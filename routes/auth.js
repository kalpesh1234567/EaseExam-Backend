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

module.exports = router;
