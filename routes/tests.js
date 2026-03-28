const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Test = require('../models/Test');
const Question = require('../models/Question');
const Classroom = require('../models/Classroom');
const Enrollment = require('../models/Enrollment');
const TestSubmission = require('../models/TestSubmission');

// GET /api/tests?classroomId=xxx
router.get('/', auth, async (req, res) => {
  try {
    const { classroomId } = req.query;
    const filter = classroomId ? { classroom: classroomId } : {};
    const tests = await Test.find(filter).populate('classroom', 'name code owner').sort('startTime');
    res.json(tests);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/tests
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ message: 'Only teachers can create tests' });
    const { classroomId, name, description, startTime, endTime } = req.body;
    const classroom = await Classroom.findOne({ _id: classroomId, owner: req.user.id });
    if (!classroom) return res.status(404).json({ message: 'Classroom not found' });
    const test = await Test.create({ classroom: classroomId, name, description: description || '', startTime, endTime });
    res.status(201).json(test);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/tests/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const test = await Test.findById(req.params.id).populate('classroom', 'name owner');
    if (!test) return res.status(404).json({ message: 'Test not found' });
    const questions = await Question.find({ test: test._id }).sort('order');
    const isOwner   = test.classroom.owner.toString() === req.user.id;
    let submissionCount = 0;
    let existingSubmission = null;
    if (isOwner) {
      submissionCount = await TestSubmission.countDocuments({ test: test._id });
    } else {
      const enrolled = await Enrollment.findOne({ classroom: test.classroom._id, student: req.user.id });
      if (!enrolled) return res.status(403).json({ message: 'Not enrolled in this classroom' });
      existingSubmission = await TestSubmission.findOne({ test: test._id, student: req.user.id });
    }
    res.json({ test, questions, isOwner, submissionCount, existingSubmission });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/tests/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const test = await Test.findById(req.params.id).populate('classroom', 'owner');
    if (!test) return res.status(404).json({ message: 'Test not found' });
    if (test.classroom.owner.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });
    await Test.findByIdAndDelete(req.params.id);
    await Question.deleteMany({ test: req.params.id });
    res.json({ message: 'Test deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
