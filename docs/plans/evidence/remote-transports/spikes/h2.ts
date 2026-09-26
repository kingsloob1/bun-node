// HTTP/2 spike: Bun.serve({ http2 }) + fetch({ protocol: "http2" }), and node:http2 (server, client, trailers).
// Run: bun h2.ts   (needs cert.pem / key.pem)
import http2 from "node:http2";
const dir = import.meta.dir;
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const enc = new TextEncoder(); const dec = new TextDecoder();
const key = await Bun.file(`${dir}/key.pem`).text();
const cert = await Bun.file(`${dir}/cert.pem`).text();
process.env.NODE_EXTRA_CA_CERTS = `${dir}/cert.pem`; // informational; fetch below passes tls.ca explicitly

// ---------- A. Bun.serve http2 ----------
const seen: string[] = [];
const srv = Bun.serve({
  port: 0, hostname: "127.0.0.1", http2: true, tls: { key, cert },
  async fetch(req, s) {
    const url = new URL(req.url);
    const ip = s.requestIP(req);
    seen.push(`${url.pathname} peerPort=${ip?.port}`);
    if (url.pathname === "/echo") {
      const body = req.body!;
      return new Response(new ReadableStream({ async start(c) { for await (const ch of body) c.enqueue(enc.encode(`echo:${dec.decode(ch)}\n`)); c.close(); } }));
    }
    if (url.pathname === "/slow") { await sleep(300); return new Response("slow"); }
    return new Response(`hello proto-check`, { headers: { "x-served": "bun" } });
  },
});
const base = `https://127.0.0.1:${srv.port}`;
const tlsOpt = { ca: cert, serverName: "localhost" };

// A1: fetch with protocol http2
for (const protocol of [undefined, "http2", "http1.1"]) {
  try {
    const r = await fetch(`${base}/`, { tls: tlsOpt, ...(protocol ? { protocol } : {}) } as any);
    console.log(`RESULT A1 fetch protocol=${protocol ?? "(default)"}: ${r.status} "${await r.text()}"`);
  }
  catch (e) { console.log(`RESULT A1 fetch protocol=${protocol ?? "(default)"}: threw ${(e as Error).name}: ${(e as Error).message}`); }
}
// A2: which wire protocol did Bun.serve actually speak? curl reports it.
{
  const run = async (args: string[]) => { const p = Bun.spawn(args, { stdout: "pipe" }); return (await new Response(p.stdout).text()); };
  // spawnSync would block this event loop, which is also the server's
  const p = await run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_version}", "--cacert", `${dir}/cert.pem`, "--resolve", `localhost:${srv.port}:127.0.0.1`, `https://localhost:${srv.port}/`]);
  const p1 = await run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_version}", "--http1.1", "--cacert", `${dir}/cert.pem`, "--resolve", `localhost:${srv.port}:127.0.0.1`, `https://localhost:${srv.port}/`]);
  console.log(`RESULT A2 curl (offers h2) negotiated HTTP/${p}; curl --http1.1 got HTTP/${p1}`);
}
// A3: multiplexing — 5 concurrent slow requests via fetch http2: one TCP connection?
{
  seen.length = 0;
  const s0 = performance.now();
  await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/slow`, { tls: tlsOpt, protocol: "http2" } as any).then(r => r.text())));
  const ports = new Set(seen.map(x => x.split("peerPort=")[1]));
  console.log(`RESULT A3 5 concurrent fetch(http2) to a 300 ms handler: ${Math.round(performance.now() - s0)}ms, distinct client ports ${ports.size}`);
}
// A4: full-duplex echo over fetch http2
{
  let push!: (s: string) => void; let end!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(c) { push = s => c.enqueue(enc.encode(s)); end = () => c.close(); } });
  push("m0");
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 3000);
  try {
    const r = await fetch(`${base}/echo`, { method: "POST", body, duplex: "half", tls: tlsOpt, protocol: "http2", signal: ac.signal } as any);
    const rd = r.body!.getReader(); const got: string[] = [];
    for (let i = 0; i < 3; i++) { const { value, done } = await rd.read(); if (done) break; got.push(dec.decode(value).trim()); if (i < 2) push(`m${i + 1}`); else end(); }
    console.log(`RESULT A4 duplex ping-pong over fetch(http2): ${JSON.stringify(got)}`);
  }
  catch (e) { console.log(`RESULT A4 duplex over fetch(http2): ${(e as Error).name} ${(e as Error).message}`); }
  clearTimeout(t);
}
// A5: node:http2 client against Bun.serve http2 — trailers from Bun.serve?
{
  const client = http2.connect(base, { ca: cert, servername: "localhost" });
  const req = client.request({ ":path": "/" });
  let trailers: unknown = null; let body = "";
  req.on("trailers", t => (trailers = t));
  req.setEncoding("utf8"); req.on("data", d => (body += d));
  await new Promise(r => req.on("end", r));
  console.log(`RESULT A5 node:http2 client -> Bun.serve(http2): body "${body}", trailers ${JSON.stringify(trailers)}`);
  client.close();
}
srv.stop(true);

// ---------- B. node:http2 server + client, trailers, bidi stream ----------
{
  const server = http2.createSecureServer({ key, cert });
  server.on("stream", (stream, headers) => {
    if (headers[":path"] === "/bidi") {
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("data", d => stream.write(`echo:${d}`));
      stream.on("end", () => stream.end());
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0", "grpc-message": "OK" }));
    }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const client = http2.connect(`https://127.0.0.1:${port}`, { ca: cert, servername: "localhost" });
  const req = client.request({ ":method": "POST", ":path": "/bidi", "content-type": "application/grpc", te: "trailers" });
  const got: string[] = []; let trailers: unknown = null;
  req.on("trailers", t => (trailers = { status: t["grpc-status"], message: t["grpc-message"] }));
  const next = () => new Promise<string>(r => req.once("data", d => r(String(d))));
  req.write("m0"); got.push(await next());
  req.write("m1"); got.push(await next());
  req.end();
  await new Promise(r => req.on("close", r));
  console.log(`RESULT B node:http2 server+client bidi ping-pong ${JSON.stringify(got)}, trailers ${JSON.stringify(trailers)}`);
  client.close(); server.close();
}

// ---------- C. node:http2 cleartext (h2c prior knowledge) + ping ----------
{
  const server = http2.createServer();
  server.on("stream", s => { s.respond({ ":status": 200 }); s.end("h2c-ok"); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const client = http2.connect(`http://127.0.0.1:${port}`);
  const rtt = await new Promise<string>(r => client.ping((err, dur) => r(err ? `err ${err.message}` : `${dur.toFixed(3)}ms`)));
  const req = client.request({ ":path": "/" }); let body = ""; req.setEncoding("utf8"); req.on("data", d => (body += d));
  await new Promise(r => req.on("end", r));
  console.log(`RESULT C node:http2 h2c: body "${body}", session.ping() RTT ${rtt}`);
  client.close(); server.close();
}
process.exit(0);
