// What Bun's S3Client sends and reads back, against a recording S3 stub.
// Not a real S3 server: this shows the CLIENT side of the wire (which headers
// Bun sends for each option, how it parses HEAD/list responses). A real
// server's behaviour (metadata limits, consistency) is taken from docs.
// Run: bun s3-wire.ts
import { S3Client } from "bun";

type Obj = { body: Uint8Array; headers: Record<string, string> };
const store = new Map<string, Obj>();
const log: string[] = [];
const keep = (h: Headers) => {
  const o: Record<string, string> = {};
  h.forEach((v, k) => {
    if (/^(x-amz-(?!date|content-sha256|security)|content-type|content-encoding|content-disposition|if-|range|cache-control|expires)/.test(k))
      o[k] = v;
  });
  return o;
};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const sent = keep(req.headers);
    log.push(`${req.method} ${url.pathname}${url.search} ${JSON.stringify(sent)}`);
    const key = url.pathname;
    if (req.method === "PUT") {
      if (req.headers.get("if-none-match") === "*" && store.has(key))
        return new Response("", { status: 412 });
      store.set(key, { body: new Uint8Array(await req.arrayBuffer()), headers: sent });
      return new Response("", { headers: { etag: `"e${store.size}"` } });
    }
    if (req.method === "DELETE") {
      store.delete(key);
      return new Response(null, { status: 204 });
    }
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const bucket = key.split("/")[1];
      const items = [...store.keys()].filter(k => k.startsWith(`/${bucket}/${prefix}`));
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${items.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${items
        .map(k => `<Contents><Key>${k.slice(bucket!.length + 2)}</Key><LastModified>2026-10-10T00:00:00.000Z</LastModified><ETag>"x"</ETag><Size>${store.get(k)!.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`)
        .join("")}</ListBucketResult>`;
      return new Response(xml, { headers: { "content-type": "application/xml" } });
    }
    const o = store.get(key);
    if (!o) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    const h: Record<string, string> = {
      "content-type": o.headers["content-type"] ?? "application/octet-stream",
      "etag": `"etag-of-${key}"`,
      "last-modified": new Date(0).toUTCString(),
      "content-length": String(o.body.length),
    };
    for (const [k, v] of Object.entries(o.headers)) if (k.startsWith("x-amz-meta-")) h[k] = v;
    const range = req.headers.get("range");
    if (range && req.method === "GET") {
      const [a, b] = range.replace("bytes=", "").split("-").map(Number);
      const part = o.body.subarray(a, (b ?? o.body.length - 1) + 1);
      return new Response(part, { status: 206, headers: { ...h, "content-length": String(part.length) } });
    }
    return new Response(req.method === "HEAD" ? null : o.body, { headers: h });
  },
});

const s3 = new S3Client({
  endpoint: `http://127.0.0.1:${server.port}`,
  bucket: "cache",
  accessKeyId: "test",
  secretAccessKey: "testtesttest",
  region: "us-east-1",
});

const step = async (name: string, fn: () => Promise<unknown>) => {
  const before = log.length;
  let out: unknown;
  try { out = await fn(); } catch (e) { out = `THROWS ${(e as Error).name}: ${(e as Error).message} code=${(e as { code?: string }).code}`; }
  console.log(`\n## ${name}\n  result: ${typeof out === "string" ? out : JSON.stringify(out)}`);
  for (const l of log.slice(before)) console.log(`  wire: ${l}`);
};

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)})`);
await step("write with type carrying parameters, contentEncoding, contentDisposition", () =>
  s3.write("ns/a", "hello", { type: "application/x-bun-cache; exp=1760000000000; v=1", contentEncoding: "gzip", contentDisposition: "inline" }));
await step("stat(): what HEAD exposes", async () => { const s = await s3.stat("ns/a"); return { size: s.size, lastModified: s.lastModified, etag: s.etag, type: s.type, keys: Object.keys(s) }; });
await step("undeclared option metadata:{exp} — is x-amz-meta-* sent?", () =>
  s3.write("ns/b", "x", { metadata: { exp: "1" } } as never));
await step("undeclared options ifNoneMatch / headers — sent?", () =>
  s3.write("ns/b", "y", { ifNoneMatch: "*", headers: { "if-none-match": "*" } } as never));
await step("exists() on present and missing", async () => [await s3.exists("ns/a"), await s3.exists("ns/zzz")]);
await step("file().text() of missing key", () => s3.file("ns/zzz").text());
await step("ranged read slice(0,3)", () => s3.file("ns/a").slice(0, 3).text());
await step("list({prefix})", () => s3.list({ prefix: "ns/" }));
await step("size()", () => s3.size("ns/a"));
await step("delete() then delete() again (idempotent?)", async () => { await s3.delete("ns/a"); await s3.delete("ns/a"); return "ok"; });
await step("presign GET (offline, no request)", async () => s3.presign("ns/b", { expiresIn: 60 }).replace(/Signature=[0-9a-f]+/, "Signature=…"));
await step("fetch(presigned GET) exposes x-amz-meta-* the stub returns", async () => {
  store.set("/cache/ns/m", { body: new TextEncoder().encode("m"), headers: { "x-amz-meta-exp": "123" } });
  const r = await fetch(s3.presign("ns/m"));
  return Object.fromEntries([...r.headers].filter(([k]) => k.startsWith("x-amz-meta")));
});
await step("S3Client methods on the prototype", async () => Object.getOwnPropertyNames(Object.getPrototypeOf(s3)).sort());
server.stop(true);
