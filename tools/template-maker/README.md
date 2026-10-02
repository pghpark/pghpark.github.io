# Template Maker

Turn a photo (menu, poster, sign, flyer…) into a reusable template whose text is
editable, then export it as an image, PDF or layered Photoshop file. Built for
**Traditional Chinese (繁體中文)**, with English mixed in.

Live at **https://pghpark.github.io/tools/template-maker/** once this folder is on
the `master` branch.

Everything runs in the browser: GitHub Pages only serves static files, so
there is no server to maintain.

## What it does

1. **Upload a photo** (button, drag-and-drop, or paste). Large photos are scaled to 2400 px on the long side.
2. **Detect text.** [Tesseract.js](https://github.com/naptha/tesseract.js) reads the text with the
   `chi_tra` + `eng` models (`chi_tra_vert` for vertical text). The spaces Tesseract puts between
   Chinese characters are removed.
3. **Remove the original text.** Each detected line is painted over with colours sampled
   around it. Use **Erase area** to drag over anything it missed.
4. **Edit.** Each line becomes a text box placed and sized over the original, in a colour sampled
   from the photo. Double-click to type on the canvas, or use the side panel (which works well with
   Chinese input methods). You can change the font, bold, size, colour, alignment, line height,
   vertical text (直排) and opacity, plus undo/redo.
5. **Save** to this browser (IndexedDB), or to the cloud once Supabase is set up (below).
6. **Export:**

| Format | Notes |
|---|---|
| PNG / JPEG / WebP | 1×, 2× or 3× scale. |
| PDF | Real, searchable text. The fonts are subset with HarfBuzz to just the characters used, so a page is usually under 100 KB. 1 px = 1 pt. |
| PSD | Layers: hidden original photo, cleaned background, and one **live text layer** per text box (Noto Sans TC / Noto Serif TC, correct size, colour, position and rotation). Photoshop asks to *update text layers* when the file opens. Click **Update**. Install the fonts from [Google Fonts](https://fonts.google.com/noto/specimen/Noto+Sans+TC) first. |
| SVG | Text stays as text and the fonts load from Google Fonts. |
| Template file (.json) | Everything in one file (images inlined), for backup or moving between browsers or accounts. |

## Traditional Chinese details

- **Fonts:** Noto Sans TC and Noto Serif TC at weights 400 and 700, the same files on screen, in the PDF and named in the PSD (`NotoSansTC-Regular`, `NotoSansTC-Bold`, `NotoSerifTC-Regular`, `NotoSerifTC-Bold`).
- **PDF font embedding:** the static TrueType files are fetched from `fonts.gstatic.com`, cut down with HarfBuzz (`harfbuzz-subset.wasm`) and embedded with pdf-lib. Two pdf-lib pitfalls are avoided on purpose:
  - pdf-lib's own `subset: true` drops CJK glyphs.
  - Noto CJK's `locl` feature swaps digits for alternate glyphs that pdf-lib spaces wrongly, so it is turned off.
- **Vertical text:** stored as one character per line, so the PSD and PDF look the same as the canvas. (ag-psd warns that writing true vertical-orientation PSD text can corrupt the file.)
- **Fallback warning:** if Google Fonts can't load, the editor warns instead of quietly exporting in a fallback font.

## OCR accuracy

Tesseract does well on clear printed text, but expect to fix a few characters by hand. In testing
it read 烏龍鮮奶茶 as 局龍魚奶余. Tips:

- Pick a **Layout** that fits the photo: *Scattered text* for posters, *Vertical text* for 直排.
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

A **Sign in for cloud** button then appears. Once you're signed in, **Save** goes to the cloud and
**Open** lists both your cloud and in-browser templates.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css` | Page and layout. No build step. |
| `app.js` | Editor: canvas, OCR → text boxes, panel, undo, erase tool, open/save, export menu. |
| `ocr.js` | Tesseract.js wrapper and clean-up of Chinese results. |
| `imaging.js` | Photo loading, text removal, text-colour estimate. |
| `fonts.js` | Font list, font loading, HarfBuzz subsetting. |
| `export.js` | PNG/JPEG/WebP/SVG/PDF/PSD writers. |
| `storage.js` | IndexedDB and Supabase stores, `.json` template files. |
| `config.js` | Supabase settings (blank = browser-only). |
| `supabase-schema.sql` | One-time database setup. |

Libraries load from jsDelivr with pinned versions: Fabric.js 7.4.0, Tesseract.js 7.0.0,
pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1, ag-psd 31.0.2, harfbuzzjs 1.6.2 and
supabase-js 2.117.2. Check `export.js → textGeometry()` before upgrading Fabric, because it
mirrors Fabric 7's text-baseline maths so the PDF and PSD line up with the canvas.

## Run locally

```sh
cd pghpark.github.io
python3 -m http.server 4000
# open http://localhost:4000/tools/template-maker/
```

(ES modules need `http://`; opening the file directly won't work.)
