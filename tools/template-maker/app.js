import { paddleDetect as detectText } from './paddle.js';
import { t, applyI18n, setLang, getLang, LANGS } from './i18n.js';
import {
  fileToCanvas, urlToCanvas, cloneCanvas, eraseText, canvasToBlob, inkBounds, letterMask, sampleRing, textColorByContrast, plainPatch, busyAround, inkContrast,
  panelUnder, findQRCodes, logoMark, makeCanvas, eraseBox,
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
const EXTRA_PROPS = ['vertical', 'ocr', 'fitBox', 'autoFit', 'eraseBox', 'slot'];
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
  stores: { local: new LocalStore(), cloud: null },
  user: null,
};

const canvas = new fabric.Canvas('c', {
  preserveObjectStacking: true,
  // The canvas is already the photo's size (up to 4096 px), more pixels than
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
// iPhone Safari only shows :active (the pressed look) when the page listens for touches.
document.addEventListener('touchstart', () => {}, { passive: true });
// A little vibration when a button is pressed (Android).
document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && e.target.closest?.('.btn:not(:disabled)')) navigator.vibrate?.(8); }, { passive: true });
$('#toast').addEventListener('click', () => { $('#toast').hidden = true; });

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
    const outOfMemory = e?.name === 'InvalidStateError' || /invalid state/i.test(e?.message);
    toast(outOfMemory ? t('errMemory') : e.message || String(e), 'error', outOfMemory ? 12000 : 6000);
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

// Phones: one finger always moves the view, like a photo viewer (a flick
// keeps gliding), and never drags a text box by accident (the layout is
// locked; see applyLock). A tap selects the box under it and opens the pop-up
// editor; tapping the selected text again types into it. A double tap on an
// empty spot zooms in there, and again back to the whole poster. Pinch zooms.
// A box unlocked with Move / resize is dragged as usual.
(() => {
  const stage = $('#stage');
  const TAP_SLOP = 10; // px a finger may wobble and still tap
  const TAP_MS = 450; // a slower press is a rest, not a tap
  let pan = null;
  let ownTouch = false; // this gesture is ours: keep its touch/mouse events from Fabric
  let glide = 0;
  let lastTap = { o: null, t: 0, x: 0, y: 0 };
  const onActiveUnlocked = (e) => {
    const act = canvas.getActiveObject();
    if (!act || !act.moveUnlocked) return false;
    const pt = canvas.getScenePoint(e);
    const r = act.getBoundingRect(); const pad = 24 / currentZoom(); // its handles too
    return pt.x >= r.left - pad && pt.x <= r.left + r.width + pad && pt.y >= r.top - pad && pt.y <= r.top + r.height + pad;
  };
  const hitAt = (e) => {
    const pt = canvas.getScenePoint(e);
    return [...canvas.getObjects()].reverse().find((o) => o.visible && o.evented !== false && o.selectable !== false && !o.temp && o.containsPoint(pt)) || null;
  };
  // Scroll the photo area first; whatever it can't take scrolls the page.
  const scrollBy = (dx, dy) => {
    const sl = stage.scrollLeft; const st = stage.scrollTop;
    stage.scrollLeft -= dx; stage.scrollTop -= dy;
    window.scrollBy(-(dx + (stage.scrollLeft - sl)), -(dy + (stage.scrollTop - st)));
  };
  const fitZoom = () => Math.min(1, (stage.clientWidth - 32) / canvas.getWidth(), (stage.clientHeight - 32) / canvas.getHeight());
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || state.tool !== 'select' || !hasDoc() || e.target !== canvas.upperCanvasEl) return;
    cancelAnimationFrame(glide);
    if (onActiveUnlocked(e)) return; // moving an unlocked box: Fabric's job
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: Date.now(), moved: false, vx: 0, vy: 0, t: Date.now() };
    ownTouch = true;
    e.stopPropagation();
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    e.stopPropagation();
    if (!pan.moved && Math.hypot(e.clientX - pan.x0, e.clientY - pan.y0) <= TAP_SLOP) return;
    if (!pan.moved) { pan.moved = true; pan.x = e.clientX; pan.y = e.clientY; return; }
    const dx = e.clientX - pan.x; const dy = e.clientY - pan.y;
    const now = Date.now(); const dt = Math.max(1, now - pan.t);
    pan.vx = 0.8 * (dx / dt) + 0.2 * pan.vx; pan.vy = 0.8 * (dy / dt) + 0.2 * pan.vy; pan.t = now;
    scrollBy(dx, dy);
    pan.x = e.clientX; pan.y = e.clientY;
  }, true);
  const end = (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    e.stopPropagation();
    const p = pan; pan = null;
    if (p.moved) {
      // Flick: keep gliding, slowing down.
      let vx = p.vx * 16; let vy = p.vy * 16; // px per frame
      if (Date.now() - p.t > 80 || e.type === 'pointercancel') return;
      const step = () => {
        vx *= 0.92; vy *= 0.92;
        if (Math.abs(vx) + Math.abs(vy) < 0.5) return;
        scrollBy(vx, vy);
        glide = requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
      return;
    }
    if (e.type === 'pointercancel' || Date.now() - p.t0 > TAP_MS) return;
    const hit = hitAt(e);
    const now = Date.now();
    const again = now - lastTap.t < 400 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30;
    if (hit) {
      if (hit === canvas.getActiveObject() && hit.enterEditing && lastTap.o === hit && now - lastTap.t < 1500) {
        hit.enterEditing(); // tapping the selected text again: type into it
        hit.selectAll?.();
      } else {
        canvas.setActiveObject(hit);
        renderProps(); renderLayers();
      }
    } else if (again && !lastTap.o) {
      // Double tap on an empty spot: zoom in there, or back to the whole poster.
      if (currentZoom() > fitZoom() * 1.3) { state.zoom = 'fit'; applyZoom(); }
      else zoomAround(Math.min(ZOOM_MAX, currentZoom() * 2.5), e.clientX, e.clientY);
    } else {
      canvas.discardActiveObject();
    }
    lastTap = { o: hit, t: now, x: e.clientX, y: e.clientY };
    canvas.requestRenderAll();
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  // The same gesture's touch events (and the mouse events a tap makes) stay
  // ours too: otherwise Fabric took a tap on a selected box as "start typing".
  window.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) { ownTouch = false; pan = null; return; } // a pinch takes over
    if (ownTouch) e.stopPropagation();
  }, true);
  window.addEventListener('touchmove', (e) => { if (ownTouch && e.touches.length === 1) e.stopPropagation(); }, true);
  window.addEventListener('touchend', (e) => {
    if (!ownTouch) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault(); // no mouse events or click from this tap
    if (!e.touches.length) ownTouch = false;
  }, { capture: true, passive: false });
})();
new ResizeObserver(() => state.zoom === 'fit' && applyZoom()).observe($('#stage'));

/** Give a canvas's memory back now (Safari otherwise frees it late). */
const releaseCanvas = (c) => { if (c) { c.width = 0; c.height = 0; } };

/**
 * Remove text boxes and free their drawing caches straight away. Safari counts
 * every canvas against one limit per tab until it gets round to freeing it;
 * past that limit new images fail ("The object is in an invalid state").
 */
function removeObjects(objs) {
  canvas.remove(...objs);
  for (const o of objs) { releaseCanvas(o._cacheCanvas); o.dispose(); }
}

/** Swap in a new photo, freeing the previous one's canvases. */
function replacePhoto(original, clean) {
  const old = [state.original, state.clean].filter((c) => c && c !== original && c !== clean);
  state.original = original;
  state.clean = clean;
  return () => old.forEach(releaseCanvas); // call once nothing shows the old ones
}

function resetCanvas(w, h) {
  canvas.discardActiveObject();
  removeObjects(canvas.getObjects());
  canvas.setDimensions({ width: w, height: h });
  setTool('select');
}

/* ---------------- History (text objects only) ---------------- */

