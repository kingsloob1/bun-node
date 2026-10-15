/**
 * Per-response summary of two probe results: status A/B, body same?, header
 * names only in A / only in B / different. Usage: bun brief.ts a.json b.json
 * A response is any object with numeric `status` and `headers`.
 */
const [a, b] = await Promise.all(process.argv.slice(2, 4).map((p) => Bun.file(p).json()));
const NOISE = new Set(["content-length", "x-powered-by"]);
const ct = (v: any) => (typeof v === "string" ? v.replace(/;\s*/g, ";").toLowerCase() : v);
function isResp(x: any) {
  return x && typeof x === "object" && typeof x.status === "number" && x.headers;
}
function walk(x: any, y: any, path: string) {
  if (isResp(x) || isResp(y)) {
    if (!isResp(x) || !isResp(y)) {
      console.log(`${path}: A=${JSON.stringify(x)?.slice(0, 160)} | B=${JSON.stringify(y)?.slice(0, 160)}`);
      return;
    }
    const onlyA: string[] = [], onlyB: string[] = [], diff: string[] = [];
    for (const k of new Set([...Object.keys(x.headers), ...Object.keys(y.headers)])) {
      if (NOISE.has(k)) continue;
      const va = k === "content-type" ? ct(x.headers[k]) : x.headers[k];
      const vb = k === "content-type" ? ct(y.headers[k]) : y.headers[k];
      if (va === undefined) onlyB.push(k);
      else if (vb === undefined) onlyA.push(k);
      else if (JSON.stringify(va) !== JSON.stringify(vb)) diff.push(`${k}(${JSON.stringify(va)} vs ${JSON.stringify(vb)})`);
    }
    const same = x.status === y.status && x.body === y.body && !onlyA.length && !onlyB.length && !diff.length;
    console.log(`${same ? "  =" : "  ≠"} ${path}: ${x.status}/${y.status}${x.body === y.body ? "" : ` body A=${JSON.stringify(x.body).slice(0, 140)} B=${JSON.stringify(y.body).slice(0, 140)}`}${onlyA.length ? ` onlyA=[${onlyA}]` : ""}${onlyB.length ? ` onlyB=[${onlyB}]` : ""}${diff.length ? ` diff=[${diff.join("; ")}]` : ""}`);
    return;
  }
  if (x && y && typeof x === "object" && typeof y === "object") {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (["probe", "kind", "nest", "platformExpress", "bun"].includes(k) && !path) continue;
      walk(x[k], y[k], path ? `${path}.${k}` : k);
    }
    return;
  }
  if (JSON.stringify(x) !== JSON.stringify(y)) console.log(`  ≠ ${path}: A=${JSON.stringify(x)?.slice(0, 200)} | B=${JSON.stringify(y)?.slice(0, 200)}`);
  else console.log(`  = ${path}: ${JSON.stringify(x)?.slice(0, 120)}`);
}
walk(a, b, "");
