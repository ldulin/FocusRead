/*
 * FocusRead - settings page.
 *
 * Data-driven: the schema below is the single description of every setting,
 * and the renderer turns it into controls. Adding a setting means adding one
 * entry here and one default in lib/settings.js - nothing else.
 */
(function () {
  'use strict';
  var FR = globalThis.FR;
  var $ = function (id) { return document.getElementById(id); };
  var settings = null;
  var voices = [];

  function langOptions() {
    return FR.settings.LANGUAGES.map(function (p) { return [p[0], p[1]]; });
  }

  var SCHEMA = [
    {
      tab: 'Reading',
      groups: [{
        title: 'Sentences',
        fields: [
          { key: 'readUnit', type: 'select', label: 'Reading unit',
            hint: 'Clause mode breaks very long academic sentences into shorter pieces, which is easier to follow.',
            options: [['sentence', 'Whole sentences'], ['clause', 'Clauses within long sentences']] },
          { key: 'clauseMaxLen', type: 'number', label: 'Split sentences longer than', min: 80, max: 600, step: 10,
            hint: 'Characters. Only used in clause mode.', showIf: function (s) { return s.readUnit === 'clause'; } },
          { key: 'autoAdvance', type: 'checkbox', label: 'Keep reading',
            hint: 'Move to the next sentence automatically instead of stopping after each one.' },
          { key: 'scrollFollow', type: 'checkbox', label: 'Follow along',
            hint: 'Scroll to keep the sentence being read on screen.' },
          { key: 'pauseBetween', type: 'number', label: 'Pause between sentences', min: 0, max: 3000, step: 50,
            hint: 'Milliseconds of silence. A short pause helps comprehension in a second language.' }
        ]
      }, {
        title: 'Turning on',
        fields: [
          { extensionOnly: true, key: 'autoActivate', type: 'checkbox', label: 'Start automatically everywhere',
            hint: 'Off by default. FocusRead normally only runs on a page after you click the icon, so it needs no standing access to your browsing.' },
          { extensionOnly: true, key: 'autoActivateHosts', type: 'list', label: 'Start automatically on these sites',
            hint: 'One hostname per line, e.g. arxiv.org' },
          { key: 'shortcutsEnabled', type: 'checkbox', label: 'Keyboard shortcuts',
            hint: 'Space, J, K, T, B, F and Escape while the reader is on.' }
        ]
      }]
    },
    {
      tab: 'Voice',
      groups: [{
        title: 'Speech',
        fields: [
          { key: 'voiceFilter', type: 'select', label: 'Which voices to offer',
            options: [['en-US', 'American English only'], ['english', 'All English'], ['all', 'Every installed voice']],
            hint: 'Only the voices that can actually read prose are listed, grouped clearest-first; the singing and buzzing ones macOS ships are left out. Widen this if the list looks short. On a phone the browser usually offers better voices than desktop Chrome does.' },
          { key: 'voiceURI', type: 'voice', label: 'Voice' },
          { key: 'localVoicesOnly', type: 'checkbox', label: 'Prefer on-device voices',
            hint: 'Network voices are the usual cause of speech cutting out, and most of them cannot report which word is being spoken.' },
          { key: 'rate', type: 'range', label: 'Speed', min: 0.5, max: 2, step: 0.05, unit: 'x',
            hint: 'Chrome can go silent above 2x with a network voice, so the range stops there.' },
          { key: 'pitch', type: 'range', label: 'Pitch', min: 0.5, max: 1.8, step: 0.05 },
          { key: 'volume', type: 'range', label: 'Volume', min: 0, max: 1, step: 0.05 },
          { key: 'maxUtteranceChars', type: 'number', label: 'Split speech every', min: 80, max: 400, step: 10,
            hint: 'Characters. Chrome truncates long utterances, so sentences are spoken in pieces. Lower this if speech cuts off.' },
          { key: 'gaplessMode', type: 'select', label: 'Smooth reading',
            options: [['auto', 'On for network voices'], ['always', 'On for every voice'], ['off', 'Off']],
            hint: 'A network voice - anything named "Online" or "Natural" - fetches its audio between utterances, which puts a gap at every sentence break and breaks the sentence-to-sentence rhythm. This reads a whole run of sentences in one request instead, so it flows. On-device voices start the next sentence in about 3ms and have no gap to remove; pick "every voice" if one still sounds choppy, or if a network voice you want is not being smoothed.' },
          { key: 'gaplessChars', type: 'number', label: 'Read ahead in runs of', min: 260, max: 1400, step: 20,
            hint: 'Characters, never crossing a paragraph. Longer runs flow better; shorter ones react faster when you skip. FocusRead shortens this by itself if the voice turns out to cut long stretches off.',
            showIf: function (s) { return s.gaplessMode !== 'off'; } }
        ]
      }, {
        title: 'Getting a better voice',
        note: 'If the voices here sound robotic, it is because macOS only ships the basic ones by default. ' +
              'Open System Settings, go to Accessibility, then Spoken Content, click the (i) next to System Voice, ' +
              'and download an English (US) voice marked Premium or Enhanced - Ava, Allison, Zoe and Tom are the ' +
              'natural-sounding ones. Restart Chrome afterwards and they appear in the list above.',
        fields: []
      }, {
        title: 'Word highlighting',
        fields: [
          { key: 'highlightWords', type: 'checkbox', label: 'Highlight each word as it is spoken' },
          { key: 'wordHighlightLag', type: 'checkbox', label: 'Highlight runs one word ahead',
            hint: 'Some voices report the position of the NEXT word. Turn this on if the highlight is consistently one word in front of what you hear.' }
        ]
      }]
    },
    {
      tab: 'Focus',
      groups: [{
        title: 'Focus aids',
        fields: [
          { key: 'focusMode', type: 'select', label: 'Focus mode',
            options: [['off', 'Off'], ['spotlight', 'Dim everything else'], ['ruler', 'Reading ruler']] },
          { key: 'dimOpacity', type: 'range', label: 'How much to dim', min: 0.05, max: 0.9, step: 0.05 },
          { key: 'highlightStyle', type: 'select', label: 'Sentence highlight',
            options: [['underline', 'Underline'], ['block', 'Filled'], ['box', 'Outline'], ['none', 'Bold only']] },
          { key: 'highlightColor', type: 'color', label: 'Sentence colour' },
          { key: 'wordHighlightColor', type: 'color', label: 'Word colour' }
        ]
      }, {
        title: 'Typography',
        fields: [
          { key: 'typography', type: 'checkbox', label: 'Restyle the page for reading',
            hint: 'Overrides the site\'s own font and spacing. Some layouts will shift.' },
          { key: 'fontFamily', type: 'select', label: 'Font',
            options: [['system', 'System'], ['serif', 'Serif'], ['sans', 'Sans-serif'],
                      ['mono', 'Monospace'], ['dyslexic', 'OpenDyslexic (if installed)']],
            showIf: function (s) { return s.typography; } },
          { key: 'fontScale', type: 'range', label: 'Text size', min: 0.8, max: 2, step: 0.05, unit: 'x',
            showIf: function (s) { return s.typography; } },
          { key: 'lineHeight', type: 'range', label: 'Line spacing', min: 1.2, max: 2.6, step: 0.05,
            showIf: function (s) { return s.typography; } },
          { key: 'letterSpacing', type: 'range', label: 'Letter spacing', min: 0, max: 3, step: 0.1, unit: 'px',
            showIf: function (s) { return s.typography; } },
          { key: 'wordSpacing', type: 'range', label: 'Word spacing', min: 0, max: 12, step: 0.5, unit: 'px',
            showIf: function (s) { return s.typography; } },
          { key: 'maxWidth', type: 'number', label: 'Maximum line width', min: 0, max: 1400, step: 20,
            hint: 'Pixels. 0 leaves the page layout alone. Around 650 is a comfortable measure.' },
          { key: 'paperTint', type: 'select', label: 'Background',
            options: [['none', 'Leave alone'], ['sepia', 'Warm paper'], ['gray', 'Soft grey'], ['dark', 'Dark']] }
        ]
      }, {
        title: 'Bold word beginnings',
        note: 'Bolding the first letters of each word is often claimed to speed up reading. The largest controlled test of it (2,074 readers) found the opposite - slightly slower, with no measured benefit. It is here because some people like it, but it is off by default. This is a plain typographic effect, not the trademarked product of the same idea.',
        fields: [
          { key: 'boldHeads', type: 'checkbox', label: 'Bold the start of each word' },
          { key: 'boldHeadStrength', type: 'range', label: 'How much of each word', min: 0.15, max: 0.8, step: 0.05,
            showIf: function (s) { return s.boldHeads; } }
        ]
      }]
    },
    {
      tab: 'Translation',
      groups: [{
        title: 'Languages',
        fields: [
          { key: 'targetLang', type: 'select', label: 'Translate into', options: langOptions },
          { key: 'sourceLang', type: 'select', label: 'Source language',
            options: function () { return [['auto', 'Detect from the page']].concat(langOptions()); } }
        ]
      }, {
        title: 'Provider',
        fields: [
          { key: 'provider', type: 'select', label: 'Translation engine',
            options: [
              ['auto', 'Automatic (recommended)'],
              ['google-free', 'Google Translate (free, no key)'],
              ['builtin', 'Chrome built-in (free, on-device)'],
              ['mymemory', 'MyMemory (free, no key)'],
              ['libre', 'LibreTranslate (your own server)'],
              ['google', 'Google Cloud Translation (your key)'],
              ['openai', 'OpenAI-compatible endpoint (your key)']
            ],
            hint: 'Automatic tries Chrome\'s on-device translator first, and falls back to Google and then MyMemory if it is not ready - on many machines it never becomes ready, which is why this is the default. Google Translate here is the keyless endpoint the Google Translate widget itself uses: no setup, good quality, but undocumented, so it can change without notice.' +
              (FR.isWeb ? ' On the web there is no extension worker to make the request, so the engine must allow cross-origin calls: Google and MyMemory do, and a self-hosted LibreTranslate needs CORS enabled.' : '') },
          { key: 'providerConfig.mymemory.email', type: 'text', label: 'Your email for MyMemory',
            hint: 'Optional. Supplying your own address raises the free daily allowance to about 50,000 characters. It is sent to MyMemory with each request and stored only on this machine.',
            showIf: function (s) { return s.provider === 'mymemory'; } },
          { key: 'providerConfig.libre.url', type: 'text', label: 'LibreTranslate URL',
            hint: 'For example http://localhost:5000. Public mirrors rate-limit anonymous use heavily, so a server you run yourself is the reliable option.',
            showIf: function (s) { return s.provider === 'libre'; } },
          { key: 'providerConfig.libre.key', type: 'password', label: 'LibreTranslate key',
            showIf: function (s) { return s.provider === 'libre'; } },
          { key: 'providerConfig.google.key', type: 'password', label: 'Google Cloud API key',
            hint: 'A Cloud Translation API key. 500,000 characters a month are free. Stored only on this machine.',
            showIf: function (s) { return s.provider === 'google'; } },
          { key: 'providerConfig.openai.url', type: 'text', label: 'API base URL',
            showIf: function (s) { return s.provider === 'openai'; } },
          { key: 'providerConfig.openai.key', type: 'password', label: 'API key',
            showIf: function (s) { return s.provider === 'openai'; } },
          { key: 'providerConfig.openai.model', type: 'text', label: 'Model',
            showIf: function (s) { return s.provider === 'openai'; } }
        ]
      }, {
        title: 'Behaviour',
        fields: [
          { key: 'bilingual', type: 'checkbox', label: 'Show a translation under every sentence',
            hint: 'Sentences are translated as they scroll into view, so opening a long paper does not spend your whole daily quota at once.' },
          { key: 'bilingualScale', type: 'range', label: 'Translation text size', min: 0.7, max: 1.2, step: 0.02, unit: 'x',
            showIf: function (s) { return s.bilingual; } },
          { key: 'translateOnSelect', type: 'checkbox', label: 'Translate when I select text' },
          { key: 'translateCurrentKey', type: 'checkbox', label: 'T translates the current sentence' },
          { key: 'speakTranslation', type: 'checkbox', label: 'Read the translation aloud too',
            hint: 'After each sentence is read in the source language, hear its translation before moving on. Needs a voice installed for your target language.' },
          { key: 'cacheTranslations', type: 'checkbox', label: 'Remember translations',
            hint: 'Avoids re-translating the same sentence, which matters on metered free tiers.' }
        ]
      }]
    },
    {
      tab: 'Documents',
      groups: [{
        title: 'PDF and Word',
        fields: [
          { key: 'pdfView', type: 'select', label: 'Default PDF view',
            options: [
              ['split', 'Side by side'],
              ['reflow', 'Reading view (clean text)'],
              ['original', 'Original layout']
            ],
            hint: 'Side by side shows the real page on the left and the reflowed text on the right, and clicking a line on the page jumps the reading pane to that sentence. Reading view is the text alone. Original layout is the pages alone, where there is no room for inline translation.' },
          { key: 'stripRunningHeads', type: 'checkbox', label: 'Drop repeated headers and page numbers',
            hint: 'Stops the journal name being read aloud in the middle of a paragraph.' },
          { key: 'joinHyphens', type: 'checkbox', label: 'Rejoin words split across lines',
            hint: 'Turns "inter-" / "national" back into "international".' },
          { extensionOnly: true, key: 'pdfInterceptLinks', type: 'pdfIntercept', label: 'Open PDF links in FocusRead',
            hint: 'Redirects .pdf page loads to the FocusRead reader instead of Chrome\'s viewer. This needs permission to read and redirect web requests, so it is off unless you ask for it. Local files also need "Allow access to file URLs" on the extensions page.' }
        ]
      }]
    }
  ];

  /* ------------------------------------------------------------------ *
   * Value access - supports dotted keys like providerConfig.google.key
   * ------------------------------------------------------------------ */

  function getVal(obj, path) {
    return path.split('.').reduce(function (o, k) { return (o == null ? undefined : o[k]); }, obj);
  }
  function patchFor(path, value) {
    var parts = path.split('.');
    var patch = {}, cur = patch;
    for (var i = 0; i < parts.length - 1; i++) { cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = value;
    return patch;
  }

  /**
   * Ask for an optional permission.
   *
   * Must be called synchronously from inside a user-gesture handler:
   * chrome.permissions.request() requires transient activation, which is why
   * routing it through the service worker (as this used to) always failed.
   */
  function requestPermission(request) {
    return new Promise(function (resolve) {
      try {
        chrome.permissions.request(request, function (granted) {
          resolve(!!granted && !chrome.runtime.lastError);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  /**
   * "http://localhost:11434/v1" -> "http://localhost/*"
   *
   * Uses hostname, NOT host: a Chrome match pattern may not contain a port,
   * and one that does is rejected outright - which meant a self-hosted
   * LibreTranslate or Ollama on any non-default port could not even be saved.
   * That is the documented example for the field.
   */
  function originPattern(url) {
    try {
      var u = new URL(String(url));
      if (!/^https?:$/.test(u.protocol)) return null;
      if (!u.hostname) return null;
      return u.protocol + '//' + u.hostname + '/*';
    } catch (e) {
      return null;
    }
  }

  var savedTimer = null;
  function flashSaved() {
    $('saved').hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(function () { $('saved').hidden = true; }, 1400);
  }

  function save(path, value) {
    return FR.settings.set(patchFor(path, value)).then(function (next) {
      settings = next;
      flashSaved();
      refreshVisibility();
    });
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function makeField(f) {
    var row = document.createElement('div');
    row.className = 'field';
    row.dataset.key = f.key;

    var label = document.createElement('div');
    label.className = 'label';
    var b = document.createElement('b');
    b.textContent = f.label;
    label.appendChild(b);
    if (f.hint) {
      var h = document.createElement('span');
      h.className = 'hint';
      h.textContent = f.hint;
      label.appendChild(h);
    }

    var msg = document.createElement('span');
    msg.className = 'fieldnote';
    msg.dataset.note = f.key;
    msg.hidden = true;
    label.appendChild(msg);

    var control = document.createElement('div');
    control.className = 'control';
    control.appendChild(buildControl(f));

    row.appendChild(label);
    row.appendChild(control);
    return row;
  }

  /** Show (or clear) an inline message under one field. */
  function note(key, text) {
    var el2 = document.querySelector('[data-note="' + CSS.escape(key) + '"]');
    if (!el2) return;
    el2.textContent = text || '';
    el2.hidden = !text;
  }

  function buildControl(f) {
    var v = getVal(settings, f.key);

    if (f.type === 'checkbox') {
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!v;
      cb.addEventListener('change', function () {
        // Running on every page without being asked needs access to every page.
        if (f.key === 'autoActivate' && cb.checked) {
          requestPermission({ origins: ['*://*/*'] }).then(function (granted) {
            if (!granted) {
              cb.checked = false;
              note(f.key, 'FocusRead needs access to all sites to start by itself. Nothing was changed.');
              return;
            }
            note(f.key, '');
            save(f.key, true);
          });
          return;
        }
        save(f.key, cb.checked);
      });
      return cb;
    }

    if (f.type === 'select' || f.type === 'voice') {
      var sel = document.createElement('select');
      var opts = f.type === 'voice' ? voiceOptions()
                                    : (typeof f.options === 'function' ? f.options() : f.options);
      opts.forEach(function (o) {
        // A group, or a plain [value, label] pair.
        if (o && o.group) {
          var grp = document.createElement('optgroup');
          grp.label = o.group;
          o.options.forEach(function (pair) {
            var child = document.createElement('option');
            child.value = pair[0];
            child.textContent = pair[1];
            grp.appendChild(child);
          });
          sel.appendChild(grp);
          return;
        }
        var opt = document.createElement('option');
        opt.value = o[0];
        opt.textContent = o[1];
        sel.appendChild(opt);
      });
      sel.value = v == null ? '' : String(v);
      sel.addEventListener('change', function () { save(f.key, sel.value); });
      return sel;
    }

    if (f.type === 'range') {
      var wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '8px';
      var r = document.createElement('input');
      r.type = 'range';
      r.min = f.min; r.max = f.max; r.step = f.step;
      r.value = String(v);
      var out = document.createElement('output');
      var show = function () { out.textContent = Number(r.value).toFixed(2).replace(/\.?0+$/, '') + (f.unit || ''); };
      show();
      r.addEventListener('input', show);
      r.addEventListener('change', function () { save(f.key, Number(r.value)); });
      wrap.appendChild(r);
      wrap.appendChild(out);
      return wrap;
    }

    if (f.type === 'number') {
      var n = document.createElement('input');
      n.type = 'number';
      n.min = f.min; n.max = f.max; n.step = f.step;
      n.value = String(v);
      n.addEventListener('change', function () { save(f.key, Number(n.value)); });
      return n;
    }

    if (f.type === 'color') {
      var c = document.createElement('input');
      c.type = 'color';
      c.value = String(v || '#f5c518');
      c.addEventListener('change', function () { save(f.key, c.value); });
      return c;
    }

    if (f.type === 'list') {
      var ta = document.createElement('textarea');
      ta.value = (v || []).join('\n');
      ta.placeholder = 'arxiv.org';
      ta.addEventListener('change', function () {
        var hosts = ta.value.split('\n')
          .map(function (x) { return x.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); })
          .filter(Boolean);
        if (!hosts.length) { note(f.key, ''); return save(f.key, []); }
        requestPermission({ origins: hosts.map(function (h) { return '*://' + h + '/*'; }) })
          .then(function (granted) {
            if (!granted) {
              note(f.key, 'Access to those sites was declined, so FocusRead will not start on them by itself.');
              return;
            }
            note(f.key, '');
            save(f.key, hosts);
          });
      });
      return ta;
    }

    if (f.type === 'pdfIntercept') {
      var pi = document.createElement('input');
      pi.type = 'checkbox';
      pi.checked = !!v;
      pi.addEventListener('change', function () {
        var want = pi.checked;
        var step = want
          ? requestPermission({ permissions: ['declarativeNetRequest'], origins: ['*://*/*'] })
          : Promise.resolve(true);

        step.then(function (granted) {
          if (want && !granted) {
            pi.checked = false;
            note(f.key, 'Permission was declined, so PDF links will keep opening in Chrome\'s viewer.');
            return;
          }
          chrome.runtime.sendMessage({ type: 'FR_SET_PDF_INTERCEPT', enabled: want }, function (r) {
            if (!r || !r.ok) {
              pi.checked = !want;
              note(f.key, (r && r.error) ? ('Could not change this: ' + r.error) : 'Could not change this setting.');
              return;
            }
            note(f.key, '');
            flashSaved();
          });
        });
      });
      return pi;
    }

    // text / password
    var t = document.createElement('input');
    t.type = f.type === 'password' ? 'password' : 'text';
    t.value = v == null ? '' : String(v);
    t.spellcheck = false;
    t.addEventListener('change', function () {
      var val = t.value.trim();
      // A user-supplied endpoint is not in host_permissions and cannot be -
      // we do not know it at build time. Ask for exactly that origin.
      if (/\.url$/.test(f.key) && val) {
        var pattern = originPattern(val);
        if (!pattern) {
          note(f.key, 'That does not look like an http:// or https:// address.');
          return;
        }
        requestPermission({ origins: [pattern] }).then(function (granted) {
          // Save either way. Refusing to store the address as well as the
          // permission just loses the reader's typing; the provider will
          // report a clear failure if the permission really is missing.
          save(f.key, val);
          note(f.key, granted
            ? ''
            : 'Saved, but FocusRead was not given permission to contact ' + pattern +
              '. Translation through it will fail until you allow it.');
        });
        return;
      }
      save(f.key, val);
    });
    return t;
  }

  /** Grouped: [['', label], {group, options: [[value,label],...]}, ...] */
  function voiceOptions() {
    var out = [['', 'Best available']];
    FR.speech.voiceGroups(voices, settings.voiceFilter).forEach(function (g) {
      out.push({
        group: g.label,
        options: g.voices.map(function (v) {
          return [v.voiceURI, v.name.replace(/\s*\(.*?\)\s*$/, '') + ' - ' + v.lang];
        })
      });
    });
    return out;
  }

  function render() {
    var tabs = $('tabs'), panels = $('panels');
    tabs.innerHTML = '';
    panels.innerHTML = '';

    SCHEMA.forEach(function (t, i) {
      var btn = document.createElement('button');
      btn.textContent = t.tab;
      btn.className = i === 0 ? 'on' : '';
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(tabs.children, function (b) { b.classList.remove('on'); });
        Array.prototype.forEach.call(panels.children, function (p) { p.classList.remove('on'); });
        btn.classList.add('on');
        panels.children[i].classList.add('on');
      });
      tabs.appendChild(btn);

      var panel = document.createElement('section');
      panel.className = 'panel' + (i === 0 ? ' on' : '');
      t.groups.forEach(function (g) {
        var visible = g.fields.filter(function (f) { return !(f.extensionOnly && FR.isWeb); });
        if (!visible.length && !g.note) return;        // nothing left to show
        var box = document.createElement('div');
        box.className = 'group';
        var h = document.createElement('h3');
        h.textContent = g.title;
        box.appendChild(h);
        if (g.note) {
          var note = document.createElement('div');
          note.className = 'callout';
          note.textContent = g.note;
          box.appendChild(note);
        }
        var fields = g.fields.filter(function (f) { return !(f.extensionOnly && FR.isWeb); });
        if (!fields.length && g.note && FR.isWeb && g.extensionOnly) return;
        fields.forEach(function (f) { box.appendChild(makeField(f)); });
        panel.appendChild(box);
      });
      panels.appendChild(panel);
    });

    refreshVisibility();
  }

  function refreshVisibility() {
    SCHEMA.forEach(function (t) {
      t.groups.forEach(function (g) {
        g.fields.forEach(function (f) {
          if (f.extensionOnly && FR.isWeb) return;
          if (!f.showIf) return;
          var row = document.querySelector('.field[data-key="' + CSS.escape(f.key) + '"]');
          if (row) row.hidden = !f.showIf(settings);
        });
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Start
   * ------------------------------------------------------------------ */

  $('clearCache').addEventListener('click', function () {
    FR.translate.clearCache().then(function () {
      $('clearCache').textContent = 'Cache cleared';
      setTimeout(function () { $('clearCache').textContent = 'Clear translation cache'; }, 1600);
    });
  });

  $('reset').addEventListener('click', function () {
    if (!confirm('Reset every FocusRead setting to its default?')) return;
    FR.settings.reset().then(function (s) { settings = s; render(); flashSaved(); });
  });

  /*
   * Which copy is actually running.
   *
   * An unpacked extension does NOT pick up changed files by itself: until it
   * is reloaded in chrome://extensions, Chrome keeps serving the old ones, and
   * nothing on screen says so. Printing the version makes "did my update
   * land?" a question the page can answer.
   */
  (function () {
    var out = $('build');
    if (!out) return;
    var v = '';
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        // The web build stubs getManifest, and its stub has no version - so
        // the version has to be checked, not just the function.
        var m = chrome.runtime.getManifest() || {};
        if (m.version) v = 'v' + m.version;
      }
    } catch (e) { /* no manifest at all */ }
    out.textContent = v || (FR.BUILD ? 'web ' + FR.BUILD : '');
  })();

  if (location.hash === '#welcome') $('welcome').hidden = false;

  Promise.all([FR.settings.get(), FR.speech.getVoices()]).then(function (r) {
    settings = r[0];
    voices = r[1] || [];
    render();
  });
})();
