/**
 * The negative controls of channel-prototype.test.ts. Each test's name starts
 * with `[mutation]`; for each mutation this runs the file with
 * `CHANNEL_MUTATE=<mutation>` and requires every test tagged with it to
 * fail. The base run (no mutation, file order and two `--randomize` seeds)
 * must pass entirely.
 *
 *   bun docs/plans/bun-native-routes/evidence/sse/channel-controls.ts
 */
import { join } from "node:path";

const file = join(import.meta.dir, "channel-prototype.test.ts");
const root = join(import.meta.dir, "../../../../..");
const tags = [...new Set([...(await Bun.file(file).text()).matchAll(/it\(`?"?\[([a-z-]+)\]/g)].map((m) => m[1]))];

function run(env: Record<string, string>, extra: string[] = []): { pass: number; fail: number; failed: string[] } {
  const p = Bun.spawnSync(["bun", "test", ...extra, file], { cwd: root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString() + p.stderr.toString();
  const num = (w: string) => Number(new RegExp(`^\\s*(\\d+) ${w}$`, "m").exec(out)?.[1] ?? Number.NaN);
  const failed = [...out.matchAll(/^\(fail\) channel > (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => m[1]);
  return { pass: num("pass"), fail: num("fail"), failed };
}

let bad = 0;
for (const extra of [[], ["--randomize", "--seed=1"], ["--randomize", "--seed=2"]]) {
  const r = run({}, extra);
  const ok = r.fail === 0 && r.pass > 0;
  if (!ok) bad++;
  console.log(`base ${extra.join(" ") || "(file order)"}`.padEnd(40), `${r.pass} pass, ${r.fail} fail`, ok ? "OK" : `BAD ${r.failed.join("; ")}`);
}
for (const tag of tags) {
  const r = run({ CHANNEL_MUTATE: tag });
  const tagged = r.failed.filter((f) => f.startsWith(`[${tag}]`)).length;
  const expected = (await Bun.file(file).text()).split(`[${tag}]`).length - 1;
  const ok = tagged >= expected && expected > 0; // a tag inside a loop names several tests
  if (!ok) bad++;
  console.log(`CHANNEL_MUTATE=${tag}`.padEnd(40), `${r.pass} pass, ${r.fail} fail; tagged tests failing ${tagged}/${expected}`, ok ? "OK" : "BAD (the control did not bite)");
  for (const f of r.failed) console.log(`    fails: ${f}`);
}
console.log(bad ? `\n${bad} control(s) BAD` : "\nevery control bites; the base passes");
process.exit(bad ? 1 : 0);
