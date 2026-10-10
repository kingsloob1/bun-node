// A file-backed cache's basic costs: atomic set (write a temp file, rename it
// into place) and get (read + parse a header), flat directory against a
// two-level hash-sharded one, and a sweep that stats every entry.
// Run: bun file-store.ts   (temp dir under ~/.cache/bun-node-e6/cacheplan, removed after)
import { mkdirSync, renameSync, rmSync, readdirSync } from "node:fs";
import { rename, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)})`);
const root = join(process.env.SPIKE_DIR ?? `${process.env.HOME}/.cache/bun-node-e6/cacheplan`, `files-${process.pid}`);
const N = Number(process.env.N ?? 10000);
const value = new Uint8Array(1024).fill(65);
const hex = (k: string) => Bun.hash.wyhash(k).toString(16).padStart(16, "0");
const header = (exp: number) => new TextEncoder().encode(`BC1 ${exp}\n`);

for (const layout of ["flat", "sharded 2x256"] as const) {
  const dir = join(root, layout.replace(/\W/g, ""));
  mkdirSync(dir, { recursive: true });
  const pathOf = (k: string) => { const h = hex(k); return layout === "flat" ? join(dir, h) : join(dir, h.slice(0, 2), h.slice(2, 4), h); };
  const made = new Set<string>();
  let t = performance.now();
  for (let i = 0; i < N; i++) {
    const p = pathOf(`key:${i}`);
    const d = p.slice(0, p.lastIndexOf("/"));
    if (!made.has(d)) { await mkdir(d, { recursive: true }); made.add(d); }
    const tmp = `${p}.${process.pid}.${i}.tmp`;
    await Bun.write(tmp, Buffer.concat([header(Date.now() + 60_000), value]));
    await rename(tmp, p);
  }
  const setRate = N / ((performance.now() - t) / 1000);
  t = performance.now();
  for (let i = 0; i < N; i++) {
    const b = await Bun.file(pathOf(`key:${i}`)).bytes();
    const nl = b.indexOf(10); const exp = Number(new TextDecoder().decode(b.subarray(4, nl)));
    if (exp < Date.now()) throw new Error("expired");
  }
  const getRate = N / ((performance.now() - t) / 1000);
  t = performance.now();
  let miss = 0;
  for (let i = 0; i < N; i++) if (!(await Bun.file(pathOf(`none:${i}`)).exists())) miss++;
  const missRate = N / ((performance.now() - t) / 1000);
  t = performance.now();
  let seen = 0;
  const walk = async (d: string): Promise<void> => { for (const e of await readdir(d, { withFileTypes: true })) { if (e.isDirectory()) await walk(join(d, e.name)); else { seen++; } } };
  await walk(dir);
  const sweepMs = performance.now() - t;
  console.log(`${layout.padEnd(14)} N=${N} 1 KiB: set (tmp+rename) ${Math.round(setRate)}/s, get ${Math.round(getRate)}/s, miss ${Math.round(missRate)}/s, directory walk of ${seen} entries ${sweepMs.toFixed(0)} ms (${made.size} dirs)`);
}
rmSync(root, { recursive: true, force: true });
console.log(`load average at end: ${(await Bun.file("/proc/loadavg").text()).trim()}`);
