import { detectText } from './ocr.js';
import { t, applyI18n, setLang, getLang, LANGS } from './i18n.js';
import {
  fileToCanvas, urlToCanvas, cloneCanvas, eraseText, canvasToBlob, inkBounds, letterMask, sampleRing, textColorByContrast, plainPatch,
} from './imaging.js';
import {
  FONTS, DEFAULT_FAMILY, MATCH_FAMILIES, ensureFontsLoaded, normalizeWeight, weightsOf, isBold, loadFontCss,
} from './fonts.js';
import {
  exportRaster, exportSVG, exportPDF, exportPSD, exportPPTX, download, safeFilename, isText,
} from './export.js';
import {
  LocalStore, CloudStore, cloudConfigured, getSupabase, recordToFile, fileToRecord,
} from './storage.js';

// Custom properties saved with each text object.
const EXTRA_PROPS = ['vertical', 'ocr', 'fitBox', 'autoFit', 'eraseBox'];
const $ = (sel) => document.querySelector(sel);

const state = {
  id: null,
  name: '',
  original: null, // untouched photo (canvas)
  clean: null, // photo with old text painted out (canvas) — the template background
  bgDirty: false,
  origDirty: false,
  dirty: false,
  home: null, // key of the store this template was last saved to
  tool: 'select',
  zoom: 'fit',
  eraseUndo: [],
  stores: { local: new LocalStore(), cloud: null },
  user: null,
};

const canvas = new fabric.Canvas('c', {
  preserveObjectStacking: true,
  // The canvas is already the photo's size (up to 2400 px), more pixels than
  // a phone screen shows. Multiplying it by the screen density (3× on iPhone)
  // made a 7200×5400 surface: over Safari's canvas limit and enough memory to
  // get the tab closed.
  enableRetinaScaling: false,
  backgroundColor: '#ffffff',
  width: 800,
  height: 600,
});
fabric.InteractiveFabricObject.ownDefaults.cornerColor = '#2563eb';
fabric.InteractiveFabricObject.ownDefaults.borderColor = '#2563eb';
fabric.InteractiveFabricObject.ownDefaults.transparentCorners = false;
fabric.InteractiveFabricObject.ownDefaults.cornerSize = 10;

/* ---------------- UI helpers ---------------- */

let toastTimer;
function toast(msg, kind = 'info', ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function setBusy(label, progress) {
  const box = $('#busy');
  if (!label) { box.hidden = true; return; }
  box.hidden = false;
  $('#busyLabel').textContent = label;
  const bar = $('#busyBar');
  if (progress == null) bar.removeAttribute('value');
  else bar.value = progress;
}

async function withBusy(label, fn) {
  setBusy(label);
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'error', 6000);
    return undefined;
  } finally {
    setBusy(null);
  }
}

function markDirty() {
  state.dirty = true;
  updateTitle();
}

function updateTitle() {
  document.title = `${state.dirty ? '• ' : ''}${state.name || t('untitled')} — ${t('appName')}`;
}

const hasDoc = () => Boolean(state.clean);

function refreshEnabled() {
  const on = hasDoc();
  document.querySelectorAll('[data-needs-doc]').forEach((el) => el.toggleAttribute('disabled', !on));
  $('#emptyState').hidden = on;
  $('#canvasWrap').hidden = !on;
  $('#detectBtn').disabled = !state.original;
  $('#compareBtn').hidden = !state.original;
  $('#undoEraseBtn').disabled = !state.eraseUndo.length;
}

/* ---------------- Canvas / zoom ---------------- */

function setBackground(el) {
  const img = new fabric.FabricImage(el, {
    originX: 'left', originY: 'top', left: 0, top: 0, objectCaching: false,
  });
  canvas.backgroundImage = img;
  canvas.requestRenderAll();
}

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 6;

function applyZoom() {
  if (!hasDoc()) return;
  const W = canvas.getWidth();
  const H = canvas.getHeight();
  let z = Number(state.zoom);
  if (state.zoom === 'fit') {
    const stage = $('#stage');
    z = Math.min(1, (stage.clientWidth - 32) / W, (stage.clientHeight - 32) / H);
  }
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  canvas.setDimensions({ width: `${W * z}px`, height: `${H * z}px` }, { cssOnly: true });
  canvas.calcOffset();
  syncZoomSelect(z);
  positionQuickEdit();
}

const currentZoom = () => canvas.upperCanvasEl.getBoundingClientRect().width / canvas.getWidth();

/** Show free zoom levels (from pinching) in the Zoom menu as e.g. "135%". */
function syncZoomSelect(z) {
  const sel = $('#zoom');
  let custom = sel.querySelector('option[data-custom]');
  if (state.zoom === 'fit' || [...sel.options].some((o) => !o.dataset.custom && o.value === String(state.zoom))) {
    custom?.remove();
    sel.value = String(state.zoom);
    return;
  }
  if (!custom) {
    custom = new Option('', '');
    custom.dataset.custom = '1';
    sel.append(custom);
  }
  custom.value = String(state.zoom);
  custom.textContent = `${Math.round(z * 100)}%`;
  sel.value = custom.value;
}

/** Zoom to z while keeping the point under (clientX, clientY) in place. */
function zoomAround(z, clientX, clientY) {
  const stage = $('#stage');
  const before = $('#canvasWrap').getBoundingClientRect();
  const fx = (clientX - before.left) / before.width;
  const fy = (clientY - before.top) / before.height;
  state.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  applyZoom();
  const after = $('#canvasWrap').getBoundingClientRect();
  stage.scrollLeft += after.left + fx * after.width - clientX;
  stage.scrollTop += after.top + fy * after.height - clientY;
}

// Two-finger pinch zooms and pans the photo; one finger still edits.
// While two fingers are down, their pointer events are kept from Fabric so a
// pinch doesn't also drag a text box; the final pointerup is let through so
// Fabric finishes cleanly.
(() => {
  const stage = $('#stage');
  const touches = new Set();
  let pinch = null;
  const pts = (e) => [...e.touches].slice(0, 2).map((t) => ({ x: t.clientX, y: t.clientY }));
  const dist = ([a, b]) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = ([a, b]) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && stage.contains(e.target)) touches.add(e.pointerId); }, true);
  const release = (e) => {
    if (e.pointerType !== 'touch') return;
    touches.delete(e.pointerId);
    if (pinch && touches.size) e.stopPropagation();
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('pointermove', (e) => { if (pinch && e.pointerType === 'touch') e.stopPropagation(); }, true);
  window.addEventListener('pointerdown', (e) => { if (pinch && e.pointerType === 'touch') e.stopPropagation(); }, true);
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || !hasDoc()) return;
    e.preventDefault();
    const p = pts(e);
    pinch = { z0: currentZoom(), d0: dist(p), m: mid(p) };
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  }, { passive: false, capture: true });
  stage.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length < 2) return;
    e.preventDefault();
    const p = pts(e);
    const m = mid(p);
    stage.scrollLeft -= m.x - pinch.m.x;
    stage.scrollTop -= m.y - pinch.m.y;
    pinch.m = m;
    zoomAround(pinch.z0 * (dist(p) / pinch.d0), m.x, m.y);
  }, { passive: false, capture: true });
  stage.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; }, { capture: true });
  stage.addEventListener('touchcancel', () => { pinch = null; }, { capture: true });
  // Trackpad pinch (sent as ctrl+wheel) and Ctrl/⌘ + mouse wheel.
  stage.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !hasDoc()) return;
    e.preventDefault();
    zoomAround(currentZoom() * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
  }, { passive: false });
})();

