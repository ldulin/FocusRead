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
      if (!r || r.error || r.injectable) return;
      $('start').disabled = true;
      $('pageNote').hidden = false;
      $('pageNote').textContent = /\.pdf(\?|#|$)/i.test(r.url || '')
        ? 'Chrome is showing this PDF in its own viewer, which extensions cannot read. Use "Open a PDF or Word file" below.'
        : 'FocusRead cannot run on browser pages like this one.';
    });
  }

  /* ---------- built-in translator status ---------- */

  function refreshEngine() {
    var dot = $('engineDot'), text = $('engineText'), dl = $('download');
    dl.hidden = true;
    $('dlTrack').hidden = true;

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
        text.textContent = 'Chrome could not report translator status. Try anyway, or pick another provider.';
        dl.hidden = false;
      } else {
        dot.className = 'dot bad';
        text.textContent = 'Chrome cannot translate into ' + FR.translate.langName(settings.targetLang) +
                           ' on this device. Choose another provider in Settings.';
      }
    });
  }

  function providerLabel(p) {
    return { builtin: 'Chrome built-in', mymemory: 'MyMemory (free)', libre: 'LibreTranslate',
             google: 'Google Translate', openai: 'an LLM endpoint' }[p] || p;
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
      send({ type: 'FR_TOGGLE_ACTIVE_TAB' }).then(function () { window.close(); });
    });
    $('openDoc').addEventListener('click', function () {
      send({ type: 'FR_OPEN_READER' }).then(function () { window.close(); });
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
