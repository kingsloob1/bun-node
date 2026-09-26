// Custom ALPN on Bun.listen/Bun.connect TLS: which encodings negotiate? Run: bun tls-alpn.ts
const dir = import.meta.dir;
const tlsBase = { key: Bun.file(`${dir}/key.pem`), cert: Bun.file(`${dir}/cert.pem`) };
const wire = (...ps: string[]) => { const parts = ps.flatMap(p => [p.length, ...new TextEncoder().encode(p)]); return new Uint8Array(parts); };
const encodings: Record<string, any> = { "string": "bunjobs/1", "wire Uint8Array": wire("bunjobs/1"), "wire Buffer": Buffer.from(wire("bunjobs/1")), "wire ArrayBuffer": wire("bunjobs/1").buffer, "array": ["bunjobs/1"] };
for (const [sname, sval] of Object.entries(encodings)) {
  let srv: any;
  try { srv = Bun.listen({ hostname: "127.0.0.1", port: 0, tls: { ...tlsBase, ALPNProtocols: sval } as any, socket: { data() {} } }); }
  catch (e) { console.log(`RESULT server ALPN as ${sname}: Bun.listen threw ${(e as Error).message}`); continue; }
  for (const [cname, cval] of Object.entries(encodings)) {
    const r = await new Promise<string>((res) => {
      try { Bun.connect({ hostname: "127.0.0.1", port: srv.port, tls: { ca: Bun.file(`${dir}/cert.pem`), serverName: "localhost", ALPNProtocols: cval } as any,
        socket: { handshake(s, ok, err) { res(`ok=${ok} alpn=${JSON.stringify(s.alpnProtocol)}${err ? ` err=${err.message.slice(0, 60)}` : ""}`); s.end(); }, data() {} } }).catch(e => res(`connect threw ${(e as Error).message}`)); } catch (e) { res(`connect threw ${(e as Error).message}`); }
      setTimeout(() => res("timeout"), 2000);
    });
    console.log(`RESULT server ${sname} / client ${cname}: ${r}`);
  }
  srv.stop(true);
}
process.exit(0);
