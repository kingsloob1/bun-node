import { readdirSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const sev = (v: any) => { const s = Array.isArray(v) ? v[0] : v; return s === 2 || s === "error" ? "error" : s === 1 || s === "warn" ? "warn" : "off"; };
const union = new Map<string, { sev: Set<string>; files: string[]; opts: string }>();
for (const f of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
  const c = await Bun.file(join(dir, f)).json();
  for (const [k, v] of Object.entries<any>(c.rules ?? {})) {
    const s = sev(v); if (s === "off") continue;
    const e = union.get(k) ?? { sev: new Set(), files: [], opts: "" };
    e.sev.add(s); e.files.push(f.replace(/\.json$/, ""));
    if (Array.isArray(v) && v.length > 1 && !e.opts) e.opts = JSON.stringify(v.slice(1));
    union.set(k, e);
  }
}
const rows = [...union.entries()].sort(([a], [b]) => a.localeCompare(b));
console.log("rule\tseverity\tfiles\toptions");
for (const [k, e] of rows) console.log([k, [...e.sev].join("/"), e.files.length === 10 ? "all" : e.files.join(","), e.opts].join("\t"));
