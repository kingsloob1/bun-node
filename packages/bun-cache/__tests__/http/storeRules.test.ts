/**
 * Which responses `cacheResponse()` stores, and for how long (plan §9.1;
 * RFC 9111 §3 for a shared cache, §4.2.1 for the lifetime, §5.2.2 for the
 * directives). Each refusal is checked by its effect: the next identical
 * request runs the handler again, and nothing fresh is at the key.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";
import type { CacheResponseOptions } from "../../lib/http/index";
import { cacheResponse } from "../../lib/http/index";
import { frameAt, keyFor, makeHttpCache, nextSet } from "./helpers";

afterEach(() => {
  setSystemTime();
});

/**
 * Serves `/r` with `handler` under `options`, twice, and answers what the
 * second request saw and how many times the handler ran. The first
 * response's write (or marker) is awaited before the second request.
 */
async function twice(
  handler: (req: BunRequest, res: BunResponse) => void,
  options: CacheResponseOptions = { ttl: 60_000 },
  init: RequestInit = {},
  /** Whether the first response writes something (an entry or a marker) to wait for. */
  writes = true,
) {
  const cache = makeHttpCache();
  const router = new BunRouter();
  let runs = 0;
  router.get("/r", cacheResponse(cache, options), (req, res) => {
    runs++;
    handler(req, res);
  });
  const written = writes ? nextSet(cache) : Bun.sleep(5);
  const first = await router.fetch("/r", init);
  await written;
  const second = await router.fetch("/r", init);
  return {
    cache,
    first,
    second,
    runs,
    frame: await frameAt(cache, keyFor("/r")),
  };
}

/** Asserts the response was not stored: the handler ran twice and the key holds the hit-for-miss marker. */
function expectRefused(result: Awaited<ReturnType<typeof twice>>): void {
  expect(result.runs).toBe(2);
  expect(result.first.headers.get("x-cache")).toBe("UNCACHEABLE");
  expect(result.frame?.kind).toBe("uncacheable");
}

describe("refused (RFC 9111 §3)", () => {
  test("Cache-Control: no-store", async () => {
    expectRefused(
      await twice((_req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.send("x");
      }),
    );
  });

  test("Cache-Control: private", async () => {
    expectRefused(
      await twice((_req, res) => {
        res.setHeader("Cache-Control", "private, max-age=60");
        res.send("x");
      }),
    );
  });

  test("Cache-Control: no-cache (every reuse would need a revalidation)", async () => {
    expectRefused(
      await twice((_req, res) => {
        res.setHeader("Cache-Control", "no-cache");
        res.send("x");
      }),
    );
  });

  test("a status outside statuses (a 500, a 302)", async () => {
    expectRefused(
      await twice((_req, res) => {
        res.status(500).send("boom");
      }),
    );
    expectRefused(
      await twice((_req, res) => {
        res.redirect(302, "/elsewhere");
      }),
    );
  });

  test("a Set-Cookie from the handler, unless allowSetCookie", async () => {
    expectRefused(
      await twice((_req, res) => {
        res.cookie("session", "abc");
        res.send("x");
      }),
    );
    const allowed = await twice(
      (_req, res) => {
        res.cookie("theme", "dark");
        res.send("x");
      },
      { ttl: 60_000, allowSetCookie: true },
    );
    expect(allowed.runs).toBe(1);
    expect(allowed.second.headers.getSetCookie()).toEqual([
      "theme=dark; Path=/; SameSite=Lax",
    ]);
  });

  test("Vary: *", async () => {
    expectRefused(
      await twice((_req, res) => {
        res.setHeader("Vary", "*");
        res.send("x");
      }),
    );
  });

  test("a streamed body", async () => {
    expectRefused(
      await twice((_req, res) => {
        res.send(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("chunk"));
              controller.close();
            },
          }),
        );
      }),
    );
  });

  test('ttl: "headers" and no freshness information', async () => {
    expectRefused(
      await twice(
        (_req, res) => {
          res.send("x");
        },
        { ttl: "headers" },
      ),
    );
  });

  test("a lifetime of 0, or none left once Age is taken off", async () => {
    expectRefused(
      await twice(
        (_req, res) => {
          res.setHeader("Cache-Control", "max-age=0");
          res.send("x");
        },
        { ttl: "headers" },
      ),
    );
    expectRefused(
      await twice(
        (_req, res) => {
          res.setHeader("Cache-Control", "max-age=60");
          res.setHeader("Age", "60");
          res.send("x");
        },
        { ttl: "headers" },
      ),
    );
  });

  test("uncacheableTtl: 0 writes no marker", async () => {
    const result = await (async () => {
      const cache = makeHttpCache();
      const router = new BunRouter();
      router.get(
        "/r",
        cacheResponse(cache, { ttl: 60_000, uncacheableTtl: 0 }),
        (_req, res) => {
          res.setHeader("Cache-Control", "private");
          res.send("x");
        },
      );
      await router.fetch("/r");
      await Bun.sleep(5);
      return await frameAt(cache, keyFor("/r"));
    })();
    expect(result).toBeUndefined();
  });
});

