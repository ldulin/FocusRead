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
          w: it.width || 0, h: h, eol: !!it.hasEOL, rotated: true,
          font: it.fontName || ''
        });
        return;
      }

      // The font id comes along because a bullet is usually a single glyph
      // from a symbol font, and that is the only thing distinguishing it from
      // a letter: a filled circle in ZapfDingbats extracts as "d".
      out.push({ str: it.str, x: t[4], y: t[5], w: it.width || 0, h: h,
                 eol: !!it.hasEOL, font: it.fontName || '' });
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
  function detectColumns(boxes, pageWidth, opts) {
    var minBoxes = (opts && opts.minBoxes) || 12;
    // Enough runs to be meaningful, but not many. A PDF that emits one run per
    // LINE rather than per word gives a full two-column page only ~30 runs, and
    // a 40-run floor silently skipped column detection on every one of them -
    // so the two columns were read interleaved, half a sentence at a time.
    // False positives are held off by the gutter width and the 25%-each-side
    // test below, not by this count.
    if (boxes.length < minBoxes || !pageWidth) return null;

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

    // The bins LOCATE the gap; they must not be used to measure it. Each bin
    // is about three points wide and a box's coverage is rounded outward at
    // both ends, so a real fifteen-point gutter - a journal's Highlights
    // column beside its author list - measures as nine and fails the floor
    // below. Detection then gave up on the page and the two columns were read
    // interleaved, a line of one and a line of the other.
    //
    // Measure it from the boxes themselves: the rightmost edge wholly left of
    // the gap, and the leftmost edge wholly right of it. Anything spanning the
    // gap - the title above both columns - belongs to neither and is ignored.
    var midX = ((best.start + best.end + 1) / 2 / BINS) * pageWidth;
    var leftMax = -Infinity, rightMin = Infinity;
    boxes.forEach(function (b) {
      var r = b.x + Math.max(b.w, 1);
      if (r <= midX) leftMax = Math.max(leftMax, r);
      else if (b.x >= midX) rightMin = Math.min(rightMin, b.x);
    });
    if (!isFinite(leftMax) || !isFinite(rightMin)) return null;

    var gutterWidth = rightMin - leftMax;
    if (gutterWidth < pageWidth * 0.018) return null;          // too narrow to be a gutter

    var gutter = (leftMax + rightMin) / 2;

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
    if (gutter === null || gutter === undefined) return 0;
    return (b.x + b.w / 2) < gutter ? 0 : 1;
  }

  /*
   * Horizontal bands.
   *
   * A journal page often stacks two structures: a full-width summary, abstract
   * or title above, two columns of body below. One gutter cannot describe that
   * page, and trying got it wrong both ways. When the full-width block crossed
   * the gutter often enough, detection gave up and the body's two columns were
   * read as one, a line of each in turn - "Moreover, many prior models utilize
   * ... neuronal Sensory cortical systems can be measured". When it crossed
   * rarely enough to be tolerated, the gutter was found and the full-width
   * block was cut in half down it instead, the left halves of its lines read
   * together before either column.
   *
   * So the page is read as bands, cut at the rows that run the full width, and
   * each band finds its own columns - or none, for a band of full-width text.
   * A page with no full-width row is one band, and comes out exactly as a
   * single gutter would have it.
   */

  /** Rows of the page, top first, each with its runs sorted left to right. */
  function rowsOf(boxes) {
    var lineTol = Math.max(2, median(boxes.map(function (b) { return b.h; })) * 0.55);
    var sorted = boxes.slice().sort(function (a, b) { return b.y - a.y; });
    var rows = [], cur = null;
    sorted.forEach(function (b) {
      if (cur && Math.abs(b.y - cur.y) <= lineTol) {
        cur.boxes.push(b);
        cur.y = (cur.y * (cur.boxes.length - 1) + b.y) / cur.boxes.length;
      } else {
        cur = { y: b.y, boxes: [b] };
        rows.push(cur);
      }
    });
    rows.forEach(function (r) { r.boxes.sort(function (a, b) { return a.x - b.x; }); });
    return rows;
  }

  /**
   * What a row says about the page's structure at its height.
   *
   *  'split'   a gap wide enough to be a gutter, somewhere in the middle third
   *  'wide'    one stretch of text reaching from the left third to the right
   *            third - which no line of a two-column body can do
   *  'neutral' neither: text on one side only, a short heading, a page number
   *
   * Only a 'wide' row can change the structure. A neutral row - the blank
   * right column beside the end of a paragraph - says nothing, and letting it
   * cut the page would put the right column above the left one below it.
   */
  /** A row's runs, merged wherever the space between them is only a word space. */
  function spansOf(row, join) {
    var spans = [], cur = null;
    row.boxes.forEach(function (b) {
      var r = b.x + Math.max(b.w, 1);
      if (cur && b.x - cur.r <= join) { cur.r = Math.max(cur.r, r); }
      else { cur = { l: b.x, r: r }; spans.push(cur); }
    });
    return spans;
  }

  // Column keys for a running head and a footer: before and after any band.
  var HEAD_KEY = -2, FOOT_KEY = 100000;
  function isEdgeKey(col) { return col === HEAD_KEY || col === FOOT_KEY; }

  function rowJoin(pageWidth, bodyH) {
    return Math.max(pageWidth * 0.018, bodyH * 1.2) * 0.8;   // a word space, not a gutter
  }

  // The gap down the middle of a two-column row, or null. Given the page's
  // gutter `at`, only the gap that contains it: the first wide gap in a row
  // can be one inside a column - a centred equation and its number.
  function rowGap(row, pageWidth, bodyH, at) {
    var minGutter = Math.max(pageWidth * 0.018, bodyH * 1.2);
    var spans = spansOf(row, rowJoin(pageWidth, bodyH));
    for (var i = 1; i < spans.length; i++) {
      var gap = spans[i].l - spans[i - 1].r;
      var mid = (spans[i].l + spans[i - 1].r) / 2;
      var here = at === null || at === undefined || (spans[i - 1].r <= at && spans[i].l >= at);
      if (gap >= minGutter && mid > pageWidth * 0.30 && mid < pageWidth * 0.70 && here) {
        return { l: spans[i - 1].r, r: spans[i].l };
      }
    }
    return null;
  }

  function rowKind(row, pageWidth, bodyH) {
    if (rowGap(row, pageWidth, bodyH)) return 'split';
    var spans = spansOf(row, rowJoin(pageWidth, bodyH));
    for (var j = 0; j < spans.length; j++) {
      if (spans[j].l < pageWidth * 0.35 && spans[j].r > pageWidth * 0.65) return 'wide';
    }
    return 'neutral';
  }

  /*
   * Asides: a narrow column at the very edge of the page.
   *
   * Journals put a copyright and licence notice, or a received / accepted rail,
   * in a slim column beside the title and abstract. Its gutter is near the edge
   * - 80% across, not the middle third where a gutter is looked for - and only
   * about two ems wide, far short of what splits a line on its own. So each
   * line of the abstract was joined to the line of the notice beside it: "but
   * the causal pres- under a Creative sures driving these topographic motifs".
   *
   * What gives such a column away is that the same narrow gap runs down the
   * edge of the page for line after line, with prose on the far side of it. Its
   * text is then read on its own, after the block it stands beside.
   */
  var ASIDE_ZONES = { left: [0.06, 0.32], right: [0.68, 0.94] };

  function findAsides(rows, pageWidth, bodyH) {
    var minGap = Math.max(pageWidth * 0.018, bodyH * 1.5);
    var join = minGap * 0.8;
    var found = [];

    ['left', 'right'].forEach(function (side) {
      var zone = ASIDE_ZONES[side];
      var hits = [];
      rows.forEach(function (row, ri) {
        var sp = spansOf(row, join);
        for (var i = 1; i < sp.length; i++) {
          var l = sp[i - 1].r, r = sp[i].l;
          if (r - l < minGap) continue;
          var f = (l + r) / 2 / pageWidth;
          // The width of the text directly across the gap from the aside.
          var across = side === 'right' ? sp[i - 1].r - sp[i - 1].l : sp[i].r - sp[i].l;
          if (f >= zone[0] && f <= zone[1]) hits.push({ ri: ri, l: l, r: r, across: across });
        }
      });
      if (hits.length < 3) return;

      // It has to be the SAME gap on each row: group them by where it sits -
      // by its right-hand edge, which is fixed on both sides: the main text's
      // margin beside a left rail, the aside's own beside a right one. The
      // other edge is the end of a ragged line, and grouping by the middle let
      // a rail with long and short lines fall into two groups, half lifted out
      // and half left spliced into the abstract.
      hits.sort(function (a, b) { return a.r - b.r; });
      var groups = [], g = null;
      hits.forEach(function (h) {
        if (g && h.r - g.r0 <= pageWidth * 0.03) g.hits.push(h);
        else { g = { r0: h.r, hits: [h] }; groups.push(g); }
      });
      groups.sort(function (a, b) { return b.hits.length - a.hits.length; });
      var best = groups[0];
      var rowsHit = {};
      best.hits.forEach(function (h) { rowsHit[h.ri] = true; });
      if (Object.keys(rowsHit).length < 3) return;

      var zoneL = -Infinity, zoneR = Infinity, top = Infinity, bot = -Infinity;
      best.hits.forEach(function (h) {
        zoneL = Math.max(zoneL, h.l);
        zoneR = Math.min(zoneR, h.r);
        top = Math.min(top, h.ri);
        bot = Math.max(bot, h.ri);
      });
      if (zoneR - zoneL < minGap * 0.6) return;

      function onAsideSide(b) {
        return side === 'right' ? b.x >= zoneR - 1 : b.x + Math.max(b.w, 1) <= zoneL + 1;
      }
      function keepsClear(row) {
        return row.boxes.every(function (b) {
          return b.x >= zoneR - 1 || b.x + Math.max(b.w, 1) <= zoneL + 1;
        });
      }
      function hasAside(row) { return row.boxes.some(onAsideSide); }

      // Grow it over the rows next to it that still have text in the column
      // and nothing across the gap - the notice's first line often sits beside
      // a short running head, where the gap is no gap at all.
      while (top > 0 && keepsClear(rows[top - 1]) && hasAside(rows[top - 1])) top--;
      while (bot < rows.length - 1 && keepsClear(rows[bot + 1]) && hasAside(rows[bot + 1])) bot++;
      for (var k = top; k <= bot; k++) if (!keepsClear(rows[k])) return;

      var boxes = [];
      for (k = top; k <= bot; k++) rows[k].boxes.forEach(function (b) { if (onAsideSide(b)) boxes.push(b); });

      // Prose. A column of figures, or the line numbers down the margin of a
      // manuscript, has the same shape and must not be lifted out of place.
      var text = boxes.map(function (b) { return b.str; }).join(' ');
      var letters = (text.match(/[A-Za-z\u00C0-\u024F]/g) || []).length;
      var visible = (text.match(/\S/g) || []).length;
      if (!visible || letters / visible < 0.6) return;
      // And running prose, not a stack of labels. The axis and area names down
      // the side of a figure - "retina", "V1", "V2", "VTC" - are letters too,
      // but one word to a line; a notice set in a slim column still averages
      // two or three.
      var lineRows = 0;
      for (k = top; k <= bot; k++) if (rows[k].boxes.some(onAsideSide)) lineRows++;
      var words = (text.match(/[A-Za-z\u00C0-\u024F]{2,}/g) || []).length;
      if (words < 8 || words / Math.max(1, lineRows) < 1.8) return;

      var aL = Infinity, aR = -Infinity;
      boxes.forEach(function (b) { aL = Math.min(aL, b.x); aR = Math.max(aR, b.x + Math.max(b.w, 1)); });
      if (aR - aL > pageWidth * 0.35) return;          // a column, not a margin note

      // Beside running prose. Across the gap from a notice is the abstract,
      // most of the page wide. Across from the labels of a table it is the
      // column of values; across from the first of four news columns, the
      // second, as narrow as itself - those are one table, or one page of
      // columns, and are read as they stand.
      var wideAcross = best.hits.filter(function (h) {
        return h.across >= Math.max((aR - aL) * 2, pageWidth * 0.35);
      }).length;
      if (wideAcross < best.hits.length * 0.6) return;

      // And a passage in its own right, set line after line at one leading
      // (a paragraph break or two aside), not a term at the head of each
      // entry of a glossary.
      var ys = [];
      for (k = top; k <= bot; k++) if (rows[k].boxes.some(onAsideSide)) ys.push(rows[k].y);
      var steps = [];
      for (k = 1; k < ys.length; k++) steps.push(ys[k - 1] - ys[k]);
      var step = median(steps);
      var even = steps.filter(function (d) { return Math.abs(d - step) <= step * 0.25; }).length;
      if (!step || even < steps.length * 0.75 || steps.some(function (d) { return d > step * 3; })) return;

      // That wraps from line to line - a sentence carried on in lower case -
      // or that says what it is. A list of terms, one to a line and each
      // capitalised, does neither.
      var lineTexts = [];
      for (k = top; k <= bot; k++) {
        var t = rows[k].boxes.filter(onAsideSide).map(function (b) { return b.str; }).join(' ').trim();
        if (t) lineTexts.push(t);
      }
      var carried = lineTexts.slice(1).filter(function (t) { return /^[a-z\u00DF-\u00FF]/.test(t); }).length;
      var says = /copyright|\u00A9|licen[cs]e|creative commons|received|accepted|published|correspondence|doi|citation|editor|funding|open access/i.test(text);
      if (carried < (lineTexts.length - 1) * 0.25 && !says) return;

      boxes.forEach(function (b) { b.aside = side; });
      found.push({ side: side, bottomY: rows[bot].y });
    });
    return found;
  }

  /**
   * Which column each run belongs to, as a key that also orders the reading:
   * band by band from the top, left column before right within each.
   *
   * @returns {function(box): number}
   */
  function assignColumns(boxes, pageWidth) {
    boxes.forEach(function (b) { delete b.aside; delete b.band; delete b.edge; });
    if (!pageWidth || boxes.length < 12) {
      var tiny = detectColumns(boxes, pageWidth);
      return function (b) { return columnOf(b, tiny); };
    }

    var bodyH = median(boxes.map(function (b) { return b.h; })) || 10;
    // Asides come out first, so the rest of the page is judged without them.
    var asides = findAsides(rowsOf(boxes), pageWidth, bodyH);
    var main = asides.length ? boxes.filter(function (b) { return !b.aside; }) : boxes;

    var whole = detectColumns(main, pageWidth);
    var rows = rowsOf(main);

    // An aside is read after the band it ends beside: never in the middle of a
    // band, where it would cut a paragraph, and with a key that is not a whole
    // number so that it is known for an aside further on.
    var bandBottoms = [];
    function asideKey(b) {
      var a = asides.filter(function (x) { return x.side === b.aside; })[0];
      var bi = 0;
      for (var i = 0; i < bandBottoms.length; i++) {
        if (bandBottoms[i] <= a.bottomY + 0.5) { bi = i; break; }
        bi = i;
      }
      return bi * 2 + (b.aside === 'left' ? 1.25 : 1.5);
    }
    // A footer or running head set across the foot of a two-column page can
    // start well inside the left half - "Neuron 112, 2435-2451, July 17, 2024,
    // (c) 2024 Elsevier Inc." from 40% across - and so is not wide by the test
    // above. Left in with the columns it was cut at the gutter: "Neuron 112"
    // went to the end of the left column, where it was read in front of the
    // first words of the right one.
    //
    // Such a row is told by text running right across the gap between the
    // columns, and is looked for only from the edge of the page inward: a row
    // with column text beyond it is an overlong line of that column - a URL in
    // the last reference - and stays where it is. A row found this way is read
    // before or after everything else on the page and takes no part in the
    // bands below, so the page is otherwise laid out exactly as it was.
    var kinds = rows.map(function (row) { return rowKind(row, pageWidth, bodyH); });
    var firstSplit = kinds.indexOf('split'), lastSplit = kinds.lastIndexOf('split');
    var edgeOf = [];
    if (firstSplit >= 0) {
      // The gap is measured from the two-column rows - the typical one, so
      // that one odd row does not move it. A page whose top half is a full-
      // width summary has no page-wide gutter, and then any middle gap counts.
      var gapL = [], gapR = [];
      kinds.forEach(function (k, i) {
        if (k !== 'split') return;
        var g = rowGap(rows[i], pageWidth, bodyH, whole);
        if (g) { gapL.push(g.l); gapR.push(g.r); }
      });
      var gl = median(gapL), gr = median(gapR), reach = bodyH * 0.5;
      // Two columns of text, not a few figure labels with space between them:
      // a run of rows that agree on where the gap is.
      var agree = 0;
      for (var gi = 0; gi < gapL.length; gi++) {
        if (Math.abs(gapL[gi] - gl) <= bodyH && Math.abs(gapR[gi] - gr) <= bodyH) agree++;
      }
      if (agree >= 6 && agree >= gapL.length * 0.6) {
        var join = rowJoin(pageWidth, bodyH);
        var crosses = function (i) {
          return spansOf(rows[i], join).some(function (sp) {
            return sp.l < gl - reach && sp.r > gr + reach;
          });
        };
        var rowH = function (i) {
          return rows[i].boxes.reduce(function (m, b) { return Math.max(m, b.h || 0); }, 0) || bodyH;
        };
        var walk = function (from, to, step, side) {
          for (var i = from; i !== to; i += step) {
            if (kinds[i] !== 'neutral') return;
            if (crosses(i)) {
              // The last line of a block of the body that runs across the
              // page - a footnote, a caption - sits at that block's own line
              // spacing. A running head or a footer stands apart.
              var j = i + step;
              if (j >= 0 && j < rows.length && (kinds[j] !== 'neutral' || !crosses(j)) &&
                  Math.abs(rows[i].y - rows[j].y) <= Math.max(rowH(i), rowH(j)) * 1.8) return;
              edgeOf[i] = side;
              continue;
            }
            var t = rows[i].boxes.map(function (b) { return b.str; }).join(' ');
            if (t.trim() && !PAGE_NUMBER.test(t)) return;
          }
        };
        walk(rows.length - 1, lastSplit, -1, 'foot');
        walk(0, firstSplit, 1, 'head');
      }
    }
    rows.forEach(function (row, i) {
      if (edgeOf[i]) row.boxes.forEach(function (b) { b.edge = edgeOf[i]; });
    });
    var edgeKey = function (b) { return b.edge === 'head' ? HEAD_KEY : FOOT_KEY; };
    var single = function (b) {
      if (b.edge) return edgeKey(b);
      return b.aside ? asideKey(b) : columnOf(b, whole);
    };

    // With an aside on the page, a full-width band ends where the aside does,
    // at the first paragraph gap below it - so that the aside, read after its
    // band, comes straight after the abstract it stands beside, and not after
    // the heading and first lines of the body that open beneath it.
    var asideLow = asides.length ? Math.min.apply(null, asides.map(function (a) { return a.bottomY; })) : null;

    var bands = [], cur = null, prev = null;
    var tallest = function (row) { return row.boxes.reduce(function (m, b) { return Math.max(m, b.h || 0); }, 0) || bodyH; };
    rows.forEach(function (row, ri) {
      if (edgeOf[ri]) return;
      var kind = kinds[ri];
      // A paragraph gap by the rows' own type: the page's typical run can be
      // small print, and then an abstract's ordinary leading looks like one.
      var cut = asideLow !== null && cur && cur.kind === 'wide' && kind === 'neutral' &&
        row.y < asideLow - 0.5 && prev !== null &&
        prev.y - row.y > Math.max(tallest(prev), tallest(row)) * 1.8;
      prev = row;
      if (cut) { cur = { kind: null, rows: [row] }; bands.push(cur); return; }
      if (!cur) { cur = { kind: kind === 'neutral' ? null : kind, rows: [row] }; bands.push(cur); return; }
      if (kind === 'neutral' || kind === cur.kind || cur.kind === null) {
        if (cur.kind === null && kind !== 'neutral') cur.kind = kind;
        cur.rows.push(row);
        return;
      }
      cur = { kind: kind, rows: [row] };
      bands.push(cur);
    });

    bands.forEach(function (band) { bandBottoms.push(band.rows[band.rows.length - 1].y); });

    // No full-width row anywhere: an ordinary page, and one gutter is right.
    if (!bands.some(function (b) { return b.kind === 'wide'; })) {
      bandBottoms = [];
      return single;
    }

    var gutterOf = [];
    bands.forEach(function (band, bi) {
      var inBand = [];
      band.rows.forEach(function (r) { r.boxes.forEach(function (b) { b.band = bi; inBand.push(b); }); });
      if (band.kind === 'wide') { gutterOf[bi] = null; return; }
      // A band finds its own gutter. A short one may not have runs enough to
      // be sure, and then the page's own gutter is the best guess - it is the
      // same body text, only interrupted.
      var g = detectColumns(inBand, pageWidth, { minBoxes: 6 });
      // Too few runs to scan at all - two labels side by side in a figure,
      // between a running head and the caption - but its rows are split rows,
      // each with its gap: where they all agree, that is the gutter. Only
      // then: a band with runs enough that the scan found no gutter has none
      // to be found this way either.
      if (g === null && band.kind === 'split' && inBand.length < 6) {
        var gs = [];
        band.rows.forEach(function (r) {
          var gg = rowGap(r, pageWidth, bodyH);
          if (gg) gs.push(gg);
        });
        var lo = Math.max.apply(null, gs.map(function (x) { return x.l; }));
        var hi = Math.min.apply(null, gs.map(function (x) { return x.r; }));
        if (gs.length >= 2 && hi > lo) g = (lo + hi) / 2;
      }
      gutterOf[bi] = g !== null ? g : whole;
    });

    return function (b) {
      if (b.edge) return edgeKey(b);
      if (b.aside) return asideKey(b);
      var bi = b.band || 0;
      return bi * 2 + columnOf(b, gutterOf[bi]);
    };
  }

  /**
   * Group boxes into visual lines.
   * @param {number|null|function} gutter the gutter's x, null for one column,
   *   or a function giving each box its column key (see assignColumns)
   */
  var NOT_A_MARK = /[0-9=+\-\u2212\u00D7\u00F7\u00B1<>()\[\]{}\/\\|~^.,;:!?'"%$#&@*_\u2018\u2019\u201C\u201D\u2032\u2033\u2190-\u21FF\u2200-\u22FF]/;

  function toLines(boxes, gutter) {
    var heights = boxes.map(function (b) { return b.h; });
    var lineTol = Math.max(2, median(heights) * 0.55);

    var colOf = typeof gutter === 'function' ? gutter : function (b) { return columnOf(b, gutter); };
    boxes.forEach(function (b) { b.col = colOf(b); });
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

    // A gap of many ems inside one "line" is not a space. It is two different
    // regions of the page that happen to sit at the same height - a marginal
    // badge beside an abstract, a date rail beside an author list - and joining
    // them splices one into the middle of the other's sentence: "ventral
    // streams. A Check for updates long-standing hypothesis is that...".
    // A word space is about a quarter of an em, so eight is far beyond any
    // spacing within a line of prose.
    var farApart = Math.max(24, median(heights) * 8);

    /*
     * A list marker is one glyph from a different font than the text it
     * introduces - a filled circle in a dingbat font, which extracts as the
     * letter "d" and was read out as "d". Nothing in the characters says so;
     * the font change does.
     */
    function markerNormalised(items) {
      var first = items[0];
      if (items.length < 2 || !first.font) return items;
      var ch = String(first.str).trim();
      if (ch.length !== 1) return items;
      // Only from a font that sets nothing else: the Cell Press dingbat font
      // has the one glyph "d", always first on its line. A glyph from any
      // other font is a word, an option letter, a variable or an operator -
      // "A  The mitochondrion", "tau  membrane time constant", "x  -1.5", the
      // ")" closing a line of code - and is to be read, however wide the space
      // after it.
      if (!markerFonts[first.font] || !markerFonts[first.font][ch]) return items;
      // Against the next run with something VISIBLE in it. Cell Press sets the
      // bullet as "d" and then a space, both in the dingbat font, so the run
      // right after the bullet is in the bullet's own font - comparing with
      // that one never saw a change and left the "d" to be read out.
      var next = null;
      for (var n = 1; n < items.length; n++) {
        if (String(items[n].str).trim()) { next = items[n]; break; }
      }
      if (!next || !next.font || next.font === first.font) return items;
      // And it stands apart from its text, by a space at least: the bold
      // panel label of "a, Mean response" runs straight into its comma. A
      // number is a section or list number, which has to be kept.
      if (/^\d$/.test(String(first.str).trim())) return items;
      var h = Math.max(first.h || 0, next.h || 0) || 8;
      if (next.x - (first.x + first.w) < h * 0.3) return items;
      var out = items.slice();
      // A copy of the run - its page-view span included, so that the span
      // still moves into its paragraph - with the bullet for its text.
      var mark = {};
      for (var key in first) {
        if (Object.prototype.hasOwnProperty.call(first, key)) mark[key] = first[key];
      }
      mark.str = '\u2022';
      out[0] = mark;
      return out;
    }

    function finishLine(ln, items) {
      items = markerNormalised(items);
      // Where the TEXT of the line starts, as opposed to its marker. A bullet
      // hangs to the left of its own text, so comparing the next line against
      // `left` made every wrapped list item look like a fresh indented
      // paragraph and split it in two.
      var textLeft = items[0].x;
      for (var t = 0; t < items.length; t++) {
        if (String(items[t].str).trim().length > 1) { textLeft = items[t].x; break; }
      }
      return {
        col: ln.col,
        // Its OWN height on the page. A line split off from a wider row kept
        // the row's averaged y, which a marginal badge sitting higher dragged
        // up by two points - enough, against the break threshold, to split an
        // abstract mid-sentence at "...into streams" / "emerged to support".
        y: items.reduce(function (m, b) { return m + b.y; }, 0) / items.length,
        items: items,
        left: items[0].x,
        textLeft: textLeft,
        right: items.reduce(function (m, b) { return Math.max(m, b.x + b.w); }, 0),
        h: median(items.map(function (b) { return b.h; })),
        textH: textHeight(items),
        text: joinItems(items)
      };
    }

    var runs = [];
    lines.forEach(function (ln) {
      ln.items.sort(function (a, b) { return a.x - b.x; });
      var run = [ln.items[0]];
      for (var k = 1; k < ln.items.length; k++) {
        var last = run[run.length - 1];
        if (ln.items[k].x - (last.x + last.w) > farApart) {
          runs.push({ ln: ln, items: run });
          run = [];
        }
        run.push(ln.items[k]);
      }
      runs.push({ ln: ln, items: run });
    });

    // Fonts that set nothing on this page but one glyph at the start of a
    // line: a bullet font. See markerNormalised.
    var fontUse = Object.create(null);
    runs.forEach(function (r) {
      var firstSeen = false;
      r.items.forEach(function (it) {
        var t = String(it.str).trim();
        if (!t || !it.font) return;
        var u = fontUse[it.font] || (fontUse[it.font] = { chars: Object.create(null), other: false });
        if (!firstSeen && t.length === 1) u.chars[t] = (u.chars[t] || 0) + 1;
        else u.other = true;
        firstSeen = true;
      });
    });
    var markerFonts = Object.create(null);
    Object.keys(fontUse).forEach(function (f) {
      var u = fontUse[f];
      if (u.other) return;
      // Option letters and panel labels run A, B, C - a dingbat font's glyphs
      // ("d" a filled square, "B" a hollow one in Cell Press) do not.
      if ((u.chars.A && u.chars.B) || (u.chars.a && u.chars.b)) return;
      // Each mark more than once: a list has items. A page whose only
      // math-font glyphs are the "W" that starts one line, or the symbols of a
      // notation list, has no list.
      // And never an operator, a bracket, punctuation or a digit: two
      // multiplication signs starting the rows of a figure's equation are
      // the only glyphs of their font on that page too.
      var marks = Object.create(null), any = false;
      Object.keys(u.chars).forEach(function (c) {
        if (u.chars[c] >= 2 && !NOT_A_MARK.test(c)) { marks[c] = true; any = true; }
      });
      if (any) markerFonts[f] = marks;
    });

    var out = runs.map(function (r) { return finishLine(r.ln, r.items); });

    return out.filter(function (ln) { return ln.text.trim().length > 0; });
  }

  /*
   * The size most of a line's words are set in: the height of its runs
   * weighted by how many letters each holds. A drop cap, a line number, a
   * section number or a superscript is one run of a line's few - and moved
   * the plain median far enough to make the first line of an abstract, or
   * every line of a preprint, look like a heading, and a preprint's "6
   * LIMITATIONS" look like body text.
   */
  var LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g;
  function textHeight(items) {
    var hs = [], cap = null;
    items.forEach(function (b) {
      var s = String(b.str).trim();
      var letters = s.match(LETTER) || [];
      if (!letters.length) return;
      var h = b.h;
      // Small capitals take the size of the capital before them: "L" at
      // 12pt and "IMITATIONS" at 9.6 is a heading set at 12.
      if (cap && letters.join('') === letters.join('').toUpperCase() && letters.length > 1 && cap > h) h = cap;
      cap = letters.length === 1 && /[A-Z]/.test(letters[0]) ? b.h : null;
      for (var k = 0; k < Math.min(letters.length, 200); k++) hs.push(h);
    });
    return hs.length ? median(hs) : median(items.map(function (b) { return b.h; }));
  }
  function sizeOf(l) { return (l && (l.textH || l.h)) || 0; }

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

  /*
   * Facing pages put the page number at the OUTER edge, so the same footer is
   * "2436 Neuron 112, 2435-2451, July 17, 2024" on one page and "Neuron 112,
   * 2435-2451, July 17, 2024 2437" on the next. Taken whole, each version is on
   * only half the pages and neither looked repeated, so every footer of a Cell
   * Press paper was read out. A page number (or an "e3"-style supplement page
   * number, or the "ll" Cell Press mark beside it) at either end is not what
   * makes a footer the same footer, so it is left out of the comparison.
   */
  var EDGE_TOKEN = /^(?:[a-z]?#[a-z]?(?:[\-\u2013\u2014][a-z]?#[a-z]?)?|[|\u00B7\u2022.\-\u2013\u2014]+|ll)$/;

  function normaliseForRepeat(s) {
    var t = s.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
    var words = t.split(' ');
    while (words.length > 2 && EDGE_TOKEN.test(words[0])) words.shift();
    while (words.length > 2 && EDGE_TOKEN.test(words[words.length - 1])) words.pop();
    return words.join(' ');
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
  /*
   * How far in from the top and bottom a running head can be. A tenth missed
   * Cell Press's "Article", 79pt down a 783pt page: 89.9% of the way up. Only
   * lines in this band are looked at, and what is looked at still has to
   * repeat, so body text here is safe.
   */
  var EDGE_BAND = 0.12;

  // A bare number is taken for a page number without having to repeat, so it
  // keeps the narrower band: four lines up a Nature page, "1989." can be the
  // end of a sentence.
  var NUMBER_BAND = 0.10;
  function atNumberEdge(y, h) {
    return !h || y >= h * (1 - NUMBER_BAND) || y <= h * NUMBER_BAND;
  }

  function edgeLines(page) {
    var h = page.height || 0;
    if (!h) return page.lines.slice(0, 2).concat(page.lines.slice(-2));
    var topBand = h * (1 - EDGE_BAND), bottomBand = h * EDGE_BAND;
    return page.lines.filter(function (ln) {
      return ln.y >= topBand || ln.y <= bottomBand;
    });
  }

  var ARTICLE_TYPE = /^(article|articles|resource|report|reports|review|reviews|perspective|perspectives|letter|letters|research|analysis|brief|communication|commentary|editorial|opinion|feature|essay|primer|preview|previews|insight|insights|correspondence|neuron|neuroscience)$/;

  // No other line just above or below it, overlapping it across the page.
  function standsAlone(lines, ln) {
    var h = ln.h || 8;
    return !lines.some(function (o) {
      if (o === ln) return false;
      var near = Math.abs(o.y - ln.y) < Math.max(h, o.h || 0) * 1.6;
      var over = Math.min(o.right, ln.right) - Math.max(o.left, ln.left) > 2;
      return near && over;
    });
  }

  function findRunningHeads(pages) {
    // No prototype: a line reading "constructor" is not already a head.
    var counts = Object.create(null);
    var n = pages.length;
    if (n < 3) return Object.create(null);

    // Slides: a title word repeated from slide to slide is a title.
    var landscape = pages.filter(function (p) { return p.width && p.height && p.width > p.height; }).length > n / 2;

    pages.forEach(function (page, idx) {
      var seen = Object.create(null);
      var num = page.page || idx + 1;
      var h = page.height || 800;
      edgeLines(page).forEach(function (ln) {
        if (!isFurniture(ln.text)) return;
        var key = normaliseForRepeat(ln.text);
        if (!key || seen[key]) return;
        seen[key] = 1;
        if (!counts[key]) counts[key] = [];
        counts[key].push({ at: ln.y / h, page: num, text: ln.text, alone: standsAlone(page.lines, ln) });
      });
    });

    var threshold = Math.max(3, Math.ceil(n * 0.4));
    var heads = Object.create(null);
    Object.keys(counts).forEach(function (k) {
      // Same text in the same place. Counted at its usual height: the Cell
      // Press mark is at the top of every page but the first, where it is at
      // the foot - and judged by its whole spread it was in no one place.
      var mid = median(counts[k].map(function (o) { return o.at; }));
      var at = counts[k].filter(function (o) { return Math.abs(o.at - mid) <= 0.03; });
      // One word ("Article") only as a running head proper: on five pages or
      // more, and not in a slide deck - not "Results" over three slides. And
      // only a word that names the kind of article, or one standing alone: in
      // a document of figures "Left" heads every page, over "Hemisphere".
      var oneWord = k.indexOf(' ') < 0 && k !== 'll';
      if (oneWord && landscape) return;
      if (oneWord && !ARTICLE_TYPE.test(k)) at = at.filter(function (o) { return o.alone; });
      var nAt = at.length;
      if (!nAt) return;
      var first = Math.min.apply(null, at.map(function (o) { return o.page; }));
      var last = Math.max.apply(null, at.map(function (o) { return o.page; }));
      // On most pages - or on nearly every page of one stretch of them. The
      // supplement at the back of a paper has a footer of its own ("e3 Neuron
      // 112, 2435-2451.e1-e7"), on all seven of its pages but on too few of
      // the whole paper's to pass the first test. Only for a footer of that
      // kind - numbered, set out with separators, at the foot of the page - so
      // that a slide title over four overlays, or "Supplementary Figure 3" at
      // the head of each of the figures, is still read.
      var structured = k.indexOf('#') >= 0 && /[,|\u00B7\u2022\u2014\u2013]/.test(at[0].text);
      var stretch = structured && mid <= EDGE_BAND && nAt >= 4 && nAt >= (last - first + 1) * 0.8;
      if (nAt < (oneWord ? Math.max(5, threshold) : threshold) && !stretch) return;
      heads[k] = { at: mid };
    });
    return heads;
  }

  /*
   * Whether a line at the top or bottom of a page is one of the running heads.
   *
   * Only at the head's own height: a thesis's running head repeats the
   * chapter title, which on the chapter's opening page is a line of the body
   * just inside the edge band. (The Cell Press mark is the exception; it moves
   * to the foot on the first page.)
   *
   * The first page of an article often runs its footer on with more - "Neuron
   * 112, 2435-2451, July 17, 2024 (c) 2024 Elsevier Inc. All rights reserved."
   * - and is the only page with that line, so it never repeats. A line that
   * STARTS with a running head is that head. Only for a head with a number in
   * it: "Nature Neuroscience" alone could begin a sentence at the foot of a
   * page, a volume and page range cannot.
   *
   * @param {number} [y] the line's height on the page, and
   * @param {number} [pageHeight] the page's, to compare where they sit
   */
  function isRunningHead(heads, text, y, pageHeight) {
    if (!heads) return false;
    var key = normaliseForRepeat(text);
    var own = Object.prototype.hasOwnProperty;
    function near(k) {
      var at = heads[k] && heads[k].at;
      if (typeof at !== 'number' || typeof y !== 'number' || !pageHeight) return true;
      if (/^ll(?: ll)*$/.test(k)) return true;
      return Math.abs(y / pageHeight - at) <= 0.03;
    }
    if (own.call(heads, key)) return near(key);
    for (var k in heads) {
      if (!own.call(heads, k)) continue;
      if (k.length < 16 || k.indexOf('#') < 0 || k.split(' ').length < 3) continue;
      if (key.length > k.length && key.indexOf(k) === 0 && /[\s,;:.|]/.test(key.charAt(k.length)) && near(k)) return true;
    }
    return false;
  }

  var PAGE_NUMBER = /^[\s|.\-\u2013\u2014]*(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?[\s|.\-\u2013\u2014]*$/i;

  /**
   * Guard against deleting real prose.
   *
   * Because normaliseForRepeat() turns every digit into a placeholder, any line
   * that differs between pages ONLY by a number looks repeated. That is exactly
   * what a running head is - and it would also match a body line that happened
   * to differ only in a figure number. Running heads are short, and they are
   * not mid-sentence continuations, so require both.
   */
  /*
   * Publisher chrome that sits in the MARGIN rather than at a page edge, so
   * the running-head machinery never looks at it.
   *
   * The Crossmark badge is beside the abstract on most journal first pages and
   * lands between two of its lines. That split the abstract in two - "ventral
   * streams. A" and "long-standing hypothesis is that..." as separate reading
   * units - and before lines were split on their gaps it was spliced into the
   * sentence itself. Matched whole and exactly: a short line that merely
   * mentions updates is not this.
   */
  var MARGIN_BADGE = /^check for updates$/i;

  function isFurniture(text) {
    var t = String(text).trim();
    // Heads are short - or, set right across the page, carry their numbers:
    // "Local-Global Parcellation of the Human Cerebral Cortex Schaefer et al. |
    // 3111", "Ann. N.Y. Acad. Sci. 1396 (2017) 166-182 (c) 2017 New York
    // Academy of Sciences." Prose that repeats at the same place on page after
    // page, numbers and all, is not a thing that happens.
    var numbered = (t.match(/\d+/g) || []).length >= 2 ||
      (/\d/.test(t) && /[|\u00B7\u2022\u00A9]|\b(doi|vol)\b/i.test(t));
    if (!t || t.length > 160 || (t.length > 70 && !numbered)) return false;
    if (/^ll(?:\s+ll)*$/.test(t)) return true;          // the Cell Press mark
    if (/^(https?:\/\/|www\.|doi:\s*)\S+$/i.test(t)) return true;   // the article's DOI
    // A sentence continuing - but "e3", a supplement's page number, is not,
    // nor is "nature neuroscience VOLUME 19 | NUMBER 3 | MARCH 2016".
    var setOut = numbered && /[|\u00B7\u2022]/.test(t);
    if (!setOut && /^[\p{Ll}]/u.test(t.replace(/^[a-z]\d+[a-z]?\s+/, ''))) return false;
    if (PAGE_NUMBER.test(t)) return true;               // a bare page number is
    if (!numbered && /[.!?]["'\u2019\u201D)\]]?$/.test(t) && t.split(/\s+/).length > 6) return false;

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
    // One word with no number in it collapses into nothing else: "Article" at
    // the head of every page of a Cell Press paper is the same line each time,
    // and was read out in the middle of whatever sentence crossed the page.
    if (tokens.length === 1 && !/\d/.test(t) && residue.length >= 3) return true;
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

  /** Does a finished sentence end inside this line (not just at its end)? */
  function hasInnerTerminator(text) {
    var t = String(text || '');
    var masked = t;
    if (FR.segmenter && FR.segmenter.mask) {
      try { masked = FR.segmenter.mask(t); } catch (e) { /* use the raw text */ }
    }
    return /[.!?]\s+\S/.test(masked);
  }

  // A title is set in display type - two or three times the body. A lead
  // paragraph or an abstract is set only slightly larger, in the same band as
  // many section headings, so size alone cannot tell those two apart.
  // A line opening with a list marker starts a new item, however it is laid
  // out. Without this, normalising the marker to a bullet let consecutive
  // items run together into one block.
  var LIST_MARKER = /^[\u2022\u00B7\u25E6\u2023\u2043\u2219]\s/;

  var DISPLAY_TYPE = 1.6;
  var LARGER_TYPE = 1.18;

  /**
   * Is this line a heading rather than body text?
   *
   * @param {object} ln the line
   * @param {number} bodyHeight median line height for the document
   * @param {{rightEdge:number, prev:object}} [ctx] the measure this line is set
   *   to and the line before it. Without it, any larger-than-body line counts
   *   as a heading, which is what this used to do on its own - and what made
   *   every line of a journal abstract a heading of its own.
   */
  function isHeadingLine(ln, bodyHeight, ctx) {
    var t = ln.text.trim();
    if (t.length > 90 || t.length < 3) return false;

    var ratio = ln.h / bodyHeight;
    // A title, unambiguously - if its words are big, and not just a drop cap.
    if (ratio > DISPLAY_TYPE && sizeOf(ln) / bodyHeight > LARGER_TYPE) return true;
    if (ratio > LARGER_TYPE) {
      var edge = ctx && ctx.rightEdge;
      if (!edge) return true;                       // no measure to judge by
      // What separates a lead paragraph from a heading of the same size is the
      // measure: the paragraph's lines run to the right margin, a heading
      // stops well short of it.
      var fills = function (l) { return l && l.right >= edge - bodyHeight * 4; };
      // A lead paragraph is several lines at its size. One line clearly
      // bigger than the lines either side of it, not ending as a sentence
      // does, is a heading however far across it runs: "(b) Anterior versus
      // posterior hippocampal function", nearly the column's width, at 14pt
      // between lines at 9. Clearly: a line number or a superscript changes a
      // line's height by a point or so, and that is not a heading.
      // Nor is a line that carries a sentence on, or holds one. And the sizes
      // compared are those of the lines' words (see textHeight): a line
      // number set large, or a drop cap, makes a line look a point bigger.
      var smaller = function (l) { return l && sizeOf(l) * 1.15 <= sizeOf(ln); };
      if (fills(ln)) {
        return !!ctx.prev && !!ctx.next && smaller(ctx.prev) && smaller(ctx.next) &&
          !TERMINAL_AT_END.test(t) && !hasInnerTerminator(t) &&
          TERMINAL_AT_END.test(String(ctx.prev.text).trim());
      }
      // A short line carrying on from a filled line of the SAME size is that
      // paragraph's last line - "local spatial constraints." - not a heading.
      var prev = ctx.prev;
      if (prev && prev.col === ln.col && Math.abs(prev.h - ln.h) < 0.5 && fills(prev)) {
        return false;
      }
      return true;
    }

    // A numbered heading: "3. Results", "3.1 Data analysis", "1 Introduction".
    //
    // The capital is load-bearing. Without it the same pattern matches a line
    // that merely BEGINS with a decimal measurement - "6.5 min. The dataset is
    // open access. We" - which was then treated as a heading, forcing a
    // paragraph break either side of it. That stranded "Each run took" and
    // "6.5 min." as separate reading units: the line-by-line reading that kept
    // being reported.
    //
    // The terminator test is the second guard: a heading does not contain a
    // finished sentence. It runs on the masked text so "Fig. 3" and "et al."
    // do not count as one.
    if (/^\d+(\.\d+)*\.?\s+[A-Z]/.test(t) &&
        t.length < 70 &&
        !/[.;]$/.test(t) &&
        !hasInnerTerminator(t)) return true;
    var WORDS = ['abstract', 'introduction', 'background', 'methods', 'materials and methods',
      'results', 'discussion', 'conclusion', 'conclusions', 'references', 'acknowledgements',
      'acknowledgments', 'related work', 'limitations', 'supplementary information', 'data availability'];
    return WORDS.indexOf(t.toLowerCase().replace(/^\d+[.\s]*/, '')) !== -1;
  }

  /**
   * Are these two heading lines one heading, wrapped?
   *
   * A paper's title runs to two or three lines of display type. Each line is a
   * heading by itself, and a heading breaks the block before and after it - so
   * a wrapped title came out as one block per line: "A single computational
   * objective can", "produce specialization of streams in", "visual cortex".
   *
   * Same column, same size, and close enough together to be consecutive lines
   * of one setting.
   *
   * The gap is measured against the LINE's own height and nothing else.
   * Display type is leaded in proportion to itself - 27.9pt for a 25.9pt
   * title - so the body's line spacing is the wrong yardstick; and taking the
   * page's median gap as a fallback made the test meaningless on a page whose
   * median gap is itself large, merging two headings a third of a page apart.
   */
  function sameHeadingRun(prev, ln) {
    if (!prev || !ln) return false;
    if (prev.col !== ln.col) return false;
    if (Math.abs(prev.h - ln.h) > 0.5) return false;
    return (prev.y - ln.y) <= ln.h * 1.8;
  }

  /**
   * Turn a page's lines into blocks, then merge blocks across page breaks when
   * a paragraph obviously continues.
   */
  /*
   * Where a page's lines break into paragraphs. One function for both the
   * reading view and the page image, so that the two group a page alike.
   *
   * @returns {function(number): {breakHere:boolean, heading:boolean}} for the
   *   line at each index
   */
  function paragraphBreaks(lines, bodyHeight) {
    var gaps = [];
    for (var i = 1; i < lines.length; i++) {
      if (lines[i].col === lines[i - 1].col) gaps.push(lines[i - 1].y - lines[i].y);
    }
    var normalGap = median(gaps.filter(function (g) { return g > 0; })) || bodyHeight * 1.2;

    // The spacing just around a line, in its own column: a page of small
    // reference text sets the page's typical gap, and against that the body's
    // ordinary leading looks like a break at every sentence end.
    var gapAt = function (k) {
      return k > 0 && k < lines.length && lines[k].col === lines[k - 1].col ? lines[k - 1].y - lines[k].y : null;
    };
    // Only where that spacing is steady: a superscript, or a fragment set
    // apart on a line of its own, throws the gaps about by a point or two,
    // and a sentence ending beside one is not a paragraph's end.
    var localGap = function (idx) {
      var near = [];
      [idx - 2, idx - 1, idx + 1, idx + 2].forEach(function (k) {
        var g = gapAt(k);
        if (g !== null && g > 0 && lines[k].col === lines[idx].col) near.push(g);
      });
      if (near.length < 2) return 0;
      var lo = Math.min.apply(null, near), hi = Math.max.apply(null, near);
      return hi - lo <= Math.max(0.6, hi * 0.06) ? hi : 0;
    };

    var edges = columnEdges(lines);
    var leftEdge = lines.reduce(function (m, ln) { return Math.min(m, ln.left); }, Infinity);
    var indentTol = bodyHeight * 0.8;
    var ctxOf = function (idx) {
      var l = lines[idx];
      return { rightEdge: edges[l.col || 0] || 0, prev: lines[idx - 1], next: lines[idx + 1] };
    };

    return function (idx) {
      var ln = lines[idx], prev = lines[idx - 1];
      var heading = isHeadingLine(ln, bodyHeight, ctxOf(idx));
      var prevHeading = !!prev && isHeadingLine(prev, bodyHeight, ctxOf(idx - 1));
      // One heading wrapped over several lines stays one block.
      var sameHeading = heading && prevHeading && sameHeadingRun(prev, ln);

      var breakHere = !prev || LIST_MARKER.test(ln.text) ||
        (!sameHeading && (heading || prevHeading));
      // Not for a wrapped heading: the tests below are about paragraph shape,
      // and display type is leaded far wider than a paragraph - the gap test
      // would put the break back in that sameHeading just took out.
      if (!breakHere && !sameHeading) {
        if (prev.col !== ln.col) breakHere = true;
        else {
          var gap = prev.y - ln.y;
          var startsAnew = endsSentence(prev.text) && /^[A-Z\u2022\u00B7(\[]/.test(ln.text);
          if (gap > normalGap * 1.45) breakHere = true;
          // A little more space than the lines on either side of it, between
          // a sentence's end and a capital: the entries of a reference list,
          // the short paragraphs of back matter, set apart by a point or two.
          else if (startsAnew && localGap(idx) && gap > localGap(idx) * 1.12) breakHere = true;
          else if (ln.left - leftEdge > indentTol &&
                   ln.left - (prev.textLeft || prev.left) > indentTol) breakHere = true;
          // A short last line followed by a capital is a paragraph end.
          else if (prev.right < (edges[prev.col || 0] || 0) - bodyHeight * 3 && startsAnew) breakHere = true;
        }
      }
      return { breakHere: breakHere, heading: heading };
    };
  }

  function linesToBlocks(lines, bodyHeight, joinHyphens) {
    if (!lines.length) return [];
    var breaks = paragraphBreaks(lines, bodyHeight);
    var blocks = [], cur = null;

    lines.forEach(function (ln, idx) {
      var prev = lines[idx - 1];
      var br = breaks(idx);
      if (br.breakHere || !cur) {
        cur = {
          type: br.heading ? 'h' : 'p',
          lines: [ln.text],
          brokeColumn: !!(prev && prev.col !== ln.col),
          aside: ((ln.col || 0) % 1) !== 0,
          edge: isEdgeKey(ln.col)
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
        aside: !!b.aside,
        edge: !!b.edge,
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
      // The paragraph this one might continue is the last one that is not an
      // aside: a notice read between two halves of a paragraph must not stop
      // them being joined, and it then follows the joined paragraph instead.
      // A running head or a footer between them is passed over the same way,
      // and is never joined to anything: "...in terms of shared or" is not
      // continued by "nature neuroscience VOLUME 19".
      var k = out.length - 1;
      while (k >= 0 && (out[k].aside || out[k].edge) && !b.aside && !b.edge) k--;
      var prev = out[k];
      var continues = prev && !b.aside && !b.edge && !prev.edge &&
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

              var lines = toLines(boxes, assignColumns(boxes, base.width));
              lines.forEach(function (ln) { allHeights.push(ln.h); });
              perPage.push({
                page: pageNum,
                lines: lines,
                height: base.height,
                width: base.width,
                // Two columns if any line landed in a right-hand column. The
                // column key is band * 2 + side, so an odd key is a right one.
                columns: lines.some(function (ln) { return (ln.col || 0) % 2 === 1; }) ? 2 : 1
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
        var topBand = h * (1 - EDGE_BAND), bottomBand = h * EDGE_BAND;
        var lines = p.lines.filter(function (ln) {
          // Index-based edges are wrong once lines are sorted by column: entry
          // 0 is the top of the LEFT column and the last entry is the foot of
          // the RIGHT one, so a two-column page had its real header kept and a
          // mid-page line examined instead.
          if (MARGIN_BADGE.test(ln.text.trim())) { removedLines++; return false; }
          var atEdge = h ? (ln.y >= topBand || ln.y <= bottomBand) : true;
          if (!atEdge) return true;
          if (atNumberEdge(ln.y, h) && PAGE_NUMBER.test(ln.text)) { removedLines++; return false; }
          if (isRunningHead(heads, ln.text, ln.y, h)) { removedLines++; return false; }
          return true;
        });
        return { page: p.page, lines: lines, columns: p.columns };
      });

      var blocks = [];
      kept.forEach(function (p) {
        var pageBlocks = linesToBlocks(p.lines, bodyHeight, opts.joinHyphens !== false);
        // The first block of the page's body: a running head kept above it
        // must not stop a sentence from the page before carrying on into it.
        var bodySeen = false;
        pageBlocks.forEach(function (b) {
          b.page = p.page;
          b.firstOnPage = !bodySeen && !b.edge && !b.aside;
          if (!b.edge && !b.aside) bodySeen = true;
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

    var lines = toLines(boxes, assignColumns(boxes, viewport.width));
    if (!lines.length) return 0;

    var bodyHeight = median(lines.map(function (l) { return l.h; })) || 10;

    // Drop the furniture, so the running head is not read out mid-page the way
    // it used to be in this view.
    if (opts.stripRunningHeads !== false) {
      var top = viewport.height * (1 - EDGE_BAND), bottom = viewport.height * EDGE_BAND;
      lines = lines.filter(function (ln) {
        if (MARGIN_BADGE.test(ln.text.trim())) { hide(ln); return false; }
        var atEdge = ln.y >= top || ln.y <= bottom;
        if (!atEdge) return true;
        if (atNumberEdge(ln.y, viewport.height) && PAGE_NUMBER.test(ln.text)) { hide(ln); return false; }
        if (isRunningHead(opts.heads, ln.text, ln.y, viewport.height)) { hide(ln); return false; }
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
    // The same breaks as the reading view, so the page image groups a page -
    // a wrapped title included - the way the reading view does.
    var breaks = paragraphBreaks(lines, bodyHeight);
    var groups = [], cur = null;
    lines.forEach(function (ln, idx) {
      if (!cur || breaks(idx).breakHere) { cur = [ln]; groups.push(cur); }
      else cur.push(ln);
    });
    return groups;
  }

  /* ------------------------------------------------------------------ *
   * Matching reading-view text against the text on a page image
   *
   * The reflowed view and the page image are two different renderings of the
   * same words and do not match character for character: the image keeps the
   * hyphenation the reflow rejoins, and its lines break in different places.
   * So both directions - a click on the image finding its sentence, and a
   * sentence finding where it sits on the image - match on word overlap.
   * ------------------------------------------------------------------ */

  function normaliseForMatch(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\u2010-\u2015-]\s+/g, '')       // rejoin "inter- national"
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenSet(text) {
    var seen = Object.create(null);
    normaliseForMatch(text).split(' ').forEach(function (t) {
      if (t.length > 2) seen[t] = true;             // skip "a", "of", "the"
    });
    return seen;
  }

  /** Jaccard-ish overlap, biased towards covering the clicked text. */
  function overlap(clickedTokens, candidate) {
    var cand = tokenSet(candidate);
    var keys = Object.keys(clickedTokens);
    if (!keys.length) return 0;
    var hit = 0;
    keys.forEach(function (k) { if (cand[k]) hit++; });
    return hit / keys.length;
  }

  /**
   * Does this line of a page image belong to this sentence?
   *
   * Scored the opposite way round from a click: what fraction of the LINE's
   * words are in the sentence. A line that straddles two sentences scores
   * about a half and is left out, which is what keeps "where is this sentence"
   * to the sentence rather than growing to the whole paragraph.
   */
  function lineInSentence(lineText, sentenceText) {
    var text = String(lineText || '');
    if (text.trim().length < 4) return false;
    return overlap(tokenSet(text), sentenceText) >= 0.7;
  }

  FR.pdf = {
    normaliseForMatch: normaliseForMatch,
    tokenSet: tokenSet,
    overlap: overlap,
    lineInSentence: lineInSentence,
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
      assignColumns: assignColumns,
      rowKind: rowKind,
      findAsides: findAsides,
      rowsOf: rowsOf,
      toLines: toLines,
      linesToBlocks: linesToBlocks,
      findRunningHeads: findRunningHeads,
      isRunningHead: isRunningHead,
      normaliseForRepeat: normaliseForRepeat,
      isFurniture: isFurniture,
      hasInnerTerminator: hasInnerTerminator,
      columnEdges: columnEdges,
      alignSpans: alignSpans,
      endsSentence: endsSentence,
      mergeContinuations: mergeContinuations,
      paragraphBreaks: paragraphBreaks,
      edgeLines: edgeLines,
      atNumberEdge: atNumberEdge,
      isHeadingLine: isHeadingLine,
      joinItems: joinItems,
      median: median,
      PAGE_NUMBER: PAGE_NUMBER
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
