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
export const FONTS = {
  'Noto Sans TC': {
    400: { ps: 'NotoSansTC-Regular', url: 'https://fonts.gstatic.com/s/notosanstc/v40/-nFuOG829Oofr2wohFbTp9ifNAn722rq0MXz76Cy_Co.ttf' },
    700: { ps: 'NotoSansTC-Bold', url: 'https://fonts.gstatic.com/s/notosanstc/v40/-nFuOG829Oofr2wohFbTp9ifNAn722rq0MXz70e1_Co.ttf' },
  },
  'Noto Serif TC': {
    400: { ps: 'NotoSerifTC-Regular', url: 'https://fonts.gstatic.com/s/notoseriftc/v37/XLYzIZb5bJNDGYxLBibeHZ0BnHwmuanx8cUaGX9aMOpD.ttf' },
    700: { ps: 'NotoSerifTC-Bold', url: 'https://fonts.gstatic.com/s/notoseriftc/v37/XLYzIZb5bJNDGYxLBibeHZ0BnHwmuanx8cUaGX-9N-pD.ttf' },
  },
};
export const DEFAULT_FAMILY = 'Noto Sans TC';

const HB_SUBSET_WASM = 'https://cdn.jsdelivr.net/npm/harfbuzzjs@1.6.2/dist/harfbuzz-subset.wasm';

export function normalizeWeight(weight) {
  return weight === 'bold' || Number(weight) >= 600 ? 700 : 400;
}

export function fontEntry(family, weight) {
  const fam = FONTS[family] || FONTS[DEFAULT_FAMILY];
  return fam[normalizeWeight(weight)];
}

/**
 * Make sure the browser has the glyphs for these text objects, then re-measure
 * them. Returns the font descriptors that failed to load (e.g. offline), so the
 * caller can warn that the canvas is using a fallback font.
 */
export async function ensureFontsLoaded(objects) {
  const jobs = [];
  const families = new Set();
  for (const o of objects) {
    if (!o.text) continue;
    families.add(o.fontFamily);
    const font = `${normalizeWeight(o.fontWeight)} 32px "${o.fontFamily}"`;
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
      if (!r.ok) throw new Error(`Font download failed (${r.status}): ${url}`);
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
 */
export async function subsetFont(fontBuffer, text) {
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
  e.hb_subset_input_set_flags(input, e.hb_subset_input_get_flags(input) | 1 /* NO_HINTING */);
  const sub = e.hb_subset_or_fail(face, input);
  e.hb_subset_input_destroy(input);
  if (!sub) throw new Error('Font subsetting failed');
  const outBlob = e.hb_face_reference_blob(sub);
  const ptr = e.hb_blob_get_data(outBlob, 0);
  const out = new Uint8Array(e.memory.buffer).slice(ptr, ptr + e.hb_blob_get_length(outBlob));
  e.hb_blob_destroy(outBlob);
  e.hb_face_destroy(sub);
  e.hb_face_destroy(face);
  return out;
}
