// D1 probe: the REST API's /query shape, served by proxy.worker.js over a real
// D1 binding in workerd (miniflare). Params are strings only (the documented
// schema). Run: bun probe-d1.ts
import { Miniflare } from "miniflare";

const SEQ = process.env.MODE_SEQUENTIAL === "1";
const mf = new Miniflare({
  modules: true,
  scriptPath: new URL("./proxy.worker.js", import.meta.url).pathname,
  compatibilityDate: "2026-07-01",
  d1Databases: { DB: "db-1" },
  kvNamespaces: { KV: "kv-1" },
  bindings: { TOKEN: "t", MODE_SEQUENTIAL: SEQ ? "1" : "0" },
  port: 0,
});
const base = await mf.ready;
const endpoint = new URL("/client/v4/accounts/acct/d1/database/db-1/query", base);

type Q = { sql: string; params?: string[] };
type R = { results: Record<string, unknown>[]; meta: { changes: number; rows_read: number; rows_written: number } };
async function query(batch: Q[]): Promise<R[]> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(batch.length === 1 ? batch[0] : { batch }),
  });
  const body = (await res.json()) as { success: boolean; errors: { message: string }[]; result: R[] };
  if (!body.success) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.result;
}
const one = async (sql: string, ...params: string[]) => (await query([{ sql, params }]))[0]!;
const tryq = async (label: string, f: () => Promise<unknown>) => {
  try { console.log(label, "->", JSON.stringify(await f())); } catch (e) { console.log(label, "-> ERROR", (e as Error).message); }
};
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)]!.toFixed(2);

console.log(`# D1 probe (${SEQ ? "proxy runs batch items one by one, like miniflare's explorer" : "proxy runs batch via DB.batch()"})`);

// ---- 1. What D1's SQLite accepts --------------------------------------------
console.log("\n## 1. SQL surface");
await tryq("BEGIN TRANSACTION", () => one("BEGIN TRANSACTION"));
await tryq("SAVEPOINT", () => one("SAVEPOINT a"));
await tryq("two statements in one sql string", () => one("SELECT 1 AS a; SELECT 2 AS b"));
await tryq("total_changes()", () => one("SELECT total_changes() AS t"));
await tryq("unhex/hex", () => one("SELECT hex(unhex(?1)) AS h, typeof(unhex(?1)) AS t", "00FF41"));
await tryq("blob as JSON", () => one("SELECT unhex('00ff41') AS b"));
await tryq("json_each over a param", () => one("SELECT value FROM json_each(?1)", '["a","b"]'));
await tryq("string param vs integer column", async () => {
  await one("CREATE TABLE IF NOT EXISTS aff (n INTEGER)");
  await one("INSERT INTO aff VALUES (?1)", "1700000000000");
  return (await one("SELECT typeof(n) AS t, n > ?1 AS gt, n + ?2 AS sum FROM aff", "999", "-5")).results;
});
await tryq("NULLIF('', '') for a null", () => one("SELECT NULLIF(?1, '') IS NULL AS isnull", ""));

// ---- 2. Schema: the SQLite driver's tables, plus triggers ---------------------
console.log("\n## 2. Schema with triggers (tag rows follow entries.tg; a stamp deletes its tag's entries)");
const DDL = [
  "CREATE TABLE e (ns TEXT NOT NULL, k TEXT NOT NULL, v BLOB, n INTEGER, exp INTEGER, tg TEXT, ca INTEGER, PRIMARY KEY (ns, k)) WITHOUT ROWID",
  "CREATE INDEX ix_e_exp ON e (exp) WHERE exp IS NOT NULL",
  "CREATE TABLE t (ns TEXT NOT NULL, tag TEXT NOT NULL, k TEXT NOT NULL, PRIMARY KEY (ns, tag, k)) WITHOUT ROWID",
  "CREATE INDEX ix_t_key ON t (ns, k)",
  "CREATE TABLE s (ns TEXT NOT NULL, tag TEXT NOT NULL, at INTEGER NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (ns, tag)) WITHOUT ROWID",
  "CREATE TABLE l (ns TEXT NOT NULL, k TEXT NOT NULL, owner TEXT NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (ns, k)) WITHOUT ROWID",
  "CREATE TRIGGER e_ai AFTER INSERT ON e WHEN NEW.tg IS NOT NULL BEGIN INSERT OR IGNORE INTO t (ns, tag, k) SELECT NEW.ns, value, NEW.k FROM json_each(NEW.tg); END",
  "CREATE TRIGGER e_au AFTER UPDATE OF tg ON e BEGIN DELETE FROM t WHERE ns = OLD.ns AND k = OLD.k; INSERT OR IGNORE INTO t (ns, tag, k) SELECT NEW.ns, value, NEW.k FROM json_each(COALESCE(NEW.tg, '[]')); END",
  "CREATE TRIGGER e_ad AFTER DELETE ON e WHEN OLD.tg IS NOT NULL BEGIN DELETE FROM t WHERE ns = OLD.ns AND k = OLD.k; END",
  "CREATE TRIGGER s_ai AFTER INSERT ON s BEGIN DELETE FROM e WHERE ns = NEW.ns AND k IN (SELECT k FROM t WHERE ns = NEW.ns AND tag = NEW.tag); END",
  "CREATE TRIGGER s_au AFTER UPDATE ON s BEGIN DELETE FROM e WHERE ns = NEW.ns AND k IN (SELECT k FROM t WHERE ns = NEW.ns AND tag = NEW.tag); END",
];
await tryq("DDL as one batch", () => query(DDL.map((sql) => ({ sql }))).then((r) => r.length));

