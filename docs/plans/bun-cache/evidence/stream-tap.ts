/**
 * PR-H2's spike (plan §9.4): can a response transform swap a streamed body
 * for a copying stream without holding back the first byte, and should the
 * copy be a `tee()`?
 *
 * Served through bun-common's `BunHttpAdapter` on port 0, a transform
 * registered first (as `cacheResponse()` registers it) swaps the body:
 *
 * 1. A pull-through tap over `res.write()` chunks 400 ms apart: when the
 *    first chunk reaches the client, the whole body, what the copy held.
 * 2. The tap over an endless stream, the client aborting after two chunks:
 *    whether the handler's stream is cancelled.
 * 3. The same with `body.tee()`, the second branch read to its end: whether
 *    the handler's stream is cancelled, and how many chunks it is still
 *    pulled for in the 500 ms after the abort.
 *
 * Run: `bun stream-tap.ts` (from this folder, inside the repo).
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";

function tap(
  source: ReadableStream<Uint8Array>,
  onDone: (bytes: Uint8Array | undefined) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            onDone(Buffer.concat(chunks));
            return;
          }
          chunks.push(value.slice());
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
          onDone(undefined);
        }
      },
      cancel(reason) {
        onDone(undefined);
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

const encoder = new TextEncoder();
let copied: string | undefined;
let tapCancelled = false;
let teeCancelled = false;
let teePulls = 0;

function endless(onCancel: () => void, onPull = () => {}) {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await Bun.sleep(50);
      onPull();
      controller.enqueue(encoder.encode("tick "));
    },
    cancel: onCancel,
  });
}

const adapter = new BunHttpAdapter(0);
adapter.get(
  "/chunks",
  (_req, res, next) => {
    res.addResponseTransform(
      {
        transform: (r) =>
          r.body === null
            ? r
            : new Response(
                tap(r.body, (b) => {
                  copied = b && new TextDecoder().decode(b);
                }),
                { status: r.status, headers: r.headers },
              ),
      },
      { first: true },
    );
    next();
  },
  async (_req, res) => {
    res.write("one ");
    await Bun.sleep(400);
    res.write("two");
    await res.end();
  },
);
adapter.get(
  "/tap",
  (_req, res, next) => {
    res.addResponseTransform(
      {
        transform: (r) =>
          r.body === null
            ? r
            : new Response(tap(r.body, () => {}), {
                status: r.status,
                headers: r.headers,
              }),
      },
      { first: true },
    );
    next();
  },
  (_req, res) => {
    res.send(endless(() => (tapCancelled = true)));
  },
);
adapter.get(
  "/tee",
  (_req, res, next) => {
    res.addResponseTransform(
      {
        transform: (r) => {
          if (r.body === null) return r;
          const [a, b] = r.body.tee();
          void new Response(b).arrayBuffer().catch(() => {});
          return new Response(a, { status: r.status, headers: r.headers });
        },
      },
      { first: true },
    );
    next();
  },
  (_req, res) => {
    res.send(
      endless(
        () => (teeCancelled = true),
        () => teePulls++,
      ),
    );
  },
);
await adapter.listen(0);
const base = `http://127.0.0.1:${adapter.listeningPort}`;

const t0 = performance.now();
const reader = (await fetch(`${base}/chunks`)).body!.getReader();
const first = await reader.read();
const firstMs = performance.now() - t0;
let body = new TextDecoder().decode(first.value);
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  body += new TextDecoder().decode(value);
}
const endMs = performance.now() - t0;
console.log(
  `1. tap over res.write(): first chunk at ${firstMs.toFixed(0)} ms, end at ${endMs.toFixed(0)} ms, body ${JSON.stringify(body)}, copy ${JSON.stringify(copied)}`,
);

async function abortAfterTwo(path: string): Promise<void> {
  const abort = new AbortController();
  const r = (await fetch(`${base}${path}`, { signal: abort.signal })).body!.getReader();
  await r.read();
  await r.read();
  abort.abort();
}
await abortAfterTwo("/tap");
await Bun.sleep(300);
console.log(`2. tap, client aborted: handler stream cancelled = ${tapCancelled}`);
await abortAfterTwo("/tee");
const atAbort = teePulls;
await Bun.sleep(500);
console.log(
  `3. tee, client aborted: handler stream cancelled = ${teeCancelled}, pulled ${teePulls - atAbort} more chunks in 500 ms`,
);
await adapter.close();
process.exit(0);
