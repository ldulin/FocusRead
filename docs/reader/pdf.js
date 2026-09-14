/*
 * FocusRead - PDF handling, on top of Mozilla's pdf.js.
 *
 * Two modes:
 *
 *   REFLOW  - the default, and the reason this file is long. A paper's PDF has
 *             no paragraphs in it; it has thousands of positioned glyph runs.
 *             We rebuild prose from geometry: detect columns, group runs into
 *             lines, lines into paragraphs, rejoin words hyphenated across line
 *             ends, and drop the running heads and page numbers that would
 *             otherwise be read aloud in the middle of a sentence.
 *
 *   ORIGINAL - pdf.js renders the page to a canvas with its usual transparent,
 *             selectable text layer on top. Faithful, and still clickable, but
 *             there is nowhere to put an inline translation.
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  var VENDOR = 'vendor/pdfjs/';
  var _lib = null;

  /**
   * Where each piece of pdf.js lives.
   *
   * Every path is listed rather than derived from one base, because the two
   * layouts disagree: the vendored folder is flat, while the npm package (and
   * so any CDN) keeps the module under build/ and the data folders beside it.
   *
   * The extension resolves these through chrome.runtime.getURL. The web build
   * has no extension URL and no MV3 remote-code restriction, so it overrides
   * them with CDN URLs.
   */
  function pdfPaths() {
    var override = FR.vendorBase && FR.vendorBase.pdfjsPaths;
    if (override) return override;
    var base = chrome.runtime.getURL(VENDOR);
    return {
      module: base + 'pdf.min.mjs',
      worker: base + 'pdf.worker.min.mjs',
      cmaps: base + 'cmaps/',
      standardFonts: base + 'standard_fonts/',
      wasm: base + 'wasm/'
    };
  }

  /** Load the pdf.js ESM build. */
  function lib() {
    if (_lib) return _lib;
    var paths = pdfPaths();
    _lib = import(paths.module).then(function (mod) {
      // In the extension the worker must be a local file: pdf.js wraps a
      // cross-origin worker in a blob: URL, which the MV3 CSP kills with no
      // useful error. On the web there is no such restriction, so the CDN
      // worker is fine.
      mod.GlobalWorkerOptions.workerSrc = paths.worker;
      return { mod: mod, paths: paths };
    }).catch(function (e) {
      _lib = null;
      throw Object.assign(
        new Error('Could not load pdf.js from ' + paths.module +
                  '. In the extension, run scripts/fetch-vendor.sh and reload it.'),
        { code: 'no-vendor', cause: e });
    });
    return _lib;
  }

  /**
   * @param {{url?:string, data?:ArrayBuffer}} source
   * @param {function(number)} [onProgress] 0..1
   */
  function open(source, onProgress) {
    return lib().then(function (L) {
      var opts = {
        // Trailing slashes are required - pdf.js concatenates these directly.
        cMapUrl: L.paths.cmaps,
        cMapPacked: true,
        standardFontDataUrl: L.paths.standardFonts,
        wasmUrl: L.paths.wasm
      };
      if (source.data) {
        opts.data = source.data;
      } else {
        opts.url = source.url;
        // A DNR redirect discards the response the browser already fetched, so
        // we fetch again - and a paywalled PDF needs the session cookie. Only
        // on that trusted path: credentials must never be attached to a URL
        // chosen by whoever opened our web-accessible reader page.
        opts.withCredentials = !!source.withCredentials;
      }

      var task = L.mod.getDocument(opts);
      if (onProgress) {
        task.onProgress = function (p) {
          if (p && p.total) onProgress(Math.min(1, p.loaded / p.total));
        };
      }
      return task.promise.then(function (doc) { return { doc: doc, mod: L.mod }; });
    });
  }

  /* ------------------------------------------------------------------ *
   * Geometry helpers
   * ------------------------------------------------------------------ */

  function median(xs) {
    if (!xs.length) return 0;
    var s = xs.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   * Normalise a page's text items into flat, comparable boxes.
   *
   * Almost all PDFs - including landscape ones with a /Rotate entry - lay text
   * out along the unrotated +x axis, so unrotated user space IS reading space
   * and nothing needs doing. The exception is content authored for a rotated
   * presentation, where the TEXT MATRIX itself carries the rotation and the
   * advance runs vertically in user space. Grouping those by y would collect a
   * visual column of glyphs into one "line" and emit unreadable fragments, so
   * the axes are swapped for them.
   *
   * @returns {{boxes:Array, rotatedRuns:number}}
   */
  function toBoxes(textContent) {
    var out = [];
    var rotatedRuns = 0;

    textContent.items.forEach(function (it) {
      if (!it.str || !it.str.length) return;
      var t = it.transform;
      var a = t[0], b = t[1], c = t[2], d = t[3];
      var h = Math.abs(it.height || d || 0) || Math.abs(a) || 10;

      // A clearly vertical advance: |b| dominates |a|.
      if (Math.abs(b) > Math.abs(a) * 2) {
        rotatedRuns++;
        h = Math.abs(it.height || c || 0) || Math.abs(b) || 10;
        // 90 CW (b < 0): reading runs along decreasing user-space y.
        // 90 CCW (b > 0): along increasing y. Either way the along-line axis
        // becomes x and the line-stacking axis becomes y.
        var alongLine = b < 0 ? -t[5] : t[5];
        var acrossLine = b < 0 ? -t[4] : t[4];
        out.push({
          str: it.str, x: alongLine, y: acrossLine,
          w: it.width || 0, h: h, eol: !!it.hasEOL, rotated: true
        });
        return;
      }

      out.push({ str: it.str, x: t[4], y: t[5], w: it.width || 0, h: h, eol: !!it.hasEOL });
    });

    return { boxes: out, rotatedRuns: rotatedRuns };
  }

  /**
   * Two-column papers are the common case and the one that breaks naive
   * extraction most badly: reading straight down the page interleaves the left
   * and right columns sentence by sentence.
   *
   * We test the obvious hypothesis - a gutter near the middle - by counting how
   * many text runs straddle it.
   */
  function detectColumns(boxes, pageWidth) {
    // Enough runs to be meaningful, but not many. A PDF that emits one run per
    // LINE rather than per word gives a full two-column page only ~30 runs, and
    // a 40-run floor silently skipped column detection on every one of them -
    // so the two columns were read interleaved, half a sentence at a time.
    // False positives are held off by the gutter width and the 25%-each-side
    // test below, not by this count.
    if (boxes.length < 12 || !pageWidth) return null;

    // Counting how many runs STRADDLE the midline only works when a run is a
    // whole line. Plenty of PDFs emit one run per word, and a word almost
    // never straddles the centre - so a perfectly ordinary single-column page
    // looked like two columns and got read in the wrong order.
    //
    // Look for the thing that actually defines a two-column page instead: a
    // vertical band down the middle that no text occupies at all.
    var BINS = 200;
    var covered = new Array(BINS);
    for (var i = 0; i < BINS; i++) covered[i] = 0;

    boxes.forEach(function (b) {
      var from = Math.max(0, Math.floor((b.x / pageWidth) * BINS));
      var to = Math.min(BINS - 1, Math.ceil(((b.x + Math.max(b.w, 1)) / pageWidth) * BINS));
      for (var k = from; k <= to; k++) covered[k]++;
    });

    // A gutter is *nearly* empty, not exactly empty. Requiring zero meant a
    // single full-width run anywhere on the page - the title block, a wide
    // figure caption, a licence footer - raised every middle bin to one and
    // killed detection for the whole page, so its two columns were then read
    // interleaved line by line.
    // The floor matters on a sparse page: 2% of 50 runs is 1, which a title
    // plus a caption plus a footer would already exceed. A real page has
    // hundreds of runs, where the percentage dominates.
    var tolerance = Math.max(3, Math.round(boxes.length * 0.02));

    // The gutter has to sit near the middle of the page.
    var lo = Math.floor(BINS * 0.34), hi = Math.ceil(BINS * 0.66);
    var best = null, runStart = -1;
    for (var j = lo; j <= hi; j++) {
      if (covered[j] <= tolerance) {
        if (runStart === -1) runStart = j;
        if (!best || (j - runStart) > (best.end - best.start)) best = { start: runStart, end: j };
      } else {
        runStart = -1;
      }
    }
    if (!best) return null;

    var gutterWidth = ((best.end - best.start + 1) / BINS) * pageWidth;
    if (gutterWidth < pageWidth * 0.018) return null;          // too narrow to be a gutter

    var gutter = ((best.start + best.end + 1) / 2 / BINS) * pageWidth;

    // Both sides must carry real content, or this is a centred heading with
    // white space either side rather than a column break.
    var left = 0, right = 0;
    boxes.forEach(function (b) {
      if (b.x + b.w / 2 < gutter) left++; else right++;
    });
    var total = boxes.length;
    if (left / total < 0.25 || right / total < 0.25) return null;

    return gutter;
  }

  function columnOf(b, gutter) {
    if (gutter === null) return 0;
    return (b.x + b.w / 2) < gutter ? 0 : 1;
  }

  /** Group boxes into visual lines. */
  function toLines(boxes, gutter) {
    var heights = boxes.map(function (b) { return b.h; });
    var lineTol = Math.max(2, median(heights) * 0.55);

    boxes.forEach(function (b) { b.col = columnOf(b, gutter); });
    boxes.sort(function (a, b) {
      if (a.col !== b.col) return a.col - b.col;
      if (Math.abs(a.y - b.y) > lineTol) return b.y - a.y;   // PDF y grows upward
      return a.x - b.x;
    });

    var lines = [], cur = null;
    boxes.forEach(function (b) {
      if (cur && b.col === cur.col && Math.abs(b.y - cur.y) <= lineTol) {
        cur.items.push(b);
        cur.y = (cur.y * (cur.items.length - 1) + b.y) / cur.items.length;
      } else {
        cur = { col: b.col, y: b.y, items: [b] };
        lines.push(cur);
      }
    });

    lines.forEach(function (ln) {
      ln.items.sort(function (a, b) { return a.x - b.x; });
      ln.left = ln.items[0].x;
      ln.right = ln.items.reduce(function (m, b) { return Math.max(m, b.x + b.w); }, 0);
      ln.h = median(ln.items.map(function (b) { return b.h; }));
      ln.text = joinItems(ln.items);
    });

    return lines.filter(function (ln) { return ln.text.trim().length > 0; });
  }

  /** Concatenate runs, inserting a space only where the glyphs are apart. */
  function joinItems(items) {
    var out = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (i > 0) {
        var prev = items[i - 1];
        var gap = it.x - (prev.x + prev.w);
        var needsSpace = gap > Math.max(1, it.h * 0.18);
        var joined = out.slice(-1);
        if (needsSpace && joined && joined !== ' ' && it.str[0] !== ' ') out += ' ';
      }
      out += it.str;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  /* ------------------------------------------------------------------ *
   * Running heads and page numbers
   * ------------------------------------------------------------------ */

  function normaliseForRepeat(s) {
    return s.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * A line repeated at the top or bottom of many pages is furniture, not prose.
   * Reading "Nature Neuroscience | VOL 24 | 1189" mid-paragraph is exactly the
   * kind of thing that makes TTS on papers unbearable.
   */
  /**
   * @param {Array<{lines:Array, height:number}>} pages
   *
   * Candidates are chosen by POSITION on the page, not by index in the line
   * array: after column sorting, "the last two entries" are the foot of the
   * right-hand column, not the foot of the page.
   *
   * A candidate must also appear at roughly the same height on every page.
   * Digit normalisation makes "Table 1" and "Table 2" the same key, so without
   * a position check a figure caption that happens to sit near the top on
   * several pages would be deleted as furniture.
   */
  function edgeLines(page) {
    var h = page.height || 0;
    if (!h) return page.lines.slice(0, 2).concat(page.lines.slice(-2));
    var topBand = h * 0.90, bottomBand = h * 0.10;
    return page.lines.filter(function (ln) {
      return ln.y >= topBand || ln.y <= bottomBand;
    });
  }

  function findRunningHeads(pages) {
    var counts = {};
    var n = pages.length;
    if (n < 3) return {};

    pages.forEach(function (page) {
      var seen = {};
      edgeLines(page).forEach(function (ln) {
        if (!isFurniture(ln.text)) return;
        var key = normaliseForRepeat(ln.text);
        if (!key || seen[key]) return;
        seen[key] = 1;
        if (!counts[key]) counts[key] = { n: 0, ys: [] };
        counts[key].n++;
        counts[key].ys.push(ln.y);
      });
    });

    var threshold = Math.max(3, Math.ceil(n * 0.4));
    var pageHeight = pages[0].height || 800;
    var heads = {};
    Object.keys(counts).forEach(function (k) {
      var c = counts[k];
      if (c.n < threshold) return;
      var min = Math.min.apply(null, c.ys), max = Math.max.apply(null, c.ys);
      // Same text, same place, on most pages.
      if (max - min > pageHeight * 0.06) return;
      heads[k] = true;
    });
    return heads;
  }

  var PAGE_NUMBER = /^[\s|.\-]*(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?[\s|.\-]*$/i;

  /**
   * Guard against deleting real prose.
   *
   * Because normaliseForRepeat() turns every digit into a placeholder, any line
   * that differs between pages ONLY by a number looks repeated. That is exactly
   * what a running head is - and it would also match a body line that happened
   * to differ only in a figure number. Running heads are short, and they are
   * not mid-sentence continuations, so require both.
   */
  function isFurniture(text) {
    var t = String(text).trim();
    if (!t || t.length > 70) return false;              // heads are short
    if (/^[\p{Ll}]/u.test(t)) return false;             // a sentence continuing
    if (PAGE_NUMBER.test(t)) return true;               // a bare page number is
    if (/[.!?]["'\u2019\u201D)\]]?$/.test(t) && t.split(/\s+/).length > 6) return false;

    // normaliseForRepeat() turns every digit run into a placeholder, so
    // "Problem 1" ... "Problem 8" all collapse to one key and look repeated.
    // On a problem set or a slide export those are the HEADINGS - deleting
    // them removes the only thing telling the reader where they are.
    //
    // Judge what is left once the numbers are gone: a real running head is
    // either structured (separators, volume/issue/page markers) or several
    // words long. One word plus a number is a heading.
    if (/[|\u00B7\u2022\u2014\u2013\/]|\b(vol|no|pp|issue|doi|isbn|issn)\b/i.test(t)) return true;

    var residue = t.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
    var tokens = residue ? residue.split(/\s+/).filter(Boolean) : [];
    return tokens.length >= 2;
  }

  /* ------------------------------------------------------------------ *
   * Paragraph assembly
   * ------------------------------------------------------------------ */

  /**
   * The right-hand edge of each column.
   *
   * A global maximum is wrong the moment a page has two columns: every
   * left-column line is then "short", and the short-last-line rule - meant to
   * catch a paragraph ending early - fires on almost every line, chopping
   * paragraphs into single lines.
   */
  function columnEdges(lines) {
    var edges = {};
    lines.forEach(function (ln) {
      var c = ln.col || 0;
      if (edges[c] === undefined || ln.right > edges[c]) edges[c] = ln.right;
    });
    return edges;
  }

  function isHeadingLine(ln, bodyHeight) {
    var t = ln.text.trim();
    if (t.length > 90 || t.length < 3) return false;
    if (ln.h > bodyHeight * 1.18) return true;
    if (/^\d+(\.\d+)*\.?\s+\S/.test(t) && t.length < 70 && !/[.;]$/.test(t)) return true;
    var WORDS = ['abstract', 'introduction', 'background', 'methods', 'materials and methods',
      'results', 'discussion', 'conclusion', 'conclusions', 'references', 'acknowledgements',
      'acknowledgments', 'related work', 'limitations', 'supplementary information', 'data availability'];
    return WORDS.indexOf(t.toLowerCase().replace(/^\d+[.\s]*/, '')) !== -1;
  }

  /**
   * Turn a page's lines into blocks, then merge blocks across page breaks when
   * a paragraph obviously continues.
   */
  function linesToBlocks(lines, bodyHeight, joinHyphens) {
    if (!lines.length) return [];

    var gaps = [];
    for (var i = 1; i < lines.length; i++) {
      if (lines[i].col === lines[i - 1].col) gaps.push(lines[i - 1].y - lines[i].y);
    }
    var normalGap = median(gaps.filter(function (g) { return g > 0; })) || bodyHeight * 1.2;

    var edges = columnEdges(lines);
    var leftEdge = lines.reduce(function (m, ln) { return Math.min(m, ln.left); }, Infinity);
    var indentTol = bodyHeight * 0.8;

    var blocks = [], cur = null;

    lines.forEach(function (ln, idx) {
      var prev = lines[idx - 1];
      var heading = isHeadingLine(ln, bodyHeight);

      var breakHere = !cur || heading || (prev && isHeadingLine(prev, bodyHeight));
      if (!breakHere && prev) {
        if (prev.col !== ln.col) breakHere = true;
        else {
          var gap = prev.y - ln.y;
          if (gap > normalGap * 1.45) breakHere = true;
          else if (ln.left - leftEdge > indentTol && ln.left - prev.left > indentTol) breakHere = true;
          // A short last line followed by a capital is a paragraph end.
          else if (prev.right < (edges[prev.col || 0] || 0) - bodyHeight * 3 &&
                   endsSentence(prev.text) &&
                   /^[A-Z\u2022\u00B7(\[]/.test(ln.text)) breakHere = true;
        }
      }

      if (breakHere) {
        cur = {
          type: heading ? 'h' : 'p',
          lines: [ln.text],
          brokeColumn: !!(prev && prev.col !== ln.col)
        };
        blocks.push(cur);
      } else {
        cur.lines.push(ln.text);
      }
    });

    return blocks.map(function (b) {
      var lns = joinHyphens && FR.segmenter ? FR.segmenter.dehyphenate(b.lines.slice()) : b.lines;
      return {
        type: b.type,
        text: lns.join(' ').replace(/\s+/g, ' ').trim(),
        brokeColumn: b.brokeColumn
      };
    }).filter(function (b) { return b.text.length > 0; });
  }

  /**
   * Rejoin a paragraph that a column or page boundary cut in half.
   *
   * A paragraph running down the left column and continuing at the top of the
   * right one is one paragraph; left split, it is read as two, mis-segmented
   * at the seam, and translated as two fragments.
   */
  function mergeContinuations(blocks) {
    var out = [];
    blocks.forEach(function (b) {
      var prev = out[out.length - 1];
      var continues = prev &&
        b.type === 'p' && prev.type === 'p' &&
        (b.brokeColumn || b.firstOnPage) &&
        !endsSentence(prev.text) &&
        /^[a-z(\[]/.test(b.text);

      if (continues) {
        var joined = FR.segmenter
          ? FR.segmenter.dehyphenate([prev.text, b.text]).join(' ')
          : prev.text + ' ' + b.text;
        prev.text = joined.replace(/\s+/g, ' ').trim();
      } else {
        out.push(b);
      }
    });
    return out;
  }

  var TERMINAL_AT_END = /[.!?:;]["'\u2019\u201D)\]]?$/;

  /**
   * Does this line really END a sentence?
   *
   * A trailing period is not enough: a line ending "and cf." or "et al." or
   * "Fig." looks terminal to a regex, and the paragraph heuristics then cut the
   * paragraph in half mid-sentence. The segmenter already knows which periods
   * are terminators - it masks the others - so ask it.
   */
  function endsSentence(text) {
    var t = String(text || '');
    if (FR.segmenter && FR.segmenter.mask) {
      try { return TERMINAL_AT_END.test(FR.segmenter.mask(t)); } catch (e) { /* fall through */ }
    }
    return TERMINAL_AT_END.test(t);
  }

  var ENDS_SENTENCE = TERMINAL_AT_END;

  /* ------------------------------------------------------------------ *
   * Public: reflow extraction
   * ------------------------------------------------------------------ */

  /**
   * @returns {Promise<{blocks: Array<{type,text,page}>, notices: string[]}>}
   */
  function extractReflow(doc, opts, onProgress) {
    opts = opts || {};
    var total = doc.numPages;
    var notices = [];
    var perPage = [];
    var allHeights = [];
    var rotatedPages = 0;
    var strayRotated = 0;

    var chain = Promise.resolve();
    for (var n = 1; n <= total; n++) {
      (function (pageNum) {
        chain = chain.then(function () {
          return doc.getPage(pageNum).then(function (page) {
            // Text-item transforms are in unrotated PDF user space. Taking the
            // width from a rotated viewport compares them against the wrong
            // axis, so on a landscape-rotated page every column and position
            // test is measured against the height instead.
            var base = page.getViewport({ scale: 1, rotation: 0 });
            return page.getTextContent().then(function (tc) {
              var extracted = toBoxes(tc);
              var boxes = extracted.boxes;

              // Rotated runs mean one of two very different things. A handful
              // of them are figure decoration - axis labels on a plot, a
              // sideways table header - which should simply not be read aloud.
              // A page where MOST runs are rotated is a genuinely rotated page,
              // and there the axis swap is what makes it readable at all.
              if (extracted.rotatedRuns) {
                var mostly = extracted.rotatedRuns > boxes.length * 0.5;
                if (mostly) {
                  rotatedPages++;
                } else {
                  boxes = boxes.filter(function (b) { return !b.rotated; });
                  strayRotated += extracted.rotatedRuns;
                }
              }

              var gutter = detectColumns(boxes, base.width);
              var lines = toLines(boxes, gutter);
              lines.forEach(function (ln) { allHeights.push(ln.h); });
              perPage.push({
                page: pageNum,
                lines: lines,
                height: base.height,
                width: base.width,
                columns: gutter === null ? 1 : 2
              });
              page.cleanup();
              if (onProgress) onProgress(pageNum / total);
            });
          });
        });
      })(n);
    }

    return chain.then(function () {
      perPage.sort(function (a, b) { return a.page - b.page; });
      var bodyHeight = median(allHeights) || 10;
      var heads = opts.stripRunningHeads ? findRunningHeads(perPage) : {};

      var removedLines = 0;
      var kept = perPage.map(function (p) {
        var h = p.height || 0;
        var topBand = h * 0.90, bottomBand = h * 0.10;
        var lines = p.lines.filter(function (ln) {
          // Index-based edges are wrong once lines are sorted by column: entry
          // 0 is the top of the LEFT column and the last entry is the foot of
          // the RIGHT one, so a two-column page had its real header kept and a
          // mid-page line examined instead.
          var atEdge = h ? (ln.y >= topBand || ln.y <= bottomBand) : true;
          if (!atEdge) return true;
          if (PAGE_NUMBER.test(ln.text)) { removedLines++; return false; }
          if (heads[normaliseForRepeat(ln.text)]) { removedLines++; return false; }
          return true;
        });
        return { page: p.page, lines: lines, columns: p.columns };
      });

      var blocks = [];
      kept.forEach(function (p) {
        var pageBlocks = linesToBlocks(p.lines, bodyHeight, opts.joinHyphens !== false);
        pageBlocks.forEach(function (b, i) {
          b.page = p.page;
          b.firstOnPage = i === 0;
          blocks.push(b);
        });
      });

      // Stitch paragraphs cut in half by a column break or a page break.
      var merged = mergeContinuations(blocks);

      if (rotatedPages) {
        // Only for genuinely sideways pages. The axis swap there is a best
        // effort, and a reader who sees scrambled text deserves to know why
        // rather than assuming the extension is broken.
        notices.push(rotatedPages + ' page' + (rotatedPages === 1 ? ' is' : 's are') +
                     ' rotated. Reading order on ' + (rotatedPages === 1 ? 'it' : 'them') +
                     ' may be wrong - use Original layout if it looks scrambled.');
      }
      if (strayRotated) {
        notices.push('Skipped ' + strayRotated + ' rotated label' + (strayRotated === 1 ? '' : 's') +
                     ' (figure axes and similar).');
      }

      var twoCol = kept.filter(function (p) { return p.columns === 2; }).length;
      if (twoCol) notices.push(twoCol + ' of ' + total + ' pages were read as two columns.');
      // Count the lines actually dropped, not the number of distinct patterns:
      // "Removed 1" when eight lines went is worse than saying nothing.
      if (removedLines) {
        notices.push('Removed ' + removedLines + ' repeated header, footer or page-number line' +
                     (removedLines === 1 ? '' : 's') + '.');
      }
      if (!merged.length) {
        notices.push('No text layer found. This PDF is probably a scan - it would need OCR, which FocusRead does not do.');
      }

      return { blocks: merged, notices: notices, pages: total, heads: heads };
    });
  }

  /* ------------------------------------------------------------------ *
   * Public: original-layout rendering
   * ------------------------------------------------------------------ */

  function renderPage(doc, mod, pageNum, container, scale, placeholder, opts) {
    return doc.getPage(pageNum).then(function (page) {
      var viewport = page.getViewport({ scale: scale });
      var dpr = Math.min(2, root.devicePixelRatio || 1);

      var wrap = document.createElement('div');
      wrap.className = 'pageWrap';
      wrap.setAttribute('data-page', String(pageNum));
      wrap.style.width = Math.floor(viewport.width) + 'px';
      wrap.style.height = Math.floor(viewport.height) + 'px';

      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      wrap.appendChild(canvas);

      var layer = document.createElement('div');
      layer.className = 'textLayer';
      // v5+ renamed this custom property; the old name makes every span
      // mis-sized because the calc() in pdf_viewer.css resolves to garbage.
      layer.style.setProperty('--total-scale-factor', String(scale));
      layer.style.width = Math.floor(viewport.width) + 'px';
      layer.style.height = Math.floor(viewport.height) + 'px';
      wrap.appendChild(layer);

      // Insert in the right place up front so page order is correct, then
      // remove it again if rendering fails - the old code appended
      // unconditionally and left a blank white rectangle behind on error.
      //
      // If the placeholder is gone the view was rebuilt (a mode switch, a new
      // document) while this getPage was in flight. Appending anyway would
      // stack an orphaned page at the end of the fresh list, so drop it.
      if (placeholder && placeholder.parentNode === container) {
        container.insertBefore(wrap, placeholder);
      } else if (placeholder) {
        page.cleanup();
        return null;
      } else {
        container.appendChild(wrap);
      }

      var ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);


      var textContent = null;
      var renderArgs = { canvasContext: ctx, canvas: canvas, viewport: viewport };
      return page.render(renderArgs).promise.then(function () {
        return page.getTextContent();
      }).then(function (tc) {
        textContent = tc;
        if (typeof mod.TextLayer === 'function') {
          var tl = new mod.TextLayer({ textContentSource: tc, container: layer, viewport: viewport });
          return tl.render();
        }
        if (typeof mod.renderTextLayer === 'function') {   // pdf.js <= v4
          return mod.renderTextLayer({ textContentSource: tc, container: layer, viewport: viewport }).promise;
        }
        return null;
      }).then(function () {
        // Rebuild the layer's spans into paragraphs so the reading engine sees
        // sentences rather than lines.
        try {
          if (textContent) {
            groupTextLayer(layer, textContent, page.getViewport({ scale: 1, rotation: 0 }), opts || {});
          }
        } catch (e) {
          console.warn('[FocusRead] could not group the text layer', e);
        }
        page.cleanup();
        if (placeholder && placeholder.parentNode) placeholder.remove();
        return wrap;
      }).catch(function (err) {
        if (wrap.parentNode) wrap.remove();
        try { page.cleanup(); } catch (e) { /* noop */ }
        throw err;
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Turning a text layer into paragraphs
   *
   * pdf.js emits one absolutely-positioned <span> per text run, which is
   * usually one LINE. Every span is its own block as far as the DOM is
   * concerned, so the reading engine saw 83 lines as 101 "sentences" and read
   * the page a line at a time - stopping mid-clause at every line end.
   *
   * Wrapping the spans of a paragraph in a plain <div> fixes it: the div is
   * static, so the spans keep positioning against .textLayer and nothing moves
   * visually, but the engine now sees one block of flowing text and can run a
   * sentence across line breaks.
   * ------------------------------------------------------------------ */

  /**
   * Attach each rendered span to the run it came from.
   *
   * pdf.js emits spans in run order and sets textContent to the run's string,
   * so walking both in step and matching on text is reliable - and unlike a
   * count comparison it survives the layer having a span more or fewer than
   * expected. The lookahead is bounded so one unmatched span cannot throw the
   * rest of the page out of alignment.
   *
   * @returns {number} how many spans were matched
   */
  function alignSpans(boxes, spans) {
    var LOOKAHEAD = 12;
    var next = 0, matched = 0;
    for (var si = 0; si < spans.length; si++) {
      var text = spans[si].textContent;
      var limit = Math.min(boxes.length, next + LOOKAHEAD);
      for (var k = next; k < limit; k++) {
        if (boxes[k].el === undefined && boxes[k].str === text) {
          boxes[k].el = spans[si];
          next = k + 1;
          matched++;
          break;
        }
      }
    }
    return matched;
  }

  /**
   * @param {Element} layer         the .textLayer div, already rendered
   * @param {object} textContent    the SAME object the layer was built from
   * @param {object} viewport       unrotated viewport, for the page width
   * @param {object} [opts]         { heads, stripRunningHeads }
   * @returns {number} paragraphs created
   *
   * Grouping is done in PDF user space, not from the rendered boxes. The
   * layer's on-screen geometry is unreliable: an ancestor transform scales the
   * whole page, and pdf.js stretches each span with scaleX to match the canvas
   * glyphs, so getBoundingClientRect() reports widths that do not agree with
   * the page's own coordinates. The extraction pass already has correct
   * coordinates, so reuse them and map item -> span by position.
   */
  function groupTextLayer(layer, textContent, viewport, opts) {
    opts = opts || {};
    var extracted = toBoxes(textContent);
    // Align against ALL runs, rotated ones included: pdf.js renders a span for
    // every run, so dropping the rotated ones first threw the counts out by
    // however many figure labels the page had. Rotated runs are excluded from
    // the line grouping further down instead.
    var allBoxes = extracted.boxes;
    if (allBoxes.length < 2) return 0;

    var spans = Array.prototype.filter.call(layer.children, function (el) {
      return el.tagName === 'SPAN' && el.textContent && el.textContent.length;
    });
    if (!spans.length) return 0;

    var matched = alignSpans(allBoxes, spans);
    // Requiring an exact count was far too brittle - one stray span on a
    // 470-run page disabled grouping for the whole page, and the reader was
    // back to stopping at every line end.
    if (matched < spans.length * 0.75) {
      console.warn('[FocusRead] could only match ' + matched + ' of ' + spans.length +
                   ' text-layer spans; not grouping');
      return 0;
    }

    var boxes = allBoxes.filter(function (b) { return b.el && !b.rotated; });
    if (boxes.length < 2) return 0;

    var gutter = detectColumns(boxes, viewport.width);
    var lines = toLines(boxes, gutter);
    if (!lines.length) return 0;

    var bodyHeight = median(lines.map(function (l) { return l.h; })) || 10;

    // Drop the furniture, so the running head is not read out mid-page the way
    // it used to be in this view.
    if (opts.stripRunningHeads !== false) {
      var top = viewport.height * 0.90, bottom = viewport.height * 0.10;
      lines = lines.filter(function (ln) {
        var atEdge = ln.y >= top || ln.y <= bottom;
        if (!atEdge) return true;
        if (PAGE_NUMBER.test(ln.text)) { hide(ln); return false; }
        if (opts.heads && opts.heads[normaliseForRepeat(ln.text)]) { hide(ln); return false; }
        return true;
      });
    }

    var groups = regroupLines(lines, bodyHeight);

    var made = 0;
    groups.forEach(function (group) {
      var para = document.createElement('div');
      para.className = 'fr-para';
      layer.appendChild(para);
      group.forEach(function (ln, li) {
        ln.items.forEach(function (b, bi) {
          if (!b.el) return;
          // A line break is a word break: without this the last word of one
          // line runs into the first word of the next.
          if (li > 0 || bi > 0) para.appendChild(document.createTextNode(' '));
          para.appendChild(b.el);
        });
      });
      made++;
    });
    return made;
  }

  function hide(line) {
    line.items.forEach(function (b) {
      b.el.setAttribute('data-fr-furniture', '');
      b.el.classList.add('fr-ignore');
    });
  }

  /** The same paragraph-break rules as linesToBlocks, returning line groups. */
  function regroupLines(lines, bodyHeight) {
    if (!lines.length) return [];
    var gaps = [];
    for (var i = 1; i < lines.length; i++) {
      if (lines[i].col === lines[i - 1].col) gaps.push(lines[i - 1].y - lines[i].y);
    }
    var normalGap = median(gaps.filter(function (g) { return g > 0; })) || bodyHeight * 1.2;
    var edges = columnEdges(lines);
    var leftEdge = lines.reduce(function (m, ln) { return Math.min(m, ln.left); }, Infinity);
    var indentTol = bodyHeight * 0.8;

    var groups = [], cur = null;
    lines.forEach(function (ln, idx) {
      var prev = lines[idx - 1];
      var heading = isHeadingLine(ln, bodyHeight);
      var breakHere = !cur || heading || (prev && isHeadingLine(prev, bodyHeight));
      if (!breakHere && prev) {
        if (prev.col !== ln.col) breakHere = true;
        else {
          var gap = prev.y - ln.y;
          if (gap > normalGap * 1.45) breakHere = true;
          else if (ln.left - leftEdge > indentTol && ln.left - prev.left > indentTol) breakHere = true;
          else if (prev.right < (edges[prev.col || 0] || 0) - bodyHeight * 3 &&
                   endsSentence(prev.text) &&
                   /^[A-Z\u2022\u00B7(\[]/.test(ln.text)) breakHere = true;
        }
      }
      if (breakHere) { cur = [ln]; groups.push(cur); }
      else cur.push(ln);
    });
    return groups;
  }

  FR.pdf = {
    pdfPaths: pdfPaths,
    open: open,
    extractReflow: extractReflow,
    renderPage: renderPage,
    groupTextLayer: groupTextLayer,
    available: function () { return lib().then(function () { return true; }, function () { return false; }); },
    // Exposed for tests. The layout reconstruction is pure geometry, so it can
    // be exercised with synthetic text runs without pdf.js present.
    _internals: {
      toBoxes: toBoxes,
      detectColumns: detectColumns,
      toLines: toLines,
      linesToBlocks: linesToBlocks,
      findRunningHeads: findRunningHeads,
      normaliseForRepeat: normaliseForRepeat,
      isFurniture: isFurniture,
      columnEdges: columnEdges,
      alignSpans: alignSpans,
      endsSentence: endsSentence,
      mergeContinuations: mergeContinuations,
      edgeLines: edgeLines,
      isHeadingLine: isHeadingLine,
      joinItems: joinItems,
      median: median,
      PAGE_NUMBER: PAGE_NUMBER
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