// One statement each. ?-numbering as in lib/drivers/sqlite.ts.
const SET_FENCED =
  "INSERT INTO e (ns, k, v, n, exp, tg, ca) SELECT ?1, ?2, unhex(?3), NULL, NULLIF(?4, ''), ?5, ?6 " +
  "WHERE NOT EXISTS (SELECT 1 FROM s WHERE ns = ?1 AND tag IN (SELECT value FROM json_each(?5)) AND exp > ?6 AND at >= ?7) " +
  "ON CONFLICT (ns, k) DO UPDATE SET v = excluded.v, n = NULL, exp = excluded.exp, tg = excluded.tg, ca = excluded.ca RETURNING 1 AS stored";
const GET = "SELECT hex(v) AS v, exp, tg FROM e WHERE ns = ?1 AND k = ?2 AND n IS NULL AND (exp IS NULL OR exp > ?3)";
const STAMPS =
  "INSERT INTO s (ns, tag, at, exp) SELECT ?1, value, ?2, ?3 FROM json_each(?4) WHERE true " +
  "ON CONFLICT (ns, tag) DO UPDATE SET at = MAX(at, excluded.at), exp = MAX(exp, excluded.exp)";
const live = "e.n IS NOT NULL AND (e.exp IS NULL OR e.exp > ?5)";
const INCR =
  `INSERT INTO e (ns, k, v, n, exp, tg, ca) VALUES (?1, ?2, NULL, ?3, NULLIF(?4, ''), NULL, ?5) ON CONFLICT (ns, k) DO UPDATE SET ` +
  `n = CASE WHEN ${live} THEN e.n + excluded.n ELSE excluded.n END, exp = CASE WHEN ${live} THEN e.exp ELSE excluded.exp END, ` +
  `ca = CASE WHEN ${live} THEN e.ca ELSE excluded.ca END, v = NULL, tg = NULL RETURNING n`;
const LOCK =
  "INSERT INTO l (ns, k, owner, exp) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (ns, k) DO UPDATE SET owner = excluded.owner, exp = excluded.exp " +
  "WHERE l.exp <= ?5 OR l.owner = excluded.owner RETURNING owner";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const set = async (ns: string, k: string, v: Uint8Array, tags: string[], createdAt: number, exp: number | null = null) =>
  (await one(SET_FENCED, ns, k, hex(v), exp === null ? "" : String(exp), JSON.stringify(tags), String(Date.now()), String(createdAt))).results.length === 1;
const get = async (ns: string, k: string) => {
  const row = (await one(GET, ns, k, String(Date.now()))).results[0] as { v: string; exp: number | null; tg: string } | undefined;
  return row === undefined ? undefined : { v: new Uint8Array(Buffer.from(row.v, "hex")), exp: row.exp, tg: row.tg };
};
const invalidate = async (ns: string, tags: string[], at: number) =>
  (await one(STAMPS, ns, String(at), String(at + 86_400_000), JSON.stringify(tags))).meta;

// ---- 3. Round trips --------------------------------------------------------
console.log("\n## 3. Entries");
const bytes = new Uint8Array(256).map((_, i) => i);
console.log("set (all 256 byte values) stored:", await set("n", "k1", bytes, ["a", "b"], Date.now()));
const back = await get("n", "k1");
console.log("byte-exact read back:", back !== undefined && Buffer.compare(back.v, bytes) === 0, "tg:", back?.tg);
console.log("tag rows via trigger:", JSON.stringify((await one("SELECT tag, k FROM t WHERE ns = 'n' ORDER BY tag")).results));
await set("n", "k1", bytes, ["c"], Date.now());
console.log("tag rows after re-tag:", JSON.stringify((await one("SELECT tag, k FROM t WHERE ns = 'n' ORDER BY tag")).results));
for (const size of [1 << 20, 1_999_000, 2_000_100]) {
  const big = crypto.getRandomValues(new Uint8Array(Math.min(size, 65536))).slice(0);
  const full = new Uint8Array(size); for (let i = 0; i < size; i += big.length) full.set(big.subarray(0, Math.min(big.length, size - i)), i);
  await tryq(`value of ${size} bytes`, async () => {
    const t0 = performance.now();
    await set("n", "big", full, [], Date.now());
    const r = await get("n", "big");
    return { equal: r !== undefined && Buffer.compare(r.v, full) === 0, ms: Math.round(performance.now() - t0) };
  });
}
await one("DELETE FROM e WHERE ns = 'n' AND k = 'big'");

