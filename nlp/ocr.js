const fs = require('fs');
const pdfParse = require('pdf-parse');
const { createWorker } = require('tesseract.js');
const logger = require('../utils/logger');

/**
 * Extracts text from uploaded files (PDF or Images).
 * - For PDFs, attempts to parse text layers first.
 * - Extracts text from images using tesseract.js.
 */
async function extractText(filePath, mimetype) {
  try {
    // 1. Handle PDF
    if (mimetype === 'application/pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      if (data.text && data.text.trim().length > 10) {
        return data.text.trim();
      }
      // If PDF has no text layer (it's scanned), we would need ghostscript/imagemagick
      // to convert PDF pages to images then run Tesseract. For this MVP, we assume
      // text-based PDFs or direct Image uploads.
      logger.warn(`PDF has no extractable text layer or is scanned: ${filePath}`);
      return data.text || '';
    }

    // 2. Handle Images (OCR via Tesseract.js)
    if (['image/jpeg', 'image/png', 'image/jpg'].includes(mimetype)) {
      const worker = await createWorker('eng');
      const { data: { text } } = await worker.recognize(filePath);
      await worker.terminate();
      return text.trim();
    }

    throw new Error('Unsupported file type for extraction');
  } catch (err) {
    logger.error('Error extracting text:', err);
    throw err;
  }
}

module.exports = { extractText };
