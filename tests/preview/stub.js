/*
 * A minimal chrome.* stand-in so the popup, options and reader pages can be
 * opened as plain files during development. Storage is in-memory; messages are
 * logged. Loaded only by tests/preview/build.py output, never by the extension.
 */
(function (g) {
  // Which situation the harness is standing in for. Set from the page's own
  // query string so a test can choose before any of the code under test runs:
  //   popup.html?tab=file:///x.pdf&fileAccess=0
  try {
    var q = new URLSearchParams(g.location.search);
    if (q.get('tab')) g.__tabUrl = q.get('tab');
    if (q.get('nativePdf')) g.__tabNativePdf = q.get('nativePdf') !== '0';
    g.__fileAccess = q.get('fileAccess') === '1';
  } catch (e) { /* not a browser with URLSearchParams; defaults apply */ }

  var store = { settings: undefined };
  var sessionStore = {};
  try {
    var sq = new URLSearchParams(g.location.search);
    if (sq.get('seedHandoff') && sq.get('handoff')) {
      sessionStore['handoff:' + sq.get('handoff')] = {
        url: sq.get('seedHandoff'),
        at: sq.get('stale') === '1' ? 0 : Date.now()
      };
    }
  } catch (e) { /* defaults apply */ }

  g.chrome = {
    runtime: {
      lastError: null,
      id: 'preview',
      getURL: function (p) { return '../../' + String(p).replace(/^\//, ''); },
      sendMessage: function (msg, cb) {
        console.log('[preview] sendMessage', msg && msg.type);
        if (typeof cb !== 'function') return;
        setTimeout(function () {
          if (msg && msg.type === 'FR_STATUS_ACTIVE_TAB') {
            // __tabUrl lets a test put the popup on a PDF tab, which is the
            // case the popup has to offer something useful for.
            return cb({
              url: g.__tabUrl || 'https://arxiv.org/abs/2401.00001',
              nativePdf: !!g.__tabNativePdf,
              injectable: true,
              title: 'A paper'
            });
          }
          if (msg && msg.type === 'FR_OPEN_PDF') {
            g.__openedPdf = (g.__openedPdf || 0) + 1;
            return cb({ ok: true });
          }
          if (msg && msg.type === 'FR_TRANSLATE') {
            // Stand in for a provider so bilingual mode, whole-page translation
            // and the selection popup can be exercised without the network.
            var texts = msg.texts || [];
            if (g.__translateFail) {
              return cb({ results: texts.map(function () {
                return { ok: false, code: g.__translateFail, error: 'stubbed failure' };
              }) });
            }
            g.__translateCalls = (g.__translateCalls || 0) + 1;
            g.__translatedCount = (g.__translatedCount || 0) + texts.length;
            return cb({ results: texts.map(function (t) {
              return { ok: true, text: '[zh] ' + String(t).slice(0, 40) };
            }) });
          }
          cb({ ok: true });
        }, 0);
      },
      openOptionsPage: function () { console.log('[preview] openOptionsPage'); }
    },
    storage: {
      // The reader reads a handoff out of session storage. ?seedHandoff= puts
      // one there before any of the code under test runs, which is the only
      // way to exercise that branch without loading the extension for real.
      session: {
        get: function (key, cb) {
          var out = {};
          [].concat(key).forEach(function (k) { out[k] = sessionStore[k]; });
          setTimeout(function () { cb(out); }, 0);
        },
        set: function (obj, cb) {
          Object.keys(obj).forEach(function (k) { sessionStore[k] = obj[k]; });
          if (cb) setTimeout(cb, 0);
        },
        remove: function (key, cb) {
          [].concat(key).forEach(function (k) { delete sessionStore[k]; });
          if (cb) setTimeout(cb, 0);
        }
      },
      local: {
        get: function (key, cb) {
          var out = {};
          if (typeof key === 'string') out[key] = store[key];
          else if (Array.isArray(key)) key.forEach(function (k) { out[k] = store[k]; });
          else out = JSON.parse(JSON.stringify(store));
          setTimeout(function () { cb(out); }, 0);
        },
        set: function (obj, cb) {
          Object.keys(obj).forEach(function (k) { store[k] = obj[k]; });
          if (cb) setTimeout(cb, 0);
        },
        remove: function (key, cb) {
          [].concat(key).forEach(function (k) { delete store[k]; });
          if (cb) setTimeout(cb, 0);
        }
      },
      onChanged: { addListener: function () {} }
    },
    permissions: {
      request: function (_, cb) { cb(true); },
      contains: function (_, cb) { cb(false); }
    },
    extension: { isAllowedFileSchemeAccess: function (cb) { cb(!!g.__fileAccess); } },
    tabs: { query: function () { return Promise.resolve([{ id: 1, url: 'https://example.com' }]); } }
  };
})(window);
