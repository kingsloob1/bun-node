// TLS over Bun.listen / Bun.connect. Run: bun tls.ts  (needs cert.pem/key.pem, CN=localhost, SAN 127.0.0.1)
const dir = import.meta.dir;
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const withTimeout = <T>(p: Promise<T>, ms: number, label: string) => Promise.race([p, sleep(ms).then(() => `TIMEOUT(${label})` as T)]);

async function attempt(port: number, tls: any, label: string) {
  const ev: string[] = [];
  const done = Promise.withResolvers<void>();
  try {
    const s = await Bun.connect({
      hostname: "127.0.0.1", port, tls,
      socket: {
        open(s) { ev.push("open"); /* a write here returns 0 and is dropped: see tls-write-timing.ts */ },
        handshake(s, ok, err) { ev.push(`handshake ok=${ok} authorized=${s.authorized} alpn=${s.alpnProtocol} err=${err?.message ?? null}`); if (ok) s.write("hi"); },
        data(s, d) { ev.push(`data "${d}" tls=${s.getTLSVersion()} alpn=${s.alpnProtocol}`); done.resolve(); },
        close(_s, e) { ev.push(`close ${e?.message ?? ""}`); done.resolve(); },
        error(_s, e) { ev.push(`error ${e.message}`); done.resolve(); },
        connectError(_s, e) { ev.push(`connectError ${e.message}`); done.resolve(); },
      },
    });
    await withTimeout(done.promise, 2000, label);
    s.end();
  }
  catch (e) { ev.push(`connect rejected: ${(e as Error).message}`); }
  console.log(`RESULT ${label}: ${ev.join(" | ")}`);
}

const serverEv: string[] = [];
const srv = Bun.listen({
  hostname: "127.0.0.1", port: 0,
  tls: { key: Bun.file(`${dir}/key.pem`), cert: Bun.file(`${dir}/cert.pem`) },
  socket: { data(s, d) { s.write(`echo:${d}`); }, handshake(_s, ok, err) { serverEv.push(`server handshake ok=${ok} ${err?.message ?? ""}`); } },
});
await attempt(srv.port, true, "4a tls:true (default verification) vs self-signed");
await attempt(srv.port, { rejectUnauthorized: true }, "4a' rejectUnauthorized:true vs self-signed");
await attempt(srv.port, { ca: Bun.file(`${dir}/cert.pem`), serverName: "localhost" }, "4b ca pinned");
await attempt(srv.port, { ca: Bun.file(`${dir}/cert.pem`), serverName: "wrong.example" }, "4b' ca pinned, wrong serverName");
await attempt(srv.port, { rejectUnauthorized: false }, "4b'' rejectUnauthorized:false");
srv.stop(true);

// ALPN
{
  const s2 = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    tls: { key: Bun.file(`${dir}/key.pem`), cert: Bun.file(`${dir}/cert.pem`), ALPNProtocols: "bunjobs/1" } as any,
    socket: { data(s, d) { s.write(`echo:${d}`); } },
  });
  await attempt(s2.port, { ca: Bun.file(`${dir}/cert.pem`), serverName: "localhost", ALPNProtocols: "bunjobs/1" }, "4d ALPN string both sides");
  const wire = new Uint8Array([9, ...new TextEncoder().encode("bunjobs/1")]);
  await attempt(s2.port, { ca: Bun.file(`${dir}/cert.pem`), serverName: "localhost", ALPNProtocols: wire.buffer }, "4d' ALPN wire-format client");
  s2.stop(true);
}

// mTLS
{
  let peerCN: unknown = "(none)";
  const s3 = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    tls: { key: Bun.file(`${dir}/key.pem`), cert: Bun.file(`${dir}/cert.pem`), ca: Bun.file(`${dir}/cert.pem`), requestCert: true, rejectUnauthorized: true } as any,
    socket: { open(s) { try { peerCN = s.getPeerCertificate()?.subject?.CN; } catch (e) { peerCN = (e as Error).message; } }, data(s, d) { s.write(`ok:${d}`); } },
  });
  await attempt(s3.port, { ca: Bun.file(`${dir}/cert.pem`), serverName: "localhost", key: Bun.file(`${dir}/key.pem`), cert: Bun.file(`${dir}/cert.pem`) }, "4c mTLS with client cert");
  console.log(`RESULT 4c server saw peer CN=${peerCN}`);
  await attempt(s3.port, { ca: Bun.file(`${dir}/cert.pem`), serverName: "localhost" }, "4c' mTLS without client cert");
  s3.stop(true);
}
console.log("server events:", serverEv);
process.exit(0);
