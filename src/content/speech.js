/*
 * FocusRead - speech synthesis.
 *
 * Runs in the PAGE context (content script / reader page), never in the service
 * worker: an MV3 worker has no DOM and therefore no speechSynthesis, and only
 * speechSynthesis emits the `boundary` events that drive word highlighting.
 *
 * Chrome's implementation has several documented quirks, all handled here:
 *
 *  1. Desktop Chrome silently TRUNCATES an utterance past roughly 200-250
 *     characters. Academic sentences routinely exceed that, so every sentence
 *     is split into sub-utterances at clause boundaries and queued in order.
 *  2. An utterance running longer than ~15s can stop early. A pause()/resume()
 *     heartbeat keeps it alive.
 *  3. `boundary.charIndex` can point at the start of the NEXT word rather than
 *     the one being spoken. `lagWord` shifts the highlight back one event.
 *  4. `charLength` is often 0, and the macOS synthesiser has a history of
 *     out-of-range word ranges. Lengths are recovered by regex and every range
 *     is clamped to the utterance.
 *  5. Remote / network voices frequently emit no boundary events at all, and
 *     rate > 2 with such a voice can produce silence. Local voices are
 *     preferred and rate is clamped to a safe band.
 *  6. Voices that emit nothing at all fall back to an estimated reading cadence
 *     so the highlight still tracks, re-synced at every sub-utterance.
 *  7. getVoices() is empty until the engine loads; resolved via `voiceschanged`
 *     with a timeout, because some builds never fire it.
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  var synth = root.speechSynthesis;
  var heartbeat = null;
  var token = 0;               // bumped by cancel(); guards stale callbacks
  var cadence = null;          // estimated-cadence interval
  var cadenceStarter = null;   // the timer that would START one
  var cadenceState = null;     // enough to resume an estimated cadence

  var RATE_MIN = 0.5, RATE_MAX = 2.0;   // above 2.0 remote voices go silent

  /* ------------------------------------------------------------------ *
   * Voices
   * ------------------------------------------------------------------ */

  var voicesPromise = null;

  function getVoices() {
    if (!synth) return Promise.resolve([]);
    if (voicesPromise) return voicesPromise;
    voicesPromise = new Promise(function (resolve) {
      var list = synth.getVoices();
      if (list && list.length) return resolve(list);
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        resolve(synth.getVoices() || []);
      }
      try { synth.addEventListener('voiceschanged', finish, { once: true }); } catch (e) { /* noop */ }
      setTimeout(finish, 2000);
    });
    return voicesPromise;
  }

  function baseLang(tag) { return String(tag || '').toLowerCase().split(/[-_]/)[0]; }

  /**
   * Pick a voice. A pinned voiceURI always wins. Otherwise: best language
   * match, preferring on-device voices, which start instantly, work offline,
   * and are the only ones that reliably emit word-boundary events.
   */
  function pickVoice(voices, voiceURI, langTag, localOnly) {
    if (voiceURI) {
      var pinned = voices.filter(function (v) { return v.voiceURI === voiceURI; })[0];
      if (pinned) return pinned;
    }
    if (!langTag) return null;
    var want = String(langTag).toLowerCase();
    var exact = voices.filter(function (v) { return String(v.lang).toLowerCase() === want; });
    var loose = voices.filter(function (v) { return baseLang(v.lang) === baseLang(want); });
    var pool = exact.length ? exact : loose;
    if (!pool.length) return null;

    var local = pool.filter(function (v) { return v.localService; });
    if (localOnly && local.length) pool = local;
    else if (local.length) pool = local;

    var dflt = pool.filter(function (v) { return v.default; });
    return dflt[0] || pool[0];
  }

  /* ------------------------------------------------------------------ *
   * Splitting a sentence into speakable sub-utterances (quirk 1)
   * ------------------------------------------------------------------ */

  function splitForSpeech(text, maxChars) {
    maxChars = Math.max(60, maxChars || 200);
    if (text.length <= maxChars) return [{ start: 0, end: text.length }];

    var coarse = (FR.segmenter && FR.segmenter.chunk)
      ? FR.segmenter.chunk(text, maxChars, 40).map(function (c) { return { start: c.start, end: c.end }; })
      : [{ start: 0, end: text.length }];

    var out = [];
    coarse.forEach(function (part) {
      var s = part.start;
      while (s < part.end) {
        var e = Math.min(part.end, s + maxChars);
        if (e < part.end) {
          // never cut mid-word
          var sp = text.lastIndexOf(' ', e);
          if (sp > s + 20) e = sp + 1;
        }
        out.push({ start: s, end: e });
        s = e;
      }
    });
    return out.filter(function (r) { return text.slice(r.start, r.end).trim().length > 0; });
  }

  /* ------------------------------------------------------------------ *
   * Heartbeat (quirk 2)
   * ------------------------------------------------------------------ */

  function startHeartbeat() {
    stopHeartbeat();
    heartbeat = setInterval(function () {
      if (!synth || !synth.speaking) return stopHeartbeat();
      if (synth.paused) return;                 // a real user pause; leave it
      try { synth.pause(); synth.resume(); } catch (e) { /* noop */ }
    }, 9000);
  }
  function stopHeartbeat() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }

  /* ------------------------------------------------------------------ *
   * Estimated cadence (quirk 6)
   * ------------------------------------------------------------------ */

  var WORD_SCAN = /[\w\u00C0-\u024F\u2019'-]+/g;

  function wordStarts(text) {
    WORD_SCAN.lastIndex = 0;
    var out = [], m;
    while ((m = WORD_SCAN.exec(text)) !== null) out.push({ at: m.index, len: m[0].length });
    return out;
  }

  function stopCadence() {
    if (cadence) { clearInterval(cadence); cadence = null; }
    // The pending starter matters as much as the interval: a 550ms timer that
    // outlives its utterance will paint estimated boundaries onto whatever is
    // speaking next.
    if (cadenceStarter) { clearTimeout(cadenceStarter); cadenceStarter = null; }
    // And the state must go too. `token` does not change between the pieces of
    // one sentence, so leaving it behind let resume() revive the cadence of a
    // chunk that had already finished - marching the highlight backwards
    // through the first half of the sentence while the second half was spoken.
    cadenceState = null;
  }

  // ~180 wpm at rate 1.0 is a typical synthesiser pace.
  function startCadence(text, base, rate, mine, emit, fromWord) {
    stopCadence();
    var words = wordStarts(text);
    if (!words.length) return;
    var msPerWord = Math.max(90, 60000 / (180 * Math.max(0.1, rate)));
    var i = fromWord || 0;
    cadenceState = { text: text, base: base, rate: rate, mine: mine, emit: emit, i: i };
    cadence = setInterval(function () {
      if (mine !== token || i >= words.length) { cadenceState = null; return stopCadence(); }
      emit({ charIndex: base + words[i].at, charLength: words[i].len, estimated: true });
      i++;
      cadenceState.i = i;
    }, msPerWord);
  }

  /* ------------------------------------------------------------------ *
   * Speaking
   * ------------------------------------------------------------------ */

  function clamp(v, lo, hi, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  // Chrome often reports charLength 0; recover the word extent from the text.
  function wordLengthAt(text, index) {
    var m = /^[\w\u00C0-\u024F\u2019'-]+/.exec(text.slice(index));
    return m ? m[0].length : 1;
  }

  /**
   * Speak `text`, reporting boundaries as absolute offsets into `text`.
   *
   * @param {string} text
   * @param {object} opts voiceURI, rate, pitch, volume, lang, maxChars,
   *   localOnly, lagWord, onstart, onboundary, onend, onerror
   * @returns {Promise<void>} resolves when speech ends or is superseded
   */
  function speak(text, opts) {
    opts = opts || {};
    if (!synth) {
      if (opts.onerror) opts.onerror({ error: 'unsupported' });
      return Promise.reject(new Error('speechSynthesis is unavailable in this browser'));
    }
    var full = String(text == null ? '' : text).trim();
    if (!full) { if (opts.onend) opts.onend({ empty: true }); return Promise.resolve(); }

    var mine = ++token;
    stopHeartbeat();
    stopCadence();
    try { synth.cancel(); } catch (e) { /* noop */ }

    var rate = clamp(opts.rate, RATE_MIN, RATE_MAX, 1);

    return getVoices().then(function (voices) {
      return new Promise(function (resolve, reject) {
        // A beat after cancel(): speak() immediately after it can be dropped.
        setTimeout(function () {
          if (mine !== token) return resolve();

          var voice = pickVoice(voices, opts.voiceURI, opts.lang, opts.localOnly !== false);
          var pieces = splitForSpeech(full, opts.maxChars);
          var lastBoundary = null;      // for lagWord (quirk 3)
          var sawBoundary = false;
          var started = false;
          var finished = 0;

          function emit(b) {
            if (mine !== token || !opts.onboundary) return;
            // Clamp: macOS has a history of out-of-range word ranges.
            var ci = Math.max(0, Math.min(full.length - 1, b.charIndex | 0));
            var len = Math.max(1, Math.min(full.length - ci, b.charLength | 0));
            opts.onboundary({ charIndex: ci, charLength: len, estimated: !!b.estimated });
          }

          pieces.every(function (piece, pi) {
            var chunk = full.slice(piece.start, piece.end);
            var u = new root.SpeechSynthesisUtterance(chunk);
            if (voice) { u.voice = voice; u.lang = voice.lang; }
            else if (opts.lang) { u.lang = opts.lang; }
            u.rate = rate;
            u.pitch = clamp(opts.pitch, 0.1, 2, 1);
            u.volume = clamp(opts.volume, 0, 1, 1);

            u.onstart = function () {
              if (mine !== token) return;
              if (!started) {
                started = true;
                startHeartbeat();
                if (opts.onstart) opts.onstart({ text: full, voice: voice ? voice.name : null });
              }
              // If this voice never reports boundaries, drive the highlight
              // from an estimated cadence instead - re-synced per piece, so
              // drift cannot accumulate across a long sentence.
              stopCadence();
              if (!sawBoundary) {
                // Record the pending cadence as we arm it, so a pause landing
                // inside the 550ms window can still be resumed - for THIS
                // piece, from its start.
                cadenceState = { text: chunk, base: piece.start, rate: rate, mine: mine, emit: emit, i: 0 };
                cadenceStarter = setTimeout(function () {
                  cadenceStarter = null;
                  if (mine === token && !sawBoundary) {
                    startCadence(chunk, piece.start, rate, mine, emit);
                  }
                }, 550);
              }
            };

            u.onboundary = function (e) {
              if (mine !== token) return;
              if (e.name && e.name !== 'word') return;
              sawBoundary = true;
              stopCadence();

              var ci = piece.start + (typeof e.charIndex === 'number' ? e.charIndex : 0);
              var len = (typeof e.charLength === 'number' && e.charLength > 0)
                ? e.charLength
                : wordLengthAt(full, ci);

              if (opts.lagWord) {
                // charIndex named the NEXT word: paint the previous one.
                if (lastBoundary) emit(lastBoundary);
                lastBoundary = { charIndex: ci, charLength: len };
              } else {
                emit({ charIndex: ci, charLength: len });
              }
            };

            u.onend = function () {
              if (mine !== token) return resolve();
              finished++;
              if (finished < pieces.length) return;
              stopHeartbeat();
              stopCadence();
              if (opts.lagWord && lastBoundary) emit(lastBoundary);
              if (opts.onend) opts.onend({ text: full });
              resolve();
            };

            u.onerror = function (e) {
              var err = (e && e.error) || 'unknown';
              if (mine !== token) return resolve();
              // Our own cancel() lands here; that is not a failure.
              if (err === 'interrupted' || err === 'canceled') return resolve();

              // Every piece of this sentence was queued up front, so the rest
              // are still sitting in the browser's queue and will happily keep
              // speaking. Invalidate them, then flush the queue: without the
              // token bump their boundary events would carry on repainting the
              // karaoke highlight for a sentence the UI has already reported as
              // stopped, and onend could never fire because the failed piece
              // never increments `finished`.
              token++;
              stopHeartbeat();
              stopCadence();
              try { synth.cancel(); } catch (e2) { /* noop */ }

              if (opts.onerror) opts.onerror({ error: err });
              reject(new Error('Speech failed: ' + err));
            };

            try {
              synth.speak(u);         // the browser queues these in order
            } catch (err) {
              // Swallowing this for pi > 0 would strand the sentence: the piece
              // fires neither end nor error, so `finished` never reaches
              // pieces.length and onend is lost with no error reported at all.
              token++;
              stopHeartbeat();
              stopCadence();
              try { synth.cancel(); } catch (e2) { /* noop */ }
              if (opts.onerror) opts.onerror({ error: String(err) });
              reject(err);
              return false;           // stop queuing the remaining pieces
            }
            return true;
          });
        }, 30);
      });
    });
  }

  function cancel() {
    token++;
    stopHeartbeat();
    stopCadence();
    if (!synth) return;
    try { synth.cancel(); } catch (e) { /* noop */ }
  }

  function pause() {
    if (!synth) return false;
    try {
      // stopCadence() clears cadenceState; keep a snapshot so resume() can pick
      // the highlight back up where it left off.
      var snap = (cadence || cadenceStarter) ? cadenceState : null;
      synth.pause();
      stopHeartbeat();
      stopCadence();
      cadenceState = snap;
      return true;
    } catch (e) { return false; }
  }

  function resume() {
    if (!synth) return false;
    try {
      synth.resume();
      startHeartbeat();
      // A voice that emits no boundary events was being tracked by the
      // estimated cadence; pause() stopped it, so without this the word
      // highlight stays frozen for the rest of the sentence.
      if (cadenceState && cadenceState.mine === token) {
        var c = cadenceState;
        startCadence(c.text, c.base, c.rate, c.mine, c.emit, c.i);
      }
      return true;
    } catch (e) { return false; }
  }

  function state() {
    if (!synth) return 'unsupported';
    if (synth.paused && synth.speaking) return 'paused';
    if (synth.speaking || synth.pending) return 'speaking';
    return 'idle';
  }

  // A tab torn down mid-utterance can wedge the engine for the whole browser.
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('pagehide', cancel);
    root.addEventListener('beforeunload', cancel);
  }

  FR.speech = {
    speak: speak,
    cancel: cancel,
    pause: pause,
    resume: resume,
    state: state,
    getVoices: getVoices,
    pickVoice: pickVoice,
    splitForSpeech: splitForSpeech,
    supported: !!synth,
    RATE_MIN: RATE_MIN,
    RATE_MAX: RATE_MAX
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
