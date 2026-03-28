const mongoose = require('mongoose');

const testSchema = new mongoose.Schema({
  classroom:   { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom', required: true },
  name:        { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  startTime:   { type: Date, required: true },
  endTime:     { type: Date, required: true },
  isActive:    { type: Boolean, default: true },
}, { timestamps: true });

testSchema.virtual('isOngoing').get(function () {
  const now = new Date();
  return this.startTime <= now && now <= this.endTime;
});

testSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Test', testSchema);
