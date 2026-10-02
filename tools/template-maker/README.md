# Template Maker

Turn a photo (menu, poster, sign, flyer…) into a reusable template whose text is
editable, then export it as an image, PDF or layered Photoshop file. Built for
**Traditional Chinese (繁體中文)**, with English mixed in.

Live at **https://pghpark.github.io/tools/template-maker/** once this folder is on
the `master` branch.

Everything runs in the browser: GitHub Pages only serves static files, so
there is no server to maintain.

## Languages

The interface is in **English (UK)** or **繁體中文**. Use the language menu at the top right. The app remembers your choice in that browser. On a first visit it picks Chinese for Chinese-language browsers and English otherwise.

Every setting and export format has an **(i)** button that explains what it does, in either language.

To send someone the app already in their language, add `?lang=` to the link:

- https://pghpark.github.io/tools/template-maker/?lang=zh (繁體中文)
- https://pghpark.github.io/tools/template-maker/?lang=en (English)

Every interface string, in both languages, is in `i18n.js`.

## Photo formats

JPG, PNG, WebP, GIF, BMP and AVIF work in every current browser. iPhone **HEIC** photos only open in
Safari. Choosing a photo from an iPhone's library usually converts it to JPG automatically, but dragging a
`.heic` file into Chrome or Edge on a computer won't work, so export it as JPG first. For the best text
detection, use a sharp, well-lit photo taken straight on, with printed (not handwritten) text.

## What it does

