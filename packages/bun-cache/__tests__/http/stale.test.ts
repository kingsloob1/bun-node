/**
 * Stale serving over HTTP (plan §9.4, RFC 5861): stale-while-revalidate
 * through a background replay of the request (`revalidate`), its token, its
 * single flight, its fence and its failures; stale-if-error on a 5xx and on
 * `hardTimeout`; HEAD, `Vary` variants and coalescing beside them; through
 * `router.fetch()`, an adapter's `fetch()` and a served adapter.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type {
  BunRequest,
  BunResponse,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRouter,
  createDeferred,
} from "@kingsleyweb/bun-common";
import type { Cache, CacheEventMap } from "../../lib/index";
import type { CacheResponseOptions } from "../../lib/http/index";
import { cacheResponse } from "../../lib/http/index";
import {
  REVALIDATE_HEADER,
  replayHeaderValue,
  replayIdOf,
} from "../../lib/http/replay";
import { frameAt, keyFor, makeHttpCache, nextSet } from "./helpers";

afterEach(() => {
  setSystemTime();
});

/** 2026-10-28T10:00:00Z, the fixtures' first request. */
const T0 = Date.parse("2026-10-28T10:00:00Z");

/** Sets the clock to `seconds` after {@link T0}. */
function at(seconds: number): void {
  setSystemTime(new Date(T0 + seconds * 1000));
}

/** The default answer: fresh 10 s, stale-while-revalidate 60 s, stale-if-error 600 s. */
const WINDOWS = "max-age=10, stale-while-revalidate=60, stale-if-error=600";

/** What a handler run answers. */
type Answer = (
  req: BunRequest,
  res: BunResponse,
  run: number,
) => void | Promise<void>;

/** Answers `body <run>` under {@link WINDOWS}. */
const ok: Answer = (_req, res, run) => {
  res.setHeader("Cache-Control", WINDOWS);
  res.send(`body ${run}`);
};

/** Throws, for the error handler to answer 503. */
const boom: Answer = () => {
  throw new Error("origin down");
};

/** Resolves with the next `name` event. */
function nextEvent<E extends keyof CacheEventMap>(
  cache: Cache,
  name: E,
): Promise<CacheEventMap[E]> {
  return new Promise((resolve) => {
    const off = cache.on(name, (event) => {
      off();
      resolve(event);
    });
  });
}

/** Lets a background replay that has loaded finish (its flight settles a few microtasks later). */
async function settle(): Promise<void> {
  await Bun.sleep(5);
}

/**
 * A router with `/r` cached by `cacheResponse(cache, { revalidate: router,
 * ...options })`, answering through `answer` (switchable), and an error
 * handler answering 503. Records each run's request headers.
 */
function fixture(options: CacheResponseOptions = {}, first: Answer = ok) {
  const cache = makeHttpCache();
  const router = new BunRouter();
  let runs = 0;
  let answer = first;
  const headers: Headers[] = [];
  const pages = cacheResponse(cache, { revalidate: router, ...options });
  router.get("/r", pages, async (req, res) => {
    runs++;
    headers.push(new Headers(req.headersObj));
    await answer(req, res, runs);
  });
  router.use(((_err, _req, res, _next) => {
    res.status(503).send("down");
  }) satisfies RouterErrorMiddlewareHandler);
  return {
    cache,
    router,
    pages,
    runs: () => runs,
    headers,
    answer: (next: Answer) => {
      answer = next;
    },
  };
}

/** Stores `/r` at {@link T0} through `f.router`. */
async function prime(f: ReturnType<typeof fixture>, init?: RequestInit) {
  at(0);
  const written = nextSet(f.cache);
  const first = await f.router.fetch("/r", init);
  expect(first.headers.get("x-cache")).toBe("MISS");
  await written;
}

