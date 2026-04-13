const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
const path = require('path');

// Configure Cloudinary from .env
const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
const api_key = process.env.CLOUDINARY_API_KEY;
const api_secret = process.env.CLOUDINARY_API_SECRET;

if (!cloud_name || !api_key || !api_secret) {
  const logger = require('./logger');
  logger.warn('WARNING: Cloudinary credentials (NAME/KEY/SECRET) are missing. File uploads WILL fail.');
}

cloudinary.config({
  cloud_name,
  api_key,
  api_secret,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    let folder = 'easeexam/sheets';
    if (file.fieldname === 'answerKey')     folder = 'easeexam/keys';
    else if (file.fieldname === 'questionPaper') folder = 'easeexam/papers';

    const isPDF = file.originalname.toLowerCase().endsWith('.pdf');
    // PDFs MUST be uploaded as 'raw' — Cloudinary's 'image' and 'auto' types
    // do NOT serve PDF content properly (they try to treat it as an image).
    // Only 'raw' allows the PDF to be fetched and streamed correctly.
    return {
      folder: folder,
      resource_type: isPDF ? 'raw' : 'auto',
      public_id: `${Date.now()}-${file.originalname.split('.')[0]}`,
    };
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF, JPG, and PNG files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

/**
 * NOTE: Cloudinary `raw` resources do NOT support URL transformations.
 * Injecting fl_attachment:false into a raw URL causes 401 Unauthorized.
 * PDF inline-viewing is handled on the frontend via Google Docs Viewer.
 * This function is kept as a no-op so callers remain unchanged.
 */
function getInlinePdfUrl(url) {
  return url || '';
}

module.exports = upload;
module.exports.getInlinePdfUrl = getInlinePdfUrl;
