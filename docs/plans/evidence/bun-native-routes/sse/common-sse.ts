/**
 * What bun-common's BunHttpAdapter does today with a hand-written SSE route
 * (`res.setHeader("Content-Type", "text/event-stream")` + `res.write`), over a
 * real socket and socket-free through `fetch()`.
 *
 *   bun docs/plans/evidence/bun-native-routes/sse/common-sse.ts
 *
 * Each case prints when the client's `fetch()` resolved (headers) and when
 * each event arrived. Events are written 200 ms apart unless said otherwise.
 */
import type { BunRequest, BunResponse, RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import { BunHttpAdapter, BunRouter, compression, noopLogger } from "@kingsleyweb/bun-common";
import { log, ms, readEvents, show } from "./lib";

const GAP = 200;

/** Writes `n` events `GAP` ms apart, then ends. */
async function produce(res: BunResponse, n = 3, gap = GAP): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await Bun.sleep(gap);
    res.write(`data: e${i}\n\n`);
  }
  await res.end();
}

function sseHeaders(res: BunResponse): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
}

async function served(
  setup: (a: BunHttpAdapter) => void,
  path: string,
  opts: { timeout?: number; requestTimeout?: number; init?: RequestInit } = {},
): Promise<string> {
  const a = new BunHttpAdapter(opts.requestTimeout ?? 0, { logger: noopLogger });
  setup(a);
  const server = await a.listen(0);
  const t0 = performance.now();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, opts.init);
    const headersAt = ms(t0);
    const out = await readEvents(res.body, t0, { timeoutMs: opts.timeout ?? 3000 });
    return `status=${res.status} ce=${res.headers.get("content-encoding")} headers@${headersAt}ms ${show(out)}`;
  } catch (error) {
    return `fetch failed @${ms(t0)}ms: ${(error as Error).message}`;
  } finally {
    await a.close();
  }
}

// A. The README pattern: start the producer, return.
log("A served, write-and-return", await served((a) => a.get("/e", (_q, res) => {
  sseHeaders(res);
  void produce(res);
}), "/e"));

// B. The handler awaits its own producer (as an `async` handler naturally would).
log("B served, handler awaits the stream", await served((a) => a.get("/e", async (_q, res) => {
  sseHeaders(res);
  await produce(res);
}), "/e"));

// C. Headers flushed explicitly, first event 500 ms later.
log("C served, flushHeaders() then first write at 500ms", await served((a) => a.get("/e", (_q, res) => {
  sseHeaders(res);
  res.flushHeaders();
  void produce(res, 2, 500);
}), "/e"));

// C2. As C, but a comment is written at once.
log("C2 served, ': open' comment at once, first event at 500ms", await served((a) => a.get("/e", (_q, res) => {
  sseHeaders(res);
  res.write(": open\n\n");
  void produce(res, 2, 500);
}), "/e"));

// D. Socket-free: router.fetch() and adapter.fetch(), write-and-return.
{
  const r = new BunRouter();
  r.get("/e", (_q, res) => {
    sseHeaders(res);
    void produce(res);
  });
  const t0 = performance.now();
  const res = await r.fetch("/e");
  const h = ms(t0);
  log("D1 router.fetch(), write-and-return", `headers@${h}ms ${show(await readEvents(res.body, t0))}`);

  const a = new BunHttpAdapter(0, { logger: noopLogger });
  a.get("/e", (_q, res2) => {
    sseHeaders(res2);
    void produce(res2);
  });
  a.get("/await", async (_q, res2) => {
    sseHeaders(res2);
    await produce(res2);
  });
  const t1 = performance.now();
  const res3 = await a.fetch("/e");
  const h3 = ms(t1);
  log("D2 adapter.fetch(), write-and-return", `headers@${h3}ms ${show(await readEvents(res3.body, t1))}`);
  const t2 = performance.now();
  const res4 = await a.fetch("/await");
  const h4 = ms(t2);
  log("D3 adapter.fetch(), handler awaits", `headers@${h4}ms ${show(await readEvents(res4.body, t2))}`);
  const r2 = new BunRouter();
  r2.get("/await", async (_q, res5) => {
    sseHeaders(res5);
    await produce(res5);
  });
  const t3 = performance.now();
  const res6 = await r2.fetch("/await");
  const h6 = ms(t3);
  log("D4 router.fetch(), handler awaits", `headers@${h6}ms ${show(await readEvents(res6.body, t3))}`);
}

// E. The adapter's requestTimeout (constructor arg) against a stream.
log("E1 requestTimeout 300, stream of 5 x 200ms", await served((a) => a.get("/e", (_q, res) => {
  sseHeaders(res);
  void produce(res, 5);
}), "/e", { requestTimeout: 300 }));
log("E2 requestTimeout 300, first write at 500ms (not flushed)", await served((a) => a.get("/e", (_q, res) => {
  sseHeaders(res);
  void produce(res, 2, 500);
}), "/e", { requestTimeout: 300 }));

