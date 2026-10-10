import { describe, expect, test } from "bun:test";
import {
  computeBackoff, createEventSource, createQueryClient, hashKey, infiniteQuery, replaceEqualDeep, stableStringify,
} from "./core";
import type { FetchContext, FetchResult, QueryClientOptions } from "./core";

/** Real-macrotask flush: lets every pending microtask chain settle. */
const flush = () => new Promise<void>(r => setImmediate(r));

/** Injected clock + timers: nothing fires until `advance()` says so. */
function manualClock(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn: () => void, ms: number) => { queue.set(++seq, { at: t + ms, fn }); return seq; },
      clearTimeout: (h: unknown) => { queue.delete(h as number); },
    },
    pending: () => queue.size,
    async advance(ms: number) {
      const target = t + ms;
      for (;;) {
        await flush();
        const due = [...queue].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        queue.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = target;
      await flush();
    },
  };
}

function setup(extra: QueryClientOptions = {}) {
  const clock = manualClock();
  const focus = createEventSource();
  const online = createEventSource();
  const client = createQueryClient({ now: clock.now, timers: clock.timers, random: () => 0.5, focusSource: focus, onlineSource: online, ...extra });
  return { clock, focus, online, client };
}

/** A fetcher that counts calls and returns `make(n)`. */
function counting<T>(make: (n: number, ctx: FetchContext) => T | Promise<T>) {
  const seen: FetchContext[] = [];
  const f = {
    calls: 0,
    seen,
    fetcher: async (ctx: FetchContext): Promise<FetchResult<T>> => {
      f.calls++;
      seen.push(ctx);
      return { data: await make(f.calls, ctx) };
    },
  };
  return f;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("keys", () => {
  test("stable stringify sorts object keys at every depth; array order still matters", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(`{"a":{"c":3,"d":2},"b":1}`);
    expect(hashKey(["todos", { page: 1, q: "x" }])).toBe(hashKey(["todos", { q: "x", page: 1 }]));
    expect(hashKey(["a", "b"])).not.toBe(hashKey(["b", "a"]));
  });
});

describe("dedupe", () => {
  test("two concurrent fetches share one promise and one call", async () => {
    const { client } = setup();
    const d = deferred<string>();
    const f = counting(() => d.promise);
    const p1 = client.fetchQuery(["k"], f.fetcher);
    const p2 = client.fetchQuery(["k"], f.fetcher);
    expect(p1).toBe(p2);
    d.resolve("v");
    expect(await Promise.all([p1, p2])).toEqual(["v", "v"]);
    expect(f.calls).toBe(1);
  });

  test("negative control: with dedupe disabled, two calls make two fetches", async () => {
    const { client } = setup();
    const f = counting(n => `v${n}`);
    await Promise.all([client.fetchQuery(["k"], f.fetcher, { dedupe: false }), client.fetchQuery(["k"], f.fetcher, { dedupe: false })]);
    expect(f.calls).toBe(2);
  });

  test("dedupeMs: a settled fetch satisfies calls inside the window, not after it", async () => {
    const { client, clock } = setup();
    const f = counting(n => n);
    await client.fetchQuery(["k"], f.fetcher, { dedupeMs: 2000 });
    await clock.advance(1999);
    expect(await client.fetchQuery(["k"], f.fetcher, { dedupeMs: 2000 })).toBe(1);
    await clock.advance(1);
    expect(await client.fetchQuery(["k"], f.fetcher, { dedupeMs: 2000 })).toBe(2);
    expect(f.calls).toBe(2);
  });
});

describe("store", () => {
  test("getSnapshot is identity-stable between changes and changes on update", async () => {
    const { client } = setup();
    const store = client.watch(["k"], counting(() => 1).fetcher);
    const a = store.getSnapshot();
    expect(store.getSnapshot()).toBe(a);
    let notified = 0;
    const off = store.subscribe(() => notified++);
    await flush();
    const b = store.getSnapshot();
    expect(b).not.toBe(a);
    expect(b.status).toBe("success");
    expect(store.getSnapshot()).toBe(b);
    expect(notified).toBe(2); // fetching, then success
    off();
  });
});

