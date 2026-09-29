/**
 * Does Bun's router match on the raw request-target while `req.url` carries
 * a normalised path? If so, a handler for key K can receive a request whose
 * `req.url` path does not have K's shape — which a design that trusts "Bun
 * sent it to K" must guard against.
 *
 *   bun docs/plans/evidence/bun-native-routes/spikes/dot-segments.ts
 */
import net from "node:net";

const tag = (key: string) => (req: Bun.BunRequest) =>
  Response.json({ by: key, params: req.params, urlPath: new URL(req.url).pathname });
const server = Bun.serve({
  port: 0,
  routes: { "/users/:id/:x": tag("/users/:id/:x"), "/users/:id": tag("/users/:id"), "/a/b": tag("/a/b") },
  fetch: (req) => Response.json({ by: "fetch", urlPath: new URL(req.url).pathname }),
});
function raw(path: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(server.port!, "127.0.0.1");
    const chunks: Buffer[] = [];
    s.on("data", (c) => chunks.push(c));
    s.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").split("\r\n\r\n").slice(1).join("")));
    s.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  });
}
console.log(`Bun ${Bun.version} (${Bun.revision})\n`);
for (const p of ["/users/42/..", "/users/42/.", "/users/../a", "/users/%2e%2e/x", "/users/42/%2e%2e", "/a/./b", "/a//b", "/users/42?x=/../..", "/users/42#frag", "http://localhost/users/42"]) {
  console.log(`${p.padEnd(28)} -> ${await raw(p)}`);
}
server.stop(true);
