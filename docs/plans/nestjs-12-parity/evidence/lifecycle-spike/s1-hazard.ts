// S1: does a graceful stop(false) leave an idle keep-alive connection serving the OLD server
// after a new one binds the same port? Variants: idle at stop, busy at stop.
import { conn, sleep } from "./raw";
const mode = process.argv[2] ?? "false"; // "false" | "true" | "none"(no stop at all: just rebind with reusePort)
const reusePort = process.argv[3] === "reuse";
const out: Record<string, unknown> = { bun: Bun.revision, mode, reusePort };

const A = Bun.serve({ port: 0, hostname: "127.0.0.1", reusePort, fetch: async (req) => {
  if (new URL(req.url).pathname === "/slow") await sleep(400);
  return new Response("A");
} });
const port = A.port!;
const idle = conn(port); await idle.ready;
const busy = conn(port); await busy.ready;
out.idleFirst = await idle.request("/");
const busyInflight = busy.request("/slow");
await sleep(50);
out.pendingAtStop = A.pendingRequests;
const t0 = performance.now();
let stopped = false;
const stopP = mode === "none" ? Promise.resolve() : A.stop(mode === "true").then(() => { stopped = true; out.stopResolvedMs = Math.round(performance.now() - t0); });
await sleep(20);
out.idleClosedAfterStop20ms = idle.closed;
let B: ReturnType<typeof Bun.serve> | undefined;
try {
  B = Bun.serve({ port, hostname: "127.0.0.1", reusePort, fetch: () => new Response("B") });
  out.rebind = "ok";
} catch (e) { out.rebind = String(e).slice(0, 80); }
out.busyInflight = await busyInflight;
await sleep(20);
out.busyClosedAfterResponse = busy.closed;
out.idleSecond = await idle.request("/");
out.busySecond = await busy.request("/");
const fresh = conn(port); await fresh.ready.catch(() => {});
out.freshConn = await fresh.request("/");
await Promise.race([stopP, sleep(1500)]);
out.stopResolved = stopped;
console.log(JSON.stringify(out, null, 1));
idle.end(); busy.end(); fresh.end();
A.stop(true); B?.stop(true);
process.exit(0);