// ---- 4. The fence ---------------------------------------------------------
console.log("\n## 4. The fence, one statement");
const c0 = Date.now();
await set("f", "x", bytes, ["org:7"], c0);
const inv = await invalidate("f", ["org:7"], c0 + 1);
console.log("invalidate meta.changes (stamp + trigger deletes?):", inv.changes, "rows_written:", inv.rows_written);
console.log("entry gone after the stamp (trigger delete):", (await get("f", "x")) === undefined,
  "tag rows left:", (await one("SELECT count(*) AS c FROM t WHERE ns = 'f'")).results[0]);
console.log("pre-invalidation load (createdAt before stamp) stored:", await set("f", "x", bytes, ["org:7"], c0));
console.log("post-invalidation load (createdAt after stamp) stored:", await set("f", "y", bytes, ["org:7"], c0 + 5));
console.log("untagged write unaffected:", await set("f", "z", bytes, [], c0));

// The race: a fenced write of a pre-invalidation load against the invalidation,
// started together. Survivors must be 0 for the one-statement design; the
// mutant (check, then write, in two requests) shows the test can fail.
async function race(rounds: number, mutant: boolean) {
  let survivors = 0;
  for (let r = 0; r < rounds; r++) {
    const ns = `race${mutant ? "m" : ""}${r}`;
    const createdAt = Date.now();
    const write = mutant
      ? (async () => {
        const hit = (await one("SELECT 1 FROM s WHERE ns = ?1 AND tag = 'g' AND at >= ?2", ns, String(createdAt))).results.length;
        await Bun.sleep(r % 3);
        if (hit === 0) await one("INSERT OR REPLACE INTO e (ns, k, v, tg, ca) VALUES (?1, 'k', x'00', '[\"g\"]', ?2)", ns, String(createdAt));
      })()
      : set(ns, "k", bytes, ["g"], createdAt);
    const invalidation = (async () => { await Bun.sleep(r % 2); await invalidate(ns, ["g"], createdAt + 1); })();
    await Promise.all([write, invalidation]);
    if ((await one("SELECT 1 FROM e WHERE ns = ?1 AND k = 'k'", ns)).results.length) survivors++;
  }
  return survivors;
}
console.log("race, one statement + trigger, survivors of 60:", await race(60, false));
console.log("race, mutant check-then-write, survivors of 60:", await race(60, true));

// ---- 5. Counters and locks -----------------------------------------------
console.log("\n## 5. Counters and locks");
{
  const now = String(Date.now());
  const t0 = performance.now();
  const outs = await Promise.all(Array.from({ length: 200 }, () => one(INCR, "c", "hits", "1", "", now)));
  const values = outs.map((o) => Number((o.results[0] as { n: number }).n)).sort((a, b) => a - b);
  console.log("200 concurrent increments: final", values.at(-1), "distinct returns", new Set(values).size,
    "ms", Math.round(performance.now() - t0));
  console.log("increment by -3 (string '-3'):", (await one(INCR, "c", "hits", "-3", "", now)).results[0]);
}
{
  const now = Date.now();
  const winners = (await Promise.all(Array.from({ length: 50 }, (_, i) =>
    one(LOCK, "l", "key", `owner-${i}`, String(now + 10_000), String(now))))).filter((r) => r.results.length === 1);
  console.log("50 contenders on a free lock, winners:", winners.length);
  const takeover = await one(LOCK, "l", "key", "late", String(now + 20_000), String(now + 15_000));
  console.log("takeover after expiry wins:", takeover.results.length === 1);
}

// ---- 6. Batch atomicity --------------------------------------------------
console.log("\n## 6. Is a batch one transaction?");
await one("CREATE TABLE IF NOT EXISTS atom (id INTEGER PRIMARY KEY)");
await tryq("batch [insert 1, insert into a missing table]", () =>
  query([{ sql: "INSERT INTO atom VALUES (1)" }, { sql: "INSERT INTO missing VALUES (1)" }]));
console.log("row 1 after the failed batch:", (await one("SELECT count(*) AS c FROM atom WHERE id = 1")).results[0]);
await tryq("batch [insert 2, insert 2 again (constraint)]", () =>
  query([{ sql: "INSERT INTO atom VALUES (2)" }, { sql: "INSERT INTO atom VALUES (2)" }]));
console.log("row 2 after the failed batch:", (await one("SELECT count(*) AS c FROM atom WHERE id = 2")).results[0]);

// ---- 7. Latency ------------------------------------------------------------
console.log("\n## 7. Round trip through the proxy (local workerd)");
{
  const ms: number[] = [];
  for (let i = 0; i < 200; i++) { const t = performance.now(); await get("n", "k1"); ms.push(performance.now() - t); }
  console.log(`get p50 ${pct(ms, 0.5)} ms, p99 ${pct(ms, 0.99)} ms (n=200)`);
  const ws: number[] = [];
  for (let i = 0; i < 200; i++) { const t = performance.now(); await set("n", `w${i}`, bytes, ["a"], Date.now()); ws.push(performance.now() - t); }
  console.log(`fenced set p50 ${pct(ws, 0.5)} ms, p99 ${pct(ws, 0.99)} ms (n=200)`);
}

await mf.dispose();
