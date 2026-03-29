const AnswerKey = require('../models/AnswerKey');
const Exam = require('../models/Exam');
const { extractTextFromPDF } = require('../services/pdfService');
const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const logger = require('../utils/logger');

const uploadAnswerKey = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Only PDF files are allowed' });
    }

    const { examId } = req.body;
    if (!examId) {
      // Clean up local file
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'Exam ID is required' });
    }

    const exam = await Exam.findById(examId);
    if (!exam) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }

    if (exam.teacher.toString() !== req.user.id) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ success: false, message: 'Forbidden: You are not the owner of this exam' });
    }

    // 1. Extract text from the local PDF
    const dataBuffer = fs.readFileSync(req.file.path);
    const extractedText = await extractTextFromPDF(dataBuffer);

    if (!extractedText || extractedText.trim().length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'Empty PDF (no extractable text)' });
    }

    // 2. Upload to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'easyexam/answer_keys',
      resource_type: 'raw', // PDF is handled as raw or image depending on use-case, 'raw' preserves extension
    });

    // 3. Save to database
    // Note: We use findOneAndUpdate to allow overwriting as requested
    const answerKey = await AnswerKey.findOneAndUpdate(
      { exam: examId },
      { 
        fileUrl: result.secure_url, 
        extractedText: extractedText, 
        uploadedAt: new Date() 
      },
      { upsert: true, new: true }
    );

    // 4. Clean up local file
    fs.unlinkSync(req.file.path);

    res.status(201).json({
      success: true,
      message: "File uploaded successfully",
      fileUrl: result.secure_url,
      extractedText: extractedText,
      uploadedAt: answerKey.updatedAt
    });

  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    logger.error('Teacher upload error:', error);
    res.status(500).json({ success: false, message: error.message || "Could not read PDF content" });
  }
};

module.exports = {
  uploadAnswerKey
};
