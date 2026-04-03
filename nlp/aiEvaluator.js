const axios = require('axios');
const logger = require('../utils/logger');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize a raw question-number value into a plain integer string.
 * "Q1", "q 1", " 01" all become "1".
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
  try { return JSON.parse(text.trim()); } catch (_) { }
  const obj = text.match(/\{[\s\S]*\}/)?.[0];
  if (obj) { try { return JSON.parse(obj); } catch (_) { } }
  const arr = text.match(/\[[\s\S]*\]/)?.[0];
  if (arr) { try { return JSON.parse(arr); } catch (_) { } }
  return null;
}

// ─── Core OpenRouter call ────────────────────────────────────────────────────

// Fallback models in priority order — if one is down, try the next
const TEXT_MODELS = [
  'meta-llama/llama-3-8b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'google/gemma-2-9b-it:free',
];

/**
 * Call OpenRouter with automatic model fallback.
 * Tries each model in TEXT_MODELS until one succeeds.
 */
async function callOpenRouter(messages, expectJson = false) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is missing from environment variables.');
  }

  for (const model of TEXT_MODELS) {
    try {
      logger.info(`[AI] Trying model: ${model}`);
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model,
          messages,
          temperature: 0.1,
          ...(expectJson ? { response_format: { type: 'json_object' } } : {}),
        },
        {
          timeout: 60_000,
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
        logger.warn(`[AI] ${model} returned no content. Trying next…`);
        continue;
      }

      logger.info(`[AI] ${model}: ${content.length} chars received.`);
      return content;
    } catch (err) {
      const status = err.response?.status;
      logger.warn(`[AI] ${model} failed (HTTP ${status ?? 'N/A'}): ${err.message}. Trying next…`);

      // Don't retry on auth errors — key is wrong for ALL models
      if (status === 401) {
        throw new Error('OpenRouter API key is invalid (401 Unauthorized).');
      }
      // For 404, 429, 500, etc. — try the next model
      continue;
    }
  }

  throw new Error('All OpenRouter models failed. Check your API key or try again later.');
}

// ─── PDF Text Extraction (simple, no OCR) ────────────────────────────────────

/**
 * Extract text from a PDF buffer using pdf-parse.
 * Returns empty string if PDF is scanned (image-only).
 * This is intentionally simple — no OCR, no vision models.
 */
async function extractTextFromPDF(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    const text = (data.text || '').trim();
    logger.info(`[PDF] Extracted ${text.length} chars from PDF.`);
    return text;
  } catch (err) {
    logger.error(`[PDF] pdf-parse failed: ${err.message}`);
    return '';
  }
}

// Keep legacy export name so submissions.js doesn't break
// For image files, we simply return empty — no OCR support in minimal mode
async function extractTextWithGemini(buffer, mimeType) {
  if (mimeType === 'application/pdf' || !mimeType) {
    return extractTextFromPDF(buffer);
  }
  // For images: no OCR in this minimal setup
  logger.warn(`[PDF] Image OCR not supported in minimal mode (mime: ${mimeType}). Returning empty.`);
  return '';
}

// ─── Phase 1: Segmentation ───────────────────────────────────────────────────

/**
 * Segment a student's text into per-question answer chunks.
 * Returns a map: { "1": "answer text", "2": "...", ... }
 * Never throws — returns {} on total failure.
 */
async function segmentAnswerSheet(rawText, questions) {
  if (!rawText || rawText.trim().length < 20) {
    logger.warn(`[Seg] Text too short (${rawText?.length ?? 0} chars). Returning empty.`);
    return {};
  }

  const MAX_CHARS = 12_000;
  const truncatedText = rawText.length > MAX_CHARS
    ? rawText.slice(0, MAX_CHARS) + '\n[...truncated...]'
    : rawText;

  const questionList = questions
    .map(q => `Q${q.questionNo}${q.text ? `: ${q.text}` : ''}`)
    .join('\n');

  const prompt = `You are an expert at analysing student answer sheets.

READ the text below and IDENTIFY the student's answer for each question.
Labels may include "Q1", "1.", "Question 1", "Ans 1", etc.

Questions to locate:
${questionList}

Text:
"""
${truncatedText}
"""

Return ONLY a valid JSON object where keys are question numbers (plain digits like "1", "2") and values are the student's answer text. Use "" for unanswered questions.
Example: { "1": "The TCP/IP model has four layers...", "2": "" }`;

  try {
    const text = await callOpenRouter(
      [{ role: 'user', content: prompt }],
      true
    );

    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.error('[Seg] Invalid JSON from model.', text?.slice(0, 200));
      return {};
    }

    const segments = {};
    for (const [k, v] of Object.entries(parsed)) {
      const normKey = normalizeQNum(k);
      if (normKey) {
        segments[normKey] = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
      }
    }

    logger.info(`[Seg] Segmented ${Object.keys(segments).length}/${questions.length} questions.`);
    return segments;
  } catch (err) {
    logger.error('[Seg] Segmentation failed:', err.message);
    return {};
  }
}

