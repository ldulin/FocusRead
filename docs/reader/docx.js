/*
 * FocusRead - Word (.docx) handling, on top of mammoth.js.
 *
 * Three things this file exists to get right:
 *
 *  1. SNIFF FIRST. A legacy .doc handed to mammoth surfaces an opaque ZIP
 *     parse error. Reading the magic bytes lets us say something useful.
 *  2. SANITISE. mammoth's output is HTML derived from an untrusted file, and
 *     this is an extension page with access to chrome.* APIs. Assigning it to
 *     innerHTML unfiltered is a straightforward XSS sink.
 *  3. SURFACE WARNINGS. mammoth drops equations and silently ACCEPTS tracked
 *     changes. A reader who cannot see that has been misled about the document.
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  var VENDOR = 'vendor/mammoth.browser.min.js';
  var _loading = null;

  /** See FR.pdf.vendorBase - the web build points this at a CDN. */
  function mammothUrl() {
    if (FR.vendorBase && FR.vendorBase.mammoth) return FR.vendorBase.mammoth;
    return chrome.runtime.getURL(VENDOR);
  }

  /** Load mammoth lazily - it is ~640 KB and most sessions never open a .docx. */
  function loadMammoth() {
    if (root.mammoth) return Promise.resolve(root.mammoth);
    if (_loading) return _loading;
    _loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = mammothUrl();
      s.onload = function () {
        root.mammoth
          ? resolve(root.mammoth)
          : reject(new Error('mammoth loaded but did not register itself'));
      };
      s.onerror = function () {
        _loading = null;
        reject(Object.assign(
          new Error('Could not load mammoth.js. In the extension, run scripts/fetch-vendor.sh and reload it.'),
          { code: 'no-vendor' }));
      };
      document.head.appendChild(s);
    });
    return _loading;
  }

  /* ------------------------------------------------------------------ *
   * Format sniffing
   * ------------------------------------------------------------------ */

  function sniff(buffer) {
    var b = new Uint8Array(buffer.slice(0, 8));
    var hex = Array.prototype.map.call(b, function (x) {
      return ('0' + x.toString(16)).slice(-2);
    }).join('').toUpperCase();

    if (hex.indexOf('504B0304') === 0) return 'docx';           // PK.. zip
    if (hex.indexOf('D0CF11E0A1B11AE1') === 0) return 'doc';    // OLE2 compound file
    if (hex.indexOf('7B5C727466') === 0) return 'rtf';          // {\rtf
    if (hex.indexOf('25504446') === 0) return 'pdf';            // %PDF
    return 'unknown';
  }

  /* ------------------------------------------------------------------ *
   * Sanitiser
   *
   * Allowlist only. Anything not named here is unwrapped (children kept) or,
   * for genuinely dangerous elements, removed outright.
   * ------------------------------------------------------------------ */

  var ALLOWED = {
    P: 1, BR: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1, PRE: 1, CODE: 1, HR: 1,
    STRONG: 1, B: 1, EM: 1, I: 1, U: 1, S: 1, SUP: 1, SUB: 1, SMALL: 1, MARK: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, TR: 1, TD: 1, TH: 1, CAPTION: 1,
    A: 1, IMG: 1, SPAN: 1, DIV: 1, FIGURE: 1, FIGCAPTION: 1
  };
  var DROP_ENTIRELY = {
    SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1,
    BASE: 1, FORM: 1, INPUT: 1, BUTTON: 1, SELECT: 1, TEXTAREA: 1, SVG: 1
  };
  var KEEP_ATTR = {
    A: ['href', 'title'],
    IMG: ['src', 'alt', 'width', 'height'],
    TD: ['colspan', 'rowspan'],
    TH: ['colspan', 'rowspan', 'scope']
  };

  function safeHref(v) { return /^(https?:|mailto:|#)/i.test(String(v).trim()); }
  function safeSrc(v) { return /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,/i.test(String(v).trim()); }

  function sanitize(html) {
    var doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
    var body = doc.body;

    // Depth-first, bottom-up, so unwrapping a parent cannot skip children.
    var all = Array.prototype.slice.call(body.querySelectorAll('*')).reverse();
    all.forEach(function (el) {
      // tagName is case-SENSITIVE for foreign content: an <svg> element reports
      // "svg", so an uppercase lookup missed it entirely and the element was
      // merely unwrapped - spilling the text of any <script> or <style> inside
      // it into the document as visible prose.
      var tag = String(el.tagName || '').toUpperCase();
      if (!el.isConnected) return;                  // removed with an ancestor

      if (DROP_ENTIRELY[tag] ||
          (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/1999/xhtml')) {
        el.remove();
        return;
      }

      if (!ALLOWED[tag]) {                       // unknown tag: keep the text
        var parent = el.parentNode;
        if (!parent) return;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
        return;
      }

      var keep = KEEP_ATTR[tag] || [];
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        var n = attr.name.toLowerCase();
        if (keep.indexOf(n) === -1) { el.removeAttribute(attr.name); return; }
        if (n === 'href' && !safeHref(attr.value)) el.removeAttribute(attr.name);
        if (n === 'src' && !safeSrc(attr.value)) el.removeAttribute(attr.name);
      });

      if (tag === 'A') {
        el.setAttribute('rel', 'noopener noreferrer nofollow');
        el.setAttribute('target', '_blank');
      }
      if (tag === 'IMG' && !el.getAttribute('src')) el.remove();
    });

    return body.innerHTML;
  }

  /* ------------------------------------------------------------------ *
   * Tracked changes
   *
   * mammoth keeps insertions and discards deletions with no warning at all, so
   * the reader would see a clean "final" document and never know it was a
   * marked-up draft. Peek at the raw XML ourselves.
   * ------------------------------------------------------------------ */

  function hasTrackedChanges(buffer) {
    try {
      var bytes = new Uint8Array(buffer);
      // Cheap scan of the raw (compressed) container for the literal tag names.
      // Not exhaustive, but zip entries for small XML are often stored with
      // enough plaintext for this to hit; a miss just means no warning.
      var text = '';
      var limit = Math.min(bytes.length, 3000000);
      for (var i = 0; i < limit; i++) text += String.fromCharCode(bytes[i]);
      return /w:ins\b/.test(text) || /w:del\b/.test(text);
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Public
   * ------------------------------------------------------------------ */

  /**
   * @param {ArrayBuffer} buffer
   * @returns {Promise<{html:string, notices:string[]}>}
   */
  function open(buffer) {
    var kind = sniff(buffer);

    if (kind === 'doc') {
      return Promise.reject(Object.assign(new Error(
        'This is a Word 97-2003 (.doc) file, which browsers cannot read. ' +
        'Open it in Word, Pages, Google Docs or LibreOffice and save it as .docx, then try again.'
      ), { code: 'legacy-doc' }));
    }
    if (kind === 'rtf') {
      return Promise.reject(Object.assign(new Error(
        'This is an RTF file. Save it as .docx and try again.'), { code: 'rtf' }));
    }
    if (kind === 'pdf') {
      return Promise.reject(Object.assign(new Error(
        'This file is actually a PDF despite its name.'), { code: 'is-pdf' }));
    }
    if (kind !== 'docx') {
      return Promise.reject(Object.assign(new Error(
        'This does not look like a Word document.'), { code: 'unknown-format' }));
    }

    var tracked = hasTrackedChanges(buffer);

    return loadMammoth().then(function (mammoth) {
      // The browser build accepts {arrayBuffer} and nothing else.
      return mammoth.convertToHtml({ arrayBuffer: buffer }, {
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
          "p[style-name='Quote'] => blockquote:fresh",
          "p[style-name='Intense Quote'] => blockquote:fresh",
          'u => u'
        ]
      });
    }).then(function (result) {
      var notices = [];
      var messages = result.messages || [];

      var dropped = messages.filter(function (m) {
        return /unrecognised|unrecognized/i.test(m.message || '');
      });
      if (dropped.length) {
        var equations = dropped.filter(function (m) { return /oMath|equation/i.test(m.message || ''); });
        if (equations.length) {
          notices.push('Equations in this document could not be converted and are missing from the text.');
        }
        notices.push(dropped.length + ' element' + (dropped.length === 1 ? '' : 's') +
                     ' could not be converted (formatting or embedded objects).');
      }
      if (tracked) {
        notices.push('This document contains tracked changes. What you see below is the ACCEPTED version: ' +
                     'insertions are included and deletions are gone.');
      }
      notices.push('Word formatting is simplified to readable text: table borders, colours and spacing are not preserved.');

      return { html: sanitize(result.value || ''), notices: notices };
    });
  }

  FR.docx = { open: open, sniff: sniff, sanitize: sanitize };
})(typeof globalThis !== 'undefined' ? globalThis : self);
