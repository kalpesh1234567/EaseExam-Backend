const StudentSubmission = require('../models/StudentSubmission');
const Exam = require('../models/Exam');
const Enrollment = require('../models/Enrollment');
const { extractTextFromPDF } = require('../services/pdfService');
const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const logger = require('../utils/logger');
const { evaluateSingleAnswer, segmentAnswerSheet } = require('../nlp/aiEvaluator');
const AnswerKey = require('../models/AnswerKey');
const Evaluation = require('../models/Evaluation');
const QuestionScore = require('../models/QuestionScore');

const uploadAnswerSheet = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Only PDF files are allowed' });
    }

    const { examId } = req.body;
    if (!examId) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'Exam ID is required' });
    }

    if (req.user.role !== 'student') {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ success: false, message: 'Only students can upload answer sheets' });
    }

    // 1. Check for duplicate submission
    const existing = await StudentSubmission.findOne({ exam: examId, student: req.user.id });
    if (existing) {
      fs.unlinkSync(req.file.path);
      return res.status(409).json({ success: false, message: 'Already submitted' });
    }

    // 2. Extract text from the local PDF
    const dataBuffer = fs.readFileSync(req.file.path);
    const extractedText = await extractTextFromPDF(dataBuffer);

    if (!extractedText || extractedText.trim().length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'Empty PDF: no extractable text found.' });
    }

    // 3. Upload to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'easyexam/student_submissions',
      resource_type: 'raw',
    });

    // 4. Save to database
    const submission = await StudentSubmission.create({
      exam: examId,
      student: req.user.id,
      fileUrl: result.secure_url,
      ocrText: extractedText,
      status: 'pending'
    });

    // 5. Clean up local file
    fs.unlinkSync(req.file.path);

    res.status(201).json({
      success: true,
      message: "File uploaded successfully",
      fileUrl: result.secure_url,
      extractedText: extractedText,
      submittedAt: submission.createdAt
    });

    // 6. Background Evaluation (Reuse existing logic)
    (async () => {
      try {
        const answerKey = await AnswerKey.findOne({ exam: examId });
        if (!answerKey || !answerKey.questions || answerKey.questions.length === 0) {
           submission.status = 'failed';
           submission.errorMsg = 'No answer key found for this exam.';
           await submission.save();
           return;
        }

        let totalScore = 0;
        const maxScore = answerKey.questions.reduce((s, q) => s + q.maxMarks, 0);

        const evalDoc = await Evaluation.create({
          submission: submission._id,
          totalScore: 0,
          maxScore,
          percentage: 0,
          grade: '',
          feedbackJson: '',
        });

        // Use the extracted text to evaluate each question
        // 1. First, segment the sheet using Gemini
        const segments = await segmentAnswerSheet(extractedText, answerKey.questions);

        for (const q of answerKey.questions) {
          // Use segmented answer if available, else fallback to full text
          const studentSegment = segments[String(q.questionNo)] || extractedText;
          
          const result = await evaluateSingleAnswer(studentSegment, q.modelAnswer, q.maxMarks, q.text);
          totalScore += result.marksObtained;

          await QuestionScore.create({
            evaluation: evalDoc._id,
            questionNo: q.questionNo,
            marksObtained: result.marksObtained,
            maxMarks: q.maxMarks,
            studentAnswer: studentSegment,
            feedback: result.feedback,
            suggestion: result.suggestion,
          });
        }

        const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
        const grade = percentage >= 90 ? 'A+' : percentage >= 80 ? 'A' : percentage >= 70 ? 'B' : percentage >= 60 ? 'C' : percentage >= 50 ? 'D' : 'F';

        evalDoc.totalScore = totalScore;
        evalDoc.percentage = percentage;
        evalDoc.grade = grade;
        evalDoc.feedbackJson = JSON.stringify({ summary: `Scored ${totalScore}/${maxScore}` });
        await evalDoc.save();

        submission.status = 'evaluated';
        await submission.save();
        logger.info(`Submission ${submission._id} evaluated successfully.`);
      } catch (bgErr) {
        logger.error('Background eval error:', bgErr);
        submission.status = 'failed';
        submission.errorMsg = bgErr.message;
        await submission.save();
      }
    })();

  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    logger.error('Student upload error:', error);
    res.status(500).json({ success: false, message: error.message || "Could not read PDF content" });
  }
};

module.exports = {
  uploadAnswerSheet
};
