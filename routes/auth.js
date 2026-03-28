const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const router = express.Router();

function generateToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, firstName: user.firstName, lastName: user.lastName },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { firstName, lastName, email, username, password, role } = req.body;
    if (!firstName || !lastName || !email || !username || !password || !role)
      return res.status(400).json({ message: 'All fields are required' });
    if (!['teacher', 'student'].includes(role))
      return res.status(400).json({ message: 'Invalid role' });

    const exists = await User.findOne({ $or: [{ email }, { username }] });
    if (exists) {
      if (exists.email === email) return res.status(400).json({ message: 'Email already in use' });
      return res.status(400).json({ message: 'Username already taken' });
    }

    const user = await User.create({ firstName, lastName, email, username, password, role });
    res.status(201).json({ token: generateToken(user), user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email, username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username and password required' });
    const user = await User.findOne({ $or: [{ username }, { email: username }] });
    if (!user || !(await user.matchPassword(password)))
      return res.status(401).json({ message: 'Invalid credentials' });
    res.json({ token: generateToken(user), user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email, username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');

// POST /api/auth/forgotpassword
router.post('/forgotpassword', async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email });
    if (!user) return res.status(404).json({ message: 'There is no user with that email' });

    const resetToken = user.getResetPasswordToken();
    await user.save({ validateBeforeSave: false });

    // Use environment variable or default to localhost for development
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetUrl = `${frontendUrl}/reset-password/${resetToken}`;

    const message = `You are receiving this email because you (or someone else) has requested the reset of a password. Please click on the link below to verify your identity and set a new password:\n\n${resetUrl}\n\nNote: If you did not request this, please ignore this email and your password will remain unchanged.`;

    // Send email asynchronously in the background to prevent UI delays
    sendEmail({
      email: user.email,
      subject: 'EasyExam Password Reset Token',
      message
    }).catch(async (err) => {
      // Cleanup token if background email fails
      user.resetPasswordToken = undefined;
      user.resetPasswordExpire = undefined;
      await user.save({ validateBeforeSave: false });
    });

    // Instantly return success to the user interface
    res.status(200).json({ message: 'Email sent successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/auth/resetpassword/:resettoken
router.put('/resetpassword/:resettoken', async (req, res) => {
  try {
    const resetPasswordToken = crypto.createHash('sha256').update(req.params.resettoken).digest('hex');
    
    const user = await User.findOne({
      resetPasswordToken,
      resetPasswordExpire: { $gt: Date.now() }
    });

    if (!user) return res.status(400).json({ message: 'Invalid or expired token' });
    if (!req.body.password) return res.status(400).json({ message: 'Password is required' });

    user.password = req.body.password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    res.status(200).json({
      message: 'Password correctly updated',
      token: generateToken(user),
      user: { id: user._id, firstName: user.firstName, lastName: user.lastName, email: user.email, username: user.username, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
