// Exporters: PNG / JPEG / WebP / SVG / PDF / PSD.
import { fontEntry, fetchFontBytes, subsetFont, ensureFontsLoaded, normalizeWeight, FONTS } from './fonts.js';
import { canvasToBlob } from './imaging.js';
import { t } from './i18n.js';

export const isText = (o) => o && typeof o.text === 'string' && o.visible !== false;

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
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
export function textGeometry(obj) {
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

export async function exportRaster(canvas, format, quality = 0.92, multiplier = 1) {
  await prepare(canvas);
  const el = canvas.toCanvasElement(multiplier);
  return canvasToBlob(el, `image/${format}`, quality);
}

export async function exportSVG(canvas) {
  await prepare(canvas);
  const families = Object.keys(FONTS).map((f) => `family=${f.replace(/ /g, '+')}:wght@400;700`).join('&amp;');
  const fontCss = `<style>@import url('https://fonts.googleapis.com/css2?${families}&amp;display=block');</style>`;
  let svg = canvas.toSVG();
  svg = svg.includes('<defs>') ? svg.replace('<defs>', `<defs>\n${fontCss}`) : svg.replace(/(<svg[^>]*>)/, `$1\n${fontCss}`);
  return new Blob([svg], { type: 'image/svg+xml' });
}

/** Searchable PDF: photo background + real text in embedded, subsetted fonts. 1 px = 1 pt. */
export async function exportPDF(canvas, background, name, onProgress = () => {}) {
  const texts = await prepare(canvas);
  const { PDFDocument, rgb, degrees } = PDFLib;
  const W = canvas.getWidth();
  const H = canvas.getHeight();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(name || 'Template');
  doc.setCreator('Template Maker');
  const page = doc.addPage([W, H]);

  onProgress(t('encodingBackground'));
  const bg = await doc.embedJpg(await (await canvasToBlob(background, 'image/jpeg', 0.92)).arrayBuffer());
  page.drawImage(bg, { x: 0, y: 0, width: W, height: H });

  // One embedded font per family+weight, cut down to the characters used.
  const groups = new Map();
  for (const o of texts) {
    const key = `${o.fontFamily}|${normalizeWeight(o.fontWeight)}`;
    if (!groups.has(key)) groups.set(key, { family: o.fontFamily, weight: o.fontWeight, text: '' });
    groups.get(key).text += o.text;
  }
  const fonts = new Map();
  for (const [key, g] of groups) {
    onProgress(t('downloadingFont', { font: `${g.family} ${normalizeWeight(g.weight)}` }));
    const bytes = await fetchFontBytes(g.family, g.weight);
    const sub = await subsetFont(bytes, g.text);
    // locl:false — Noto CJK's locl swaps digits to alternate glyphs in Latin runs,
    // which pdf-lib then spaces incorrectly.
    fonts.set(key, await doc.embedFont(sub, { features: { locl: false } }));
  }

  for (const o of texts) {
    const font = fonts.get(`${o.fontFamily}|${normalizeWeight(o.fontWeight)}`);
    const g = textGeometry(o);
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
  return new Blob([buf], { type: 'image/vnd.adobe.photoshop' });
}