// Undo history: a snapshot of the text/image boxes per step. A step that also
// changed the photo (wiping an area, restoring an original, placing a new QR
// code or logo) carries a patch with the pixels before and after.
const history = { stack: [], patches: [], index: -1, paused: false };

function serializeObjects() {
  return canvas.getObjects().filter((o) => !o.temp).map((o) => o.toObject(EXTRA_PROPS));
}

function resetHistory() {
  history.stack = [JSON.stringify(serializeObjects())];
  history.patches = [null];
  history.index = 0;
}

function pushHistory(patch = null) {
  if (history.paused) return;
  const snap = JSON.stringify(serializeObjects());
  if (snap === history.stack[history.index] && !patch) return;
  history.stack = history.stack.slice(0, history.index + 1);
  history.patches = history.patches.slice(0, history.index + 1);
  history.stack.push(snap);
  history.patches.push(patch);
  if (history.stack.length > 80) { history.stack.shift(); history.patches.shift(); }
  history.index = history.stack.length - 1;
  markDirty();
}

/** Change part of the photo (state.clean) with `paint()`, returning the before/after patch for the history. */
function patchBackground(box, paint, pad = 0) {
  const x = Math.max(0, Math.floor(box.x0 - pad)); const y = Math.max(0, Math.floor(box.y0 - pad));
  const w = Math.max(1, Math.min(state.clean.width - x, Math.ceil(box.x1 - box.x0 + 2 * pad)));
  const h = Math.max(1, Math.min(state.clean.height - y, Math.ceil(box.y1 - box.y0 + 2 * pad)));
  const g = state.clean.getContext('2d');
  const before = g.getImageData(x, y, w, h);
  paint(g, { x, y, w, h });
  const after = g.getImageData(x, y, w, h);
  state.bgDirty = true;
  setBackground(state.clean);
  return { x, y, before, after };
}

function applyPatch(patch, which) {
  state.clean.getContext('2d').putImageData(patch[which], patch.x, patch.y);
  state.bgDirty = true;
  setBackground(state.clean);
}

async function restoreObjects(objects) {
  history.paused = true;
  canvas.discardActiveObject();
  removeObjects(canvas.getObjects());
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
  const patch = history.patches[history.index];
  if (patch) applyPatch(patch, 'before');
  history.index--;
  await restoreObjects(JSON.parse(history.stack[history.index]));
  markDirty();
}

async function redo() {
  if (history.index >= history.stack.length - 1) return;
  history.index++;
  const patch = history.patches[history.index];
  if (patch) applyPatch(patch, 'after');
  await restoreObjects(JSON.parse(history.stack[history.index]));
  markDirty();
}

// On a phone the layout is locked: a finger moves the poster, never a text
// box by accident (edited text stays where the original was). The pop-up's
// Move / resize unlocks one box until it is deselected.
const TOUCH = matchMedia('(pointer: coarse)').matches;
function applyLock(o) {
  if (!o || o.temp) return;
  const locked = TOUCH && !o.moveUnlocked;
  o.set({ lockMovementX: locked, lockMovementY: locked, lockScalingX: locked, lockScalingY: locked, lockRotation: locked, hasControls: !locked });
}
function relockAll() {
  for (const o of canvas.getObjects()) if (o.moveUnlocked) { o.moveUnlocked = false; applyLock(o); }
}

let textChangeTimer;
canvas.on('object:added', (e) => { applyLock(e.target); pushHistory(); renderLayers(); });
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
canvas.on('selection:updated', () => { for (const o of canvas.getObjects()) if (o.moveUnlocked && o !== canvas.getActiveObject()) { o.moveUnlocked = false; applyLock(o); } renderProps(); renderLayers(); });
canvas.on('selection:cleared', () => { relockAll(); renderProps(); renderLayers(); });

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

// Two scratch canvases reused for every trial rendering while matching fonts
// (hundreds per photo): new canvases each time added up to ~400 MB that Safari
// only freed later, and past its limit images fail. Emptied after each photo.
const scratch = [document.createElement('canvas'), document.createElement('canvas')];
const freeScratch = () => scratch.forEach(releaseCanvas);

