const mongoose = require('mongoose');

const classroomSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  code:        { type: String, required: true, unique: true, uppercase: true },
  description: { type: String, default: '' },
  owner:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

module.exports = mongoose.model('Classroom', classroomSchema);
