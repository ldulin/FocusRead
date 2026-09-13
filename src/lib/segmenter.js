/*
 * FocusRead - sentence segmentation tuned for academic English.
 *
 * Strategy: MASK, SEGMENT, UNMASK.
 *
 * Generic sentence splitters (including Intl.Segmenter) break on academic prose
 * because the period is wildly overloaded: "et al.", "Fig. 3", "p < 0.05",
 * "J. R. Smith", "doi:10.1038/nn.4499". So before segmenting we replace every
 * period that is NOT a sentence terminator with a sentinel character. The
 * sentinel is exactly one character wide, so every offset in the masked string
 * still maps 1:1 onto the original string - we segment the masked text, then
 * slice the ORIGINAL text with the offsets that come back.
 *
 * Classic script (no ES modules): MV3 content scripts cannot be modules, and
 * this same file is loaded by the reader page and the service worker.
 *
 * Source is deliberately pure ASCII; every non-ASCII literal is a \u escape.
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  // U+0001 never occurs in real text and is not a terminator under UAX#29.
  var DOT = String.fromCharCode(1);

  /* ------------------------------------------------------------------ *
   * Abbreviations
   * ------------------------------------------------------------------ */

  // Periods here are ALWAYS masked. These essentially never end a sentence, so
  // the risk of wrongly welding two sentences together is negligible.
  var ALWAYS = [
    // reference / figure / structural
    'Fig', 'Figs', 'fig', 'figs', 'Tab', 'Tabs', 'Eq', 'Eqs', 'eq', 'eqs',
    'Ref', 'Refs', 'ref', 'refs', 'Sec', 'Secs', 'sec', 'Ch', 'Chap', 'Chaps',
    'App', 'Appx', 'Suppl', 'Supp', 'Vol', 'vol', 'No', 'no', 'pp', 'p',
    'Pt', 'Ed', 'Eds', 'ed', 'eds', 'Rev', 'Proc', 'Trans', 'Bull', 'Ann',
    // latin / editorial
    'e.g', 'i.e', 'eg', 'ie', 'cf', 'viz', 'vs', 'v', 'ibid', 'op', 'cit',
    'et', 'seq', 'inf', 'sup', 'ca', 'approx', 'Approx', 'resp', 'Resp',
    // titles
    'Dr', 'Drs', 'Prof', 'Profs', 'Mr', 'Mrs', 'Ms', 'Mx', 'St',
    'Hon', 'Pres', 'Gov', 'Sen', 'Rep', 'Capt', 'Col', 'Gen', 'Lt', 'Sgt',
    // orgs / places
    'Inc', 'Ltd', 'Corp', 'Co', 'Univ', 'Dept', 'Inst', 'Natl', 'Intl',
    'Mt', 'Ave', 'Blvd', 'Rd',
    // months / days
    'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sept', 'Sep', 'Oct',
    'Nov', 'Dec', 'Mon', 'Tue', 'Tues', 'Wed', 'Thu', 'Thur', 'Thurs', 'Fri', 'Sat', 'Sun'
  ];

  // These DO sometimes end a sentence ("...mice, rats, etc.", "Each run took
  // 6.5 min."). Mask the period only when what follows looks like a
  // continuation rather than a new sentence.
  //
  // Units belong here, not above: a methods section ends sentences with them
  // constantly, and always-masking "min." silently welds two sentences
  // together - which then get read aloud as one and translated as one.
  var CONDITIONAL = [
    'etc', 'al', 'Jr', 'Sr', 'Ph.D', 'PhD', 'M.D', 'D.Phil', 'B.A', 'M.A', 'M.Sc', 'B.Sc',
    // units / measures
    'min', 'hr', 'hrs', 'wk', 'yr', 'yrs', 'mo', 'deg', 'wt', 'ml', 'mm', 'cm', 'kg',
    'conc', 'temp', 'avg', 'std', 'dev', 'est', 'max', 'diam'
  ];

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function byLengthDesc(a, b) { return b.length - a.length; }

  // Longest-first so "e.g" is tried before "e", "Ph.D" before "P".
  var ALWAYS_RE = new RegExp(
    '(^|[^\\p{L}\\p{N}])(' + ALWAYS.slice().sort(byLengthDesc).map(escapeRe).join('|') + ')\\.',
    'gu'
  );
  var COND_RE = new RegExp(
    '(^|[^\\p{L}\\p{N}])(' + CONDITIONAL.slice().sort(byLengthDesc).map(escapeRe).join('|') + ')\\.',
    'gu'
  );

  /* ------------------------------------------------------------------ *
   * Masking
   * ------------------------------------------------------------------ */

  function maskRange(chars, start, end) {
    for (var i = Math.max(0, start); i < end && i < chars.length; i++) {
      if (chars[i] === '.') chars[i] = DOT;
    }
  }

  function mask(text) {
    var chars = text.split('');
    var m;

    // 0. Flatten whitespace, one character for one character. DOM text carries
    //    the source file's newlines and indentation, and ICU treats a newline
    //    as a strong sentence-ish boundary - the single biggest cause of bad
    //    splits on real pages. Never use /\s+/g here: that would change the
    //    string length and break every offset downstream.
    for (var w = 0; w < chars.length; w++) {
      var wc = chars[w];
      if (wc === '\n' || wc === '\r' || wc === '\t' || wc === '\f' ||
          wc === '\u00A0' || wc === '\u2028' || wc === '\u2029' || wc === '\u200B') {
        chars[w] = ' ';
      }
    }

    // 1. URLs, DOIs, emails, bare domains - mask every period inside.
    var URLS = /(?:https?:\/\/|www\.|doi:\s*|DOI:\s*)[^\s<>()[\]{}"']+|\b10\.\d{4,9}\/[^\s<>()[\]{}"',;]+|\b[\w.+-]+@[\w-]+\.[\w.-]+|\b[\w-]+\.(?:com|org|net|edu|gov|io|ai|co|uk|de|cn)\b/gi;
    while ((m = URLS.exec(text)) !== null) maskRange(chars, m.index, m.index + m[0].length);

    // 2. Decimals and version-like numbers: 0.05, 3.14, 1.2.3
    var NUM = /\d+(?:\.\d+)+/g;
    while ((m = NUM.exec(text)) !== null) maskRange(chars, m.index, m.index + m[0].length);

    // 3. A period immediately before a digit: "$1.5M", "p.25"
    var DIGITDOT = /\.(?=\d)/g;
    while ((m = DIGITDOT.exec(text)) !== null) chars[m.index] = DOT;

    // 4. Known abbreviations, always masked (plus their internal dots).
    ALWAYS_RE.lastIndex = 0;
    while ((m = ALWAYS_RE.exec(text)) !== null) {
      var dotAt = m.index + m[0].length - 1;
      chars[dotAt] = DOT;
      maskRange(chars, m.index, dotAt);
    }

    // 5. Conditional abbreviations: mask unless a new sentence plausibly starts.
    COND_RE.lastIndex = 0;
    while ((m = COND_RE.exec(text)) !== null) {
      var dIdx = m.index + m[0].length - 1;
      var nextVisible = (/^\s*(\S)/.exec(text.slice(dIdx + 1)) || [])[1] || '';
      // Continuation if what follows is lowercase, a digit, or opens a bracket:
      // "Smith et al. (2020)", "cells, etc., were washed".
      var continues = nextVisible === '' ||
        /[a-z0-9(\[,;:)\u2019\u201C'"-]/.test(nextVisible);
      if (continues) {
        chars[dIdx] = DOT;
        maskRange(chars, m.index, dIdx);
      }
    }

    // 6. Single-capital initials: "J. R. Smith", "A. Turing".
    var INITIAL = /(^|[^\p{L}\p{N}])([A-Z])\.(?=\s|$)/gu;
    while ((m = INITIAL.exec(text)) !== null) chars[m.index + m[0].length - 1] = DOT;

    // 7. Dotted acronyms: U.S., U.K., N.A.S.A., a.m., p.m.
    var ACRO = /\b(?:[A-Za-z]\.){2,}/g;
    while ((m = ACRO.exec(text)) !== null) {
      var endIdx = m.index + m[0].length;
      // Keep the FINAL period live if a capitalised word follows - that is
      // probably a real sentence end ("...based in the U.S. Results were...").
      var realEnd = /^\s[A-Z\u201C"(]/.test(text.slice(endIdx, endIdx + 2));
      maskRange(chars, m.index, realEnd ? endIdx - 1 : endIdx);
    }

    // 8. Ordered-list markers at the start of a block: "1. Introduction".
    var ORD = /(^|\n)[ \t]*(\d{1,2}(?:\.\d{1,2})*|[ivxlcIVXLC]{1,5}|[a-zA-Z])\.(?=\s)/g;
    while ((m = ORD.exec(text)) !== null) chars[m.index + m[0].length - 1] = DOT;

    // 9. Ellipsis: mask the leading dots so only the last one can terminate.
    var ELL = /\.{2,}/g;
    while ((m = ELL.exec(text)) !== null) maskRange(chars, m.index, m.index + m[0].length - 1);

    // 10. Short parenthetical asides: "(see Fig. 2 for details.)"
    var PAREN = /\([^()]{0,160}\)|\[[^\[\]]{0,160}\]/g;
    while ((m = PAREN.exec(text)) !== null) maskRange(chars, m.index, m.index + m[0].length);

    return chars.join('');
  }

  /* ------------------------------------------------------------------ *
   * Segmentation
   * ------------------------------------------------------------------ */

  var _seg;
  function intlSegmenter() {
    if (_seg === undefined) {
      try {
        _seg = (typeof Intl !== 'undefined' && Intl.Segmenter)
          ? new Intl.Segmenter('en', { granularity: 'sentence' })
          : false;
      } catch (e) { _seg = false; }
    }
    return _seg;
  }

  var TERMINATORS = '[.!?\\u2026\\u3002\\uFF01\\uFF1F]';
  var CLOSERS = '["\'\\u2019\\u201D)\\]]';

  function rawSegments(masked) {
    var seg = intlSegmenter();
    var out = [];
    if (seg) {
      var parts = seg.segment(masked);
      for (var s of parts) out.push({ start: s.index, end: s.index + s.segment.length });
      return out;
    }
    // Fallback: split after a terminator + optional closers + whitespace.
    var RE = new RegExp(TERMINATORS + '+' + CLOSERS + '*(?:\\s+|$)', 'g');
    var last = 0, m;
    while ((m = RE.exec(masked)) !== null) {
      out.push({ start: last, end: m.index + m[0].length });
      last = m.index + m[0].length;
    }
    if (last < masked.length) out.push({ start: last, end: masked.length });
    return out;
  }

  var ENDS_PROPERLY = new RegExp(TERMINATORS + CLOSERS + '*$');
  var ORPHAN_CLOSER = /^[)\]}\u201D\u2019,;:]/;

  function hasUnclosedBracket(s) {
    var depth = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
    }
    return depth > 0;
  }

  /**
   * Split `text` into sentences.
   * @returns {Array<{start:number,end:number,text:string}>} offsets into `text`
   */
  function segment(text) {
    if (!text || !text.trim()) return [];
    var raw = rawSegments(mask(text));
    var out = [];

    for (var i = 0; i < raw.length; i++) {
      var start = raw[i].start, end = raw[i].end;
      var piece = text.slice(start, end);

      if (!piece.trim()) {                        // whitespace-only: never drop it
        if (out.length) out[out.length - 1].end = end;
        else out.push({ start: start, end: end });
        continue;
      }

      var trimmed = piece.trim();
      var merge = false;

      if (out.length) {
        var prev = text.slice(out[out.length - 1].start, out[out.length - 1].end).trim();
        if (trimmed.length < 3) merge = true;                 // stray fragment
        else if (/^[a-z]/.test(trimmed)) merge = true;        // lowercase start = bad split
        else if (ORPHAN_CLOSER.test(trimmed)) merge = true;   // orphan closing bracket
        else if (hasUnclosedBracket(prev)) merge = true;      // previous still open
        else if (!ENDS_PROPERLY.test(prev)) merge = true;     // previous never terminated
      }

      if (merge) out[out.length - 1].end = end;
      else out.push({ start: start, end: end });
    }

    return out.map(function (r) {
      var slice = text.slice(r.start, r.end);
      var lead = slice.length - slice.replace(/^\s+/, '').length;
      var trail = slice.length - slice.replace(/\s+$/, '').length;
      return { start: r.start + lead, end: r.end - trail, text: slice.trim() };
    }).filter(function (r) { return r.text.length > 0; });
  }

  /* ------------------------------------------------------------------ *
   * Clause chunking - shorter focus units than a 60-word academic sentence.
   * ------------------------------------------------------------------ */

  var CLAUSE_RE = new RegExp(
    '(;\\s+)' +
    '|(\\s+[\\u2014\\u2013]\\s+)' +
    '|(,\\s+(?:and|but|or|yet|so|which|who|whom|whose|where|when|while|whereas' +
    '|although|though|because|since|unless|whether|that)\\s+)', 'g');

  function chunk(text, maxLen, minLen) {
    maxLen = maxLen || 220;
    minLen = minLen || 45;
    if (text.length <= maxLen) return [{ start: 0, end: text.length, text: text }];

    var points = [], m;
    CLAUSE_RE.lastIndex = 0;
    // break AFTER the separator so the connective leads the next chunk
    while ((m = CLAUSE_RE.exec(text)) !== null) points.push(m.index + m[0].length);

    var out = [], last = 0;
    for (var i = 0; i < points.length; i++) {
      if (points[i] - last >= minLen && text.length - points[i] >= minLen) {
        out.push({ start: last, end: points[i] });
        last = points[i];
      }
    }
    out.push({ start: last, end: text.length });
    return out.map(function (r) {
      return { start: r.start, end: r.end, text: text.slice(r.start, r.end).trim() };
    }).filter(function (r) { return r.text.length > 0; });
  }

  /* ------------------------------------------------------------------ *
   * PDF helper - rejoin words broken across a line end.
   * "inter-\nnational" -> "international"; keeps real hyphens ("well-known").
   * ------------------------------------------------------------------ */

  var HYPHEN_END = /^([\s\S]*?)([\p{L}]{2,})[-\u2010\u00AD]$/u;

  function dehyphenate(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], next = lines[i + 1];
      var m = HYPHEN_END.exec(line);
      if (m && next && /^[\p{Ll}]/u.test(next.trim())) {
        var nm = /^(\S+)([\s\S]*)$/.exec(next.trim());
        if (nm) {
          out.push(m[1] + m[2] + nm[1]);
          lines[i + 1] = nm[2].replace(/^\s+/, '');
          if (!lines[i + 1]) lines.splice(i + 1, 1);
          continue;
        }
      }
      out.push(line);
    }
    return out;
  }

  FR.segmenter = { segment: segment, chunk: chunk, mask: mask, dehyphenate: dehyphenate, DOT: DOT };
})(typeof globalThis !== 'undefined' ? globalThis : self);
