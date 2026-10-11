const f = process.argv[2];
const p = JSON.parse(await Bun.file(f).text());
const byId = new Map(p.nodes.map((n: any) => [n.id, n]));
const self = new Map<number, number>();
const dt = p.timeDeltas; const samples = p.samples;
for (let i = 0; i < samples.length; i++) self.set(samples[i], (self.get(samples[i]) ?? 0) + (dt[i] ?? 0));
const agg = new Map<string, number>();
let total = 0;
for (const [id, t] of self) { const n: any = byId.get(id); const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-1)[0]}:${n.callFrame.lineNumber + 1}`; agg.set(k, (agg.get(k) ?? 0) + t); total += t; }
for (const [k, t] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(((t / total) * 100).toFixed(1).padStart(5) + "%  " + k);
