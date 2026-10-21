#!/usr/bin/env bash
# Type-checks this folder against the real V3a types, then proves its
# negative controls fire: a copy of types.probe.ts with every
# `@ts-expect-error` line removed, checked in a scratch directory, must fail
# once per removed line, on exactly the lines the controls guard.
#
#   bash check-types.sh [scratch-dir]   (default ~/.cache/bun-node-11/validate-g1/v3c/scratch/mutant)
#
# The copies' relative imports of packages/ are rewritten to absolute paths,
# so the mutant reads the same lib files. It writes and deletes only inside
# the scratch directory.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
scratch="${1:-$HOME/.cache/bun-node-11/validate-g1/v3c/scratch/mutant}"
check() { (cd "$1" && env -u AGENT -u CLAUDECODE -u REPL_ID bun --check 2>&1); }

echo "## clean: bun --check in response-variants/"
check "$here"
echo "exit=$?"

rm -rf "$scratch" && mkdir -p "$scratch"
abs() { sed "s#\\.\\./\\.\\./\\.\\./\\.\\./\\.\\./packages/#$repo/packages/#g"; }
abs < "$here/variants.ts" > "$scratch/variants.ts"
grep -vE '^\s*// @ts-expect-error' "$here/types.probe.ts" | abs > "$scratch/types.probe.ts"
ln -s "$repo/node_modules" "$scratch/node_modules"
cat > "$scratch/tsconfig.json" <<JSON
{ "extends": "$here/tsconfig.json", "include": ["./*.ts"] }
JSON
controls=$(grep -cE '^\s*// @ts-expect-error' "$here/types.probe.ts")
echo
echo "## mutant: every @ts-expect-error removed ($controls controls)"
out="$(check "$scratch")"
echo "$out" | grep -E 'error TS|errors? in' || echo "$out"
errors=$(echo "$out" | grep -c 'error TS')
# Each control guards the line after it; in the mutant that line moves up by
# the number of controls removed so far. The errors must be on exactly those.
expected=$(grep -nE '^\s*// @ts-expect-error' "$here/types.probe.ts" | cut -d: -f1 | awk '{ print $1 + 1 - NR }' | sort -un | tr '\n' ' ')
actual=$(echo "$out" | grep 'error TS' | sed -nE 's/^types\.probe\.ts\(([0-9]+),.*/\1/p' | sort -un | tr '\n' ' ')
others=$(echo "$out" | grep 'error TS' | grep -vc '^types\.probe\.ts(')
echo "mutant: $errors errors; controls=$controls; errors outside the probe: $others"
echo "expected lines: $expected"
echo "error lines:    $actual"
[ "$expected" = "$actual" ] && [ "$others" = 0 ] && echo "PASS: every control fires, and nothing else fails" || echo "FAIL: the lines differ"
