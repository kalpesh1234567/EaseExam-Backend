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

// ─── Helper: derive the image MIME type from a URL/path extension ────────────
function getMimeType(urlOrPath) {
  const ext = path.extname(urlOrPath).toLowerCase().replace(/\?.*$/, '');
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.pdf') return 'application/pdf';
  return null; // May be missing, will check buffer magic bytes in runBackgroundEvaluation
}

// ─── Helper: grade from percentage ──────────────────────────────────────────
function calcGrade(percentage) {
  if (percentage >= 90) return 'A+';
  if (percentage >= 80) return 'A';
  if (percentage >= 70) return 'B';
  if (percentage >= 60) return 'C';
  if (percentage >= 50) return 'D';
  return 'F';
}

// ─── POST /api/submissions/submit/:testId — student submits test ─────────────
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

// ─── GET /api/submissions/result/:testId — student gets their result ─────────
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

// ─── GET /api/submissions/students-work/:testId — teacher views all submissions
router.get('/students-work/:testId', auth, async (req, res) => {
  try {
    const test = await Test.findById(req.params.testId).populate('classroom', 'owner name');
    if (!test) return res.status(404).json({ message: 'Test not found' });
    if (test.classroom.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const submissions = await TestSubmission.find({ test: test._id }).populate('student', 'firstName lastName username');
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

// ─── PATCH /api/submissions/update-score/:answerId — teacher overrides score ─
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

    // ── Background evaluation (fire-and-forget) ──────────────────────────────
    runBackgroundEvaluation(submission, answerKey).catch(bgErr => {
      // This catch is a safety net; runBackgroundEvaluation handles its own errors internally
      logger.error('Unexpected top-level background eval error:', bgErr);
    });

  } catch (err) {
    logger.error('/:examId upload handler error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── Background evaluation (extracted for clarity) ───────────────────────────
async function runBackgroundEvaluation(submission, answerKey) {
  try {
    // ── Step 1: OCR / text extraction ────────────────────────────────────────
    let rawText = '';
    const fileUrl = submission.fileUrl;
    const isRemoteUrl = fileUrl.startsWith('http');
    
    let mimeType = getMimeType(fileUrl);
    let buffer = null;

    if (isRemoteUrl) {
      logger.info(`[Eval] Downloading file from Cloudinary: ${fileUrl}`);
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 30_000,
      });
      buffer = Buffer.from(response.data);

      // Robust Type Detection: Check magic bytes if extension was missing
      if (!mimeType && buffer.length > 4) {
        // %PDF-
        if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
          mimeType = 'application/pdf';
        } 
        // JPEG: FF D8 FF
        else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
          mimeType = 'image/jpeg';
        }
        // PNG: 89 50 4E 47
        else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
          mimeType = 'image/png';
        }
        
        if (mimeType) {
          logger.info(`[Eval] Detected MIME type from buffer: ${mimeType}`);
        }
      }

      if (!mimeType) {
        // Final fallback — if it's from Cloudinary 'raw' folder, it's almost always a PDF
        if (fileUrl.includes('/raw/upload/')) {
          mimeType = 'application/pdf';
          logger.info('[Eval] No extension found, but URL is in raw folder — assuming application/pdf');
        } else {
          throw new Error(`Could not determine file type for URL: ${fileUrl}`);
        }
      }

      if (mimeType === 'application/pdf') {
        // Step 1a: try fast text-layer extraction via pdf-parse
        try {
          const pdfParse = require('pdf-parse');
          const data = await pdfParse(buffer);
          rawText = (data.text || '').trim();
          logger.info(`[Eval] pdf-parse extracted ${rawText.length} chars.`);
        } catch (pdfErr) {
          logger.warn('[Eval] pdf-parse failed:', pdfErr.message);
          rawText = '';
        }

        // Step 1b: if text layer is empty/too short, it's a scanned PDF.
        // We cannot send a raw PDF to a vision model — vision APIs only accept images.
        // Attempt to render the first page as a JPEG using pdf-to-img (optional dep).
        // If that package is unavailable, log clearly and continue with empty text.
        if (rawText.length < 50) {
          logger.info('[Eval] Short PDF text — attempting page-image render for vision OCR…');
          try {
            // pdf-to-img renders each page as a Buffer (JPEG by default).
            // Install with: npm install pdf-to-img
            const { pdf } = require('pdf-to-img');
            const pages = [];
            for await (const pageImage of pdf(buffer, { scale: 2 })) {
              pages.push(pageImage);
            }
            if (pages.length > 0) {
              // Run OCR on all pages and concatenate
              const pageTexts = await Promise.all(
                pages.map(pageBuffer => extractTextWithGemini(pageBuffer, 'image/jpeg'))
              );
              rawText = pageTexts.filter(Boolean).join('\n\n');
              logger.info(`[Eval] Vision OCR across ${pages.length} page(s): ${rawText.length} chars.`);
            } else {
              logger.warn('[Eval] pdf-to-img returned 0 pages.');
            }
          } catch (renderErr) {
            logger.warn(
              '[Eval] pdf-to-img not available or failed. Scanned PDF will have empty OCR text.',
              renderErr.message
            );
            // rawText stays empty — evaluation will still run, scoring 0 with
            // a clear "no answer found" feedback for each question.
          }
        }
      } else {
        // It's an image — pass directly to vision OCR
        rawText = await extractTextWithGemini(buffer, mimeType);
        logger.info(`[Eval] Vision OCR (image): ${rawText.length} chars.`);
      }
    } else {
      // Local file (fallback path)
      const absolutePath = path.join(__dirname, '..', fileUrl);
      rawText = await extractTextFromFile(absolutePath);
      logger.info(`[Eval] Local file OCR: ${rawText.length} chars.`);
    }

    submission.ocrText = rawText;
    await submission.save();

    logger.info(`[Eval] OCR complete. Total chars: ${rawText.length}`);

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

    // ── Step 3: Segment the OCR text into per-question answer chunks ─────────
    logger.info(`[Eval] Starting segmentation for submission ${submission._id}`);
    const segments = await segmentAnswerSheet(rawText, answerKey.questions);
    const segmentCount = Object.values(segments).filter(v => v && v.trim().length > 3).length;
    logger.info(`[Eval] Segmented ${segmentCount}/${answerKey.questions.length} questions.`);

    // ── Step 4: Evaluate each question ───────────────────────────────────────
    let totalScore = 0;

    for (const q of answerKey.questions) {
      // normalizeQNum ensures "Q1" / "01" / "1" all resolve to "1"
      const qKey = String(q.questionNo).replace(/^0+/, '') || String(q.questionNo);
      const segment = segments[qKey];
      const usedFallback = !segment || segment.trim().length <= 3;

      if (usedFallback) {
        logger.warn(`[Eval] Q${q.questionNo}: no segment found — will score 0 with 'no answer' feedback.`);
      }

      // Do NOT fall back to full rawText — that would evaluate the entire sheet
      // as if it were one question's answer, leading to inflated or nonsense scores.
      const studentSegment = usedFallback ? '' : segment;

      const result = await evaluateSingleAnswer(
        studentSegment,
        q.modelAnswer,
        q.maxMarks,
        q.text || ''
      );

      totalScore += result.marksObtained;

      await QuestionScore.create({
        evaluation: evalDoc._id,
        questionNo: q.questionNo,
        marksObtained: result.marksObtained,
        maxMarks: q.maxMarks,
        studentAnswer: studentSegment,
        feedback: result.feedback,
        suggestion: result.suggestion,
      });

      logger.info(`[Eval] Q${q.questionNo}: ${result.marksObtained}/${q.maxMarks}`);
    }

    // ── Step 5: Finalise evaluation ──────────────────────────────────────────
    const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
    const grade = calcGrade(percentage);

    evalDoc.totalScore = totalScore;
    evalDoc.percentage = percentage;
    evalDoc.grade = grade;
    evalDoc.feedbackJson = JSON.stringify({
      summary: `Scored ${totalScore}/${maxScore}`,
      segmentsFound: segmentCount,
    });
    await evalDoc.save();

    submission.status = 'evaluated';
    await submission.save();

    logger.info(`[Eval] Complete — ${totalScore}/${maxScore} (${percentage}%) Grade: ${grade}`);

  } catch (bgErr) {
    logger.error('[Eval] Background evaluation error:', bgErr);
    try {
      submission.status = 'failed';
      submission.errorMsg = bgErr.message;
      await submission.save();
    } catch (saveErr) {
      logger.error('[Eval] Could not update submission status to failed:', saveErr.message);
    }
  }
}

module.exports = router;
