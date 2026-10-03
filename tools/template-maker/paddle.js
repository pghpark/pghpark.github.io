// Text detection + recognition with PaddleOCR PP-OCRv6 (Apache-2.0), run in
// the browser with ONNX Runtime Web. The Chinese model reads Simplified and
// Traditional Chinese, English and Japanese; its dictionary has 18,709
// characters. It first *finds* every text region (any layout,
// any style), then reads each one, so every visible piece of text gets a box.

// PP-OCRv6 Small (Apache-2.0): on 20 benchmark posters it read 77.1% of
// characters and 56.2% of lines exactly, against 72.1% and 43.1% for
// PP-OCRv5 mobile, at a similar download (det 9.9 MB + rec 21 MB). The files
// are the official ONNX exports, from a pinned npm package so jsDelivr serves them.
const V6 = 'https://cdn.jsdelivr.net/npm/@arcships/light-ocr-model-ppocrv6-small@0.3.4/bundle';
const V5 = 'https://cdn.jsdelivr.net/npm/pdfmarkdown-ppocrv5-models@1.0.0';
// Tried in order; PP-OCRv5 mobile is the fallback if PP-OCRv6 can't be downloaded.
const MODELS = [
  { det: `${V6}/det/inference.onnx`, rec: `${V6}/rec/inference.onnx`, dict: `${V6}/rec/dictionary.json` },
  { det: `${V5}/detection/PP-OCRv5_mobile_det_infer.ort`, rec: `${V5}/recognition/PP-OCRv5_mobile_rec_infer.onnx`, dict: `${V5}/recognition/ppocrv5_dict.txt` },
];
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';

// PaddleOCR's DB defaults, except unclip (2.0 keeps the edge characters).
const DET = { limitSide: 960, maxSide: 2400, fineSide: 1920, wholeArea: 1.4e6, tile: 1024, tileMargin: 160, smallText: 48, thresh: 0.3, boxThresh: 0.6, unclip: 2.0, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };
const REC_HEIGHT = 48;

// The CPU-only build: the full ort.min.js also carries WebGPU/WebNN support
// this app doesn't use, which doubles the engine (28 MB) and its memory.
const ORT_JS = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.js';
// The runtime's engine (14 MB). Fetched here with the models so the progress
// and countdown cover it.
const ORT_WASM_FILE = `${ORT_WASM}ort-wasm-simd-threaded.wasm`;
// File sizes, for the countdown when a server doesn't send a length.
const KNOWN_SIZE = { [MODELS[0].det]: 9880512, [MODELS[0].rec]: 21159378, [ORT_WASM_FILE]: 14239897 };

/**
 * A downloader that adds up all files in flight and reports one progress:
 * {status: 'downloading', loaded, total, progress, eta} (eta in seconds, from
 * the average speed so far; null until a second has passed).
 */
function downloader(report) {
  const files = new Map();
  const t0 = performance.now();
  let last = 0;
  const update = (force) => {
    const now = performance.now();
    if (!force && now - last < 250) return;
    last = now;
    let loaded = 0; let total = 0;
    for (const f of files.values()) { loaded += f.got; total += Math.max(f.total, f.got); }
    const secs = (now - t0) / 1000;
    const rate = secs >= 1 ? loaded / secs : 0;
    report?.({ status: 'downloading', loaded, total, progress: total ? loaded / total : null, eta: rate > 0 ? (total - loaded) / rate : null });
  };
  return async (url) => {
    const f = { got: 0, total: KNOWN_SIZE[url] || 0 }; // counts towards the total from the start
    files.set(url, f);
    const res = await fetch(url).catch((e) => { files.delete(url); throw e; });
    if (!res.ok) { files.delete(url); throw new Error(`Model download failed (${res.status})`); }
    f.total = Number(res.headers.get('content-length')) || f.total;
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      f.got += value.length;
      update(false);
    }
    f.total = f.got;
    update(true);
    const out = new Uint8Array(f.got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  };
}
const OPENCC_JS = 'https://cdn.jsdelivr.net/npm/opencc-js@1.4.2/dist/umd/cn2t.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.crossOrigin = 'anonymous'; // a CORS response can be stored for offline use
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(el);
  });
}

