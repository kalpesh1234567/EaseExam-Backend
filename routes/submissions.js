const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const pdfParse = require('pdf-parse');
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

// ─── Helper: extract text from a PDF buffer ─────────────────────────────────
async function extractTextFromBuffer(buffer) {
  try {
    const data = await pdfParse(buffer);
    return (data.text || '').trim();
  } catch (err) {
    logger.error('[Extract] pdf-parse failed:', err.message);
    return '';
  }
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
router.post('/:examId', auth, (req, res, next) => {
  upload.single('sheetUrl')(req, res, err => {
    if (err) {
      logger.error('Multer/Cloudinary upload error:', err);
      return res.status(500).json({
        message: 'UPLOAD_ERROR: ' + (err.message || err.name || 'Unknown upload issue'),
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
      logger.error('[Eval] Top-level background eval error:', bgErr);
    });

  } catch (err) {
    logger.error('/:examId upload handler error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── Background evaluation (SIMPLIFIED) ──────────────────────────────────────
async function runBackgroundEvaluation(submission, answerKey) {
  try {
    // ── Step 1: Download file and extract text with pdf-parse ─────────────
    let rawText = '';
    const fileUrl = submission.fileUrl;

    if (fileUrl.startsWith('http')) {
      logger.info(`[Eval] Downloading file: ${fileUrl}`);
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30_000 });
      const buffer = Buffer.from(response.data);

      // Strategy: ALWAYS try pdf-parse first (even if MIME says octet-stream).
      // If pdf-parse returns usable text → done.
      // If not → try image OCR via OpenRouter vision models.
      rawText = await extractTextFromBuffer(buffer);
      logger.info(`[Eval] pdf-parse got ${rawText.length} chars.`);

      if (rawText.length < 30) {
        logger.info('[Eval] pdf-parse got little text — trying image OCR via vision model…');
        const ocrText = await extractTextWithGemini(buffer, 'image/jpeg');
        if (ocrText && ocrText.length > rawText.length) {
          rawText = ocrText;
          logger.info(`[Eval] Vision OCR got ${rawText.length} chars.`);
        }
      }
    } else {
      // Local file (dev only)
      const absolutePath = path.join(__dirname, '..', fileUrl);
      if (fs.existsSync(absolutePath)) {
        const buffer = fs.readFileSync(absolutePath);
        rawText = await extractTextFromBuffer(buffer);
      }
      logger.info(`[Eval] Local file: ${rawText.length} chars.`);
    }

    // Check if we got usable text
    if (!rawText || rawText.trim().length < 20) {
      logger.warn(`[Eval] PDF has no readable text (${rawText.length} chars). Probably scanned.`);
      // Still continue — questions will score 0 with "no answer" feedback
    }

    submission.ocrText = rawText;
    await submission.save();
    logger.info(`[Eval] Text extraction complete — ${rawText.length} chars.`);

    // ── Step 2: Create evaluation document ───────────────────────────────
    const maxScore = answerKey.questions.reduce((s, q) => s + q.maxMarks, 0);
    const evalDoc = await Evaluation.create({
      submission: submission._id,
      totalScore: 0,
      maxScore,
      percentage: 0,
      grade: '',
      feedbackJson: '',
    });

    // ── Step 3: Segment text into per-question answers ───────────────────
    logger.info(`[Eval] Segmenting for submission ${submission._id}`);
    const segments = await segmentAnswerSheet(rawText, answerKey.questions);
    const segmentCount = Object.values(segments).filter(v => v && v.trim().length > 3).length;
    logger.info(`[Eval] Segmented ${segmentCount}/${answerKey.questions.length} questions.`);

    // ── Step 4: Evaluate each question ───────────────────────────────────
    let totalScore = 0;

    for (const q of answerKey.questions) {
      const qKey = String(q.questionNo).replace(/^0+/, '') || String(q.questionNo);
      const segment = segments[qKey];
      const hasSegment = segment && segment.trim().length > 3;

      if (!hasSegment) {
        logger.warn(`[Eval] Q${q.questionNo}: no segment — scoring 0.`);
      }

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

    // ── Step 5: Finalise ─────────────────────────────────────────────────
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

    logger.info(`[Eval] ✅ Complete — ${totalScore}/${maxScore} (${percentage}%) Grade: ${grade}`);

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
