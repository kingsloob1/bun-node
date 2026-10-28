/**
 * `cacheResponse()` in the Express 5 pipeline (plan §9.2, §9.7): beside
 * `compression()` in both orders, under error handlers and `next("route")`,
 * over a real socket (where streaming matters), with the request's own
 * `Cache-Control` (`honorRequest`), and with a codec that does not keep
 * bytes.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRouter,
  compression,
} from "@kingsleyweb/bun-common";
import type { Cache } from "../../lib/index";
import { createCache, memoryDriver } from "../../lib/index";
import type { CacheResponseOptions } from "../../lib/http/index";
import { cacheResponse } from "../../lib/http/index";
import { frameAt, keyFor, makeHttpCache, nextSet } from "./helpers";

afterEach(() => {
  setSystemTime();
});

/** A body past compression()'s 1 KiB threshold. */
const BIG = "cacheable ".repeat(300);
const gzip = { headers: { "accept-encoding": "gzip" } };

/** The decoded text of a gzip-encoded response. */
async function gunzipped(response: Response): Promise<string> {
  return new TextDecoder().decode(
    Bun.gunzipSync(new Uint8Array(await response.arrayBuffer())),
  );
}

describe("compression() (§9.7)", () => {
  test("compression() before the cache: misses are captured uncompressed, hits are compressed", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    router.use(compression());
    router.get("/big", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
      res.type("text/plain").send(BIG);
    });
    const written = nextSet(cache);
    const miss = await router.fetch("/big", gzip);
    expect(miss.headers.get("content-encoding")).toBe("gzip");
    expect(await gunzipped(miss)).toBe(BIG);
    await written;

    const frame = await frameAt(cache, keyFor("/big"));
    expect(frame?.kind).toBe("response");
    if (frame?.kind === "response") {
      expect(new TextDecoder().decode(frame.response.body)).toBe(BIG);
      expect(
        frame.response.meta.headers.some(
          ([name]) => name === "content-encoding",
        ),
      ).toBe(false);
    }

    const hit = await router.fetch("/big", gzip);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.get("content-encoding")).toBe("gzip");
    expect(await gunzipped(hit)).toBe(BIG);
    // A client that takes no encoding gets the plain bytes from the same entry.
    const plain = await router.fetch("/big");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe(BIG);
  });

  test("compression() after the cache: the miss is still captured uncompressed; a hit skips compression", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    router.get(
      "/big",
      cacheResponse(cache, { ttl: 60_000 }),
      compression(),
      (_req, res) => {
        res.type("text/plain").send(BIG);
      },
    );
    const written = nextSet(cache);
    const miss = await router.fetch("/big", gzip);
    expect(miss.headers.get("content-encoding")).toBe("gzip");
    await written;
    const frame = await frameAt(cache, keyFor("/big"));
    expect(
      frame?.kind === "response" &&
        new TextDecoder().decode(frame.response.body),
    ).toBe(BIG);
    const hit = await router.fetch("/big", gzip);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.get("content-encoding")).toBeNull();
    expect(await hit.text()).toBe(BIG);
  });
});

describe("the pipeline (§9.2)", () => {
  test("a thrown error answered 5xx by an error handler is not stored", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    let runs = 0;
    router.get("/boom", cacheResponse(cache, { ttl: 60_000 }), () => {
      runs++;
      throw new Error("boom");
    });
    router.use(((_err, _req, res, _next) => {
      res.status(503).send("down");
    }) satisfies RouterErrorMiddlewareHandler);
    const first = await router.fetch("/boom");
    expect(first.status).toBe(503);
    expect(first.headers.get("x-cache")).toBe("UNCACHEABLE");
    await Bun.sleep(5);
    await router.fetch("/boom");
    expect(runs).toBe(2);
    expect((await frameAt(cache, keyFor("/boom")))?.kind).toBe("uncacheable");
  });

  test('next("route"): whatever finally answers on the response is stored', async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    router.get(
      "/n",
      cacheResponse(cache, { ttl: 60_000 }),
      (_req, _res, next) => {
        next("route");
      },
    );
    router.get("/n", (_req, res) => {
      res.send("second route");
    });
    const written = nextSet(cache);
    await router.fetch("/n");
    await written;
    const hit = await router.fetch("/n");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("second route");
  });

  test("a subtree mount keys by the full URL, not the mount-relative one", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    const sub = new BunRouter();
    sub.get("/page", (req, res) => {
      res.send(`sub ${req.originalUrl}`);
    });
    router.use("/a", cacheResponse(cache, { ttl: 60_000 }), sub);
    router.use("/b", cacheResponse(cache, { ttl: 60_000 }), sub);
    let written = nextSet(cache);
    await router.fetch("/a/page");
    await written;
    written = nextSet(cache);
    const b = await router.fetch("/b/page");
    expect(b.headers.get("x-cache")).toBe("MISS");
    expect(await b.text()).toBe("sub /b/page");
    await written;
  });

  test("over a real socket: miss then hit, and a streamed answer is delivered whole and not stored", async () => {
    const cache = makeHttpCache();
    const adapter = new BunHttpAdapter(0);
    let runs = 0;
    adapter.get(
      "/served",
      cacheResponse(cache, { ttl: 60_000 }),
      (_req, res) => {
        runs++;
        res.send(`served ${runs}`);
      },
    );
    adapter.get(
      "/stream",
      cacheResponse(cache, { ttl: 60_000 }),
      async (_req, res) => {
        res.write("one ");
        await Bun.sleep(5);
        res.write("two");
        await res.end();
      },
    );
    await adapter.listen(0);
    try {
      const base = `http://127.0.0.1:${adapter.listeningPort}`;
      const written = nextSet(cache);
      const miss = await fetch(`${base}/served`);
      expect(miss.headers.get("x-cache")).toBe("MISS");
      expect(await miss.text()).toBe("served 1");
      await written;
      const hit = await fetch(`${base}/served`);
      expect(hit.headers.get("x-cache")).toBe("HIT");
      expect(hit.headers.get("age")).toBe("0");
      expect(await hit.text()).toBe("served 1");
      const head = await fetch(`${base}/served`, { method: "HEAD" });
      expect(head.headers.get("x-cache")).toBe("HIT");
      expect(head.headers.get("content-length")).toBe(
        String("served 1".length),
      );

      const stream = await fetch(`${base}/stream`);
      expect(stream.headers.get("x-cache")).toBe("UNCACHEABLE");
      expect(await stream.text()).toBe("one two");
      await Bun.sleep(5);
      expect((await frameAt(cache, keyFor("/stream")))?.kind).toBe(
        "uncacheable",
      );
    } finally {
      await adapter.close();
    }
    expect(runs).toBe(1);
  });
});

