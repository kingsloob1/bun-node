const p = JSON.parse(await Bun.file(process.argv[2]).text());
const byId = new Map(p.nodes.map((n: any) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const self = new Map<number, number>();
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0));
const incl = new Map<string, number>(); let total = 0;
for (const [id, t] of self) { total += t; const seen = new Set<string>(); let cur: number | undefined = id; while (cur !== undefined) { const n: any = byId.get(cur); const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber + 1}`; if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + t); } cur = parent.get(cur); } }
for (const [k, t] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(((t / total) * 100).toFixed(1).padStart(5) + "%  " + k);
