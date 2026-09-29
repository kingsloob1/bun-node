#!/usr/bin/env bash
# Runs the whole gateway matrix and appends one JSON line per run to $OUT.
#   OUT=results.ndjson BACKENDS="memory redis" RUNS=3 ./run-matrix.sh
set -u
cd "$(dirname "$0")"
OUT=${OUT:-results.ndjson}
BACKENDS=${BACKENDS:-"memory redis postgres"}
RUNS=${RUNS:-3}
for backend in $BACKENDS; do
  jobs=20000
  [ "$backend" != memory ] && jobs=10000
  for batch in on off; do
    for mode in direct ws http pull-proxy; do
      for run in $(seq 1 "$RUNS"); do
        timeout 300 bun bench.ts --backend "$backend" --mode "$mode" --batch "$batch" \
          --jobs "$jobs" --concurrency 32 2>/dev/null | tail -1 >>"$OUT"
      done
      timeout 300 bun bench.ts --backend "$backend" --mode "$mode" --batch "$batch" \
        --latency 500 2>/dev/null | tail -1 >>"$OUT"
    done
  done
done
