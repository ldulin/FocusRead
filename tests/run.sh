#!/usr/bin/env bash
# Run the FocusRead test suites.
#
# No Node.js required: macOS exposes JavaScriptCore through
# `osascript -l JavaScript`, so this works on a stock machine.
# Exits non-zero if anything fails.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here/.."
status=0

# run_suite <title> <entry-expression> <file>...
run_suite() {
  local title="$1" entry="$2"; shift 2
  local tmp; tmp="$(mktemp -t focusread-tests).js"
  cat "$@" > "$tmp"
  printf 'var r = %s; r.report + (r.fail ? "\\nEXIT:1" : "\\nEXIT:0");\n' "$entry" >> "$tmp"

  echo "== $title"
  local out; out="$(osascript -l JavaScript "$tmp" 2>&1)"
  rm -f "$tmp"
  printf '%s\n' "${out%$'\n'EXIT:*}"
  [[ "$out" == *"EXIT:0" ]] || status=1
  echo
}

run_suite "Sentence segmentation" "FR.tests.run()" \
  "$root/src/lib/segmenter.js" \
  "$here/segmenter.cases.js"

run_suite "Voice curation" "FR.voiceTests.run()" \
  "$here/jsc-stubs.js" \
  "$root/src/lib/segmenter.js" \
  "$root/src/content/speech.js" \
  "$here/voice.cases.js"

run_suite "Gapless runs" "FR.gaplessTests.run()" \
  "$here/jsc-stubs.js" \
  "$root/src/lib/segmenter.js" \
  "$root/src/content/speech.js" \
  "$here/gapless.cases.js"

run_suite "Service worker decisions" "FR.swTests.run()" \
  "$here/sw-stub.js" \
  "$root/src/lib/segmenter.js" \
  "$root/src/lib/settings.js" \
  "$root/src/lib/translate.js" \
  "$root/src/background/service-worker.js" \
  "$here/sw.cases.js"

run_suite "PDF layout reconstruction" "FR.pdfTests.run()" \
  "$here/jsc-stubs.js" \
  "$root/src/lib/segmenter.js" \
  "$root/src/reader/pdf.js" \
  "$here/pdf.cases.js"

echo "== Syntax"
"$here/syntax.sh" || status=1
echo

echo "== Wiring"
if command -v python3 >/dev/null; then
  python3 "$here/wiring.py" || status=1
else
  echo "  skipped (needs python3)"
fi

echo
if [[ $status -eq 0 ]]; then
  echo "All suites passed."
else
  echo "FAILURES - see above."
fi
exit $status
