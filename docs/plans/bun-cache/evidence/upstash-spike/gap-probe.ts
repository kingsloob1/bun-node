// Can a subscriber connection be dropped without CLIENT KILL, so Bun reconnects it?
// Mode via argv[2]: "quit" (send QUIT on the subscriber) or "close" (close() then connect()).
import { RedisClient } from "bun";

const url = process.env.BUN_CACHE_TEST_UPSTASH_REDIS_URL ?? process.env.REDIS_PROBE_URL!;
const mode = process.argv[2] ?? "quit";
const channel = `bun-cache-probe:${process.pid}:bus`;
const c = new RedisClient(url);
await c.connect();
const sub = await c.duplicate();
await sub.connect();
const got: string[] = [];
await sub.subscribe(channel, (m) => got.push(m));
let reconnects = 0;
sub.onconnect = () => {
  reconnects++;
  sub.send("SUBSCRIBE", [channel]).catch((e) => console.log("resub err", String(e)));
};
sub.onclose = (e) => console.log("onclose", e instanceof Error ? e.message : String(e));
const t = performance.now();
if (mode === "quit") {
  try {
    console.log("QUIT ->", await sub.send("QUIT", []));
  } catch (e) {
    console.log("QUIT threw", e instanceof Error ? e.message : String(e));
  }
} else {
  sub.close();
  console.log("closed; connected =", sub.connected);
  try {
    await sub.connect();
    console.log("connect() after close ok; connected =", sub.connected);
  } catch (e) {
    console.log("connect() after close threw", e instanceof Error ? e.message : String(e));
  }
}
const deadline = performance.now() + 8000;
while (reconnects === 0 && performance.now() < deadline) await Bun.sleep(20);
console.log(`onconnect fired: ${reconnects} after ${(performance.now() - t).toFixed(0)} ms; connected=${sub.connected}`);
await Bun.sleep(mode === "quit" ? 300 : 300);
await c.publish(channel, "after");
const d2 = performance.now() + 3000;
while (got.length === 0 && performance.now() < d2) await Bun.sleep(20);
console.log("delivered after reconnect:", got);
sub.onconnect = null;
sub.close();
c.close();
