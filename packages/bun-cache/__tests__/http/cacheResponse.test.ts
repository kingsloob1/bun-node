/**
 * `cacheResponse()`'s core path (plan §9.1): a miss runs the handler and
 * stores its answer, a hit answers from the cache without calling `next()`,
 * with `Age`, the stored `ETag` (and a 304 for a matching conditional
 * request) and the status header; the key's parts (query, host, `varyBy`,
 * `key`); and which headers are stored.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type {
  BunRequest,
  BunResponse,
  NextFunction,
} from "@kingsleyweb/bun-common";
import { BunHttpAdapter, BunRouter, etag } from "@kingsleyweb/bun-common";
import { cacheResponse } from "../../lib/http/index";
import { frameAt, keyFor, makeHttpCache, nextSet } from "./helpers";

afterEach(() => {
  setSystemTime();
});

/** A router whose `/page` counts its runs and answers `body <n>`. */
function counted(
  options: Parameters<typeof cacheResponse>[1] = { ttl: 60_000 },
) {
  const cache = makeHttpCache();
  const router = new BunRouter();
  const pages = cacheResponse(cache, options);
  let runs = 0;
  router.get("/page", pages, (_req, res) => {
    runs++;
    res.send(`body ${runs}`);
  });
  return { cache, router, pages, runs: () => runs };
}

describe("miss, then hit", () => {
  test("the first request runs the handler; the next is answered from the cache", async () => {
    const { cache, router, runs } = counted();
    const written = nextSet(cache);
    const first = await router.fetch("/page");
    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(await first.text()).toBe("body 1");
    await written;

    const second = await router.fetch("/page");
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(second.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(await second.text()).toBe("body 1");
    expect(runs()).toBe(1);
  });

  test("a hit does not call next(): later middleware and the handler do not run", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    const seen: string[] = [];
    router.get(
      "/p",
      cacheResponse(cache, { ttl: 60_000 }),
      (_req: BunRequest, _res: BunResponse, next: NextFunction) => {
        seen.push("after");
        next();
      },
      (_req, res) => {
        seen.push("handler");
        res.json({ ok: true });
      },
    );
    const written = nextSet(cache);
    await router.fetch("/p");
    await written;
    await router.fetch("/p");
    expect(seen).toEqual(["after", "handler"]);
  });

  test("JSON keeps its type, status text and status on a hit", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    router.get("/j", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
      res.statusText("Fine").status(203).json({ a: 1 });
    });
    const written = nextSet(cache);
    await router.fetch("/j");
    await written;
    const hit = await router.fetch("/j");
    expect(hit.status).toBe(203);
    expect(hit.statusText).toBe("Fine");
    expect(hit.headers.get("content-type")).toBe(
      "application/json;charset=utf-8",
    );
    expect(await hit.json()).toEqual({ a: 1 });
  });

  test("the same through bun-common's BunHttpAdapter.fetch()", async () => {
    const cache = makeHttpCache();
    const adapter = new BunHttpAdapter(0);
    let runs = 0;
    adapter.get("/x", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
      runs++;
      res.send(`x${runs}`);
    });
    const written = nextSet(cache);
    expect(await (await adapter.fetch("/x")).text()).toBe("x1");
    await written;
    const hit = await adapter.fetch("/x");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("x1");
    expect(runs).toBe(1);
  });

  test("an entry past its TTL is a miss again", async () => {
    setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const { cache, router, runs } = counted({ ttl: 5_000 });
    const written = nextSet(cache);
    await router.fetch("/page");
    await written;
    setSystemTime(new Date("2026-10-28T10:00:04Z"));
    expect((await router.fetch("/page")).headers.get("x-cache")).toBe("HIT");
    setSystemTime(new Date("2026-10-28T10:00:06Z"));
    const later = await router.fetch("/page");
    expect(later.headers.get("x-cache")).toBe("MISS");
    expect(await later.text()).toBe("body 2");
    expect(runs()).toBe(2);
  });
});

