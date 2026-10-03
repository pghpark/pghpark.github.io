// Canvas helpers: loading photos, removing old text, guessing text colour.
import { t } from './i18n.js';

// Largest photo side kept. On a computer, full detail up to 4096 px (an
// iPhone photo is 4032 px; Safari's largest canvas is 4096 × 4096 pixels'
// worth). On a phone, 2400 px: a 4032 px photo at full size peaked at 1.8 GB
// against 1.26 GB, near where iPhone Safari closes the tab. 2400 px is still
// ample for text; reading works on its own smaller copies either way.
const MAX_SIDE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 2400 : 4096;

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

function loadImage(src) {
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
    // Not resized: templates keep the uploaded file itself as the original, untouched.
    // A copy of its bytes: the browser can revoke access to the picked file later.
    if (scale === 1 && /^image\/(jpeg|png|webp)$/.test(file.type)) c.sourceFile = new Blob([await file.arrayBuffer()], { type: file.type });
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
export function eraseText(canvas, box, pad = 3, colors = null) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // `colors` ({ bg, fg }) for text on a panel: the ring around its box can be
  // outside the panel, and the panel itself must not count as text.
  const bg = colors?.bg || sampleRing(canvas, box, pad);
  const fg = colors?.fg || textRGB(canvas, box, bg);
  if (!fg) { eraseBox(canvas, box, pad); return; }
  let grow = Math.min(3, Math.max(1, Math.round((box.y1 - box.y0) * 0.04)));
  const r = clampRect(canvas, box.x0 - pad - grow - 1, box.y0 - pad - grow - 1, box.x1 + pad + grow + 1, box.y1 + pad + grow + 1);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w <= 2 || h <= 2) return;
  const img = ctx.getImageData(r.x0, r.y0, w, h);
  const d = img.data;
  // How far a pixel lies along the blend from the background to the text
  // colour (0 = background, 1 = text), and how far off that blend it is.
  // Letter edges are blends of the two; artwork in other colours is off it.
  const ab = [fg[0] - bg[0], fg[1] - bg[1], fg[2] - bg[2]];
  const ab2 = Math.max(1, ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]);
  const blend = (i) => {
    const p0 = d[i] - bg[0]; const p1 = d[i + 1] - bg[1]; const p2 = d[i + 2] - bg[2];
    const t = (p0 * ab[0] + p1 * ab[1] + p2 * ab[2]) / ab2;
    const off = Math.hypot(p0 - t * ab[0], p1 - t * ab[1], p2 - t * ab[2]) / Math.sqrt(ab2);
    // Strongly toward the text colour, JPEG colour fringes may stray further off.
    return off < (t >= 0.35 ? 0.5 : 0.35) ? t : 0;
  };
  // 1. Text pixels inside the padded box (never the outer 1px frame, which
  //    seeds the fill), including the soft edges of small letters: anything
  //    at least a fifth of the way from background to text colour.
  let mask = new Uint8Array(w * h);
  const bx0 = Math.max(1, Math.floor(box.x0 - pad - r.x0));
  const by0 = Math.max(1, Math.floor(box.y0 - pad - r.y0));
  const bx1 = Math.min(w - 1, Math.ceil(box.x1 + pad - r.x0));
  const by1 = Math.min(h - 1, Math.ceil(box.y1 + pad - r.y0));
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const i = (y * w + x) * 4;
      if (blend(i) > 0.2) mask[y * w + x] = 1;
    }
  }
  // 2. Grow the mask through the faint tint around the letters (still blends,
  //    so neighbouring artwork isn't swallowed; up to 4 px), then one more
  //    pixel all round, so the fill below only borrows clean background.
  grow = Math.max(grow, 4);
  for (let g = 0; g < grow + 1; g++) {
    const next = mask.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const k = y * w + x;
        if (!mask[k] && (mask[k - 1] || mask[k + 1] || mask[k - w] || mask[k + w]) && (g === grow || blend(k * 4) > 0.05)) next[k] = 1;
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
 * How busy the photo is just around a line: the share of neighbouring pixel
 * pairs with a clear brightness step, in a band 0.25 to 0.8 line-heights
 * outside the box (other text boxes in `others` left out). Printed text sits on
 * plain or smoothly shaded ground (about 0 to 0.07); carvings, foliage and
 * ornaments that the reader mistakes for letters sit in clutter (over 0.1).
 */
export function busyAround(canvas, box, others = []) {
  const h = Math.min(box.x1 - box.x0, box.y1 - box.y0);
  const in0 = Math.max(2, 0.25 * h); const out = Math.max(5, 0.8 * h);
  const r = clampRect(canvas, box.x0 - out, box.y0 - out, box.x1 + out, box.y1 + out);
  const w = r.x1 - r.x0; const hh = r.y1 - r.y0;
  if (w < 3 || hh < 3) return 0;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.x0, r.y0, w, hh);
  const lum = (k) => 0.3 * data[k] + 0.59 * data[k + 1] + 0.11 * data[k + 2];
  let steps = 0; let pairs = 0;
  for (let y = 0; y < hh; y++) {
    const ay = r.y0 + y;
    for (let x = 0; x < w - 1; x++) {
      const ax = r.x0 + x;
      if (ax > box.x0 - in0 && ax < box.x1 + in0 && ay > box.y0 - in0 && ay < box.y1 + in0) continue;
      if (others.some((q) => ax >= q.x0 && ax < q.x1 && ay >= q.y0 && ay < q.y1)) continue;
      const k = (y * w + x) * 4;
      pairs++;
      if (Math.abs(lum(k + 4) - lum(k)) > 18) steps++;
    }
  }
  return steps / Math.max(1, pairs);
}

