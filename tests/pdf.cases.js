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

    /* ---- facing pages: the page number swaps ends ---- */
    (function () {
      // Cell Press: the page number is at the outer edge, so odd and even pages
      // carry the "same" footer with the number at opposite ends, and the
      // supplement's pages are numbered e1, e2 ... with the "ll" mark beside.
      function page(n, foot) {
        return {
          height: 783,
          lines: [
            { text: 'Body prose that is only on page ' + 'abcdefgh'[n - 1], y: 400, left: 50, right: 550, h: 10, col: 0, items: [] },
            { text: foot, y: 21, left: 50, right: 550, h: 8, col: 0, items: [] }
          ]
        };
      }
      var feet = [
        '2436 Neuron 112, 2435–2451, July 17, 2024',
        'Neuron 112, 2435–2451, July 17, 2024 2437 ll',
        '2438 Neuron 112, 2435–2451, July 17, 2024',
        'Neuron 112, 2435–2451, July 17, 2024 2439 ll',
        '2440 Neuron 112, 2435–2451, July 17, 2024',
        'Neuron 112, 2435–2451, July 17, 2024 2441 ll'
      ];
      var heads = P.findRunningHeads(feet.map(function (f, i) { return page(i + 1, f); }));
      eq('a footer with the page number first is a running head',
         !!heads[P.normaliseForRepeat(feet[0])], true);
      eq('and so is the facing page\'s, with the number last',
         !!heads[P.normaliseForRepeat(feet[1])], true);
      eq('"e3 ... ll" and "... e4 ll" supplement footers are one key',
         P.normaliseForRepeat('e3 Neuron 112, 2435–2451.e1–e7, July 17, 2024 ll') ===
         P.normaliseForRepeat('Neuron 112, 2435–2451.e1–e7, July 17, 2024 e4 ll'), true);
      eq('a first page that runs its footer on with more is still the footer',
         P.isRunningHead(heads, 'Neuron 112, 2435\u20132451, July 17, 2024 \u00AA 2024 Elsevier Inc. All rights reserved. 2435 ll'), true);
      eq('a line that merely mentions the journal is not',
         P.isRunningHead(heads, 'Neuron reported in 2024 that the effect held'), false);

      // The supplement's own footer is on all of its pages but few of the paper's.
      var many = [];
      for (var i = 1; i <= 25; i++) {
        var f = i < 19 ? (i % 2 ? i + 2433 + ' Neuron 112, 2435\u20132451, July 17, 2024'
                                : 'Neuron 112, 2435\u20132451, July 17, 2024 ' + (i + 2433) + ' ll')
                       : (i % 2 ? 'e' + (i - 18) + ' Neuron 112, 2435\u20132451.e1\u2013e7, July 17, 2024 ll'
                                : 'Neuron 112, 2435\u20132451.e1\u2013e7, July 17, 2024 e' + (i - 18) + ' ll');
        many.push({ page: i, height: 783, lines: [
          { text: 'Body prose that is only on page number ' + 'abcdefghijklmnopqrstuvwxy'[i - 1], y: 400, left: 50, right: 550, h: 10, col: 0, items: [] },
          { text: f, y: 21, left: 50, right: 550, h: 8, col: 0, items: [] }
        ] });
      }
      var heads25 = P.findRunningHeads(many);
      eq('the supplement footer, on 7 of 25 pages, is a running head',
         P.isRunningHead(heads25, 'e3 Neuron 112, 2435\u20132451.e1\u2013e7, July 17, 2024 ll'), true);
      eq('and the main footer still is',
         P.isRunningHead(heads25, '2436 Neuron 112, 2435\u20132451, July 17, 2024'), true);
      eq('the lone Cell Press mark is furniture', P.isFurniture('ll'), true);
      var marked = [1, 2, 3, 4, 5, 6].map(function (i) {
        return { page: i, height: 783, lines: [
          { text: 'll', y: i === 1 ? 51 : 718, left: 50, right: 60, h: 8, col: 0, items: [] },
          { text: 'Body prose that is only on page ' + 'abcdef'[i - 1], y: 400, left: 50, right: 550, h: 10, col: 0, items: [] }] };
      });
      eq('a mark at the top of every page but the first is still a running head',
         P.isRunningHead(P.findRunningHeads(marked), 'll'), true);
      eq('a three-page run is not enough on its own',
         !!P.findRunningHeads([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (i) {
           return { page: i, height: 800, lines: [
             { text: i >= 4 && i <= 6 ? 'Table 2 (continued) for site ' + i : 'Unique prose ' + 'abcdefghij'[i - 1], y: 780, left: 50, right: 550, h: 9, col: 0, items: [] }] };
         }))[P.normaliseForRepeat('Table 2 (continued) for site 4')], false);
      eq('"Table 1" keeps its number in the key - it is two words in all',
         P.normaliseForRepeat('Table 1'), 'table #');
    })();

    /* ---- a footer across the gutter of a two-column page ---- */
    (function () {
      // Neuron, page 2: the footer starts 40% across - not wide by the 35-65%
      // test - and its runs either side of the gutter were split between the
      // columns, so "Neuron 112" was read before the right column's first words.
      function mk(t, x, y, w, f) { return { str: t, x: x, y: y, w: w, h: 8, font: f || 'body' }; }
      var boxes = [];
      for (var k = 0; k < 10; k++) {
        boxes.push(mk(k === 9 ? 'have been developed, but these approaches do not gener-' : 'left column body text that runs across the column', 53, 289 - k * 11, 238));
        boxes.push(mk(k === 0 ? 'alize to multiple areas. Moreover, many prior models utilize' : 'right column body text that runs across its column', 304, 289 - k * 11, 239));
      }
      boxes.push(mk('Neuron 112', 244, 21, 40, 'italic'));
      boxes.push(mk(', 2435–2451, July 17, 2024 ª 2024 Elsevier Inc. All rights reserved.', 284, 21, 237));
      boxes.push(mk('2435', 526, 21, 18, 'bold'));
      var ls = P.toLines(boxes.slice(), P.assignColumns(boxes, 603));
      var foot = ls.filter(function (l) { return /Neuron 112/.test(l.text); });
      eq('the footer is one line', foot.length === 1 && /Neuron 112.*2435–2451.*Elsevier/.test(foot[0].text), true);
      var alize = ls.map(function (l) { return l.text; }).indexOf('alize to multiple areas. Moreover, many prior models utilize');
      eq('the right column still begins with its own first words',
         alize > 0 && /gener-$/.test(ls[alize - 1].text), true);
      eq('and the footer comes after both columns', ls.indexOf(foot[0]) > alize, true);

      // The real page 2 has a full-width summary above the columns, and then
      // there is no page-wide gutter: the one between the columns must do.
      var top = [];
      for (k = 0; k < 24; k++) {
        top.push(mk('A key feature of cortical systems is functional organization: the arrangement of functionally distinct', 53, 640 - k * 11, 491));
      }
      var page2 = top.concat(boxes.map(function (b) { return mk(b.str, b.x, b.y, b.w, b.font); }));
      var ls2 = P.toLines(page2.slice(), P.assignColumns(page2, 603));
      var foot2 = ls2.filter(function (l) { return /Neuron 112/.test(l.text); });
      var alize2 = ls2.map(function (l) { return l.text; }).indexOf('alize to multiple areas. Moreover, many prior models utilize');
      eq('below a full-width summary the footer is still one line',
         foot2.length === 1 && /Neuron 112.*Elsevier/.test(foot2[0].text), true);
      eq('and the right column still follows "gener-"', alize2 > 0 && /gener-$/.test(ls2[alize2 - 1].text), true);
    })();

    /* ---- the edge rows of a two-column page ---- */
    (function () {
      function mk(t, x, y, w, h) { return { str: t, x: x, y: y, w: w, h: h || 10, font: 'body' }; }
      function order(boxes, W) {
        return P.toLines(boxes.slice(), P.assignColumns(boxes, W)).map(function (l) { return l.text.split(' ')[0]; });
      }
      function before(o, a, b) { return o.indexOf(a) >= 0 && o.indexOf(a) < o.indexOf(b); }
      // A centred running head over the gutter, and a picture at the top of
      // the left column (no text runs), so the right column starts higher.
      var a = [mk('L. Du et al. / NeuroImage 280 (2023) 120345', 220, 760, 172, 8)];
      for (var k = 0; k < 45; k++) {
        a.push(mk('R' + k + ' right column words', 314, 740 - 12 * k, 255));
        if (k >= 13) a.push(mk('L' + k + ' left column words', 43, 740 - 12 * k, 257));
      }
      var oa = order(a, 612);
      eq('a head over the gutter does not pull the right column ahead of the left',
         before(oa, 'L44', 'R0') && before(oa, 'R12', 'R13'), true);
      eq('and is read first', oa[0], 'L.');

      // A slide: a title over two text boxes of different leading.
      var b = [mk('Encoding results across the four subjects', 36, 480, 394, 30)];
      for (k = 0; k < 8; k++) b.push(mk('L' + k + ' left bullet', 36, 420 - 30 * k, 300, 18));
      for (k = 0; k < 9; k++) b.push(mk('R' + k + ' right bullet', 380, 405 - 26 * k, 300, 18));
      var ob = order(b, 720);
      eq('a slide reads its left box, then its right', before(ob, 'L7', 'R0') && before(ob, 'L0', 'L1'), true);

      // A numbered equation in the left column of a page whose columns are
      // half a line out of step: the only gap at mid-page is the equation's.
      var c = [];
      for (k = 0; k < 45; k++) {
        if (k === 20) { c.push(mk('E = mc^2 + x', 120, 740 - 12 * k, 100)); c.push(mk('(3)', 285, 740 - 12 * k, 15)); }
        else c.push(mk('L' + k + ' left column words', 43, 740 - 12 * k, 257));
        c.push(mk('R' + k + ' right column words', 314, 740 - 12 * k - 6, 255));
      }
      var oc = order(c, 612);
      eq('an equation number does not set the gutter', before(oc, 'L44', 'R0') && before(oc, 'L0', 'L1'), true);

      // A URL running past the gutter in the left column, below the end of
      // the right one.
      var d = [];
      for (k = 0; k < 45; k++) {
        d.push(mk(k === 37 ? 'L37 https://github.com/someone/a-very-long-repository-name' : 'L' + k + ' left column words', 43, 740 - 12 * k, k === 37 ? 290 : 257));
        if (k < 30) d.push(mk('R' + k + ' right column words', 314, 740 - 12 * k, 255));
      }
      var od = order(d, 612);
      eq('an overlong line stays in its column', before(od, 'L44', 'R0') && before(od, 'L36', 'L37') && before(od, 'L37', 'L38'), true);
    })();

    /* ---- headings that repeat are not running heads ---- */
    (function () {
      function ln(t, y, h) { return { text: t, y: y, left: 12, right: 300, h: h || 12, col: 0, items: [] }; }
      // A deck built up a step at a time: the same title on consecutive slides.
      var titles = ['Motivation', 'Prior work on ventral stream', 'Our approach', 'Datasets used here', 'Results', 'Results', 'Results', 'Results',
        'Interim summary', 'Encoding models', 'Fitting procedure', 'Model architecture', 'Model architecture', 'Model architecture',
        'Model architecture', 'Comparison to baselines', 'Limitations of this study', 'Future directions', 'Acknowledgements', 'Questions and discussion'];
      var deck = titles.map(function (t, i) {
        return { page: i + 1, height: 272, lines: [ln(t, 250, 14.4), ln('Bullet text unique to page ' + 'abcdefghijklmnopqrst'.charAt(i), 200, 11)] };
      });
      var dh = P.findRunningHeads(deck);
      eq('slide titles over a build are kept',
         deck.filter(function (p) { return P.isRunningHead(dh, p.lines[0].text, 250, 272); }).length, 0);
      var six = ['Background on face areas', 'Results', 'Results', 'Results', 'Summary of findings', 'Open questions for discussion'].map(function (t, i) {
        return { page: i + 1, height: 272, lines: [ln(t, 250), ln('A bullet unique to slide ' + 'abcdef'.charAt(i), 200)] };
      });
      eq('"Results" on three slides of six is kept', P.isRunningHead(P.findRunningHeads(six), 'Results', 250, 272), false);

      // Figure labels heading the last pages of a preprint.
      var sp = [];
      for (var i = 1; i <= 30; i++) {
        sp.push({ page: i, height: 792, lines: [ln(i >= 24 ? 'Supplementary Figure ' + (i - 23) : 'Unique prose about topic ' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + (i * 7) % 26), 708)] });
      }
      var sh = P.findRunningHeads(sp);
      eq('"Supplementary Figure N" heading each figure page is kept',
         sp.filter(function (p) { return p.page >= 24 && P.isRunningHead(sh, p.lines[0].text, 708, 792); }).length, 0);

      // A thesis: the running head repeats the chapter title, which opens the
      // chapter lower down, just inside the band.
      var ch = [[1, 'Chapter 1: Introduction'], [6, 'Chapter 2: Visual Development'], [14, 'Chapter 3: Neural Coding of Faces in Infancy', 'Chapter 3: Neural Coding']];
      var th = [];
      for (i = 1; i <= 20; i++) {
        var c = null, open = false;
        ch.forEach(function (x) { if (i >= x[0]) { c = x; open = i === x[0]; } });
        th.push({ page: i, height: 792, lines: [open ? ln(c[1], 702) : ln(c[2] || c[1], 756), ln('Body prose unique to page ' + 'abcdefghijklmnopqrst'.charAt(i - 1), 400)] });
      }
      var thh = P.findRunningHeads(th);
      eq('a chapter title below its own running head is kept',
         th.filter(function (p) { return p.lines[0].y === 702 && P.isRunningHead(thh, p.lines[0].text, 702, 792); }).length, 0);

      // Footers that start with a page number and then a lowercase word.
      eq('"2 iScience 26, ..." is furniture', P.isFurniture('2 iScience 26, 106123, March 17, 2023'), true);
      eq('"2 of 10 https://doi.org/..." is furniture', P.isFurniture('2 of 10 https://doi.org/10.1073/pnas.2217646120'), true);

      // A bare number four lines up the page is not a page number.
      eq('a number 11% up the page may end a sentence', P.atNumberEdge(88, 792), false);
      eq('one 5% up is a page number', P.atNumberEdge(40, 792), true);

      eq('a long running head that carries its numbers is furniture',
         P.isFurniture('Local-Global Parcellation of the Human Cerebral Cortex Schaefer et al. | 3111'), true);
      eq('even one that ends in a full stop',
         P.isFurniture('Ann. N.Y. Acad. Sci. 1396 (2017) 166\u2013182 \u00A9C 2017 New York Academy of Sciences.'), true);
      eq('a long line without numbers is not',
         P.isFurniture('The participants were recruited from the community and paid for their time in the study sessions'), false);
      // Cell Press sets "Article" and its mark far bigger than the text.
      var cell = [];
      for (i = 1; i <= 10; i++) {
        cell.push({ page: i, height: 783, width: 603, lines: [
          { text: 'll', y: 718, left: 540, right: 560, h: 16, col: 0, items: [] },
          { text: 'Article', y: 704, left: 490, right: 545, h: 13.95, col: 1, items: [] },
          { text: 'Body prose unique to page ' + 'abcdefghij'.charAt(i - 1), y: 400, left: 50, right: 550, h: 8.5, col: 0, items: [] }] });
      }
      var ch2 = P.findRunningHeads(cell);
      eq('a display-size "Article" over every page is a running head', P.isRunningHead(ch2, 'Article', 704, 783), true);
      eq('and so is the mark beside it', P.isRunningHead(ch2, 'll', 718, 783), true);
      var wide = [];
      for (i = 1; i <= 10; i++) {
        wide.push({ page: i, height: 540, width: 720, lines: [
          { text: i % 2 ? 'Results' : 'Slide ' + 'abcdefghij'.charAt(i - 1) + ' of the talk', y: 500, left: 36, right: 300, h: 28, col: 0, items: [] }] });
      }
      eq('"Results" on half the slides of a deck is still a title',
         P.isRunningHead(P.findRunningHeads(wide), 'Results', 500, 540), false);
      eq('"Constructor" is not a running head of an empty set', P.isRunningHead({}, 'Constructor'), false);
      eq('nor is "__proto__"', P.isRunningHead(Object.create(null), '__proto__'), false);
    })();

    /* ---- from pages checked against the printed page ---- */
    (function () {
      function mk(t, x, y, w, h, f) { return { str: t, x: x, y: y, w: w, h: h || 8, font: f || 'body' }; }
      function twoCols(boxes, top, n, gap) {
        for (var k = 0; k < n; k++) {
          boxes.push(mk('left column body text runs on in this line of it', 40, top - k * (gap || 10), 250));
          boxes.push(mk('right column body text runs on in this one too', 311, top - k * (gap || 10), 250));
        }
      }
      function read(boxes, W) {
        return P.mergeContinuations(P.linesToBlocks(P.toLines(boxes.slice(), P.assignColumns(boxes, W)), 8.3, true))
          .map(function (b) { return b.text; });
      }

      // Nature Machine Intelligence, page 1: an affiliation footnote of two
      // lines, its second short, above the journal's footer.
      var fn = [];
      twoCols(fn, 400, 25);
      fn.push(mk('1Department of Cognitive Science, Johns Hopkins University, Baltimore, MD, USA. 3Université de', 40, 59.7, 512, 6));
      fn.push(mk('Montréal, Montréal, Quebec, Canada. e-mail: someone@example.org', 40, 47.4, 327, 7.5));
      fn.push(mk('Nature Machine Intelligence | Volume 7 | November 2025 | 1834–1844', 40, 21.7, 286));
      fn.push(mk('1834', 543, 21.3, 19));
      var fnt = read(fn, 603);
      eq('a footnote is not cut at its last line',
         fnt.some(function (t) { return /Université de Montréal, Montréal/.test(t); }), true);

      // An ICLR page: line numbers down the margin and one column of text.
      var iclr = [];
      for (var k = 0; k < 30; k++) {
        iclr.push(mk(String(600 + k), 73, 700 - k * 11, 13));
        if (k !== 26) iclr.push(mk('and the body text of the one column runs on across the page in this line', 108, 700 - k * 11, 396));
      }
      iclr.push(mk('expressions, psychological content, self-reference, etc. Dataset sizes:', 108, 700 - 26 * 11, 275));
      var it = read(iclr, 612);
      eq('a line between line numbers stays in its paragraph',
         it.filter(function (t) { return /expressions, psychological content/.test(t); })
           .every(function (t) { return /body text/.test(t); }), true);

      // A figure page: a section heading over a strip of labels with gaps.
      var fig = [mk('A.8 TOP ADJECTIVES AND MORE SENTENCES', 108, 700, 199, 9)];
      fig.push(mk('(a)', 117, 675, 12)); fig.push(mk('Faces', 160, 675, 30)); fig.push(mk('Places', 260, 675, 30));
      fig.push(mk('Bodies', 360, 675, 30)); fig.push(mk('Food', 440, 675, 25)); fig.push(mk('Words', 470, 675, 28));
      for (k = 0; k < 4; k++) { fig.push(mk('label', 120, 640 - k * 30, 20)); fig.push(mk('label', 400, 640 - k * 30, 20)); }
      P.assignColumns(fig, 612);
      eq('a heading over a figure is not taken for a running head', fig[0].edge, undefined);

      // A running head over a page whose first words carry on a sentence.
      var blocks = [
        { type: 'p', text: 'The 1-hour setting offers a good balance between scan duration and recon-', page: 6, firstOnPage: false },
        { type: 'p', text: 'MindEye2', page: 7, edge: true, firstOnPage: false },
        { type: 'p', text: 'struction performance, with notable improvements from pretraining.', page: 7, firstOnPage: true, brokeColumn: true }
      ];
      var mb = P.mergeContinuations(blocks).map(function (b) { return b.text; });
      eq('a sentence carries on past a running head', mb[0], 'The 1-hour setting offers a good balance between scan duration and reconstruction performance, with notable improvements from pretraining.');
      eq('and the head is not joined to anything', mb[1], 'MindEye2');
      var foot = P.mergeContinuations([
        { type: 'p', text: 'relate to each other, in terms of shared or', page: 8 },
        { type: 'p', text: 'nature neuroscience VOLUME 19 | NUMBER 3 | MARCH 2016', page: 8, edge: true, brokeColumn: true }]);
      eq('a footer is not read on from the sentence above it', foot.length, 2);
      eq('a lowercase journal footer is furniture', P.isFurniture('nature neuroscience VOLUME 19 | NUMBER 3 | MARCH 2016'), true);

      // A reference list: entries 1.2 lines apart, each ending in a full stop.
      function ln(t, y, left, right, h) { return { text: t, y: y, left: left, right: right, textLeft: left, h: h || 7, col: 0, items: [] }; }
      var refs = [
        ln('Poldrack, R.A., Wagner, A.D., Prull, M.W., Desmond, J.E., Glover, G.H., and', 533.9, 60, 299),
        ln('Gabrieli, J.D.E. (1999). Functional specialization for semantic and phonological', 524.4, 60, 299),
        ln('processing in the left inferior prefrontal cortex. Neuroimage 10, 15-35.', 514.9, 60, 278),
        ln('Raichle, M.E., MacLeod, A.M., Snyder, A.Z., Powers, W.J., Gusnard, D.A., and', 503.5, 60, 299),
        ln('Shulman, G.L. (2001). A default mode of brain function. Proc. Natl. Acad. Sci.', 494.0, 60, 299),
        ln('USA 98, 676-682.', 484.5, 60, 116),
        ln('Rosch, E., Mervis, C.B., Gray, W.D., Johnson, D.M., and Boyes-Braem, P. (1976).', 473.0, 60, 299),
        ln('Basic objects in natural categories. Cognit. Psychol. 8, 382-439.', 463.5, 60, 260)];
      eq('reference entries set a point apart are separate', P.linesToBlocks(refs, 8.47, true).length, 3);

      // A heading nearly the column wide, alone at its size between body lines.
      var hd = [
        ln('applied directly to such paradigms will be useful.', 637.1, 43, 237, 9),
        ln('(b) Anterior versus posterior hippocampal function', 607.1, 43, 266, 14),
        ln('There is an anatomical gradient in the prominence of differ-', 595.0, 43, 283, 9),
        ln('ent hippocampal subfields, in which regions CA1-3 are', 583.0, 43, 283, 9)];
      var hb = P.linesToBlocks(hd, 9, true);
      eq('a heading the width of its column is still a heading',
         hb.map(function (b) { return b.type + ':' + b.text.slice(0, 12); }),
         ['p:applied dire', 'h:(b) Anterior', 'p:There is an ']);

      // Two labels side by side in a figure, under a running head and above
      // a caption: too few runs to scan for a gutter.
      var lamp = [mk('132', 49, 733, 36), mk('POLYN, NORMAN, AND KAHANA', 235, 734, 126)];
      lamp.push(mk('source', 255, 674.6, 17, 6)); lamp.push(mk('temporal', 332, 674.4, 23, 6));
      lamp.push(mk('context', 254, 667.4, 19, 6)); lamp.push(mk('context', 330, 667.3, 23, 6));
      lamp.push(mk('Figure 1. Context as the spotlight of memory. Here, we envision the', 118, 513.4, 360));
      twoCols(lamp, 450, 20);
      var lt = P.toLines(lamp.slice(), P.assignColumns(lamp, 612)).map(function (l) { return l.text; });
      eq('side-by-side labels are read one after the other',
         lt.indexOf('source context') >= 0 || (lt.indexOf('source') >= 0 && lt.indexOf('source') < lt.indexOf('temporal')), true);
      eq('and not run together', lt.indexOf('source temporal'), -1);
    })();

    /* ---- second round of pages checked against the printed page ---- */
    (function () {
      function ln(t, y, left, right, h, col) { return { text: t, y: y, left: left, right: right, textLeft: left, h: h || 8.4, col: col || 0, items: [] }; }
      // A preprint with its line numbers set large: one line a point taller.
      var pre = [
        ln('11 Neuroscientific studies rely heavily on a-priori hypotheses, which can bias results', 428.3, 56, 511),
        ln('12 toward existing theories. Here, we use a hypothesis-neutral approach to study cate-', 414.7, 56, 511, 10.9),
        ln('13 gory selectivity in higher visual cortex. Using only stimulus images and their', 401.2, 56, 511),
        ln('14 fMRI activity, we constrain randomly initialized neural networks to predict', 387.6, 56, 511)];
      eq('a line made taller by its line number is not a heading', P.linesToBlocks(pre, 8.4, true).length, 1);

      // A page of small reference text with a column of body above it: the
      // body's own leading is not a paragraph break at every sentence end.
      var mixed = [];
      for (var k = 0; k < 10; k++) {
        var tx = k === 4 ? 'shifted by TR / 2, therefore reducing the suggested minimal ISI to 2 s.' :
          k === 5 ? 'When choosing the mid-slice as the target less interpolation is needed,' :
          'and the body of the paragraph carries on across the column here,';
        mixed.push(ln(tx, 700 - k * 10.5, 40, 285, 8));
      }
      for (k = 0; k < 30; k++) mixed.push(ln('Ref ' + k + ', small type set close together for the list.', 560 - k * 8, 40, 285, 6.5));
      var mb = P.linesToBlocks(mixed, 8, true).map(function (b) { return b.text; });
      eq('body leading on a page of small print is not a break',
         mb.some(function (t) { return /ISI to 2 s\. When choosing/.test(t); }), true);

      // Elsevier: "W. Majeed et al. / NeuroImage 54 (2011) 1140-1150", whole on
      // one page and cut at the gutter on the next, is one running head.
      eq('a page range at the end of a head is its page number',
         P.normaliseForRepeat('W. Majeed et al. / NeuroImage 54 (2011) 1140–1150'),
         P.normaliseForRepeat('W. Majeed et al. / NeuroImage 54 (2011) 1140'));
      eq('and the cut-off "–1150" is a page number', P.PAGE_NUMBER.test('–1150'), true);
      eq('a DOI on its own is furniture', P.isFurniture('https://doi.org/10.1038/s42256-025-01072-0'), true);
    })();

    /* ---- sizes and spacing that only look like structure ---- */
    (function () {
      function mk(t, x, y, w, h) { return { str: t, x: x, y: y, w: w, h: h, font: 'body' }; }
      // A drop cap: one huge letter at the start of an abstract.
      var drop = [
        mk('P', 54, 700, 18, 30), mk('recision mapping of brain networks within individuals has become a widely used tool that', 76, 700, 482, 11),
        mk('prevailingly relies on functional connectivity analysis of resting-state data. Here we explored', 54, 686, 504, 11),
        mk('whether networks could also be precisely estimated from task data alone, across many tasks.', 54, 672, 480, 11)];
      var dl = P.toLines(drop, null);
      eq('a drop cap does not make its line a heading', P.linesToBlocks(dl, 11, true).length, 1);
      eq('the text height of that line is the text\'s', dl[0].textH, 11);

      // Lines whose spacing wobbles with superscripts: no break at a full stop.
      function ln(t, y) { return { text: t, y: y, left: 40, right: 295, textLeft: 40, h: 8.3, textH: 8.3, col: 0, items: [] }; }
      var wob = [ln('images were shown for three seconds at a size of', 700), ln('8.4 degrees with 1 s gaps in between image presentations.', 691.3),
                 ln('Subjects were instructed to fixate on a central point and to', 678.5), ln('press a button whenever an image repeated in the session', 667.7),
                 ln('so that attention was held on the images throughout.', 656.9)];
      eq('a wobble in the spacing is not a paragraph break', P.linesToBlocks(wob, 8.3, true).length, 1);
    })();

    /* ---- small capitals, and an author list in larger type ---- */
    (function () {
      function mk(t, x, y, w, h) { return { str: t, x: x, y: y, w: w, h: h, font: 'body' }; }
      var sc = P.toLines([mk('486', 73, 701, 13, 8), mk('6', 108, 701, 6, 12), mk(' ', 114, 701, 3, 12),
                          mk('L', 118, 701, 7, 12), mk('IMITATIONS', 125, 701, 69, 9.6)], null);
      eq('a heading in small capitals is measured by its capitals', sc[0].textH, 12);

      var names = ['Maximilian Maier10,25, Marcelo G. Mattar9, Marvin Mathony1,', 'Alireza Modirshanechi1,13, Robin Na2, Mariia Nadverniuk3,',
                   'Antonios Nasioulas17,23, Surabhi S. Nath13, Helen Niemeyer24,', 'Kate Nussenbaum37, Sebastian Olschewski19,25, Thorsten Pachur,'];
      var widths = [362, 344, 360, 382];
      var auth = names.map(function (t, k) {
        return { text: t, y: 352.3 - k * 26.9, left: 306 - widths[k] / 2, right: 306 + widths[k] / 2, textLeft: 306 - widths[k] / 2, h: 10.5, textH: 14.3, col: 0, items: [] };
      });
      auth.unshift({ text: 'Post-training makes large language models less human-like.', y: 420, left: 72, right: 540, textLeft: 72, h: 12, textH: 12, col: 0, items: [] });
      for (var k = 0; k < 6; k++) auth.push({ text: 'Body text of the paper runs across the page in this line of it', y: 200 - k * 14, left: 72, right: 540, textLeft: 72, h: 12, textH: 12, col: 0, items: [] });
      var ab = P.linesToBlocks(auth, 12, true).map(function (b) { return b.text; });
      eq('a centred author list is one block, long lines and short',
         ab.filter(function (t) { return /Maximilian Maier/.test(t) && /Kate Nussenbaum/.test(t); }).length, 1);
    })();

    /* ---- a word that heads a figure is not a running head ---- */
    (function () {
      function ln(t, y, left, right, h) { return { text: t, y: y, left: left, right: right, h: h || 20, col: 0, items: [] }; }
      var pages = [];
      for (var i = 1; i <= 12; i++) {
        pages.push({ page: i, height: 792, width: 612, lines: [
          ln('Left', 740, 40, 80), ln('Hemisphere', 718, 40, 150),
          ln('Region label for page ' + 'abcdefghijkl'.charAt(i - 1), 500, 200, 400, 10)] });
      }
      var h = P.findRunningHeads(pages);
      eq('"Left" over "Hemisphere" on every page is kept', P.isRunningHead(h, 'Left', 740, 792), false);
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
      eq('one word with no number, the same every time, can be furniture', P.isFurniture('Article'), true);
      var art = [1, 2, 3, 4, 5].map(function (i) {
        return { page: i, height: 783, lines: [
          { text: 'Article', y: 704, left: 500, right: 545, h: 9, col: 1, items: [] },
          { text: 'Body prose that is only on page ' + 'abcde'[i - 1], y: 400, left: 50, right: 550, h: 10, col: 0, items: [] }] };
      });
      eq('"Article" at the head of every page is a running head',
         P.isRunningHead(P.findRunningHeads(art), 'Article'), true);
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

    lines.push('\n--- a full-width block above two columns: read it in bands ---');
    (function () {
      // A Cell Press Introduction page: a full-width Summary, then two columns.
      // One gutter cannot describe it. When the Summary crossed the gutter
      // often enough, detection gave up and the columns were read a line of
      // each in turn - the right column's "alize to multiple areas." first of
      // all. When it crossed rarely enough, the Summary was cut down the middle.
      function words(line, x0, y) {
        var out = [], x = x0;
        line.split(' ').forEach(function (w) {
          out.push({ str: w, x: x, y: y, w: w.length * 4.4, h: 8, font: 'body' });
          x += w.length * 4.4 + 2.4;
        });
        return out;
      }
      function oneRun(line, x0, y) {
        var sp = line.split(' ').length - 1;
        return [{ str: line, x: x0, y: y, w: (line.length - sp) * 4.4 + sp * 2.4, h: 8, font: 'body' }];
      }
      var SUMMARY = [
        'Recent work shows that a single computational model can predict both the responses',
        'and the spatial layout of neurons in early and higher visual cortex of the primate, and',
        'our results provide a unifying principle for the functional organization of the system.',
        'A further summary line runs the full width of the page, just like the others above it.',
        'A fifth line follows so that the summary is long enough to block a single gutter.',
        'And a sixth line keeps crossing the middle of the page from one margin to the other.',
        'With seven lines crossing it, no single gutter survives the whole-page scan at all.'
      ];
      var LEFT = ['INTRODUCTION',
        'Sensory cortical systems can be measured in two ways: by the',
        'response patterns of neurons as a function of stimulus input',
        'and by the spatial arrangement of those neurons across the',
        'cortical surface. These approaches do not gener-'];
      var RIGHT = ['alize to multiple areas. Moreover, many prior models utilize',
        'hand-crafted features and thus cannot explain how neuronal',
        'response properties are learned from realistic sensory inputs.',
        'Here, we introduce the topographic network model.'];

      function page(make, summaryLines) {
        var boxes = [];
        SUMMARY.slice(0, summaryLines).forEach(function (t, k) { boxes = boxes.concat(make(t, 50, 700 - k * 11)); });
        LEFT.forEach(function (t, k) { boxes = boxes.concat(make(t, 50, 600 - k * 11)); });
        RIGHT.forEach(function (t, k) { boxes = boxes.concat(make(t, 318, 600 - k * 11)); });
        return boxes;
      }
      function read(boxes) {
        var ls = P.toLines(boxes.slice(), P.assignColumns(boxes, 612));
        return P.mergeContinuations(P.linesToBlocks(ls, 8, true)).map(function (b) { return b.text; });
      }
      // Everything before the heading, and everything after it. Where the
      // summary's own paragraph breaks fall is the paragraph rule's business;
      // what matters here is what comes before what.
      function split(blocks) {
        var h = blocks.indexOf('INTRODUCTION');
        return { before: blocks.slice(0, h).join(' '), heading: blocks[h], after: blocks.slice(h + 1).join(' ') };
      }
      var EXPECT_BODY = 'Sensory cortical systems can be measured in two ways: by the response patterns of ' +
        'neurons as a function of stimulus input and by the spatial arrangement of those neurons across ' +
        'the cortical surface. These approaches do not generalize to multiple areas. Moreover, many prior ' +
        'models utilize hand-crafted features and thus cannot explain how neuronal response properties are ' +
        'learned from realistic sensory inputs. Here, we introduce the topographic network model.';

      // 1. one run per word, short summary: the page gutter IS found, and used
      //    to cut the summary in two.
      var a = split(read(page(words, 3)));
      eq('a full-width summary is not cut down the gutter', a.before, SUMMARY.slice(0, 3).join(' '));
      eq('the body reads left column, then right', a.after, EXPECT_BODY);

      // 2. one run per line, long summary: no gutter survives the whole page -
      //    the case that read the columns interleaved.
      var boxes2 = page(oneRun, 7);
      eq('(here the page as a whole has no gutter)', P.detectColumns(boxes2, 612), null);
      var raw = read(boxes2), b = split(raw);
      eq('the summary is read whole, in order, before anything else', b.before, SUMMARY.join(' '));
      eq('the heading stays between them', b.heading, 'INTRODUCTION');
      eq('and the body still finds its own two columns', b.after, EXPECT_BODY);
      eq('so the right column\'s first line does not come first',
         raw.some(function (t) { return t.indexOf('alize to multiple') === 0; }), false);

      // 3. an ordinary two-column page is exactly what one gutter gives.
      var plain = [];
      LEFT.forEach(function (t, k) { plain = plain.concat(words(t, 50, 600 - k * 11)); });
      RIGHT.forEach(function (t, k) { plain = plain.concat(words(t, 318, 600 - k * 11)); });
      plain = plain.concat(words('Here, we introduce the topographic network model, again.', 318, 545));
      var g = P.detectColumns(plain, 612), assign = P.assignColumns(plain, 612);
      eq('with no full-width row, the columns are the single gutter\'s columns',
         plain.every(function (bx) { return assign(bx) === (bx.x + bx.w / 2 < g ? 0 : 1); }), true);
    })();

    lines.push('\n--- what a row says about the page ---');
    (function () {
      function row(spans) {
        return { y: 500, boxes: spans.map(function (s) { return { x: s[0], w: s[1] - s[0], y: 500, h: 8 }; }) };
      }
      eq('two columns with a gutter between them: split',
         P.rowKind(row([[50, 300], [318, 562]]), 612, 8), 'split');
      eq('one stretch across the page: wide',
         P.rowKind(row([[50, 200], [203, 400], [403, 562]]), 612, 8), 'wide');
      eq('text on the left only: neutral', P.rowKind(row([[50, 280]]), 612, 8), 'neutral');
      eq('a left column that runs well past the middle is still not full width',
         P.rowKind(row([[50, 380]]), 612, 8), 'neutral');
      eq('a short heading: neutral', P.rowKind(row([[50, 130]]), 612, 8), 'neutral');
    })();

    lines.push('\n--- a line split off a wider row keeps its own height ---');
    (function () {
      // The "Check for updates" badge sits a little higher than the abstract
      // line beside it. Split apart, the abstract line kept the row's averaged
      // y - two points too high - which put the gap to the next line over the
      // break threshold and split the abstract mid-sentence.
      var ls = P.toLines([
        { str: 'Check for updates', x: 52, y: 495, w: 60, h: 8 },
        { str: 'long-standing hypothesis is that the functional organization into streams',
          x: 217, y: 489.9, w: 325, h: 8 }
      ], null);
      var text = ls.filter(function (l) { return /long-standing/.test(l.text); })[0];
      eq('the badge and the text are two lines', ls.length, 2);
      eq('and the text line is where its own words are, not the row average',
         Math.round(text.y * 10) / 10, 489.9);
    })();

    lines.push('\n--- a bullet followed by a space in its own font ---');
    (function () {
      // Exactly what a Cell Press highlights page emits: the dingbat "d", then
      // a space in the SAME dingbat font, then the text in the body font.
      var ls = P.toLines([
        { str: 'd', x: 53, y: 605, w: 5, h: 8, font: 'dingbat' },
        { str: ' ', x: 59, y: 605, w: 1, h: 8, font: 'dingbat' },
        { str: 'Single model predicts function and spatial structure in early', x: 66, y: 605, w: 274, h: 8, font: 'body' },
        { str: 'and higher visual cortex', x: 66, y: 591, w: 110, h: 8, font: 'body' },
        { str: 'd', x: 53, y: 573, w: 5, h: 8, font: 'dingbat' },
        { str: ' ', x: 59, y: 573, w: 1, h: 8, font: 'dingbat' },
        { str: 'Best model uses self-supervised learning', x: 66, y: 573, w: 170, h: 8, font: 'body' }
      ], null);
      var blocks = P.linesToBlocks(ls, 8, true);
      eq('the dingbat is a bullet even with a space of its own font after it',
         blocks[0].text,
         '• Single model predicts function and spatial structure in early and higher visual cortex');
      eq('and so is the next one', blocks[1].text, '\u2022 Best model uses self-supervised learning');

      // STAR Methods: one dingbat font, "d" for a filled square and "B" for a
      // hollow one.
      var star = [];
      // As measured: the mark 4pt wide and its text 4pt after it.
      [['d', 'RESOURCE AVAILABILITY'], ['B', 'Lead contact'], ['B', 'Materials availability'], ['d', 'KEY RESOURCES TABLE']].forEach(function (r, k) {
        star.push({ str: r[0], x: 316, y: 600 - k * 14, w: 4, h: 8, font: 'dingbat' });
        star.push({ str: ' ', x: 320, y: 600 - k * 14, w: 1, h: 8, font: 'dingbat' });
        star.push({ str: r[1], x: 324, y: 600 - k * 14, w: 100, h: 8, font: 'body' });
      });
      eq('both glyphs of a two-glyph bullet font are bullets',
         P.toLines(star, null).map(function (l) { return l.text.charAt(0); }).join(''), '\u2022\u2022\u2022\u2022');

    })();

    lines.push('\n--- a one-letter word in another font is not a bullet ---');
    (function () {
      function read(items) { return P.linesToBlocks(P.toLines(items, null), 8, true)[0].text; }
      // Nature legend: bold panel label "a", a space, then roman text.
      eq('a bold panel label followed by a word space stays a letter',
         read([{ str: 'a', x: 53, y: 600, w: 4, h: 8, font: 'bold' },
               { str: ' ', x: 57, y: 600, w: 2, h: 8, font: 'bold' },
               { str: 'single cell. Top, mean response time course', x: 59, y: 600, w: 160, h: 8, font: 'roman' }]),
         'a single cell. Top, mean response time course');
      eq('an italic variable stays a variable',
         read([{ str: 'x', x: 53, y: 600, w: 4, h: 8, font: 'italic' },
               { str: ' (cm)', x: 58, y: 600, w: 18, h: 8, font: 'roman' }]),
         'x (cm)');
      eq('a panel label straight before its comma stays a letter',
         read([{ str: 'a', x: 53, y: 600, w: 4, h: 8, font: 'bold' },
               { str: ', Schematic of the task', x: 57, y: 600, w: 90, h: 8, font: 'roman' }]),
         'a, Schematic of the task');
      eq('a section number in another font is kept, even with a gap',
         read([{ str: '1', x: 53, y: 600, w: 5, h: 10, font: 'bold' },
               { str: 'Introduction and overview of the work', x: 70, y: 600, w: 160, h: 10, font: 'roman' }]),
         '1 Introduction and overview of the work');
    })();

    lines.push('\n--- letters set apart in another font are still letters ---');
    (function () {
      function mk(s, x, y, w, f) { return { str: s, x: x, y: y, w: w, h: 10, font: f }; }
      function show(bs) { return P.toLines(bs, null).map(function (l) { return l.text; }); }
      eq('a notation list keeps its symbols', show([
        mk('τ', 90, 600, 4.4, 'CMMI10'), mk(' ', 94.4, 600, 25.6, 'CMMI10'), mk('membrane time constant (20 ms)', 120, 600, 140, 'CMR10'),
        mk('N', 90, 586, 8.0, 'CMMI10'), mk(' ', 98.0, 586, 22.0, 'CMMI10'), mk('number of recorded neurons', 120, 586, 130, 'CMR10')]),
        ['τ membrane time constant (20 ms)', 'N number of recorded neurons']);
      eq('multiple-choice options keep their letters', show([
        mk('Which organelle produces most of the ATP?', 72, 500, 260, 'Arial-Bold'),
        mk('A', 90, 486, 7.2, 'Arial-Bold'), mk(' ', 97.2, 486, 10.8, 'Arial-Bold'), mk('The mitochondrion', 108, 486, 90, 'Arial'),
        mk('B', 90, 472, 7.2, 'Arial-Bold'), mk(' ', 97.2, 472, 10.8, 'Arial-Bold'), mk('The ribosome', 108, 472, 65, 'Arial')]),
        ['Which organelle produces most of the ATP?', 'A The mitochondrion', 'B The ribosome']);
      eq('an operator set apart in a math font stays an operator', show([
        mk('\u2018Dance\u2019', 72, 600, 40, 'Roman'),
        mk('\u00D7', 140, 600, 6, 'Math'), mk('\u20131.5 \u20132.1 \u20133.2', 160, 600, 60, 'Roman'),
        mk('\u00D7', 72, 580, 6, 'Math'), mk('\u20130.5 \u20131.1 \u20132.2', 92, 580, 60, 'Roman'),
        mk('y = a ', 72, 560, 30, 'Roman'), mk('\u00D7', 102, 560, 6, 'Math'), mk(' b', 108, 560, 8, 'Roman')]),
        ['\u2018Dance\u2019 \u00D7 \u20131.5 \u20132.1 \u20133.2', '\u00D7 \u20130.5 \u20131.1 \u20132.2', 'y = a \u00D7 b']);
      eq('multiplication signs that are their font\'s only glyphs stay signs', show([
        mk('\u00D7', 72, 600, 6, 'MathOnly'), mk('\u20131.5 \u20132.1 \u20133.2', 92, 600, 60, 'Roman'),
        mk('\u00D7', 72, 560, 6, 'MathOnly'), mk('\u20130.5 \u20131.1 \u20132.2', 92, 560, 60, 'Roman')]),
        ['\u00D7 \u20131.5 \u20132.1 \u20133.2', '\u00D7 \u20130.5 \u20131.1 \u20132.2']);
      eq('a variable at the start of a stretched TeX line stays a variable', show([
        mk('The recurrent network is driven by its input, and we define the weight matrix', 72, 700, 230, 'CMR10'),
        mk('W', 72, 688, 9.4, 'CMMI10'), mk(' ', 81.4, 688, 5.4, 'CMMI10'), mk('as the learned connectivity between all units.', 86.8, 688, 215, 'CMR10')])[1],
        'W as the learned connectivity between all units.');
    })();

    lines.push('\n--- a copyright notice in a slim column beside the abstract ---');
    (function () {
      // Science Advances page 1, as measured: main column 36-467pt, the notice
      // in a column 486-559pt - a 19pt gap 80% across a 594pt page, which is
      // neither in the middle third nor wide enough to split a line by itself.
      function mk(t, x, y, w, h) { return { str: t, x: x, y: y, w: w, h: h || 9.5, font: 'body' }; }
      var NOTICE = ['Copyright © 2023 The', 'Authors, some', 'rights reserved;', 'exclusive licensee',
        'American Association', 'for the Advancement', 'of Science. No claim to', 'original U.S. Government',
        'Works. Distributed', 'under a Creative', 'Commons Attribution', 'License 4.0 (CC BY).'];
      var ABSTRACT = [
        'The human ventral visual stream has a highly systematic organization of object information, but the causal pres-',
        'sures driving these topographic motifs are highly debated. Here, we use self-organizing principles to learn a',
        'topographic representation of the data manifold of a deep neural network representational space. We find',
        'that a smooth mapping of this representational space showed many brain-like motifs, with a large-scale orga-',
        'nization by animacy and real-world object size, supported by mid-level feature tuning, with naturally emerging.'];
      var boxes = [mk('C O G N I T I V E   N E U R O S C I E N C E', 36, 690, 137)];
      boxes.push(mk('Cortical topographic motifs emerge in a self-organized', 36, 667, 431, 20));
      boxes.push(mk('map of object space', 36, 647, 159, 20));
      boxes.push(mk('Fenil R. Doshi* and Talia Konkle', 36, 622, 144, 11));
      ABSTRACT.forEach(function (t, k) { boxes.push(mk(t, 36, 601 - k * 10, 431)); });
      NOTICE.forEach(function (t, k) { boxes.push(mk(t, 486, 690 - k * 10, 73)); });
      // and two columns of body below, so the page has a real structure to keep
      for (var k = 0; k < 8; k++) {
        boxes.push(mk('Left column body text runs on in this line here', 36, 500 - k * 11, 255));
        boxes.push(mk('Right column body text runs on in this one too', 310, 500 - k * 11, 250));
      }

      var found = P.findAsides(P.rowsOf(boxes), 594, 9.5);
      eq('the notice is found as an aside on the right', found.map(function (f) { return f.side; }), ['right']);
      eq('every line of it, including the one beside the running head',
         boxes.filter(function (b) { return b.aside; }).length, NOTICE.length);
      boxes.forEach(function (b) { delete b.aside; });

      var ls = P.toLines(boxes.slice(), P.assignColumns(boxes, 594));
      var texts = P.mergeContinuations(P.linesToBlocks(ls, 9.5, true)).map(function (b) { return b.text; });
      var abs = texts.filter(function (t) { return /^The human ventral/.test(t); })[0] || '';
      eq('the abstract has none of the notice in it',
         /Creative|Copyright|licensee|Commons/.test(abs), false);
      eq('and "pres- / sures" is one word again', /causal pressures driving/.test(abs), true);
      var at = function (re) { for (var i = 0; i < texts.length; i++) if (re.test(texts[i])) return i; return -1; };
      eq('the notice is read after the abstract', at(/^Copyright/) > at(/^The human ventral/), true);
      eq('and before the body below it', at(/^Copyright/) < at(/^Left column body/), true);
      eq('the notice is one passage, in order', texts[at(/^Copyright/)], NOTICE.join(' '));
    })();

    lines.push('\n--- an aside and the body that opens below it ---');
    (function () {
      function mk(t, x, y, w, h) { return { str: t, x: x, y: y, w: w, h: h || 9.5, font: 'body' }; }
      // The right column opens with a figure, so the heading and first lines
      // of the left column have nothing beside them.
      var boxes = [mk('Cortical topographic motifs emerge in a self-organized map', 36, 667, 431, 20)];
      for (var k = 0; k < 6; k++) boxes.push(mk('The abstract runs across the wide block beside the licence notice, line ' + k + (k === 5 ? '.' : ','), 36, 601 - k * 10, 431));
      ['Copyright 2023 The', 'Authors, some', 'rights reserved;', 'exclusive licensee', 'American Association', 'for the Advancement',
       'of Science. No claim to', 'original Government', 'Works. Distributed', 'under a Creative'].forEach(function (t, k) { boxes.push(mk(t, 486, 670 - k * 10, 73)); });
      ['INTRODUCTION', 'Visual cortex is organized into maps at many', 'scales, from retinotopy to category-selective',
       'regions in ventral cortex, as shown by work in', 'humans and in monkeys by',
       'Kanwisher, Tsao, Livingstone and many others.'].forEach(function (t, k) { boxes.push(mk(t, 36, 530 - k * 11, 255)); });
      for (k = 0; k < 6; k++) boxes.push(mk('Left column body text runs on in this line here', 36, 464 - k * 11, 255));
      for (k = 0; k < 7; k++) boxes.push(mk('Right column body text runs on in this one too', 310, 475 - k * 11, 250));
      var texts = P.mergeContinuations(P.linesToBlocks(P.toLines(boxes.slice(), P.assignColumns(boxes, 594)), 9.5, true))
        .map(function (b) { return b.text; });
      var at = function (re) { for (var i = 0; i < texts.length; i++) if (re.test(texts[i])) return i; return -1; };
      eq('the notice is read after the abstract', at(/^Copyright/) > at(/^The abstract/), true);
      eq('and before the heading below it', at(/^Copyright/) < at(/^INTRODUCTION/), true);
      eq('so the sentence under the heading is whole',
         texts.some(function (t) { return /humans and in monkeys by Kanwisher/.test(t); }), true);
    })();

    lines.push('\n--- a ragged rail at the left edge ---');
    (function () {
      function mk(t, x, y, w, h) { return { str: t, x: x, y: y, w: w, h: h || 9, font: 'body' }; }
      var boxes = [mk('A topographic deep network accounts for the functional', 46, 712, 500, 18)];
      var RAIL = [['Funding information', 80], ['National Eye Institute', 92], ['Grant number R01', 70], ['Correspondence', 62], ['Jane Doe, Department', 88],
        ['of Psychology, Harvard University,', 106], ['Cambridge, MA 02138, United States', 106], ['Email: jane@harvard.edu', 104]];
      RAIL.forEach(function (r, k) { boxes.push(mk(r[0], 46, 660 - k * 11, r[1])); });
      for (var k = 0; k < 10; k++) boxes.push(mk('The abstract of the paper runs across the wide right block of page one here and on.', 175, 660 - k * 11, 385));
      for (k = 0; k < 20; k++) {
        boxes.push(mk('Left column of the main text runs down the page in this line', 46, 520 - k * 11, 245));
        boxes.push(mk('Right column of the main text runs down the page here too', 315, 520 - k * 11, 245));
      }
      P.assignColumns(boxes, 612);
      eq('every line of the rail is lifted, long and short',
         boxes.filter(function (b) { return b.aside === 'left'; }).length, RAIL.length);
    })();

    lines.push('\n--- what is not an aside ---');
    (function () {
      function mk(t, x, y, w) { return { str: t, x: x, y: y, w: w, h: 9, font: 'body' }; }
      // Area labels down the side of a figure: letters, one word to a line.
      var fig = [];
      ['retina', 'retina', 'V1', 'V1', 'V2', 'V4', 'VTC', 'VTC'].forEach(function (t, k) {
        fig.push(mk('a figure caption line that runs along the left side', 36, 600 - k * 12, 400));
        fig.push(mk(t, 470, 600 - k * 12, 20));
      });
      eq('a stack of figure labels is not an aside', P.findAsides(P.rowsOf(fig), 594, 9).length, 0);

      // Line numbers down a manuscript margin: figures, not prose.
      var nums = [];
      for (var k = 0; k < 10; k++) {
        nums.push(mk(String(k + 1), 20, 600 - k * 12, 8));
        nums.push(mk('the manuscript text runs across the page from margin to margin', 60, 600 - k * 12, 480));
      }
      eq('margin line numbers are not an aside', P.findAsides(P.rowsOf(nums), 594, 9).length, 0);

      // An ordinary two-column page: the gutter is in the middle, not the edge.
      var two = [];
      for (k = 0; k < 10; k++) {
        two.push(mk('left column body text runs on in this line', 36, 600 - k * 12, 255));
        two.push(mk('right column body text runs on in this one', 310, 600 - k * 12, 250));
      }
      eq('a two-column body is not an aside', P.findAsides(P.rowsOf(two), 594, 9).length, 0);

      // The labels of a table in the left column, across from its values.
      var tab = [];
      for (k = 0; k < 8; k++) tab.push(mk('Left column prose describing the training setup of the model', 54, 700 - k * 11, 240));
      tab.push(mk('Table 1: Hyperparameters used for training.', 80, 600, 190));
      [['Learning rate', '0.001'], ['Batch size', '256'], ['Weight decay', '0.05'], ['Optimizer', 'AdamW'], ['Training epochs', '100'], ['Warmup steps', '1000']].forEach(function (r, i) {
        tab.push(mk(r[0], 70, 585 - i * 11, 70));
        tab.push(mk(r[1], 200, 585 - i * 11, 30));
      });
      for (k = 0; k < 8; k++) tab.push(mk('More left column prose follows the table here in the text', 54, 510 - k * 11, 240));
      for (k = 0; k < 30; k++) tab.push(mk('Right column prose that runs down the whole of its column', 318, 700 - k * 11, 240));
      eq('the labels of a table are not an aside', P.findAsides(P.rowsOf(tab), 612, 9).length, 0);

      // A glossary: a term, then its definition, one entry to a line.
      var glo = [];
      [['Receptive field', 'the region of visual space in which a stimulus drives a neuron to respond.'],
       ['Population code', 'the information carried jointly by the activity of many neurons at once.'],
       ['Voxel time series', 'the BOLD signal of one voxel sampled at every volume of a functional run.'],
       ['Noise ceiling', 'the best prediction accuracy possible given the reliability of the data.'],
       ['Tuning curve', 'the response of a neuron as a function of one property of the stimulus.'],
       ['Representational similarity', 'a comparison of the geometry of two sets of responses to stimuli.']].forEach(function (r, i) {
        glo.push(mk(r[0], 72, 600 - i * 14, 110));
        glo.push(mk(r[1], 200, 600 - i * 14, 330));
      });
      for (k = 0; k < 10; k++) glo.push(mk('Thesis prose runs across the single column of the page in this line', 72, 500 - k * 14, 460));
      eq('the terms of a glossary are not an aside', P.findAsides(P.rowsOf(glo), 612, 9).length, 0);

      // Four equal columns: the first and last are columns, not rails.
      var four = [];
      for (k = 0; k < 20; k++) {
        [36, 175.5, 315, 454.5].forEach(function (x, c) { four.push(mk('column ' + (c + 1) + ' text runs in its line', x, 700 - k * 11, 121.5)); });
      }
      eq('four equal columns have no aside', P.findAsides(P.rowsOf(four), 612, 9).length, 0);

    })();

    return {
      pass: pass, fail: fail,
      report: lines.join('\n') + '\n\n==== ' + pass + ' passed, ' + fail + ' failed ===='
    };
  }

  FR.pdfTests = { run: run };
})(typeof globalThis !== 'undefined' ? globalThis : this);
