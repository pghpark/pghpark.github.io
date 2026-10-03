# Template Maker

Turn a photo (menu, poster, sign, flyer…) into a reusable template whose text is
editable, then export it as an image, PDF or layered Photoshop file. Built for
**Traditional Chinese (繁體中文)**, with English mixed in.

Live at **https://pghpark.github.io/tools/template-maker/** once this folder is on
the `master` branch.

Everything runs in the browser: GitHub Pages only serves static files, so
there is no server to maintain.

## Languages

The interface is in **English (UK)** or **繁體中文**. Use the **EN | 繁中** toggle next to the app name. The app remembers your choice in that browser. It starts in 繁體中文 for everyone (including the first-visit install steps) until English is chosen; `?lang=en` in the link also opens it in English.

Hover over any setting, tool or export format (or press and hold it on a phone) to see a tooltip explaining what it does, in either language.

To send someone the app already in their language, add `?lang=` to the link:

- https://pghpark.github.io/tools/template-maker/?lang=zh (繁體中文)
- https://pghpark.github.io/tools/template-maker/?lang=en (English)

Every interface string, in both languages, is in `i18n.js`.

## Install on a phone

It installs like an app, without an app store:

- **iPhone / iPad:** open https://pghpark.github.io/tools/template-maker/ in **Safari**, tap **Share** (on newer iPhones **•••** first) → **View More** if needed → **Add to Home Screen** → **Add**.
- **Android:** open the same link in **Chrome**, tap **⋮** → **Install app** (or **Add to Home screen**).

On the very first visit, a short intro comes first: four swipe cards (photo → editable template with a before/after of a sample poster, the keep-or-convert questions, export formats, privacy and the one-time 46 MB download), with **Try a sample poster** (first visit only; `sample/poster.jpg`, made up by us, organiser and venue fictional) and **Get started**. **About Template Maker** at the bottom of the panel shows the cards again.

Then the app shows these steps with pictures for the phone in use (with an **Install now** button where Chrome or Edge offer their own prompt). After that, the small **Install on Home Screen** button beside **About Template Maker** at the bottom of the side panel shows them again. Neither appears when the app is already opened from its Home Screen icon.

It then opens full screen from its icon (範本製作器). Templates saved in the browser are stored per app: on iPhone the Home Screen app keeps its own, separate from Safari's, so save a template again (or export it as .template.json and open it) to have it in both. Files: `manifest.webmanifest` and `icons/`.

## Memory on phones

iPhone Safari closes a tab that uses too much memory, and refuses new images once all of a tab's canvases together pass a limit (the error *The object is in an invalid state*). So the app:

- keeps the photo at most 2400 px on its long side on a phone (4096 px on a computer) and draws the editor at 1× (not 3× screen density);
- frees every temporary canvas as soon as it is used (canvases otherwise stay counted until Safari gets round to freeing them: about 450 MB for a 100-line poster before this was fixed), and frees the previous photo, removed text boxes and export copies straight away;
- caps 2× / 3× image exports at 16.7 megapixels, Safari's largest canvas;
- closes the text reader's worker after each photo (see *Offline* below).

If the error still appears, the app says so in plain words (close other tabs, or reopen the app).

## Offline

After the first use, the app works without a connection (`sw.js`, a service worker):

