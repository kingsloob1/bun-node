// SQLite set/get throughput in WAL mode: bun:sqlite (sync, prepared) against
// Bun's SQL with the sqlite adapter (async, what bun-jobs' SqlDriver uses),
// for a cache-shaped table. Median of 3 rounds per cell.
// Run: bun sqlite-wal.ts   (writes temp DBs under $TMPDIR or ~/.cache/bun-node-e6/cacheplan)
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.env.SPIKE_DIR ?? `${process.env.HOME}/.cache/bun-node-e6/cacheplan/sqlite-${process.pid}`);
mkdirSync(dir, { recursive: true });
const N = Number(process.env.N ?? 20000);
const median = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1]!;
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const out: string[] = [];
const row = (s: string) => { out.push(s); console.log(s); };

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), N=${N} ops per cell, median of 3`);
row(`| API | value | sync | set, one per statement | set, batched 500/tx | get (hit) | get (miss) |`);
row(`|---|---|---|---|---|---|---|`);

for (const size of [100, 10_000]) {
  const value = new Uint8Array(size).fill(7);
  for (const sync of ["NORMAL", "FULL"]) {
    const r: Record<string, number[]> = { one: [], batch: [], hit: [], miss: [] };
    for (let round = 0; round < 3; round++) {
      const file = join(dir, `s-${size}-${sync}-${round}.db`);
      const db = new Database(file, { create: true });
      db.run("PRAGMA journal_mode=WAL");
      db.run(`PRAGMA synchronous=${sync}`);
      db.run("PRAGMA busy_timeout=5000");
      db.run("CREATE TABLE c (k TEXT PRIMARY KEY, v BLOB NOT NULL, exp INTEGER) WITHOUT ROWID");
      db.run("CREATE INDEX ix_c_exp ON c (exp) WHERE exp IS NOT NULL");
      const put = db.prepare("INSERT INTO c (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp");
      const get = db.prepare("SELECT v, exp FROM c WHERE k = ?");
      let t = performance.now();
      for (let i = 0; i < N; i++) put.run(`k:${i}`, value, Date.now() + 60_000);
      r.one!.push(N / ((performance.now() - t) / 1000));
      const tx = db.transaction((from: number) => { for (let i = from; i < from + 500; i++) put.run(`b:${i}`, value, Date.now() + 60_000); });
      t = performance.now();
      for (let i = 0; i < N; i += 500) tx(i);
      r.batch!.push(N / ((performance.now() - t) / 1000));
      t = performance.now();
      for (let i = 0; i < N; i++) { const x = get.get(`k:${i}`) as { exp: number } | null; if (!x || x.exp < Date.now()) throw new Error("miss"); }
      r.hit!.push(N / ((performance.now() - t) / 1000));
      t = performance.now();
      for (let i = 0; i < N; i++) if (get.get(`none:${i}`)) throw new Error("hit");
      r.miss!.push(N / ((performance.now() - t) / 1000));
      db.close();
    }
    row(`| bun:sqlite | ${size} B | ${sync} | ${fmt(median(r.one!))}/s | ${fmt(median(r.batch!))}/s | ${fmt(median(r.hit!))}/s | ${fmt(median(r.miss!))}/s |`);
  }
  // Bun SQL, sqlite adapter (async)
  const r: Record<string, number[]> = { one: [], conc: [], hit: [], hitConc: [] };
  const M = Math.min(N, 5000);
  for (let round = 0; round < 3; round++) {
    const file = join(dir, `q-${size}-${round}.db`);
    const sql = new SQL({ adapter: "sqlite", filename: file });
    await sql`PRAGMA journal_mode=WAL`;
    await sql`PRAGMA synchronous=NORMAL`;
    await sql`CREATE TABLE c (k TEXT PRIMARY KEY, v BLOB NOT NULL, exp INTEGER) WITHOUT ROWID`;
    let t = performance.now();
    for (let i = 0; i < M; i++) await sql`INSERT INTO c (k, v, exp) VALUES (${`k:${i}`}, ${value}, ${Date.now() + 60_000}) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp`;
    r.one!.push(M / ((performance.now() - t) / 1000));
    t = performance.now();
    await Promise.all(Array.from({ length: M }, (_, i) => sql`INSERT INTO c (k, v, exp) VALUES (${`p:${i}`}, ${value}, ${Date.now() + 60_000}) ON CONFLICT(k) DO UPDATE SET v = excluded.v`));
    r.conc!.push(M / ((performance.now() - t) / 1000));
    t = performance.now();
    for (let i = 0; i < M; i++) { const [x] = await sql`SELECT v, exp FROM c WHERE k = ${`k:${i}`}`; if (!x) throw new Error("miss"); }
    r.hit!.push(M / ((performance.now() - t) / 1000));
    t = performance.now();
    await Promise.all(Array.from({ length: M }, (_, i) => sql`SELECT v FROM c WHERE k = ${`k:${i}`}`));
    r.hitConc!.push(M / ((performance.now() - t) / 1000));
    await sql.close();
  }
  row(`| Bun SQL sqlite (await each) | ${size} B | NORMAL | ${fmt(median(r.one!))}/s | — | ${fmt(median(r.hit!))}/s | — |`);
  row(`| Bun SQL sqlite (${M} concurrent) | ${size} B | NORMAL | ${fmt(median(r.conc!))}/s | — | ${fmt(median(r.hitConc!))}/s | — |`);
}
rmSync(dir, { recursive: true, force: true });
console.log(`load average at end: ${(await Bun.file("/proc/loadavg").text()).trim()}`);