// F. compression(): gzip, one event per flush?
log("F compression(), Accept-Encoding gzip", await served((a) => {
  a.use(compression({ threshold: 0 }));
  a.get("/e", (_q, res) => {
    sseHeaders(res);
    void produce(res);
  });
}, "/e", { init: { headers: { "accept-encoding": "gzip" } } }));

// G. Client disconnect: what the server sees.
{
  const a = new BunHttpAdapter(0, { logger: noopLogger });
  const seen: string[] = [];
  let t0 = 0;
  a.get("/e", (req: BunRequest, res: BunResponse) => {
    sseHeaders(res);
    req.request.signal.addEventListener("abort", () => seen.push(`req.signal abort@${ms(t0)}`));
    res.on("close", () => seen.push(`res close@${ms(t0)}`));
    res.on("finish", () => seen.push(`res finish@${ms(t0)}`));
    req.socket.once("close", () => seen.push(`req.socket close@${ms(t0)}`));
    let n = 0;
    const timer = setInterval(() => {
      const ok = res.write(`data: e${++n}\n\n`);
      if (n === 6) {
        seen.push(`write#6 after abort returned ${ok}`);
        clearInterval(timer);
      }
    }, 100);
  });
  const server = await a.listen(0);
  const ac = new AbortController();
  t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${server.port}/e`, { signal: ac.signal });
  const out = await readEvents(res.body, t0, { max: 2 });
  ac.abort();
  await Bun.sleep(700);
  log("G client aborts after 2 events: client", show(out));
  log("G … server saw", seen.join(", "));
  await a.close();
}

// H. adapter.close() (server.stop(true)) with a stream open.
{
  const a = new BunHttpAdapter(0, { logger: noopLogger });
  const seen: string[] = [];
  let t0 = 0;
  a.get("/e", (req: BunRequest, res: BunResponse) => {
    sseHeaders(res);
    req.request.signal.addEventListener("abort", () => seen.push(`req.signal abort@${ms(t0)}`));
    res.on("close", () => seen.push(`res close@${ms(t0)}`));
    let n = 0;
    const timer = setInterval(() => {
      res.write(`data: e${++n}\n\n`);
      if (n > 30) clearInterval(timer);
    }, 100);
  });
  const server = await a.listen(0);
  t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${server.port}/e`);
  const reading = readEvents(res.body, t0, { timeoutMs: 3000 });
  await Bun.sleep(350);
  const c0 = performance.now();
  const closeAt = ms(t0);
  await a.close();
  const closeTook = ms(c0);
  const out = await reading;
  await Bun.sleep(200);
  log("H adapter.close() 350ms after headers: client", `${show(out)} close() called @${closeAt}ms, took ${closeTook}ms`);
  log("H … server saw", seen.join(", ") || "nothing");
}

// I. Errors after the headers went out.
let handlerRan = 0;
const errorHandler = ((err, _req, res, _next) => {
  handlerRan++;
  res.status(500).send(`handler saw: ${String((err as Error).message)}`);
}) satisfies RouterErrorMiddlewareHandler;
log("I1 write then throw (sync), error handler registered", await served((a) => {
  a.get("/e", (_q, res) => {
    sseHeaders(res);
    res.write("data: e1\n\n");
    throw new Error("boom");
  });
  a.use(errorHandler);
}, "/e", { timeout: 1500 }));
log("I2 write then next(err), error handler registered", await served((a) => {
  a.get("/e", (_q, res, next) => {
    sseHeaders(res);
    res.write("data: e1\n\n");
    next(new Error("boom"));
  });
  a.use(errorHandler);
}, "/e", { timeout: 1500 }));
log("I3 write then throw, no error handler", await served((a) => {
  a.get("/e", (_q, res) => {
    sseHeaders(res);
    res.write("data: e1\n\n");
    throw new Error("boom");
  });
}, "/e", { timeout: 1500 }));
log("I4 async handler: write, await, throw", await served((a) => {
  a.get("/e", async (_q, res) => {
    sseHeaders(res);
    res.write("data: e1\n\n");
    await Bun.sleep(100);
    throw new Error("boom");
  });
  a.use(errorHandler);
}, "/e", { timeout: 1500 }));

log("I … error handler invocations across I1, I2, I4", String(handlerRan));

// J. Last-Event-ID is an ordinary header.
log("J Last-Event-ID via req.get()", await served((a) => a.get("/e", (req: BunRequest, res: BunResponse) => {
  sseHeaders(res);
  res.write(`data: resume-from ${req.get("last-event-id")}\n\n`);
  void res.end();
}), "/e", { init: { headers: { "last-event-id": "41" } } }));

process.exit(0);
