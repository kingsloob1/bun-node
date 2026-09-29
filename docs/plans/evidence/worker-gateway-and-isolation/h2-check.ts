// Verifies h2c on Bun.serve (control: http2:false) and fetch multiplexing.
//   CERT_DIR=<dir with key.pem cert.pem> bun h2-check.ts
import { connect } from "node:http2";
const dir = process.env.CERT_DIR!;
const key = await Bun.file(`${dir}/key.pem`).text(), cert = await Bun.file(`${dir}/cert.pem`).text();
async function h2c(port: number) {
  const client = connect(`http://127.0.0.1:${port}`);
  try {
    return await Promise.race([new Promise<string>((res, rej) => {
      client.on("error", rej);
      const r = client.request({ ":path": "/" }); let d = ""; r.setEncoding("utf8");
      r.on("response", (h) => (d += `status=${h[":status"]} `)); r.on("data", (c) => (d += c)); r.on("end", () => res(d)); r.on("error", rej); r.end();
    }), Bun.sleep(3000).then(() => "TIMEOUT")]);
  } catch (e) { return "ERR " + (e as Error).message; } finally { client.destroy(); }
}
for (const http2 of [true, false]) {
  using s = Bun.serve({ port: 0, http2, fetch: () => new Response("ok") } as any);
  console.log(`RESULT h2c prior-knowledge -> Bun.serve({http2:${http2}}, no tls):`, await h2c(s.port));
  const p = Bun.spawn(["curl", "-s", "-m", "3", "-o", "/dev/null", "-w", "%{http_version}", "--http2-prior-knowledge", `http://127.0.0.1:${s.port}/`]);
  console.log(`RESULT curl --http2-prior-knowledge http2:${http2}:`, (await new Response(p.stdout).text()) || "exit " + (await p.exited));
}
using t = Bun.serve({ port: 0, tls: { key, cert }, http2: true, fetch: () => new Response("ok") } as any);
const p = Bun.spawn(["curl", "-s", "-m", "3", "-k", "-o", "/dev/null", "-w", "%{http_version}", "--http2", `https://localhost:${t.port}/`]);
console.log("RESULT curl --http2 over tls ->", await new Response(p.stdout).text());
// which protocol did fetch use? count TCP connections for 5 concurrent requests
let conns = new Set<string>();
using u = Bun.serve({ port: 0, tls: { key, cert }, http2: true, async fetch(req, srv) { await Bun.sleep(200); return new Response(String(srv.requestIP(req)?.port)); } } as any);
for (const proto of [undefined, "http2"]) {
  conns = new Set();
  const t0 = performance.now();
  const r = await Promise.all(Array.from({ length: 5 }, () => fetch(`https://localhost:${u.port}/`, { tls: { ca: cert }, ...(proto ? { protocol: proto } : {}) } as any).then((x) => x.text())));
  r.forEach((x) => conns.add(x));
  console.log(`RESULT fetch protocol=${proto ?? "default"}: 5 concurrent 200ms requests took ${(performance.now() - t0).toFixed(0)}ms over ${conns.size} client ports`);
}
process.exit(0);
