// Spike: does crypto.subtle's speed-up with many signs in flight come from
// other threads (CPU time > wall time) or from amortised promise overhead?
// Compares wall time with process CPU time for 64-in-flight signs, and with
// 1-in-flight. Run: bun mac-concurrency-cpu.ts
const enc = new TextEncoder();
const key = await crypto.subtle.importKey("raw", enc.encode("k".repeat(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const input = enc.encode("x".repeat(1200));
for (const inFlight of [1, 8, 64, 512]) {
  const N = 200_000;
  const rounds = N / inFlight;
  for (let r = 0; r < Math.min(rounds, 200); r++) await Promise.all(Array.from({ length: inFlight }, () => crypto.subtle.sign("HMAC", key, input)));
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  for (let r = 0; r < rounds; r++) await Promise.all(Array.from({ length: inFlight }, () => crypto.subtle.sign("HMAC", key, input)));
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(c0);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  console.log(`RESULT in-flight ${inFlight}: wall ${(wall * 1000 / N).toFixed(2)} us/op, cpu ${(cpuMs * 1000 / N).toFixed(2)} us/op, cpu/wall ${(cpuMs / wall).toFixed(2)}`);
}
