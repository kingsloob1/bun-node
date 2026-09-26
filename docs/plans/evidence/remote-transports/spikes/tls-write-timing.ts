// When a TLS client declares a handshake() handler, open() fires before the handshake completes.
// Is a write() made in open() delivered? Compare with writing in handshake(), and with no handshake handler.
// Run: bun tls-write-timing.ts
const dir = import.meta.dir;
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
let serverGot: string[] = [];
const srv = Bun.listen({
  hostname: "127.0.0.1", port: 0,
  tls: { key: Bun.file(`${dir}/key.pem`), cert: Bun.file(`${dir}/cert.pem`) },
  socket: { data(s, d) { serverGot.push(String(d)); s.write(`echo:${d}`); } },
});
const tls = { ca: Bun.file(`${dir}/cert.pem`), serverName: "localhost" };
for (const mode of ["write in open, handshake handler present", "write in handshake()", "write in open, no handshake handler"]) {
  serverGot = [];
  const ev: string[] = [];
  const handlers: any = {
    open(s: any) { ev.push("open"); if (mode !== "write in handshake()") ev.push(`write->${s.write("hi")}`); },
    data(_s: any, d: any) { ev.push(`data "${d}"`); },
  };
  if (mode !== "write in open, no handshake handler") handlers.handshake = (s: any, ok: boolean) => { ev.push(`handshake ok=${ok}`); if (mode === "write in handshake()") ev.push(`write->${s.write("hi")}`); };
  const c = await Bun.connect({ hostname: "127.0.0.1", port: srv.port, tls, socket: handlers });
  await sleep(500);
  console.log(`RESULT ${mode}: client ${ev.join(" | ")}; server got ${JSON.stringify(serverGot)}`);
  c.end();
}
srv.stop(true);
process.exit(0);