describe("honorRequest (RFC 9111 §5.2.1)", () => {
  /** `/h` counting its runs, under `honorRequest` unless `options` says otherwise. */
  function honoring(
    options: CacheResponseOptions = { ttl: 60_000, honorRequest: true },
  ) {
    const cache = makeHttpCache();
    const router = new BunRouter();
    let runs = 0;
    router.get("/h", cacheResponse(cache, options), (_req, res) => {
      runs++;
      res.send(`run ${runs}`);
    });
    const ask = async (
      cacheControl?: string,
      extra: Record<string, string> = {},
    ) => {
      const headers: Record<string, string> = { ...extra };
      if (cacheControl !== undefined) {
        headers["cache-control"] = cacheControl;
      }
      const response = await router.fetch("/h", { headers });
      return {
        status: response.status,
        cache: response.headers.get("x-cache"),
        text: await response.text(),
      };
    };
    const warm = async () => {
      const written = nextSet(cache);
      await ask();
      await written;
    };
    return { cache, ask, warm, runs: () => runs };
  }

  test("ignored by default: a client's no-cache cannot push load onto the handler", async () => {
    const { ask, warm } = honoring({ ttl: 60_000 });
    await warm();
    expect((await ask("no-cache")).cache).toBe("HIT");
    expect((await ask(undefined, { pragma: "no-cache" })).cache).toBe("HIT");
  });

  test("no-store bypasses", async () => {
    const { ask, warm, runs } = honoring();
    await warm();
    expect(await ask("no-store")).toEqual({
      status: 200,
      cache: "BYPASS",
      text: "run 2",
    });
    expect(runs()).toBe(2);
  });

  test("no-cache, Pragma: no-cache and max-age=0 run the handler and store its answer", async () => {
    const { cache, ask, warm } = honoring();
    await warm();
    for (const [directive, extra] of [
      ["no-cache", {}],
      [undefined, { pragma: "no-cache" }],
      ["max-age=0", {}],
    ] as const) {
      const written = nextSet(cache);
      const fresh = await ask(directive, extra);
      expect(fresh.cache).toBe("MISS");
      await written;
      expect((await ask()).text).toBe(fresh.text);
    }
  });

  test("max-age=N refuses a stored answer older than N; min-fresh one with too little freshness left", async () => {
    setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const { ask, warm } = honoring();
    await warm();
    setSystemTime(new Date("2026-10-28T10:00:20Z"));
    expect((await ask("max-age=30")).cache).toBe("HIT");
    expect((await ask("max-age=10")).cache).toBe("MISS");
    // The MISS stored a new answer at 10:00:20 (fresh until 10:01:20).
    await Bun.sleep(5);
    setSystemTime(new Date("2026-10-28T10:01:00Z"));
    expect((await ask("min-fresh=10")).cache).toBe("HIT");
    expect((await ask("min-fresh=30")).cache).toBe("MISS");
  });

  test("only-if-cached answers a miss with 504, and a hit as usual", async () => {
    const { ask, warm, runs } = honoring();
    expect((await ask("only-if-cached")).status).toBe(504);
    expect(runs()).toBe(0);
    await warm();
    expect((await ask("only-if-cached")).cache).toBe("HIT");
  });
});

describe("codecs", () => {
  test("a codec that does not keep bytes (json) never serves a broken entry: every request is a miss, answered correctly", async () => {
    // The types refuse a JSON cache (its `set` takes JSON values, not the
    // frame's bytes); forced past them, it must still never serve garbage.
    const cache = createCache({
      driver: memoryDriver(),
      sweepInterval: 0,
      codec: "json",
    }) as unknown as Cache;
    const router = new BunRouter();
    let runs = 0;
    router.get("/j", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
      runs++;
      res.send(`run ${runs}`);
    });
    const written = nextSet(cache);
    expect(await (await router.fetch("/j")).text()).toBe("run 1");
    await written;
    const second = await router.fetch("/j");
    expect(await second.text()).toBe("run 2");
    expect(second.headers.get("x-cache")).toBe("MISS");
  });

  test("the raw codec keeps the frame", async () => {
    const cache = createCache({
      driver: memoryDriver(),
      sweepInterval: 0,
      codec: "raw",
    });
    const router = new BunRouter();
    router.get("/r", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
      res.send("raw");
    });
    const written = nextSet(cache);
    await router.fetch("/r");
    await written;
    expect((await router.fetch("/r")).headers.get("x-cache")).toBe("HIT");
  });
});
