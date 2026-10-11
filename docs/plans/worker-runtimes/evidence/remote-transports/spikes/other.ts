// Odds and ends: wss with a pinned CA and custom headers; WebSocket upgrade on an http2 server;
// WebSocket over a unix socket. Run: bun other.ts
const dir = import.meta.dir;
const key = await Bun.file(`${dir}/key.pem`).text(); const cert = await Bun.file(`${dir}/cert.pem`).text();
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const tryWs = (url: string, opts: any) => new Promise<string>((res) => {
  let ws: WebSocket;
  try { ws = new WebSocket(url, opts); } catch (e) { res(`threw ${(e as Error).message}`); return; }
  ws.onopen = () => ws.send("hi");
  ws.onmessage = (e) => { res(`message "${e.data}"`); ws.close(); };
  ws.onerror = (e: any) => res(`error ${e?.message ?? e?.type}`);
  ws.onclose = (e) => res(`close ${e.code}`);
  setTimeout(() => res("timeout"), 3000);
});
for (const http2 of [false, true]) {
  const srv = Bun.serve<{ auth: string | null }>({
    port: 0, hostname: "127.0.0.1", tls: { key, cert }, http2,
    fetch(req, s) { if (s.upgrade(req, { data: { auth: req.headers.get("authorization") } })) return; return new Response("no"); },
    websocket: { message(ws, m) { ws.send(`echo:${m} auth=${ws.data.auth}`); } },
  });
  const url = `wss://localhost:${srv.port}/`;
  console.log(`RESULT wss (server http2=${http2}) tls.ca + headers: ${await tryWs(url, { tls: { ca: cert }, headers: { authorization: "Bearer t" } })}`);
  console.log(`RESULT wss (server http2=${http2}) default verification: ${await tryWs(url, {})}`);
  srv.stop(true);
}
{
  const path = `${dir}/ws.sock`; try { await Bun.file(path).delete(); } catch {}
  const srv = Bun.serve({ unix: path, fetch(req, s) { if (s.upgrade(req)) return; return new Response("no"); }, websocket: { message(ws, m) { ws.send(`unix-echo:${m}`); } } });
  console.log(`RESULT ws+unix:// URL: ${await tryWs(`ws+unix://${path}`, {})}`);
  srv.stop(true);
}
await sleep(10);
process.exit(0);