describe("stale-while-revalidate (§9.4)", () => {
  test("a stale entry is answered STALE at once, and one background replay refreshes it", async () => {
    const f = fixture();
    await prime(f);
    at(15);
    const refreshed = nextSet(f.cache);
    const stale = await f.router.fetch("/r");
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-cache")).toBe("STALE");
    expect(stale.headers.get("age")).toBe("15");
    expect(stale.headers.get("warning")).toBeNull();
    expect(await stale.text()).toBe("body 1");
    await refreshed;
    expect(f.runs()).toBe(2);
    const hit = await f.router.fetch("/r");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("body 2");
    expect(f.runs()).toBe(2);
  });

  test("the replay carries only the key's headers, the host and the token", async () => {
    const f = fixture({ varyBy: ["accept-language"] });
    const init = {
      headers: {
        "accept-language": "fr",
        cookie: "session=secret",
        "x-request-id": "abc",
        "if-none-match": '"nope"',
        "cache-control": "no-cache",
      },
    };
    await prime(f, init);
    at(15);
    const refreshed = nextSet(f.cache);
    expect((await f.router.fetch("/r", init)).headers.get("x-cache")).toBe(
      "STALE",
    );
    await refreshed;
    const replayed = f.headers[1];
    const names = [...replayed.keys()].sort();
    expect(names).toEqual(["accept-language", "host", REVALIDATE_HEADER]);
    expect(replayed.get("accept-language")).toBe("fr");
    // The refreshed entry is the same variant: the next fr request hits it.
    const hit = await f.router.fetch("/r", init);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("body 2");
  });

  test("the same through bun-common's BunHttpAdapter.fetch()", async () => {
    const cache = makeHttpCache();
    const adapter = new BunHttpAdapter(0);
    let runs = 0;
    adapter.get(
      "/r",
      cacheResponse(cache, { revalidate: adapter }),
      (_req, res) => {
        runs++;
        res.setHeader("Cache-Control", WINDOWS);
        res.send(`a${runs}`);
      },
    );
    at(0);
    const written = nextSet(cache);
    await adapter.fetch("/r");
    await written;
    at(15);
    const refreshed = nextSet(cache);
    const stale = await adapter.fetch("/r");
    expect(stale.headers.get("x-cache")).toBe("STALE");
    expect(await stale.text()).toBe("a1");
    await refreshed;
    expect(await (await adapter.fetch("/r")).text()).toBe("a2");
    expect(runs).toBe(2);
  });

  test("over a real socket: STALE, then the replay's answer", async () => {
    const cache = makeHttpCache();
    const adapter = new BunHttpAdapter(0);
    let runs = 0;
    adapter.get(
      "/r",
      cacheResponse(cache, { revalidate: adapter }),
      (_req, res) => {
        runs++;
        res.setHeader("Cache-Control", WINDOWS);
        res.send(`served ${runs}`);
      },
    );
    await adapter.listen(0);
    try {
      const url = `http://127.0.0.1:${adapter.listeningPort}/r`;
      at(0);
      const written = nextSet(cache);
      await (await fetch(url)).text();
      await written;
      at(15);
      const refreshed = nextSet(cache);
      const stale = await fetch(url);
      expect(stale.headers.get("x-cache")).toBe("STALE");
      expect(await stale.text()).toBe("served 1");
      await refreshed;
      const hit = await fetch(url);
      expect(hit.headers.get("x-cache")).toBe("HIT");
      expect(await hit.text()).toBe("served 2");
    } finally {
      await adapter.close();
    }
    expect(runs).toBe(2);
  });

  test("a burst of stale hits starts one replay", async () => {
    const f = fixture();
    await prime(f);
    at(15);
    const gate = createDeferred<void>();
    f.answer(async (req, res, run) => {
      await gate.promise;
      await ok(req, res, run);
    });
    const refreshed = nextSet(f.cache);
    const responses = await Promise.all(
      Array.from({ length: 20 }, async () => await f.router.fetch("/r")),
    );
    for (const response of responses) {
      expect(response.headers.get("x-cache")).toBe("STALE");
      expect(await response.text()).toBe("body 1");
    }
    gate.resolve();
    await refreshed;
    await settle();
    expect(f.runs()).toBe(2);
  });

  test("the route's window takes the place of the response's; must-revalidate still forbids stale", async () => {
    const f = fixture({ staleWhileRevalidate: 120_000 }, (_req, res, run) => {
      res.setHeader("Cache-Control", "max-age=10, stale-while-revalidate=5");
      res.send(`body ${run}`);
    });
    await prime(f);
    at(100);
    const refreshed = nextSet(f.cache);
    expect((await f.router.fetch("/r")).headers.get("x-cache")).toBe("STALE");
    await refreshed;

    const strict = fixture(
      { staleWhileRevalidate: 120_000 },
      (_req, res, run) => {
        res.setHeader("Cache-Control", "max-age=10, must-revalidate");
        res.send(`body ${run}`);
      },
    );
    await prime(strict);
    at(15);
    const late = await strict.router.fetch("/r");
    expect(late.headers.get("x-cache")).toBe("MISS");
    expect(await late.text()).toBe("body 2");
  });

  test("past the window the entry is a miss", async () => {
    const f = fixture({ staleIfError: 0 });
    await prime(f);
    at(71);
    const late = await f.router.fetch("/r");
    expect(late.headers.get("x-cache")).toBe("MISS");
    expect(await late.text()).toBe("body 2");
  });

  test("honorRequest: a client's max-age is never answered stale", async () => {
    const f = fixture({ honorRequest: true });
    await prime(f);
    at(15);
    const response = await f.router.fetch("/r", {
      headers: { "cache-control": "max-age=3600" },
    });
    expect(response.headers.get("x-cache")).toBe("MISS");
    expect(await response.text()).toBe("body 2");
  });

  test("HEAD: a stale entry's headers are answered STALE and refreshed as a GET", async () => {
    const f = fixture();
    await prime(f);
    at(15);
    const refreshed = nextSet(f.cache);
    const head = await f.router.fetch("/r", { method: "HEAD" });
    expect(head.headers.get("x-cache")).toBe("STALE");
    expect(head.headers.get("cache-control")).toBe(WINDOWS);
    expect(await head.text()).toBe("");
    await refreshed;
    expect(f.runs()).toBe(2);
    const hit = await f.router.fetch("/r");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("body 2");
  });

  test("Vary: the replay refreshes the stale variant it was asked for, and only it", async () => {
    const f = fixture({}, (req, res, run) => {
      res.setHeader("Cache-Control", WINDOWS);
      res.setHeader("Vary", "Accept-Language");
      res.send(`${req.get("accept-language") ?? "-"} ${run}`);
    });
    const en = { headers: { "accept-language": "en" } };
    const fr = { headers: { "accept-language": "fr" } };
    await prime(f, en);
    const second = nextSet(f.cache);
    expect(await (await f.router.fetch("/r", fr)).text()).toBe("fr 2");
    await second;
    at(15);
    const refreshed = nextSet(f.cache);
    const stale = await f.router.fetch("/r", fr);
    expect(stale.headers.get("x-cache")).toBe("STALE");
    expect(await stale.text()).toBe("fr 2");
    await refreshed;
    expect(f.headers[2]?.get("accept-language")).toBe("fr");
    const frHit = await f.router.fetch("/r", fr);
    expect(frHit.headers.get("x-cache")).toBe("HIT");
    expect(await frHit.text()).toBe("fr 3");
    // The base key's first variant is still the stale one.
    const enStale = await f.router.fetch("/r", en);
    expect(enStale.headers.get("x-cache")).toBe("STALE");
    expect(await enStale.text()).toBe("en 1");
  });

  test("an invalidation during the replay drops its write", async () => {
    const f = fixture();
    await prime(f);
    at(15);
    const gate = createDeferred<void>();
    const started = createDeferred<void>();
    f.answer(async (req, res, run) => {
      started.resolve();
      await gate.promise;
      await ok(req, res, run);
    });
    const fenced = nextEvent(f.cache, "fenced");
    expect((await f.router.fetch("/r")).headers.get("x-cache")).toBe("STALE");
    await started.promise;
    await f.pages.invalidate("/r");
    // A plain write now would be newer than the invalidation; the replay's
    // load started before it, so the fence drops it.
    at(16);
    gate.resolve();
    expect((await fenced).key).toBe(keyFor("/r"));
    await settle();
    expect(await f.cache.getEntry(keyFor("/r"))).toBeUndefined();
    f.answer(ok);
    const next = await f.router.fetch("/r");
    expect(next.headers.get("x-cache")).toBe("MISS");
    expect(await next.text()).toBe("body 3");
  });

  test("a replay that fails keeps the stale entry, backs off, and the entry lasts to the end of its stale-if-error window", async () => {
    const f = fixture();
    await prime(f);
    f.answer(boom);
    at(15);
    const loaded = nextEvent(f.cache, "load");
    expect(await (await f.router.fetch("/r")).text()).toBe("body 1");
    await loaded;
    await settle();
    expect(f.runs()).toBe(2);
    expect((await frameAt(f.cache, keyFor("/r")))?.kind).toBeUndefined();
    expect((await f.cache.getEntry(keyFor("/r")))?.stale).toBe(true);

    // Inside the backoff: stale, and no replay.
    at(20);
    const again = await f.router.fetch("/r");
    expect(again.headers.get("x-cache")).toBe("STALE");
    await settle();
    expect(f.runs()).toBe(2);

    // Past the backoff: another replay, which fails too.
    at(30);
    const retried = nextEvent(f.cache, "load");
    expect((await f.router.fetch("/r")).headers.get("x-cache")).toBe("STALE");
    await retried;
    await settle();
    expect(f.runs()).toBe(3);

    // Past stale-while-revalidate, inside stale-if-error: a miss whose 503
    // is answered with the stale entry.
    at(300);
    const rescued = await f.router.fetch("/r");
    expect(rescued.status).toBe(200);
    expect(rescued.headers.get("x-cache")).toBe("STALE");
    expect(await rescued.text()).toBe("body 1");
    expect(f.runs()).toBe(4);

    // Past both windows: the entry is gone and the 503 goes through.
    at(611);
    const down = await f.router.fetch("/r");
    expect(down.status).toBe(503);
    expect(down.headers.get("x-cache")).toBe("UNCACHEABLE");
  });

  test("a replay whose answer may no longer be stored replaces the stale entry with the hit-for-miss marker", async () => {
    const f = fixture();
    await prime(f);
    f.answer((_req, res, run) => {
      res.setHeader("Cache-Control", "no-store");
      res.send(`private ${run}`);
    });
    at(15);
    const written = nextSet(f.cache);
    expect((await f.router.fetch("/r")).headers.get("x-cache")).toBe("STALE");
    await written;
    expect((await frameAt(f.cache, keyFor("/r")))?.kind).toBe("uncacheable");
    const next = await f.router.fetch("/r");
    expect(next.headers.get("x-cache")).toBe("UNCACHEABLE");
    expect(await next.text()).toBe("private 3");
  });

  test("a key function the replay cannot reproduce: nothing is stored, the stale entry stays", async () => {
    const f = fixture({ key: (req) => `tenant:${req.get("x-tenant") ?? ""}` });
    const init = { headers: { "x-tenant": "acme" } };
    await prime(f, init);
    at(15);
    const loaded = nextEvent(f.cache, "load");
    expect((await f.router.fetch("/r", init)).headers.get("x-cache")).toBe(
      "STALE",
    );
    await loaded;
    await settle();
    expect(f.runs()).toBe(2);
    const entry = await f.cache.getEntry(
      `http:${JSON.stringify(["GET", "key", "tenant:acme"])}`,
    );
    expect(entry?.stale).toBe(true);
  });
});

