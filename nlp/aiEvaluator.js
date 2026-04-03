const axios = require('axios');
const logger = require('../utils/logger');

// Centralize the Axios call for OpenRouter to handle errors and headers uniformly
async function callOpenRouter(model, messages, expectJson = false) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    logger.warn('No OPENROUTER_API_KEY found in environment variables.');
    return '';
  }

  const payload = {
    model: model,
    messages: messages,
    temperature: 0.1,
  };

  if (expectJson) {
      payload.response_format = { type: "json_object" };
  }

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/kalpesh1234567/EaseExam', // Best practice for OpenRouter
          'X-Title': 'EaseExam ASAE'
        },
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    logger.error(`OpenRouter API failed (${model}):`, err.response?.data || err.message);
    if (err.stack) logger.error(err.stack);
    return '';
  }
}

/**
 * OCR / Text extraction using OpenRouter Vision Model
 * Uses Qwen-2-VL-72B-Instruct (free tier) to extract text from images and documents
 */
async function extractTextWithGemini(buffer, mimeType = 'application/pdf') {
  logger.info(`Starting OpenRouter OCR (${mimeType}).`);
  
  // Convert buffer to base64 data URI format expected by most vision endpoints
  const base64Data = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64Data}`;

  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Please read this document carefully and extract all the handwritten or typed text exactly as it appears. If there are multiple pages, extract text from all of them in order.'
        },
        {
          type: 'image_url', // Most vision APIs accept image_url for base64
          image_url: {
            url: dataUrl
          }
        }
      ]
    }
  ];

  // We use Qwen VL which is good at OCR and operates well on OpenRouter
  // meta-llama/llama-3.2-11b-vision-instruct:free is also an option
  const text = await callOpenRouter('qwen/qwen-2-vl-72b-instruct:free', messages);
  
  if (text) {
      logger.info('Extracted text using OpenRouter Vision successfully.');
  }

  return text || '';
}

/**
 * PHASE 1 — Segment a student's answer sheet into per-question answers.
 * Uses Llama-3-8B-Instruct via OpenRouter
 */
async function segmentAnswerSheet(rawText, questions) {
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

  const text = await callOpenRouter(
      'meta-llama/llama-3-8b-instruct:free', 
      [{ role: 'user', content: prompt }],
      true // Expect JSON
  );

  if (!text) {
      logger.error('Segmentation failed, returning empty fallback map.');
      return {};
  }

  try {
    // OpenRouter / Llama 3 often wraps JSON in backticks
    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || text;
    const parsed = JSON.parse(jsonStr);

    const segments = {};
    for (const [k, v] of Object.entries(parsed)) {
      segments[String(k)] = typeof v === 'string' ? v.trim() : String(v).trim();
    }

    logger.info(`Segmented sheet into ${Object.keys(segments).length} question answers using Llama 3.`);
    return segments;
  } catch (err) {
    logger.error('Failed to parse OpenRouter segmentation JSON:', err.message);
    return {};
  }
}

/**
 * PHASE 2 — Evaluate one question's extracted student answer against the model answer.
 * Uses Llama-3-8B-Instruct via OpenRouter
 */
async function evaluateSingleAnswer(studentAnswerSegment, modelAnswer, maxMarks, questionText = '') {
  const hasAnswer = studentAnswerSegment && studentAnswerSegment.trim().length > 3;

  if (!hasAnswer) {
    return {
      marksObtained: 0,
      feedback: 'No answer was found for this question in the submitted sheet.',
      suggestion: 'Ensure your handwriting is clear and answers are labelled with the correct question number.',
    };
  }

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

Return ONLY a valid JSON object with the following exact format:
{
  "marksObtained": <number between 0 and ${maxMarks}>,
  "feedback": "<brief feedback on what was correct or missing>",
  "suggestion": "<one actionable improvement tip for the student>"
}
`;

  const text = await callOpenRouter(
      'meta-llama/llama-3-8b-instruct:free', 
      [{ role: 'user', content: prompt }],
      true // Expect JSON
  );

  const defaultFail = {
    marksObtained: 0,
    feedback: 'Failed to evaluate via AI due to an internal error or missing API key.',
    suggestion: 'Please contact your instructor for a manual review.',
  };

  if (!text) return defaultFail;

  try {
    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0] || text;
    const parsed = JSON.parse(jsonStr);

    return {
      marksObtained: Math.min(Math.max(0, Number(parsed.marksObtained) || 0), maxMarks),
      feedback: parsed.feedback || 'Evaluated successfully.',
      suggestion: parsed.suggestion || 'Review the topic concepts.',
    };
  } catch (err) {
    logger.error('Failed to parse OpenRouter evaluation JSON:', err.message);
    return defaultFail;
  }
}

// Keeping the function name 'extractTextWithGemini' so we do not have to rewrite submission.js 
// We will just rename it underneath, but export it as is.
/**
 * NEW: Auto-Extract structured model answers from a teacher's Answer Key OCR text.
 * Maps the unstructured OCR text to the predefined question numbers.
 */
async function autoExtractAnswerKey(ocrText, questions) {
  if (!ocrText || ocrText.trim().length < 20) {
    logger.warn('OCR text too short for answer key extraction.');
    return questions;
  }

  const questionList = questions
    .map(q => `Q${q.questionNo}${q.text ? `: ${q.text}` : ''}`)
    .join('\n');

  const prompt = `
You are an expert at extracting structured information from academic answer keys.

Below is the OCR text of an official Answer Key.
Your goal is to extract the CORRECT model answer (or key points) for each question number listed below.

Questions to identify:
${questionList}

OCR Text from Answer Key:
"""
${ocrText}
"""

Return a JSON array of objects with the exact structure:
[
  { "questionNo": 1, "modelAnswer": "..." },
  { "questionNo": 2, "modelAnswer": "..." }
]

IMPORTANT:
- Only return the JSON array, nothing else.
- If an answer is multi-line, preserve the important key points.
- If no answer is found for a question, use empty string "".
`;

  const text = await callOpenRouter(
    'meta-llama/llama-3-8b-instruct:free',
    [{ role: 'user', content: prompt }],
    true
  );

  if (!text) return questions;

  try {
    const jsonStr = text.match(/\[[\s\S]*\]/)?.[0] || text;
    const extracted = JSON.parse(jsonStr);

    // Map the extracted answers back to the original questions array
    const updatedQuestions = questions.map(q => {
      const match = extracted.find(e => Number(e.questionNo) === Number(q.questionNo));
      return {
        ...q,
        modelAnswer: q.modelAnswer && q.modelAnswer.trim().length > 0
          ? q.modelAnswer // Keep teacher's manual entry if it exists
          : (match && match.modelAnswer ? match.modelAnswer.trim() : '')
      };
    });

    return updatedQuestions;
  } catch (err) {
    logger.error('Failed to parse auto-extracted answer key JSON:', err.message);
    return questions;
  }
}

module.exports = { segmentAnswerSheet, evaluateSingleAnswer, extractTextWithGemini, autoExtractAnswerKey };
