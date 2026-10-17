/**
 * The channel under load. Heavy: run through the wrapper, alone.
 *
 *   bun docs/plans/bun-native-routes/evidence/sse/channel-perf.ts [rounds=3] [--out results/channel-perf.json]
 *   CHANNEL_PERF_SMOKE=1 bun …/channel-perf.ts 1 --out /tmp/x.json      (tiny shapes)
 *
 * Fan-out (one server process and one client process per cell, like perf.ts):
 *   A  N raw-TCP readers + optionally one client that never reads (a Python
 *      socket with a 64 KiB receive buffer, as backpressure.ts), M events of
 *      58 bytes each, through `channel.handler()` on bun-common's adapter.
 *      Events/s delivered to the readers, with and without the stalled one,
 *      for the stock writer (`proto`) and the shared-promise one (`shared`).
 *   B  the same, broadcasting until the stalled client is dropped: bytes
 *      offered to it, time from the first event, server RSS at that moment.
 * In-process:
 *   C  `send()` cost per event: 1,000 and 100 no-op subscribers, broadcast vs
 *      one topic of 10, topic index vs scan.
 *   D  registry memory per subscriber (heap delta of attach() alone).
 */
import type { SseChannelWriter } from "./channel-prototype";
import { join, resolve } from "node:path";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { createSseChannel } from "./channel-prototype";
import { sseShared } from "./channel-writer";
import { sse } from "./prototype-sse";

const [mode] = process.argv.slice(2);
const tick = () => new Promise<void>((r) => setImmediate(r));
const load = async () => (await Bun.file("/proc/loadavg").text()).split(" ").slice(0, 3).join(" ");
const rss = (gc = true) => (gc && Bun.gc(true), process.memoryUsage().rss);

