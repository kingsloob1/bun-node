import type { KeyvMajor, KeyvStoreLike } from "./harness";
import { afterEach, describe, expect, test } from "bun:test";
import { cacheManagerOver } from "./harness";

/**
 * What a Keyv store adapter must do under cache-manager 7.2.9, per Keyv
 * major: the cases PR-K1 runs `toKeyvStore` through, as
 *
 * ```ts
 * describeKeyvCompat("toKeyvStore", () => {
 *   const cache = createCache({ driver: memoryDriver() });
 *   return { store: () => toKeyvStore(cache), close: () => cache.close() };
 * });
 * ```
 *
 * Every case drives the real cache-manager, so a case that passes here is
 * what `@nestjs/cache-manager` would see.
 */

/** A backend under test: adapters over one shared store, and how to release it after each case. */
export interface CompatSubject {
  /** A new store adapter over the subject's one backend; two calls are two caches sharing it. */
  store: () => KeyvStoreLike;
  /** Releases what the backend holds; called after every case. */
  close?: () => Promise<void>;
}

/** Options for {@link describeKeyvCompat}. */
export interface KeyvCompatOptions {
  /** The majors to run; both by default. */
  majors?: readonly KeyvMajor[];
}

/** Registers the contract cases for one store, for each Keyv major. */
export function describeKeyvCompat(
  name: string,
  make: () => CompatSubject | Promise<CompatSubject>,
  options: KeyvCompatOptions = {},
): void {
  for (const major of options.majors ?? ([5, 6] as const)) {
    describe(`${name} under cache-manager 7.2.9 + Keyv ${major}`, () => {
      const opened: CompatSubject[] = [];
      const open = async (): Promise<CompatSubject> => {
        const subject = await make();
        opened.push(subject);
        return subject;
      };
      afterEach(async () => {
        for (const subject of opened.splice(0)) await subject.close?.();
      });

      test("set then get round-trips a JSON value", async () => {
        const { cache } = cacheManagerOver(major, (await open()).store());
        const value = { a: 1, nested: { list: [1, "two", null] } };
        await cache.set("k", value);
        expect(await cache.get<unknown>("k")).toEqual(value);
      });

      test("a Date comes back as its ISO string (Keyv's JSON envelope wins)", async () => {
        const { cache } = cacheManagerOver(major, (await open()).store());
        await cache.set("d", { at: new Date(0) });
        expect(await cache.get<unknown>("d")).toEqual({
          at: "1970-01-01T00:00:00.000Z",
        });
      });

      test("a miss is undefined", async () => {
        const { cache } = cacheManagerOver(major, (await open()).store());
        expect(await cache.get<unknown>("absent")).toBeUndefined();
      });

      test("mset then mget, in order, undefined per miss", async () => {
        const { cache } = cacheManagerOver(major, (await open()).store());
        await cache.mset([
          { key: "a", value: 1 },
          { key: "b", value: 2 },
        ]);
        expect(await cache.mget<unknown>(["a", "absent", "b"])).toEqual([
          1,
          undefined,
          2,
        ]);
      });

      test("del removes one key", async () => {
        const { cache } = cacheManagerOver(major, (await open()).store());
        await cache.set("a", 1);
        await cache.set("b", 2);
        await cache.del("a");
        expect(await cache.get<unknown>("a")).toBeUndefined();
        expect(await cache.get<unknown>("b")).toBe(2);
      });

      test("an entry expires after its TTL", async () => {
        const { cache } = cacheManagerOver(major, (await open()).store());
        await cache.set("short", 1, 40);
        expect(await cache.get<unknown>("short")).toBe(1);
        await Bun.sleep(80);
        expect(await cache.get<unknown>("short")).toBeUndefined();
      });

      test("clear() removes only its own namespace's keys", async () => {
        const subject = await open();
        const one = cacheManagerOver(major, subject.store(), {
          namespace: "one",
        });
        const two = cacheManagerOver(major, subject.store(), {
          namespace: "two",
        });
        await one.cache.set("k", 1);
        await two.cache.set("k", 2);
        await one.cache.clear();
        expect(await one.cache.get<unknown>("k")).toBeUndefined();
        expect(await two.cache.get<unknown>("k")).toBe(2);
      });
    });
  }
}
