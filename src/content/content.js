/*
 * FocusRead - content script entry point.
 *
 * Thin on purpose: the Controller holds all the behaviour. This file only
 * decides WHEN to switch on, and answers the service worker.
 *
 * The extension does not auto-inject into every page. It is injected on demand
 * when you click the toolbar icon or press the shortcut, which means installing
 * it does not ask for "read and change all your data on all websites".
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  // Injection is idempotent: clicking the icon twice must not build two engines.
  if (FR.__contentLoaded) return;
  FR.__contentLoaded = true;

  var controller = null;

  function get() {
    if (!controller) controller = new FR.Controller({ root: document.body });
    return controller;
  }

  function status() {
    return {
      active: !!(controller && controller.active),
      sentences: controller && controller.engine ? controller.engine.count() : 0,
      index: controller && controller.engine ? controller.engine.index : -1,
      builtinTranslator: FR.translate.builtinAvailable()
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'FR_TOGGLE':
        if (controller && controller.active) {
          controller.deactivate();
          respond(status());
        } else {
          get().activate().then(function () { respond(status()); },
                                function (e) { respond({ error: String(e && e.message || e) }); });
          return true;   // respond asynchronously
        }
        return false;

      case 'FR_ACTIVATE':
        get().activate().then(function () { respond(status()); },
                              function (e) { respond({ error: String(e && e.message || e) }); });
        return true;

      case 'FR_DEACTIVATE':
        if (controller) controller.deactivate();
        respond(status());
        return false;

      case 'FR_STATUS':
        respond(status());
        return false;

      case 'FR_PLAY':
        get().activate().then(function (c) { c.play(); respond(status()); });
        return true;

      case 'FR_READ_SELECTION': {
        var sel = String((root.getSelection && root.getSelection()) || '').trim();
        if (!sel) { respond({ error: 'Nothing selected' }); return false; }
        get().activate().then(function (c) {
          FR.speech.speak(sel, {
            rate: c.settings.rate, lang: c.docLang(),
            maxChars: c.settings.maxUtteranceChars, localOnly: c.settings.localVoicesOnly
          });
          respond(status());
        });
        return true;
      }

      case 'FR_TRANSLATE_SELECTION':
        get().activate().then(function (c) { c.handleSelection(); respond(status()); });
        return true;

      /*
       * Built-in translation has to run where there is a real Document, so the
       * service worker relays requests for it back into this page.
       */
      case 'FR_BUILTIN_TRANSLATE':
        if (!FR.translate.builtinAvailable()) {
          respond({ results: (msg.texts || []).map(function () {
            return { ok: false, code: 'builtin-unavailable', error: 'Built-in translator unavailable in this page' };
          }) });
          return false;
        }
        FR.translate.translateBatch(msg.texts || [], msg.opts || {}).then(function (results) {
          respond({ results: results });
        });
        return true;

      default:
        return false;
    }
  });

  // Leaving a page should release the on-device translator too.
  root.addEventListener('pagehide', function () {
    if (FR.translate && FR.translate.builtinDestroy) FR.translate.builtinDestroy();
  });

  // Auto-activate only where the reader has explicitly asked for it.
  FR.settings.get().then(function (s) {
    var host = location.hostname;
    var wanted = s.autoActivate || (s.autoActivateHosts || []).indexOf(host) !== -1;
    if (!wanted) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { get().activate(); }, { once: true });
    } else {
      get().activate();
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
