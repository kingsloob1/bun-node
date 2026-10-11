/**
 * Minimal reproduction (no dependencies): Bun.serve's `routes` matches the RAW
 * request-target, but hands the handler a `req.url` whose path has been
 * normalised (dot segments removed, `%2e` treated as `.`). The handler and its
 * params therefore describe a different path from `req.url`. A raw `#` also
 * lands inside the last param.
 *
 *   bun raw-target-routing.ts
 *
 * Expected: either the router matches the normalised path (so `/public/../admin`
 * reaches the `/admin` route, or `fetch`), or `req.url` keeps the raw path —
 * in any case the route chosen and `req.url` agree.
 * Actual (Bun 1.4.3-canary.1+5f554969b, linux x64): see the printed lines.
 */
import net from "node:net";

const server = Bun.serve({
  port: 0,
  routes: {
    "/public/:file": (req) => Response.json({ route: "/public/:file", params: req.params, url: new URL(req.url).pathname }),
    "/admin": () => Response.json({ route: "/admin" }),
  },
  fetch: (req) => Response.json({ route: "fetch", url: new URL(req.url).pathname }),
});

function raw(path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(server.port!, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(data.split("\r\n\r\n")[1]));
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  });
}

console.log(`Bun ${Bun.version} (${Bun.revision}) ${process.platform} ${process.arch}`);
for (const path of ["/public/..", "/public/%2e%2e", "/public/../admin", "/public/a.txt#frag"]) {
  console.log(`GET ${path.padEnd(20)} -> ${await raw(path)}`);
}
server.stop(true);
