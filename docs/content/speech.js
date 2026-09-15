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
 *  8. The browser speaks QUEUED utterances strictly one at a time and only
 *     asks the engine for the next one once the current one has ended. For a
 *     network voice - Microsoft's "Online (Natural)" voices, Google's - that
 *     means the round trip to the synthesis server happens in the silence
 *     between utterances, so reading one sentence per utterance puts an
 *     audible hole at every sentence boundary and breaks the prosody across
 *     it. Queueing further ahead cannot help; only asking for fewer, longer
 *     utterances can. `speakRun` therefore speaks a whole run of sentences as
 *     ONE utterance and uses the voice's word boundaries to work out which
 *     sentence is being spoken. See `speakRun` for how a voice that truncates
 *     long utterances is detected and backed away from.
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
  var boundarySeen = {};       // voiceURI -> does this voice report words?

  var RATE_MIN = 0.5, RATE_MAX = 2.0;   // above 2.0 remote voices go silent

  /* ------------------------------------------------------------------ *
   * Voices
   * ------------------------------------------------------------------ */

  var voicesPromise = null;

  /** The voices the engine has RIGHT NOW, without waiting. */
  function voicesNow() {
    if (!synth) return [];
    try { return synth.getVoices() || []; } catch (e) { return []; }
  }

  /*
   * Never cache the list for good.
   *
   * Edge registers its "Online (Natural)" voices after the local ones, so the
   * first call comes back with a non-empty list that is missing precisely the
   * voices someone is most likely to have chosen - and it never fires again
   * for a listener that asked for one shot. Every later decision is then made
   * about the wrong voice: which voice is speaking, and whether it is the kind
   * that needs a paragraph read in one breath.
   */
  function getVoices() {
    if (!synth) return Promise.resolve([]);
    var now = voicesNow();
    if (now.length) return Promise.resolve(now);
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

  /* ------------------------------------------------------------------ *
   * Voice curation
   *
   * macOS exposes ~180 voices to the web, and the en-US list is mostly
   * unusable for reading a paper: joke voices that sing or buzz ("Bells",
   * "Boing", "Zarvox", "Bubbles"), and the 1990s-era voices that sound
   * robotic ("Fred", "Ralph", "Albert"). Chrome's own default is often one of
   * the flat network voices. Left unfiltered, the picker is a wall of noise
   * and whatever the reader lands on tends to sound synthetic.
   * ------------------------------------------------------------------ */

  // Sound effects, not narrators: these sing, buzz or whisper and cannot read
  // a paper. The only tier never offered.
  var NOVELTY = [
    'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos',
    'deranged', 'good news', 'hysterical', 'jester', 'organ', 'pipe organ',
    'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox'
  ];

  // Apple's character voices. Stylised - Grandma and Grandpa sound elderly,
  // Rocko and Flo are cartoonish - but they are real, intelligible voices, so
  // they are offered, after the plainer ones. These were in the novelty list
  // at first, which cut the American English list from 28 entries to 5 and
  // left almost nothing to choose between.
  var STYLISED = ['eddy', 'flo', 'grandma', 'grandpa', 'reed', 'rocko', 'sandy', 'shelley'];

  // The old low-quality generation. Real, and sometimes all that is installed,
  // but robotic. Offered last.
  var LEGACY = ['fred', 'junior', 'kathy', 'ralph', 'agnes', 'vicki', 'victoria', 'princess', 'bruce'];

  // The natural-sounding ones, best first. Most are optional downloads on
  // macOS; iOS and Android usually ship better defaults than desktop Chrome.
  var PREFERRED = [
    'ava', 'allison', 'samantha', 'susan', 'zoe', 'joelle', 'nicky',
    'tom', 'aaron', 'evan', 'nathan', 'noelle', 'alex', 'siri'
  ];

  function bareName(v) {
    // "Eddy (English (United States))" -> "eddy"
    return String(v.name || '').replace(/\s*\(.*$/, '').trim().toLowerCase();
  }

  /**
   * Which group a voice belongs in. Doubles as its sort order.
   * @returns {'natural'|'plain'|'stylised'|'network'|'basic'}
   */
  function voiceTier(v) {
    var n = bareName(v);
    if (PREFERRED.indexOf(n) !== -1) return 'natural';
    if (LEGACY.indexOf(n) !== -1) return 'basic';
    if (STYLISED.indexOf(n) !== -1) return 'stylised';
    if (!v.localService) return 'network';
    return 'plain';
  }

  var TIER_ORDER = { natural: 0, plain: 1000, stylised: 2000, network: 3000, basic: 4000 };

  var TIER_LABEL = {
    natural: 'Clearest',
    plain: 'Other installed voices',
    stylised: 'Character voices',
    network: 'Network voices (need a connection)',
    basic: 'Basic voices (robotic)'
  };

  function voiceRank(v) {
    var tier = voiceTier(v);
    if (tier === 'natural') return PREFERRED.indexOf(bareName(v));   // 0..13
    return TIER_ORDER[tier];
  }

  /**
   * @param {Array} voices
   * @param {'en-US'|'english'|'all'} filter
   * @returns {Array} ranked, with the unusable ones removed
   */
  function curateVoices(voices, filter) {
    var list = (voices || []).filter(function (v) {
      if (NOVELTY.indexOf(bareName(v)) !== -1) return false;
      if (filter === 'all') return true;
      var lang = String(v.lang || '').toLowerCase();
      if (filter === 'english') return lang.indexOf('en') === 0;
      return lang === 'en-us' || lang === 'en_us';
    });

    // If a strict filter leaves nothing, widen rather than show an empty list.
    if (!list.length && filter === 'en-US') return curateVoices(voices, 'english');
    if (!list.length && filter === 'english') return curateVoices(voices, 'all');

    return list.sort(function (a, b) {
      var d = voiceRank(a) - voiceRank(b);
      if (d) return d;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  /**
   * The curated list split into labelled groups, so offering more voices does
   * not just mean a longer undifferentiated list.
   * @returns {Array<{label:string, tier:string, voices:Array}>}
   */
  function voiceGroups(voices, filter) {
    var list = curateVoices(voices, filter);
    var order = ['natural', 'plain', 'stylised', 'network', 'basic'];
    var buckets = {};
    list.forEach(function (v) {
      var t = voiceTier(v);
      (buckets[t] = buckets[t] || []).push(v);
    });
    return order.filter(function (t) { return buckets[t] && buckets[t].length; })
      .map(function (t) { return { label: TIER_LABEL[t], tier: t, voices: buckets[t] }; });
  }

  /** True when nothing better than the old robotic voices is installed. */
  function onlyLegacyVoices(voices, filter) {
    var list = curateVoices(voices, filter || 'en-US');
    if (!list.length) return true;
    return list.every(function (v) { return voiceRank(v) >= 500; });
  }


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
    if (local.length) pool = local;

    // Rank rather than take the browser default: on macOS the default for
    // en-US is frequently one of the flat legacy voices.
    var ranked = pool.slice().sort(function (a, b) { return voiceRank(a) - voiceRank(b); });
    var usable = ranked.filter(function (v) { return NOVELTY.indexOf(bareName(v)) === -1; });
    return usable[0] || ranked[0] || pool[0];
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
          var vkey = voice ? String(voice.voiceURI || voice.name) : '';
          var pieces = splitForSpeech(full, opts.maxChars);
          var lastBoundary = null;      // for lagWord (quirk 3)
          var sawBoundary = false;
          var started = false;
          var finished = 0;

          function emit(b) {
            if (mine !== token || !opts.onboundary) return;
            // Clamp: macOS has a history of out-of-range word ranges.
            var raw = b.charIndex | 0;
            var ci = Math.max(0, Math.min(full.length - 1, raw));
            var len = Math.max(1, Math.min(full.length - ci, b.charLength | 0));
            // Say so when it had to be clamped. Within one sentence the
            // clamped offset is harmless, but a merged run spans several and
            // the clamp always lands in the LAST of them - which a caller
            // tracking sentences has to be able to disbelieve.
            opts.onboundary({
              charIndex: ci, charLength: len,
              estimated: !!b.estimated, clamped: raw !== ci
            });
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
              if (vkey) boundarySeen[vkey] = true;
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
              // Remember whether this voice reports words, but only judge it on
              // an utterance long enough to have contained several: a two-word
              // heading proves nothing either way.
              if (vkey && full.length >= 40 && boundarySeen[vkey] !== true) {
                boundarySeen[vkey] = !!sawBoundary;
              }
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

  /* ------------------------------------------------------------------ *
   * Gapless runs (quirk 8)
   * ------------------------------------------------------------------ */

  var RUN_CHARS = 700;          // most text handed to a single utterance
  var RUN_SENTENCES = 6;
  var RUN_MIN_CHARS = 260;      // a run shorter than this is not worth it
  var MAX_WORD_JUMP = 160;      // chars one word boundary may plausibly skip
  var EARLY_END = 0.5;          // of the estimated duration: below this it was cut
  var WPM = 180;                // a typical synthesiser pace at rate 1.0

  /** Roughly how long `text` should take to say, in ms. */
  function estimateSpeechMs(text, rate) {
    var words = (String(text == null ? '' : text).match(/\S+/g) || []).length;
    return words * Math.max(90, 60000 / (WPM * Math.max(0.1, rate)));
  }

  /**
   * Where the unspoken tail of a run starts, or -1 if every sentence in it was
   * reached.
   *
   * Only a TRAILING gap means the voice stopped: an engine that is simply
   * stingy with word events leaves holes in the middle, and re-reading a
   * paragraph over that would be a worse noise than the gap being removed.
   *
   * @param {number} count how many sentences the run has
   * @param {Array<boolean>} spoken which of them a word landed in
   */
  function unspokenTail(count, spoken) {
    var k = count;
    while (k > 0 && !(spoken || [])[k - 1]) k--;
    return k < count ? k : -1;
  }

  /**
   * Whether a voice reports which word it is speaking, learned by listening.
   * @returns {boolean|undefined} undefined until it has spoken something long
   *   enough for the answer to mean anything.
   */
  function emitsBoundaries(voiceURI) {
    var k = String(voiceURI || '');
    if (!k || !(k in boundarySeen)) return undefined;
    return boundarySeen[k];
  }

  /**
   * Is this voice synthesised on a server?
   *
   * `localService` is the proper answer, but the name is worth reading too:
   * whether a browser sets the flag correctly for its own hosted voices is not
   * something this code can verify on every build, and getting it wrong here
   * would silently withhold the fix from exactly the voices that need it.
   * Guessing wrong the other way merely merges a voice that did not need it.
   */
  function isNetworkVoice(v) {
    if (!v) return false;
    if (v.localService === false) return true;
    // "Microsoft Andrew Online (Natural)", "Google US English".
    return /\b(online|natural)\b/i.test(String(v.name || ''));
  }

  /**
   * Which consecutive sentences may be spoken as one utterance.
   *
   * A run never crosses a paragraph: the pause at a paragraph break is one a
   * reader wants, and it also keeps a run from growing without limit. Pure, so
   * the policy is testable without a speech engine.
   *
   * @param {Array<{text:string, blockEl:*}>} recs engine sentence records
   * @param {number} index first sentence of the run
   * @param {{budget?:number, maxSentences?:number}} opts
   * @returns {Array<{i:number, text:string}>} always at least the sentence at
   *   `index`, so a caller can speak the result unconditionally
   */
  function planRun(recs, index, opts) {
    opts = opts || {};
    var budget = Math.max(1, opts.budget || RUN_CHARS);
    var most = Math.max(1, opts.maxSentences || RUN_SENTENCES);
    var first = recs && recs[index];
    if (!first) return [];

    var out = [{ i: index, text: String(first.text == null ? '' : first.text) }];
    var chars = out[0].text.length;
    for (var k = index + 1; k < recs.length && out.length < most; k++) {
      var r = recs[k];
      if (!r || r.blockEl !== first.blockEl) break;
      var t = String(r.text == null ? '' : r.text);
      // Stop rather than skip: a run has to stay contiguous, or the sentence
      // in the hole would never be spoken at all.
      if (!t.trim()) break;
      if (chars + 1 + t.length > budget) break;
      out.push({ i: k, text: t });
      chars += 1 + t.length;
    }
    return out;
  }

  /** The run as one string, with each sentence's offsets inside it. */
  function runSpans(run) {
    var spans = [], text = '';
    (run || []).forEach(function (seg) {
      var t = String(seg.text == null ? '' : seg.text).trim();
      if (!t) return;
      if (text) text += ' ';
      var start = text.length;
      text += t;
      spans.push({ i: seg.i, start: start, end: text.length });
    });
    return { text: text, spans: spans };
  }

  /**
   * The sentence an absolute offset falls in. The space joining two sentences
   * belongs to the one that FOLLOWS it: a boundary event fires just before the
   * word it names, so an offset there means the next sentence is starting.
   */
  function spanAt(spans, ci) {
    for (var k = 0; k < spans.length; k++) {
      if (ci < spans[k].end) return spans[k];
    }
    return spans.length ? spans[spans.length - 1] : null;
  }

  /**
   * Speak several consecutive sentences as ONE utterance, so a network voice
   * makes one request and streams through them without a hole at every
   * sentence boundary (quirk 8). Which sentence is being spoken comes from the
   * word boundaries, translated back into per-sentence offsets.
   *
   * @param {Array<{i:number, text:string}>} run from planRun
   * @param {object} opts as `speak`, plus:
   *   onsentence(i)            the run has moved into sentence `i`
   *   onboundary(i, b)         word boundary, offsets relative to sentence `i`
   *   onend({index, spoken})   the whole run finished
   *   ontruncated({index, reached, early})  the voice stopped early - it will
   *     not take an utterance this long, and the caller should shorten the run
   *     and carry on from `index`, the first sentence that was not finished.
   * @returns {Promise<void>}
   */
  function speakRun(run, opts) {
    opts = opts || {};
    var joined = runSpans(run);
    var spans = joined.spans;
    if (!spans.length) {
      if (opts.onend) opts.onend({ index: -1, spoken: 0 });
      return Promise.resolve();
    }

    var cur = null, lastCi = -1, lastEnd = 0, real = false, startedAt = 0;
    var spoken = [];                 // did a word land in each sentence?
    var rate = clamp(opts.rate, RATE_MIN, RATE_MAX, 1);

    function report(b) {
      var ci = b.charIndex, len = b.charLength;
      // Quirk 4: an out-of-range offset is clamped to the utterance's last
      // character - which in a merged run belongs to a different SENTENCE.
      // Believing one would pin the reader on the run's last sentence for the
      // rest of the run, because the tracker only moves forwards, and would
      // mark that sentence spoken and so hide a real truncation.
      if (b.clamped) return;
      // The same damage from an offset that is merely wrong rather than out of
      // range. No single word boundary skips this far ahead.
      if (lastCi >= 0 && ci > lastCi + MAX_WORD_JUMP) return;

      var sp = spanAt(spans, ci);
      if (!sp) return;
      lastCi = Math.max(lastCi, ci);
      lastEnd = Math.max(lastEnd, ci + len);
      if (!b.estimated) real = true;

      // Only ever forwards: an engine that reports an odd early offset must
      // not drag the reader back to a sentence already spoken.
      if (!cur || sp.start > cur.start) {
        cur = sp;
        if (opts.onsentence) opts.onsentence(sp.i);
      }
      spoken[spans.indexOf(cur)] = true;

      if (!opts.onboundary) return;
      var rel = Math.max(0, ci - cur.start);
      var room = Math.max(1, (cur.end - cur.start) - rel);
      opts.onboundary(cur.i, {
        charIndex: rel,
        charLength: Math.max(1, Math.min(room, len)),
        estimated: !!b.estimated
      });
    }

    /** How far short of this sentence's end the words stopped. */
    function shortOf(sp) { return sp.end - lastEnd; }

    return speak(joined.text, {
      voiceURI: opts.voiceURI,
      rate: opts.rate,
      pitch: opts.pitch,
      volume: opts.volume,
      lang: opts.lang,
      localOnly: opts.localOnly,
      lagWord: opts.lagWord,
      // The whole point: one utterance, so one request and one audio stream.
      maxChars: joined.text.length + 1,
      onstart: function (e) {
        startedAt = Date.now();
        cur = spans[0];
        if (opts.onsentence) opts.onsentence(spans[0].i);
        if (opts.onstart) opts.onstart(e);
      },
      onboundary: function (b) {
        report(b);
      },
      onend: function () {
        // A voice that will not take an utterance this long (quirks 1 and 2)
        // ends NORMALLY, just early. Reporting that as a finished run is the
        // expensive mistake: the caller marks every sentence in it read and
        // moves on to the next paragraph, so the reader silently loses most of
        // the page. Two witnesses, because neither covers the other's ground.
        var last = spans[spans.length - 1];
        var reached = joined.text.length ? lastEnd / joined.text.length : 1;
        var stopAt = -1;

        if (real) {
          // The words say exactly how far it got. A trailing stretch of
          // sentences that no word landed in was never spoken - which catches
          // a cut at any sentence boundary, where measuring a FRACTION of the
          // run is blind to one that falls in the last fifth. A gap in the
          // middle is not a cut: that is a voice being stingy with word
          // events, and re-reading the paragraph over it would be worse than
          // the silence being removed.
          var tail = unspokenTail(spans.length, spoken);
          if (tail >= 0) {
            stopAt = tail;
            // The sentence before the gap was probably cut part-way too - a
            // cut rarely lands exactly on a full stop - and carrying on after
            // it would lose the rest of it unread. One short word of slack,
            // because re-reading a sentence costs far less than losing the
            // end of one, and the run is already known to have been cut.
            if (tail > 0 && shortOf(spans[tail - 1]) > 5) stopAt = tail - 1;
          } else if (shortOf(last) > Math.max(12, (last.end - last.start) * 0.2)) {
            // Words in every sentence, but they stopped well inside the final
            // one. Here there is no other evidence of a cut, so it takes a
            // clear shortfall: some voices never report their last word, and
            // calling that a cut would re-read a sentence in every run.
            stopAt = spans.length - 1;
          }
        } else if (startedAt &&
                   (Date.now() - startedAt) < EARLY_END * estimateSpeechMs(joined.text, rate)) {
          // A voice that reports no words leaves only the clock, and nothing
          // says a paragraph in half the time it takes to read one. The clock
          // cannot say WHERE it stopped, so the run is read again from the
          // start; the budget halves every time this happens, so a voice that
          // truncates stops being handed runs at all within a few tries.
          stopAt = 0;
        }

        if (stopAt >= 0 && opts.ontruncated) {
          return opts.ontruncated({
            index: spans[stopAt].i,
            reached: reached,
            chars: lastEnd
          });
        }
        if (opts.onend) opts.onend({ index: last.i, spoken: spans.length });
      },
      onerror: opts.onerror
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
    speakRun: speakRun,
    planRun: planRun,
    runSpans: runSpans,
    spanAt: spanAt,
    emitsBoundaries: emitsBoundaries,
    isNetworkVoice: isNetworkVoice,
    unspokenTail: unspokenTail,
    estimateSpeechMs: estimateSpeechMs,
    cancel: cancel,
    pause: pause,
    resume: resume,
    state: state,
    getVoices: getVoices,
    voicesNow: voicesNow,
    pickVoice: pickVoice,
    curateVoices: curateVoices,
    voiceGroups: voiceGroups,
    voiceTier: voiceTier,
    onlyLegacyVoices: onlyLegacyVoices,
    splitForSpeech: splitForSpeech,
    supported: !!synth,
    RATE_MIN: RATE_MIN,
    RATE_MAX: RATE_MAX,
    RUN_CHARS: RUN_CHARS,
    RUN_MIN_CHARS: RUN_MIN_CHARS,
    RUN_SENTENCES: RUN_SENTENCES
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
