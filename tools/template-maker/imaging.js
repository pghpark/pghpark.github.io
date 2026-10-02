// Canvas helpers: loading photos, removing old text, guessing text colour.
import { t } from './i18n.js';

export const MAX_SIDE = 2400;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function cloneCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0);
  return c;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t('errReadImage')));
    img.src = src;
  });
}

/** Read an uploaded file into a canvas, downscaling very large photos. */
export async function fileToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = makeCanvas(Math.round(img.naturalWidth * scale), Math.round(img.naturalHeight * scale));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function urlToCanvas(url) {
  const img = await loadImage(url);
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
  return c;
}

const clampRect = (c, x0, y0, x1, y1) => ({
  x0: Math.max(0, Math.floor(x0)), y0: Math.max(0, Math.floor(y0)),
  x1: Math.min(c.width, Math.ceil(x1)), y1: Math.min(c.height, Math.ceil(y1)),
});

function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[s.length >> 1];
}

/** Median colour of a 3px ring just outside the rectangle. */
export function sampleRing(canvas, box, pad) {
  const ring = 3;
  const r = clampRect(canvas, box.x0 - pad - ring, box.y0 - pad - ring, box.x1 + pad + ring, box.y1 + pad + ring);
  const inner = { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad };
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w <= 0 || h <= 0) return [255, 255, 255];
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.x0, r.y0, w, h);
  const R = []; const G = []; const B = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ax = r.x0 + x; const ay = r.y0 + y;
      if (ax >= inner.x0 && ax < inner.x1 && ay >= inner.y0 && ay < inner.y1) continue;
      const i = (y * w + x) * 4;
      R.push(data[i]); G.push(data[i + 1]); B.push(data[i + 2]);
    }
  }
  return [median(R), median(G), median(B)];
}

/**
 * Paint over text with the surrounding colour. Each row is blended between the
 * colours sampled just left and right of the box, so gentle gradients survive.
 */
export function eraseBox(canvas, box, pad = 4) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const r = clampRect(canvas, box.x0 - pad, box.y0 - pad, box.x1 + pad, box.y1 + pad);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w <= 0 || h <= 0) return;
  const fallback = sampleRing(canvas, box, pad);
  const left = sideColumn(ctx, canvas, r.x0 - 3, r.y0, h, fallback);
  const right = sideColumn(ctx, canvas, r.x1, r.y0, h, fallback);
  const img = ctx.getImageData(r.x0, r.y0, w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = w === 1 ? 0.5 : x / (w - 1);
      const i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) d[i + k] = left[y][k] * (1 - t) + right[y][k] * t;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, r.x0, r.y0);
}

// Median colour of a 3px-wide column next to the box, smoothed vertically.
function sideColumn(ctx, canvas, x, y0, h, fallback) {
  if (x < 0 || x + 3 > canvas.width) return Array.from({ length: h }, () => fallback);
  const { data } = ctx.getImageData(x, y0, 3, h);
  const rows = [];
  for (let y = 0; y < h; y++) {
    const px = [0, 1, 2].map((dx) => (y * 3 + dx) * 4);
    rows.push([0, 1, 2].map((k) => median(px.map((i) => data[i + k]))));
  }
  const win = 4;
  return rows.map((_, y) => {
    const slice = rows.slice(Math.max(0, y - win), y + win + 1);
    return [0, 1, 2].map((k) => median(slice.map((c) => c[k])));
  });
}

/**
 * Remove text by repainting only its strokes. Pixels in the box that are
 * closer to the text colour than to the surrounding background are masked
 * (plus a 1–2 px margin for anti-aliased edges), then filled inwards from
 * their unmasked neighbours, layer by layer. Everything else in the box is
 * left as photographed, so artwork behind or near the text isn't smeared.
 * Falls back to eraseBox when there's no clear text/background contrast.
 */
