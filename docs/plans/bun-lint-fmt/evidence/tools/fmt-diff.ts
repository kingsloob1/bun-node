// Differential: Prettier 3.8.4 (today, our options) vs Prettier 3.9.10 vs bun fmt, per file.
// usage: bun fmt-diff.ts <repoRoot> <outDir> <fileList>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const [root, outDir, listFile] = process.argv.slice(2);
const p38 = await import(join(import.meta.dir, "../p38/node_modules/prettier/index.mjs"));
const p39 = await import(join(import.meta.dir, "../p39/node_modules/prettier/index.mjs"));
const opts = { endOfLine: "lf", singleQuote: false, singleAttributePerLine: true, trailingComma: "all", tabWidth: 2, useTabs: false, bracketSpacing: true, semi: true } as const;
const files = readFileSync(listFile, "utf8").split("\n").filter(Boolean);
mkdirSync(outDir, { recursive: true });
const rows: string[] = ["file\tsrc==p38\tp38==p39\tbun==p39\tbun==p38\tbunErr"];
let n = 0;
const agg = { srcNotP38: 0, p38NotP39: 0, bunNotP39: 0, bunNotP38: 0, bunErr: 0, p39Err: 0 };
const diffsDir = join(outDir, "bun-vs-p39");
mkdirSync(diffsDir, { recursive: true });
for (const f of files) {
  const abs = join(root, f);
  const src = readFileSync(abs, "utf8");
  let o38 = "", o39 = "", ob = "", bunErr = "";
  try { o38 = await p38.format(src, { ...opts, filepath: abs }); } catch (e) { o38 = "ERR"; }
  try { o39 = await p39.format(src, { ...opts, filepath: abs }); } catch (e) { o39 = "ERR"; agg.p39Err++; }
  const p = Bun.spawnSync(["bun", "fmt", `--stdin-filepath=${f}`], { cwd: root, stdin: Buffer.from(src), env: { ...process.env, CI: "1" } });
  ob = p.stdout.toString();
  if (p.exitCode !== 0) { bunErr = p.stderr.toString().split("\n")[0]; agg.bunErr++; }
  const r = [src === o38, o38 === o39, ob === o39, ob === o38];
  if (!r[0]) agg.srcNotP38++;
  if (!r[1]) agg.p38NotP39++;
  if (!r[2]) { agg.bunNotP39++; writeFileSync(join(diffsDir, f.replaceAll("/", "__") + ".p39"), o39); writeFileSync(join(diffsDir, f.replaceAll("/", "__") + ".bun"), ob); }
  if (!r[3]) agg.bunNotP38++;
  rows.push([f, ...r.map(String), bunErr].join("\t"));
  n++;
}
writeFileSync(join(outDir, "per-file.tsv"), rows.join("\n") + "\n");
console.log(JSON.stringify({ files: n, ...agg }));
