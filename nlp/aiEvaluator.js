const axios = require('axios');
const logger = require('../utils/logger');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize a raw question-number value from the model into a plain integer
 * string so that "Q1", "q 1", " 01" all become "1".
 */
function normalizeQNum(val) {
  if (val === undefined || val === null) return '';
  return String(val).replace(/[^0-9]/g, '').replace(/^0+/, '') || '';
}

/**
 * Safe JSON extractor: tries the full text first, then falls back to the
 * first {...} or [...] substring. Returns null on complete failure.
 */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  // Try full text first (model returned pure JSON)
  try { return JSON.parse(text.trim()); } catch (_) {}
  // Try first object
  const obj = text.match(/\{[\s\S]*\}/)?.[0];
  if (obj) { try { return JSON.parse(obj); } catch (_) {} }
  // Try first array
  const arr = text.match(/\[[\s\S]*\]/)?.[0];
  if (arr) { try { return JSON.parse(arr); } catch (_) {} }
  return null;
}

// ─── Core API call ───────────────────────────────────────────────────────────

/**
 * Centralized OpenRouter call.
 * Returns { content: string } on success, throws on unrecoverable error.
 * Retries up to `maxRetries` times with exponential back-off.
 */
async function callOpenRouter(model, messages, expectJson = false, maxRetries = 2) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is missing from environment variables.');
  }

  const payload = {
    model,
    messages,
    temperature: 0.1,
    ...(expectJson ? { response_format: { type: 'json_object' } } : {}),
  };

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        payload,
        {
          timeout: 60_000, // 60-second hard timeout — prevents indefinite hangs
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/kalpesh1234567/EaseExam',
            'X-Title': 'EaseExam ASAE',
          },
        }
      );

      const content = response.data?.choices?.[0]?.message?.content ?? null;
      if (content === null) {
        throw new Error('Model returned no content in choices[0].message.content');
      }
      logger.info(`OpenRouter (${model}): ${content.length} chars received.`);
      return content;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // Don't retry on auth errors or bad requests
      if (status === 401 || status === 400) break;
      if (attempt < maxRetries) {
        const delay = (attempt + 1) * 1500;
        logger.warn(`OpenRouter attempt ${attempt + 1} failed (${status ?? err.message}). Retrying in ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  logger.error(`OpenRouter API failed after ${maxRetries + 1} attempts (${model}):`, lastErr?.response?.data || lastErr?.message);
  throw lastErr; // Callers decide how to handle — they no longer silently get ''
}

// ─── Phase 0: OCR ────────────────────────────────────────────────────────────

/**
 * Extract text from an image buffer using OpenRouter vision models.
 * Uses a prioritized fallback list to ensure "instant" recovery if a free model is down (404).
 */
async function extractTextFromImage(buffer, mimeType = 'image/jpeg') {
  const supportedImageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!supportedImageTypes.includes(mimeType)) {
    throw new Error(`extractTextFromImage only supports images. Received: "${mimeType}".`);
  }

  // Prioritized list of active FREE vision models on OpenRouter
  const visionModels = [
    'google/gemini-flash-1.5-exp:free',
    'meta-llama/llama-3.2-11b-vision-instruct:free',
    'qwen/qwen2.5-vl-72b-instruct:free',
    'qwen/qwen-2-vl-72b-instruct:free',
    'mistralai/pixtral-12b:free'
  ];

  const base64Data = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64Data}`;
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Read this image and extract ALL handwritten or typed text exactly. Do not add commentary.' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
  }];

  for (const model of visionModels) {
    try {
      logger.info(`Attempting Vision OCR with ${model}...`);
      const text = await callOpenRouter(model, messages, false, 0); // Disable internal retries to swap models faster
      if (text && text.trim().length > 0) {
        logger.info(`Vision OCR SUCCESS with ${model}.`);
        return text.trim();
      }
    } catch (err) {
      logger.warn(`Vision OCR failed for ${model}: ${err.message}. Trying next fallback...`);
    }
  }

  logger.error('CRITICAL: All Vision OCR fallback models failed.');
  return '';
}