// One finger on the photo's empty area moves the view, like scrolling a
// picture (it used to draw a selection box). On a text box it still selects
// and drags it; a short tap on the empty area still clears the selection.
(() => {
  const stage = $('#stage');
  let pan = null;
  const onText = (e) => {
    const pt = canvas.getScenePoint(e);
    const act = canvas.getActiveObject();
    if (act) {
      const r = act.getBoundingRect(); const pad = 24 / currentZoom(); // its handles too
      if (pt.x >= r.left - pad && pt.x <= r.left + r.width + pad && pt.y >= r.top - pad && pt.y <= r.top + r.height + pad) return true;
    }
    return canvas.getObjects().some((o) => o.visible && o.evented !== false && o.containsPoint(pt));
  };
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || state.tool !== 'select' || !hasDoc() || e.target !== canvas.upperCanvasEl || onText(e)) return;
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    e.stopPropagation();
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    e.stopPropagation();
    const dx = e.clientX - pan.x; const dy = e.clientY - pan.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) pan.moved = true;
    // Scroll the photo area first; whatever it can't take scrolls the page.
    const sl = stage.scrollLeft; const st = stage.scrollTop;
    stage.scrollLeft -= dx; stage.scrollTop -= dy;
    window.scrollBy(-(dx + (stage.scrollLeft - sl)), -(dy + (stage.scrollTop - st)));
    pan.x = e.clientX; pan.y = e.clientY;
  }, true);
  const end = (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    e.stopPropagation();
    if (!pan.moved) { canvas.discardActiveObject(); canvas.requestRenderAll(); }
    pan = null;
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  stage.addEventListener('touchstart', (e) => { if (e.touches.length > 1) pan = null; }, { capture: true }); // a pinch takes over
})();
new ResizeObserver(() => state.zoom === 'fit' && applyZoom()).observe($('#stage'));

function resetCanvas(w, h) {
  canvas.discardActiveObject();
  canvas.remove(...canvas.getObjects());
  canvas.setDimensions({ width: w, height: h });
  state.eraseUndo = [];
  setTool('select');
}

/* ---------------- History (text objects only) ---------------- */

const history = { stack: [], index: -1, paused: false };

function serializeObjects() {
  return canvas.getObjects().filter((o) => !o.temp).map((o) => o.toObject(EXTRA_PROPS));
}

function resetHistory() {
  history.stack = [JSON.stringify(serializeObjects())];
  history.index = 0;
}

function pushHistory() {
  if (history.paused) return;
  const snap = JSON.stringify(serializeObjects());
  if (snap === history.stack[history.index]) return;
  history.stack = history.stack.slice(0, history.index + 1);
  history.stack.push(snap);
  if (history.stack.length > 80) history.stack.shift();
  history.index = history.stack.length - 1;
  markDirty();
}

async function restoreObjects(objects) {
  history.paused = true;
  canvas.discardActiveObject();
  canvas.remove(...canvas.getObjects());
  const objs = await fabric.util.enlivenObjects(objects);
  await ensureFontsLoaded(objs);
  canvas.add(...objs);
  canvas.requestRenderAll();
  history.paused = false;
  renderLayers();
  renderProps();
}

async function undo() {
  if (history.index <= 0) return;
  history.index--;
  await restoreObjects(JSON.parse(history.stack[history.index]));
  markDirty();
}

async function redo() {
  if (history.index >= history.stack.length - 1) return;
  history.index++;
  await restoreObjects(JSON.parse(history.stack[history.index]));
  markDirty();
}

let textChangeTimer;
canvas.on('object:added', () => { pushHistory(); renderLayers(); });
canvas.on('object:removed', () => { pushHistory(); renderLayers(); });
canvas.on('object:modified', (e) => {
  // Moving or resizing a box by hand means the user is placing it themselves.
  e.target?.set('autoFit', false);
  pushHistory();
  renderProps();
});
canvas.on('text:changed', (e) => {
  ensureFontsLoaded([e.target]).then(() => { refitIfAuto(e.target); canvas.requestRenderAll(); });
  clearTimeout(textChangeTimer);
  textChangeTimer = setTimeout(() => { pushHistory(); renderLayers(); renderProps(); }, 400);
});
canvas.on('selection:created', () => { renderProps(); renderLayers(); });
canvas.on('selection:updated', () => { renderProps(); renderLayers(); });
canvas.on('selection:cleared', () => { renderProps(); renderLayers(); });

/* ---------------- Text objects ---------------- */

function newText(text, opts = {}) {
  return new fabric.IText(text, {
    originX: 'left',
    originY: 'top',
    fontFamily: DEFAULT_FAMILY,
    fontWeight: 400,
    fontSize: 48,
    fill: '#111111',
    lineHeight: 1.0,
    vertical: false,
    ocr: false,
    ...opts,
  });
}

const toVertical = (text) => [...text.replace(/\s+/g, '')].join('\n');
const fromVertical = (text) => text.replace(/\n/g, '');

// Fabric draws a one-line text's baseline this far below the box top, as a
// fraction of the font size: line height 1.13 × (1 − 0.222). See Fabric's
// Text._renderTextCommon / _renderChars (_fontSizeMult, _fontSizeFraction).
const BASELINE = 1.13 * (1 - 0.222);
const measureCtx = document.createElement('canvas').getContext('2d');

/** Ink box of `text` in the editor font at 100 px (letter shapes, not the em box). */
function inkAt100(text, o) {
  measureCtx.font = `${normalizeWeight(o.fontWeight, o.fontFamily)} 100px "${o.fontFamily}"`;
  const m = measureCtx.measureText(text);
  return {
    left: m.actualBoundingBoxLeft, // distance the ink starts left of the pen (negative = right)
    width: m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
    ascent: m.actualBoundingBoxAscent,
    height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
  };
}

/** Share of the letter box that `text` covers when drawn in the editor font at this weight. */
function inkDensity(text, family, weight, fs) {
  const c = document.createElement('canvas');
  measureCtx.font = `${weight} ${fs}px "${family}"`;
  const m = measureCtx.measureText(text);
  const w = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight) + 2;
  const h = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) + 2;
  if (w < 3 || h < 3) return 0;
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.font = measureCtx.font;
  g.fillText(text, m.actualBoundingBoxLeft + 1, m.actualBoundingBoxAscent + 1);
  const { data } = g.getImageData(0, 0, w, h);
  let ink = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 127) ink++;
  // Over the glyphs' own box (not the 1 px margin drawn around it), as the
  // photo's coverage is measured over its letters' tight box.
  return ink / Math.max(1, (w - 2) * (h - 2));
}

/** Render `text` in a font, stretched so its letters fill a w×h box, as a mask. */
function renderedMask(text, family, weight, w, h) {
  measureCtx.font = `${weight} 100px "${family}"`;
  const m = measureCtx.measureText(text);
  const iw = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight);
  const ih = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
  if (iw < 2 || ih < 2) return null;
  const src = document.createElement('canvas');
  src.width = iw; src.height = ih;
  const sg = src.getContext('2d');
  sg.font = measureCtx.font;
  sg.fillText(text, m.actualBoundingBoxLeft, m.actualBoundingBoxAscent);
  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  const dg = dst.getContext('2d', { willReadFrequently: true });
  dg.drawImage(src, 0, 0, w, h);
  const { data } = dg.getImageData(0, 0, w, h);
  const out = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) out[k] = data[k * 4 + 3] > 110 ? 1 : 0;
  return out;
}

/** Stroke overlap of two masks, allowing 1 px of slack (0 = nothing in common, 1 = identical). */
function maskSimilarity(a, b, w, h) {
  const near = (m, k) => {
    const x = k % w; const y = (k - x) / w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx; const yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && m[yy * w + xx]) return true;
    }
    return false;
  };
  let na = 0; let nb = 0; let hit = 0;
  for (let k = 0; k < w * h; k++) {
    if (a[k]) { na++; if (near(b, k)) hit++; }
    if (b[k]) { nb++; if (near(a, k)) hit++; }
  }
  return na + nb ? hit / (na + nb) : 0;
}

/**
 * Pick the library font (family + weight) whose letters look most like the
 * original's: render the recognised text in each candidate, stretched to the
 * same box, and compare stroke masks. A family other than the default wins
 * only if it is clearly closer, so lines don't flip fonts on noise.
 */
