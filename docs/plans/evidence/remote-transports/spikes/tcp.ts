// TCP spike: Bun.listen / Bun.connect — framing, backpressure, half-close, TLS, unix sockets, timeouts.
// Run: bun tcp.ts   (needs cert.pem / key.pem next to it; see README in the evidence doc)
import type { Socket } from "bun";
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const MiB = 1024 * 1024;
const dir = import.meta.dir;

// ---------- 1. framing: one large write, and many small writes ----------
{
  const chunks: number[] = []; let total = 0;
  const done = Promise.withResolvers<void>();
  const srv = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: { data(_s, d) { chunks.push(d.byteLength); total += d.byteLength; if (total >= 4 * MiB + 1000) done.resolve(); } },
  });
  const payload = new Uint8Array(4 * MiB);
  let off = 0; const writeReturns: number[] = []; let drains = 0;
  const pump = (s: Socket<undefined>) => { while (off < payload.byteLength) { const n = s.write(payload.subarray(off)); writeReturns.push(n); if (n <= 0) break; off += n; if (n < payload.byteLength - off + n) break; } };
  const c = await Bun.connect({ hostname: "127.0.0.1", port: srv.port, socket: { data() {}, drain(s) { drains++; pump(s); } } });
  pump(c);
  while (off < payload.byteLength) await sleep(5);
  // then 100 tiny writes back-to-back
  for (let i = 0; i < 100; i++) c.write("0123456789");
  await done.promise;
  const small = chunks.slice(-5);
  console.log(`RESULT 1 one 4 MiB payload: write() returns ${JSON.stringify(writeReturns.slice(0, 6))}${writeReturns.length > 6 ? "..." : ""} (${writeReturns.length} calls, ${drains} drain events); receiver got ${chunks.length} data events for ${total} bytes; sizes (first 8) ${JSON.stringify(chunks.slice(0, 8))}; last events ${JSON.stringify(small)}`);
  c.end(); srv.stop(true);
}

// ---------- 1b. write(buf, byteOffset) with byteLength omitted (docs: defaults to the remainder) ----------
{
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const c = await Bun.connect({ hostname: "127.0.0.1", port: srv.port, socket: { data() {} } });
  let r: string;
  try { r = `returned ${c.write(new Uint8Array(100), 10)}`; } catch (e) { r = `threw ${(e as Error).message}`; }
  console.log(`RESULT 1b write(new Uint8Array(100), 10): ${r}; write(buf, 10, 90) -> ${c.write(new Uint8Array(100), 10, 90)}`);
  c.end(); srv.stop(true);
}

// ---------- 2. backpressure: receiver paused; what does write() do, and is the remainder buffered? ----------
{
  let received = 0; let serverSock!: Socket<undefined>;
  const opened = Promise.withResolvers<void>();
  const srv = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: { open(s) { serverSock = s; s.pause(); opened.resolve(); }, data(_s, d) { received += d.byteLength; } },
  });
  let drains = 0;
  const c = await Bun.connect({ hostname: "127.0.0.1", port: srv.port, socket: { data() {}, drain() { drains++; } } });
  await opened.promise;
  const returns: number[] = []; let accepted = 0;
  const mb = new Uint8Array(MiB);
  for (let i = 0; i < 64; i++) { const n = c.write(mb); returns.push(n); accepted += Math.max(n, 0); }
  await sleep(200);
  const receivedWhilePaused = received;
  serverSock.resume();
  await sleep(1000);
  console.log(`RESULT 2 64 x write(1 MiB) into a paused receiver: returns ${JSON.stringify(returns.slice(0, 12))}... accepted=${(accepted / MiB).toFixed(2)} MiB of 64; received while paused=${receivedWhilePaused}; after resume received=${(received / MiB).toFixed(2)} MiB; drain events=${drains}`);
  console.log(`RESULT 2 bytes lost silently if the caller ignores write()'s return: ${((64 * MiB - received) / MiB).toFixed(2)} MiB`);
  c.end(); srv.stop(true);
}

// ---------- 3. half-close: see tcp-halfclose.ts, tcp-halfclose2.ts, tcp-halfclose3.ts ----------
// ---------- 4. TLS: see tls.ts ----------

// ---------- 5. Unix domain socket (path and abstract) ----------
for (const path of [`${dir}/spike.sock`, "\0bunjobs-spike"]) {
  try { if (!path.startsWith("\0")) await Bun.file(path).delete(); } catch {}
  const srv = Bun.listen({ unix: path, socket: { data(s, d) { s.write(`unix-echo:${d}`); } } });
  const got = Promise.withResolvers<string>();
  const c = await Bun.connect({ unix: path, socket: { data(_s, d) { got.resolve(String(d)); } } });
  c.write("hi");
  console.log(`RESULT 5 unix socket ${path.startsWith("\0") ? "(abstract)" : "(path)"}: "${await got.promise}", remoteAddress="${c.remoteAddress}"`);
  c.end(); srv.stop(true);
}
// fetch + Bun.serve over a unix socket too
{
  const path = `${dir}/spike-http.sock`;
  try { await Bun.file(path).delete(); } catch {}
  const s = Bun.serve({ unix: path, fetch: () => new Response("http-over-unix") });
  const r = await fetch("http://localhost/", { unix: path } as any);
  console.log(`RESULT 5 fetch({unix}) -> Bun.serve({unix}): ${r.status} "${await r.text()}"`);
  s.stop(true);
}

// ---------- 6. socket.timeout(): idle timeout on a raw socket ----------
{
  const s0 = performance.now(); let firedAt = 0;
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { s.timeout(2); }, data() {}, timeout() { firedAt = performance.now() - s0; } } });
  const closed = Promise.withResolvers<void>();
  await Bun.connect({ hostname: "127.0.0.1", port: srv.port, socket: { data() {}, close() { closed.resolve(); } } });
  await Promise.race([closed.promise, sleep(8000)]);
  console.log(`RESULT 6 server socket.timeout(2): timeout handler at ${Math.round(firedAt)}ms; client saw close at ${Math.round(performance.now() - s0)}ms`);
  srv.stop(true);
}

// ---------- 7. setKeepAlive / setNoDelay return values ----------
{
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const c = await Bun.connect({ hostname: "127.0.0.1", port: srv.port, socket: { data() {} } });
  console.log(`RESULT 7 setKeepAlive(true, 1000) -> ${c.setKeepAlive(true, 1000)}; setNoDelay(true) -> ${c.setNoDelay(true)} (probes not observable on loopback)`);
  c.end(); srv.stop(true);
}

// ---------- 8. peer process dies: does the other side learn? ----------
{
  const events: string[] = []; const s0 = performance.now();
  const closed = Promise.withResolvers<void>();
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { events.push("open"); }, data() {}, end() { events.push(`end@${Math.round(performance.now() - s0)}`); }, close(_s, e) { events.push(`close@${Math.round(performance.now() - s0)} err=${e?.message}`); closed.resolve(); }, error(_s, e) { events.push(`error ${e.message}`); } } });
  const child = Bun.spawn(["bun", "-e", `await Bun.connect({ hostname: "127.0.0.1", port: ${srv.port}, socket: { data() {} } }); setInterval(() => {}, 1000);`]);
  await sleep(500);
  child.kill("SIGKILL");
  await Promise.race([closed.promise, sleep(3000)]);
  console.log(`RESULT 8 peer SIGKILLed at ~500ms: server events ${events.join(" | ")} (loopback: kernel sends FIN; a cut cable / partition sends nothing — not measurable here)`);
  srv.stop(true);
}
process.exit(0);
