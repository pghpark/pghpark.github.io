// Text detection with Tesseract.js (runs in the browser, no API key).
// Language data (chi_tra ≈ 1.6 MB) is downloaded from jsDelivr on first use
// and cached in IndexedDB by Tesseract.js.

export const OCR_MODES = {
  auto: { langs: ['chi_tra', 'eng'], psm: '3', label: 'Auto layout (橫排)' },
  block: { langs: ['chi_tra', 'eng'], psm: '6', label: 'Single block of text' },
  sparse: { langs: ['chi_tra', 'eng'], psm: '11', label: 'Scattered text (posters, signs)' },
  vertical: { langs: ['chi_tra_vert'], psm: '5', label: 'Vertical text (直排)' },
};

// CJK ideographs, CJK punctuation, fullwidth forms, bopomofo, extension planes.
const CJK = '[\\u2E80-\\u2FDF\\u3000-\\u303F\\u3100-\\u312F\\u31A0-\\u31BF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF\\u{20000}-\\u{2FA1F}]';
const SPACE_BETWEEN_CJK = new RegExp(`(?<=${CJK})\\s+(?=${CJK})`, 'gu');
const HAS_CJK = new RegExp(CJK, 'u');

/** Tesseract puts spaces between Chinese characters ("今 日 特 價"); remove them. */
export function cleanText(text) {
  return text.replace(SPACE_BETWEEN_CJK, '').replace(/\s+$/u, '').replace(/^\s+/u, '');
}

export const hasCjk = (text) => HAS_CJK.test(text);

let worker = null;
let workerKey = '';
let progressHandler = () => {};

async function getWorker(langs) {
  const key = langs.join('+');
  if (worker && workerKey === key) return worker;
  if (worker) await worker.terminate();
  worker = await Tesseract.createWorker(langs, 1 /* LSTM */, {
    logger: (m) => progressHandler(m),
  });
  workerKey = key;
  return worker;
}

/**
 * @param {HTMLCanvasElement} source
 * @returns {Promise<Array<{text, bbox:{x0,y0,x1,y1}, confidence, vertical}>>}
 */
export async function detectText(source, { mode = 'auto', minConfidence = 30, onProgress } = {}) {
  const cfg = OCR_MODES[mode] || OCR_MODES.auto;
  progressHandler = onProgress || (() => {});

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

  const w = await getWorker(cfg.langs);
  await w.setParameters({ tessedit_pageseg_mode: cfg.psm, preserve_interword_spaces: '1' });
  const { data } = await w.recognize(input, {}, { blocks: true, text: true });

  const lines = (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  const found = lines
    .map((l) => ({
      text: cleanText(l.text),
      confidence: l.confidence,
      bbox: {
        x0: l.bbox.x0 / scale, y0: l.bbox.y0 / scale,
        x1: l.bbox.x1 / scale, y1: l.bbox.y1 / scale,
      },
      vertical: mode === 'vertical',
    }))
    .filter((l) => l.text && l.confidence >= minConfidence && /[\p{L}\p{N}]/u.test(l.text)
      && l.bbox.x1 - l.bbox.x0 > 3 && l.bbox.y1 - l.bbox.y0 > 3);

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
