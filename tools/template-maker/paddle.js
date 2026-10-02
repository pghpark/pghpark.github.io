// Text detection + recognition with PaddleOCR PP-OCRv5 (Apache-2.0), run in
// the browser with ONNX Runtime Web. PP-OCRv5's Chinese model reads Simplified
// and Traditional Chinese, English and Japanese; its dictionary has 18,384
// characters. Unlike Tesseract it first *finds* every text region (any layout,
// any style), then reads each one, so every visible piece of text gets a box.
//
// Models: the official PP-OCRv5 mobile exports, redistributed unmodified on npm
// (pdfmarkdown-ppocrv5-models) so jsDelivr can serve them to browsers.

const MODELS = 'https://cdn.jsdelivr.net/npm/pdfmarkdown-ppocrv5-models@1.0.0';
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';

// PaddleOCR defaults (PaddleX PP-OCRv5 inference.yml).
const DET = { limitSide: 960, maxSide: 2400, fineSide: 1920, smallText: 48, thresh: 0.3, boxThresh: 0.6, unclip: 2.0, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };
const REC_HEIGHT = 48;

const ORT_JS = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.min.js';
const OPENCC_JS = 'https://cdn.jsdelivr.net/npm/opencc-js@1.4.2/dist/umd/cn2t.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(el);
  });
}

let loading = null;
async function load(report) {
  loading ||= (async () => {
    if (!self.ort) await loadScript(ORT_JS);
    ort.env.wasm.wasmPaths = ORT_WASM;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const fetchBytes = async (path, label) => {
      report?.({ status: label, progress: 0 });
      const res = await fetch(`${MODELS}/${path}`);
      if (!res.ok) throw new Error(`Model download failed (${res.status})`);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (total) report?.({ status: label, progress: got / total });
      }
      const out = new Uint8Array(got);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    };
    const [detBytes, recBytes, dictText] = await Promise.all([
      fetchBytes('detection/PP-OCRv5_mobile_det_infer.ort', 'loading text finder'),
      fetchBytes('recognition/PP-OCRv5_mobile_rec_infer.onnx', 'loading text reader'),
      fetch(`${MODELS}/recognition/ppocrv5_dict.txt`).then((r) => r.text()),
    ]);
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const [det, rec] = await Promise.all([ort.InferenceSession.create(detBytes, opts), ort.InferenceSession.create(recBytes, opts)]);
    // CTC: index 0 is "blank", then the dictionary (one character per line; this
    // export has a stray empty line that is not a class), then a space.
    const chars = ['', ...dictText.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== ''), ' '];
    if (!self.OpenCC) await loadScript(OPENCC_JS).catch(() => {});
    const cn2tw = self.OpenCC ? OpenCC.Converter({ from: 'cn', to: 'tw' }) : (t) => t;
    return { det, rec, chars, cn2tw };
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Image → float tensor (N,3,H,W), BGR order like PaddleOCR (images are read with OpenCV). */
function toTensor(ctx, w, h, mean, std) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0; i < plane; i++) {
    const r = data[i * 4] / 255; const g = data[i * 4 + 1] / 255; const b = data[i * 4 + 2] / 255;
    out[i] = (b - mean[0]) / std[0];
    out[plane + i] = (g - mean[1]) / std[1];
    out[2 * plane + i] = (r - mean[2]) / std[2];
  }
  return new ort.Tensor('float32', out, [1, 3, h, w]);
}

/**
 * Text detection (DB). Returns axis-aligned boxes in source pixels with a
 * score. Each connected region of the probability map is one text instance;
 * like PaddleOCR's DBPostProcess it is scored by its mean probability and
 * expanded by area × unclip / perimeter.
 */
