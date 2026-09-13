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

  /** Load the vendored pdf.js ESM build. */
  function lib() {
    if (_lib) return _lib;
    var base = chrome.runtime.getURL(VENDOR);
    _lib = import(base + 'pdf.min.mjs').then(function (mod) {
      // The worker MUST be a local file. pdf.js wraps a cross-origin worker in
      // a blob: URL, which the extension CSP kills with no useful error.
      mod.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
      return { mod: mod, base: base };
    }).catch(function (e) {
      _lib = null;
      throw Object.assign(
        new Error('pdf.js is not installed. Run scripts/fetch-vendor.sh in the extension folder, then reload the extension.'),
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
        cMapUrl: L.base + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: L.base + 'standard_fonts/',
        wasmUrl: L.base + 'wasm/'
      };
      if (source.data) {
        opts.data = source.data;
      } else {
        opts.url = source.url;
        // A DNR redirect discards the response the browser already fetched, so
        // we fetch again - and a paywalled PDF needs the session cookie.
        opts.withCredentials = true;
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

  /** Normalise a page's text items into flat, comparable boxes. */
  function toBoxes(textContent) {
    var out = [];
    textContent.items.forEach(function (it) {
      if (!it.str || !it.str.length) return;
      var t = it.transform;
      var h = Math.abs(it.height || t[3] || 0) || Math.abs(t[0]) || 10;
      out.push({
        str: it.str,
        x: t[4],
        y: t[5],
        w: it.width || 0,
        h: h,
        eol: !!it.hasEOL
      });
    });
    return out;
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
    if (boxes.length < 40) return null;
    var mid = pageWidth / 2;
    var tol = pageWidth * 0.02;

    var straddle = 0, left = 0, right = 0;
    boxes.forEach(function (b) {
      if (b.x < mid - tol && b.x + b.w > mid + tol) straddle++;
      else if (b.x + b.w / 2 < mid) left++;
      else right++;
    });

    var total = boxes.length;
    if (straddle / total > 0.12) return null;           // too much full-width text
    if (left / total < 0.25 || right / total < 0.25) return null;
    return mid;
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
  function findRunningHeads(pageLines) {
    var counts = {};
    var pages = pageLines.length;
    if (pages < 3) return {};

    pageLines.forEach(function (lines) {
      var edges = lines.slice(0, 2).concat(lines.slice(-2));
      var seen = {};
      edges.forEach(function (ln) {
        if (!isFurniture(ln.text)) return;
        var key = normaliseForRepeat(ln.text);
        if (!key || seen[key]) return;
        seen[key] = 1;
        counts[key] = (counts[key] || 0) + 1;
      });
    });

    var threshold = Math.max(3, Math.ceil(pages * 0.4));
    var heads = {};
    Object.keys(counts).forEach(function (k) { if (counts[k] >= threshold) heads[k] = true; });
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
    if (/[.!?]["'\u2019\u201D)\]]?$/.test(t) && t.split(/\s+/).length > 6) return false;
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Paragraph assembly
   * ------------------------------------------------------------------ */

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

    var rightEdge = lines.reduce(function (m, ln) { return Math.max(m, ln.right); }, 0);
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
          else if (prev.right < rightEdge - bodyHeight * 3 &&
                   /[.!?:]["'\u2019\u201D)\]]?$/.test(prev.text) &&
                   /^[A-Z\u2022\u00B7(\[]/.test(ln.text)) breakHere = true;
        }
      }

      if (breakHere) {
        cur = { type: heading ? 'h' : 'p', lines: [ln.text] };
        blocks.push(cur);
      } else {
        cur.lines.push(ln.text);
      }
    });

    return blocks.map(function (b) {
      var lns = joinHyphens && FR.segmenter ? FR.segmenter.dehyphenate(b.lines.slice()) : b.lines;
      return { type: b.type, text: lns.join(' ').replace(/\s+/g, ' ').trim() };
    }).filter(function (b) { return b.text.length > 0; });
  }

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

    var chain = Promise.resolve();
    for (var n = 1; n <= total; n++) {
      (function (pageNum) {
        chain = chain.then(function () {
          return doc.getPage(pageNum).then(function (page) {
            var viewport = page.getViewport({ scale: 1 });
            return page.getTextContent().then(function (tc) {
              var boxes = toBoxes(tc);
              var gutter = detectColumns(boxes, viewport.width);
              var lines = toLines(boxes, gutter);
              lines.forEach(function (ln) { allHeights.push(ln.h); });
              perPage.push({ page: pageNum, lines: lines, columns: gutter === null ? 1 : 2 });
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
      var heads = opts.stripRunningHeads ? findRunningHeads(perPage.map(function (p) { return p.lines; })) : {};

      var kept = perPage.map(function (p) {
        var lines = p.lines.filter(function (ln, i) {
          var edge = i < 2 || i >= p.lines.length - 2;
          if (!edge) return true;
          if (PAGE_NUMBER.test(ln.text)) return false;
          return !heads[normaliseForRepeat(ln.text)];
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

      // Stitch a paragraph that runs across a page break.
      var merged = [];
      blocks.forEach(function (b) {
        var prev = merged[merged.length - 1];
        var continues = prev && b.firstOnPage && b.type === 'p' && prev.type === 'p' &&
          !/[.!?:;]["'\u2019\u201D)\]]?$/.test(prev.text) && /^[a-z(\[]/.test(b.text);
        if (continues) {
          var joined = FR.segmenter
            ? FR.segmenter.dehyphenate([prev.text, b.text]).join(' ')
            : prev.text + ' ' + b.text;
          prev.text = joined.replace(/\s+/g, ' ').trim();
        } else {
          merged.push(b);
        }
      });

      var twoCol = kept.filter(function (p) { return p.columns === 2; }).length;
      if (twoCol) notices.push(twoCol + ' of ' + total + ' pages were read as two columns.');
      var removed = Object.keys(heads).length;
      if (removed) notices.push('Removed ' + removed + ' repeated header/footer line' + (removed === 1 ? '' : 's') + '.');
      if (!merged.length) {
        notices.push('No text layer found. This PDF is probably a scan - it would need OCR, which FocusRead does not do.');
      }

      return { blocks: merged, notices: notices, pages: total };
    });
  }

  /* ------------------------------------------------------------------ *
   * Public: original-layout rendering
   * ------------------------------------------------------------------ */

  function renderPage(doc, mod, pageNum, container, scale) {
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

      container.appendChild(wrap);

      var ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      var renderArgs = { canvasContext: ctx, canvas: canvas, viewport: viewport };
      return page.render(renderArgs).promise.then(function () {
        return page.getTextContent();
      }).then(function (tc) {
        if (typeof mod.TextLayer === 'function') {
          var tl = new mod.TextLayer({ textContentSource: tc, container: layer, viewport: viewport });
          return tl.render();
        }
        if (typeof mod.renderTextLayer === 'function') {   // pdf.js <= v4
          return mod.renderTextLayer({ textContentSource: tc, container: layer, viewport: viewport }).promise;
        }
        return null;
      }).then(function () {
        page.cleanup();
        return wrap;
      });
    });
  }

  FR.pdf = {
    open: open,
    extractReflow: extractReflow,
    renderPage: renderPage,
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
      isHeadingLine: isHeadingLine,
      joinItems: joinItems,
      median: median,
      PAGE_NUMBER: PAGE_NUMBER
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
