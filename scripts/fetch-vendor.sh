#!/usr/bin/env bash
#
# FocusRead - download the third-party libraries the document reader needs.
#
#   pdf.js    reads PDFs
#   mammoth   reads .docx
#
# Neither is committed to this repository: they are large, and Manifest V3
# forbids loading them from a CDN at runtime, so they have to be real files
# inside the extension folder. Run this once after cloning, and again after
# changing a version below.
#
#   ./scripts/fetch-vendor.sh              # install
#   ./scripts/fetch-vendor.sh --check      # report what is present
#   PDFJS_VERSION=6.3.289 ./scripts/fetch-vendor.sh
#
# Packages are fetched from the npm registry rather than a CDN because cdnjs
# does not mirror pdf.js's wasm/, cmaps/ and standard_fonts/ directories, and
# a PDF that needs them fails in subtle ways rather than cleanly.

set -euo pipefail

PDFJS_VERSION="${PDFJS_VERSION:-6.3.289}"
MAMMOTH_VERSION="${MAMMOTH_VERSION:-1.12.3}"
SKIP_CMAPS="${SKIP_CMAPS:-0}"      # set to 1 to omit CJK character maps (~1.5 MB)

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
vendor="$root/vendor"
pdfdir="$vendor/pdfjs"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

report() {
  local ok=0
  echo "Installed libraries in $vendor:"
  for f in "$pdfdir/pdf.min.mjs" "$pdfdir/pdf.worker.min.mjs" "$vendor/mammoth.browser.min.js"; do
    if [[ -f "$f" ]]; then
      printf '  present  %-34s %s\n' "${f#"$vendor"/}" "$(du -h "$f" | cut -f1)"
    else
      printf '  MISSING  %s\n' "${f#"$vendor"/}"
      ok=1
    fi
  done
  for d in "$pdfdir/wasm" "$pdfdir/standard_fonts" "$pdfdir/cmaps"; do
    if [[ -d "$d" ]]; then
      printf '  present  %-34s %s files\n' "${d#"$vendor"/}/" "$(find "$d" -type f | wc -l | tr -d ' ')"
    else
      printf '  missing  %s/\n' "${d#"$vendor"/}"
    fi
  done
  return $ok
}

if [[ "${1:-}" == "--check" ]]; then
  report || { echo; red "Run ./scripts/fetch-vendor.sh to install the missing pieces."; exit 1; }
  green "Everything the reader needs is installed."
  exit 0
fi

command -v tar >/dev/null || { red "tar is required."; exit 1; }

# ---------------------------------------------------------------------------
# Downloader
#
# curl is the obvious choice and usually right, but it is not always usable:
# on a managed Mac an endpoint-security agent can block the curl binary
# specifically, which shows up as "Resolving timed out" even though the network
# is fine and other clients work. So try curl, then Python, then openssl, and
# only give up when none of them can fetch.
# ---------------------------------------------------------------------------

DOWNLOADER=""

probe_url="https://registry.npmjs.org/pdfjs-dist"

if command -v curl >/dev/null && curl -fsS -o /dev/null --max-time 15 "$probe_url" 2>/dev/null; then
  DOWNLOADER="curl"
elif command -v python3 >/dev/null && python3 - "$probe_url" <<'PYPROBE' >/dev/null 2>&1; then
import sys, socket, urllib.request
socket.setdefaulttimeout(15)
urllib.request.urlopen(sys.argv[1]).read(1)
PYPROBE
  DOWNLOADER="python3"
  dim "  curl could not reach the network; using python3 instead"
elif command -v wget >/dev/null && wget -q -O /dev/null --timeout=15 "$probe_url" 2>/dev/null; then
  DOWNLOADER="wget"
  dim "  curl could not reach the network; using wget instead"
else
  red "Could not reach https://registry.npmjs.org with curl, python3 or wget."
  red ""
  red "The network itself may be fine - check with:"
  red "    nslookup registry.npmjs.org"
  red "If that resolves but curl still times out, something on this machine is"
  red "blocking curl specifically (an endpoint-security agent, a VPN filter)."
  red ""
  red "You can also install the libraries by hand - see vendor/README.md."
  exit 1
