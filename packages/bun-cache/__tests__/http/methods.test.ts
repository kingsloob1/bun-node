/**
 * HEAD, unsafe methods and invalidation (plan §9.3): HEAD reads GET's entry
 * and never stores; a 2xx/3xx `POST`, `PUT`, `PATCH` or `DELETE` drops its
 * path's entries (RFC 9111 §4.4); `invalidate()`, `addCacheTags()` and the
 * `tags` option drop them on demand.
 */
import { describe, expect, test } from "bun:test";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";
import type { CacheDriver } from "../../lib/index";
import type { CacheResponseOptions } from "../../lib/http/index";
import { addCacheTags, cacheResponse } from "../../lib/http/index";
import { createCache, memoryDriver } from "../../lib/index";
import { frameAt, keyFor, makeHttpCache, nextSet } from "./helpers";

/** `/posts/:id` (GET, counted, tagged `post:<id>`) and its unsafe twins under one `cacheResponse`, mounted with `use`. */
function blog(options: CacheResponseOptions = { ttl: 60_000 }) {
  const cache = makeHttpCache();
  const router = new BunRouter();
  const pages = cacheResponse(cache, options);
  let runs = 0;
  router.use("/posts", pages);
  router.get("/posts/:id", (req, res) => {
    runs++;
    addCacheTags(res, `post:${req.params.id}`);
    res.send(`post ${req.params.id} #${runs}`);
  });
  router.post("/posts/:id", (req, res) => {
    res.status(Number(req.getHeader("x-status") ?? "200"));
    const location = req.getHeader("x-location");
    if (location !== null) {
      res.setHeader("Location", location);
    }
    res.send("done");
  });
  router.put("/posts/:id", (_req, res) => {
    res.send("put");
  });
  router.delete("/posts/:id", (_req, res) => {
    void res.status(204).end();
  });
  const get = async (path: string, init: RequestInit = {}) => {
    const response = await router.fetch(path, init);
    return {
      status: response.headers.get("x-cache"),
      text: await response.text(),
      response,
    };
  };
  /** GETs `path` and waits for its entry to be written. */
  const warm = async (path: string) => {
    const written = nextSet(cache);
    await get(path);
    await written;
  };
  return { cache, router, pages, get, warm, runs: () => runs };
}

describe("HEAD", () => {
  test("a HEAD is answered from the GET entry: status and headers, no body", async () => {
    const { get, warm, runs, router } = blog();
    await warm("/posts/1");
    const head = await router.fetch("/posts/1", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("x-cache")).toBe("HIT");
    expect(head.headers.get("etag")).not.toBeNull();
    expect(await head.text()).toBe("");
    expect(runs()).toBe(1);
    expect((await get("/posts/1")).status).toBe("HIT");
  });

  test("a HEAD miss runs the GET handler and stores nothing", async () => {
    const { cache, router, runs } = blog();
    const head = await router.fetch("/posts/2", { method: "HEAD" });
    expect(head.headers.get("x-cache")).toBe("MISS");
    expect(runs()).toBe(1);
    await Bun.sleep(5);
    expect(await frameAt(cache, keyFor("/posts/2"))).toBeUndefined();
  });
});