function matchFont(text, photoMask) {
  if (!photoMask || [...text.replace(/\s/g, '')].length < 1) return null;
  const { w, h, data } = photoMask;
  let best = null;
  let defaultScore = 0;
  // Shape is compared at regular and bold only; the exact weight comes from guessWeight.
  for (const family of MATCH_FAMILIES) {
    for (const weight of weightsOf(family).filter((k) => k === 400 || k === 700)) {
      const m = renderedMask(text, family, weight, w, h);
      if (!m) continue;
      const score = maskSimilarity(data, m, w, h);
      if (family === DEFAULT_FAMILY) defaultScore = Math.max(defaultScore, score);
      if (!best || score > best.score) best = { family, weight, score };
    }
  }
  if (!best) return null;
  // Margin and mask size tuned on 444 benchmark lines (family right 81%).
  if (best.family !== DEFAULT_FAMILY && best.score < defaultScore + 0.01) {
    // Not clearly better: stay with the default family, at its better weight.
    const w4 = maskSimilarity(data, renderedMask(text, DEFAULT_FAMILY, 400, w, h) || new Uint8Array(w * h), w, h);
    const w7 = maskSimilarity(data, renderedMask(text, DEFAULT_FAMILY, 700, w, h) || new Uint8Array(w * h), w, h);
    return { family: DEFAULT_FAMILY, weight: w7 > w4 ? 700 : 400, score: Math.max(w4, w7) };
  }
  return best;
}

/**
 * Bold or regular? Compare how much of the letter box the original's strokes
 * cover with how much the family's regular and bold weights cover for the same
 * text, and pick the closer one. Large lettering may then step on to Black or
 * Light; small text looks heavier than it is (blurred edges), so it doesn't.
 */
const EXTREME_WEIGHT_MIN_SIZE = 40;
function guessWeight(text, family, fs, photoDensity) {
  if (!photoDensity || fs < 8) return 400;
  const density = (w) => inkDensity(text, family, w, fs);
  const closer = (a, b) => {
    const da = density(a); const db = density(b);
    if (!da || !db) return a;
    return Math.abs(photoDensity - db) < Math.abs(photoDensity - da) ? b : a;
  };
  const weights = weightsOf(family);
  let w = weights.includes(700) ? closer(400, 700) : 400;
  if (fs >= EXTREME_WEIGHT_MIN_SIZE) {
    if (w === 700 && weights.includes(900)) w = closer(700, 900);
    if (w === 400 && weights.includes(300)) w = closer(400, 300);
  }
  return w;
}

/** Put a one-line text's letters (ink) centred on (cx, cy) at font size fs, and remember where they are. */
function placeInk(o, ink, fs, cx, cy) {
  const k = fs / 100;
  o.set({ fontSize: fs });
  o.initDimensions();
  const n = [...o.text].length;
  const inkW = ink.width * k + (n > 1 ? ((n - 1) * (o.charSpacing || 0) * fs) / 1000 : 0);
  const inkH = ink.height * k;
  const inkLeft = cx - inkW / 2;
  const inkTop = cy - inkH / 2;
  o.set({ left: inkLeft + ink.left * k, top: inkTop - (BASELINE * fs - ink.ascent * k) });
  o.setCoords();
  o.ink = ink;
  o.inkBox = { x0: inkLeft, y0: inkTop, x1: inkLeft + inkW, y1: inkTop + inkH };
}

/**
 * Display lettering in posters often overlaps its neighbours by design; the
 * same sizes in a regular font collide. Where two converted lines would touch,
 * shrink the larger one around its centre until they no longer touch.
 */
