/**
 * Compression ahead of the cache — `compression()` registered before
 * `cacheResponse()`: misses are captured uncompressed, and each hit is
 * compressed for the request that gets it.
 *
 * ```bash
 * bun 05-http/compression.ts
 * ```
 *
 * - One stored copy serves a gzip client and a plain one.
 * - Put `compression()` ahead of the cache, never behind it.
 */
import { BunRouter, compression } from "@kingsleyweb/bun-common";
import { cacheResponse } from "@kingsleyweb/bun-cache/http";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { httpCache, nextSet } from "../shared/http";

title("bun-cache/http: compression before the cache");

/** Large and repetitive enough to clear compression's size threshold. */
const BODY = "the quick brown fox jumps over the lazy dog. ".repeat(200);

const cache = httpCache();
const router = new BunRouter();
let runs = 0;

router.use(compression());
router.get("/text", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
  runs++;
  res.type("text/plain").send(BODY);
});

/* ------------------------------------------------------------------ */
step("the miss, then a gzip hit");

const written = nextSet(cache);
await (await router.fetch("/text")).text();
await written;

const gzip = await router.fetch("/text", {
  headers: { "accept-encoding": "gzip" },
});
show("hit", [
  gzip.headers.get("x-cache"),
  gzip.headers.get("content-encoding"),
]);
checkEqual("a HIT", gzip.headers.get("x-cache"), "HIT");
checkEqual(
  "compressed with gzip",
  gzip.headers.get("content-encoding"),
  "gzip",
);
const bytes = new Uint8Array(await gzip.arrayBuffer());
check("smaller than the body", bytes.length < BODY.length, {
  compressed: bytes.length,
  body: BODY.length,
});
check(
  "decodes to the stored body",
  new TextDecoder().decode(Bun.gunzipSync(bytes)) === BODY,
);

/* ------------------------------------------------------------------ */
step("the same entry for a client that does not ask for gzip");

const plain = await router.fetch("/text", {
  headers: { "accept-encoding": "identity" },
});
checkEqual("a HIT", plain.headers.get("x-cache"), "HIT");
checkEqual("not compressed", plain.headers.get("content-encoding"), null);
check("the body as stored", (await plain.text()) === BODY);
checkEqual("the handler ran once", runs, 1);

summary();
await cache.close();
