// Follow-up to http-header-flush2.ts: what exactly has Bun.serve written 300 ms into a streamed
// response whose first chunk is at 500 ms? Run: bun http-header-flush3.ts
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const server = Bun.serve({
  port: 0,
  fetch() {
    return new Response(new ReadableStream({ async start(c) { await sleep(500); c.enqueue(new TextEncoder().encode("a")); c.close(); } }),
      { headers: { "content-type": "text/event-stream" } });
  },
});
let buf = ""; let at300 = "";
const sock = await Bun.connect({ hostname: "127.0.0.1", port: server.port!, socket: { data(_s, d) { buf += d.toString(); } } });
sock.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
await sleep(300); at300 = buf;
await sleep(400);
console.log("RESULT bytes at 300ms:", JSON.stringify(at300));
console.log("RESULT bytes at 700ms:", JSON.stringify(buf));
sock.end(); server.stop(true);