function separateLines(objs) {
  const items = objs.filter((o) => o.inkBox && o.ink);
  for (let round = 0; round < 40; round++) {
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const A = items[i].inkBox;
        const B = items[j].inkBox;
        const gap = 0.04 * Math.min(A.y1 - A.y0, B.y1 - B.y0);
        const ox = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0) + gap;
        const oy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) + gap;
        if (ox <= 0 || oy <= 0) continue;
        const big = items[i].fontSize >= items[j].fontSize ? items[i] : items[j];
        if (big.fontSize <= 8) continue;
        const bb = big.inkBox;
        placeInk(big, big.ink, big.fontSize * 0.95, (bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/**
 * Turn an OCR line into a text object whose letters cover the original's:
 * the font size makes the letter height match, letter spacing makes the
 * line width match, and the box is placed so the letter shapes (not the
 * em box) line up with where the original letters were.
 */
function textFromLine(line, color) {
  const { x0, y0, x1, y1 } = line.bbox;
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (line.vertical) {
    const chars = [...line.text.replace(/\s+/g, '')];
    return {
      obj: newText(chars.join('\n'), { fontSize: bw, fill: color, textAlign: 'center', vertical: true, ocr: true }),
      fit: (o) => {
        const widest = Math.max(...chars.map((c) => inkAt100(c, o).width), 1);
        const fs = Math.min(2000, Math.max(6, (bw * 100) / widest));
        const first = inkAt100(chars[0], o);
        const last = inkAt100(chars[chars.length - 1], o);
        const k = fs / 100;
        const span = bh - (first.ascent + (last.height - last.ascent)) * k; // first ink top → last baseline
        const lh = chars.length > 1 ? Math.min(3, Math.max(0.6, span / ((chars.length - 1) * 1.13 * fs))) : 1;
        o.set({ fontSize: fs, lineHeight: lh });
        o.initDimensions();
        o.set({ left: x0 + bw / 2 - o.width / 2, top: y0 - (BASELINE * fs - first.ascent * k) });
        o.setCoords();
      },
    };
  }
  return {
    obj: newText(line.text, { fontSize: bh, fill: color, ocr: true }),
    fit: (o) => {
      // Family: closest-looking library font. Weight: stroke coverage, which
      // was right more often (79% vs 73% on the benchmark).
      const match = matchFont(line.text, line.mask);
      if (match) o.set({ fontFamily: match.family });
      const approx = (bh * 100) / Math.max(inkAt100(line.text, o).height, 1);
      if (line.bbox.density && weightsOf(o.fontFamily).length > 1) {
        o.set({ fontWeight: guessWeight(line.text, o.fontFamily, approx, line.bbox.density) });
      } else if (line.bbox.density && guessWeight(line.text, DEFAULT_FAMILY, approx, line.bbox.density) >= 900) {
        // Very heavy strokes, but the closest-shaped font has one regular
        // weight: the weight matters more to the look, so use the default
        // family at Black. (Plain bold stays: rounded fonts read as bold.)
        o.set({ fontFamily: DEFAULT_FAMILY, fontWeight: guessWeight(line.text, DEFAULT_FAMILY, approx, line.bbox.density) });
      } else {
        o.set({ fontWeight: 400 });
      }
      // Remember the original letters' area so edits can re-fit to it.
      o.set({ fitBox: { x0, y0, x1, y1 }, autoFit: true });
      fitToBox(o);
    },
  };
}

/**
 * Size and space a one-line text so its letters cover o.fitBox (the original
 * letters' pixel bounds). Height first: the letters get the original's height
 * and letter spacing absorbs the width difference, so a missing "/" spreads
 * digits instead of enlarging them. Squeezing is limited to −8% of a
 * character; past that the font shrinks.
 */
function fitToBox(o) {
  const { x0, y0, x1, y1 } = o.fitBox;
  const bw = x1 - x0;
  const bh = y1 - y0;
  const ink = inkAt100(o.text, o);
  const n = [...o.text].length;
  const MIN_SPACING = -80; // thousandths of the font size
  let fs = (bh * 100) / Math.max(ink.height, 1);
  let spacing = n > 1 ? (((bw - (ink.width * fs) / 100) / (n - 1)) / fs) * 1000 : 0;
  if (spacing < MIN_SPACING) {
    fs = bw / (ink.width / 100 + ((n - 1) * MIN_SPACING) / 1000);
    spacing = MIN_SPACING;
  }
  fs = Math.min(2000, Math.max(6, fs));
  o.set({ charSpacing: Math.round(Math.min(2000, spacing)), scaleX: 1, scaleY: 1 });
  // Centre the letters on the original's: keeps the gaps between rows as in the photo.
  placeInk(o, ink, fs, (x0 + x1) / 2, (y0 + y1) / 2);
}

/** After the text of a detected line changes, re-fit it to the original area (unless the user sized it). */
function refitIfAuto(o) {
  if (!o || !o.autoFit || !o.fitBox || o.vertical || o.text.includes('\n') || !o.text.trim()) return;
  fitToBox(o);
}

/** Turn OCR lines into fitted text boxes and erase their originals from the background. */
const hexOf = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * Two lines stacked one above the other (a date over its times) can each
 * measure a little of the other: a few stray pixels from the line below are
 * enough to carry a box down into it. Where two measured boxes overlap only
 * a little, split them at the row of least ink in the overlap, which is the
 * gap between the lines. Deep overlaps are lettering designed to overlap and
 * are left alone.
 */
function splitStackedLines(lines) {
  const flat = lines.filter((l) => !l.vertical && !l.badge);
  const g = state.original.getContext('2d', { willReadFrequently: true });
  const colours = new Map();
  const colourOf = (l) => {
    if (!colours.has(l)) colours.set(l, [1, 3, 5].map((k) => parseInt(textColorByContrast(l.src, l.bbox).slice(k, k + 2), 16)));
    return colours.get(l);
  };
  for (const A of flat) {
    for (const B of flat) {
      if (A === B) continue;
      const a = A.bbox; const b = B.bbox;
      if ((a.y0 + a.y1) / 2 >= (b.y0 + b.y1) / 2) continue; // A must be the upper line
      const x0 = Math.max(a.x0, b.x0); const x1 = Math.min(a.x1, b.x1);
      if (x1 - x0 < 4 || a.y1 <= b.y0) continue;
      const depth = a.y1 - b.y0;
      if (depth > 0.6 * Math.min(a.y1 - a.y0, b.y1 - b.y0)) continue;
      const ya = Math.max(Math.floor(b.y0), Math.ceil(a.y0) + 1); const yb = Math.min(Math.ceil(a.y1), Math.floor(b.y1) - 1);
      if (yb < ya) continue;
      const { data } = g.getImageData(Math.floor(x0), ya, Math.ceil(x1 - x0), yb - ya + 1);
      const w = Math.ceil(x1 - x0);
      const ca = colourOf(A); const cb = colourOf(B);
      const near = (i, c) => Math.abs(data[i] - c[0]) + Math.abs(data[i + 1] - c[1]) + Math.abs(data[i + 2] - c[2]) < 80;
      let best = ya; let bestN = Infinity;
      for (let y = 0; y <= yb - ya; y++) {
        let n = 0;
        for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (near(i, ca) || near(i, cb)) n++; }
        if (n < bestN || (n === bestN && Math.abs(ya + y - (ya + yb) / 2) < Math.abs(best - (ya + yb) / 2))) { bestN = n; best = ya + y; }
      }
      A.bbox = { ...a, y1: Math.max(a.y0 + 2, best) };
      B.bbox = { ...b, y0: Math.min(b.y1 - 2, best + 1) };
    }
  }
}

/** A copy of the photo with a date's badge disc painted in the background colour. */
function withoutDisc(src, line) {
  const c = cloneCanvas(src);
  const g = c.getContext('2d');
  const bg = sampleRing(src, line.bbox, 2);
  g.fillStyle = `rgb(${bg.join(',')})`;
  g.beginPath();
  g.arc(line.disc.cx, line.disc.cy, line.disc.r * 1.08, 0, 2 * Math.PI);
  g.fill();
  return c;
}

async function convertLines(lines) {
  // Fit new text to the letters themselves, not to the OCR box around them.
  const fitted = lines.map((l) => {
    // A date with a weekday badge beside it is measured with the badge's disc
    // painted out, so the disc doesn't count as part of its letters.
    const src = l.disc ? withoutDisc(state.original, l) : state.original;
    const han = [...l.text].filter((ch) => /\p{Script=Han}/u.test(ch)).length;
    const bbox = inkBounds(src, l.bbox, { vertical: l.vertical, color: l.badge ? hexOf(l.badge.ink) : null, cjk: han >= 0.5 * [...l.text.replace(/\s/g, '')].length });
    return { ...l, src, bbox };
  });
  splitStackedLines(fitted);
  for (const l of fitted) l.mask = l.vertical ? null : letterMask(l.src, l.bbox);
  // Every candidate font needs these characters loaded before comparing shapes.
  const allText = fitted.map((l) => l.text).join('');
  await Promise.all(MATCH_FAMILIES.map(loadFontCss));
  await Promise.allSettled(MATCH_FAMILIES.flatMap((f) => weightsOf(f).map((w) => document.fonts.load(`${w} 40px "${f}"`, allText))));
  const built = fitted.map((l) => textFromLine(l, l.badge ? hexOf(l.badge.ink) : textColorByContrast(l.src, l.bbox, l.vertical)));
  await ensureFontsLoaded(built.map((b) => b.obj));
  built.forEach((b) => b.fit(b.obj));
  built.forEach((b, i) => {
    b.obj.ocrBox = fitted[i].bbox; // for checking the fit; not saved
    const e = lines[i].bbox;
    b.obj.set('eraseBox', { x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1 });
  });
  const g = state.clean.getContext('2d');
  for (const l of lines) if (!l.badge) eraseText(state.clean, l.bbox, 2);
  // Badge discs are artwork: put back any disc a date's erasing touched, then
  // repaint the inside of each badge's disc in its own colour, under the character.
  for (const l of lines) {
    const d = l.disc || l.badge;
    if (!d) continue;
    g.save();
    g.beginPath();
    g.arc(d.cx, d.cy, d.r, 0, 2 * Math.PI);
    g.clip();
    g.drawImage(state.original, 0, 0);
    g.restore();
  }
  for (const l of lines.filter((x) => x.badge)) {
    g.fillStyle = hexOf(l.badge.color);
    g.beginPath();
    g.arc(l.badge.cx, l.badge.cy, l.badge.r * 0.92, 0, 2 * Math.PI);
    g.fill();
  }
  return built.map((b) => b.obj);
}

/**
 * Text drawn into the artwork (a sign, a banner, a sheet of paper someone
 * holds) sits on a small plain patch: the colour around it doesn't run on
 * into the poster's background, and it clearly differs from what lies around
 * the text or around the patch. On 40 benchmark posters 2.1% of ordinary
 * lines look like this (each is still asked about); all three picture items
 * on the reference poster do.
 */
function looksLikePictureText(ib) {
  const h = Math.min(ib.y1 - ib.y0, ib.x1 - ib.x0);
  const near = sampleRing(state.original, ib, 0.3 * h);
  const far = sampleRing(state.original, ib, 1.5 * h);
  const offset = Math.abs(near[0] - far[0]) + Math.abs(near[1] - far[1]) + Math.abs(near[2] - far[2]);
  const patch = plainPatch(state.original, ib);
  return patch.bounded && patch.ratio < 3 && Math.max(offset, patch.offset) >= 200;
}

/**
 * Ask which of the lines that look like part of a picture should become
 * editable. Each has its own tick box; returns the ticked ones.
 */
function askAboutPictureText(lines) {
  const dlg = $('#artDialog');
  $('#artCount').textContent = t('artFound', { n: lines.length });
  const boxes = lines.map(() => Object.assign(document.createElement('input'), { type: 'checkbox', checked: true }));
  $('#artList').replaceChildren(...lines.map((l, i) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.append(boxes[i], document.createTextNode(` ${l.text}`));
    li.append(label);
    return li;
  }));
  dlg.showModal();
  return new Promise((resolve) => {
    const done = (picked) => { dlg.close(); resolve(picked); };
    $('#artYes').onclick = () => done(lines.filter((_, i) => boxes[i].checked));
    $('#artNo').onclick = () => done([]);
    dlg.oncancel = (e) => { e.preventDefault(); done([]); };
  });
}

