const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
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
const { segmentAnswerSheet, evaluateSingleAnswer } = require('../nlp/aiEvaluator');

// Helper: extract text from a file (image or PDF)
async function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const { PDFParse: pdfParse } = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text || '';
  } else {
    const Tesseract = require('tesseract.js');
    const { data } = await Tesseract.recognize(filePath, 'eng');
    return data.text || '';
  }
}


// POST /api/submissions/submit/:testId — student submits test
router.post('/submit/:testId', auth, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ message: 'Only students can submit tests' });
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
    res.status(500).json({ message: err.message });
  }
});

// GET /api/submissions/result/:testId — student gets their result
router.get('/result/:testId', auth, async (req, res) => {
  try {
    const test = await Test.findById(req.params.testId).populate('classroom', 'name');
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
    res.status(500).json({ message: err.message });
  }
});

// GET /api/submissions/students-work/:testId — teacher views all submissions
router.get('/students-work/:testId', auth, async (req, res) => {
  try {
    const test = await Test.findById(req.params.testId).populate('classroom', 'owner name');
    if (!test) return res.status(404).json({ message: 'Test not found' });
    if (test.classroom.owner.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

    const submissions = await TestSubmission.find({ test: test._id }).populate('student', 'firstName lastName username');
    const questions = await Question.find({ test: test._id }).sort('order');
    const totalMarks = questions.reduce((s, q) => s + q.maxScore, 0);

    const result = await Promise.all(submissions.map(async (sub) => {
      const answers = await Answer.find({ submission: sub._id }).populate('question');
      return { submission: sub, answers };
    }));

    res.json({ test, submissions: result, questions, totalMarks });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/submissions/update-score/:answerId — teacher overrides score
router.patch('/update-score/:answerId', auth, async (req, res) => {
  try {
    const answer = await Answer.findById(req.params.answerId)
      .populate({ path: 'question', populate: { path: 'test', populate: { path: 'classroom', select: 'owner' } } });
    if (!answer) return res.status(404).json({ message: 'Answer not found' });
    if (answer.question.test.classroom.owner.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

    const score = Math.max(0, Math.min(parseFloat(req.body.score), answer.question.maxScore));
    answer.teacherScore = score;
    await answer.save();

    // Recalc submission teacherTotal
    const submission = await TestSubmission.findById(answer.submission);
    const allAnswers = await Answer.find({ submission: submission._id });
    submission.teacherTotal = Math.round(allAnswers.reduce((s, a) => s + (a.teacherScore !== null ? a.teacherScore : a.mlScore), 0) * 100) / 100;
    submission.isReviewed = allAnswers.every(a => a.teacherScore !== null);
    await submission.save();

    res.json({ answer, submission });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
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
router.post('/:examId', auth, upload.single('sheetUrl'), async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can submit answer sheets' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    const exam = await Exam.findById(req.params.examId);
    if (!exam) return res.status(404).json({ message: 'Exam not found' });

    // Verify student is enrolled in the exam's classroom
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

    const fileUrl = `/uploads/sheets/${req.file.filename}`;
    const submission = await StudentSubmission.create({
      exam: exam._id,
      student: req.user.id,
      fileUrl,
      status: 'pending',
    });

    res.status(201).json({ message: 'Uploaded. Evaluation in progress...', submissionId: submission._id });

    // ── Background Evaluation (Two-Phase) ────────────────────────────────────
    (async () => {
      try {
        const absolutePath = path.join(__dirname, '..', req.file.path);
        const rawText = await extractTextFromFile(absolutePath);

        submission.ocrText = rawText;
        await submission.save();

        const maxScore = answerKey.questions.reduce((s, q) => s + q.maxMarks, 0);

        const evalDoc = await Evaluation.create({
          submission: submission._id,
          totalScore: 0,
          maxScore,
          percentage: 0,
          grade: '',
          feedbackJson: '',
        });

        // ── PHASE 1: Segment the answer sheet into per-question answer chunks ──
        // One smart Gemini call: full OCR text + all question numbers/texts → JSON map
        logger.info(`[Eval] Starting segmentation for submission ${submission._id}`);
        const segments = await segmentAnswerSheet(rawText, answerKey.questions);
        const segmentCount = Object.keys(segments).filter(k => segments[k]).length;
        logger.info(`[Eval] Segmented ${segmentCount}/${answerKey.questions.length} questions successfully`);

        // ── PHASE 2: Evaluate each question's specific answer segment ──
        let totalScore = 0;

        for (const q of answerKey.questions) {
          const qKey = String(q.questionNo);

          // Use the specific segment if found, otherwise fall back to full OCR text
          const studentSegment = segments[qKey] && segments[qKey].trim().length > 3
            ? segments[qKey]
            : rawText;

          const usedFallback = !segments[qKey] || segments[qKey].trim().length <= 3;
          if (usedFallback) {
            logger.warn(`[Eval] Q${q.questionNo}: segment not found, using full OCR text as fallback`);
          }

          const result = await evaluateSingleAnswer(
            studentSegment,
            q.modelAnswer,
            q.maxMarks,
            q.text || ''   // pass question text for richer AI context
          );

          totalScore += result.marksObtained;

          await QuestionScore.create({
            evaluation: evalDoc._id,
            questionNo:      q.questionNo,
            marksObtained:   result.marksObtained,
            maxMarks:        q.maxMarks,
            studentAnswer:   studentSegment,   // specific segment, not full dump
            feedback:        result.feedback,
            suggestion:      result.suggestion,
          });

          logger.info(`[Eval] Q${q.questionNo}: ${result.marksObtained}/${q.maxMarks} marks`);
        }

        const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
        const grade = percentage >= 90 ? 'A+' : percentage >= 80 ? 'A' : percentage >= 70 ? 'B' : percentage >= 60 ? 'C' : percentage >= 50 ? 'D' : 'F';

        evalDoc.totalScore   = totalScore;
        evalDoc.percentage   = percentage;
        evalDoc.grade        = grade;
        evalDoc.feedbackJson = JSON.stringify({ summary: `Scored ${totalScore}/${maxScore}`, segmentsFound: segmentCount });
        await evalDoc.save();

        submission.status = 'evaluated';
        await submission.save();

        logger.info(`[Eval] Done — ${totalScore}/${maxScore} (${percentage}%) Grade: ${grade}`);

      } catch (bgErr) {
        logger.error('Background eval error:', bgErr);
        submission.status  = 'failed';
        submission.errorMsg = bgErr.message;
        await submission.save();
      }
    })();
  } catch (err) {
    logger.error('Upload error:', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;

