const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Exam = require('../models/Exam');
const StudentSubmission = require('../models/StudentSubmission');
const Evaluation = require('../models/Evaluation');
const QuestionScore = require('../models/QuestionScore');

/**
 * @swagger
 * /api/results/teacher/{examId}:
 *   get:
 *     summary: Teacher views all student results for an exam
 *     tags: [Results]
 *     security:
 *       - BearerAuth: []
 */
router.get('/teacher/:examId', auth, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam || exam.teacher.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const submissions = await StudentSubmission.find({ exam: exam._id }).populate('student', 'firstName lastName email username');
    const evaluations = await Evaluation.find({ submission: { $in: submissions.map(s => s._id) } });

    const results = submissions.map(sub => {
      const evalDoc = evaluations.find(e => e.submission.toString() === sub._id.toString());
      return {
        student: sub.student,
        status: sub.status,
        fileUrl: sub.fileUrl,
        evaluation: evalDoc || null
      };
    });

    res.json(results);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * @swagger
 * /api/results/student/{examId}:
 *   get:
 *     summary: Student views their own detailed result
 *     tags: [Results]
 *     security:
 *       - BearerAuth: []
 */
router.get('/student/:examId', auth, async (req, res) => {
  try {
    const sub = await StudentSubmission.findOne({ exam: req.params.examId, student: req.user.id }).populate('exam', 'title subject maxMarks');
    if (!sub) return res.status(404).json({ message: 'No submission found' });

    if (sub.status !== 'evaluated') {
      return res.json({ status: sub.status, errorMsg: sub.errorMsg, exam: sub.exam });
    }

    const evalDoc = await Evaluation.findOne({ submission: sub._id });
    const qScores = await QuestionScore.find({ evaluation: evalDoc._id }).sort('questionNo');

    res.json({
      status: sub.status,
      exam: sub.exam,
      evaluation: evalDoc,
      questionScores: qScores
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
