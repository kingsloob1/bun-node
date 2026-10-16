// Classify every enabled ESLint rule: native-same | native-different | missing.
// Input: enabled-rules.tsv (from union.ts) and rule-map-raw.tsv (from map.ts). Output: parity.tsv + counts.
const rows = (await Bun.file(process.argv[2]).text()).trim().split("\n").slice(1).map(l => l.split("\t"));
const raw = new Map((await Bun.file(process.argv[3]).text()).trim().split("\n").slice(1).map(l => l.split("\t")).map(r => [r[0], r]));
type C = [cat: "native-same" | "native-different" | "missing", bun: string, note: string];
const diff: Record<string, [string, string]> = {
  "unused-imports/no-unused-vars": ["@typescript-eslint/no-unused-vars", "same options (^_ patterns are Bun's default too); does not treat a JSDoc {@link X} as a use (1 hit)"],
  "unused-imports/no-unused-imports": ["@typescript-eslint/no-unused-vars", "unused imports are reported by no-unused-vars; removed by --fix-suggestions, not --fix"],
  "antfu/no-top-level-await": ["n/no-top-level-await", "also reports for-await and await using"],
  "e18e/prefer-array-some": ["unicorn/prefer-array-some", "oxlint port"],
  "e18e/prefer-date-now": ["unicorn/prefer-date-now", "oxlint port"],
  "e18e/prefer-includes": ["unicorn/prefer-includes", "oxlint port"],
  "e18e/prefer-object-has-own": ["prefer-object-has-own", "ESLint core"],
  "e18e/prefer-regex-test": ["unicorn/prefer-regexp-test", "oxlint port; reports .match() on non-strings"],
  "e18e/prefer-nullish-coalescing": ["@typescript-eslint/prefer-nullish-coalescing", "needs types (--type-aware)"],
  "eslint-comments/no-unlimited-disable": ["unicorn/no-abusive-eslint-disable", "oxlint port"],
  "eslint-comments/no-unused-enable": ["reportUnusedInlineConfigs", "a linter option, not a rule"],
  "eslint-comments/no-duplicate-disable": ["reportUnusedDisableDirectives", "a linter option; a duplicate disable is an unused one"],
  "test/no-only-tests": ["bun:test/no-focused-tests", ""],
  "style/jsx-curly-brace-presence": ["react/jsx-curly-brace-presence", "eslint-plugin-react's rule"],
  "prettier/prettier": ["bun/format", "checks against bun fmt (Prettier 3.9 output)"],
  "react/no-missing-key": ["react/jsx-key", "eslint-plugin-react"],
  "react/dom-no-dangerously-set-innerhtml": ["react/no-danger", ""],
  "react/dom-no-dangerously-set-innerhtml-with-children": ["react/no-danger-with-children", ""],
  "react/dom-no-find-dom-node": ["react/no-find-dom-node", ""],
  "react/dom-no-render-return-value": ["react/no-render-return-value", ""],
  "react/dom-no-void-elements-with-children": ["react/void-dom-elements-no-children", ""],
  "react/dom-no-script-url": ["react/jsx-no-script-url", ""],
  "react/dom-no-unsafe-iframe-sandbox": ["react/iframe-missing-sandbox", "narrower: missing sandbox only"],
  "react/dom-no-render": ["react/no-deprecated", "covers ReactDOM.render among others"],
  "react/dom-no-hydrate": ["react/no-deprecated", ""],
  "react/jsx-no-children-prop": ["react/no-children-prop", ""],
  "react/jsx-no-children-prop-with-children": ["react/no-children-prop", "approximate"],
  "react/jsx-no-namespace": ["react/no-namespace", ""],
  "react/no-set-state-in-component-did-mount": ["react/no-did-mount-set-state", ""],
  "react/no-set-state-in-component-did-update": ["react/no-did-update-set-state", ""],
  "react/no-set-state-in-component-will-update": ["react/no-will-update-set-state", ""],
  "react/no-unsafe-component-will-mount": ["react/no-unsafe", ""],
  "react/no-unsafe-component-will-receive-props": ["react/no-unsafe", ""],
  "react/no-unsafe-component-will-update": ["react/no-unsafe", ""],
  "react/no-component-will-mount": ["react/no-deprecated", ""],
  "react/no-component-will-receive-props": ["react/no-deprecated", ""],
  "react/no-component-will-update": ["react/no-deprecated", ""],
  "react/no-nested-component-definitions": ["react/no-unstable-nested-components", "also react/static-components (React Compiler)"],
  "react/no-unused-class-component-members": ["react/no-unused-class-component-methods", ""],
  "react/use-state": ["react/hook-use-state", "approximate"],
  "react/no-children-count": ["react/no-react-children", "one rule for all Children.* calls"],
  "react/no-children-for-each": ["react/no-react-children", ""],
  "react/no-children-map": ["react/no-react-children", ""],
  "react/no-children-only": ["react/no-react-children", ""],
  "react/no-children-to-array": ["react/no-react-children", ""],
};
const why: Record<string, string> = {
  regexp: "eslint-plugin-regexp: no native equivalent; loads in bun lint as a JS plugin without the eslint package",
  jsonc: "JSON files: Bun hands them to the eslint package; bun fmt sortPackageJson covers package.json key order only",
  markdown: "Markdown is an ESLint language: needs the eslint package; Bun has no native Markdown rules",
  jsdoc: "eslint-plugin-jsdoc: JS plugin, and it needs the eslint package to load",
  perfectionist: "JS plugin needing the eslint package; bun fmt sortImports sorts imports (not exports) in its own order",
  antfu: "eslint-plugin-antfu: JS plugin, loads without eslint",
  e18e: "@e18e/eslint-plugin: JS plugin, loads without eslint",
  style: "@stylistic: formatting rules; Bun runs no deprecated formatting rules",
  command: "eslint-plugin-command: comment-driven codemods",
  "eslint-comments": "@eslint-community/eslint-comments: JS plugin, loads without eslint",
  node: "eslint-plugin-n rule Bun has not ported (Bun ports 15 rules of n)",
  react: "@eslint-react rule with no eslint-plugin-react / React Compiler counterpart; @eslint-react needs the eslint package",
};
const out = ["rule\tseverity\tcategory\tbun_rule\tnote"];
const count: Record<string, number> = {};
const byPlugin: Record<string, Record<string, number>> = {};
for (const [rule, sev] of rows) {
  const plugin = rule.includes("/") ? rule.split("/")[0] : "(core)";
  const r = raw.get(rule)!;
  let c: C;
  if (diff[rule]) c = ["native-different", diff[rule][0], diff[rule][1]];
  else if (r[3] === "yes") {
    const bun = rule.startsWith("ts/") ? "@typescript-eslint/" + rule.slice(3) : rule.startsWith("node/") ? "n/" + rule.slice(5) : rule.startsWith("test/") ? (rule === "test/no-import-node-test" ? "vitest/no-import-node-test" : "bun:test/" + rule.slice(5)) : rule.startsWith("style/") ? "react/" + rule.slice(6) : r[2];
    if (plugin === "(core)" || plugin === "ts" || plugin === "node") c = ["native-same", bun, plugin === "(core)" ? "" : `antfu's prefix ${plugin}/ is ${bun.split("/")[0]}/ in bunfig and in eslint-disable comments`];
    else if (plugin === "import") c = ["native-different", bun, "Bun ports eslint-plugin-import 2.32; we run antfu's fork eslint-plugin-import-lite"];
    else if (plugin === "unicorn") c = ["native-different", bun, "Bun's unicorn rules are ports of oxlint's, used only from bunfig"];
    else if (plugin === "react" || plugin === "react-refresh") c = ["native-different", bun, "same name, different upstream: we run @eslint-react; Bun has eslint-plugin-react / React Compiler / oxlint rules"];
    else if (plugin === "test") c = ["native-different", bun, "we run @vitest/eslint-plugin, which does not recognise bun:test imports; Bun's bun:test rules do"];
    else c = ["native-different", bun, ""];
  } else c = ["missing", "", why[plugin] ?? ""];
  if (rule === "@typescript-eslint/no-namespace" || rule === "ts/no-namespace") c[2] = (c[2] ? c[2] + "; " : "") + "Bun's default allowDeclarations = true differs from typescript-eslint: set it to false";
  count[c[0]] = (count[c[0]] ?? 0) + 1;
  (byPlugin[plugin] ??= {})[c[0]] = (byPlugin[plugin][c[0]] ?? 0) + 1;
  out.push([rule, sev, ...c].join("\t"));
}
await Bun.write(process.argv[4], out.join("\n") + "\n");
console.log(rows.length, count);
for (const [p, m] of Object.entries(byPlugin).sort()) console.log(p.padEnd(16), JSON.stringify(m));