/**
 * The models run in reader-worker.js, a background worker this file starts
 * for each photo and closes afterwards, so the page keeps responding (on a
 * phone the work takes a minute or more) and the memory comes back after.
 * Returns { run(model, {data, dims}) → {data, dims}, close() }.
 */
function startReader({ det, rec, engine }) {
  const worker = new Worker(new URL(`reader-worker.js${new URL(import.meta.url).search}`, import.meta.url));
  const pending = new Map();
  let next = 0;
  const call = (msg, transfer = []) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
  const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); };
  worker.onmessage = ({ data: m }) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m); else p.reject(new Error(m.error));
  };
  worker.onerror = (e) => { e.preventDefault?.(); failAll(new Error(e.message || 'Text reader stopped')); };
  const ready = call({ type: 'init', ortJs: ORT_JS, wasmPaths: ORT_WASM, engine, det, rec });
  return {
    ready,
    run: (model, { data, dims }) => call({ type: 'run', model, data, dims }, [data.buffer]),
    close: () => { failAll(new Error('Text reader closed')); worker.terminate(); },
  };
}

// Downloaded once per visit (and kept by the offline store): ≈45 MB, much less
// than the runtime's working memory that closing the worker gives back.
let loading = null;
let spare = null; // the reader that load() opened to check the models, for the first photo
async function load(report) {
  loading ||= (async () => {
    await self.templateMakerOffline; // see app.js: lets the offline store keep this download
    const fetchBytes = downloader(report);
    // If this fails, the runtime fetches its engine itself (just without progress).
    const wasm = fetchBytes(ORT_WASM_FILE).catch(() => null);
    let files; let entries; let lastError;
    for (const model of MODELS) {
      try {
        const [det, rec, dictText] = await Promise.all([
          fetchBytes(model.det),
          fetchBytes(model.rec),
          fetch(model.dict).then((r) => { if (!r.ok) throw new Error(`Model download failed (${r.status})`); return r.text(); }),
        ]);
        files = { det, rec, engine: await wasm };
        // Check the models open before settling on them (else try the next).
        const reader = startReader(files);
        try { await reader.ready; } catch (e) { reader.close(); throw e; }
        spare = reader;
        // CTC: index 0 is "blank", then the dictionary, then a space. A .json
        // dictionary is {"characters": [...]}; a .txt one has one character per
        // line (the v5 export also has a stray empty line that is not a class).
        entries = model.dict.endsWith('.json')
          ? JSON.parse(dictText).characters
          : dictText.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== '');
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (!entries) throw lastError;
    const chars = ['', ...entries, ' '];
    if (!self.OpenCC) await loadScript(OPENCC_JS).catch(() => {});
    const cn2tw = self.OpenCC ? OpenCC.Converter({ from: 'cn', to: 'tw' }) : (t) => t;
    return { files, chars, cn2tw };
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
function toTensor(ctx, w, h, mean, std, x = 0, y = 0) {
  const { data } = ctx.getImageData(x, y, w, h);
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0; i < plane; i++) {
    const r = data[i * 4] / 255; const g = data[i * 4 + 1] / 255; const b = data[i * 4 + 2] / 255;
    out[i] = (b - mean[0]) / std[0];
    out[plane + i] = (g - mean[1]) / std[1];
    out[2 * plane + i] = (r - mean[2]) / std[2];
  }
  return { data: out, dims: [1, 3, h, w] };
}

/**
 * Text detection (DB). Returns axis-aligned boxes in source pixels with a
 * score. Each connected region of the probability map is one text instance;
 * like PaddleOCR's DBPostProcess it is scored by its mean probability and
 * expanded by area × unclip / perimeter.
 */
async function detect(session, source, side, { tiled = false, onTile = () => {} } = {}) {
  const long = Math.max(source.width, source.height);
  const s = side / long;
  const w = Math.max(32, Math.round((source.width * s) / 32) * 32);
  const h = Math.max(32, Math.round((source.height * s) / 32) * 32);
  const c = canvasOf(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  // Tiled: the model's memory use grows with the area it is given, and a whole
  // 2400 px photo needs more than a phone browser allows (Safari closes the
  // tab). It looks at local neighbourhoods, so overlapping tiles, stitched,
  // give nearly the same map; only very large lettering can be cut at a seam.
  const prob = new Float32Array(w * h);
  const T = tiled ? DET.tile : Infinity; const M = DET.tileMargin;
  const starts = (n) => { const out = []; for (let p = 0; ; p += T - 2 * M) { out.push(Math.max(0, Math.min(p, n - T))); if (p + T >= n) break; } return [...new Set(out)]; };
  const ys = h <= T ? [0] : starts(h); const xs = w <= T ? [0] : starts(w);
  let tile = 0;
  for (const ty of ys) {
    for (const tx of xs) {
      const tw = Math.min(T, w); const th = Math.min(T, h);
      const t = await session(toTensor(ctx, tw, th, DET.mean, DET.std, tx, ty));
      // Keep each tile's inner part (its margin is unreliable), except at the image edges.
      const ix0 = tx === 0 ? 0 : M; const iy0 = ty === 0 ? 0 : M;
      const ix1 = tx + tw >= w ? tw : tw - M; const iy1 = ty + th >= h ? th : th - M;
      for (let y = iy0; y < iy1; y++) prob.set(t.data.subarray(y * tw + ix0, y * tw + ix1), (ty + y) * w + tx + ix0);
      onTile(++tile / (ys.length * xs.length));
    }
  }
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
  c.width = 0; c.height = 0; // free the working canvas now (Safari caps page canvas memory)
  return boxes;
}

/**
 * Text recognition (CTC) of one box. Tall boxes are vertical text: rotated 90°
 * first, as PaddleOCR does. With `among` (a string of characters), reads a
 * single character known to be one of those: the one the model scores highest.
 */
async function recognize(session, chars, source, box, among = null) {
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
  c.width = 0; c.height = 0;
  const t = await session(input);
  const [, steps, classes] = t.dims;
  if (among) {
    let bestCh = ''; let bestP = 0;
    for (const chr of among) {
      const k = chars.indexOf(chr);
      if (k < 0) continue;
      for (let i = 0; i < steps; i++) if (t.data[i * classes + k] > bestP) { bestP = t.data[i * classes + k]; bestCh = chr; }
    }
    return { text: bestCh, confidence: bestP * 100, vertical };
  }
  let text = ''; let prev = -1; let scoreSum = 0; let count = 0; const charConf = [];
  for (let i = 0; i < steps; i++) {
    let best = 0; let bestP = -Infinity;
    for (let k = 0; k < classes; k++) {
      const p = t.data[i * classes + k];
      if (p > bestP) { bestP = p; best = k; }
    }
    if (best !== 0 && best !== prev) { text += chars[best] ?? ''; charConf.push(bestP); scoreSum += bestP; count++; }
    prev = best;
  }
  // Per-character confidence (0–1), aligned with the characters of the untrimmed text.
  const lead = text.length - text.trimStart().length;
  return { text: text.trim(), confidence: count ? (scoreSum / count) * 100 : 0, vertical, charConf: charConf.slice(lead) };
}

/**
 * Find and read every text region.
 * @returns {Promise<Array<{text, confidence, bbox:{x0,y0,x1,y1}, vertical, detScore}>>}
 */
export async function paddleDetect(source, { onProgress } = {}) {
  const notify = onProgress || (() => {});
  const { files, chars, cn2tw } = await load(notify);
  const reader = spare || startReader(files);
  spare = null;
  try {
    await reader.ready;
    return await readAll(source, reader, chars, cn2tw, notify);
  } finally {
    reader.close();
  }
}

const READ_AHEAD = 6;

/** Run `fn` over `items` with at most `limit` running at once; results in order. */
async function inTurn(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

async function readAll(source, reader, chars, cn2tw, notify) {
  const det = (input) => reader.run('det', input);
  const rec = (input) => reader.run('rec', input);
  notify({ status: 'finding text', progress: 0 });
  // Two passes. The whole image, at most ~1.4 megapixels so it fits a phone's
  // memory, finds display lettering whole (tiles could cut a big date).
  // Small print also needs a larger pass: at the smaller size the first or
  // last character of a small line is often missed (benchmark: 69.5% → 72.8%
  // of characters read). That pass is tiled, and only adds or improves small
  // text, so big lettering never comes from it.
  const long = Math.max(source.width, source.height);
  const aspect = Math.min(source.width, source.height) / long;
  const side = Math.min(DET.maxSide, Math.max(DET.limitSide, long), Math.sqrt(DET.wholeArea / aspect));
  const fine = Math.min(DET.maxSide, Math.max(DET.fineSide, long));
  const twoPasses = fine / side >= 1.25;
  // The larger pass has about (fine/side)² times the work.
  const share = twoPasses ? 1 / (1 + (fine / side) ** 2) : 1;
  const passes = [await detect(det, source, side, { onTile: (f) => notify({ status: 'finding text', progress: f * share }) })];
  if (twoPasses) passes.push(await detect(det, source, fine, { tiled: true, onTile: (f) => notify({ status: 'finding text', progress: share + f * (1 - share) }) }));
  const total = passes[0].length + (passes[1]?.length || 0);
  let done = 0;
  const read = [];
  for (const boxes of passes) {
    // Several lines in flight: this page prepares the next crops while the
    // worker reads, so it never waits idle. Each line is read exactly as alone.
    const results = await inTurn(boxes, READ_AHEAD, async (box) => {
      const r = await recognize(rec, chars, source, box);
      notify({ status: 'reading text', progress: ++done / total });
      return r;
    });
    const lines = [];
    results.forEach((r, i) => {
      // A few non-text marks get a box and a near-zero score ("C" at 4%).
      if (r.text && r.confidence >= 20) lines.push({ ...r, text: toTaiwan(r.text, cn2tw), bbox: boxes[i], detScore: boxes[i].score });
    });
    read.push(lines);
  }
  const lines = dropRepeats(stackColumns(mergePieces(read.length > 1 ? combinePasses(read[0], read[1]) : read[0])));
  const found = restoreDateSlashes(source, await readBadges(source, lines, (canvas, box, among) => recognize(rec, chars, canvas, box, among)));
  // A lone Latin letter, or a lone digit read unsurely, is nearly always a
  // speck or decoration misread ("a" or "2" for a piece of confetti).
  return found.filter((l) => !/^[A-Za-z]$/.test(l.text.trim()) && !(/^\d$/.test(l.text.trim()) && l.confidence < 90 && !l.badge));
}

/**
 * A longer reading replaces the short pieces it covers, but a piece may have
 * read one of its characters more surely (屆 alone at 81%, where the whole
 * column read 國). Keep a piece's Chinese character when it was read more
 * confidently than the character at the same place in the longer reading.
 */
function keepSureCharacters(f, pieces) {
  const chars = [...f.text];
  if (!f.charConf || f.charConf.length !== chars.length) return f;
  const han = /^\p{Script=Han}$/u;
  const a0 = f.vertical ? f.bbox.y0 : f.bbox.x0; const a1 = f.vertical ? f.bbox.y1 : f.bbox.x1;
  for (const p of pieces) {
    const t = p.text.trim();
    if ([...t].length !== 1 || !han.test(t)) continue;
    const c = f.vertical ? (p.bbox.y0 + p.bbox.y1) / 2 : (p.bbox.x0 + p.bbox.x1) / 2;
    const i = Math.min(chars.length - 1, Math.max(0, Math.floor(((c - a0) / (a1 - a0)) * chars.length)));
    if (han.test(chars[i]) && chars[i] !== t && p.confidence / 100 > f.charConf[i]) chars[i] = t;
  }
  return { ...f, text: chars.join('') };
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
    // Overlapping big lettering: usually a piece of it (skip), but a small mark
    // set beside it (第 next to 歷史) reads characters the big line doesn't have.
    const big = hits.filter((b) => thick(b) >= DET.smallText);
    if (big.length) {
      const own = [...f.text.replace(/\s/g, '')].filter((ch) => !big.some((b) => b.text.includes(ch)));
      if (own.length < len(f) || area(f.bbox) >= 0.15 * Math.min(...big.map((b) => area(b.bbox)))) continue;
    }
    const small = hits.filter((b) => !big.includes(b));
    if (!small.length) { out.push(f); continue; }
    const hitLen = small.reduce((n, b) => n + len(b), 0);
    const better = len(f) > hitLen || (len(f) === hitLen && small.length === 1 && f.confidence > small[0].confidence);
    if (better) { for (const b of small) out.splice(out.indexOf(b), 1); out.push(keepSureCharacters(f, small)); }
  }
  return out;
}

/**
 * Stylised dates often use a thin, long slash (01/15) that the reader drops,
 * giving "0115". For a line read as four digits that make a valid month and
 * day, count the separate marks across its letters: five marks, the middle
 * one leaning like "/", means the slash is there.
 */
function restoreDateSlashes(source, lines) {
  const ctx = source.getContext('2d', { willReadFrequently: true });
  return lines.map((l) => {
    const m = !l.vertical && l.text.trim().match(/^(\d{2})(\d{2})$/);
    if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31) return l;
    const x0 = Math.max(0, Math.floor(l.bbox.x0)); const y0 = Math.max(0, Math.floor(l.bbox.y0));
    const w = Math.min(source.width, Math.ceil(l.bbox.x1)) - x0; const h = Math.min(source.height, Math.ceil(l.bbox.y1)) - y0;
    if (w < 10 || h < 6) return l;
    const { data } = ctx.getImageData(x0, y0, w, h);
    const px = (i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    const border = [];
    for (let x = 0; x < w; x++) border.push(px(x), px((h - 1) * w + x));
    const bg = [0, 1, 2].map((k) => { const v = border.map((c) => c[k]).sort((a, b) => a - b); return v[v.length >> 1]; });
    const d = l.disc; // a weekday badge's disc isn't one of the date's marks
    const ink = (x, y) => {
      if (d && Math.hypot(x0 + x - d.cx, y0 + y - d.cy) < d.r * 1.08) return false;
      const c = px(y * w + x); return Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 120;
    };
    // Separate marks: connected ink shapes of a good part of the digits' height.
    const seen = new Uint8Array(w * h); const shapes = [];
    for (let k = 0; k < w * h; k++) {
      if (seen[k] || !ink(k % w, (k - (k % w)) / w)) continue;
      const stack = [k]; seen[k] = 1; const pts = [];
      while (stack.length) {
        const q = stack.pop(); const x = q % w; const y = (q - x) / w; pts.push([x, y]);
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!seen[j] && ink(nx, ny)) { seen[j] = 1; stack.push(j); }
        }
      }
      const ys = pts.map((p) => p[1]);
      shapes.push({ pts, top: Math.min(...ys), bottom: Math.max(...ys), cx: pts.reduce((n, p) => n + p[0], 0) / pts.length });
    }
    // Typical digit height: the median height of the large shapes.
    const most = Math.max(0, ...shapes.map((sh) => sh.pts.length));
    const heights = shapes.filter((sh) => sh.pts.length >= 0.3 * most).map((sh) => sh.bottom - sh.top).sort((p, q) => p - q);
    const digitH = heights[heights.length >> 1] || 0;
    const marks = shapes.filter((sh) => sh.bottom - sh.top >= 0.4 * digitH && sh.pts.length >= 8).sort((p, q) => p.cx - q.cx);
    if (marks.length !== 5) return l;
    // The middle mark should lean like "/": further right at its top than at its bottom.
    const sl = marks[2]; const mid = (sl.top + sl.bottom) / 2;
    const upper = sl.pts.filter((p) => p[1] < mid); const lower = sl.pts.filter((p) => p[1] >= mid);
    const width = Math.max(...sl.pts.map((p) => p[0])) - Math.min(...sl.pts.map((p) => p[0])) + 1;
    if (!upper.length || !lower.length) return l;
    const lean = upper.reduce((n, p) => n + p[0], 0) / upper.length - lower.reduce((n, p) => n + p[0], 0) / lower.length;
    if (lean < 0.25 * width) return l;
    return { ...l, text: `${m[1]}/${m[2]}` };
  });
}

/**
 * Weekdays on posters are often a character in a filled circle (01/15 ㊁).
 * The reader sees the circle as a letter ("0115e") or skips it, and erasing
 * the date would wipe the circle out. Look beside each date-like line for a
 * filled disc of the line's colour; read the character inside it on its own
 * (flipped to dark-on-light), and re-read the date without the disc. The disc
 * itself stays in the picture; only the character becomes editable text.
 */
const WEEKDAYS = '一二三四五六日天';
async function readBadges(source, lines, read) {
  const W = source.width; const H = source.height;
  const ctx = source.getContext('2d', { willReadFrequently: true });
  const out = [...lines];
  for (const line of lines) {
    // Dates only (01/15, 0115, 8月10日), allowing a stray letter or two where the badge was misread.
    if (line.vertical || !/^\d{1,2}\s*[/.\-月]?\s*\d{1,2}\s*日?\s*[A-Za-z()（）○◯]{0,2}$/.test(line.text.trim()) || (line.text.match(/\d/g) || []).length < 3) continue;
    const b = line.bbox; const h = b.y1 - b.y0;
    const rx0 = Math.max(0, Math.floor(b.x0)); const rx1 = Math.min(W, Math.ceil(b.x1 + 1.5 * h));
    const ry0 = Math.max(0, Math.floor(b.y0 - 0.3 * h)); const ry1 = Math.min(H, Math.ceil(b.y1 + 0.3 * h));
    const rw = rx1 - rx0; const rh = ry1 - ry0;
    if (rw < 8 || rh < 8) continue;
    const { data } = ctx.getImageData(rx0, ry0, rw, rh);
    const disc = findDisc(data, rw, rh, h);
    if (!disc) continue;
    const D = { x0: rx0 + disc.cx - disc.r, y0: ry0 + disc.cy - disc.r, x1: rx0 + disc.cx + disc.r, y1: ry0 + disc.cy + disc.r };
    // Read the character inside: inner square, character dark on light.
    const side = 2 * Math.max(4, Math.round(disc.r * 0.7)); // even, so the half offsets are whole pixels
    const crop = document.createElement('canvas');
    crop.width = side * 2; crop.height = side * 2;
    const cc = crop.getContext('2d', { willReadFrequently: true });
    cc.fillStyle = '#fff';
    cc.fillRect(0, 0, crop.width, crop.height);
    cc.drawImage(source, rx0 + disc.cx - side / 2, ry0 + disc.cy - side / 2, side, side, side / 2, side / 2, side, side);
    const img = cc.getImageData(side / 2, side / 2, side, side);
    // Inside the circle, pixels closer to the character's colour than to the
    // disc's are ink; the disc and anything outside the circle are paper.
    const off = (i) => Math.abs(img.data[i] - disc.color[0]) + Math.abs(img.data[i + 1] - disc.color[1]) + Math.abs(img.data[i + 2] - disc.color[2]);
    const inside = [];
    for (let i = 0; i < img.data.length; i += 4) {
      const x = (i / 4) % side - side / 2 + 0.5; const y = Math.floor(i / 4 / side) - side / 2 + 0.5;
      if (Math.hypot(x, y) < 0.9 * disc.r) inside.push(i);
    }
    const offs = inside.map(off).sort((x, y) => x - y);
    const cut = Math.max(60, offs[Math.floor(offs.length * 0.95)] / 2); // halfway to the character colour
    const ink = new Uint8Array(side * side);
    const inkRGB = [0, 0, 0]; let inkN = 0;
    for (const i of inside) {
      ink[i / 4] = off(i) > cut ? 1 : 0;
      if (off(i) > 1.5 * cut) { inkRGB[0] += img.data[i]; inkRGB[1] += img.data[i + 1]; inkRGB[2] += img.data[i + 2]; inkN++; }
    }
    // Majority filter: drops print-texture specks, keeps strokes.
    for (let k = 0; k < side * side; k++) {
      const x = k % side; const y = (k - x) / side; let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx; const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < side && yy < side) n += ink[yy * side + xx];
      }
      const v = n >= 5 ? 0 : 255;
      img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = v;
    }
    cc.putImageData(img, side / 2, side / 2);
    // Beside a date, a badge is the day of the week.
    const r = await read(crop, { x0: 0, y0: 0, x1: crop.width, y1: crop.height }, WEEKDAYS);
    crop.width = 0; crop.height = 0;
    const ch = r.text;
    if (!ch || r.confidence < 15) continue; // low is fine: a disc beside a date is already strong evidence
    const inner = { x0: rx0 + disc.cx - side / 2, y0: ry0 + disc.cy - side / 2, x1: rx0 + disc.cx + side / 2, y1: ry0 + disc.cy + side / 2, score: 1 };
    // Drop readings of the badge itself; re-read the date without it.
    for (const l of [...out]) {
      if (l === line || l.vertical) continue;
      const lb = l.bbox;
      const ov = Math.max(0, Math.min(lb.x1, D.x1) - Math.max(lb.x0, D.x0)) * Math.max(0, Math.min(lb.y1, D.y1) - Math.max(lb.y0, D.y0));
      if (ov >= 0.6 * (lb.x1 - lb.x0) * (lb.y1 - lb.y0)) out.splice(out.indexOf(l), 1);
    }
    // The date keeps its box, but shouldn't keep what the reader made of the
    // badge ("0115e", "08/25四"); the editor is told where the disc is, so it
    // can measure the date's letters without it and leave it unerased.
    const m = line.text.trim().match(/^(.*?\d{1,2}\s*[/.\-月]?\s*\d{1,2}\s*日?)(.{0,2})$/);
    out[out.indexOf(line)] = { ...line, text: m ? m[1] : line.text, disc: { cx: rx0 + disc.cx, cy: ry0 + disc.cy, r: disc.r } };
    // The editor needs the disc (to repaint it under the character) and the
    // character's own colour (the usual estimate would pick the disc's).
    const badge = {
      cx: rx0 + disc.cx, cy: ry0 + disc.cy, r: disc.r, color: disc.color.map(Math.round),
      ink: inkN ? inkRGB.map((v) => Math.round(v / inkN)) : [255, 255, 255],
    };
    out.push({ text: ch, confidence: r.confidence, vertical: false, bbox: inner, detScore: 1, badge });
  }
  return out;
}

