// Single-flight under 1000 concurrent misses for one key: how many times the
// loader runs, and how long the burst takes, with and without in-process
// coalescing. Also many keys at once, the cost of the coalescing map on hits,
// and what a rejected loader does to its waiters.
// Run: bun single-flight.ts
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

class Store { // a stand-in cache with an async boundary, like any driver
  m = new Map<string, unknown>();
  async get(k: string) { await Promise.resolve(); return this.m.get(k); }
  async set(k: string, v: unknown) { await Promise.resolve(); this.m.set(k, v); }
}

function naive(store: Store) {
  return async <T>(k: string, load: () => Promise<T>): Promise<T> => {
    const hit = await store.get(k);
    if (hit !== undefined) return hit as T;
    const v = await load(); await store.set(k, v); return v;
  };
}
function singleFlight(store: Store) {
  const inflight = new Map<string, Promise<unknown>>();
  return async <T>(k: string, load: () => Promise<T>): Promise<T> => {
    const hit = await store.get(k);
    if (hit !== undefined) return hit as T;
    let p = inflight.get(k) as Promise<T> | undefined;
    if (!p) {
      p = (async () => { try { const v = await load(); await store.set(k, v); return v; } finally { inflight.delete(k); } })();
      inflight.set(k, p);
    }
    return p;
  };
}

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)})`);
for (const loaderMs of [0, 5, 50]) {
  for (const [name, make] of [["naive", naive], ["single-flight", singleFlight]] as const) {
    const store = new Store(); const getOrSet = make(store); let calls = 0;
    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: 1000 }, () => getOrSet("k", async () => { calls++; await sleep(loaderMs); return { n: calls }; })));
    const ms = performance.now() - t0;
    const distinct = new Set(results.map(r => JSON.stringify(r))).size;
    console.log(`1000 concurrent misses, one key, loader ${loaderMs} ms, ${name.padEnd(13)}: loader ran ${String(calls).padStart(4)}x, ${distinct} distinct values returned, burst took ${ms.toFixed(1)} ms`);
  }
}
{ // 100 keys x 10 callers each
  const store = new Store(); const getOrSet = singleFlight(store); let calls = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: 1000 }, (_, i) => getOrSet(`k${i % 100}`, async () => { calls++; await sleep(5); return i; })));
  console.log(`1000 concurrent misses over 100 keys (10 each), loader 5 ms, single-flight: loader ran ${calls}x in ${(performance.now() - t0).toFixed(1)} ms`);
}
{ // rejection: every waiter sees the same error; the next call retries
  const store = new Store(); const getOrSet = singleFlight(store); let calls = 0;
  const settled = await Promise.allSettled(Array.from({ length: 1000 }, () => getOrSet("bad", async () => { calls++; await sleep(5); throw new Error("origin down"); })));
  const rejected = settled.filter(s => s.status === "rejected").length;
  const again = await getOrSet("bad", async () => { calls++; return "ok"; });
  console.log(`1000 concurrent misses, loader throws: loader ran ${calls - 1}x, ${rejected} callers rejected with the one error; next call ran the loader again -> ${again}`);
}
{ // overhead on hits: 1e6 hits through each wrapper
  for (const [name, make] of [["naive", naive], ["single-flight", singleFlight]] as const) {
    const store = new Store(); store.m.set("h", 1); const getOrSet = make(store);
    const t0 = performance.now();
    for (let i = 0; i < 1_000_000; i++) await getOrSet("h", async () => 0);
    console.log(`1,000,000 sequential hits, ${name.padEnd(13)}: ${((performance.now() - t0) / 1000).toFixed(3)} µs/hit`);
  }
}
console.log(`load average at end: ${(await Bun.file("/proc/loadavg").text()).trim()}`);
