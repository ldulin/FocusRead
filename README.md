# FocusRead

A Chrome extension for reading papers in a language that isn't your first.

Click any sentence to hear it. Everything else dims so your eye doesn't wander.
Select a word and see what it means. Turn on bilingual mode and every sentence
gets its translation underneath. Works on web pages, and on PDF and Word files
you open in its own reader.

Built for one specific job: getting through dense academic English without
losing your place.

---

## What it does

**Read aloud, one sentence at a time**
Click a sentence and it starts there. Space plays and pauses, `J` and `K` step
forward and back. The word being spoken is highlighted as you hear it. Speech
keeps going to the next sentence unless you tell it not to.

**Stay focused**
Dim everything except the sentence being read, or use a reading ruler that
masks the page above and below it. Adjustable dimming, highlight style and
colour. Optional typography controls: font, size, line spacing, letter and word
spacing, line width, and a warm-paper or dark background.

**Translate what you need, when you need it**
- Select any word or sentence for a popup translation, with a button to hear
  either language read aloud.
- Press `T` to translate the sentence you're on.
- Press `B` for bilingual mode: a translation under every sentence, appearing as
  you scroll rather than all at once.
- Or translate the whole page in one go.

**Open PDFs and Word files**
Drop a `.pdf` or `.docx` into the reader. PDFs get rebuilt into clean prose -
two-column layouts are un-interleaved, running heads and page numbers are
dropped, and words hyphenated across a line break are put back together. All
the reading and translation features work there too. `Original layout` shows the
real pages when you need to see a figure.

---

## Install

It isn't on the Chrome Web Store. Load it yourself:

