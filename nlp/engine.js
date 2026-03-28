/**
 * NLP Evaluation Engine — JavaScript port of the original Python nlp_engine.py
 * Techniques: TF-IDF + Cosine Similarity + Keyword Matching
 * Scoring: 50% cosine + 35% keywords + 15% length
 */

// ────────────── Stopwords ──────────────
const STOPWORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could',
  'should','may','might','shall','can','need','dare','ought',
  'used','to','of','in','for','on','with','at','by','from',
  'as','into','through','during','before','after','above','below',
  'between','out','off','over','under','again','further','then',
  'once','and','but','or','nor','so','yet','both','either',
  'neither','not','only','own','same','than','too','very','just',
  'it','its','this','that','these','those','i','me','my','we',
  'our','you','your','he','his','she','her','they','their',
  'what','which','who','whom','when','where','why','how',
  'all','each','every','any','few','more','most','other',
  'some','such','no','up','about','also','like',
]);

const SUFFIXES = ['ing','tion','sion','ed','er','est','ly','ment','ness',
                  'ity','ies','es','al','ous','ive','ful','less','able','ible'];

// ────────────── Text Preprocessing ──────────────
function stem(word) {
  word = word.toLowerCase();
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function preprocess(text, removeStopwords = true, applyStem = true) {
  let tokens = tokenize(text);
  if (removeStopwords) tokens = tokens.filter(t => !STOPWORDS.has(t) && t.length > 1);
  if (applyStem) tokens = tokens.map(stem);
  return tokens;
}

// ────────────── TF-IDF ──────────────
function computeTF(tokens) {
  const count = {};
  for (const t of tokens) count[t] = (count[t] || 0) + 1;
  const total = tokens.length || 1;
  const tf = {};
  for (const [w, c] of Object.entries(count)) tf[w] = c / total;
  return tf;
}

function computeIDF(documents) {
  const N = documents.length;
  const idf = {};
  const allWords = new Set(documents.flat());
  for (const word of allWords) {
    const containing = documents.filter(doc => doc.includes(word)).length;
    idf[word] = Math.log((N + 1) / (containing + 1)) + 1;
  }
  return idf;
}

function tfidfVector(tokens, idf) {
  const tf = computeTF(tokens);
  const vec = {};
  for (const [w, tfVal] of Object.entries(tf)) vec[w] = tfVal * (idf[w] || 1);
  return vec;
}

// ────────────── Cosine Similarity ──────────────
function cosineSimilarity(vec1, vec2) {
  if (!Object.keys(vec1).length || !Object.keys(vec2).length) return 0;
  const allWords = new Set([...Object.keys(vec1), ...Object.keys(vec2)]);
  let dot = 0, mag1 = 0, mag2 = 0;
  for (const w of allWords) {
    dot += (vec1[w] || 0) * (vec2[w] || 0);
  }
  for (const v of Object.values(vec1)) mag1 += v * v;
  for (const v of Object.values(vec2)) mag2 += v * v;
  if (!mag1 || !mag2) return 0;
  return dot / (Math.sqrt(mag1) * Math.sqrt(mag2));
}

// ────────────── Keyword Matching ──────────────
function extractKeywords(text, topN = 15) {
  const tokens = preprocess(text, true, false);
  const count = {};
  for (const t of tokens) count[t] = (count[t] || 0) + 1;
  return Object.entries(count)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
}

// ────────────── Length Score ──────────────
function lengthScore(studentText, referenceText) {
  const sLen = studentText.split(/\s+/).length;
  const rLen = referenceText.split(/\s+/).length;
  if (!rLen) return 0.5;
  const ratio = sLen / rLen;
  if (ratio >= 0.5 && ratio <= 1.5) return 1.0;
  if (ratio < 0.5) return Math.max(0.3, ratio / 0.5);
  return Math.max(0.5, 1.5 / ratio);
}

// ────────────── Feedback ──────────────
function generateFeedback(cosSim, kwCoverage, lenScore, matchedKws, missedKws) {
  const lines = [];
  if (cosSim >= 0.75)      lines.push('✅ Excellent semantic alignment with the reference answer.');
  else if (cosSim >= 0.5)  lines.push('🔵 Good conceptual understanding shown.');
  else if (cosSim >= 0.3)  lines.push('🟡 Partial understanding demonstrated.');
  else                     lines.push('🔴 Answer needs significant improvement in content.');

  if (kwCoverage >= 0.75)      lines.push('✅ Most key concepts are covered.');
  else if (kwCoverage >= 0.5)  lines.push('🔵 Several key concepts mentioned.');
  else if (kwCoverage >= 0.25) lines.push('🟡 Some important concepts are missing.');
  else                         lines.push('🔴 Many key concepts are absent.');

  if (matchedKws.length) lines.push(`✔ Keywords covered: ${matchedKws.slice(0, 6).join(', ')}`);
  if (missedKws.length)  lines.push(`✘ Consider including: ${missedKws.slice(0, 6).join(', ')}`);

  if (lenScore >= 0.9)    lines.push('✅ Answer length is appropriate.');
  else if (lenScore < 0.5) lines.push('⚠ Answer is too short — add more detail.');

  return lines.join('\n');
}

// ────────────── Main Evaluation Function ──────────────
function evaluateAnswer(studentAnswer, referenceAnswer, maxScore = 10) {
  if (!studentAnswer || !studentAnswer.trim()) {
    return {
      score: 0, percentage: 0, similarity: 0, keywordCoverage: 0,
      feedback: 'No answer provided.', matchedKeywords: [], missedKeywords: [],
    };
  }

  const studentTokens   = preprocess(studentAnswer);
  const referenceTokens = preprocess(referenceAnswer);
  const idf             = computeIDF([studentTokens, referenceTokens]);
  const studentVec      = tfidfVector(studentTokens, idf);
  const referenceVec    = tfidfVector(referenceTokens, idf);

  const cosSim     = cosineSimilarity(studentVec, referenceVec);
  const refKeywords = extractKeywords(referenceAnswer, 12);
  const studentRaw  = preprocess(studentAnswer, true, false);

  const matchedKws = [];
  const missedKws  = [];
  for (const kw of refKeywords) {
    const kwStem = stem(kw);
    if (studentRaw.some(s => stem(s) === kwStem)) matchedKws.push(kw);
    else missedKws.push(kw);
  }

  const kwCoverage   = refKeywords.length ? matchedKws.length / refKeywords.length : 0;
  const lenScore     = lengthScore(studentAnswer, referenceAnswer);
  const finalFraction = (cosSim * 0.50) + (kwCoverage * 0.35) + (lenScore * 0.15);
  const score         = Math.round(finalFraction * maxScore * 100) / 100;
  const percentage    = Math.round(finalFraction * 1000) / 10;
  const feedback      = generateFeedback(cosSim, kwCoverage, lenScore, matchedKws, missedKws);

  return {
    score,
    percentage,
    similarity:       Math.round(cosSim * 1000) / 1000,
    keywordCoverage:  Math.round(kwCoverage * 1000) / 1000,
    lengthScore:      Math.round(lenScore * 1000) / 1000,
    feedback,
    matchedKeywords:  matchedKws.slice(0, 8),
    missedKeywords:   missedKws.slice(0, 8),
  };
}

function evaluateSubmission(answersData) {
  const results = answersData.map(item =>
    evaluateAnswer(item.studentAnswer, item.referenceAnswer, item.maxScore || 10)
  );
  const totalScore = Math.round(results.reduce((s, r) => s + r.score, 0) * 100) / 100;
  return { totalScore, results };
}

module.exports = { evaluateAnswer, evaluateSubmission };
