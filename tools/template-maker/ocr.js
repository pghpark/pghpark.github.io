// Text detection with Tesseract.js (runs in the browser, no API key).
// Language data (chi_tra ≈ 1.6 MB) is downloaded from jsDelivr on first use
// and cached in IndexedDB by Tesseract.js.

export const OCR_MODES = {
  // Tries horizontal and vertical readings and keeps what fits each part of the
  // photo best. See autoDetect() below.
  detect: { labelKey: 'modeDetect' },
  auto: { langs: ['chi_tra', 'eng'], psm: '3', labelKey: 'modeAuto' },
  block: { langs: ['chi_tra', 'eng'], psm: '6', labelKey: 'modeBlock' },
  sparse: { langs: ['chi_tra', 'eng'], psm: '11', labelKey: 'modeSparse' },
  vertical: { langs: ['chi_tra_vert'], psm: '5', labelKey: 'modeVertical' },
};

// CJK ideographs, CJK punctuation, fullwidth forms, bopomofo, extension planes.
const CJK = '[\\u2E80-\\u2FDF\\u3000-\\u303F\\u3100-\\u312F\\u31A0-\\u31BF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF\\u{20000}-\\u{2FA1F}]';
// Captures the first character instead of a lookbehind, which Safari only supports from 16.4.
const SPACE_BETWEEN_CJK = new RegExp(`(${CJK})\\s+(?=${CJK})`, 'gu');
const HAS_CJK = new RegExp(CJK, 'u');

/** Tesseract puts spaces between Chinese characters ("今 日 特 價"); remove them. */
export function cleanText(text) {
  return text.replace(SPACE_BETWEEN_CJK, '$1').replace(/\s+$/u, '').replace(/^\s+/u, '');
}

export const hasCjk = (text) => HAS_CJK.test(text);

// One worker per language set, kept between runs: Auto detect uses a horizontal
// and a vertical worker at the same time.
const workers = new Map();
let progressHandler = () => {};

function getWorker(langs) {
  const key = langs.join('+');
  if (!workers.has(key)) {
    workers.set(key, Tesseract.createWorker(langs, 1 /* LSTM */, {
      logger: (m) => progressHandler(key, m),
    }).catch((e) => { workers.delete(key); throw e; }));
  }
  return workers.get(key);
}

