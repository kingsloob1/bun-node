#!/bin/bash
# layer-ab.sh L1 L2 ...: interleaved wrk rounds of layers.ts layers (multipart), µs/request.
for r in 1 2 3; do
  for L in "$@"; do
    LAYER=$L NODE_ENV=production taskset -c 0 bun served-layers.ts > la.out 2>&1 & pid=$!
    for i in $(seq 1 50); do grep -q READY la.out && break; sleep 0.1; done
    port=$(grep -o "READY [0-9]*" la.out | grep -o "[0-9]*")
    taskset -c 1-3 wrk -t2 -c64 -d1s -s ${LUA:-upload.lua} http://127.0.0.1:$port/upload >/dev/null
    rps=$(taskset -c 1-3 wrk -t2 -c64 -d4s -s ${LUA:-upload.lua} http://127.0.0.1:$port/upload | awk '/Requests\/sec/{print int($2)}')
    kill $pid; wait $pid 2>/dev/null
    echo "$L $rps"
  done
done | awk '{a[$1]=a[$1]" "$2; s[$1]+=$2; c[$1]++} END {for (k in a) printf "%-14s %s  (mean %d req/s = %.1f us)\n", k, a[k], s[k]/c[k], 1e6*c[k]/s[k]}'
