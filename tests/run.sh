#!/usr/bin/env bash
# Run the FocusRead unit tests with no dependencies.
#
# macOS ships JavaScriptCore behind `osascript -l JavaScript`, so the tests run
# on a stock machine with no Node.js install. Exits non-zero if anything fails.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -t focusread-tests).js"
trap 'rm -f "$tmp"' EXIT

cat "$here/../src/lib/segmenter.js" "$here/segmenter.cases.js" > "$tmp"
cat >> "$tmp" <<'JS'
var r = FR.tests.run();
r.report + (r.fail ? '\nEXIT:1' : '\nEXIT:0');
JS

out="$(osascript -l JavaScript "$tmp")"
printf '%s\n' "${out%$'\n'EXIT:*}"
[[ "$out" == *"EXIT:0" ]] || { echo "TESTS FAILED"; exit 1; }

echo
"$here/syntax.sh"

echo
if command -v python3 >/dev/null; then
  python3 "$here/wiring.py"
else
  echo "wiring: skipped (needs python3)"
fi
