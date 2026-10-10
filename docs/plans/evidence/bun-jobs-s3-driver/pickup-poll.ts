// Pickup latency on S3 with no notification: a waiter polls a `wake` object's
// ETag with HEAD every P ms; a producer PUTs the wake object at a random moment.
// Measures wake-to-notice latency and HEAD requests per second, for several P,
// and adds the claim path's request count. Loopback MinIO, so network RTT ≈ 0:
// on real S3 add one round trip per request on the path.
// Run: bun pickup-poll.ts
import { S3Client } from "bun";
const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:19101", bucket: "jobs", accessKeyId: "spikeuser", secretAccessKey: "spikesecret123", region: "us-east-1", virtualHostedStyle: false });
const key = `pp-${process.pid}/wake`;
await s3.write(key, "0");
const SAMPLES = 25;
console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), MinIO loopback, ${SAMPLES} wakes per interval`);
for (const P of [25, 100, 250, 1000]) {
  // Only the polling loop's HEADs count, over the time spent polling: the
  // baseline stat each sample takes first is the spike's own, not a waiter's.
  // (The first version counted it and divided by total time, overstating
  // HEAD/s by 1.5 to 2x: 59.6 against 27.7 at 25 ms, 1.7 against 1.0 at 1000 ms.)
  let heads = 0, pollMs = 0; const lat: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const before = (await s3.stat(key)).etag;
    const p0 = performance.now();
    const delay = Math.random() * P * 2;
    let wokeAt = 0;
    const producer = (async () => { await Bun.sleep(delay); wokeAt = performance.now(); await s3.write(key, `${P}-${i}-${Math.random()}`); })();
    for (;;) {
      await Bun.sleep(P);
      heads++;
      if ((await s3.stat(key)).etag !== before) break;
    }
    pollMs += performance.now() - p0;
    lat.push(performance.now() - wokeAt);
    await producer;
  }
  const secs = pollMs / 1000;
  lat.sort((a, b) => a - b);
  console.log(`poll every ${String(P).padStart(4)} ms: notice latency p50 ${lat[Math.floor(SAMPLES / 2)]!.toFixed(0)} ms, max ${lat.at(-1)!.toFixed(0)} ms; ${(heads / secs).toFixed(1)} HEAD/s per waiter (${((heads / secs) * 86400 * 30 / 1e6).toFixed(1)} M requests per idle waiter per 30 days)`);
}
await s3.delete(key);
