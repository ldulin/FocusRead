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
    heads: null,
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

    // Handed over by the toolbar button, through session storage: see
    // openReaderWith in the service worker for why it does not travel in the
    // URL. Only the extension can put an entry there, so this one is trusted -
    // and consumed, so a reload does not silently fetch it a second time.
    var h = /[?&]handoff=([A-Za-z0-9]+)/.exec(search);
    if (h && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
      return new Promise(function (resolve) {
        var key = 'handoff:' + h[1];
        chrome.storage.session.get(key, function (got) {
          var entry = got && got[key];
          try { chrome.storage.session.remove(key); } catch (e) { /* noop */ }
          if (!entry || !entry.url) return resolve(null);
          // A stale entry is not worth fetching: the tab it was made for was
          // never opened, and the address may no longer be what was meant.
          if (Date.now() - (entry.at || 0) > 60000) return resolve(null);
          resolve({ url: entry.url, trusted: true });
        });
      });
    }

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
  /**
   * Ask for access to one site, then try again. Returns false when this is not
   * the kind of failure a permission would fix.
   * @returns {boolean} whether it took over the error display
   */
  function offerHostAccess(url, gen) {
    if (typeof chrome === 'undefined' || !chrome.permissions) return false;
    var origin;
    try {
      var u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return false;
      origin = u.protocol + '//' + u.host + '/*';
    } catch (e) { return false; }

    hideStatus();
    $('drop').hidden = false;
    var box = $('dropError');
    box.hidden = false;
    box.textContent = '';

    var p = document.createElement('p');
    p.textContent = 'FocusRead could not fetch that document. It needs your ' +
                    'permission to read files from this site:';
    var code = document.createElement('code');
    code.textContent = origin;
    code.style.cssText = 'display:block;margin:8px 0;word-break:break-all;font-size:12px';

    var go = document.createElement('button');
    go.className = 'primary';
    go.textContent = 'Allow and open';
    go.addEventListener('click', function () {
      go.disabled = true;
      chrome.permissions.request({ origins: [origin] }, function (granted) {
        if (!granted) {
          go.disabled = false;
          go.textContent = 'Allow and open';
          return;
        }
        box.hidden = true;
        // With the permission in hand, cookies can go too: a paper behind an
        // institutional login needs them, and CORS no longer applies.
        loadFromUrl(url, true, gen === undefined ? undefined : beginLoad(), true);
      });
    });

    box.appendChild(p);
    box.appendChild(code);
    box.appendChild(go);
    return true;
  }

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
    state.heads = null;
    state.kind = null;
    state.rendered = new Set();
    state.fitWidth = 0;
    $('doc').hidden = true;
    $('doc').innerHTML = '';
    $('pages').hidden = true;
    $('pages').innerHTML = '';
    $('modes').hidden = true;
    $('pager').hidden = true;
    $('notices').hidden = true;
    $('splitBar').hidden = true;
    $('zoom').hidden = true;
    $('textSize').hidden = true;
    document.body.classList.remove('split');
  }

  /**
   * What had to be guessed or dropped while rebuilding the document.
   *
   * Folded away by default: it is worth being able to check what was skipped,
   * but it is read once, and left open it costs a block of the reading space
   * on every page - in side-by-side it spans the whole grid row and takes the
   * height off both panes.
   */
  function showNotices(list) {
    var box = $('notices');
    if (!list || !list.length) { box.hidden = true; return; }
    box.hidden = false;
    box.textContent = '';

    var fold = document.createElement('details');
    var sum = document.createElement('summary');
    sum.textContent = 'About this document (' + list.length +
                      (list.length === 1 ? ' note)' : ' notes)');
    fold.appendChild(sum);

    var ul = document.createElement('ul');
    list.forEach(function (n) {
      var li = document.createElement('li');
      li.textContent = n;
      ul.appendChild(li);
    });
    fold.appendChild(ul);
    box.appendChild(fold);
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

  /**
   * Read a local file the browser is already showing, as bytes.
   *
   * pdf.js fetches a file:// address through the same machinery it uses for
   * the network, and a file read carries no HTTP status line - the 0 it gets
   * back reads as a failed request, which is the "Unexpected server response
   * (0)" this used to end in. Reading the bytes here settles it, and hands the
   * document to exactly the same code as a file dropped on the window.
   *
   * XMLHttpRequest rather than fetch: fetch refuses the file: scheme outright.
   * Both need "Allow access to file URLs", checked before this is called.
   */
  function readLocalFile(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      try {
        xhr.open('GET', url);
        xhr.responseType = 'arraybuffer';
      } catch (e) {
        return reject(new Error('that address cannot be opened directly'));
      }
      xhr.onload = function () {
        // No status line to check, so the bytes are the only evidence.
        if (xhr.response && xhr.response.byteLength) return resolve(xhr.response);
        reject(new Error('the file came back empty (status ' + xhr.status + ')'));
      };
      xhr.onerror = function () {
        // Both requirements were checked before this, so a refusal here is
        // most likely the file itself rather than the permissions.
        reject(new Error('the browser refused to read it (status ' + xhr.status + '). ' +
                         'If the file has been moved or renamed, open it from the browser ' +
                         'again; otherwise drop it onto this window, which always works'));
      };
      try { xhr.send(); } catch (e) { reject(new Error('the file could not be read')); }
    });
  }

  /**
   * @param {string} url
   * @param {boolean} trusted whether this address came from us rather than a page
   * @param {number} [existingGen]
   * @param {boolean} [creds] send cookies - only after the host permission has
   *   been granted, and only because a document behind a login needs them
   */
  function loadFromUrl(url, trusted, existingGen, creds) {
    var gen = existingGen === undefined ? beginLoad() : existingGen;
    var base = String(url).split(/[?#]/)[0].split('/').pop() || 'document.pdf';
    var name;
    try { name = decodeURIComponent(base); } catch (e) { name = base; }
    setFileName(name);
    showStatus('Fetching ' + name + '...', 0.05);

    if (/^file:/i.test(url)) {
      // Extensions cannot read file:// until the user turns it on explicitly.
      return Promise.all([chromeAllowsFiles(), hasFilePermission()]).then(function (r) {
        if (stale(gen)) return;
        if (!r[0]) {
          showError('To open local files by URL, enable "Allow access to file URLs" for FocusRead on the ' +
                    'chrome://extensions page. Or just drop the file onto this window, which needs no permission.');
          return;
        }
        if (!r[1]) {
          showError('This copy of FocusRead does not have permission to read local files. Reload it on the ' +
                    'chrome://extensions page - Settings should then show v0.2.3 or later. Or drop the file ' +
                    'onto this window, which needs no permission at all.');
          return;
        }
        // Read the bytes here rather than handing pdf.js the address: see
        // readLocalFile. Once they are bytes this is the same path a file
        // dropped on the window takes, so .docx works too.
        return readLocalFile(url).then(function (buf) {
          if (stale(gen)) return;
          showStatus('Opening ' + name + '...', 0.35);
          var isPdf = /\.pdf(\?|#|$)/i.test(url) || (FR.docx.sniff(buf) === 'pdf');
          return isPdf ? loadPdf({ data: buf }, false, gen) : loadDocx(buf, gen);
        });
      }).catch(function (e) {
        if (stale(gen)) return;
        showError('Could not open that file: ' + (e.message || e));
      });
    }
    return loadPdf({ url: url }, creds, gen).catch(function (e) {
      if (stale(gen)) return;
      // A cross-origin fetch the extension has no host permission for fails
      // here, and no wording can fix that - only the permission can. Offer it
      // at the moment it is needed rather than asking for every site up front.
      if (offerHostAccess(url, gen)) return;
      showError('Could not open that PDF: ' + (e.message || e));
    });
  }

  /*
   * Reading a local file needs TWO independent things, and only one of them is
   * the switch everyone knows about:
   *
   *   1. the user's "Allow access to file URLs" toggle, which nothing but the
   *      user can turn on, and
   *   2. a file-scheme host permission in the extension itself. The wildcard
   *      that looks like it covers everything covers http and https only, so
   *      the file scheme has to be asked for by name.
   *
   * With the toggle on and the permission missing the read simply fails, which
   * is indistinguishable from a missing file unless they are checked apart.
   */
  function chromeAllowsFiles() {
    return new Promise(function (resolve) {
      if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
        chrome.extension.isAllowedFileSchemeAccess(resolve);
      } else {
        resolve(false);
      }
    });
  }

  function hasFilePermission() {
    return new Promise(function (resolve) {
      if (typeof chrome === 'undefined' || !chrome.permissions) return resolve(false);
      chrome.permissions.contains({ origins: ['file:///*'] }, function (has) {
        resolve(!!has);
      });
    });
  }

  function loadPdf(source, creds, gen) {
    state.kind = 'pdf';
    // Only http(s), and only when asked for. A response that says
    // "Access-Control-Allow-Origin: *" - which is most open repositories,
    // arXiv included - fails the CORS check outright if credentials are
    // requested, so asking for them up front turns papers that would have
    // opened with no permission at all into ones that need one.
    if (source.url && /^https?:/i.test(source.url)) source.withCredentials = !!creds;

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
      state.heads = out.heads || {};
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
    // Not in split view: there the reading pane is beside these pages, and a
    // zoom re-renders through here without going back through renderSplit -
    // which is what would otherwise put the right-hand pane back.
    if (state.mode !== 'split') $('doc').hidden = true;
    hideStatus();

    // Size to the CONTAINER, not the window: in split view the pane is roughly
    // half the width, and sizing from the window made every page overflow it.
    //
    // Measured once per layout and then held: a zoomed page overflows the pane
    // horizontally, which brings up a scrollbar, which narrows clientWidth,
    // which would make the committed render come out a few percent smaller
    // than the preview that was just on screen - a visible snap on every zoom.
    // Holding it also makes zoom exactly proportional, which is what the
    // preview assumes.
    if (!state.fitWidth) {
      var avail = host.clientWidth || (root.innerWidth || 900);
      state.fitWidth = Math.max(260, Math.min(900, avail - 34));
    }
    var width = Math.max(160, state.fitWidth * zoom());

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
          FR.pdf.renderPage(doc, state.mod, n, host, scale, slot, renderOpts()).catch(function (err) {
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
      zoomShown = zoom();          // what the canvases are now drawn at

      if (skipController) return null;
      return attachController(host, false);
    });
  }

  /* ------------------------------------------------------------------ *
   * Zoom
   *
   * 1 means "fit the page to its pane", which is what the view has always
   * done; anything else multiplies that. Changing it re-renders, because the
   * page is a canvas - scaling it with CSS would just blur it, and the text
   * layer would stop lining up with the glyphs.
   * ------------------------------------------------------------------ */

  var ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
  var TEXT_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2];

  /* ------------------------------------------------------------------ *
   * Reading-view text size
   *
   * The same fontScale the Settings page exposes, so there is one answer to
   * "how big is the text" rather than two that disagree. The reading view in
   * Side by side is the same element, so it follows along.
   * ------------------------------------------------------------------ */

  function textScale() {
    var v = state.settings ? Number(state.settings.fontScale) : 1;
    return isFinite(v) && v > 0 ? Math.min(2, Math.max(0.8, v)) : 1;
  }

  function showTextSize() {
    var v = textScale();
    $('textLevel').textContent = Math.round(v * 100) + '%';
    $('textSmaller').disabled = v <= TEXT_STEPS[0];
    $('textBigger').disabled = v >= TEXT_STEPS[TEXT_STEPS.length - 1];
    // Set it here too rather than waiting for the settings round trip, so the
    // text resizes on the click instead of a moment after it.
    document.documentElement.style.setProperty('--fr-scale', String(v));
  }

  function setTextScale(v) {
    v = Math.min(2, Math.max(0.8, v));
    if (!state.settings || Math.abs(v - textScale()) < 0.001) return;
    state.settings.fontScale = v;
    FR.settings.set({ fontScale: v });
    showTextSize();
  }

  function stepText(dir) {
    var v = textScale();
    var i;
    if (dir > 0) {
      for (i = 0; i < TEXT_STEPS.length; i++) {
        if (TEXT_STEPS[i] > v + 0.001) return setTextScale(TEXT_STEPS[i]);
      }
    } else {
      for (i = TEXT_STEPS.length - 1; i >= 0; i--) {
        if (TEXT_STEPS[i] < v - 0.001) return setTextScale(TEXT_STEPS[i]);
      }
    }
  }

  function zoom() {
    var z = state.settings ? Number(state.settings.pdfZoom) : 1;
    return isFinite(z) && z > 0 ? Math.min(3, Math.max(0.5, z)) : 1;
  }

  function showZoom() {
    var z = zoom();
    $('zoomLevel').textContent = Math.round(z * 100) + '%';
    $('zoomOut').disabled = z <= ZOOM_STEPS[0];
    $('zoomIn').disabled = z >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
    $('zoomFit').disabled = z === 1;
    $('pages').classList.toggle('zoomed', z > 1);
  }

  /**
   * Zoom, holding one point of the page still.
   *
   * Everything scales by the same factor, so where a point sits in the
   * document is a pair of fractions that survive the re-render; putting the
   * anchor back under the same screen position afterwards is what makes a
   * zoom feel like a zoom. Anchoring the scroll TOP instead - and leaving
   * scrollLeft alone entirely - drops you at the left edge of a page that is
   * now wider than the pane, which is not where you were looking.
   *
   * @param {number} z the new scale
   * @param {{x:number, y:number}} [at] point to hold, in pane coordinates;
   *   the middle of the pane if not given, or the pointer for a wheel zoom
   */
  /*
   * Re-rendering every page is far too slow to do on each step of a zoom - and
   * going through setMode also tore down the reading pane and the controller,
   * which a zoom does not touch at all. So a zoom now happens in two parts:
   * the pages are scaled on the spot with a transform, which is instant and
   * keeps the layout honest because the wrappers are resized to match, and the
   * real re-render follows once the zooming stops. A burst of clicks costs one
   * re-render instead of one each.
   */
  var zoomTimer = null;
  var zoomShown = 1;          // the scale the canvases were actually drawn at

  function previewZoom(z) {
    var host = $('pages');
    var k = z / zoomShown;
    host.style.setProperty('--fr-preview', String(k));
    host.classList.toggle('previewing', Math.abs(k - 1) > 0.001);
    // Resize the wrappers so the scrollable area, and therefore every scroll
    // position computed from it, matches what is on screen.
    Array.prototype.forEach.call(host.children, function (el) {
      if (!el.dataset) return;
      if (el.dataset.baseW === undefined) {
        // Captured before this element has ever been scaled, so it is the
        // size the canvas was actually drawn at.
        el.dataset.baseW = String(el.offsetWidth);
        el.dataset.baseH = String(el.offsetHeight);
      }
      el.style.width = Math.floor(Number(el.dataset.baseW) * k) + 'px';
      el.style.height = Math.floor(Number(el.dataset.baseH) * k) + 'px';
    });
  }

  function setZoom(z, at) {
    z = Math.min(3, Math.max(0.5, z));
    if (!state.settings) return;
    if (Math.abs(z - zoom()) < 0.001) return;
    state.settings.pdfZoom = z;
    FR.settings.set({ pdfZoom: z });
    showZoom();
    // Only the page-image views care.
    if (state.mode !== 'original' && state.mode !== 'split') return;

    var pane = $('pages');
    var ax = at ? at.x : pane.clientWidth / 2;
    var ay = at ? at.y : pane.clientHeight / 2;
    var fx = (pane.scrollLeft + ax) / Math.max(1, pane.scrollWidth);
    var fy = (pane.scrollTop + ay) / Math.max(1, pane.scrollHeight);

    previewZoom(z);
    // The preview changed the layout synchronously, so the point that was
    // under the cursor can be put back under it now.
    pane.scrollLeft = fx * pane.scrollWidth - ax;
    pane.scrollTop = fy * pane.scrollHeight - ay;

    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(commitZoom, 220);
  }

  /** Draw the pages properly at the scale the preview is showing. */
  function commitZoom() {
    zoomTimer = null;
    if (state.mode !== 'original' && state.mode !== 'split') return;
    var pane = $('pages');
    var keepL = pane.scrollLeft, keepT = pane.scrollTop;

    // Only the page images. In split view the reading pane and its controller
    // are untouched by a zoom, and rebuilding them was most of what made this
    // slow. In original view the marks live in the page text layer that is
    // about to be thrown away, so that controller does have to be replaced.
    var ownsController = state.mode === 'original';
    if (ownsController && state.controller) {
      state.controller.deactivate();
      state.controller = null;
    }
    renderOriginal(undefined, !ownsController).then(function () {
      zoomShown = zoom();
      pane.style.removeProperty('--fr-preview');
      pane.classList.remove('previewing');
      // Same geometry as the preview was showing, so the scroll carries over.
      pane.scrollLeft = keepL;
      pane.scrollTop = keepT;
    });
  }

  function stepZoom(dir, at) {
    var z = zoom();
    if (dir > 0) {
      for (var i = 0; i < ZOOM_STEPS.length; i++) {
        if (ZOOM_STEPS[i] > z + 0.001) return setZoom(ZOOM_STEPS[i], at);
      }
    } else {
      for (var j = ZOOM_STEPS.length - 1; j >= 0; j--) {
        if (ZOOM_STEPS[j] < z - 0.001) return setZoom(ZOOM_STEPS[j], at);
      }
    }
  }

  function renderOpts() {
    return {
      heads: state.heads || {},
      stripRunningHeads: !state.settings || state.settings.stripRunningHeads !== false
    };
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
        FR.pdf.renderPage(doc, state.mod, page, host, scale, placeholder, renderOpts()).catch(function (err) {
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

    state.fitWidth = 0;                  // the pane's width is about to change
    document.body.classList.toggle('split', mode === 'split');
    $('splitBar').hidden = mode !== 'split';
    $('zoom').hidden = !(mode === 'original' || mode === 'split');
    $('textSize').hidden = !(mode === 'reflow' || mode === 'split');
    showZoom();
    showTextSize();

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
      wireOriginalClicks();
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
    var c = new FR.Controller({
      root: rootEl,
      isReader: true,
      // In the page-image view the text is a layer of absolutely positioned
      // spans; tell the engine which wrapper counts as one paragraph.
      groupSelector: allowBilingual ? null : '.fr-para'
    });
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

  /* ------------------------------------------------------------------ *
   * Clicking the page image jumps the reading pane
   *
   * The two panes are separate engines with their own numbering, and the text
   * does not match character for character: the page image keeps the
   * hyphenation ("inter- national") that the reading view rejoins, and line
   * breaks fall in different places. So match on word overlap within the same
   * page rather than trying to align indices.
   * ------------------------------------------------------------------ */

  function normaliseForMatch(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\u2010-\u2015-]\s+/g, '')       // rejoin "inter- national"
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenSet(text) {
    var seen = Object.create(null);
    normaliseForMatch(text).split(' ').forEach(function (t) {
      if (t.length > 2) seen[t] = true;             // skip "a", "of", "the"
    });
    return seen;
  }

  /** Jaccard-ish overlap, biased towards covering the clicked text. */
  function overlap(clickedTokens, candidate) {
    var cand = tokenSet(candidate);
    var keys = Object.keys(clickedTokens);
    if (!keys.length) return 0;
    var hit = 0;
    keys.forEach(function (k) { if (cand[k]) hit++; });
    return hit / keys.length;
  }

  function pageOfNode(node) {
    var wrap = node && node.closest ? node.closest('[data-page]') : null;
    return wrap ? Number(wrap.getAttribute('data-page')) : null;
  }

  /**
   * @param {string} text  what was clicked on the page image
   * @param {number|null} page
   * @returns {number} sentence index in the reading pane, or -1
   */
  function findReadingSentence(text, page) {
    var c = state.controller;
    if (!c || !c.engine) return -1;
    var clicked = tokenSet(text);
    if (!Object.keys(clicked).length) return -1;

    var best = -1, bestScore = 0;
    c.engine.sentences.forEach(function (rec) {
      // Prefer the same page, but do not require it: a paragraph can straddle
      // a page break, and the reading view stitches those together.
      var recPage = rec.blockEl && rec.blockEl.getAttribute
        ? Number(rec.blockEl.getAttribute('data-page'))
        : null;
      if (page && recPage && Math.abs(recPage - page) > 1) return;

      var score = overlap(clicked, rec.text);
      if (recPage === page) score += 0.05;          // tie-break towards the page
      if (score > bestScore) { bestScore = score; best = rec.i; }
    });

    return bestScore >= 0.45 ? best : -1;
  }

  function wireOriginalClicks() {
    if (state.clickWired) return;
    state.clickWired = true;

    $('pages').addEventListener('click', function (e) {
      if (state.mode !== 'split') return;
      var mark = e.target.closest ? e.target.closest('fr-s[data-i], .textLayer span') : null;
      if (!mark) return;

      // Use the whole sentence when the click landed on one, otherwise the line.
      var text = mark.tagName === 'FR-S'
        ? sentenceTextAt(mark)
        : (mark.textContent || '');
      if (!text.trim()) return;

      var idx = findReadingSentence(text, pageOfNode(mark));
      if (idx < 0) {
        flash(mark, false);
        return;
      }

      var c = state.controller;
      c.engine.setCurrent(idx, { scroll: true });
      c.ui.setState({ index: idx });
      // While it is reading, move the READING, not just the highlight. A
      // merged run would otherwise paint over this within a word - its next
      // word boundary re-asserts whichever sentence the run is on - and even
      // one sentence at a time only honoured the click at the next full stop.
      // Paused counts: play() resumes the utterance that was interrupted, so
      // without dropping it the click would be forgotten on the next press.
      if (c.playing) c.speakCurrent();
      else if (FR.speech.state() === 'paused') FR.speech.cancel();
      flash(mark, true);
    }, true);
  }

  /** Every mark of the clicked sentence, joined. */
  function sentenceTextAt(mark) {
    var i = mark.getAttribute('data-i');
    var all = mark.closest('.textLayer')
      ? mark.closest('.textLayer').querySelectorAll('fr-s[data-i="' + i + '"]')
      : [mark];
    return Array.prototype.map.call(all, function (m) { return m.textContent; }).join(' ');
  }

  function flash(el, found) {
    el.classList.add(found ? 'fr-jumped' : 'fr-nomatch');
    setTimeout(function () { el.classList.remove('fr-jumped', 'fr-nomatch'); }, 900);
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

    $('textBigger').addEventListener('click', function () { stepText(1); });
    $('textSmaller').addEventListener('click', function () { stepText(-1); });

    // About: a panel under the bar rather than a block above the document.
    var about = $('aboutBtn'), panel = $('aboutPanel');
    about.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = panel.hidden;
      panel.hidden = !open;
      about.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (panel.hidden) return;
      if (panel.contains(e.target) || e.target === about) return;
      panel.hidden = true;
      about.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) {
        panel.hidden = true;
        about.setAttribute('aria-expanded', 'false');
        about.focus();
      }
    });

    var resizeTimer = null;
    root.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.mode !== 'original' && state.mode !== 'split') return;
        state.fitWidth = 0;              // re-measure against the new window
        commitZoom();
      }, 220);
    });

    $('zoomIn').addEventListener('click', function () { stepZoom(1); });
    $('zoomOut').addEventListener('click', function () { stepZoom(-1); });
    $('zoomFit').addEventListener('click', function () { setZoom(1); });

    // Ctrl/Cmd + wheel over the pages, the gesture people already expect.
    // Without the modifier the wheel scrolls, which is also what people expect.
    $('pages').addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (state.mode !== 'original' && state.mode !== 'split') return;
      e.preventDefault();
      // Zoom about the pointer, the way every other zoomable view does.
      var box = $('pages').getBoundingClientRect();
      stepZoom(e.deltaY < 0 ? 1 : -1,
               { x: e.clientX - box.left, y: e.clientY - box.top });
    }, { passive: false });

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
    // Settings can change from the Settings page, in this tab or another one.
    // Without this the reader keeps its own copy from load time, and the next
    // A+ or zoom step would then start from a value that is no longer true.
    FR.settings.onChange(function (s) {
      state.settings = s;
      showTextSize();
      showZoom();
    });

    FR.settings.get().then(function (s) {
      state.settings = s;
      state.mode = (s.pdfView === 'original' || s.pdfView === 'split') ? s.pdfView : 'reflow';
      return sourceFromLocation().then(function (src) {
        if (!src) return;
        if (src.trusted) loadFromUrl(src.url, true);
        else confirmUrl(src.url);
      });
    });
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
