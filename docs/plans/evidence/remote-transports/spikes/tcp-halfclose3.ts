// Bun client half-close vs python server, with the server's view printed: does the FIN arrive,
// and can the Bun client still read afterwards? Also the Bun-to-Bun case with the client's end() handler absent.
// Run: bun tcp-halfclose3.ts   (needs python3)
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
for (const [allowHalfOpen, how] of [[true, "shutdown(true)"], [true, "shutdown()"], [true, "end()"], [false, "shutdown(true)"], [false, "shutdown()"], [false, "end()"]] as const) {
  const py = `import socket,sys,time;l=socket.socket();l.bind(("127.0.0.1",0));l.listen();print(l.getsockname()[1],flush=True);c,_=l.accept()
b=b"";eof=False
c.settimeout(1.5)
try:
  while True:
    d=c.recv(100)
    if not d: eof=True;break
    b+=d
except Exception: pass
time.sleep(0.2)
try: c.sendall(b"reply");sent="sent"
except Exception as e: sent=type(e).__name__
print(f"server got {b!r} eof={eof} reply={sent}",flush=True);time.sleep(0.5);c.close()`;
  const p = Bun.spawn(["python3", "-c", py], { stdout: "pipe" });
  const rd = p.stdout.getReader(); const dec = new TextDecoder();
  const port = Number(dec.decode((await rd.read()).value).trim());
  const events: string[] = []; const t0 = performance.now(); const at = () => Math.round(performance.now() - t0);
  const c = await Bun.connect({ hostname: "127.0.0.1", port, allowHalfOpen, socket: { data(_s, d) { events.push(`C data "${d}"@${at()}`); }, end() { events.push(`C end@${at()}`); }, close() { events.push(`C close@${at()}`); } } });
  c.write("request");
  if (how === "shutdown(true)") c.shutdown(true); else if (how === "shutdown()") c.shutdown(); else c.end();
  const pyLine = dec.decode((await rd.read()).value).trim();
  await sleep(800);
  console.log(`RESULT Bun.connect(allowHalfOpen=${allowHalfOpen}) ${how}: python: ${pyLine}; Bun client: ${events.join(" | ")}; readyState=${c.readyState}`);
  p.kill();
}
process.exit(0);
