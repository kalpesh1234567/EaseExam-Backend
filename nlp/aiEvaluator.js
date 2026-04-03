const axios = require('axios');
const logger = require('../utils/logger');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeQNum(val) {
  if (val === undefined || val === null) return '';
  return String(val).replace(/[^0-9]/g, '').replace(/^0+/, '') || '';
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text.trim()); } catch (_) {}
  const obj = text.match(/\{[\s\S]*\}/)?.[0];
  if (obj) { try { return JSON.parse(obj); } catch (_) {} }
  const arr = text.match(/\[[\s\S]*\]/)?.[0];
  if (arr) { try { return JSON.parse(arr); } catch (_) {} }
  return null;
}

// ─── OpenRouter text models (for segmentation + evaluation) ──────────────────

const TEXT_MODELS = [
  'meta-llama/llama-3-8b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'google/gemma-2-9b-it:free',
];

async function callOpenRouter(messages, expectJson = false) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing.');

  for (const model of TEXT_MODELS) {
    try {
      logger.info(`[AI] Trying model: ${model}`);
      const res = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model, messages, temperature: 0.1, ...(expectJson ? { response_format: { type: 'json_object' } } : {}) },
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
      const content = res.data?.choices?.[0]?.message?.content ?? null;
      if (content) { logger.info(`[AI] ${model}: ${content.length} chars.`); return content; }
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) throw new Error('OpenRouter API key invalid (401).');
      logger.warn(`[AI] ${model} failed (${status ?? err.message}). Trying next…`);
    }
  }
  throw new Error('All OpenRouter text models failed.');
}

// ─── OpenRouter vision models (for image OCR) ────────────────────────────────

const VISION_MODELS = [
  'google/gemini-flash-1.5-exp:free',
  'meta-llama/llama-3.2-11b-vision-instruct:free',
  'qwen/qwen2.5-vl-72b-instruct:free',
];

async function ocrImageBuffer(imageBuffer, mimeType = 'image/jpeg') {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing.');

  const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Read this image and extract ALL handwritten or typed text exactly as written. Do not add commentary.' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
  }];

  for (const model of VISION_MODELS) {
    try {
      logger.info(`[OCR] Trying vision model: ${model}`);
      const res = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model, messages, temperature: 0.1 },
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
      const text = res.data?.choices?.[0]?.message?.content ?? '';
      if (text.trim().length > 0) {
        logger.info(`[OCR] ${model} success: ${text.length} chars.`);
        return text.trim();
      }
    } catch (err) {
      logger.warn(`[OCR] ${model} failed (${err.response?.status ?? err.message}). Trying next…`);
    }
  }

  logger.error('[OCR] All vision models failed for this page.');
  return '';
}

// ─── Core: PDF → images → OCR ────────────────────────────────────────────────
//
// Pipeline for scanned PDFs (which is always the case):
//   1. Use pdfjs-dist to render each page to a JPEG buffer
//   2. Send each JPEG to a vision model on OpenRouter
//   3. Merge all page texts and return
//
// pdfjs-dist + @napi-rs/canvas are already in package.json.

async function extractTextFromScannedPDF(pdfBuffer) {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = require('@napi-rs/canvas');

    const pdfDoc = await pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    logger.info(`[OCR] PDF has ${pdfDoc.numPages} page(s) — rendering each to JPEG…`);
    const pageTexts = [];

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 }); // ~150dpi on A4
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;
      const jpegBuffer = await canvas.encode('jpeg', 90);
      logger.info(`[OCR] Page ${pageNum}/${pdfDoc.numPages}: ${jpegBuffer.length} bytes → vision OCR`);

      const pageText = await ocrImageBuffer(jpegBuffer, 'image/jpeg');
      if (pageText) pageTexts.push(pageText);

      page.cleanup();
    }

    const merged = pageTexts.join('\n\n--- PAGE BREAK ---\n\n');
    logger.info(`[OCR] Total extracted: ${merged.length} chars from ${pdfDoc.numPages} pages.`);
    return merged;

  } catch (err) {
    logger.error('[OCR] PDF render failed:', err.message);
    return '';
  }
}

// ─── Public: extract text from any file buffer ───────────────────────────────
// Always treats as scanned PDF → renders pages → vision OCR.
// Falls back to pdf-parse text layer if rendering fails.

