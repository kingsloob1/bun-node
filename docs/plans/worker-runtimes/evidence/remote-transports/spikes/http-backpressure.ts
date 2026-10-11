// Do streamed HTTP bodies propagate backpressure? Count pull() calls on a 1 MiB-per-pull source while
// the other side is not reading. Run: bun http-backpressure.ts
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const MiB = 1024 * 1024;
const source = (counter: { n: number }, limit = 256) => new ReadableStream({
  pull(c) { counter.n++; if (counter.n > limit) { c.close(); return; } c.enqueue(new Uint8Array(MiB)); },
}, { highWaterMark: 1 });

// 1. response body: server produces, client does not read for 1.5 s
{
  const pulls = { n: 0 };
  const srv = Bun.serve({ port: 0, fetch: () => new Response(source(pulls)) });
  const r = await fetch(`http://127.0.0.1:${srv.port}/`);
  await sleep(1500);
  const whileIdle = pulls.n;
  const rd = r.body!.getReader(); let got = 0;
  for (;;) { const { value, done } = await rd.read(); if (done) break; got += value.byteLength; }
  console.log(`RESULT 1 response stream, client idle 1.5 s: server pulled ${whileIdle} MiB meanwhile (unbounded would be 256); client then read ${(got / MiB).toFixed(0)} MiB`);
  srv.stop(true);
}
// 1b. same but with fetch's body never read and the client process busy-waiting? skip; 1 covers the in-process case.

// 2. request body: client streams up (64 MiB and 256 MiB; default maxRequestBodySize is 128 MiB),
//    server handler does not read for 1.5 s, then reads to the end
for (const limit of [64, 256]) {
  const pulls = { n: 0 };
  let readStart = 0; let err = "";
  const srv = Bun.serve({ port: 0, async fetch(req) {
    await sleep(1500); readStart = pulls.n;
    let got = 0;
    try { for await (const c of req.body!) got += c.byteLength; } catch (e) { err = (e as Error).message; }
    return new Response(String(got));
  } });
  let out: string;
  try { const r = await fetch(`http://127.0.0.1:${srv.port}/`, { method: "POST", body: source(pulls, limit), duplex: "half" } as RequestInit); out = `status ${r.status}, server read ${(Number(await r.text()) / MiB).toFixed(0)} MiB${err ? ` then threw "${err}"` : " without error"}`; }
  catch (e) { out = `client error ${(e as Error).message}`; }
  console.log(`RESULT 2 request stream of ${limit} MiB, server idle 1.5 s: client pulled ${readStart} MiB meanwhile; ${out}`);
  srv.stop(true);
}
// 3. same 256 MiB upload, server reads immediately
{
  const pulls = { n: 0 }; let err = "";
  const srv = Bun.serve({ port: 0, async fetch(req) { let got = 0; try { for await (const c of req.body!) got += c.byteLength; } catch (e) { err = (e as Error).message; } return new Response(String(got)); } });
  let out: string;
  try { const r = await fetch(`http://127.0.0.1:${srv.port}/`, { method: "POST", body: source(pulls, 256), duplex: "half" } as RequestInit); out = `status ${r.status}, server read ${(Number(await r.text()) / MiB).toFixed(0)} MiB${err ? ` then threw "${err}"` : " without error"}`; }
  catch (e) { out = `client error ${(e as Error).message}`; }
  console.log(`RESULT 3 request stream of 256 MiB (> default maxRequestBodySize 128 MiB), server reading at once: ${out}`);
  srv.stop(true);
}
process.exit(0);
