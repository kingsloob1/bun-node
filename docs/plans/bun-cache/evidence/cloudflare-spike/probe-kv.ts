// KV probe: the REST API's KV shapes, served by proxy.worker.js over a real KV
// binding in workerd (miniflare); and miniflare's own REST-shaped "local
// explorer" for comparison. Run: bun probe-kv.ts [--expiry] (waits ~65 s)
import { Miniflare } from "miniflare";

const mf = new Miniflare({
  modules: true,
  scriptPath: new URL("./proxy.worker.js", import.meta.url).pathname,
  compatibilityDate: "2026-07-01",
  kvNamespaces: { KV: "kv-1" },
  d1Databases: { DB: "db-1" },
  bindings: { TOKEN: "t" },
  unsafeLocalExplorer: true,
  port: 0,
});
const base = await mf.ready;
const ns = new URL("/client/v4/accounts/acct/storage/kv/namespaces/kv-1/", base);
const auth = { authorization: "Bearer t" };
const at = (path: string) => new URL(path, ns);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)]!.toFixed(2);
const put = async (key: string, body: BodyInit, query = "", headers: Record<string, string> = {}) => {
  const res = await fetch(at(`values/${encodeURIComponent(key)}${query}`), { method: "PUT", headers: { ...auth, ...headers }, body });
  return { status: res.status, body: await res.json() as { success: boolean; errors: { message: string }[] } };
};
const get = async (key: string) => {
  const res = await fetch(at(`values/${encodeURIComponent(key)}`), { headers: auth });
  return { status: res.status, expiration: res.headers.get("expiration"), bytes: new Uint8Array(await res.arrayBuffer()) };
};
const show = (label: string, r: { status: number; body: { success: boolean; errors: { message: string }[] } }) =>
  console.log(label, "->", r.status, r.body.success ? "ok" : r.body.errors[0]?.message);
const now = () => Math.floor(Date.now() / 1000);

console.log("# KV probe");
console.log("\n## 1. Writes the binding refuses (workerd's local KV)");
show("expiration_ttl=59", await put("ttl59", "x", "?expiration_ttl=59"));
show("expiration_ttl=60", await put("ttl60", "x", "?expiration_ttl=60"));
show("expiration = now+30 s", await put("abs30", "x", `?expiration=${now() + 30}`));
show("expiration = now+61 s", await put("abs61", "x", `?expiration=${now() + 61}`));
show("key of 512 bytes", await put("k".repeat(512), "x"));
show("key of 513 bytes", await put("k".repeat(513), "x"));
{
  const form = (m: string) => { const f = new FormData(); f.set("value", new Blob([new Uint8Array([1, 2])])); f.set("metadata", m); return f; };
  show("metadata of 1024 bytes JSON", await put("m1024", form(JSON.stringify({ a: "x".repeat(1016) }))));
  show("metadata of 1025 bytes JSON", await put("m1025", form(JSON.stringify({ a: "x".repeat(1017) }))));
}
show("value of 25 MiB", await put("v25", new Uint8Array(25 * 1024 * 1024)));
show("value of 25 MiB + 1", await put("v25p", new Uint8Array(25 * 1024 * 1024 + 1)));
{
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await put("hot", String(i))).status);
  console.log("5 writes to one key within ~10 ms, statuses:", statuses.join(","), "(Cloudflare: 1 write/s/key, else 429)");
}

console.log("\n## 2. Reads");
{
  const bytes = new Uint8Array(256).map((_, i) => i);
  await put("bin", bytes, `?expiration=${now() + 3600}`);
  const r = await get("bin");
  console.log("raw GET byte-exact:", Buffer.compare(r.bytes, bytes) === 0, "expiration header:", r.expiration);
  console.log("missing key status:", (await get("nope")).status);
  const bulk = await (await fetch(at("bulk/get"), { method: "POST", headers: auth, body: JSON.stringify({ keys: ["bin", "nope"], type: "text" }) })).json() as any;
  const text: string = bulk.result.values.bin;
  console.log("bulk/get of a binary value as text: length", text.length, "of 256; byte-exact after UTF-8 encode:",
    Buffer.compare(new TextEncoder().encode(text), bytes) === 0, "; missing ->", bulk.result.values.nope);
  const b64 = Buffer.from(bytes).toString("base64");
  await put("b64", b64);
  const bulk2 = await (await fetch(at("bulk/get"), { method: "POST", headers: auth, body: JSON.stringify({ keys: ["b64"], type: "text", withMetadata: true }) })).json() as any;
  console.log("bulk/get of a base64 text value, decoded byte-exact:", Buffer.compare(Buffer.from(bulk2.result.values.b64.value, "base64"), bytes) === 0);
  const tooMany = await fetch(at("bulk/get"), { method: "POST", headers: auth, body: JSON.stringify({ keys: Array.from({ length: 101 }, (_, i) => `k${i}`) }) });
  console.log("bulk/get of 101 keys:", tooMany.status);
}
{
  let fresh = 0;
  for (let i = 0; i < 100; i++) { await put("rw", String(i)); if (new TextDecoder().decode((await get("rw")).bytes) === String(i)) fresh++; await Bun.sleep(0); }
  console.log("write then read at once, fresh:", fresh, "of 100 (local KV is one store; Cloudflare's is eventually consistent, up to 60 s)");
}

