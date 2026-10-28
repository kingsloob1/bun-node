/**
 * Streamed answers — skipped by default, stored with `streams: { buffer }`.
 *
 * ```bash
 * bun 05-http/streams.ts
 * ```
 *
 * - A handler that `res.write()`s its body in pieces is a stream. With the
 *   default (`streams: "skip"`) it is sent as it is and never stored:
 *   `UNCACHEABLE` every time, the handler run every time.
 * - With `streams: { buffer: 64 * 1024 }` each chunk still goes to the client
 *   as it arrives, and a copy of up to 64 KiB is kept: the first request is a
 *   `MISS`, and once the stream has ended the next is a `HIT` with the whole
 *   body.
 * - A stream that outgrows the buffer is delivered whole and not stored: the
 *   next request runs the handler again. Its `X-Cache` is `MISS` both times:
 *   it goes out with the first byte, before anyone knows the size (the key
 *   is marked uncacheable by the time the first stream has ended, and the
 *   second stream is still copied in case it fits).
 */
import type { BunResponse } from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";
import { cacheResponse } from "@kingsleyweb/bun-cache/http";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { httpCache, nextSet } from "../shared/http";

title("bun-cache/http: buffered streams");

const cache = httpCache();
const router = new BunRouter();
const runs = { skipped: 0, buffered: 0, big: 0 };

/** A handler writing `chunks` pieces of `size` bytes, a moment apart. */
function stream(counter: keyof typeof runs, chunks: number, size: number) {
  return async (_req: unknown, res: BunResponse) => {
    runs[counter]++;
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Cache-Control", "max-age=60");

    for (let index = 0; index < chunks; index++) {
      res.write("x".repeat(size));
      await Bun.sleep(10);
    }

    await res.end();
  };
}

router.get("/skipped", cacheResponse(cache), stream("skipped", 2, 10));
router.get(
  "/buffered",
  cacheResponse(cache, { streams: { buffer: 64 * 1024 } }),
  stream("buffered", 2, 10),
);
router.get(
  "/big",
  cacheResponse(cache, { streams: { buffer: 64 * 1024 } }),
  stream("big", 3, 40 * 1024),
);

/** The answer to the next `GET path`: its `X-Cache` and body length. */
async function get(path: string) {
  const response = await router.fetch(path);
  const body = await response.text();
  return { xCache: response.headers.get("x-cache"), length: body.length };
}

/* ------------------------------------------------------------------ */
step("the default: streams are skipped");

checkEqual("first /skipped", (await get("/skipped")).xCache, "UNCACHEABLE");
checkEqual("second /skipped", (await get("/skipped")).xCache, "UNCACHEABLE");
checkEqual("the handler ran every time", runs.skipped, 2);

/* ------------------------------------------------------------------ */
step("streams: { buffer: 65536 }: stored once the stream ends");

const stored = nextSet(cache);
const miss = await get("/buffered");
show("first", miss);
checkEqual("the first request is a MISS", miss.xCache, "MISS");
checkEqual("delivered whole", miss.length, 20);
await stored;

const hit = await get("/buffered");
show("second", hit);
checkEqual("the second is a HIT", hit.xCache, "HIT");
checkEqual("with the whole body", hit.length, 20);
checkEqual("the handler ran once", runs.buffered, 1);

/* ------------------------------------------------------------------ */
step("a stream past the buffer: delivered whole, not stored");

const first = await get("/big");
show("first", first);
checkEqual("120 KiB delivered whole", first.length, 120 * 1024);
checkEqual(
  "a MISS (the size is unknown at the first byte)",
  first.xCache,
  "MISS",
);

const second = await get("/big");
checkEqual("and run again", runs.big, 2);
show("second", second);
checkEqual("a MISS again, not a HIT", second.xCache, "MISS");
checkEqual("still whole", second.length, 120 * 1024);

summary();
await cache.close();
