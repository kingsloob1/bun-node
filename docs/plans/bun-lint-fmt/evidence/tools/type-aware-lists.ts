// usage: bun lists.ts <ta-outdir> <base-outdir> <evidence-dir> — one sorted findings list per directory, plus summary.tsv
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
type R = { filePath: string; messages: { ruleId: string | null; line: number; column: number; message: string; severity: number }[] }[];
const [ta, base, out] = process.argv.slice(2) as [string, string, string];
const TA = new Set(process.env.TA_RULES!.split(",").map(r => `@typescript-eslint/${r}`));
const rows: string[] = ["directory\trule\tneeds_types\tseverity\tfindings_type_aware_run\tfindings_default_run"];
for (const f of readdirSync(ta).filter(f => f.endsWith(".json")).sort()) {
  const dir = f.replace(/\.json$/, "").replace("_", "/");
  const t = JSON.parse(readFileSync(`${ta}/${f}`, "utf8")) as R, b = JSON.parse(readFileSync(`${base}/${f}`, "utf8")) as R;
  const lines: string[] = []; const ct: Record<string, number> = {}, cb: Record<string, number> = {};
  for (const x of t) for (const m of x.messages) {
    const p = x.filePath.replace(/.*\/native\//, ""); const sev = m.severity === 2 ? "error" : "warn";
    lines.push(`${p}:${m.line}:${m.column}\t${sev}\t${m.ruleId}${TA.has(m.ruleId ?? "") ? " [types]" : ""}\t${m.message.split("\n")[0]}`);
    const k = `${m.ruleId}\t${TA.has(m.ruleId ?? "") ? "yes" : "no"}\t${sev}`; ct[k] = (ct[k] ?? 0) + 1;
  }
  for (const x of b) for (const m of x.messages) { const k = `${m.ruleId}\tno\t${m.severity === 2 ? "error" : "warn"}`; cb[k] = (cb[k] ?? 0) + 1 }
  lines.sort((a, z) => a.localeCompare(z, "en", { numeric: true }));
  writeFileSync(`${out}/${f.replace(/\.json$/, ".txt")}`, `# ${dir}: bun lint --type-aware -f json, the answered root bunfig.toml, develop 930dd664, Bun 1.4.4-canary.1+5f5799ed1, 2026-10-17\n# file:line:column, severity, rule ([types] = needs types, on only with --type-aware), message. ${lines.length} findings.\n${lines.join("\n")}\n`);
  for (const k of Object.keys({ ...ct, ...cb }).sort()) rows.push(`${dir}\t${k}\t${ct[k] ?? 0}\t${cb[k] ?? 0}`);
}
writeFileSync(`${out}/summary.tsv`, rows.join("\n") + "\n");
