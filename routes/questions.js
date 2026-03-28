const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const Question = require('../models/Question');
const Test = require('../models/Test');
const Classroom = require('../models/Classroom');

// POST /api/questions — add question to test
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ message: 'Only teachers can add questions' });
    const { testId, text, referenceAnswer, maxScore } = req.body;
    const test = await Test.findById(testId).populate('classroom', 'owner');
    if (!test) return res.status(404).json({ message: 'Test not found' });
    if (test.classroom.owner.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });
    const order = (await Question.countDocuments({ test: testId })) + 1;
    const question = await Question.create({ test: testId, text, referenceAnswer, maxScore: maxScore || 10, order });
    res.status(201).json(question);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/questions?testId=xxx
router.get('/', auth, async (req, res) => {
  try {
    const { testId } = req.query;
    const questions = await Question.find({ test: testId }).sort('order');
    res.json(questions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/questions/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const question = await Question.findById(req.params.id).populate({ path: 'test', populate: { path: 'classroom', select: 'owner' } });
    if (!question) return res.status(404).json({ message: 'Question not found' });
    if (question.test.classroom.owner.toString() !== req.user.id) return res.status(403).json({ message: 'Forbidden' });
    await Question.findByIdAndDelete(req.params.id);
    res.json({ message: 'Question deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
