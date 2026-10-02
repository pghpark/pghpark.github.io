// Traditional Chinese fonts used by the editor and every exporter.
//
// - On screen, the browser loads them from Google Fonts (see index.html).
// - PDF export needs the actual font file. These are Google's static
//   TrueType instances (the variable font defaults to the Thin weight, and the
//   CFF-based .otf files break pdf-lib). To refresh the URLs, run:
//     curl "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;700&family=Noto+Serif+TC:wght@400;700"
//   (curl's user agent gets plain .ttf links instead of sliced woff2).
// - PSD export only stores the PostScript name; Photoshop needs the font
//   installed locally (free from fonts.google.com).
import { t } from './i18n.js';

// `forms` is the character standard each family follows:
//   tw        Taiwan Ministry of Education standard forms (國字標準字體)
//   inherited older printing forms (舊字形 / 傳承字形)
//   hk        Hong Kong forms (常用字字形表)
//   jp        shapes derived from a Japanese font
// Only `tw` families are chosen automatically when matching a photo; the others
// are in the font menu, labelled, for when the original clearly uses them.
// `face` is the font's own family name where it differs (PowerPoint uses it).
const GS = 'https://fonts.gstatic.com/s/';
export const FONTS = {
  'Noto Sans TC': {
    forms: 'tw',
    300: { ps: 'NotoSansTC-Light', face: 'Noto Sans TC Light', url: `${GS}notosanstc/v40/-nFuOG829Oofr2wohFbTp9ifNAn722rq0MXz7_6y_Co.ttf` },
    400: { ps: 'NotoSansTC-Regular', url: `${GS}notosanstc/v40/-nFuOG829Oofr2wohFbTp9ifNAn722rq0MXz76Cy_Co.ttf` },
    700: { ps: 'NotoSansTC-Bold', url: `${GS}notosanstc/v40/-nFuOG829Oofr2wohFbTp9ifNAn722rq0MXz70e1_Co.ttf` },
    900: { ps: 'NotoSansTC-Black', face: 'Noto Sans TC Black', url: `${GS}notosanstc/v40/-nFuOG829Oofr2wohFbTp9ifNAn722rq0MXz7wm1_Co.ttf` },
  },
  'Noto Serif TC': {
    forms: 'tw',
    300: { ps: 'NotoSerifTC-Light', face: 'Noto Serif TC Light', url: `${GS}notoseriftc/v37/XLYzIZb5bJNDGYxLBibeHZ0BnHwmuanx8cUaGX8EMOpD.ttf` },
    400: { ps: 'NotoSerifTC-Regular', url: `${GS}notoseriftc/v37/XLYzIZb5bJNDGYxLBibeHZ0BnHwmuanx8cUaGX9aMOpD.ttf` },
    700: { ps: 'NotoSerifTC-Bold', url: `${GS}notoseriftc/v37/XLYzIZb5bJNDGYxLBibeHZ0BnHwmuanx8cUaGX-9N-pD.ttf` },
    900: { ps: 'NotoSerifTC-Black', face: 'Noto Serif TC Black', url: `${GS}notoseriftc/v37/XLYzIZb5bJNDGYxLBibeHZ0BnHwmuanx8cUaGX_zN-pD.ttf` },
  },
  // 粉圓, rounded; by justfont for use in Taiwan (one weight).
  Huninn: {
    forms: 'tw',
    400: { ps: 'Huninn-Regular', url: `${GS}huninn/v9/OpNNnoINg9bQ4xkpjg.ttf` },
  },
  // 芫荽, hard-pen handwriting; Taiwan Ministry of Education character forms (one weight).
  Iansui: {
    forms: 'tw',
    400: { ps: 'Iansui-Regular', url: `${GS}iansui/v14/w8gbH2UoTuUp5bOajQ.ttf` },
  },
  // 霞鶩文楷, brush-like Kai.
  'LXGW WenKai TC': {
    forms: 'inherited',
    400: { ps: 'LXGWWenKaiTC-Regular', url: `${GS}lxgwwenkaitc/v11/w8gDH20td8wNsI3f40DmtXZb48uK.ttf` },
    700: { ps: 'LXGWWenKaiTC-Bold', url: `${GS}lxgwwenkaitc/v11/w8gAH20td8wNsI3f40DmtXZb4_M2Avkp.ttf` },
  },
  // 仙人掌明體, Ming (serif).
  'Cactus Classical Serif': {
    forms: 'inherited',
    400: { ps: 'CactusClassicalSerif-Regular', url: `${GS}cactusclassicalserif/v16/sZlVdQ6K-zJOCzUaS90zMNN-Ep-OoC8dZr0JFuA.ttf` },
  },
  // 朱古力黑體, sans.
  'Chocolate Classical Sans': {
    forms: 'inherited',
    400: { ps: 'ChocolateClassicalSans-Regular', url: `${GS}chocolateclassicalsans/v17/nuFqD-PLTZX4XIgT-P2ToCDudWHHflqUpTpfjWdDPA.ttf` },
  },
  // 昭源黑體 / 宋體 / 圓體.
  'Chiron Hei HK': {
    forms: 'hk',
    400: { ps: 'ChironHeiHK-Regular', url: `${GS}chironheihk/v7/wXK-E3MSr44vpVKPvzqVJaxhp3w7QQhPNY163lJtr18M.ttf` },
    700: { ps: 'ChironHeiHK-Bold', url: `${GS}chironheihk/v7/wXK-E3MSr44vpVKPvzqVJaxhp3w7QQhPNY163lKKqF8M.ttf` },
  },
  'Chiron Sung HK': {
    forms: 'hk',
    400: { ps: 'ChironSungHK-Regular', url: `${GS}chironsunghk/v3/nuFtD_XLTZPpXIpS3-3dhGzHTSilFc8oGNI59hRj9OSt_g.ttf` },
    700: { ps: 'ChironSungHK-Bold', url: `${GS}chironsunghk/v3/nuFtD_XLTZPpXIpS3-3dhGzHTSilFc8oGNI59hRjE-Ot_g.ttf` },
  },
  'Chiron GoRound TC': {
    forms: 'hk',
    400: { ps: 'ChironGoRoundTC-Regular', url: `${GS}chirongoroundtc/v5/tssEAopDbiwZ4xauFDX3yQ3Ywoaj6kNR0yP4oqNo8RKqbBqJHA.ttf` },
    700: { ps: 'ChironGoRoundTC-Bold', url: `${GS}chirongoroundtc/v5/tssEAopDbiwZ4xauFDX3yQ3Ywoaj6kNR0yP4oqNo8RKqix2JHA.ttf` },
  },
  // 霞鶩漫黑, marker-style sans derived from the Japanese Tanugo.
  'LXGW Marker Gothic': {
    forms: 'jp',
    400: { ps: 'LXGWMarkerGothic-Regular', url: `${GS}lxgwmarkergothic/v4/Gg8oN4AaXyDVTi_NlS1-xCtMQxY3lToBjg.ttf` },
  },
};
export const DEFAULT_FAMILY = 'Noto Sans TC';
/** Families the photo matcher may pick on its own (Taiwan standard forms). */
export const MATCH_FAMILIES = Object.keys(FONTS).filter((f) => FONTS[f].forms === 'tw');