describe("the replay token (§9.4)", () => {
  test("a request carrying a forged token is an ordinary request: stale, not a forced miss", async () => {
    const f = fixture();
    await prime(f);
    at(15);
    // The real replay the first stale answer starts waits, so every forged
    // request below finds the entry still stale.
    const gate = createDeferred<void>();
    f.answer(async (req, res, run) => {
      await gate.promise;
      await ok(req, res, run);
    });
    const refreshed = nextSet(f.cache);
    const forged = [
      "1",
      `${"0".repeat(64)}.${crypto.randomUUID()}`,
      `.${crypto.randomUUID()}`,
    ];
    for (const value of forged) {
      const response = await f.router.fetch("/r", {
        headers: { [REVALIDATE_HEADER]: value },
      });
      expect(response.headers.get("x-cache")).toBe("STALE");
      expect(await response.text()).toBe("body 1");
    }
    gate.resolve();
    await refreshed;
    await settle();
    // The one run is the real replay the first stale answer started.
    expect(f.runs()).toBe(2);
    const hit = await f.router.fetch("/r", {
      headers: { [REVALIDATE_HEADER]: forged[1] },
    });
    expect(hit.headers.get("x-cache")).toBe("HIT");
  });

  test("a real replay's header, sent again from outside, is ordinary: each id is used once", async () => {
    const f = fixture();
    await prime(f);
    at(15);
    const refreshed = nextSet(f.cache);
    await f.router.fetch("/r");
    await refreshed;
    const captured = f.headers[1]?.get(REVALIDATE_HEADER);
    expect(captured).toBeString();
    at(30);
    const response = await f.router.fetch("/r", {
      headers: { [REVALIDATE_HEADER]: captured! },
    });
    expect(response.headers.get("x-cache")).toBe("STALE");
    expect(await response.text()).toBe("body 2");
  });

  test("replayIdOf: only this process's token, compared whole", () => {
    const valid = replayHeaderValue("id-1");
    const of = (value: string) =>
      replayIdOf({
        getHeader: (name: string) =>
          name === REVALIDATE_HEADER ? value : null,
      } as unknown as BunRequest);
    expect(of(valid)).toBe("id-1");
    const token = valid.slice(0, valid.indexOf("."));
    const flipped = `${token[0] === "a" ? "b" : "a"}${token.slice(1)}.id-1`;
    expect(of(flipped)).toBeUndefined();
    expect(of(`${token.slice(0, -1)}.id-1`)).toBeUndefined();
    expect(of(`${token}0.id-1`)).toBeUndefined();
    expect(of(`${token}.`)).toBeUndefined();
    expect(of(token)).toBeUndefined();
  });
});