async function detect(session, source, side) {
  const long = Math.max(source.width, source.height);
  const s = side / long;
  const w = Math.max(32, Math.round((source.width * s) / 32) * 32);
  const h = Math.max(32, Math.round((source.height * s) / 32) * 32);
  const c = canvasOf(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const input = toTensor(ctx, w, h, DET.mean, DET.std);
  const out = await session.run({ [session.inputNames[0]]: input });
  const prob = out[session.outputNames[0]].data; // (1,1,h,w)
  // Connected components on the thresholded map (4-neighbour flood fill).
  const label = new Int32Array(w * h);
  const boxes = [];
  let next = 0;
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] || prob[start] <= DET.thresh) continue;
    next++;
    let x0 = w; let y0 = h; let x1 = 0; let y1 = 0; let n = 0; let sum = 0;
    stack.push(start);
    label[start] = next;
    while (stack.length) {
      const k = stack.pop();
      const x = k % w; const y = (k - x) / w;
      n++; sum += prob[k];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !label[k - 1] && prob[k - 1] > DET.thresh) { label[k - 1] = next; stack.push(k - 1); }
      if (x < w - 1 && !label[k + 1] && prob[k + 1] > DET.thresh) { label[k + 1] = next; stack.push(k + 1); }
      if (y > 0 && !label[k - w] && prob[k - w] > DET.thresh) { label[k - w] = next; stack.push(k - w); }
      if (y < h - 1 && !label[k + w] && prob[k + w] > DET.thresh) { label[k + w] = next; stack.push(k + w); }
    }
    const bw = x1 - x0 + 1; const bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < 3) continue;
    const score = sum / n;
    if (score < DET.boxThresh) continue;
    const d = (bw * bh * DET.unclip) / (2 * (bw + bh)); // unclip distance
    boxes.push({
      x0: Math.max(0, (x0 - d) / (w / source.width)),
      y0: Math.max(0, (y0 - d) / (h / source.height)),
      x1: Math.min(source.width, (x1 + 1 + d) / (w / source.width)),
      y1: Math.min(source.height, (y1 + 1 + d) / (h / source.height)),
      score,
    });
  }
  return boxes;
}

