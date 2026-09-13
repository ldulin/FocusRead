/*
 * FocusRead - reader page orchestration.
 *
 * Decides where the document came from (a redirected navigation, a ?file= URL,
 * a drop, a file picker), hands the bytes to the PDF or Word layer, renders the
 * result, and then points the ordinary reading Controller at it - so a PDF gets
 * exactly the same click-a-sentence, focus and translate behaviour as a web page.
 */
(function (root) {
  'use strict';
  var FR = root.FR;

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    mode: 'reflow',
    doc: null,          // pdf.js document
    mod: null,          // pdf.js module
    kind: null,         // 'pdf' | 'docx'
    name: '',
    blocks: null,
    rendered: new Set(),
    controller: null,
    io: null
  };

  /* ------------------------------------------------------------------ *
   * Where did this document come from?
   * ------------------------------------------------------------------ */

  function sourceFromLocation() {
    var search = location.search || '';
    // The DNR rule appends the original URL after a sentinel rather than as a
    // query parameter, because regexSubstitution does not percent-encode.
    if (search.indexOf('?DNR:') === 0) {
      return decodeURIComponent(search.slice(5)) + (location.hash || '');
    }
    var m = /[?&]file=([^&]+)/.exec(search);
    if (m) return decodeURIComponent(m[1]);
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Chrome
   * ------------------------------------------------------------------ */

  function showStatus(text, fraction) {
    $('drop').hidden = true;
    $('status').hidden = false;
    $('statusText').textContent = text;
    $('statusBar').style.width = Math.round((fraction || 0) * 100) + '%';
  }
  function hideStatus() { $('status').hidden = true; }

  function showError(message, detail) {
    hideStatus();
    $('doc').hidden = true;
    $('pages').hidden = true;
    $('drop').hidden = false;
    var box = $('dropError');
    box.hidden = false;
    box.textContent = message + (detail ? ' (' + detail + ')' : '');
  }

  function showNotices(list) {
    var box = $('notices');
    if (!list || !list.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<h4>About this document</h4><ul></ul>';
    var ul = box.querySelector('ul');
    list.forEach(function (n) {
      var li = document.createElement('li');
      li.textContent = n;
      ul.appendChild(li);
    });
  }

  function setFileName(name) {
    state.name = name || '';
    $('fileName').textContent = name || 'No document open';
    $('fileName').title = name || '';
    document.title = name ? name + ' - FocusRead' : 'FocusRead';
  }

  /* ------------------------------------------------------------------ *
   * Loading
   * ------------------------------------------------------------------ */

  function loadFromFile(file) {
    setFileName(file.name);
    $('dropError').hidden = true;
    showStatus('Reading ' + file.name + '...', 0.1);
    return file.arrayBuffer().then(function (buf) {
      var isPdf = /\.pdf$/i.test(file.name) || (FR.docx.sniff(buf) === 'pdf');
      return isPdf ? loadPdf({ data: buf }) : loadDocx(buf);
    }).catch(function (e) {
      showError(e.message || String(e), e.code === 'no-vendor' ? null : undefined);
    });
  }

  function loadFromUrl(url) {
    var name = decodeURIComponent(String(url).split(/[?#]/)[0].split('/').pop() || 'document.pdf');
    setFileName(name);
    showStatus('Fetching ' + name + '...', 0.05);

    if (/^file:/i.test(url)) {
      // Extensions cannot read file:// until the user turns it on explicitly.
      return chromeAllowsFiles().then(function (allowed) {
        if (!allowed) {
          showError('To open local files by URL, enable "Allow access to file URLs" for FocusRead on the ' +
                    'chrome://extensions page. Or just drop the file onto this window, which needs no permission.');
          return;
        }
        return loadPdf({ url: url });
      });
    }
    return loadPdf({ url: url }).catch(function (e) {
      showError('Could not open that PDF: ' + (e.message || e));
    });
  }

  function chromeAllowsFiles() {
    return new Promise(function (resolve) {
      if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
        chrome.extension.isAllowedFileSchemeAccess(resolve);
      } else {
        resolve(false);
      }
    });
  }

  function loadPdf(source) {
    state.kind = 'pdf';
    return FR.pdf.open(source, function (f) {
      showStatus('Downloading...', f * 0.4);
    }).then(function (res) {
      state.doc = res.doc;
      state.mod = res.mod;
      $('modes').hidden = false;
      $('pager').hidden = false;
      $('pageCount').textContent = '/ ' + res.doc.numPages;
      $('pageNum').max = String(res.doc.numPages);
      return FR.settings.get();
    }).then(function (s) {
      showStatus('Extracting text...', 0.5);
      return FR.pdf.extractReflow(state.doc, {
        stripRunningHeads: s.stripRunningHeads,
        joinHyphens: s.joinHyphens
      }, function (f) {
        showStatus('Extracting text... page ' + Math.round(f * state.doc.numPages), 0.5 + f * 0.45);
      });
    }).then(function (out) {
      state.blocks = out.blocks;
      showNotices(out.notices);
      return setMode(state.mode);
    });
  }

  function loadDocx(buffer) {
    state.kind = 'docx';
    showStatus('Converting Word document...', 0.4);
    return FR.docx.open(buffer).then(function (out) {
      $('modes').hidden = true;
      $('pager').hidden = true;
      var docEl = $('doc');
      docEl.innerHTML = out.html;
      docEl.hidden = false;
      $('pages').hidden = true;
      showNotices(out.notices);
      hideStatus();
      return attachController(docEl, true);
    });
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function renderReflow() {
    var docEl = $('doc');
    docEl.innerHTML = '';
    var lastPage = 0;

    state.blocks.forEach(function (b) {
      if (b.page && b.page !== lastPage) {
        if (lastPage) {
          var hr = document.createElement('hr');
          hr.className = 'pagebreak fr-ignore';
          hr.setAttribute('data-label', 'page ' + b.page);
          docEl.appendChild(hr);
        }
        lastPage = b.page;
      }
      var el = document.createElement(b.type === 'h' ? 'h2' : 'p');
      el.textContent = b.text;
      if (b.page) el.setAttribute('data-page', String(b.page));
      docEl.appendChild(el);
    });

    docEl.hidden = false;
    $('pages').hidden = true;
    hideStatus();
    return attachController(docEl, true);
  }

  function renderOriginal() {
    var host = $('pages');
    host.innerHTML = '';
    state.rendered = new Set();
    host.hidden = false;
    $('doc').hidden = true;
    hideStatus();

    var width = Math.min(900, (root.innerWidth || 900) - 60);

    return state.doc.getPage(1).then(function (p1) {
      var base = p1.getViewport({ scale: 1 });
      var scale = width / base.width;

      // Placeholders keep the scrollbar honest; pages render as they approach.
      for (var n = 1; n <= state.doc.numPages; n++) {
        var ph = document.createElement('div');
        ph.className = 'pageWrap fr-ignore';
        ph.setAttribute('data-placeholder', String(n));
        ph.style.width = Math.floor(base.width * scale) + 'px';
        ph.style.height = Math.floor(base.height * scale) + 'px';
        host.appendChild(ph);
      }

      if (state.io) state.io.disconnect();
      state.io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var n = Number(e.target.getAttribute('data-placeholder'));
          if (!n || state.rendered.has(n)) return;
          state.rendered.add(n);
          state.io.unobserve(e.target);
          var slot = e.target;
          FR.pdf.renderPage(state.doc, state.mod, n, host, scale).then(function (wrap) {
            host.insertBefore(wrap, slot);
            slot.remove();
          }).catch(function (err) {
            slot.textContent = 'Could not render page ' + n + ': ' + (err.message || err);
          });
        });
      }, { rootMargin: '900px 0px' });

      Array.prototype.forEach.call(host.children, function (c) { state.io.observe(c); });

      return attachController(host, false);
    });
  }

  function setMode(mode) {
    state.mode = mode;
    Array.prototype.forEach.call(document.querySelectorAll('#modes button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-mode') === mode);
    });
    if (state.controller) { state.controller.deactivate(); state.controller = null; }
    return mode === 'original' ? renderOriginal() : renderReflow();
  }

  /* ------------------------------------------------------------------ *
   * The reading controller
   * ------------------------------------------------------------------ */

  function attachController(rootEl, allowBilingual) {
    var c = new FR.Controller({ root: rootEl, isReader: true });
    c.allowBilingual = allowBilingual;
    state.controller = c;
    return c.activate().then(function () {
      if (state.kind === 'pdf') syncPagerToScroll();
      return c;
    });
  }

  /* ------------------------------------------------------------------ *
   * Page navigation
   * ------------------------------------------------------------------ */

  function goToPage(n) {
    n = Math.max(1, Math.min(state.doc ? state.doc.numPages : 1, n | 0));
    $('pageNum').value = String(n);
    var target = state.mode === 'original'
      ? document.querySelector('[data-page="' + n + '"], [data-placeholder="' + n + '"]')
      : document.querySelector('#doc [data-page="' + n + '"]');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  var pagerTimer = null;
  function syncPagerToScroll() {
    root.addEventListener('scroll', function () {
      clearTimeout(pagerTimer);
      pagerTimer = setTimeout(function () {
        var mid = (root.innerHeight || 0) * 0.35;
        var nodes = document.querySelectorAll('[data-page], [data-placeholder]');
        for (var i = nodes.length - 1; i >= 0; i--) {
          var r = nodes[i].getBoundingClientRect();
          if (r.top <= mid) {
            var p = nodes[i].getAttribute('data-page') || nodes[i].getAttribute('data-placeholder');
            if (p) $('pageNum').value = p;
            return;
          }
        }
      }, 120);
    }, { passive: true });
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  function wire() {
    $('pickBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('openBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('optionsBtn').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });

    $('fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) loadFromFile(f);
      e.target.value = '';
    });

    document.querySelectorAll('#modes button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!state.doc) return;
        setMode(b.getAttribute('data-mode'));
      });
    });

    $('pagePrev').addEventListener('click', function () { goToPage(Number($('pageNum').value) - 1); });
    $('pageNext').addEventListener('click', function () { goToPage(Number($('pageNum').value) + 1); });
    $('pageNum').addEventListener('change', function () { goToPage(Number($('pageNum').value)); });

    var depth = 0;
    var veil = $('dragveil');
    ['dragenter', 'dragover'].forEach(function (t) {
      root.addEventListener(t, function (e) {
        e.preventDefault();
        if (t === 'dragenter') depth++;
        veil.hidden = false;
      });
    });
    root.addEventListener('dragleave', function () {
      if (--depth <= 0) { depth = 0; veil.hidden = true; }
    });
    root.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      veil.hidden = true;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFromFile(f);
    });
  }

  /* ------------------------------------------------------------------ *
   * Start
   * ------------------------------------------------------------------ */

  document.addEventListener('DOMContentLoaded', function () {
    wire();
    FR.settings.get().then(function (s) {
      state.mode = s.pdfView === 'original' ? 'original' : 'reflow';
      var src = sourceFromLocation();
      if (src) loadFromUrl(src);
    });
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
