const mongoose = require('mongoose');

const studentSubmissionSchema = new mongoose.Schema({
  exam:       { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
  student:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  fileUrl:    { type: String, required: true },
  ocrText:    { type: String, default: '' },
  status:     { type: String, enum: ['pending', 'evaluated', 'failed'], default: 'pending' },
  errorMsg:   { type: String, default: '' }
}, { timestamps: true });

studentSubmissionSchema.index({ exam: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('StudentSubmission', studentSubmissionSchema);
