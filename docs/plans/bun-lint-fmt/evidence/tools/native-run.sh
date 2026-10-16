#!/bin/bash
# usage: native-run.sh <tag> — runs native bun lint per lint scope in native/ and tallies
cd ~/.cache/bun-node-ae/plan-lintfmt/native
rm -f ../out/native-*.json
for d in packages/bun-common packages/bun-nest packages/bun-jobs packages/bun-jobs-ui scripts playground templates/compute-provider examples/bun-common examples/bun-nest examples/bun-jobs examples/bun-jobs-ui; do n=$(echo $d | tr / _); (cd $d && CI=1 bun lint -f json -o ~/.cache/bun-node-ae/plan-lintfmt/out/native-$n.json >/dev/null 2>~/.cache/bun-node-ae/plan-lintfmt/out/native-$n.err; echo "$d exit $?"); done
cd ../out && bun -e '
const fs=require("fs"); const c={}; let files=0;
for (const f of fs.readdirSync(".").filter(f=>f.startsWith("native-")&&f.endsWith(".json"))) { let r; try { r=JSON.parse(fs.readFileSync(f)) } catch { console.log("bad", f, fs.readFileSync(f.replace(".json",".err"),"utf8").slice(0,300)); continue } files+=r.length; for (const x of r) for (const m of x.messages) { const k=(m.severity==2?"E ":"W ")+(m.ruleId??"(none)"); c[k]=(c[k]||0)+1 } }
console.log("files",files); console.log(Object.entries(c).sort((a,b)=>b[1]-a[1]).map(([k,v])=>v+" "+k).join("\n"))'
