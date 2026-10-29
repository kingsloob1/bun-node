/**
 * `cacheResponse({ surrogateKeys })` (plan §9.3, R27): each answer's tags in
 * a CDN's purge header — Fastly's `Surrogate-Key` (space-separated, case
 * sensitive) or Cloudflare's `Cache-Tag` (comma-separated, case
 * insensitive). The formats and their limits, a tag that breaks them (left
 * out, warned once, never an error), merging with a header already set,
 * every kind of answer (MISS, HIT, STALE, UNCACHEABLE, 304, HEAD, a coalesced
 * follower; not BYPASS), and the default `false`, through `router.fetch()`.
 */
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type {
  BunRequest,
  BunResponse,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import {
  BunRouter,
  createDeferred,
  createTestLogger,
} from "@kingsleyweb/bun-common";
import type { Cache, CacheEventMap } from "../../lib/index";
import { createCache, memoryDriver } from "../../lib/index";
import { memoryDriverDump } from "../../lib/drivers/memory";
import type { CacheResponseOptions } from "../../lib/http/index";
import { addCacheTags, cacheResponse } from "../../lib/http/index";
import type { SurrogateSkip } from "../../lib/http/surrogate";
import {
  MAX_HEADER_BYTES,
  MAX_TAG_BYTES,
  surrogateFormat,
  surrogateHeaderValue,
} from "../../lib/http/surrogate";
import type { StoredResponseMeta } from "../../lib/http/frame";
import { decodeFrame, encodeResponse } from "../../lib/http/frame";
import { frameAt, keyFor, makeHttpCache, nextSet } from "./helpers";

afterEach(() => {
  setSystemTime();
});

/** The path tag `cacheResponse()` gives every entry for `path`. */
const pathTagOf = (path: string): string => `http:path:${path}`;

/** {@link surrogateHeaderValue} with the skipped tags collected. */
function value(
  header: "Surrogate-Key" | "Cache-Tag",
  existing: string | undefined,
  tags: readonly string[],
): { value: string | undefined; skipped: [string, SurrogateSkip][] } {
  const skipped: [string, SurrogateSkip][] = [];
  const out = surrogateHeaderValue(
    surrogateFormat(header),
    existing,
    tags,
    (tag, reason) => {
      skipped.push([tag, reason]);
    },
  );
  return { value: out, skipped };
}

describe("the header formats", () => {
  test("Surrogate-Key joins with spaces, Cache-Tag with commas; nothing to set is undefined", () => {
    expect(value("Surrogate-Key", undefined, ["a", "b:1"]).value).toBe("a b:1");
    expect(value("Cache-Tag", undefined, ["a", "b:1"]).value).toBe("a,b:1");
    expect(value("Cache-Tag", undefined, []).value).toBeUndefined();
  });

  test("a tag holding the separator is left out: a space for Surrogate-Key, a comma for Cache-Tag", () => {
    expect(value("Surrogate-Key", undefined, ["a b", "c,d"])).toEqual({
      value: "c,d",
      skipped: [["a b", "separator"]],
    });
    expect(value("Cache-Tag", undefined, ["c,d", "a b"])).toEqual({
      value: undefined,
      skipped: [
        ["c,d", "separator"],
        ["a b", "character"],
      ],
    });
  });

  test("whitespace, control characters and non-ASCII are left out of both", () => {
    for (const header of ["Surrogate-Key", "Cache-Tag"] as const) {
      const out = value(header, undefined, [
        "tab\there",
        "line\r\nbreak",
        "café",
        "emoji-😀",
        "ok",
      ]);
      expect(out.value).toBe("ok");
      expect(out.skipped.map(([, reason]) => reason)).toEqual([
        "character",
        "character",
        "character",
        "character",
      ]);
    }
  });

  test(`a tag of ${MAX_TAG_BYTES} bytes goes in; one byte more is too long`, () => {
    const fits = "k".repeat(MAX_TAG_BYTES);
    const over = "k".repeat(MAX_TAG_BYTES + 1);
    expect(value("Surrogate-Key", undefined, [fits, over])).toEqual({
      value: fits,
      skipped: [[over, "too-long"]],
    });
  });

  test(`the header stops at ${MAX_HEADER_BYTES} bytes, leaving out only the tags that do not fit`, () => {
    // 16 tags of 998 bytes (+15 separators) = 15,983: a 17th does not
    // fit, a 1-byte one after it still does (15,985).
    const big = Array.from(
      { length: 17 },
      (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(996)}`,
    );
    const out = value("Cache-Tag", undefined, [...big, "z"]);
    expect(out.value!.length).toBe(15_985);
    expect(out.value!.split(",")).toHaveLength(17);
    expect(out.value!.endsWith(",z")).toBe(true);
    expect(out.skipped).toEqual([[big[16], "header-full"]]);
    // Exactly 16,000 bytes fits; one more tag does not.
    const exact = [
      ...Array.from(
        { length: 15 },
        (_, i) => `${String(i).padStart(2, "0")}${"y".repeat(997)}`,
      ),
      "w".repeat(1000),
    ];
    const full = value("Cache-Tag", undefined, [...exact, "z"]);
    expect(full.value!.length).toBe(MAX_HEADER_BYTES);
    expect(full.skipped).toEqual([["z", "header-full"]]);
  });

  test("merging keeps what was set first and verbatim, de-duplicated; Cache-Tag compares case-insensitively", () => {
    expect(
      value("Surrogate-Key", "  own  post:7 own ", ["post:7", "Post:7", "x"])
        .value,
    ).toBe("own post:7 Post:7 x");
    expect(value("Cache-Tag", "own, Post:7,,", ["post:7", "x"]).value).toBe(
      "own,Post:7,x",
    );
  });
});

describe("the stored tags", () => {
  test("a frame's tags must be strings: a frame with anything else is not a frame", () => {
    const meta: StoredResponseMeta = {
      status: 200,
      statusText: "",
      headers: [],
      storedAt: 0,
      age: 0,
      freshUntil: null,
      staleWhileRevalidate: 0,
      staleIfError: 0,
      tags: ["a"],
    };
    const body = new Uint8Array(0);
    expect(decodeFrame(encodeResponse({ meta, body }))?.kind).toBe("response");
    const bad = { ...meta, tags: [1] } as unknown as StoredResponseMeta;
    expect(decodeFrame(encodeResponse({ meta: bad, body }))).toBeUndefined();
  });
});

/** A router with `/posts/:id` cached, tagging `post:<id>` and the route's `post`; records each run. */
function fixture(
  options: CacheResponseOptions = {},
  answer: (req: BunRequest, res: BunResponse) => void = (_req, res) => {
    res.send("post");
  },
) {
  const cache = makeHttpCache();
  const { logger, events } = createTestLogger();
  const router = new BunRouter();
  let runs = 0;
  const pages = cacheResponse(cache, {
    ttl: 60_000,
    tags: ["post"],
    logger,
    ...options,
  });
  router.get("/posts/:id", pages, (req, res) => {
    runs++;
    addCacheTags(res, `post:${String(req.params.id)}`);
    answer(req, res);
  });
  return {
    cache,
    router,
    pages,
    events,
    warnings: () => events.filter((event) => event.level === "warn"),
    runs: () => runs,
  };
}

/** The tags `fixture()` gives `/posts/7`, in order. */
const POST_7 = [pathTagOf("/posts/7"), "post", "post:7"];

describe("surrogateKeys over the pipeline", () => {
  test("false (the default) sends neither header and keeps no tags in the frame", async () => {
    for (const options of [{}, { surrogateKeys: false as const }]) {
      const f = fixture(options);
      const written = nextSet(f.cache);
      const miss = await f.router.fetch("/posts/7");
      await written;
      const hit = await f.router.fetch("/posts/7");
      const head = await f.router.fetch("/posts/7", { method: "HEAD" });
      const headMiss = await f.router.fetch("/posts/8", { method: "HEAD" });
      for (const response of [miss, hit, head, headMiss]) {
        expect(response.headers.get("surrogate-key")).toBeNull();
        expect(response.headers.get("cache-tag")).toBeNull();
      }
      expect(hit.headers.get("x-cache")).toBe("HIT");
      const frame = await frameAt(f.cache, keyFor("/posts/7"));
      expect(frame?.kind).toBe("response");
      expect(
        frame?.kind === "response" ? frame.response.meta.tags : "none",
      ).toBeUndefined();
    }
  });

  for (const [header, separator] of [
    ["Surrogate-Key", " "],
    ["Cache-Tag", ","],
  ] as const) {
    test(`${header}: MISS, HIT, 304 and HEAD (hit and miss) carry the entry's tags`, async () => {
      const f = fixture({ surrogateKeys: header });
      const expected = POST_7.join(separator);
      const written = nextSet(f.cache);
      const miss = await f.router.fetch("/posts/7");
      expect(miss.headers.get("x-cache")).toBe("MISS");
      expect(miss.headers.get(header)).toBe(expected);
      await written;

      const hit = await f.router.fetch("/posts/7");
      expect(hit.headers.get("x-cache")).toBe("HIT");
      expect(hit.headers.get(header)).toBe(expected);
      expect(await hit.text()).toBe("post");

      const notModified = await f.router.fetch("/posts/7", {
        headers: { "if-none-match": hit.headers.get("etag")! },
      });
      expect(notModified.status).toBe(304);
      expect(notModified.headers.get(header)).toBe(expected);

      const headHit = await f.router.fetch("/posts/7", { method: "HEAD" });
      expect(headHit.headers.get("x-cache")).toBe("HIT");
      expect(headHit.headers.get(header)).toBe(expected);

      const headMiss = await f.router.fetch("/posts/9", { method: "HEAD" });
      expect(headMiss.headers.get("x-cache")).toBe("MISS");
      expect(headMiss.headers.get(header)).toBe(
        [pathTagOf("/posts/9"), "post", "post:9"].join(separator),
      );
      expect(f.runs()).toBe(2);
      expect(f.warnings()).toEqual([]);
    });
  }

  test("a conditional miss's 304 carries it too", async () => {
    const f = fixture({ surrogateKeys: "Surrogate-Key" }, (_req, res) => {
      res.setHeader("ETag", '"v1"');
      res.send("post");
    });
    const conditional = await f.router.fetch("/posts/7", {
      headers: { "if-none-match": '"v1"' },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("x-cache")).toBe("MISS");
    expect(conditional.headers.get("surrogate-key")).toBe(POST_7.join(" "));
  });

  test("merging: the handler's own header first, de-duplicated, on the miss and on every hit", async () => {
    const f = fixture({ surrogateKeys: "Surrogate-Key" }, (_req, res) => {
      res.setHeader("Surrogate-Key", "own post:7");
      res.send("post");
    });
    const expected = ["own", "post:7", pathTagOf("/posts/7"), "post"].join(" ");
    const written = nextSet(f.cache);
    expect(
      (await f.router.fetch("/posts/7")).headers.get("surrogate-key"),
    ).toBe(expected);
    await written;
    const hit = await f.router.fetch("/posts/7");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.get("surrogate-key")).toBe(expected);
  });

  test("merging: a header a middleware ahead set (not stored) is merged on every hit", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    router.use((_req, res, next) => {
      res.setHeader("Cache-Tag", "Site");
      next();
    });
    router.get(
      "/p",
      cacheResponse(cache, {
        ttl: 60_000,
        surrogateKeys: "Cache-Tag",
        tags: ["site", "p"],
      }),
      (_req, res) => {
        res.send("p");
      },
    );
    const written = nextSet(cache);
    const miss = await router.fetch("/p");
    await written;
    const hit = await router.fetch("/p");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    // `site` is `Site` to Cloudflare: kept once, as the middleware wrote it.
    for (const response of [miss, hit]) {
      expect(response.headers.get("cache-tag")).toBe(
        `Site,${pathTagOf("/p")},p`,
      );
    }
  });

  test("the other CDN's header, set by the handler, is left as it is", async () => {
    const f = fixture({ surrogateKeys: "Cache-Tag" }, (_req, res) => {
      res.setHeader("Surrogate-Key", "fastly-only");
      res.send("post");
    });
    const miss = await f.router.fetch("/posts/7");
    expect(miss.headers.get("surrogate-key")).toBe("fastly-only");
    expect(miss.headers.get("cache-tag")).toBe(POST_7.join(","));
  });

  test("a tag that breaks the format is left out, warned once, and the answer and the entry are unaffected", async () => {
    const f = fixture({ surrogateKeys: "Surrogate-Key" }, (_req, res) => {
      addCacheTags(res, "has space", "k".repeat(MAX_TAG_BYTES + 1));
      res.send("post");
    });
    const written = nextSet(f.cache);
    const miss = await f.router.fetch("/posts/7");
    expect(miss.status).toBe(200);
    expect(miss.headers.get("surrogate-key")).toBe(POST_7.join(" "));
    await written;
    const hit = await f.router.fetch("/posts/7");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.get("surrogate-key")).toBe(POST_7.join(" "));
    expect(await hit.text()).toBe("post");
    const warnings = f.warnings();
    expect(warnings.map((event) => event.fields.reason)).toEqual([
      "separator",
      "too-long",
    ]);
    expect(warnings[0].fields).toMatchObject({
      header: "Surrogate-Key",
      tag: "has space",
    });
    expect(String(warnings[1].fields.tag)).toHaveLength(101);
    // The entry still carries every tag: the cache invalidates by them.
    const dropped = f.cache.invalidateTags(["has space"]);
    await dropped;
    expect((await f.router.fetch("/posts/7")).headers.get("x-cache")).toBe(
      "MISS",
    );
    expect(f.warnings()).toHaveLength(2);
  });

  test("Cache-Tag leaves out a tag holding a comma", async () => {
    const f = fixture({ surrogateKeys: "Cache-Tag" }, (_req, res) => {
      addCacheTags(res, "a,b");
      res.send("post");
    });
    const miss = await f.router.fetch("/posts/7");
    expect(miss.headers.get("cache-tag")).toBe(POST_7.join(","));
    expect(f.warnings().map((event) => event.fields.reason)).toEqual([
      "separator",
    ]);
  });

  test("an answer not stored (UNCACHEABLE) carries it; BYPASS does not", async () => {
    const f = fixture(
      {
        surrogateKeys: "Surrogate-Key",
        bypass: (req) => req.getHeader("x-preview") === "1",
      },
      (_req, res) => {
        res.setHeader("Cache-Control", "private");
        res.send("mine");
      },
    );
    const uncacheable = await f.router.fetch("/posts/7");
    expect(uncacheable.headers.get("x-cache")).toBe("UNCACHEABLE");
    expect(uncacheable.headers.get("surrogate-key")).toBe(POST_7.join(" "));
    const bypass = await f.router.fetch("/posts/7", {
      headers: { "x-preview": "1" },
    });
    expect(bypass.headers.get("x-cache")).toBe("BYPASS");
    expect(bypass.headers.get("surrogate-key")).toBeNull();
  });

  test("a throwing tags function: answered, not stored, no header", async () => {
    const f = fixture({
      surrogateKeys: "Surrogate-Key",
      tags: () => {
        throw new Error("no tags");
      },
    });
    const miss = await f.router.fetch("/posts/7");
    expect(miss.status).toBe(200);
    expect(miss.headers.get("surrogate-key")).toBeNull();
  });

  test("a coalesced follower's answer carries it", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    const gate = createDeferred<void>();
    let runs = 0;
    router.get(
      "/slow",
      cacheResponse(cache, {
        ttl: 60_000,
        surrogateKeys: "Surrogate-Key",
        tags: ["slow"],
      }),
      async (_req, res) => {
        runs++;
        await gate.promise;
        res.send("slow");
      },
    );
    const leader = router.fetch("/slow");
    await Bun.sleep(5);
    const follower = router.fetch("/slow");
    await Bun.sleep(5);
    gate.resolve();
    const [led, followed] = await Promise.all([leader, follower]);
    expect(runs).toBe(1);
    expect(followed.headers.get("x-cache")).toBe("HIT");
    for (const response of [led, followed]) {
      expect(response.headers.get("surrogate-key")).toBe(
        `${pathTagOf("/slow")} slow`,
      );
    }
  });

  test("an entry stored before the option was on carries the core entry's tags", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    const handler = (_req: BunRequest, res: BunResponse): void => {
      res.send("old");
    };
    router.get(
      "/old",
      cacheResponse(cache, { ttl: 60_000, tags: ["old"] }),
      handler,
    );
    const written = nextSet(cache);
    await router.fetch("/old");
    await written;
    // The same cache, now behind a middleware that sends the header.
    const later = new BunRouter();
    later.get(
      "/old",
      cacheResponse(cache, {
        ttl: 60_000,
        tags: ["old"],
        surrogateKeys: "Cache-Tag",
      }),
      handler,
    );
    const hit = await later.fetch("/old");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.get("cache-tag")).toBe(`${pathTagOf("/old")},old`);
  });

  test("rejects anything but the two headers and false", () => {
    const cache = makeHttpCache();
    for (const surrogateKeys of ["surrogate-key", "Surrogate-Control", true]) {
      expect(() =>
        cacheResponse(cache, {
          surrogateKeys: surrogateKeys as CacheResponseOptions["surrogateKeys"],
        }),
      ).toThrow(TypeError);
    }
  });
});

