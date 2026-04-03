const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const upload = require('../utils/fileUpload');
const logger = require('../utils/logger');
const Exam = require('../models/Exam');
const AnswerKey = require('../models/AnswerKey');

/**
 * @swagger
 * /api/answerKey/{examId}:
 *   post:
 *     summary: Upload answer key for an exam (PDF/Image) or JSON
 *     tags: [AnswerKey]
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
 *               answerKey:
 *                 type: string
 *                 format: binary
 *               questionsJson:
 *                 type: string
 *                 description: JSON string array of {questionNo, text, modelAnswer, maxMarks}
 *     responses:
 *       201:
 *         description: Answer key saved
 */
router.post('/:examId', auth, upload.single('answerKey'), async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ message: 'Only teachers can configure answer keys' });

    const exam = await Exam.findById(req.params.examId);
    if (!exam || exam.teacher.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Exam not found or forbidden' });
    }

    let questions = [];
    if (req.body.questionsJson) {
      try {
        questions = JSON.parse(req.body.questionsJson);
      } catch (e) {
        return res.status(400).json({ message: 'Invalid questions JSON format' });
      }
    }

    const fileUrl = req.file ? req.file.path : '';

    const existingKey = await AnswerKey.findOne({ exam: exam._id });
    if (existingKey) {
      existingKey.questions = questions;
      if (fileUrl) existingKey.fileUrl = fileUrl;
      await existingKey.save();
      return res.json(existingKey);
    }

    const key = await AnswerKey.create({ exam: exam._id, fileUrl, questions });
    res.status(201).json(key);
  } catch (err) {
    logger.error('AnswerKey upload failed:', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
