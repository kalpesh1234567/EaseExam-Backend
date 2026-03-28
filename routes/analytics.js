const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Exam = require('../models/Exam');
const StudentSubmission = require('../models/StudentSubmission');
const Evaluation = require('../models/Evaluation');

/**
 * @swagger
 * /api/analytics/{examId}:
 *   get:
 *     summary: Get analytics for an exam
 *     tags: [Analytics]
 *     security:
 *       - BearerAuth: []
 */
router.get('/:examId', auth, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam || exam.teacher.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

    const submissions = await StudentSubmission.find({ exam: exam._id });
    const evaluatedIds = submissions.filter(s => s.status === 'evaluated').map(s => s._id);
    const evaluations = await Evaluation.find({ submission: { $in: evaluatedIds } }).populate({ path: 'submission', populate: { path: 'student', select: 'firstName lastName' } });

    const totalStudents = submissions.length;
    const evaluatedCount = evaluations.length;

    if (evaluatedCount === 0) {
      return res.json({ totalStudents, evaluatedCount, avgScore: 0, failCount: 0, topPerformers: [] });
    }

    const avgScore = evaluations.reduce((acc, curr) => acc + curr.totalScore, 0) / evaluatedCount;
    const failCount = evaluations.filter(e => e.percentage < 40).length; // < 40% = fail
    
    // Sort descending by score, take top 3
    const sorted = [...evaluations].sort((a, b) => b.totalScore - a.totalScore);
    const topPerformers = sorted.slice(0, 3).map(e => ({
      name: `${e.submission.student.firstName} ${e.submission.student.lastName}`,
      score: e.totalScore,
      percentage: e.percentage
    }));

    res.json({
      totalStudents,
      evaluatedCount,
      avgScore: Math.round(avgScore * 100) / 100,
      failCount,
      topPerformers
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
