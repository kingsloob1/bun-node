// Can Bun reach S3 conditional writes (If-None-Match: * create-once, If-Match: <etag>
// compare-and-swap), and do S3-compatible servers honour them, including under a race?
// Three paths per server: Bun's S3Client (as shipped), a presigned URL from S3Client
// plus fetch() with an UNSIGNED conditional header, and fetch() with our own SigV4
// header signature that SIGNS the conditional header.
// Run: bun conditional-writes.ts            (servers from S3_TARGETS, see README)
import { S3Client } from "bun";
import { createHash, createHmac } from "node:crypto";

type Target = { name: string; endpoint: string; key: string; secret: string; bucket: string };
const targets: Target[] = JSON.parse(process.env.S3_TARGETS ?? JSON.stringify([
  { name: "minio 2025.5.24 (bitnamilegacy)", endpoint: "http://127.0.0.1:19101", key: "spikeuser", secret: "spikesecret123", bucket: "jobs" },
  { name: "seaweedfs 4.48", endpoint: "http://127.0.0.1:19102", key: "spikeuser", secret: "spikesecret123", bucket: "jobs" },
  { name: "rustfs (2026-10-03 image)", endpoint: "http://127.0.0.1:19103", key: "spikeuser", secret: "spikesecret123", bucket: "jobs" },
  { name: "versitygw 1.8.0 (posix)", endpoint: "http://127.0.0.1:19104", key: "spikeuser", secret: "spikesecret123", bucket: "jobs" },
]));
const region = "us-east-1";
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Minimal SigV4 header signing (path-style, UNSIGNED-PAYLOAD), signing every header passed. */
async function signedFetch(t: Target, method: string, path: string, headers: Record<string, string> = {}, body?: string | Uint8Array, query = "") {
  const url = new URL(t.endpoint);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const h: Record<string, string> = { host: url.host, "x-amz-date": amzDate, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" };
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const names = Object.keys(h).sort();
  const canonical = [method, enc(path), query, names.map(n => `${n}:${h[n]!.trim()}\n`).join(""), names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${t.secret}`, date), region), "s3"), "aws4_request");
  const sig = createHmac("sha256", kSigning).update(toSign).digest("hex");
  const { host: _host, ...send } = h;
  return fetch(`${t.endpoint}${enc(path)}${query ? `?${query}` : ""}`, {
    method, body,
    headers: { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${t.key}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` },
  });
}

