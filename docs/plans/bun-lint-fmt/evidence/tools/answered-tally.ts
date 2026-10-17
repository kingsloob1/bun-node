// usage: bun tally.ts <outdir>  — findings per directory and per rule from run.sh's json reports
import { readdirSync, readFileSync } from "node:fs";
const dir = process.argv[2]!;
const perDir: Record<string, Record<string, number>> = {};
const perRule: Record<string, number> = {};
let files = 0, total = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
  const r = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { filePath: string; messages: { ruleId: string | null; severity: number }[] }[];
  const d = f.replace(/\.json$/, "").replace("_", "/");
  perDir[d] = {};
  files += r.length;
  for (const x of r) for (const m of x.messages) {
    const k = `${m.severity === 2 ? "E" : "W"} ${m.ruleId ?? "(none)"}`;
    perDir[d][k] = (perDir[d][k] ?? 0) + 1; perRule[k] = (perRule[k] ?? 0) + 1; total++;
  }
}
console.log(`files ${files}, findings ${total}`);
console.log("\n# per rule");
for (const [k, v] of Object.entries(perRule).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(5)} ${k}`);
console.log("\n# per directory");
for (const [d, m] of Object.entries(perDir)) {
  const n = Object.values(m).reduce((a, b) => a + b, 0);
  console.log(`${d}: ${n}`);
  for (const [k, v] of Object.entries(m).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)} ${k}`);
}
