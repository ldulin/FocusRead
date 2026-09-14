/*
 * FocusRead - floating UI: the control bar, the selection popup, the reading
 * ruler and toasts.
 *
 * All of it lives inside a shadow root attached to a single <fr-ui> host, so
 * the page's CSS cannot reach in and ours cannot leak out. Icons are inline
 * SVG rather than emoji so rendering does not depend on the reader's fonts.
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  var SVG = {
    play: '<path d="M8 5.5v13l11-6.5z"/>',
    pause: '<path d="M7 5.5h3.2v13H7zm7 0h3.2v13H14z"/>',
    prev: '<path d="M8 6h2.2v12H8zm9 0v12l-7-6z"/>',
    next: '<path d="M16 6h-2.2v12H16zM7 6v12l7-6z"/>',
    focus: '<path d="M12 8a4 4 0 100 8 4 4 0 000-8zm0 6a2 2 0 110-4 2 2 0 010 4z"/><path d="M3 7V4a1 1 0 011-1h3v2H5v2zm18 0V4a1 1 0 00-1-1h-3v2h2v2zM3 17v3a1 1 0 001 1h3v-2H5v-2zm18 0v3a1 1 0 01-1 1h-3v-2h2v-2z"/>',
    lang: '<path d="M12 3a9 9 0 100 18 9 9 0 000-18zm6.9 8h-3a15 15 0 00-1.2-5.2A7 7 0 0118.9 11zM12 5c.8 1.2 1.5 3.3 1.7 6h-3.4C10.5 8.3 11.2 6.2 12 5zM5.1 13h3c.1 1.9.5 3.7 1.2 5.2A7 7 0 015.1 13zm3-2h-3a7 7 0 014.2-5.2A15 15 0 008.1 11zM12 19c-.8-1.2-1.5-3.3-1.7-6h3.4c-.2 2.7-.9 4.8-1.7 6zm2.7-.8c.7-1.5 1.1-3.3 1.2-5.2h3a7 7 0 01-4.2 5.2z"/>',
    translate: '<path d="M4 5h7v2H8.6c.5 1.7 1.4 3.2 2.4 4.3-.6.6-1.3 1.1-2 1.5l.7 1.9c1-.5 1.9-1.2 2.7-2 .8.8 1.7 1.5 2.7 2l.7-1.9c-.7-.4-1.4-.9-2-1.5 1-1.1 1.9-2.6 2.4-4.3H13V5h-2V3H9v2H4zm6.7 2h2.6c-.4 1.2-1 2.3-1.3 2.8-.3-.5-.9-1.6-1.3-2.8zM17 13l-4 9h2.1l.9-2h4l.9 2H23l-4-9zm-.2 5.2L18 15.4l1.2 2.8z"/>',
    settings: '<path d="M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zm0 5.5a2 2 0 110-4 2 2 0 010 4z"/><path d="M20.3 13.6l-.1-1.6.1-1.6 1.6-1.2-1.6-2.8-1.9.6a7 7 0 00-2.7-1.6L15.2 2h-3.2l-.5 2.4a7 7 0 00-2.7 1.6l-1.9-.6-1.6 2.8L6.9 10l-.1 1.6.1 1.6-1.6 1.2 1.6 2.8 1.9-.6a7 7 0 002.7 1.6l.5 2.4h3.2l.5-2.4a7 7 0 002.7-1.6l1.9.6 1.6-2.8z" opacity=".28"/>',
    close: '<path d="M18.3 7.1l-1.4-1.4L12 10.6 7.1 5.7 5.7 7.1l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z"/>',
    copy: '<path d="M16 1H4a2 2 0 00-2 2v14h2V3h12zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11z"/>',
    speak: '<path d="M4 9v6h4l5 5V4L8 9zm12.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4zM14 1.2v2.1a8.5 8.5 0 010 17.4v2.1a10.5 10.5 0 000-21.6z"/>',
    grip: '<path d="M9 5h2v2H9zm4 0h2v2h-2zM9 9h2v2H9zm4 0h2v2h-2zM9 13h2v2H9zm4 0h2v2h-2zM9 17h2v2H9zm4 0h2v2h-2z"/>'
  };

  function icon(name, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) +
           '" fill="currentColor" aria-hidden="true">' + SVG[name] + '</svg>';
  }

  var STYLE = [
    ':host{all:initial}',
    '*,*::before,*::after{box-sizing:border-box}',
    '.bar,.pop,.toast{',
    '  font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    '  color:#1b1d21;-webkit-font-smoothing:antialiased}',

    /* ---------- control bar ---------- */
    '.bar{position:fixed;z-index:2147483646;left:50%;bottom:22px;transform:translateX(-50%);',
    '  display:flex;align-items:center;gap:2px;padding:5px 6px;border-radius:14px;',
    '  background:rgba(252,252,253,.97);backdrop-filter:saturate(1.6) blur(14px);',
    '  box-shadow:0 8px 30px rgba(0,0,0,.2),0 0 0 1px rgba(0,0,0,.09);',
    '  user-select:none;max-width:min(94vw,760px);flex-wrap:nowrap}',
    '.bar[hidden]{display:none}',
    '.grip{cursor:grab;color:#b2b6bd;padding:2px;display:flex}',
    '.grip:active{cursor:grabbing}',

    'button{all:unset;display:inline-flex;align-items:center;justify-content:center;',
    '  gap:5px;min-width:32px;height:32px;padding:0 7px;border-radius:9px;cursor:pointer;',
    '  color:#2b2f36;font:inherit;white-space:nowrap}',
    'button:hover{background:rgba(0,0,0,.07)}',
    'button:focus-visible{outline:2px solid #4c8dff;outline-offset:1px}',
    'button[disabled]{opacity:.35;cursor:default}',
    'button[disabled]:hover{background:none}',
    'button.on{background:#1f6feb;color:#fff}',
    'button[data-mode="ruler"].on{background:#7a4ddb}',
    'button[data-mode="ruler"].on::after{content:"";position:absolute;left:6px;right:6px;bottom:4px;height:2px;background:#fff;border-radius:2px}',
    'button[data-act="focus"]{position:relative}',
    'button.on:hover{background:#1a5fd0}',
    'button.primary{background:#1b1d21;color:#fff;min-width:38px}',
    'button.primary:hover{background:#33373e}',

    '.sep{width:1px;height:20px;background:rgba(0,0,0,.11);margin:0 3px;flex:none}',
    '.count{font-variant-numeric:tabular-nums;color:#6b7078;padding:0 6px;font-size:12px;flex:none}',
    '.rate{font-variant-numeric:tabular-nums;font-size:12px;font-weight:600;min-width:38px}',
    'select{all:unset;font:inherit;font-size:12px;color:#2b2f36;padding:5px 6px;border-radius:8px;',
    '  cursor:pointer;max-width:130px;text-overflow:ellipsis;background:rgba(0,0,0,.045)}',
    'select:hover{background:rgba(0,0,0,.08)}',

    /* ---------- selection popup ---------- */
    '.pop{position:fixed;z-index:2147483647;max-width:min(420px,90vw);padding:11px 13px;',
    '  border-radius:12px;background:#fff;box-shadow:0 10px 34px rgba(0,0,0,.22),0 0 0 1px rgba(0,0,0,.09);',
    '  line-height:1.5}',
    '.pop[hidden]{display:none}',
    '.pop .src{color:#6b7078;font-size:12px;max-height:4.4em;overflow:hidden;margin-bottom:7px;',
    '  padding-bottom:7px;border-bottom:1px solid rgba(0,0,0,.08)}',
    '.pop .out{font-size:15px;color:#16181c;white-space:pre-wrap;word-break:break-word;',
    '  max-height:40vh;overflow:auto}',
    '.pop .out.pending{color:#8a8f97;font-style:italic}',
    '.pop .out.error{color:#b3261e}',
    '.pop .acts{display:flex;gap:2px;margin-top:9px;align-items:center}',
    '.pop .acts .spacer{flex:1}',
    '.pop .prov{font-size:11px;color:#9aa0a8}',

    /* ---------- toast ---------- */
    '.toast{position:fixed;z-index:2147483647;left:50%;bottom:74px;transform:translateX(-50%);',
    '  background:#1b1d21;color:#fff;padding:9px 15px;border-radius:10px;font-size:13px;',
    '  box-shadow:0 8px 26px rgba(0,0,0,.3);max-width:80vw;text-align:center}',
    '.toast[hidden]{display:none}',

    /* ---------- progress strip while translating a page ---------- */
    '.prog{position:fixed;z-index:2147483645;left:0;top:0;height:3px;background:#1f6feb;',
    '  width:0;transition:width .2s ease}',
    '.prog[hidden]{display:none}',

    '@media (prefers-color-scheme:dark){',
    '  .bar{background:rgba(32,34,38,.97);box-shadow:0 8px 30px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.12)}',
    '  button{color:#e6e8ec}button:hover{background:rgba(255,255,255,.1)}',
    '  button.primary{background:#e6e8ec;color:#16181c}button.primary:hover{background:#fff}',
    '  .sep{background:rgba(255,255,255,.15)}.count,.grip{color:#9aa0a8}',
    '  select{color:#e6e8ec;background:rgba(255,255,255,.09)}',
    '  .pop{background:#202226;box-shadow:0 10px 34px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.12)}',
    '  .pop .out{color:#e6e8ec}.pop .src{color:#9aa0a8;border-bottom-color:rgba(255,255,255,.12)}',
    '}',
    '@media (prefers-reduced-motion:reduce){.prog{transition:none}}'
  ].join('\n');

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  /* ------------------------------------------------------------------ */

  function UI(actions, opts) {
    this.actions = actions || {};
    this.opts = opts || {};
    this.host = null;
    this.shadow = null;
    this._toastTimer = null;
    this._popPinned = false;
    this._onWindowResize = null;
  }

  UI.prototype.mount = function () {
    if (this.host) return;
    var self = this;

    this.host = document.createElement('fr-ui');
    this.host.setAttribute('data-focusread', '');
    // The host itself must be inert; only its children take pointer events.
    this.host.style.cssText = 'all:initial;position:static;pointer-events:none';
    this.shadow = this.host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = STYLE;
    this.shadow.appendChild(style);

    this.shadow.appendChild(el(
      '<div class="prog" hidden></div>'
    ));

    var bar = el(
      '<div class="bar" role="toolbar" aria-label="FocusRead controls" style="pointer-events:auto">' +
        '<span class="grip" title="Drag to move">' + icon('grip', 16) + '</span>' +
        '<button data-act="prev" title="Previous sentence (K)" aria-label="Previous sentence">' + icon('prev') + '</button>' +
        '<button data-act="toggle" class="primary" title="Play / pause (Space)" aria-label="Play">' + icon('play', 20) + '</button>' +
        '<button data-act="next" title="Next sentence (J)" aria-label="Next sentence">' + icon('next') + '</button>' +
        '<span class="count" data-role="count">0 / 0</span>' +
        '<span class="sep"></span>' +
        '<button data-act="rate" class="rate" title="Reading speed">1.0x</button>' +
        '<select data-role="voice" title="Voice"></select>' +
        '<span class="sep"></span>' +
        '<button data-act="focus" title="Focus mode (F)" aria-label="Focus mode" aria-pressed="false">' + icon('focus') + '</button>' +
        '<button data-act="bilingual" title="Show translation under every sentence (B)" aria-label="Bilingual mode" aria-pressed="false">' + icon('lang') + '</button>' +
        '<button data-act="translate" title="Translate the current sentence (T)" aria-label="Translate sentence">' + icon('translate') + '</button>' +
        '<span class="sep"></span>' +
        '<button data-act="settings" title="Settings" aria-label="Settings">' + icon('settings') + '</button>' +
        '<button data-act="close" title="Turn FocusRead off (Esc)" aria-label="Close">' + icon('close') + '</button>' +
      '</div>'
    );
    this.shadow.appendChild(bar);

    var pop = el(
      '<div class="pop" hidden style="pointer-events:auto">' +
        '<div class="src" data-role="src"></div>' +
        '<div class="out" data-role="out" role="status" aria-live="polite"></div>' +
        '<div class="acts">' +
          '<button data-act="pop-speak-src" title="Read the original aloud">' + icon('speak', 16) + '</button>' +
          '<button data-act="pop-speak-out" title="Read the translation aloud">' + icon('speak', 16) + icon('lang', 13) + '</button>' +
          '<button data-act="pop-copy" title="Copy the translation">' + icon('copy', 16) + '</button>' +
          '<span class="spacer"></span>' +
          '<span class="prov" data-role="prov"></span>' +
          '<button data-act="pop-close" title="Close">' + icon('close', 16) + '</button>' +
        '</div>' +
      '</div>'
    );
    this.shadow.appendChild(pop);

    // Announced to assistive tech. Errors and status were otherwise delivered
    // as a silently-appearing div that a screen reader never mentions.
    this.shadow.appendChild(el(
      '<div class="toast" hidden role="status" aria-live="polite" aria-atomic="true"></div>'
    ));

    // One delegated listener for every button in the shadow tree.
    this.shadow.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-act]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      var fn = self.actions[btn.getAttribute('data-act')];
      if (fn) fn(btn, e);
    });

    var voice = this.shadow.querySelector('[data-role="voice"]');
    voice.addEventListener('change', function () {
      if (self.actions.voice) self.actions.voice(voice.value);
    });
    // Stop the page from seeing keystrokes aimed at our own controls.
    this.shadow.addEventListener('keydown', function (e) { e.stopPropagation(); });

    this._wireToolbarKeys(bar);
    this._makeDraggable(bar, this.shadow.querySelector('.grip'));

    var parent = document.body || document.documentElement;
    parent.appendChild(this.host);

    // Additive clearance for the fixed toolbar. An element rather than a
    // padding override, so a page that already reserves more space keeps it.
    this.spacer = document.createElement('fr-spacer');
    this.spacer.className = 'fr-ignore';
    this.spacer.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.spacer);
  };

  /**
   * role="toolbar" promises arrow-key navigation between controls and a single
   * tab stop. Claiming the role without implementing it is worse than not
   * claiming it, so implement it: roving tabindex plus Left/Right/Home/End.
   */
  UI.prototype._wireToolbarKeys = function (bar) {
    var self = this;
    function items() {
      return Array.prototype.filter.call(
        bar.querySelectorAll('button, select'),
        function (n) { return !n.disabled; });
    }
    function focusAt(list, i) {
      var n = list.length;
      var target = list[((i % n) + n) % n];
      list.forEach(function (el2) { el2.tabIndex = el2 === target ? 0 : -1; });
      target.focus();
    }
    // Seat the tab stop on a control that is never disabled. Doing this at
    // mount time picked "prev", which activate() disables immediately at
    // sentence 0 - leaving the whole toolbar unreachable by Tab, which is
    // strictly worse than the native tab stops it replaced.
    this._reseatTabStop = function () {
      var list = items();
      if (!list.length) return;
      var held = list.filter(function (el2) { return el2.tabIndex === 0; })[0];
      if (held && !held.disabled) return;
      var preferred = bar.querySelector('[data-act="toggle"]');
      var target = (preferred && !preferred.disabled) ? preferred : list[0];
      list.forEach(function (el2) { el2.tabIndex = el2 === target ? 0 : -1; });
    };
    Array.prototype.forEach.call(bar.querySelectorAll('button, select'),
      function (el2) { el2.tabIndex = -1; });
    this._reseatTabStop();

    bar.addEventListener('keydown', function (e) {
      var list = items();
      var i = list.indexOf(e.target);
      if (i === -1) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); focusAt(list, i + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); focusAt(list, i - 1); }
      else if (e.key === 'Home') { e.preventDefault(); focusAt(list, 0); }
      else if (e.key === 'End') { e.preventDefault(); focusAt(list, list.length - 1); }
    });
  };

  UI.prototype._makeDraggable = function (bar, grip) {
    var dragging = false, dx = 0, dy = 0;
    var self = this;
    grip.addEventListener('pointerdown', function (e) {
      dragging = true;
      var r = bar.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      bar.style.transform = 'none';
      bar.style.left = r.left + 'px';
      bar.style.top = r.top + 'px';
      bar.style.bottom = 'auto';
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var w = bar.offsetWidth, h = bar.offsetHeight;
      bar.style.left = Math.max(4, Math.min(root.innerWidth - w - 4, e.clientX - dx)) + 'px';
      bar.style.top = Math.max(4, Math.min(root.innerHeight - h - 4, e.clientY - dy)) + 'px';
    });
    grip.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
      if (self.actions.moved) {
        self.actions.moved({ left: parseFloat(bar.style.left), top: parseFloat(bar.style.top) });
      }
    });

    // Restore a previously dragged position. The clamp has to wait until the
    // host is in the document: measuring offsetWidth on a detached element
    // returns 0, so every restored position clamped to the top-left corner.
    var saved = this.opts.position;
    if (saved && isFinite(saved.left) && isFinite(saved.top)) {
      bar.style.transform = 'none';
      bar.style.bottom = 'auto';
      bar.style.left = saved.left + 'px';
      bar.style.top = saved.top + 'px';
      requestAnimationFrame(function () { self._clampBar(); });
    }

    // A dragged bar is positioned in viewport coordinates, so shrinking the
    // window or rotating a tablet can strand it completely off-screen with no
    // way to get it back.
    this._onWindowResize = function () { self._clampBar(); };
    root.addEventListener('resize', this._onWindowResize);
  };

  UI.prototype._clampBar = function () {
    var bar = this.$('.bar');
    if (!bar || bar.style.top === '' || bar.style.top === 'auto') return;
    var w = bar.offsetWidth, h = bar.offsetHeight;
    if (!w || !h) return;                 // not laid out yet; nothing to clamp against
    var left = parseFloat(bar.style.left);
    var top = parseFloat(bar.style.top);
    if (!isFinite(left) || !isFinite(top)) return;
    bar.style.left = Math.max(4, Math.min(root.innerWidth - w - 4, left)) + 'px';
    bar.style.top = Math.max(4, Math.min(root.innerHeight - h - 4, top)) + 'px';
  };

  UI.prototype.$ = function (sel) { return this.shadow && this.shadow.querySelector(sel); };

  /* ---------- control bar state ---------- */

  UI.prototype.setState = function (s) {
    if (!this.shadow) return;
    var q = this.$.bind(this);

    if (s.playing !== undefined) {
      var t = q('[data-act="toggle"]');
      t.innerHTML = icon(s.playing ? 'pause' : 'play', 20);
      t.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    }
    if (s.index !== undefined || s.total !== undefined) {
      var total = s.total === undefined ? this._total : s.total;
      var idx = s.index === undefined ? this._index : s.index;
      this._total = total; this._index = idx;
      q('[data-role="count"]').textContent = (total ? (idx + 1) : 0) + ' / ' + (total || 0);
      q('[data-act="prev"]').toggleAttribute('disabled', !(idx > 0));
      q('[data-act="next"]').toggleAttribute('disabled', !(total && idx < total - 1));
      if (this._reseatTabStop) this._reseatTabStop();
    }
    if (s.rate !== undefined) q('[data-act="rate"]').textContent = Number(s.rate).toFixed(2).replace(/0$/, '') + 'x';
    // State must not be conveyed by colour alone: mirror it into aria-pressed
    // so a screen reader announces on/off, and into the title so a tooltip
    // says which it is.
    if (s.focus !== undefined) {
      // `focus` is the MODE string ('off' | 'spotlight' | 'ruler'), not a
      // boolean: spotlight and ruler previously rendered and announced
      // identically, so pressing F twice gave no way to tell them apart.
      var mode = (s.focus === true) ? 'spotlight' : (s.focus || 'off');
      var LABELS = { off: 'off', spotlight: 'dim the rest', ruler: 'reading ruler' };
      var fb = q('[data-act="focus"]');
      fb.classList.toggle('on', mode !== 'off');
      fb.setAttribute('data-mode', mode);
      fb.setAttribute('aria-pressed', mode !== 'off' ? 'true' : 'false');
      fb.setAttribute('aria-label', 'Focus mode: ' + LABELS[mode]);
      fb.title = 'Focus mode (F) - ' + LABELS[mode];
    }
    if (s.bilingual !== undefined) {
      var bb = q('[data-act="bilingual"]');
      bb.classList.toggle('on', !!s.bilingual);
      bb.setAttribute('aria-pressed', s.bilingual ? 'true' : 'false');
      bb.title = 'Translation under every sentence (B) - ' + (s.bilingual ? 'on' : 'off');
    }
    if (s.hidden !== undefined) q('.bar').toggleAttribute('hidden', !!s.hidden);
  };

  UI.prototype.setVoices = function (voices, selectedURI) {
    var sel = this.$('[data-role="voice"]');
    if (!sel) return;
    var opts = ['<option value="">Default voice</option>'];
    voices.forEach(function (v) {
      var label = v.name.replace(/\s*\(.*?\)\s*$/, '') + ' - ' + v.lang;
      opts.push('<option value="' + escapeAttr(v.voiceURI) + '">' + escapeHtml(label) + '</option>');
    });
    sel.innerHTML = opts.join('');
    sel.value = selectedURI || '';
  };

  UI.prototype.setProgress = function (fraction) {
    var p = this.$('.prog');
    if (!p) return;
    if (fraction === null || fraction >= 1) {
      p.style.width = '100%';
      setTimeout(function () { p.hidden = true; p.style.width = '0'; }, 320);
      return;
    }
    p.hidden = false;
    p.style.width = Math.max(2, Math.round(fraction * 100)) + '%';
  };

  /* ---------- selection popup ---------- */

  UI.prototype.showPopup = function (rect, data) {
    var pop = this.$('.pop');
    if (!pop) return;
    var out = this.$('[data-role="out"]');

    this.$('[data-role="src"]').textContent = data.source || '';
    out.textContent = data.text || '';
    out.classList.toggle('pending', !!data.pending);
    out.classList.toggle('error', !!data.error);
    this.$('[data-role="prov"]').textContent = data.provider || '';

    pop.hidden = false;
    this._position(pop, rect);
  };

  UI.prototype._position = function (pop, rect) {
    // Measure first, then choose a side that keeps the popup fully on screen.
    pop.style.left = '-9999px';
    pop.style.top = '0';
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var vw = root.innerWidth, vh = root.innerHeight, gap = 8;

    var left = Math.round(rect.left + rect.width / 2 - w / 2);
    left = Math.max(gap, Math.min(vw - w - gap, left));

    var below = rect.bottom + gap;
    var top = (below + h < vh - gap) ? below : Math.max(gap, rect.top - h - gap);

    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  };

  UI.prototype.hidePopup = function () {
    var pop = this.$('.pop');
    if (pop) pop.hidden = true;
    this._popPinned = false;
  };

  UI.prototype.popupVisible = function () {
    var pop = this.$('.pop');
    return !!(pop && !pop.hidden);
  };

  UI.prototype.containsNode = function (node) {
    return !!(this.host && (this.host === node || this.host.contains(node)));
  };

  /* ---------- toast ---------- */

  UI.prototype.toast = function (message, ms) {
    var t = this.$('.toast');
    if (!t) return;
    // Reveal first, THEN write. A mutation inside a display:none subtree is
    // outside the accessibility tree, and most screen readers stay silent.
    t.hidden = false;
    t.textContent = '';
    // Force the reveal to be observed before the text lands.
    void t.offsetHeight;
    t.textContent = message;
    clearTimeout(this._toastTimer);
    var self = this;
    this._toastTimer = setTimeout(function () {
      self._toastTimer = null;
      // destroy() may have run in the meantime; $() would return null and the
      // old code threw inside a timer, where nothing catches it.
      var el2 = self.$('.toast');
      if (el2) el2.hidden = true;
    }, ms || 2600);
  };

  /* ---------- reading ruler ---------- */

  UI.prototype.updateRuler = function (rect) {
    var top = document.getElementById('fr-ruler-top');
    var bot = document.getElementById('fr-ruler-bottom');
    if (!rect) {
      if (top) top.remove();
      if (bot) bot.remove();
      return;
    }
    if (!top) {
      top = document.createElement('div');
      top.id = 'fr-ruler-top';
      top.className = 'fr-ignore';
      document.documentElement.appendChild(top);
    }
    if (!bot) {
      bot = document.createElement('div');
      bot.id = 'fr-ruler-bottom';
      bot.className = 'fr-ignore';
      document.documentElement.appendChild(bot);
    }
    var pad = 4;
    top.style.height = Math.max(0, rect.top - pad) + 'px';
    bot.style.height = Math.max(0, root.innerHeight - rect.bottom - pad) + 'px';
  };

  UI.prototype.destroy = function () {
    clearTimeout(this._toastTimer);
    this._toastTimer = null;
    if (this._onWindowResize) {
      root.removeEventListener('resize', this._onWindowResize);
      this._onWindowResize = null;
    }
    this.updateRuler(null);
    if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
    if (this.spacer && this.spacer.parentNode) this.spacer.parentNode.removeChild(this.spacer);
    this.host = null;
    this.spacer = null;
    this.shadow = null;
  };

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

  FR.UI = UI;
})(typeof globalThis !== 'undefined' ? globalThis : self);
