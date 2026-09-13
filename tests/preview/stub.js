/*
 * A minimal chrome.* stand-in so the popup, options and reader pages can be
 * opened as plain files during development. Storage is in-memory; messages are
 * logged. Loaded only by tests/preview/build.py output, never by the extension.
 */
(function (g) {
  var store = { settings: undefined };

  g.chrome = {
    runtime: {
      lastError: null,
      id: 'preview',
      getURL: function (p) { return '../../' + String(p).replace(/^\//, ''); },
      sendMessage: function (msg, cb) {
        console.log('[preview] sendMessage', msg);
        if (typeof cb === 'function') {
          setTimeout(function () {
            if (msg && msg.type === 'FR_STATUS_ACTIVE_TAB') {
              cb({ url: 'https://arxiv.org/abs/2401.00001', injectable: true, title: 'A paper' });
            } else {
              cb({ ok: true });
            }
          }, 0);
        }
      },
      openOptionsPage: function () { console.log('[preview] openOptionsPage'); }
    },
    storage: {
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
    extension: { isAllowedFileSchemeAccess: function (cb) { cb(false); } },
    tabs: { query: function () { return Promise.resolve([{ id: 1, url: 'https://example.com' }]); } }
  };
})(window);
