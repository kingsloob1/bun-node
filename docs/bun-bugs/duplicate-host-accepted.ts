// Minimal Bun-only reproduction: Bun.serve accepts an HTTP/1.1 request with two
// Host header lines. RFC 9112 §3.2: "A server MUST respond with a 400 (Bad
// Request) status code to any HTTP/1.1 request message that lacks a Host header
// field and to any request message that contains more than one Host header
// field line or a Host header field with an invalid field value."
// Expected: 400 Bad Request, handler not called. Exits 1 while the bug is present.
let reached = false;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    reached = true;
    return new Response(`url=${req.url} host=${req.headers.get("host")}`);
  },
});
const reply: string = await new Promise((resolve) => {
  let buf = "";
  Bun.connect({
    hostname: "127.0.0.1",
    port: server.port,
    socket: {
      open: (s) => void s.write("GET / HTTP/1.1\r\nHost: a.example\r\nHost: b.example\r\nConnection: close\r\n\r\n"),
      data: (_s, d) => void (buf += new TextDecoder().decode(d)),
      close: () => resolve(buf),
      error: () => resolve(buf),
    },
  });
});
server.stop(true);
console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)})`);
console.log(reply.split("\r\n")[0], "| body:", reply.split("\r\n\r\n")[1]);
if (reached) {
  console.log("BUG: handler reached with two Host header lines");
  process.exit(1);
}
console.log("OK: rejected");
