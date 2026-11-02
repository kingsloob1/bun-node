/**
 * `setMany` past one chunk, for the drivers that cut a batch into statements
 * or scripts (Postgres, MySQL and MariaDB: 1,000 rows and 16 MiB; Redis: 1,000
 * entries and 8 MiB of frames). Registered by `sqlSuite.ts` and by
 * `redisSuite.ts` on the local server only: on a remote, billed lane (Upstash)
 * a thousand-entry batch costs more than it proves, and the kit's small
 * `setMany` cases run there anyway.
 */
import process from "node:process";
import { expect, test } from "bun:test";
import type { CacheDriver, StoredEntry } from "../../lib/index";

/** Deterministic bytes of `size`, each offset by `seed`. */
function bytes(size: number, seed = 0): Uint8Array {
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    out[index] = (index + seed) % 256;
  }
  return out;
}

/** The chunk tests' options. */
export interface SetManyChunkOptions {
  /** Whether a batch of several chunks is stored whole or not at all (one transaction): the SQL drivers. */
  atomic: boolean;
}

/** Registers the tests on `driver`, each in a namespace of its own, which it clears after. */
export function registerSetManyChunkTests(
  /** The driver under test. */
  driver: CacheDriver,
  /** What the driver promises of a batch. */
  options: SetManyChunkOptions,
): void {
  let serial = 0;
  const ns = (): string => `chunks-${process.pid}-${++serial}`;

  test("setMany past 1,000 entries stores every one, with its expiry and tags", async () => {
    const namespace = ns();
    const later = Date.now() + 60_000;
    const small: StoredEntry[] = Array.from({ length: 2_100 }, (_, index) => ({
      key: `s${index}`,
      value: bytes((index % 50) + 1, index),
      expiresAt: index % 2 === 0 ? null : later,
      tags: index % 3 === 0 ? ["third"] : [],
    }));
    await driver.setMany(namespace, small);
    const read = await driver.getMany(
      namespace,
      small.map((each) => each.key),
    );
    read.forEach((each, index) => {
      expect(each?.value).toEqual(small[index].value);
      expect(each?.expiresAt).toBe(small[index].expiresAt);
    });
    // The tag index covers every chunk.
    expect(await driver.deleteByTags!(namespace, ["third"], later)).toBe(700);
    expect(await driver.get(namespace, "s2097")).toBeUndefined();
    expect(await driver.get(namespace, "s2098")).toBeDefined();
    await driver.clear(namespace);
  }, 60_000);

  test("setMany past one chunk's bytes stores every entry", async () => {
    const namespace = ns();
    // 20 MiB of 1 MiB entries: past the 8–16 MiB one statement or script carries.
    const size = 1024 * 1024 - 1024;
    const large: StoredEntry[] = Array.from({ length: 20 }, (_, index) => ({
      key: `l${index}`,
      value: bytes(size, index),
      expiresAt: Date.now() + 60_000,
      tags: [],
    }));
    await driver.setMany(namespace, large);
    const back = await driver.getMany(
      namespace,
      large.map((each) => each.key),
    );
    back.forEach((each, index) => {
      expect(each?.value).toEqual(large[index].value);
    });
    await driver.clear(namespace);
  }, 60_000);

  if (options.atomic) {
    test("setMany of several chunks is stored whole or not at all: a failing chunk leaves none of the batch", async () => {
      const namespace = ns();
      await driver.set(namespace, {
        key: "s0",
        value: bytes(3),
        expiresAt: null,
        tags: [],
      });
      const batch: StoredEntry[] = Array.from(
        { length: 1_050 },
        (_, index) => ({
          key: `s${index}`,
          value: bytes(10, index),
          expiresAt: null,
          tags: ["batch"],
        }),
      );
      // Last in key order, so in the second chunk: an expiry no BIGINT holds.
      batch.push({
        key: "zz-bad",
        value: bytes(1),
        expiresAt: 2 ** 70,
        tags: [],
      });
      let thrown: unknown;
      try {
        await driver.setMany(namespace, batch);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      // The first chunk was rolled back with the failing one.
      const read = await driver.getMany(namespace, [
        "s0",
        "s1",
        "s500",
        "s999",
      ]);
      expect(read[0]?.value).toEqual(bytes(3));
      expect(read.slice(1)).toEqual([undefined, undefined, undefined]);
      expect(
        await driver.deleteByTags!(namespace, ["batch"], Date.now() + 60_000),
      ).toBe(0);
      await driver.clear(namespace);
    }, 60_000);
  }
}