describe("stored after all", () => {
  test("must-understand overrides no-store for a status the cache stores (RFC 9111 §5.2.2.3)", async () => {
    const result = await twice(
      (_req, res) => {
        res.setHeader("Cache-Control", "no-store, must-understand, max-age=60");
        res.send("x");
      },
      { ttl: "headers" },
    );
    expect(result.runs).toBe(1);
    expect(result.second.headers.get("x-cache")).toBe("HIT");
  });

  test('a qualified private="…" or no-cache="…" withholds only the fields it names (§5.2.2.4, §5.2.2.7)', async () => {
    const result = await twice((_req, res) => {
      res.setHeader(
        "Cache-Control",
        'private="X-User", no-cache="X-Debug", max-age=60',
      );
      res.setHeader("X-User", "alice");
      res.setHeader("X-Debug", "1");
      res.setHeader("X-Public", "yes");
      res.send("x");
    });
    expect(result.runs).toBe(1);
    expect(result.second.headers.get("x-user")).toBeNull();
    expect(result.second.headers.get("x-debug")).toBeNull();
    expect(result.second.headers.get("x-public")).toBe("yes");
  });

  test("the statuses option replaces the stored set", async () => {
    const result = await twice(
      (_req, res) => {
        res.redirect(302, "/elsewhere");
      },
      { ttl: 60_000, statuses: [302] },
    );
    expect(result.runs).toBe(1);
    expect(result.second.status).toBe(302);
    expect(result.second.headers.get("location")).toBe("/elsewhere");
  });

  test("a 301 from res.redirect() (immutable headers) and a 404 are stored by default", async () => {
    const moved = await twice((_req, res) => {
      res.redirect(301, "/new");
    });
    expect(moved.runs).toBe(1);
    expect(moved.second.status).toBe(301);
    expect(moved.second.headers.get("x-cache")).toBe("HIT");
    const missing = await twice((_req, res) => {
      res.status(404).send("nope");
    });
    expect(missing.runs).toBe(1);
    expect(missing.second.status).toBe(404);
  });

  test("a 204 is stored with an empty body", async () => {
    const result = await twice((_req, res) => {
      void res.status(204).end();
    });
    expect(result.runs).toBe(1);
    expect(result.second.status).toBe(204);
    expect(await result.second.text()).toBe("");
  });
});

describe("Authorization (RFC 9111 §3.5)", () => {
  const auth = { headers: { authorization: "Bearer t" } };

  test("an answer to a request with Authorization is not stored, and no marker is written", async () => {
    const result = await twice(
      (_req, res) => {
        res.send("mine");
      },
      { ttl: 60_000 },
      auth,
      false,
    );
    expect(result.runs).toBe(2);
    expect(result.frame).toBeUndefined();
  });

  test("public, s-maxage or must-revalidate allow storing it", async () => {
    for (const directive of ["public", "s-maxage=60", "must-revalidate"]) {
      const result = await twice(
        (_req, res) => {
          res.setHeader("Cache-Control", directive);
          res.send("shared");
        },
        { ttl: 60_000 },
        auth,
      );
      expect(result.runs).toBe(1);
    }
  });

  test('varyBy: ["authorization"] keys on the identity, and stores', async () => {
    const result = await twice(
      (_req, res) => {
        res.send("mine");
      },
      { ttl: 60_000, varyBy: ["authorization"] },
      auth,
    );
    expect(result.runs).toBe(1);
  });
});

