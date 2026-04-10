/**
 * /api/files — Secure PDF Proxy
 *
 * Cloudinary raw resources may have Restricted Delivery enabled, making
 * direct public URLs return 401. This proxy:
 *   1. Verifies the user's JWT (view permission)
 *   2. Generates a short-lived Cloudinary SIGNED URL server-side
 *   3. Fetches the PDF and streams it straight to the browser
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
 * Extract the Cloudinary public_id from a stored raw URL.
 * e.g. https://res.cloudinary.com/cloud/raw/upload/v123456/easeexam/papers/test.pdf
 *   → easeexam/papers/test.pdf
 */
function extractPublicId(url) {
  // Strip version segment (v12345/) if present
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/);
  return match ? match[1] : null;
}



/**
 * Strip any Cloudinary transformation flags that may have been accidentally
 * embedded in stored URLs (e.g. fl_attachment:false from an earlier bug).
 *
 * Before: https://res.cloudinary.com/x/raw/upload/fl_attachment:false/v123/x.pdf
 * After:  https://res.cloudinary.com/x/raw/upload/v123/x.pdf
 */
function cleanCloudinaryUrl(url) {
  if (!url) return url;
  // Remove any flag-like segment between /upload/ and the version or public_id
  // Flags look like  fl_something:value  or  f_something
  return url.replace(/\/upload\/((?:[a-z_]+:[^/]+\/)+)/, '/upload/');
}

/**
 * Fetch the PDF from Cloudinary and pipe it to the response.
 *
 * Strategy:
 *   1. Clean the URL (strip any erroneously stored transformation flags).
 *   2. Try a direct fetch — works when Cloudinary is publicly accessible.
 *   3. If Cloudinary returns 401 (Restricted Delivery), generate a short-lived
 *      signed URL and retry once.
 */
async function streamPdf(rawUrl, filename, res) {
  const cleanUrl = cleanCloudinaryUrl(rawUrl);
  logger.info(`[Files] Proxying PDF: ${filename}`);

  const headers = { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Cache-Control': 'private, max-age=300' };

  try {
    // ── Attempt 1: direct public URL ────────────────────────────────────────
    const upstream = await axios.get(cleanUrl, { responseType: 'stream', timeout: 20000 });
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    upstream.data.pipe(res);
  } catch (directErr) {
    if (directErr.response?.status !== 401) throw directErr; // not an auth issue — rethrow

    // ── Attempt 2: signed URL (Cloudinary Restricted Delivery) ────────────
    logger.warn('[Files] Direct fetch returned 401 — retrying with signed URL');
    const publicId = extractPublicId(cleanUrl);
    if (!publicId) throw new Error('Could not determine Cloudinary public_id for signing');

    const signedUrl = cloudinary.url(publicId, {
      resource_type: 'raw',
      type:          'upload',
      sign_url:      true,
      secure:        true,
      expires_at:    Math.floor(Date.now() / 1000) + 300,
    });

    const upstream2 = await axios.get(signedUrl, { responseType: 'stream', timeout: 20000 });
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    upstream2.data.pipe(res);
  }
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
    if (!res.headersSent) res.status(500).json({ message: 'Failed to load PDF' });
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
    if (!res.headersSent) res.status(500).json({ message: 'Failed to load PDF' });
  }
});

module.exports = router;
