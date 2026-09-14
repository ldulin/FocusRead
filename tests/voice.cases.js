/*
 * Voice curation.
 *
 * macOS exposes ~180 voices and most of the American English ones are novelty
 * sound effects, so some filtering is necessary. Getting it wrong is easy in
 * both directions: the first attempt classed eight of Apple's real character
 * voices as sound effects and cut the list from 28 entries to 5, leaving
 * almost nothing to choose between.
 *
 * Pure functions over voice-shaped objects, so no browser is needed.
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

    function v(name, lang, local) {
      return {
        name: name,
        lang: lang || 'en-US',
        voiceURI: 'uri:' + name,
        localService: local !== false,
        default: false
      };
    }
    function names(list) { return list.map(function (x) { return x.name.replace(/\s*\(.*$/, ''); }); }

    /* ---- what is a sound effect, and what is a voice ---- */
    eq('a singing voice is excluded', S.curateVoices([v('Bells'), v('Samantha')], 'en-US').length, 1);
    eq('so is Zarvox', names(S.curateVoices([v('Zarvox'), v('Samantha')], 'en-US')), ['Samantha']);
    eq('so is Albert', names(S.curateVoices([v('Albert'), v('Samantha')], 'en-US')), ['Samantha']);

    // The regression: these are stylised but real, and must be offered.
    ['Eddy', 'Flo', 'Grandma', 'Grandpa', 'Reed', 'Rocko', 'Sandy', 'Shelley'].forEach(function (n) {
      eq('"' + n + '" is a real voice and is offered',
         names(S.curateVoices([v(n)], 'en-US')), [n]);
      eq('"' + n + '" is a character voice', S.voiceTier(v(n)), 'stylised');
    });

    /* ---- tiers ---- */
    eq('Samantha is clearest', S.voiceTier(v('Samantha')), 'natural');
    eq('Ava is clearest', S.voiceTier(v('Ava')), 'natural');
    eq('Fred is basic', S.voiceTier(v('Fred')), 'basic');
    eq('an unknown local voice is plain', S.voiceTier(v('Somebody New')), 'plain');
    eq('an unknown remote voice is a network voice',
       S.voiceTier(v('Google US English', 'en-US', false)), 'network');

    /* ---- ordering: clearest first, robotic last ---- */
    (function () {
      var list = [v('Fred'), v('Rocko'), v('Samantha'), v('Google US English', 'en-US', false), v('Newcomer')];
      eq('ranked clearest to most robotic',
         names(S.curateVoices(list, 'en-US')),
         ['Samantha', 'Newcomer', 'Rocko', 'Google US English', 'Fred']);
    })();

    /* ---- language filters ---- */
    (function () {
      var list = [v('Samantha', 'en-US'), v('Daniel', 'en-GB'), v('Tingting', 'zh-CN'), v('Bells', 'en-US')];
      eq('American English only', names(S.curateVoices(list, 'en-US')), ['Samantha']);
      eq('all English', names(S.curateVoices(list, 'english')).sort(), ['Daniel', 'Samantha']);
      eq('everything installed, minus the sound effects',
         names(S.curateVoices(list, 'all')).sort(), ['Daniel', 'Samantha', 'Tingting']);
    })();

    // A strict filter that matches nothing must widen rather than show nothing.
    eq('a filter matching nothing falls back instead of emptying the list',
       names(S.curateVoices([v('Daniel', 'en-GB')], 'en-US')), ['Daniel']);
    eq('and falls back again when no English exists',
       names(S.curateVoices([v('Tingting', 'zh-CN')], 'en-US')), ['Tingting']);

    /* ---- grouping for the picker ---- */
    (function () {
      var list = [v('Samantha'), v('Rocko'), v('Fred'), v('Bells')];
      var groups = S.voiceGroups(list, 'en-US');
      eq('one group per populated tier', groups.length, 3);
      eq('clearest group first', groups[0].tier, 'natural');
      eq('robotic group last', groups[2].tier, 'basic');
      eq('every group is labelled', groups.every(function (g) { return !!g.label; }), true);
      eq('no empty groups', groups.every(function (g) { return g.voices.length > 0; }), true);
      eq('the sound effect is in no group',
         groups.some(function (g) { return names(g.voices).indexOf('Bells') !== -1; }), false);
    })();

    /* ---- automatic pick ---- */
    (function () {
      var list = [v('Fred'), v('Bells'), v('Samantha')];
      eq('the automatic pick is the clearest, not the first',
         S.pickVoice(list, '', 'en-US', true).name, 'Samantha');
      eq('a pinned voice always wins',
         S.pickVoice(list, 'uri:Fred', 'en-US', true).name, 'Fred');
      eq('never a sound effect, even if it is all there is',
         S.pickVoice([v('Bells'), v('Fred')], '', 'en-US', true).name, 'Fred');
    })();

    eq('a basic-only install is reported as such',
       S.onlyLegacyVoices([v('Fred'), v('Ralph')], 'en-US'), true);
    eq('and a good install is not',
       S.onlyLegacyVoices([v('Samantha'), v('Fred')], 'en-US'), false);

    return {
      pass: pass, fail: fail,
      report: lines.join('\n') + '\n\n==== ' + pass + ' passed, ' + fail + ' failed ===='
    };
  }

  FR.voiceTests = { run: run };
})(typeof globalThis !== 'undefined' ? globalThis : this);