export function eraseText(canvas, box, pad = 3) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const bg = sampleRing(canvas, box, pad);
  const fg = textRGB(canvas, box, bg);
  if (!fg) { eraseBox(canvas, box, pad); return; }
  const grow = Math.min(3, Math.max(1, Math.round((box.y1 - box.y0) * 0.04)));
  const r = clampRect(canvas, box.x0 - pad - grow - 1, box.y0 - pad - grow - 1, box.x1 + pad + grow + 1, box.y1 + pad + grow + 1);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w <= 2 || h <= 2) return;
  const img = ctx.getImageData(r.x0, r.y0, w, h);
  const d = img.data;
  const dist = (i, c) => Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]);
  // 1. Text pixels inside the padded box (never the outer 1px frame, which seeds the fill).
  let mask = new Uint8Array(w * h);
  const bx0 = Math.max(1, Math.floor(box.x0 - pad - r.x0));
  const by0 = Math.max(1, Math.floor(box.y0 - pad - r.y0));
  const bx1 = Math.min(w - 1, Math.ceil(box.x1 + pad - r.x0));
  const by1 = Math.min(h - 1, Math.ceil(box.y1 + pad - r.y0));
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const i = (y * w + x) * 4;
      if (dist(i, fg) < dist(i, bg)) mask[y * w + x] = 1;
    }
  }
  // 2. Grow the mask to cover anti-aliased edges.
  for (let g = 0; g < grow; g++) {
    const next = mask.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const k = y * w + x;
        if (!mask[k] && (mask[k - 1] || mask[k + 1] || mask[k - w] || mask[k + w])) next[k] = 1;
      }
    }
    mask = next;
  }
  // 3. Fill masked pixels from known neighbours, outside in.
  let todo = [];
  for (let k = 0; k < w * h; k++) if (mask[k]) todo.push(k);
  let need = 2; // prefer pixels with 2+ known neighbours (smoother); drop to 1 if stuck
  while (todo.length) {
    const ready = [];
    const later = [];
    for (const k of todo) {
      const x = k % w; const y = (k - x) / w;
      let n = 0; let s0 = 0; let s1 = 0; let s2 = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; const yy = y + dy;
          if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h && !mask[yy * w + xx]) {
            const j = (yy * w + xx) * 4;
            s0 += d[j]; s1 += d[j + 1]; s2 += d[j + 2]; n++;
          }
        }
      }
      if (n >= need) ready.push([k, s0 / n, s1 / n, s2 / n]);
      else later.push(k);
    }
    if (!ready.length) {
      if (need === 1) break;
      need = 1;
      continue;
    }
    need = 2;
    for (const [k, c0, c1, c2] of ready) {
      const i = k * 4;
      d[i] = c0; d[i + 1] = c1; d[i + 2] = c2; d[i + 3] = 255;
      mask[k] = 0;
    }
    todo = later;
  }
  ctx.putImageData(img, r.x0, r.y0);
}

/**
 * Tight box around the letter pixels inside a (padded) text box, so new text
 * can be sized to the original letters rather than to the OCR box around them.
 * Pixels closer to the text colour than to the background count as ink; rows
 * and columns with only a few ink pixels (specks, artwork edges) are trimmed.
 * Returns the input box if the text doesn't stand out from its background.
 */
export function inkBounds(canvas, box) {
  const bg = sampleRing(canvas, box, 1);
  const fg = textRGB(canvas, box, bg);
  if (!fg) return box;
  const r = clampRect(canvas, box.x0, box.y0, box.x1, box.y1);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w < 3 || h < 3) return box;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.x0, r.y0, w, h);
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  const dist = (i, c) => Math.abs(data[i] - c[0]) + Math.abs(data[i + 1] - c[1]) + Math.abs(data[i + 2] - c[2]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (dist(i, fg) < dist(i, bg) && dist(i, bg) > 40) { rows[y]++; cols[x]++; }
    }
  }
  const edge = (counts, len) => {
    const max = Math.max(...counts);
    if (!max) return null;
    const min = Math.max(1, max * 0.04);
    let a = 0; while (a < len && counts[a] < min) a++;
    let b = len - 1; while (b > a && counts[b] < min) b--;
    return [a, b + 1];
  };
  const ys = edge(rows, h);
  const xs = edge(cols, w);
  if (!ys || !xs) return box;
  let ink = 0;
  for (let y = ys[0]; y < ys[1]; y++) ink += rows[y];
  // Share of the letter box covered by ink: a stroke-weight cue (bold text covers more).
  const density = ink / Math.max(1, (xs[1] - xs[0]) * (ys[1] - ys[0]));
  const tight = { x0: r.x0 + xs[0], y0: r.y0 + ys[0], x1: r.x0 + xs[1], y1: r.y0 + ys[1], density };
  // Don't trust a result that collapsed to a sliver.
  if ((tight.x1 - tight.x0) < (box.x1 - box.x0) * 0.3 || (tight.y1 - tight.y0) < (box.y1 - box.y0) * 0.3) return box;
  return tight;
}

/** Average colour of the pixels most unlike the background, or null if the text doesn't stand out. */
function textRGB(canvas, box, bg) {
  const r = clampRect(canvas, box.x0, box.y0, box.x1, box.y1);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w <= 0 || h <= 0) return null;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.x0, r.y0, w, h);
  const scored = [];
  for (let i = 0; i < data.length; i += 4) {
    scored.push([Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]), i]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const top = scored.slice(0, Math.max(1, Math.floor(scored.length * 0.1)));
  if (top[0][0] < 60) return null;
  const sum = [0, 0, 0];
  for (const [, i] of top) { sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; }
  return sum.map((v) => v / top.length);
}

const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Guess the text colour: pixels inside the box that differ most from the background. */
export function estimateTextColor(canvas, box) {
  const bg = sampleRing(canvas, box, 2);
  const r = clampRect(canvas, box.x0, box.y0, box.x1, box.y1);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w <= 0 || h <= 0) return '#000000';
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.x0, r.y0, w, h);
  const scored = [];
  for (let i = 0; i < data.length; i += 4) {
    const dist = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    scored.push([dist, i]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const top = scored.slice(0, Math.max(1, Math.floor(scored.length * 0.1)));
  if (top[0][0] < 60) {
    const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    return lum > 128 ? '#000000' : '#ffffff';
  }
  const sum = [0, 0, 0];
  for (const [, i] of top) { sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; }
  return toHex(sum.map((v) => v / top.length));
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error(t('errEncodeImage')))), type, quality,
  ));
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