describe("surrogateKeys on stale answers", () => {
  /** 2026-10-29T10:00:00Z. */
  const T0 = Date.parse("2026-10-29T10:00:00Z");
  const at = (seconds: number): void => {
    setSystemTime(new Date(T0 + seconds * 1000));
  };

  /** `/r`, fresh 10 s, SWR 60 s and SIE 600 s, failing (503) from `fail()` on. */
  function staleFixture(revalidate: boolean) {
    const cache = makeHttpCache();
    const router = new BunRouter();
    let failing = false;
    router.get(
      "/r",
      cacheResponse(cache, {
        surrogateKeys: "Surrogate-Key",
        tags: ["r"],
        ...(revalidate ? { revalidate: router } : {}),
      }),
      (_req, res) => {
        if (failing) {
          throw new Error("origin down");
        }
        res.setHeader(
          "Cache-Control",
          "max-age=10, stale-while-revalidate=60, stale-if-error=600",
        );
        res.send("r");
      },
    );
    router.use(((_err, _req, res, _next) => {
      res.status(503).send("down");
    }) satisfies RouterErrorMiddlewareHandler);
    return {
      cache,
      router,
      fail: () => {
        failing = true;
      },
    };
  }

  const R = `${pathTagOf("/r")} r`;

  test("STALE inside stale-while-revalidate carries it", async () => {
    const f = staleFixture(true);
    at(0);
    const written = nextSet(f.cache);
    await f.router.fetch("/r");
    await written;
    at(15);
    const refreshed = nextSet(f.cache);
    const stale = await f.router.fetch("/r");
    expect(stale.headers.get("x-cache")).toBe("STALE");
    expect(stale.headers.get("surrogate-key")).toBe(R);
    await refreshed;
  });

  test("STALE answering a 5xx (stale-if-error) carries it", async () => {
    const f = staleFixture(false);
    at(0);
    const written = nextSet(f.cache);
    await f.router.fetch("/r");
    await written;
    f.fail();
    at(100);
    const rescued = await f.router.fetch("/r");
    expect(rescued.status).toBe(200);
    expect(rescued.headers.get("x-cache")).toBe("STALE");
    expect(rescued.headers.get("surrogate-key")).toBe(R);
  });

  test("STALE answered by hardTimeout, and a HEAD answered stale, carry it", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    let slow = false;
    router.get(
      "/t",
      cacheResponse(cache, {
        surrogateKeys: "Cache-Tag",
        tags: ["t"],
        staleIfError: 600_000,
        hardTimeout: 20,
      }),
      async (_req, res) => {
        if (slow) {
          await Bun.sleep(200);
        }
        res.setHeader("Cache-Control", "max-age=10, stale-while-revalidate=60");
        res.send("t");
      },
    );
    at(0);
    const written = nextSet(cache);
    await router.fetch("/t");
    await written;
    at(15);
    const head = await router.fetch("/t", { method: "HEAD" });
    expect(head.headers.get("x-cache")).toBe("STALE");
    expect(head.headers.get("cache-tag")).toBe(`${pathTagOf("/t")},t`);
    slow = true;
    at(100);
    const timedOut = await router.fetch("/t");
    expect(timedOut.headers.get("x-cache")).toBe("STALE");
    expect(timedOut.headers.get("cache-tag")).toBe(`${pathTagOf("/t")},t`);
  });
});

