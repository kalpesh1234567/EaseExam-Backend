const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const auth = require('../middleware/auth');
const upload = require('../utils/fileUpload');
const logger = require('../utils/logger');

// Old test-based models
const TestSubmission = require('../models/TestSubmission');
const Answer = require('../models/Answer');
const Question = require('../models/Question');
const Test = require('../models/Test');
const Enrollment = require('../models/Enrollment');
const { evaluateAnswer } = require('../nlp/engine');

// New exam-based models
const Exam = require('../models/Exam');
const AnswerKey = require('../models/AnswerKey');
const StudentSubmission = require('../models/StudentSubmission');
const Evaluation = require('../models/Evaluation');
const QuestionScore = require('../models/QuestionScore');
const { segmentAnswerSheet, evaluateSingleAnswer, extractTextWithGemini } = require('../nlp/aiEvaluator');

// ─── Helper: extract text from a LOCAL file (image or PDF) ──────────────────
async function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text || '';
  }
  const Tesseract = require('tesseract.js');
  const { data } = await Tesseract.recognize(filePath, 'eng');
  return data.text || '';
}

// ─── Helper: derive MIME type from URL extension (best-effort) ──────────────
// Returns null when extension is missing (e.g. Cloudinary /raw/upload/ URLs).
function getMimeTypeFromUrl(urlOrPath) {
  const clean = urlOrPath.split('?')[0];
  const ext = path.extname(clean).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png')  return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif')  return 'image/gif';
  if (ext === '.pdf')  return 'application/pdf';
  return null;
}

// ─── Helper: derive MIME type for LOCAL file path ────────────────────────────
function getMimeTypeFromLocalPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png')  return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif')  return 'image/gif';
  if (ext === '.pdf')  return 'application/pdf';
  return 'application/octet-stream';
}

// ─── Helper: parse Content-Type header to a clean MIME string ───────────────
// "image/jpeg; charset=utf-8" becomes "image/jpeg". Unknown types return null.
function normaliseMime(contentTypeHeader) {
  if (!contentTypeHeader) return null;
  const mime = contentTypeHeader.split(';')[0].trim().toLowerCase();
  const known = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
  return known.includes(mime) ? mime : null;
}

// ─── Helper: grade from percentage ──────────────────────────────────────────
function calcGrade(pct) {
  if (pct >= 90) return 'A+';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B';
  if (pct >= 60) return 'C';
  if (pct >= 50) return 'D';
  return 'F';
}

// ─── Helper: render every page of a scanned PDF to JPEG, run vision OCR ─────
//
// Stack: pdfjs-dist (pure-JS PDF renderer) + @napi-rs/canvas (prebuilt .node
// binaries for Linux/macOS/Windows — NO compilation needed, works on Render
// free tier without any build packs).
//
// One-time install: npm install pdfjs-dist @napi-rs/canvas
//
async function renderPdfPagesToText(pdfBuffer) {
  // Dynamic import so server still boots if the package is somehow missing
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,   // avoids "standardFontDataUrl" warnings
  });

  const pdfDoc = await loadingTask.promise;
  logger.info(`[Eval] PDF has ${pdfDoc.numPages} page(s) — rendering to JPEG for OCR`);

  const pageTexts = [];

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2.0 }); // ~150 dpi on A4

    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;

    // encode() returns a Buffer — quality 90 keeps file size reasonable
    const jpegBuffer = await canvas.encode('jpeg', 90);
    logger.info(`[Eval] Page ${pageNum}/${pdfDoc.numPages}: ${jpegBuffer.length} bytes — sending to vision OCR`);

    const pageText = await extractTextWithGemini(jpegBuffer, 'image/jpeg');
    if (pageText && pageText.trim().length > 0) {
      pageTexts.push(pageText.trim());
    }

    page.cleanup();
  }

  return pageTexts.join('\n\n--- PAGE BREAK ---\n\n');
}

