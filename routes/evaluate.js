const express = require('express');
const router = express.Router();
const { evaluateAnswer } = require('../nlp/engine');

// POST /api/evaluate — evaluate a single answer (public API)
router.post('/', async (req, res) => {
  try {
    const { student_answer, reference_answer, max_score } = req.body;
    const result = evaluateAnswer(student_answer || '', reference_answer || '', parseInt(max_score) || 10);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
