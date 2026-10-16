import { join } from "node:path";
const p39 = await import(join(import.meta.dir, "../p39/node_modules/prettier/index.mjs"));
const opts = { singleAttributePerLine: true, filepath: "" } as any;
for (const f of process.argv.slice(3)) {
  const src = await Bun.$`git -C ${process.argv[2]} show HEAD:${f}`.text();
  const a = await p39.format(src, { ...opts, filepath: f });
  const b = await p39.format(a, { ...opts, filepath: f });
  const run = (s: string) => Bun.spawnSync(["bun", "fmt", `--stdin-filepath=${f}`], { cwd: process.argv[2], stdin: Buffer.from(s) }).stdout.toString();
  const ba = run(src), bb = run(ba);
  console.log(f, { p39_idempotent: a === b, bun_idempotent: ba === bb, bun1_eq_p39_1: ba === a, bun2_eq_p39_2: bb === b });
}
