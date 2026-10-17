#!/usr/bin/env bash
# Type-checks this folder, then proves its negative controls fire: a copy of
# types.probe.ts with every `@ts-expect-error` line removed, checked in a
# scratch directory, must fail once per removed line.
#
#   bash check-types.sh [scratch-dir]   (default ~/.cache/bun-node-11/validate-plan/s1/mutant)
#
# It writes and deletes only inside the scratch directory.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"
scratch="${1:-$HOME/.cache/bun-node-11/validate-plan/s1/mutant}"
check() { (cd "$1" && env -u AGENT -u CLAUDECODE -u REPL_ID bun --check 2>&1); }

echo "## clean: bun --check in contract-core/"
check "$here"
echo "exit=$?"

rm -rf "$scratch" && mkdir -p "$scratch"
cp "$here/core.ts" "$here/transports.ts" "$scratch/"
grep -vE '^\s*// @ts-expect-error' "$here/types.probe.ts" > "$scratch/types.probe.ts"
ln -s "$repo/node_modules" "$scratch/node_modules"
cat > "$scratch/tsconfig.json" <<EOF
{ "extends": "$here/tsconfig.json", "include": ["./*.ts"] }
EOF
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
echo "mutant: $errors errors; controls=$controls"
echo "expected lines: $expected"
echo "error lines:    $actual"
[ "$expected" = "$actual" ] && echo "PASS: every control fires, and nothing else fails" || echo "FAIL: the lines differ"
