#!/bin/bash
# Lint/format timing: 3 runs per tool per scope. Output TSV: tool scope run wall user sys load1_before load1_after
S=~/.cache/bun-node-ae/plan-lintfmt
OUT=$S/out/perf.tsv
SCOPES="packages/bun-common packages/bun-nest packages/bun-jobs packages/bun-jobs-ui scripts playground templates/compute-provider examples/bun-common examples/bun-nest examples/bun-jobs examples/bun-jobs-ui"
echo -e "tool\tscope\trun\twall_s\tuser_s\tsys_s\tload1_before\tload1_after\texit" > $OUT
t() { # tool scope run dir cmd...
  local tool=$1 scope=$2 run=$3 dir=$4; shift 4
  local lb=$(cut -d' ' -f1 /proc/loadavg)
  local tf=$S/out/perf.time.tmp
  (cd $dir && /usr/bin/time -o $tf -f "%e %U %S %x" "$@" >/dev/null 2>&1)
  local r=$(grep -v -i command $tf | tail -1)
  local la=$(cut -d' ' -f1 /proc/loadavg)
  set -- $r
  echo -e "$tool\t$scope\t$run\t$1\t$2\t$3\t$lb\t$la\t$4" >> $OUT
}
export CI=1
for run in 1 2 3; do
  for s in $SCOPES; do
    t eslint $s $run $S/copy/$s bunx eslint .
    t bunlint-eslintcfg $s $run $S/copy/$s bun lint
    t bunlint-native $s $run $S/native-perf/$s bun lint
    t bunlint-hybrid $s $run $S/hybrid-perf/$s bun lint
    t bunlint-native-regexp $s $run $S/regexp-perf/$s bun lint
  done
  t bunlint-native ALL-root $run $S/native-perf bun lint
  t prettier-3.8.4-check scope-1651 $run $S/copy $S/p38/node_modules/.bin/prettier --check --single-attribute-per-line $(cat $S/out/prettier-scope.list)
  t bunfmt-check scope-1651 $run $S/native-perf bun fmt --check $(cat $S/out/prettier-scope.list)
  t bunfmt-check ALL-root $run $S/native-perf bun fmt --check
done