async function runDetect() {
  if (!state.original) return;
  const existing = canvas.getObjects().filter((o) => o.ocr);
  if (existing.length && !confirm(t('confirmReplace'))) return;
  let pictureLines = [];
  await withBusy(t('detecting'), async () => {
    let lines = await detectText(state.original, {
      onProgress: (m) => setBusy(`${t(`ocr:${m.status}`).replace(/^ocr:/, '')}…`, typeof m.progress === 'number' ? m.progress : null),
    });
    history.paused = true;
    canvas.discardActiveObject();
    canvas.remove(...existing);

    // Readings below 50% confidence are mostly logos and tiny print read as
    // gibberish; leave those areas exactly as in the photo instead.
    // (A weekday badge is kept: finding a disc beside a date already vouches for it.)
    const skipped = lines.filter((l) => l.confidence < 50 && !l.badge).length;
    lines = lines.filter((l) => l.confidence >= 50 || l.badge);
    // A weekday badge (㊁) sits on its own disc; that isn't artwork text.
    pictureLines = lines.filter((l) => !l.badge && looksLikePictureText(inkBounds(state.original, l.bbox, { vertical: l.vertical })));
    lines = lines.filter((l) => !pictureLines.includes(l));

    state.clean = cloneCanvas(state.original);
    state.eraseUndo = [];
    const objs = await convertLines(lines);
    separateLines(objs);
    state.bgDirty = true;
    setBackground(state.clean);
    if (objs.length) canvas.add(...objs);
    history.paused = false;
    pushHistory();
    renderLayers();
    refreshEnabled();
    const nVertical = lines.filter((l) => l.vertical).length;
    toast(lines.length
      ? `${t(lines.length === 1 ? 'foundOne' : 'foundMany', { n: lines.length })}${nVertical && nVertical < lines.length ? ` ${t('foundVertical', { n: nVertical })}` : ''}`
      : t('noTextFound'), lines.length ? 'ok' : 'warn', skipped ? 7000 : 3500);
    if (skipped) setTimeout(() => toast(t('keptAsPhoto', { n: skipped }), 'info', 6000), 3600);
  });
  const picked = pictureLines.length ? await askAboutPictureText(pictureLines) : [];
  if (picked.length) {
    history.paused = true;
    const objs = await convertLines(picked);
    setBackground(state.clean);
    canvas.add(...objs);
    separateLines(canvas.getObjects().filter((o) => o.ocr));
    history.paused = false;
    pushHistory();
    renderLayers();
    canvas.requestRenderAll();
  }
}

function addText() {
  if (!hasDoc()) return;
  const W = canvas.getWidth();
  const H = canvas.getHeight();
  const o = newText(t('newTextSample'), { fontSize: Math.round(Math.max(W, H) / 20) });
  ensureFontsLoaded([o]).then(() => {
    o.set({ left: W / 2 - o.width / 2, top: H / 2 - o.height / 2 });
    o.setCoords();
    canvas.add(o);
    canvas.setActiveObject(o);
    canvas.requestRenderAll();
  });
}

/* ---------------- Properties panel ---------------- */

const active = () => {
  const o = canvas.getActiveObject();
  return isText(o) ? o : null;
};

function renderProps() {
  const o = active();
  $('#props').hidden = !o;
  $('#noSelection').hidden = Boolean(o);
  if (!o) { renderQuickEdit(); return; }
  const ta = $('#propText');
  if (document.activeElement !== ta) ta.value = o.vertical ? fromVertical(o.text) : o.text;
  $('#propFont').value = FONTS[o.fontFamily] ? o.fontFamily : DEFAULT_FAMILY;
  renderWeights(o);
  $('#propSize').value = Math.round(o.fontSize * o.scaleY);
  $('#propColor').value = typeof o.fill === 'string' && /^#[0-9a-f]{6}$/i.test(o.fill) ? o.fill : new fabric.Color(o.fill).toHex().replace(/^#?/, '#');
  $('#propLine').value = o.lineHeight;
  $('#propSpacing').value = Math.round(o.charSpacing || 0);
  $('#propVertical').checked = Boolean(o.vertical);
  $('#propOpacity').value = o.opacity ?? 1;
  document.querySelectorAll('[name=align]').forEach((r) => { r.checked = r.value === o.textAlign; });
  renderQuickEdit();
}

async function updateActive(changes, { remeasure = true } = {}) {
  const o = active();
  if (!o) return;
  o.set(changes);
  if (remeasure) await ensureFontsLoaded([o]);
  o.setCoords();
  canvas.requestRenderAll();
  pushHistory();
  renderLayers();
}

$('#propText').addEventListener('input', (e) => {
  const o = active();
  if (!o) return;
  updateActive({ text: o.vertical ? toVertical(e.target.value) : e.target.value }).then(() => { refitIfAuto(o); canvas.requestRenderAll(); renderQuickEdit(); });
});
$('#propFont').addEventListener('change', async (e) => {
  const o = active();
  const family = e.target.value;
  await loadFontCss(family);
  await updateActive({ fontFamily: family, fontWeight: normalizeWeight(o?.fontWeight, family) });
  if (o) renderWeights(o);
});
$('#propWeight').addEventListener('change', (e) => updateActive({ fontWeight: Number(e.target.value) }));
$('#propSize').addEventListener('change', (e) => {
  const v = Number(e.target.value);
  if (v > 0) updateActive({ fontSize: v, scaleX: 1, scaleY: 1, autoFit: false });
});
$('#propColor').addEventListener('input', (e) => updateActive({ fill: e.target.value }, { remeasure: false }));
$('#propLine').addEventListener('change', (e) => updateActive({ lineHeight: Number(e.target.value) || 1 }));
$('#propSpacing').addEventListener('change', (e) => updateActive({ charSpacing: Number(e.target.value) || 0, autoFit: false }));
$('#propOpacity').addEventListener('input', (e) => updateActive({ opacity: Number(e.target.value) }, { remeasure: false }));
function setVertical(on) {
  const o = active();
  if (!o) return;
  const plain = o.vertical ? fromVertical(o.text) : o.text.replace(/\n/g, '');
  updateActive(on
    ? { vertical: true, text: toVertical(plain), textAlign: 'center' }
    : { vertical: false, text: plain, textAlign: 'left' }).then(renderProps);
}
$('#propVertical').addEventListener('change', (e) => setVertical(e.target.checked));

/* ---------------- Pop-up editor next to the selected text ---------------- */

let transforming = false;
function renderQuickEdit() {
  const box = $('#quickEdit');
  const o = active();
  if (!o || o.isEditing || transforming || comparing || state.tool !== 'select') { box.hidden = true; return; }
  const ta = $('#qeText');
  if (document.activeElement !== ta) ta.value = o.vertical ? fromVertical(o.text) : o.text;
  if (document.activeElement !== $('#qeSize')) $('#qeSize').value = Math.round(o.fontSize * o.scaleY);
  $('#qeColor').value = $('#propColor').value;
  $('#qeBold').setAttribute('aria-pressed', String(isBold(o.fontWeight)));
  $('#qeVertical').setAttribute('aria-pressed', String(Boolean(o.vertical)));
  $('#qeKeep').hidden = !o.eraseBox;
  box.hidden = false;
  positionQuickEdit();
}

function positionQuickEdit() {
  const box = $('#quickEdit');
  const o = active();
  if (box.hidden || !o) return;
  const c = canvas.upperCanvasEl.getBoundingClientRect();
  const z = c.width / canvas.getWidth();
  const b = o.getBoundingRect();
  const top = c.top + b.top * z;
  const bottom = top + b.height * z;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  let y = bottom + 10;
  if (y + h > vh - 8) y = top - h - 10;           // no room below: go above
  if (y < 8) y = Math.min(vh - h - 8, Math.max(8, bottom + 10)); // no room either: keep on screen
  const x = Math.min(Math.max(8, c.left + (b.left + b.width / 2) * z - w / 2), window.innerWidth - w - 8);
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
}