describe("unsafe methods (RFC 9111 §4.4)", () => {
  test("a 2xx POST drops every entry for its path: each query, each variant", async () => {
    const { get, warm, router } = blog();
    await warm("/posts/1");
    await warm("/posts/1?page=2");
    await warm("/posts/3");
    await router.fetch("/posts/1", { method: "POST" });
    expect((await get("/posts/1")).status).toBe("MISS");
    expect((await get("/posts/1?page=2")).status).toBe("MISS");
    expect((await get("/posts/3")).status).toBe("HIT");
  });

  test("PUT and DELETE do too; a 4xx or 5xx does not", async () => {
    const { cache, get, warm, router } = blog();
    await warm("/posts/1");
    await router.fetch("/posts/1", {
      method: "POST",
      headers: { "x-status": "422" },
    });
    expect((await get("/posts/1")).status).toBe("HIT");
    await router.fetch("/posts/1", { method: "PUT" });
    // The core's fence refuses a load that starts in the same millisecond as
    // an invalidation (its tie goes to the invalidation), so the GET that
    // is to be stored starts a little later.
    await Bun.sleep(2);
    const written = nextSet(cache);
    expect((await get("/posts/1")).status).toBe("MISS");
    await written;
    await router.fetch("/posts/1", { method: "DELETE" });
    expect((await get("/posts/1")).status).toBe("MISS");
  });

  test("a same-host Location is invalidated too; another host's is not", async () => {
    const { get, warm, router } = blog();
    await warm("/posts/5");
    await warm("/posts/6");
    await router.fetch("/posts/new", {
      method: "POST",
      headers: { "x-status": "201", "x-location": "/posts/5" },
    });
    expect((await get("/posts/5")).status).toBe("MISS");
    await router.fetch("/posts/new", {
      method: "POST",
      headers: {
        "x-status": "201",
        "x-location": "http://elsewhere.test/posts/6",
      },
    });
    expect((await get("/posts/6")).status).toBe("HIT");
  });

  test("invalidateOnUnsafe: false leaves entries alone", async () => {
    const { get, warm, router } = blog({
      ttl: 60_000,
      invalidateOnUnsafe: false,
    });
    await warm("/posts/1");
    await router.fetch("/posts/1", { method: "POST" });
    expect((await get("/posts/1")).status).toBe("HIT");
  });

  test("a GET right after the POST answered waits for the invalidation, in process", async () => {
    // A cache whose invalidation is slow: the GET must not read before it.
    const { get, warm, router, cache } = blog();
    await warm("/posts/1");
    const original = cache.invalidateTags.bind(cache);
    cache.invalidateTags = async (tags, options) => {
      await Bun.sleep(20);
      await original(tags, options);
    };
    await router.fetch("/posts/1", { method: "POST" });
    expect((await get("/posts/1")).status).toBe("MISS");
  });
});

describe("invalidation on demand", () => {
  test("pages.invalidate() takes a path, a URL or a Request", async () => {
    const { get, warm, pages } = blog();
    await warm("/posts/1");
    await warm("/posts/2");
    await warm("/posts/3");
    await pages.invalidate("/posts/1");
    await pages.invalidate("http://localhost/posts/2?ignored=1");
    await pages.invalidate(new Request("http://localhost/posts/3"));
    expect((await get("/posts/1")).status).toBe("MISS");
    expect((await get("/posts/2")).status).toBe("MISS");
    expect((await get("/posts/3")).status).toBe("MISS");
  });

  test("with host: true, invalidate() needs the host", async () => {
    const { pages } = blog({ ttl: 60_000, host: true });
    await expect(pages.invalidate("/posts/1")).rejects.toThrow(TypeError);
  });

  test("with host: true, an invalidation is per host", async () => {
    const { get, router, cache, pages } = blog({ ttl: 60_000, host: true });
    for (const host of ["a.test", "b.test"]) {
      const written = nextSet(cache);
      await router.fetch(`http://${host}/posts/1`);
      await written;
    }
    await pages.invalidate("http://a.test/posts/1");
    expect((await get("http://a.test/posts/1")).status).toBe("MISS");
    expect((await get("http://b.test/posts/1")).status).toBe("HIT");
  });

  test("addCacheTags() tags the entry; cache.invalidateTags() drops it", async () => {
    const { get, warm, cache } = blog();
    await warm("/posts/1");
    await warm("/posts/2");
    await cache.invalidateTags(["post:1"]);
    expect((await get("/posts/1")).status).toBe("MISS");
    expect((await get("/posts/2")).status).toBe("HIT");
  });

  test("the tags option, as a list or a function of the request", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    const handler = (_req: BunRequest, res: BunResponse) => {
      res.send("x");
    };
    router.get(
      "/a",
      cacheResponse(cache, { ttl: 60_000, tags: ["listing"] }),
      handler,
    );
    router.get(
      "/b/:slug",
      cacheResponse(cache, {
        ttl: 60_000,
        tags: (req) => [`slug:${String(req.params.slug)}`],
      }),
      handler,
    );
    let written = nextSet(cache);
    await router.fetch("/a");
    await written;
    written = nextSet(cache);
    await router.fetch("/b/hello");
    await written;
    await cache.invalidateTags(["listing", "slug:hello"]);
    expect((await router.fetch("/a")).headers.get("x-cache")).toBe("MISS");
    expect((await router.fetch("/b/hello")).headers.get("x-cache")).toBe(
      "MISS",
    );
  });

  test("a throwing tags function answers but stores nothing", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    router.get(
      "/t",
      cacheResponse(cache, {
        ttl: 60_000,
        tags: () => {
          throw new Error("bad tags");
        },
      }),
      (_req, res) => {
        res.send("still answered");
      },
    );
    const response = await router.fetch("/t");
    expect(await response.text()).toBe("still answered");
    await Bun.sleep(5);
    expect(await frameAt(cache, keyFor("/t"))).toBeUndefined();
  });

  test("addCacheTags() refuses an empty tag", () => {
    const res = {} as BunResponse;
    expect(() => addCacheTags(res, "")).toThrow(TypeError);
  });
});

