const pdfParse = require('pdf-parse');
const fs = require('fs');

/**
 * Extracts text from a PDF buffer.
 * @param {Buffer} dataBuffer - Buffer of the PDF file.
 * @returns {Promise<string>} - Extracted text content.
 */
const extractTextFromPDF = async (dataBuffer) => {
    try {
        const data = await pdfParse(dataBuffer);
        return data.text;
    } catch (error) {
        throw new Error('Could not read PDF content: ' + error.message);
    }
};

module.exports = {
    extractTextFromPDF
};
