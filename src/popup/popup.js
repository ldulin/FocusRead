/*
 * FocusRead - toolbar popup.
 *
 * Also the correct home for the built-in translator's first-run download:
 * Translator.create() needs transient user activation when a language pack is
 * missing, and a popup button click is the only place in an extension that
 * reliably has it.
 */
(function () {
  'use strict';
  var FR = globalThis.FR;
  var $ = function (id) { return document.getElementById(id); };
  var settings = null;

  function send(msg) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(msg, function (r) {
        resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r);
      });
    });
  }

  /* ---------- current tab ---------- */

  function checkTab() {
    return send({ type: 'FR_STATUS_ACTIVE_TAB' }).then(function (r) {
      window.__tabInfo = r;
      if (!r || r.error) return;
      // Without the "tabs" permission the URL is only visible once activeTab
      // has been granted. Unknown is not the same as unsupported.
      if (!r.url) return;

      // A PDF URL passes the http(s) test, so it looks injectable - but Chrome
      // is rendering it in its own viewer, which no content script can reach.
      // The suffix is not a reliable signal either (arxiv.org/pdf/2401.12345v1
      // has none), so the content script reports its own document.contentType
      // and that answer wins.
      if (r.nativePdf || /\.pdf(\?|#|$)/i.test(r.url || '')) {
        offerPdfHandoff(r.url);
        return;
      }

      if (r.injectable) return;
      $('start').disabled = true;
      $('pageNote').hidden = false;
      $('pageNote').textContent = 'FocusRead cannot run on browser pages like this one.';
    });
  }

  /*
   * The browser is showing this PDF in its own viewer, which no content script
   * can reach - so offer to open the same address in our reader instead of
   * telling the reader to go and find the file again by hand.
   */
  function offerPdfHandoff(url) {
    $('start').disabled = true;
    $('pageNote').hidden = false;
    $('pageNote').textContent =
      'This PDF is in the browser\'s own viewer, which no extension can read.';
    var btn = $('openThis');
    btn.hidden = false;
    btn.disabled = false;
    if (/^file:/i.test(url || '')) {
      // Reading a local file needs a permission only the user can grant, and
      // it is a checkbox rather than a prompt - so say so before the reader
      // opens on an error instead of after.
      if (!chrome.extension || !chrome.extension.isAllowedFileSchemeAccess) return;
      chrome.extension.isAllowedFileSchemeAccess(function (ok) {
        if (ok) return;
        $('pageNote').textContent =
          'This is a local file. Turn on "Allow access to file URLs" for ' +
          'FocusRead on the extensions page first, then press the button.';
      });
    }
  }

  /* ---------- built-in translator status ---------- */

  function refreshEngine() {
    var dot = $('engineDot'), text = $('engineText'), dl = $('download');
    dl.hidden = true;
    $('dlTrack').hidden = true;

    if (settings.provider === 'auto') {
      // Report what it will actually do, not just that it is on auto.
      dot.className = 'dot ok';
      text.textContent = 'Checking which translator is available...';
      return FR.translate.builtinUsable('en', settings.targetLang).then(function (ok) {
        dot.className = 'dot ok';
        text.textContent = ok
          ? 'Using Chrome\'s on-device translator (free, offline).'
          : 'Chrome\'s on-device translator is not ready here, so Google Translate is used instead.';
      });
    }
    if (settings.provider !== 'builtin') {
      dot.className = 'dot ok';
      text.textContent = 'Using ' + providerLabel(settings.provider) + '.';
      return Promise.resolve();
    }
    if (!FR.translate.builtinAvailable()) {
      dot.className = 'dot bad';
      text.textContent = 'Chrome\'s built-in translator is unavailable (needs Chrome 138+ desktop).';
      return Promise.resolve();
    }

    var src = settings.sourceLang === 'auto' ? 'en' : settings.sourceLang;
    return FR.translate.builtinStatus(src, settings.targetLang).then(function (st) {
      if (st === 'available') {
        dot.className = 'dot ok';
        text.textContent = 'Offline translation ready (' + FR.translate.langName(settings.targetLang) + ').';
      } else if (st === 'downloadable') {
        dot.className = 'dot warn';
        text.textContent = 'A one-time language pack is needed for ' + FR.translate.langName(settings.targetLang) + '.';
        dl.hidden = false;
      } else if (st === 'downloading') {
        dot.className = 'dot warn';
        text.textContent = 'Chrome is downloading the language pack...';
      } else if (st === 'same-language') {
        dot.className = 'dot warn';
        text.textContent = 'Source and target are the same language.';
      } else if (st === 'unknown') {
        dot.className = 'dot warn';
        text.textContent = 'Chrome did not answer about translation support - usually no connection. ' +
                           'You can still try, or pick another provider in Settings.';
        dl.hidden = false;
      } else {
        dot.className = 'dot bad';
        text.textContent = 'Chrome cannot translate into ' + FR.translate.langName(settings.targetLang) +
                           ' on this device. Choose another provider in Settings.';
      }
    });
  }

  function providerLabel(p) {
    return { auto: 'automatic engine selection', builtin: 'Chrome built-in',
             'google-free': 'Google Translate (free)', mymemory: 'MyMemory (free)',
             libre: 'LibreTranslate', google: 'Google Cloud Translation',
             openai: 'an LLM endpoint' }[p] || p;
  }

  // Runs inside a click handler so the download has user activation.
  function downloadPack() {
    var dl = $('download');
    dl.disabled = true;
    dl.textContent = 'Downloading...';
    $('dlTrack').hidden = false;

    var src = settings.sourceLang === 'auto' ? 'en' : settings.sourceLang;
    return FR.translate.translateBatch(['FocusRead is ready.'], {
      provider: 'builtin',
      sourceLang: src,
      targetLang: settings.targetLang,
      cache: false,
      onProgress: function (loaded) {
        $('dlBar').style.width = Math.round(Math.min(1, loaded) * 100) + '%';
      }
    }).then(function (res) {
      dl.disabled = false;
      dl.textContent = 'Download language pack';
      var r = res[0] || {};
      if (!r.ok) {
        $('engineDot').className = 'dot bad';
        $('engineText').textContent = r.error || 'The download did not finish.';
        return;
      }
      $('dlBar').style.width = '100%';
      return refreshEngine();
    });
  }

  /* ---------- settings widgets ---------- */

  function fillLanguages() {
    var sel = $('targetLang');
    FR.settings.LANGUAGES.forEach(function (pair) {
      var o = document.createElement('option');
      o.value = pair[0];
      o.textContent = pair[1];
      sel.appendChild(o);
    });
  }

  function bind() {
    $('start').addEventListener('click', function () {
      var btn = $('start');
      btn.disabled = true;
      btn.textContent = 'Starting...';
      send({ type: 'FR_TOGGLE_ACTIVE_TAB' }).then(function (r) {
        // Closing regardless meant a refused injection - a PDF viewer, a
        // chrome:// page, a site that blocks scripting - looked like a no-op.
        if (r && (r.error || r.error === '')) {
          btn.disabled = false;
          btn.textContent = 'Start reading this page';
          $('pageNote').hidden = false;
          $('pageNote').textContent =
            r.error === 'native-pdf'
              ? 'Chrome shows PDFs in its own viewer, which extensions cannot read. Use "Open a PDF or Word file" below.'
              : r.error === 'unsupported-page'
                ? 'FocusRead cannot run on this page.'
                : 'Could not start: ' + r.error;
          return;
        }
        window.close();
      });
    });
    $('openDoc').addEventListener('click', function () {
      send({ type: 'FR_OPEN_READER' }).then(function () { window.close(); });
    });
    $('openThis').addEventListener('click', function () {
      var btn = $('openThis');
      btn.disabled = true;
      send({ type: 'FR_OPEN_PDF' }).then(function (r) {
        if (r && r.error) {
          btn.disabled = false;
          $('pageNote').textContent = 'Could not open it: ' + r.error;
          return;
        }
        window.close();
      });
    });
    $('settings').addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
      window.close();
    });

    $('focusMode').addEventListener('change', function (e) {
      FR.settings.set({ focusMode: e.target.value });
    });
    $('rate').addEventListener('input', function (e) {
      $('rateOut').textContent = Number(e.target.value).toFixed(2).replace(/0$/, '') + 'x';
    });
    $('rate').addEventListener('change', function (e) {
      FR.settings.set({ rate: Number(e.target.value) });
    });
    $('bilingual').addEventListener('change', function (e) {
      FR.settings.set({ bilingual: e.target.checked });
    });
    $('targetLang').addEventListener('change', function (e) {
      settings.targetLang = e.target.value;
      FR.settings.set({ targetLang: e.target.value }).then(refreshEngine);
    });
    $('download').addEventListener('click', downloadPack);
  }

  /* ---------- start ---------- */

  fillLanguages();
  bind();
  FR.settings.get().then(function (s) {
    settings = s;
    $('focusMode').value = s.focusMode;
    $('rate').value = String(s.rate);
    $('rateOut').textContent = Number(s.rate).toFixed(2).replace(/0$/, '') + 'x';
    $('targetLang').value = s.targetLang;
    $('bilingual').checked = !!s.bilingual;
    return Promise.all([checkTab(), refreshEngine()]);
  });
})();
