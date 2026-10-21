#!/usr/bin/env bash
# Runs each bench.ts scenario in its own process (fresh JIT state), REPEAT
# times (default 3), pinned to one CPU when `taskset` exists (PIN, default
# 3), and prints each run's minimum and median and the load before and after
# it, then the `last` rows again with FLATTEN=1. Separate processes of the same scenario differed by up to 3x unpinned
# (bimodal), so read the lowest of the runs. Run it through the heavy-run
# wrapper (bench.ts's header says how). Writes nothing.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here" || exit 1
repeat="${REPEAT:-3}"
pin=()
command -v taskset > /dev/null && pin=(taskset -c "${PIN:-3}")
names=("plain")
for n in 1 2 4 8; do names+=("first N=$n" "last N=$n" "by N=$n" "named N=$n"); done
names+=("adjust fill+strip" "reserialize")
runs=()
for name in "${names[@]}"; do runs+=("0|$name"); done
for n in 1 2 4 8; do runs+=("1|last N=$n"); done
first=1
for run in "${runs[@]}"; do
  flatten="${run%%|*}"
  name="${run#*|}"
  for ((i = 1; i <= repeat; i++)); do
    out="$(FLATTEN="$flatten" ONLY="$name" "${pin[@]}" bun bench.ts)" || { echo "FAILED: $name"; exit 1; }
    if [ "$first" = 1 ]; then echo "$out" | sed -n 1p; echo "# pinned: ${pin[*]:-no}; $repeat runs per scenario"; first=0; fi
    echo "$out" | sed -n '3p' | tr -d '\n'
    echo "   ($(echo "$out" | sed -n 2p | sed 's/^# //'))"
  done
done
