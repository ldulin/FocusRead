#!/usr/bin/env python3
"""
Build the web version of the reader into docs/, for GitHub Pages.

The extension and the website run the SAME code - engine, speech, segmenter,
translation, reader, settings page. Only three things differ, and all three are
handled here rather than by forking the source:

  1. web/shim.js stands in for the chrome.* APIs the shared code touches.
  2. pdf.js and mammoth.js come from a CDN rather than a vendored folder. A
     website has no Manifest V3 remote-code restriction, and this keeps a few
     megabytes of third-party build output out of the repository.
  3. Paths are flattened: docs/ is the Pages root, so `../lib/x.js` from
     src/reader/ becomes `lib/x.js`.

Run it after changing anything under src/ or web/, and commit docs/.
GitHub Pages then serves main /docs with no build machinery of its own.
"""
import hashlib
import json
import os
import re
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# What the build id is computed over: the code, not the assets.
WATCH_FOR_ID = [
    'src/lib/segmenter.js', 'src/lib/settings.js', 'src/lib/translate.js',
    'src/content/speech.js', 'src/content/engine.js', 'src/content/ui.js',
    'src/content/controller.js', 'src/reader/reader.js', 'src/reader/pdf.js',
    'src/reader/docx.js', 'src/options/options.js', 'web/shim.js',
]
OUT = os.path.join(ROOT, 'docs')

# source page -> published name
PAGES = [
    ('src/reader/reader.html', 'index.html'),
    ('src/options/options.html', 'settings.html'),
]

EXTRA = ['web/shim.js', 'web/mobile.css']

ASSET_RE = re.compile(r'(<(?:script|link|img)\b[^>]*?(?:src|href)=")([^"]+)(")')


def build_id():
    h = hashlib.sha256()
    for rel in sorted(WATCH_FOR_ID):
        path = os.path.join(ROOT, rel)
        if os.path.isfile(path):
            with open(path, 'rb') as f:
                h.update(f.read())
    return time.strftime('%Y-%m-%d') + ' ' + h.hexdigest()[:7]


