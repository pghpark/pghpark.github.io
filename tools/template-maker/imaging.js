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
 * How busy the background right around a text box is (0 = flat colour).
 * Text printed on a plain area scores low; text inside a drawing (a sign, a
 * banner, a paper someone holds) is surrounded by outlines and colour changes.
 * Measured on a ring around the box: the share of pixels far from its median colour.
 */
export function backgroundBusyness(canvas, box) {
  const h = box.y1 - box.y0;
  const pad = Math.max(3, Math.round(h * 0.35));
  const ring = Math.max(3, Math.round(h * 0.25));
  const r = clampRect(canvas, box.x0 - pad - ring, box.y0 - pad - ring, box.x1 + pad + ring, box.y1 + pad + ring);
  const inner = { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad };
  const w = r.x1 - r.x0; const hh = r.y1 - r.y0;
  if (w <= 0 || hh <= 0) return 0;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.x0, r.y0, w, hh);
  const px = [];
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    const ax = r.x0 + x; const ay = r.y0 + y;
    if (ax >= inner.x0 && ax < inner.x1 && ay >= inner.y0 && ay < inner.y1) continue;
    const i = (y * w + x) * 4; px.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (!px.length) return 0;
  const med = [0, 1, 2].map((k) => median(px.map((p) => p[k])));
  return px.filter((p) => Math.abs(p[0] - med[0]) + Math.abs(p[1] - med[1]) + Math.abs(p[2] - med[2]) > 90).length / px.length;
}

/**
 * Tight box around the letter pixels inside a (padded) text box, so new text
 * can be sized to the original letters rather than to the OCR box around them.
 * Pixels closer to the text colour than to the background count as ink; rows
 * and columns with only a few ink pixels (specks, artwork edges) are trimmed.
 * Returns the input box if the text doesn't stand out from its background.
 * For a vertical line the same is done with rows and columns swapped.
 */
export function inkBounds(canvas, box, { vertical = false } = {}) {
  const r = clampRect(canvas, box.x0, box.y0, box.x1, box.y1);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w < 3 || h < 3) return box;
  const bg = sampleRing(canvas, box, 1);
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.x0, r.y0, w, h);
  const d = (i, c) => Math.abs(data[i] - c[0]) + Math.abs(data[i + 1] - c[1]) + Math.abs(data[i + 2] - c[2]);
  // "across" runs over the line's thickness (rows of a horizontal line,
  // columns of a vertical one); "along" runs along its letters.
  const A = vertical ? w : h;
  const B = vertical ? h : w;
  const at = vertical ? (a, b) => (b * w + a) * 4 : (a, b) => (a * w + b) * 4;
  // Text colour from the middle band of the box only: the line itself, not a
  // neighbour (a big date above a time) poking into the padded box.
  const band = [];
  for (let a = Math.floor(A * 0.3); a < Math.ceil(A * 0.7); a++) {
    for (let b = 0; b < B; b++) { const i = at(a, b); band.push([d(i, bg), i]); }
  }
  band.sort((p, q) => q[0] - p[0]);
  const top = band.slice(0, Math.max(1, Math.floor(band.length * 0.08)));
  if (!top.length || top[0][0] < 60) return box;
  const fg = [0, 1, 2].map((k) => top.reduce((s, [, i]) => s + data[i + k], 0) / top.length);
  // A pixel is ink if it is nearer this line's colour than the background's.
  const isInk = (i) => d(i, fg) < d(i, bg) && d(i, bg) > 40;
  const across = new Uint32Array(A);
  const along = new Uint32Array(B);
  for (let a = 0; a < A; a++) {
    for (let b = 0; b < B; b++) if (isInk(at(a, b))) across[a]++;
  }
  // Grow from the middle outwards; stop at the first (nearly) empty row or
  // column, which separates this line from its neighbours.
  const maxA = Math.max(...across);
  if (!maxA) return box;
  const empty = Math.max(1, maxA * 0.03);
  const mid = Math.floor(A / 2);
  let a0 = mid; let a1 = mid;
  while (a0 > 0 && across[a0 - 1] > empty) a0--;
  while (a1 < A - 1 && across[a1 + 1] > empty) a1++;
  if (across[mid] <= empty) { // the middle is a gap (e.g. between two strokes): fall back to everything
    a0 = across.findIndex((v) => v > empty); a1 = A - 1 - [...across].reverse().findIndex((v) => v > empty);
  }
  let ink = 0;
  for (let a = a0; a <= a1; a++) {
    for (let b = 0; b < B; b++) if (isInk(at(a, b))) { along[b]++; ink++; }
  }
  const minB = Math.max(1, Math.max(...along) * 0.04);
  let b0 = 0; while (b0 < B && along[b0] < minB) b0++;
  let b1 = B - 1; while (b1 > b0 && along[b1] < minB) b1--;
  const tight = vertical
    ? { x0: r.x0 + a0, y0: r.y0 + b0, x1: r.x0 + a1 + 1, y1: r.y0 + b1 + 1 }
    : { x0: r.x0 + b0, y0: r.y0 + a0, x1: r.x0 + b1 + 1, y1: r.y0 + a1 + 1 };
  tight.density = ink / Math.max(1, (tight.x1 - tight.x0) * (tight.y1 - tight.y0));
  if ((tight.x1 - tight.x0) < (box.x1 - box.x0) * 0.3 || (tight.y1 - tight.y0) < (box.y1 - box.y0) * 0.3) return box;
  return tight;
}

/**
 * Black-and-white mask of the letter strokes inside `box`, scaled to `height`
 * px tall (width keeps the aspect ratio). Used to compare fonts with the original.
 */
export function letterMask(canvas, box, height = 40) {
  const bw = box.x1 - box.x0; const bh = box.y1 - box.y0;
  if (bw < 2 || bh < 2) return null;
  const bg = sampleRing(canvas, box, 1);
  const fg = textRGB(canvas, box, bg);
  if (!fg) return null;
  const w = Math.max(4, Math.min(1200, Math.round((height * bw) / bh)));
  const c = makeCanvas(w, height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, box.x0, box.y0, bw, bh, 0, 0, w, height);
  const { data } = g.getImageData(0, 0, w, height);
  const mask = new Uint8Array(w * height);
  for (let k = 0; k < w * height; k++) {
    const i = k * 4;
    const dFg = Math.abs(data[i] - fg[0]) + Math.abs(data[i + 1] - fg[1]) + Math.abs(data[i + 2] - fg[2]);
    const dBg = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    mask[k] = dFg < dBg ? 1 : 0;
  }
  return { w, h: height, data: mask };
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
