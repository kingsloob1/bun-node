#!/bin/bash
# ab.sh PATH LUA L1 L2 ...: interleaved wrk rounds of layers; µs/request.
path=$1; lua=$2; shift 2
for r in 1 2 3; do
  for L in "$@"; do
    if [ "$L" = elysia2 ]; then cmd="bun ../../../../../benchmarks/scenarios/servers.ts elysia2"; else cmd="bun served-layers.ts"; fi
    LAYER=$L NODE_ENV=production taskset -c 0 $cmd > ab.out 2>&1 & pid=$!
    for i in $(seq 1 60); do grep -q READY ab.out && break; sleep 0.1; done
    port=$(grep -o "READY [0-9]*" ab.out | grep -o "[0-9]*")
    s=""; [ -n "$lua" ] && s="-s $lua"
    taskset -c 1-3 wrk -t2 -c64 -d1s $s http://127.0.0.1:$port$path >/dev/null
    rps=$(taskset -c 1-3 wrk -t2 -c64 -d4s $s http://127.0.0.1:$port$path | awk '/Requests\/sec/{print int($2)}')
    kill $pid; wait $pid 2>/dev/null
    echo "$L $rps"
  done
done | awk '{a[$1]=a[$1]" "$2; s[$1]+=$2; c[$1]++} END {for (k in a) printf "%-10s %s  (mean %d = %.2f us)\n", k, a[k], s[k]/c[k], 1e6*c[k]/s[k]}'
