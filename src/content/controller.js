/*
 * FocusRead - the controller.
 *
 * Owns the lifecycle: settings -> engine scan -> UI -> speech -> translation.
 * Deliberately independent of HOW the document arrived, so the same class
 * drives an ordinary web page (content.js) and the built-in PDF/DOCX reader
 * (reader.js).
 *
 * Translation routing is the subtle part. Chrome's on-device Translator exists
 * only where there is a real Document, so it runs HERE. Network providers need
 * the extension's host permissions and must not be subject to the page's CORS
 * policy, so those are relayed to the service worker.
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  var FONT_STACKS = {
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    serif: 'Georgia, "Iowan Old Style", "Times New Roman", Times, serif',
    sans: '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    dyslexic: '"OpenDyslexic", "Comic Sans MS", "Trebuchet MS", Verdana, sans-serif'
  };

  var RATES = [0.6, 0.75, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0];

  function Controller(opts) {
    opts = opts || {};
    this.rootEl = opts.root || document.body;
    this.isReader = !!opts.isReader;
    this.active = false;
    this.playing = false;
    this.settings = null;
    this.engine = null;
    this.ui = null;
    this._pendingBilingual = [];
    this._bilingualTimer = null;
    this._io = null;
    this._boundKeys = null;
    this._rulerRaf = null;
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  Controller.prototype.activate = function () {
    var self = this;
    if (this.active) return Promise.resolve(this);
    return FR.settings.get().then(function (s) {
      self.settings = s;
      self.active = true;

      self.engine = new FR.Engine(self.rootEl, {
        readUnit: s.readUnit,
        clauseMaxLen: s.clauseMaxLen
      });

      self.ui = new FR.UI(self._actions());
      self.ui.mount();

      document.documentElement.classList.add('fr-active');
      self.applyVisuals();

      FR.speech.getVoices().then(function (voices) {
        var list = s.localVoicesOnly ? voices.filter(function (v) { return v.localService; }) : voices;
        self.ui.setVoices(list.length ? list : voices, s.voiceURI);
      });

      self.engine.on('progress', function (p) {
        if (p.total > 20) self.ui.setProgress(p.done / p.total);
      });

      return self.engine.scan().then(function (count) {
        self.ui.setProgress(null);
        self.engine.watch();
        self.ui.setState({ total: count, index: 0, playing: false, rate: s.rate,
                           focus: s.focusMode !== 'off', bilingual: s.bilingual });
        if (!count) {
          self.ui.toast('FocusRead found no readable text on this page.');
        } else {
          self.engine.setCurrent(self.engine.firstVisible(), { scroll: false });
          if (s.boldHeads) self.engine.setBoldHeads(true, s.boldHeadStrength);
          if (s.bilingual) self.setBilingual(true);
        }
        self._wireEvents();
        FR.settings.onChange(function (next) { self.settings = next; self.applyVisuals(); });
        return self;
      });
    });
  };

  Controller.prototype.deactivate = function () {
    if (!this.active) return;
    this.stop();
    this._unwireEvents();
    if (this._io) { this._io.disconnect(); this._io = null; }
    if (this.engine) this.engine.detach();
    if (this.ui) this.ui.destroy();
    var html = document.documentElement;
    html.classList.remove('fr-active', 'fr-focus-spotlight', 'fr-focus-ruler', 'fr-typo', 'fr-width',
      'fr-hl-underline', 'fr-hl-block', 'fr-hl-box', 'fr-hl-none',
      'fr-tint-sepia', 'fr-tint-gray', 'fr-tint-dark');
    this.active = false;
    this.engine = null;
    this.ui = null;
  };

  Controller.prototype.toggle = function () {
    return this.active ? (this.deactivate(), Promise.resolve(this)) : this.activate();
  };

  /* ------------------------------------------------------------------ *
   * Visual settings -> CSS
   * ------------------------------------------------------------------ */

  Controller.prototype.applyVisuals = function () {
    var s = this.settings, html = document.documentElement, st = html.style;
    if (!s) return;

    html.classList.remove('fr-focus-spotlight', 'fr-focus-ruler');
    if (s.focusMode === 'spotlight') html.classList.add('fr-focus-spotlight');
    if (s.focusMode === 'ruler') html.classList.add('fr-focus-ruler');
    if (s.focusMode !== 'ruler' && this.ui) this.ui.updateRuler(null);

    ['underline', 'block', 'box', 'none'].forEach(function (k) {
      html.classList.toggle('fr-hl-' + k, s.highlightStyle === k);
    });

    html.classList.toggle('fr-typo', !!s.typography);
    html.classList.toggle('fr-width', Number(s.maxWidth) > 0);
    ['sepia', 'gray', 'dark'].forEach(function (k) {
      html.classList.toggle('fr-tint-' + k, s.paperTint === k);
    });

    st.setProperty('--fr-hl', s.highlightColor);
    st.setProperty('--fr-word', s.wordHighlightColor);
    st.setProperty('--fr-dim', String(s.dimOpacity));
    st.setProperty('--fr-scale', String(s.fontScale));
    st.setProperty('--fr-lh', String(s.lineHeight));
    st.setProperty('--fr-ls', Number(s.letterSpacing) + 'px');
    st.setProperty('--fr-ws', Number(s.wordSpacing) + 'px');
    st.setProperty('--fr-mw', (Number(s.maxWidth) || 680) + 'px');
    st.setProperty('--fr-ff', FONT_STACKS[s.fontFamily] || 'inherit');
    st.setProperty('--fr-bi-scale', String(s.bilingualScale));

    if (this.ui) {
      this.ui.setState({ rate: s.rate, focus: s.focusMode !== 'off', bilingual: s.bilingual });
    }
  };

  /* ------------------------------------------------------------------ *
   * Playback
   * ------------------------------------------------------------------ */

  Controller.prototype.speakCurrent = function () {
    var self = this;
    var rec = this.engine.current();
    if (!rec) return;
    var s = this.settings;

    this.playing = true;
    this.ui.setState({ playing: true, index: rec.i, total: this.engine.count() });

    FR.speech.speak(rec.text, {
      voiceURI: s.voiceURI,
      rate: s.rate,
      pitch: s.pitch,
      volume: s.volume,
      lang: this.docLang(),
      maxChars: s.maxUtteranceChars,
      localOnly: s.localVoicesOnly,
      lagWord: s.wordHighlightLag,
      onboundary: function (b) {
        if (s.highlightWords) self.engine.highlightWord(rec.i, b.charIndex, b.charLength);
      },
      onend: function () {
        self.engine.clearWord();
        if (!self.playing) return;

        var advance = function () {
          if (!self.playing) return;
          if (s.autoAdvance && self.engine.index < self.engine.count() - 1) {
            var go = function () {
              if (!self.playing) return;
              self.engine.setCurrent(self.engine.index + 1, { scroll: s.scrollFollow });
              self.speakCurrent();
            };
            s.pauseBetween > 0 ? setTimeout(go, s.pauseBetween) : go();
          } else {
            self.playing = false;
            self.ui.setState({ playing: false });
          }
        };

        // Hear it again in your own language before moving on.
        if (s.speakTranslation) self._speakTranslation(rec).then(advance, advance);
        else advance();
      },
      onerror: function (e) {
        self.playing = false;
        self.engine.clearWord();
        self.ui.setState({ playing: false });
        self.ui.toast(e.error === 'unsupported'
          ? 'This browser has no speech engine available.'
          : 'Speech stopped: ' + e.error);
      }
    }).catch(function () { /* reported through onerror */ });
  };

  /**
   * Speak the translation of `rec` in the target language, fetching it first if
   * it is not already on screen. Never rejects - a failed translation should
   * pause reading, not end it.
   */
  Controller.prototype._speakTranslation = function (rec) {
    var self = this;
    var s = this.settings;
    var have = rec.translation
      ? Promise.resolve(rec.translation)
      : this.translateSentence(rec.i);

    return have.then(function (text) {
      if (!text || !self.playing) return;
      return FR.speech.speak(text, {
        rate: s.rate,
        pitch: s.pitch,
        volume: s.volume,
        lang: s.targetLang,
        voiceURI: '',                 // the reading voice is for the source language
        maxChars: s.maxUtteranceChars,
        localOnly: s.localVoicesOnly,
        onerror: function () { /* no voice for this language; just move on */ }
      });
    }).catch(function () { /* keep reading regardless */ });
  };

  Controller.prototype.play = function () {
    if (!this.engine || !this.engine.count()) return;
    if (FR.speech.state() === 'paused') {
      FR.speech.resume();
      this.playing = true;
      this.ui.setState({ playing: true });
      return;
    }
    if (this.engine.index < 0) this.engine.setCurrent(this.engine.firstVisible());
    this.speakCurrent();
  };

  Controller.prototype.pause = function () {
    FR.speech.pause();
    this.playing = false;
    this.ui.setState({ playing: false });
  };

  Controller.prototype.stop = function () {
    this.playing = false;
    FR.speech.cancel();
    if (this.engine) this.engine.clearWord();
    if (this.ui) this.ui.setState({ playing: false });
  };

  Controller.prototype.togglePlay = function () {
    var st = FR.speech.state();
    if (this.playing && st === 'speaking') return this.pause();
    this.play();
  };

  Controller.prototype.step = function (delta) {
    if (!this.engine || !this.engine.count()) return;
    var wasPlaying = this.playing;
    FR.speech.cancel();
    this.playing = false;
    var target = Math.max(0, Math.min(this.engine.count() - 1, this.engine.index + delta));
    this.engine.setCurrent(target, { scroll: true });
    this.ui.setState({ index: target });
    if (wasPlaying) this.speakCurrent(); else this.ui.setState({ playing: false });
  };

  Controller.prototype.docLang = function () {
    var s = this.settings;
    if (s.sourceLang && s.sourceLang !== 'auto') return s.sourceLang;
    return document.documentElement.getAttribute('lang') || 'en';
  };

  /* ------------------------------------------------------------------ *
   * Translation
   * ------------------------------------------------------------------ */

  /** Route a batch to the right execution context and return per-item results. */
  Controller.prototype.translate = function (texts, onProgress) {
    var s = this.settings;
    var opts = {
      provider: s.provider,
      sourceLang: s.sourceLang === 'auto' ? this.docLang() : s.sourceLang,
      targetLang: s.targetLang,
      providerConfig: s.providerConfig,
      cache: s.cacheTranslations
    };

    if (s.provider === 'builtin') {
      if (!FR.translate.builtinAvailable()) {
        return Promise.resolve(texts.map(function () {
          return {
            ok: false, code: 'builtin-unavailable',
            error: 'Chrome\'s built-in translator is not available here (needs Chrome 138+ on desktop, over https). Pick another provider in FocusRead settings.'
          };
        }));
      }
      opts.onProgress = onProgress;
      return FR.translate.translateBatch(texts, opts);
    }

    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: 'FR_TRANSLATE', texts: texts, opts: opts }, function (resp) {
        if (chrome.runtime.lastError || !resp) {
          return resolve(texts.map(function () {
            return {
              ok: false, code: 'relay',
              error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'No response from FocusRead background'
            };
          }));
        }
        resolve(resp.results || []);
      });
    });
  };

  Controller.prototype.translateSentence = function (i) {
    var self = this;
    var rec = this.engine.get(i);
    if (!rec) return Promise.resolve(null);
    if (rec.translation) { this.engine.setTranslation(i, rec.translation); return Promise.resolve(rec.translation); }

    this.engine.setTranslation(i, 'translating...');
    if (rec.transEl) rec.transEl.classList.add('fr-t-pending');

    return this.translate([rec.text]).then(function (res) {
      var r = res[0] || { ok: false, error: 'No result' };
      if (rec.transEl) {
        rec.transEl.classList.remove('fr-t-pending');
        rec.transEl.classList.toggle('fr-t-error', !r.ok);
      }
      self.engine.setTranslation(i, r.ok ? r.text : r.error);
      if (!r.ok) rec.translation = null;
      return r.ok ? r.text : null;
    });
  };

  /**
   * Bilingual mode. Sentences are translated as they scroll into view rather
   * than all at once: a 300-sentence paper would otherwise burn a free-tier
   * quota in a single page load.
   */
  Controller.prototype.setBilingual = function (on) {
    var self = this;
    if (on && this.allowBilingual === false) {
      this.ui.toast('Inline translation needs Reading view - Original layout has no room between the lines.', 4200);
      this.ui.setState({ bilingual: false });
      return;
    }
    this.settings.bilingual = !!on;
    FR.settings.set({ bilingual: !!on });
    this.ui.setState({ bilingual: !!on });

    if (!on) {
      if (this._io) { this._io.disconnect(); this._io = null; }
      this._pendingBilingual = [];
      this.engine.clearTranslations();
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      this.ui.toast('Translating the whole page...');
      return this.translatePage();
    }

    this._io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var i = Number(e.target.getAttribute('data-i'));
        self._io.unobserve(e.target);
        if (!isNaN(i)) self._queueBilingual(i);
      });
    }, { rootMargin: '250px 0px' });

    this.engine.sentences.forEach(function (rec) {
      if (rec.marks[0]) self._io.observe(rec.marks[0]);
    });
  };

  Controller.prototype._queueBilingual = function (i) {
    var self = this;
    if (this._pendingBilingual.indexOf(i) === -1) this._pendingBilingual.push(i);
    clearTimeout(this._bilingualTimer);
    this._bilingualTimer = setTimeout(function () { self._flushBilingual(); }, 220);
  };

  Controller.prototype._flushBilingual = function () {
    var self = this;
    var batch = this._pendingBilingual.splice(0, 20);
    if (!batch.length) return;

    var recs = batch.map(function (i) { return self.engine.get(i); }).filter(Boolean);
    var fresh = recs.filter(function (r) { return !r.translation; });
    if (!fresh.length) return;

    fresh.forEach(function (r) {
      self.engine.setTranslation(r.i, 'translating...');
      if (r.transEl) r.transEl.classList.add('fr-t-pending');
    });

    this.translate(fresh.map(function (r) { return r.text; })).then(function (res) {
      var firstError = null;
      fresh.forEach(function (r, k) {
        var out = res[k] || { ok: false, error: 'No result' };
        if (r.transEl) {
          r.transEl.classList.remove('fr-t-pending');
          r.transEl.classList.toggle('fr-t-error', !out.ok);
        }
        self.engine.setTranslation(r.i, out.ok ? out.text : out.error);
        if (!out.ok) { r.translation = null; firstError = firstError || out; }
      });
      if (firstError) self._reportProviderError(firstError);
      if (self._pendingBilingual.length) self._flushBilingual();
    });
  };

  Controller.prototype._reportProviderError = function (err) {
    if (this._errorToasted) return;
    this._errorToasted = true;
    var self = this;
    setTimeout(function () { self._errorToasted = false; }, 8000);
    this.ui.toast(err.error || 'Translation failed', 5000);
  };

  /** Translate every sentence at once, with a progress bar. */
  Controller.prototype.translatePage = function () {
    var self = this;
    var recs = this.engine.sentences.filter(function (r) { return !r.translation; });
    if (!recs.length) { this.ui.toast('Everything is already translated.'); return Promise.resolve(); }

    var size = 20, done = 0;
    var groups = [];
    for (var i = 0; i < recs.length; i += size) groups.push(recs.slice(i, i + size));

    this.ui.toast('Translating ' + recs.length + ' sentences...');
    return groups.reduce(function (p, group) {
      return p.then(function () {
        group.forEach(function (r) {
          self.engine.setTranslation(r.i, 'translating...');
          if (r.transEl) r.transEl.classList.add('fr-t-pending');
        });
        return self.translate(group.map(function (r) { return r.text; })).then(function (res) {
          group.forEach(function (r, k) {
            var out = res[k] || { ok: false, error: 'No result' };
            if (r.transEl) {
              r.transEl.classList.remove('fr-t-pending');
              r.transEl.classList.toggle('fr-t-error', !out.ok);
            }
            self.engine.setTranslation(r.i, out.ok ? out.text : out.error);
            if (!out.ok) r.translation = null;
          });
          done += group.length;
          self.ui.setProgress(done / recs.length);
        });
      });
    }, Promise.resolve()).then(function () {
      self.ui.setProgress(null);
      self.ui.toast('Done.');
    });
  };

  /* ------------------------------------------------------------------ *
   * Selection popup
   * ------------------------------------------------------------------ */

  Controller.prototype.handleSelection = function () {
    var self = this;
    var s = this.settings;
    if (!s.translateOnSelect) return;

    var sel = root.getSelection && root.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;

    var text = String(sel.toString()).replace(/\s+/g, ' ').trim();
    if (text.length < 1 || text.length > 4000) return;
    if (this.ui.containsNode(sel.anchorNode)) return;      // selection inside our own UI

    var rect;
    try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) { return; }
    if (!rect || (!rect.width && !rect.height)) return;

    this._lastSelection = text;
    this.ui.showPopup(rect, {
      source: text.length > 220 ? text.slice(0, 220) + '...' : text,
      text: 'translating...',
      pending: true,
      provider: s.provider
    });

    this.translate([text]).then(function (res) {
      if (self._lastSelection !== text) return;            // superseded
      var r = res[0] || { ok: false, error: 'No result' };
      self._lastTranslation = r.ok ? r.text : '';
      self.ui.showPopup(rect, {
        source: text.length > 220 ? text.slice(0, 220) + '...' : text,
        text: r.ok ? r.text : r.error,
        error: !r.ok,
        provider: r.ok ? s.provider : ''
      });
    });
  };

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  Controller.prototype._actions = function () {
    var self = this;
    return {
      toggle: function () { self.togglePlay(); },
      prev: function () { self.step(-1); },
      next: function () { self.step(1); },
      rate: function () {
        var cur = self.settings.rate;
        var idx = RATES.indexOf(RATES.reduce(function (best, r) {
          return Math.abs(r - cur) < Math.abs(best - cur) ? r : best;
        }, RATES[0]));
        var next = RATES[(idx + 1) % RATES.length];
        self.settings.rate = next;
        FR.settings.set({ rate: next });
        self.ui.setState({ rate: next });
        if (self.playing) { FR.speech.cancel(); self.speakCurrent(); }
      },
      voice: function (uri) {
        self.settings.voiceURI = uri;
        FR.settings.set({ voiceURI: uri });
        if (self.playing) { FR.speech.cancel(); self.speakCurrent(); }
      },
      focus: function () {
        var order = ['off', 'spotlight', 'ruler'];
        var next = order[(order.indexOf(self.settings.focusMode) + 1) % order.length];
        self.settings.focusMode = next;
        FR.settings.set({ focusMode: next });
        self.applyVisuals();
        self.ui.toast('Focus: ' + next);
        self._updateRuler();
      },
      bilingual: function () { self.setBilingual(!self.settings.bilingual); },
      translate: function () {
        if (self.engine.index >= 0) self.translateSentence(self.engine.index);
      },
      settings: function () { chrome.runtime.sendMessage({ type: 'FR_OPEN_OPTIONS' }); },
      close: function () { self.deactivate(); },
      'pop-close': function () { self.ui.hidePopup(); },
      'pop-copy': function () {
        var t = self._lastTranslation || '';
        if (!t) return;
        navigator.clipboard.writeText(t).then(
          function () { self.ui.toast('Copied'); },
          function () { self.ui.toast('Could not copy'); }
        );
      },
      'pop-speak-src': function () {
        FR.speech.speak(self._lastSelection || '', {
          rate: self.settings.rate, lang: self.docLang(),
          maxChars: self.settings.maxUtteranceChars, localOnly: self.settings.localVoicesOnly
        });
      },
      'pop-speak-out': function () {
        FR.speech.speak(self._lastTranslation || '', {
          rate: self.settings.rate, lang: self.settings.targetLang,
          voiceURI: '', maxChars: self.settings.maxUtteranceChars, localOnly: false
        });
      }
    };
  };

  Controller.prototype._wireEvents = function () {
    var self = this;

    this._onClick = function (e) {
      if (self.ui.containsNode(e.target)) return;
      if (e.target.closest && e.target.closest('a,button,input,select,textarea,[role="button"]')) return;
      var i = self.engine.indexFromNode(e.target);
      if (i < 0) return;
      // A click that is really a drag-select should not start playback.
      var sel = root.getSelection && root.getSelection();
      if (sel && !sel.isCollapsed && String(sel).trim().length > 1) return;
      e.preventDefault();
      self.engine.setCurrent(i, { scroll: false });
      self.ui.setState({ index: i });
      self.ui.hidePopup();
      self.speakCurrent();
    };

    this._onMouseUp = function () { setTimeout(function () { self.handleSelection(); }, 10); };

    this._onDocMouseDown = function (e) {
      if (!self.ui.popupVisible()) return;
      if (self.ui.containsNode(e.target)) return;
      self.ui.hidePopup();
    };

    this._onScroll = function () {
      if (self.settings.focusMode === 'ruler') self._updateRuler();
      if (self.ui.popupVisible()) self.ui.hidePopup();
    };

    this._boundKeys = function (e) { self._onKey(e); };

    document.addEventListener('click', this._onClick, true);
    document.addEventListener('mouseup', this._onMouseUp, true);
    document.addEventListener('mousedown', this._onDocMouseDown, true);
    document.addEventListener('keydown', this._boundKeys, true);
    root.addEventListener('scroll', this._onScroll, { passive: true });
    root.addEventListener('resize', this._onScroll, { passive: true });

    this.engine.on('current', function () { self._updateRuler(); });
  };

  Controller.prototype._unwireEvents = function () {
    document.removeEventListener('click', this._onClick, true);
    document.removeEventListener('mouseup', this._onMouseUp, true);
    document.removeEventListener('mousedown', this._onDocMouseDown, true);
    document.removeEventListener('keydown', this._boundKeys, true);
    root.removeEventListener('scroll', this._onScroll);
    root.removeEventListener('resize', this._onScroll);
  };

  Controller.prototype._updateRuler = function () {
    var self = this;
    if (!this.ui) return;
    if (this.settings.focusMode !== 'ruler') return this.ui.updateRuler(null);
    cancelAnimationFrame(this._rulerRaf);
    this._rulerRaf = requestAnimationFrame(function () {
      var marks = self.engine ? self.engine.marksFor(self.engine.index) : [];
      if (!marks.length) return self.ui.updateRuler(null);
      var first = marks[0].getBoundingClientRect();
      var last = marks[marks.length - 1].getBoundingClientRect();
      self.ui.updateRuler({ top: Math.min(first.top, last.top), bottom: Math.max(first.bottom, last.bottom) });
    });
  };

  var TYPING = { INPUT: 1, TEXTAREA: 1, SELECT: 1 };

  Controller.prototype._onKey = function (e) {
    if (!this.settings.shortcutsEnabled) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (TYPING[t.tagName] || t.isContentEditable)) return;
    if (this.ui.containsNode(t)) return;

    switch (e.key) {
      case ' ':
        e.preventDefault(); this.togglePlay(); break;
      case 'j': case 'J': case 'ArrowRight':
        e.preventDefault(); this.step(1); break;
      case 'k': case 'K': case 'ArrowLeft':
        e.preventDefault(); this.step(-1); break;
      case 't': case 'T':
        if (this.settings.translateCurrentKey && this.engine.index >= 0) {
          e.preventDefault(); this.translateSentence(this.engine.index);
        }
        break;
      case 'b': case 'B':
        e.preventDefault(); this.setBilingual(!this.settings.bilingual); break;
      case 'f': case 'F':
        e.preventDefault(); this._actions().focus(); break;
      case 'Escape':
        if (this.ui.popupVisible()) { e.preventDefault(); this.ui.hidePopup(); }
        else if (this.playing) { e.preventDefault(); this.stop(); }
        else { this.deactivate(); }
        break;
      default: break;
    }
  };

  FR.Controller = Controller;
  FR.RATES = RATES;
})(typeof globalThis !== 'undefined' ? globalThis : self);
