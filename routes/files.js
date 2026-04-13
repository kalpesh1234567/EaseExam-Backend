/**
 * /api/files — Secure PDF Proxy
 *
 * Cloudinary free-tier restricts delivery of 'raw' PDF resources (401).
 * PDFs may have been uploaded as resource_type 'raw', 'image', or 'auto'.
 * This proxy:
 *   1. Verifies the user's JWT
 *   2. Detects the resource_type from the stored URL
 *   3. Tries multiple strategies to fetch the PDF (direct → signed → alt resource type)
 *   4. Streams the PDF to the browser
 *
 * The real Cloudinary URL is NEVER exposed to the frontend.
 */

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const cloudinary = require('cloudinary').v2;
const auth     = require('../middleware/auth');
const logger   = require('../utils/logger');

const Exam              = require('../models/Exam');
const StudentSubmission = require('../models/StudentSubmission');
const Enrollment        = require('../models/Enrollment');

// Configure Cloudinary (already done in fileUpload.js, but needed here too)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Detect the resource_type from a stored Cloudinary URL.
 * URLs look like: https://res.cloudinary.com/CLOUD/{resource_type}/upload/...
 *   - /raw/upload/...   → 'raw'
 *   - /image/upload/... → 'image'
 *   - /video/upload/... → 'video'
 *   - /auto/upload/...  → 'auto' (resolved to image on delivery)
 * If we can't detect, default to 'auto'.
 */
function detectResourceType(url) {
  const match = url.match(/res\.cloudinary\.com\/[^/]+\/(raw|image|video|auto)\/upload\//);
  return match ? match[1] : 'auto';
}

/**
 * Extract the Cloudinary public_id from a stored URL.
 * Returns the FULL path after /upload/v123.../ including any file extension.
 *
 * e.g. https://res.cloudinary.com/cloud/raw/upload/v123/easeexam/papers/test.pdf
 *   → easeexam/papers/test.pdf
 */
function extractPublicId(url) {
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/);
  return match ? match[1] : null;
}

/**
 * Strip file extension from a public_id.
 *   easeexam/papers/test.pdf → easeexam/papers/test
 */
function stripExtension(publicId) {
  return publicId.replace(/\.[^/.]+$/, '');
}

/**
 * Strip any Cloudinary transformation flags that may have been accidentally
 * embedded in stored URLs (e.g. fl_attachment:false from an earlier bug).
 */
function cleanCloudinaryUrl(url) {
  if (!url) return url;
  return url.replace(/\/upload\/((?:[a-z_]+:[^/]+\/)+)/, '/upload/');
}

/**
 * Generate a signed Cloudinary URL for a given public_id and resource type.
 *
 * IMPORTANT: Cloudinary public_id rules differ by resource_type:
 *   - 'raw':   extension IS part of the public_id  (e.g. "folder/file.pdf")
 *   - 'image': extension is NOT part of the public_id (e.g. "folder/file")
 *   - 'auto':  same as 'image' — extension is a format hint
 */
function makeSignedUrl(publicId, resourceType) {
  // For image/auto, strip the file extension from the public_id
  const effectiveId = (resourceType === 'raw') ? publicId : stripExtension(publicId);

  return cloudinary.url(effectiveId, {
    resource_type: resourceType,
    type:          'upload',
    sign_url:      true,
    secure:        true,
    expires_at:    Math.floor(Date.now() / 1000) + 300,
  });
}

/**
 * Try to fetch a URL. Returns the axios response stream on success, null on failure.
 */
async function tryFetch(url, label) {
  try {
    const response = await axios.get(url, { responseType: 'stream', timeout: 20000 });
    logger.info(`[Files] ✅ ${label} succeeded (${response.status})`);
    return response;
  } catch (err) {
    logger.warn(`[Files] ❌ ${label} failed: ${err.response?.status || err.message}`);
    return null;
  }
}

/**
 * Pipe a successful upstream response to the client.
 */
function pipeToResponse(upstream, headers, res) {
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
  upstream.data.pipe(res);
}

/**
 * Fetch the PDF from Cloudinary and pipe it to the response.
 *
 * Strategy (tries in order, stops at first success):
 *   1. Direct fetch of the stored/cleaned URL
 *   2. Direct URL with swapped resource types (raw↔image↔auto)
 *   3. Signed URLs with each resource type (using correct public_id per type)
 */
