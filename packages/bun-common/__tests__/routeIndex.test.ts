import type { Route } from "@routejs/router";
import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { FifoCache, RouteCandidateIndex } from "../lib/utils/routeIndex";

/** A small seeded PRNG (mulberry32), so a failure names a reproducible seed. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROUTE_SEGMENTS = [
  "users",
  "posts",
  "api",
  "v1",
  "Admin",
  "new",
  ":id",
  ":name",
  ":id(\\d+)",
  ":opt?",
  "*",
  "*rest",
  "{*all}",
  "a.b",
  "x%20y",
  "σ",
  "café",
  "ab+",
  "ab?c",
];
const USE_PREFIXES = [
  "/",
  "/api",
  "/users",
  "/:tenant",
  "/api/v1",
  "/Admin",
  "/posts/:id",
  "/*",
  "/σ",
];
const REQUEST_SEGMENTS = [
  "users",
  "USERS",
  "posts",
  "api",
  "v1",
  "admin",
  "Admin",
  "new",
  "42",
  "7",
  "a.b",
  "x%20y",
  "%zz",
  "..",
  ".",
  "",
  "ς",
  "Σ",
  "σ",
  "CAFÉ",
  "café",
  "abbb",
  "ac",
  "abc",
];

interface Table {
  router: BunRouter;
  /** One request path per probe. */
  paths: string[];
}

/** A random route table (on a router with the given case sensitivity) and request paths for it. */
function randomTable(seed: number, caseSensitive: boolean): Table {
  const rand = prng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const router = new BunRouter({ caseSensitive });
  const registered: string[] = [];
  const noop = () => {};
  const count = 4 + Math.floor(rand() * 30);
  for (let i = 0; i < count; i++) {
    const r = rand();
    try {
      if (r < 0.2) {
        const prefix = pick(USE_PREFIXES);
        router.use(prefix, noop);
        registered.push(prefix);
      } else if (r < 0.27) {
        const sub = new BunRouter();
        sub.get(`/${pick(ROUTE_SEGMENTS)}`, noop);
        sub.use(noop);
        const mount = pick(["/api", "/users", "/v1", "/:org"]);
        router.use(mount, sub);
        registered.push(mount);
      } else {
        const depth = 1 + Math.floor(rand() * 3);
        const segments: string[] = [];
        for (let k = 0; k < depth; k++) {
          segments.push(pick(ROUTE_SEGMENTS));
        }
        const path = `/${segments.join("/")}`;
        // A per-route `caseSensitive` that differs from the router's.
        if (rand() < 0.1) {
          router.setRoute({
            method: "GET",
            path,
            callbacks: [noop],
            caseSensitive: !caseSensitive,
          });
        } else if (rand() < 0.15) {
          router.all(path, noop);
        } else {
          router.get(path, noop);
        }
        registered.push(path);
      }
    } catch {
      // A pattern routejs itself rejects: nothing registered.
    }
  }

  const paths: string[] = [];
  for (let i = 0; i < 60; i++) {
    let path: string;
    if (registered.length > 0 && rand() < 0.5) {
      // Derived from a registered pattern, so most probes hit something.
      path = pick(registered)
        .split("/")
        .map((s) =>
          s.startsWith(":")
            ? pick(["42", "7", "new", "x%20y", "%zz", ".."])
            : s.includes("*")
              ? pick(["a/b", "", "z"])
              : s,
        )
        .join("/");
      if (rand() < 0.15) path += "/";
      if (rand() < 0.1) path = path.toUpperCase();
      if (rand() < 0.1) path = path.toLowerCase();
    } else {
      const depth = Math.floor(rand() * 5);
      path = `/${Array.from({ length: depth }, () => pick(REQUEST_SEGMENTS)).join("/")}`;
    }
    if (rand() < 0.05) path = `${path}//`;
    paths.push(path.startsWith("/") ? path : `/${path}`);
  }
  return { router, paths };
}

/** Indices of the routes whose own regex matches `path` — what the index must never drop. */
function matching(routes: Route[], path: string): number[] {
  const out: number[] = [];
  routes.forEach((route, index) => {
    if (route.pathRegexp?.test(path)) {
      out.push(index);
    }
  });
  return out;
}

const SEEDS = 400;

