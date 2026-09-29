/**
 * `server.reload({ routes })` on this Bun: its cost as the table grows, what
 * happens to a request in flight across it, whether an open WebSocket
 * survives it, and whether requests during a reload storm ever miss.
 *
 *   bun docs/plans/evidence/bun-native-routes/spikes/reload.ts
 */
type Routes = Record<string, (req: Bun.BunRequest, server: Bun.Server<undefined>) => Response | Promise<Response> | undefined>;

function table(n: number, tag: string): Routes {
  const routes: Routes = {};
  for (let i = 0; i < n; i++) routes[`/r${i}/:id`] = () => new Response(`${tag}${i}`);
  return routes;
}

console.log(`Bun ${Bun.version} (${Bun.revision})\n`);

// 1. Cost of reload() by table size (best of 5)
const fetchFallback = () => new Response("fetch", { status: 404 });
const websocket: Bun.WebSocketHandler<undefined> = {
  message(ws, msg) {
    ws.send(`echo:${msg}`);
  },
};
const server = Bun.serve({ port: 0, routes: table(1, "v0-"), fetch: fetchFallback, websocket });
for (const n of [10, 100, 1000, 5000]) {
  const next = table(n, "v1-");
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    server.reload({ routes: next, fetch: fetchFallback, websocket });
    best = Math.min(best, performance.now() - t0);
  }
  const t0 = performance.now();
  const fresh = Bun.serve({ port: 0, routes: next, fetch: fetchFallback, websocket });
  const serveMs = performance.now() - t0;
  fresh.stop(true);
  console.log(`reload() with ${String(n).padStart(4)} routes: ${best.toFixed(3)} ms   (Bun.serve() with the same table: ${serveMs.toFixed(3)} ms)`);
}

// 2. Does reload() without `fetch` keep the old fallback? Without `websocket`?
server.reload({ routes: { "/only": () => new Response("only") } } as never);
const probe = await fetch(`${server.url}nothing`).then(async (r) => `${r.status} ${await r.text()}`);
console.log(`\nreload({ routes }) alone, then GET /nothing -> ${probe}`);

// 3. In-flight request across a reload: the old handler finishes; new requests see the new table
let release!: () => void;
const gate = new Promise<void>((resolve) => (release = resolve));
server.reload({
  routes: {
    "/slow": async () => {
      await gate;
      return new Response("old-slow");
    },
    "/which": () => new Response("old"),
  },
  fetch: fetchFallback,
  websocket,
});
const inflight = fetch(`${server.url}slow`).then((r) => r.text());
await Bun.sleep(50);
server.reload({ routes: { "/which": () => new Response("new") }, fetch: fetchFallback, websocket });
const afterReload = await fetch(`${server.url}which`).then((r) => r.text());
const slowAfter = await fetch(`${server.url}slow`).then(async (r) => `${r.status} ${await r.text()}`);
release();
console.log(`in-flight /slow started before reload -> ${await inflight}`);
console.log(`/which after reload -> ${afterReload}; /slow after reload -> ${slowAfter}`);

// 4. WebSocket opened before a reload keeps working after it
server.reload({
  routes: { "/ws": (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })) },
  fetch: fetchFallback,
  websocket,
});
const ws = new WebSocket(`${server.url.href.replace("http", "ws")}ws`);
await new Promise((resolve) => (ws.onopen = resolve));
server.reload({ routes: table(100, "v2-"), fetch: fetchFallback, websocket });
ws.send("after-reload");
const echoed = await new Promise<string>((resolve) => (ws.onmessage = (e) => resolve(String(e.data))));
console.log(`websocket opened before reload, message after -> ${echoed}`);
ws.close();

// 5. Reload storm under load: every request must be answered by *some* table
server.reload({ routes: table(200, "a-"), fetch: fetchFallback, websocket });
let stop = false;
let reloads = 0;
const storm = (async () => {
  while (!stop) {
    server.reload({ routes: table(200, reloads % 2 ? "a-" : "b-"), fetch: fetchFallback, websocket });
    reloads++;
    await Bun.sleep(0);
  }
})();
const counts: Record<string, number> = {};
const clients = Array.from({ length: 32 }, async () => {
  for (let i = 0; i < 300; i++) {
    const r = await fetch(`${server.url}r150/x`);
    const text = await r.text();
    const key = `${r.status} ${text.replace(/\d+$/, "N")}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
});
await Promise.all(clients);
stop = true;
await storm;
console.log(`reload storm: ${reloads} reloads during 9600 requests -> ${JSON.stringify(counts)}`);

server.stop(true);
