/*
 * Enough of the extension platform to LOAD the service worker under
 * JavaScriptCore so its pure decision functions can be tested.
 *
 * importScripts becomes a no-op because the runner concatenates those files
 * itself; every chrome.* surface the worker touches at load time is a stub that
 * records nothing. Listeners registered at load simply never fire.
 */
(function (g) {
  g.importScripts = function () {};

  function listener() { return { addListener: function () {}, removeListener: function () {} }; }
  function asyncOk(value) {
    return function () { return Promise.resolve(value); };
  }

  g.chrome = {
    runtime: {
      getURL: function (p) { return 'chrome-extension://testid/' + p; },
      getManifest: function () {
        return {
          host_permissions: [
            'https://api.mymemory.translated.net/*',
            'https://translation.googleapis.com/*'
          ]
        };
      },
      onInstalled: listener(),
      onStartup: listener(),
      onMessage: listener(),
      openOptionsPage: function () {},
      lastError: null
    },
    action: { onClicked: listener(), setTitle: function () {} },
    commands: { onCommand: listener() },
    contextMenus: { create: function () {}, removeAll: function (cb) { if (cb) cb(); }, onClicked: listener() },
    tabs: { query: asyncOk([]), create: function () {}, sendMessage: function () {} },
    scripting: {
      executeScript: asyncOk([]), insertCSS: asyncOk(),
      getRegisteredContentScripts: asyncOk([]),
      registerContentScripts: asyncOk(), updateContentScripts: asyncOk(),
      unregisterContentScripts: asyncOk()
    },
    storage: {
      local: {
        get: function (k, cb) { if (cb) cb({}); },
        set: function (o, cb) { if (cb) cb(); },
        remove: function (k, cb) { if (cb) cb(); }
      },
      onChanged: listener()
    },
    permissions: {
      getAll: asyncOk({ origins: [], permissions: [] }),
      contains: asyncOk(false),
      request: asyncOk(false),
      onAdded: listener(),
      onRemoved: listener()
    },
    declarativeNetRequest: { updateDynamicRules: asyncOk() }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