```bash
git clone <your-fork-url> focus-read
cd focus-read
./scripts/fetch-vendor.sh
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and choose the `focus-read` folder

`fetch-vendor.sh` downloads [pdf.js](https://github.com/mozilla/pdf.js) and
[mammoth.js](https://github.com/mwilliamson/mammoth.js). They aren't committed
here - see [vendor/README.md](vendor/README.md) for why. Everything except the
PDF and Word reader works without them.

---

## Using it

Click the FocusRead icon, then **Start reading this page**. Or press `Alt`+`R`.

| Key | Does |
| --- | --- |
| `Space` | play / pause |
| `J` or `→` | next sentence |
| `K` or `←` | previous sentence |
| `T` | translate this sentence |
| `B` | bilingual mode on/off |
| `F` | cycle focus mode |
| `Esc` | stop, then close |
| `Alt`+`R` | turn FocusRead on/off |
| `Alt`+`P` | play / pause from anywhere |
| `Alt`+`O` | open a PDF or Word file |

Right-click a selection for **Read this aloud** or **Translate this with FocusRead**.

---

## Translation engines

Set this in Settings → Translation. Default is Chrome's built-in engine.

| Engine | Key needed | Cost | Notes |
| --- | --- | --- | --- |
| **Chrome built-in** | no | free | Runs on your machine. Nothing is sent anywhere. Needs Chrome 138+ on desktop and downloads a language pack once, from the popup. |
| **MyMemory** | no | free | ~5,000 characters/day per IP. Adding your own email in Settings raises it to ~50,000. |
| **LibreTranslate** | optional | free if self-hosted | Point it at your own server. Public mirrors rate-limit anonymous use heavily. |
| **Google Cloud Translation** | yes | 500k chars/month free | Your own key, stored only on this machine. |
| **Any OpenAI-compatible endpoint** | yes | varies | Good for technical prose. Set base URL, key and model. |

**DeepL is deliberately not offered.** It returns `403` to any request made from
a browser, including an extension's background worker, by design. Adding it
would only produce a setting that fails for everyone who picks it.

Translations are cached so re-reading a page doesn't spend your quota again.
Clear the cache any time in Settings.

---

## Privacy

- **No account, no telemetry, no analytics.** Nothing is collected.
- API keys are stored in `chrome.storage.local` - on this machine only. They're
  never synced to your Google account and never leave except as the
  `Authorization` header of the request you asked for.
- With the Chrome built-in engine, no text leaves your computer at all.
- With any other engine, only the sentences you actually translate are sent, to
  the provider you chose.
- FocusRead is **not** injected into pages automatically. It runs on a page only
  after you click the icon or press the shortcut, which is why installing it
  doesn't ask for access to all your browsing. (You can opt into auto-start for
  specific sites in Settings.)
- PDF and Word files are read inside the browser. They're never uploaded.

---

## Known limits

Worth knowing before you rely on it:

- **Chrome's own PDF viewer is unreachable.** Extensions cannot see inside it -
  no text, no selection, nothing. That's a browser restriction, not something
  this can work around. Use the FocusRead reader instead, or turn on
  *Open PDF links in FocusRead* in Settings → Documents.
- **Scanned PDFs won't work.** If there's no text layer, there's nothing to read.
  FocusRead doesn't do OCR.
- **Maths is skipped.** MathJax, KaTeX and MathML blocks are left alone rather
  than read aloud as gibberish.
- **Heavily dynamic pages may fight back.** Marking sentences means adding
  wrappers to the page; a site that constantly re-renders its own DOM (some
  React apps) can undo them. Static article pages - arXiv, PMC, publisher
  sites, blogs - are fine.
- **Original layout has no inline translation.** There's nowhere to put it
  between lines of a page image. Selection translation still works.
- **Word support is text, not layout.** `.docx` becomes readable prose; table
  borders, colours and exact spacing don't survive. Equations are dropped, and
  tracked changes are shown accepted - the reader tells you when either happens.
  Old `.doc` files aren't supported; re-save as `.docx`.
- **Word-level highlighting depends on the voice.** Network voices often report
  nothing, so on-device voices are preferred. If the highlight runs one word
  ahead of the audio, there's a setting for that.

---

## Development

No build step and no Node.js. The source is plain ES5-compatible JavaScript
loaded directly by the browser.

```bash
./tests/run.sh        # everything: both suites, syntax, wiring
```

That runs four checks, none of which need Node.js - they use JavaScriptCore
through `osascript -l JavaScript`:

| Check | Covers |
| --- | --- |
| `tests/segmenter.cases.js` | sentence splitting against academic punctuation |
| `tests/sw.cases.js` | which sites auto-activation registers on, which pages are injectable, the PDF redirect rule |
| `tests/pdf.cases.js` | column detection, line and paragraph rebuilding, running-head removal, rotated text - with synthetic page data, so no PDF or pdf.js needed |
| `tests/syntax.sh` | every JS file parses |
| `tests/wiring.py` | nothing references anything that doesn't exist: manifest paths, injection order, element ids, message types, settings keys, CSS classes |

Three more suites need a real DOM and run in the browser. JavaScriptCore has
no `setTimeout` and never drains microtasks, so anything promise- or
timer-based has to be tested there:

| Page | Covers |
| --- | --- |
| `tests/preview/runtime.html` | the speech queue, driven by a fake synthesiser the test advances by hand - normal completion, a piece failing mid-queue, cancellation, one-word lag - plus settings persistence and MyMemory's byte chunking |
| `tests/preview/sanitizer.html` | 22 attacks on the `.docx` sanitiser, ending by rendering the output to confirm nothing executes |
| `tests/segmenter.test.html` | the segmentation cases, in a browser |

`tests/preview/page.html` is a sample paper with the reader already running on
it, including the awkward cases: adjacent inline elements, a block nested
inside flowing text, an SVG, a sentence wrapped entirely in a link.

### Looking at the UI

The pages can be opened as ordinary web pages, with `chrome.*` stubbed:

```bash
python3 tests/preview/build.py
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8765/tests/preview/` - `popup.html`,
`options.html`, `reader.html`, and `page.html`, a sample paper with the
reader already running on it. The generated pages are the real markup, CSS
and JS with a stub injected, not mock-ups, so what you see is what ships.
This is how the three bugs in commit 2 were found.

```
src/
  lib/segmenter.js      sentence splitting tuned for academic English
  lib/settings.js       schema, defaults, storage
  lib/translate.js      translation providers and cache
  content/engine.js     DOM -> sentences; highlight, bold, inline translation
  content/speech.js     speechSynthesis, with Chrome's quirks handled
  content/ui.js         floating toolbar and popup (shadow DOM)
  content/controller.js wires the above together
  content/content.js    content-script entry point
  background/           service worker: injection, translation relay, PDF rules
  reader/               the PDF and Word reader
  popup/ options/       toolbar popup and settings page
```

### Why the pieces sit where they do

Three browser constraints shape the whole architecture:

1. **`speechSynthesis` needs a DOM**, so all speech runs in the page, never in
   the service worker.
2. **Chrome's built-in `Translator` also needs a real Document** and is
   `undefined` in an MV3 service worker. Built-in translation runs in the page;
   network providers run in the worker, which is the only context with the
   extension's host permissions and no page CORS policy.
3. **Sentence boundaries must survive academic punctuation.** `Intl.Segmenter`
   splits on `et al.`, `Fig. 3`, `p < 0.05` and `J. R. Smith`. The segmenter
   masks every non-terminal period with a one-character sentinel before
   segmenting, so offsets stay valid, then restores them.

---

## Licence

MIT - see [LICENSE](LICENSE).

pdf.js (Apache-2.0) and mammoth.js (BSD-2-Clause) are downloaded at install
time and keep their own licences.