describe("the lifetime", () => {
  test('ttl: "headers" reads Surrogate-Control max-age, then s-maxage, then max-age, then Expires', async () => {
    setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const cases: [Record<string, string>, number][] = [
      [
        {
          "surrogate-control": "max-age=10",
          "cache-control": "s-maxage=20, max-age=30",
        },
        10,
      ],
      [{ "cache-control": "s-maxage=20, max-age=30" }, 20],
      [{ "cache-control": "max-age=30" }, 30],
      [
        {
          expires: "Wed, 28 Oct 2026 10:00:40 GMT",
          date: "Wed, 28 Oct 2026 10:00:00 GMT",
        },
        40,
      ],
    ];
    for (const [headers, seconds] of cases) {
      const cache = makeHttpCache();
      const router = new BunRouter();
      router.get(
        "/r",
        cacheResponse(cache, { ttl: "headers" }),
        (_req, res) => {
          for (const [name, value] of Object.entries(headers)) {
            res.setHeader(name, value);
          }
          res.send("x");
        },
      );
      const written = nextSet(cache);
      await router.fetch("/r");
      await written;
      const entry = await cache.getEntry(keyFor("/r"));
      expect(entry?.freshUntil).toBe(
        Date.parse("2026-10-28T10:00:00Z") + seconds * 1000,
      );
    }
  });

  test("an Expires that does not parse is in the past (§5.3)", async () => {
    expectRefused(
      await twice(
        (_req, res) => {
          res.setHeader("Expires", "0");
          res.send("x");
        },
        { ttl: "headers" },
      ),
    );
  });

  test("Age is taken off the header lifetime", async () => {
    setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const result = await twice(
      (_req, res) => {
        res.setHeader("Cache-Control", "max-age=60");
        res.setHeader("Age", "45");
        res.send("x");
      },
      { ttl: "headers" },
    );
    const entry = await result.cache.getEntry(keyFor("/r"));
    expect(entry?.freshUntil).toBe(Date.parse("2026-10-28T10:00:15Z"));
  });

  test("a numeric ttl overrides the freshness headers (not the refusals)", async () => {
    const result = await twice((_req, res) => {
      res.setHeader("Cache-Control", "max-age=0");
      res.send("x");
    });
    expect(result.runs).toBe(1);
  });

  test("stale-while-revalidate= and stale-if-error= are kept for PR-H2; must-revalidate zeroes them", async () => {
    setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const windows = await twice(
      (_req, res) => {
        res.setHeader(
          "Cache-Control",
          "max-age=10, stale-while-revalidate=30, stale-if-error=300",
        );
        res.send("x");
      },
      { ttl: "headers" },
    );
    const meta =
      windows.frame?.kind === "response"
        ? windows.frame.response.meta
        : undefined;
    expect(meta?.staleWhileRevalidate).toBe(30_000);
    expect(meta?.staleIfError).toBe(300_000);
    // The core entry outlives its freshness by the longer window.
    expect((await windows.cache.getEntry(keyFor("/r")))?.expiresAt).toBe(
      Date.parse("2026-10-28T10:00:10Z") + 300_000,
    );

    const strict = await twice(
      (_req, res) => {
        res.setHeader(
          "Cache-Control",
          "max-age=10, must-revalidate, stale-if-error=300",
        );
        res.send("x");
      },
      { ttl: "headers" },
    );
    const strictMeta =
      strict.frame?.kind === "response"
        ? strict.frame.response.meta
        : undefined;
    expect(strictMeta?.staleIfError).toBe(0);
    expect((await strict.cache.getEntry(keyFor("/r")))?.expiresAt).toBe(
      Date.parse("2026-10-28T10:00:10Z"),
    );
  });

  test("PR-H1 never serves stale: past freshUntil is a miss, inside the window or not", async () => {
    setSystemTime(new Date("2026-10-28T10:00:00Z"));
    const cache = makeHttpCache();
    const router = new BunRouter();
    let runs = 0;
    router.get("/r", cacheResponse(cache, { ttl: "headers" }), (_req, res) => {
      runs++;
      res.setHeader("Cache-Control", "max-age=10, stale-while-revalidate=600");
      res.send(String(runs));
    });
    const written = nextSet(cache);
    await router.fetch("/r");
    await written;
    setSystemTime(new Date("2026-10-28T10:00:11Z"));
    const response = await router.fetch("/r");
    expect(response.headers.get("x-cache")).toBe("MISS");
    expect(await response.text()).toBe("2");
  });
});
