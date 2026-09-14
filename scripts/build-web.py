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
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'docs')

# source page -> published name
PAGES = [
    ('src/reader/reader.html', 'index.html'),
    ('src/options/options.html', 'settings.html'),
]

EXTRA = ['web/shim.js', 'web/mobile.css']

ASSET_RE = re.compile(r'(<(?:script|link|img)\b[^>]*?(?:src|href)=")([^"]+)(")')


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

HEAD_EXTRAS = """<link rel="icon" href="icons/icon32.png">
<link rel="apple-touch-icon" href="icons/icon128.png">
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#1b1d21">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="FocusRead">
"""

WEB_NOTE = """
<section class="webnote">
  <p><strong>FocusRead on the web.</strong> Open a PDF or Word file below and
  read it sentence by sentence - tap a sentence to hear it, tap again to stop.
  Everything happens on your device; the file is never uploaded.</p>
  <p>This is the reader only. To use FocusRead on <em>web pages</em> as well
  you need the Chrome extension, which browsers on phones cannot run -
  <a href="https://github.com/ldulin/FocusRead" target="_blank" rel="noopener">source
  and install instructions</a>.</p>
  <p><button type="button" id="trySample" class="ghost">Try it on a sample paper</button></p>
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
                        HEAD_EXTRAS +
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
  var note = document.querySelector('.webnote');
  if (note) {
    // The note is collapsed on a phone; let a tap open it.
    note.addEventListener('click', function (e) {
      if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON') return;
      note.classList.toggle('open');
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


def main():
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

    # Pages would otherwise run the whole thing through Jekyll, which ignores
    # files and folders beginning with an underscore and is pure overhead here.
    open(os.path.join(OUT, '.nojekyll'), 'w').close()

    print('\n%d assets copied:' % len(set(all_copied)))
    for p in sorted(set(all_copied)):
        print('  ' + p)


if __name__ == '__main__':
    main()