describe("Age (RFC 9111 §5.1, §4.2.3)", () => {
  test("a hit's Age is the time it has spent in the cache, in whole seconds", async () => {
    setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const { cache, router } = counted();
    const written = nextSet(cache);
    const miss = await router.fetch("/page");
    expect(miss.headers.get("age")).toBeNull();
    await written;
    setSystemTime(new Date("2026-10-28T10:00:07.900Z"));
    expect((await router.fetch("/page")).headers.get("age")).toBe("7");
  });

  test("the response's own Age is carried and added to", async () => {
    setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const cache = makeHttpCache();
    const router = new BunRouter();
    router.get(
      "/proxied",
      cacheResponse(cache, { ttl: 60_000 }),
      (_req, res) => {
        res.setHeader("Age", "30");
        res.send("upstream");
      },
    );
    const written = nextSet(cache);
    await router.fetch("/proxied");
    await written;
    setSystemTime(new Date("2026-10-28T10:00:05Z"));
    expect((await router.fetch("/proxied")).headers.get("age")).toBe("35");
  });
});

describe("ETag and 304", () => {
  test("a hit carries the stored ETag and answers a matching If-None-Match with 304", async () => {
    const { cache, router } = counted();
    const written = nextSet(cache);
    const miss = await router.fetch("/page");
    const tag = miss.headers.get("etag");
    expect(tag).not.toBeNull();
    await written;
    const hit = await router.fetch("/page");
    expect(hit.headers.get("etag")).toBe(tag);
    const conditional = await router.fetch("/page", {
      headers: { "if-none-match": tag! },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("x-cache")).toBe("HIT");
    expect(await conditional.text()).toBe("");
  });

  test("a stored response without an ETag gets one computed (sent on the miss too); etag: false leaves it out", async () => {
    // BunHttpAdapter tags nothing by default (its `etag` option is off), so
    // any ETag here is the cache's.
    const adapter = new BunHttpAdapter(0);
    const cache = makeHttpCache();
    adapter.get("/on", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
      res.send("on");
    });
    adapter.get(
      "/off",
      cacheResponse(cache, { ttl: 60_000, etag: false }),
      (_req, res) => {
        res.send("off");
      },
    );
    let written = nextSet(cache);
    const onMiss = await adapter.fetch("/on");
    expect(onMiss.headers.get("etag")).toMatch(/^"2-/);
    await written;
    expect((await adapter.fetch("/on")).headers.get("etag")).toBe(
      onMiss.headers.get("etag"),
    );

    written = nextSet(cache);
    expect((await adapter.fetch("/off")).headers.get("etag")).toBeNull();
    await written;
    const offHit = await adapter.fetch("/off");
    expect(offHit.headers.get("x-cache")).toBe("HIT");
    expect(offHit.headers.get("etag")).toBeNull();
  });

  test("a conditional miss gets its 304 from the captured response, and the full response is stored", async () => {
    const { cache, router, runs } = counted();
    const written = nextSet(cache);
    const conditional = await router.fetch("/page", {
      headers: { "if-none-match": `"other", ${etag("body 1")}` },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("x-cache")).toBe("MISS");
    expect(conditional.headers.get("etag")).toBe(etag("body 1"));
    await written;
    const hit = await router.fetch("/page");
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("body 1");
    expect(runs()).toBe(1);
  });

  test("a conditional miss on a handler with its own ETag: the handler is not let answer 304, so the body is stored", async () => {
    // A handler that sets a header takes bun-common's full send path, which
    // would answer a matching If-None-Match with a body-less 304 itself.
    const cache = makeHttpCache();
    const router = new BunRouter();
    let runs = 0;
    router.get("/own", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
      runs++;
      res.setHeader("ETag", '"v1"');
      res.send("versioned");
    });
    const written = nextSet(cache);
    const conditional = await router.fetch("/own", {
      headers: { "if-none-match": '"v1"' },
    });
    expect(conditional.status).toBe(304);
    await written;
    const hit = await router.fetch("/own");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("versioned");
    expect(runs).toBe(1);
  });

  test("a conditional miss whose validator does not match gets the full response", async () => {
    const { router } = counted();
    const response = await router.fetch("/page", {
      headers: { "if-none-match": '"stale"' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body 1");
  });

  test("If-Modified-Since against a stored Last-Modified answers 304 on a hit", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    const modified = "Tue, 27 Oct 2026 10:00:00 GMT";
    router.get("/lm", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
      res.setHeader("Last-Modified", modified);
      res.send("lm");
    });
    const written = nextSet(cache);
    await router.fetch("/lm");
    await written;
    const conditional = await router.fetch("/lm", {
      headers: { "if-modified-since": "Wed, 28 Oct 2026 10:00:00 GMT" },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("last-modified")).toBe(modified);
  });
});

describe("the status header", () => {
  test("statusHeader renames it; false sends none", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    router.get(
      "/a",
      cacheResponse(cache, { ttl: 60_000, statusHeader: "CDN-Cache" }),
      (_req, res) => {
        res.send("a");
      },
    );
    router.get(
      "/b",
      cacheResponse(cache, { ttl: 60_000, statusHeader: false }),
      (_req, res) => {
        res.send("b");
      },
    );
    let written = nextSet(cache);
    await router.fetch("/a");
    await written;
    const a = await router.fetch("/a");
    expect(a.headers.get("cdn-cache")).toBe("HIT");
    expect(a.headers.get("x-cache")).toBeNull();
    written = nextSet(cache);
    await router.fetch("/b");
    await written;
    expect((await router.fetch("/b")).headers.get("x-cache")).toBeNull();
    // Never stored, whatever its name.
    const frame = await frameAt(cache, keyFor("/a"));
    expect(
      frame?.kind === "response" &&
        frame.response.meta.headers.some(([n]) => n === "cdn-cache"),
    ).toBe(false);
  });

  test("bypass skips the cache: BYPASS, no read, no store", async () => {
    const { cache, router, runs } = counted({
      ttl: 60_000,
      bypass: (req) => req.getHeader("x-preview") === "1",
    });
    const preview = { headers: { "x-preview": "1" } };
    const first = await router.fetch("/page", preview);
    expect(first.headers.get("x-cache")).toBe("BYPASS");
    expect(await frameAt(cache, keyFor("/page"))).toBeUndefined();
    const written = nextSet(cache);
    await router.fetch("/page");
    await written;
    const second = await router.fetch("/page", preview);
    expect(second.headers.get("x-cache")).toBe("BYPASS");
    expect(await second.text()).toBe("body 3");
    expect(runs()).toBe(3);
  });
});

describe("the key", () => {
  test("the query is sorted by name, so the same parameters in another order hit", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    let runs = 0;
    router.get("/q", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
      runs++;
      res.send(String(runs));
    });
    const written = nextSet(cache);
    await router.fetch("/q?b=2&a=1&a=0");
    await written;
    expect(await (await router.fetch("/q?a=1&a=0&b=2")).text()).toBe("1");
    // Repeated names keep their order: a different list is a different key.
    expect(await (await router.fetch("/q?a=0&a=1&b=2")).text()).toBe("2");
  });

  test("query: [names] keeps only those; query: false ignores the query", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    let runs = 0;
    const handler = (_req: BunRequest, res: BunResponse) => {
      runs++;
      res.send(String(runs));
    };
    router.get(
      "/some",
      cacheResponse(cache, { ttl: 60_000, query: ["page"] }),
      handler,
    );
    router.get(
      "/none",
      cacheResponse(cache, { ttl: 60_000, query: false }),
      handler,
    );
    let written = nextSet(cache);
    await router.fetch("/some?page=2&utm=x");
    await written;
    expect(await (await router.fetch("/some?utm=y&page=2")).text()).toBe("1");
    written = nextSet(cache);
    expect(await (await router.fetch("/some?page=3")).text()).toBe("2");
    await written;
    written = nextSet(cache);
    await router.fetch("/none?x=1");
    await written;
    expect(await (await router.fetch("/none?y=2")).text()).toBe("3");
  });

  test("host: true keys by host; the default shares one entry across hosts", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    let runs = 0;
    const handler = (_req: BunRequest, res: BunResponse) => {
      runs++;
      res.send(String(runs));
    };
    router.get("/shared", cacheResponse(cache, { ttl: 60_000 }), handler);
    router.get(
      "/split",
      cacheResponse(cache, { ttl: 60_000, host: true }),
      handler,
    );
    let written = nextSet(cache);
    await router.fetch("http://a.test/shared");
    await written;
    expect(await (await router.fetch("http://b.test/shared")).text()).toBe("1");
    written = nextSet(cache);
    await router.fetch("http://a.test/split");
    await written;
    expect(await (await router.fetch("http://b.test/split")).text()).toBe("3");
  });

  test("varyBy puts request headers in the key", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    router.get(
      "/v",
      cacheResponse(cache, { ttl: 60_000, varyBy: ["X-Tenant"] }),
      (req, res) => {
        res.send(`tenant ${req.getHeader("x-tenant")}`);
      },
    );
    let written = nextSet(cache);
    await router.fetch("/v", { headers: { "x-tenant": "a" } });
    await written;
    written = nextSet(cache);
    expect(
      await (await router.fetch("/v", { headers: { "x-tenant": "b" } })).text(),
    ).toBe("tenant b");
    await written;
    const a = await router.fetch("/v", { headers: { "x-tenant": "a" } });
    expect(a.headers.get("x-cache")).toBe("HIT");
    expect(await a.text()).toBe("tenant a");
  });

  test("a key function replaces path, query, host and varyBy", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    let runs = 0;
    router.get(
      "/k/:id",
      cacheResponse(cache, {
        ttl: 60_000,
        key: (req) => req.originalUrl.split("/")[2].split("?")[0],
      }),
      (_req, res) => {
        runs++;
        res.send(String(runs));
      },
    );
    const written = nextSet(cache);
    await router.fetch("/k/7?x=1");
    await written;
    expect(await (await router.fetch("/k/7?x=2")).text()).toBe("1");
    expect(
      await frameAt(cache, `http:${JSON.stringify(["GET", "key", "7"])}`),
    ).toBeDefined();
  });
});