if (mode === "server") {
  // server <proto|shared> <eventBytes>
  const [, writer, size] = process.argv.slice(2);
  const payload = "x".repeat(Number(size) - 8); // "data: " + payload + "\n\n"
  const channel = createSseChannel({ heartbeatMs: 0, createWriter: writer === "shared" ? sseShared : sse });
  let dropped: { at: number; sentToSlow: number; rss: number } | undefined;
  let sentSinceGo = 0;
  let go0 = 0;
  let slowSince = 0;
  const a = new BunHttpAdapter(0, { logger: noopLogger, server: { idleTimeout: 255 } });
  a.get("/e", (req, res) => {
    const sub = channel.subscribe(req, res);
    if (req.query.slow && sub) {
      slowSince = sentSinceGo;
      sub.writer!.onClose(() => (dropped ??= { at: performance.now() - go0, sentToSlow: sentSinceGo - slowSince, rss: rss(false) }));
    }
  });
  a.get("/size", (_q, res) => res.send(String(channel.size)));
  a.get("/mem", (_q, res) => res.send(String(rss())));
  a.get("/dropped", (_q, res) => res.json(dropped ?? null));
  a.post("/go", async (req, res) => {
    // m events (or, with until=dropped, until the stalled client is dropped), 100 per macrotask.
    const m = Number(req.query.m);
    go0 = performance.now();
    for (let sent = 0; req.query.until === "dropped" ? !dropped && sent < 5e6 : sent < m; sent += 100) {
      for (let i = 0; i < 100; i++) channel.send({ data: payload });
      sentSinceGo += 100;
      await tick();
    }
    res.json({ sent: sentSinceGo, ms: performance.now() - go0 });
  });
  console.log(`PORT ${(await a.listen(0)).port}`);
} else if (mode === "clients") {
  // clients <port> <readers> <events> <slow 0|1> <until: count|dropped>
  const [, p, nArg, mArg, slowArg, until] = process.argv.slice(2);
  const [port, n, m] = [Number(p), Number(nArg), Number(mArg)];
  const base = `http://127.0.0.1:${port}`;
  let slow: Bun.Subprocess | undefined;
  if (slowArg === "1") {
    slow = Bun.spawn(["python3", "-c", `import socket,time\ns=socket.socket()\ns.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,65536)\ns.connect(("127.0.0.1",${port}))\ns.send(b"GET /e?slow=1 HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n")\ntime.sleep(600)`]);
    while (Number(await (await fetch(`${base}/size`)).text()) < 1) await Bun.sleep(20);
  }
  const counts = new Uint32Array(n);
  const targets = new Float64Array(n).fill(Infinity);
  const last = new Uint8Array(n);
  let ready = 0;
  let done = 0;
  let onReady = () => {};
  let onDone = () => {};
  const sockets = await Promise.all(Array.from({ length: n }, (_, k) => Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      open: (s) => void s.write("GET /e HTTP/1.1\r\nHost: x\r\n\r\n"),
      data(_s, buf) {
        let c = 0;
        if (last[k] === 10 && buf[0] === 10) c++;
        for (let i = buf.indexOf(10); i !== -1 && i < buf.length - 1; i = buf.indexOf(10, i + 1)) if (buf[i + 1] === 10) c++;
        last[k] = buf[buf.length - 1];
        if (counts[k] === 0 && c > 0 && ++ready === n) onReady();
        counts[k] += c;
        if (counts[k] >= targets[k]) {
          targets[k] = Infinity;
          if (++done === n) onDone();
        }
      },
    },
  })));
  if (ready < n) await new Promise<void>((r) => (onReady = r));
  await Bun.sleep(200);
  const memIdle = Number(await (await fetch(`${base}/mem`)).text());
  const before = Array.from(counts);
  if (until !== "dropped") for (let k = 0; k < n; k++) targets[k] = counts[k] + m;
  const all = until === "dropped" ? Promise.resolve() : new Promise<void>((r) => (onDone = r));
  const g0 = performance.now();
  const go = await (await fetch(`${base}/go?m=${m}&until=${until}`, { method: "POST" })).json() as { sent: number };
  await all;
  const deliverMs = performance.now() - g0;
  const delivered = counts.reduce((s, c, k) => s + c - before[k], 0);
  const memAfter = Number(await (await fetch(`${base}/mem`)).text());
  const dropped = await (await fetch(`${base}/dropped`)).json();
  const sizeAfter = Number(await (await fetch(`${base}/size`)).text());
  console.log(JSON.stringify({ n, delivered, sent: go.sent, deliverMs, eventsPerSec: Math.round(delivered / (deliverMs / 1000)), memIdle, memAfter, dropped, sizeAfter }));
  for (const s of sockets) s.end();
  slow?.kill();
  process.exit(0);
} else if (mode === "micro") {
  // Holds its close listener, as a real writer does, so the registry's closure is counted.
  const noop = (): SseChannelWriter & { l: (() => void)[] } => ({ l: [], send() {}, closed: false, onClose(fn) { this.l.push(fn); }, close() {} });
  const out: Record<string, number> = {};
  for (const subs of [1000, 100]) {
    for (const [label, routing, topic] of [["broadcast", "index", undefined], ["topic-index", "index", "t3"], ["topic-scan", "scan", "t3"]] as const) {
      const ch = createSseChannel({ heartbeatMs: 0, routing });
      for (let i = 0; i < subs; i++) ch.attach(noop(), { topics: label === "broadcast" ? [] : [`t${i % 10}`] });
      const sends = 200_000_000 / subs / 10;
      for (let i = 0; i < 2000; i++) ch.send({ data: "warm" }, { topic });
      const t0 = Bun.nanoseconds();
      for (let i = 0; i < sends; i++) ch.send({ data: "x".repeat(50) }, { topic });
      out[`send ns/event ${subs} subs ${label}`] = Math.round((Bun.nanoseconds() - t0) / sends);
      ch.close();
    }
  }
  for (const [label, topics] of [["no topics", []], ["3 topics", ["a", "b", "c"]]] as const) {
    const N = 100_000;
    const writers = Array.from({ length: N }, noop);
    const ch = createSseChannel({ heartbeatMs: 0 });
    Bun.gc(true);
    const h0 = process.memoryUsage().heapUsed;
    for (const w of writers) ch.attach(w, { topics });
    Bun.gc(true);
    out[`registry bytes/subscriber, ${label}`] = Math.round((process.memoryUsage().heapUsed - h0) / N);
    ch.close();
  }
  console.log(JSON.stringify(out));
  process.exit(0);
} else {
  const dir = import.meta.dir;
  const rounds = Number(process.argv[2] ?? 3);
  const outIdx = process.argv.indexOf("--out");
  const outFile = outIdx > 0 ? resolve(dir, process.argv[outIdx + 1]) : join(dir, "results/channel-perf.json");
  const smoke = !!process.env.CHANNEL_PERF_SMOKE;
  // [label, writer, readers, events, slow, until, eventBytes]
  type Cell = [string, "proto" | "shared", number, number, 0 | 1, "count" | "dropped", number];
  const cells: Cell[] = [];
  for (const w of ["proto", "shared"] as const) {
    for (const [n, m] of smoke ? [[20, 200]] : [[1000, 1000], [100, 10_000]]) {
      cells.push([`A ${n}x${m}`, w, n, m, 0, "count", 58], [`A ${n}x${m} +slow`, w, n, m, 1, "count", 58]);
    }
    cells.push([`B ${smoke ? 20 : 100}+slow until dropped, 58 B`, w, smoke ? 20 : 100, 0, 1, "dropped", 58]);
    if (!smoke) cells.push([`B 1000+slow until dropped, 4 KiB`, w, 1000, 0, 1, "dropped", 4096]);
  }
  const runs: Record<string, unknown>[] = [];
  const spawnServer = async (w: string, size: number) => {
    const server = Bun.spawn(["bun", import.meta.path, "server", w, String(size)], { stdout: "pipe", stderr: "inherit", env: { ...process.env, NODE_ENV: "production" } });
    const reader = server.stdout.getReader();
    let text = "";
    while (!/PORT (\d+)/.test(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`server exited: ${text}`);
      text += new TextDecoder().decode(value);
    }
    return { server, port: Number(/PORT (\d+)/.exec(text)![1]) };
  };
  for (let round = 1; round <= rounds; round++) {
    for (const [label, w, n, m, slow, until, size] of cells) {
      const { server, port } = await spawnServer(w, size);
      const baseRss = Number(await (await fetch(`http://127.0.0.1:${port}/mem`)).text());
      const l0 = await load();
      const client = Bun.spawn(["bun", import.meta.path, "clients", String(port), String(n), String(m), String(slow), until], { stdout: "pipe", stderr: "inherit" });
      const text = await Promise.race([new Response(client.stdout).text(), Bun.sleep(240_000).then(() => "")]);
      client.kill();
      server.kill();
      await server.exited;
      if (!text.trim()) {
        console.log(`r${round} ${label} ${w}: timed out`);
        continue;
      }
      const r = { round, label, writer: w, load: l0, baseRss, ...JSON.parse(text) };
      runs.push(r);
      const d = r.dropped as { at: number; sentToSlow: number; rss: number } | null;
      console.log(`r${round} ${label.padEnd(34)} ${w.padEnd(6)} ${String(r.eventsPerSec).padStart(9)} ev/s  idle ${((r.memIdle - baseRss) / 1048576).toFixed(1)} MiB  after ${((r.memAfter - baseRss) / 1048576).toFixed(1)} MiB${d ? `  dropped @${d.at.toFixed(0)} ms after ${(d.sentToSlow * size / 1048576).toFixed(1)} MiB offered, rss@drop +${((d.rss - baseRss) / 1048576).toFixed(1)} MiB` : slow ? "  slow still connected" : ""}  size after ${r.sizeAfter}  load ${l0}`);
    }
    const micro = Bun.spawn(["bun", import.meta.path, "micro"], { stdout: "pipe", stderr: "inherit", env: { ...process.env, NODE_ENV: "production" } });
    const mr = { round, label: "micro", load: await load(), ...JSON.parse(await new Response(micro.stdout).text()) };
    runs.push(mr);
    console.log(`r${round} micro ${JSON.stringify(mr)}`);
  }
  await Bun.write(outFile, JSON.stringify({ bun: Bun.revision, date: new Date().toISOString(), cores: navigator.hardwareConcurrency, runs }, null, 2));
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`\nmedian of ${rounds} round(s); load at the end ${await load()}`);
  for (const [label, w] of cells) {
    const rs = runs.filter((r) => r.label === label && r.writer === w) as Record<string, number & Record<string, number>>[];
    if (!rs.length) continue;
    const drops = rs.map((r) => r.dropped as unknown as { at: number; sentToSlow: number; rss: number } | null).filter((d) => d !== null);
    const size = cells.find((c) => c[0] === label)![6];
    console.log(`${label.padEnd(34)} ${w.padEnd(6)} ${String(med(rs.map((r) => r.eventsPerSec))).padStart(9)} ev/s  idle ${(med(rs.map((r) => r.memIdle - r.baseRss)) / 1048576).toFixed(1)} MiB` + (drops.length ? `  dropped ${drops.length}/${rs.length}, @${med(drops.map((d) => d.at)).toFixed(0)} ms, ${(med(drops.map((d) => d.sentToSlow)) * size / 1048576).toFixed(1)} MiB offered, rss@drop +${(med(drops.map((d, i) => d.rss - rs[i].baseRss)) / 1048576).toFixed(1)} MiB` : ""));
  }
  const micros = runs.filter((r) => r.label === "micro");
  for (const k of Object.keys(micros[0] ?? {}).filter((k) => !["round", "label", "load"].includes(k))) console.log(`${k.padEnd(48)} ${med(micros.map((r) => r[k] as number))}`);
  process.exit(0);
}