// Serialise jobs per worker (each pass changes the worker's page-segmentation mode).
const queues = new Map();
function runPass(langs, psm, input) {
  const key = langs.join('+');
  const job = (queues.get(key) || Promise.resolve()).then(async () => {
    const w = await getWorker(langs);
    await w.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' });
    const { data } = await w.recognize(input, {}, { blocks: true });
    return (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
      .map((l) => ({ text: cleanText(l.text), confidence: l.confidence, bbox: { ...l.bbox } }));
  });
  queues.set(key, job.catch(() => {}));
  return job;
}

const VALID = /[\p{Script=Han}A-Za-z0-9]/u;
const countChars = (text) => [...text].filter((c) => VALID.test(c)).length;
// How much readable, confident text a reading contains.
const readingScore = (lines) => lines.reduce((s, l) => s + countChars(l.text) * (l.confidence / 100) ** 2, 0);
const W = (b) => b.x1 - b.x0;
const H = (b) => b.y1 - b.y0;
const usable = (lines, minConfidence) => lines.filter((l) => l.text && l.confidence >= minConfidence && /[\p{L}\p{N}]/u.test(l.text));

/**
 * Auto detect layout.
 *
 * Reads the photo as horizontal text three ways (Tesseract page modes 3, 6 and
 * 11) and as vertical text once (chi_tra_vert, mode 5), then:
 *  1. keeps the best horizontal and the best vertical reading (most confident
 *     readable characters), and uses the better of those two as the base;
 *  2. swaps in confident lines of the other orientation where they explain a
 *     region better (so a poster with a vertical title and horizontal details
 *     gets both), unless they would cut across a much longer line.
 * Tuned on 100 synthetic Traditional Chinese poster photos (horizontal menus,
 * paragraphs, scattered posters, 直排 and mixed): 80% character accuracy vs
 * 55% for Tesseract's own auto layout, which never reads vertical text.
 */
async function autoDetect(input, minConfidence, report) {
  const H_LANGS = ['chi_tra', 'eng'];
  const passes = [
    { langs: H_LANGS, psm: '3', vertical: false },
    { langs: H_LANGS, psm: '6', vertical: false },
    { langs: H_LANGS, psm: '11', vertical: false },
    { langs: ['chi_tra_vert'], psm: '5', vertical: true },
  ];
  let done = 0;
  report(0);
  const results = await Promise.all(passes.map((p) => runPass(p.langs, p.psm, input).then((lines) => {
    report(++done / passes.length);
    return { ...p, lines: lines.map((l) => ({ ...l, vertical: p.vertical })) };
  })));
  const best = (list) => list
    .map((r) => ({ lines: usable(r.lines, minConfidence), r }))
    .map((x) => ({ ...x, score: readingScore(x.lines) }))
    .sort((a, b) => b.score - a.score)[0];
  const hBest = best(results.filter((r) => !r.vertical));
  const vBest = best(results.filter((r) => r.vertical));
  const vertBase = vBest.score > hBest.score;
  let out = [...(vertBase ? vBest : hBest).lines];
  const other = (vertBase ? hBest : vBest).lines.filter((l) => l.confidence >= Math.max(50, minConfidence)
    && countChars(l.text) >= 3
    && (vertBase ? W(l.bbox) > 1.6 * H(l.bbox) : H(l.bbox) > 1.6 * W(l.bbox)));
  for (const o of other) {
    const touching = out.filter((l) => overlap(l.bbox, o.bbox) > 0);
    const crosses = touching.some((l) => l.confidence >= 60 && (vertBase ? H(l.bbox) > 2 * H(o.bbox) : W(l.bbox) > 2 * W(o.bbox)));
    if (!crosses && readingScore([o]) > readingScore(touching)) {
      out = out.filter((l) => !touching.includes(l)).concat([o]);
    }
  }
  return out;
}

/**
 * @param {HTMLCanvasElement} source
 * @returns {Promise<Array<{text, bbox:{x0,y0,x1,y1}, confidence, vertical}>>}
 */
export async function detectText(source, { mode = 'detect', minConfidence = 30, onProgress } = {}) {
  const cfg = OCR_MODES[mode] || OCR_MODES.detect;
  const notify = onProgress || (() => {});

  // Tesseract is much more accurate on larger glyphs: upscale small photos.
  const longSide = Math.max(source.width, source.height);
  const scale = longSide < 1600 ? Math.min(3, 2000 / longSide) : 1;
  let input = source;
  if (scale !== 1) {
    input = document.createElement('canvas');
    input.width = Math.round(source.width * scale);
    input.height = Math.round(source.height * scale);
    const ctx = input.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, input.width, input.height);
  }

  let lines;
  if (mode === 'detect') {
    // Show downloads/start-up as usual, then one bar across all four readings.
    progressHandler = (_key, m) => { if (m.status !== 'recognizing text') notify(m); };
    lines = await autoDetect(input, minConfidence, (progress) => notify({ status: 'detecting layout', progress }));
  } else {
    progressHandler = (_key, m) => notify(m);
    lines = (await runPass(cfg.langs, cfg.psm, input)).map((l) => ({ ...l, vertical: mode === 'vertical' }));
  }

  const found = lines
    .map((l) => ({
      ...l,
      bbox: { x0: l.bbox.x0 / scale, y0: l.bbox.y0 / scale, x1: l.bbox.x1 / scale, y1: l.bbox.y1 / scale },
    }))
    .filter((l) => l.text && l.confidence >= minConfidence && /[\p{L}\p{N}]/u.test(l.text)
      && l.bbox.x1 - l.bbox.x0 > 3 && l.bbox.y1 - l.bbox.y0 > 3
      // Noise and textures read as 1–2 stray letters ("EX", "3"). In testing this
      // removed only junk: 37 of 671 boxes, with no loss of real text.
      && !(countChars(l.text) <= 2 && l.confidence < 60));

  // Large stylised text sometimes yields a second, garbage reading inside the
  // same area ("今日特價" + "£ + JE"). Keep the most confident line per area.
  const kept = [];
  for (const l of [...found].sort((a, b) => b.confidence - a.confidence)) {
    if (!kept.some((k) => overlap(l.bbox, k.bbox) > 0.5 * area(l.bbox))) kept.push(l);
  }
  return found.filter((l) => kept.includes(l));
}

const area = (b) => (b.x1 - b.x0) * (b.y1 - b.y0);
const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
