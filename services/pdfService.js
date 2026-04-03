const pdfParse = require('pdf-parse');
const logger = require('../utils/logger');

/**
 * Extract text from a PDF buffer using pdf-parse.
 * Simple and stable — no OCR, no vision models.
 * Returns empty string if the PDF is scanned (image-only).
 */
const extractTextFromPDF = async (dataBuffer) => {
  try {
    const data = await pdfParse(dataBuffer);
    const text = (data.text || '').trim();
    logger.info(`[PDF] Extracted ${text.length} chars.`);

    if (text.length < 20) {
      logger.warn('[PDF] Very little text — PDF is likely scanned (image-only).');
    }

    return text;
  } catch (error) {
    logger.error('[PDF] pdf-parse failed: ' + error.message);
    return '';
  }
};

module.exports = {
  extractTextFromPDF
};
