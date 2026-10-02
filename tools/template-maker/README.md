# Template Maker

Turn a photo (menu, poster, sign, flyer…) into a reusable template whose text is
editable, then export it as an image, PDF or layered Photoshop file. Built for
**Traditional Chinese (繁體中文)**, with English mixed in.

Live at **https://pghpark.github.io/tools/template-maker/** once this folder is on
the `master` branch.

Everything runs in the browser: GitHub Pages only serves static files, so
there is no server to maintain.

## Languages

The interface is in **English (UK)** or **繁體中文**. Use the **EN | 繁中** toggle next to the app name. The app remembers your choice in that browser. On a first visit it picks Chinese for Chinese-language browsers and English otherwise.

Hover over any setting, tool or export format (or press and hold it on a phone) to see a tooltip explaining what it does, in either language.

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

1. **Upload a photo** (the **Upload a photo** button, drag-and-drop, or paste). Large photos are scaled to 2400 px on the long side.
2. **Find and read every piece of text** with [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv5 (Apache-2.0), running in the browser through ONNX Runtime Web (see *How text is found* below).
3. **Remove the original text** from the background. Only the letter strokes are repainted, from the pixels around them, so artwork behind or next to the text isn't smeared. Hold **Hold to see original** to compare with the untouched photo.
4. **Edit.** Each line becomes a text box whose letters cover the original's: the same letter height, line width (through letter spacing), position, colour and bold/regular weight. Tap a box for the pop-up editor (text, size, colour, bold, vertical, keep as picture, delete), or use the side panel for everything else. After you correct a misread, the line re-fits itself to the original area. Pinch or Ctrl + scroll to zoom.
5. **Save** to this browser (IndexedDB), or to the cloud once Supabase is set up (below).
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

## How text is found

- **Finding and reading text:** PaddleOCR PP-OCRv5 (mobile models, from npm `pdfmarkdown-ppocrv5-models`, served by jsDelivr). A detection model finds every text region, in any layout including vertical; a recognition model then reads each region. Vertical regions are rotated first, as PaddleOCR does. Small photos get a second, enlarged pass that only adds or improves small print (big lettering is taken from the normal-size pass, where it is found whole). One model reads Traditional and Simplified Chinese, English and Japanese, with an 18,384-character dictionary.
- **Taiwan forms:** occasional Simplified outputs (国, 创) are converted with [OpenCC](https://github.com/BYVoid/OpenCC) (Mainland → Taiwan characters, no vocabulary changes); 台 is kept as written.
- **Unreadable areas** (below 50% reading confidence, usually logos or tiny print) are left as in the photo rather than replaced with gibberish.
- **Text inside pictures** (a shop sign, a banner, a sheet of paper someone holds) is spotted by its busy surroundings, or by a small plain patch set inside a busy drawing. Because that guess is wrong now and then, the app lists these lines with a tick box each and converts only the ticked ones. Any converted line can be put back as picture with the picture button in the pop-up editor (**↶ Erase** undoes that).
- **Sizing:** each new line is fitted to the original letters' pixel bounds (not the OCR box); vertical columns are measured column by column. Letter height sets the font size, letter spacing absorbs width differences, and bold or regular is chosen by comparing stroke coverage. Overlapping display lettering is shrunk just enough not to collide.
- **Font:** the original letters are compared, shape against shape, with the same text drawn in each library font (Noto Sans TC, Noto Serif TC, Huninn 粉圓, Iansui 芫荽, all Taiwan standard forms), and the closest wins.
- **Fallback:** if PaddleOCR can't load (very old browsers), Tesseract.js is used instead.
- **Download size:** about 35 MB on first use (ONNX Runtime ~14 MB, models ~21 MB), then cached by the browser.

## OCR accuracy

Expect to correct a few characters. Thin strokes such as the "/" in a stylised date can be missed, and hand-lettered titles may be misread. Correct the text in the pop-up editor and the line re-fits to the original area.

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
| `paddle.js` | PaddleOCR PP-OCRv5 detection and recognition with ONNX Runtime Web. |
| `ocr.js` | Calls PaddleOCR, with a Tesseract.js fallback. |
| `imaging.js` | Photo loading, text removal, text-colour estimate. |
| `fonts.js` | Font list, font loading, HarfBuzz subsetting. |
| `export.js` | PNG/JPEG/WebP/SVG/PDF/PPTX/PSD writers. |
| `storage.js` | IndexedDB and Supabase stores, `.json` template files. |
| `i18n.js` | Interface text in English (UK) and 繁體中文, and the language switch. |
| `config.js` | Supabase settings (blank = browser-only). |
| `supabase-schema.sql` | One-time database setup. |

Libraries load from jsDelivr with pinned versions: Fabric.js 7.4.0, ONNX Runtime Web 1.30.0, PP-OCRv5 models (pdfmarkdown-ppocrv5-models 1.0.0), opencc-js 1.4.2, Tesseract.js 7.0.0,
pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1, ag-psd 31.0.2, PptxGenJS 4.0.1, harfbuzzjs 1.6.2 and
supabase-js 2.117.2. Check `export.js → textGeometry()` before upgrading Fabric, because it
mirrors Fabric 7's text-baseline maths so the PDF and PSD line up with the canvas.

## Releasing changes

Bump the version string in `index.html` (it appears in the import map, `app.js?v=` and `style.css?v=`) whenever you change any file. GitHub Pages lets browsers cache each file for 10 minutes, and the version stamp stops a browser from mixing old and new files. If the app ever fails to start, it shows a message with the error instead of a page that silently does nothing.

## Run locally

```sh
cd pghpark.github.io
python3 -m http.server 4000
# open http://localhost:4000/tools/template-maker/
```

(ES modules need `http://`; opening the file directly won't work.)
