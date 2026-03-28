const nodemailer = require('nodemailer');
const logger = require('./logger');

const sendEmail = async (options) => {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  const message = {
    from: `${process.env.EMAIL_USER}`,
    to: options.email,
    subject: options.subject,
    text: options.message
  };

  try {
    const info = await transporter.sendMail(message);
    logger.info(`Email sent: ${info.messageId}`);
  } catch (error) {
    logger.error('Error sending email:', error);
    throw error;
  }
};

module.exports = sendEmail;
