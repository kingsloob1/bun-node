/**
 * Isolates the one thing native routes change for bun-common: *how Bun hands
 * the request over*. The same stock adapter pipeline (`handleNativeRequest`,
 * route cache on) is reached three ways:
 *
 *   fetch       the adapter's own listen() — Bun.serve `fetch`
 *   route-fn    Bun.serve routes { "/static": fn } — any-method function
 *   route-get   Bun.serve routes { "/static": { GET: fn } } — method object
 *
 * plus the trivial-handler controls (no adapter) for each. If route-* is not
 * faster than fetch here, no amount of candidate-list work can make native
 * routing pay for requests the route cache already serves.
 *
 *   bun docs/plans/evidence/bun-native-routes/spikes/dispatch-only.ts [seconds] [rounds]
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";

const seconds = Number(process.argv[2] ?? 4);
const rounds = Number(process.argv[3] ?? 3);

async function oha(url: string): Promise<number> {
  const proc = Bun.spawn(["oha", "-z", `${seconds}s`, "-c", "64", "--no-tui", "--output-format", "json", url], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return Math.round((JSON.parse(out) as { summary: { requestsPerSec: number } }).summary.requestsPerSec);
}

const lean = { request: { parseBody: false, parseCookies: false, parseQuery: false } };
type Handle = (req: Request, server: Bun.Server<unknown>) => Promise<Response | undefined>;

function adapterFor(options: object) {
  const adapter = new BunHttpAdapter(0, options);
  adapter.get("/static", (_req, res) => res.send("ok"));
  adapter.get("/user/:id", (req, res) => res.send(req.params.id));
  const handle = (adapter as unknown as { handleNativeRequest: Handle }).handleNativeRequest.bind(adapter);
  return { adapter, handle };
}

const variants: Record<string, () => Promise<{ port: number; stop: () => unknown }>> = {
  "trivial fetch": async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    return { port: s.port!, stop: () => s.stop(true) };
  },
  "trivial route-fn": async () => {
    const s = Bun.serve({ port: 0, routes: { "/static": () => new Response("ok"), "/user/:id": () => new Response("ok") }, fetch: () => new Response("nf") });
    return { port: s.port!, stop: () => s.stop(true) };
  },
  "trivial route-get": async () => {
    const s = Bun.serve({ port: 0, routes: { "/static": { GET: () => new Response("ok") }, "/user/:id": { GET: () => new Response("ok") } }, fetch: () => new Response("nf") });
    return { port: s.port!, stop: () => s.stop(true) };
  },
};
for (const [label, options] of [["lean", lean], ["defaults", {}]] as const) {
  variants[`adapter(${label}) fetch`] = async () => {
    const { adapter } = adapterFor(options);
    const s = await adapter.listen(0);
    return { port: s.port!, stop: () => adapter.close() };
  };
  variants[`adapter(${label}) route-fn`] = async () => {
    const { handle } = adapterFor(options);
    const s = Bun.serve({ port: 0, routes: { "/static": handle, "/user/:id": handle }, fetch: handle as never, websocket: { message() {} } });
    return { port: s.port!, stop: () => s.stop(true) };
  };
  variants[`adapter(${label}) route-get`] = async () => {
    const { handle } = adapterFor(options);
    const s = Bun.serve({ port: 0, routes: { "/static": { GET: handle }, "/user/:id": { GET: handle } }, fetch: handle as never, websocket: { message() {} } });
    return { port: s.port!, stop: () => s.stop(true) };
  };
}

console.log(`Bun ${Bun.version} (${Bun.revision}); oha -c 64, ${seconds}s, median of ${rounds} rounds (interleaved), NODE_ENV=${process.env.NODE_ENV}\n`);
const results: Record<string, number[]> = {};
for (let round = 0; round < rounds; round++) {
  for (const [label, start] of Object.entries(variants)) {
    for (const path of ["/static", "/user/42"]) {
      const server = await start();
      await oha(`http://127.0.0.1:${server.port}${path}`.replace(`${seconds}s`, "1s"));
      const rps = await oha(`http://127.0.0.1:${server.port}${path}`);
      (results[`${label.padEnd(28)} ${path}`] ??= []).push(rps);
      await server.stop();
    }
  }
}
for (const [label, runs] of Object.entries(results)) {
  const median = [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  console.log(`${label.padEnd(40)} ${String(median).padStart(7)}   runs ${runs.join(", ")}`);
}
