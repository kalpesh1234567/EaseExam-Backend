const mongoose = require('mongoose');

const examSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  subject:     { type: String, required: true, trim: true },
  teacher:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  maxMarks:    { type: Number, required: true },
  description: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Exam', examSchema);