['object:moving', 'object:scaling', 'object:rotating'].forEach((ev) => canvas.on(ev, () => { transforming = true; $('#quickEdit').hidden = true; }));
canvas.on('mouse:up', () => { if (transforming) { transforming = false; renderQuickEdit(); } });
canvas.on('text:editing:entered', () => { $('#quickEdit').hidden = true; });
canvas.on('text:editing:exited', () => renderQuickEdit());
$('#stage').addEventListener('scroll', positionQuickEdit);
window.addEventListener('resize', positionQuickEdit);
window.visualViewport?.addEventListener('resize', positionQuickEdit);

const resizeBy = (factor) => {
  const o = active();
  if (!o) return;
  const now = o.fontSize * o.scaleY;
  const next = Math.max(4, Math.round(factor > 1 ? Math.max(now + 1, now * factor) : Math.min(now - 1, now * factor)));
  updateActive({ fontSize: next, scaleX: 1, scaleY: 1, autoFit: false }).then(renderProps);
};
$('#qeText').addEventListener('input', (e) => {
  const o = active();
  if (o) updateActive({ text: o.vertical ? toVertical(e.target.value) : e.target.value }).then(() => { refitIfAuto(o); canvas.requestRenderAll(); renderProps(); });
});
$('#qeSmaller').addEventListener('click', () => resizeBy(1 / 1.1));
$('#qeBigger').addEventListener('click', () => resizeBy(1.1));
$('#qeSize').addEventListener('change', (e) => {
  const v = Number(e.target.value);
  if (v > 0) updateActive({ fontSize: v, scaleX: 1, scaleY: 1, autoFit: false }).then(renderProps);
});
$('#qeColor').addEventListener('input', (e) => { updateActive({ fill: e.target.value }, { remeasure: false }); $('#propColor').value = e.target.value; });
$('#qeBold').addEventListener('click', () => {
  const o = active();
  if (o) updateActive({ fontWeight: normalizeWeight(isBold(o.fontWeight) ? 400 : 700, o.fontFamily) }).then(renderProps);
});
$('#qeVertical').addEventListener('click', () => { const o = active(); if (o) setVertical(!o.vertical); });
$('#qeDelete').addEventListener('click', () => { const o = active(); if (o) canvas.remove(o); });
$('#qeKeep').addEventListener('click', () => keepAsPicture(active()));

/** Undo the conversion of one line: remove its text box and put the photo's original pixels back. */
function keepAsPicture(o) {
  if (!o || !o.eraseBox || !state.original) return;
  const b = o.eraseBox;
  const pad = 6;
  const x = Math.max(0, Math.floor(b.x0 - pad)); const y = Math.max(0, Math.floor(b.y0 - pad));
  const w = Math.min(state.clean.width - x, Math.ceil(b.x1 - b.x0 + 2 * pad));
  const h = Math.min(state.clean.height - y, Math.ceil(b.y1 - b.y0 + 2 * pad));
  // Same undo stack as the Erase area tool, so ↶ Erase puts the cleaned patch back.
  state.eraseUndo.push({ x, y, data: state.clean.getContext('2d').getImageData(x, y, w, h) });
  if (state.eraseUndo.length > 30) state.eraseUndo.shift();
  state.clean.getContext('2d').drawImage(state.original, x, y, w, h, x, y, w, h);
  state.bgDirty = true;
  markDirty();
  setBackground(state.clean);
  canvas.remove(o);
  refreshEnabled();
}
document.querySelectorAll('[name=align]').forEach((r) => r.addEventListener('change', () => updateActive({ textAlign: r.value }, { remeasure: false })));

$('#dupBtn').addEventListener('click', async () => {
  const o = active();
  if (!o) return;
  const c = await o.clone(EXTRA_PROPS);
  c.set({ left: o.left + 20, top: o.top + 20, ocr: false });
  canvas.add(c);
  canvas.setActiveObject(c);
});
$('#delBtn').addEventListener('click', () => {
  const o = active();
  if (o) canvas.remove(o);
});
$('#fwdBtn').addEventListener('click', () => { const o = active(); if (o) { canvas.bringObjectForward(o); pushHistory(); renderLayers(); } });
$('#backBtn').addEventListener('click', () => { const o = active(); if (o) { canvas.sendObjectBackwards(o); pushHistory(); renderLayers(); } });

/* ---------------- Layers list ---------------- */

function renderLayers() {
  const list = $('#layers');
  const objs = canvas.getObjects().filter(isText).reverse();
  list.replaceChildren(...objs.map((o) => {
    const li = document.createElement('li');
    li.className = o === canvas.getActiveObject() ? 'selected' : '';
    const label = document.createElement('button');
    label.className = 'layer-label';
    label.textContent = (o.vertical ? fromVertical(o.text) : o.text).replace(/\s+/g, ' ') || t('layerEmpty');
    label.title = t('layerSelect');
    label.style.fontFamily = `"${o.fontFamily}"`;
    label.addEventListener('click', () => { canvas.setActiveObject(o); canvas.requestRenderAll(); });
    const eye = document.createElement('button');
    eye.className = 'icon';
    eye.textContent = o.visible === false ? '◌' : '●';
    eye.title = t(o.visible === false ? 'layerShow' : 'layerHide');
    eye.addEventListener('click', () => {
      o.set('visible', o.visible === false);
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      pushHistory();
      renderLayers();
    });
    li.append(eye, label);
    return li;
  }));
  $('#layerCount').textContent = objs.length;
}

/* ---------------- Hold to see the original photo ---------------- */

let comparing = false;
function setComparing(on) {
  if (on === comparing || !state.original) return;
  comparing = on;
  canvas.discardActiveObject();
  canvas.getObjects().forEach((o) => {
    if (on) { o._wasVisible = o.visible; o.visible = false; } else { o.visible = o._wasVisible ?? true; }
  });
  setBackground(on ? state.original : state.clean);
  $('#compareBtn').classList.toggle('active', on);
  renderQuickEdit();
}
{
  const btn = $('#compareBtn');
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.setPointerCapture?.(e.pointerId); setComparing(true); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, () => setComparing(false)));
  btn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setComparing(true); } });
  btn.addEventListener('keyup', () => setComparing(false));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

/* ---------------- Erase tool ---------------- */

let drag = null;
function setTool(tool) {
  state.tool = tool;
  $('#eraseBtn').classList.toggle('active', tool === 'erase');
  $('#stage').classList.toggle('erasing', tool === 'erase');
  const selecting = tool === 'select';
  canvas.selection = selecting;
  canvas.discardActiveObject();
  canvas.getObjects().forEach((o) => { o.selectable = selecting; o.evented = selecting; });
  canvas.defaultCursor = selecting ? 'default' : 'crosshair';
  canvas.requestRenderAll();
}

canvas.on('mouse:down', (opt) => {
  if (state.tool !== 'erase') return;
  const p = canvas.getScenePoint(opt.e);
  const rect = new fabric.Rect({
    originX: 'left', originY: 'top', left: p.x, top: p.y, width: 1, height: 1,
    fill: 'rgba(37,99,235,0.15)', stroke: '#2563eb', strokeDashArray: [6, 4], strokeWidth: 2,
    strokeUniform: true, selectable: false, evented: false, excludeFromExport: true, temp: true,
  });
  history.paused = true;
  canvas.add(rect);
  history.paused = false;
  drag = { start: p, rect };
});
canvas.on('mouse:move', (opt) => {
  if (!drag) return;
  const p = canvas.getScenePoint(opt.e);
  drag.rect.set({
    left: Math.min(p.x, drag.start.x), top: Math.min(p.y, drag.start.y),
    width: Math.abs(p.x - drag.start.x), height: Math.abs(p.y - drag.start.y),
  });
  canvas.requestRenderAll();
});
canvas.on('mouse:up', () => {
  if (!drag) return;
  const { left, top, width, height } = drag.rect;
  history.paused = true;
  canvas.remove(drag.rect);
  history.paused = false;
  drag = null;
  if (width < 3 || height < 3) return;
  const box = { x0: left, y0: top, x1: left + width, y1: top + height };
  const x = Math.max(0, Math.floor(left) - 8);
  const y = Math.max(0, Math.floor(top) - 8);
  const w = Math.min(state.clean.width - x, Math.ceil(width) + 16);
  const h = Math.min(state.clean.height - y, Math.ceil(height) + 16);
  state.eraseUndo.push({ x, y, data: state.clean.getContext('2d').getImageData(x, y, w, h) });
  if (state.eraseUndo.length > 30) state.eraseUndo.shift();
  eraseText(state.clean, box, 0);
  state.bgDirty = true;
  markDirty();
  setBackground(state.clean);
  refreshEnabled();
});

