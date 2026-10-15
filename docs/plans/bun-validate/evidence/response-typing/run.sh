#!/usr/bin/env bash
# Re-runs the response-typing spike (plan §B2) from scratch.
#
#   bash run.sh [scratch-dir]      default: ~/.cache/bun-node-ae/plan-validate/spike-rt
#
# 1. copies packages/bun-common (lib, __tests__, scripts) and packages/bun-nest
#    from this checkout into the scratch dir, with a node_modules whose
#    @kingsleyweb/bun-common points at the COPY;
# 2. applies response-typing.patch to the copy (4 files, ~80 lines);
# 3. checks, each with a bare `bun --check` and AGENT/CLAUDECODE/REPL_ID unset:
#    a. the patched bun-common lib + its own __tests__ + responses.spike.ts;
#    b. responses.spike.ts with every @ts-expect-error removed (must fail 9x);
#    c. bun-nest (lib + __tests__ + scripts) against the patched bun-common;
#    d. responses.spike.ts against UNPATCHED bun-common (must fail);
#    e. generate-verb-overloads.ts --check (the overloads are untouched).
# Deletes nothing outside the scratch dir.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../../.." && pwd)"
S="${1:-$HOME/.cache/bun-node-ae/plan-validate/spike-rt}"
chk() { (cd "$1" && env -u AGENT -u CLAUDECODE -u REPL_ID bun --check 2>&1); }

rm -rf "$S" && mkdir -p "$S/packages" "$S/node_modules/@kingsleyweb"
cp "$ROOT/tsconfig.base.json" "$S/"
for e in "$ROOT"/node_modules/* "$ROOT"/node_modules/.bin; do
  [ "$(basename "$e")" = "@kingsleyweb" ] || ln -s "$e" "$S/node_modules/$(basename "$e")"
done
ln -s ../../packages/bun-common "$S/node_modules/@kingsleyweb/bun-common"
ln -s "$ROOT/packages/bun-jobs" "$S/node_modules/@kingsleyweb/bun-jobs"
for p in bun-common bun-nest; do
  mkdir -p "$S/packages/$p"
  cp -r "$ROOT/packages/$p/"{lib,__tests__,scripts,package.json} "$S/packages/$p/"
done
cp -r "$S/packages/bun-common" "$S/base-bun-common"
printf '{ "extends": "../tsconfig.base.json", "compilerOptions": { "types": ["bun"] }, "include": ["./lib/**/*", "./spike/**/*"] }\n' > "$S/base-bun-common/tsconfig.json"
printf '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["bun"] }, "include": ["./lib/**/*", "./spike/**/*", "./__tests__/**/*", "./scripts/**/*"] }\n' > "$S/packages/bun-common/tsconfig.json"
cp "$ROOT/packages/bun-nest/tsconfig.json" "$S/packages/bun-nest/"
(cd "$S/packages/bun-common" && patch -p1 -s < "$HERE/response-typing.patch") || { echo "patch failed"; exit 1; }
mkdir -p "$S/packages/bun-common/spike" "$S/base-bun-common/spike"
cp "$HERE/responses.spike.ts" "$S/packages/bun-common/spike/"
cp "$HERE/responses.spike.ts" "$S/base-bun-common/spike/"

echo "== a. patched bun-common: lib + __tests__ + spike (expect: no errors)"; chk "$S/packages/bun-common" | tail -1
grep -v "@ts-expect-error" "$HERE/responses.spike.ts" > "$S/packages/bun-common/spike/zz-mutant.ts"
echo "== b. negative control: directives removed (expect 9 errors in zz-mutant)"
chk "$S/packages/bun-common" | grep "zz-mutant" | cut -c1-150; rm "$S/packages/bun-common/spike/zz-mutant.ts"
echo "== c. bun-nest against the patched bun-common (expect: no errors)"; chk "$S/packages/bun-nest" | tail -1
echo "== d. the spike against UNPATCHED bun-common (expect: errors)"; chk "$S/base-bun-common" | tail -1
echo "== e. generated overloads"; (cd "$S/packages/bun-common" && bun scripts/generate-verb-overloads.ts --check 2>&1)
