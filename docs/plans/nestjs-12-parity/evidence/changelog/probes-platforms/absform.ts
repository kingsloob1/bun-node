const server = Bun.serve({ port: 0, fetch(req) { return new Response(req.url + " | " + new URL(req.url).pathname); } });
const sock = await Bun.connect({ hostname: "127.0.0.1", port: server.port, socket: { data(_s, d) { console.log(new TextDecoder().decode(d).split("\r\n\r\n")[1]); _s.end(); }, open(s) { s.write("GET http://evil.example/admin/x?y=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"); } } });
await Bun.sleep(300); server.stop(true);
