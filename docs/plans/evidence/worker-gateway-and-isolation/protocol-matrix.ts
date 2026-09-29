// Re-checks, on the installed Bun, which transports work as client AND as
// server, with one round trip each. A summary spike: the detailed behaviour
// (backpressure, timers, half-close…) is in ../remote-transports/spikes/.
//
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 \
//     -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
//   CERT_DIR=<dir with key.pem cert.pem> bun protocol-matrix.ts
import { connect as h2connect, createServer as h2createServer } from "node:http2";
import process from "node:process";

const dir = process.env.CERT_DIR ?? ".";
const key = await Bun.file(`${dir}/key.pem`).text();
const cert = await Bun.file(`${dir}/cert.pem`).text();
const results: Record<string, string> = {};

async function check(name: string, fn: () => Promise<string>) {
  const t = performance.now();
  try {
    const detail = await Promise.race([
      fn(),
      Bun.sleep(8000).then(() => {
        throw new Error("timeout 8s");
      }),
    ]);
    results[name] = `OK ${(performance.now() - t).toFixed(1)}ms ${detail}`;
  } catch (e) {
    results[name] = `FAIL ${(e as Error).message}`;
  }
}

// 1. HTTP/1.1
await check("http/1.1 serve+fetch", async () => {
  using s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  return await (await fetch(`http://127.0.0.1:${s.port}/`)).text();
});

// 2. HTTPS with a pinned CA
await check("https serve+fetch (pinned ca)", async () => {
  using s = Bun.serve({ port: 0, tls: { key, cert }, fetch: () => new Response("ok") });
  return await (await fetch(`https://localhost:${s.port}/`, { tls: { ca: cert } })).text();
});

// 3. HTTP/2 over TLS: Bun.serve({ http2 }) + fetch({ protocol: "http2" })
await check("h2 Bun.serve+fetch", async () => {
  using s = Bun.serve({
    port: 0,
    tls: { key, cert },
    http2: true,
    fetch: (req) => new Response(`ok via ${(req as unknown as { httpVersion?: string }).httpVersion ?? "?"}`),
  } as Parameters<typeof Bun.serve>[0]);
  const res = await fetch(`https://localhost:${s.port}/`, {
    tls: { ca: cert },
    protocol: "http2",
  } as RequestInit);
  return await res.text();
});

// 4. h2c (cleartext, prior knowledge) with node:http2 both sides
await check("h2c node:http2 server+client", async () => {
  const srv = h2createServer();
  srv.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const client = h2connect(`http://127.0.0.1:${port}`);
  const body = await new Promise<string>((resolve, reject) => {
    const req = client.request({ ":path": "/" });
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
    req.end();
  });
  client.close();
  srv.close();
  return body;
});

// 4b. h2c with Bun.serve: does Bun.serve speak cleartext h2 at all?
await check("h2c Bun.serve (no tls) <- node:http2 client", async () => {
  using s = Bun.serve({ port: 0, http2: true, fetch: () => new Response("ok") } as Parameters<typeof Bun.serve>[0]);
  const client = h2connect(`http://127.0.0.1:${s.port}`);
  try {
    return await new Promise<string>((resolve, reject) => {
      client.on("error", reject);
      const req = client.request({ ":path": "/" });
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
      req.on("error", reject);
      req.end();
    });
  } finally {
    client.close();
  }
});

// 5. HTTP/3 (experimental): Bun.serve({ http3 }) + fetch({ protocol: "http3" })
await check("h3 Bun.serve+fetch (rejectUnauthorized:false)", async () => {
  using s = Bun.serve({
    port: 0,
    tls: { key, cert },
    http3: true,
    fetch: () => new Response("ok"),
  } as Parameters<typeof Bun.serve>[0]);
  const res = await fetch(`https://localhost:${s.port}/`, {
    protocol: "http3",
    tls: { rejectUnauthorized: false },
  } as RequestInit);
  return await res.text();
});

// 6. WebSocket and WSS
for (const secure of [false, true]) {
  await check(secure ? "wss serve+client (pinned ca)" : "ws serve+client", async () => {
    using s = Bun.serve({
      port: 0,
      ...(secure ? { tls: { key, cert } } : {}),
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: { message: (ws, m) => void ws.send(`echo:${m}`) },
    });
    const ws = new WebSocket(`${secure ? "wss" : "ws"}://localhost:${s.port}/`, {
      ...(secure ? { tls: { ca: cert } } : {}),
    } as unknown as string[]);
    return await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send("hi");
      ws.onmessage = (e) => {
        resolve(String(e.data));
        ws.close();
      };
      ws.onerror = () => reject(new Error("ws error"));
    });
  });
}

// 7. TCP and TLS-over-TCP
for (const secure of [false, true]) {
  await check(secure ? "tcp+tls listen+connect" : "tcp listen+connect", async () => {
    const srv = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      ...(secure ? { tls: { key, cert } } : {}),
      socket: { data: (sock, d) => void sock.write(`echo:${d}`) },
    });
    try {
      return await new Promise<string>((resolve, reject) => {
        void Bun.connect({
          hostname: "localhost",
          port: srv.port,
          ...(secure ? { tls: { ca: cert, serverName: "localhost" } } : {}),
          socket: {
            open: (sock) => void (secure ? undefined : sock.write("hi")),
            handshake: secure ? (sock) => void sock.write("hi") : undefined,
            data: (sock, d) => {
              resolve(String(d));
              sock.end();
            },
            connectError: (_s, e) => reject(e),
          },
        } as Parameters<typeof Bun.connect>[0]);
      });
    } finally {
      srv.stop(true);
    }
  });
}

// 8. UDP
await check("udp udpSocket", async () => {
  const server = await Bun.udpSocket({
    socket: { data: (sock, buf, port, addr) => void sock.send(`echo:${buf}`, port, addr) },
  });
  try {
    return await new Promise<string>((resolve) => {
      void Bun.udpSocket({
        socket: {
          data: (sock, buf) => {
            resolve(String(buf));
            sock.close();
          },
        },
      }).then((c) => c.send("hi", server.port, "127.0.0.1"));
    });
  } finally {
    server.close();
  }
});

console.log(`bun ${Bun.version} (${Bun.revision})`);
for (const [k, v] of Object.entries(results)) console.log(`RESULT ${k.padEnd(48)} ${v}`);
process.exit(0);
