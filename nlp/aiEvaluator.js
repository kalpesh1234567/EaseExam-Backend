const { GoogleGenAI, Type, Schema } = require('@google/genai');
const logger = require('../utils/logger');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Evaluates a student's answer against a model answer using Gemini 1.5 Flash.
 * Prompts the model to return JSON with marks, feedback, and suggestions.
 */
async function evaluateSingleAnswer(studentAnswer, modelAnswer, maxMarks) {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('No Gemini API key found, skipping AI evaluation. Returning 0.');
    return { marksObtained: 0, feedback: 'Gemini API key missing.', suggestion: '' };
  }

  const prompt = `
You are an expert academic evaluator. Evaluate the student's answer against the provided model answer.
The maximum marks for this question is: ${maxMarks}.

Model Answer: "${modelAnswer}"
Student Answer: "${studentAnswer}"

Rules:
1. Do not use exact string matching. Evaluate semantic meaning and concept understanding.
2. Be fair and objective. Assign marks from 0 up to ${maxMarks} based on correctness and completeness. Make sure marks are integers.
3. Provide brief feedback (what was right/wrong) and an actionable suggestion for improvement.
`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: prompt,
      config: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            marksObtained: { type: Type.INTEGER },
            feedback: { type: Type.STRING },
            suggestion: { type: Type.STRING }
          },
          required: ["marksObtained", "feedback", "suggestion"]
        }
      }
    });

    const result = JSON.parse(response.text());
    
    return {
      marksObtained: Math.min(Math.max(0, result.marksObtained), maxMarks),
      feedback: result.feedback || 'Evaluated successfully.',
      suggestion: result.suggestion || 'Review the topic concepts.'
    };
  } catch (err) {
    logger.error('Gemini evaluation failed:', err);
    return {
      marksObtained: 0,
      feedback: 'Failed to evaluate via AI due to an internal error.',
      suggestion: ''
    };
  }
}

module.exports = { evaluateSingleAnswer };