/** Share of the letter box that `text` covers when drawn in the editor font at this weight. */
function inkDensity(text, family, weight, fs) {
  const c = scratch[0];
  measureCtx.font = `${weight} ${fs}px "${family}"`;
  const m = measureCtx.measureText(text);
  const w = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight) + 2;
  const h = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) + 2;
  if (w < 3 || h < 3) return 0;
  c.width = w; c.height = h; // resizing also clears it
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
  const src = scratch[0];
  src.width = iw; src.height = ih;
  const sg = src.getContext('2d', { willReadFrequently: true });
  sg.font = measureCtx.font;
  sg.fillText(text, m.actualBoundingBoxLeft, m.actualBoundingBoxAscent);
  const dst = scratch[1];
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
function fitToBox(o, size = null) {
  const { x0, y0, x1, y1 } = o.fitBox;
  const bw = x1 - x0;
  const bh = y1 - y0;
  const ink = inkAt100(o.text, o);
  const n = [...o.text].length;
  const MIN_SPACING = -80; // thousandths of the font size
  // `size`: a paragraph's shared size (see harmoniseBlocks); else the letters' height decides.
  let fs = size || (bh * 100) / Math.max(ink.height, 1);
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

/**
 * Lines of one paragraph or block share one font, weight, colour and size, as
 * in the original, and each kind of text (names, headings, body text) shares
 * one font and weight across the page (see style classes below). Each line's own guess can wobble (bold, then regular, then
 * serif) on small differences; the block takes its majority, counted by
 * characters. A block is rows close above each other, of similar size, the
 * same colour and script (English and Chinese paragraphs stay apart), that
 * line up (left, centre or right edges) or overlap; and items side by side
 * on one row at the same size.
 */
function harmoniseBlocks(items) {
  const rows = items.filter(({ o, line }) => !o.vertical && !line.badge && o.fitBox && o.text.trim());
  const isHan = (text) => {
    const chars = [...text.replace(/\s/g, '')];
    return chars.filter((ch) => /\p{Script=Han}/u.test(ch)).length >= 0.5 * chars.length;
  };
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) || 0);
  // Colour estimates of small dark text wobble (near-black vs dark grey): two
  // dark colours count as the same.
  const sameColour = (a, b, limit) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= limit
    || (Math.max(...a) < 120 && Math.max(...b) < 120);
  const info = rows.map(({ o }) => ({ o, b: o.fitBox, fs: o.fontSize, han: isHan(o.text), c: rgb(o.fill), n: [...o.text.replace(/\s/g, '')].length }));
  const together = (a, b) => {
    if (a.han !== b.han) return false;
    const fs = Math.min(a.fs, b.fs);
    if (!sameColour(a.c, b.c, 90)) return false;
    // Side by side on one row at the same size: items of one kind (the names
    // in a speaker grid), which the original sets in one style.
    // Sizes are compared by the letters' height in the photo here: each line's
    // own font guess can make its size estimate differ by a third.
    const ha = a.b.y1 - a.b.y0; const hb = b.b.y1 - b.b.y0;
    if (Math.abs((a.b.y0 + a.b.y1) / 2 - (b.b.y0 + b.b.y1) / 2) <= 0.35 * Math.min(ha, hb) && Math.max(ha, hb) / Math.min(ha, hb) <= 1.35) {
      return Math.max(a.b.x0, b.b.x0) - Math.min(a.b.x1, b.b.x1) <= 10 * Math.min(ha, hb);
    }
    if (Math.max(a.fs, b.fs) / fs > 1.25) return false;
    const [top, low] = a.b.y0 <= b.b.y0 ? [a, b] : [b, a];
    const gap = low.b.y0 - top.b.y1;
    if (gap < -0.3 * fs || gap > 1.2 * fs) return false;
    const overlap = Math.min(a.b.x1, b.b.x1) - Math.max(a.b.x0, b.b.x0);
    const aligned = Math.abs(a.b.x0 - b.b.x0) <= fs || Math.abs(a.b.x1 - b.b.x1) <= fs
      || Math.abs((a.b.x0 + a.b.x1) / 2 - (b.b.x0 + b.b.x1) / 2) <= fs;
    return aligned || overlap >= 0.5 * Math.min(a.b.x1 - a.b.x0, b.b.x1 - b.b.x0);
  };
  // Union-find over the pairs that belong together.
  const up = info.map((_, i) => i);
  const root = (i) => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; };
  for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) if (together(info[i], info[j])) up[root(i)] = root(j);
  const blocks = new Map();
  info.forEach((x, i) => { const r = root(i); if (!blocks.has(r)) blocks.set(r, []); blocks.get(r).push(x); });
  const majority = (members, key) => {
    const votes = new Map();
    for (const x of members) votes.set(key(x), (votes.get(key(x)) || 0) + x.n);
    return [...votes].sort((a, b) => b[1] - a[1])[0][0];
  };
  // Style classes: blocks of one kind of text across the page (all the names,
  // all the headings, all the body text) share one font and weight. Same
  // script, colour and shape (paragraph or short item), and letters of the
  // same size, measured in one reference font so the comparison doesn't
  // depend on each line's guess.
  const ref = { fontFamily: DEFAULT_FAMILY, fontWeight: 400 };
  for (const x of info) x.ref = ((x.b.y1 - x.b.y0) * 100) / Math.max(1, inkAt100(x.o.text, ref).height);
  const list = [...blocks.values()].map((members) => {
    const refs = members.map((x) => x.ref).sort((a, b) => a - b);
    // Paragraphs (3+ lines, or long lines) are one kind; short items (names, labels) another.
    const para = members.length >= 3 || Math.max(...members.map((x) => x.n)) > 40;
    return { members, para, han: members[0].han, c: rgb(majority(members, (x) => x.o.fill)), ref: refs[refs.length >> 1] };
  });
  // Across the page only near-black counts as "the same dark" (body text,
  // footers and dates are often different dark greys in different fonts).
  const sameKindColour = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= 60
    || (Math.max(...a) < 60 && Math.max(...b) < 60);
  const cls = list.map((_, i) => i);
  const top = (i) => { while (cls[i] !== i) i = cls[i] = cls[cls[i]]; return i; };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      if (a.han === b.han && a.para === b.para && Math.max(a.ref, b.ref) / Math.min(a.ref, b.ref) <= 1.1 && sameKindColour(a.c, b.c)) cls[top(i)] = top(j);
    }
  }
  const classes = new Map();
  list.forEach((blk, i) => { const r = top(i); if (!classes.has(r)) classes.set(r, []); classes.get(r).push(blk); });
  for (const group of classes.values()) {
    const all = group.flatMap((blk) => blk.members);
    const family = majority(all, (x) => x.o.fontFamily);
    // Weight: a paragraph's lines share one. Short items share it only at
    // the same size (within 4%): a bold organisation name above a regular
    // date (中華民國114年) differs by 8%, a label and its value by 11%.
    const paraOf = new Map(group.flatMap((blk) => blk.members.map((x) => [x, blk.para ? blk : null])));
    const weightOf = (x) => {
      const peers = paraOf.get(x) ? paraOf.get(x).members : all.filter((y) => !paraOf.get(y) && Math.max(x.ref, y.ref) / Math.min(x.ref, y.ref) <= 1.04);
      return normalizeWeight(majority(peers, (y) => normalizeWeight(y.o.fontWeight, family)), family);
    };
    const weights = new Map(all.map((x) => [x, weightOf(x)]));
    for (const { members } of group) {
      const fill = majority(members, (x) => x.o.fill);
      for (const x of members) { x.o.set({ fontFamily: family, fontWeight: weights.get(x), fill }); fitToBox(x.o); }
      // One size per block when its lines are nearly the same size already.
      if (members.length < 2) continue;
      // In a paragraph of 3+ lines where most agree, an odd one out was mis-measured.
      const sizes = members.map((x) => x.o.fontSize).sort((a, b) => a - b);
      const size = sizes[sizes.length >> 1];
      const agree = sizes.filter((v) => Math.max(v, size) / Math.min(v, size) <= 1.15).length;
      if (sizes[sizes.length - 1] / sizes[0] <= 1.2 || (members.length >= 3 && agree >= (2 / 3) * members.length)) {
        for (const x of members) fitToBox(x.o, size);
      }
    }
  }
  return [...blocks.values()].map((members) => members.map((x) => x.o));
}

/**
 * A paragraph or block whose lines ended up in one font, weight, size and
 * colour becomes one multi-line text box, edited as a whole. Its lines are
 * stacked (not side by side); line spacing comes from the original baselines,
 * alignment from whichever edges line up (left, centre or right). The first
 * line stays exactly where it was fitted. Returns the objects to add.
 */
