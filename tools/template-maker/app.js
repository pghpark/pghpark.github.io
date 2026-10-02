import { detectText, hasCjk, OCR_MODES } from './ocr.js';
import { t, applyI18n, setLang, getLang, LANGS } from './i18n.js';
import {
  fileToCanvas, urlToCanvas, cloneCanvas, eraseBox, estimateTextColor, canvasToBlob,
} from './imaging.js';
import { FONTS, DEFAULT_FAMILY, ensureFontsLoaded, normalizeWeight } from './fonts.js';
import {
  exportRaster, exportSVG, exportPDF, exportPSD, exportPPTX, download, safeFilename, isText,
} from './export.js';
import {
  LocalStore, CloudStore, cloudConfigured, getSupabase, recordToFile, fileToRecord,
} from './storage.js';

// Custom properties saved with each text object.
const EXTRA_PROPS = ['vertical', 'ocr'];
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
  $('#showOriginal').disabled = !state.original;
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

function applyZoom() {
  if (!hasDoc()) return;
  const W = canvas.getWidth();
  const H = canvas.getHeight();
  let z = Number(state.zoom);
  if (state.zoom === 'fit') {
    const stage = $('#stage');
    z = Math.min(1, (stage.clientWidth - 32) / W, (stage.clientHeight - 32) / H);
  }
  z = Math.max(0.05, z);
  canvas.setDimensions({ width: `${W * z}px`, height: `${H * z}px` }, { cssOnly: true });
  canvas.calcOffset();
}
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
canvas.on('object:modified', () => { pushHistory(); renderProps(); });
canvas.on('text:changed', (e) => {
  ensureFontsLoaded([e.target]).then(() => canvas.requestRenderAll());
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

/** Turn an OCR line into a text object sized and placed over the original. */
function textFromLine(line, color) {
  const { x0, y0, x1, y1 } = line.bbox;
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (line.vertical) {
    const chars = [...line.text.replace(/\s+/g, '')];
    const fs = bw / 0.92;
    const lh = Math.min(1.6, Math.max(0.8, bh / (chars.length * fs * 1.13)));
    return {
      obj: newText(chars.join('\n'), {
        fontSize: fs, fill: color, lineHeight: lh, textAlign: 'center', vertical: true, ocr: true,
      }),
      fit: (o) => o.set({ left: x0 + bw / 2 - o.width / 2, top: y0 + bh / 2 - o.height / 2 }),
    };
  }
  // CJK glyphs fill ~92% of the em box; Latin ink is shorter.
  const fs = bh / (hasCjk(line.text) ? 0.92 : 0.75);
  return {
    obj: newText(line.text, { fontSize: fs, fill: color, ocr: true }),
    fit: (o) => {
      // Width is the more reliable signal once the real font is measured.
      if (o.width > 0 && [...line.text].length > 1) {
        const byWidth = o.fontSize * (bw / o.width);
        o.set('fontSize', Math.min(fs * 1.4, Math.max(fs * 0.7, byWidth)));
        o.initDimensions();
      }
      o.set({ left: x0, top: y0 + bh / 2 - o.height / 2 });
      o.setCoords();
    },
  };
}

async function runDetect() {
  if (!state.original) return;
  const existing = canvas.getObjects().filter((o) => o.ocr);
  if (existing.length && !confirm(t('confirmReplace'))) return;
  const mode = $('#ocrMode').value;
  const erase = $('#eraseText').checked;
  await withBusy(t('detecting'), async () => {
    const lines = await detectText(state.original, {
      mode,
      minConfidence: Number($('#minConf').value),
      onProgress: (m) => setBusy(`${t(`ocr:${m.status}`).replace(/^ocr:/, '')}…`, typeof m.progress === 'number' ? m.progress : null),
    });
    history.paused = true;
    canvas.discardActiveObject();
    canvas.remove(...existing);

    const built = lines.map((l) => textFromLine(l, estimateTextColor(state.original, l.bbox)));
    await ensureFontsLoaded(built.map((b) => b.obj));
    built.forEach((b) => b.fit(b.obj));

    state.clean = cloneCanvas(state.original);
    state.eraseUndo = [];
    if (erase) lines.forEach((l) => eraseBox(state.clean, l.bbox, Math.max(3, (l.bbox.y1 - l.bbox.y0) * 0.12)));
    state.bgDirty = true;
    $('#showOriginal').checked = false;
    setBackground(state.clean);

    if (built.length) canvas.add(...built.map((b) => b.obj));
    history.paused = false;
    pushHistory();
    renderLayers();
    refreshEnabled();
    const nVertical = lines.filter((l) => l.vertical).length;
    toast(lines.length
      ? `${t(lines.length === 1 ? 'foundOne' : 'foundMany', { n: lines.length })}${nVertical && nVertical < lines.length ? ` ${t('foundVertical', { n: nVertical })}` : ''}`
      : t('noTextFound'), lines.length ? 'ok' : 'warn');
  });
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
  if (!o) return;
  const ta = $('#propText');
  if (document.activeElement !== ta) ta.value = o.vertical ? fromVertical(o.text) : o.text;
  $('#propFont').value = FONTS[o.fontFamily] ? o.fontFamily : DEFAULT_FAMILY;
  $('#propBold').checked = normalizeWeight(o.fontWeight) === 700;
  $('#propSize').value = Math.round(o.fontSize * o.scaleY);
  $('#propColor').value = typeof o.fill === 'string' && /^#[0-9a-f]{6}$/i.test(o.fill) ? o.fill : new fabric.Color(o.fill).toHex().replace(/^#?/, '#');
  $('#propLine').value = o.lineHeight;
  $('#propVertical').checked = Boolean(o.vertical);
  $('#propOpacity').value = o.opacity ?? 1;
  document.querySelectorAll('[name=align]').forEach((r) => { r.checked = r.value === o.textAlign; });
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
  updateActive({ text: o.vertical ? toVertical(e.target.value) : e.target.value });
});
$('#propFont').addEventListener('change', (e) => updateActive({ fontFamily: e.target.value }));
$('#propBold').addEventListener('change', (e) => updateActive({ fontWeight: e.target.checked ? 700 : 400 }));
$('#propSize').addEventListener('change', (e) => {
  const v = Number(e.target.value);
  if (v > 0) updateActive({ fontSize: v, scaleX: 1, scaleY: 1 });
});
$('#propColor').addEventListener('input', (e) => updateActive({ fill: e.target.value }, { remeasure: false }));
$('#propLine').addEventListener('change', (e) => updateActive({ lineHeight: Number(e.target.value) || 1 }));
$('#propOpacity').addEventListener('input', (e) => updateActive({ opacity: Number(e.target.value) }, { remeasure: false }));
$('#propVertical').addEventListener('change', (e) => {
  const o = active();
  if (!o) return;
  const plain = o.vertical ? fromVertical(o.text) : o.text.replace(/\n/g, '');
  updateActive(e.target.checked
    ? { vertical: true, text: toVertical(plain), textAlign: 'center' }
    : { vertical: false, text: plain, textAlign: 'left' });
  renderProps();
});
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
  eraseBox(state.clean, box, 0);
  state.bgDirty = true;
  markDirty();
  $('#showOriginal').checked = false;
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
  if ($('#autoDetect').checked) runDetect();
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
  $('#showOriginal').checked = false;
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
  if ($('#showOriginal').checked) { $('#showOriginal').checked = false; setBackground(state.clean); }
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

const FONT_LABELS = { 'Noto Sans TC': 'fontSans', 'Noto Serif TC': 'fontSerif' };

/** Dropdowns whose option text comes from code rather than index.html. */
function renderOptions() {
  const mode = $('#ocrMode').value;
  $('#ocrMode').replaceChildren(...Object.entries(OCR_MODES).map(([k, v]) => new Option(t(v.labelKey), k)));
  if (mode) $('#ocrMode').value = mode;
  const font = $('#propFont').value;
  $('#propFont').replaceChildren(...Object.keys(FONTS).map((f) => new Option(FONT_LABELS[f] ? t(FONT_LABELS[f]) : f, f)));
  if (font) $('#propFont').value = font;
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
  $('#showOriginal').addEventListener('change', (e) => setBackground(e.target.checked ? state.original : state.clean));
  $('#zoom').addEventListener('change', (e) => { state.zoom = e.target.value; applyZoom(); });
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
window.templateMaker = { canvas, state };
