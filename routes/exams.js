const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const upload = require('../utils/fileUpload');
const Exam = require('../models/Exam');
const Classroom = require('../models/Classroom');
const Enrollment = require('../models/Enrollment');
const AnswerKey = require('../models/AnswerKey');
const StudentSubmission = require('../models/StudentSubmission');

// GET /api/exams — Teacher gets own exams, Student gets enrolled classroom exams
router.get('/', auth, async (req, res) => {
  try {
    let filter = {};
    if (req.user.role === 'teacher') {
      filter = { teacher: req.user.id };
    } else {
      const enrollments = await Enrollment.find({ student: req.user.id });
      const classroomIds = enrollments.map(e => e.classroom);
      filter = { classroom: { $in: classroomIds } };
    }
    const exams = await Exam.find(filter)
      .populate('teacher', 'firstName lastName')
      .populate('classroom', 'name')
      .sort('-createdAt');
    res.json(exams);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/exams — Create a new exam (teacher only)
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ message: 'Only teachers can create exams' });
    const { title, subject, maxMarks, description, classroomId } = req.body;
    if (!classroomId) return res.status(400).json({ message: 'Classroom ID is required' });

    const classroom = await Classroom.findOne({ _id: classroomId, owner: req.user.id });
    if (!classroom) return res.status(403).json({ message: 'Invalid classroom selection' });

    const exam = await Exam.create({ title, subject, maxMarks, description, teacher: req.user.id, classroom: classroom._id });
    res.status(201).json(exam);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/exams/:id — Get exam details with answer key & submission info
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

// GET /api/exams/:id/submissions-status — Get all enrolled students and their submission status (teacher only)
router.get('/:id/submissions-status', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ message: 'Forbidden' });

    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ message: 'Exam not found' });

    // 1. Get all enrolled students for this classroom
    const enrollments = await Enrollment.find({ classroom: exam.classroom }).populate('student', 'firstName lastName username email');
    
    // 2. Get all submissions for this exam
    const submissions = await StudentSubmission.find({ exam: exam._id });

    // 3. Map enrollments to status
    const statusList = enrollments.map(en => {
      const sub = submissions.find(s => s.student.toString() === en.student._id.toString());
      return {
        student: en.student,
        hasSubmitted: !!sub,
        status: sub ? sub.status : 'not_submitted',
        submissionId: sub ? sub._id : null,
        fileUrl: sub ? sub.fileUrl : null,
        updatedAt: sub ? sub.updatedAt : null
      };
    });

    res.json({ exam, students: statusList });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/exams/:id/question-paper — Upload question paper PDF (teacher only)
router.post('/:id/question-paper', auth, upload.single('questionPaper'), async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ message: 'Only teachers can upload question papers' });
    if (!req.file) return res.status(400).json({ message: 'No file uploaded. Please attach a PDF.' });

    const exam = await Exam.findOne({ _id: req.params.id, teacher: req.user.id });
    if (!exam) return res.status(404).json({ message: 'Exam not found or forbidden' });

    exam.questionPaperUrl = req.file.path; // Cloudinary returns the full URL in path
    await exam.save();

    res.json({ message: 'Question paper uploaded successfully', questionPaperUrl: exam.questionPaperUrl });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/exams/:id/question-paper — Remove question paper (teacher only)
router.delete('/:id/question-paper', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ message: 'Forbidden' });

    const exam = await Exam.findOne({ _id: req.params.id, teacher: req.user.id });
    if (!exam) return res.status(404).json({ message: 'Exam not found or forbidden' });

    exam.questionPaperUrl = '';
    await exam.save();
    res.json({ message: 'Question paper removed' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