function mergeParagraphs(objs, blocks) {
  const out = new Set(objs);
  const med = (vals) => [...vals].sort((a, b) => a - b)[vals.length >> 1];
  const spread = (vals) => Math.max(...vals) - Math.min(...vals);
  for (const block of blocks) {
    if (block.length < 2) continue;
    const rows = [...block].sort((a, b) => a.fitBox.y0 - b.fitBox.y0);
    const f = rows[0];
    const same = rows.every((o) => o.fontFamily === f.fontFamily && Number(o.fontWeight) === Number(f.fontWeight)
      && o.fill === f.fill && Math.abs(o.fontSize - f.fontSize) < 0.01 && !o.vertical && !o.text.includes('\n'));
    // Stacked: each line starts below the previous one's middle.
    const stacked = rows.every((o, i) => i === 0 || o.fitBox.y0 >= (rows[i - 1].fitBox.y0 + rows[i - 1].fitBox.y1) / 2);
    if (!same || !stacked) continue;
    // A wider gap than the usual line spacing starts a new paragraph (a blank line between them).
    const base = rows.map((o) => o.top + BASELINE * o.fontSize); // each fitted line's baseline
    const steps = rows.slice(1).map((o, i) => base[i + 1] - base[i]);
    const usual = med(steps);
    let run = [rows[0]];
    for (let i = 1; i < rows.length; i++) {
      if (rows.length > 2 && steps[i - 1] > 1.35 * usual) { mergeRun(run, out); run = []; }
      run.push(rows[i]);
    }
    mergeRun(run, out);
  }
  return [...out];

  function mergeRun(rows, out) {
    if (rows.length < 2) return;
    const f = rows[0];
    const fs = f.fontSize;
    const charSpacing = med(rows.map((o) => o.charSpacing || 0));
    // A first line that starts further in than the rest: a whole number of
    // characters in (a two-character indent, or the rest of a line led by a
    // heading in another colour) becomes that many full-width spaces;
    // anything else keeps the first line in its own box, where it was.
    // Only when the lines after it are clearly left-aligned (two or more
    // starting together): two centred lines also start at different places.
    let indent = '';
    const rest = rows.slice(1);
    const restLefts = rest.map((o) => o.left);
    const inset = f.left - med(restLefts);
    const leftAligned = rest.length >= 2 && spread(restLefts) <= 0.3 * fs && spread(restLefts) < spread(rest.map((o) => o.left + o.width / 2));
    if (inset > 0.5 * fs && leftAligned) {
      const em = fs * (1 + charSpacing / 1000);
      const k = Math.round(inset / em);
      if (k > 12 || Math.abs(inset - k * em) > 0.35 * em) { mergeRun(rest, out); return; }
      indent = '\u3000'.repeat(k);
    }
    const base = rows.map((o) => o.top + BASELINE * fs);
    const steps = rows.slice(1).map((o, i) => base[i + 1] - base[i]);
    const lineHeight = Math.min(3, Math.max(0.5, med(steps) / (1.13 * fs)));
    const placed = indent ? rest : rows; // an indented first line says nothing about the alignment
    const lefts = placed.map((o) => o.left); const rights = placed.map((o) => o.left + o.width); const mids = placed.map((o) => o.left + o.width / 2);
    const align = indent ? 'left' : spread(lefts) <= Math.min(spread(mids), spread(rights)) + 0.3 * fs ? 'left'
      : spread(mids) <= spread(rights) ? 'center' : 'right';
    const union = (key) => ({
      x0: Math.min(...rows.map((o) => o[key].x0)), y0: Math.min(...rows.map((o) => o[key].y0)),
      x1: Math.max(...rows.map((o) => o[key].x1)), y1: Math.max(...rows.map((o) => o[key].y1)),
    });
    const para = newText(indent + rows.map((o) => o.text).join('\n'), {
      fontFamily: f.fontFamily, fontWeight: f.fontWeight, fill: f.fill, fontSize: fs, ocr: true,
      lineHeight, textAlign: align, charSpacing,
    });
    para.initDimensions();
    const left = align === 'left' ? med(lefts) : align === 'center' ? med(mids) - para.width / 2 : med(rights) - para.width;
    para.set({ left, top: f.top, eraseBox: union('eraseBox'), fitBox: union('fitBox'), autoFit: false });
    para.ocrBox = union('ocrBox');
    para.setCoords();
    for (const o of rows) out.delete(o);
    out.add(para);
  }
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

/**
 * A heading in another colour that the reader joined to the line beside it
 * (a red 《大悲觀音伏藏法》 leading a white paragraph line) is split off at the
 * character where the ink colour changes, so each part is painted out and
 * redrawn in its own colour. Without this the red heading stayed in the photo
 * and a white copy of it was drawn next to it.
 */
function splitColourRuns(lines) {
  const out = [];
  const g = state.original.getContext('2d', { willReadFrequently: true });
  const width = (ch) => (/\s/.test(ch) ? 0.3 : /[\u2E80-\uFFEF]/.test(ch) ? 1 : 0.55);
  for (const l of lines) {
    const chars = [...l.text];
    if (l.vertical || l.badge || chars.length < 4) { out.push(l); continue; }
    const x0 = Math.floor(l.bbox.x0); const y0 = Math.floor(l.bbox.y0);
    const w = Math.ceil(l.bbox.x1) - x0; const h = Math.ceil(l.bbox.y1) - y0;
    if (w < 8 || h < 4) { out.push(l); continue; }
    const bg = sampleRing(state.original, l.bbox, 2);
    const { data } = g.getImageData(x0, y0, w, h);
    // Ink colour totals per column: pixels clearly away from the ground.
    const sum = new Float64Array(w * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) < 120) continue;
        sum[x * 4] += data[i]; sum[x * 4 + 1] += data[i + 1]; sum[x * 4 + 2] += data[i + 2]; sum[x * 4 + 3]++;
      }
    }
    const mean = (a, b) => {
      let r = 0; let gg = 0; let bb = 0; let n = 0;
      for (let x = a; x < b; x++) { r += sum[x * 4]; gg += sum[x * 4 + 1]; bb += sum[x * 4 + 2]; n += sum[x * 4 + 3]; }
      return n ? [r / n, gg / n, bb / n, n] : null;
    };
    const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    // How evenly one colour runs through a stretch: ink-weighted mean distance of its columns' colours.
    const spread = (a, b, m) => {
      let d = 0; let n = 0;
      for (let x = a; x < b; x++) { const c = sum[x * 4 + 3]; if (c) { d += dist([sum[x * 4] / c, sum[x * 4 + 1] / c, sum[x * 4 + 2] / c], m) * c; n += c; } }
      return n ? d / n : 0;
    };
    const total = chars.reduce((n, ch) => n + width(ch), 0);
    let best = null; let acc = 0;
    for (let k = 1; k < chars.length; k++) {
      acc += width(chars[k - 1]);
      if (k < 2 || chars.length - k < 2) continue;
      // Only where a heading can end: after a closing bracket or colon, or
      // before an opening bracket. Never inside a word or number (a gradient
      // "2025" is one piece of text).
      if (!/[》」』）】〉〕)\]：:｜|]/.test(chars[k - 1]) && !/[《「『（【〈〔(\[]/.test(chars[k])) continue;
      const xs = Math.round((acc / total) * w);
      const L = mean(0, xs); const R = mean(xs, w);
      if (!L || !R || L[3] < 20 || R[3] < 20) continue;
      const d = dist(L, R);
      if (!best || d > best.d) best = { k, xs, d, L, R };
    }
    if (!best || best.d < 150 || Math.max(spread(0, best.xs, best.L), spread(best.xs, w, best.R)) > best.d / 3) { out.push(l); continue; }
    const cut = x0 + best.xs;
    const part = (a, b, box) => ({ ...l, text: chars.slice(a, b).join('').trim(), bbox: box, charConf: l.charConf?.slice(a, b) });
    out.push(part(0, best.k, { ...l.bbox, x1: cut }), part(best.k, chars.length, { ...l.bbox, x0: cut }));
  }
  return out.filter((l) => l.text);
}

/**
 * One copy of the photo with every date's badge disc painted in the date's
 * background colour (one copy for all dates: a full-size canvas is 17 MB, and
 * iPhone Safari caps the canvas memory a page may hold). Release it with
 * releaseCanvas when done.
 */
function withoutDiscs(src, lines) {
  const c = cloneCanvas(src);
  const g = c.getContext('2d');
  for (const line of lines) {
    const bg = sampleRing(src, line.bbox, 2);
    g.fillStyle = `rgb(${bg.join(',')})`;
    g.beginPath();
    g.arc(line.disc.cx, line.disc.cy, line.disc.r * 1.08, 0, 2 * Math.PI);
    g.fill();
  }
  return c;
}

