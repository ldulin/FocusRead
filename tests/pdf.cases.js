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

    /* ---- single column ---- */
    (function () {
      var boxes = [
        line('The first sentence of the paragraph runs', 50, 700, 400),
        line('across two lines and ends here.', 50, 686, 300),
        line('A second paragraph starts after a wider', 50, 660, 400),
        line('vertical gap than the line spacing.', 50, 646, 320)
      ];
      var gutter = P.detectColumns(boxes, 600);
      eq('a short page is not treated as two columns', gutter, null);

      var ls = P.toLines(boxes, gutter);
      eq('four visual lines are recovered', ls.length, 4);
      eq('line text is joined correctly', ls[0].text,
         'The first sentence of the paragraph runs');

      var blocks = P.linesToBlocks(ls, 10, true);
      eq('a wider gap starts a new paragraph', blocks.length, 2);
      eq('paragraph one is joined from its two lines', blocks[0].text,
         'The first sentence of the paragraph runs across two lines and ends here.');
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

      var fixed = P.findRunningHeads([page(1, 780), page(2, 779), page(3, 781), page(4, 780)]);
      eq('the same text pinned to the same place IS furniture',
         !!fixed[P.normaliseForRepeat('Table 1')], true);
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
