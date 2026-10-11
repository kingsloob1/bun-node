// Spike: the cost of RT §4.3.1's text frame with its per-frame MAC (RT §4.4.1),
// as the protocol core would build and check it: JSON.stringify, the MAC input
// string, HMAC-SHA256, base64url, and the reverse with a constant-time verify.
//
// Measures, per frame size (a heartbeat ~150 B, a 1.2 KiB invoke, a 16 KiB
// result):
//   A. crypto.subtle sign, one at a time (what RT Appendix A measured)
//   B. crypto.subtle sign, 64 in flight (does WebCrypto parallelise?)
//   C. node:crypto createHmac, synchronous
//   D. a whole text frame encode + decode-and-verify with crypto.subtle, sequential
//   E. the same with node:crypto
// Prints RESULT lines. Run: bun mac-throughput.ts
import { createHmac, timingSafeEqual } from "node:crypto";

const enc = new TextEncoder();
const secret = enc.encode("k".repeat(32));
const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
function message(size: number): unknown {
  const base = { op: "result", job: "01JB7Q2M8ZRT9V", attempt: 1, fence: "h7f3-4211-1789:1790000000400", status: "completed", at: 1790000003111 };
  const pad = Math.max(0, size - JSON.stringify(base).length - 12);
  return { ...base, result: { b: "x".repeat(pad) } };
}
const SID = "q3JtZ2FfZ3c0bE1uUXpXRA.Ym9iX2V4ZWN1dG9yX25vbg";

async function time(label: string, n: number, fn: (i: number) => Promise<void> | void): Promise<number> {
  for (let i = 0; i < Math.min(2000, n); i++) await fn(i); // warm
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  const ms = performance.now() - t0;
  const us = (ms * 1000) / n;
  console.log(`RESULT ${label}: ${us.toFixed(2)} us/op, ${Math.round(n / (ms / 1000))} ops/s`);
  return us;
}

for (const size of [150, 1200, 16384]) {
  const json = JSON.stringify(message(size));
  const input = enc.encode(`BJ1\n${SID}\ne\n42\n17\n${json}`);
  const N = size > 4000 ? 20000 : 50000;

  await time(`A subtle sign seq ${size}B`, N, async () => {
    await crypto.subtle.sign("HMAC", key, input);
  });

  // B: 64 concurrent signs per round
  {
    const rounds = N / 64;
    for (let r = 0; r < 50; r++) await Promise.all(Array.from({ length: 64 }, () => crypto.subtle.sign("HMAC", key, input)));
    const t0 = performance.now();
    for (let r = 0; r < rounds; r++) await Promise.all(Array.from({ length: 64 }, () => crypto.subtle.sign("HMAC", key, input)));
    const ms = performance.now() - t0;
    console.log(`RESULT B subtle sign 64-in-flight ${size}B: ${((ms * 1000) / N).toFixed(2)} us/op, ${Math.round(N / (ms / 1000))} ops/s`);
  }

  await time(`C node createHmac ${size}B`, N, () => {
    createHmac("sha256", secret).update(input).digest();
  });

  // D/E: full frame encode, then parse (indexOf four spaces) and verify.
  const fullSubtle = async (i: number) => {
    const body = JSON.stringify(message(size));
    const mac = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`BJ1\n${SID}\ne\n${i}\n0\n${body}`))));
    const line = `BJ1 ${i} 0 ${mac} ${body}`;
    // decode
    let p = 0;
    const idx: number[] = [];
    for (let k = 0; k < 4; k++) { p = line.indexOf(" ", p) + 1; idx.push(p); }
    const seq = line.slice(idx[0], idx[1] - 1);
    const ack = line.slice(idx[1], idx[2] - 1);
    const gotMac = Buffer.from(line.slice(idx[2], idx[3] - 1), "base64url");
    const json = line.slice(idx[3]);
    const ok = await crypto.subtle.verify("HMAC", key, gotMac, enc.encode(`BJ1\n${SID}\ne\n${seq}\n${ack}\n${json}`));
    if (!ok) throw new Error("verify failed");
    JSON.parse(json);
  };
  await time(`D frame encode+verify subtle ${size}B`, N / 2, fullSubtle);

  const fullNode = (i: number) => {
    const body = JSON.stringify(message(size));
    const mac = createHmac("sha256", secret).update(`BJ1\n${SID}\ne\n${i}\n0\n${body}`).digest("base64url");
    const line = `BJ1 ${i} 0 ${mac} ${body}`;
    let p = 0;
    const idx: number[] = [];
    for (let k = 0; k < 4; k++) { p = line.indexOf(" ", p) + 1; idx.push(p); }
    const seq = line.slice(idx[0], idx[1] - 1);
    const ack = line.slice(idx[1], idx[2] - 1);
    const gotMac = Buffer.from(line.slice(idx[2], idx[3] - 1), "base64url");
    const json = line.slice(idx[3]);
    const want = createHmac("sha256", secret).update(`BJ1\n${SID}\ne\n${seq}\n${ack}\n${json}`).digest();
    if (!timingSafeEqual(want, gotMac)) throw new Error("verify failed");
    JSON.parse(json);
  };
  await time(`E frame encode+verify node ${size}B`, N / 2, fullNode);
}
console.log(`RESULT env: bun ${Bun.revision} ${process.platform}/${process.arch}`);
