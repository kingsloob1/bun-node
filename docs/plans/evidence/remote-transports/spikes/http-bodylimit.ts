// Can maxRequestBodySize be lifted for a long-lived streamed upload? Run: bun http-bodylimit.ts
const MiB = 1024 * 1024;
for (const max of [Infinity, Number.MAX_SAFE_INTEGER, 2 ** 32, 512 * MiB]) {
  let srv;
  try { srv = Bun.serve({ port: 0, maxRequestBodySize: max, async fetch(req) { let g = 0; try { for await (const c of req.body!) g += c.byteLength; } catch (e) { return new Response(`threw ${(e as Error).message}`); } return new Response(String(g)); } }); }
  catch (e) { console.log(`RESULT maxRequestBodySize=${max}: Bun.serve threw ${(e as Error).message}`); continue; }
  let n = 0;
  const body = new ReadableStream({ pull(c) { if (++n > 300) c.close(); else c.enqueue(new Uint8Array(MiB)); } }, { highWaterMark: 1 });
  const r = await fetch(`http://127.0.0.1:${srv.port}/`, { method: "POST", body, duplex: "half" } as RequestInit);
  const t = await r.text();
  console.log(`RESULT maxRequestBodySize=${max}: 300 MiB streamed upload -> ${r.status} ${/^\d+$/.test(t) ? `${Number(t) / MiB} MiB read` : t}`);
  srv.stop(true);
}
process.exit(0);
