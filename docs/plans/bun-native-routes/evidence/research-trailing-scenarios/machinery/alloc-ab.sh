#!/bin/bash
for r in 1 2 3; do for a in 0 1 3 6; do
  ALLOC=$a NODE_ENV=production taskset -c 0 bun alloc.ts > al.out 2>&1 & pid=$!
  for i in $(seq 1 50); do grep -q READY al.out && break; sleep 0.1; done
  port=$(grep -o "READY [0-9]*" al.out | grep -o "[0-9]*")
  taskset -c 1-3 wrk -t2 -c64 -d1s http://127.0.0.1:$port/x >/dev/null
  rps=$(taskset -c 1-3 wrk -t2 -c64 -d4s http://127.0.0.1:$port/x | awk '/Requests\/sec/{print int($2)}')
  kill $pid; wait $pid 2>/dev/null; echo "$a $rps"
done; done | awk '{s[$1]+=$2; c[$1]++; a[$1]=a[$1]" "$2} END {for (k in s) printf "ALLOC=%s %s  mean %.2f us\n", k, a[k], 1e6*c[k]/s[k]}' | sort
