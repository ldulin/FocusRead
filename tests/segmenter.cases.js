/*
 * Shared test cases for FR.segmenter.
 * Runner-agnostic: loaded by tests/segmenter.test.html (browser) and by
 * tests/run.sh (JavaScriptCore via `osascript -l JavaScript`).
 * Defines FR.tests.run() -> { pass, fail, report }
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  function run() {
    var S = FR.segmenter, pass = 0, fail = 0, lines = [];

    function eq(label, got, want) {
      var ok = JSON.stringify(got) === JSON.stringify(want);
      ok ? pass++ : fail++;
      lines.push((ok ? '[PASS] ' : '[FAIL] ') + label +
        (ok ? '' : '\n        want: ' + JSON.stringify(want) +
                   '\n        got : ' + JSON.stringify(got)));
    }
    function sents(t) { return S.segment(t).map(function (s) { return s.text; }); }

    /* -- must NOT split inside academic notation -- */
    eq('citation + p-value',
      sents('Prior work (Smith et al., 2020) showed an effect at p < 0.05. We replicated it.'),
      ['Prior work (Smith et al., 2020) showed an effect at p < 0.05.', 'We replicated it.']);

    eq('Fig. reference',
      sents('See Fig. 3 for details. The effect was large.'),
      ['See Fig. 3 for details.', 'The effect was large.']);

    eq('e.g. / i.e.',
      sents('Use a filter, e.g. a Butterworth. Then resample, i.e. downsample to 1 kHz.'),
      ['Use a filter, e.g. a Butterworth.', 'Then resample, i.e. downsample to 1 kHz.']);

    eq('initials',
      sents('J. R. Smith reported a 3.5% increase.'),
      ['J. R. Smith reported a 3.5% increase.']);

    eq('DOI url',
      sents('Data are at https://doi.org/10.1038/nn.4499 for reuse. It is open access.'),
      ['Data are at https://doi.org/10.1038/nn.4499 for reuse.', 'It is open access.']);

    eq('U.S. mid-sentence',
      sents('The U.S. Food and Drug Administration approved it.'),
      ['The U.S. Food and Drug Administration approved it.']);

    eq('decimals and units',
      sents('Participants (N = 24, mean age 22.4 yrs) completed 3 runs. Each run took 6.5 min.'),
      ['Participants (N = 24, mean age 22.4 yrs) completed 3 runs.', 'Each run took 6.5 min.']);

    eq('vs. and cf.',
      sents('We compared A vs. B here. See cf. Jones for contrast.'),
      ['We compared A vs. B here.', 'See cf. Jones for contrast.']);

    /* -- "etc." / "al." are conditional: they CAN end a sentence -- */
    eq('etc. ending a sentence',
      sents('We used mice, rats, etc. Results were consistent.'),
      ['We used mice, rats, etc.', 'Results were consistent.']);

    eq('etc. mid-sentence',
      sents('We used mice, rats, etc., and all were healthy.'),
      ['We used mice, rats, etc., and all were healthy.']);

    eq('unit abbreviation ending a sentence',
      sents('Each run took 6.5 min. Data are available online.'),
      ['Each run took 6.5 min.', 'Data are available online.']);

    eq('unit abbreviation mid-sentence',
      sents('Each run took 6.5 min and was repeated twice.'),
      ['Each run took 6.5 min and was repeated twice.']);

    eq('unit abbreviation followed by lowercase',
      sents('We washed for 10 min. then imaged the slice.'),
      ['We washed for 10 min. then imaged the slice.']);

    eq('et al. before a year',
      sents('This matches Smith et al. (2020) exactly.'),
      ['This matches Smith et al. (2020) exactly.']);

    /* -- structure -- */
    eq('numbered heading', sents('1. Introduction'), ['1. Introduction']);

    eq('parenthetical with inner period',
      sents('The result held (see Fig. 2 for details.) across subjects. Next we tested B.'),
      ['The result held (see Fig. 2 for details.) across subjects.', 'Next we tested B.']);

    eq('question and exclamation',
      sents('Does it generalise? We think so! Probably.'),
      ['Does it generalise?', 'We think so!', 'Probably.']);

    eq('quote closing after terminator',
      sents('He said "it works." Then he left.'),
      ['He said "it works."', 'Then he left.']);

    eq('empty input', sents('   '), []);
    eq('no terminator at all', sents('A fragment with no end'), ['A fragment with no end']);

    /* -- invariants -- */
    (function () {
      var t = 'See Fig. 3 now. The p < 0.05 effect held. Done.';
      var ok = S.segment(t).every(function (s) { return t.slice(s.start, s.end) === s.text; });
      eq('offsets round-trip against the source string', ok, true);
    })();

    (function () {
      var samples = [
        'Smith et al. (2020) found p < 0.05 in Fig. 3.',
        'Visit www.example.com or e-mail a.b@c.edu, i.e. either.',
        'Versions 1.2.3 and 10.4 differ... a lot.'
      ];
      var ok = samples.every(function (s) { return S.mask(s).length === s.length; });
      eq('mask() is length-preserving', ok, true);
    })();

    (function () {
      var t = 'One. Two! Three? Four.';
      var joined = S.segment(t).map(function (s) { return s.text; }).join(' ');
      eq('no text is lost across a whole paragraph', joined, t);
    })();

    /* -- clause chunking -- */
    (function () {
      var long = 'Although the effect was small in the first cohort, we observed a ' +
                 'consistent increase across all three replication samples, which ' +
                 'suggests that the underlying mechanism is robust to variation in ' +
                 'both the stimulus set and the participant population.';
      var c = S.chunk(long).map(function (x) { return x.text; });
      eq('long sentence splits into >1 clause chunk', c.length > 1, true);
      eq('chunks reassemble to the original',
         c.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '));
      eq('short sentence is left alone', S.chunk('Short one.').length, 1);
    })();

    /* -- de-hyphenation across PDF line breaks -- */
    eq('dehyphenate joins a broken word',
      S.dehyphenate(['we found inter-', 'national variation here']),
      ['we found international', 'variation here']);

    eq('dehyphenate keeps a real hyphen',
      S.dehyphenate(['a well-known result', 'was replicated']),
      ['a well-known result', 'was replicated']);

    return {
      pass: pass, fail: fail,
      report: lines.join('\n') + '\n\n==== ' + pass + ' passed, ' + fail + ' failed ===='
    };
  }

  FR.tests = { run: run };
})(typeof globalThis !== 'undefined' ? globalThis : this);
