/*
 * FocusRead - MV3 service worker.
 *
 * Three jobs, and deliberately nothing else:
 *   1. Inject the reader into the active tab on demand (activeTab), so the
 *      extension needs no broad host permission at install time.
 *   2. Relay NETWORK translation requests. A content script runs in the page's
 *      origin and obeys the page's CORS rules and CSP; only the worker carries
 *      the extension's host permissions.
 *   3. Optionally redirect PDF navigations into our own viewer.
 *
 * It is a CLASSIC worker (no "type": "module") so importScripts can share the
 * exact same library files the page contexts use.
 *
 * Note what is NOT here: Chrome's built-in Translator is invisible to a service
 * worker (no responsible Document), and speechSynthesis needs a DOM. Both live
 * in page contexts.
 */
/* global importScripts */
importScripts('../lib/segmenter.js', '../lib/settings.js', '../lib/translate.js');

var FR = globalThis.FR;

/* ------------------------------------------------------------------ *
 * Injection
 * ------------------------------------------------------------------ */

var INJECT_JS = [
  'src/lib/segmenter.js',
  'src/lib/settings.js',
  'src/lib/translate.js',
  'src/content/speech.js',
  'src/content/engine.js',
  'src/content/ui.js',
  'src/content/controller.js',
  'src/content/content.js'
];
var INJECT_CSS = ['src/content/content.css'];

function isInjectable(url) {
  // An empty url means activeTab has not revealed it to us yet - there is no
  // "tabs" permission here by design. Treat unknown as injectable and let the
  // injection itself fail with a real error, rather than telling the reader
  // the page is unsupported when it very likely is not.
  if (!url) return true;
  return /^(https?|file|ftp):/i.test(url);
}

function ping(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, { type: 'FR_STATUS' }, function (resp) {
      resolve(chrome.runtime.lastError ? null : resp);
    });
  });
}

/** Inject the reader once; returns the tab's status. */
function ensureInjected(tabId) {
  return ping(tabId).then(function (resp) {
    if (resp) return resp;
    return chrome.scripting.insertCSS({ target: { tabId: tabId }, files: INJECT_CSS })
      .then(function () {
        return chrome.scripting.executeScript({ target: { tabId: tabId }, files: INJECT_JS });
      })
      .then(function () { return ping(tabId); });
  });
}

function sendTo(tabId, message) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, message, function (resp) {
      resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : resp);
    });
  });
}

function actOnActiveTab(message) {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    var tab = tabs[0];
    if (!tab) return null;
    if (!isInjectable(tab.url)) {
      notifyUnsupported(tab);
      return null;
    }
    return ensureInjected(tab.id).then(function () { return sendTo(tab.id, message); });
  });
}

function notifyUnsupported(tab) {
  // chrome://, the Web Store and the native PDF viewer are all off limits to
  // extensions. Say so rather than failing silently.
  var url = (tab && tab.url) || '';
  if (!url) return;                    // nothing useful to say yet
  var why = /^chrome(-extension)?:|^edge:|^about:/i.test(url)
    ? 'Browser pages are off limits to extensions.'
    : (/\.pdf(\?|#|$)/i.test(url)
        ? 'This is Chrome\'s built-in PDF viewer, which extensions cannot read. Open the PDF in the FocusRead reader instead.'
        : 'FocusRead cannot run on this page.');
  chrome.action.setTitle({ title: 'FocusRead - ' + why, tabId: tab && tab.id });
}

// No chrome.action.onClicked listener: the action declares a default_popup, so
// Chrome opens the popup and the click event is never dispatched. The popup's
// "Start reading this page" button sends FR_TOGGLE_ACTIVE_TAB instead.

chrome.commands.onCommand.addListener(function (command) {
  if (command === 'toggle-reader') actOnActiveTab({ type: 'FR_TOGGLE' });
  if (command === 'play-pause') actOnActiveTab({ type: 'FR_PLAY' });
  if (command === 'open-reader') openReader();
});

/* ------------------------------------------------------------------ *
 * Context menu
 * ------------------------------------------------------------------ */

function buildMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: 'fr-read-selection', title: 'Read this aloud', contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'fr-translate-selection', title: 'Translate this with FocusRead', contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'fr-toggle', title: 'Turn FocusRead on for this page', contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'fr-open-reader', title: 'Open a PDF or Word file...', contexts: ['action']
    });
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  buildMenus();
  syncPdfRules();
  syncAutoActivation();
  if (details && details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') });
  }
});
chrome.runtime.onStartup.addListener(function () {
  syncPdfRules();
  syncAutoActivation();
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'fr-open-reader') return openReader();
  if (!isInjectable(tab.url)) return notifyUnsupported(tab);
  var map = {
    'fr-read-selection': 'FR_READ_SELECTION',
    'fr-translate-selection': 'FR_TRANSLATE_SELECTION',
    'fr-toggle': 'FR_TOGGLE'
  };
  var type = map[info.menuItemId];
  if (type) ensureInjected(tab.id).then(function () { sendTo(tab.id, { type: type }); });
});

