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

  // A raw exception string under a sentence tells the reader nothing they can
  // act on. Map what we know to plain language, and keep the detail in the
  // console for whoever is debugging.
  var ERROR_TEXT = {
    quota: 'Daily translation limit reached. Add your email in settings to raise it, or switch provider.',
    auth: 'The translation service rejected your API key. Check it in settings.',
    config: 'This translation engine is not set up yet. Open settings to finish it.',
    relay: 'FocusRead could not reach its background service. Try reloading the page.',
    'builtin-unavailable': 'Chrome\'s built-in translator is not available here. Pick another engine in settings.',
    'builtin-in-worker': 'Chrome\'s built-in translator is not available here. Pick another engine in settings.',
    'builtin-pair': 'Chrome cannot translate this language pair on this device. Pick another engine in settings.',
    'builtin-needs-gesture': 'Chrome needs to download a language pack. Open the FocusRead popup and click Download.',
    'builtin-timeout': 'The translator stopped responding. Check your connection, or pick another engine.',
    provider: 'The translation service returned an error. Try again, or switch provider in settings.',
    network: 'Could not reach the translation service. Check your connection, or that FocusRead is allowed to contact it.',
    offline: 'You appear to be offline. Chrome\'s built-in translator works without a connection - you can switch to it in settings.',
    error: 'Translation failed. Try again, or switch provider in settings.'
  };

  function friendlyError(result) {
    if (!result) return 'Translation failed.';
    if (result.error && !result.code) return String(result.error);
    var msg = ERROR_TEXT[result.code];
    if (msg) {
      if (result.error) console.warn('[FocusRead]', result.code, result.error);
      return msg;
    }
    console.warn('[FocusRead] translation failed', result);
    return 'Translation failed. ' + (result.error || '');
  }

  function Controller(opts) {
    opts = opts || {};
    this.opts = opts;
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
    this._playGeneration = 0;    // invalidates in-flight auto-advance chains
    this._bilingualGen = 0;      // invalidates in-flight translation batches
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
        clauseMaxLen: s.clauseMaxLen,
        groupSelector: self.opts.groupSelector || null
      });

      self.ui = new FR.UI(self._actions(), { position: s.toolbarPos });
      self.ui.mount();

      document.documentElement.classList.add('fr-active');
      self.applyVisuals();

      FR.speech.getVoices().then(function (voices) {
        self.ui.setVoices(FR.speech.curateVoices(voices, s.voiceFilter), s.voiceURI);
      });

      self.engine.on('progress', function (p) {
        if (p.total > 20) self.ui.setProgress(p.done / p.total);
      });

      // A live page can grow after the first pass; the toolbar count and the
      // bilingual observer both have to follow.
      self.engine.on('scanned', function (info) {
        if (!self.active) return;
        self.ui.setState({ total: info.count });
        if (self.settings.bilingual) self._observeForBilingual();
      });

      return self.engine.scan().then(function (count) {
        self.ui.setProgress(null);
        self.engine.watch();
        self.ui.setState({ total: count, index: 0, playing: false, rate: s.rate,
                           focus: s.focusMode, bilingual: s.bilingual });
        if (!count) {
          self.ui.toast('FocusRead found no readable text on this page.');
        } else {
          self.engine.setCurrent(self.engine.firstVisible(), { scroll: false });
          if (s.boldHeads) self.engine.setBoldHeads(true, s.boldHeadStrength);
          if (s.bilingual) self.setBilingual(true);
        }
        self._wireEvents();
        // Registered per activate(), so it MUST be removed on deactivate -
        // otherwise every activation leaves another listener behind that keeps
        // restyling a page the reader has already switched off.
        self._settingsListener = FR.settings.onChange(function (next) {
          if (!self.active) return;
          self.settings = next;
          self.applyVisuals();
        });
        return self;
      });
    });
  };

  Controller.prototype.deactivate = function () {
    if (!this.active) return;
    this.active = false;                 // stop late callbacks touching the UI
    this.stop();
    if (this._settingsListener) {
      FR.settings.offChange(this._settingsListener);
      this._settingsListener = null;
    }
    this._unwireEvents();
    if (this._io) { this._io.disconnect(); this._io = null; }
    if (this.engine) this.engine.detach();
    if (this.ui) this.ui.destroy();
    // Each Translator instance holds on-device model resources. Leaking one per
    // navigation adds up over a long reading session.
    if (FR.translate && FR.translate.builtinDestroy) FR.translate.builtinDestroy();
    var html = document.documentElement;
    html.classList.remove('fr-active', 'fr-focus-spotlight', 'fr-focus-ruler', 'fr-typo', 'fr-width',
      'fr-hl-underline', 'fr-hl-block', 'fr-hl-box', 'fr-hl-none',
      'fr-tint-sepia', 'fr-tint-gray', 'fr-tint-dark');
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
      this.ui.setState({ rate: s.rate, focus: s.focusMode, bilingual: s.bilingual });
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

    // `playing` alone is not enough to stop a stale chain: clicking a new
    // sentence sets playing=false then true again within the same tick, so the
    // old sentence's onend still sees playing===true and advances from ITS
    // index, and two chains then race, each undoing the other's highlight.
    var generation = ++this._playGeneration;
    var mine = function () { return self.active && self.playing && self._playGeneration === generation; };

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
        if (!mine()) return;
        if (s.highlightWords) self.engine.highlightWord(rec.i, b.charIndex, b.charLength);
      },
      onend: function () {
        if (!mine()) return;
        self.engine.clearWord();

        var advance = function () {
          if (!mine()) return;
          if (s.autoAdvance && self.engine.index < self.engine.count() - 1) {
            var go = function () {
              if (!mine()) return;
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
        if (s.speakTranslation) self._speakTranslation(rec, generation).then(advance, advance);
        else advance();
      },
      onerror: function (e) {
        if (!self.active) return;
        self.playing = false;
        if (self.engine) self.engine.clearWord();
        self.ui.setState({ playing: false });
        self.ui.toast(e.error === 'unsupported'
          ? 'This browser has no speech engine available.'
          : 'Speech stopped (' + e.error + '). Press play to continue.', 4000);
      }
    }).catch(function () { /* reported through onerror */ });
  };

  /**
   * Speak the translation of `rec` in the target language, fetching it first if
   * it is not already on screen. Never rejects - a failed translation should
   * pause reading, not end it.
   */
  Controller.prototype._speakTranslation = function (rec, generation) {
    var self = this;
    var s = this.settings;
    var mine = function () {
      return self.active && self.playing &&
             (generation === undefined || self._playGeneration === generation);
    };
    // Only render it if bilingual mode is already showing translations;
    // otherwise "read the translation aloud" would silently also switch on
    // inline translation, which is a different feature.
    var have = rec.translation
      ? Promise.resolve(rec.translation)
      : this.translateSentence(rec.i, !!s.bilingual);

    return have.then(function (text) {
      // Fetching a translation can take a second or more. If the reader clicked
      // a different sentence meanwhile, speaking this one would cancel the new
      // sentence mid-word AND orphan its chain, wedging playback entirely.
      if (!text || !mine()) return;
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
    this._playGeneration++;
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
    this._playGeneration++;
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

    var relay = function () {
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

    // "auto" is split across two contexts: only a page can reach Chrome's
    // built-in translator, only the worker can reach the network without the
    // page's CORS rules. Ask here whether the built-in one is actually ready;
    // if it is not, hand the whole thing to the worker, which will skip it.
    if (s.provider === 'auto') {
      opts.onProgress = onProgress;
      return FR.translate.builtinUsable(opts.sourceLang === 'auto' ? 'en' : opts.sourceLang, opts.targetLang)
        .then(function (ok) {
          if (!ok) return relay();
          return FR.translate.translateBatch(texts, opts).then(function (results) {
            var allBad = results.length && results.every(function (r) { return r && !r.ok; });
            return allBad ? relay() : results;
          });
        });
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

  /**
   * @param {number} i
   * @param {boolean} [render=true] false to fetch without putting it on screen -
   *   used when the translation is only going to be spoken.
   */
  Controller.prototype.translateSentence = function (i, render) {
    var self = this;
    var show = render !== false;
    var rec = this.engine.get(i);
    if (!rec) return Promise.resolve(null);

    if (rec.translation) {
      if (show) this.engine.setTranslation(i, rec.translation);
      return Promise.resolve(rec.translation);
    }

    if (show) {
      this.engine.setTranslation(i, 'translating...');
      if (rec.transEl) rec.transEl.classList.add('fr-t-pending');
    }

    return this.translate([rec.text]).then(function (res) {
      var r = res[0] || { ok: false, code: 'provider', error: 'No result' };
      if (!r.ok) rec.translation = null;
      if (show) {
        if (rec.transEl) {
          rec.transEl.classList.remove('fr-t-pending');
          rec.transEl.classList.toggle('fr-t-error', !r.ok);
        }
        self.engine.setTranslation(i, r.ok ? r.text : friendlyError(r));
      } else if (!r.ok) {
        self._reportProviderError(r);
      }
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
    // Any batch already in flight belongs to the previous state. Without this,
    // a request issued while bilingual was ON resolves after it is switched
    // OFF and re-creates every translation element that was just removed.
    var gen = ++this._bilingualGen;
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
      clearTimeout(this._bilingualTimer);
      this._pendingBilingual = [];
      // Clear the per-mark stamps too. Leaving them meant a NEW observer
      // skipped every sentence, so turning bilingual off and on again left the
      // button reading "on" with the feature silently dead.
      this.engine.sentences.forEach(function (rec) {
        if (rec.marks[0]) delete rec.marks[0].__frObserved;
      });
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

    this._observeForBilingual();
    // Don't rely on the observer alone for the first screen. IntersectionObserver
    // callbacks are throttled while a tab is hidden, so enabling bilingual mode
    // in a background tab (or from a restored session) could leave the feature
    // silently doing nothing until something happened to scroll.
    this._queueVisible();
  };

  /** Queue every sentence currently within (or near) the viewport, by geometry. */
  Controller.prototype._queueVisible = function () {
    if (!this.engine) return;
    var vh = root.innerHeight || document.documentElement.clientHeight || 0;
    var margin = 250;
    var queued = 0;
    for (var i = 0; i < this.engine.sentences.length; i++) {
      var mark = this.engine.sentences[i].marks[0];
      if (!mark) continue;
      var r;
      try { r = mark.getBoundingClientRect(); } catch (e) { continue; }
      if (!r.height && !r.width) continue;
      if (r.bottom < -margin || r.top > vh + margin) continue;
      this._queueBilingual(i);
      if (++queued >= 40) break;            // one screenful is plenty
    }
  };

  /** Observe every sentence that is not being watched yet. */
  Controller.prototype._observeForBilingual = function () {
    var self = this;
    if (!this._io || !this.engine) return;
    this.engine.sentences.forEach(function (rec) {
      var mark = rec.marks[0];
      if (!mark || mark.__frObserved) return;
      mark.__frObserved = true;
      self._io.observe(mark);
    });
  };

  Controller.prototype._queueBilingual = function (i) {
    var self = this;
    if (!this.settings.bilingual) return;
    if (this._pendingBilingual.indexOf(i) === -1) this._pendingBilingual.push(i);
    clearTimeout(this._bilingualTimer);
    this._bilingualTimer = setTimeout(function () { self._flushBilingual(); }, 220);
  };

  Controller.prototype._flushBilingual = function () {
    var self = this;
    if (!this.active || !this.engine) return;
    var batch = this._pendingBilingual.splice(0, 20);
    if (!batch.length) return;

    var recs = batch.map(function (i) { return self.engine.get(i); }).filter(Boolean);
    var fresh = recs.filter(function (r) { return !r.translation; });
    if (!fresh.length) {
      // Everything in this batch was already translated. Keep draining rather
      // than returning, or the rest of the queue is stranded until the reader
      // happens to scroll something new into view.
      if (this._pendingBilingual.length) this._flushBilingual();
      return;
    }

    fresh.forEach(function (r) {
      self.engine.setTranslation(r.i, 'translating...');
      if (r.transEl) r.transEl.classList.add('fr-t-pending');
    });

    var gen = this._bilingualGen;
    this.translate(fresh.map(function (r) { return r.text; })).then(function (res) {
      // Superseded: bilingual was toggled while this batch was in flight.
      if (gen !== self._bilingualGen || !self.settings.bilingual) return;
      var firstError = null;
      fresh.forEach(function (r, k) {
        var out = res[k] || { ok: false, error: 'No result' };
        if (r.transEl) {
          r.transEl.classList.remove('fr-t-pending');
          r.transEl.classList.toggle('fr-t-error', !out.ok);
        }
        self.engine.setTranslation(r.i, out.ok ? out.text : friendlyError(out));
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
    this.ui.toast(friendlyError(err), 5500);
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
            self.engine.setTranslation(r.i, out.ok ? out.text : friendlyError(out));
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
        text: r.ok ? r.text : friendlyError(r),
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
      moved: function (pos) {
        if (!pos || !isFinite(pos.left) || !isFinite(pos.top)) return;
        self.settings.toolbarPos = pos;
        FR.settings.set({ toolbarPos: pos });
      },
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
      // Speaking a selection takes over the single speech engine, so the
      // reading session has to be stopped properly first - otherwise the
      // toolbar still shows Play and the engine's auto-advance is left armed.
      'pop-speak-src': function () {
        if (!self._lastSelection) {
          self.ui.toast('Nothing is selected.');
          return;
        }
        self.stop();
        FR.speech.speak(self._lastSelection, {
          rate: self.settings.rate, lang: self.docLang(),
          maxChars: self.settings.maxUtteranceChars, localOnly: self.settings.localVoicesOnly,
          onerror: function (err) { self.ui.toast('Could not read that aloud (' + err.error + ').'); }
        }).catch(function () { /* reported above */ });
      },
      'pop-speak-out': function () {
        // Check BEFORE stopping: speak('') returns early without bumping the
        // speech token, so stopping first would silently end the reading
        // session and then speak nothing at all. _lastTranslation is empty
        // whenever the translation is still in flight or failed.
        if (!self._lastTranslation) {
          self.ui.toast('There is no translation to read yet.');
          return;
        }
        self.stop();
        FR.speech.speak(self._lastTranslation, {
          rate: self.settings.rate, lang: self.settings.targetLang,
          voiceURI: '', maxChars: self.settings.maxUtteranceChars, localOnly: false,
          onerror: function () {
            self.ui.toast('No ' + FR.translate.langName(self.settings.targetLang) +
                          ' voice is installed on this computer.', 4500);
          }
        }).catch(function () { /* reported above */ });
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

  var TYPING = { INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1 };

  // Only elements that genuinely consume Space or an arrow key. A link is NOT
  // one of them - it activates on Enter, which this extension never binds - and
  // including <a> disabled every shortcut whenever focus sat inside a citation
  // link, which on a paper is most of the time. LABEL and DETAILS are not
  // focusable at all and only ever appeared as ancestors.
  var ACTIVATABLE = { BUTTON: 1, SUMMARY: 1, VIDEO: 1, AUDIO: 1 };

  // Widgets that own the arrow keys. "link" is deliberately absent, for the
  // same reason <a> is.
  var INTERACTIVE_ROLE = /^(button|textbox|searchbox|combobox|listbox|menuitem|menuitemcheckbox|menuitemradio|checkbox|radio|slider|spinbutton|switch|tab|option)$/;

  /**
   * Is this element typing-capable, or a widget that owns the arrow keys?
   *
   * Checked all the way up the composed path: an INPUT cannot contain focusable
   * descendants, and a composite widget may put focus on an inner handle while
   * the role sits on the container.
   */
  function isTypingTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    if (TYPING[String(el.tagName || '').toUpperCase()]) return true;
    if (el.isContentEditable) return true;
    var role = el.getAttribute && el.getAttribute('role');
    return !!(role && INTERACTIVE_ROLE.test(role));
  }

  /**
   * Does the FOCUSED element itself act on Space?
   *
   * Only ever applied to the innermost target, never to ancestors: a tabindex
   * on a wrapper (or on <body>, a common accessibility pattern) must not
   * disable the reader across the whole page.
   */
  function isActivationTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = String(el.tagName || '').toUpperCase();
    if (tag === 'BODY' || tag === 'HTML') return false;
    if (tag === 'A') return false;                 // activates on Enter, not Space
    if (ACTIVATABLE[tag]) return true;
    // A focusable custom control may well use Space, so tabindex counts - with
    // one exception: role="link" is a link, and a link never acts on Space.
    // Without this, removing "link" from the typing roles would be undone by
    // the tabindex every such element carries.
    var role = el.getAttribute && el.getAttribute('role');
    if (role === 'link') return false;
    return !!(el.getAttribute &&
              el.hasAttribute('tabindex') &&
              el.getAttribute('tabindex') !== '-1');
  }

  Controller.prototype._onKey = function (e) {
    if (!this.settings.shortcutsEnabled) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // composedPath() sees INTO shadow roots. e.target is retargeted to the
    // host, so a page that builds its search box in a shadow DOM would look
    // like a plain <div> and have its typing stolen.
    var path = (e.composedPath && e.composedPath()) || [e.target];

    if (isActivationTarget(path[0])) return;     // a focused button, summary, ...

    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (node === this.ui.host) return;          // our own controls
      if (node === document || node === window) break;
      if (isTypingTarget(node)) return;
    }

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
        // Deliberately never deactivates. Escape is pressed reflexively to
        // dismiss things, and losing the whole session - every translation on
        // the page with it - is far too destructive for a stray keypress.
        if (this.ui.popupVisible()) { e.preventDefault(); this.ui.hidePopup(); }
        else if (this.playing) { e.preventDefault(); this.stop(); }
        else { this.ui.toast('Press Alt+R, or the X on the toolbar, to turn FocusRead off.'); }
        break;
      default: break;
    }
  };

  FR.Controller = Controller;
  FR.RATES = RATES;
})(typeof globalThis !== 'undefined' ? globalThis : self);