/**
 * The best filled disc in an RGBA patch, found by trying centres and radii:
 * just inside its edge the disc is solid and one colour; just outside it is
 * mostly background (a neighbouring digit may touch it). `lineH` bounds the
 * size. Returns {cx, cy, r, color} in patch pixels, where color is the disc's
 * own colour, or null.
 */
function findDisc(data, w, h, lineH) {
  const px = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const dist = (a, c) => Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) + Math.abs(a[2] - c[2]);
  const median = (arr) => { const v = [...arr].sort((x, y) => x - y); return v[v.length >> 1]; };
  // Background: median colour of the patch border.
  const border = [];
  for (let x = 0; x < w; x++) border.push(px(x, 0), px(x, h - 1));
  for (let y = 0; y < h; y++) border.push(px(0, y), px(w - 1, y));
  const bg = [0, 1, 2].map((k) => median(border.map((c) => c[k])));
  const isBg = (c) => dist(c, bg) <= 80;
  const steps = 32;
  const ring = Array.from({ length: steps }, (_, s) => [Math.cos((2 * Math.PI * s) / steps), Math.sin((2 * Math.PI * s) / steps)]);
  let best = null;
  const rMin = Math.max(5, 0.15 * lineH); const rMax = 0.8 * lineH;
  for (let r = rMin; r <= rMax; r += Math.max(1, r * 0.08)) {
    const step = Math.max(1, Math.round(r / 6));
    for (let cy = Math.ceil(r * 1.2); cy < h - r * 1.2; cy += step) {
      for (let cx = Math.ceil(r * 1.2); cx < w - r * 1.2; cx += step) {
        const rim = [];
        for (const [dx, dy] of ring) {
          const c = px(Math.round(cx + 0.85 * r * dx), Math.round(cy + 0.85 * r * dy));
          if (!isBg(c)) rim.push(c);
        }
        if (rim.length < 0.9 * steps) continue;
        let outside = 0;
        for (const [dx, dy] of ring) if (isBg(px(Math.round(cx + 1.2 * r * dx), Math.round(cy + 1.2 * r * dy)))) outside++;
        if (outside < 0.55 * steps) continue;
        const color = [0, 1, 2].map((k) => median(rim.map((c) => c[k])));
        if (rim.filter((c) => dist(c, color) < 90).length < 0.85 * steps) continue;
        const score = outside / steps + rim.length / steps + r / rMax * 0.5;
        if (!best || score > best.score) best = { cx, cy, r, color, score };
      }
    }
  }
  return best;
}

