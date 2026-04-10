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
 * Generate a short-lived (5-minute) signed Cloudinary URL.
 * This bypasses Restricted Delivery and works even on locked-down accounts.
 */
function buildSignedUrl(rawUrl) {
  const publicId = extractPublicId(rawUrl);
  if (!publicId) return rawUrl; // fallback

  return cloudinary.url(publicId, {
    resource_type: 'raw',
    type:          'upload',
    sign_url:      true,
    secure:        true,
    expires_at:    Math.floor(Date.now() / 1000) + 300, // expires in 5 min
  });
}

/**
 * Fetch the PDF from Cloudinary (via signed URL) and pipe it to the response.
 */
async function streamPdf(cloudinaryUrl, filename, res) {
  const signedUrl = buildSignedUrl(cloudinaryUrl);
  logger.info(`[Files] Proxying PDF: ${filename}`);

  const upstream = await axios.get(signedUrl, {
    responseType: 'stream',
    timeout: 20000,
  });

  res.setHeader('Content-Type',        'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control',       'private, max-age=300');
  upstream.data.pipe(res);
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
