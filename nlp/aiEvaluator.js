const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Shared model factory
function getModel() {
  return genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  });
}

/**
 * NEW: OCR / Text extraction using Gemini 1.5 Flash (supports scanned PDFs and images)
 */
async function extractTextWithGemini(buffer, mimeType = 'application/pdf') {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('No Gemini API key for OCR — falling back to metadata only.');
    return '';
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    // We send the file content as a base64 part
    const prompt = "Please read this file and extract all the handwritten or typed text exactly as it appears. If there are multiple pages, extract text from all of them in order.";
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType: mimeType
        }
      }
    ]);

    const text = result.response.text();
    logger.info(`Extracted text using Gemini Vision/OCR (${mimeType}).`);
    return text || '';
  } catch (err) {
    logger.error('Gemini OCR failed:', err.message || err);
    if (err.stack) logger.error(err.stack);
    return '';
  }
}

/**
 * PHASE 1 — Segment a student's answer sheet into per-question answers.
 *
 * Sends ONE Gemini call with:
 *  - The full OCR text of the student sheet
 *  - The list of question numbers + question texts from the answer key
 *
 * Returns a map: { "1": "student answer for Q1", "2": "student answer for Q2", ... }
 * Falls back to an empty map on failure (caller will use full text as fallback).
 */
async function segmentAnswerSheet(rawText, questions) {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('No Gemini API key — skipping segmentation, will use full text fallback.');
    return {};
  }

  if (!rawText || rawText.trim().length < 10) {
    logger.warn('OCR text too short for segmentation.');
    return {};
  }

  const questionList = questions
    .map(q => `Q${q.questionNo}${q.text ? `: ${q.text}` : ''}`)
    .join('\n');

  const prompt = `
You are an expert at analyzing handwritten or typed student answer sheets.

Your task is to READ the full OCR text below and IDENTIFY which portion of the text is the student's answer to each question number.

The student's sheet may have answers labelled as "Q1", "1.", "Question 1", "Ans 1", "Answer 1", etc.

Questions to locate:
${questionList}

Full OCR text of student's answer sheet:
"""
${rawText}
"""

Return a JSON object where keys are the question numbers (as strings) and values are the student's extracted answer text for that question.
If no answer is found for a question, use an empty string "".

IMPORTANT:
- Only return the JSON object, nothing else.
- Do NOT include your own commentary.
- Example format:
{
  "1": "The TCP/IP model has four layers: Application, Transport, Internet, Network Access...",
  "2": "Newton's second law states F = ma...",
  "3": ""
}
`;

  try {
    const model = getModel();
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || text;
    const parsed = JSON.parse(jsonStr);

    // Normalise keys to strings
    const segments = {};
    for (const [k, v] of Object.entries(parsed)) {
      segments[String(k)] = typeof v === 'string' ? v.trim() : String(v).trim();
    }

    logger.info(`Segmented sheet into ${Object.keys(segments).length} question answers.`);
    return segments;
  } catch (err) {
    logger.error('Segmentation failed, will fall back to full text per question:', err.message);
    return {};
  }
}

/**
 * PHASE 2 — Evaluate one question's extracted student answer against the model answer.
 *
 * @param {string} studentAnswerSegment - The specific student answer for this question (from segmentation)
 * @param {string} modelAnswer          - The teacher's model/reference answer
 * @param {number} maxMarks             - Maximum marks for this question
 * @param {string} questionText         - Optional question text for better context
 */
async function evaluateSingleAnswer(studentAnswerSegment, modelAnswer, maxMarks, questionText = '') {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('No Gemini API key found, skipping AI evaluation. Returning 0.');
    return { marksObtained: 0, feedback: 'Gemini API key missing.', suggestion: '' };
  }

  const hasAnswer = studentAnswerSegment && studentAnswerSegment.trim().length > 3;

  if (!hasAnswer) {
    return {
      marksObtained: 0,
      feedback: 'No answer was found for this question in the submitted sheet.',
      suggestion: 'Ensure your handwriting is clear and answers are labelled with the correct question number.',
    };
  }

  const model = getModel();

  const prompt = `
You are an expert academic evaluator assigning marks to a student's answer.

${questionText ? `Question: "${questionText}"` : ''}
Maximum marks: ${maxMarks}
Model (Reference) Answer: "${modelAnswer}"

Student's Answer:
"""
${studentAnswerSegment}
"""

Instructions:
1. Compare the student's answer to the model answer based on CONCEPTUAL ACCURACY and COMPLETENESS.
2. Award partial marks fairly — if the student got the core concept right, award most of the marks even if phrasing differs.
3. Be strict about factual errors.
4. Keep feedback concise and constructive.

Return ONLY a JSON object:
{
  "marksObtained": <number between 0 and ${maxMarks}>,
  "feedback": "<brief feedback on what was correct or missing>",
  "suggestion": "<one actionable improvement tip for the student>"
}
`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    if (!text) throw new Error('Empty response from Gemini');

    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || text;
    const parsed = JSON.parse(jsonStr);

    return {
      marksObtained: Math.min(Math.max(0, Number(parsed.marksObtained) || 0), maxMarks),
      feedback: parsed.feedback || 'Evaluated successfully.',
      suggestion: parsed.suggestion || 'Review the topic concepts.',
    };
  } catch (err) {
    logger.error('Gemini evaluation failed:', err);
    return {
      marksObtained: 0,
      feedback: 'Failed to evaluate via AI due to an internal error.',
      suggestion: 'Please contact your instructor for a manual review.',
    };
  }
}

module.exports = { segmentAnswerSheet, evaluateSingleAnswer, extractTextWithGemini };