async function convertLines(lines) {
  // Fit new text to the letters themselves, not to the OCR box around them.
  // A date with a weekday badge beside it is measured with the badge's disc
  // painted out, so the disc doesn't count as part of its letters.
  const dated = lines.filter((l) => l.disc);
  const noDiscs = dated.length ? withoutDiscs(state.original, dated) : null;
  const fitted = lines.map((l) => {
    const src = l.disc ? noDiscs : state.original;
    const han = [...l.text].filter((ch) => /\p{Script=Han}/u.test(ch)).length;
    const known = l.badge ? hexOf(l.badge.ink) : l.panel ? hexOf(l.panel.text) : null;
    const bbox = inkBounds(src, l.bbox, { vertical: l.vertical, color: known, cjk: han >= 0.5 * [...l.text.replace(/\s/g, '')].length });
    return { ...l, src, bbox };
  });
  splitStackedLines(fitted);
  for (const l of fitted) l.mask = l.vertical ? null : letterMask(l.src, l.bbox);
  // Every candidate font needs these characters loaded before comparing shapes.
  const allText = fitted.map((l) => l.text).join('');
  await Promise.all(MATCH_FAMILIES.map(loadFontCss));
  await Promise.allSettled(MATCH_FAMILIES.flatMap((f) => weightsOf(f).map((w) => document.fonts.load(`${w} 40px "${f}"`, allText))));
  const built = fitted.map((l) => textFromLine(l, l.badge ? hexOf(l.badge.ink) : l.panel ? hexOf(l.panel.text) : textColorByContrast(l.src, l.bbox, l.vertical)));
  await ensureFontsLoaded(built.map((b) => b.obj));
  built.forEach((b) => b.fit(b.obj));
  const blocks = harmoniseBlocks(built.map((b, i) => ({ o: b.obj, line: fitted[i] })));
  built.forEach((b, i) => {
    b.obj.ocrBox = fitted[i].bbox; // for checking the fit; not saved
    const e = lines[i].bbox;
    b.obj.set('eraseBox', { x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1 });
  });
  const g = state.clean.getContext('2d');
  for (const l of lines) if (!l.badge) eraseText(state.clean, l.bbox, 2, l.panel ? { bg: l.panel.fill, fg: l.panel.text } : null);
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
  releaseCanvas(noDiscs);
  freeScratch();
  return mergeParagraphs(built.map((b) => b.obj), blocks);
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
 * A short reading with no Chinese in it, among busy artwork: usually carvings,
 * ornaments or foliage that the reader took for letters or digits. A real
 * number or word on a poster sits on plain or smoothly shaded ground.
 */
function looksLikePattern(line, lines) {
  const chars = [...line.text.replace(/\s/g, '')];
  if (chars.length > 6 || chars.some((ch) => /\p{Script=Han}/u.test(ch))) return false;
  return busyAround(state.original, line.bbox, lines.filter((o) => o !== line).map((o) => o.bbox)) > 0.1;
}

// Enclosed numbers and characters (④, ㊁): printed on a disc or in a ring.
const ENCLOSED = /[\u2460-\u24FF\u2776-\u2793\u3251-\u325F\u3280-\u32BF]/u;

// Labels that introduce a row of logos ("主辦單位", "Organizers", "Media Partners").
const LOGO_LABEL = /主辦|協辦|承辦|合辦|指導|贊助|支持|合作|夥伴|媒體|organi[sz]er|partner|sponsor|supported|presented by|hosted by/i;

/**
 * Lines in a logo row: below an organiser/partner label, down to about five
 * label-heights or the next heading lined up with the label (主辦單位 …
 * 活動地點), whichever comes first. The labels themselves stay ordinary text.
 */
function logoLines(lines) {
  const flat = lines.filter((l) => !l.vertical);
  const labels = flat.filter((l) => LOGO_LABEL.test(l.text) && [...l.text].length <= 30);
  const found = new Set();
  for (const lab of labels) {
    const h = lab.bbox.y1 - lab.bbox.y0;
    const below = flat.filter((l) => !labels.includes(l) && l.bbox.y0 >= lab.bbox.y1 - 0.3 * h);
    const next = below.filter((l) => l.bbox.y0 > lab.bbox.y1 + h && Math.abs(l.bbox.x0 - lab.bbox.x0) <= h && Math.abs((l.bbox.y1 - l.bbox.y0) / h - 1) < 0.3);
    const stop = Math.min(lab.bbox.y1 + 5 * h, ...next.map((l) => l.bbox.y0));
    for (const l of below) if (l.bbox.y0 < stop) found.add(l);
  }
  return found;
}

/** Open the photo picker; `use(file)` runs once a file is chosen. */
function pickImage(use) {
  const input = $('#slotInput');
  input.value = '';
  input.onchange = () => { const file = input.files[0]; if (file) use(file); };
  input.click();
}

/**
 * Put an image (a new QR code or logo) in `region` as a movable box, fitted
 * inside it and centred. The image is stored at most twice the box's size:
 * sharp in 2× exports, light in saved templates and undo history. With
 * `replacing`, it swaps that image box; otherwise the old picture under the
 * region is painted out (Undo brings it back).
 */
async function placeImage(region, file, replacing = null) {
  const src = await fileToCanvas(file);
  const rw = region.x1 - region.x0; const rh = region.y1 - region.y0;
  const k0 = Math.min(1, (2 * Math.max(rw, rh)) / Math.max(src.width, src.height));
  const c = makeCanvas(Math.max(1, Math.round(src.width * k0)), Math.max(1, Math.round(src.height * k0)));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  releaseCanvas(src);
  const url = c.toDataURL('image/png');
  releaseCanvas(c);
  const img = await fabric.FabricImage.fromURL(url);
  const k = Math.min(rw / img.width, rh / img.height);
  img.set({
    originX: 'left', originY: 'top', scaleX: k, scaleY: k,
    left: region.x0 + (rw - img.width * k) / 2, top: region.y0 + (rh - img.height * k) / 2,
    slot: { x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1 },
  });
  // One step for Undo: the old picture painted out and the new image box added.
  history.paused = true;
  let patch = null;
  if (replacing) canvas.remove(replacing);
  else patch = patchBackground(region, () => eraseBox(state.clean, region, 0));
  canvas.add(img);
  history.paused = false;
  pushHistory(patch);
  canvas.setActiveObject(img);
  canvas.requestRenderAll();
  refreshEnabled();
  return { img, patch };
}

/** Run an export with backgroundWithImages(), freeing the copy afterwards. */
async function withImageBackground(run) {
  const bg = backgroundWithImages();
  try { return await run(bg); } finally { if (bg !== state.clean) releaseCanvas(bg); }
}

/** The background with image boxes painted in, for exports that put text over one picture (PDF, PowerPoint, PSD). */
function backgroundWithImages() {
  const imgs = canvas.getObjects().filter((o) => o.type === 'image' && o.visible !== false);
  if (!imgs.length) return state.clean;
  const c = cloneCanvas(state.clean);
  const g = c.getContext('2d');
  for (const o of imgs) {
    g.save();
    g.globalAlpha = o.opacity ?? 1;
    g.transform(...o.calcTransformMatrix());
    g.drawImage(o.getElement(), -o.width / 2, -o.height / 2, o.width, o.height);
    g.restore();
  }
  return c;
}

const unionBox = (lines) => ({
  x0: Math.min(...lines.map((l) => l.bbox.x0)), y0: Math.min(...lines.map((l) => l.bbox.y0)),
  x1: Math.max(...lines.map((l) => l.bbox.x1)), y1: Math.max(...lines.map((l) => l.bbox.y1)),
});

/**
 * One question per logo: its pieces (東蓮覺苑 + TUNG LIN KOK YUEN) touch or
 * nearly touch, while separate logos in a row have a clear gap between them.
 */
function groupLogoPieces(asks) {
  const logos = asks.filter((a) => a.kind === 'logo');
  const groups = [];
  for (const a of logos) {
    const l = a.lines[0];
    const h = Math.min(l.bbox.y1 - l.bbox.y0, l.bbox.x1 - l.bbox.x0);
    const near = (g) => g.lines.some((m) => {
      const gap = Math.max(m.bbox.x0 - l.bbox.x1, l.bbox.x0 - m.bbox.x1, m.bbox.y0 - l.bbox.y1, l.bbox.y0 - m.bbox.y1);
      return gap <= 0.5 * Math.min(h, m.bbox.y1 - m.bbox.y0);
    });
    const hits = groups.filter(near);
    const merged = { kind: 'logo', lines: [l, ...hits.flatMap((g) => g.lines)] };
    for (const g of hits) groups.splice(groups.indexOf(g), 1);
    groups.push(merged);
  }
  return [...asks.filter((a) => a.kind !== 'logo'), ...groups];
}

/**
 * Ask about each doubtful piece of text in turn: a cut-out of the original,
 * what was read, and two big buttons, Keep (as part of the picture) or
 * Convert (to editable text). Returns the lines to convert.
 */
function askKeepOrConvert(items) {
  const dlg = $('#askDialog');
  const snip = $('#askSnip');
  // Each answer, so ← Back can undo it: 'keep', 'convert', or the placed image box.
  const answers = [];
  let i = 0;
  return new Promise((resolve) => {
    const finish = () => {
      dlg.close();
      releaseCanvas(snip);
      resolve(answers.flatMap((a, k) => (a === 'convert' ? items[k].lines : [])));
    };
    const show = () => {
      if (i >= items.length) { finish(); return; }
      const { lines, kind, region } = items[i];
      const byPlace = [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
      $('#askStep').textContent = t('askStep', { i: i + 1, n: items.length });
      $('#askKind').textContent = t(`askKind:${kind}`);
      $('#askHint').textContent = t(`askHint:${kind}`);
      $('#askRead').hidden = Boolean(region);
      $('#askRead').textContent = region ? '' : t('askRead', { text: byPlace.map((l) => l.text).join(' / ') });
      // A picture (QR code, emblem) is kept or swapped for a new image.
      $('#askKeep').textContent = t(region ? 'askKeepImage' : 'askKeep');
      $('#askConvert').textContent = t(region ? 'askImport' : 'askConvert');
      $('#askRest').hidden = i === items.length - 1;
      $('#askBack').hidden = i === 0;
      // The original around the text, with a little margin, at most 640 × 320.
      const b = region || unionBox(lines);
      const m = Math.max(6, 0.4 * Math.min(b.x1 - b.x0, b.y1 - b.y0));
      const x0 = Math.max(0, b.x0 - m); const y0 = Math.max(0, b.y0 - m);
      const x1 = Math.min(state.original.width, b.x1 + m); const y1 = Math.min(state.original.height, b.y1 + m);
      const k = Math.min(640 / (x1 - x0), 320 / (y1 - y0), 4);
      snip.width = Math.round((x1 - x0) * k); snip.height = Math.round((y1 - y0) * k);
      const g = snip.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(state.original, x0, y0, x1 - x0, y1 - y0, 0, 0, snip.width, snip.height);
      if (!dlg.open) dlg.showModal();
    };
    const answer = (a) => { answers[i] = a; i++; show(); };
    $('#askKeep').onclick = () => answer('keep');
    $('#askConvert').onclick = () => {
      const { region } = items[i];
      if (!region) { answer('convert'); return; }
      // Import: on to the next question once an image is chosen (cancelling stays here).
      pickImage(async (file) => {
        const img = await withBusy(t('placingImage'), () => placeImage(region, file));
        if (img) answer(img);
      });
    };
    // Back to the previous question, undoing its answer (an imported image is
    // removed and the original under it put back).
    $('#askBack').onclick = () => {
      if (i === 0) return;
      i--;
      const a = answers.pop();
      if (a && typeof a === 'object') { canvas.remove(a.img); if (a.patch) applyPatch(a.patch, 'before'); }
      show();
    };
    $('#askRest').onclick = finish;
    dlg.oncancel = (e) => { e.preventDefault(); finish(); }; // Esc: keep the rest
    show();
  });
}

/** "Downloading the text reader, first time only: 12 of 46 MB · about 40 s left". */
function downloadLabel({ loaded, total, eta }) {
  const mb = (n) => (n / 1e6).toFixed(0);
  let left = t('ocr:downloadingEstimating');
  if (eta != null && Number.isFinite(eta)) {
    const secs = Math.max(1, Math.round(eta));
    const time = secs < 60 ? t('secondsShort', { s: secs }) : t('minutesShort', { m: Math.floor(secs / 60), s: secs % 60 });
    left = t('ocr:downloadingLeft', { left: time });
  }
  return `${t('ocr:downloading', { done: mb(loaded), total: total ? mb(total) : '…' })} · ${left}`;
}

async function runDetect() {
  if (!state.original) return;
  const existing = canvas.getObjects().filter((o) => o.ocr);
  if (existing.length && !confirm(t('confirmReplace'))) return;
  let asks = [];
  await withBusy(t('detecting'), async () => {
    let lines = await detectText(state.original, {
      onProgress: (m) => setBusy(m.status === 'downloading' ? downloadLabel(m) : `${t(`ocr:${m.status}`).replace(/^ocr:/, '')}…`, typeof m.progress === 'number' ? m.progress : null),
    }).catch((e) => {
      console.error(e);
      // Out of memory keeps its own message (see withBusy).
      throw e?.name === 'InvalidStateError' ? e : new Error(t('errReader'));
    });
    history.paused = true;
    canvas.discardActiveObject();
    removeObjects(existing);
    lines = splitColourRuns(lines);

    // Doubtful pieces are asked about one by one after the rest is converted:
    // - logos and organisation names (a logo row, or read below 50%
    //   confidence: mostly logos and tiny print) — usually best kept;
    // - text on a coloured panel or shape (追根溯源 on its blue box, ④ and ㊁ on discs);
    // - signs, banners and labels inside the artwork, and patterns in it read
    //   as letters (a temple roof's carvings as "15100");
    // - faint, see-through text (a watermark): it can't be painted out cleanly.
    const logos = logoLines(lines);
    for (const l of lines) {
      l.panel = l.badge ? null : panelUnder(state.original, l.bbox);
      // On a shape: a weekday disc (㊁), an enclosed character (第④屆), a panel.
      const onShape = l.badge || ENCLOSED.test(l.text) || l.panel;
      const kind = logos.has(l) ? 'logo'
        : onShape ? 'panel'
          : l.confidence < 50 ? 'unsure'
            : inkContrast(state.original, l.bbox) < 100 ? 'faint'
              : looksLikePattern(l, lines) || looksLikePictureText(inkBounds(state.original, l.bbox, { vertical: l.vertical })) ? 'picture' : null;
      if (kind) asks.push({ lines: [l], kind });
    }
    lines = lines.filter((l) => !asks.some((a) => a.lines.includes(l)));
    asks = groupLogoPieces(asks);
    // Pictures to swap rather than text: QR codes, and the emblem beside each
    // logo's lettering. Readings inside a QR code are noise.
    // Lettering: confident readings only (an emblem read as "空物" is not).
    const lettering = [...lines, ...asks.flatMap((a) => a.lines)].filter((l) => [...l.text].length >= 2 && l.confidence >= 50).map((l) => l.bbox);
    // Already replaced by an image box (Detect text again): don't ask again.
    const slots = canvas.getObjects().filter((o) => o.slot).map((o) => o.slot);
    const replaced = (r) => slots.some((b) => Math.min(b.x1, r.x1) - Math.max(b.x0, r.x0) > 0.5 * (r.x1 - r.x0) && Math.min(b.y1, r.y1) - Math.max(b.y0, r.y0) > 0.5 * (r.y1 - r.y0));
    for (const g of asks.filter((a) => a.kind === 'logo')) {
      const mark = logoMark(state.original, unionBox(g.lines), lettering);
      if (mark && !replaced(mark)) asks.push({ kind: 'logoMark', region: mark, lines: [] });
    }
    for (const qr of findQRCodes(state.original)) {
      const inQR = (l) => { const cx = (l.bbox.x0 + l.bbox.x1) / 2; const cy = (l.bbox.y0 + l.bbox.y1) / 2; return cx > qr.x0 && cx < qr.x1 && cy > qr.y0 && cy < qr.y1; };
      // Confidently read text inside means it isn't a QR code after all: keep everything.
      if (lines.filter((l) => inQR(l) && l.confidence >= 80 && [...l.text].length >= 3).length >= 2) continue;
      lines = lines.filter((l) => !inQR(l));
      asks = asks.filter((a) => !a.lines.length || !a.lines.every(inQR));
      if (!replaced(qr)) asks.push({ kind: 'qr', region: qr, lines: [] });
    }
    const top = (a) => (a.region ? a.region.y0 : Math.min(...a.lines.map((l) => l.bbox.y0)));
    asks.sort((a, b) => top(a) - top(b) || (b.region ? 1 : 0) - (a.region ? 1 : 0));

    const freeOld = replacePhoto(state.original, cloneCanvas(state.original));
      const objs = await convertLines(lines);
    separateLines(objs);
    state.bgDirty = true;
    setBackground(state.clean);
    freeOld();
    if (objs.length) canvas.add(...objs);
    history.paused = false;
    pushHistory();
    renderLayers();
    refreshEnabled();
    const nVertical = lines.filter((l) => l.vertical).length;
    toast(lines.length
      ? `${t(lines.length === 1 ? 'foundOne' : 'foundMany', { n: lines.length })}${nVertical && nVertical < lines.length ? ` ${t('foundVertical', { n: nVertical })}` : ''}`
      : t('noTextFound'), lines.length ? 'ok' : 'warn', 3500);
  });
  const picked = asks.length ? await askKeepOrConvert(asks) : [];
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
/** The selected image box (a new QR code or logo), if that's what is selected. */
const activeImage = () => {
  const o = canvas.getActiveObject();
  return o && o.type === 'image' ? o : null;
};

function renderProps() {
  const o = active();
  const textBox = Boolean(o);
  $('#props').hidden = !textBox;
  $('#noSelection').hidden = Boolean(textBox);
  if (!textBox) { renderQuickEdit(); return; }
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
/** Side panel and pop-up editor share this. A line still filling its original area re-fits to it. */
async function setFont(family) {
  const o = active();
  if (!o) return;
  await loadFontCss(family);
  await updateActive({ fontFamily: family, fontWeight: normalizeWeight(o.fontWeight, family) });
  refitIfAuto(o);
  canvas.requestRenderAll();
  renderProps();
}
$('#propFont').addEventListener('change', (e) => setFont(e.target.value));
$('#qeFont').addEventListener('change', (e) => setFont(e.target.value));
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
  const o = active() || activeImage();
  if (!o || o.isEditing || transforming || comparing || state.tool !== 'select') { box.hidden = true; return; }
  const isImage = o.type === 'image';
  box.classList.toggle('is-image', isImage);
  $('#qeMove').hidden = !TOUCH;
  $('#qeMove').classList.toggle('active', Boolean(o.moveUnlocked));
  $('#qeMove').querySelector('span').textContent = t(o.moveUnlocked ? 'moveDone' : 'moveBox');
  if (isImage) { box.hidden = false; positionQuickEdit(); return; }
  const ta = $('#qeText');
  if (document.activeElement !== ta) ta.value = o.vertical ? fromVertical(o.text) : o.text;
  if (document.activeElement !== $('#qeSize')) $('#qeSize').value = Math.round(o.fontSize * o.scaleY);
  $('#qeColor').value = $('#propColor').value;
  $('#qeFont').value = FONTS[o.fontFamily] ? o.fontFamily : DEFAULT_FAMILY;
  $('#qeBold').setAttribute('aria-pressed', String(isBold(o.fontWeight)));
  $('#qeVertical').setAttribute('aria-pressed', String(Boolean(o.vertical)));
  $('#qeKeep').hidden = !o.eraseBox;
  box.hidden = false;
  positionQuickEdit();
}

function positionQuickEdit() {
  const box = $('#quickEdit');
  const o = active() || activeImage();
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
$('#qeDelete').addEventListener('click', () => { const o = active() || activeImage(); if (o) canvas.remove(o); });
$('#qeKeep').addEventListener('click', () => keepAsPicture(active()));
$('#qeMove').addEventListener('click', () => {
  const o = active() || activeImage();
  if (!o) return;
  o.moveUnlocked = !o.moveUnlocked;
  applyLock(o);
  canvas.requestRenderAll();
  renderQuickEdit();
});
$('#qeReplace').addEventListener('click', () => {
  const o = activeImage();
  if (!o) return;
  const r = o.getBoundingRect();
  pickImage((file) => withBusy(t('placingImage'), () => placeImage(o.slot || { x0: r.left, y0: r.top, x1: r.left + r.width, y1: r.top + r.height }, file, o)));
});

/** Undo the conversion of one line: remove its text box and put the photo's original pixels back. */
function keepAsPicture(o) {
  if (!o || !o.eraseBox || !state.original) return;
  // One step for Undo: the box goes and the original pixels come back.
  history.paused = true;
  const patch = patchBackground(o.eraseBox, (g, r) => g.drawImage(state.original, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h), 6);
  canvas.remove(o);
  history.paused = false;
  pushHistory(patch);
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
  canvas.selection = selecting && !TOUCH; // no box-select on phones (it grabbed several lines at once)
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
  wipeArea({ x0: left, y0: top, x1: left + width, y1: top + height });
});

/**
 * Wipe an area: every text or image box mostly inside it is removed, and the
 * photo there is painted with the colours around it. One step for Undo.
 */
function wipeArea(box) {
  const inside = (o) => {
    const r = o.getBoundingRect();
    const ix = Math.min(r.left + r.width, box.x1) - Math.max(r.left, box.x0);
    const iy = Math.min(r.top + r.height, box.y1) - Math.max(r.top, box.y0);
    return ix > 0 && iy > 0 && ix * iy >= 0.6 * r.width * r.height;
  };
  history.paused = true;
  const gone = canvas.getObjects().filter((o) => !o.temp && inside(o));
  if (gone.length) canvas.remove(...gone);
  const patch = patchBackground(box, () => eraseBox(state.clean, box, 0));
  history.paused = false;
  pushHistory(patch);
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
    const original = await fileToCanvas(file);
    const freeOld = replacePhoto(original, cloneCanvas(original));
    state.originalFile = original.sourceFile || null;
    state.cleanFile = null;
    state.id = crypto.randomUUID();
    state.name = file.name.replace(/\.[^.]+$/, '') || t('untitled');
    state.bgDirty = true;
    state.origDirty = true;
    state.home = null;
    $('#docName').value = state.name;
    resetCanvas(state.original.width, state.original.height);
    setBackground(state.clean);
    freeOld();
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

async function savedBackground() {
  if (!state.bgDirty && state.cleanFile) return state.cleanFile;
  state.cleanFile = await canvasToBlob(state.clean, 'image/jpeg', 0.95);
  return state.cleanFile;
}

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
    // Encoded as few times as possible: the uploaded file is kept as the
    // original, and an unchanged background reuses its last saved copy.
    background: full || state.bgDirty ? await savedBackground() : null,
    original: state.original && (full || state.origDirty) ? state.originalFile || (state.originalFile = await canvasToBlob(state.original, 'image/jpeg', 0.95)) : null,
    updatedAt: new Date().toISOString(),
  };
}

async function save() {
  if (!hasDoc()) return;
  const store = currentStore();
  return await withBusy(t('saving', { where: t(store.whereKey) }), async () => {
    const key = storeKey(store);
    await store.put(await buildRecord({ full: state.home !== key }));
    state.home = key;
    state.bgDirty = false;
    state.origDirty = false;
    state.dirty = false;
    updateTitle();
    toast(t('saved', { where: t(store.whereKey) }), 'ok', 6000);
    confirmOnButton($('#saveBtn'), t('savedShort'));
    return true;
  }) ?? false;
}

/** Close the template (asking to save unsaved changes) and go back to the start. */
async function closeDoc() {
  if (!hasDoc()) return;
  if (state.dirty) {
    const choice = await askToSaveFirst();
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await save())) return; // a failed save keeps the template open
  }
  resetCanvas(800, 600);
  canvas.backgroundImage = null;
  replacePhoto(null, null)();
  Object.assign(state, { id: null, name: '', bgDirty: false, origDirty: false, dirty: false, home: null, originalFile: null, cleanFile: null });
  $('#docName').value = '';
  resetHistory();
  updateTitle();
  refreshEnabled();
  renderLayers();
  renderProps();
  window.scrollTo({ top: 0 });
}

