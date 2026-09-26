// WebSocket spike: Bun.serve websocket handler + the global WebSocket client.
// Run: bun ws.ts
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const log: string[] = [];
const MiB = 1024 * 1024;

type D = { name: string };
const serverEvents: Record<string, string[]> = {};
const ev = (n: string, s: string) => (serverEvents[n] ??= []).push(s);
const sockets = new Map<string, import("bun").ServerWebSocket<D>>();

const server = Bun.serve<D>({
  port: 0,
  fetch(req, srv) {
    const name = new URL(req.url).searchParams.get("name") ?? "?";
    if (srv.upgrade(req, { data: { name } })) return;
    return new Response("no upgrade", { status: 400 });
  },
  websocket: {
    maxPayloadLength: 1 * MiB,
    backpressureLimit: 4 * MiB,
    perMessageDeflate: true,
    idleTimeout: 8, // seconds; see section 7
    open(ws) { sockets.set(ws.data.name, ws); ev(ws.data.name, "open"); },
    message(ws, msg) {
      const kind = typeof msg === "string" ? `text(${msg.length})` : `${msg.constructor.name}(${msg.byteLength})`;
      ev(ws.data.name, `message ${kind}`);
      if (ws.data.name === "echo") ws.send(msg);
    },
    drain(ws) { ev(ws.data.name, `drain buffered=${ws.getBufferedAmount()}`); },
    ping(ws, data) { ev(ws.data.name, `ping "${data}"`); },
    pong(ws, data) { ev(ws.data.name, `pong "${data}"`); },
    close(ws, code, reason) { ev(ws.data.name, `close ${code} "${reason}"`); },
  },
});
const url = (name: string) => `ws://127.0.0.1:${server.port}/?name=${name}`;
async function open(name: string, opts?: object): Promise<WebSocket> {
  const ws = new WebSocket(url(name), opts as any);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return ws;
}

// 1. binary + text frames round-trip, binaryType, negotiated extensions
{
  const ws = await open("echo");
  const got: string[] = [];
  ws.onmessage = e => got.push(typeof e.data === "string" ? `string(${e.data.length})` : `${e.data.constructor.name}(${e.data.byteLength})`);
  ws.send("hello"); ws.send(new Uint8Array([1, 2, 3])); await sleep(50);
  ws.binaryType = "arraybuffer"; ws.send(new Uint8Array([1, 2, 3])); await sleep(50);
  console.log(`RESULT 1 client received: ${got.join(", ")}; default binaryType now=${ws.binaryType}; extensions="${ws.extensions}"`);
  // client-side send() return value
  console.log(`RESULT 1 client send() returns: ${JSON.stringify(ws.send("x"))}`);
  // client ping/pong: can the client send a ping, and observe the server's pong?
  const clientSaw: string[] = [];
  for (const t of ["ping", "pong"]) ws.addEventListener(t, (e: any) => clientSaw.push(`${t}:${e.data ?? ""}`));
  (ws as any).ping("from-client");
  await sleep(100);
  const s = sockets.get("echo")!;
  s.ping("from-server");
  await sleep(100);
  console.log(`RESULT 1 client ping() -> server events: ${serverEvents.echo.filter(x => x.startsWith("p")).join(", ")}; client observed events: ${JSON.stringify(clientSaw)}`);
  ws.close(4001, "done");
  await sleep(50);
}

// 2. maxPayloadLength = 1 MiB: client sends 2 MiB
{
  const ws = await open("big");
  const closed = new Promise<CloseEvent>(r => (ws.onclose = r));
  ws.send(new Uint8Array(2 * MiB));
  const c = await Promise.race([closed, sleep(2000).then(() => null)]);
  console.log(`RESULT 2 client sent 2 MiB > maxPayloadLength 1 MiB: client close event code=${c?.code} reason="${c?.reason}"; server: ${serverEvents.big.join(" | ")}`);
}

// 3. Server backpressure: client paused (stops reading), server sends 1 MiB messages
{
  const ws = await open("slow");
  ws.pause();
  const s = sockets.get("slow")!;
  const returns: string[] = [];
  const payload = new Uint8Array(MiB);
  for (let i = 0; i < 12; i++) {
    const r = s.sendBinary(payload);
    returns.push(`${r}@buf=${(s.getBufferedAmount() / MiB).toFixed(1)}MiB`);
  }
  console.log(`RESULT 3 server sendBinary(1 MiB) x12 into a paused client (backpressureLimit 4 MiB): ${returns.join(", ")}`);
  let received = 0;
  ws.onmessage = () => received++;
  ws.resume();
  await sleep(1000);
  console.log(`RESULT 3 after resume: client received ${received} messages; server events: ${serverEvents.slow.join(" | ")}`);
  ws.close();
  await sleep(50);
}