1. **Upload a photo** (**New template from photo**, drag-and-drop, or paste). Large photos are scaled to 2400 px on the long side.
2. **Detect text.** [Tesseract.js](https://github.com/naptha/tesseract.js) reads the text with the
   `chi_tra` + `eng` models (`chi_tra_vert` for vertical text). The spaces Tesseract puts between
   Chinese characters are removed.
3. **Remove the original text.** Each detected line is painted over with colours sampled
   around it. Use **Erase area** to drag over anything it missed.
4. **Edit.** Each line becomes a text box placed and sized over the original, in a colour sampled
   from the photo. Double-click to type on the canvas, or use the side panel (which works well with
   Chinese input methods). You can change the font, bold, size, colour, alignment, line height,
   vertical text (直排) and opacity, plus undo/redo.
5. **Save template** to this browser (IndexedDB), or to the cloud once Supabase is set up (below).
6. **Export:**

| Format | Notes |
|---|---|
| PNG / JPEG / WebP | 1×, 2× or 3× scale. |
| PowerPoint / Canva (.pptx) | **Best for Canva.** One slide the size of the photo: the cleaned background as a picture, plus a real, editable text box for every text box (same font, size, colour, alignment, rotation and line spacing). It also opens in PowerPoint, Google Slides and Keynote. In Canva, drag the file onto the home page. Canva swaps in a similar font if it doesn't have Noto Sans/Serif TC. |
| PDF | Real, searchable text. The fonts are subset with HarfBuzz to just the characters used, so a page is usually under 100 KB. 1 px = 1 pt. |
| PSD | Layers: hidden original photo, cleaned background, and one **live text layer** per text box (Noto Sans TC / Noto Serif TC, correct size, colour, position and rotation). Photoshop asks to *update text layers* when the file opens. Click **Update**. Install the fonts from [Google Fonts](https://fonts.google.com/noto/specimen/Noto+Sans+TC) first. |
| SVG | Text stays as text and the fonts load from Google Fonts. |
| Template file (.json) | Everything in one file (images inlined), for backup or moving between browsers or accounts. |

## Traditional Chinese details

- **Taiwan character shapes:** Noto Sans TC and Noto Serif TC follow Taiwan's Ministry of Education standard character shapes (國字標準字體). Hong Kong shapes are the separate “HK” families, which aren't used. The canvas, text editor, PDF (`/Lang zh-TW`) and PowerPoint (`zh-TW`) are all tagged as Taiwan Traditional Chinese, so browsers and Office apps pick Taiwan forms, including for any fallback font.
- **Fonts:** Noto Sans TC and Noto Serif TC at weights 400 and 700, the same files on screen, in the PDF and named in the PSD (`NotoSansTC-Regular`, `NotoSansTC-Bold`, `NotoSerifTC-Regular`, `NotoSerifTC-Bold`).
- **PDF font embedding:** the static TrueType files are fetched from `fonts.gstatic.com`, cut down with HarfBuzz (`harfbuzz-subset.wasm`) and embedded with pdf-lib. Two pdf-lib pitfalls are avoided on purpose:
  - pdf-lib's own `subset: true` drops CJK glyphs.
  - Noto CJK's `locl` feature swaps digits for alternate glyphs that pdf-lib spaces wrongly, so it is turned off.
- **Vertical text:** stored as one character per line, so the PSD and PDF look the same as the canvas. (ag-psd warns that writing true vertical-orientation PSD text can corrupt the file.)
- **Fallback warning:** if Google Fonts can't load, the editor warns instead of quietly exporting in a fallback font.

## Auto detect layout

**Auto detect** is the default layout. It reads the photo four ways in parallel workers:
- as horizontal text with Tesseract page modes 3 (auto), 6 (single block) and 11 (sparse text);
- as vertical text with `chi_tra_vert`, mode 5.

It then:
1. keeps the best horizontal reading and the best vertical reading, scored as readable characters × confidence², and uses the better of the two as the base;
2. swaps in confident lines of the other orientation wherever they explain a region better, as long as they don't cut across a much longer line. That way a poster with a vertical title and horizontal details gets both.

It was tuned on synthetic Traditional Chinese poster photos (10 fonts; tilt, perspective, blur, noise, shading and JPEG damage), and the final check used 50 photos that played no part in tuning:

| Character accuracy (F1) | Horizontal | Block | Scattered | Vertical | Mixed | All |
|---|---|---|---|---|---|---|
| **Auto detect** | **71.2** | **92.6** | 72.3 | **74.4** | **74.4** | **77.0** |
| Horizontal text (Tesseract auto) | 62.3 | 86.0 | 52.6 | 0.0 | 58.0 | 51.8 |
| Best fixed mode for each column* | 70.1 | 90.8 | 72.5 | 70.5 | 72.0 | 64.8 |

\* Each column shows whichever fixed mode did best there; the "All" figure is the best fixed mode overall (Scattered text).

The trade-off is speed: about four OCR passes instead of one. Pick a fixed layout when you already know it.

## OCR accuracy

Tesseract does well on clear printed text, but expect to fix a few characters by hand. In testing
it read 烏龍鮮奶茶 as 局龍魚奶余. Tips:

- Leave **Layout** on *Auto detect*, or pick a fixed layout if you know it (faster).
- Straight-on, well-lit, high-resolution photos help a lot.
- Raise **Skip results below confidence** if you get junk boxes.

For much higher accuracy, swap `detectText()` in `ocr.js` for a cloud OCR such as Google Cloud
Vision, Azure Read or a vision LLM. That needs a secret API key, so it must go through a small proxy
(a Supabase Edge Function or Cloudflare Worker). Never put the key in this public repo.

## Turn on cloud saving (Supabase, free tier)

Without this step, templates are saved only in the browser that made them.

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query**: paste [`supabase-schema.sql`](supabase-schema.sql) and click **Run**.
   This creates the `templates` table, a private `template-assets` storage bucket, and
   Row Level Security policies, so each user can only reach their own templates.
3. **Authentication → URL Configuration**: set *Site URL* to
   `https://pghpark.github.io/tools/template-maker/` and add it to *Redirect URLs*. Email sign-in
   (magic link) is on by default.
4. **Project Settings → API**: copy the *Project URL* and the *anon public* key into
   [`config.js`](config.js), then commit.
   The anon key is meant to be public. RLS is what protects the data.
   **Never** commit the `service_role` key.

A **Sign in for cloud** button then appears. Once you're signed in, **Save template** goes to the cloud and
**Open templates** lists both your cloud and in-browser templates.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css` | Page and layout. No build step. |
| `app.js` | Editor: canvas, OCR → text boxes, panel, undo, erase tool, open/save, export menu. |
| `ocr.js` | Tesseract.js wrapper and clean-up of Chinese results. |
| `imaging.js` | Photo loading, text removal, text-colour estimate. |
| `fonts.js` | Font list, font loading, HarfBuzz subsetting. |
| `export.js` | PNG/JPEG/WebP/SVG/PDF/PPTX/PSD writers. |
| `storage.js` | IndexedDB and Supabase stores, `.json` template files. |
| `i18n.js` | Interface text in English (UK) and 繁體中文, and the language switch. |
| `config.js` | Supabase settings (blank = browser-only). |
| `supabase-schema.sql` | One-time database setup. |

Libraries load from jsDelivr with pinned versions: Fabric.js 7.4.0, Tesseract.js 7.0.0,
pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1, ag-psd 31.0.2, PptxGenJS 4.0.1, harfbuzzjs 1.6.2 and
supabase-js 2.117.2. Check `export.js → textGeometry()` before upgrading Fabric, because it
mirrors Fabric 7's text-baseline maths so the PDF and PSD line up with the canvas.

## Run locally

```sh
cd pghpark.github.io
python3 -m http.server 4000
# open http://localhost:4000/tools/template-maker/
```

(ES modules need `http://`; opening the file directly won't work.)