// ─── Phase 2: Evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate one question's student answer against the model answer.
 * Returns { marksObtained, feedback, suggestion }
 * Never throws.
 */
async function evaluateSingleAnswer(studentAnswerSegment, modelAnswer, maxMarks, questionText = '') {
  const hasAnswer = studentAnswerSegment && studentAnswerSegment.trim().length > 3;

  if (!hasAnswer) {
    return {
      marksObtained: 0,
      feedback: 'No answer was found for this question in the submitted sheet.',
      suggestion: 'Ensure your answers are clearly written and labelled with the correct question number.',
    };
  }

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
2. Award partial marks fairly — if the core concept is right, award most marks even if phrasing differs.
3. Be strict about factual errors.
4. Keep feedback concise.

Return ONLY a valid JSON object:
{
  "marksObtained": <number between 0 and ${maxMarks}>,
  "feedback": "<brief feedback, max 2 sentences>",
  "suggestion": "<one improvement tip>"
}`;

  const defaultFail = {
    marksObtained: 0,
    feedback: 'Failed to evaluate due to an AI service error.',
    suggestion: 'Please contact your instructor for a manual review.',
  };

  try {
    const text = await callOpenRouter(
      [{ role: 'user', content: prompt }],
      true
    );

    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== 'object') {
      logger.error('[Eval] Invalid JSON from model.', text?.slice(0, 200));
      return defaultFail;
    }

    const rawMarks = parsed.marksObtained;
    const parsedMarks = parseFloat(rawMarks);

    if (isNaN(parsedMarks)) {
      logger.warn(`[Eval] marksObtained "${rawMarks}" is NaN. Defaulting to 0.`);
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
    logger.error('[Eval] Evaluation failed:', err.message);
    return defaultFail;
  }
}

// ─── Answer Key Extraction ───────────────────────────────────────────────────

async function autoExtractAnswerKey(ocrText, questions) {
  if (!ocrText || ocrText.trim().length < 20) {
    logger.warn('[AK] Text too short. Returning original questions.');
    return questions;
  }

  const MAX_CHARS = 12_000;
  const truncatedText = ocrText.length > MAX_CHARS
    ? ocrText.slice(0, MAX_CHARS) + '\n[...truncated...]'
    : ocrText;

  const questionList = questions
    .map(q => `Q${q.questionNo}${q.text ? `: ${q.text}` : ''}`)
    .join('\n');

  const prompt = `You are an expert at extracting structured information from academic answer keys.

Below is the text of an Answer Key.
Extract the correct model answer for each question listed.

Questions:
${questionList}

Text:
"""
${truncatedText}
"""

Return ONLY a valid JSON array:
[
  { "questionNo": 1, "modelAnswer": "..." },
  { "questionNo": 2, "modelAnswer": "..." }
]
Use "" for any question whose answer is not found.`;

  try {
    const text = await callOpenRouter(
      [{ role: 'user', content: prompt }],
      true
    );

    const parsed = extractJson(text);
    if (!Array.isArray(parsed)) {
      logger.error('[AK] Model did not return JSON array.', text?.slice(0, 200));
      return questions;
    }

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

    logger.info(`[AK] Updated ${Object.keys(lookup).length}/${questions.length} questions.`);
    return updatedQuestions;
  } catch (err) {
    logger.error('[AK] Answer key extraction failed:', err.message);
    return questions;
  }
}

module.exports = {
  extractTextWithGemini,  // legacy name kept for submissions.js
  extractTextFromPDF,
  segmentAnswerSheet,
  evaluateSingleAnswer,
  autoExtractAnswerKey,
};
