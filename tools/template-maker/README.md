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

## Install on a phone

It installs like an app, without an app store:

- **iPhone / iPad:** open https://pghpark.github.io/tools/template-maker/ in **Safari**, tap **Share** → **Add to Home Screen** → **Add**.
- **Android:** open the same link in **Chrome**, tap **⋮** → **Install app** (or **Add to Home screen**).

It then opens full screen from its icon (範本製作器). Templates saved in the browser are stored per app: on iPhone the Home Screen app keeps its own, separate from Safari's, so save a template again (or export it as .template.json and open it) to have it in both. Files: `manifest.webmanifest` and `icons/`.

## Photo formats

JPG, PNG, WebP, GIF, BMP and AVIF work in every current browser. iPhone **HEIC** photos only open in
Safari. Choosing a photo from an iPhone's library usually converts it to JPG automatically, but dragging a
`.heic` file into Chrome or Edge on a computer won't work, so export it as JPG first. For the best text
detection, use a sharp, well-lit photo taken straight on, with printed (not handwritten) text.

## What it does

1. **Upload a photo** (the **Upload a photo** button, drag-and-drop, or paste). Large photos are scaled to 2400 px on the long side.
2. **Find and read every piece of text** with [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv6 Small (Apache-2.0), running in the browser through ONNX Runtime Web (see *How text is found* below).
3. **Remove the original text** from the background. Only the letter strokes are repainted, from the pixels around them, so artwork behind or next to the text isn't smeared. Hold **Hold to see original** to compare with the untouched photo.
4. **Edit.** Each line becomes a text box whose letters cover the original's: the same letter height, line width (through letter spacing), position, colour and bold/regular weight. Tap a box for the pop-up editor (text, size, colour, bold, vertical, keep as picture, delete), or use the side panel for everything else. The tools (＋ Text, Erase area, Undo, Redo, Zoom) sit in a bar right under the top buttons; on phones it stays at the top of the screen while you scroll. After you correct a misread, the line re-fits itself to the original area. Pinch or Ctrl + scroll to zoom; on a phone, drag the photo with one finger to move around it (a drag that starts on a text box moves the text).
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

- **Taiwan character shapes:** Noto Sans TC, Noto Serif TC, Huninn (粉圓) and Iansui (芫荽) follow Taiwan's Ministry of Education standard character shapes (國字標準字體). Only these are picked automatically. The canvas, text editor, PDF (`/Lang zh-TW`) and PowerPoint (`zh-TW`) are all tagged as Taiwan Traditional Chinese, so browsers and Office apps pick Taiwan forms, including for any fallback font.
- **Fonts:** Noto Sans TC and Noto Serif TC come in Light (300), Regular (400), Bold (700) and Black (900); Huninn and Iansui have one weight. Matching picks regular or bold from stroke coverage, and large lettering (40 px and up) can step on to Black or Light. The same files are used on screen and in the PDF, and named in the PSD (e.g. `NotoSansTC-Black`) and PowerPoint (e.g. `Noto Sans TC Black`).
- **Other character forms** (font menu, labelled, never picked automatically): LXGW WenKai TC, Cactus Classical Serif and Chocolate Classical Sans (inherited forms); Chiron Hei HK, Chiron Sung HK and Chiron GoRound TC (Hong Kong forms); LXGW Marker Gothic (derived from a Japanese font). They draw some characters differently from Taiwan's standard, so use them only when the original clearly does. Every font's stylesheet loads only when it is first used, and only the slices holding the characters shown are downloaded.
- **PDF font embedding:** the static TrueType files are fetched from `fonts.gstatic.com`, cut down with HarfBuzz (`harfbuzz-subset.wasm`) and embedded with pdf-lib. Two pdf-lib pitfalls are avoided on purpose:
  - pdf-lib's own `subset: true` drops CJK glyphs.
  - Noto CJK's `locl` feature swaps digits for alternate glyphs that pdf-lib spaces wrongly, so it is turned off.
  - Some fonts (the Chiron family) subset into a last glyph pdf-lib can't read; those are re-subset keeping the original glyph numbers.
- **Vertical text:** stored as one character per line, so the PSD and PDF look the same as the canvas. (ag-psd warns that writing true vertical-orientation PSD text can corrupt the file.)
- **Fallback warning:** if Google Fonts can't load, the editor warns instead of quietly exporting in a fallback font.

## How text is found

- **Finding and reading text:** PaddleOCR PP-OCRv6 Small (the official ONNX exports, from the pinned npm package `@arcships/light-ocr-model-ppocrv6-small@0.3.4`, served by jsDelivr). On 20 benchmark posters it read 77.1% of characters and 56.2% of lines exactly, against 72.1% and 43.1% for PP-OCRv5 mobile, at a similar download size. A detection model finds every text region, in any layout including vertical; a recognition model then reads each region. Vertical regions are rotated first, as PaddleOCR does. Detection runs twice: once on the whole image at up to about 1.4 megapixels, where display lettering is found whole, and once larger (up to 2400 px) in overlapping 1024 px tiles, which only adds or improves small print. Capping the whole-image pass and tiling the large one keep memory within what phone browsers allow (a phone photo peaks at about 1.15 GB in Chromium, against 2.65 GB before; iPhone Safari closed the tab). One model reads Traditional and Simplified Chinese, English and Japanese, with an 18,709-character dictionary.
- **Taiwan forms:** occasional Simplified outputs (国, 创) are converted with [OpenCC](https://github.com/BYVoid/OpenCC) (Mainland → Taiwan characters, no vocabulary changes); 台 is kept as written.
- **Unreadable areas** (below 50% reading confidence, usually logos or tiny print) are left as in the photo rather than replaced with gibberish.
- **Vertical labels split into single characters** (第④屆) are joined back into one vertical line.
- **Weekday badges** (a character in a filled circle after a date, 01/15 ㊁): the app looks beside each date for a filled disc, reads the character inside it on its own (choosing among 一二三四五六日天), keeps the disc as artwork and makes only the character editable. The date keeps its own reading, minus anything the reader made of the badge.
- **Date slashes:** a thin, long "/" (01/15) that the reader drops is put back when the date has a fifth, slanted mark between month and day.
- **Text inside pictures** (a shop sign, a banner, a sheet of paper someone holds) is spotted by the small plain patch it sits on: the colour around it doesn't run on into the poster's background, and differs from what lies around the text or the patch. On 40 benchmark posters 2.1% of ordinary lines look like that. Because that guess is wrong now and then, the app lists these lines with a tick box each and converts only the ticked ones. Any converted line can be put back as picture with the picture button in the pop-up editor (**↶ Erase** undoes that).
- **Sizing:** each new line is fitted to the original letters' pixel bounds (not the OCR box); vertical columns are measured column by column. Letter height sets the font size, letter spacing absorbs width differences, and bold or regular is chosen by comparing stroke coverage. Text colour is the colour found inside the line that stops at its ends (background and artwork carry on past them), taken from the stroke centres; on the benchmark this raised colour accuracy from 61% to 72% with exact boxes, most for small text on artwork. Overlapping display lettering is shrunk just enough not to collide.
- **Font:** the original letters are compared, shape against shape, with the same text drawn in each library font (Noto Sans TC, Noto Serif TC, Huninn 粉圓, Iansui 芫荽, all Taiwan standard forms), and the closest wins.
- **Fallback:** if PaddleOCR can't load (very old browsers), Tesseract.js is used instead.
- **Download size:** about 60 MB on first use (ONNX Runtime's engine 28 MB, models 31 MB, plus small scripts), then served from the browser's cache. While it downloads, the app shows megabytes done and an estimate of the time left.

## OCR accuracy

Expect to correct a few characters. Hand-lettered titles and stylised characters may be misread (on the reference poster, 屆 is read as 國). Correct the text in the pop-up editor and the line re-fits to the original area.

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
| `paddle.js` | PaddleOCR PP-OCRv6 detection and recognition with ONNX Runtime Web. |
| `ocr.js` | Calls PaddleOCR, with a Tesseract.js fallback. |
| `imaging.js` | Photo loading, text removal, text-colour estimate. |
| `fonts.js` | Font list, font loading, HarfBuzz subsetting. |
| `export.js` | PNG/JPEG/WebP/SVG/PDF/PPTX/PSD writers. |
| `storage.js` | IndexedDB and Supabase stores, `.json` template files. |
| `i18n.js` | Interface text in English (UK) and 繁體中文, and the language switch. |
| `config.js` | Supabase settings (blank = browser-only). |
| `supabase-schema.sql` | One-time database setup. |

Libraries load from jsDelivr with pinned versions: Fabric.js 7.4.0, ONNX Runtime Web 1.30.0, PP-OCRv6 Small models (@arcships/light-ocr-model-ppocrv6-small 0.3.4), opencc-js 1.4.2, Tesseract.js 7.0.0,
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
