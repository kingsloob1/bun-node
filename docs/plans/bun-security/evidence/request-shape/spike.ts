// Spike: what Bun.serve hands a handler for unusual request lines and headers,
// sent over a raw TCP socket so no client normalises them first.
// Run: bun spike.ts   (loopback only; no timing is measured)
const seen: unknown[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url);
    seen.push({ method: req.method, url: req.url, pathname: u.pathname, host: req.headers.get("host") });
    return new Response("ok");
  },
});

async function raw(request: string): Promise<string> {
  return await new Promise((resolve) => {
    let buf = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        open(s) {
          s.write(request);
        },
        data(_s, d) {
          buf += new TextDecoder().decode(d);
        },
        close() {
          resolve(buf.split("\r\n")[0] ?? "");
        },
        error() {
          resolve(`error; got: ${buf.split("\r\n")[0]}`);
        },
      },
    });
  });
}

const cases: Record<string, string> = {
  dotSegments: "GET /a/../admin HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  encodedDots: "GET /a/%2e%2e/admin HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  encodedSlash: "GET /admin%2Fsecret HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  doubleSlash: "GET //admin//x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  backslash: "GET /a\\..\\admin HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  absoluteForm: "GET http://evil.example/admin HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  oddMethod: "FOO / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  lowerMethod: "get / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  noHost: "GET / HTTP/1.1\r\nConnection: close\r\n\r\n",
  twoHosts: "GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\nConnection: close\r\n\r\n",
  header20k: `GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(20_000)}\r\nConnection: close\r\n\r\n`,
  header100k: `GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(100_000)}\r\nConnection: close\r\n\r\n`,
  clAndTe:
    "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n",
};
const statusLines: Record<string, string> = {};
for (const [name, req] of Object.entries(cases)) {
  const before = seen.length;
  statusLines[name] = await raw(req);
  (statusLines as Record<string, unknown>)[`${name}.handler`] = seen.length > before ? seen[seen.length - 1] : "handler not reached";
}
server.stop(true);
console.log(JSON.stringify({ bun: Bun.version, revision: Bun.revision, results: statusLines }, null, 2));
