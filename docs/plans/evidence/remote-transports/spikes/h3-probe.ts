// Why does fetch({ protocol: "http3" }) report HTTP3Unsupported? Vary host, TLS verification and flags.
// Run: bun h3-probe.ts ; and with BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT=1
const dir = import.meta.dir;
const key = await Bun.file(`${dir}/key.pem`).text(); const cert = await Bun.file(`${dir}/cert.pem`).text();
const srv = Bun.serve({ port: 0, http3: true, tls: { key, cert }, fetch: () => new Response("hello h3") });
const ss = Bun.spawn(["ss", "-uln", `sport = :${srv.port}`], { stdout: "pipe" });
console.log(`RESULT server UDP listener: ${(await new Response(ss.stdout).text()).trim().split("\n").slice(1).join(" ; ") || "none"}`);
for (const host of ["127.0.0.1", "localhost"]) {
  for (const tls of [{ ca: cert, serverName: "localhost" }, { rejectUnauthorized: false }]) {
    try {
      const r = await fetch(`https://${host}:${srv.port}/`, { tls, protocol: "http3", signal: AbortSignal.timeout(3000) } as any);
      console.log(`RESULT host=${host} tls=${Object.keys(tls)}: ${r.status} "${await r.text()}"`);
    }
    catch (e) { console.log(`RESULT host=${host} tls=${Object.keys(tls)}: ${(e as Error).name} ${(e as Error).message.split(".")[0]}`); }
  }
}
// Alt-Svc upgrade path: plain fetch twice with the flag on
for (let i = 0; i < 2; i++) {
  try { const r = await fetch(`https://localhost:${srv.port}/`, { tls: { ca: cert } } as any); console.log(`RESULT plain fetch #${i + 1}: ${r.status} alt-svc=${r.headers.get("alt-svc")}`); }
  catch (e) { console.log(`RESULT plain fetch #${i + 1}: ${(e as Error).message}`); }
}
srv.stop(true);
process.exit(0);