describe("purging a CDN by the same tags (the README recipe)", () => {
  test("the invalidate event names, in plain text, tags the header carried", async () => {
    const f = fixture({ surrogateKeys: "Surrogate-Key" });
    f.router.delete("/posts/:id", f.pages, (_req, res) => {
      res.status(204).send("");
    });
    const purged: string[][] = [];
    f.cache.on("invalidate", (event: CacheEventMap["invalidate"]) => {
      purged.push([...event.tags]);
    });
    const written = nextSet(f.cache);
    const sent = (await f.router.fetch("/posts/7")).headers
      .get("surrogate-key")!
      .split(" ");
    await written;
    await f.cache.invalidateTags(["post:7"]);
    await f.pages.invalidate("/posts/7");
    await f.router.fetch("/posts/7", { method: "DELETE" });
    await Bun.sleep(5);
    expect(purged).toEqual([
      ["post:7"],
      [pathTagOf("/posts/7")],
      [pathTagOf("/posts/7")],
    ]);
    for (const tags of purged) {
      for (const tag of tags) {
        expect(sent).toContain(tag);
      }
    }
  });

  test("under encrypt.hashNames the header is plain text, and the store still holds no tag", async () => {
    const driver = memoryDriver();
    const cache: Cache = createCache({
      driver,
      sweepInterval: 0,
      encrypt: {
        keys: [{ id: "k1", key: new Uint8Array(32).fill(1) }],
        hashNames: { key: new Uint8Array(32).fill(2) },
      },
    });
    const router = new BunRouter();
    router.get(
      "/a",
      cacheResponse(cache, { ttl: 60_000, surrogateKeys: "Cache-Tag" }),
      (_req, res) => {
        addCacheTags(res, "tenant-secret-tag");
        res.send("a");
      },
    );
    const written = nextSet(cache);
    await router.fetch("/a");
    await written;
    const hit = await router.fetch("/a");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.get("cache-tag")).toBe(
      `${pathTagOf("/a")},tenant-secret-tag`,
    );
    const needle = Buffer.from("tenant-secret-tag");
    const dump = memoryDriverDump(driver);
    expect(dump.length).toBeGreaterThan(0);
    expect(dump.some((chunk) => Buffer.from(chunk).includes(needle))).toBe(
      false,
    );
  });
});