// ─── POST /api/submissions/submit/:testId ────────────────────────────────────
router.post('/submit/:testId', auth, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can submit tests' });
    }

    const test = await Test.findById(req.params.testId);
    if (!test) return res.status(404).json({ message: 'Test not found' });

    const enrolled = await Enrollment.findOne({ classroom: test.classroom, student: req.user.id });
    if (!enrolled) return res.status(403).json({ message: 'Not enrolled in this classroom' });

    const exists = await TestSubmission.findOne({ test: test._id, student: req.user.id });
    if (exists) return res.status(400).json({ message: 'Already submitted' });

    const questions = await Question.find({ test: test._id }).sort('order');
    const submission = await TestSubmission.create({ test: test._id, student: req.user.id });
    let totalMl = 0;
    const answers = [];

    for (const question of questions) {
      const studentAnswer = (req.body.answers?.[question._id.toString()] || '').trim();
      const result = evaluateAnswer(studentAnswer, question.referenceAnswer, question.maxScore);
      const answer = await Answer.create({
        submission: submission._id,
        question: question._id,
        answerText: studentAnswer,
        mlScore: result.score,
        similarityScore: result.similarity,
        keywordScore: result.keywordCoverage,
        matchedKeywords: result.matchedKeywords,
        missedKeywords: result.missedKeywords,
        feedback: result.feedback,
      });
      totalMl += result.score;
      answers.push(answer);
    }

    submission.mlTotal = Math.round(totalMl * 100) / 100;
    await submission.save();
    res.status(201).json({ message: 'Test submitted successfully', submission, answers });
  } catch (err) {
    logger.error('submit/:testId error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/submissions/result/:testId ─────────────────────────────────────
router.get('/result/:testId', auth, async (req, res) => {
  try {
    const test = await Test.findById(req.params.testId).populate('classroom', 'name');
    if (!test) return res.status(404).json({ message: 'Test not found' });

    const submission = await TestSubmission.findOne({ test: test._id, student: req.user.id });
    if (!submission) return res.status(404).json({ message: 'Submission not found' });

    const answers = await Answer.find({ submission: submission._id }).populate('question');
    const questions = await Question.find({ test: test._id }).sort('order');
    const totalMarks = questions.reduce((s, q) => s + q.maxScore, 0);

    const detailed = answers.map(a => {
      const result = evaluateAnswer(a.answerText, a.question.referenceAnswer, a.question.maxScore);
      return { answer: a, result };
    });

    res.json({ test, submission, detailed, totalMarks });
  } catch (err) {
    logger.error('result/:testId error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/submissions/students-work/:testId ───────────────────────────────
router.get('/students-work/:testId', auth, async (req, res) => {
  try {
    const test = await Test.findById(req.params.testId).populate('classroom', 'owner name');
    if (!test) return res.status(404).json({ message: 'Test not found' });
    if (test.classroom.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const submissions = await TestSubmission.find({ test: test._id })
      .populate('student', 'firstName lastName username');
    const questions = await Question.find({ test: test._id }).sort('order');
    const totalMarks = questions.reduce((s, q) => s + q.maxScore, 0);

    const result = await Promise.all(
      submissions.map(async sub => {
        const answers = await Answer.find({ submission: sub._id }).populate('question');
        return { submission: sub, answers };
      })
    );

    res.json({ test, submissions: result, questions, totalMarks });
  } catch (err) {
    logger.error('students-work/:testId error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── PATCH /api/submissions/update-score/:answerId ───────────────────────────
router.patch('/update-score/:answerId', auth, async (req, res) => {
  try {
    const answer = await Answer.findById(req.params.answerId).populate({
      path: 'question',
      populate: { path: 'test', populate: { path: 'classroom', select: 'owner' } },
    });
    if (!answer) return res.status(404).json({ message: 'Answer not found' });
    if (answer.question.test.classroom.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const rawScore = parseFloat(req.body.score);
    if (isNaN(rawScore)) {
      return res.status(400).json({ message: 'score must be a valid number' });
    }
    const score = Math.max(0, Math.min(rawScore, answer.question.maxScore));
    answer.teacherScore = score;
    await answer.save();

    const submission = await TestSubmission.findById(answer.submission);
    const allAnswers = await Answer.find({ submission: submission._id });
    submission.teacherTotal =
      Math.round(
        allAnswers.reduce((s, a) => s + (a.teacherScore !== null ? a.teacherScore : a.mlScore), 0) * 100
      ) / 100;
    submission.isReviewed = allAnswers.every(a => a.teacherScore !== null);
    await submission.save();

    res.json({ answer, submission });
  } catch (err) {
    logger.error('update-score/:answerId error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/submissions/:examId — student uploads answer sheet ────────────
/**
 * @swagger
 * /api/submissions/{examId}:
 *   post:
 *     summary: Student uploads answer sheet for an exam
 *     tags: [Submissions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: examId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               sheetUrl:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Sheet uploaded and evaluation started
 */
router.post('/:examId', auth, (req, res, next) => {
  upload.single('sheetUrl')(req, res, err => {
    if (err) {
      logger.error('Multer/Cloudinary upload error:', err);
      return res.status(500).json({
        message: 'UPLOAD_ERROR: ' + (err.message || err.name || 'Unknown upload issue'),
        details: err.stack || JSON.stringify(err, null, 2),
        errorCode: err.http_code || 500,
      });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can submit answer sheets' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    const exam = await Exam.findById(req.params.examId);
    if (!exam) return res.status(404).json({ message: 'Exam not found' });

    const enrolled = await Enrollment.findOne({ classroom: exam.classroom, student: req.user.id });
    if (!enrolled) {
      return res.status(403).json({ message: 'You are not enrolled in the classroom for this exam.' });
    }

    const answerKey = await AnswerKey.findOne({ exam: exam._id });
    if (!answerKey || !answerKey.questions || answerKey.questions.length === 0) {
      return res.status(404).json({ message: 'Answer key not configured.' });
    }

    const existing = await StudentSubmission.findOne({ exam: exam._id, student: req.user.id });
    if (existing) {
      return res.status(400).json({ message: 'Already submitted.' });
    }

    const fileUrl = req.file.path; // Cloudinary URL
    const submission = await StudentSubmission.create({
      exam: exam._id,
      student: req.user.id,
      fileUrl,
      status: 'pending',
    });

    // Respond immediately — evaluation runs in the background
    res.status(201).json({ message: 'Uploaded. Evaluation in progress…', submissionId: submission._id });

    runBackgroundEvaluation(submission, answerKey).catch(bgErr => {
      logger.error('Top-level background eval error:', bgErr);
    });

  } catch (err) {
    logger.error('/:examId upload handler error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── Background evaluation ───────────────────────────────────────────────────
async function runBackgroundEvaluation(submission, answerKey) {
  try {
    // ── Step 1: OCR / text extraction ────────────────────────────────────────
    let rawText = '';
    const fileUrl = submission.fileUrl;
    const isRemoteUrl = fileUrl.startsWith('http');

    if (isRemoteUrl) {
      logger.info(`[Eval] Downloading file: ${fileUrl}`);
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30_000 });
      const buffer = Buffer.from(response.data);

      // Determine MIME type in priority order:
      //   1. HTTP Content-Type header — most reliable; works for Cloudinary
      //      /raw/upload/ URLs that have NO file extension.
      //   2. URL file extension — fallback for normal servers.
      //   3. Default image/jpeg — last resort; let vision model attempt it.
      const headerMime = normaliseMime(response.headers['content-type']);
      const urlMime    = getMimeTypeFromUrl(fileUrl);
      const mimeType   = headerMime || urlMime || 'image/jpeg';

      logger.info(`[Eval] Detected MIME — header: ${headerMime ?? 'none'}, url: ${urlMime ?? 'none'}, using: ${mimeType}`);

      if (mimeType === 'application/pdf') {
        // ── 1a: text-layer extraction (fast, works for digital PDFs) ─────────
        try {
          const pdfParse = require('pdf-parse');
          const pdfData = await pdfParse(buffer);
          rawText = (pdfData.text || '').trim();
          logger.info(`[Eval] pdf-parse extracted ${rawText.length} chars.`);
        } catch (pdfErr) {
          logger.warn('[Eval] pdf-parse failed:', pdfErr.message);
          rawText = '';
        }

        // ── 1b: scanned PDF — render pages to JPEG, run vision OCR ───────────
        //
        // pdfjs-dist  = pure-JS renderer (zero native deps)
        // @napi-rs/canvas = prebuilt binaries for Linux/macOS/Windows
        //                   (no compilation — works on Render free tier)
        //
        // npm install pdfjs-dist @napi-rs/canvas
        //
        if (rawText.length < 50) {
          logger.info('[Eval] Scanned PDF — rendering pages to JPEG for vision OCR…');
          try {
            rawText = await renderPdfPagesToText(buffer);
            logger.info(`[Eval] Vision OCR from PDF pages: ${rawText.length} chars.`);
          } catch (renderErr) {
            logger.warn('[Eval] PDF page render failed:', renderErr.message);
            // rawText stays '' — questions score 0 with "no answer" feedback.
          }
        }

      } else {
        // ── Image file — send directly to vision OCR ─────────────────────────
        rawText = await extractTextWithGemini(buffer, mimeType);
        logger.info(`[Eval] Vision OCR (image): ${rawText.length} chars.`);
      }

    } else {
      // ── Local file (dev only) ─────────────────────────────────────────────
      const absolutePath = path.join(__dirname, '..', fileUrl);
      logger.info(`[Eval] Local file OCR: ${absolutePath}`);
      rawText = await extractTextFromFile(absolutePath);
      logger.info(`[Eval] Local file OCR: ${rawText.length} chars.`);
    }

    submission.ocrText = rawText;
    await submission.save();
    logger.info(`[Eval] OCR complete — ${rawText.length} chars.`);

    // ── Step 2: Create evaluation document ───────────────────────────────────
    const maxScore = answerKey.questions.reduce((s, q) => s + q.maxMarks, 0);
    const evalDoc = await Evaluation.create({
      submission: submission._id,
      totalScore: 0,
      maxScore,
      percentage: 0,
      grade: '',
      feedbackJson: '',
    });

    // ── Step 3: Segment OCR text into per-question answer chunks ─────────────
    logger.info(`[Eval] Starting segmentation for submission ${submission._id}`);
    const segments = await segmentAnswerSheet(rawText, answerKey.questions);
    const segmentCount = Object.values(segments).filter(v => v && v.trim().length > 3).length;
    logger.info(`[Eval] Segmented ${segmentCount}/${answerKey.questions.length} questions.`);

    // ── Step 4: Evaluate each question ───────────────────────────────────────
    let totalScore = 0;

    for (const q of answerKey.questions) {
      const qKey = String(q.questionNo).replace(/^0+/, '') || String(q.questionNo);
      const segment = segments[qKey];
      const hasSegment = segment && segment.trim().length > 3;

      if (!hasSegment) {
        logger.warn(`[Eval] Q${q.questionNo}: no segment — scoring 0.`);
      }

      // NEVER fall back to full rawText — that inflates scores by evaluating the
      // entire answer sheet as if it were one question's answer.
      const studentSegment = hasSegment ? segment : '';

      const result = await evaluateSingleAnswer(
        studentSegment,
        q.modelAnswer,
        q.maxMarks,
        q.text || ''
      );

      totalScore += result.marksObtained;

      await QuestionScore.create({
        evaluation:    evalDoc._id,
        questionNo:    q.questionNo,
        marksObtained: result.marksObtained,
        maxMarks:      q.maxMarks,
        studentAnswer: studentSegment,
        feedback:      result.feedback,
        suggestion:    result.suggestion,
      });

      logger.info(`[Eval] Q${q.questionNo}: ${result.marksObtained}/${q.maxMarks}`);
    }

    // ── Step 5: Finalise ─────────────────────────────────────────────────────
    const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
    const grade = calcGrade(percentage);

    evalDoc.totalScore   = totalScore;
    evalDoc.percentage   = percentage;
    evalDoc.grade        = grade;
    evalDoc.feedbackJson = JSON.stringify({
      summary:       `Scored ${totalScore}/${maxScore}`,
      segmentsFound: segmentCount,
    });
    await evalDoc.save();

    submission.status = 'evaluated';
    await submission.save();

    logger.info(`[Eval] Complete — ${totalScore}/${maxScore} (${percentage}%) Grade: ${grade}`);

  } catch (bgErr) {
    logger.error('[Eval] Background evaluation error:', bgErr);
    try {
      submission.status   = 'failed';
      submission.errorMsg = bgErr.message;
      await submission.save();
    } catch (saveErr) {
      logger.error('[Eval] Could not save failed status:', saveErr.message);
    }
  }
}

module.exports = router;
