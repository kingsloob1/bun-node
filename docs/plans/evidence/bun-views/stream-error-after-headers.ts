// Spike 3d: a body stream that errors after its first 1000 bytes. Does the
// client see an error (connection reset), or a clean, truncated 200?
// Plain Bun.serve against bun-common's adapter, with the stream erroring
// directly and through pipeThrough(TransformStream) (React's stream wrapped).
//
//   bun stream-error-after-headers.ts
import { BunHttpAdapter, createLogger } from "../../../../packages/bun-common/lib/index.ts";

const direct = () =>
  new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(new TextEncoder().encode("x".repeat(1000)));
      await Bun.sleep(20);
      c.error(new Error("broke after headers"));
    },
  });
const piped = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("x".repeat(5000)));
      c.close();
    },
  }).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      // Awaiting in transform holds the close back, so the error lands first.
      async transform(chunk, c) {
        c.enqueue(chunk.slice(0, 1000));
        await Bun.sleep(20);
        throw new Error("broke after headers");
      },
    }),
  );
const bodies = { direct, piped } as const;

const bun = Bun.serve({
  port: 0,
  fetch: (req) => new Response(bodies[new URL(req.url).pathname.slice(1) as keyof typeof bodies](), { headers: { "content-type": "text/html" } }),
  error: () => new Response("x", { status: 500 }),
});
const adapter = new BunHttpAdapter(0, { logger: createLogger({ level: "fatal" }) });
adapter.get("/:kind", (req, res) => {
  res.type("html").send(bodies[(req.params as { kind: keyof typeof bodies }).kind]());
});
await adapter.listen(0, "127.0.0.1");

console.log(`bun ${Bun.version} (${Bun.revision.slice(0, 9)})`);
console.log("server | body | status | client saw");
for (const [server, base] of [["Bun.serve", `http://127.0.0.1:${bun.port}`], ["bun-common adapter", `http://127.0.0.1:${adapter.listeningPort}`]] as const) {
  for (const kind of ["direct", "piped"]) {
    let status = 0;
    let saw: string;
    try {
      const response = await fetch(`${base}/${kind}`);
      status = response.status;
      saw = `a clean end after ${(await response.text()).length} bytes`;
    } catch (e) {
      saw = `an error: ${String(e).slice(0, 60)}`;
    }
    console.log(`${server} | ${kind} | ${status} | ${saw}`);
  }
}
bun.stop(true);
await adapter.close();
