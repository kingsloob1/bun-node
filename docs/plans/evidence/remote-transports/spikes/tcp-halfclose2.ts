// Half-close against a non-Bun peer (python3), to separate Bun's server side from its client side.
// Run: bun tcp-halfclose2.ts   (needs python3)
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
// A. Bun server (allowHalfOpen true/false) vs python client: send, SHUT_WR, read reply until EOF
for (const allowHalfOpen of [false, true]) {
  const events: string[] = [];
  const srv = Bun.listen({
    hostname: "127.0.0.1", port: 0, allowHalfOpen,
    socket: {
      data(_s, d) { events.push(`S data "${d}"`); },
      end(s) { events.push("S end"); events.push(`S write-after-FIN=${s.write("reply-after-fin")}`); s.end(); },
      close() { events.push("S close"); },
    },
  });
  const py = `import socket;s=socket.create_connection(("127.0.0.1",${srv.port}));s.sendall(b"request");s.shutdown(socket.SHUT_WR);s.settimeout(2)
b=b""
try:
  while True:
    d=s.recv(100)
    if not d: break
    b+=d
except Exception as e: b+=("<"+type(e).__name__+">").encode()
print(b.decode())`;
  const p = Bun.spawn(["python3", "-c", py], { stdout: "pipe" });
  const out = (await new Response(p.stdout).text()).trim();
  await sleep(100);
  console.log(`RESULT A Bun.listen(allowHalfOpen=${allowHalfOpen}) vs python client (send, SHUT_WR, read to EOF): python read "${out}"; server events ${events.join(" | ")}`);
  srv.stop(true);
}
// B. python server (read to EOF, then reply, close) vs Bun client shutdown(true)
for (const allowHalfOpen of [false, true]) {
  const py = `import socket,sys;l=socket.socket();l.bind(("127.0.0.1",0));l.listen();print(l.getsockname()[1],flush=True);c,_=l.accept()
b=b""
while True:
  d=c.recv(100)
  if not d: break
  b+=d
c.sendall(b"reply-to-"+b);c.close();print(b.decode(),flush=True)`;
  const p = Bun.spawn(["python3", "-c", py], { stdout: "pipe" });
  const rd = p.stdout.getReader();
  const port = Number(new TextDecoder().decode((await rd.read()).value).trim().split("\n")[0]);
  const events: string[] = [];
  const c = await Bun.connect({ hostname: "127.0.0.1", port, allowHalfOpen, socket: { data(_s, d) { events.push(`C data "${d}"`); }, end() { events.push("C end"); }, close() { events.push("C close"); } } });
  c.write("request"); c.shutdown(true);
  await sleep(1000);
  console.log(`RESULT B python server vs Bun.connect(allowHalfOpen=${allowHalfOpen}) write+shutdown(true): client events ${events.join(" | ")}`);
  p.kill();
}
process.exit(0);