// Keep the old export name so submission.js import doesn't break
const extractTextWithGemini = extractTextFromImage;

// ─── Phase 1: Segmentation ───────────────────────────────────────────────────

/**
 * Segment a student's OCR text into per-question answer chunks.
 * Returns a map: { "1": "answer text", "2": "...", ... }
 * Never throws — returns {} on total failure.
 */
async function segmentAnswerSheet(rawText, questions) {
  if (!rawText || rawText.trim().length < 10) {
    logger.warn(`OCR text too short for segmentation (${rawText?.length ?? 0} chars). Returning empty map.`);
    return {};
  }

  // Truncate very long OCR text to avoid blowing the context window.
  // ~12 000 chars ≈ 3 000 tokens — safe for an 8B model.
  const MAX_OCR_CHARS = 12_000;
  const truncatedText =
    rawText.length > MAX_OCR_CHARS
      ? rawText.slice(0, MAX_OCR_CHARS) + '\n[...truncated for length...]'
      : rawText;

  if (rawText.length > MAX_OCR_CHARS) {
    logger.warn(`OCR text truncated from ${rawText.length} to ${MAX_OCR_CHARS} chars for segmentation.`);
  }

  const questionList = questions
    .map(q => `Q${q.questionNo}${q.text ? `: ${q.text}` : ''}`)
    .join('\n');

  const prompt = `You are an expert at analysing handwritten or typed student answer sheets.

READ the OCR text below and IDENTIFY the student's answer for each question number listed.
Labels used by students may include "Q1", "1.", "Question 1", "Ans 1", "Answer 1", etc.

Questions to locate:
${questionList}

Full OCR text:
"""
${truncatedText}
"""

Return ONLY a valid JSON object where keys are question numbers (as plain digit strings, e.g. "1", "2") and values are the student's answer text for that question. Use "" for unanswered questions.
Example: { "1": "The TCP/IP model has four layers...", "2": "Newton's second law states F=ma...", "3": "" }`;

  try {
    const text = await callOpenRouter(
      'meta-llama/llama-3-8b-instruct:free',
      [{ role: 'user', content: prompt }],
      true
    );

    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.error('Segmentation: model returned invalid JSON structure.', text?.slice(0, 200));
      return {};
    }

    const segments = {};
    for (const [k, v] of Object.entries(parsed)) {
      const normKey = normalizeQNum(k);
      if (normKey) {
        segments[normKey] = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
      }
    }

    logger.info(`Segmented ${Object.keys(segments).length}/${questions.length} questions.`);
    return segments;
  } catch (err) {
    logger.error('Segmentation failed:', err.message);
    return {};
  }
}

// ─── Phase 2: Evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate one question's extracted student answer against the model answer.
 * Returns { marksObtained: number, feedback: string, suggestion: string }
 * Never throws.
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

  // Truncate individual fields to keep total prompt under ~3 000 tokens
  const MAX_FIELD = 2_000;
  const safeModel = (modelAnswer || '').slice(0, MAX_FIELD);
  const safeAnswer = studentAnswerSegment.slice(0, MAX_FIELD);

  const prompt = `You are an expert academic evaluator.

${questionText ? `Question: "${questionText}"` : ''}
Maximum marks: ${maxMarks}
Model (Reference) Answer: "${safeModel}"

Student's Answer:
"""
${safeAnswer}
"""

Instructions:
1. Compare the student's answer to the model answer based on CONCEPTUAL ACCURACY and COMPLETENESS.
2. Award partial marks fairly — if the student got the core concept right, award most of the marks even if phrasing differs.
3. Be strict about factual errors.
4. Keep feedback concise and constructive.

Return ONLY a valid JSON object with EXACTLY this format (no extra keys):
{
  "marksObtained": <number between 0 and ${maxMarks}, integers or .5 steps only>,
  "feedback": "<brief feedback, max 2 sentences>",
  "suggestion": "<one actionable improvement tip>"
}`;

  const defaultFail = {
    marksObtained: 0,
    feedback: 'Failed to evaluate due to an AI service error.',
    suggestion: 'Please contact your instructor for a manual review.',
  };

  try {
    const text = await callOpenRouter(
      'meta-llama/llama-3-8b-instruct:free',
      [{ role: 'user', content: prompt }],
      true
    );

    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== 'object') {
      logger.error('Evaluation: model returned invalid JSON.', text?.slice(0, 200));
      return defaultFail;
    }

    // Robust marks parsing — handles "4", 4, 4.5, "four" → NaN → 0
    const rawMarks = parsed.marksObtained;
    const parsedMarks = parseFloat(rawMarks);

    if (isNaN(parsedMarks)) {
      logger.warn(`Evaluation: marksObtained "${rawMarks}" is not a number. Defaulting to 0.`);
    }

    const marksObtained = isNaN(parsedMarks)
      ? 0
      : Math.min(Math.max(0, parsedMarks), maxMarks);

    return {
      marksObtained,
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : 'Evaluated successfully.',
      suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion : 'Review the topic concepts.',
    };
  } catch (err) {
    logger.error('Evaluation API call failed:', err.message);
    return defaultFail;
  }
}