async function streamPdf(rawUrl, filename, res) {
  const cleanUrl     = cleanCloudinaryUrl(rawUrl);
  const publicId     = extractPublicId(cleanUrl);
  const detectedType = detectResourceType(cleanUrl);

  logger.info(`[Files] Proxying PDF: ${filename}`);
  logger.info(`[Files]   URL: ${cleanUrl}`);
  logger.info(`[Files]   Public ID (full): ${publicId}`);
  logger.info(`[Files]   Public ID (no ext): ${publicId ? stripExtension(publicId) : 'N/A'}`);
  logger.info(`[Files]   Detected resource_type: ${detectedType}`);

  const headers = {
    'Content-Type':        'application/pdf',
    'Content-Disposition': `inline; filename="${filename}"`,
    'Cache-Control':       'private, max-age=300',
  };

  // ── Attempt 1: Direct public URL (as stored) ─────────────────────────────
  let upstream = await tryFetch(cleanUrl, 'Direct fetch (original)');
  if (upstream) { pipeToResponse(upstream, headers, res); return; }

  // ── Attempt 2: Direct URLs with swapped resource type ─────────────────────
  // The stored URL might say /raw/upload/ but the file actually lives under /image/upload/
  const allTypes = ['image', 'raw', 'auto'];
  for (const rt of allTypes) {
    if (rt === detectedType) continue; // already tried via original URL
    const altUrl = cleanUrl.replace(
      /res\.cloudinary\.com\/([^/]+)\/(raw|image|video|auto)\/upload\//,
      `res.cloudinary.com/$1/${rt}/upload/`
    );
    upstream = await tryFetch(altUrl, `Direct (${rt})`);
    if (upstream) { pipeToResponse(upstream, headers, res); return; }
  }

  if (!publicId) {
    throw new Error('Could not determine Cloudinary public_id from URL: ' + cleanUrl);
  }

  // ── Attempt 3: Signed URLs with each resource type ────────────────────────
  // makeSignedUrl automatically handles extension stripping per resource type
  for (const rt of allTypes) {
    const signedUrl = makeSignedUrl(publicId, rt);
    logger.info(`[Files]   Trying signed URL (${rt}): ${signedUrl}`);
    upstream = await tryFetch(signedUrl, `Signed (${rt})`);
    if (upstream) { pipeToResponse(upstream, headers, res); return; }
  }

  // ── All attempts failed ───────────────────────────────────────────────────
  throw new Error(`All fetch strategies exhausted for: ${cleanUrl}`);
}

// ─── GET /api/files/question-paper/:examId ────────────────────────────────────
// Accessible by: the exam's teacher OR any enrolled student
router.get('/question-paper/:examId', auth, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam)                  return res.status(404).json({ message: 'Exam not found' });
    if (!exam.questionPaperUrl) return res.status(404).json({ message: 'No question paper uploaded yet' });

    const isTeacher = exam.teacher.toString() === req.user.id;
    if (!isTeacher) {
      const enrolled = await Enrollment.findOne({ classroom: exam.classroom, student: req.user.id });
      if (!enrolled) return res.status(403).json({ message: 'You are not enrolled in this exam\'s classroom' });
    }

    await streamPdf(exam.questionPaperUrl, 'question-paper.pdf', res);
  } catch (err) {
    logger.error('[Files] question-paper error:', err.message);
    if (!res.headersSent) res.status(500).json({ message: 'Failed to load PDF: ' + err.message });
  }
});

// ─── GET /api/files/answer-sheet/:submissionId ────────────────────────────────
// Accessible by: the exam's teacher OR the student who submitted
router.get('/answer-sheet/:submissionId', auth, async (req, res) => {
  try {
    const sub = await StudentSubmission.findById(req.params.submissionId);
    if (!sub)          return res.status(404).json({ message: 'Submission not found' });
    if (!sub.fileUrl)  return res.status(404).json({ message: 'No answer sheet on record' });

    const exam      = await Exam.findById(sub.exam);
    const isTeacher = exam && exam.teacher.toString() === req.user.id;
    const isOwner   = sub.student.toString() === req.user.id;

    if (!isTeacher && !isOwner) return res.status(403).json({ message: 'Not authorized to view this sheet' });

    await streamPdf(sub.fileUrl, 'answer-sheet.pdf', res);
  } catch (err) {
    logger.error('[Files] answer-sheet error:', err.message);
    if (!res.headersSent) res.status(500).json({ message: 'Failed to load PDF: ' + err.message });
  }
});

module.exports = router;