def stamp_of(src_rel):
    with open(os.path.join(ROOT, src_rel), 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()[:10]


def published_path(src_rel):
    """src/content/engine.js -> content/engine.js ; icons/x.png -> icons/x.png"""
    if src_rel.startswith('src/'):
        return src_rel[len('src/'):]
    return src_rel


def copy_asset(src_rel):
    """Copy an asset and return its published path with a content stamp.

    The stamp matters on a deployed site, not just while developing: GitHub
    Pages serves assets with a cache lifetime, so without it a returning
    visitor keeps running the previous build's JavaScript against the new
    HTML - which is exactly the kind of mismatch that is impossible to
    diagnose from a bug report.
    """
    src = os.path.join(ROOT, src_rel)
    if not os.path.exists(src):
        raise SystemExit('missing asset referenced by a page: ' + src_rel)
    rel = published_path(src_rel)
    dst = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    with open(src, 'rb') as f:
        stamp = hashlib.sha256(f.read()).hexdigest()[:10]
    return rel, rel + '?v=' + stamp


MANIFEST = """{
  "name": "FocusRead",
  "short_name": "FocusRead",
  "description": "Read papers sentence by sentence: hear them read aloud, stay focused, translate as you go.",
  "start_url": ".",
  "scope": ".",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#121417",
  "theme_color": "#1b1d21",
  "icons": [
    { "src": "icons/icon48.png", "sizes": "48x48", "type": "image/png" },
    { "src": "icons/icon128.png", "sizes": "128x128", "type": "image/png" }
  ]
}
"""

# The web build has no manifest to read a version out of, so stamp one in.
# Settings prints it, which is how "am I looking at the new build?" gets an
# answer without diffing files.
BUILD_STAMP = """<script>window.FR=window.FR||{};FR.BUILD="%s";</script>
"""

HEAD_EXTRAS = """<link rel="icon" href="icons/icon32.png">
<link rel="apple-touch-icon" href="icons/icon128.png">
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#1b1d21">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="FocusRead">
"""

# Orientation, not instructions: it is read once and then in the way, so it
# lives behind a button and the page opens on the two things you might do.
WEB_NOTE = """
<section class="webnote">
  <div class="webnoteRow">
    <button type="button" id="aboutBtn" class="ghost about"
            aria-expanded="false" aria-controls="aboutBody">
      <span class="badge" aria-hidden="true">i</span>What is this?
    </button>
    <button type="button" id="trySample" class="ghost">Try it on a sample paper</button>
  </div>
  <div id="aboutBody" class="webnoteBody" hidden>
    <p><strong>FocusRead on the web.</strong> Open a PDF or Word file below and
    read it sentence by sentence - tap a sentence to hear it, tap again to stop.
    Everything happens on your device; the file is never uploaded.</p>
    <p>This is the reader only. To use FocusRead on <em>web pages</em> as well
    you need the Chrome extension, which browsers on phones cannot run -
    <a href="https://github.com/ldulin/FocusRead" target="_blank" rel="noopener">source
    and install instructions</a>.</p>
  </div>
</section>
"""


def build_page(src_rel, out_name):
    src_dir = os.path.dirname(src_rel)
    with open(os.path.join(ROOT, src_rel), encoding='utf-8') as f:
        html = f.read()

    copied = []

    def fix(m):
        pre, url, post = m.group(1), m.group(2), m.group(3)
        if url.startswith(('http:', 'https:', 'data:', '//', '#')):
            return m.group(0)
        bare = url.split('?')[0]
        resolved = os.path.normpath(os.path.join(src_dir, bare))
        rel, stamped = copy_asset(resolved)
        copied.append(rel)
        return pre + stamped + post

    html = ASSET_RE.sub(fix, html)

    # The shim must run before anything that touches chrome.*
    html = html.replace('<script src=',
                        '<script src="shim.js?v=%s"></script>\n<script src=' % stamp_of('web/shim.js'), 1)

    # Mobile styling last, so it can override the shared sheets.
    html = html.replace('</head>',
                        HEAD_EXTRAS + (BUILD_STAMP % BUILD_ID) +
                        '<link rel="stylesheet" href="mobile.css?v=%s">\n</head>' % stamp_of('web/mobile.css'),
                        1)

    if out_name == 'index.html':
        html = html.replace('<section id="drop"', WEB_NOTE + '\n  <section id="drop"', 1)
        html = html.replace('<title>FocusRead</title>',
                            '<title>FocusRead - read papers aloud, sentence by sentence</title>\n'
                            '<meta name="description" content="Open a PDF or Word file and read it '
                            'sentence by sentence: tap to hear it, dim the rest to stay focused, '
                            'translate a word or the whole page. Works on your phone.">\n'
                            '<meta name="color-scheme" content="light dark">', 1)

    # Buttons that only mean something inside an extension.
    html = html.replace('<button id="openDoc" class="ghost">Open a PDF or Word file</button>', '')

    if out_name == 'index.html':
        html = html.replace('</body>', '''<script>
(function () {
  // Once a document is open, even the closed row is just taking up reading
  // space, and there is nothing left on the page to orient anyone about. The
  // drop card's own visibility is the signal: it comes back when the document
  // is closed, and so does this.
  var noteSec = document.querySelector('.webnote');
  var drop = document.getElementById('drop');
  if (noteSec && drop && window.MutationObserver) {
    new MutationObserver(function () { noteSec.hidden = drop.hidden; })
      .observe(drop, { attributes: true, attributeFilter: ['hidden'] });
  }

  var aboutBtn = document.getElementById('aboutBtn');
  var aboutBody = document.getElementById('aboutBody');
  if (aboutBtn && aboutBody) {
    aboutBtn.addEventListener('click', function () {
      var open = aboutBody.hidden;
      aboutBody.hidden = !open;
      // Announce it as well as show it: the button IS the state.
      aboutBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // Somewhere to start without hunting for a file first.
  var sample = document.getElementById('trySample');
  if (!sample) return;
  sample.addEventListener('click', function () {
    sample.disabled = true;
    sample.textContent = 'Loading sample...';
    fetch('sample.pdf')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function (blob) {
        var file = new File([blob], 'sample-paper.pdf', { type: 'application/pdf' });
        var dt = new DataTransfer();
        dt.items.add(file);
        var input = document.getElementById('fileInput');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
      })
      .catch(function (e) {
        sample.disabled = false;
        sample.textContent = 'Try it on a sample paper';
        var box = document.getElementById('dropError');
        box.hidden = false;
        box.textContent = 'Could not load the sample: ' + e.message;
      });
  });
})();
</script>
</body>''', 1)

    with open(os.path.join(OUT, out_name), 'w', encoding='utf-8') as f:
        f.write(html)
    return copied


BUILD_ID = None


def write_build_json():
    # What the pages check themselves against; fetched with cache: 'no-store'.
    with open(os.path.join(OUT, 'build.json'), 'w', encoding='utf-8') as f:
        json.dump({'build': BUILD_ID}, f)


def main():
    global BUILD_ID
    BUILD_ID = build_id()
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    all_copied = []
    for src_rel, out_name in PAGES:
        all_copied += build_page(src_rel, out_name)
        print('built docs/' + out_name)

    for rel in EXTRA:
        dst = os.path.join(OUT, os.path.basename(rel))
        shutil.copy2(os.path.join(ROOT, rel), dst)
        print('copied docs/' + os.path.basename(rel))

    # Every icon, not just the two the pages reference: the web manifest and
    # the iOS home-screen icon need the larger ones.
    icons_out = os.path.join(OUT, 'icons')
    os.makedirs(icons_out, exist_ok=True)
    for name in sorted(os.listdir(os.path.join(ROOT, 'icons'))):
        if name.endswith('.png'):
            shutil.copy2(os.path.join(ROOT, 'icons', name), os.path.join(icons_out, name))

    # Installable, so it can be added to a phone's home screen and opened
    # without browser chrome - which is most of the point of the web build.
    with open(os.path.join(OUT, 'manifest.webmanifest'), 'w', encoding='utf-8') as f:
        f.write(MANIFEST)
    print('wrote docs/manifest.webmanifest')

    # The same PDF the tests use: a two-column paper with running heads, a
    # hyphen across a line break and the punctuation that breaks naive
    # splitters. Somewhere to start on a phone without finding a file first.
    shutil.copy2(os.path.join(ROOT, 'tests', 'fixtures', 'paper.pdf'),
                 os.path.join(OUT, 'sample.pdf'))
    print('copied docs/sample.pdf')

    write_build_json()
    print('wrote docs/build.json (%s)' % BUILD_ID)

    # Pages would otherwise run the whole thing through Jekyll, which ignores
    # files and folders beginning with an underscore and is pure overhead here.
    open(os.path.join(OUT, '.nojekyll'), 'w').close()

    print('\n%d assets copied:' % len(set(all_copied)))
    for p in sorted(set(all_copied)):
        print('  ' + p)


if __name__ == '__main__':
    main()
