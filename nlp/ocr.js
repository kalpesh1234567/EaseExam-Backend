const fs = require('fs');
const { PDFParse } = require('pdf-parse');
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
      const pdf = new PDFParse({ verbosity: 0 });
      await pdf.load(dataBuffer);
      const text = await pdf.getText();
      if (text && text.trim().length > 10) {
        return text.trim();
      }
      logger.warn(`PDF has no extractable text layer or is scanned: ${filePath}`);
      return text || '';
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
