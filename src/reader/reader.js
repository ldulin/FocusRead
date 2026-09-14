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
   * Hosts that must never be fetched with the user's cookies on someone else's
   * say-so: loopback, link-local, and the RFC1918 ranges. These are exactly the
   * targets a web page cannot reach itself and would want a confused deputy for.
   */
  var PRIVATE_HOST = new RegExp(
    '^(localhost|127\\.|0\\.0\\.0\\.0$|\\[?::1\\]?$|10\\.|192\\.168\\.|' +
    '169\\.254\\.|172\\.(1[6-9]|2\\d|3[01])\\.|.*\\.local$|.*\\.internal$)', 'i');

  /**
   * @returns {Promise<{url:string, trusted:boolean}|null>}
   *
   * reader.html is web-accessible under a stable chrome-extension:// path, so
   * the "?DNR:" prefix proves nothing on its own - any page can navigate to it
   * or window.open() it and claim the same provenance. Trust therefore requires
   * everything a genuine declarativeNetRequest redirect implies and an attacker
   * cannot arrange:
   *
   *   - we are the top frame (not a hidden iframe),
   *   - nothing scripted opened us (window.opener is null after a real
   *     top-level navigation, and set after window.open),
   *   - the URL is http(s) - the rule can never produce anything else, which
   *     also kills "?DNR:file:///...",
   *   - the intercept feature is actually switched on; if the user never
   *     enabled it, no redirect of ours can have happened,
   *   - the host is not loopback or private.
   *
   * Anything short of all five is treated as untrusted: shown to the user for
   * confirmation and fetched without credentials.
   */
  function sourceFromLocation() {
    var search = location.search || '';

    if (search.indexOf('?DNR:') === 0) {
      // Deliberately NOT decoded. regexSubstitution copies the matched URL in
      // verbatim without percent-encoding it, so decoding here would corrupt
      // any URL that legitimately contains a %-sequence.
      var url = search.slice(5) + (location.hash || '');
      var framed = false;
      try { framed = root.top !== root.self; } catch (e) { framed = true; }
      var opened = !!root.opener;

      var host = '';
      var scheme = '';
      try {
        var u = new URL(url);
        host = u.hostname;
        scheme = u.protocol;
      } catch (e) { /* unparseable */ }

      var shapeOk = /^https?:$/.test(scheme) && host && !PRIVATE_HOST.test(host);
      if (framed || opened || !shapeOk) return Promise.resolve({ url: url, trusted: false });

      return FR.settings.get().then(function (s) {
        return { url: url, trusted: !!s.pdfInterceptLinks };
      });
    }

    var m = /[?&]file=([^&#]+)/.exec(search);
    if (m) {
      var raw;
      try { raw = decodeURIComponent(m[1]); } catch (e) { raw = m[1]; }
      return Promise.resolve({ url: raw, trusted: false });
    }
    return Promise.resolve(null);
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
      go.disabled = true;                 // a second click would start a second load
      box.hidden = true;
      // Route through loadFromUrl so this path gets the same file:// guard,
      // filename, status and error handling as every other entry point.
      loadFromUrl(url, false);
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
    $('splitBar').hidden = true;
    document.body.classList.remove('split');
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

  /*
   * Load generations.
   *
   * Opening a second document while the first is still extracting used to be
   * mutually destructive: the new load's resetDocument() destroyed the old
   * pdf.js document, the old one's chain then rejected with "Worker was
   * destroyed", its catch called showError -> resetDocument, and THAT destroyed
   * the new document. The user ended up with an error and no document, from two
   * perfectly good files.
   *
   * Every entry point takes a generation; every continuation checks it before
   * touching shared state or reporting anything.
   */
  var loadSeq = 0;

  function beginLoad() {
    resetDocument();
    return ++loadSeq;
  }

  function stale(gen) { return gen !== loadSeq; }

  function loadFromFile(file) {
    var gen = beginLoad();
    setFileName(file.name);
    $('dropError').hidden = true;
    showStatus('Reading ' + file.name + '...', 0.1);
    return file.arrayBuffer().then(function (buf) {
      if (stale(gen)) return;
      var isPdf = /\.pdf$/i.test(file.name) || (FR.docx.sniff(buf) === 'pdf');
      return isPdf ? loadPdf({ data: buf }, false, gen) : loadDocx(buf, gen);
    }).catch(function (e) {
      if (stale(gen)) return;          // a superseded load must not report
      showError(e.message || String(e));
    });
  }

  function loadFromUrl(url, trusted, existingGen) {
    var gen = existingGen === undefined ? beginLoad() : existingGen;
    var base = String(url).split(/[?#]/)[0].split('/').pop() || 'document.pdf';
    var name;
    try { name = decodeURIComponent(base); } catch (e) { name = base; }
    setFileName(name);
    showStatus('Fetching ' + name + '...', 0.05);

    if (/^file:/i.test(url)) {
      // Extensions cannot read file:// until the user turns it on explicitly.
      return chromeAllowsFiles().then(function (allowed) {
        if (stale(gen)) return;
        if (!allowed) {
          showError('To open local files by URL, enable "Allow access to file URLs" for FocusRead on the ' +
                    'chrome://extensions page. Or just drop the file onto this window, which needs no permission.');
          return;
        }
        return loadPdf({ url: url }, trusted, gen);
      }).catch(function (e) {
        if (stale(gen)) return;
        showError('Could not open that file: ' + (e.message || e));
      });
    }
    return loadPdf({ url: url }, trusted, gen).catch(function (e) {
      if (stale(gen)) return;
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

  function loadPdf(source, trusted, gen) {
    state.kind = 'pdf';
    if (source.url) source.withCredentials = !!trusted;

    return FR.pdf.open(source, function (f) {
      if (stale(gen)) return;          // do not repaint over a newer load
      showStatus('Downloading...', f * 0.4);
    }).then(function (res) {
      // Hold the document locally. Reading state.doc in a later .then lets a
      // reset that lands mid-chain hand this load a null.
      var doc = res.doc;
      if (stale(gen)) {
        // Otherwise a superseded load leaks a live worker for the tab's life.
        try { doc.destroy(); } catch (e) { /* noop */ }
        return null;
      }
      state.doc = doc;
      state.mod = res.mod;
      $('modes').hidden = false;
      $('pager').hidden = false;
      $('pageCount').textContent = '/ ' + doc.numPages;
      $('pageNum').max = String(doc.numPages);

      return FR.settings.get().then(function (s) {
        if (stale(gen)) return null;
        showStatus('Extracting text...', 0.5);
        return FR.pdf.extractReflow(doc, {
          stripRunningHeads: s.stripRunningHeads,
          joinHyphens: s.joinHyphens
        }, function (f) {
          if (stale(gen)) return;
          showStatus('Extracting text... page ' + Math.round(f * doc.numPages), 0.5 + f * 0.45);
        });
      });
    }).then(function (out) {
      if (!out || stale(gen)) return;
      state.blocks = out.blocks;
      showNotices(out.notices);
      return setMode(state.mode, gen);
    });
  }

  function loadDocx(buffer, gen) {
    state.kind = 'docx';
    showStatus('Converting Word document...', 0.4);
    return FR.docx.open(buffer).then(function (out) {
      if (stale(gen)) return;
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
    buildReflow();
    $('doc').hidden = false;
    $('pages').hidden = true;
    hideStatus();
    return attachController($('doc'), true);
  }

  function buildReflow() {
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
  }

  function renderOriginal(gen, skipController) {
    var doc = state.doc;
    if (!doc) return Promise.resolve();
    var host = $('pages');
    host.innerHTML = '';
    state.rendered = new Set();
    host.hidden = false;
    $('doc').hidden = true;
    hideStatus();

    // Size to the CONTAINER, not the window: in split view the pane is roughly
    // half the width, and sizing from the window made every page overflow it.
    var avail = host.clientWidth || (root.innerWidth || 900);
    var width = Math.max(260, Math.min(900, avail - 34));

    return doc.getPage(1).then(function (p1) {
      // A reset landing inside this await would null state.doc; use the local.
      if (doc !== state.doc || (gen !== undefined && stale(gen))) return;
      var base = p1.getViewport({ scale: 1 });
      var scale = width / base.width;

      // Placeholders keep the scrollbar honest; pages render as they approach.
      for (var n = 1; n <= doc.numPages; n++) {
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
          FR.pdf.renderPage(doc, state.mod, n, host, scale, slot).catch(function (err) {
            state.rendered.delete(n);          // allow a retry on the next pass
            slot.textContent = 'Could not render page ' + n + ': ' + (err.message || err);
            slot.style.cssText += ';display:grid;place-items:center;color:#b3261e;font-size:13px;padding:16px';
          });
        });
      }, { rootMargin: '900px 0px' });

      Array.prototype.forEach.call(host.children, function (c) { state.io.observe(c); });

      // Render what is already on screen without waiting for the observer.
      // IntersectionObserver callbacks are suspended while a tab is hidden, so
      // a document opened in a background tab would otherwise show nothing but
      // blank placeholders until the reader scrolled.
      renderVisiblePages(host, scale, doc);

      if (skipController) return null;
      return attachController(host, false);
    });
  }

  /** Render every placeholder currently in (or near) view, by geometry. */
  function renderVisiblePages(host, scale, doc) {
    var hostRect = host.getBoundingClientRect();
    var slots = Array.prototype.slice.call(host.querySelectorAll('[data-placeholder]'));
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      var n = Number(slot.getAttribute('data-placeholder'));
      if (!n || state.rendered.has(n)) continue;
      var r = slot.getBoundingClientRect();
      if (r.bottom < hostRect.top - 200) continue;
      if (r.top > hostRect.bottom + 900) break;
      state.rendered.add(n);
      if (state.io) state.io.unobserve(slot);
      (function (page, placeholder) {
        FR.pdf.renderPage(doc, state.mod, page, host, scale, placeholder).catch(function (err) {
          state.rendered.delete(page);
          placeholder.textContent = 'Could not render page ' + page + ': ' + (err.message || err);
        });
      })(n, slot);
    }
  }

  function setMode(mode, gen) {
    if (gen !== undefined && stale(gen)) return Promise.resolve();
    state.mode = mode;
    Array.prototype.forEach.call(document.querySelectorAll('#modes button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-mode') === mode);
    });
    if (state.controller) { state.controller.deactivate(); state.controller = null; }

    document.body.classList.toggle('split', mode === 'split');
    $('splitBar').hidden = mode !== 'split';

    if (mode === 'original') return renderOriginal(gen);
    if (mode === 'split') return renderSplit(gen);
    return renderReflow();
  }

  /**
   * Both views at once: the real pages on the left, the reflowed text on the
   * right. The controller attaches to the reflowed side, so every reading
   * feature works there while the page image stays available for figures.
   */
  function renderSplit(gen) {
    return renderOriginal(gen, true).then(function () {
      if (gen !== undefined && stale(gen)) return;
      buildReflow();
      $('doc').hidden = false;
      $('pages').hidden = false;
      hideStatus();
      wireScrollSync();
      return attachController($('doc'), true).then(function (c) {
        syncPagesToReading();          // start the two panes on the same page
        return c;
      });
    });
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
    // In split view the reflowed text is the one being read, so page
    // navigation targets it and the image pane follows via the scroll sync.
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
        behavior: prefersReducedMotion() ? 'instant' : 'smooth',
        block: 'start'
      });
    }
  }

  function prefersReducedMotion() {
    try { return root.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  /**
   * In split view, follow the reading side with the page image.
   *
   * One-directional on purpose: the text is what you read, so it drives. A
   * two-way sync fights itself as each pane's smooth scroll retriggers the
   * other.
   */
  var syncWired = false;
  var syncTimer = null;

  function wireScrollSync() {
    if (syncWired) return;
    syncWired = true;
    var docEl = $('doc');
    docEl.addEventListener('scroll', function () {
      if (state.mode !== 'split') return;
      if (!$('syncScroll').checked) return;
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncPagesToReading, 90);
    }, { passive: true });
  }

  function syncPagesToReading() {
    if (state.mode !== 'split') return;
    var box = $('syncScroll');
    if (box && !box.checked) return;
    var page = pageAtTop($('doc'));
    if (!page) return;
    var host = $('pages');
    var target = host.querySelector('[data-page="' + page + '"]') ||
                 host.querySelector('[data-placeholder="' + page + '"]');
    if (!target) return;
    // offsetTop is relative to the scrolling pane, so no viewport maths.
    host.scrollTo({ top: Math.max(0, target.offsetTop - 12), behavior: 'auto' });
    $('pageNum').value = String(page);
  }

  /** Which source page is at the top of a scrolling pane? */
  function pageAtTop(pane) {
    var nodes = pane.querySelectorAll('[data-page]');
    var paneTop = pane.getBoundingClientRect().top;
    var best = null;
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (r.bottom < paneTop) { best = nodes[i]; continue; }
      if (r.top <= paneTop + 80) best = nodes[i];
      else break;
    }
    return best ? Number(best.getAttribute('data-page')) : null;
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
      return sourceFromLocation().then(function (src) {
        if (!src) return;
        if (src.trusted) loadFromUrl(src.url, true);
        else confirmUrl(src.url);
      });
    });
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
