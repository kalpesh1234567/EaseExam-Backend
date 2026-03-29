const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');
const { uploadAnswerKey } = require('../controllers/teacherController');

/**
 * @swagger
 * /api/teacher/upload-answer-key:
 *   post:
 *     summary: Teacher uploads a digital PDF answer key
 *     tags: [Teacher]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               examId:
 *                 type: string
 *               answerKey:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Answer key uploaded and processed
 */
router.post('/upload-answer-key', auth, upload.single('answerKey'), uploadAnswerKey);

module.exports = router;