describe("RouteCandidateIndex", () => {
  it("never drops a route whose regex matches, over random tables (differential)", () => {
    const misses: string[] = [];
    let probes = 0;
    let candidatesTotal = 0;
    let routesTotal = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const caseSensitive of [false, true]) {
        const { router, paths } = randomTable(seed, caseSensitive);
        const routes = router.routes();
        const index = new RouteCandidateIndex();
        for (const path of paths) {
          const candidates = index.candidates(routes, path);
          // Ascending, so registration order is kept.
          expect(candidates).toEqual([...candidates].sort((a, b) => a - b));
          const candidateSet = new Set(candidates);
          for (const routeIndex of matching(routes, path)) {
            if (!candidateSet.has(routeIndex)) {
              const route = routes[routeIndex];
              misses.push(
                `seed ${seed} cs=${caseSensitive} ${path}: dropped ${route.path ?? `use(${route.group})`}`,
              );
            }
          }
          probes++;
          candidatesTotal += candidates.length;
          routesTotal += routes.length;
        }
      }
    }
    expect(misses.slice(0, 10)).toEqual([]);
    expect(probes).toBe(SEEDS * 2 * 60);
    // And it narrows: on these small, overlapping tables, under half the
    // routes are candidates on average.
    expect(candidatesTotal / routesTotal).toBeLessThan(0.5);
  });

  it("negative control: the differential catches a rule that drops a matching route", () => {
    // The same check, against an index that wrongly drops every wildcard
    // route. If the tables never exercised wildcards, this would pass too and
    // the differential above would prove nothing.
    let caught = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const { router, paths } = randomTable(seed, false);
      const routes = router.routes();
      const index = new RouteCandidateIndex();
      for (const path of paths) {
        const broken = new Set(
          index
            .candidates(routes, path)
            .filter(
              (i) => !String(routes[i].path ?? routes[i].group).includes("*"),
            ),
        );
        if (matching(routes, path).some((i) => !broken.has(i))) {
          caught++;
        }
      }
    }
    expect(caught).toBeGreaterThan(20);
  });

  it("buckets by first segment and keeps everywhere-routes in registration order", () => {
    const router = new BunRouter();
    const noop = () => {};
    router.use(noop); // 0: global middleware
    router.get("/users/:id", noop); // 1
    router.get("/posts/:id", noop); // 2
    router.use("/:tenant", noop); // 3: param first segment
    router.get("/users/new", noop); // 4
    router.get("/users/:id/posts", noop); // 5: wrong length for /users/42
    router.get("/USERS/42", noop); // 6: case-insensitive by default
    const index = new RouteCandidateIndex();
    const forUser = [0, 1, 3, 6];
    expect(index.candidates(router.routes(), "/users/42")).toEqual(forUser);
    expect(index.candidates(router.routes(), "/users/42/")).toEqual(forUser);
    expect(index.candidates(router.routes(), "/posts/1")).toEqual([0, 2, 3]);
    expect(index.candidates(router.routes(), "/")).toEqual([0]);
    expect(index.candidates(router.routes(), "/nothing")).toEqual([0, 3]);
  });

  it("compares a case-sensitive route exactly", () => {
    const router = new BunRouter({ caseSensitive: true });
    router.get("/Users/:id", () => {});
    const index = new RouteCandidateIndex();
    expect(index.candidates(router.routes(), "/Users/1")).toEqual([0]);
    expect(index.candidates(router.routes(), "/users/1")).toEqual([]);
  });

  it("never rules out a route on a non-ASCII case fold it cannot reproduce", () => {
    // Without the `u` flag, /σ/i matches "ς": lower-casing would say they differ.
    const router = new BunRouter();
    router.get("/a/σ", () => {});
    const route = router.routes()[0];
    expect(route.pathRegexp.test("/a/ς")).toBe(true);
    expect(
      new RouteCandidateIndex().candidates(router.routes(), "/a/ς"),
    ).toEqual([0]);
  });

  it("rebuilds when the table grows or is replaced, or on invalidate()", () => {
    const router = new BunRouter();
    const index = new RouteCandidateIndex();
    router.get("/a", () => {});
    expect(index.candidates(router.routes(), "/b")).toEqual([]);
    router.get("/b", () => {});
    expect(index.candidates(router.routes(), "/b")).toEqual([1]);

    const other = new BunRouter();
    other.get("/b", () => {});
    expect(index.candidates(other.routes(), "/b")).toEqual([0]);
  });
});

