const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { Parser } = require('json2csv');
const PDFDocument = require('pdfkit');
const Exam = require('../models/Exam');
const StudentSubmission = require('../models/StudentSubmission');
const Evaluation = require('../models/Evaluation');

/**
 * @swagger
 * /api/export/{examId}/csv:
 *   get:
 *     summary: Export results as CSV
 *     tags: [Export]
 *     security:
 *       - BearerAuth: []
 */
router.get('/:examId/csv', auth, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam || exam.teacher.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

    const submissions = await StudentSubmission.find({ exam: exam._id }).populate('student', 'firstName lastName email');
    const evaluations = await Evaluation.find({ submission: { $in: submissions.map(s => s._id) } });

    const data = submissions.map(sub => {
      const ev = evaluations.find(e => e.submission.toString() === sub._id.toString());
      return {
        StudentName: `${sub.student.firstName} ${sub.student.lastName}`,
        Email: sub.student.email,
        Status: sub.status,
        TotalScore: ev ? ev.totalScore : 'N/A',
        Percentage: ev ? ev.percentage : 'N/A',
        Grade: ev ? ev.grade : 'N/A'
      };
    });

    const parser = new Parser();
    const csv = parser.parse(data);

    res.header('Content-Type', 'text/csv');
    res.attachment(`${exam.title.replace(/\s+/g, '_')}_Results.csv`);
    return res.send(csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * @swagger
 * /api/export/{examId}/pdf:
 *   get:
 *     summary: Export results as PDF
 *     tags: [Export]
 *     security:
 *       - BearerAuth: []
 */
router.get('/:examId/pdf', auth, async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.examId);
    if (!exam || exam.teacher.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

    const submissions = await StudentSubmission.find({ exam: exam._id }).populate('student', 'firstName lastName');
    const evaluations = await Evaluation.find({ submission: { $in: submissions.map(s => s._id) } });

    const doc = new PDFDocument();
    res.setHeader('Content-disposition', `attachment; filename="${exam.title.replace(/\s+/g, '_')}_Results.pdf"`);
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);

    doc.fontSize(20).text(`Results: ${exam.title}`, { align: 'center' });
    doc.fontSize(12).text(`Subject: ${exam.subject} | Max Marks: ${exam.maxMarks}`, { align: 'center' });
    doc.moveDown(2);

    submissions.forEach((sub, i) => {
      const ev = evaluations.find(e => e.submission.toString() === sub._id.toString());
      const name = `${sub.student.firstName} ${sub.student.lastName}`;
      if (ev) {
        doc.fontSize(12).text(`${i+1}. ${name} - Score: ${ev.totalScore} (${ev.percentage}%) - Grade: ${ev.grade}`);
      } else {
        doc.fontSize(12).text(`${i+1}. ${name} - Status: ${sub.status}`);
      }
      doc.moveDown(0.5);
    });

    doc.end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
