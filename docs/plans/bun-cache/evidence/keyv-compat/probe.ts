// What a Keyv store adapter receives from cache-manager 7 + Keyv 5 or 6, and
// whether wrap() and ttl() still work. A recording store, no backend.
// Run: cd v5 (or v6) && bun install && cp ../probe.ts . && bun probe.ts
import { Keyv } from "keyv";
import { createCache } from "cache-manager";
const calls: unknown[] = [];
const store: any = {
  opts: {}, namespace: undefined as string | undefined, m: new Map<string, unknown>(),
  on() { return this; },
  async get(k: string) { calls.push(["get", k]); return this.m.get(k); },
  async set(k: string, v: unknown, t?: number) { calls.push(["set", k, v, t]); this.m.set(k, v); return true; },
  async delete(k: string) { calls.push(["delete", k]); return this.m.delete(k); },
  async clear() { calls.push(["clear", this.namespace]); this.m.clear(); },
  async has(k: string) { return this.m.has(k); },
};
const keyv = new Keyv({ store });
const cache = createCache({ stores: [keyv], ttl: 60_000 });
let n = 0;
const f = async () => { n++; return { a: 1, d: new Date(0) }; };
const r = await Promise.all([cache.wrap("k", f), cache.wrap("k", f), cache.wrap("k", f)]);
await cache.wrap("k", f);
console.log("factory calls:", n, "value:", JSON.stringify(r[0]), "ttl():", await cache.ttl("k"), "now:", Date.now());
console.log("keyv.namespace:", keyv.namespace, "store.namespace:", store.namespace);
await cache.clear();
for (const c of calls) console.log(JSON.stringify(c));