describe("BunRouter: candidate index in the pipeline", () => {
  it("keeps routeIndex as the route's position in routes()", () => {
    const router = new BunRouter();
    for (let i = 0; i < 20; i++) {
      router.get(`/r${i}/:id`, () => {});
    }
    const layers = router.getMatchedLayers({
      requestHost: "localhost",
      requestMethod: "GET",
      requestUrl: "/r17/5",
    });
    expect(layers.map((layer) => layer.routeIndex)).toEqual([17]);
  });

  it("picks up a route registered after the first request", async () => {
    const router = new BunRouter();
    router.get("/a/:id", (req, res) => res.send(`a${req.params.id}`));
    expect((await router.fetch("/b/1")).status).toBe(404);
    router.get("/b/:id", (req, res) => res.send(`b${req.params.id}`));
    expect(await (await router.fetch("/b/1")).text()).toBe("b1");
  });

  it("runs the Express pipeline over candidates exactly as over the whole table", async () => {
    // Middleware, an error handler, next('route') and decoding across many
    // sibling routes, with the cache off (every request a miss) and on.
    for (const routeCacheMax of [0, 3, undefined]) {
      const adapter = new BunHttpAdapter(0, { routeCacheMax });
      const trail: string[] = [];
      adapter.use((req, _res, next) => {
        trail.push(`global:${req.path}`);
        next();
      });
      for (let i = 0; i < 50; i++) {
        adapter.get(`/r${i}/:id`, (req, res) => {
          res.send(`r${i}:${req.params.id}`);
        });
      }
      adapter.use("/r7", (_req, _res, next) => next());
      adapter.get("/r7/:id", (_req, _res, next) => next("route"));
      adapter.get("/r7/:id", (req, res) => res.send(`second:${req.params.id}`));
      adapter.get("/boom/:id", () => {
        throw new Error("boom");
      });
      adapter.use(((err, _req, res, _next) => {
        const status = (err as { status?: number }).status ?? 500;
        res.status(status).send(`caught:${(err as Error).message}`);
      }) satisfies RouterErrorMiddlewareHandler);

      for (let n = 0; n < 5; n++) {
        expect(await (await adapter.fetch(`/r42/${n}`)).text()).toBe(
          `r42:${n}`,
        );
        expect(await (await adapter.fetch(`/r7/${n}`)).text()).toBe(`r7:${n}`);
        expect(await (await adapter.fetch(`/boom/${n}`)).text()).toBe(
          "caught:boom",
        );
        expect((await adapter.fetch(`/r42/%zz`)).status).toBe(400);
        expect((await adapter.fetch(`/nope/${n}`)).status).toBe(404);
      }
      expect(trail).toContain("global:/r42/0");
    }
  });
});

describe("FifoCache", () => {
  it("evicts the oldest entry once full", () => {
    const cache = new FifoCache<number>(3);
    for (const [key, value] of [
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ] as const) {
      cache.set(key, value);
    }
    expect(cache.size).toBe(3);
    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect([cache.get("b"), cache.get("c"), cache.get("d")]).toEqual([2, 3, 4]);
    cache.set("e", 5);
    cache.set("f", 6);
    cache.set("g", 7);
    expect([cache.get("b"), cache.get("c"), cache.get("d")]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect([cache.get("e"), cache.get("f"), cache.get("g")]).toEqual([5, 6, 7]);
  });

  it("matches Map-based FIFO eviction step for step", () => {
    const rand = prng(7);
    const max = 16;
    const cache = new FifoCache<number>(max);
    const reference = new Map<string, number>();
    for (let i = 0; i < 5_000; i++) {
      const key = `k${Math.floor(rand() * 64)}`;
      if (reference.has(key)) {
        reference.set(key, i);
      } else {
        if (reference.size >= max) {
          reference.delete(reference.keys().next().value!);
        }
        reference.set(key, i);
      }
      cache.set(key, i);
      expect(cache.size).toBe(reference.size);
    }
    for (const [key, value] of reference) {
      expect(cache.get(key)).toBe(value);
    }
  });

  it("re-setting a key keeps its place and size", () => {
    const cache = new FifoCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 3);
    expect(cache.size).toBe(2);
    cache.set("c", 4); // evicts "a", the first inserted
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });

  it("clear() empties it and starts the order afresh", () => {
    const cache = new FifoCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    cache.set("c", 3);
    cache.set("d", 4);
    expect([cache.get("c"), cache.get("d")]).toEqual([3, 4]);
  });

  it("evicts in constant time at a large cap", () => {
    // The Map-based eviction this replaces took ~18 µs per insert at 50,000;
    // O(1) eviction keeps a full cache's inserts in the sub-microsecond range.
    const cache = new FifoCache<number>(50_000);
    for (let i = 0; i < 50_000; i++) {
      cache.set(`warm${i}`, i);
    }
    const start = Bun.nanoseconds();
    for (let i = 0; i < 50_000; i++) {
      cache.set(`k${i}`, i);
    }
    const perInsert = (Bun.nanoseconds() - start) / 50_000;
    expect(perInsert).toBeLessThan(5_000);
    expect(cache.size).toBe(50_000);
  });
});