/**
 * How strongly the letters stand out inside a box: the colour distance (sum of
 * R, G and B differences) from the box's median colour that the most distinct
 * 3% of its pixels reach. Printed text reaches 160 or more (red on brown
 * included); a see-through watermark stays under 100.
 */
export function inkContrast(canvas, box) {
  const r = clampRect(canvas, box.x0, box.y0, box.x1, box.y1);
  const w = r.x1 - r.x0; const h = r.y1 - r.y0;
  if (w < 1 || h < 1) return 765;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.x0, r.y0, w, h);
  const n = w * h; const R = new Uint8Array(n); const G = new Uint8Array(n); const B = new Uint8Array(n);
  for (let i = 0, k = 0; i < n; i++, k += 4) { R[i] = data[k]; G[i] = data[k + 1]; B[i] = data[k + 2]; }
  const mid = [median(R), median(G), median(B)];
  const D = new Float32Array(n);
  for (let i = 0; i < n; i++) D[i] = Math.abs(R[i] - mid[0]) + Math.abs(G[i] - mid[1]) + Math.abs(B[i] - mid[2]);
  D.sort();
  return D[Math.floor(n * 0.97)];
}

/**
 * Text printed on a coloured panel (a filled box, badge or band): most of the
 * reading box is one colour that differs clearly from just outside the box,
 * and the letters are another colour standing out from that panel. Plain text
 * on the page fails this, since most of its box is the page colour itself.
 * Returns { fill, text } as [r, g, b], or null.
 */
export function panelUnder(canvas, box) {
  const r = clampRect(canvas, box.x0, box.y0, box.x1, box.y1);
  const w = r.x1 - r.x0; const h = r.y1 - r.y0;
  if (w < 4 || h < 4) return null;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(r.x0, r.y0, w, h);
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  // Most common colour (4 bits per channel), then the average of its pixels.
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const sum = [0, 0, 0]; let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const px = [data[i], data[i + 1], data[i + 2]];
    if (dist(px, [((top >> 8) << 4) + 8, (((top >> 4) & 15) << 4) + 8, ((top & 15) << 4) + 8]) < 48) { sum[0] += px[0]; sum[1] += px[1]; sum[2] += px[2]; n++; }
  }
  if (n < 0.45 * w * h) return null;
  const fill = sum.map((v) => v / n);
  // Compared just outside the box and a little further out (the band beside
  // a line can be the next line's letters).
  const near = sampleRing(canvas, box, Math.max(2, 0.12 * Math.min(w, h)));
  const further = sampleRing(canvas, box, Math.max(4, 0.6 * Math.min(w, h)));
  if (dist(fill, near) < 150 || dist(fill, further) < 150) return null;
  // The letters: the pixels least like the panel.
  const far = [];
  for (let i = 0; i < data.length; i += 4) far.push([dist([data[i], data[i + 1], data[i + 2]], fill), i]);
  far.sort((a, b) => b[0] - a[0]);
  const pick = far.slice(0, Math.max(4, Math.round(far.length * 0.08)));
  const text = [0, 1, 2].map((c) => pick.reduce((t, [, i]) => t + data[i + c], 0) / pick.length);
  if (dist(text, fill) < 150) return null;
  return { fill: fill.map(Math.round), text: text.map(Math.round) };
}

