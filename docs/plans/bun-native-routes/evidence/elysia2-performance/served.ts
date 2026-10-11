/**
 * A served-path probe, not a load test: ONE process, ONE connection, the
 * client and the server (`Bun.serve`) on the same thread, a few seconds per
 * cell. The client is a raw socket writing BATCH pipelined `GET`s (as wrk
 * sends them: a Host header only) and counting status lines, so its own cost
 * is small and the same for every cell; the *differences* between cells are
 * server-side costs that only a served request has — work an in-process
 * `new Request()` loop cannot see (Bun materialises a served request's
 * headers, URL and signal lazily, on first access). A `fetch()` client was
 * tried first and dropped: ~120 us of client per request, +-15 us of noise.
 *
 *   NODE_ENV=production BUN_OPTIONS= bun served.ts [cells|...] [scenario]
 *
 * ns per request, median of 3 interleaved rounds of SECONDS_ (default 2) s.
 */
import process from "node:process";
import { makeTarget, SCENARIOS, type Serve } from "./targets";

const seconds = Number(process.env.SECONDS_ ?? 2);
const scenario = process.argv[3] ?? "static";
const probes: Record<string, (req: Request) => Response> = {
  // Framework-free handlers, each touching one more part of the request.
  "raw: new Response('ok')": () => new Response("ok"),
  "raw: + req.url": (req) => {
    void req.url;
    return new Response("ok");
  },
  "raw: + req.method": (req) => {
    void req.method;
    return new Response("ok");
  },
  "raw: + req.headers": (req) => {
    void req.headers;
    return new Response("ok");
  },
  "raw: + req.headers.get('host')": (req) => {
    void req.headers.get("host");
    return new Response("ok");
  },
  "raw: + req.signal": (req) => {
    void req.signal;
    return new Response("ok");
  },
  "raw: + req.body": (req) => {
    void req.body;
    return new Response("ok");
  },
  "raw: Promise.resolve(new Response('ok'))": () => Promise.resolve(new Response("ok")) as never,
};
const cells = (process.argv[2] ?? [...Object.keys(probes), "elysia2", "bun-common", "bun-common-lean"].join("|")).split("|");

const servers: Record<string, string> = {};
for (const cell of cells) {
  const fetch: Serve = probes[cell] ?? (await makeTarget(cell));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", development: false, fetch: (req) => fetch(req) as Response });
  servers[cell] = `http://127.0.0.1:${server.port}${new URL(SCENARIOS[scenario]().url).pathname}`;
}

const BATCH = Number(process.env.BATCH ?? 32);
/** Requests per second through one pipelined connection, for `ms`. */
async function run(url: string, ms: number): Promise<number> {
  const { port, pathname } = new URL(url);
  const one = `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`;
  const batch = Buffer.from(one.repeat(BATCH));
  const marker = "HTTP/1.1 ";
  let seen = 0;
  let tail = "";
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const end = performance.now() + ms;
  let total = 0;
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: Number(port),
    socket: {
      data(sock, chunk) {
        const text = tail + chunk.toString("latin1");
        let at = text.indexOf(marker);
        let last = -1;
        while (at !== -1) {
          seen++;
          last = at;
          at = text.indexOf(marker, at + marker.length);
        }
        tail = text.slice(last === -1 ? Math.max(0, text.length - marker.length) : last + marker.length);
        if (seen >= BATCH) {
          total += BATCH;
          seen -= BATCH;
          if (performance.now() < end) sock.write(batch);
          else done();
        }
      },
    },
  });
  const t0 = performance.now();
  socket.write(batch);
  await finished;
  const elapsed = performance.now() - t0;
  socket.end();
  return (elapsed * 1e6) / total;
}

const results: Record<string, number[]> = {};
for (const cell of cells) await run(servers[cell], 300);
for (let round = 0; round < 3; round++) {
  for (const cell of cells) (results[cell] ??= []).push(await run(servers[cell], seconds * 1000));
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[1];
const base = median(results[cells[0]]);
console.log(`Bun ${Bun.version}, scenario ${scenario}; ns/request (pipelined client + server, one thread), median of 3 x ${seconds}s\n`);
for (const cell of cells) {
  const m = median(results[cell]);
  console.log(`  ${cell.padEnd(44)} ${m.toFixed(0).padStart(7)} ns   ${(m - base >= 0 ? "+" : "") + (m - base).toFixed(0)}   [${results[cell].map((x) => x.toFixed(0)).join(", ")}]`);
}
process.exit(0);
