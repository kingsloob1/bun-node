// HTTP/3 client: which tls options work, against an h3-ONLY server (http1:false), so a success is h3.
// Run: bun h3-probe2.ts ; NODE_EXTRA_CA_CERTS=cert.pem bun h3-probe2.ts
const dir = import.meta.dir; const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const enc = new TextEncoder(); const dec = new TextDecoder();
const key = await Bun.file(`${dir}/key.pem`).text(); const cert = await Bun.file(`${dir}/cert.pem`).text();
let reqAbort = 0;
const srv = Bun.serve({ port: 0, http3: true, http1: false, tls: { key, cert }, async fetch(req) {
  const p = new URL(req.url).pathname;
  req.signal.addEventListener("abort", () => reqAbort++);
  if (p === "/stream") return new Response(new ReadableStream({ async start(c) { for (let i = 0; i < 4; i++) { c.enqueue(enc.encode(`c${i}\n`)); await sleep(150); } c.close(); } }));
  if (p === "/echo") { const b = req.body!; return new Response(new ReadableStream({ async start(c) { for await (const ch of b) c.enqueue(enc.encode(`echo:${dec.decode(ch)}\n`)); c.close(); } })); }
  if (p === "/big") return new Response(new Uint8Array(4 * 1024 * 1024));
  if (p === "/slow") { await sleep(2000); return new Response("slow"); }
  return new Response("h3-only");
} });
const variants: Record<string, any> = { "no tls option": undefined, "tls {}": {}, "tls {ca}": { ca: cert }, "tls {serverName}": { serverName: "localhost" }, "tls {rejectUnauthorized:false}": { rejectUnauthorized: false } };
for (const [name, tls] of Object.entries(variants)) {
  try { const r = await fetch(`https://localhost:${srv.port}/`, { ...(tls ? { tls } : {}), protocol: "http3", signal: AbortSignal.timeout(3000) } as any); console.log(`RESULT ${name}: ${r.status} "${await r.text()}"`); }
  catch (e) { console.log(`RESULT ${name}: ${(e as Error).name} ${(e as Error).message.split(" fetching")[0]}`); }
}
const h3 = (p: string, init: any = {}) => fetch(`https://localhost:${srv.port}${p}`, { ...init, tls: { rejectUnauthorized: false }, protocol: "http3" } as any);
try { const s0 = performance.now(); const r = await h3("/stream"); const rd = r.body!.getReader(); const t: number[] = []; for (;;) { const { done } = await rd.read(); if (done) break; t.push(Math.round(performance.now() - s0)); } console.log(`RESULT streamed h3 read times: ${JSON.stringify(t)}`); } catch (e) { console.log(`RESULT streamed h3: ${(e as Error).message}`); }
{
  let push!: (s: string) => void; let end!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(c) { push = s => c.enqueue(enc.encode(s)); end = () => c.close(); } });
  push("m0"); const ac = new AbortController(); const t = setTimeout(() => ac.abort(new Error("3s timeout")), 3000);
  try { const r = await h3("/echo", { method: "POST", body, duplex: "half", signal: ac.signal }); const rd = r.body!.getReader(); const got: string[] = [];
    for (let i = 0; i < 3; i++) { const { value, done } = await rd.read(); if (done) break; got.push(dec.decode(value).trim()); if (i < 2) push(`m${i + 1}`); else end(); }
    console.log(`RESULT duplex h3: ${JSON.stringify(got)}`); } catch (e) { console.log(`RESULT duplex h3: ${(e as Error).message}`); }
  clearTimeout(t);
}
try { const s0 = performance.now(); const b = await (await h3("/big")).arrayBuffer(); console.log(`RESULT 4 MiB h3: ${b.byteLength} in ${Math.round(performance.now() - s0)}ms`); } catch (e) { console.log(`RESULT big h3: ${(e as Error).message}`); }
try { const s1 = performance.now(); const rs = await Promise.all(Array.from({ length: 20 }, () => h3("/").then(r => r.text()))); console.log(`RESULT 20 concurrent h3: ${rs.filter(x => x === "h3-only").length}/20 in ${Math.round(performance.now() - s1)}ms`); } catch (e) { console.log(`RESULT concurrent h3: ${(e as Error).message}`); }
try { await h3("/slow", { signal: AbortSignal.timeout(300) }); } catch (e) { await sleep(200); console.log(`RESULT h3 AbortSignal.timeout(300): ${(e as Error).name}; server req.signal aborted count=${reqAbort}`); }
srv.stop(true); process.exit(0);