describe("stale-if-error (§9.4)", () => {
  test("a miss past stale-while-revalidate whose handler fails gets the stale entry; the entry is kept", async () => {
    const f = fixture();
    await prime(f);
    f.answer(boom);
    at(100);
    const rescued = await f.router.fetch("/r");
    expect(rescued.status).toBe(200);
    expect(rescued.headers.get("x-cache")).toBe("STALE");
    expect(rescued.headers.get("age")).toBe("100");
    expect(await rescued.text()).toBe("body 1");
    await settle();
    expect((await f.cache.getEntry(keyFor("/r")))?.stale).toBe(true);
    f.answer(ok);
    const written = nextSet(f.cache);
    const recovered = await f.router.fetch("/r");
    expect(recovered.headers.get("x-cache")).toBe("MISS");
    expect(await recovered.text()).toBe("body 3");
    await written;
    expect((await f.router.fetch("/r")).headers.get("x-cache")).toBe("HIT");
  });

  test("the stale answer keeps the headers middleware ahead of the cache set on this request", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    let runs = 0;
    router.use((req, res, next) => {
      res.setHeader("X-Request-Id", req.get("x-id") ?? "none");
      next();
    });
    router.get("/r", cacheResponse(cache), (_req, res) => {
      runs++;
      if (runs > 1) {
        throw new Error("origin down");
      }
      res.setHeader("Cache-Control", WINDOWS);
      res.send("body 1");
    });
    router.use(((_err, _req, res, _next) => {
      res.status(503).send("down");
    }) satisfies RouterErrorMiddlewareHandler);
    at(0);
    const written = nextSet(cache);
    await router.fetch("/r", { headers: { "x-id": "first" } });
    await written;
    at(100);
    const rescued = await router.fetch("/r", { headers: { "x-id": "second" } });
    expect(rescued.headers.get("x-cache")).toBe("STALE");
    expect(rescued.headers.get("x-request-id")).toBe("second");
    expect(rescued.headers.get("cache-control")).toBe(WINDOWS);
    expect(await rescued.text()).toBe("body 1");
  });

  test("coalesced followers of a failing leader get the stale entry too", async () => {
    const f = fixture();
    await prime(f);
    const gate = createDeferred<void>();
    f.answer(async (req, res, run) => {
      await gate.promise;
      await boom(req, res, run);
    });
    at(100);
    const responses = Array.from(
      { length: 5 },
      async () => await f.router.fetch("/r"),
    );
    await Bun.sleep(5);
    gate.resolve();
    for (const response of await Promise.all(responses)) {
      expect(response.status).toBe(200);
      expect(response.headers.get("x-cache")).toBe("STALE");
      expect(await response.text()).toBe("body 1");
    }
    expect(f.runs()).toBe(2);
  });

  test("without coalescing, the same", async () => {
    const f = fixture({ coalesce: false });
    await prime(f);
    f.answer(boom);
    at(100);
    const rescued = await f.router.fetch("/r");
    expect(rescued.headers.get("x-cache")).toBe("STALE");
    expect(await rescued.text()).toBe("body 1");
  });

  test("the route's staleIfError takes the place of the response's", async () => {
    const f = fixture({ staleIfError: 60_000 }, (_req, res, run) => {
      res.setHeader("Cache-Control", "max-age=10");
      res.send(`body ${run}`);
    });
    await prime(f);
    f.answer(boom);
    at(50);
    const rescued = await f.router.fetch("/r");
    expect(rescued.headers.get("x-cache")).toBe("STALE");
    expect(await rescued.text()).toBe("body 1");
    at(71);
    expect((await f.router.fetch("/r")).status).toBe(503);
  });

  test("a conditional request answered stale gets its 304", async () => {
    const f = fixture();
    await prime(f);
    const etag = (await f.router.fetch("/r")).headers.get("etag");
    expect(etag).toBeString();
    f.answer(boom);
    at(100);
    const response = await f.router.fetch("/r", {
      headers: { "if-none-match": etag! },
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("x-cache")).toBe("STALE");
  });

  test("hardTimeout: a handler that has not answered in time is answered stale, and its late answer dropped", async () => {
    const f = fixture({ hardTimeout: 30 });
    await prime(f);
    const late = createDeferred<void>();
    f.answer(async (req, res, run) => {
      await Bun.sleep(150);
      await ok(req, res, run);
      late.resolve();
    });
    at(100);
    const started = performance.now();
    const rescued = await f.router.fetch("/r");
    expect(performance.now() - started).toBeLessThan(140);
    expect(rescued.headers.get("x-cache")).toBe("STALE");
    expect(await rescued.text()).toBe("body 1");
    await late.promise;
    await settle();
    const entry = await f.cache.getEntry(keyFor("/r"));
    expect(entry?.stale).toBe(true);
    expect(f.runs()).toBe(2);
  });

  test("without a stale entry, a 5xx is not rescued and hardTimeout does not answer", async () => {
    const f = fixture({ hardTimeout: 20 }, async (req, res, run) => {
      await Bun.sleep(60);
      await boom(req, res, run);
    });
    at(0);
    const response = await f.router.fetch("/r");
    expect(response.status).toBe(503);
  });
});