// ─── Answer Key Extraction ───────────────────────────────────────────────────

/**
 * Auto-extract structured model answers from a teacher's answer key OCR text.
 * Returns the original questions array with modelAnswer fields filled in where
 * the teacher hadn't entered them manually.
 * Never throws.
 */
async function autoExtractAnswerKey(ocrText, questions) {
  if (!ocrText || ocrText.trim().length < 20) {
    logger.warn('OCR text too short for answer key extraction. Returning original questions.');
    return questions;
  }

  const MAX_OCR_CHARS = 12_000;
  const truncatedText =
    ocrText.length > MAX_OCR_CHARS ? ocrText.slice(0, MAX_OCR_CHARS) + '\n[...truncated...]' : ocrText;

  const questionList = questions
    .map(q => `Q${q.questionNo}${q.text ? `: ${q.text}` : ''}`)
    .join('\n');

  const prompt = `You are an expert at extracting structured information from academic answer keys.

Below is the OCR text of an official Answer Key.
Extract the CORRECT model answer (or key points) for each question number listed below.

Questions to identify:
${questionList}

OCR Text:
"""
${truncatedText}
"""

Return ONLY a valid JSON array with EXACTLY this structure (no extra keys):
[
  { "questionNo": 1, "modelAnswer": "..." },
  { "questionNo": 2, "modelAnswer": "..." }
]
Use "" for any question whose answer is not found.`;

  try {
    const text = await callOpenRouter(
      'meta-llama/llama-3-8b-instruct:free',
      [{ role: 'user', content: prompt }],
      true
    );

    const parsed = extractJson(text);
    if (!Array.isArray(parsed)) {
      logger.error('Answer key extraction: model did not return a JSON array.', text?.slice(0, 200));
      return questions;
    }

    // Build a lookup: normalizedQNum → modelAnswer
    const lookup = {};
    for (const entry of parsed) {
      const key = normalizeQNum(entry?.questionNo);
      if (key && typeof entry?.modelAnswer === 'string') {
        lookup[key] = entry.modelAnswer.trim();
      }
    }

    const updatedQuestions = questions.map(q => {
      const key = normalizeQNum(q.questionNo);
      const hasManual = q.modelAnswer && q.modelAnswer.trim().length > 0;
      return {
        ...q,
        modelAnswer: hasManual ? q.modelAnswer : (lookup[key] ?? ''),
      };
    });

    logger.info(`Answer key extraction: updated ${Object.keys(lookup).length}/${questions.length} questions.`);
    return updatedQuestions;
  } catch (err) {
    logger.error('Answer key extraction failed:', err.message);
    return questions; // Safe fallback — return originals unchanged
  }
}

module.exports = {
  extractTextWithGemini, // legacy name kept for submission.js compatibility
  extractTextFromImage,  // preferred new name
  segmentAnswerSheet,
  evaluateSingleAnswer,
  autoExtractAnswerKey,
};
