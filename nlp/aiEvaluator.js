const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

// Initialize the Gemini SDK correctly
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Evaluates a student's answer against a model answer using Gemini 1.5 Flash.
 * Uses a more robust prompt to handle potentially cluttered OCR text.
 */
async function evaluateSingleAnswer(studentAnswer, modelAnswer, maxMarks) {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('No Gemini API key found, skipping AI evaluation. Returning 0.');
    return { marksObtained: 0, feedback: 'Gemini API key missing.', suggestion: '' };
  }

  // Use the correct model name
  const model = genAI.getGenerativeModel({ 
    model: 'gemini-1.5-flash',
    generationConfig: {
      temperature: 0.1, // Lower temperature for more consistent academic grading
      responseMimeType: 'application/json',
    }
  });

  const prompt = `
You are an expert academic evaluator. You are given an OCR extraction of a student's answer sheet.
IMPORTANT: The OCR text may contain noise, header/footer text, browser titles, or other irrelevant information. Your first task is to locate the relevant answer that matches the provided model answer context.

Question Context:
Maximum marks possible: ${maxMarks}
Model (Reference) Answer: "${modelAnswer}"

Student's OCR Text:
"""
${studentAnswer}
"""

Instructions:
1. Extract the relevant student's response from the OCR text above.
2. Compare it to the Model Answer based on concepts and completeness.
3. Assign an appropriate score (0 to ${maxMarks}). Be fair—if they got the core concept, give most marks even if small words are missing.
4. Provide structured JSON output.

Return ONLY a JSON object with this structure:
{
  "marksObtained": <number>,
  "feedback": "<string: brief feedback on what was correct or missing>",
  "suggestion": "<string: actionable advice to the student>"
}
`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Safety check for empty or malformed text
    if (!text) {
      throw new Error('Empty response from Gemini');
    }

    // Attempt to extract JSON even if the model adds markdown guards
    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || text;
    const parsed = JSON.parse(jsonStr);
    
    return {
      marksObtained: Math.min(Math.max(0, Number(parsed.marksObtained) || 0), maxMarks),
      feedback: parsed.feedback || 'Evaluated successfully.',
      suggestion: parsed.suggestion || 'Review the topic concepts.'
    };
  } catch (err) {
    logger.error('Gemini evaluation failed:', err);
    return {
      marksObtained: 0,
      feedback: 'Failed to evaluate via AI due to an internal error.',
      suggestion: 'Please contact your instructor for a manual review.'
    };
  }
}

module.exports = { evaluateSingleAnswer };
