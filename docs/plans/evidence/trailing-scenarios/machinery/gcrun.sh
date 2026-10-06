#!/bin/bash
# gcrun.sh NAME PATH LUA CMD...: serve under load for 5 s, report req/s and GC per request.
name=$1; path=$2; lua=$3; shift 3
BUN_JSC_logGC=1 NODE_ENV=production taskset -c 0 "$@" > gc.out 2>&1 & pid=$!
for i in $(seq 1 60); do grep -q "READY" gc.out && break; sleep 0.1; done
port=$(grep -o "READY [0-9]*" gc.out | grep -o "[0-9]*")
s=""; [ -n "$lua" ] && s="-s $lua"
n0=$(wc -l < gc.out)
rps=$(taskset -c 1-3 wrk -t2 -c64 -d5s $s http://127.0.0.1:$port$path | awk '/Requests\/sec/{print int($2)}')
kill $pid 2>/dev/null; wait $pid 2>/dev/null
tail -n +$n0 gc.out | awk -v n="$name" -v r="$rps" '/cycle [0-9.]*ms/{match($0,/cycle [0-9.]*ms/); v=substr($0,RSTART+6,RLENGTH-8); s+=v; c++} /FullCollection/{f++} END {printf "%-16s %6d req/s  cycles %4d (full %3d)  GC %6.1f ms  %.2f us/req\n", n, r, c, f, s, s*1000/(r*5)}'