// 3b. closeOnBackpressureLimit
{
  const srv2 = Bun.serve<undefined>({
    port: 0,
    fetch(req, s) { return s.upgrade(req) ? undefined : new Response("x"); },
    websocket: {
      backpressureLimit: 2 * MiB, closeOnBackpressureLimit: true,
      open(ws) { const out: number[] = []; for (let i = 0; i < 8; i++) out.push(ws.sendBinary(new Uint8Array(MiB))); log.push(`closeOnBackpressureLimit returns ${out.join(",")} readyState=${ws.readyState}`); },
      message() {},
      close(_ws, code) { log.push(`closeOnBackpressureLimit server close ${code}`); },
    },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${srv2.port}/`);
  ws.pause();
  const cp = new Promise<CloseEvent>(r => (ws.onclose = r));
  await sleep(1000);
  const before = log.join(" | ");
  ws.resume(); // a paused client does not read, so it cannot see the close until resumed
  const c = await Promise.race([cp, sleep(2000).then(() => null)]);
  console.log(`RESULT 3b after 1 s: ${before} ; after resume: client close code=${c?.code}`);
  srv2.stop(true);
}

// 4. Client-side backpressure: server stops reading? The server cannot pause, so block the server's event loop
//    by running the server in a child process that busy-waits; measure client bufferedAmount growth.
{
  const child = Bun.spawn(["bun", "-e", `
    const s = Bun.serve({ port: 0, fetch(r, s) { return s.upgrade(r) ? undefined : new Response("x"); },
      websocket: { open(ws) { setTimeout(() => Bun.sleepSync(3000), 50); }, message() {} } });
    console.log(s.port);
  `], { stdout: "pipe" });
  const reader = child.stdout.getReader();
  const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
  const ws = await new Promise<WebSocket>((res) => { const w = new WebSocket(`ws://127.0.0.1:${port}/`, { perMessageDeflate: false } as any); w.onopen = () => res(w); });
  await sleep(100); // server now blocked in sleepSync
  const buf: string[] = [];
  for (let i = 0; i < 64; i++) { ws.send(new Uint8Array(MiB)); if (i % 16 === 15) buf.push(`${i + 1}MiB->${(ws.bufferedAmount / MiB).toFixed(1)}`); }
  await sleep(200);
  buf.push(`after200ms->${(ws.bufferedAmount / MiB).toFixed(1)}`);
  console.log(`RESULT 4 client send() 64 x 1 MiB to a blocked server; client bufferedAmount (MiB): ${buf.join(", ")}`);
  ws.close();
  child.kill(); await child.exited;
}

// 5. close codes: server-initiated with custom code, and abrupt terminate
{
  const ws = await open("closer");
  const c = new Promise<CloseEvent>(r => (ws.onclose = r));
  sockets.get("closer")!.close(4401, "lease lost");
  const e = await c;
  console.log(`RESULT 5 server close(4401,"lease lost") -> client code=${e.code} reason="${e.reason}" wasClean=${e.wasClean}`);
  const ws2 = await open("killed");
  ws2.terminate();
  await sleep(100);
  console.log(`RESULT 5 client terminate() -> server: ${serverEvents.killed.join(" | ")}`);
  let threw = "";
  const ws3 = await open("badcode");
  try { ws3.close(1006); } catch (err) { threw = `${(err as Error).name}`; }
  console.log(`RESULT 5 client close(1006) throws: ${threw || "no"}`);
  ws3.close();
}

// 6. reconnection: does the client reconnect on its own after the server closes?
{
  const ws = await open("reconnect");
  const c = new Promise<CloseEvent>(r => (ws.onclose = r));
  sockets.get("reconnect")!.close(1012, "restart");
  await c; await sleep(500);
  const opens = serverEvents.reconnect.filter(x => x === "open").length;
  console.log(`RESULT 6 after server close, readyState=${ws.readyState}, server saw ${opens} open(s) -> no automatic reconnect`);
}

// 7. idleTimeout (8 s) with sendPings default true: a silent client that answers pings survives
{
  const ws = await open("idle");
  let closedAt = 0; const s = performance.now();
  ws.onclose = () => (closedAt = performance.now() - s);
  await sleep(20000);
  console.log(`RESULT 7 silent client, idleTimeout=8, sendPings default: ${closedAt ? `closed after ${Math.round(closedAt)}ms` : "still open after 20 s"}; server events: ${serverEvents.idle.join(" | ")}`);
  ws.close();
}
// 7b. same but the client is paused (cannot answer pings)
{
  const ws = await open("idlepaused");
  ws.pause();
  let closedAt = 0; const s = performance.now();
  ws.onclose = (e) => { closedAt = performance.now() - s; log.push(`idlepaused client close ${e.code}`); };
  await sleep(20000);
  console.log(`RESULT 7b paused client (cannot pong), idleTimeout=8: ${closedAt ? `closed after ${Math.round(closedAt)}ms` : "still open after 20 s"}; server events: ${serverEvents.idlepaused.join(" | ")}`);
  ws.resume(); await sleep(100); ws.close();
}
server.stop(true);
