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

  /**
   * @returns {{url:string, trusted:boolean}|null}
   *
   * `trusted` means the browser itself sent us here: the declarativeNetRequest
   * rule rewrote a top-level navigation the user made. Anything else - notably
   * a ?file= parameter - could have been supplied by any web page, because
   * reader.html is web-accessible. Those are NOT fetched automatically.
   */
  function sourceFromLocation() {
    var search = location.search || '';

    if (search.indexOf('?DNR:') === 0) {
      // Deliberately NOT decoded. regexSubstitution copies the matched URL in
      // verbatim without percent-encoding it, so decoding here would corrupt
      // any URL that legitimately contains a %-sequence (and throw outright on
      // a stray % in a filename).
      return { url: search.slice(5) + (location.hash || ''), trusted: true };
    }

    var m = /[?&]file=([^&#]+)/.exec(search);
    if (m) {
      var raw;
      try { raw = decodeURIComponent(m[1]); } catch (e) { raw = m[1]; }
      return { url: raw, trusted: false };
    }
    return null;
  }

  /**
   * Ask before fetching a URL we were handed by an unknown caller.
   *
   * Without this, any page could open our web-accessible reader pointing at an
   * arbitrary address and we would fetch it with the user's cookies attached -
   * a confused deputy that reaches intranet hosts the calling page cannot.
   */
  function confirmUrl(url) {
    hideStatus();
    $('drop').hidden = false;
    var box = $('dropError');
    box.hidden = false;
    box.textContent = '';

    var p = document.createElement('p');
    p.textContent = 'Another page asked FocusRead to open this address:';
    var code = document.createElement('code');
    code.textContent = url.length > 300 ? url.slice(0, 300) + '...' : url;
    code.style.cssText = 'display:block;margin:8px 0;word-break:break-all;font-size:12px';
    var go = document.createElement('button');
    go.className = 'primary';
    go.textContent = 'Open it';
    go.addEventListener('click', function () {
      box.hidden = true;
      loadPdf({ url: url }, false);
    });
    var no = document.createElement('p');
    no.style.cssText = 'margin:10px 0 0;font-size:12px';
    no.textContent = 'If you did not expect this, close the tab. Opening it sends a request to that address.';

    box.appendChild(p);
    box.appendChild(code);
    box.appendChild(go);
    box.appendChild(no);
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
    resetDocument();
    $('drop').hidden = false;
    var box = $('dropError');
    box.hidden = false;
    box.textContent = message + (detail ? ' (' + detail + ')' : '');
  }

  /**
   * Drop whatever was loaded before.
   *
   * Without this, a failed load left the PREVIOUS document's controller alive
   * and its mode buttons live, so the error message sat above a document the
   * user thought they had replaced.
   */
  function resetDocument() {
    if (state.controller) { state.controller.deactivate(); state.controller = null; }
    if (state.io) { state.io.disconnect(); state.io = null; }
    if (state.doc && state.doc.destroy) { try { state.doc.destroy(); } catch (e) { /* noop */ } }
    state.doc = null;
    state.mod = null;
    state.blocks = null;
    state.kind = null;
    state.rendered = new Set();
    $('doc').hidden = true;
    $('doc').innerHTML = '';
    $('pages').hidden = true;
    $('pages').innerHTML = '';
    $('modes').hidden = true;
    $('pager').hidden = true;
    $('notices').hidden = true;
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
    resetDocument();
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

  function loadFromUrl(url, trusted) {
    var base = String(url).split(/[?#]/)[0].split('/').pop() || 'document.pdf';
    var name;
    try { name = decodeURIComponent(base); } catch (e) { name = base; }
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
        return loadPdf({ url: url }, trusted);
      }).catch(function (e) {
        // Previously uncaught: any failure here left the spinner up forever.
        showError('Could not open that file: ' + (e.message || e));
      });
    }
    return loadPdf({ url: url }, trusted).catch(function (e) {
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

  function loadPdf(source, trusted) {
    state.kind = 'pdf';
    if (source.url) source.withCredentials = !!trusted;
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
          FR.pdf.renderPage(state.doc, state.mod, n, host, scale, slot).catch(function (err) {
            state.rendered.delete(n);          // allow a retry on the next pass
            slot.textContent = 'Could not render page ' + n + ': ' + (err.message || err);
            slot.style.cssText += ';display:grid;place-items:center;color:#b3261e;font-size:13px;padding:16px';
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

  function activeContainer() {
    return state.mode === 'original' ? $('pages') : $('doc');
  }

  function goToPage(n) {
    n = Math.max(1, Math.min(state.doc ? state.doc.numPages : 1, n | 0));
    $('pageNum').value = String(n);
    // Scope to the container actually on screen. A document-wide selector
    // matches the hidden reflow paragraph first (it comes earlier in the DOM),
    // so scrolling to a page in Original layout did nothing at all.
    var host = activeContainer();
    var target = host.querySelector('[data-page="' + n + '"]') ||
                 host.querySelector('[data-placeholder="' + n + '"]');
    if (target) {
      target.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start'
      });
    }
  }

  function prefersReducedMotion() {
    try { return root.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  var pagerTimer = null;
  var pagerWired = false;

  /**
   * Keep the page box in step with the scroll position.
   *
   * Registered ONCE. It used to be called on every mode switch, adding another
   * window listener each time, and it queried the whole document - so it also
   * counted the hidden view's nodes, which have a zero rect and reported the
   * wrong page.
   */
  function syncPagerToScroll() {
    if (pagerWired) return;
    pagerWired = true;
    root.addEventListener('scroll', function () {
      if (!state.doc) return;
      clearTimeout(pagerTimer);
      pagerTimer = setTimeout(function () {
        var mid = (root.innerHeight || 0) * 0.35;
        var nodes = activeContainer().querySelectorAll('[data-page], [data-placeholder]');
        for (var i = nodes.length - 1; i >= 0; i--) {
          var r = nodes[i].getBoundingClientRect();
          if (!r.height && !r.width) continue;          // not laid out
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
      if (!src) return;
      if (src.trusted) loadFromUrl(src.url, true);
      else confirmUrl(src.url);
    });
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
