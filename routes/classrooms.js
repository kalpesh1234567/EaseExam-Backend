const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Classroom = require('../models/Classroom');
const Enrollment = require('../models/Enrollment');
const Test = require('../models/Test');

function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// GET /api/classrooms — teacher: own classrooms; student: enrolled classrooms
router.get('/', auth, async (req, res) => {
  try {
    if (req.user.role === 'teacher') {
      const classrooms = await Classroom.find({ owner: req.user.id }).populate('owner', 'firstName lastName');
      // Append counts
      const result = await Promise.all(classrooms.map(async (c) => {
        const studentCount = await Enrollment.countDocuments({ classroom: c._id });
        const testCount    = await Test.countDocuments({ classroom: c._id });
        return { ...c.toJSON(), studentCount, testCount };
      }));
      return res.json(result);
    } else {
      // student — get enrolled classrooms
      const enrollments = await Enrollment.find({ student: req.user.id }).populate({ path: 'classroom', populate: { path: 'owner', select: 'firstName lastName' } });
      return res.json(enrollments.map(e => e.classroom));
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/classrooms — teacher only
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ message: 'Only teachers can create classrooms' });
    const { name, description } = req.body;
    let code;
    let attempts = 0;
    do { code = generateCode(); attempts++; } while ((await Classroom.findOne({ code })) && attempts < 10);

    const classroom = await Classroom.create({ name, description: description || '', code, owner: req.user.id });
    res.status(201).json(classroom);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/classrooms/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const classroom = await Classroom.findById(req.params.id).populate('owner', 'firstName lastName');
    if (!classroom) return res.status(404).json({ message: 'Classroom not found' });
    // Access check
    const isOwner = classroom.owner._id.toString() === req.user.id;
    const isEnrolled = await Enrollment.findOne({ classroom: classroom._id, student: req.user.id });
    if (!isOwner && !isEnrolled) return res.status(403).json({ message: 'Access denied' });

    const students = await Enrollment.find({ classroom: classroom._id }).populate('student', 'firstName lastName username email');
    const tests    = await Test.find({ classroom: classroom._id }).sort('startTime');
    res.json({ classroom, students: students.map(e => e.student), tests, isOwner });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/classrooms/join — student joins by code
router.post('/join', auth, async (req, res) => {
  try {
    if (req.user.role !== 'student') return res.status(403).json({ message: 'Only students can join classrooms' });
    const { code } = req.body;
    const classroom = await Classroom.findOne({ code: code?.toUpperCase() });
    if (!classroom) return res.status(404).json({ message: 'Invalid classroom code' });
    const existing = await Enrollment.findOne({ classroom: classroom._id, student: req.user.id });
    if (existing) return res.status(200).json({ message: 'Already enrolled', classroom });
    await Enrollment.create({ classroom: classroom._id, student: req.user.id });
    res.status(201).json({ message: 'Joined successfully', classroom });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
