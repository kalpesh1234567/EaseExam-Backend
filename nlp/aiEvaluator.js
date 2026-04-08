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
  const obj = text.match(/\\{[\\s\\S]*\\}/)?.[0];
  if (obj) { try { return JSON.parse(obj); } catch (_) {} }
  const arr = text.match(/\\[[\\s\\S]*\\]/)?.[0];
  if (arr) { try { return JSON.parse(arr); } catch (_) {} }
  return null;
}

// FIX 1: Detect if OCR output is useless (blank page render artifact)
function isUselessOcrText(text) {
  if (!text || text.trim().length < 15) return true;
  const lower = text.trim().toLowerCase();
  const junkPhrases = [
    'blank page', 'this page is blank', 'no text', 'empty page',
    'page intentionally left blank', 'nothing here', 'white page',
  ];
  if (junkPhrases.some(p => lower.includes(p))) return true;
  // If >90% of chars are non-alphanumeric, it's likely a render artifact
  const alphaCount = (text.match(/[a-z0-9]/gi) || []).length;
  if (alphaCount / text.length < 0.1) return true;
  return false;
}

// ─── OpenRouter text models ──────────────────────────────────────────────────

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
      const content = res.data?.choices?.[0]?.message?.content ?? null;
      if (content) {
        logger.info(`[AI] ${model}: ${content.length} chars.`);
        return content;
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) throw new Error('OpenRouter API key invalid (401).');
      logger.warn(`[AI] ${model} failed (${status ?? err.message}). Trying next…`);
    }
  }
  throw new Error('All OpenRouter text models failed.');
}

// ─── Image OCR via Gemini 1.5 Flash ──────────────────────────────────────────

async function ocrImageBuffer(imageBuffer, mimeType = 'image/jpeg') {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is missing.');

  // FIX 2: Reject clearly too-small buffers (blank renders are typically < 5KB)
  if (!imageBuffer || imageBuffer.length < 5000) {
    logger.warn(`[OCR] Skipping suspiciously small buffer: ${imageBuffer?.length ?? 0} bytes`);
    return '';
  }

  const base64Data = imageBuffer.toString('base64');

  try {
    logger.info(`[OCR] Sending ${imageBuffer.length} bytes to Gemini 1.5 Flash…`);
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        contents: [{
          parts: [
            {
              text: `You are an expert at reading handwritten and typed exam answer sheets.
Extract ALL visible text from this image exactly as written.
Preserve question labels like "Q1", "1.", "Ans 1", "Answer 1" etc.
Output ONLY the extracted text. No commentary, no formatting, no markdown.
If the image is blank or unreadable, output exactly: BLANK_PAGE`,
            },
            { inline_data: { mime_type: mimeType, data: base64Data } },
          ],
        }],
        generationConfig: { temperature: 0.1 },
      },
      { timeout: 60_000, headers: { 'Content-Type': 'application/json' } }
    );

    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const trimmed = text.trim();

    // FIX 3: Treat explicit blank signal and junk text as empty
    if (trimmed === 'BLANK_PAGE' || isUselessOcrText(trimmed)) {
      logger.warn('[OCR] Gemini reported blank/unreadable page.');
      return '';
    }

    logger.info(`[OCR] Gemini success: ${trimmed.length} chars.`);
    return trimmed;
  } catch (err) {
    logger.error(`[OCR] Gemini failed (${err.response?.status ?? err.message}):`, err.response?.data ?? '');
    return '';
  }
}

// ─── Core: Scanned PDF → render pages → OCR each page ───────────────────────

async function extractTextFromScannedPDF(pdfBuffer) {
  try {
    // FIX 4: Catch module-not-found errors clearly
    let pdfjsLib;
    try {
      pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    } catch (importErr) {
      logger.error('[OCR] pdfjs-dist not available:', importErr.message);
      return '';
    }

    let createCanvas;
    try {
      ({ createCanvas } = require('@napi-rs/canvas'));
    } catch (canvasErr) {
      logger.error('[OCR] @napi-rs/canvas not available:', canvasErr.message);
      return '';
    }

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
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');

      // FIX 5: Fill white background before render — transparent → near-black JPEG
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport }).promise;
      const jpegBuffer = await canvas.encode('jpeg', 90);
      logger.info(`[OCR] Page ${pageNum}/${pdfDoc.numPages}: ${jpegBuffer.length} bytes → Gemini OCR`);

      const pageText = await ocrImageBuffer(jpegBuffer, 'image/jpeg');
      if (pageText) pageTexts.push(`[PAGE ${pageNum}]\n${pageText}`);

      page.cleanup();
    }

    if (pageTexts.length === 0) {
      logger.warn('[OCR] All pages came back empty from Gemini OCR.');
      return '';
    }

    const merged = pageTexts.join('\n\n--- PAGE BREAK ---\n\n');
    logger.info(`[OCR] Total: ${merged.length} chars from ${pdfDoc.numPages} pages.`);
    return merged;

  } catch (err) {
    logger.error('[OCR] PDF render failed:', err.message);
    return '';
  }
}

// ─── pdf-parse text-layer extraction ─────────────────────────────────────────

async function extractTextLayerFromPDF(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    const text = (data.text || '').trim();
    logger.info(`[Extract] pdf-parse text layer: ${text.length} chars.`);
    return text;
  } catch (err) {
    logger.warn('[Extract] pdf-parse failed:', err.message);
    return '';
  }
}

