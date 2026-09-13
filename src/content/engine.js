/*
 * FocusRead - the reading engine.
 *
 * Turns an arbitrary DOM subtree into an ordered list of sentences, each one a
 * real element you can click, highlight, speak and translate.
 *
 * Design notes
 * ------------
 * - We only ever ADD wrapper elements; no text is rewritten. That makes
 *   detach() a perfect restore: unwrap every marker and normalize().
 * - Sentences are wrapped in <fr-s data-i="N">. One sentence can produce
 *   SEVERAL marks when it spans inline elements ("the <em>key</em> result."),
 *   so a mark list - not a single node - is the unit of highlight.
 * - Wrapping walks sentences and node-pieces in REVERSE, because splitText()
 *   invalidates every offset after the split point but leaves earlier ones
 *   intact.
 * - Word-level (karaoke) highlighting uses the CSS Custom Highlight API, which
 *   paints ranges without touching the DOM at all. If unavailable we simply
 *   skip word highlighting rather than degrade the page.
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1,
    OPTION: 1, BUTTON: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1,
    SVG: 1, MATH: 1, CANVAS: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1, OBJECT: 1,
    EMBED: 1, MAP: 1, AREA: 1, TITLE: 1, HEAD: 1, LINK: 1, META: 1,
    'FR-S': 1, 'FR-T': 1, 'FR-UI': 1, 'FR-B': 1
  };

  var INLINE_DISPLAY = {
    inline: 1, 'inline-block': 1, 'inline-flex': 1, 'inline-grid': 1,
    ruby: 1, 'ruby-text': 1, contents: 1, 'inline-table': 1
  };

  function isSkipped(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS[el.tagName]) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    if (el.classList && el.classList.contains('fr-ignore')) return true;
    // Rendered maths. MathJax and KaTeX re-render their own subtrees, so any
    // wrapper we inject there is both destroyed and destructive - and reading
    // "\frac x y" aloud helps nobody.
    if (MATH_SELECTOR && el.matches) {
      try { if (el.matches(MATH_SELECTOR)) return true; } catch (e) { /* old browser */ }
    }
    return false;
  }

  var MATH_SELECTOR = [
    'mjx-container', '.MathJax', '.MathJax_Display', '.MathJax_Preview',
    '.katex', '.katex-display', '.math', '.mwe-math-element',
    '[data-mathml]', '.formula', '.equation'
  ].join(',');

  /* ------------------------------------------------------------------ *
   * Block discovery
   * ------------------------------------------------------------------ */

  function Engine(rootEl, opts) {
    this.root = rootEl || document.body;
    this.opts = Object.assign({
      readUnit: 'sentence',
      clauseMaxLen: 220,
      minBlockChars: 2,
      chunkBudgetMs: 12          // wrapping work per animation frame
    }, opts || {});
    this.sentences = [];
    this.index = -1;
    this._displayCache = new WeakMap();
    this._attached = false;
    this._observer = null;
    this._mutating = false;
    this._listeners = {};
  }

  Engine.prototype.on = function (evt, fn) {
    (this._listeners[evt] = this._listeners[evt] || []).push(fn);
    return this;
  };
  Engine.prototype._emit = function (evt, payload) {
    (this._listeners[evt] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.warn('[FocusRead] listener error', e); }
    });
  };

  Engine.prototype._isInline = function (el) {
    var v = this._displayCache.get(el);
    if (v === undefined) {
      var d;
      try { d = getComputedStyle(el).display; } catch (e) { d = 'inline'; }
      v = !!INLINE_DISPLAY[d];
      this._displayCache.set(el, v);
    }
    return v;
  };

  // The nearest non-inline ancestor: the visual paragraph this text belongs to.
  Engine.prototype._blockOf = function (textNode) {
    var el = textNode.parentElement;
    while (el && el !== this.root && this._isInline(el)) el = el.parentElement;
    return el || this.root;
  };

  /**
   * Group every eligible text node under `scope` by its owning block.
   * @returns {Array<{el:Element, pieces:Array<{node:Text,start:number,len:number}>, text:string}>}
   */
  Engine.prototype._collectBlocks = function (scope) {
    var self = this;
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        for (var p = n.parentNode; p && p !== scope.parentNode; p = p.parentNode) {
          if (isSkipped(p)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var blocks = [], byEl = new Map(), node;
    while ((node = walker.nextNode())) {
      var block = self._blockOf(node);
      var entry = byEl.get(block);
      if (!entry) {
        entry = { el: block, pieces: [], text: '' };
        byEl.set(block, entry);
        blocks.push(entry);
      }
      entry.pieces.push({ node: node, start: entry.text.length, len: node.nodeValue.length });
      entry.text += node.nodeValue;
    }

    return blocks.filter(function (b) {
      if (b.text.trim().length < self.opts.minBlockChars) return false;
      // Skip anything not actually painted (collapsed menus, hidden tabs).
      try { if (!b.el.getClientRects().length) return false; } catch (e) { /* detached */ }
      return true;
    });
  };

  /* ------------------------------------------------------------------ *
   * Normalisation - collapsed text plus an index map back to raw offsets.
   * DOM text carries the source file's newlines and indentation; speech and
   * translation want the collapsed form, but wrapping needs raw offsets.
   * ------------------------------------------------------------------ */

  function normalize(raw) {
    var norm = '', map = [];
    var pendingSpace = false;
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\u00A0') {
        if (norm.length) pendingSpace = true;
        continue;
      }
      if (pendingSpace) { norm += ' '; map.push(i); pendingSpace = false; }
      norm += c; map.push(i);
    }
    return { text: norm, map: map };
  }

  /* ------------------------------------------------------------------ *
   * Wrapping
   * ------------------------------------------------------------------ */

  // Wrap exactly [a, b) of `node` in a fresh <fr-s>, splitting as needed.
  function wrapRange(node, a, b, index) {
    var n = node;
    if (b < n.nodeValue.length) n.splitText(b);
    if (a > 0) n = n.splitText(a);
    var mark = document.createElement('fr-s');
    mark.setAttribute('data-i', String(index));
    var parent = n.parentNode;
    if (!parent) return null;
    parent.insertBefore(mark, n);
    mark.appendChild(n);
    return mark;
  }

  /**
   * Segment one block and wrap each sentence.
   * @returns {Array} sentence records, in document order
   */
  Engine.prototype._processBlock = function (block, startIndex) {
    var seg = FR.segmenter;
    var units = seg.segment(block.text);
    if (!units.length) return [];

    // In clause mode, break long sentences into shorter focus units.
    if (this.opts.readUnit === 'clause') {
      var expanded = [];
      for (var u = 0; u < units.length; u++) {
        var sUnit = units[u];
        var parts = seg.chunk(sUnit.text, this.opts.clauseMaxLen);
        if (parts.length === 1) { expanded.push(sUnit); continue; }
        for (var q = 0; q < parts.length; q++) {
          expanded.push({
            start: sUnit.start + parts[q].start,
            end: sUnit.start + parts[q].end,
            text: parts[q].text
          });
        }
      }
      units = expanded;
    }

    var records = units.map(function (unit, k) {
      var norm = normalize(block.text.slice(unit.start, unit.end));
      return {
        i: startIndex + k,
        text: norm.text,
        rawStart: unit.start,
        rawEnd: unit.end,
        normMap: norm.map,      // normalised index -> offset within the unit
        marks: [],
        blockEl: block.el,
        translation: null
      };
    });

    // REVERSE order: splitText only invalidates offsets AFTER the split point.
    for (var s = records.length - 1; s >= 0; s--) {
      var rec = records[s];
      var overlapping = [];
      for (var p = 0; p < block.pieces.length; p++) {
        var piece = block.pieces[p];
        var pStart = piece.start, pEnd = piece.start + piece.len;
        if (pEnd <= rec.rawStart || pStart >= rec.rawEnd) continue;
        overlapping.push({
          node: piece.node,
          a: Math.max(0, rec.rawStart - pStart),
          b: Math.min(piece.len, rec.rawEnd - pStart)
        });
      }
      for (var o = overlapping.length - 1; o >= 0; o--) {
        var ov = overlapping[o];
        if (ov.b <= ov.a) continue;
        if (!ov.node.parentNode) continue;          // node was removed mid-scan
        try {
          var mark = wrapRange(ov.node, ov.a, ov.b, rec.i);
          if (mark) rec.marks.unshift(mark);
        } catch (e) {
          console.warn('[FocusRead] could not wrap a fragment', e);
        }
      }
    }

    return records.filter(function (r) { return r.marks.length > 0; });
  };

  /**
   * Scan the root and build the sentence index. Work is spread across frames so
   * a 400-page document does not freeze the tab.
   * @returns {Promise<number>} number of sentences found
   */
  Engine.prototype.scan = function (scope) {
    var self = this;
    var blocks = this._collectBlocks(scope || this.root);
    this._mutating = true;

    return new Promise(function (resolve) {
      var out = self.sentences.slice();
      var bi = 0;

      function step() {
        var t0 = (root.performance && performance.now()) || 0;
        while (bi < blocks.length) {
          var recs = self._processBlock(blocks[bi], out.length);
          for (var r = 0; r < recs.length; r++) out.push(recs[r]);
          bi++;
          var t1 = (root.performance && performance.now()) || 0;
          if (t1 - t0 > self.opts.chunkBudgetMs) break;
        }
        self._emit('progress', { done: bi, total: blocks.length });
        if (bi < blocks.length) { requestAnimationFrame(step); return; }

        self.sentences = out;
        self._attached = true;
        self._mutating = false;
        self._emit('scanned', { count: out.length });
        resolve(out.length);
      }
      step();
    });
  };

  /* ------------------------------------------------------------------ *
   * Navigation and highlight
   * ------------------------------------------------------------------ */

  Engine.prototype.count = function () { return this.sentences.length; };
  Engine.prototype.get = function (i) { return this.sentences[i] || null; };
  Engine.prototype.current = function () { return this.get(this.index); };

  Engine.prototype.marksFor = function (i) {
    var rec = this.get(i);
    return rec ? rec.marks : [];
  };

  Engine.prototype.setCurrent = function (i, opts) {
    opts = opts || {};
    if (i < 0 || i >= this.sentences.length) return false;
    this.clearWord();
    if (this.index >= 0) {
      this.marksFor(this.index).forEach(function (m) { m.classList.remove('fr-cur'); });
    }
    this.index = i;
    this.marksFor(i).forEach(function (m) { m.classList.add('fr-cur'); });
    if (opts.scroll !== false) this.scrollIntoView(i);
    this._emit('current', { index: i, record: this.get(i) });
    return true;
  };

  Engine.prototype.next = function (opts) {
    return this.index + 1 < this.sentences.length ? this.setCurrent(this.index + 1, opts) : false;
  };
  Engine.prototype.prev = function (opts) {
    return this.index > 0 ? this.setCurrent(this.index - 1, opts) : false;
  };

  Engine.prototype.scrollIntoView = function (i) {
    var marks = this.marksFor(i);
    if (!marks.length) return;
    var r;
    try { r = marks[0].getBoundingClientRect(); } catch (e) { return; }
    var vh = root.innerHeight || document.documentElement.clientHeight;
    // Only scroll when the sentence is outside a comfortable middle band, so
    // reading does not jitter line by line.
    if (r.top >= vh * 0.18 && r.bottom <= vh * 0.82) return;
    try {
      marks[0].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    } catch (e) {
      marks[0].scrollIntoView();
    }
  };

  /** Index of the first sentence at or below the current viewport top. */
  Engine.prototype.firstVisible = function () {
    for (var i = 0; i < this.sentences.length; i++) {
      var marks = this.sentences[i].marks;
      if (!marks.length) continue;
      var r = marks[0].getBoundingClientRect();
      if (r.bottom > 0 && r.top < (root.innerHeight || 0)) return i;
    }
    return 0;
  };

  Engine.prototype.indexFromNode = function (node) {
    var el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== document.documentElement) {
      if (el.tagName === 'FR-S' && el.hasAttribute('data-i')) return Number(el.getAttribute('data-i'));
      el = el.parentElement;
    }
    return -1;
  };

  /* ------------------------------------------------------------------ *
   * Word-level highlight via the CSS Custom Highlight API.
   * Paints a range with zero DOM mutation - crucial while speech is running.
   * ------------------------------------------------------------------ */

  var HL_NAME = 'fr-word';
  var highlightSupported = typeof root.Highlight === 'function' &&
                           typeof CSS !== 'undefined' && CSS.highlights;

  Engine.prototype.clearWord = function () {
    if (highlightSupported) { try { CSS.highlights.delete(HL_NAME); } catch (e) { /* noop */ } }
  };

  /**
   * Highlight [charIndex, charIndex+length) of sentence `i`, where the offsets
   * are into the NORMALISED sentence text (what speech engines report).
   */
  Engine.prototype.highlightWord = function (i, charIndex, length) {
    if (!highlightSupported) return false;
    var rec = this.get(i);
    if (!rec || !rec.marks.length) return false;

    var map = rec.normMap;
    if (charIndex < 0 || charIndex >= map.length) return false;
    var rawA = map[charIndex];
    var rawB = map[Math.min(map.length - 1, charIndex + Math.max(1, length) - 1)] + 1;

    // Walk this sentence's marks, accumulating raw offsets, to find the
    // text nodes and offsets that contain [rawA, rawB).
    var acc = 0, startNode = null, startOff = 0, endNode = null, endOff = 0;
    for (var m = 0; m < rec.marks.length && !endNode; m++) {
      var w = document.createTreeWalker(rec.marks[m], NodeFilter.SHOW_TEXT);
      var tn;
      while ((tn = w.nextNode())) {
        var len = tn.nodeValue.length;
        if (!startNode && rawA < acc + len) { startNode = tn; startOff = rawA - acc; }
        if (startNode && rawB <= acc + len) { endNode = tn; endOff = rawB - acc; break; }
        acc += len;
      }
    }
    if (!startNode) return false;
    if (!endNode) { endNode = startNode; endOff = startNode.nodeValue.length; }

    try {
      var range = document.createRange();
      range.setStart(startNode, Math.max(0, Math.min(startOff, startNode.nodeValue.length)));
      range.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.nodeValue.length)));
      CSS.highlights.set(HL_NAME, new root.Highlight(range));
      return true;
    } catch (e) {
      return false;
    }
  };

  /* ------------------------------------------------------------------ *
   * Inline translation (bilingual mode)
   * ------------------------------------------------------------------ */

  Engine.prototype.setTranslation = function (i, text) {
    var rec = this.get(i);
    if (!rec) return;
    rec.translation = text;
    var last = rec.marks[rec.marks.length - 1];
    if (!last || !last.parentNode) return;

    var node = rec.transEl;
    if (!node) {
      node = document.createElement('fr-t');
      node.setAttribute('data-i', String(i));
      rec.transEl = node;
    }
    node.textContent = text || '';
    node.style.display = text ? '' : 'none';
    if (node.previousSibling !== last || !node.parentNode) {
      this._mutating = true;
      last.parentNode.insertBefore(node, last.nextSibling);
      this._mutating = false;
    }
  };

  Engine.prototype.clearTranslations = function () {
    this._mutating = true;
    this.sentences.forEach(function (rec) {
      if (rec.transEl && rec.transEl.parentNode) rec.transEl.parentNode.removeChild(rec.transEl);
      rec.transEl = null;
      rec.translation = null;
    });
    this._mutating = false;
  };

  /* ------------------------------------------------------------------ *
   * Bold word-heads - emphasise the opening letters of every word.
   *
   * Deliberately NOT called "Bionic Reading": that name is trademarked and the
   * technique is patented by its owner, whose licence forbids derivative works.
   * The plain typographic transform here is unencumbered. Note also that the
   * largest controlled study to date (2,074 participants) found it slightly
   * SLOWER than unmodified text, so it ships off by default.
   * ------------------------------------------------------------------ */

  Engine.prototype.setBoldHeads = function (on, strength) {
    this._mutating = true;
    if (!on) {
      unwrapAll(this.root, 'FR-B');
      this._mutating = false;
      return;
    }
    unwrapAll(this.root, 'FR-B');
    var frac = Math.max(0.1, Math.min(0.9, strength || 0.4));
    var marks = this.root.querySelectorAll('fr-s');
    for (var i = 0; i < marks.length; i++) boldHeads(marks[i], frac);
    this._mutating = false;
  };

  var WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*/gu;

  function boldHeads(mark, frac) {
    var walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT);
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);

    nodes.forEach(function (node) {
      var text = node.nodeValue;
      WORD_RE.lastIndex = 0;
      var spans = [], m;
      while ((m = WORD_RE.exec(text)) !== null) {
        var word = m[0];
        // 1-letter words gain nothing; cap so long words stay readable.
        var cut = word.length <= 1 ? 1 : Math.max(1, Math.min(word.length - 1, Math.round(word.length * frac)));
        spans.push({ start: m.index, end: m.index + cut });
      }
      if (!spans.length) return;
      for (var s = spans.length - 1; s >= 0; s--) {
        var cur = node, a = spans[s].start, b = spans[s].end;
        if (b < cur.nodeValue.length) cur.splitText(b);
        if (a > 0) cur = cur.splitText(a);
        var bold = document.createElement('fr-b');
        cur.parentNode.insertBefore(bold, cur);
        bold.appendChild(cur);
      }
    });
  }

  function unwrapAll(scope, tagName) {
    var els = scope.querySelectorAll(tagName.toLowerCase());
    for (var i = els.length - 1; i >= 0; i--) {
      var el = els[i], parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }
  }

  /* ------------------------------------------------------------------ *
   * Live pages - rescan content that arrives after the first pass.
   * ------------------------------------------------------------------ */

  Engine.prototype.watch = function () {
    var self = this;
    if (this._observer || typeof MutationObserver === 'undefined') return;
    var pending = null;
    this._observer = new MutationObserver(function (records) {
      if (self._mutating) return;
      var worthwhile = records.some(function (r) {
        for (var i = 0; i < r.addedNodes.length; i++) {
          var n = r.addedNodes[i];
          if (n.nodeType === 1 && !isSkipped(n) && n.textContent && n.textContent.trim().length > 40) return true;
        }
        return false;
      });
      if (!worthwhile) return;
      clearTimeout(pending);
      pending = setTimeout(function () { self.rescan(); }, 700);
    });
    this._observer.observe(this.root, { childList: true, subtree: true });
  };

  /** Re-run the scan over blocks that have no marks yet. */
  Engine.prototype.rescan = function () {
    var self = this;
    var known = new Set();
    this.sentences.forEach(function (r) { known.add(r.blockEl); });
    var fresh = this._collectBlocks(this.root).filter(function (b) {
      return !known.has(b.el) && !b.el.querySelector('fr-s');
    });
    if (!fresh.length) return Promise.resolve(0);

    this._mutating = true;
    var added = 0;
    fresh.forEach(function (b) {
      var recs = self._processBlock(b, self.sentences.length);
      recs.forEach(function (r) { self.sentences.push(r); added++; });
    });
    this._mutating = false;
    if (added) this._emit('scanned', { count: this.sentences.length, added: added });
    return Promise.resolve(added);
  };

  /* ------------------------------------------------------------------ *
   * Teardown - must leave the page byte-identical to how we found it.
   * ------------------------------------------------------------------ */

  Engine.prototype.detach = function () {
    this._mutating = true;
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
    this.clearWord();
    this.clearTranslations();
    unwrapAll(this.root, 'FR-B');
    unwrapAll(this.root, 'FR-S');
    try { this.root.normalize(); } catch (e) { /* noop */ }
    this.sentences = [];
    this.index = -1;
    this._attached = false;
    this._mutating = false;
    this._emit('detached', {});
  };

  Engine.prototype.isAttached = function () { return this._attached; };

  FR.Engine = Engine;
  FR.engineUtils = { normalize: normalize, isSkipped: isSkipped, unwrapAll: unwrapAll };
})(typeof globalThis !== 'undefined' ? globalThis : self);
