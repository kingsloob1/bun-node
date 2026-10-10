// Spike 3c: the two controls that place gz-stall.ts's stall in bun-common
// rather than Bun. (1) Bun.serve delivers a body chunk enqueued from a timer,
// outside pull(), as zlib's 'data' events are. (2) node:zlib on Bun runs the
// write callback and fires 'end' after end().
//
//   bun gz-stall-controls.ts
import * as zlib from "node:zlib";

const server = Bun.serve({
  port: 0,
  fetch() {
    let sent = 0;
    let scheduled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (scheduled) return;
        scheduled = true;
        // Return at once with nothing enqueued; enqueue later, outside pull().
        const tick = () => {
          if (sent++ < 2) {
            controller.enqueue(new TextEncoder().encode(`chunk${sent}\n`));
            setTimeout(tick, 20);
          } else controller.close();
        };
        setTimeout(tick, 20);
      },
    });
    return new Response(stream);
  },
});
const c = new AbortController();
const t = setTimeout(() => c.abort(), 1500);
try {
  const text = await (await fetch(`http://127.0.0.1:${server.port}/`, { signal: c.signal })).text();
  console.log(`(1) Bun.serve, chunks enqueued outside pull(): finished, body ${JSON.stringify(text)}`);
} catch (e) {
  console.log(`(1) Bun.serve, chunks enqueued outside pull(): STALLED (${String(e)})`);
}
clearTimeout(t);
server.stop(true);

for (const [name, make] of [["gzip", () => zlib.createGzip()], ["br", () => zlib.createBrotliCompress()]] as const) {
  const engine = make();
  let bytes = 0;
  engine.on("data", (chunk: Buffer) => { bytes += chunk.length; });
  const ended = new Promise<string>((resolve) => engine.once("end", () => resolve("'end' fired")));
  for (const fill of ["x", "y"]) {
    await new Promise<void>((resolve, reject) => engine.write(new TextEncoder().encode("<p>".padEnd(100, fill)), (e) => (e ? reject(e) : resolve())));
  }
  engine.end();
  console.log(`(2) node:zlib ${name}: two write callbacks ran; after end(): ${await Promise.race([ended, Bun.sleep(1000).then(() => "'end' NOT fired in 1 s")])}, ${bytes} bytes out`);
}