// ─── Public: extract text from any file buffer ───────────────────────────────
// FIX 6: Try text layer first for PDFs (fast, free, reliable for digital PDFs).
// Only fall back to render+OCR when text layer is too short.

async function extractTextWithGemini(buffer, mimeType) {
  const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (imageTypes.includes(mimeType)) {
    return ocrImageBuffer(buffer, mimeType);
  }

  // Step 1: Try pdf-parse text layer (works for digital PDFs instantly)
  logger.info('[Extract] Step 1 — trying pdf-parse text layer…');
  const textLayerResult = await extractTextLayerFromPDF(buffer);

  if (textLayerResult.length >= 100) {
    logger.info('[Extract] Text layer has sufficient content — skipping OCR.');
    return textLayerResult;
  }

  logger.info(`[Extract] Text layer too short (${textLayerResult.length} chars) — falling back to render+OCR.`);

  // Step 2: Render pages → Gemini OCR (for scanned/handwritten PDFs)
  const ocrText = await extractTextFromScannedPDF(buffer);

  if (!isUselessOcrText(ocrText)) {
    return ocrText;
  }

  // Step 3: Return whatever text layer had as last resort
  logger.warn('[Extract] OCR also failed — returning whatever text layer had.');
  return textLayerResult;
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

  // FIX 7: Include possible label variants so model finds non-standard labelling
  const questionList = questions
    .map(q => `Q${q.questionNo} (also: "${q.questionNo}.", "Ans ${q.questionNo}", "Answer ${q.questionNo}", "Question ${q.questionNo}")${q.text ? ` — Topic: ${q.text}` : ''}`)
    .join('\n');

  const prompt = `You are an expert at analysing student answer sheets.

READ the extracted text below and IDENTIFY the student's written answer for each question.
The student may label answers as "Q1", "1.", "Ans 1", "Answer 1", "Question 1", etc.

Questions to locate:
${questionList}

Extracted answer sheet text:
"""
${truncatedText}
"""

Return ONLY a valid JSON object where:
- Keys are plain question numbers as strings ("1", "2", "3")
- Values are the student's complete answer text for that question
- Use "" for any question where no answer was found

Example: { "1": "The TCP/IP model has four layers...", "2": "Newton's second law states...", "3": "" }

Output only the JSON object, no commentary.`;

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

async function evaluateSingleAnswer(studentAnswerSegment, modelAnswer, maxMarks, questionText = '', questionNo = '') {
  // FIX 8: Stricter check — require real words, not just non-empty characters
  const wordCount = (studentAnswerSegment || '').trim().split(/\\s+/).filter(w => w.length > 1).length;
  const hasAnswer = wordCount >= 3;

  const qLabel = questionNo ? `Question ${questionNo}` : 'this question';

  if (!hasAnswer) {
    return {
      marksObtained: 0,
      feedback: `For ${qLabel}, no answer was found in the submitted sheet.`,
      suggestion: 'Ensure your answers are clearly written and labelled with the correct question number.',
    };
  }

  const MAX_FIELD = 2_000;
  const safeModel = (modelAnswer || '').slice(0, MAX_FIELD);
  const safeAnswer = studentAnswerSegment.slice(0, MAX_FIELD);

  const prompt = `You are an expert academic evaluator.

${questionNo ? `Question Number: ${questionNo}` : ''}
${questionText ? `Question: "${questionText}"` : ''}
Maximum marks: ${maxMarks}
Model Answer: "${safeModel}"

Student's Answer:
"""
${safeAnswer}
"""

Evaluation criteria:
1. Compare based on CONCEPTUAL ACCURACY and COMPLETENESS.
2. Award partial marks fairly — getting the core concept right earns most marks.
3. Be strict about factual errors but lenient about phrasing.
4. If the student's answer appears to be OCR noise or random characters, award 0.

Return ONLY valid JSON with no extra text:
{
  "marksObtained": <number between 0 and ${maxMarks}, decimals allowed like 2.5>,
  "feedback": "<2 sentences: clearly start by mentioning 'For Question ${questionNo || "this question"}', then state what was correct and what was wrong>",
  "suggestion": "<one specific improvement tip for ${qLabel}>"
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
  const truncatedText = ocrText.length > MAX_CHARS
    ? ocrText.slice(0, MAX_CHARS) + '\n[...truncated...]'
    : ocrText;
  const questionList = questions
    .map(q => `Q${q.questionNo}${q.text ? `: ${q.text}` : ''}`)
    .join('\n');

  const prompt = `Extract model answers from this answer key text.

Questions:
${questionList}

Text:
"""
${truncatedText}
"""

Return ONLY a JSON array with no extra text:
[
  { "questionNo": 1, "modelAnswer": "..." },
  { "questionNo": 2, "modelAnswer": "..." }
]
Use "" if answer not found for a question.`;

  try {
    const text = await callOpenRouter([{ role: 'user', content: prompt }], true);
    const parsed = extractJson(text);
    if (!Array.isArray(parsed)) return questions;

    const lookup = {};
    for (const entry of parsed) {
      const key = normalizeQNum(entry?.questionNo);
      if (key && typeof entry?.modelAnswer === 'string') {
        lookup[key] = entry.modelAnswer.trim();
      }
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