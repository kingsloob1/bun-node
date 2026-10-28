// D1 probe: the largest value that passes as a hex string param and reads back
// as hex(v); and the two-halves form. Run: bun probe-d1-size.ts
import { Miniflare } from "miniflare";
const mf = new Miniflare({ modules: true, scriptPath: new URL("./proxy.worker.js", import.meta.url).pathname,
  compatibilityDate: "2026-07-01", d1Databases: { DB: "db-1" }, kvNamespaces: { KV: "kv-1" }, bindings: { TOKEN: "t" }, port: 0 });
const endpoint = new URL("/client/v4/accounts/acct/d1/database/db-1/query", await mf.ready);
async function one(sql: string, ...params: string[]) {
  const res = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ sql, params }) });
  const body = await res.json() as any; if (!body.success) throw new Error(body.errors[0].message); return body.result[0];
}
await one("CREATE TABLE b (k TEXT PRIMARY KEY, v BLOB)");
for (const n of [999_999, 1_000_000, 1_000_001]) {
  try { await one("INSERT OR REPLACE INTO b VALUES ('x', unhex(?1))", Buffer.alloc(n, 7).toString("hex"));
    const r = await one("SELECT length(v) AS len, length(hex(v)) AS hl FROM b WHERE k = 'x'"); console.log(n, "hex param ok", JSON.stringify(r.results[0]));
    try { const g = await one("SELECT hex(v) AS v FROM b WHERE k = 'x'"); console.log(n, "hex(v) read ok", g.results[0].v.length / 2); } catch (e) { console.log(n, "hex(v) read ERROR", (e as Error).message); }
  } catch (e) { console.log(n, "hex param ERROR", (e as Error).message); }
}
// Two halves: write unhex(?1) || unhex(?2), read hex(substr(..)) twice.
for (const n of [1_999_999, 2_000_000, 2_000_001]) {
  const h = Buffer.alloc(n, 9).toString("hex"); const mid = Math.floor(n / 2) * 2;
  try { await one("INSERT OR REPLACE INTO b VALUES ('y', unhex(?1) || unhex(?2))", h.slice(0, mid), h.slice(mid));
    const g = await one("SELECT hex(substr(v, 1, ?1)) AS a, hex(substr(v, ?1 + 1)) AS b, length(v) AS len FROM b WHERE k = 'y'", String(mid / 2));
    console.log(n, "two halves ok, len", g.results[0].len, "read bytes", (g.results[0].a.length + g.results[0].b.length) / 2);
  } catch (e) { console.log(n, "two halves ERROR", (e as Error).message); }
}
console.log("NULLIF('', '') is null:", JSON.stringify((await one("SELECT NULLIF(?1, '') IS NULL AS n", "")).results[0]));
await mf.dispose();
