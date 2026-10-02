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
 * For a vertical line the same is done with rows and columns swapped.
 * `color` (#rrggbb) gives the text colour when it is already known; `cjk`
 * says the line is mostly Chinese characters.
 */
export function inkBounds(canvas, box, { vertical = false, color = null, cjk = true } = {}) {
  const r = clampRect(canvas, box.x0, box.y0, box.x1, box.y1);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w < 3 || h < 3) return box;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.x0, r.y0, w, h);
  const d = (i, c) => Math.abs(data[i] - c[0]) + Math.abs(data[i + 1] - c[1]) + Math.abs(data[i + 2] - c[2]);
  // Background: either just outside the box, or its own edge (a detection box
  // is padded, so its edge is background too). Text often sits on a panel of
  // its own colour, where the outside is something else; take whichever colour
  // covers more of the box.
  const frame = [];
  for (let x = 0; x < w; x++) for (const y of [0, 1, h - 2, h - 1]) frame.push((y * w + x) * 4);
  for (let y = 2; y < h - 2; y++) for (const x of [0, 1, w - 2, w - 1]) frame.push((y * w + x) * 4);
  const med = (k) => { const v = frame.map((i) => data[i + k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const candidates = [sampleRing(canvas, box, 1), [med(0), med(1), med(2)]];
  const cover = (c) => { let n = 0; for (let i = 0; i < data.length; i += 16) if (d(i, c) <= 40) n++; return n; };
  const bg = cover(candidates[1]) > cover(candidates[0]) ? candidates[1] : candidates[0];
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
  // The line's colour: the colour inside the box that stops at its ends, so
  // artwork behind or around the text (which carries on) isn't taken for it.
  const hex = color || textColorByContrast(canvas, box, vertical);
  const fg = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
  // A pixel is ink if it is close to the line's colour (and nearer it than the
  // background's): over a drawing, being "unlike the background" isn't enough.
  const near = Math.max(50, Math.min(120, 0.4 * (Math.abs(fg[0] - bg[0]) + Math.abs(fg[1] - bg[1]) + Math.abs(fg[2] - bg[2]))));
  const isInk = (i) => d(i, fg) < near && d(i, fg) < d(i, bg) && d(i, bg) > 40;
  const across = new Uint32Array(A);
  const along = new Uint32Array(B);
  // Columns that are ink nearly all the way across the box, touching both of
  // its (padded) edges, are a bar, tag or frame beside the text, not letters:
  // leave them out of the row counts.
  const solid = new Uint8Array(B);
  for (let b = 0; b < B; b++) { let n = 0; for (let a = 0; a < A; a++) if (isInk(at(a, b))) n++; solid[b] = n >= 0.8 * A && isInk(at(0, b)) && isInk(at(A - 1, b)) ? 1 : 0; }
  for (let a = 0; a < A; a++) {
    for (let b = 0; b < B; b++) if (!solid[b] && isInk(at(a, b))) across[a]++;
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
  // Hit (nearly) the whole box: neighbouring lines or artwork in the padding
  // kept every row "non-empty". Look for the dips between this line and them:
  // rows well below the line's typical density, a few in a row. Only for
  // Chinese text: its characters have dense, flat tops and bottoms, whereas
  // digits and Latin letters taper (a dip there is the end of a letter).
  if (cjk && a1 - a0 + 1 >= 0.75 * A) {
    const core = Array.from(across.slice(Math.floor(A * 0.35), Math.ceil(A * 0.65))).sort((p, q) => p - q);
    const typical = core[core.length >> 1] || 0;
    const low = (k) => across[k] < 0.25 * typical;
    const dip = (k, dir) => { for (let j = 0; j < 2; j++) { const q = k + dir * j; if (q < 0 || q >= A || !low(q)) return false; } return true; };
    let b0 = mid; let b1 = mid;
    while (b0 > 0 && !dip(b0 - 1, -1)) b0--;
    while (b1 < A - 1 && !dip(b1 + 1, 1)) b1++;
    if (typical > 0 && b1 - b0 + 1 >= 0.25 * A) { a0 = Math.max(a0, b0); a1 = Math.min(a1, b1); }
  }
  // The strict ink test stops at the stroke centres; the font sizing compares
  // with full glyph outlines. Take back the blurred edge row on each side.
  {
    const loose = (a) => { let n = 0; for (let b = 0; b < B; b++) { const i = at(a, b); if (!solid[b] && d(i, fg) < d(i, bg) && d(i, bg) > 40) n++; } return n; };
    if (a0 > 0 && loose(a0 - 1) > empty) a0--;
    if (a1 < A - 1 && loose(a1 + 1) > empty) a1++;
  }
  let ink = 0;
  for (let a = a0; a <= a1; a++) {
    for (let b = 0; b < B; b++) {
      if (solid[b]) continue;
      const i = at(a, b);
      if (isInk(i)) along[b]++;
      // Stroke coverage (for bold or regular) counts blurred stroke edges too,
      // as the rendered fonts it is compared with do.
      if (d(i, fg) < d(i, bg) && d(i, bg) > 40) ink++;
    }
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
 * How far the plain colour just around a line of text extends. Flood-fills
 * that colour (seeded on a ring 0.3 line-heights out) within a window of six
 * line heights. Returns {bounded, ratio, offset}: bounded if the fill never
 * reaches the window's edge (a sign, a banner, a sheet of paper); the filled
 * area as a multiple of the text's own box; and how different the patch's
 * colour is from what lies just outside it.
 */
export function plainPatch(canvas, ink) {
  const W = canvas.width; const H = canvas.height;
  const h = Math.max(4, Math.min(ink.y1 - ink.y0, ink.x1 - ink.x0));
  const near = sampleRing(canvas, ink, 0.3 * h);
  const R = 6 * h;
  const wx0 = Math.max(0, Math.floor(ink.x0 - R)); const wy0 = Math.max(0, Math.floor(ink.y0 - R));
  const ww = Math.min(W, Math.ceil(ink.x1 + R)) - wx0; const wh = Math.min(H, Math.ceil(ink.y1 + R)) - wy0;
  if (ww < 3 || wh < 3) return { bounded: false, ratio: Infinity };
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(wx0, wy0, ww, wh);
  const plain = (k) => Math.abs(data[k * 4] - near[0]) + Math.abs(data[k * 4 + 1] - near[1]) + Math.abs(data[k * 4 + 2] - near[2]) < 45;
  const seen = new Uint8Array(ww * wh); const stack = [];
  const seed = (x, y) => { const k = (y - wy0) * ww + (x - wx0); if (k >= 0 && k < ww * wh && !seen[k] && plain(k)) { seen[k] = 1; stack.push(k); } };
  const rx0 = Math.max(wx0, Math.floor(ink.x0 - 0.3 * h)); const ry0 = Math.max(wy0, Math.floor(ink.y0 - 0.3 * h));
  const rx1 = Math.min(wx0 + ww - 1, Math.ceil(ink.x1 + 0.3 * h)); const ry1 = Math.min(wy0 + wh - 1, Math.ceil(ink.y1 + 0.3 * h));
  for (let x = rx0; x <= rx1; x++) { seed(x, ry0); seed(x, ry1); }
  for (let y = ry0; y <= ry1; y++) { seed(rx0, y); seed(rx1, y); }
  let area = 0; let bounded = true;
  let fx0 = ink.x0; let fy0 = ink.y0; let fx1 = ink.x1; let fy1 = ink.y1;
  while (stack.length) {
    const k = stack.pop(); area++;
    const x = k % ww; const y = (k - x) / ww;
    if (wx0 + x < fx0) fx0 = wx0 + x; if (wx0 + x + 1 > fx1) fx1 = wx0 + x + 1;
    if (wy0 + y < fy0) fy0 = wy0 + y; if (wy0 + y + 1 > fy1) fy1 = wy0 + y + 1;
    if (x === 0 || y === 0 || x === ww - 1 || y === wh - 1) bounded = false;
    if (x > 0 && !seen[k - 1] && plain(k - 1)) { seen[k - 1] = 1; stack.push(k - 1); }
    if (x < ww - 1 && !seen[k + 1] && plain(k + 1)) { seen[k + 1] = 1; stack.push(k + 1); }
    if (y > 0 && !seen[k - ww] && plain(k - ww)) { seen[k - ww] = 1; stack.push(k - ww); }
    if (y < wh - 1 && !seen[k + ww] && plain(k + ww)) { seen[k + ww] = 1; stack.push(k + ww); }
  }
  // Colour just outside the patch, to compare the patch with its surroundings.
  const outside = sampleRing(canvas, { x0: fx0, y0: fy0, x1: fx1, y1: fy1 }, 2);
  const offset = Math.abs(near[0] - outside[0]) + Math.abs(near[1] - outside[1]) + Math.abs(near[2] - outside[2]);
  return { bounded, ratio: area / Math.max(1, (ink.x1 - ink.x0) * (ink.y1 - ink.y0)), offset };
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
  c.width = 0; c.height = 0; // give its memory back now (Safari otherwise frees it late)
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

/**
 * Text colour by elimination: cluster the colours inside the line's box, and
 * prefer the cluster that is common inside but rare just beyond the line's two
 * ends. Background and artwork (a drawing behind the text) carry on past the
 * ends; the lettering stops. Falls back to estimateTextColor.
 */
export function textColorByContrast(canvas, box, vertical = false) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const r = clampRect(canvas, box.x0, box.y0, box.x1, box.y1);
  const w = r.x1 - r.x0; const h = r.y1 - r.y0;
  if (w < 3 || h < 3) return estimateTextColor(canvas, box);
  const read = (x0, y0, x1, y1) => {
    const q = clampRect(canvas, x0, y0, x1, y1);
    if (q.x1 - q.x0 < 1 || q.y1 - q.y0 < 1) return [];
    const d = g.getImageData(q.x0, q.y0, q.x1 - q.x0, q.y1 - q.y0).data; const out = [];
    for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]]);
    return out;
  };
  const inside = read(r.x0, r.y0, r.x1, r.y1);
  const t = vertical ? w : h; // line thickness
  const ends = vertical
    ? [...read(r.x0, r.y0 - 1.2 * t, r.x1, r.y0 - 0.2 * t), ...read(r.x0, r.y1 + 0.2 * t, r.x1, r.y1 + 1.2 * t)]
    : [...read(r.x0 - 1.2 * t, r.y0, r.x0 - 0.2 * t, r.y1), ...read(r.x1 + 0.2 * t, r.y0, r.x1 + 1.2 * t, r.y1)];
  if (ends.length < 20) return estimateTextColor(canvas, box);
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  // k-means (k = 6) on the inside colours.
  const sorted = [...inside].sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
  // Seeds: the median colour, then repeatedly the colour farthest from all
  // seeds so far, so similar-brightness colours (yellow text on tan) separate.
  let centres = [sorted[sorted.length >> 1]];
  const sample = inside.filter((_, i) => i % 3 === 0);
  while (centres.length < 6) {
    let far = null; let farD = -1;
    for (const p of sample) { const dd = Math.min(...centres.map((c) => dist(p, c))); if (dd > farD) { farD = dd; far = p; } }
    if (!far || farD < 30) break;
    centres.push(far);
  }
  for (let it = 0; it < 6; it++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (const p of inside) {
      let best = 0; for (let k = 1; k < centres.length; k++) if (dist(p, centres[k]) < dist(p, centres[best])) best = k;
      sums[best][0] += p[0]; sums[best][1] += p[1]; sums[best][2] += p[2]; sums[best][3]++;
    }
    centres = sums.map((sm, k) => (sm[3] ? [sm[0] / sm[3], sm[1] / sm[3], sm[2] / sm[3]] : centres[k]));
  }
  const T = 60;
  const med = (arr, k) => { const v = arr.map((p) => p[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const around = [0, 1, 2].map((k) => med(ends, k));
  // Of the colours that stop at the line's ends, the one most unlike the
  // surroundings is the solid stroke colour (the others are blends at its edges).
  // Letter strokes are thin: most of their pixels lie on an edge. A panel or
  // patch behind the text is solid. Share of a colour's pixels on its edge:
  const edgeShare = (c) => {
    let n = 0; let edge = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (dist(inside[y * w + x], c) >= T) continue;
      n++;
      const out = (xx, yy) => xx < 0 || yy < 0 || xx >= w || yy >= h || dist(inside[yy * w + xx], c) >= T;
      if (out(x - 1, y) || out(x + 1, y) || out(x, y - 1) || out(x, y + 1)) edge++;
    }
    return n ? edge / n : 0;
  };
  // Candidates: common enough inside, and never the surroundings' own colour.
  const cands = centres
    .map((c) => ({ c, sIn: inside.filter((p) => dist(p, c) < T).length / inside.length, sOut: ends.filter((p) => dist(p, c) < T).length / ends.length, score: dist(c, around) }))
    .filter((x) => x.sIn >= 0.04 && x.score >= 60);
  const best = (list) => list.reduce((m, x) => (!m || x.score > m.score ? x : m), null);
  const stops = cands.filter((x) => x.sOut <= 0.5 * x.sIn);
  // Thicker strokes in bigger text, so a lower edge share is still a stroke.
  const strokes = (list) => list.filter((x) => edgeShare(x.c) >= Math.min(0.35, 6 / t));
  // Prefer a stroke colour that stops at the ends; then any colour that stops;
  // then (an end lies on artwork of the text's colour, or off the photo) the
  // most distinct stroke colour.
  const pick = (best(strokes(stops)) || best(stops) || best(strokes(cands)))?.c;
  if (!pick) return estimateTextColor(canvas, box);
  // Refine: the stroke cores, i.e. the members of that cluster least like the
  // surroundings (edge pixels are blends).
  const members = inside.filter((p) => dist(p, pick) < T).sort((a, b) => dist(b, around) - dist(a, around));
  const core = members.slice(0, Math.max(1, Math.ceil(members.length * 0.4)));
  return toHex([0, 1, 2].map((k) => core.reduce((n, p) => n + p[k], 0) / core.length));
}

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