const verdict = (first: number, second: number) => first >= 200 && first < 300 && (second === 412 || second === 409) ? `honoured (${first} then ${second})` : first === 403 || second === 403 ? `rejected: 403` : first < 300 && second < 300 ? `IGNORED (${first} then ${second}: overwrote)` : `other (${first} then ${second})`;
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)]!.toFixed(2);

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), ${new Date().toISOString()}`);
for (const t of targets) {
  console.log(`\n## ${t.name} at ${t.endpoint}`);
  const run = `cw-${process.pid}-${Date.now()}`;
  try {
    const mk = await signedFetch(t, "PUT", `/${t.bucket}`);
    console.log(`create bucket: ${mk.status}${mk.status >= 300 ? ` (${(await mk.text()).match(/<Code>([^<]+)/)?.[1] ?? ""})` : ""}`);
    const s3 = new S3Client({ endpoint: t.endpoint, bucket: t.bucket, accessKeyId: t.key, secretAccessKey: t.secret, region, virtualHostedStyle: false });

    // 1. Bun's S3Client: what each path gives back
    const wrote = await s3.write(`${run}/a`, "v1");
    const st = await s3.stat(`${run}/a`);
    const ls = await s3.list({ prefix: `${run}/` });
    const text = await s3.file(`${run}/a`).text();
    console.log(`S3Client: write() returns ${typeof wrote} ${wrote}; text() ${JSON.stringify(text)} (no ETag on this path); stat().etag ${st.etag}; list() eTag ${ls.contents?.[0]?.eTag}`);

    // 2. presigned URL + fetch with an UNSIGNED conditional header
    const pre = (k: string) => s3.presign(k, { method: "PUT", expiresIn: 300 });
    let a = await fetch(pre(`${run}/p1`), { method: "PUT", body: "x", headers: { "if-none-match": "*" } });
    let b = await fetch(pre(`${run}/p1`), { method: "PUT", body: "y", headers: { "if-none-match": "*" } });
    console.log(`presigned + unsigned If-None-Match:* -> ${verdict(a.status, b.status)}; PUT response ETag header: ${a.headers.get("etag")}`);
    const etagP = (await s3.stat(`${run}/p1`)).etag;
    a = await fetch(pre(`${run}/p1`), { method: "PUT", body: "z", headers: { "if-match": etagP } });
    b = await fetch(pre(`${run}/p1`), { method: "PUT", body: "w", headers: { "if-match": etagP } });
    console.log(`presigned + unsigned If-Match:<etag> (2nd reuses the stale etag) -> ${verdict(a.status, b.status)}`);

    // 3. own SigV4 signing the conditional header
    a = await signedFetch(t, "PUT", `/${t.bucket}/${run}/s1`, { "if-none-match": "*" }, "x");
    b = await signedFetch(t, "PUT", `/${t.bucket}/${run}/s1`, { "if-none-match": "*" }, "y");
    const etag1 = a.headers.get("etag");
    console.log(`SigV4-signed If-None-Match:* -> ${verdict(a.status, b.status)}; PUT response ETag header: ${etag1}`);
    a = await signedFetch(t, "PUT", `/${t.bucket}/${run}/s1`, { "if-match": etag1 ?? '"none"' }, "z");
    b = await signedFetch(t, "PUT", `/${t.bucket}/${run}/s1`, { "if-match": etag1 ?? '"none"' }, "w");
    console.log(`SigV4-signed If-Match:<etag> (2nd reuses the stale etag) -> ${verdict(a.status, b.status)}; body now ${JSON.stringify(await s3.file(`${run}/s1`).text())}`);
    a = await signedFetch(t, "DELETE", `/${t.bucket}/${run}/s1`, { "if-match": '"0000"' });
    console.log(`SigV4-signed conditional DELETE with a wrong If-Match -> ${a.status} (${a.status === 412 ? "honoured" : a.status === 204 ? "IGNORED: deleted" : "other"}); object exists after: ${await s3.exists(`${run}/s1`)}`);

    // 4. races: 32 concurrent create-once, then 32 concurrent CAS from one etag
    const N = 32;
    const racers = await Promise.all(Array.from({ length: N }, (_, i) => signedFetch(t, "PUT", `/${t.bucket}/${run}/race`, { "if-none-match": "*" }, `r${i}`)));
    const codes = (rs: Response[]) => Object.entries(rs.reduce<Record<number, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {})).map(([k, v]) => `${v}x${k}`).join(", ");
    console.log(`race: ${N} concurrent If-None-Match:* PUTs -> ${codes(racers)}`);
    const base = (await s3.stat(`${run}/race`)).etag;
    const cas = await Promise.all(Array.from({ length: N }, (_, i) => signedFetch(t, "PUT", `/${t.bucket}/${run}/race`, { "if-match": base }, `c${i}`)));
    const winners = cas.filter(r => r.ok).length;
    console.log(`race: ${N} concurrent If-Match:<same etag> PUTs -> ${codes(cas)} (${winners === 1 ? "exactly one winner" : `${winners} WINNERS`})`);

    // 5. a CAS loop on one counter object: 16 writers x 10 increments; lost updates?
    await signedFetch(t, "PUT", `/${t.bucket}/${run}/ctr`, {}, "0");
    let attempts = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 16 }, async () => {
      for (let i = 0; i < 10; i++) {
        for (;;) {
          attempts++;
          const g = await signedFetch(t, "GET", `/${t.bucket}/${run}/ctr`);
          const n = Number(await g.text());
          const p = await signedFetch(t, "PUT", `/${t.bucket}/${run}/ctr`, { "if-match": g.headers.get("etag")! }, String(n + 1));
          if (p.ok) break;
          if (p.status !== 412 && p.status !== 409) throw new Error(`status ${p.status}`);
        }
      }
    }));
    const ms = performance.now() - t0;
    const final = await s3.file(`${run}/ctr`).text();
    console.log(`CAS counter: 16 writers x 10 -> final ${final} (want 160), ${attempts} GET+PUT attempts, ${(160 / (ms / 1000)).toFixed(0)} committed increments/s over loopback`);

    // 6. loopback latency per request (server + client cost only; real S3 is network-bound)
    const put: number[] = [], get: number[] = [], head: number[] = [], list: number[] = [];
    for (let i = 0; i < 100; i++) {
      let s = performance.now(); await s3.write(`${run}/l/${i}`, "x".repeat(512)); put.push(performance.now() - s);
      s = performance.now(); await s3.file(`${run}/l/${i}`).text(); get.push(performance.now() - s);
      s = performance.now(); await s3.stat(`${run}/l/${i}`); head.push(performance.now() - s);
      if (i % 10 === 9) { s = performance.now(); await s3.list({ prefix: `${run}/l/` }); list.push(performance.now() - s); }
    }
    console.log(`loopback p50/p95 ms: PUT ${pct(put, .5)}/${pct(put, .95)}, GET ${pct(get, .5)}/${pct(get, .95)}, HEAD ${pct(head, .5)}/${pct(head, .95)}, LIST(<=100 keys) ${pct(list, .5)}/${pct(list, .95)}`);

    // 7. read-after-write and list-after-write on a fresh key
    await s3.write(`${run}/raw`, "fresh");
    const seen = (await s3.list({ prefix: `${run}/raw` })).contents?.length ?? 0;
    console.log(`read-after-write: GET ${JSON.stringify(await s3.file(`${run}/raw`).text())}, LIST sees ${seen}/1 (single node: says nothing about distributed setups)`);

    // cleanup: exactly this run's prefix
    let n = 0;
    for (;;) { const page = await s3.list({ prefix: `${run}/` }); if (!page.contents?.length) break; for (const c of page.contents) { await s3.delete(c.key); n++; } }
    console.log(`cleanup: deleted ${n} objects under ${run}/`);
  } catch (e) {
    console.log(`ERROR: ${(e as Error).message}`);
  }
}