describe("stale-while-revalidate", () => {
  test("a subscriber to stale data sees it at once while a background refetch runs", async () => {
    const { client, clock } = setup();
    const d = deferred<string>();
    const f = counting(n => (n === 1 ? "old" : d.promise));
    await client.fetchQuery(["k"], f.fetcher);
    await clock.advance(5000);
    const store = client.watch(["k"], f.fetcher, { staleTime: 1000 });
    const off = store.subscribe(() => {});
    expect(store.getSnapshot()).toMatchObject({ status: "success", data: "old", fetchStatus: "fetching" });
    d.resolve("new");
    await flush();
    expect(store.getSnapshot()).toMatchObject({ data: "new", fetchStatus: "idle" });
    expect(f.calls).toBe(2);
    off();
  });

  test("fresh data (inside staleTime) does not refetch on subscribe", async () => {
    const { client, clock } = setup();
    const f = counting(() => "v");
    await client.fetchQuery(["k"], f.fetcher);
    await clock.advance(500);
    const off = client.watch(["k"], f.fetcher, { staleTime: 1000 }).subscribe(() => {});
    await flush();
    expect(f.calls).toBe(1);
    off();
  });
});

describe("revalidation triggers", () => {
  test("focus refetches stale observed entries only, and respects refetchOnFocus: false", async () => {
    const { client, clock, focus, online } = setup();
    const a = counting(n => n);
    const b = counting(n => n);
    const c = counting(n => n);
    const offA = client.watch(["a"], a.fetcher, { staleTime: 1000 }).subscribe(() => {});
    const offB = client.watch(["b"], b.fetcher, { staleTime: 60_000 }).subscribe(() => {});
    const offC = client.watch(["c"], c.fetcher, { staleTime: 1000, refetchOnFocus: false }).subscribe(() => {});
    await flush();
    await clock.advance(2000);
    focus.emit();
    await flush();
    expect([a.calls, b.calls, c.calls]).toEqual([2, 1, 1]);
    await clock.advance(2000);
    online.emit();
    await flush();
    expect([a.calls, b.calls, c.calls]).toEqual([3, 1, 2]); // c only opted out of focus
    offA(); offB(); offC();
    await clock.advance(2000);
    focus.emit();
    await flush();
    expect(a.calls).toBe(3); // unobserved: no refetch
  });

  test("refetchInterval polls while subscribed and stops after", async () => {
    const { client, clock } = setup();
    const f = counting(n => n);
    const off = client.watch(["k"], f.fetcher, { refetchInterval: 1000 }).subscribe(() => {});
    await flush();
    await clock.advance(3000);
    expect(f.calls).toBe(4);
    off();
    await clock.advance(5000);
    expect(f.calls).toBe(4);
  });
});

describe("retries", () => {
  test("computeBackoff: exponential, capped, jittered within ±jitter", () => {
    expect([1, 2, 3, 4, 5].map(n => computeBackoff(n, { base: 100, max: 1000, jitter: 0 }))).toEqual([100, 200, 400, 800, 1000]);
    expect(computeBackoff(3, { base: 100, jitter: 0.1 }, () => 0)).toBeCloseTo(360);
    expect(computeBackoff(3, { base: 100, jitter: 0.1 }, () => 0.999999)).toBeCloseTo(440, 2);
  });

  test("retries with backoff then succeeds; exhausted retries end in error", async () => {
    const { client, clock } = setup();
    const f = counting((n) => { if (n < 3) throw new Error(`fail ${n}`); return "ok"; });
    const p = client.fetchQuery(["k"], f.fetcher, { retry: 3, retryDelay: { base: 100, jitter: 0 } });
    await flush();
    expect(f.calls).toBe(1);
    await clock.advance(99);
    expect(f.calls).toBe(1);
    await clock.advance(1);
    expect(f.calls).toBe(2);
    await clock.advance(200);
    expect(f.calls).toBe(3);
    expect(await p).toBe("ok");

    const g = counting((): string => { throw new Error("always"); });
    const q = client.fetchQuery(["g"], g.fetcher, { retry: 2, retryDelay: { base: 10, jitter: 0 } }).catch((e: Error) => e);
    await clock.advance(1000);
    expect(((await q) as Error).message).toBe("always");
    expect(g.calls).toBe(3);
    expect(client.getQueryState(["g"])).toMatchObject({ status: "error", fetchStatus: "idle" });
  });
});

