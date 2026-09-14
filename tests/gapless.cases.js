/*
 * Gapless runs: which sentences get merged into one utterance, and where each
 * one sits inside the merged text.
 *
 * This is the arithmetic the word highlight depends on. If an offset maps to
 * the wrong sentence the karaoke highlight lands in a sentence nobody is
 * reading, and if a run crosses a paragraph the reader is dragged through a
 * break that should have been a pause.
 *
 * Pure functions, so no speech engine is needed.
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  function run() {
    var S = FR.speech, pass = 0, fail = 0, lines = [];

    function eq(label, got, want) {
      var ok = JSON.stringify(got) === JSON.stringify(want);
      ok ? pass++ : fail++;
      lines.push((ok ? '[PASS] ' : '[FAIL] ') + label +
        (ok ? '' : '\n        want: ' + JSON.stringify(want) +
                   '\n        got : ' + JSON.stringify(got)));
    }
    function section(t) { lines.push('\n--- ' + t + ' ---'); }

    function rec(text, block) { return { text: text, blockEl: block }; }
    function idsOf(run) { return run.map(function (r) { return r.i; }); }

    /* ================= planning a run ================= */
    section('planRun');

    var para = [
      rec('One two three.', 'p1'),
      rec('Four five six.', 'p1'),
      rec('Seven eight nine.', 'p1')
    ];

    eq('consecutive sentences in one paragraph merge',
       idsOf(S.planRun(para, 0, { budget: 700 })), [0, 1, 2]);
    eq('a run starts where it is asked to, not at the paragraph',
       idsOf(S.planRun(para, 1, { budget: 700 })), [1, 2]);
    eq('the last sentence is a run of one',
       idsOf(S.planRun(para, 2, { budget: 700 })), [2]);

    var twoParas = [
      rec('First paragraph.', 'p1'),
      rec('Still the first.', 'p1'),
      rec('A new paragraph.', 'p2'),
      rec('Also new.', 'p2')
    ];
    eq('a run never crosses a paragraph',
       idsOf(S.planRun(twoParas, 0, { budget: 700 })), [0, 1]);
    eq('and the next run picks up on the other side of it',
       idsOf(S.planRun(twoParas, 2, { budget: 700 })), [2, 3]);

    // 'One two three.' is 14 chars; two of them plus the joining space is 29.
    eq('the budget stops the run',
       idsOf(S.planRun(para, 0, { budget: 29 })), [0, 1]);
    eq('a budget too small for even two sentences gives one',
       idsOf(S.planRun(para, 0, { budget: 20 })), [0]);
    eq('a sentence longer than the whole budget is still spoken',
       idsOf(S.planRun([rec('A very long sentence indeed.', 'p1')], 0, { budget: 5 })), [0]);

    var many = [];
    for (var n = 0; n < 12; n++) many.push(rec('Sentence ' + n + '.', 'p1'));
    eq('no more than six sentences in one breath',
       idsOf(S.planRun(many, 0, { budget: 9000 })).length, 6);
    eq('and the cap is adjustable',
       idsOf(S.planRun(many, 0, { budget: 9000, maxSentences: 3 })), [0, 1, 2]);

    eq('an index past the end plans nothing',
       S.planRun(para, 9, { budget: 700 }), []);
    eq('no records at all plan nothing',
       S.planRun([], 0, { budget: 700 }), []);

    eq('a blank record ends the run rather than being skipped over',
       idsOf(S.planRun([rec('First.', 'p1'), rec('   ', 'p1'), rec('Third.', 'p1')],
                       0, { budget: 700 })), [0]);

    /* ================= laying the run out ================= */
    section('runSpans');

    var laid = S.runSpans([{ i: 4, text: 'Alpha beta.' }, { i: 5, text: 'Gamma delta.' }]);
    eq('the sentences are joined with a single space',
       laid.text, 'Alpha beta. Gamma delta.');
    eq('each sentence keeps its own index and extent',
       laid.spans, [{ i: 4, start: 0, end: 11 }, { i: 5, start: 12, end: 24 }]);
    eq('surrounding whitespace is trimmed, not carried into the offsets',
       S.runSpans([{ i: 0, text: '  Alpha.  ' }, { i: 1, text: 'Beta.' }]).spans,
       [{ i: 0, start: 0, end: 6 }, { i: 1, start: 7, end: 12 }]);
    eq('an empty sentence contributes no span',
       S.runSpans([{ i: 0, text: 'Alpha.' }, { i: 1, text: '' }]).spans,
       [{ i: 0, start: 0, end: 6 }]);
    eq('a run of nothing lays out as nothing',
       S.runSpans([]), { text: '', spans: [] });

    /* ================= offset -> sentence ================= */
    section('spanAt');

    var spans = laid.spans;                   // [0,11) and [12,24)
    var at = function (ci) { var s = S.spanAt(spans, ci); return s ? s.i : null; };

    eq('the first character belongs to the first sentence', at(0), 4);
    eq('so does its last', at(10), 4);
    eq('the joining space belongs to the sentence about to be spoken', at(11), 5);
    eq('the second sentence starts where it says it does', at(12), 5);
    eq('the last character is still inside it', at(23), 5);
    eq('an offset past the end clamps to the last sentence', at(999), 5);
    eq('a negative offset does not fall off the front', at(-5), 4);
    eq('no spans, no sentence', S.spanAt([], 0), null);

    // Three spans: the middle one must not be skipped over.
    var three = S.runSpans([{ i: 0, text: 'Aa.' }, { i: 1, text: 'Bb.' }, { i: 2, text: 'Cc.' }]);
    eq('offsets across three sentences map in order',
       [0, 3, 4, 7, 8].map(function (c) { return S.spanAt(three.spans, c).i; }),
       [0, 1, 1, 2, 2]);

    /* ================= did the voice actually finish? ================= */
    section('unspokenTail');

    // A word landed in each sentence of the run, or it did not.
    eq('a run every sentence was reached in is finished',
       S.unspokenTail(3, [true, true, true]), -1);
    eq('a run cut after the first sentence is unfinished from the second',
       S.unspokenTail(3, [true, false, false]), 1);
    eq('a cut before the last sentence is caught even though it is short',
       S.unspokenTail(3, [true, true, false]), 2);
    eq('a gap in the MIDDLE is a stingy voice, not a cut',
       S.unspokenTail(3, [true, false, true]), -1);
    eq('a run no word landed in at all is unfinished from the start',
       S.unspokenTail(3, [false, false, false]), 0);
    eq('and a missing record of words counts as none', S.unspokenTail(3, []), 0);
    eq('an empty run cannot be unfinished', S.unspokenTail(0, []), -1);

    section('estimateSpeechMs');

    var ms = function (t, r) { return Math.round(S.estimateSpeechMs(t, r)); };
    eq('nothing takes no time', ms('', 1), 0);
    eq('three words at 180 wpm take a second', ms('one two three', 1), 1000);
    eq('twice the speed, half the time', ms('one two three', 2), 500);
    eq('half the speed, twice the time', ms('one two three', 0.5), 2000);
    eq('an absurd rate is floored rather than predicting instant speech',
       ms('one two three', 50), 270);
    eq('whitespace between words does not add any',
       ms('one   two\n\nthree', 1), 1000);

    /* ================= which voices need it ================= */
    section('isNetworkVoice');

    var nv = function (name, local) { return S.isNetworkVoice({ name: name, localService: local }); };
    eq('the flag is believed when it says remote', nv('Whatever', false), true);
    eq('an on-device voice is not a network voice', nv('Samantha', true), false);
    eq('Microsoft\'s Online voices are caught by name too',
       nv('Microsoft Andrew Online (Natural) - English (United States)', true), true);
    eq('and so are Windows Natural voices', nv('Microsoft Aria (Natural)', true), true);
    eq('a name that merely contains the letters does not count',
       nv('Naturalist', true), false);
    eq('nothing is not a network voice', S.isNetworkVoice(null), false);

    /* ================= what a voice is known to do ================= */
    section('emitsBoundaries');

    eq('an unknown voice is unknown, not assumed mute',
       S.emitsBoundaries('uri:never-spoken'), undefined);
    eq('and neither is a missing name', S.emitsBoundaries(''), undefined);

    return {
      pass: pass, fail: fail,
      report: lines.join('\n') + '\n\n==== ' + pass + ' passed, ' + fail + ' failed ===='
    };
  }

  FR.gaplessTests = { run: run };
})(typeof globalThis !== 'undefined' ? globalThis : this);
