// Generate a native-only [lint] bunfig from ESLint's effective config (print-config JSONs).
import { join } from "node:path";
const pc = process.argv[2];
const load = async (n: string) => (await Bun.file(join(pc, n + ".json")).json()).rules as Record<string, any>;
const order = ["bun-common-lib-ts", "bun-common-test-ts", "bun-jobs-ui-app-tsx", "bun-jobs-ui-test-tsx"];
const sev = (v: any) => { const s = Array.isArray(v) ? v[0] : v; return s === 2 || s === "error" ? "error" : s === 1 || s === "warn" ? "warn" : "off"; };
const toml = (v: any): string => {
  if (v === null) return '""';
  if (Array.isArray(v)) return "[" + v.map(toml).join(", ") + "]";
  if (typeof v === "object") return "{ " + Object.entries(v).map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${toml(x)}`).join(", ") + " }";
  return JSON.stringify(v);
};
const map = new Map((await Bun.file(process.argv[3]).text()).trim().split("\n").slice(1).map(l => l.split("\t")).filter(r => r[3] === "yes").map(r => [r[0], r[2]]));
// renamed equivalents (hand-mapped; see rule-map.md)
const renamed: Record<string, string> = {
  "unused-imports/no-unused-vars": "@typescript-eslint/no-unused-vars",
  "antfu/no-top-level-await": "n/no-top-level-await",
  "e18e/prefer-array-some": "unicorn/prefer-array-some",
  "e18e/prefer-date-now": "unicorn/prefer-date-now",
  "e18e/prefer-includes": "unicorn/prefer-includes",
  "e18e/prefer-object-has-own": "prefer-object-has-own",
  "e18e/prefer-regex-test": "unicorn/prefer-regexp-test",
  "eslint-comments/no-unlimited-disable": "unicorn/no-abusive-eslint-disable",
  "test/no-only-tests": "bun:test/no-focused-tests",
  "react/no-missing-key": "react/jsx-key",
  "react/dom-no-dangerously-set-innerhtml": "react/no-danger",
  "react/dom-no-dangerously-set-innerhtml-with-children": "react/no-danger-with-children",
  "react/dom-no-find-dom-node": "react/no-find-dom-node",
  "react/dom-no-render-return-value": "react/no-render-return-value",
  "react/dom-no-void-elements-with-children": "react/void-dom-elements-no-children",
  "react/dom-no-script-url": "react/jsx-no-script-url",
  "react/dom-no-unsafe-iframe-sandbox": "react/iframe-missing-sandbox",
  "react/jsx-no-children-prop": "react/no-children-prop",
  "react/jsx-no-namespace": "react/no-namespace",
  "react/no-set-state-in-component-did-mount": "react/no-did-mount-set-state",
  "react/no-set-state-in-component-did-update": "react/no-did-update-set-state",
  "react/no-set-state-in-component-will-update": "react/no-will-update-set-state",
  "react/no-unsafe-component-will-mount": "react/no-unsafe",
  "react/no-nested-component-definitions": "react/no-unstable-nested-components",
  "react/no-unused-class-component-members": "react/no-unused-class-component-methods",
};
// options that do not carry over between differently-sourced rules
const dropOpts = new Set(["react/jsx-key", "react/no-unsafe", "react/iframe-missing-sandbox", "unicorn/no-abusive-eslint-disable", "bun:test/no-focused-tests", "n/no-top-level-await", "react/no-unstable-nested-components"]);

const known = new Set((await Bun.file(process.argv[5]).text()).trim().split("\n"));
const canon = (t: string) => t.replace(/^@typescript-eslint\//, "typescript/").replace(/^n\//, "node/");
const isNative = (t: string) => known.has(t) || known.has("eslint/" + t) || known.has(canon(t));
const nativeName = (k: string): string | undefined => {
  let t: string | undefined;
  if (k.startsWith("ts/")) t = "@typescript-eslint/" + k.slice(3);
  else if (k.startsWith("node/")) t = "n/" + k.slice(5);
  else if (k.startsWith("test/")) t = "bun:test/" + k.slice(5);
  else if (k === "style/jsx-curly-brace-presence") t = "react/jsx-curly-brace-presence";
  else if (k === "prettier/prettier") t = "bun/format";
  else t = renamed[k] ?? map.get(k) ?? k;
  if (renamed[k]) t = renamed[k];
  if (t === "bun:test/no-import-node-test") t = "vitest/no-import-node-test";
  if (t === "bun:test/no-only-tests") t = "bun:test/no-focused-tests";
  return t && isNative(t) ? t : undefined;
};
const fix = (t: string, v: any) => {
  if (t === "import/consistent-type-specifier-style" && Array.isArray(v)) return [v[0], "prefer-" + v[1]];
  return v;
};
const entry = (k: string, v: any) => {
  const t = nativeName(k); if (!t) return undefined;
  if (sev(v) === "off") return [t, `${JSON.stringify(t)} = "off"`];
  v = fix(t, v);
  const opts = Array.isArray(v) && v.length > 1 && !dropOpts.has(t) && t !== "bun/format" ? v.slice(1) : [];
  return [t, `${JSON.stringify(t)} = ${opts.length ? toml([sev(v), ...opts]) : JSON.stringify(sev(v))}`];
};
const table = (rules: Record<string, any>) => { const m = new Map<string, string>(); for (const [k, v] of Object.entries(rules)) { const e = entry(k, v); if (e && !(m.has(e[0]) && e[1].endsWith('"off"'))) m.set(e[0], e[1]); } return m; };
const lib = table(await load("bun-common-lib-ts"));
const test = table(await load("bun-common-test-ts"));
const app = table(await load("bun-jobs-ui-app-tsx"));
const apptest = table(await load("bun-jobs-ui-test-tsx"));
const diff = (a: Map<string, string>, b: Map<string, string>) => [...a.entries()].filter(([k, v]) => b.get(k) !== v).map(([, v]) => v);
const base = Object.fromEntries([...lib.entries()].filter(([, v]) => !v.endsWith('"off"') || true));
const tests = Object.fromEntries(diff(test, lib).map(v => [v, v]));
const react = Object.fromEntries(diff(app, lib).map(v => [v, v]));
const reactTests = Object.fromEntries(diff(apptest, app).filter(v => !Object.values(tests).includes(v)).map(v => [v, v]));
const out: string[] = [];
out.push("# GENERATED from ESLint's effective config by tools/gen-bunfig.ts — native rules only (no JS plugins).");
out.push("[lint]");
out.push('ignorePatterns = ["**/dist/**", "**/dts/**", "docs/**", "benchmarks/**", "**/bench/**/results/**"]');
out.push("reportUnusedDisableDirectives = \"warn\"");
out.push("", "[lint.rules]");
// unused-imports owns unused vars in our config: turn the plain rules off as antfu does
out.push(...Object.values(base).sort());
out.push("", "[[lint.overrides]]", 'files = ["**/__tests__/**", "**/*.spec.*", "**/*.test.*", "**/*.bench.*", "**/*.benchmark.*"]', "rules = { " + Object.values(tests).sort().map(l => l).join(", ") + " }");
out.push("", "[[lint.overrides]]", 'files = ["packages/bun-jobs-ui/**", "examples/bun-jobs-ui/**"]', "rules = { " + Object.values(react).sort().join(", ") + " }");
if (Object.keys(reactTests).length) out.push("", "[[lint.overrides]]", 'files = ["packages/bun-jobs-ui/__tests__/**"]', "rules = { " + Object.values(reactTests).sort().join(", ") + " }");
out.push("", "# antfu's per-glob disables (antfu/disables/scripts, cli, dts, cjs, config-files), kept as they are today.");
// The packages' overrideRules puts no-console back to "warn" after antfu's disables, so only top-level await stays off here.
out.push("[[lint.overrides]]", 'files = ["**/scripts/**", "**/cli/**", "**/cli.*", "**/*.config.*"]', 'rules = { "n/no-top-level-await" = "off" }');
out.push("[[lint.overrides]]", 'files = ["**/*.d.ts", "**/*.d.mts", "**/*.d.cts"]', 'rules = { "@typescript-eslint/no-unused-vars" = "off", "unicorn/no-abusive-eslint-disable" = "off" }');
out.push("[[lint.overrides]]", 'files = ["**/*.js", "**/*.cjs"]', 'rules = { "@typescript-eslint/no-require-imports" = "off" }');
out.push("", "# CLI entry points: printing is the product, and top-level await blocks no importer.");
out.push("[[lint.overrides]]", 'files = ["scripts/**", "playground/**", "examples/**", "templates/*/scripts/**"]', 'rules = { "no-console" = "off", "n/no-top-level-await" = "off" }');
await Bun.write(process.argv[4], out.join("\n") + "\n");
console.log("base", Object.keys(base).length, "tests", Object.keys(tests).length, "react", Object.keys(react).length);