/** Resolves 'save', 'discard' or 'cancel'. */
function askToSaveFirst() {
  const dlg = $('#closeDialog');
  $('#closeText').textContent = t('closeText', { name: state.name || t('untitled') });
  return new Promise((resolve) => {
    const done = (choice) => { dlg.close(); resolve(choice); };
    $('#closeSave').onclick = () => done('save');
    $('#closeDiscard').onclick = () => done('discard');
    $('#closeCancel').onclick = () => done('cancel');
    dlg.oncancel = (e) => { e.preventDefault(); done('cancel'); }; // Esc
    dlg.showModal();
  });
}

/** Show a short confirmation on the button itself ("✓ Saved"), then put it back. */
function confirmOnButton(btn, text) {
  const label = btn.querySelector('[data-i18n]');
  if (!label) return;
  clearTimeout(btn.doneTimer);
  label.textContent = text;
  btn.classList.add('done');
  navigator.vibrate?.([12, 60, 24]); // Android; iPhone browsers don't vibrate for web pages
  btn.doneTimer = setTimeout(() => { btn.classList.remove('done'); label.textContent = t(label.dataset.i18n); }, 3000);
}

async function openRecord(rec, homeKey) {
  const toCanvas = async (blob) => {
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    try { return await urlToCanvas(url); } finally { URL.revokeObjectURL(url); }
  };
  const clean = await toCanvas(rec.background);
  if (!clean) throw new Error(t('errNoBackground'));
  const freeOld = replacePhoto(await toCanvas(rec.original), clean);
  state.originalFile = rec.original || null; // already encoded: saved again as is
  state.cleanFile = rec.background || null;
  state.id = rec.id || crypto.randomUUID();
  state.name = rec.name || t('untitled');
  state.home = homeKey;
  state.bgDirty = !homeKey;
  state.origDirty = !homeKey;
  $('#docName').value = state.name;
  resetCanvas(rec.width || state.clean.width, rec.height || state.clean.height);
  setBackground(state.clean);
  freeOld();
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
      // Delete: a big round bin button (asks first).
      const del = document.createElement('button');
      del.className = 'template-del';
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
      del.title = t('delete');
      del.setAttribute('aria-label', `${t('delete')}: ${tpl.name}`);
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
      await download(await exportRaster(canvas, kind, 0.95, scale), `${base}.${kind === 'jpeg' ? 'jpg' : kind}`);
    } else if (kind === 'pptx') {
      await withImageBackground((bg) => exportPPTX(canvas, bg, state.name)).then((f) => download(f, `${base}.pptx`));
      toast(t('pptxSaved'), 'ok', 8000);
    } else if (kind === 'svg') {
      await download(await exportSVG(canvas), `${base}.svg`);
    } else if (kind === 'pdf') {
      await withImageBackground((bg) => exportPDF(canvas, bg, state.name, (msg) => setBusy(msg))).then((f) => download(f, `${base}.pdf`));
    } else if (kind === 'psd') {
      await withImageBackground((bg) => exportPSD(canvas, bg, state.original)).then((f) => download(f, `${base}.psd`));
      toast(t('psdSaved'), 'ok', 7000);
    } else if (kind === 'json') {
      await download(await recordToFile(await buildRecord({ full: true })), `${base}.template.json`);
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
  for (const sel of [$('#propFont'), $('#qeFont')]) {
    sel.replaceChildren(
      group(t('fontsTaiwan'), MATCH_FAMILIES),
      group(t('fontsOther'), Object.keys(FONTS).filter((f) => !MATCH_FAMILIES.includes(f))),
    );
    if (font) sel.value = font;
  }
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
  $('#eraseBtn').addEventListener('click', () => {
    setTool(state.tool === 'erase' ? 'select' : 'erase');
    if (state.tool === 'erase') toast(t('eraseHint'), 'info', 5000);
    // On phones the panel is under the photo: bring the photo up to drag on.
    if (state.tool === 'erase' && matchMedia('(max-width: 760px)').matches) $('#stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#saveBtn').addEventListener('click', save);
  $('#closeBtn').addEventListener('click', closeDoc);
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && (active() || activeImage())) { e.preventDefault(); canvas.remove(active() || activeImage()); }
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

// Offline support (sw.js): after the first use, the app and its text reader
// open without a connection. Also ask the phone to keep that storage.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => navigator.storage?.persist?.()).catch(() => {});
  // The text reader waits (up to 5 s) for the worker to take over this page,
  // so even the first download of its 46 MB is stored for offline use.
  self.templateMakerOffline = navigator.serviceWorker.controller ? Promise.resolve() : new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
    setTimeout(resolve, 5000);
  });
  // The worker adds the headers that let the text reader use several cores
  // (see sw.js); they apply from the next page load. On the first visit,
  // reload once as soon as the worker takes over, unless a photo is open.
  const isolateOnce = () => {
    if (self.crossOriginIsolated || hasDoc() || !$('#busy').hidden || document.querySelector('dialog[open]') || sessionStorage.getItem('tm-isolated')) return;
    try { sessionStorage.setItem('tm-isolated', '1'); } catch { return; }
    location.reload();
  };
  self.templateMakerIsolate = isolateOnce; // tried again when the intro closes
  if (navigator.serviceWorker.controller) isolateOnce();
  else navigator.serviceWorker.addEventListener('controllerchange', isolateOnce, { once: true });
}
}

