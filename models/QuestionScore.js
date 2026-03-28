const mongoose = require('mongoose');

const questionScoreSchema = new mongoose.Schema({
  evaluation:    { type: mongoose.Schema.Types.ObjectId, ref: 'Evaluation', required: true },
  questionNo:    { type: Number, required: true },
  marksObtained: { type: Number, required: true },
  maxMarks:      { type: Number, required: true },
  studentAnswer: { type: String, default: '' },
  feedback:      { type: String, default: '' },
  suggestion:    { type: String, default: '' }
}, { timestamps: true });

questionScoreSchema.index({ evaluation: 1, questionNo: 1 }, { unique: true });

module.exports = mongoose.model('QuestionScore', questionScoreSchema);
