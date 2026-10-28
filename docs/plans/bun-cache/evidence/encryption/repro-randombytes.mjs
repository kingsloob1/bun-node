// crypto.randomBytes(12) against crypto.getRandomValues on a 12-byte array.
import { randomBytes, randomFillSync } from "node:crypto";
const N = 200_000;
function time(name, fn) {
  for (let i = 0; i < 20_000; i++) fn();
  const t = performance.now();
  for (let i = 0; i < N; i++) fn();
  console.log(name, (((performance.now() - t) * 1000) / N).toFixed(3), "µs/op");
}
time("randomBytes(12)              ", () => randomBytes(12));
time("randomBytes(1024)            ", () => randomBytes(1024));
time("randomFillSync(Uint8Array 12)", () => randomFillSync(new Uint8Array(12)));
time("getRandomValues(Uint8Array12)", () => crypto.getRandomValues(new Uint8Array(12)));