function undoErase() {
  const step = state.eraseUndo.pop();
  if (!step) return;
  state.clean.getContext('2d').putImageData(step.data, step.x, step.y);
  state.bgDirty = true;
  markDirty();
  setBackground(state.clean);
  refreshEnabled();
}

/* ---------------- New / open / save ---------------- */

function confirmDiscard() {
  return !state.dirty || confirm(t('confirmDiscard'));
}

async function newFromFile(file) {
  // Some systems give HEIC/AVIF files an empty MIME type, so fall back to the extension.
  const looksLikeImage = file && (file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name));
  if (!looksLikeImage) { toast(t('notImage'), 'warn', 6000); return; }
  if (!confirmDiscard()) return;
  await withBusy(t('loadingPhoto'), async () => {
    state.original = await fileToCanvas(file);
    state.clean = cloneCanvas(state.original);
    state.id = crypto.randomUUID();
    state.name = file.name.replace(/\.[^.]+$/, '') || t('untitled');
    state.bgDirty = true;
    state.origDirty = true;
    state.home = null;
    $('#docName').value = state.name;
    resetCanvas(state.original.width, state.original.height);
    setBackground(state.clean);
    resetHistory();
    markDirty();
    refreshEnabled();
    applyZoom();
  });
  renderLayers();
  renderProps();
  runDetect();
}

function currentStore() {
  return state.user && state.stores.cloud ? state.stores.cloud : state.stores.local;
}
const storeKey = (store) => (store.isCloud ? `cloud:${state.user.id}` : 'local');

async function buildRecord({ full = false } = {}) {
  const W = canvas.getWidth();
  const H = canvas.getHeight();
  canvas.discardActiveObject();
  return {
    id: state.id,
    name: state.name || t('untitled'),
    width: W,
    height: H,
    objects: serializeObjects(),
    thumbnail: canvas.toDataURL({ format: 'jpeg', quality: 0.7, multiplier: 320 / Math.max(W, H) }),
    background: full || state.bgDirty ? await canvasToBlob(state.clean, 'image/jpeg', 0.92) : null,
    original: state.original && (full || state.origDirty) ? await canvasToBlob(state.original, 'image/jpeg', 0.9) : null,
    updatedAt: new Date().toISOString(),
  };
}

async function save() {
  if (!hasDoc()) return;
  const store = currentStore();
  await withBusy(t('saving', { where: t(store.whereKey) }), async () => {
    const key = storeKey(store);
    await store.put(await buildRecord({ full: state.home !== key }));
    state.home = key;
    state.bgDirty = false;
    state.origDirty = false;
    state.dirty = false;
    updateTitle();
    toast(t('saved', { where: t(store.whereKey) }), 'ok');
  });
}

async function openRecord(rec, homeKey) {
  const toCanvas = async (blob) => {
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    try { return await urlToCanvas(url); } finally { URL.revokeObjectURL(url); }
  };
  state.clean = await toCanvas(rec.background);
  if (!state.clean) throw new Error(t('errNoBackground'));
  state.original = await toCanvas(rec.original);
  state.id = rec.id || crypto.randomUUID();
  state.name = rec.name || t('untitled');
  state.home = homeKey;
  state.bgDirty = !homeKey;
  state.origDirty = !homeKey;
  $('#docName').value = state.name;
  resetCanvas(rec.width || state.clean.width, rec.height || state.clean.height);
  setBackground(state.clean);
  await restoreObjects(rec.objects || []);
  resetHistory();
  state.dirty = !homeKey;
  updateTitle();
  refreshEnabled();
  applyZoom();
}

async function showOpenDialog() {
  const dlg = $('#openDialog');
  const tabs = $('#openTabs');
  const stores = [state.stores.local];
  if (state.user && state.stores.cloud) stores.unshift(state.stores.cloud);
  tabs.replaceChildren(...stores.map((s, i) => {
    const b = document.createElement('button');
    b.textContent = t(s.labelKey);
    b.className = i === 0 ? 'active' : '';
    b.addEventListener('click', () => {
      tabs.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      fillOpenList(s);
    });
    return b;
  }));
  $('#cloudHint').hidden = Boolean(state.user);
  dlg.showModal();
  fillOpenList(stores[0]);
}

async function fillOpenList(store) {
  const list = $('#templateList');
  list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: t('loading') }));
  try {
    const items = await store.list();
    if (!items.length) {
      list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: t('noTemplates') }));
      return;
    }
    list.replaceChildren(...items.map((tpl) => {
      const li = document.createElement('li');
      li.className = 'template-card';
      const open = document.createElement('button');
      open.className = 'template-open';
      if (tpl.thumbnail) open.append(Object.assign(document.createElement('img'), { src: tpl.thumbnail, alt: '' }));
      const meta = document.createElement('span');
      meta.innerHTML = '<strong></strong><small></small>';
      meta.querySelector('strong').textContent = tpl.name;
      meta.querySelector('small').textContent = `${tpl.width}×${tpl.height} · ${tpl.updatedAt ? new Date(tpl.updatedAt).toLocaleString(LANGS[getLang()].htmlLang) : ''}`;
      open.append(meta);
      open.addEventListener('click', async () => {
        if (!confirmDiscard()) return;
        $('#openDialog').close();
        await withBusy(t('opening'), async () => openRecord(await store.get(tpl.id), storeKey(store)));
      });
      const del = document.createElement('button');
      del.className = 'icon danger';
      del.textContent = '✕';
      del.title = t('delete');
      del.addEventListener('click', async () => {
        if (!confirm(t('confirmDelete', { name: tpl.name }))) return;
        await withBusy(t('deleting'), () => store.remove(tpl.id));
        if (state.id === tpl.id && state.home === storeKey(store)) { state.home = null; state.bgDirty = true; state.origDirty = true; }
        fillOpenList(store);
      });
      li.append(open, del);
      return li;
    }));
  } catch (e) {
    list.replaceChildren(Object.assign(document.createElement('li'), { className: 'error', textContent: e.message }));
  }
}

/* ---------------- Export ---------------- */

async function doExport(kind) {
  if (!hasDoc()) return;
  const base = safeFilename(state.name);
  const scale = Number($('#exportScale').value) || 1;
  await withBusy(t('exporting', { kind: kind.toUpperCase() }), async () => {
    if (['png', 'jpeg', 'webp'].includes(kind)) {
      download(await exportRaster(canvas, kind, 0.92, scale), `${base}.${kind === 'jpeg' ? 'jpg' : kind}`);
    } else if (kind === 'pptx') {
      download(await exportPPTX(canvas, state.clean, state.name), `${base}.pptx`);
      toast(t('pptxSaved'), 'ok', 8000);
    } else if (kind === 'svg') {
      download(await exportSVG(canvas), `${base}.svg`);
    } else if (kind === 'pdf') {
      download(await exportPDF(canvas, state.clean, state.name, (msg) => setBusy(msg)), `${base}.pdf`);
    } else if (kind === 'psd') {
      download(await exportPSD(canvas, state.clean, state.original), `${base}.psd`);
      toast(t('psdSaved'), 'ok', 7000);
    } else if (kind === 'json') {
      download(await recordToFile(await buildRecord({ full: true })), `${base}.template.json`);
    }
  });
  canvas.requestRenderAll();
}

