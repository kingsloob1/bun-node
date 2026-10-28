// D1 probe: a stamp UPSERT that takes the DO UPDATE path fires the UPDATE trigger
// (the second invalidation of a tag still deletes its entries).
import { Miniflare } from "miniflare";
const mf = new Miniflare({ modules: true, scriptPath: new URL("./proxy.worker.js", import.meta.url).pathname,
  compatibilityDate: "2026-07-01", d1Databases: { DB: "db-1" }, kvNamespaces: { KV: "kv-1" }, bindings: { TOKEN: "t" }, port: 0 });
const endpoint = new URL("/client/v4/accounts/acct/d1/database/db-1/query", await mf.ready);
async function q(batch: { sql: string; params?: string[] }[]) {
  const res = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ batch }) });
  const body = await res.json() as any; if (!body.success) throw new Error(body.errors[0].message); return body.result;
}
await q([
  { sql: "CREATE TABLE e (ns TEXT, k TEXT, tg TEXT, PRIMARY KEY (ns, k)) WITHOUT ROWID" },
  { sql: "CREATE TABLE t (ns TEXT, tag TEXT, k TEXT, PRIMARY KEY (ns, tag, k)) WITHOUT ROWID" },
  { sql: "CREATE TABLE s (ns TEXT, tag TEXT, at INTEGER, PRIMARY KEY (ns, tag)) WITHOUT ROWID" },
  { sql: "CREATE TRIGGER e_ai AFTER INSERT ON e BEGIN INSERT OR IGNORE INTO t SELECT NEW.ns, value, NEW.k FROM json_each(NEW.tg); END" },
  { sql: "CREATE TRIGGER e_ad AFTER DELETE ON e BEGIN DELETE FROM t WHERE ns = OLD.ns AND k = OLD.k; END" },
  { sql: "CREATE TRIGGER s_ai AFTER INSERT ON s BEGIN DELETE FROM e WHERE ns = NEW.ns AND k IN (SELECT k FROM t WHERE ns = NEW.ns AND tag = NEW.tag); END" },
  { sql: "CREATE TRIGGER s_au AFTER UPDATE ON s BEGIN DELETE FROM e WHERE ns = NEW.ns AND k IN (SELECT k FROM t WHERE ns = NEW.ns AND tag = NEW.tag); END" },
]);
const STAMP = "INSERT INTO s (ns, tag, at) VALUES ('n', 'g', ?1) ON CONFLICT (ns, tag) DO UPDATE SET at = MAX(at, excluded.at)";
const COUNT = "SELECT count(*) AS c FROM e WHERE ns = 'n' AND k IN (SELECT k FROM t WHERE ns = 'n' AND tag = 'g')";
await q([{ sql: "INSERT INTO e VALUES ('n', 'a', '[\"g\"]')" }]);
let r = await q([{ sql: COUNT }, { sql: STAMP, params: ["1"] }]);
console.log("first invalidation (INSERT path): counted", r[0].results[0].c, "meta.changes", r[1].meta.changes, "left", (await q([{ sql: "SELECT count(*) AS c FROM e" }]))[0].results[0].c);
await q([{ sql: "INSERT INTO e VALUES ('n', 'b', '[\"g\"]')" }, { sql: "INSERT INTO e VALUES ('n', 'c', '[\"g\"]')" }]);
r = await q([{ sql: COUNT }, { sql: STAMP, params: ["2"] }]);
console.log("second invalidation (DO UPDATE path): counted", r[0].results[0].c, "meta.changes", r[1].meta.changes, "left", (await q([{ sql: "SELECT count(*) AS c FROM e" }]))[0].results[0].c);
await mf.dispose();
