const mongoose = require('mongoose');

const enrollmentSchema = new mongoose.Schema({
  classroom: { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', required: true },
  student:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

enrollmentSchema.index({ classroom: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('Enrollment', enrollmentSchema);
