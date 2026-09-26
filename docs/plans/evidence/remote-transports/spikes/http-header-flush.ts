// Is the header delay a server or a client property? Raw TCP client against Bun.serve,
// and Bun fetch against a raw TCP server that sends headers immediately.
// Run: bun http-header-flush.ts
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const enc = new TextEncoder();

const server = Bun.serve({
  port: 0,
  fetch() {
    return new Response(new ReadableStream({ async start(c) { await sleep(500); c.enqueue(enc.encode("a")); c.close(); } }),
      { headers: { "content-type": "text/event-stream" } });
  },
});
{
  const s = performance.now();
  let first = -1;
  const done = Promise.withResolvers<void>();
  const sock = await Bun.connect({
    hostname: "127.0.0.1", port: server.port!,
    socket: {
      data(_s, d) { if (first < 0) { first = performance.now() - s; console.log(`RESULT raw-TCP client: first bytes from Bun.serve after ${Math.round(first)}ms:`, JSON.stringify(d.toString().split("\r\n")[0])); done.resolve(); } },
    },
  });
  sock.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
  await done.promise; sock.end();
}

// raw TCP server that writes headers now and the body 500 ms later
const raw = Bun.listen({
  hostname: "127.0.0.1", port: 0,
  socket: {
    async data(sock) {
      sock.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n");
      await sleep(500);
      sock.write("1\r\na\r\n0\r\n\r\n");
      sock.end();
    },
  },
});
{
  const s = performance.now();
  const r = await fetch(`http://127.0.0.1:${raw.port}/`);
  console.log(`RESULT Bun fetch vs raw server sending headers immediately: resolved after ${Math.round(performance.now() - s)}ms`);
  await r.text();
}
raw.stop(true);
server.stop(true);