/** Text recognition (CTC) of one box. Tall boxes are vertical text: rotated 90° first, as PaddleOCR does. */
async function recognize(session, chars, source, box) {
  const bw = box.x1 - box.x0; const bh = box.y1 - box.y0;
  const vertical = bh >= 1.5 * bw;
  const cw = vertical ? bh : bw; const ch = vertical ? bw : bh;
  const W = Math.min(3200, Math.max(16, Math.ceil((REC_HEIGHT * cw) / ch)));
  const c = canvasOf(W, REC_HEIGHT);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  if (vertical) {
    // Rotate the crop 90° anticlockwise so the column reads left-to-right.
    ctx.translate(0, REC_HEIGHT);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(source, box.x0, box.y0, bw, bh, 0, 0, REC_HEIGHT, W);
  } else {
    ctx.drawImage(source, box.x0, box.y0, bw, bh, 0, 0, W, REC_HEIGHT);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const input = toTensor(ctx, W, REC_HEIGHT, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
  const out = await session.run({ [session.inputNames[0]]: input });
  const t = out[session.outputNames[0]];
  const [, steps, classes] = t.dims;
  let text = ''; let prev = -1; let scoreSum = 0; let count = 0;
  for (let i = 0; i < steps; i++) {
    let best = 0; let bestP = -Infinity;
    for (let k = 0; k < classes; k++) {
      const p = t.data[i * classes + k];
      if (p > bestP) { bestP = p; best = k; }
    }
    if (best !== 0 && best !== prev) { text += chars[best] ?? ''; scoreSum += bestP; count++; }
    prev = best;
  }
  return { text: text.trim(), confidence: count ? (scoreSum / count) * 100 : 0, vertical };
}

/**
 * Find and read every text region.
 * @returns {Promise<Array<{text, confidence, bbox:{x0,y0,x1,y1}, vertical, detScore}>>}
 */
export async function paddleDetect(source, { onProgress } = {}) {
  const notify = onProgress || (() => {});
  const { det, rec, chars, cn2tw } = await load(notify);
  notify({ status: 'finding text', progress: 0 });
  // Two passes. At the photo's own size (960–2400 px on the long side) display
  // lettering is found whole. Small print also needs an enlarged pass: at the
  // smaller size the first or last character of a small line is often missed
  // (benchmark: 69.5% → 72.8% of characters read). Enlarging splits big
  // lettering, though, so the enlarged pass only adds or improves small text.
  const long = Math.max(source.width, source.height);
  const side = Math.min(DET.maxSide, Math.max(DET.limitSide, long));
  const passes = [await detect(det, source, side)];
  if (DET.fineSide / side >= 1.25) passes.push(await detect(det, source, DET.fineSide));
  const total = passes[0].length + (passes[1]?.length || 0);
  let done = 0;
  const read = [];
  for (const boxes of passes) {
    const lines = [];
    for (const box of boxes) {
      const r = await recognize(rec, chars, source, box);
      notify({ status: 'reading text', progress: ++done / total });
      // A few non-text marks get a box and a near-zero score ("C" at 4%).
      if (r.text && r.confidence >= 20) lines.push({ ...r, text: toTaiwan(r.text, cn2tw), bbox: box, detScore: box.score });
    }
    read.push(lines);
  }
  return dropRepeats(mergePieces(read.length > 1 ? combinePasses(read[0], read[1]) : read[0]));
}

/**
 * Merge the normal and the enlarged pass. Big text always comes from the
 * normal pass. A small line from the enlarged pass replaces the normal-pass
 * line it overlaps when it reads more characters (or the same number, more
 * confidently), and is added when the normal pass found nothing there.
 */
function combinePasses(base, fine) {
  const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const overlap = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
  const thick = (l) => Math.min(l.bbox.x1 - l.bbox.x0, l.bbox.y1 - l.bbox.y0);
  const len = (l) => [...l.text.replace(/\s/g, '')].length;
  const out = [...base];
  for (const f of fine) {
    if (thick(f) >= DET.smallText) continue;
    const hits = out.filter((b) => overlap(b.bbox, f.bbox) >= 0.5 * Math.min(area(b.bbox), area(f.bbox)));
    if (!hits.length) { out.push(f); continue; }
    if (hits.some((b) => thick(b) >= DET.smallText)) continue;
    const hitLen = hits.reduce((n, b) => n + len(b), 0);
    const better = len(f) > hitLen || (len(f) === hitLen && hits.length === 1 && f.confidence > hits[0].confidence);
    if (better) { for (const b of hits) out.splice(out.indexOf(b), 1); out.push(f); }
  }
  return out;
}

/**
 * The text finder sometimes boxes a character twice: once inside its line and
 * once on its own ("時" inside "報名時間"). Converting both puts two text
 * boxes on top of each other, so drop a short reading that sits almost wholly inside
 * a longer line of the same direction and size.
 */
function dropRepeats(lines) {
  const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const thick = (l) => (l.vertical ? l.bbox.x1 - l.bbox.x0 : l.bbox.y1 - l.bbox.y0);
  return lines.filter((l) => !lines.some((m) => {
    if (m === l || m.vertical !== l.vertical || [...m.text].length <= [...l.text].length) return false;
    const a = l.bbox; const b = m.bbox;
    const inside = area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
    const ratio = Math.max(thick(l), thick(m)) / Math.max(1, Math.min(thick(l), thick(m)));
    return inside >= 0.8 * area(a) && ratio < 3;
  }));
}

/**
 * The text finder splits a line at wide gaps ("上午  09:30", letter-spaced
 * titles, "08 / 03"). Join horizontal pieces that sit on the same baseline at a
 * similar size with a gap of under ~1.5 character heights.
 */
function mergePieces(lines) {
  const H = (b) => b.y1 - b.y0;
  const out = [];
  const rest = [...lines].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  while (rest.length) {
    let cur = rest.shift();
    for (let i = 0; i < rest.length; i++) {
      const nx = rest[i];
      if (cur.vertical || nx.vertical) continue;
      const a = cur.bbox; const b = nx.bbox;
      const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      const sameRow = overlapY >= 0.6 * Math.min(H(a), H(b));
      const sameSize = Math.max(H(a), H(b)) / Math.min(H(a), H(b)) < 1.4;
      const gap = b.x0 - a.x1;
      if (!sameRow || !sameSize || gap > 1.5 * Math.min(H(a), H(b)) || gap < -0.3 * H(b)) continue;
      cur = {
        ...cur,
        text: `${cur.text}${gap > 0.35 * Math.min(H(a), H(b)) ? ' ' : ''}${nx.text}`,
        confidence: (cur.confidence * cur.text.length + nx.confidence * nx.text.length) / (cur.text.length + nx.text.length),
        bbox: { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), score: Math.min(a.score, b.score) },
      };
      rest.splice(i, 1);
      i = -1; // look again: the longer line may now reach another piece
    }
    out.push(cur);
  }
  return out;
}

/**
 * PP-OCRv5 sometimes returns Simplified forms (国, 创, 调) for Traditional
 * text. Convert those with OpenCC (Mainland → Taiwan characters, no vocabulary
 * changes). Characters the original already had are kept, e.g. 台 stays 台
 * (OpenCC's Taiwan table would make it 臺).
 */
function toTaiwan(text, cn2tw) {
  const out = cn2tw(text);
  const a = [...text];
  const b = [...out];
  if (a.length !== b.length) return out;
  return b.map((c, i) => (a[i] === '台' ? '台' : c)).join('');
}
