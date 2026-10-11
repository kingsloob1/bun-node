// TCP half-close in detail: client writes a request then shutdown(true); does the server get the data,
// an end() callback, and can it still reply? Run: bun tcp-halfclose.ts
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
for (const allowHalfOpen of [false, true]) {
  for (const how of ["shutdown(true)", "shutdown()", "end()"]) {
    const events: string[] = []; const t0 = performance.now(); const at = () => Math.round(performance.now() - t0);
    const srv = Bun.listen({
      hostname: "127.0.0.1", port: 0, allowHalfOpen,
      socket: {
        open() { events.push(`S open@${at()}`); },
        data(_s, d) { events.push(`S data "${d}"@${at()}`); },
        end(s) { events.push(`S end@${at()}`); const n = s.write("reply-after-fin"); events.push(`S write-after-FIN=${n}`); s.end(); },
        close(_s, e) { events.push(`S close@${at()}${e ? ` ${e.message}` : ""}`); },
      },
    });
    const c = await Bun.connect({
      hostname: "127.0.0.1", port: srv.port, allowHalfOpen,
      socket: { data(_s, d) { events.push(`C data "${d}"@${at()}`); }, end() { events.push(`C end@${at()}`); }, close() { events.push(`C close@${at()}`); } },
    });
    await sleep(50);
    c.write("request");
    if (how === "end()") c.end(); else if (how === "shutdown()") c.shutdown(); else c.shutdown(true);
    await sleep(1000);
    console.log(`RESULT allowHalfOpen=${allowHalfOpen} client ${how}: ${events.join(" | ")}`);
    srv.stop(true);
  }
}
process.exit(0);
