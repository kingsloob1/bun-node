// For each enabled ESLint rule, find a native bun lint rule by name (via --explain), recording its header.
const rows = (await Bun.file(process.argv[2]).text()).trim().split("\n").slice(1).map(l => l.split("\t"));
const cands = (r: string): string[] => {
  const [p, ...rest] = r.split("/"); const n = rest.join("/");
  if (!n) return [r, `eslint/${r}`];
  switch (p) {
    case "ts": return [`@typescript-eslint/${n}`];
    case "node": return [`n/${n}`, `node/${n}`];
    case "import": return [`import/${n}`];
    case "unicorn": return [`unicorn/${n}`];
    case "react": return [`react/${n}`, `react-hooks/${n}`, `@eslint-react/${n}`];
    case "react-refresh": return [`react-refresh/${n}`, `react/${n}`];
    case "test": return [`vitest/${n}`, `jest/${n}`, `bun:test/${n}`];
    case "style": return [`@stylistic/${n}`, `eslint/${n}`, n];
    case "regexp": return [`regexp/${n}`];
    case "jsdoc": return [`jsdoc/${n}`];
    case "prettier": return [r];
    default: return [r];
  }
};
const out = ["rule\tseverity\tcandidate\tnative\theader"];
for (const [rule, sev] of rows) {
  let found = "", header = "";
  for (const c of cands(rule)) {
    const p = Bun.spawnSync(["bun", "lint", `--explain=${c}`], { env: { ...process.env, NO_COLOR: "1" } });
    const t = p.stdout.toString();
    if (p.exitCode === 0 && t.trim()) {
      const lines = t.split("\n");
      found = c;
      header = (lines[0] + " | " + lines.slice(3, 7).join(" ").replace(/\s+/g, " ")).slice(0, 260);
      break;
    }
  }
  out.push([rule, sev, found || cands(rule)[0], found ? "yes" : "no", header].join("\t"));
}
await Bun.write(process.argv[3], out.join("\n") + "\n");
console.log(out.filter(l => l.includes("\tyes\t")).length, "native of", rows.length);
