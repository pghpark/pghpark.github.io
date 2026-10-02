// Canvas helpers: loading photos, removing old text, guessing text colour.

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
    img.onerror = () => reject(new Error('Could not read that image'));
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
    (b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality,
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
