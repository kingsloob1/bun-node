// Summarise out/perf.tsv: per tool and scope, the median of 3 runs (wall, user+sys), and the per-run totals over the 11 scopes.
const rows = (await Bun.file(process.argv[2]).text()).trim().split("\n").slice(1).map(l => l.split("\t"));
type R = { tool: string; scope: string; run: number; wall: number; cpu: number; lb: number; la: number; exit: string };
const rs: R[] = rows.map(r => ({ tool: r[0], scope: r[1], run: +r[2], wall: +r[3], cpu: +r[4] + +r[5], lb: +r[6], la: +r[7], exit: r[8] }));
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const tools = [...new Set(rs.map(r => r.tool))];
const scopes = [...new Set(rs.map(r => r.scope))];
const f = (n: number) => n.toFixed(2);
console.log("| scope | " + tools.map(t => t).join(" | ") + " |");
console.log("|---|" + tools.map(() => "---|").join(""));
for (const s of scopes) {
  const cells = tools.map(t => { const x = rs.filter(r => r.tool === t && r.scope === s); return x.length ? `${f(med(x.map(r => r.wall)))} s (${f(med(x.map(r => r.cpu)))} CPU)` : ""; });
  if (cells.some(Boolean)) console.log(`| ${s} | ${cells.join(" | ")} |`);
}
console.log("\nTotals over the 11 lint scopes, per run (wall / CPU), and the median:");
for (const t of tools) {
  const per = [1, 2, 3].map(run => { const x = rs.filter(r => r.tool === t && r.run === run && !["ALL-root", "scope-1651"].includes(r.scope)); return x.length ? [x.reduce((a, r) => a + r.wall, 0), x.reduce((a, r) => a + r.cpu, 0)] : null; }).filter(Boolean) as number[][];
  if (per.length) console.log(`${t}: ${per.map(p => `${f(p[0])}/${f(p[1])}`).join(", ")}  median wall ${f(med(per.map(p => p[0])))} s, CPU ${f(med(per.map(p => p[1])))} s`);
}
const loads = rs.map(r => r.lb).concat(rs.map(r => r.la));
console.log(`\nload1 during the runs: min ${Math.min(...loads)}, median ${med(loads)}, max ${Math.max(...loads)}`);
console.log("exit codes by tool:", JSON.stringify(Object.fromEntries(tools.map(t => [t, [...new Set(rs.filter(r => r.tool === t).map(r => r.exit))]]))));
