// socket.timeout(n): when does the handler fire, and does Bun close the socket itself?
// Run: bun tcp-timeout.ts
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
for (const secs of [1, 2, 5]) {
  const t0 = performance.now(); const at = () => Math.round(performance.now() - t0);
  const ev: string[] = [];
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    open(s) { s.timeout(secs); }, data() {},
    timeout(s) { ev.push(`S timeout@${at()} readyState=${s.readyState}`); },
    close() { ev.push(`S close@${at()}`); },
  } });
  await Bun.connect({ hostname: "127.0.0.1", port: srv.port, socket: { data() {}, close() { ev.push(`C close@${at()}`); } } });
  await sleep(secs * 1000 + 9000);
  console.log(`RESULT timeout(${secs}): ${ev.join(" | ") || "nothing"}`);
  srv.stop(true);
}
process.exit(0);
