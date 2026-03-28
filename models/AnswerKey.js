const mongoose = require('mongoose');

const keyQuestionSchema = new mongoose.Schema({
  questionNo:  { type: Number, required: true },
  text:        { type: String, default: '' },
  modelAnswer: { type: String, required: true },
  maxMarks:    { type: Number, required: true },
});

const answerKeySchema = new mongoose.Schema({
  exam:      { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true, unique: true },
  fileUrl:   { type: String, default: '' }, // If uploaded as a file
  questions: [keyQuestionSchema],
}, { timestamps: true });

module.exports = mongoose.model('AnswerKey', answerKeySchema);
