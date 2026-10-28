/**
 * An invalidation that lands while a write is still in flight still wins.
 *
 * ```bash
 * bun 05-http/invalidate-in-flight.ts
 * ```
 *
 * - A streamed answer is stored when its body ends, which can be well after
 *   its headers went out. On a networked driver the write itself takes time
 *   too. `pages.invalidate(path)` called in between would otherwise drop
 *   nothing, and the late write would put the old answer back.
 * - `cacheResponse()` tracks the writes it has in flight per path and, after
 *   they land, invalidates the path again in the background. So the entry is
 *   gone once the write has landed, and the next request runs the handler.
 * - The driver here is the memory driver with every `set` delayed by 20 ms,
 *   standing in for a slow network; the body ends 30 ms after the response
 *   starts. Both delays are what make the write be in flight when
 *   `invalidate()` runs.
 */
import type { CacheDriver } from "@kingsleyweb/bun-cache";
import { BunRouter } from "@kingsleyweb/bun-common";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { cacheResponse } from "@kingsleyweb/bun-cache/http";
import { check, checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";

title("bun-cache/http: invalidate() with a write in flight");

/** The memory driver with every `set` taking `lagMs` first, as a networked one does. */
function slowWrites(lagMs: number): CacheDriver {
  const inner = memoryDriver();
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === "set" && typeof value === "function") {
        return async (...args: Parameters<CacheDriver["set"]>) => {
          await Bun.sleep(lagMs);
          return await inner.set(...args);
        };
      }
      return typeof value === "function"
        ? (value.bind(target) as unknown)
        : value;
    },
  });
}

/** A body that ends `afterMs` after it starts: its bytes, and so its write, come after the headers. */
function lateBody(text: string, afterMs: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      await Bun.sleep(afterMs);
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const cache = createCache({
  driver: slowWrites(20),
  namespace: "http",
  sweepInterval: 0,
});
const router = new BunRouter();
const pages = cacheResponse(cache, {
  ttl: 60_000,
  coalesce: false,
  streams: { buffer: 1024 },
});
let runs = 0;

router.get("/report", pages, (_req, res) => {
  runs++;
  res.send(lateBody(`report #${runs}`, 30));
});

/* ------------------------------------------------------------------ */
step("invalidate() while the streamed answer's write is still to come");

const first = await router.fetch("/report");
// The response has started; its body, and then its write, are still to come.
await pages.invalidate("/report");
checkEqual(
  "the first answer is delivered whole",
  await first.text(),
  "report #1",
);

// The body ended; the write needed 20 ms more, then the second pass dropped it.
await Bun.sleep(150);
const second = await router.fetch("/report");
checkEqual("the next request is a MISS", second.headers.get("x-cache"), "MISS");
checkEqual("it ran the handler again", await second.text(), "report #2");
check("two runs in all", runs === 2, runs);

summary();
await cache.close();
