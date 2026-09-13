#!/usr/bin/env python3
"""
FocusRead - static wiring checks.

Catches the failure mode a browser only reveals at runtime: a reference that
points at nothing. Manifest paths, injected script order, element ids used by
JS but absent from the HTML, message types sent with no listener, and settings
keys read but never given a default.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
problems = []
checks = 0


def err(msg):
    problems.append(msg)


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def exists(rel):
    return os.path.exists(os.path.join(ROOT, rel))


def walk_js():
    for base, dirs, files in os.walk(os.path.join(ROOT, 'src')):
        dirs[:] = [d for d in dirs if d != 'node_modules']
        for f in files:
            if f.endswith('.js'):
                yield os.path.relpath(os.path.join(base, f), ROOT)


# ---------------------------------------------------------------- manifest
man = json.loads(read('manifest.json'))
paths = []
for size, p in man.get('icons', {}).items():
    paths.append(p)
for size, p in man.get('action', {}).get('default_icon', {}).items():
    paths.append(p)
paths.append(man['action']['default_popup'])
paths.append(man['background']['service_worker'])
paths.append(man['options_ui']['page'])
for entry in man.get('web_accessible_resources', []):
    for r in entry.get('resources', []):
        if '*' not in r:
            paths.append(r)

for p in paths:
    checks += 1
    if not exists(p):
        err('manifest.json references a missing file: %s' % p)

# ------------------------------------------------------- injected scripts
sw = read('src/background/service-worker.js')
inject_js = re.findall(r"'(src/[^']+\.js)'", sw.split('var INJECT_CSS')[0].split('var INJECT_JS')[1])
inject_css = re.findall(r"'(src/[^']+\.css)'", sw.split('var INJECT_CSS')[1][:200])

for p in inject_js + inject_css:
    checks += 1
    if not exists(p):
        err('service worker injects a missing file: %s' % p)

# Load-order: a file may only use an FR.<ns> that an earlier file defines.
DEFINES = {
    'src/lib/segmenter.js': ['segmenter'],
    'src/lib/settings.js': ['settings'],
    'src/lib/translate.js': ['translate'],
    'src/content/speech.js': ['speech'],
    'src/content/engine.js': ['Engine', 'engineUtils'],
    'src/content/ui.js': ['UI'],
    'src/content/controller.js': ['Controller', 'RATES'],
    'src/content/content.js': [],
}
seen = set()
for p in inject_js:
    checks += 1
    src = read(p)
    for ns in re.findall(r'FR\.([A-Za-z_]\w*)', src):
        if ns in ('__contentLoaded',):
            continue
        owner = next((f for f, names in DEFINES.items() if ns in names), None)
        if owner and owner != p and owner not in seen:
            err('%s uses FR.%s but %s is injected later' % (p, ns, owner))
    seen.add(p)

# ---------------------------------------------------- importScripts paths
for m in re.findall(r"importScripts\(([^)]*)\)", sw):
    for rel in re.findall(r"'([^']+)'", m):
        checks += 1
        resolved = os.path.normpath(os.path.join('src/background', rel))
        if not exists(resolved):
            err('service worker importScripts cannot resolve %s (-> %s)' % (rel, resolved))

# ------------------------------------------------------ HTML id <-> JS ids
PAGES = [
    ('src/popup/popup.html', ['src/popup/popup.js']),
    ('src/options/options.html', ['src/options/options.js']),
    ('src/reader/reader.html', ['src/reader/reader.js']),
]
for html_path, scripts in PAGES:
    html = read(html_path)
    ids = set(re.findall(r'\bid="([^"]+)"', html))
    for js in scripts:
        src = read(js)
        for used in set(re.findall(r"""\$\(['"]([^'"]+)['"]\)""", src)) | \
                    set(re.findall(r"""getElementById\(['"]([^'"]+)['"]\)""", src)):
            checks += 1
            if used not in ids:
                err('%s uses id "%s" which is not in %s' % (js, used, html_path))

# Every script tag in a page must exist on disk.
for html_path, _ in PAGES:
    html = read(html_path)
    base = os.path.dirname(html_path)
    for src in re.findall(r'<script src="([^"]+)"', html) + re.findall(r'<link rel="stylesheet" href="([^"]+)"', html):
        checks += 1
        resolved = os.path.normpath(os.path.join(base, src))
        if not exists(resolved):
            err('%s loads a missing file: %s (-> %s)' % (html_path, src, resolved))

# ------------------------------------------------------------ message types
sent, handled = {}, set()
for p in walk_js():
    src = read(p)
    for t in re.findall(r"type:\s*'(FR_[A-Z_]+)'", src):
        sent.setdefault(t, set()).add(p)
    for t in re.findall(r"msg\.type === '(FR_[A-Z_]+)'", src):
        handled.add(t)
    for t in re.findall(r"case '(FR_[A-Z_]+)'", src):
        handled.add(t)

for t, where in sorted(sent.items()):
    checks += 1
    if t not in handled:
        err('message %s is sent from %s but nothing handles it' % (t, ', '.join(sorted(where))))

# --------------------------------------------------------- settings keys
settings_src = read('src/lib/settings.js')
defaults_block = settings_src.split('var DEFAULTS = {')[1].split('\n  };')[0]
default_keys = set(re.findall(r'^\s{4}(\w+):', defaults_block, re.M))
provider_keys = set(re.findall(r'^\s{6}(\w+):', defaults_block, re.M))

# Only count unambiguous reads: `this.settings.x` / `self.settings.x` /
# `c.settings.x`. A bare `s.x` is far too noisy - `s` is also a script element,
# a state object and a string elsewhere in this codebase.
SETTINGS_READ = re.compile(r'(?<!FR)\.settings\.([a-z][A-Za-z]*)\b')
read_keys = set()
for p in walk_js():
    if p == 'src/lib/settings.js':
        continue
    read_keys |= set(SETTINGS_READ.findall(read(p)))

API = {'get', 'set', 'reset', 'peek', 'onChange'}
for k in sorted(read_keys - default_keys - API):
    if k in provider_keys:
        continue
    checks += 1
    err('settings key "%s" is read in code but has no default in settings.js' % k)

# Defaults nobody reads are dead weight; report them, but do not fail the run,
# since some are read only through the data-driven options schema.
opts_keys = set(re.findall(r"key:\s*'([A-Za-z.]+)'", read('src/options/options.js')))
opts_roots = {k.split('.')[0] for k in opts_keys}
unused = sorted(default_keys - read_keys - opts_roots - {'schemaVersion', 'providerConfig'})
if unused:
    print('  note  defaults not referenced anywhere: %s' % ', '.join(unused))

# Also the options-page schema must only reference real keys.
opts = read('src/options/options.js')
for k in set(re.findall(r"key:\s*'([A-Za-z.]+)'", opts)):
    checks += 1
    root_key = k.split('.')[0]
    if root_key not in default_keys:
        err('options.js exposes setting "%s" which has no default' % k)

# ----------------------------------------------------------------- CSS refs
css = read('src/content/content.css')
content_js = ''.join(read(p) for p in
                     ['src/content/controller.js', 'src/content/engine.js', 'src/content/ui.js'])
for cls in set(re.findall(r"'(fr-(?:hl|focus|tint)-[a-z]+)'", content_js)):
    checks += 1
    if cls not in css:
        err('JS toggles class .%s which content.css never styles' % cls)
for var in set(re.findall(r"setProperty\('(--fr-[a-z-]+)'", content_js)):
    checks += 1
    if var not in css:
        err('JS sets custom property %s which content.css never uses' % var)

# ----------------------------------------------------------------- report
print('wiring: %d checks' % checks)
if problems:
    for p in problems:
        print('  FAIL  ' + p)
    print('%d problem(s) found.' % len(problems))
    sys.exit(1)
print('  ok    everything referenced exists and is wired up.')