const HB_SUBSET_WASM = 'https://cdn.jsdelivr.net/npm/harfbuzzjs@1.6.2/dist/harfbuzz-subset.wasm';

/** Weights a family really has (single-weight families would only get a faked bold). */
export const weightsOf = (family) => Object.keys(FONTS[family] || FONTS[DEFAULT_FAMILY]).filter((k) => /^\d+$/.test(k)).map(Number);

/** The family's own weight closest to `weight` ("bold" counts as 700). */
export function normalizeWeight(weight, family = DEFAULT_FAMILY) {
  const w = weight === 'bold' ? 700 : weight === 'normal' ? 400 : Number(weight) || 400;
  return weightsOf(family).reduce((best, k) => (Math.abs(k - w) < Math.abs(best - w) ? k : best));
}

export const isBold = (weight) => weight === 'bold' || Number(weight) >= 600;

export function fontEntry(family, weight) {
  const fam = FONTS[family] ? family : DEFAULT_FAMILY;
  return FONTS[fam][normalizeWeight(weight, fam)];
}

/** Google Fonts stylesheet URL for these families, all their weights. */
export function fontCssUrl(families = Object.keys(FONTS)) {
  const q = families.filter((f) => FONTS[f]).map((f) => `family=${f.replace(/ /g, '+')}:wght@${weightsOf(f).join(';')}`).join('&');
  return `https://fonts.googleapis.com/css2?${q}&display=swap`;
}

