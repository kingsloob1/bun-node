// Spike: what Bun.serve tells a handler about the peer, and what a client can
// claim through forwarding headers. Run: bun spike.ts  (no network beyond loopback)
// Records: server.requestIP(), server.timeout() presence, header passthrough,
// and a Unix-socket listener's requestIP().
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out: Record<string, unknown> = { bun: Bun.version, revision: Bun.revision };

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    return Response.json({
      requestIP: srv.requestIP(req),
      xff: req.headers.get("x-forwarded-for"),
      forwarded: req.headers.get("forwarded"),
      xRealIp: req.headers.get("x-real-ip"),
      hasTimeout: typeof (srv as { timeout?: unknown }).timeout === "function",
    });
  },
});
const url = `http://127.0.0.1:${server.port}/`;
out.plain = await (await fetch(url)).json();
out.spoofed = await (
  await fetch(url, {
    headers: {
      "x-forwarded-for": "203.0.113.7, 198.51.100.9",
      forwarded: 'for="[2001:db8::1]:4711";proto=https, for=192.0.2.60',
      "x-real-ip": "203.0.113.8",
    },
  })
).json();
// Two X-Forwarded-For header lines: does Bun join them?
out.twoXffLines = await (
  await fetch(url, {
    headers: [
      ["x-forwarded-for", "203.0.113.1"],
      ["x-forwarded-for", "198.51.100.2"],
    ],
  })
).json();
server.stop(true);

// IPv6 loopback
try {
  const s6 = Bun.serve({ port: 0, hostname: "::1", fetch: (r, s) => Response.json(s.requestIP(r)) });
  out.ipv6 = await (await fetch(`http://[::1]:${s6.port}/`)).json();
  s6.stop(true);
} catch (error) {
  out.ipv6 = `unavailable: ${String(error)}`;
}

// Unix socket listener: what is the peer?
const sock = join(tmpdir(), `secplan-${process.pid}.sock`);
try {
  const su = Bun.serve({ unix: sock, fetch: (r, s) => Response.json({ ip: s.requestIP(r) }) });
  out.unix = await (await fetch("http://localhost/", { unix: sock } as RequestInit)).json();
  su.stop(true);
} catch (error) {
  out.unix = `error: ${String(error)}`;
} finally {
  try {
    unlinkSync(sock);
  } catch {}
}

// idleTimeout bounds: Bun documents a maximum of 255 seconds.
for (const idleTimeout of [0, 10, 255, 256]) {
  try {
    const s = Bun.serve({ port: 0, idleTimeout, fetch: () => new Response("ok") });
    out[`idleTimeout_${idleTimeout}`] = "accepted";
    s.stop(true);
  } catch (error) {
    out[`idleTimeout_${idleTimeout}`] = `rejected: ${String(error).slice(0, 120)}`;
  }
}
console.log(JSON.stringify(out, null, 2));
