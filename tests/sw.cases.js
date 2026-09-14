/*
 * Service-worker decision logic.
 *
 * These functions decide WHERE the reader runs and WHETHER a page is
 * reachable at all, and a mistake in them is silent: the feature simply never
 * happens. They were previously untested, which is how autoMatches came to
 * register the whole reader onto two translation API endpoints and nowhere else.
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  function run() {
    var pass = 0, fail = 0, lines = [];
    function eq(label, got, want) {
      var ok = JSON.stringify(got) === JSON.stringify(want);
      ok ? pass++ : fail++;
      lines.push((ok ? '[PASS] ' : '[FAIL] ') + label +
        (ok ? '' : '\n        want: ' + JSON.stringify(want) + '\n        got : ' + JSON.stringify(got)));
    }

    var API = [
      'https://api.mymemory.translated.net/*',
      'https://translation.googleapis.com/*'
    ];

    /* ---- where auto-activation registers ---- */
    eq('all-sites grant produces the all-sites pattern',
      root.autoMatches({ autoActivate: true }, { origins: ['*://*/*'].concat(API) }),
      ['*://*/*']);

    eq('<all_urls> is accepted too',
      root.autoMatches({ autoActivate: true }, { origins: ['<all_urls>'].concat(API) }),
      ['*://*/*']);

    // The bug that mattered: with only the extension's own API hosts granted,
    // the result must be EMPTY so the caller unregisters - not those two hosts.
    eq('revoking site access yields nothing to register',
      root.autoMatches({ autoActivate: true }, { origins: API }),
      []);

    eq('a specific granted origin is used as-is',
      root.autoMatches({ autoActivate: true }, { origins: ['https://arxiv.org/*'].concat(API) }),
      ['https://arxiv.org/*']);

    eq('per-site list becomes match patterns',
      root.autoMatches({ autoActivate: false, autoActivateHosts: ['arxiv.org', 'pmc.ncbi.nlm.nih.gov'] }, { origins: API }),
      ['*://arxiv.org/*', '*://pmc.ncbi.nlm.nih.gov/*']);

    eq('blank entries in the per-site list are ignored',
      root.autoMatches({ autoActivate: false, autoActivateHosts: ['', '  ', 'arxiv.org'] }, { origins: API }),
      ['*://arxiv.org/*']);

    eq('nothing configured registers nothing',
      root.autoMatches({ autoActivate: false, autoActivateHosts: [] }, { origins: API }), []);

    /* ---- which pages we will try to inject into ---- */
    eq('https is injectable', root.isInjectable('https://arxiv.org/abs/1'), true);
    eq('file is injectable', root.isInjectable('file:///Users/x/paper.pdf'), true);
    eq('chrome:// is not', root.isInjectable('chrome://extensions'), false);
    eq('the web store is not', root.isInjectable('https://chromewebstore.google.com/'), true);
    eq('a devtools page is not', root.isInjectable('devtools://devtools/bundled/x.html'), false);
    // Unknown is not the same as unsupported: activeTab may not have revealed
    // the URL yet, and refusing here told the reader an ordinary page was off
    // limits.
    eq('an unknown url is treated as injectable', root.isInjectable(''), true);
    eq('undefined is treated as injectable', root.isInjectable(undefined), true);

    /* ---- the PDF redirect rule ---- */
    (function () {
      var rules = root.pdfRules();
      eq('exactly one redirect rule', rules.length, 1);
      var r = rules[0];
      eq('only top-level navigations', r.condition.resourceTypes, ['main_frame', 'sub_frame']);
      // A redirect turns a POST into a GET and drops the body.
      eq('POST is excluded', r.condition.excludedRequestMethods, ['post']);
      eq('the substitution carries the original url after a sentinel',
         /\?DNR:\\0$/.test(r.action.redirect.regexSubstitution), true);
      eq('it redirects to our own reader',
         r.action.redirect.regexSubstitution.indexOf('chrome-extension://testid/src/reader/reader.html') === 0, true);
    })();

    return {
      pass: pass, fail: fail,
      report: lines.join('\n') + '\n\n==== ' + pass + ' passed, ' + fail + ' failed ===='
    };
  }

  FR.swTests = { run: run };
})(typeof globalThis !== 'undefined' ? globalThis : this);