init();

/* ---------------- Install on Home Screen ---------------- */

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const PLATFORM = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios'
  : /Android/i.test(navigator.userAgent) ? 'android' : 'desktop';
// Chrome and Edge offer their own install prompt; keep it for "Install now".
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; installPrompt = null; });

/** Step-by-step pictures for this phone (Share → View More → Add to Home Screen on iPhone). */
function showInstall() {
  const dlg = $('#installDialog');
  dlg.querySelectorAll('.install-steps').forEach((ol) => { ol.hidden = ol.dataset.for !== PLATFORM; });
  $('#installNow').hidden = !installPrompt;
  $('#installOk').hidden = Boolean(installPrompt);
  dlg.showModal();
}
$('#installBtn').hidden = standalone();
$('#installBtn').addEventListener('click', showInstall);
$('#installLater').addEventListener('click', () => $('#installDialog').close());
$('#installOk').addEventListener('click', () => $('#installDialog').close());
$('#installNow').addEventListener('click', async () => {
  $('#installDialog').close();
  const prompt = installPrompt;
  installPrompt = null;
  if (prompt) { prompt.prompt(); await prompt.userChoice.catch(() => {}); }
});
// First visit only (after the intro), never over a photo being loaded.
function maybeShowInstall() {
  if (standalone() || hasDoc() || !$('#busy').hidden || document.querySelector('dialog[open]')) return;
  try { if (localStorage.getItem('tm-install-shown')) return; localStorage.setItem('tm-install-shown', '1'); } catch { return; }
  showInstall();
}

