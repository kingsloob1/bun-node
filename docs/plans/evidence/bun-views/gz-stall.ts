// Spike 3b: compression() + a streamed body that pauses between chunks, with
// no React. Reproduces the stall seen by http-serve.ts on /gz/stream-suspense.
//
//   bun gz-stall.ts
//
// Each case sends chunk A, waits `pause` ms, sends chunk B, closes. The client
// reads with a 1.5 s deadline and reports what arrived.
import { BunHttpAdapter, compression, createLogger } from "../../../../packages/bun-common/lib/index.ts";

const adapter = new BunHttpAdapter(0, { logger: createLogger({ level: "error" }) });
adapter.use(compression({ threshold: 0 }));
const text = (n: number) => new TextEncoder().encode("<p>".padEnd(n, "x"));

adapter.get("/case", (req, res) => {
  const q = req.query as Record<string, string>;
  const a = Number(q.a);
  const b = Number(q.b);
  const pause = Number(q.pause);
  // "start": everything enqueued from start(); "pull": one chunk per pull(),
  // the shape React's renderToReadableStream has.
  let step = 0;
  const stream =
    q.mode === "pull"
      ? new ReadableStream<Uint8Array>({
          async pull(controller) {
            step++;
            if (step === 1) controller.enqueue(text(a));
            else if (step === 2) {
              if (pause > 0) await Bun.sleep(pause);
              controller.enqueue(text(b));
            } else controller.close();
          },
        })
      : new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(text(a));
            if (pause > 0) await Bun.sleep(pause);
            controller.enqueue(text(b));
            controller.close();
          },
        });
  res.type("html").send(stream);
});
await adapter.listen(0, "127.0.0.1");
const base = `http://127.0.0.1:${adapter.listeningPort}`;
console.log(`bun ${Bun.version} (${Bun.revision.slice(0, 9)})`);
console.log("source | A bytes | B bytes | pause ms | encoding | finished | ms | decoded bytes (expected A+B)");
for (const [a, b, pause] of [
  [100, 100, 0],
  [100, 100, 50],
  [100_000, 1_000, 0],
  [100_000, 1_000, 50],
  [100_000, 100_000, 50],
  [1_000, 100_000, 50],
] as const) {
  for (const mode of ["start", "pull"])
  for (const encoding of ["identity", "gzip", "br"]) {
    const t0 = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    let finished = true;
    let bytes = 0;
    try {
      const response = await fetch(`${base}/case?mode=${mode}&a=${a}&b=${b}&pause=${pause}`, {
        headers: { "accept-encoding": encoding },
        signal: controller.signal,
      });
      bytes = (await response.arrayBuffer()).byteLength;
    } catch {
      finished = false;
    }
    clearTimeout(timer);
    console.log(`${mode} | ${a} | ${b} | ${pause} | ${encoding} | ${finished} | ${(performance.now() - t0).toFixed(0)} | ${finished ? bytes : "-"} (${a + b})`);
  }
}
await adapter.close();
