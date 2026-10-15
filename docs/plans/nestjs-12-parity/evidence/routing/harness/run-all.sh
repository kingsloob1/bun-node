#!/usr/bin/env bash
# Runs the routing differential in two mirrors (evidence/nest-mirror.sh makes
# them) and writes results/ beside this folder.
#   MIRROR11=<repo copy on Nest 11> MIRROR12=<repo copy on Nest 12> harness/run-all.sh [group-filter]
# A filter writes partial results over results/: re-run without one after.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
FILTER="${1:-}"
for v in 11 12; do
  mirror_var="MIRROR$v"
  dir="${!mirror_var}/spikes-routing"
  mkdir -p "$dir"
  cp "$HERE"/harness/{app.ts,probes.ts,run.ts,tsconfig.json} "$dir/"
  # cwd must be the spike dir: Bun reads decorator options from the cwd's tsconfig.
  (cd "$dir" && env -u AGENT -u CLAUDECODE -u REPL_ID timeout 120 bun run.ts "$HERE/results/raw-nest$v.json" $FILTER)
done
bun "$HERE/harness/compare.ts" "$HERE/results/raw-nest11.json" "$HERE/results/raw-nest12.json" "$HERE/results/results.md"