describe("abort", () => {
  test("abortOnUnsubscribe aborts when the last subscriber leaves; the default does not", async () => {
    const { client } = setup();
    const hang = counting(() => new Promise<never>(() => {}));
    const offA = client.watch(["a"], hang.fetcher, { abortOnUnsubscribe: true }).subscribe(() => {});
    const offB = client.watch(["b"], hang.fetcher).subscribe(() => {});
    offA(); offB();
    expect(hang.seen[0]!.signal.aborted).toBe(true);
    expect(hang.seen[1]!.signal.aborted).toBe(false);
    expect(client.getQueryState(["a"])!.fetchStatus).toBe("idle");
  });
});

describe("cache writes", () => {
  test("setQueryData with an updater notifies subscribers", async () => {
    const { client } = setup();
    await client.fetchQuery(["n"], counting(() => 1).fetcher);
    const store = client.watch(["n"], counting(() => 1).fetcher, { staleTime: Infinity });
    let seen = 0;
    const off = store.subscribe(() => seen++);
    client.setQueryData<number>(["n"], prev => (prev ?? 0) + 41);
    expect(store.getSnapshot().data).toBe(42);
    expect(seen).toBe(1);
    off();
  });

  test("invalidate by key prefix: observed matches refetch, unobserved matches go stale, others untouched", async () => {
    const { client } = setup();
    const t1 = counting(n => n);
    const t2 = counting(n => n);
    const u = counting(n => n);
    const opts = { staleTime: Infinity };
    const off = client.watch(["todos", 1], t1.fetcher, opts).subscribe(() => {});
    await client.fetchQuery(["todos", 2], t2.fetcher, opts);
    await client.fetchQuery(["users"], u.fetcher, opts);
    await flush();
    await client.invalidate({ key: ["todos"] });
    expect([t1.calls, t2.calls, u.calls]).toEqual([2, 1, 1]);
    const off2 = client.watch(["todos", 2], t2.fetcher, opts).subscribe(() => {}); // stale despite staleTime: Infinity
    const off3 = client.watch(["users"], u.fetcher, opts).subscribe(() => {});
    await flush();
    expect([t2.calls, u.calls]).toEqual([2, 1]);
    off(); off2(); off3();
  });

  test("invalidate by tags", async () => {
    const { client } = setup();
    const a = counting(n => n);
    const b = counting(n => n);
    const offA = client.watch(["a"], a.fetcher, { staleTime: Infinity, tags: ["post:1"] }).subscribe(() => {});
    const offB = client.watch(["b"], b.fetcher, { staleTime: Infinity, tags: ["post:2"] }).subscribe(() => {});
    await flush();
    await client.invalidate({ tags: ["post:1"] });
    expect([a.calls, b.calls]).toEqual([2, 1]);
    offA(); offB();
  });
});

describe("mutations", () => {
  test("optimistic update shows at once and rolls back on error", async () => {
    const { client } = setup();
    await client.fetchQuery(["todo"], counting(() => ({ title: "old" })).fetcher);
    const d = deferred<void>();
    const p = client.mutate(() => d.promise, {
      optimistic: (c) => { const rollback = c.snapshot(["todo"]); c.setQueryData(["todo"], { title: "new" }); return rollback; },
    }).catch((e: Error) => e);
    expect(client.getQueryData<{ title: string }>(["todo"])).toEqual({ title: "new" });
    d.reject(new Error("server said no"));
    expect(((await p) as Error).message).toBe("server said no");
    await flush();
    expect(client.getQueryData<{ title: string }>(["todo"])).toEqual({ title: "old" });
  });

  test("success invalidates tags and the observed query refetches", async () => {
    const { client } = setup();
    const f = counting(n => `v${n}`);
    const off = client.watch(["todo"], f.fetcher, { staleTime: Infinity, tags: ["todos"] }).subscribe(() => {});
    await flush();
    let succeeded: unknown;
    await client.mutate(async () => "saved", { invalidateTags: ["todos"], onSuccess: (r) => { succeeded = r; } });
    expect(succeeded).toBe("saved");
    expect(f.calls).toBe(2);
    expect(client.getQueryData<string>(["todo"])).toBe("v2");
    off();
  });
});

