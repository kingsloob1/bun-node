// The SQL primitives a cache driver needs, on each engine through Bun's SQL:
// (1) a bytes column round-trip (bun-jobs' dialects have none), 1 MiB;
// (2) atomic increment returning the new value, under 200 concurrent calls;
// (3) an expired-row sweep by indexed expires_at.
// Creates one table per engine named cacheplan_<pid> and drops exactly it.
// Run: BUN_JOBS_TEST_POSTGRES_URL=… BUN_JOBS_TEST_MYSQL_URL=… BUN_JOBS_TEST_MARIADB_URL=… bun sql-primitives.ts
import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)})`);
const t = `cacheplan_${process.pid}`;
const sqliteDir = mkdtempSync(join(process.env.SPIKE_DIR ?? tmpdir(), "cacheplan-"));
type Engine = { name: string; make: () => SQL; bytes: string; key: string };
const myOpts = (url: string) => { const u = new URL(url); const pk = u.searchParams.get("allowPublicKeyRetrieval") === "true"; u.searchParams.delete("allowPublicKeyRetrieval"); return { url: u.toString(), allowPublicKeyRetrieval: pk } as never; };
const engines: Engine[] = [
  { name: "sqlite", make: () => new SQL({ adapter: "sqlite", filename: join(sqliteDir, "c.db") }), bytes: "BLOB", key: "TEXT" },
];
if (process.env.BUN_JOBS_TEST_POSTGRES_URL) engines.push({ name: "postgres", make: () => new SQL(process.env.BUN_JOBS_TEST_POSTGRES_URL!), bytes: "BYTEA", key: "TEXT" });
if (process.env.BUN_JOBS_TEST_MYSQL_URL) engines.push({ name: "mysql", make: () => new SQL(myOpts(process.env.BUN_JOBS_TEST_MYSQL_URL!)), bytes: "LONGBLOB", key: "VARCHAR(255)" });
if (process.env.BUN_JOBS_TEST_MARIADB_URL) engines.push({ name: "mariadb", make: () => new SQL(myOpts(process.env.BUN_JOBS_TEST_MARIADB_URL!)), bytes: "LONGBLOB", key: "VARCHAR(255)" });

for (const e of engines) {
  const sql = e.make();
  try {
    await sql.unsafe(`CREATE TABLE ${t} (k ${e.key} PRIMARY KEY, v ${e.bytes}, n BIGINT, exp BIGINT)`);
    await sql.unsafe(`CREATE INDEX ix_${t}_exp ON ${t} (exp)`);
    // (1) bytes
    const blob = new Uint8Array(1 << 20).map((_, i) => (i * 31) & 255);
    await sql`INSERT INTO ${sql(t)} (k, v, exp) VALUES ('b', ${blob}, ${Date.now() + 1000})`;
    const [row] = await sql`SELECT v FROM ${sql(t)} WHERE k = 'b'`;
    const back = row.v as Uint8Array;
    const same = back.length === blob.length && Bun.deepEquals(new Uint8Array(back), blob);
    console.log(`${e.name}: 1 MiB bytes column round-trip ${same ? "equal" : "DIFFERENT"}, read back as ${back?.constructor?.name}`);
    // (2) atomic increment, 200 concurrent
    const N = 200;
    let returned: number[] = [];
    const t0 = performance.now();
    if (e.name === "mysql" || e.name === "mariadb") {
      // ON DUPLICATE KEY + LAST_INSERT_ID(expr) on a reserved connection: the new value comes back without a second race
      returned = await Promise.all(Array.from({ length: N }, async () => {
        const c = await sql.reserve();
        try {
          await c.unsafe(`INSERT INTO ${t} (k, n) VALUES ('ctr', LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE n = LAST_INSERT_ID(n + 1)`);
          const [r] = await c.unsafe(`SELECT LAST_INSERT_ID() AS n`);
          return Number(r.n);
        } finally { c.release(); }
      }));
    } else {
      returned = await Promise.all(Array.from({ length: N }, async () => {
        const [r] = await sql.unsafe(`INSERT INTO ${t} (k, n) VALUES ('ctr', 1) ON CONFLICT (k) DO UPDATE SET n = ${t}.n + 1 RETURNING n`);
        return Number(r.n);
      }));
    }
    const ms = performance.now() - t0;
    const [fin] = await sql.unsafe(`SELECT n FROM ${t} WHERE k = 'ctr'`);
    const unique = new Set(returned).size;
    console.log(`${e.name}: ${N} concurrent increments -> final ${fin.n}, ${unique} distinct returned values (want ${N}), ${ms.toFixed(1)} ms`);
    // (3) sweep
    const now = Date.now();
    const vals = Array.from({ length: 2000 }, (_, i) => ({ k: `s${i}`, exp: i % 2 ? now - 1000 : now + 60_000 }));
    await sql`INSERT INTO ${sql(t)} ${sql(vals, "k", "exp")}`;
    const t1 = performance.now();
    const res = await sql.unsafe(`DELETE FROM ${t} WHERE exp IS NOT NULL AND exp < ${now}`);
    const ms3 = performance.now() - t1;
    const [left] = await sql.unsafe(`SELECT COUNT(*) AS c FROM ${t} WHERE k LIKE 's%'`);
    console.log(`${e.name}: sweep of 2000 rows (half expired) in ${ms3.toFixed(1)} ms: result.count=${res.count}, result.affectedRows=${(res as { affectedRows?: number }).affectedRows}, rows left ${left.c}`);
  } catch (err) {
    console.log(`${e.name}: ERROR ${(err as Error).message}`);
  } finally {
    await sql.unsafe(`DROP TABLE IF EXISTS ${t}`).catch(() => {});
    await sql.close();
  }
}
rmSync(sqliteDir, { recursive: true, force: true });
