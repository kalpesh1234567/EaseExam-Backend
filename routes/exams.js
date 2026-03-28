const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Exam = require('../models/Exam');
const AnswerKey = require('../models/AnswerKey');
const StudentSubmission = require('../models/StudentSubmission');

/**
 * @swagger
 * tags:
 *   name: Exams
 *   description: Exam management
 */

/**
 * @swagger
 * /api/exams:
 *   get:
 *     summary: Get all exams (Teacher gets own, Student gets all available)
 *     tags: [Exams]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of exams
 */
router.get('/', auth, async (req, res) => {
  try {
    const filter = req.user.role === 'teacher' ? { teacher: req.user.id } : {};
    const exams = await Exam.find(filter).populate('teacher', 'firstName lastName').sort('-createdAt');
    res.json(exams);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * @swagger
 * /api/exams:
 *   post:
 *     summary: Create a new exam
 *     tags: [Exams]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string }
 *               subject: { type: string }
 *               maxMarks: { type: number }
 *               description: { type: string }
 *     responses:
 *       201:
 *         description: Exam created
 */
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ message: 'Only teachers can create exams' });
    const { title, subject, maxMarks, description } = req.body;
    const exam = await Exam.create({ title, subject, maxMarks, description, teacher: req.user.id });
    res.status(201).json(exam);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * @swagger
 * /api/exams/{id}:
 *   get:
 *     summary: Get exam details
 *     tags: [Exams]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Exam details
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id).populate('teacher', 'firstName lastName');
    if (!exam) return res.status(404).json({ message: 'Exam not found' });

    const key = await AnswerKey.findOne({ exam: exam._id });
    const isOwner = exam.teacher._id.toString() === req.user.id;

    let submission = null;
    let submissionCount = 0;

    if (isOwner) {
      submissionCount = await StudentSubmission.countDocuments({ exam: exam._id });
    } else {
      submission = await StudentSubmission.findOne({ exam: exam._id, student: req.user.id });
    }

    res.json({ exam, hasAnswerKey: !!key, answerKey: isOwner ? key : null, isOwner, submissionCount, submission });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
