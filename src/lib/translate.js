/*
 * FocusRead - translation providers.
 *
 * Loaded by BOTH the service worker and the page contexts, with a hard split
 * in responsibility:
 *
 *   - NETWORK providers must run in the service worker. A content script runs
 *     in the page's origin and obeys the page's CORS rules and CSP; only the
 *     worker carries the extension's host permissions.
 *   - The BUILT-IN provider must run in a page context. Chrome exposes
 *     Translator only where there is a responsible Document, so
 *     `self.Translator` is undefined in an MV3 service worker - a probe there
 *     reports "unavailable" forever even when translation works fine.
 *
 * translateBatch() returns one result object per input and never throws.
 *
 * Result shape: { ok: true, text } | { ok: false, error, code }
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  /* ------------------------------------------------------------------ *
   * Language-code mapping
   *
   * Everything internal is BCP-47 ("zh-Hans"). Each provider wants its own
   * dialect of that, and getting it wrong is the single most common cause of
   * "translation returns the input unchanged".
   * ------------------------------------------------------------------ */

  var MAP = {
    mymemory: { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', 'pt': 'pt-PT', 'he': 'he-IL' },
    google:   { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', 'he': 'iw' },
      libre:    { 'zh-Hans': 'zh', 'zh-Hant': 'zt' },
    builtin:  {},
    openai:   {}
  };

  // Human-readable names, used when prompting an LLM provider.
  var NAMES = {
    'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese',
    en: 'English', ja: 'Japanese', ko: 'Korean', es: 'Spanish', fr: 'French',
    de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic',
    hi: 'Hindi', bn: 'Bengali', tr: 'Turkish', vi: 'Vietnamese', th: 'Thai',
    id: 'Indonesian', nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian', fa: 'Persian',
    he: 'Hebrew', sv: 'Swedish', el: 'Greek', cs: 'Czech'
  };

  function lang(provider, tag) {
    if (!tag || tag === 'auto') return 'auto';
    var m = MAP[provider] || {};
    if (m[tag]) return m[tag];
    if (provider === 'libre') return tag.split('-')[0];
    return tag;
  }
  function name(tag) { return NAMES[tag] || NAMES[tag.split('-')[0]] || tag; }

  /* ------------------------------------------------------------------ *
   * Cache - a plain object in storage.local, FIFO-evicted.
   * ------------------------------------------------------------------ */

  var CACHE_KEY = 'translationCache';
  var CACHE_MAX = 4000;
  var memCache = null;        // { key: text }
  var memOrder = null;        // [key] insertion order
  var flushTimer = null;

  function hash(s) {          // FNV-1a, base36
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }
  function cacheKey(provider, src, tgt, text) {
    return provider + '|' + src + '|' + tgt + '|' + hash(text) + '|' + text.length;
  }

  function loadCache() {
    if (memCache) return Promise.resolve(memCache);
    return new Promise(function (resolve) {
      chrome.storage.local.get(CACHE_KEY, function (r) {
        var stored = (r && r[CACHE_KEY]) || {};
        memCache = stored.map || {};
        memOrder = stored.order || Object.keys(memCache);
        resolve(memCache);
      });
    });
  }

  function cachePut(key, text) {
    memCache[key] = text;
    memOrder.push(key);
    while (memOrder.length > CACHE_MAX) delete memCache[memOrder.shift()];
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      var payload = {}; payload[CACHE_KEY] = { map: memCache, order: memOrder };
      chrome.storage.local.set(payload);
    }, 1500);
  }

  function clearCache() {
    memCache = {}; memOrder = [];
    return new Promise(function (res) { chrome.storage.local.remove(CACHE_KEY, res); });
  }

  /* ------------------------------------------------------------------ *
   * Provider: Chrome built-in on-device Translator
   *
   * Free, private, offline once the language pack downloads. Two API shapes
   * have shipped; both are probed so this keeps working across versions.
   * ------------------------------------------------------------------ */

  var builtinPool = {};   // "src>tgt" -> Promise<translator>

  function builtinCtor() {
    if (typeof root.Translator !== 'undefined') return root.Translator;
    if (root.translation && typeof root.translation.createTranslator === 'function') {
      return {                                    // older shape, adapted
        availability: function (o) {
          return root.translation.canTranslate
            ? root.translation.canTranslate(o).then(function (v) {
                return v === 'readily' ? 'available' : (v === 'no' ? 'unavailable' : 'downloadable');
              })
            : Promise.resolve('downloadable');
        },
        create: function (o) { return root.translation.createTranslator(o); }
      };
    }
    return null;
  }

  function builtinAvailable() { return builtinCtor() !== null; }

  /**
   * Normalised availability for a pair.
   * @returns {Promise<'available'|'downloadable'|'downloading'|'unavailable'|'unknown'|'same-language'>}
   */
  function builtinStatus(src, tgt) {
    var T = builtinCtor();
    if (!T) return Promise.resolve('unavailable');
    var source = src === 'auto' ? 'en' : src;
    // availability() reports 'unavailable' for a same-language pair, which is
    // indistinguishable from "not supported" unless we check it ourselves.
    if (source === tgt) return Promise.resolve('same-language');
    return Promise.resolve()
      .then(function () { return T.availability({ sourceLanguage: source, targetLanguage: tgt }); })
      .then(function (v) {
        // MDN documents a null return meaning "could not be determined"; a
        // strict switch over the four documented strings would fall through.
        if (v === null || v === undefined) return 'unknown';
        return String(v);
      })
      .catch(function () { return 'unavailable'; });
  }

  /**
   * One warm Translator per language pair. `create()` needs transient user
   * activation the first time a language pack must be downloaded, so the first
   * call has to originate from a real click - hence the explicit error code
   * the UI can turn into "click to download the language pack".
   */
  function builtinTranslator(src, tgt, onProgress) {
    var k = src + '>' + tgt;
    if (builtinPool[k]) return builtinPool[k];
    var T = builtinCtor();
    if (!T) return Promise.reject(Object.assign(
      new Error('Chrome built-in translator is not reachable here'), { code: 'builtin-unavailable' }));

    builtinPool[k] = Promise.resolve()
      .then(function () {
        var opts = { sourceLanguage: src, targetLanguage: tgt };
        if (onProgress) {
          opts.monitor = function (mon) {
            mon.addEventListener('downloadprogress', function (e) {
              // e.loaded is a 0..1 fraction.
              onProgress(typeof e.loaded === 'number' ? e.loaded : 0);
            });
          };
        }
        return T.create(opts);
      })
      .catch(function (e) {
        delete builtinPool[k];
        var msg = String((e && e.message) || e);
        if (/user (gesture|activation)|NotAllowedError/i.test(msg) || (e && e.name === 'NotAllowedError')) {
          throw Object.assign(new Error(
            'Chrome needs to download the ' + name(src) + ' to ' + name(tgt) +
            ' language pack. Click Translate once more to start the download.'),
            { code: 'builtin-needs-gesture' });
        }
        throw Object.assign(new Error(msg), { code: e && e.code ? e.code : 'builtin-create' });
      });
    return builtinPool[k];
  }

  function viaBuiltin(texts, src, tgt, cfg, onProgress) {
    var source = src === 'auto' ? 'en' : src;
    if (source === tgt) {
      return Promise.resolve(texts.map(function (t) { return { ok: true, text: t }; }));
    }
    return builtinStatus(source, tgt).then(function (status) {
      if (status === 'unavailable') {
        throw Object.assign(
          new Error('Chrome cannot translate ' + name(source) + ' to ' + name(tgt) + ' on this device'),
          { code: 'builtin-pair' });
      }
      return builtinTranslator(source, tgt, onProgress).then(function (tr) {
        // Translations are sequential per instance; a parallel fan-out would
        // queue behind itself anyway, so be explicit about it.
        return serial(texts, function (t) {
          return Promise.resolve(tr.translate(t)).then(function (out) {
            return { ok: true, text: String(out) };
          });
        });
      });
    });
  }

  /** Release model resources. Leaking one instance per navigation is real. */
  function builtinDestroy() {
    Object.keys(builtinPool).forEach(function (k) {
      var p = builtinPool[k];
      delete builtinPool[k];
      Promise.resolve(p).then(function (tr) {
        try { if (tr && tr.destroy) tr.destroy(); } catch (e) { /* noop */ }
      }, function () { /* never created */ });
    });
  }

  /* ------------------------------------------------------------------ *
   * Provider: MyMemory - free, keyless, one string per request.
   *
   * Two traps, both of which produce silent corruption rather than an error:
   *   - `q` is capped at 500 BYTES of UTF-8, not 500 characters.
   *   - Failures (quota, bad langpair) arrive as HTTP 200 with responseStatus
   *     in the body, sometimes as a string, sometimes as a number.
   * ------------------------------------------------------------------ */

  var MYMEMORY_MAX_BYTES = 480;      // a little under the 500-byte cap

  function utf8Length(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    return unescape(encodeURIComponent(s)).length;
  }

  /** Split `text` so each piece encodes to at most `maxBytes` of UTF-8. */
  function byteChunks(text, maxBytes) {
    if (utf8Length(text) <= maxBytes) return [text];

    // Prefer clause boundaries so the translator still sees coherent units.
    var parts = (FR.segmenter && FR.segmenter.chunk)
      ? FR.segmenter.chunk(text, 240, 40).map(function (c) { return c.text; })
      : [text];

    var out = [];
    parts.forEach(function (part) {
      if (utf8Length(part) <= maxBytes) { out.push(part); return; }
      var words = part.split(/(\s+)/), cur = '';
      words.forEach(function (w) {
        if (cur && utf8Length(cur + w) > maxBytes) {
          out.push(cur);
          cur = w.replace(/^\s+/, '');
        } else {
          cur += w;
        }
      });
      if (cur.trim()) out.push(cur);
    });
    return out.filter(function (p) { return p.trim().length > 0; });
  }

  function myMemoryOnce(chunk, pair, cfg) {
    var url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(chunk) +
              '&langpair=' + encodeURIComponent(pair) +
              (cfg && cfg.email ? '&de=' + encodeURIComponent(cfg.email) : '');
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      // Errors come back as HTTP 200; the real status is in the body, and its
      // type is inconsistent - compare numerically.
      var status = Number(j.responseStatus);
      if (isFinite(status) && status !== 200) {
        var msg = String(j.responseDetails || ('MyMemory error ' + status));
        throw Object.assign(new Error(msg), {
          code: (status === 429 || /limit|quota/i.test(msg)) ? 'quota' : 'provider'
        });
      }
      var out = j.responseData && j.responseData.translatedText;
      if (!out) throw Object.assign(new Error('Empty response from MyMemory'), { code: 'provider' });
      var text = decodeEntities(String(out));
      // A quota warning is sometimes delivered *as* the translation.
      if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE PAIR/i.test(text)) {
        throw Object.assign(new Error(text), { code: 'quota' });
      }
      return text;
    });
  }

  function viaMyMemory(texts, src, tgt, cfg) {
    var pair = (src === 'auto' ? 'en' : lang('mymemory', src)) + '|' + lang('mymemory', tgt);
    return pooled(texts, 3, function (t) {
      var chunks = byteChunks(t, MYMEMORY_MAX_BYTES);
      return serial(chunks.map(function (c) { return c; }), function (c) {
        return myMemoryOnce(c, pair, cfg).then(function (text) { return { ok: true, text: text }; });
      }).then(function (parts) {
        var bad = parts.filter(function (p) { return !p.ok; })[0];
        if (bad) return bad;
        return { ok: true, text: parts.map(function (p) { return p.text; }).join(' ') };
      });
    });
  }

  // MyMemory returns HTML entities for quotes in some locales.
  function decodeEntities(s) {
    return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }

  /* ------------------------------------------------------------------ *
   * Provider: LibreTranslate (self-hosted or public instance)
   * ------------------------------------------------------------------ */

  function viaLibre(texts, src, tgt, cfg) {
    var base = String((cfg && cfg.url) || '').replace(/\/+$/, '');
    if (!base) return Promise.resolve(texts.map(function () {
      return { ok: false, code: 'config', error: 'No LibreTranslate URL configured' };
    }));
    var body = {
      q: texts,
      source: src === 'auto' ? 'auto' : lang('libre', src),
      target: lang('libre', tgt),
      format: 'text'
    };
    if (cfg.key) body.api_key = cfg.key;
    return fetch(base + '/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t.slice(0, 200)); });
      return r.json();
    }).then(function (j) {
      var out = j.translatedText;
      var arr = Array.isArray(out) ? out : [out];
      return texts.map(function (_, i) {
        return arr[i] != null ? { ok: true, text: String(arr[i]) }
                              : { ok: false, code: 'provider', error: 'Missing translation' };
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * DeepL is deliberately absent.
   *
   * It returns 403 to any browser-originated request by design, and a service
   * worker fetch still carries `Origin: chrome-extension://<id>`. No amount of
   * host_permissions changes that. Offering it would only produce a provider
   * that fails for everyone who selects it.
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * Provider: Google Cloud Translation v2
   * ------------------------------------------------------------------ */

  function viaGoogle(texts, src, tgt, cfg) {
    var key = (cfg && cfg.key || '').trim();
    if (!key) return Promise.resolve(texts.map(function () {
      return { ok: false, code: 'config', error: 'No Google API key configured' };
    }));
    var body = { q: texts, target: lang('google', tgt), format: 'text' };
    if (src !== 'auto') body.source = lang('google', src);
    return fetch('https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw Object.assign(new Error(j.error.message || 'Google error'),
        { code: j.error.code === 403 ? 'auth' : 'provider' });
      var arr = (j.data && j.data.translations) || [];
      return texts.map(function (_, i) {
        return arr[i] ? { ok: true, text: decodeEntities(arr[i].translatedText) }
                      : { ok: false, code: 'provider', error: 'Missing translation' };
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Provider: any OpenAI-compatible chat endpoint.
   * Numbered lines keep the batch aligned and let one call cover a paragraph.
   * ------------------------------------------------------------------ */

  function viaOpenAI(texts, src, tgt, cfg) {
    var key = (cfg && cfg.key || '').trim();
    var base = String((cfg && cfg.url) || 'https://api.openai.com/v1').replace(/\/+$/, '');
    if (!key) return Promise.resolve(texts.map(function () {
      return { ok: false, code: 'config', error: 'No API key configured for the LLM provider' };
    }));

    var numbered = texts.map(function (t, i) { return (i + 1) + '. ' + t.replace(/\n+/g, ' '); }).join('\n');
    var sys = 'You are a translation engine for academic text. Translate each numbered ' +
      'line into ' + name(tgt) + '. Preserve technical terms, units, citations and ' +
      'numbers exactly. Output ONLY the numbered translations, one per line, same ' +
      'numbering, no commentary, no extra lines.';

    return fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: (cfg && cfg.model) || 'gpt-4o-mini',
        temperature: 0,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: numbered }]
      })
    }).then(function (r) {
      if (r.status === 401) throw Object.assign(new Error('The LLM provider rejected the API key'), { code: 'auth' });
      if (!r.ok) return r.text().then(function (t) { throw new Error('LLM ' + r.status + ': ' + t.slice(0, 200)); });
      return r.json();
    }).then(function (j) {
      var content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!content) return texts.map(function () { return { ok: false, code: 'provider', error: 'Empty LLM response' }; });
      var byIndex = {};
      String(content).split('\n').forEach(function (line) {
        var m = /^\s*(\d+)[.)]\s*(.+)$/.exec(line);
        if (m) byIndex[Number(m[1])] = m[2].trim();
      });
      return texts.map(function (_, i) {
        return byIndex[i + 1]
          ? { ok: true, text: byIndex[i + 1] }
          : { ok: false, code: 'provider', error: 'LLM omitted line ' + (i + 1) };
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Concurrency helpers
   * ------------------------------------------------------------------ */

  function serial(items, fn) {
    var out = [];
    return items.reduce(function (p, item) {
      return p.then(function () {
        return Promise.resolve(fn(item))
          .catch(function (e) { return { ok: false, code: e.code || 'error', error: String(e.message || e) }; })
          .then(function (r) { out.push(r); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  function pooled(items, width, fn) {
    var out = new Array(items.length), next = 0;
    function worker() {
      if (next >= items.length) return Promise.resolve();
      var i = next++;
      return Promise.resolve(fn(items[i]))
        .catch(function (e) { return { ok: false, code: e.code || 'error', error: String(e.message || e) }; })
        .then(function (r) { out[i] = r; return worker(); });
    }
    var workers = [];
    for (var w = 0; w < Math.min(width, items.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () { return out; });
  }

  var PROVIDERS = {
    builtin: viaBuiltin, mymemory: viaMyMemory, libre: viaLibre,
    google: viaGoogle, openai: viaOpenAI
  };

  // Providers that take a whole array in one request.
  var BATCHED = { libre: 1, google: 1, openai: 1 };
  var BATCH_SIZE = 24;

  /* ------------------------------------------------------------------ *
   * Public entry point
   * ------------------------------------------------------------------ */

  /**
   * @param {string[]} texts
   * @param {{provider,sourceLang,targetLang,providerConfig,cache,onProgress}} opts
   * @returns {Promise<Array<{ok:boolean,text?:string,error?:string,code?:string}>>}
   */
  function translateBatch(texts, opts) {
    opts = opts || {};
    var provider = opts.provider || 'builtin';
    var src = opts.sourceLang || 'auto';
    var tgt = opts.targetLang || 'zh-Hans';
    var cfg = (opts.providerConfig || {})[provider] || {};
    var useCache = opts.cache !== false;
    var impl = PROVIDERS[provider];

    if (!impl) {
      return Promise.resolve(texts.map(function () {
        return { ok: false, code: 'config', error: 'Unknown provider: ' + provider };
      }));
    }
    if (provider === 'builtin' && !builtinAvailable()) {
      return Promise.resolve(texts.map(function () {
        return { ok: false, code: 'builtin-unavailable', error: 'Chrome built-in translator not reachable here' };
      }));
    }

    return (useCache ? loadCache() : Promise.resolve({})).then(function () {
      var results = new Array(texts.length);
      var todo = [], todoIdx = [];

      texts.forEach(function (t, i) {
        var trimmed = String(t == null ? '' : t).trim();
        if (!trimmed) { results[i] = { ok: true, text: '' }; return; }
        if (useCache) {
          var hit = memCache[cacheKey(provider, src, tgt, trimmed)];
          if (hit !== undefined) { results[i] = { ok: true, text: hit, cached: true }; return; }
        }
        todo.push(trimmed); todoIdx.push(i);
      });

      if (!todo.length) return results;

      // Chunk so one failure does not lose a whole 200-sentence page.
      var groups = [];
      if (BATCHED[provider]) {
        for (var s = 0; s < todo.length; s += BATCH_SIZE) groups.push(todo.slice(s, s + BATCH_SIZE));
      } else {
        groups.push(todo);
      }

      var offset = 0;
      return serialGroups(groups, function (group) {
        return Promise.resolve(impl(group, src, tgt, cfg, opts.onProgress))
          .catch(function (e) {
            return group.map(function () {
              return { ok: false, code: e.code || 'error', error: String(e.message || e) };
            });
          });
      }).then(function (chunks) {
        chunks.forEach(function (chunk) {
          chunk.forEach(function (r) {
            var i = todoIdx[offset];
            results[i] = r;
            if (useCache && r && r.ok && r.text) cachePut(cacheKey(provider, src, tgt, todo[offset]), r.text);
            offset++;
          });
        });
        return results;
      });
    });
  }

  function serialGroups(groups, fn) {
    var out = [];
    return groups.reduce(function (p, g) {
      return p.then(function () {
        return Promise.resolve(fn(g)).then(function (r) { out.push(r); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  FR.translate = {
    translateBatch: translateBatch,
    builtinAvailable: builtinAvailable,
    builtinStatus: builtinStatus,
    clearCache: clearCache,
    builtinDestroy: builtinDestroy,
    langName: name,
    providerLang: lang,
    PROVIDERS: Object.keys(PROVIDERS)
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
