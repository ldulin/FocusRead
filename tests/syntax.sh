#!/usr/bin/env bash
# Parse every JavaScript file in the extension.
#
# No Node.js required: macOS exposes JavaScriptCore through
# `osascript -l JavaScript`, and `new Function(src)` PARSES a file without
# running it - so DOM and chrome.* references are fine, syntax errors are not.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here/.."
fail=0

check_one() {
  PATHARG="$1" osascript -l JavaScript <<'JS' 2>&1
ObjC.import('Foundation');
var p = $.NSProcessInfo.processInfo.environment.objectForKey('PATHARG').js;
var s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
if (s.isNil()) { 'READ_ERROR'; }
else {
  try { new Function(ObjC.unwrap(s)); 'OK'; }
  catch (e) { 'SYNTAX: ' + e.message; }
}
JS
}

while IFS= read -r f; do
  rel="${f#"$root"/}"
  out="$(check_one "$f")"
  if [[ "$out" == "OK" ]]; then
    printf '  ok    %s\n' "$rel"
  else
    printf '  FAIL  %s\n        %s\n' "$rel" "$out"
    fail=1
  fi
done < <(find "$root/src" "$root/tests" -name '*.js' | sort)

if [[ $fail -eq 0 ]]; then echo "All files parse."; else echo "PARSE FAILURES"; exit 1; fi