function openReader() {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/reader/reader.html') });
}

/* ------------------------------------------------------------------ *
 * Auto-activation
 *
 * The settings existed but nothing acted on them: content scripts are only
 * ever injected on demand, so "start automatically" could never fire. Doing it
 * properly means a REGISTERED content script, which needs a real host
 * permission - requested from the options page, never granted at install.
 * ------------------------------------------------------------------ */

var AUTO_SCRIPT_ID = 'focusread-auto';

/**
 * Which URL patterns should auto-activate.
 *
 * The scheme segment of a granted origin is NOT literally "http": the options
 * page requests the all-sites match pattern, and getAll() returns it verbatim
 * with a leading asterisk. Filtering for /^https?:/ dropped it and left only
 * the extension's own manifest host_permissions - so the feature registered
 * the whole reader bundle onto the two translation API endpoints and fired
 * nowhere the reader actually browses.
 *
 * Subtracting host_permissions also matters on the way back: if the user
 * revokes all-sites access while the setting is still on, `matches` comes back
 * empty and the caller correctly unregisters instead of re-registering onto
 * those API hosts.
 */
function autoMatches(settings, granted) {
  if (settings.autoActivate) {
    var origins = granted.origins || [];
    var own = chrome.runtime.getManifest().host_permissions || [];
    if (origins.indexOf('*://*/*') !== -1 || origins.indexOf('<all_urls>') !== -1) {
      return ['*://*/*'];
    }
    return origins.filter(function (o) {
      return own.indexOf(o) === -1 && /^(\*|https?):\/\//.test(o);
    });
  }
  return (settings.autoActivateHosts || [])
    .map(function (h) { return String(h).trim(); })
    .filter(Boolean)
    .map(function (h) { return '*://' + h + '/*'; });
}

function syncAutoActivation() {
  if (!chrome.scripting || !chrome.scripting.getRegisteredContentScripts) return Promise.resolve();

  return Promise.all([FR.settings.get(), chrome.permissions.getAll()])
    .then(function (r) {
      var settings = r[0], granted = r[1];
      var matches = autoMatches(settings, granted);

      return chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_SCRIPT_ID] })
        .catch(function () { return []; })
        .then(function (existing) {
          if (!matches.length) {
            return existing.length
              ? chrome.scripting.unregisterContentScripts({ ids: [AUTO_SCRIPT_ID] }).catch(function () {})
              : null;
          }
          var spec = {
            id: AUTO_SCRIPT_ID,
            matches: matches,
            js: INJECT_JS,
            css: INJECT_CSS,
            runAt: 'document_idle',
            persistAcrossSessions: true
          };
          return existing.length
            ? chrome.scripting.updateContentScripts([spec]).catch(function () {})
            : chrome.scripting.registerContentScripts([spec]).catch(function (e) {
                console.warn('[FocusRead] could not register auto-activation', e);
              });
        });
    });
}

// Granting or revoking a host has to re-register immediately, not at next start.
if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(syncAutoActivation);
  chrome.permissions.onRemoved.addListener(syncAutoActivation);
}
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.settings) syncAutoActivation();
});

