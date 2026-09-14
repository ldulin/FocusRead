#!/usr/bin/env python3
"""
Generate standalone previews of the extension's pages.

The pages are copied verbatim apart from (a) a chrome.* stub injected before
everything else and (b) relative paths rewritten for the new location, so what
you see is the real markup, CSS and JS rather than a mock-up.

    python3 tests/preview/build.py && open tests/preview/popup.html
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'tests', 'preview')

PAGES = ['src/popup/popup.html', 'src/options/options.html', 'src/reader/reader.html']


def rewrite(url, src_dir):
    if url.startswith(('http:', 'https:', 'data:', '#')):
        return url
    # Resolve against the page's real directory, then make it relative to OUT.
    real = os.path.normpath(os.path.join(ROOT, src_dir, url))
    rel = os.path.relpath(real, OUT)
    # Cache-bust on mtime: without this the browser keeps serving the previous
    # build of a file you just edited, and you debug a bug you already fixed.
    try:
        return '%s?v=%d' % (rel, os.path.getmtime(real))
    except OSError:
        return rel


for page in PAGES:
    src_dir = os.path.dirname(page)
    with open(os.path.join(ROOT, page), encoding='utf-8') as f:
        html = f.read()

    html = re.sub(r'(<script src=")([^"]+)(")',
                  lambda m: m.group(1) + rewrite(m.group(2), src_dir) + m.group(3), html)
    html = re.sub(r'(<link rel="stylesheet" href=")([^"]+)(")',
                  lambda m: m.group(1) + rewrite(m.group(2), src_dir) + m.group(3), html)
    html = re.sub(r'(<img src=")([^"]+)(")',
                  lambda m: m.group(1) + rewrite(m.group(2), src_dir) + m.group(3), html)

    # The stub must run before any extension script touches chrome.*
    stub_v = int(os.path.getmtime(os.path.join(OUT, 'stub.js')))
    html = html.replace('<script src=',
                        '<script src="stub.js?v=%d"></script>\n<script src=' % stub_v, 1)

    name = os.path.basename(page)
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
        f.write(html)
    print('wrote tests/preview/' + name)


# page.html is hand-written and already lives here with correct paths; it only
# needs its cache-busters refreshed so an edit to src/ is actually picked up.
STANDALONE = ['page.html', 'runtime.html', 'sanitizer.html']
for name in STANDALONE:
    path = os.path.join(OUT, name)
    if not os.path.exists(path):
        continue
    with open(path, encoding='utf-8') as f:
        html = f.read()

    def stamp(m):
        pre, url, post = m.group(1), m.group(2), m.group(3)
        bare = url.split('?')[0]
        if bare.startswith(('http:', 'https:', 'data:', '#')):
            return m.group(0)
        real = os.path.normpath(os.path.join(OUT, bare))
        try:
            return '%s%s?v=%d%s' % (pre, bare, os.path.getmtime(real), post)
        except OSError:
            return '%s%s%s' % (pre, bare, post)

    html = re.sub(r'(<script src=")([^"]+)(")', stamp, html)
    html = re.sub(r'(<link rel="stylesheet" href=")([^"]+)(")', stamp, html)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    print('stamped tests/preview/' + name)
