const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const TestSubmission = require('../models/TestSubmission');
const Answer = require('../models/Answer');
const Question = require('../models/Question');
const Test = require('../models/Test');
const Enrollment = require('../models/Enrollment');
const { evaluateAnswer } = require('../nlp/engine');

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
    const test      = await Test.findById(req.params.testId).populate('classroom', 'name');
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
    const questions   = await Question.find({ test: test._id }).sort('order');
    const totalMarks  = questions.reduce((s, q) => s + q.maxScore, 0);

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
    submission.isReviewed   = allAnswers.every(a => a.teacherScore !== null);
    await submission.save();

    res.json({ answer, submission });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