describe("coalescing beside a replay (§9.4, §9.5)", () => {
  test("a miss arriving while a replay runs joins it: one handler run", async () => {
    const f = fixture({ staleIfError: 0 });
    await prime(f);
    const gate = createDeferred<void>();
    const started = createDeferred<void>();
    f.answer(async (req, res, run) => {
      started.resolve();
      await gate.promise;
      await ok(req, res, run);
    });
    at(15);
    expect((await f.router.fetch("/r")).headers.get("x-cache")).toBe("STALE");
    await started.promise;
    // Past stale-while-revalidate (and so the entry's expiry) now: this
    // request misses, and waits on the replay's flight rather than running
    // the handler again.
    at(75);
    const joined = f.router.fetch("/r");
    await Bun.sleep(5);
    gate.resolve();
    const response = await joined;
    expect(response.headers.get("x-cache")).toBe("HIT");
    expect(await response.text()).toBe("body 2");
    expect(f.runs()).toBe(2);
  });

  test("a replay started while a miss leads joins the miss: one handler run", async () => {
    // The miss leads past stale-while-revalidate (inside stale-if-error, so
    // the entry is still there); a stale answer then starts a replay. The
    // clock goes back for that, which only the test can do.
    const f = fixture();
    await prime(f);
    const gate = createDeferred<void>();
    const started = createDeferred<void>();
    f.answer(async (req, res, run) => {
      started.resolve();
      await gate.promise;
      await ok(req, res, run);
    });
    at(100);
    const leading = f.router.fetch("/r");
    await started.promise;
    at(15);
    const stale = await f.router.fetch("/r");
    expect(stale.headers.get("x-cache")).toBe("STALE");
    gate.resolve();
    expect(await (await leading).text()).toBe("body 2");
    await settle();
    expect(f.runs()).toBe(2);
  });
});

describe("options", () => {
  test("revalidate, hardTimeout and the windows are checked", () => {
    const cache = makeHttpCache();
    expect(() =>
      cacheResponse(cache, {
        revalidate: {} as unknown as CacheResponseOptions["revalidate"],
      }),
    ).toThrow(TypeError);
    expect(() => cacheResponse(cache, { hardTimeout: -1 })).toThrow(RangeError);
    expect(() =>
      cacheResponse(cache, { staleWhileRevalidate: Number.NaN }),
    ).toThrow(RangeError);
    expect(() => cacheResponse(cache, { staleIfError: -5 })).toThrow(
      RangeError,
    );
  });
});
