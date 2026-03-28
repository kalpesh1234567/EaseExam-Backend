const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema({
  submission:      { type: mongoose.Schema.Types.ObjectId, ref: 'TestSubmission', required: true },
  question:        { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  answerText:      { type: String, default: '' },
  mlScore:         { type: Number, default: 0 },
  teacherScore:    { type: Number, default: null },
  similarityScore: { type: Number, default: 0 },
  keywordScore:    { type: Number, default: 0 },
  matchedKeywords: [{ type: String }],
  missedKeywords:  [{ type: String }],
  feedback:        { type: String, default: '' },
}, { timestamps: true });

answerSchema.virtual('finalScore').get(function () {
  return this.teacherScore !== null ? this.teacherScore : this.mlScore;
});

answerSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Answer', answerSchema);
