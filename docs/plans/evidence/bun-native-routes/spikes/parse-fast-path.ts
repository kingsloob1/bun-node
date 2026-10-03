/**
 * PR-2a: the observable state of a bodiless request, before and after the
 * parse fast path. Runs the same requests through this checkout's BunRequest
 * and through another checkout's (`BASE`, e.g. a worktree of develop), served
 * over a real socket, and prints any field that differs.
 *
 *   BASE=/path/to/develop-worktree bun spikes/parse-fast-path.ts
 */
import process from "node:process";

const BASE = process.env.BASE;
if (!BASE) throw new Error("set BASE to a checkout to compare against");
const here = await import("../../../../../packages/bun-common/lib/BunRequest");
const base = await import(`${BASE}/packages/bun-common/lib/BunRequest`);

const OPTIONS = { parseBody: true, parseCookies: true, parseQuery: true, cookieSecret: "k" };
type Req = InstanceType<typeof here.BunRequest>;

async function observe(req: Req) {
  const events: string[] = [];
  req.on("data", () => events.push("data"));
  req.on("end", () => events.push("end"));
  req.on("error", () => events.push("error"));
  const settled = await req.ready();
  await Promise.resolve();
  await Promise.resolve();
  return JSON.stringify({
    body: req.body === undefined ? "<undefined>" : req.body,
    buffer: req.buffer?.length,
    parsed: req.isBodyParsed,
    complete: req.complete,
    query: req.query,
    cookies: req.cookies,
    signed: req.signedCookies,
    tooLarge: req.isPayloadTooLarge,
    decodeErr: String(req.bodyDecodingError),
    bodyUsed: req.request.bodyUsed,
    settled: settled.map((s) => [s.status, s.status === "fulfilled" ? s.value : String(s.reason)]),
    events,
  });
}

const cases: [string, string, Record<string, string>][] = [
  ["GET", "/", {}],
  ["GET", "/a?x=1&y[z]=2&arr=1&arr=2", { cookie: "a=1; j=j:{\"k\":1}; s=s:v.bad" }],
  ["DELETE", "/d", { "content-type": "application/json" }],
  ["POST", "/p", { "content-encoding": "gzip" }],
  ["POST", "/p", { "content-type": "text/plain" }],
  ["HEAD", "/h?q", {}],
];

let diffs = 0;
for (const [method, path, headers] of cases) {
  const results: string[] = [];
  for (const Impl of [here.BunRequest, base.BunRequest]) {
    let out = "";
    const server = Bun.serve({
      port: 0,
      async fetch(request, srv) {
        const created = Impl.init(request, srv, OPTIONS);
        out = await observe((created instanceof Impl ? created : await created) as Req);
        return new Response("ok");
      },
    });
    await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers });
    server.stop(true);
    results.push(out);
  }
  const same = results[0] === results[1];
  if (!same) diffs++;
  console.log(`${same ? "same" : "DIFF"} ${method} ${path} ${JSON.stringify(headers)}`);
  if (!same) console.log(`  here ${results[0]}\n  base ${results[1]}`);
  else console.log(`  ${results[0]}`);
}
console.log(`${cases.length} cases, ${diffs} differences`);
