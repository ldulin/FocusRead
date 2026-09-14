/*
 * FocusRead on the open web.
 *
 * The reader is the only part of this extension that can work without one:
 * it already opens a file you hand it and does everything in the page. What it
 * cannot do is read OTHER web pages - that needs a content script, and mobile
 * browsers have no extensions at all.
 *
 * So this file stands in for the handful of chrome.* APIs the shared code
 * touches, which lets the web build run the SAME reader, settings page,
 * engine, speech and translation code as the extension rather than a fork of
 * it. Loaded before everything else.
 */
(function (g) {
  'use strict';

  var FR = (g.FR = g.FR || {});
  FR.isWeb = true;

  // No MV3 remote-code restriction on a website, so the libraries come from a
  // CDN instead of a vendored folder. Keeps the repository free of a few
  // megabytes of third-party build output.
  var PDFJS_VERSION = '6.3.289';
  var MAMMOTH_VERSION = '1.12.3';
  var PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VERSION + '/';
  FR.vendorBase = {
    // The npm layout, which is not the flat vendored one: the module and worker
    // live under build/, the data folders sit beside it.
    pdfjsPaths: {
      module: PDFJS + 'build/pdf.min.mjs',
      worker: PDFJS + 'build/pdf.worker.min.mjs',
      cmaps: PDFJS + 'cmaps/',
      standardFonts: PDFJS + 'standard_fonts/',
      wasm: PDFJS + 'wasm/'
    },
    mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@' + MAMMOTH_VERSION + '/mammoth.browser.min.js'
  };

  /* ------------------------------------------------------------------ *
   * storage.local -> localStorage
   *
   * Same callback shape, and asynchronous like the real thing, so the shared
   * settings module cannot come to depend on synchronous behaviour here.
   * ------------------------------------------------------------------ */

  var PREFIX = 'focusread:';
  var listeners = [];

  function readKey(k) {
    try {
      var raw = localStorage.getItem(PREFIX + k);
      return raw === null ? undefined : JSON.parse(raw);
    } catch (e) {
      return undefined;                 // private mode, or corrupt value
    }
  }

  function writeKey(k, v) {
    try {
      localStorage.setItem(PREFIX + k, JSON.stringify(v));
      return true;
    } catch (e) {
      // Quota, or Safari private browsing. The reader still works; only
      // persistence is lost, so say so once rather than failing.
      if (!writeKey._warned) {
        writeKey._warned = true;
        console.warn('[FocusRead] settings cannot be saved in this browser (storage is unavailable)');
      }
      return false;
    }
  }

  function notify(changes) {
    listeners.forEach(function (fn) {
      try { fn(changes, 'local'); } catch (e) { /* a bad listener must not break the rest */ }
    });
  }

  var local = {
    get: function (keys, cb) {
      var out = {};
      if (typeof keys === 'string') out[keys] = readKey(keys);
      else if (Array.isArray(keys)) keys.forEach(function (k) { out[k] = readKey(k); });
      else if (keys && typeof keys === 'object') {
        Object.keys(keys).forEach(function (k) {
          var v = readKey(k);
          out[k] = v === undefined ? keys[k] : v;
        });
      }
      setTimeout(function () { cb(out); }, 0);
    },
    set: function (obj, cb) {
      var changes = {};
      Object.keys(obj).forEach(function (k) {
        changes[k] = { oldValue: readKey(k), newValue: obj[k] };
        writeKey(k, obj[k]);
      });
      setTimeout(function () {
        notify(changes);
        if (cb) cb();
      }, 0);
    },
    remove: function (keys, cb) {
      var changes = {};
      [].concat(keys).forEach(function (k) {
        changes[k] = { oldValue: readKey(k), newValue: undefined };
        try { localStorage.removeItem(PREFIX + k); } catch (e) { /* noop */ }
      });
      setTimeout(function () {
        notify(changes);
        if (cb) cb();
      }, 0);
    }
  };

  /* ------------------------------------------------------------------ *
   * runtime
   * ------------------------------------------------------------------ */

  function handleMessage(msg, cb) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      /*
       * In the extension this is relayed to the service worker, which has host
       * permissions and is exempt from the page's CORS rules. Here there is no
       * worker: the fetch happens in the page and therefore needs the provider
       * to send permissive CORS headers. MyMemory and the keyless Google
       * endpoint both do; a self-hosted LibreTranslate needs configuring for
       * it, and the settings page says so.
       */
      case 'FR_TRANSLATE':
        FR.translate.translateBatch(msg.texts || [], msg.opts || {}).then(
          function (results) { cb({ results: results }); },
          function (e) {
            cb({
              results: (msg.texts || []).map(function () {
                return { ok: false, code: 'error', error: String((e && e.message) || e) };
              })
            });
          }
        );
        return;

      case 'FR_OPEN_OPTIONS':
        g.location.href = 'settings.html';
        return;

      case 'FR_OPEN_READER':
        g.location.href = 'index.html';
        return;

      default:
        if (cb) cb({ error: 'unsupported-on-web' });
    }
  }

  g.chrome = {
    runtime: {
      lastError: null,
      id: 'focusread-web',
      getURL: function (p) { return String(p).replace(/^\/+/, ''); },
      getManifest: function () { return { host_permissions: [] }; },
      sendMessage: function (msg, cb) {
        handleMessage(msg, typeof cb === 'function' ? cb : function () {});
      },
      openOptionsPage: function () { g.location.href = 'settings.html'; },
      onMessage: { addListener: function () {}, removeListener: function () {} },
      onInstalled: { addListener: function () {} },
      onStartup: { addListener: function () {} }
    },
    storage: {
      local: local,
      onChanged: {
        addListener: function (fn) { listeners.push(fn); },
        removeListener: function (fn) {
          var i = listeners.indexOf(fn);
          if (i !== -1) listeners.splice(i, 1);
        }
      }
    },
    // Present so feature checks resolve, and uniformly negative: none of these
    // capabilities exist on the web.
    permissions: {
      request: function (_, cb) { if (cb) cb(false); },
      contains: function (_, cb) { if (cb) cb(false); },
      getAll: function (cb) { if (cb) cb({ origins: [], permissions: [] }); },
      onAdded: { addListener: function () {} },
      onRemoved: { addListener: function () {} }
    },
    extension: {
      isAllowedFileSchemeAccess: function (cb) { if (cb) cb(false); }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
