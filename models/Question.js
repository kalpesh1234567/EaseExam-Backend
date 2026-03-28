const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
  test:            { type: mongoose.Schema.Types.ObjectId, ref: 'Test', required: true },
  text:            { type: String, required: true },
  referenceAnswer: { type: String, required: true },
  maxScore:        { type: Number, default: 10 },
  order:           { type: Number, default: 0 },
}, { timestamps: true });

questionSchema.index({ test: 1, order: 1 });

module.exports = mongoose.model('Question', questionSchema);