/**
 * QR codes, found by their three corner squares ("finder patterns"): along a
 * row and a column through each, dark-light-dark-light-dark runs in the ratio
 * 1:1:3:1:1. Three of similar size forming a right angle are one code.
 * Returns boxes { x0, y0, x1, y1 } (including the quiet margin) in canvas pixels.
 */
export function findQRCodes(canvas) {
  const W = canvas.width; const H = canvas.height;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  // Grey levels and Otsu's threshold.
  const grey = new Uint8Array(W * H); const hist = new Array(256).fill(0);
  for (let k = 0; k < W * H; k++) { const v = (data[k * 4] * 299 + data[k * 4 + 1] * 587 + data[k * 4 + 2] * 114) / 1000 | 0; grey[k] = v; hist[v]++; }
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0; let wB = 0; let best = 0; let thr = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue; const wF = W * H - wB; if (!wF) break;
    sumB += v * hist[v]; const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) { best = between; thr = v; }
  }
  const dark = (x, y) => grey[y * W + x] <= thr;
  const ratioOK = (r) => {
    const total = r.reduce((a, b) => a + b, 0); if (total < 7) return false;
    const m = total / 7; const tol = m * 0.6;
    return Math.abs(r[0] - m) < tol && Math.abs(r[1] - m) < tol && Math.abs(r[2] - 3 * m) < 3 * tol && Math.abs(r[3] - m) < tol && Math.abs(r[4] - m) < tol;
  };
  // Runs along a line through (x, y), centred on the dark run there.
  const runsAt = (x, y, dx, dy) => {
    const inside = (a, b) => a >= 0 && b >= 0 && a < W && b < H;
    if (!dark(x, y)) return null;
    let sgn = 1; const r = [0, 0, 0, 0, 0];
    const count = (sx, sy, want, max) => { let n = 0; while (inside(sx, sy) && dark(sx, sy) === want && n < max) { n++; sx += dx * sgn; sy += dy * sgn; } return [n, sx, sy]; };
    // centre run both ways
    let a = 0; let px = x; let py = y; while (inside(px, py) && dark(px, py)) { a++; px -= dx; py -= dy; }
    let b = 0; let qx = x + dx; let qy = y + dy; while (inside(qx, qy) && dark(qx, qy)) { b++; qx += dx; qy += dy; }
    r[2] = a + b;
    sgn = -1; let [n1, ax, ay] = count(px, py, false, r[2] * 2); r[1] = n1; [n1, ax, ay] = count(ax, ay, true, r[2] * 2); r[0] = n1;
    sgn = 1; let [n2, bx, by] = count(qx, qy, false, r[2] * 2); r[3] = n2; [n2, bx, by] = count(bx, by, true, r[2] * 2); r[4] = n2;
    return ratioOK(r) ? { r, start: -(a - 1) - r[1] - r[0], end: b + r[3] + r[4] } : null;
  };
  const found = [];
  for (let y = 0; y < H; y += 2) {
    let x = 0;
    while (x < W) {
      // Collect five runs starting with a dark one.
      if (!dark(x, y)) { x++; continue; }
      const r = []; let p = x; let col = true;
      while (r.length < 5 && p < W) { let n = 0; while (p < W && dark(p, y) === col) { n++; p++; } r.push(n); col = !col; }
      if (r.length === 5 && ratioOK(r)) {
        const cx = x + r[0] + r[1] + (r[2] >> 1);
        const v = runsAt(cx, y, 0, 1);
        if (v) {
          const cy = y + (v.start + v.end) / 2;
          const h = runsAt(cx, Math.round(cy), 1, 0);
          if (h) {
            const ccx = cx + (h.start + h.end) / 2;
            const module = (r.reduce((a2, b2) => a2 + b2, 0) + v.r.reduce((a2, b2) => a2 + b2, 0)) / 14;
            const near = found.find((f) => Math.hypot(f.x - ccx, f.y - cy) < 2 * Math.max(f.m, module));
            if (near) { near.n++; near.x += (ccx - near.x) / near.n; near.y += (cy - near.y) / near.n; }
            else found.push({ x: ccx, y: cy, m: module, n: 1 });
          }
        }
      }
      x += r[0] || 1;
    }
  }
  const finders = found.filter((f) => f.n >= 2);
  const codes = [];
  const used = new Set();
  for (let i = 0; i < finders.length; i++) {
    for (let j = 0; j < finders.length; j++) {
      for (let k = j + 1; k < finders.length; k++) {
        if (i === j || i === k || used.has(i) || used.has(j) || used.has(k)) continue;
        const A = finders[i]; const B = finders[j]; const C = finders[k];
        const ms = [A.m, B.m, C.m]; if (Math.max(...ms) / Math.min(...ms) > 1.6) continue;
        const ab = Math.hypot(B.x - A.x, B.y - A.y); const ac = Math.hypot(C.x - A.x, C.y - A.y); const bc = Math.hypot(C.x - B.x, C.y - B.y);
        // A is the corner: AB ≈ AC, BC ≈ AB·√2, and the code is 21 to about
        // 77 modules (version 1 to 15; corner centres are 14 to 70 modules
        // apart). Dense lettering (回, 口) can look like corner squares, but
        // seldom at a QR code's proportions.
        const mods = ab / ((A.m + B.m + C.m) / 3);
        if (Math.abs(ab - ac) > 0.2 * ab || Math.abs(bc - ab * Math.SQRT2) > 0.2 * bc || mods < 12 || mods > 72) continue;
        const D = { x: B.x + C.x - A.x, y: B.y + C.y - A.y };
        // Inside, a QR code is about half dark modules; lines of text are much sparser.
        {
          const qx0 = Math.round(Math.min(A.x, B.x, C.x, D.x)); const qx1 = Math.round(Math.max(A.x, B.x, C.x, D.x));
          const qy0 = Math.round(Math.min(A.y, B.y, C.y, D.y)); const qy1 = Math.round(Math.max(A.y, B.y, C.y, D.y));
          let darkN = 0; let n = 0;
          for (let y = Math.max(0, qy0); y < Math.min(H, qy1); y += 2) for (let x = Math.max(0, qx0); x < Math.min(W, qx1); x += 2) { n++; if (dark(x, y)) darkN++; }
          if (!n || darkN / n < 0.3 || darkN / n > 0.75) continue;
        }
        const xs = [A.x, B.x, C.x, D.x]; const ys = [A.y, B.y, C.y, D.y];
        const pad = 4.5 * A.m; // half a finder (3.5 modules) plus a module of margin
        codes.push({
          x0: Math.max(0, Math.floor(Math.min(...xs) - pad)), y0: Math.max(0, Math.floor(Math.min(...ys) - pad)),
          x1: Math.min(W, Math.ceil(Math.max(...xs) + pad)), y1: Math.min(H, Math.ceil(Math.max(...ys) + pad)),
        });
        used.add(i); used.add(j); used.add(k);
      }
    }
  }
  return codes;
}

