// Spike: a dual-stack listener ("::") reached over IPv4 — the address form a
// CIDR matcher must normalise. Run: bun dualstack.ts
const s = Bun.serve({ port: 0, hostname: "::", fetch: (r, srv) => Response.json(srv.requestIP(r)) });
const v4 = await (await fetch(`http://127.0.0.1:${s.port}/`)).json();
const v6 = await (await fetch(`http://[::1]:${s.port}/`)).json();
// Default hostname (Bun's default "0.0.0.0"? or "::"?) reached over IPv4
const d = Bun.serve({ port: 0, fetch: (r, srv) => Response.json({ ip: srv.requestIP(r), hostname: srv.hostname }) });
const dv4 = await (await fetch(`http://127.0.0.1:${d.port}/`)).json();
s.stop(true);
d.stop(true);
console.log(JSON.stringify({ bun: Bun.version, revision: Bun.revision, dualStackOverV4: v4, dualStackOverV6: v6, defaultHostOverV4: dv4 }, null, 2));
