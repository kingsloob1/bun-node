// The Azure Blob Storage spike (plan Status, 2026-10-27: "whether Azurite
// covers the Lease Blob and conditional-write paths"), against Azurite from
// `bun scripts/setup-databases.ts --only=azure`. Signs with the driver's own
// Shared Key signer (fetch only, no Azure SDK).
//
// Run: BUN_CACHE_TEST_AZURE_URL=azure://…  bun wire.ts
// Data: every blob is under bun-cache-probe/<pid>-<time>/ and the script
// deletes exactly the blobs it listed under that prefix at the end.
import process from "node:process";
import type { AzureSigningTarget } from "../../../../../packages/bun-cache/lib/drivers/azure-sign";
import { azureFetch } from "../../../../../packages/bun-cache/lib/drivers/azure-sign";

const url = process.env.BUN_CACHE_TEST_AZURE_URL;
if (!url) throw new Error("set BUN_CACHE_TEST_AZURE_URL");
const parsed = new URL(url);
const path = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
const container = path.pop()!;
const target: AzureSigningTarget = {
  endpoint: `${parsed.searchParams.get("scheme") ?? "https"}://${parsed.host}${path.length ? `/${path.join("/")}` : ""}`,
  account: decodeURIComponent(parsed.username),
  key: decodeURIComponent(parsed.password),
  container,
};
const run = `bun-cache-probe/${process.pid}-${Date.now().toString(36)}`;
const enc = new TextEncoder();
const out = (title: string, value: unknown) =>
  console.log(`  ${title}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
const section = (title: string) => console.log(`\n## ${title}`);
const code = (r: Response) => `${r.status} ${r.headers.get("x-ms-error-code") ?? ""}`.trim();

async function put(blob: string, body: string, headers: Record<string, string> = {}) {
  return await azureFetch(target, {
    method: "PUT",
    blob: `${run}/${blob}`,
    headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/octet-stream", ...headers },
    body: enc.encode(body),
  });
}
async function req(method: string, blob: string, headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  return await azureFetch(target, { method, blob: blob === "" ? "" : `${run}/${blob}`, headers, query });
}
const lease = (blob: string, headers: Record<string, string>) => req("PUT", blob, headers, { comp: "lease" });

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}); endpoint ${target.endpoint}, container ${container}`);

section("signing");
{
  const ok = await put("sig", "x");
  out("PUT with the right key", code(ok));
  const wrong = await azureFetch({ ...target, key: Buffer.from("not-the-key").toString("base64") }, {
    method: "GET", blob: `${run}/sig`,
  });
  out("GET with a wrong key", `${code(wrong)} ${(await wrong.text()).match(/<Message>([^<\n]*)/)?.[1] ?? ""}`);
  const unsigned = await fetch(`${target.endpoint}/${container}/${run}/sig`);
  out("GET unsigned (private container)", code(unsigned));
  const old = await azureFetch(target, { method: "GET", blob: `${run}/sig`, headers: {} as Record<string, string> });
  out("GET (control)", code(old));
  const { signAzureRequest, azureBlobUrl } = await import("../../../../../packages/bun-cache/lib/drivers/azure-sign");
  const u = azureBlobUrl(target, `${run}/sig`);
  const stale = signAzureRequest(target, { method: "GET", url: u, date: new Date(Date.now() - 20 * 60_000) });
  out("GET signed 20 min ago (Azure refuses past 15 min)", code(await fetch(u, { headers: stale })));
  const future = signAzureRequest(target, { method: "GET", url: u, headers: { "x-ms-version": "2099-01-01" } });
  const fr = await fetch(u, { headers: future });
  out("GET with x-ms-version 2099-01-01", `${code(fr)} ${(await fr.text()).match(/<Message>([^<\n]*)/)?.[1] ?? ""}`);
  for (const v of ["2021-12-02", "2025-01-05", "2025-11-05", "2026-02-06"]) {
    const h = signAzureRequest(target, { method: "GET", url: u, headers: { "x-ms-version": v } });
    const r = await fetch(u, { headers: h });
    await r.arrayBuffer();
    out(`x-ms-version ${v}`, code(r));
  }
  const odd = await put("name with spaces/^a~b!'()*%/é", "odd");
  const oddGet = await req("GET", "name with spaces/^a~b!'()*%/é");
  out("odd blob name PUT / GET", `${code(odd)} / ${code(oddGet)} ${await oddGet.text()}`);
}

section("put, get, head: ETag, Content-Type with parameters, metadata");
{
  const type = "application/x-bun-cache; exp=1760000000000; at=1759999999000";
  const p = await put("e1", "hello", { "content-type": type, "x-ms-meta-exp": "1760000000000" });
  out("PUT status, etag, last-modified", [p.status, p.headers.get("etag"), p.headers.get("last-modified")]);
  const g = await req("GET", "e1");
  out("GET content-type", g.headers.get("content-type"));
  out("GET etag", g.headers.get("etag"));
  out("GET x-ms-meta-exp", g.headers.get("x-ms-meta-exp"));
  out("GET body", await g.text());
  const h = await req("HEAD", "e1");
  out("HEAD content-type, length", [h.headers.get("content-type"), h.headers.get("content-length")]);
  const m = await req("GET", "missing");
  out("GET missing", `${code(m)}`);
  await m.arrayBuffer();
  const range = await req("GET", "e1", { "x-ms-range": "bytes=0-2" });
  out("GET x-ms-range 0-2", `${range.status} ${await range.text()}`);
  const rangeStd = await req("GET", "e1", { range: "bytes=1-2" });
  out("GET Range 1-2 (signed standard header)", `${rangeStd.status} ${await rangeStd.text()}`);
}

section("conditional PUT and DELETE");
{
  const first = await put("c1", "1", { "if-none-match": "*" });
  out("create If-None-Match:* (absent)", code(first));
  const etag = first.headers.get("etag")!;
  const again = await put("c1", "2", { "if-none-match": "*" });
  out("create If-None-Match:* (present)", code(again));
  out("body after", await (await req("GET", "c1")).text());
  const swap = await put("c1", "3", { "if-match": etag });
  out("If-Match current etag", code(swap));
  const stale = await put("c1", "4", { "if-match": etag });
  out("If-Match stale etag", code(stale));
  const onMissing = await put("nope", "x", { "if-match": etag });
  out("If-Match on a missing blob", code(onMissing));
  const star = await put("c1", "5", { "if-match": "*" });
  out("If-Match:* on present", code(star));
  const delStale = await req("DELETE", "c1", { "if-match": etag });
  out("DELETE If-Match stale", code(delStale));
  const cur = (await req("HEAD", "c1")).headers.get("etag")!;
  const del = await req("DELETE", "c1", { "if-match": cur });
  out("DELETE If-Match current", code(del));
  const delMissing = await req("DELETE", "c1");
  out("DELETE missing", code(delMissing));
  const delMissingIf = await req("DELETE", "c1", { "if-match": cur });
  out("DELETE missing with If-Match", code(delMissingIf));
}

section("concurrent conditional writes to one blob");
for (const n of [5, 50]) {
  let t = performance.now();
  const creates = await Promise.all(Array.from({ length: n }, (_, i) => put(`race-${n}`, String(i), { "if-none-match": "*" })));
  const createMs = performance.now() - t;
  const codes: Record<string, number> = {};
  for (const r of creates) codes[code(r)] = (codes[code(r)] ?? 0) + 1;
  out(`${n} creates If-None-Match:* (${createMs.toFixed(0)} ms)`, codes);
  const etag = (await req("HEAD", `race-${n}`)).headers.get("etag")!;
  t = performance.now();
  const swaps = await Promise.all(Array.from({ length: n }, (_, i) => put(`race-${n}`, `s${i}`, { "if-match": etag })));
  const swapMs = performance.now() - t;
  const sc: Record<string, number> = {};
  for (const r of swaps) sc[code(r)] = (sc[code(r)] ?? 0) + 1;
  out(`${n} swaps If-Match same etag (${swapMs.toFixed(0)} ms)`, sc);
}
{
  // 200 increments as a CAS loop from 20 workers: lost updates?
  await put("ctr", "0");
  let conflicts = 0;
  const t = performance.now();
  await Promise.all(Array.from({ length: 20 }, async () => {
    for (let k = 0; k < 10; k++) {
      for (;;) {
        const g = await req("GET", "ctr");
        const v = Number(await g.text());
        const r = await put("ctr", String(v + 1), { "if-match": g.headers.get("etag")! });
        await r.arrayBuffer();
        if (r.status === 201) break;
        conflicts++;
        await Bun.sleep(Math.random() * 5);
      }
    }
  }));
  out(`200 CAS increments from 20 workers (${(performance.now() - t).toFixed(0)} ms)`, { value: await (await req("GET", "ctr")).text(), conflicts });
}

section("Lease Blob");
{
  const A = crypto.randomUUID();
  const B = crypto.randomUUID();
  await put("l1", "lock");
  const missing = await lease("l-missing", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "15" });
  out("acquire on a missing blob", code(missing));
  for (const d of ["5", "14", "61"]) {
    out(`acquire duration ${d}`, code(await lease("l1", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": d, "x-ms-proposed-lease-id": A })));
  }
  const acq = await lease("l1", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "15", "x-ms-proposed-lease-id": A });
  out("acquire 15 s as A", `${code(acq)} lease-id=${acq.headers.get("x-ms-lease-id") === A}`);
  out("acquire as B while A holds", code(await lease("l1", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "15", "x-ms-proposed-lease-id": B })));
  out("acquire again as A (re-acquire)", code(await lease("l1", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "20", "x-ms-proposed-lease-id": A })));
  out("renew as A", code(await lease("l1", { "x-ms-lease-action": "renew", "x-ms-lease-id": A })));
  out("renew as B", code(await lease("l1", { "x-ms-lease-action": "renew", "x-ms-lease-id": B })));
  out("PUT without the lease id", code(await put("l1", "x")));
  out("PUT with A's lease id", code(await put("l1", "y", { "x-ms-lease-id": A })));
  out("PUT with B's lease id", code(await put("l1", "z", { "x-ms-lease-id": B })));
  out("DELETE without the lease id", code(await req("DELETE", "l1")));
  out("GET while leased (no id needed)", code(await req("GET", "l1")));
  const props = await req("HEAD", "l1");
  out("HEAD lease state/status/duration", [props.headers.get("x-ms-lease-state"), props.headers.get("x-ms-lease-status"), props.headers.get("x-ms-lease-duration")]);
  out("release as B", code(await lease("l1", { "x-ms-lease-action": "release", "x-ms-lease-id": B })));
  out("release as A", code(await lease("l1", { "x-ms-lease-action": "release", "x-ms-lease-id": A })));
  out("release as A again", code(await lease("l1", { "x-ms-lease-action": "release", "x-ms-lease-id": A })));
  out("acquire infinite (-1) as A", code(await lease("l1", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "-1", "x-ms-proposed-lease-id": A })));
  const brk = await lease("l1", { "x-ms-lease-action": "break", "x-ms-lease-break-period": "0" });
  out("break, period 0", `${code(brk)} lease-time=${brk.headers.get("x-ms-lease-time")}`);
  out("acquire as B after the break", code(await lease("l1", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "15", "x-ms-proposed-lease-id": B })));
  const brk2 = await lease("l1", { "x-ms-lease-action": "break", "x-ms-lease-break-period": "2" });
  out("break, period 2 s", `${code(brk2)} lease-time=${brk2.headers.get("x-ms-lease-time")}`);
  out("acquire as A during the break period", code(await lease("l1", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "15", "x-ms-proposed-lease-id": A })));
  await Bun.sleep(2_200);
  out("acquire as A after the break period", code(await lease("l1", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "15", "x-ms-proposed-lease-id": A })));
  out("change A -> B", code(await lease("l1", { "x-ms-lease-action": "change", "x-ms-lease-id": A, "x-ms-proposed-lease-id": B })));
  out("release as B", code(await lease("l1", { "x-ms-lease-action": "release", "x-ms-lease-id": B })));
  out("non-GUID proposed id", code(await lease("l1", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "15", "x-ms-proposed-lease-id": "owner-1" })));
  // 50 contenders on a free blob.
  await put("l2", "lock");
  const ids = Array.from({ length: 50 }, () => crypto.randomUUID());
  let t = performance.now();
  const acqs = await Promise.all(ids.map((id) => lease("l2", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "15", "x-ms-proposed-lease-id": id })));
  const c: Record<string, number> = {};
  for (const r of acqs) c[code(r)] = (c[code(r)] ?? 0) + 1;
  out(`50 concurrent acquires (${(performance.now() - t).toFixed(0)} ms)`, c);
  // Expiry: a 15 s lease, then how long until another id can take it.
  await put("l3", "lock");
  const X = crypto.randomUUID();
  const Y = crypto.randomUUID();
  t = performance.now();
  await lease("l3", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "15", "x-ms-proposed-lease-id": X });
  let tries = 0;
  for (;;) {
    tries++;
    const r = await lease("l3", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "15", "x-ms-proposed-lease-id": Y });
    if (r.status === 201) break;
    await Bun.sleep(250);
  }
  out("a 15 s lease taken by another id after (ms)", `${(performance.now() - t).toFixed(0)} (${tries} tries)`);
  const st = await req("HEAD", "l3");
  out("state after", [st.headers.get("x-ms-lease-state"), st.headers.get("x-ms-lease-duration")]);
  await lease("l3", { "x-ms-lease-action": "release", "x-ms-lease-id": Y });
  await lease("l2", { "x-ms-lease-action": "break", "x-ms-lease-break-period": "0" });
}

section("List Blobs: prefix, paging, what each item carries");
{
  for (const n of ["p/a", "p/b", "p/c", "p/d", "p/e"]) await put(n, n, { "content-type": `application/x-bun-cache; exp=${Date.now() + 60_000}; at=${Date.now()}`, "x-ms-meta-exp": "9" });
  let marker: string | undefined;
  let pages = 0;
  const names: string[] = [];
  let first = "";
  do {
    const r = await req("GET", "", {}, { restype: "container", comp: "list", prefix: `${run}/p/`, maxresults: "2", include: "metadata", ...(marker ? { marker } : {}) });
    const xml = await r.text();
    if (!first) first = xml;
    pages++;
    for (const m of xml.matchAll(/<Name>([^<]*)<\/Name>/g)) names.push(m[1].slice(run.length + 1));
    marker = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1];
  } while (marker);
  out("pages of 2 for 5 blobs", pages);
  out("names", names);
  console.log(`  first page XML (one Blob):\n    ${first.replace(/<Blob>/, "\n    <Blob>").split("\n").slice(0, 2).join("\n").slice(0, 1600)}`);
  const big = await req("GET", "", {}, { restype: "container", comp: "list", prefix: `${run}/p/`, maxresults: "6000" });
  out("maxresults 6000", code(big));
  await big.arrayBuffer();
}

section("sizes and limits");
{
  const mb = 64;
  const bytes = new Uint8Array(mb * 1024 * 1024);
  const t = performance.now();
  const r = await azureFetch(target, { method: "PUT", blob: `${run}/big`, headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/octet-stream" }, body: bytes });
  out(`${mb} MiB single Put Blob`, `${code(r)} in ${(performance.now() - t).toFixed(0)} ms`);
  const g = await req("GET", "big");
  out("read back length", (await g.arrayBuffer()).byteLength);
  const meta = await put("meta", "x", { "x-ms-meta-bad-name": "1" });
  out("metadata name with '-'", code(meta));
}

section("batch delete (Blob Batch)");
{
  const r = await req("POST", "", { "content-type": "multipart/mixed; boundary=batch_x" }, { restype: "container", comp: "batch" });
  out("POST ?comp=batch with an empty body", code(r));
  await r.arrayBuffer();
}

section("ETags from a listing, escaping in a listing, leases against conditions");
{
  await put("q/1", "a");
  const list = await req("GET", "", {}, { restype: "container", comp: "list", prefix: `${run}/q/` });
  const listed = /<Etag>([^<]*)<\/Etag>/.exec(await list.text())![1];
  const head = (await req("HEAD", "q/1")).headers.get("etag")!;
  out("listing Etag vs HEAD ETag", [listed, head]);
  out("DELETE If-Match <listing etag, unquoted>", code(await req("DELETE", "q/1", { "if-match": listed })));
  await put("q/2", "a");
  const listed2 = /<Etag>([^<]*)<\/Etag>/.exec(await (await req("GET", "", {}, { restype: "container", comp: "list", prefix: `${run}/q/` })).text())![1];
  out("DELETE If-Match <listing etag, quoted>", code(await req("DELETE", "q/2", { "if-match": `"${listed2}"` })));
  await put("q/a&b<c>'\"", "x");
  const esc = await (await req("GET", "", {}, { restype: "container", comp: "list", prefix: `${run}/q/` })).text();
  out("a name with & < > ' \" in the listing", /<Name>([^<]*)<\/Name>/.exec(esc)?.[1]);
  const lid = crypto.randomUUID();
  const before = (await put("q/leased", "a")).headers.get("etag");
  await lease("q/leased", { "x-ms-lease-action": "acquire", "x-ms-lease-duration": "15", "x-ms-proposed-lease-id": lid });
  out("If-None-Match:* on a leased blob", code(await put("q/leased", "b", { "if-none-match": "*" })));
  const e = (await req("HEAD", "q/leased")).headers.get("etag")!;
  out("If-Match current, no lease id, on a leased blob", code(await put("q/leased", "b", { "if-match": e })));
  out("ETag before and after taking a lease", [before, e]);
  await lease("q/leased", { "x-ms-lease-action": "break", "x-ms-lease-break-period": "0" });
  const p1 = await put("q/lm", "1");
  await Bun.sleep(300);
  const p2 = await put("q/lm", "2");
  out("Last-Modified of two writes 300 ms apart", [p1.headers.get("last-modified"), p2.headers.get("last-modified")]);
  out("ETags of the same two writes", [p1.headers.get("etag"), p2.headers.get("etag")]);
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) await (await req("GET", "q/lm")).arrayBuffer();
  out("100 sequential GETs (ms each)", ((performance.now() - t0) / 100).toFixed(2));
  const t1 = performance.now();
  for (let i = 0; i < 100; i++) await (await put("q/lm", String(i))).arrayBuffer();
  out("100 sequential PUTs (ms each)", ((performance.now() - t1) / 100).toFixed(2));
}

section("cleanup: exactly the blobs under this run's prefix");
{
  let marker: string | undefined;
  let deleted = 0;
  do {
    const r = await req("GET", "", {}, { restype: "container", comp: "list", prefix: `${run}/`, ...(marker ? { marker } : {}) });
    const xml = await r.text();
    for (const m of xml.matchAll(/<Name>([^<]*)<\/Name>/g)) {
      const name = m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      const d = await azureFetch(target, { method: "DELETE", blob: name });
      if (d.status === 202) deleted++;
      else out(`could not delete ${name}`, code(d));
    }
    marker = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1];
  } while (marker);
  out("deleted", deleted);
}