/**
 * The graphic part of a logo (its emblem) next to the logo's lettering:
 * shapes that stand out from the page within about one lettering-height of
 * `group` (the lettering's box), outside every text box. Returns its box or null.
 */
export function logoMark(canvas, group, textBoxes) {
  const H = Math.max(8, group.y1 - group.y0);
  const win = clampRect(canvas, group.x0 - 1.6 * H, group.y0 - 0.6 * H, group.x1 + 1.6 * H, group.y1 + 0.6 * H);
  const w = win.x1 - win.x0; const h = win.y1 - win.y0;
  if (w < 4 || h < 4) return null;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(win.x0, win.y0, w, h);
  const page = sampleRing(canvas, { x0: win.x0 + 3, y0: win.y0 + 3, x1: win.x1 - 3, y1: win.y1 - 3 }, 0);
  const inText = (x, y) => textBoxes.some((b) => x >= b.x0 - 2 && x <= b.x1 + 2 && y >= b.y0 - 2 && y <= b.y1 + 2);
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(data[i] - page[0]) + Math.abs(data[i + 1] - page[1]) + Math.abs(data[i + 2] - page[2]) > 60 && !inText(win.x0 + x, win.y0 + y)) ink[y * w + x] = 1;
    }
  }
  // Connected shapes; keep those near the lettering and not cut by the window edge.
  const seen = new Uint8Array(w * h);
  let box = null;
  for (let s0 = 0; s0 < w * h; s0++) {
    if (!ink[s0] || seen[s0]) continue;
    const stack = [s0]; seen[s0] = 1; let n = 0; let x0 = w; let y0 = h; let x1 = 0; let y1 = 0;
    while (stack.length) {
      const k = stack.pop(); n++;
      const x = k % w; const y = (k - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const nk of [k - 1, k + 1, k - w, k + w]) {
        if (nk < 0 || nk >= w * h || seen[nk] || !ink[nk] || (Math.abs((nk % w) - x) > 1)) continue;
        seen[nk] = 1; stack.push(nk);
      }
    }
    if (n < 0.02 * H * H) continue;
    if (x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1) continue;
    const b = { x0: win.x0 + x0, y0: win.y0 + y0, x1: win.x0 + x1 + 1, y1: win.y0 + y1 + 1 };
    const gap = Math.max(b.x0 - group.x1, group.x0 - b.x1, b.y0 - group.y1, group.y0 - b.y1);
    if (gap > 1.0 * H) continue;
    box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : b;
  }
  if (!box || (box.x1 - box.x0) * (box.y1 - box.y0) < 0.15 * H * H) return null;
  return box;
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
  let chosen = best(strokes(stops)) || best(stops) || best(strokes(cands));
  // On a gradient panel (gold, light in the middle and darker at the ends) the
  // panel's own highlight stands out most from the ends. A shade of the
  // surroundings' own hue loses to a stroke colour of a clearly different hue
  // that is more stroke-like (red calligraphy on gold).
  const hsv = (c) => {
    const mx = Math.max(...c); const mn = Math.min(...c); const d = mx - mn;
    const hue = !d ? 0 : mx === c[0] ? ((c[1] - c[2]) / d + 6) % 6 : mx === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
    return { h: hue * 60, s: mx ? d / mx : 0, v: mx / 255 };
  };
  const hueGap = (a, b) => { const d = Math.abs(hsv(a).h - hsv(b).h) % 360; return Math.min(d, 360 - d); };
  const shade = (c) => hsv(around).s > 0.25 && hsv(c).s > 0.12 && hueGap(c, around) < 10;
  const distinct = (c) => (hsv(c).s > 0.12 && hueGap(c, around) > 15) || hsv(c).v < 0.25;
  if (chosen && shade(chosen.c)) {
    const e = edgeShare(chosen.c);
    const alt = best(strokes(cands).filter((x) => x !== chosen && distinct(x.c)
      && (edgeShare(x.c) >= e + 0.15 || 1 - edgeShare(x.c) <= 0.5 * (1 - e)))); // thin lines: nearly every pixel is an edge
    if (alt) chosen = alt;
  }
  const pick = chosen?.c;
  if (!pick) return estimateTextColor(canvas, box);
  // Refine: the stroke cores, i.e. the members of that cluster least like the
  // surroundings (edge pixels are blends).
  const members = inside.filter((p) => dist(p, pick) < T).sort((a, b) => dist(b, around) - dist(a, around));
  const core = members.slice(0, Math.max(1, Math.ceil(members.length * 0.4)));
  return toHex([0, 1, 2].map((k) => core.reduce((n, p) => n + p[k], 0) / core.length));
}

/** Guess the text colour: pixels inside the box that differ most from the background. */
function estimateTextColor(canvas, box) {
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
