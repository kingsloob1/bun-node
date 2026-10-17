// usage: bun cmp.ts <eslint.json> <bun.json> — typescript-eslint vs bun lint --type-aware, per rule, keyed by file:line:col:rule
import { readFileSync } from "node:fs";
type R = { filePath: string; messages: { ruleId: string | null; line: number; column: number; message: string; severity: number }[] }[];
const rel = (p: string) => p.replace(/.*\/native\//, "");
const load = (f: string, keep: (r: string) => boolean) => { const m = new Map<string, string>(); let fatal = 0; for (const x of JSON.parse(readFileSync(f, "utf8")) as R) for (const y of x.messages) { if (!y.ruleId) { fatal++; continue } if (keep(y.ruleId)) m.set(`${rel(x.filePath)}:${y.line}:${y.column}:${y.ruleId}`, y.message) } return { m, fatal } };
const isTA = (r: string) => r.startsWith("@typescript-eslint/") && new Set(process.env.TA_RULES!.split(",")).has(r.slice(19));
const e = load(process.argv[2]!, isTA), b = load(process.argv[3]!, isTA);
console.log(`fatal (no ruleId): eslint ${e.fatal}, bun ${b.fatal}`);
const rules = new Set([...e.m.keys(), ...b.m.keys()].map(k => k.split(":").pop()!));
console.log("rule\ttypescript-eslint\tbun\tboth\teslint-only\tbun-only");
for (const r of [...rules].sort()) { const ek = [...e.m.keys()].filter(k => k.endsWith(`:${r}`)), bk = [...b.m.keys()].filter(k => k.endsWith(`:${r}`)); const both = ek.filter(k => b.m.has(k)).length; console.log(`${r.slice(19)}\t${ek.length}\t${bk.length}\t${both}\t${ek.length - both}\t${bk.length - both}`) }
if (process.env.SHOW) for (const [k, v] of b.m) if (!e.m.has(k) && k.endsWith(process.env.SHOW)) console.log("bun-only", k, v.slice(0, 100));
if (process.env.SHOWE) for (const [k, v] of e.m) if (!b.m.has(k) && k.endsWith(process.env.SHOWE)) console.log("eslint-only", k, v.slice(0, 100));
