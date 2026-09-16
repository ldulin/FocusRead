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

    /* ---- a line starting with a decimal is not a numbered heading ---- */
    (function () {
      function ln(t) { return { text: t, h: 10, left: 56, right: 280, y: 700, col: 0 }; }

      // The exact line that caused line-by-line reading: "6.5" matched the
      // same ^\d+(\.\d+)* pattern as "3.1 Methods".
      eq('a decimal measurement is not a heading',
         P.isHeadingLine(ln('6.5 min. The dataset is open access. We'), 10), false);
      eq('nor is a p-value line',
         P.isHeadingLine(ln('0.05 was the threshold we adopted throughout'), 10), false);
      eq('nor a bare measurement mid-paragraph',
         P.isHeadingLine(ln('22.4 yrs on average across the three cohorts'), 10), false);

      // Real numbered headings must still be recognised.
      eq('"1 Introduction" is a heading', P.isHeadingLine(ln('1 Introduction'), 10), true);
      eq('"3. Results" is a heading', P.isHeadingLine(ln('3. Results'), 10), true);
      eq('"3.1 Data analysis" is a heading', P.isHeadingLine(ln('3.1 Data analysis'), 10), true);
      eq('a named section is still a heading', P.isHeadingLine(ln('Discussion'), 10), true);

      /* ---- a journal abstract is body text set in a larger face ----
       * Measured from Nature Communications: body lines 8.2pt, the abstract
       * 1.21x that and running to the right margin, the title 3.15x and
       * falling 85pt short of it. Judging by size alone made every abstract
       * line a heading of its own, so nothing joined into a paragraph: the
       * hyphen at "Topo- graphic" never rejoined and each line was read out as
       * if it were a sentence.
       */
      var EDGE = 561;
      function big(t, right) { return { text: t, h: 9.95, left: 320, right: right, y: 600, col: 0 }; }
      function title(t, right) { return { text: t, h: 25.9, left: 40, right: right, y: 700, col: 0 }; }
      var measure = { rightEdge: EDGE, prev: null };

      eq('a title is a heading even though it stops short of the margin',
         P.isHeadingLine(title('A single computational objective can', 476), 8.22, measure), true);
      eq('an abstract line running to the margin is not a heading',
         P.isHeadingLine(big('units to respond similarly, better captures brain', 558), 8.22, measure),
         false);
      eq('nor is one a few points short of it',
         P.isHeadingLine(big('emerged to support distinct visual behaviors. Here', 535), 8.22, measure),
         false);
      eq('the paragraph\'s short last line carries on from the filled one',
         P.isHeadingLine(big('local spatial constraints.', 325), 8.22,
                         { rightEdge: EDGE, prev: big('a single principle: learning generally useful', 556) }),
         false);
      eq('but a short larger-set line on its own is a heading',
         P.isHeadingLine(big('Results', 360), 8.22,
                         { rightEdge: EDGE, prev: { text: 'body text', h: 8.2, left: 320, right: 558, y: 610, col: 0 } }),
         true);
      /* ---- a title wrapped over three lines is ONE heading ----
       * Measured from the same paper: three lines of 25.9pt display type,
       * 27.9pt apart, against a body gap of about 10pt. Each line is a heading
       * on its own and a heading breaks the block either side of it, so the
       * title arrived as three reading units - "A single computational
       * objective can", "produce specialization of streams in", "visual
       * cortex" - and clicking it read a third of a title.
       */
      (function () {
        function tl(t, y) { return { text: t, h: 25.9, left: 40, right: 476, y: y, col: 0 }; }
        var body = function (t, y) { return { text: t, h: 8.22, left: 40, right: 558, y: y, col: 0 }; };
        var blocks = P.linesToBlocks([
          tl('A single computational objective can', 657),
          tl('produce specialization of streams in', 629.1),
          tl('visual cortex', 601.2),
          body('Received: 19 April 2026', 554.6),
          body('and the paragraph that follows it continues here', 544.6)
        ], 8.22, true);
        eq('the three title lines are one block', blocks[0].text,
           'A single computational objective can produce specialization of streams in visual cortex');
        eq('and it is still a heading', blocks[0].type, 'h');
        eq('what follows it is not swallowed', blocks[1].type, 'p');

        // Two headings of the same size that are far apart stay apart.
        var far = P.linesToBlocks([
          tl('First display heading', 657),
          tl('A second one much further down', 400)
        ], 8.22, true);
        eq('display lines far apart are separate headings', far.length, 2);
      })();

      eq('with no measure to judge by, larger type is still a heading',
         P.isHeadingLine(big('units to respond similarly, better captures brain', 558), 8.22), true);

      eq('a complete sentence is never a heading',
         P.hasInnerTerminator('6.5 min. The dataset is open access.'), true);
      eq('an abbreviation is not an inner terminator',
         P.hasInnerTerminator('See Fig. 3 for the distribution'), false);

      // End to end: the three lines that were being split apart.
      var lines = [
        { text: 'Participants (N = 24, mean age 22.4 yrs)', y: 700, left: 56, right: 262, h: 10, col: 0 },
        { text: 'completed 3 runs of the task. Each run took', y: 687, left: 56, right: 277, h: 10, col: 0 },
        { text: '6.5 min. The dataset is open access. We', y: 674, left: 56, right: 263, h: 10, col: 0 },
        { text: 'used a Butterworth filter, i.e. a maximally', y: 661, left: 56, right: 275, h: 10, col: 0 }
      ];
      var blocks = P.linesToBlocks(lines, 10, true);
      eq('the four lines stay one paragraph', blocks.length, 1);
      eq('so the sentence is whole',
         blocks[0].text.indexOf('Each run took 6.5 min.') !== -1, true);
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
      /* ---- two regions at the same height are not one line ---- */
      (function () {
        // The Crossmark badge sits in the margin at the same height as a line
        // of the abstract. Joined, it lands inside the sentence: "ventral
        // streams. A Check for updates long-standing hypothesis is that...".
        var boxes = [
          { str: 'Check for updates', x: 40, y: 600, w: 70, h: 8 },
          { str: 'long-standing hypothesis is that the organization', x: 320, y: 600, w: 240, h: 8 }
        ].map(function (b) { return { str: b.str, x: b.x, y: b.y, w: b.w, h: b.h }; });
        var ls = P.toLines(boxes.map(function (b) {
          return { str: b.str, x: b.x, y: b.y, w: b.w, h: b.h, text: b.str };
        }), null);
        eq('a marginal badge is not joined to the text beside it', ls.length, 2);
        eq('the badge keeps its own extent', Math.round(ls[0].right), 110);
        eq('and the text keeps its own', Math.round(ls[1].left), 320);

        // Ordinary spacing within a line must still be one line.
        var near = P.toLines([
          { str: 'ordinary words', x: 320, y: 500, w: 60, h: 8, text: 'ordinary words' },
          { str: 'with normal spacing', x: 384, y: 500, w: 70, h: 8, text: 'with normal spacing' }
        ], null);
        eq('normal word spacing does not split a line', near.length, 1);
      })();

      eq('empty boxes produce no lines', P.toLines([], null), []);
    })();

    lines.push('\n--- matching a sentence against the lines of a page image ---');
    (function () {
      var P = FR.pdf;
      // Real text from a paper: the sentence being read, and lines as the page
      // image breaks them - which is not where the sentences break.
      var S = 'This matters for a resource paper: it means the procedures reported ' +
              'here can be applied to network estimates from other laboratories, in ' +
              'other participants, without reimplementation.';

      eq('a line wholly inside the sentence belongs to it',
         P.lineInSentence('procedures reported here can be applied to network', S), true);
      eq('so does the line that finishes it',
         P.lineInSentence('other participants, without reimplementation.', S), true);
      eq('a line that straddles the sentence before it does not',
         P.lineInSentence('parcel outlines as Connectome Workbench border files. This matters for a', S), false);
      eq('nor does a line of the next paragraph',
         P.lineInSentence('Uploaded maps are processed in temporary storage and purged', S), false);
      eq('nor a heading', P.lineInSentence('Discussion', S), false);
      eq('nor a page number', P.lineInSentence('7', S), false);
      eq('nor an empty line', P.lineInSentence('   ', S), false);
      eq('nor nothing at all', P.lineInSentence(null, S), false);

      // Hyphenation survives the rejoin: the image keeps "inter- national",
      // the reflowed sentence has "international".
      eq('a hyphen broken across the line still matches',
         P.lineInSentence('variation observed in these data', 'The inter- national variation observed in these data is small.'), true);

      eq('word overlap ignores punctuation and case',
         P.overlap(P.tokenSet('Gordon et al. (2016)'), 'gordon et al 2016 derived areal boundaries'), 1);
      eq('words of one or two letters are dropped',
         Object.keys(P.tokenSet('a of an to is it')).length, 0);
      eq('longer ones are kept, lowercased',
         Object.keys(P.tokenSet('The And Gordon')).sort(), ['and', 'gordon', 'the']);
    })();

    lines.push('\n--- a journal highlights page: two columns under a full-width title ---');
    (function () {
      // Geometry from a Neuron first page: the title spans both columns, the
      // Highlights list is the left one and Authors / Correspondence / In
      // brief the right, with a fifteen-point gutter at 58% across. The bullet
      // is one glyph from a dingbat font, which extracts as the letter "d".
      function B(str, x, y, w, h, f) {
        return { str: str, x: x, y: y, w: w, h: h, font: f || 'body' };
      }
      var boxes = [
        B('Neuron', 54, 700, 90, 22, 'display'),
        B('Article', 470, 706, 50, 12, 'display'),
        B('A unifying framework for functional organization in', 54, 668, 476, 14, 'display'),
        B('early and higher ventral visual cortex', 54, 650, 330, 14, 'display'),
        B('Highlights', 54, 618, 60, 10, 'bold'),
        B('Authors', 352, 618, 50, 10, 'bold')
      ];
      [['Single model predicts function and spatial structure in early', 600],
       ['and higher visual cortex', 589],
       ['Best model uses self-supervised learning and a scalable', 572],
       ['spatial constraint', 561]].forEach(function (pair, i) {
        if (i % 2 === 0) boxes.push(B('d', 54, pair[1], 5, 8, 'dingbat'));
        boxes.push(B(pair[0], 66, pair[1], 271, 8));
      });
      [['Eshed Margalit, Hyodong Lee,', 600],
       ['Dawn Finzi, James J. DiCarlo,', 589],
       ['Correspondence', 546],
       ['eshed.margalit@gmail.com', 535]].forEach(function (pair) {
        boxes.push(B(pair[0], 352, pair[1], 189, 8));
      });

      var gutter = P.detectColumns(boxes, 595);
      eq('the gutter between the two columns is found', Math.round(gutter || 0), 345);

      var ls = P.toLines(boxes, gutter);
      var mixed = ls.filter(function (l) {
        return /Margalit|Finzi|Correspondence/.test(l.text) &&
               /model|constraint|cortex/.test(l.text);
      });
      eq('no line mixes the two columns', mixed.length, 0);

      var blocks = P.linesToBlocks(ls, 8, true);
      var texts = blocks.map(function (b) { return b.text; });
      eq('a wrapped list item is one block, with a real bullet',
         texts.indexOf('\u2022 Single model predicts function and spatial structure in early and higher visual cortex') !== -1,
         true);
      eq('and the next item is its own block',
         texts.indexOf('\u2022 Best model uses self-supervised learning and a scalable spatial constraint') !== -1,
         true);
      eq('the letter the dingbat extracts as is gone',
         texts.some(function (t) { return /(^|\s)d\s/.test(t); }), false);
      eq('the author list is not broken up',
         texts.indexOf('Eshed Margalit, Hyodong Lee, Dawn Finzi, James J. DiCarlo,') !== -1, true);
    })();

    lines.push('\n--- a gutter is measured from the boxes, not the bins ---');
    (function () {
      // 200 bins over a 595pt page is 3pt each, and coverage rounds outward at
      // both ends, so a real 15pt gutter measured as 9pt and failed the floor.
      var boxes = [];
      for (var i = 0; i < 10; i++) {
        boxes.push({ str: 'left column text here', x: 54, y: 600 - i * 11, w: 283, h: 8 });
        boxes.push({ str: 'right column text here', x: 352, y: 600 - i * 11, w: 189, h: 8 });
      }
      boxes.push({ str: 'a title across both of them', x: 54, y: 660, w: 476, h: 14 });
      var g = P.detectColumns(boxes, 595);
      eq('a fifteen-point gutter is wide enough', g !== null, true);
      eq('and it is placed between the columns, not at a bin edge',
         Math.round(g || 0), 345);

      // A genuinely narrow gap is still rejected.
      var tight = [];
      for (var k = 0; k < 10; k++) {
        tight.push({ str: 'left', x: 54, y: 600 - k * 11, w: 291, h: 8 });
        tight.push({ str: 'right', x: 350, y: 600 - k * 11, w: 191, h: 8 });
      }
      eq('a five-point gap is not a gutter', P.detectColumns(tight, 595), null);
    })();

    return {
      pass: pass, fail: fail,
      report: lines.join('\n') + '\n\n==== ' + pass + ' passed, ' + fail + ' failed ===='
    };
  }

  FR.pdfTests = { run: run };
})(typeof globalThis !== 'undefined' ? globalThis : this);
