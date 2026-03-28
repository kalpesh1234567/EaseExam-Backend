const mongoose = require('mongoose');

const evaluationSchema = new mongoose.Schema({
  submission:    { type: mongoose.Schema.Types.ObjectId, ref: 'StudentSubmission', required: true, unique: true },
  totalScore:    { type: Number, default: 0 },
  maxScore:      { type: Number, required: true },
  percentage:    { type: Number, default: 0 },
  grade:         { type: String, default: '' },
  feedbackJson:  { type: String, default: '' }, // High level overall feedback
  evaluatedAt:   { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('Evaluation', evaluationSchema);