const cssLoaded = new Map();
/**
 * Add a family's @font-face rules the first time it is needed. Only the
 * stylesheet is fetched here; the browser then downloads just the slices of
 * the font that hold the characters actually shown.
 */
export function loadFontCss(family) {
  if (!FONTS[family]) return Promise.resolve();
  if (!cssLoaded.has(family)) {
    cssLoaded.set(family, new Promise((resolve) => {
      const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: fontCssUrl([family]) });
      link.onload = resolve;
      link.onerror = () => { cssLoaded.delete(family); resolve(); };
      document.head.appendChild(link);
    }));
  }
  return cssLoaded.get(family);
}

/**
 * Make sure the browser has the glyphs for these text objects, then re-measure
 * them. Returns the font descriptors that failed to load (e.g. offline), so the
 * caller can warn that the canvas is using a fallback font.
 */
export async function ensureFontsLoaded(objects) {
  const jobs = [];
  const families = new Set(objects.filter((o) => o.text).map((o) => o.fontFamily));
  await Promise.all([...families].map(loadFontCss));
  for (const o of objects) {
    if (!o.text) continue;
    const font = `${normalizeWeight(o.fontWeight, o.fontFamily)} 32px "${o.fontFamily}"`;
    jobs.push(document.fonts.load(font, o.text).then(() => (document.fonts.check(font, o.text) ? null : font), () => font));
  }
  const failed = [...new Set((await Promise.all(jobs)).filter(Boolean))];
  if (failed.length) document.dispatchEvent(new CustomEvent('fontsfailed', { detail: failed }));
  for (const f of families) fabric.cache.clearFontCache(f);
  for (const o of objects) {
    if (!o.text) continue;
    o.initDimensions();
    o.set('dirty', true);
    o.setCoords();
  }
  return failed;
}

const fontBytes = new Map();
export function fetchFontBytes(family, weight) {
  const { url } = fontEntry(family, weight);
  if (!fontBytes.has(url)) {
    fontBytes.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(t('errFontDownload', { status: r.status }));
      return r.arrayBuffer();
    }).catch((e) => { fontBytes.delete(url); throw e; }));
  }
  return fontBytes.get(url);
}

let hbModule;
/**
 * Cut a font down to just the characters in `text` using HarfBuzz.
 * A CJK font is 7–10 MB; the subset is usually a few KB.
 * (pdf-lib's own `subset: true` drops CJK glyphs, so we don't use it.)
 * `retainGids` keeps every glyph's original number (unused ones empty). It is
 * slower and bigger before pdf-lib compresses it, but some fonts (the Chiron
 * family) otherwise produce a last glyph that pdf-lib's fontkit can't read.
 */
export async function subsetFont(fontBuffer, text, { retainGids = false } = {}) {
  hbModule ||= WebAssembly.compileStreaming(fetch(HB_SUBSET_WASM)).catch((e) => { hbModule = null; throw e; });
  const instance = await WebAssembly.instantiate(await hbModule);
  const e = instance.exports;
  const fontPtr = e.malloc(fontBuffer.byteLength);
  new Uint8Array(e.memory.buffer).set(new Uint8Array(fontBuffer), fontPtr);
  const blob = e.hb_blob_create(fontPtr, fontBuffer.byteLength, 2 /* HB_MEMORY_MODE_WRITABLE */, 0, 0);
  const face = e.hb_face_create(blob, 0);
  e.hb_blob_destroy(blob);
  const input = e.hb_subset_input_create_or_fail();
  const unicodes = e.hb_subset_input_unicode_set(input);
  for (const ch of new Set(text + ' ')) e.hb_set_add(unicodes, ch.codePointAt(0));
  e.hb_subset_input_set_flags(input, e.hb_subset_input_get_flags(input) | 1 /* NO_HINTING */ | (retainGids ? 2 /* RETAIN_GIDS */ : 0));
  const sub = e.hb_subset_or_fail(face, input);
  e.hb_subset_input_destroy(input);
  if (!sub) throw new Error(t('errSubset'));
  const outBlob = e.hb_face_reference_blob(sub);
  const ptr = e.hb_blob_get_data(outBlob, 0);
  const out = new Uint8Array(e.memory.buffer).slice(ptr, ptr + e.hb_blob_get_length(outBlob));
  e.hb_blob_destroy(outBlob);
  e.hb_face_destroy(sub);
  e.hb_face_destroy(face);
  return out;
}