console.log("\n## 3. List and bulk");
{
  const pairs = Array.from({ length: 1500 }, (_, i) => ({ key: `p/ns/e/${String(i).padStart(4, "0")}`, value: Buffer.from([i & 255]).toString("base64"), base64: true, expiration_ttl: 3600 }));
  const w = await (await fetch(at("bulk"), { method: "PUT", headers: auth, body: JSON.stringify(pairs) })).json() as any;
  console.log("bulk write of 1500 (base64, ttl 3600):", JSON.stringify(w.result));
  let cursor = ""; let pages = 0; let total = 0; let withExp = 0;
  do {
    const r = await (await fetch(at(`keys?prefix=${encodeURIComponent("p/ns/")}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`), { headers: auth })).json() as any;
    pages++; total += r.result.length; withExp += r.result.filter((k: any) => typeof k.expiration === "number").length; cursor = r.result_info.cursor;
  } while (cursor);
  console.log(`list by prefix: ${total} keys in ${pages} pages of <= 1000, ${withExp} with expiration`);
  const keys = pairs.map((p) => p.key);
  const d = await (await fetch(at("bulk/delete"), { method: "POST", headers: auth, body: JSON.stringify(keys) })).json() as any;
  console.log("bulk delete:", JSON.stringify(d.result));
}

console.log("\n## 4. Round trips through the proxy (local workerd)");
{
  const ms: number[] = []; const ws: number[] = [];
  const v = crypto.getRandomValues(new Uint8Array(1024));
  for (let i = 0; i < 200; i++) { const t = performance.now(); await put(`lat${i}`, v); ws.push(performance.now() - t); }
  for (let i = 0; i < 200; i++) { const t = performance.now(); await get(`lat${i}`); ms.push(performance.now() - t); }
  console.log(`put 1 KiB p50 ${pct(ws, 0.5)} ms p99 ${pct(ws, 0.99)}; get p50 ${pct(ms, 0.5)} ms p99 ${pct(ms, 0.99)} (n=200)`);
}

console.log("\n## 5. miniflare's local explorer (/cdn-cgi/explorer/api), the REST-shaped surface it ships");
{
  const ex = (p: string) => new URL(`/cdn-cgi/explorer/api${p}`, base);
  const r1 = await fetch(ex("/storage/kv/namespaces"));
  console.log("list namespaces:", r1.status, (await r1.text()).slice(0, 160));
  const r2 = await fetch(ex(`/storage/kv/namespaces/kv-1/values/explorer-ttl?expiration_ttl=60`), { method: "PUT", body: "x" });
  console.log("PUT ?expiration_ttl=60:", r2.status);
  const listed = await (await fetch(ex(`/storage/kv/namespaces/kv-1/keys?prefix=explorer-ttl`))).json() as any;
  console.log("…its expiration in a listing:", JSON.stringify(listed.result?.[0]));
  const r3 = await fetch(ex(`/storage/kv/namespaces/kv-1/values/explorer-ttl?expiration_ttl=30`), { method: "PUT", body: "x" });
  console.log("PUT ?expiration_ttl=30 (Cloudflare refuses < 60):", r3.status);
  const raw = await fetch(ex("/d1/database/db-1/raw"), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ batch: [{ sql: "CREATE TABLE IF NOT EXISTS ex (id INTEGER PRIMARY KEY)" }, { sql: "INSERT INTO ex VALUES (1)" }, { sql: "INSERT INTO ex VALUES (1)" }] }) });
  console.log("D1 /raw batch [create, insert 1, insert 1 again]:", raw.status);
  const after = await (await fetch(ex("/d1/database/db-1/raw"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: "SELECT count(*) FROM ex" }) })).json() as any;
  console.log("…rows left after the failed batch:", JSON.stringify(after.result?.[0]?.results?.rows));
  const q = await fetch(ex("/d1/database/db-1/query"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: "SELECT 1" }) });
  console.log("D1 /query:", q.status);
  const auth401 = await fetch(ex("/storage/kv/namespaces"), { headers: { authorization: "Bearer wrong" } });
  console.log("explorer with a wrong token:", auth401.status, "(it checks none)");
}

if (process.argv.includes("--expiry")) {
  console.log("\n## 6. Native expiry");
  await put("exp60", "x", "?expiration_ttl=60");
  const t0 = Date.now();
  let gone = 0;
  while (Date.now() - t0 < 75_000) { await Bun.sleep(1000); if ((await get("exp60")).status === 404) { gone = Date.now() - t0; break; } }
  console.log("expiration_ttl=60: gone after", gone, "ms");
}
await mf.dispose();
