/*
 * Tests for the PDF layout reconstruction.
 *
 * pdf.js itself is not needed here: everything under test takes plain
 * {str, x, y, w, h} runs, which is what page.getTextContent() boils down to.
 * That lets the hardest part of the pipeline - working out where columns,
 * lines and paragraphs are - be tested without a PDF or a browser.
 *
 * Coordinates follow the PDF convention: y increases UPWARD.
 */
(function (root) {
  'use strict';
  var FR = (root.FR = root.FR || {});

  function run() {
    var P = FR.pdf._internals, pass = 0, fail = 0, lines = [];

    function eq(label, got, want) {
      var ok = JSON.stringify(got) === JSON.stringify(want);
      ok ? pass++ : fail++;
      lines.push((ok ? '[PASS] ' : '[FAIL] ') + label +
        (ok ? '' : '\n        want: ' + JSON.stringify(want) +
                   '\n        got : ' + JSON.stringify(got)));
    }

    // Build one line of text as a single run.
    function line(str, x, y, w) {
      return { str: str, x: x, y: y, w: w === undefined ? str.length * 5 : w, h: 10 };
    }

    /* ---- toBoxes shape and rotated-run detection ---- */
    (function () {
      var upright = { items: [
        { str: 'Hello', transform: [10, 0, 0, 10, 50, 700], width: 40, height: 10 },
        { str: 'world', transform: [10, 0, 0, 10, 95, 700], width: 40, height: 10 }
      ] };
      var r1 = P.toBoxes(upright);
      eq('upright runs are not flagged as rotated', r1.rotatedRuns, 0);
      eq('upright coordinates come straight from the matrix',
         [r1.boxes[0].x, r1.boxes[0].y], [50, 700]);

      // A 90-degree-clockwise text matrix: the advance is vertical.
      var sideways = { items: [
        { str: 'Hello', transform: [0, -10, 10, 0, 700, 400], width: 40, height: 10 }
      ] };
      var r2 = P.toBoxes(sideways);
      eq('a vertical advance is detected as rotated', r2.rotatedRuns, 1);
      eq('rotated runs get the along-line axis as x', r2.boxes[0].x, -400);
    })();

    /* ---- rotated runs: decoration vs a genuinely sideways page ---- */
    (function () {
      function upright(i) {
        return { str: 'body line ' + i, transform: [10, 0, 0, 10, 56, 700 - i * 13], width: 200, height: 10 };
      }
      function sideways(i) {
        return { str: 'axis ' + i, transform: [0, -8, 8, 0, 300 + i, 400], width: 40, height: 8 };
      }
      // A plot's axis labels among ordinary body text.
      var mixed = { items: [] };
      for (var i = 0; i < 20; i++) mixed.items.push(upright(i));
      for (var j = 0; j < 3; j++) mixed.items.push(sideways(j));
      var r = P.toBoxes(mixed);
      eq('a few rotated runs are counted', r.rotatedRuns, 3);
      eq('but the page is mostly upright', r.rotatedRuns > r.boxes.length * 0.5, false);

      // A genuinely sideways page.
      var turned = { items: [] };
      for (var k = 0; k < 20; k++) turned.items.push(sideways(k));
      var r2 = P.toBoxes(turned);
      eq('a sideways page is mostly rotated', r2.rotatedRuns > r2.boxes.length * 0.5, true);
    })();

    /* ---- single column ---- */
    (function () {
      var boxes = [
        line('The first sentence of the paragraph runs', 50, 700, 400),
        line('across two lines and ends here.', 50, 686, 300),
        line('A second paragraph starts after a wider', 50, 660, 400),
        line('vertical gap than the line spacing.', 50, 646, 320)
      ];
      var gutter = P.detectColumns(boxes, 600);
      eq('a page with too few runs is not treated as two columns', gutter, null);

      var ls = P.toLines(boxes, gutter);
      eq('four visual lines are recovered', ls.length, 4);
      eq('line text is joined correctly', ls[0].text,
         'The first sentence of the paragraph runs');

      var blocks = P.linesToBlocks(ls, 10, true);
      eq('a wider gap starts a new paragraph', blocks.length, 2);
      eq('paragraph one is joined from its two lines', blocks[0].text,
         'The first sentence of the paragraph runs across two lines and ends here.');
    })();

    /* ---- a SPARSE two-column page (one run per line, as many PDFs emit) ---- */
    (function () {
      // 14 lines a side is a real page; requiring 40 runs meant pages like this
      // were read straight across, interleaving the columns.
      var boxes = [];
      for (var i = 0; i < 14; i++) {
        var y = 700 - i * 14;
        boxes.push(line('left hand column line number ' + i, 56, y, 220));
        boxes.push(line('right hand column line ' + i, 320, y, 220));
      }
      var g = P.detectColumns(boxes, 612);
      eq('a sparse two-column page is still detected', g !== null, true);
      eq('its gutter falls between the columns', g > 275 && g < 325, true);

      var ls = P.toLines(boxes, g);
      eq('the left column is read before the right',
         ls.slice(0, 14).every(function (l) { return l.text.indexOf('left') === 0; }), true);
    })();

    /* ---- two columns ---- */
    (function () {
      var boxes = [];
      // 24 lines per column, interleaved in y exactly as a real page would be.
      for (var i = 0; i < 24; i++) {
        var y = 700 - i * 14;
        boxes.push(line('left line ' + i + ' of the first column here', 50, y, 220));
        boxes.push(line('right line ' + i + ' of the second column', 320, y, 220));
      }
      var gutter = P.detectColumns(boxes, 600);
      eq('a two-column page is detected', gutter !== null, true);
      eq('the gutter is found between the columns', gutter > 270 && gutter < 320, true);

      var ls = P.toLines(boxes, gutter);
      eq('all lines survive column sorting', ls.length, 48);
      eq('the whole left column comes before the right',
         ls.slice(0, 24).every(function (l) { return l.text.indexOf('left') === 0; }) &&
         ls.slice(24).every(function (l) { return l.text.indexOf('right') === 0; }),
         true);
    })();

    /* ---- word-level text layers: the case that used to break ---- */
    (function () {
      // Many PDFs emit one run per WORD. Almost no single word straddles the
      // page centre, so a straddle-counting heuristic saw two columns here and
      // read the page in the wrong order.
      var boxes = [];
      for (var row = 0; row < 30; row++) {
        var y = 700 - row * 14;
        var x = 50;
        for (var w = 0; w < 9; w++) {
          boxes.push(line('word' + w, x, y, 48));
          x += 55;                         // runs straight across the midline
        }
      }
      eq('a word-level single-column page is not split into two',
         P.detectColumns(boxes, 600), null);
    })();

    /* ---- a two-column page with a full-width title is still two columns ---- */
    (function () {
      var boxes = [];
      for (var i = 0; i < 24; i++) {
        var y = 700 - i * 14;
        boxes.push(line('left line ' + i + ' of the first column here', 50, y, 220));
        boxes.push(line('right line ' + i + ' of the second column', 320, y, 220));
      }
      // One run spanning both columns: a title, a wide caption, a licence line.
      boxes.push(line('A Full Width Title Across Both Columns', 50, 760, 500));
      eq('one full-width run does not kill gutter detection',
         P.detectColumns(boxes, 600) !== null, true);

      var withCaption = boxes.slice();
      withCaption.push(line('Figure 1. A caption spanning the full page width', 50, 400, 500));
      withCaption.push(line('Open access under CC BY 4.0 - see the publisher', 50, 30, 500));
      eq('three full-width runs still do not kill it',
         P.detectColumns(withCaption, 600) !== null, true);
    })();

    /* ---- a full-width element defeats column detection, safely ---- */
    (function () {
      var boxes = [];
      for (var i = 0; i < 30; i++) {
        boxes.push(line('a full width line of running text across the page', 50, 700 - i * 14, 500));
      }
      eq('full-width text is not mistaken for two columns',
         P.detectColumns(boxes, 600), null);
    })();

    /* ---- running heads ---- */
    (function () {
      var BODY = [
        'The effect replicated across every cohort we tested.',
        'Participants were recruited from two separate sites.',
        'We found no evidence for the alternative account.',
        'Signal quality was verified before any analysis ran.'
      ];
      function page(n) {
        return {
          height: 800,
          lines: [
            { text: 'Journal of Test Results | VOL 12 | ' + (100 + n), y: 780, left: 50, right: 550, h: 8, col: 0, items: [] },
            { text: BODY[n - 1], y: 700, left: 50, right: 550, h: 10, col: 0, items: [] },
            { text: String(100 + n), y: 40, left: 300, right: 310, h: 8, col: 0, items: [] }
          ]
        };
      }
      var heads = P.findRunningHeads([page(1), page(2), page(3), page(4)]);
      eq('a repeated running head is detected',
         !!heads[P.normaliseForRepeat('Journal of Test Results | VOL 12 | 101')], true);
      eq('ordinary body text is not detected as a running head',
         !!heads[P.normaliseForRepeat(BODY[0])], false);

      // The dangerous case: prose that differs between pages ONLY by a number.
      // Digit normalisation makes it look repeated, so the furniture guard has
      // to reject it on other grounds.
      eq('a mid-sentence continuation is never furniture',
         P.isFurniture('and the effect grew by 3 points on every trial'), false);
      eq('a long prose line is never furniture',
         P.isFurniture('Body text on page 1 which differs every time and runs on much further than a header would'), false);
      eq('a complete sentence is never furniture',
         P.isFurniture('We measured the response of every participant twice.'), false);
      eq('a real running head is furniture',
         P.isFurniture('Journal of Test Results | VOL 12 | 101'), true);
      eq('a bare page number is furniture', P.isFurniture('101'), true);

      eq('a bare page number is recognised', P.PAGE_NUMBER.test('  12  '), true);
      eq('page N of M is recognised', P.PAGE_NUMBER.test('3 of 12'), true);
      eq('real text is not a page number', P.PAGE_NUMBER.test('12 subjects'), false);
    })();

    /* ---- a repeated caption that MOVES is not a running head ---- */
    (function () {
      // Digit normalisation makes "Table 1" and "Table 2" the same key. Without
      // checking that the line stays in the same place, a caption drifting down
      // the page would be deleted as furniture.
      function page(n, y) {
        return {
          height: 800,
          lines: [
            { text: 'Table ' + n, y: y, left: 50, right: 160, h: 9, col: 0, items: [] },
            { text: 'Body prose unique to page ' + 'abcd'[n - 1], y: 400, left: 50, right: 550, h: 10, col: 0, items: [] }
          ]
        };
      }
      var heads = P.findRunningHeads([page(1, 780), page(2, 120), page(3, 770), page(4, 60)]);
      eq('a caption that moves around the page is not furniture',
         !!heads[P.normaliseForRepeat('Table 1')], false);

      // Even pinned to the same spot, "Table N" is a heading, not furniture:
      // one word plus a number is exactly what a numbered heading looks like.
      var fixed = P.findRunningHeads([page(1, 780), page(2, 779), page(3, 781), page(4, 780)]);
      eq('a numbered heading is never furniture, even at a fixed position',
         !!fixed[P.normaliseForRepeat('Table 1')], false);
    })();

    /* ---- numbered headings must survive; real running heads must not ---- */
    (function () {
      eq('"Problem 1" is a heading, not a running head', P.isFurniture('Problem 1'), false);
      eq('"Chapter 3" is a heading', P.isFurniture('Chapter 3'), false);
      eq('"Question 12" is a heading', P.isFurniture('Question 12'), false);
      eq('a journal running head is furniture',
         P.isFurniture('Journal of Test Results | VOL 12 | 101'), true);
      eq('a publication line is furniture',
         P.isFurniture('Nature Neuroscience, Vol 24, 1189'), true);
      eq('a two-word masthead is furniture', P.isFurniture('Nature Neuroscience'), true);
      eq('a bare page number is furniture', P.isFurniture('  101  '), true);
    })();

    /* ---- paragraphs cut by a column or page break ---- */
    (function () {
      var blocks = [
        { type: 'p', text: 'The measured response increased steadily until it', brokeColumn: false },
        { type: 'p', text: 'reached a plateau after ten trials.', brokeColumn: true },
        { type: 'p', text: 'A new paragraph begins here.', brokeColumn: false }
      ];
      var merged = P.mergeContinuations(blocks);
      eq('a paragraph split across a column break is rejoined', merged.length, 2);
      eq('the rejoined text reads continuously', merged[0].text,
         'The measured response increased steadily until it reached a plateau after ten trials.');

      var headed = P.mergeContinuations([
        { type: 'p', text: 'Ends without punctuation', brokeColumn: false },
        { type: 'h', text: 'Discussion', brokeColumn: true }
      ]);
      eq('a heading is never merged into the paragraph before it', headed.length, 2);

      var finished = P.mergeContinuations([
        { type: 'p', text: 'This paragraph is complete.', brokeColumn: false },
        { type: 'p', text: 'lowercase start but previous was finished', brokeColumn: true }
      ]);
      eq('a finished sentence is not merged with what follows', finished.length, 2);
    })();

    /* ---- a trailing abbreviation is not a paragraph end ---- */
    (function () {
      eq('a real sentence end is recognised', P.endsSentence('observed in these data.'), true);
      eq('"and cf." is not a sentence end', P.endsSentence('the distribution, and cf.'), false);
      eq('"et al." is not a sentence end', P.endsSentence('as shown by Smith et al.'), false);
      eq('"Fig." is not a sentence end', P.endsSentence('as shown in Fig.'), false);
      eq('a question mark ends a sentence', P.endsSentence('does it generalise?'), true);

      // The line pair that exposed this on a real PDF: a short line ending in
      // an abbreviation, followed by a capitalised word.
      var lines = [
        { text: 'See Fig. 3 for the full distribution, and cf.', y: 700, left: 56, right: 260, h: 10, col: 0 },
        { text: 'Jones for a contrasting account of the data.', y: 687, left: 56, right: 280, h: 10, col: 0 }
      ];
      var blocks = P.linesToBlocks(lines, 10, true);
      eq('the paragraph is not cut after an abbreviation', blocks.length, 1);
    })();

    /* ---- a two-column page must not measure "short line" against the page ---- */
    (function () {
      var lines = [];
      for (var i = 0; i < 8; i++) {
        lines.push({ text: 'Left column line ' + i + ' continuing on.', y: 700 - i * 13,
                     left: 56, right: 280, h: 10, col: 0 });
      }
      for (var j = 0; j < 8; j++) {
        lines.push({ text: 'Right column line ' + j + ' continuing on.', y: 700 - j * 13,
                     left: 320, right: 545, h: 10, col: 1 });
      }
      eq('per-column edges, not one page-wide maximum',
         P.columnEdges(lines), { '0': 280, '1': 545 });

      // Every left line is narrower than the widest RIGHT line, so a global
      // edge made the short-last-line rule fire on all of them.
      var blocks = P.linesToBlocks(lines, 10, false);
      eq('a two-column page is not chopped into one block per line',
         blocks.length <= 4, true);
    })();

    /* ---- matching rendered spans back to their text runs ---- */
    (function () {
      // A fake span: only .textContent matters to alignSpans.
      function sp(t) { return { textContent: t }; }
      function boxesFor(strs) { return strs.map(function (t) { return { str: t }; }); }

      var runs = ['Alpha ', 'beta ', 'gamma', 'delta'];

      var exact = boxesFor(runs);
      eq('an exact 1:1 layer matches every span',
         P.alignSpans(exact, runs.map(sp)), 4);
      eq('and each run gets its own span',
         exact.every(function (b, i) { return b.el.textContent === runs[i]; }), true);

      // The case that broke on a real paper: the layer has one span MORE than
      // the runs we kept, because a rotated figure label was filtered out.
      var withExtra = boxesFor(runs);
      var spansPlus = runs.map(sp);
      spansPlus.splice(2, 0, sp('90deg label'));
      eq('an unexpected extra span does not derail the rest',
         P.alignSpans(withExtra, spansPlus), 4);
      eq('the runs after the extra span are still matched correctly',
         withExtra[3].el.textContent, 'delta');

      // And one span FEWER than runs.
      var withFewer = boxesFor(runs);
      eq('a missing span leaves the others aligned',
         P.alignSpans(withFewer, [sp('Alpha '), sp('gamma'), sp('delta')]), 3);
      eq('the skipped run has no span', withFewer[1].el, undefined);
      eq('later runs still line up', withFewer[2].el.textContent, 'gamma');

      // Repeated text must not all collapse onto one run.
      var repeated = boxesFor(['the', 'the', 'the']);
      eq('repeated strings each claim a distinct run',
         P.alignSpans(repeated, [sp('the'), sp('the'), sp('the')]), 3);
      eq('and they are distinct span objects',
         repeated[0].el !== repeated[1].el && repeated[1].el !== repeated[2].el, true);

      eq('no spans matches nothing', P.alignSpans(boxesFor(runs), []), 0);
    })();

    /* ---- headings ---- */
    (function () {
      var body = { text: 'and so the effect was robust across samples.', h: 10, left: 50, right: 550 };
      var numbered = { text: '3. Results', h: 10, left: 50, right: 120 };
      var named = { text: 'Discussion', h: 10, left: 50, right: 130 };
      var bigger = { text: 'A Larger Title', h: 14, left: 50, right: 200 };
      eq('body text is not a heading', P.isHeadingLine(body, 10), false);
      eq('a numbered heading is detected', P.isHeadingLine(numbered, 10), true);
      eq('a known section name is detected', P.isHeadingLine(named, 10), true);
      eq('a larger font is detected as a heading', P.isHeadingLine(bigger, 10), true);
    })();

    /* ---- word spacing when runs are adjacent vs separated ---- */
    (function () {
      eq('adjacent runs are not given a spurious space',
         P.joinItems([{ str: 'inter', x: 50, w: 25, h: 10 }, { str: 'national', x: 75, w: 40, h: 10 }]),
         'international');
      eq('separated runs get a space',
         P.joinItems([{ str: 'two', x: 50, w: 20, h: 10 }, { str: 'words', x: 78, w: 30, h: 10 }]),
         'two words');
    })();

    /* ---- degenerate input must not throw ---- */
    (function () {
      eq('no lines produces no blocks', P.linesToBlocks([], 10, true), []);
      eq('a single line produces one block',
         P.linesToBlocks([{ text: 'Only one line here.', y: 700, left: 50, right: 300, h: 10, col: 0 }], 10, true).length,
         1);
      eq('empty boxes produce no lines', P.toLines([], null), []);
    })();

    return {
      pass: pass, fail: fail,
      report: lines.join('\n') + '\n\n==== ' + pass + ' passed, ' + fail + ' failed ===='
    };
  }

  FR.pdfTests = { run: run };
})(typeof globalThis !== 'undefined' ? globalThis : this);