- The app's own files are always checked with the server when online, so updates arrive the next time it opens; the stored copies are used offline.
- The pinned libraries, the text reader (models and ONNX Runtime's engine, about 46 MB) and the fonts used are stored on first use and reused after that. The reader waits up to 5 s for the service worker before its first download, so that download is stored too.
- When a library or model version is upgraded, the old version's stored files are deleted, so storage doesn't grow over time.
- The app asks the browser to keep this storage (`navigator.storage.persist()`); a browser can still clear it when the phone runs out of space, and the app then downloads again.

The text reader runs in a background worker (`reader-worker.js`), so the page keeps responding while a photo is processed. It reads several lines in a row without pausing (the page prepares the next crops while the worker reads; each line is read exactly as on its own), and uses several processor cores when the page is "cross-origin isolated": `sw.js` adds the two headers this needs (`Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`), which GitHub Pages can't send, and on the first visit the page reloads itself once as soon as the service worker takes over (never while a photo is open or loading). Everything the app loads from other sites already uses CORS, which those headers require. The worker is closed after each photo: ONNX Runtime's working memory only grows while it runs, and closing it is the only way to give that (about 300 MB) back to the phone for editing and exporting.

## Photo formats

JPG, PNG, WebP, GIF, BMP and AVIF work in every current browser. iPhone **HEIC** photos only open in
Safari. Choosing a photo from an iPhone's library usually converts it to JPG automatically, but dragging a
`.heic` file into Chrome or Edge on a computer won't work, so export it as JPG first. For the best text
detection, use a sharp, well-lit photo taken straight on, with printed (not handwritten) text.

## What it does

1. **Upload a photo** (the **Upload a photo** button, drag-and-drop, or paste). The name field under the app name (with the pencil) starts as the photo's file name; edit it there, and saving and exporting use that name. Photos keep full detail up to 4096 px on the long side on a computer and 2400 px on a phone (to stay within iPhone Safari's memory; ample for text).
2. **Find and read every piece of text** with [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv6 Small (Apache-2.0), running in the browser through ONNX Runtime Web (see *How text is found* below).
3. **Ask about the doubtful parts**, one at a time, with a cut-out of the original and two big buttons (see *Keep or convert* below). Everything else is converted straight away.
4. **Remove the original text** from the background. Only the letter strokes are repainted, from the pixels around them, so artwork behind or next to the text isn't smeared. A pixel counts as part of a letter when it lies on the blend from the background colour to the text colour (at least a fifth of the way), which includes the soft edges of small letters that used to leave a faint grey haze; the erased area then grows through the faint tint around the letters (up to 4 px, still only blends) so the fill borrows clean background. Artwork in other colours is off that blend and stays. Hold **Hold to see original** to compare with the untouched photo.
5. **Edit.** Each line becomes a text box whose letters cover the original's: the same letter height, line width (through letter spacing), position, colour and bold/regular weight. Lines of one paragraph, and each kind of text across the page (all the names, all the headings, all the body text), get one font and weight, as in the original (see *Consistent fonts* below). Tap a box for the pop-up editor (text, font, size, colour, bold, vertical, delete, and a labelled **Restore original (keep as picture)** button); tap an image box (a new QR code or logo) for **Replace image** and delete, or use the side panel for everything else. The most-used tools (＋ Text, Zoom, Undo, Redo) are large keys in a bar right under the top buttons; on phones it stays at the top of the screen while you scroll. **Wipe an area** (side panel, under *Clean up the photo*) removes things the reader missed or you don't want: drag a box over a stamp, a stray mark or old text, and the text boxes mostly inside it are deleted and the photo there is filled from the colours around it. It is one step for **Undo** (the photo comes back too). On a phone, tapping it scrolls back up to the photo. **Close template** (top bar) goes back to the start screen, first asking **Save / Don’t save / Cancel** if there are unsaved changes. After you correct a misread, the line re-fits itself to the original area.

**Moving around (phones and tablets):** the layout is locked, so text never moves by accident.

- **One finger** always moves the poster, also when it starts on text; a quick flick keeps gliding and slows down.
- **Tap** a text box to select it and open the pop-up editor; **tap it again** to type into it. A press longer than about half a second, or one that moves more than 10 px, is not a tap.
- **Double-tap** an empty spot to zoom in there (2.5×); double-tap again for the whole poster.
- **Pinch** to zoom (Ctrl + scroll on a computer). The Zoom menu goes from **Whole poster** down to 25%.
- **Move / resize** in the pop-up unlocks that one box to drag or resize; **Done moving** (or tapping elsewhere) locks it again.
- **Lock screen** (top left of the poster) is for just looking around: taps and clicks select nothing until **Unlock to edit**; moving and zooming work as usual. **＋ Text** unlocks it.
- **Hold to see original** (top right of the poster) shows the untouched photo while you hold it. On a touch screen it waits a moment before switching, so a scroll that starts on it just scrolls (it used to flash the original in and out). Both buttons stay in reach just under the toolbar while the page scrolls through the poster.

The intro cards (first visit, or **About Template Maker**) include these gestures, and each time the app is opened on a phone or tablet the first poster on screen brings the same list as a short reminder (**Got it**, or **Don’t show for 30 days**). On a computer, text boxes drag and resize as usual.

**Buttons** all look pressable: at least 44 px tall, bold, with a solid edge underneath that they sink onto when pressed (main actions blue, deleting red, the rest outlined).
6. **Save** to this browser (IndexedDB), or to the cloud once Supabase is set up (below). The uploaded photo is kept as the original exactly as it was (no re-compression) when it wasn't resized, and an unchanged background reuses its saved copy, so saving again never degrades the images.
7. **Export:** (image boxes are included in every format)

| Format | Notes |
|---|---|
| PNG / JPEG / WebP | 1×, 2× or 3× scale (up to 16.7 megapixels, Safari's largest canvas). PNG and WebP are exact; JPEG at 95% quality. |
| PowerPoint / Canva (.pptx) | **Best for Canva.** One slide the size of the photo: the cleaned background as a picture, plus a real, editable text box for every text box (same font, size, colour, alignment, rotation and line spacing). It also opens in PowerPoint, Google Slides and Keynote. In Canva, drag the file onto the home page. Canva swaps in a similar font if it doesn't have Noto Sans/Serif TC. |
| PDF | Real, searchable text. The fonts are subset with HarfBuzz to just the characters used, so a page is usually under 100 KB. 1 px = 1 pt. |
| PSD | Layers: hidden original photo, cleaned background, and one **live text layer** per text box (Noto Sans TC / Noto Serif TC, correct size, colour, position and rotation). Photoshop asks to *update text layers* when the file opens. Click **Update**. Install the fonts from [Google Fonts](https://fonts.google.com/noto/specimen/Noto+Sans+TC) first. |
| SVG | Text stays as text and the fonts load from Google Fonts. |
| Template file (.json) | Everything in one file (images inlined), for backup or moving between browsers or accounts. |

On a phone, every export opens the system share sheet (**Save to Files**, **Save Image**, AirDrop, Mail…) instead of a new browser page. Safari only allows that shortly after a tap, so when a slow export (usually PDF) misses that window, a small **Your file is ready** box asks for one more tap. On a computer the file downloads as usual.

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

- **Finding and reading text:** PaddleOCR PP-OCRv6 Small (the official ONNX exports, from the pinned npm package `@arcships/light-ocr-model-ppocrv6-small@0.3.4`, served by jsDelivr). On 20 benchmark posters it read 77.1% of characters and 56.2% of lines exactly, against 72.1% and 43.1% for PP-OCRv5 mobile, at a similar download size. A detection model finds every text region, in any layout including vertical; a recognition model then reads each region. Vertical regions are rotated first, as PaddleOCR does. Detection runs twice: once on the whole image at up to about 1.4 megapixels, where display lettering is found whole, and once larger (up to 2400 px) in overlapping 1024 px tiles, which only adds or improves small print. Capping the whole-image pass and tiling the large one keep memory within what phone browsers allow (a phone photo peaks at about 0.95 GB in Chromium, against 2.65 GB before, when iPhone Safari closed the tab; afterwards it settles at about 0.5 GB). One model reads Traditional and Simplified Chinese, English and Japanese, with an 18,709-character dictionary.
- **Taiwan forms:** occasional Simplified outputs (国, 创) are converted with [OpenCC](https://github.com/BYVoid/OpenCC) (Mainland → Taiwan characters, no vocabulary changes). Characters that are also correct Traditional characters, or common surnames, are kept as read: 台涂余干后里范松谷只冲准系制卷征云丑斗了凶朴 (涂師姐 used to become 塗師姐).
- **Neighbouring columns:** pieces on one row are joined into one line unless each heads its own centred column (a line of clearly different width centred on it just above or below, as in a speaker grid), so "Ven. Tenzin Choidron" and "Zinaida Debenova" stay two names. A doubtful piece (below 50%) is never joined to confident text.
- **Headings in another colour:** a red heading the reader joined to the white line after it (《大悲觀音伏藏法》結合…) is split off where the ink colour changes, so each part is erased and redrawn in its own colour (before, the red heading stayed in the photo and a white copy was drawn beside it). Brackets stay with their own text.
- **Vertical labels split into single characters** (第④屆) are joined back into one vertical line.
- **Weekday badges** (a character in a filled circle after a date, 01/15 ㊁): the app looks beside each date for a filled disc, reads the character inside it on its own (choosing among 一二三四五六日天), keeps the disc as artwork and makes only the character editable. The date keeps its own reading, minus anything the reader made of the badge.
- **Date slashes:** a thin, long "/" (01/15) that the reader drops is put back when the date has a fifth, slanted mark between month and day.

## Keep or convert

After reading, the app asks about each doubtful part in turn: a cut-out of the original, what was read, and two big buttons. **Keep all the rest as picture** (or Esc) ends the questions.

| What | Found by | Buttons |
|---|---|---|
| **Logo or organisation name** | Lines below an organiser/partner label (主辦、協辦、媒體、Organizers、Partners、Sponsors…), down to about five label-heights or the next heading lined up with the label. Pieces of one logo that touch are asked about together. | Keep as picture / Convert to text |
| **Logo graphic** | Shapes standing out from the page within one lettering-height of a logo's lettering, outside confident text. | Keep as it is / Import new image |
| **QR code** | Its three corner squares (runs of dark-light-dark-light-dark in the ratio 1:1:3:1:1 along a row and a column, three of similar size at a right angle), 12 to 72 modules across, with 30–75% dark modules inside. Readings inside it are dropped. A "QR code" with two or more confident readings inside is not one (a paragraph's characters can mimic corner squares). | Keep as it is / Import new image |
| **Text on a coloured box or shape** | Most of the reading box is one colour that differs clearly from just outside and a little further out, with lettering of a third colour (追根溯源 on its blue panel); an enclosed character (第④屆); a weekday disc (㊁). Converted text is measured, coloured and erased against the panel, so the panel stays. | Keep as picture / Convert to text |
| **Hard to read** | Read below 50% confidence (usually logos or tiny print). | Keep as picture / Convert to text |
| **Text inside a picture** | A sign, banner or sheet of paper: the small plain patch it sits on doesn't run on into the poster's background (2.1% of ordinary lines on 40 benchmark posters look like that). Also a short reading (up to 6 characters) with no Chinese in busy artwork: more than 10% of neighbouring pixel pairs around it step clearly in brightness (carvings, ornaments, foliage read as "15100"; printed text sits at 0–7%). | Keep as picture / Convert to text |
| **Faint or see-through text** | The letters stand out weakly from their own box (colour distance under 100; printed text is 160 or more): usually a watermark. It can't be painted out cleanly. | Keep as picture / Convert to text |

**Import new image** opens the photo picker; the image goes in as a movable, resizable box fitted inside the area, stored at most twice the area's size (sharp in 2× exports, light in saved templates), and the old picture under it is painted out (**Undo** brings it back). Any converted line can be put back as picture with **Restore original (keep as picture)** in the pop-up editor.

## Consistent fonts

Each line first gets its own closest font, weight and size. Then:

1. **Blocks:** rows close above each other (gap up to 1.2× the size), of similar size, the same colour and script (English and Chinese paragraphs stay apart), lined up or overlapping, plus items side by side on one row at the same letter height (names in a grid) form a block.
2. **Kinds of text:** blocks of the same script and colour whose letters are the same size, measured in one reference font, are one kind of text across the page (all the names, all the headings, all the body text).
3. Each kind takes its majority font and weight (counted by characters); each block takes its majority colour and, when its lines are nearly the same size (or most of a 3+ line paragraph agrees), one shared size. Letter spacing still matches each line's own width.

4. **One text box per paragraph:** a block whose stacked lines ended up in one font, weight, size and colour becomes one multi-line text box, edited as a whole. Line spacing comes from the original baselines and alignment from whichever edges line up (left, centre or right); the first line stays exactly where it was fitted. Lines that differ in any of these stay separate boxes. A gap more than 1.35× the usual line spacing starts a new paragraph (a blank line stays blank). A first line that starts further in by a whole number of characters (a two-character indent, or the rest of a line after a heading in another colour) gets that many full-width spaces; any other indent keeps the first line in its own box.

Small dark text's colour estimates wobble, so two dark colours count as the same.
- **Sizing:** each new line is fitted to the original letters' pixel bounds (not the OCR box); vertical columns are measured column by column. Letter height sets the font size, letter spacing absorbs width differences, and bold or regular is chosen by comparing stroke coverage. Text colour is the colour found inside the line that stops at its ends (background and artwork carry on past them), taken from the stroke centres; on the benchmark this raised colour accuracy from 61% to 72% with exact boxes, most for small text on artwork. Overlapping display lettering is shrunk just enough not to collide.
- **Font:** the original letters are compared, shape against shape, with the same text drawn in each library font (Noto Sans TC, Noto Serif TC, Huninn 粉圓, Iansui 芫荽, all Taiwan standard forms), and the closest wins.
- **Download size:** about 46 MB on first use (ONNX Runtime's CPU-only engine 14 MB, models 31 MB, plus small scripts; the full ONNX Runtime build's engine is 28 MB because it also carries WebGPU support this app doesn't use), then served from the browser's cache. While it downloads, the app shows megabytes done and an estimate of the time left.

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
| `sw.js` | Service worker: offline use and stored downloads. |
| `paddle.js` | PaddleOCR PP-OCRv6 detection and recognition with ONNX Runtime Web. |
| `reader-worker.js` | Runs the two models in a background worker, closed after each photo. |
| `imaging.js` | Photo loading, text removal, text-colour estimate. |
| `fonts.js` | Font list, font loading, HarfBuzz subsetting. |
| `export.js` | PNG/JPEG/WebP/SVG/PDF/PPTX/PSD writers. |
| `storage.js` | IndexedDB and Supabase stores, `.json` template files. |
| `i18n.js` | Interface text in English (UK) and 繁體中文, and the language switch. |
| `config.js` | Supabase settings (blank = browser-only). |
| `supabase-schema.sql` | One-time database setup. |

Libraries load from jsDelivr with pinned versions: Fabric.js 7.4.0, ONNX Runtime Web 1.30.0 (the CPU-only build, `ort.wasm.min.js`), PP-OCRv6 Small models (@arcships/light-ocr-model-ppocrv6-small 0.3.4), opencc-js 1.4.2,
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
