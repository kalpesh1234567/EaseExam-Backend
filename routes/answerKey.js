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

    // Background Auto-Fill: If some model answers are empty and a file was uploaded
    const needsAutoFill = fileUrl && (questions.some(q => !q.modelAnswer || q.modelAnswer.trim().length === 0));

    if (needsAutoFill) {
      (async () => {
        try {
          const axios = require('axios');
          const path = require('path');
          const { extractTextWithGemini, autoExtractAnswerKey } = require('../nlp/aiEvaluator');

          // 1. Download file from Cloudinary 
          const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
          const buffer = Buffer.from(response.data);

          // 2. OCR based on file extension
          const ext = path.extname(fileUrl).toLowerCase();
          let ocrText = '';

          if (ext === '.pdf') {
            try {
              const pdfParse = require('pdf-parse');
              const data = await pdfParse(buffer);
              ocrText = (data.text || '').trim();
              if (ocrText.length < 50) {
                 logger.info('[AutoFill] Scanned PDF detected, using Vision OCR...');
                 ocrText = await extractTextWithGemini(buffer, 'application/pdf');
              }
            } catch (e) {
              ocrText = await extractTextWithGemini(buffer, 'application/pdf');
            }
          } else {
            const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
            ocrText = await extractTextWithGemini(buffer, mimeType);
          }

          // 3. AI Structure Extraction
          if (ocrText && ocrText.length > 20) {
            const updatedQuestions = await autoExtractAnswerKey(ocrText, questions);
            
            // 4. Update the AnswerKey document
            key.questions = updatedQuestions;
            await key.save();
            logger.info(`[AutoFill] Successfully auto-extracted answer key for exam ${exam._id}.`);
          }
        } catch (fillErr) {
          logger.error('[AutoFill] Failed to auto-extract answer key:', fillErr.message);
        }
      })();
    }

    res.status(201).json(key);
  } catch (err) {
    logger.error('AnswerKey upload failed:', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