/**
 * A short vertical label (第④屆) can come back as one box per character.
 * Single characters stacked in a column, of a similar width and close
 * together, are joined top to bottom into one vertical line.
 */
function stackColumns(lines) {
  const W = (b) => b.x1 - b.x0;
  const single = (l) => !l.vertical && /^[\p{L}\p{N}]$/u.test(l.text.trim());
  const columns = [];
  for (const l of lines.filter(single).sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const col = columns.find((c) => {
      const q = c[c.length - 1].bbox; const b = l.bbox;
      const overlapX = Math.min(q.x1, b.x1) - Math.max(q.x0, b.x0);
      const w = Math.min(W(q), W(b));
      const gap = b.y0 - q.y1;
      return overlapX >= 0.6 * w && Math.max(W(q), W(b)) / w < 1.6 && gap < 0.8 * w && gap > -0.6 * w;
    });
    if (col) col.push(l); else columns.push([l]);
  }
  const joined = columns.filter((c) => c.length >= 2);
  const used = new Set(joined.flat());
  return [
    ...lines.filter((l) => !used.has(l)),
    ...joined.map((c) => ({
      ...c[0],
      text: c.map((l) => l.text.trim()).join(''),
      vertical: true,
      confidence: c.reduce((n, l) => n + l.confidence, 0) / c.length,
      bbox: {
        x0: Math.min(...c.map((l) => l.bbox.x0)), y0: c[0].bbox.y0,
        x1: Math.max(...c.map((l) => l.bbox.x1)), y1: c[c.length - 1].bbox.y1,
        score: Math.min(...c.map((l) => l.bbox.score)),
      },
    })),
  ];
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
  const W = (b) => b.x1 - b.x0;
  const mid = (b) => (b.x0 + b.x1) / 2;
  // Centred columns side by side (names in a speaker grid) can sit as close
  // as a word gap. A piece heads its own column when a line of clearly
  // different width is centred on it just above or below: then keep apart.
  const ownColumn = (a, other) => lines.some((l) => {
    const b = l.bbox;
    if (l.vertical || b === a || b === other) return false;
    const h = H(a);
    const below = b.y0 - a.y1; const above = a.y0 - b.y1;
    const near = (below > -0.3 * h && below < 3 * h) || (above > -0.3 * h && above < 3 * h);
    return near && Math.abs(mid(b) - mid(a)) <= Math.max(3, 0.06 * W(a)) && Math.abs(W(b) - W(a)) >= 0.25 * W(a);
  });
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
      if (ownColumn(a, b) && ownColumn(b, a)) continue;
      // A doubtful reading (an emblem read as "空物") stays apart from confident text.
      if ((cur.confidence < 50) !== (nx.confidence < 50)) continue;
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
