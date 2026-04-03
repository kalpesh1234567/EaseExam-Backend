const pdfParse = require('pdf-parse');
const fs = require('fs');
const { extractTextWithGemini } = require('../nlp/aiEvaluator');
const logger = require('../utils/logger');

/**
 * Extracts text from a PDF buffer.
 * @param {Buffer} dataBuffer - Buffer of the PDF file.
 * @returns {Promise<string>} - Extracted text content.
 */
const extractTextFromPDF = async (dataBuffer) => {
    try {
        const data = await pdfParse(dataBuffer);
        let text = data.text || '';
        
        // If text is very short/empty, it might be a scanned PDF (images only)
        if (text.trim().length < 10) {
            logger.info('Digital PDF extraction yielded little text. Attempting Gemini OCR fallback...');
            const aiText = await extractTextWithGemini(dataBuffer);
            if (aiText) text = aiText;
        }

        return text;
    } catch (error) {
        logger.error('pdf-parse failed, trying Gemini OCR fallback: ' + error.message);
        return await extractTextWithGemini(dataBuffer);
    }
};

module.exports = {
    extractTextFromPDF
};
