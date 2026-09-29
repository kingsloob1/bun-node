/**
 * What `Bun.serve({ routes })` does on this Bun, point by point — the facts
 * the plan's semantics analysis rests on. Each probe sends one raw request
 * and prints who answered (`route:<key>`, `fetch`, or Bun itself) plus the
 * params Bun handed over.
 *
 *   bun docs/plans/evidence/bun-native-routes/spikes/semantics.ts
 *
 * Raw requests go through `node:net` so the path is sent byte for byte
 * (`fetch()` would normalise `..`, `//` and escapes before Bun saw them).
 */
import net from "node:net";

type Handler = (req: Bun.BunRequest, server: Bun.Server<undefined>) => Response | Promise<Response> | undefined;

/** A route handler that reports which route key answered and its params. */
function tag(key: string): Handler {
  return (req) =>
    Response.json({ by: `route:${key}`, method: req.method, params: req.params, url: new URL(req.url).pathname });
}

const routes: Record<string, unknown> = {
  // precedence: registered param-first on purpose
  "/users/:id": tag("/users/:id"),
  "/users/new": tag("/users/new"),
  "/users/*": tag("/users/*"),
  "/files/*": tag("/files/*"),
  // two dynamic routes that both match /x/b
  "/:a/b": tag("/:a/b"),
  "/x/:b": tag("/x/:b"),
  "/deep/:a/*": tag("/deep/:a/*"),
  "/deep/*": tag("/deep/*"),
  // trailing slash / case
  "/a": tag("/a"),
  "/b/": tag("/b/"),
  "/Case": tag("/Case"),
  // decoding
  "/p/:x": tag("/p/:x"),
  // syntax Bun may or may not support
  "/opt/:a?": tag("/opt/:a?"),
  "/re/:id(\\d+)": tag("/re/:id(\\d+)"),
  "/named/*rest": tag("/named/*rest"),
  "/mid/:a-:b": tag("/mid/:a-:b"),
  // "/two/:a/:a" throws at Bun.serve() — see syntax.ts
  // methods
  "/m": { GET: tag("/m GET"), POST: tag("/m POST") },
  "/bare": tag("/bare"),
  "/static": new Response("static-body", { headers: { "x-static": "1" } }),
  // behaviour of handlers
  "/undef": (() => undefined) as unknown as Handler,
  "/throw": () => {
    throw new Error("boom");
  },
  "/reject": async () => {
    throw new Error("async boom");
  },
  "/upgrade": ((req, server) =>
    server.upgrade(req, { data: undefined }) ? undefined : new Response("no upgrade", { status: 400 })) as Handler,
  "/caf%C3%A9": tag("/caf%C3%A9"), // "/café" throws — see syntax.ts
};

const server = Bun.serve({
  port: 0,
  routes: routes as Record<string, Handler>,
  fetch(req) {
    return Response.json({ by: "fetch", method: req.method, url: new URL(req.url).pathname });
  },
  error(err) {
    return new Response(`error(): ${(err as Error).message}`, { status: 500 });
  },
  websocket: {
    open(ws) {
      ws.send("hi");
      ws.close();
    },
    message() {},
  },
});

/** Sends one raw HTTP/1.1 request and resolves `status + body`. */
function raw(method: string, path: string, extra = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(server.port!, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${extra}\r\n`);
  });
}

function summarise(response: string): string {
  const [head, ...rest] = response.split("\r\n\r\n");
  const status = head.split("\r\n")[0].replace("HTTP/1.1 ", "");
  const allow = /\r\nallow: ([^\r]*)/i.exec(head)?.[1];
  const cl = /\r\ncontent-length: ([^\r]*)/i.exec(head)?.[1];
  let body = rest.join("\r\n\r\n");
  // chunked
  if (/transfer-encoding: chunked/i.test(head)) {
    body = body.replace(/^[0-9a-f]+\r\n/i, "").replace(/\r\n0\r\n\r\n$/, "");
  }
  return `${status}${allow ? ` allow=${allow}` : ""}${cl !== undefined ? ` cl=${cl}` : ""} ${body.slice(0, 160)}`;
}

const probes: [string, string, string?][] = [
  ["GET", "/users/new"],
  ["GET", "/users/42"],
  ["GET", "/users/42/posts"],
  ["GET", "/users/"],
  ["GET", "/users"],
  ["GET", "/files"],
  ["GET", "/files/"],
  ["GET", "/files/a/b%20c"],
  ["GET", "/x/b"],
  ["GET", "/deep/1/2"],
  ["GET", "/deep/1"],
  ["GET", "/a"],
  ["GET", "/a/"],
  ["GET", "/b"],
  ["GET", "/b/"],
  ["GET", "/case"],
  ["GET", "/CASE"],
  ["GET", "/Case"],
  ["GET", "/p/hello%20world"],
  ["GET", "/p/a%2Fb"],
  ["GET", "/p/%E2%82%AC"],
  ["GET", "/p/a+b"],
  ["GET", "/p/%E0%A4%A"],
  ["GET", "/p/%zz"],
  ["GET", "/p/"],
  ["GET", "/opt"],
  ["GET", "/opt/1"],
  ["GET", "/opt/:a?"],
  ["GET", "/re/12"],
  ["GET", "/re/abc"],
  ["GET", "/named/x/y"],
  ["GET", "/mid/1-2"],
  ["GET", "/two/1/2"],
  ["GET", "/m"],
  ["HEAD", "/m"],
  ["POST", "/m"],
  ["PUT", "/m"],
  ["OPTIONS", "/m"],
  ["DELETE", "/bare"],
  ["HEAD", "/bare"],
  ["GET", "/static"],
  ["HEAD", "/static"],
  ["POST", "/static"],
  ["GET", "/undef"],
  ["GET", "/throw"],
  ["GET", "/reject"],
  ["GET", "/a?x=1"],
  ["GET", "//a"],
  ["GET", "/x/../a"],
  ["GET", "/%61"],
  ["GET", "/caf%C3%A9"],
  ["GET", "/nothing"],
  ["GET", "/upgrade", "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"],
];

console.log(`Bun ${Bun.version} (${Bun.revision})\n`);
for (const [method, path, extra] of probes) {
  try {
    const result = await Promise.race([
      raw(method, path, extra),
      Bun.sleep(1500).then(() => "TIMEOUT\r\n\r\n"),
    ]);
    console.log(`${method.padEnd(7)} ${path.padEnd(20)} -> ${summarise(result)}`);
  } catch (error) {
    console.log(`${method.padEnd(7)} ${path.padEnd(20)} -> socket error ${(error as Error).message}`);
  }
}

server.stop(true);