fi

# download <url> <destination-file>
download() {
  case "$DOWNLOADER" in
    curl)   curl -fsSL --retry 3 --connect-timeout 20 "$1" -o "$2" ;;
    wget)   wget -q --tries=3 --timeout=20 -O "$2" "$1" ;;
    python3)
      python3 - "$1" "$2" <<'PYGET'
import sys, socket, urllib.request, shutil
socket.setdefaulttimeout(60)
req = urllib.request.Request(sys.argv[1], headers={'User-Agent': 'focusread-fetch-vendor'})
with urllib.request.urlopen(req) as r, open(sys.argv[2], 'wb') as f:
    shutil.copyfileobj(r, f)
PYGET
      ;;
  esac
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch_npm() {                      # fetch_npm <package> <version> <destdir>
  local pkg="$1" ver="$2" dest="$3"
  local url="https://registry.npmjs.org/${pkg}/-/${pkg}-${ver}.tgz"
  local tgz="$tmp/${pkg}-${ver}.tgz"
  dim "  downloading ${pkg}@${ver}"
  mkdir -p "$dest"
  if ! download "$url" "$tgz"; then
    red "Failed to download ${pkg}@${ver}"
    red "Tried: $url"
    red "That version may not exist. The current one is printed by:"
    red "  python3 -c \"import urllib.request,re;print(re.search(rb'\\\"latest\\\":\\\"([^\\\"]+)',urllib.request.urlopen('https://registry.npmjs.org/${pkg}').read(400000)).group(1).decode())\""
    exit 1
  fi
  tar xz -C "$dest" -f "$tgz" || { red "Could not unpack ${pkg}-${ver}.tgz"; exit 1; }
}

echo "Installing into $vendor"
mkdir -p "$pdfdir"

# ---- pdf.js ----------------------------------------------------------------
fetch_npm pdfjs-dist "$PDFJS_VERSION" "$tmp/pdfjs"
src="$tmp/pdfjs/package"

[[ -f "$src/build/pdf.min.mjs" ]] || { red "pdf.min.mjs not found in the tarball - does version $PDFJS_VERSION exist?"; exit 1; }

cp "$src/build/pdf.min.mjs"        "$pdfdir/"
cp "$src/build/pdf.worker.min.mjs" "$pdfdir/"
[[ -f "$src/web/pdf_viewer.css" ]] && cp "$src/web/pdf_viewer.css" "$pdfdir/"

for d in wasm standard_fonts; do
  if [[ -d "$src/$d" ]]; then
    rm -rf "${pdfdir:?}/$d"
    cp -R "$src/$d" "$pdfdir/$d"
  else
    dim "  note: $d/ is not in this pdf.js release"
  fi
done

if [[ "$SKIP_CMAPS" == "1" ]]; then
  dim "  skipping cmaps/ (SKIP_CMAPS=1) - CJK PDFs may not render"
elif [[ -d "$src/cmaps" ]]; then
  rm -rf "${pdfdir:?}/cmaps"
  cp -R "$src/cmaps" "$pdfdir/cmaps"
fi

# ---- mammoth ---------------------------------------------------------------
fetch_npm mammoth "$MAMMOTH_VERSION" "$tmp/mammoth"
msrc="$tmp/mammoth/package/mammoth.browser.min.js"
if [[ ! -f "$msrc" ]]; then
  red "mammoth.browser.min.js not found in the tarball."
  red "It is generated by a prepare script, so it exists in the npm package but not in a git clone."
  exit 1
fi
cp "$msrc" "$vendor/mammoth.browser.min.js"

# ---- sanity check ----------------------------------------------------------
# MV3 blocks eval. A library that needs it would fail at runtime with a CSP
# error that is hard to trace back here, so check now.
if grep -qE '[^.a-zA-Z0-9_]eval\(' "$vendor/mammoth.browser.min.js" 2>/dev/null; then
  red "  warning: mammoth.browser.min.js appears to call eval(), which MV3 blocks."
fi

echo
report
echo
green "Done. Now reload the extension at chrome://extensions."