/* ------------------------------------------------------------------ *
 * Translation relay
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (!msg || !msg.type) return;

  if (msg.type === 'FR_TRANSLATE') {
    var opts = msg.opts || {};
    if (opts.provider === 'builtin') {
      // Cannot run here - no Document, so self.Translator does not exist.
      respond({
        results: (msg.texts || []).map(function () {
          return {
            ok: false, code: 'builtin-in-worker',
            error: 'Built-in translation must run in the page, not the background worker'
          };
        })
      });
      return false;
    }
    FR.translate.translateBatch(msg.texts || [], opts).then(
      function (results) { respond({ results: results }); },
      function (e) {
        respond({
          results: (msg.texts || []).map(function () {
            return { ok: false, code: 'error', error: String((e && e.message) || e) };
          })
        });
      }
    );
    return true;    // async
  }

  if (msg.type === 'FR_TOGGLE_ACTIVE_TAB' || msg.type === 'FR_ACTIVATE_ACTIVE_TAB') {
    // Sent by the popup. Opening the popup grants activeTab for that tab, so
    // the worker may inject even without a broad host permission.
    actOnActiveTab({ type: msg.type === 'FR_TOGGLE_ACTIVE_TAB' ? 'FR_TOGGLE' : 'FR_ACTIVATE' })
      .then(function (r) { respond(r || { error: 'unsupported-page' }); },
            function (e) { respond({ error: String(e && e.message || e) }); });
    return true;
  }

  if (msg.type === 'FR_STATUS_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var tab = tabs[0];
      if (!tab) return respond({ error: 'no-tab' });
      respond({ url: tab.url, injectable: isInjectable(tab.url), title: tab.title });
    });
    return true;
  }

  if (msg.type === 'FR_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return false;
  }

  if (msg.type === 'FR_OPEN_READER') {
    openReader();
    return false;
  }

  if (msg.type === 'FR_SET_PDF_INTERCEPT') {
    setPdfIntercept(!!msg.enabled).then(function (r) { respond(r); });
    return true;
  }

  return false;
});

/* ------------------------------------------------------------------ *
 * Optional: open PDFs in our own viewer.
 *
 * Off by default. Turning it on asks for the declarativeNetRequest permission
 * and host access, because redirecting navigations is a serious capability and
 * should be a deliberate choice, not something granted at install.
 *
 * Rule design follows pdf.js's own extension:
 *   - main_frame / sub_frame ONLY. Including xmlhttprequest would match our own
 *     viewer's fetch of the same URL and produce an infinite redirect loop.
 *   - POST excluded: a redirect becomes a GET and silently drops the body.
 *   - the original URL is carried after a "?DNR:" sentinel rather than a
 *     "?file=" parameter, because regexSubstitution does NOT percent-encode,
 *     so a PDF URL with its own query string would otherwise be mangled.
 * ------------------------------------------------------------------ */

var PDF_RULE_ID = 1;

function pdfRules() {
  return [{
    id: PDF_RULE_ID,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: {
        regexSubstitution: chrome.runtime.getURL('src/reader/reader.html') + '?DNR:\\0'
      }
    },
    condition: {
      regexFilter: '^https?://.+\\.pdf(\\?.*)?$',
      resourceTypes: ['main_frame', 'sub_frame'],
      excludedRequestMethods: ['post']
    }
  }];
}

function setPdfIntercept(enabled) {
  // The namespace is optional, so it is absent until the permission is
  // granted. Dereferencing it threw synchronously - before any promise existed
  // - so the caller's .then never ran and the checkbox stuck.
  if (!chrome.declarativeNetRequest) {
    return FR.settings.set({ pdfInterceptLinks: false })
      .then(function () {
        return { ok: !enabled, enabled: false,
                 error: enabled ? 'FocusRead was not granted permission to redirect requests.' : undefined };
      });
  }
  if (!enabled) {
    return chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [PDF_RULE_ID] })
      .then(function () { return FR.settings.set({ pdfInterceptLinks: false }); })
      .then(function () { return { ok: true, enabled: false }; })
      .catch(function (e) { return { ok: false, error: String(e.message || e) }; });
  }

  // The permission itself is requested by the OPTIONS PAGE, inside its click
  // handler. chrome.permissions.request() requires transient user activation,
  // and a service worker never has any - calling it here failed every time.
  return chrome.permissions.contains({
    permissions: ['declarativeNetRequest'],
    origins: ['*://*/*']
  }).then(function (has) {
    if (!has) return { ok: false, error: 'Permission was not granted' };
    return chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [PDF_RULE_ID],
      addRules: pdfRules()
    }).then(function () {
      return FR.settings.set({ pdfInterceptLinks: true });
    }).then(function () { return { ok: true, enabled: true }; });
  }).catch(function (e) { return { ok: false, error: String(e.message || e) }; });
}

/** Re-apply the rule after an update or restart, if it is still wanted. */
function syncPdfRules() {
  if (!chrome.declarativeNetRequest) return;
  FR.settings.get().then(function (s) {
    if (!s.pdfInterceptLinks) return;
    chrome.permissions.contains({ permissions: ['declarativeNetRequest'] }, function (has) {
      if (!has) return;
      chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [PDF_RULE_ID], addRules: pdfRules()
      }).catch(function () { /* rule survives across restarts anyway */ });
    });
  });
}
