/*
 * FocusRead - settings schema, defaults and storage access.
 *
 * Everything lives in chrome.storage.local (not .sync) on purpose: provider API
 * keys never leave this machine, and there is no silent cross-device upload.
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  var DEFAULTS = {
    schemaVersion: 1,

    /* --- when the reader turns itself on --- */
    autoActivate: false,          // run on every page load
    autoActivateHosts: [],        // ...or only on these hostnames
    shortcutsEnabled: true,
    toolbarPos: null,             // {left, top} in px once the reader drags it

    /* --- speech --- */
    voiceURI: '',                 // '' = browser default for the page language
    rate: 1.0,                    // 0.5 - 2.5
    pitch: 1.0,
    volume: 1.0,
    autoAdvance: true,            // keep going to the next sentence
    highlightWords: true,         // karaoke-style word highlight while speaking
    wordHighlightLag: false,      // some voices report the NEXT word's index
    scrollFollow: true,           // keep the spoken sentence on screen
    readUnit: 'sentence',         // 'sentence' | 'clause'
    clauseMaxLen: 220,            // split sentences longer than this in clause mode
    pauseBetween: 0,              // ms of silence between sentences
    maxUtteranceChars: 200,       // Chrome truncates longer utterances
    localVoicesOnly: true,        // remote voices rarely emit word boundaries

    /* --- focus aids --- */
    focusMode: 'spotlight',       // 'off' | 'spotlight' | 'ruler'
    dimOpacity: 0.3,              // how faint the non-current text goes
    highlightStyle: 'underline',  // 'underline' | 'block' | 'box' | 'none'
    highlightColor: '#f5c518',
    wordHighlightColor: '#ff8a3d',
    boldHeads: false,             // bold the opening letters of each word
    boldHeadStrength: 0.4,        // 0 - 1, fraction of each word bolded
    typography: false,            // restyle the page for reading
    fontFamily: 'system',         // 'system'|'serif'|'sans'|'mono'|'dyslexic'
    fontScale: 1.0,               // 0.8 - 2.0
    lineHeight: 1.7,
    letterSpacing: 0,             // px
    wordSpacing: 0,               // px
    maxWidth: 0,                  // px; 0 = leave the page layout alone
    paperTint: 'none',            // 'none'|'sepia'|'gray'|'dark'

    /* --- translation --- */
    targetLang: 'zh-Hans',
    sourceLang: 'auto',
    provider: 'builtin',          // builtin|mymemory|libre|google|openai
    bilingual: false,             // show a translation under every sentence
    bilingualScale: 0.92,         // relative font size of the translation line
    translateOnSelect: true,      // popup when you select text
    translateCurrentKey: true,    // "T" translates the sentence being read
    speakTranslation: false,      // also read the translation aloud
    cacheTranslations: true,

    providerConfig: {
      mymemory: { email: '' },    // supplying an email raises the free quota
      libre: { url: '', key: '' },   // your own instance; public mirrors are unreliable
      google: { key: '' },
      openai: { url: 'https://api.openai.com/v1', key: '', model: 'gpt-4o-mini' }
    },

    /* --- document reader (PDF / DOCX) --- */
    pdfView: 'reflow',            // 'reflow' (clean text) | 'original' (page images)
    pdfInterceptLinks: false,     // open .pdf links in FocusRead instead of Chrome's viewer
    stripRunningHeads: true,      // drop repeated page headers/footers in reflow mode
    joinHyphens: true             // rejoin words split across line ends
  };

  // Offered in the target-language dropdown. Value is a BCP-47 tag.
  var LANGUAGES = [
    ['zh-Hans', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'],
    ['en', 'English'], ['ja', 'Japanese'], ['ko', 'Korean'], ['es', 'Spanish'],
    ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'],
    ['ru', 'Russian'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['bn', 'Bengali'],
    ['tr', 'Turkish'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['id', 'Indonesian'],
    ['nl', 'Dutch'], ['pl', 'Polish'], ['uk', 'Ukrainian'], ['fa', 'Persian'],
    ['he', 'Hebrew'], ['sv', 'Swedish'], ['el', 'Greek'], ['cs', 'Czech']
  ];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Shallow-merge stored values over defaults, one level deep for
  // providerConfig so a new provider gains its defaults on upgrade.
  function merge(stored) {
    var out = clone(DEFAULTS);
    if (!stored) return out;
    Object.keys(out).forEach(function (k) {
      if (k === 'providerConfig') return;
      if (stored[k] !== undefined && stored[k] !== null) out[k] = stored[k];
    });
    if (stored.providerConfig) {
      Object.keys(out.providerConfig).forEach(function (p) {
        if (stored.providerConfig[p]) {
          Object.assign(out.providerConfig[p], stored.providerConfig[p]);
        }
      });
    }
    return out;
  }

  var cached = null;

  function get() {
    if (cached) return Promise.resolve(cached);
    return new Promise(function (resolve) {
      chrome.storage.local.get('settings', function (r) {
        cached = merge(r && r.settings);
        resolve(cached);
      });
    });
  }

  /**
   * Write a partial update.
   *
   * providerConfig has to be merged a level deeper than everything else.
   * Object.assign is shallow, so a patch of {providerConfig:{google:{key}}} -
   * which is exactly what the options page builds for every dotted field -
   * would REPLACE the whole providerConfig object. merge() then rebuilds the
   * missing providers from DEFAULTS, quietly erasing every other provider's
   * API key. The options page does not re-read its inputs after a save, so the
   * erased keys stay on screen and the loss is invisible until translation
   * starts failing.
   */
  function set(patch) {
    return get().then(function (cur) {
      var incoming = Object.assign({}, cur, patch);

      if (patch.providerConfig) {
        incoming.providerConfig = Object.assign({}, cur.providerConfig);
        Object.keys(patch.providerConfig).forEach(function (p) {
          incoming.providerConfig[p] =
            Object.assign({}, cur.providerConfig[p], patch.providerConfig[p]);
        });
      }

      var next = merge(incoming);
      cached = next;
      return new Promise(function (resolve) {
        chrome.storage.local.set({ settings: next }, function () { resolve(next); });
      });
    });
  }

  function reset() {
    cached = null;
    return new Promise(function (resolve) {
      chrome.storage.local.remove('settings', function () { get().then(resolve); });
    });
  }

  // Invalidate the in-memory copy whenever any context writes settings.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.settings) {
        cached = merge(changes.settings.newValue);
        (FR.settings._listeners || []).forEach(function (fn) {
          try { fn(cached); } catch (e) { /* a bad listener must not break the rest */ }
        });
      }
    });
  }

  FR.settings = {
    DEFAULTS: DEFAULTS,
    LANGUAGES: LANGUAGES,
    get: get,
    set: set,
    reset: reset,
    peek: function () { return cached; },
    _listeners: [],
    onChange: function (fn) {
      FR.settings._listeners.push(fn);
      return fn;                       // hand back a handle for offChange
    },
    offChange: function (fn) {
      var i = FR.settings._listeners.indexOf(fn);
      if (i !== -1) FR.settings._listeners.splice(i, 1);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
