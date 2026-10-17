#!/bin/bash
# usage: run.sh <tag> [extra bun lint flags...]  — bun lint -f json in each of the 11 dirs of the clone, timed
S=/home/kingsloob1/.cache/bun-node-e8/agents/lintplan; tag=$1; shift
mkdir -p $S/out/$tag; cd $S/native
DIRS="packages/bun-common packages/bun-nest packages/bun-jobs packages/bun-jobs-ui scripts playground templates/compute-provider examples/bun-common examples/bun-nest examples/bun-jobs examples/bun-jobs-ui"
echo "load_start $(cut -d' ' -f1 /proc/loadavg)" > $S/out/$tag/times.txt
t0=$(date +%s.%N)
for d in $DIRS; do n=$(echo $d | tr / _)
  ( cd $d && /usr/bin/time -f "$d wall=%e user=%U sys=%S" env -u CLAUDECODE -u AGENT -u REPL_ID CI=1 bun lint "$@" -f json -o $S/out/$tag/$n.json >/dev/null 2>$S/out/$tag/$n.err; echo "$d exit=$?" >> $S/out/$tag/times.txt; tail -1 $S/out/$tag/$n.err >> $S/out/$tag/times.txt )
done
t1=$(date +%s.%N); echo "total_wall $(echo "$t1 - $t0" | bc)" >> $S/out/$tag/times.txt
echo "load_end $(cut -d' ' -f1 /proc/loadavg)" >> $S/out/$tag/times.txt