async function extractTextWithGemini(buffer, mimeType) {
  // For image files uploaded directly (jpg/png) → OCR directly
  const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (imageTypes.includes(mimeType)) {
    return ocrImageBuffer(buffer, mimeType);
  }

  // For PDFs (or unknown/octet-stream from Cloudinary) → render pages → OCR
  logger.info('[Extract] Rendering PDF pages to images for OCR…');
  const ocrText = await extractTextFromScannedPDF(buffer);

  // Fallback: if rendering fails, try plain text layer
  if (!ocrText || ocrText.trim().length < 20) {
    logger.warn('[Extract] Page rendering failed or no text — trying pdf-parse text layer…');
    try {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      return (data.text || '').trim();
    } catch (_) {
      return '';
    }
  }

  return ocrText;
}

// ─── Phase 1: Segmentation ───────────────────────────────────────────────────

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
    const text = await callOpenRouter([{ role: 'user', content: prompt }], true);
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.error('[Seg] Invalid JSON from model.', text?.slice(0, 200));
      return {};
    }

    const segments = {};
    for (const [k, v] of Object.entries(parsed)) {
      const normKey = normalizeQNum(k);
      if (normKey) segments[normKey] = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
    }

    logger.info(`[Seg] Segmented ${Object.keys(segments).length}/${questions.length} questions.`);
    return segments;
  } catch (err) {
    logger.error('[Seg] Segmentation failed:', err.message);
    return {};
  }
}

// ─── Phase 2: Evaluation ─────────────────────────────────────────────────────

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
Model Answer: "${safeModel}"

Student's Answer:
"""
${safeAnswer}
"""

1. Compare based on CONCEPTUAL ACCURACY and COMPLETENESS.
2. Award partial marks fairly — core concept right = most marks.
3. Be strict about factual errors.

Return ONLY valid JSON:
{
  "marksObtained": <number 0 to ${maxMarks}>,
  "feedback": "<brief feedback, max 2 sentences>",
  "suggestion": "<one improvement tip>"
}`;

  const defaultFail = {
    marksObtained: 0,
    feedback: 'Failed to evaluate due to an AI service error.',
    suggestion: 'Please contact your instructor for manual review.',
  };

  try {
    const text = await callOpenRouter([{ role: 'user', content: prompt }], true);
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== 'object') {
      logger.error('[Eval] Invalid JSON from model.', text?.slice(0, 200));
      return defaultFail;
    }

    const parsedMarks = parseFloat(parsed.marksObtained);
    const marksObtained = isNaN(parsedMarks) ? 0 : Math.min(Math.max(0, parsedMarks), maxMarks);

    return {
      marksObtained,
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : 'Evaluated successfully.',
      suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion : 'Review topic concepts.',
    };
  } catch (err) {
    logger.error('[Eval] Evaluation failed:', err.message);
    return defaultFail;
  }
}

// ─── Answer Key Extraction ────────────────────────────────────────────────────

async function autoExtractAnswerKey(ocrText, questions) {
  if (!ocrText || ocrText.trim().length < 20) return questions;

  const MAX_CHARS = 12_000;
  const truncatedText = ocrText.length > MAX_CHARS ? ocrText.slice(0, MAX_CHARS) + '\n[...truncated...]' : ocrText;
  const questionList = questions.map(q => `Q${q.questionNo}${q.text ? `: ${q.text}` : ''}`).join('\n');

  const prompt = `Extract model answers from this answer key text.

Questions:
${questionList}

Text:
"""
${truncatedText}
"""

Return ONLY a JSON array:
[
  { "questionNo": 1, "modelAnswer": "..." },
  { "questionNo": 2, "modelAnswer": "..." }
]
Use "" if answer not found.`;

  try {
    const text = await callOpenRouter([{ role: 'user', content: prompt }], true);
    const parsed = extractJson(text);
    if (!Array.isArray(parsed)) return questions;

    const lookup = {};
    for (const entry of parsed) {
      const key = normalizeQNum(entry?.questionNo);
      if (key && typeof entry?.modelAnswer === 'string') lookup[key] = entry.modelAnswer.trim();
    }

    return questions.map(q => {
      const key = normalizeQNum(q.questionNo);
      const hasManual = q.modelAnswer && q.modelAnswer.trim().length > 0;
      return { ...q, modelAnswer: hasManual ? q.modelAnswer : (lookup[key] ?? '') };
    });
  } catch (err) {
    logger.error('[AK] Answer key extraction failed:', err.message);
    return questions;
  }
}

module.exports = {
  extractTextWithGemini,
  segmentAnswerSheet,
  evaluateSingleAnswer,
  autoExtractAnswerKey,
};
