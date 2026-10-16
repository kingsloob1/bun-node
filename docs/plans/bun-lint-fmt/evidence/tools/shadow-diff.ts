// Compare ESLint findings (out/eslint-*.json) with native bun lint findings (out/native-*.json).
// Rule names are normalised to Bun's native names; a finding is keyed by file:line:rule.
import { readdirSync, readFileSync } from "node:fs";
const dir = process.argv[2];
const norm = (r: string | null) => {
  if (!r) return "(parse)";
  const ren: Record<string, string> = { "antfu/no-top-level-await": "n/no-top-level-await", "unused-imports/no-unused-vars": "@typescript-eslint/no-unused-vars", "unused-imports/no-unused-imports": "@typescript-eslint/no-unused-vars", "prettier/prettier": "bun/format", "test/no-only-tests": "bun:test/no-focused-tests" };
  if (ren[r]) return ren[r];
  return r.replace(/^ts\//, "@typescript-eslint/").replace(/^node\//, "n/").replace(/^test\//, "bun:test/");
};
const rel = (p: string) => p.replace(/^.*\/plan-lintfmt\/(copy|native)\//, "");
const load = (prefix: string) => {
  const m = new Map<string, string>();
  for (const f of readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith(".json") && !f.includes("bun-common.json") || f === prefix + "packages_bun-common.json")) {
    for (const x of JSON.parse(readFileSync(`${dir}/${f}`, "utf8"))) for (const msg of x.messages) {
      if (/\.(md|json|jsonc|ya?ml|toml)$/.test(x.filePath) || /\.md\//.test(x.filePath)) continue; // native mode does not lint these
      const k = `${rel(x.filePath)}:${msg.line}:${norm(msg.ruleId)}`;
      m.set(k, (msg.severity === 2 ? "E" : "W"));
    }
  }
  return m;
};
const es = load("eslint-"), nb = load("native-");
const onlyE = [...es.keys()].filter(k => !nb.has(k)), onlyB = [...nb.keys()].filter(k => !es.has(k));
const both = [...es.keys()].filter(k => nb.has(k));
const byRule = (ks: string[]) => { const c: Record<string, number> = {}; for (const k of ks) { const r = k.split(":").slice(2).join(":"); c[r] = (c[r] ?? 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]); };
console.log(`ESLint findings (code files): ${es.size}; native: ${nb.size}; same file:line:rule: ${both.length}`);
console.log("\nOnly ESLint:"); for (const [r, n] of byRule(onlyE)) console.log(`  ${n}\t${r}`);
console.log("\nOnly bun lint:"); for (const [r, n] of byRule(onlyB)) console.log(`  ${n}\t${r}`);
if (process.argv[3]) { console.log("\n--- detail"); for (const k of [...onlyE.map(k => "E-only " + k), ...onlyB.map(k => "B-only " + k)]) if (k.includes(process.argv[3])) console.log(k); }
