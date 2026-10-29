import { describe, expect, test } from "bun:test";
import { describeKeyvCompat } from "./contract";
import {
  cacheManagerOver,
  KEYV_VERSION,
  recording,
  referenceBacking,
} from "./harness";

/**
 * The harness proven on the reference store, and the facts the plan measured
 * (`docs/plans/bun-cache/evidence/keyv-compat/results.txt`, §10.4) pinned
 * against the real packages. Run with `bun run compat` in this directory;
 * the file is named `.compat.ts`, not `.test.ts`, so bun-cache's own
 * `bun test`, which would find a `*.test.ts` here, never runs it.
 */

describeKeyvCompat("the reference store", () => referenceBacking());

describe(`cache-manager 7.2.9 + Keyv ${KEYV_VERSION[5]}: what a store receives`, () => {
  test("wrap() is single-flight: three concurrent calls, one loader run", async () => {
    const { cache } = cacheManagerOver(5, referenceBacking().store());
    let runs = 0;
    const loader = () => {
      runs++;
      return Promise.resolve({ a: 1 });
    };
    await Promise.all([
      cache.wrap("k", loader),
      cache.wrap("k", loader),
      cache.wrap("k", loader),
    ]);
    expect(runs).toBe(1);
  });

  test("ttl() answers an absolute timestamp", async () => {
    const { cache } = cacheManagerOver(5, referenceBacking().store(), {
      ttl: 60_000,
    });
    await cache.set("k", 1);
    const before = Date.now();
    const expires = await cache.ttl("k");
    expect(expires).toBeGreaterThan(before + 59_000);
    expect(expires).toBeLessThanOrEqual(before + 60_000);
  });

  test('the store sees namespace "keyv", "keyv:"-prefixed keys, a JSON envelope and a relative TTL', async () => {
    const { store, calls } = recording(referenceBacking().store());
    const { cache } = cacheManagerOver(5, store, { ttl: 60_000 });
    await cache.set("k", { d: new Date(0) });
    await cache.clear();
    const set = calls.find((call) => call.method === "set")!;
    expect(set.args[0]).toBe("keyv:k");
    const envelope = JSON.parse(set.args[1] as string) as {
      value: unknown;
      expires: unknown;
    };
    expect(envelope.value).toEqual({ d: "1970-01-01T00:00:00.000Z" });
    expect(typeof envelope.expires).toBe("number");
    expect(set.args[2]).toBe(60_000);
    expect(calls.find((call) => call.method === "clear")!.namespace).toBe(
      "keyv",
    );
  });
});

describe(`cache-manager 7.2.9 + Keyv ${KEYV_VERSION[6]}: the breakage the README pins Keyv 5 for`, () => {
  test("wrap() runs the loader twice for three concurrent calls", async () => {
    const { cache } = cacheManagerOver(6, referenceBacking().store());
    let runs = 0;
    const loader = () => {
      runs++;
      return Promise.resolve({ a: 1 });
    };
    await Promise.all([
      cache.wrap("k", loader),
      cache.wrap("k", loader),
      cache.wrap("k", loader),
    ]);
    await cache.wrap("k", loader);
    expect(runs).toBe(2);
  });

  test("ttl() answers undefined", async () => {
    const { cache } = cacheManagerOver(6, referenceBacking().store(), {
      ttl: 60_000,
    });
    await cache.set("k", 1);
    expect(await cache.ttl("k")).toBeUndefined();
  });

  test("the store sees no namespace, and unprefixed keys", async () => {
    const { store, calls } = recording(referenceBacking().store());
    const { cache } = cacheManagerOver(6, store, { ttl: 60_000 });
    await cache.set("k", 1);
    const set = calls.find((call) => call.method === "set")!;
    expect(set.args[0]).toBe("k");
    expect(set.namespace).toBeUndefined();
  });
});
