// Exporters: PNG / JPEG / WebP / SVG / PDF / PSD.
import { fontEntry, fetchFontBytes, subsetFont, ensureFontsLoaded, normalizeWeight, fontCssUrl } from './fonts.js';
import { canvasToBlob } from './imaging.js';
import { t } from './i18n.js';

export const isText = (o) => o && typeof o.text === 'string' && o.visible !== false;

/**
 * Hand a finished file to the user. On phones this opens the system share
 * sheet straight away (Save Image, Save to Files, AirDrop…), which is how a
 * phone saves files; a plain download link only opens a preview page there.
 * Safari allows the sheet only within a few seconds of the tap, so after a
 * slow export it asks for one more tap. Computers download as usual.
 */
export async function download(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  const phone = matchMedia('(pointer: coarse)').matches;
  if (phone && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // the sheet was closed
      if (e.name === 'NotAllowedError' && await askToShare(file)) return; // too long since the tap
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** "Your file is ready — Save or share": the tap opens the share sheet. */
function askToShare(file) {
  const dlg = document.querySelector('#shareDialog');
  if (!dlg) return Promise.resolve(false);
  document.querySelector('#shareName').textContent = file.name;
  dlg.showModal();
  return new Promise((resolve) => {
    document.querySelector('#shareYes').onclick = async () => {
      dlg.close();
      try { await navigator.share({ files: [file] }); } catch { /* closed */ }
      resolve(true);
    };
    document.querySelector('#shareNo').onclick = () => { dlg.close(); resolve(true); };
  });
}

export function safeFilename(name) {
  return (name || 'template').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '_').trim().slice(0, 80) || 'template';
}

function colorOf(obj) {
  try {
    const [r, g, b, a] = new fabric.Color(typeof obj.fill === 'string' ? obj.fill : '#000').getSource();
    return { r, g, b, a: a ?? 1 };
  } catch {
    return { r: 0, g: 0, b: 0, a: 1 };
  }
}

/**
 * Where Fabric draws each line of a text object, as baseline points in canvas
 * pixels. Mirrors Text._renderTextCommon / _renderChars in Fabric 7.
 */
function textGeometry(obj) {
  const m = obj.calcTransformMatrix();
  const lines = [];
  let acc = 0;
  for (let i = 0; i < obj._textLines.length; i++) {
    const h = obj.getHeightOfLineImpl(i);
    const baselineY = -obj.height / 2 + acc + h - h * obj._fontSizeFraction;
    const p = fabric.util.transformPoint(new fabric.Point(-obj.width / 2 + obj._getLineLeftOffset(i), baselineY), m);
    lines.push({ text: obj._textLines[i].join(''), x: p.x, y: p.y, localBaseline: baselineY });
    acc += obj.getHeightOfLine(i);
  }
  return {
    lines,
    matrix: m,
    fontSize: obj.fontSize * obj.scaleY,
    // Extra space after each letter, in px (Fabric's charSpacing is 1/1000 em).
    letterSpacing: ((obj.charSpacing || 0) / 1000) * obj.fontSize * obj.scaleY,
    leading: obj._textLines.length ? obj.getHeightOfLine(0) * obj.scaleY : obj.fontSize * obj.scaleY,
    angle: obj.angle || 0,
    color: colorOf(obj),
  };
}

async function prepare(canvas) {
  canvas.discardActiveObject();
  const texts = canvas.getObjects().filter(isText);
  await ensureFontsLoaded(texts);
  canvas.renderAll();
  return texts;
}

// Safari can't make a canvas over 16.7 megapixels (4096 × 4096); a bigger
// export fails or comes out blank, so 2× and 3× stop at that size.
const MAX_CANVAS_AREA = 16777216;

export async function exportRaster(canvas, format, quality = 0.95, multiplier = 1) {
  await prepare(canvas);
  const fit = Math.sqrt(MAX_CANVAS_AREA / (canvas.getWidth() * canvas.getHeight()));
  const el = canvas.toCanvasElement(Math.min(multiplier, fit));
  try {
    return await canvasToBlob(el, `image/${format}`, quality);
  } finally {
    el.width = 0; el.height = 0; // give its memory back now (Safari otherwise frees it late)
  }
}

export async function exportSVG(canvas) {
  await prepare(canvas);
  const used = [...new Set(canvas.getObjects().filter((o) => o.text).map((o) => o.fontFamily))];
  const fontCss = `<style>@import url('${fontCssUrl(used).replace('display=swap', 'display=block').replace(/&/g, '&amp;')}');</style>`;
  let svg = canvas.toSVG();
  svg = svg.includes('<defs>') ? svg.replace('<defs>', `<defs>\n${fontCss}`) : svg.replace(/(<svg[^>]*>)/, `$1\n${fontCss}`);
  return new Blob([svg], { type: 'image/svg+xml' });
}

/** Searchable PDF: photo background + real text in embedded, subsetted fonts. 1 px = 1 pt. */
/** Can pdf-lib's fontkit read every glyph of this font? (See subsetFont.) */
function glyphsReadable(bytes) {
  try {
    const font = fontkit.create(bytes);
    for (let g = 0; g < font.numGlyphs; g++) font.getGlyph(g).cbox; // reading each glyph's box throws on a broken font
    return true;
  } catch {
    return false;
  }
}

export async function exportPDF(canvas, background, name, onProgress = () => {}) {
  const texts = await prepare(canvas);
  const { PDFDocument, rgb, degrees } = PDFLib;
  const W = canvas.getWidth();
  const H = canvas.getHeight();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(name || 'Template');
  doc.setCreator('Template Maker');
  doc.setLanguage('zh-TW');
  const page = doc.addPage([W, H]);

  onProgress(t('encodingBackground'));
  const bg = await doc.embedJpg(await (await canvasToBlob(background, 'image/jpeg', 0.95)).arrayBuffer());
  page.drawImage(bg, { x: 0, y: 0, width: W, height: H });

  // One embedded font per family+weight, cut down to the characters used.
  const groups = new Map();
  for (const o of texts) {
    const key = `${o.fontFamily}|${normalizeWeight(o.fontWeight, o.fontFamily)}`;
    if (!groups.has(key)) groups.set(key, { family: o.fontFamily, weight: o.fontWeight, text: '' });
    groups.get(key).text += o.text;
  }
  const fonts = new Map();
  for (const [key, g] of groups) {
    onProgress(t('downloadingFont', { font: `${g.family} ${normalizeWeight(g.weight, g.family)}` }));
    const bytes = await fetchFontBytes(g.family, g.weight);
    let sub = await subsetFont(bytes, g.text);
    if (!glyphsReadable(sub)) sub = await subsetFont(bytes, g.text, { retainGids: true });
    // locl:false — Noto CJK's locl swaps digits to alternate glyphs in Latin runs,
    // which pdf-lib then spaces incorrectly.
    fonts.set(key, await doc.embedFont(sub, { features: { locl: false } }));
  }

  for (const o of texts) {
    const font = fonts.get(`${o.fontFamily}|${normalizeWeight(o.fontWeight, o.fontFamily)}`);
    const g = textGeometry(o);
    page.pushOperators(PDFLib.setCharacterSpacing(g.letterSpacing));
    for (const line of g.lines) {
      if (!line.text.trim()) continue;
      page.drawText(line.text, {
        x: line.x,
        y: H - line.y,
        size: g.fontSize,
        font,
        color: rgb(g.color.r / 255, g.color.g / 255, g.color.b / 255),
        opacity: g.color.a * (o.opacity ?? 1),
        rotate: degrees(-g.angle),
      });
    }
    page.pushOperators(PDFLib.setCharacterSpacing(0));
  }
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

/**
 * Layered PSD: hidden original photo, cleaned background, one live text layer
 * per text box. Photoshop will ask to "Update" the text layers on open — say yes.
 */
export async function exportPSD(canvas, background, original) {
  const texts = await prepare(canvas);
  const W = canvas.getWidth();
  const H = canvas.getHeight();
  const children = [];
  if (original) children.push({ name: 'Original photo 原圖', hidden: true, canvas: original });
  children.push({ name: 'Background 背景', canvas: background });

  for (const o of texts) {
    const g = textGeometry(o);
    // Photoshop point text is anchored on the first baseline at the alignment edge.
    const align = ['center', 'right'].includes(o.textAlign) ? o.textAlign : 'left';
    const anchorX = { left: -o.width / 2, center: 0, right: o.width / 2 }[align];
    const anchor = fabric.util.transformPoint(new fabric.Point(anchorX, g.lines[0]?.localBaseline ?? 0), g.matrix);
    const rad = (g.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const br = o.getBoundingRect();
    children.push({
      name: o.text.replace(/\s+/g, ' ').slice(0, 40) || 'Text',
      opacity: o.opacity ?? 1,
      left: Math.round(br.left),
      top: Math.round(br.top),
      canvas: o.toCanvasElement(),
      text: {
        text: g.lines.map((l) => l.text).join('\n'),
        transform: [cos, sin, -sin, cos, anchor.x, anchor.y],
        antiAlias: 'smooth',
        style: {
          font: { name: fontEntry(o.fontFamily, o.fontWeight).ps },
          fontSize: g.fontSize,
          tracking: Math.round(o.charSpacing || 0),
          autoLeading: false,
          leading: g.leading,
          fillColor: { r: g.color.r, g: g.color.g, b: g.color.b },
        },
        paragraphStyle: { justification: align },
      },
    });
  }

  const psd = {
    width: W,
    height: H,
    canvas: canvas.toCanvasElement(1),
    imageResources: {
      resolutionInfo: {
        horizontalResolution: 72, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches',
        verticalResolution: 72, verticalResolutionUnit: 'PPI', heightUnit: 'Inches',
      },
    },
    children,
  };
  const buf = agPsd.writePsd(psd, { generateThumbnail: true });
  // Free the copies made here (not the photo and background, which stay in use).
  for (const c of [psd.canvas, ...children.map((ch) => ch.canvas)]) if (c !== original && c !== background) { c.width = 0; c.height = 0; }
  return new Blob([buf], { type: 'image/vnd.adobe.photoshop' });
}

/**
 * PowerPoint (.pptx), the most reliable way into Canva, Google Slides, Keynote
 * and PowerPoint with editable text: one slide the size of the photo, the
 * cleaned background as a picture, and one real text box per text box.
 * Lines are kept exactly as on the canvas (wrapping off, exact line spacing).
 */
export async function exportPPTX(canvas, background, name) {
  const texts = await prepare(canvas);
  const PX = 96; // pixels per inch
  const W = canvas.getWidth();
  const H = canvas.getHeight();
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'TEMPLATE', width: W / PX, height: H / PX });
  pptx.layout = 'TEMPLATE';
  pptx.title = name || 'Template';
  const slide = pptx.addSlide();
  const bg = await canvasToBlob(background, 'image/jpeg', 0.95);
  const bgData = await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(bg);
  });
  slide.addImage({ data: bgData.replace(/^data:/, ''), x: 0, y: 0, w: W / PX, h: H / PX });

  for (const o of texts) {
    const g = textGeometry(o);
    const c = o.getCenterPoint();
    // Unrotated box; a little extra width so a slightly wider substitute font doesn't wrap.
    const w = o.width * o.scaleX;
    const h = o.height * o.scaleY;
    const extra = w * 0.06;
    const align = ['center', 'right'].includes(o.textAlign) ? o.textAlign : 'left';
    const x0 = c.x - w / 2 - (align === 'center' ? extra / 2 : align === 'right' ? extra : 0);
    const hex = [g.color.r, g.color.g, g.color.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    slide.addText(g.lines.map((l) => l.text).join('\n'), {
      x: x0 / PX,
      y: (c.y - h / 2) / PX,
      w: (w + extra) / PX,
      h: h / PX,
      // Light and Black are separate font names in Office; Bold is the bold flag.
      fontFace: fontEntry(o.fontFamily, o.fontWeight).face || o.fontFamily,
      fontSize: g.fontSize * 0.75, // px → pt
      bold: normalizeWeight(o.fontWeight, o.fontFamily) === 700,
      color: hex,
      transparency: Math.round((1 - g.color.a * (o.opacity ?? 1)) * 100),
      align,
      valign: 'top',
      margin: 0,
      wrap: false,
      fit: 'none',
      lineSpacing: g.leading * 0.75, // exact spacing, same as the canvas
      charSpacing: g.letterSpacing * 0.75, // px → pt
      rotate: g.angle,
      lang: 'zh-TW',
    });
  }
  const buf = await pptx.write({ outputType: 'arraybuffer', compression: true });
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}
