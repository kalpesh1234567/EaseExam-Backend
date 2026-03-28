const mongoose = require('mongoose');

const testSubmissionSchema = new mongoose.Schema({
  test:          { type: mongoose.Schema.Types.ObjectId, ref: 'Test', required: true },
  student:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  mlTotal:       { type: Number, default: 0 },
  teacherTotal:  { type: Number, default: null },
  isReviewed:    { type: Boolean, default: false },
}, { timestamps: true });

testSubmissionSchema.index({ test: 1, student: 1 }, { unique: true });

testSubmissionSchema.virtual('finalScore').get(function () {
  return this.teacherTotal !== null ? this.teacherTotal : this.mlTotal;
});

testSubmissionSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('TestSubmission', testSubmissionSchema);
