const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');
const { uploadAnswerSheet } = require('../controllers/studentController');

/**
 * @swagger
 * /api/student/upload-answer-sheet:
 *   post:
 *     summary: Student uploads a digital PDF answer sheet
 *     tags: [Student]
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
 *               answerSheet:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Answer sheet uploaded and evaluation started
 */
router.post('/upload-answer-sheet', auth, upload.single('answerSheet'), uploadAnswerSheet);

module.exports = router;
