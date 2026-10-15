import { Glob } from "bun";
const root = process.argv[2];
const globs = ["packages/bun-nest/**/*.ts","packages/bun-jobs/lib/**/*.ts","packages/bun-jobs-ui/**/*.ts","packages/bun-jobs-ui/**/*.tsx","examples/bun-nest/**/*.ts","playground/**/*.ts","packages/bun-jobs/__tests__/**/*.ts","examples/**/*.ts"];
const names = new Map<string, Set<string>>();
const seen = new Set<string>();
for (const g of globs) for await (const f of new Glob(g).scan({ cwd: root })) {
  if (f.includes("node_modules") || f.includes("/dts/") || seen.has(f)) continue; seen.add(f);
  const src = await Bun.file(`${root}/${f}`).text();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](@nestjs\/[^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    for (let n of m[1].split(",")) { n = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim(); if (!n) continue;
      const k = `${m[2]}::${n}`; if (!names.has(k)) names.set(k, new Set()); names.get(k)!.add(f); }
  }
}
for (const [k, fs] of [...names].sort()) console.log(`${k}\t${fs.size}\t${[...fs][0]}`);