describe("garbage collection", () => {
  test("unobserved entries are dropped after gcTime; observed ones are kept", async () => {
    const { client, clock } = setup({ defaults: { gcTime: 1000 } });
    await client.fetchQuery(["loose"], counting(() => 1).fetcher);
    const off = client.watch(["held"], counting(() => 1).fetcher).subscribe(() => {});
    await clock.advance(999);
    expect(client.has(["loose"])).toBe(true);
    await clock.advance(1);
    expect(client.has(["loose"])).toBe(false);
    expect(client.has(["held"])).toBe(true);
    off();
    await clock.advance(1000);
    expect(client.has(["held"])).toBe(false);
    expect(client.size).toBe(0);
  });
});

describe("dehydrate / hydrate", () => {
  test("round-trips through JSON; fresh hydrated data does not refetch", async () => {
    const server = setup();
    await server.client.fetchQuery(["user", { id: 1 }], async () => ({ data: { name: "Ada" }, etag: "\"u1\"" }), { tags: ["user"] });
    const wire = JSON.parse(JSON.stringify(server.client.dehydrate()));
    const browser = setup();
    browser.client.hydrate(wire);
    expect(browser.client.getQueryState(["user", { id: 1 }])).toMatchObject({ status: "success", data: { name: "Ada" }, tags: ["user"] });
    const f = counting(() => ({ name: "Ada" }));
    const off = browser.client.watch(["user", { id: 1 }], f.fetcher, { staleTime: 60_000 }).subscribe(() => {});
    await flush();
    expect(f.calls).toBe(0);
    off();
  });
});

describe("conditional revalidation", () => {
  test("the fetcher sees the previous ETag; notModified keeps the data identity and bumps updatedAt", async () => {
    const { client, clock } = setup();
    const seenEtags: (string | undefined)[] = [];
    let first = true;
    const fetcher = async ({ etag }: FetchContext): Promise<FetchResult<{ items: number[] }>> => {
      seenEtags.push(etag);
      if (first) { first = false; return { data: { items: [1, 2] }, etag: "\"v1\"" }; }
      return { notModified: true };
    };
    const data1 = await client.fetchQuery(["list"], fetcher);
    const t1 = client.getQueryState(["list"])!.updatedAt;
    await clock.advance(5000);
    const data2 = await client.fetchQuery(["list"], fetcher);
    expect(seenEtags).toEqual([undefined, "\"v1\""]);
    expect(data2).toBe(data1);
    expect(client.getQueryState(["list"])!.updatedAt).toBe(t1 + 5000);
  });
});

describe("structural sharing", () => {
  test("replaceEqualDeep keeps unchanged subtrees", () => {
    const prev = { a: { x: 1 }, b: [{ y: 2 }, { y: 3 }], c: 1 };
    const next = replaceEqualDeep(prev, { a: { x: 1 }, b: [{ y: 2 }, { y: 4 }], c: 1 });
    expect(next).not.toBe(prev);
    expect(next.a).toBe(prev.a);
    expect(next.b[0]).toBe(prev.b[0]);
    expect(next.b[1]).not.toBe(prev.b[1]);
    expect(replaceEqualDeep(prev, structuredClone(prev))).toBe(prev);
  });

  test("a refetch returning equal JSON keeps the snapshot's data identity", async () => {
    const { client } = setup();
    const f = counting(() => ({ list: [{ id: 1 }, { id: 2 }] }));
    const a = await client.fetchQuery(["k"], f.fetcher);
    const b = await client.fetchQuery(["k"], f.fetcher);
    expect(f.calls).toBe(2);
    expect(b).toBe(a);
  });
});

describe("infinite", () => {
  test("pages append via getNextPageParam; a refetch reloads every loaded page", async () => {
    const { client } = setup();
    const calls: number[] = [];
    const inf = infiniteQuery(client, ["feed"], async ({ pageParam }) => {
      calls.push(pageParam);
      return { items: [pageParam * 10], next: pageParam < 3 ? pageParam + 1 : undefined };
    }, { initialPageParam: 1, getNextPageParam: last => last.next });
    await inf.fetchNextPage();
    await inf.fetchNextPage();
    await inf.fetchNextPage();
    expect(inf.hasNextPage()).toBe(false);
    const data = await inf.fetchNextPage(); // no-op at the end
    expect(data.pageParams).toEqual([1, 2, 3]);
    expect(data.pages.map(p => p.items[0])).toEqual([10, 20, 30]);
    await client.fetchQuery(["feed"], inf.fetcher);
    expect(calls).toEqual([1, 2, 3, 1, 2, 3]);
  });
});