describe("an invalidation and a write in flight", () => {
  /** A cache whose driver takes `lagMs` over every write, as a networked one does. */
  function slowWriteCache(lagMs: number) {
    const inner = memoryDriver();
    const driver = new Proxy(inner, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property === "set" && typeof value === "function") {
          return async (...args: Parameters<CacheDriver["set"]>) => {
            await Bun.sleep(lagMs);
            return await inner.set(...args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return createCache({ driver, sweepInterval: 0 });
  }

  /** A body that ends `afterMs` after it starts: its bytes, and so its write, come after the response. */
  function lateBody(text: string, afterMs: number): ReadableStream<Uint8Array> {
    return new ReadableStream({
      async start(controller) {
        await Bun.sleep(afterMs);
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  }

  for (const coalesce of [false, true]) {
    test(`invalidate() also drops a write in flight for the path (a streamed body, coalesce: ${String(coalesce)})`, async () => {
      const cache = slowWriteCache(20);
      const router = new BunRouter();
      const pages = cacheResponse(cache, {
        ttl: 60_000,
        coalesce,
        streams: { buffer: 1024 },
      });
      let runs = 0;
      router.get("/r", pages, (_req, res) => {
        runs++;
        res.send(lateBody(`#${runs}`, 30));
      });
      // The answer has started; its body, and then its write, are to come.
      const first = await router.fetch("/r");
      await pages.invalidate("/r");
      expect(await first.text()).toBe("#1");
      await Bun.sleep(80);
      expect(await frameAt(cache, keyFor("/r"))).toBeUndefined();
      expect(await (await router.fetch("/r")).text()).toBe("#2");
    });
  }

  test("an unsafe method's invalidation also drops a GET's write in flight", async () => {
    const cache = slowWriteCache(40);
    const router = new BunRouter();
    const pages = cacheResponse(cache, {
      ttl: 60_000,
      coalesce: false,
      streams: { buffer: 1024 },
    });
    router.use("/r", pages);
    let runs = 0;
    router.get("/r", (_req, res) => {
      runs++;
      res.send(lateBody(`#${runs}`, 30));
    });
    router.post("/r", (_req, res) => {
      res.send("ok");
    });
    const first = await router.fetch("/r");
    await router.fetch("/r", { method: "POST" });
    expect(await first.text()).toBe("#1");
    await Bun.sleep(80);
    expect(await frameAt(cache, keyFor("/r"))).toBeUndefined();
  });
});
