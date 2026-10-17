#!/usr/bin/env bash
# Re-runs the http-complete spike from scratch.
#
#   bash run.sh [scratch-dir]            default: ~/.cache/bun-node-11/validate-plan/s2/spike
#   BENCH=1 bash run.sh [scratch-dir]    also runs bench.ts, through the heavy-run wrapper
#
# 1. copies packages/bun-common (lib, __tests__, scripts) and packages/bun-nest
#    from this checkout into the scratch dir, with a node_modules whose
#    @kingsleyweb/bun-common points at the COPY, plus an unpatched base copy;
# 2. applies http-complete.patch to the copy (it contains response-typing.patch);
# 3. runs, each type check a bare `bun --check` with AGENT/CLAUDECODE/REPL_ID unset:
#    a. request-parts.probe.ts on the UNPATCHED workspace package (headers, cookies today);
#    b. the patched bun-common: lib + __tests__ + scripts + the three spike files;
#    c. types.probe.ts with every @ts-expect-error removed (expect 19 errors in zz-mutant);
#    d. bun-nest (lib + __tests__ + scripts) against the patched bun-common;
#    e. types.probe.ts against the UNPATCHED base (expect errors);
#    f. generate-verb-overloads.ts --check (the overloads are untouched);
#    g. runtime.probe.ts (H1-H52) through router.fetch();
#    h. bun-common's own suite on the patched copy and on the base copy;
#    i. with BENCH=1: bench.ts, wrapped (the only heavy step).
# Deletes nothing outside the scratch dir.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../../.." && pwd)"
S="${1:-$HOME/.cache/bun-node-11/validate-plan/s2/spike}"
chk() { (cd "$1" && env -u AGENT -u CLAUDECODE -u REPL_ID bun --check 2>&1); }
CFG='{ "extends": "%s", "compilerOptions": { "types": ["bun"], "paths": { "lib/*": ["./lib/*"], "utils/*": ["./lib/utils/*"] } }, "include": ["./lib/**/*", "./spike/**/*", "./__tests__/**/*", "./scripts/**/*"] }\n'

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
# shellcheck disable=SC2059
printf "$CFG" "../../tsconfig.base.json" > "$S/packages/bun-common/tsconfig.json"
# shellcheck disable=SC2059
printf "$CFG" "../tsconfig.base.json" > "$S/base-bun-common/tsconfig.json"
cp "$ROOT/packages/bun-nest/tsconfig.json" "$S/packages/bun-nest/"
(cd "$S/packages/bun-common" && patch -p1 -s < "$HERE/http-complete.patch") || { echo "patch failed"; exit 1; }
mkdir -p "$S/packages/bun-common/spike" "$S/base-bun-common/spike"
cp "$HERE"/{types.probe.ts,runtime.probe.ts,bench.ts} "$S/packages/bun-common/spike/"
cp "$HERE/types.probe.ts" "$S/base-bun-common/spike/"

echo "== a. request-parts.probe.ts, UNPATCHED workspace bun-common"
(cd "$HERE" && bun request-parts.probe.ts 2>&1)
echo "== b. patched bun-common: lib + __tests__ + scripts + spike (expect: no errors)"
chk "$S/packages/bun-common" | tail -1
grep -v "@ts-expect-error" "$HERE/types.probe.ts" > "$S/packages/bun-common/spike/zz-mutant.ts"
echo "== c. negative control: directives removed (expect 19 errors in zz-mutant: N1-N18 and the pinned limit L1)"
chk "$S/packages/bun-common" | grep "^spike/zz-mutant" | cut -c1-170
echo "   count: $(chk "$S/packages/bun-common" | grep -c "^spike/zz-mutant")"
rm "$S/packages/bun-common/spike/zz-mutant.ts"
echo "== d. bun-nest against the patched bun-common (expect: 1 error, bun-jobs/lib/api/errors.ts ProblemIssueDto)"
chk "$S/packages/bun-nest" | grep -E "error TS|errors? in|No type errors" | sed -E 's#^.*/packages/bun-jobs/#bun-jobs/#' | cut -c1-200
echo "== e. types.probe.ts against the UNPATCHED base (expect: errors)"
chk "$S/base-bun-common" | tail -1
echo "== f. generated overloads"
(cd "$S/packages/bun-common" && bun scripts/generate-verb-overloads.ts --check 2>&1)
echo "== g. runtime.probe.ts"
(cd "$S/packages/bun-common" && timeout 300 bun spike/runtime.probe.ts 2>&1)
echo "== h. bun-common's own suite, patched copy, then unpatched base (the same tests must fail in both)"
for d in "$S/packages/bun-common" "$S/base-bun-common"; do
  (cd "$d" && timeout 600 bun test 2>&1 | grep -E "^\(fail\)|^ +[0-9]+ (pass|fail|skip)$" | sed "s#^#   $(basename "$d"): #")
done
if [ "${BENCH:-}" = "1" ]; then
  echo "== i. bench.ts (heavy-run wrapper)"
  (cd "$S/packages/bun-common" && HEAVY_TICKET="${HEAVY_TICKET:-bun-node-11-httpcost}" /tmp/claude-1000/bun-node-heavy-run.sh nice -n 10 timeout 900 bun spike/bench.ts 2>&1)
fi