describe("what is stored", () => {
  test("headers set by middleware ahead of the cache are not replayed; those the handler sets are", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    let request = 0;
    router.use((_req, res, next) => {
      request++;
      res.setHeader("X-Request-Id", `r${request}`);
      next();
    });
    router.get("/h", cacheResponse(cache, { ttl: 60_000 }), (_req, res) => {
      res.setHeader("X-Built-By", "handler");
      res.send("h");
    });
    const written = nextSet(cache);
    await router.fetch("/h");
    await written;
    const hit = await router.fetch("/h");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.get("x-request-id")).toBe("r2");
    expect(hit.headers.get("x-built-by")).toBe("handler");
  });

  test("hop-by-hop fields, Content-Length and omitHeaders are dropped", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    router.get(
      "/drop",
      cacheResponse(cache, { ttl: 60_000, omitHeaders: ["X-Secret"] }),
      (_req, res) => {
        res.setHeader("Connection", "x-conn-only");
        res.setHeader("X-Conn-Only", "1");
        res.setHeader("Keep-Alive", "timeout=5");
        res.setHeader("X-Secret", "s");
        res.setHeader("X-Kept", "k");
        res.send("drop");
      },
    );
    const written = nextSet(cache);
    await router.fetch("/drop");
    await written;
    const frame = await frameAt(cache, keyFor("/drop"));
    expect(frame?.kind).toBe("response");
    const names =
      frame?.kind === "response"
        ? frame.response.meta.headers.map(([name]) => name)
        : [];
    expect(names).toContain("x-kept");
    for (const dropped of [
      "connection",
      "x-conn-only",
      "keep-alive",
      "x-secret",
      "content-length",
      "x-cache",
    ]) {
      expect(names).not.toContain(dropped);
    }
  });

  test("an answer already sent by an earlier layer is left alone", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    router.get(
      "/sent",
      (_req, res, next) => {
        res.send("early");
        next();
      },
      cacheResponse(cache, { ttl: 60_000 }),
    );
    const response = await router.fetch("/sent");
    expect(await response.text()).toBe("early");
    expect(response.headers.get("x-cache")).toBeNull();
  });
});

describe("options", () => {
  test("bad options throw when the middleware is built", () => {
    const cache = makeHttpCache();
    expect(() => cacheResponse(cache, { ttl: -1 })).toThrow(RangeError);
    expect(() => cacheResponse(cache, { uncacheableTtl: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => cacheResponse(cache, { coalesce: { wait: -5 } })).toThrow(
      RangeError,
    );
    expect(() => cacheResponse(cache, { statusHeader: "" })).toThrow(TypeError);
  });
});