/* ---------------- First-visit intro (swipe cards) ---------------- */

const introCards = () => [...$('#introTrack').children];
function introIndex() {
  const track = $('#introTrack');
  return Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
}
function renderIntroNav() {
  const i = introIndex();
  const last = i >= introCards().length - 1;
  $('#introDots').querySelectorAll('i').forEach((d, k) => d.classList.toggle('on', k === i));
  $('#introNext').textContent = t(last ? 'introStart' : 'introNext');
}
/** `first`: the first visit, which also offers the sample poster. */
function showIntro({ first = false } = {}) {
  const dlg = $('#introDialog');
  $('#introSample').hidden = !first;
  dlg.showModal();
  $('#introTrack').scrollLeft = 0;
  renderIntroNav();
}
function closeIntro() {
  const dlg = $('#introDialog');
  if (!dlg.open) return;
  dlg.close();
  try { localStorage.setItem('tm-intro-seen', '1'); } catch { /* storage blocked */ }
  self.templateMakerIsolate?.();
  setTimeout(maybeShowInstall, 400);
}
$('#introTrack').addEventListener('scroll', () => requestAnimationFrame(renderIntroNav), { passive: true });
$('#introNext').addEventListener('click', () => {
  const i = introIndex();
  if (i >= introCards().length - 1) { closeIntro(); return; }
  $('#introTrack').scrollTo({ left: (i + 1) * $('#introTrack').clientWidth, behavior: 'smooth' });
});
$('#introSkip').addEventListener('click', closeIntro);
$('#introDialog').addEventListener('cancel', (e) => { e.preventDefault(); closeIntro(); });
$('#introSample').addEventListener('click', async () => {
  closeIntro();
  try {
    const blob = await (await fetch('sample/poster.jpg')).blob();
    newFromFile(new File([blob], `${t('sampleName')}.jpg`, { type: 'image/jpeg' }));
  } catch (e) { toast(t('errReadImage'), 'error'); }
});
$('#aboutBtn').addEventListener('click', () => showIntro());
document.addEventListener('langchange', () => { if ($('#introDialog').open) renderIntroNav(); });
setTimeout(() => {
  let seen = true;
  try { seen = Boolean(localStorage.getItem('tm-intro-seen')); } catch { /* storage blocked: skip the intro */ }
  if (!seen && !hasDoc() && $('#busy').hidden) showIntro({ first: true });
  else maybeShowInstall();
}, seenDelay());
function seenDelay() { try { return localStorage.getItem('tm-intro-seen') ? 2500 : 600; } catch { return 2500; } }

// Handy for debugging from the console.
window.templateMaker = { canvas, state, debug: { matchFont, renderedMask, maskSimilarity, inkDensity, guessWeight } };