/* ---------------- Cloud sign-in ---------------- */

function updateSaveTitle() {
  $('#saveBtn').title = t(state.user ? 'saveTitleCloud' : 'saveTitleLocal');
}

const FONT_LABELS = {
  'Noto Sans TC': 'fontSans', 'Noto Serif TC': 'fontSerif', Huninn: 'fontHuninn', Iansui: 'fontIansui',
  'LXGW WenKai TC': 'fontWenkai', 'Cactus Classical Serif': 'fontCactus', 'Chocolate Classical Sans': 'fontChocolate',
  'Chiron Hei HK': 'fontChironHei', 'Chiron Sung HK': 'fontChironSung', 'Chiron GoRound TC': 'fontChironRound',
  'LXGW Marker Gothic': 'fontMarker',
};
const FORMS_LABELS = { inherited: 'formsInherited', hk: 'formsHk', jp: 'formsJp' };

/** Dropdowns whose option text comes from code rather than index.html. */
function renderOptions() {
  const font = $('#propFont').value;
  const group = (label, families) => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...families.map((f) => {
      const forms = FORMS_LABELS[FONTS[f].forms];
      return new Option(`${FONT_LABELS[f] ? t(FONT_LABELS[f]) : f}${forms ? ` · ${t(forms)}` : ''}`, f);
    }));
    return g;
  };
  $('#propFont').replaceChildren(
    group(t('fontsTaiwan'), MATCH_FAMILIES),
    group(t('fontsOther'), Object.keys(FONTS).filter((f) => !MATCH_FAMILIES.includes(f))),
  );
  if (font) $('#propFont').value = font;
  const o = active();
  if (o) renderWeights(o);
}

/** The weight menu lists only the weights the chosen family really has. */
function renderWeights(o) {
  const family = FONTS[o.fontFamily] ? o.fontFamily : DEFAULT_FAMILY;
  $('#propWeight').replaceChildren(...weightsOf(family).map((k) => new Option(t(`weight${k}`), k)));
  $('#propWeight').value = String(normalizeWeight(o.fontWeight, family));
}

/**
 * Help tooltips: hover a control (desktop), focus it with the keyboard, or
 * press and hold it (touch) to see what it does, in the current language.
 */
function initTips() {
  const pop = $('#infoPop');
  let timer = null;
  let current = null;
  let suppressClick = false;
  const hide = () => {
    clearTimeout(timer);
    pop.hidden = true;
    current?.removeAttribute('aria-describedby');
    current = null;
  };
  const show = (el) => {
    current = el;
    pop.textContent = t(`info:${el.dataset.tip}`);
    pop.hidden = false;
    el.setAttribute('aria-describedby', 'infoPop');
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = Math.min(Math.max(16, r.left + r.width / 2 - w / 2), window.innerWidth - w - 16);
    const below = r.bottom + 8 + h <= window.innerHeight - 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - h - 8)}px`;
  };
  const later = (el, ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => show(el), ms);
  };
  // Mouse: show after a short pause over a control, hide when leaving it.
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest('[data-tip]');
    if (el === current) return;
    hide();
    if (el) { current = el; later(el, 450); }
  });
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) hide(); });
  // Keyboard: show while a control is focused.
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && e.target.matches(':focus-visible')) { hide(); current = el; later(el, 300); }
  });
  document.addEventListener('focusout', hide);
  // Touch: press and hold. The tap that ends a long press doesn't also click.
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const el = e.target.closest('[data-tip]');
    hide();
    if (el) {
      current = el;
      timer = setTimeout(() => { show(el); suppressClick = true; }, 550);
    }
  });
  const cancelPress = () => { if (pop.hidden) clearTimeout(timer); };
  document.addEventListener('pointerup', cancelPress);
  document.addEventListener('pointercancel', cancelPress);
  document.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-tip]') && !pop.hidden) e.preventDefault(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('resize', hide);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('langchange', hide);
}

function initLanguage() {
  const buttons = [...document.querySelectorAll('#langToggle [data-lang]')];
  const sync = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === getLang())));
  buttons.forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  applyI18n();
  renderOptions();
  sync();
  document.addEventListener('langchange', () => {
    sync();
    renderOptions();
    renderLayers();
    renderProps();
    updateSaveTitle();
    updateTitle();
  });
}

async function initCloud() {
  if (!cloudConfigured()) {
    $('#account').hidden = true;
    return;
  }
  $('#account').hidden = false;
  try {
    const client = await getSupabase();
    const apply = (session) => {
      state.user = session?.user || null;
      state.stores.cloud = state.user ? new CloudStore(client, state.user) : null;
      $('#signInBtn').hidden = Boolean(state.user);
      $('#userBox').hidden = !state.user;
      $('#userEmail').textContent = state.user?.email || '';
      updateSaveTitle();
    };
    apply((await client.auth.getSession()).data.session);
    client.auth.onAuthStateChange((_event, session) => apply(session));
    $('#signInBtn').addEventListener('click', () => $('#authDialog').showModal());
    $('#signOutBtn').addEventListener('click', () => client.auth.signOut());
    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#authEmail').value.trim();
      const { error } = await client.auth.signInWithOtp({
        email, options: { emailRedirectTo: location.origin + location.pathname },
      });
      if (error) { toast(error.message, 'error', 6000); return; }
      $('#authDialog').close();
      toast(t('checkEmail', { email }), 'ok', 8000);
    });
  } catch (e) {
    toast(t('cloudUnavailable', { msg: e.message }), 'error', 6000);
  }
}

/* ---------------- Wiring ---------------- */

function init() {
  initLanguage();
  initTips();
  updateSaveTitle();
  updateTitle();

  $('#fileInput').addEventListener('change', (e) => { newFromFile(e.target.files[0]); e.target.value = ''; });
  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !confirmDiscard()) return;
    $('#openDialog').close();
    await withBusy(t('importing'), async () => openRecord(await fileToRecord(file), null));
  });
  $('#detectBtn').addEventListener('click', runDetect);
  $('#addTextBtn').addEventListener('click', addText);
  $('#eraseBtn').addEventListener('click', () => setTool(state.tool === 'erase' ? 'select' : 'erase'));
  $('#undoEraseBtn').addEventListener('click', undoErase);
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#saveBtn').addEventListener('click', save);
  $('#openBtn').addEventListener('click', showOpenDialog);
  $('#zoom').addEventListener('change', (e) => { if (e.target.selectedOptions[0]?.dataset.custom) return; state.zoom = e.target.value; applyZoom(); });
  $('#docName').addEventListener('input', (e) => { state.name = e.target.value; markDirty(); });
  $('.menu summary').addEventListener('click', (e) => {
    if (e.currentTarget.hasAttribute('disabled')) e.preventDefault();
  });
  document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => {
    b.closest('details').open = false;
    doExport(b.dataset.export);
  }));
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  const stage = $('#stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragging'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('dragging');
    newFromFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); newFromFile(file); }
  });

  window.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
      || canvas.getActiveObject()?.isEditing;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && active()) { e.preventDefault(); canvas.remove(active()); }
    if (e.key === 'Escape' && state.tool !== 'select') setTool('select');
  });
  window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });
  let fontWarned = false;
  document.addEventListener('fontsfailed', (e) => {
    if (fontWarned) return;
    fontWarned = true;
    toast(t('fontsFailed', { fonts: e.detail.join(', ').replace(/ 32px/g, '') }), 'warn', 9000);
  });

  refreshEnabled();
  renderLayers();
  renderProps();
  initCloud();
  window.templateMakerReady = true;
}

init();

// Handy for debugging from the console.
window.templateMaker = { canvas, state, debug: { matchFont, renderedMask, maskSimilarity, inkDensity, guessWeight } };
