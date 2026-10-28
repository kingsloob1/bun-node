/**
 * Keys (the encryption plan's §5): rotation through a ring, and `keys`
 * functions — waited for on first use (at most `timeout`), called once for
 * many operations, refreshed every `keyRefresh` ms and early (at most once
 * per 10 s) on an unknown key id, a rejection or an invalid ring keeping the
 * previous ring, and no ring at all: writes `false`, reads miss.
 */
import { describe, expect, test } from "bun:test";
import type { CacheKeyRing } from "../../lib/index";
import { envelopeKeyId } from "../../lib/core/encrypt";
import {
  decryptErrors,
  KEY_A,
  KEY_B,
  ringKey,
  SENTINEL,
  setup,
  storedBytes,
} from "./encryptionHelpers";

/** Ring key `a`. */
const A = { id: "a", key: KEY_A };
/** Ring key `b`. */
const B = { id: "b", key: KEY_B };

/** A `keys` function answering each of `answers` in turn (the last one forever), counting its calls. */
function provider(
  ...answers: (CacheKeyRing | Error | (() => Promise<CacheKeyRing>))[]
): (() => Promise<CacheKeyRing>) & { calls: number } {
  const fn = Object.assign(
    async (): Promise<CacheKeyRing> => {
      const answer = answers[Math.min(fn.calls, answers.length - 1)];
      fn.calls++;
      if (answer instanceof Error) {
        throw answer;
      }
      return typeof answer === "function" ? await answer() : answer;
    },
    { calls: 0 },
  );
  return fn;
}

describe("rotation", () => {
  test("the runbook: written under a, read with [b, a]; new writes under b; [b] alone misses a's entries", async () => {
    const old = setup({ encrypt: { keys: [A] } });
    await old.cache.set("before", SENTINEL);
    const shared = { driver: old.driver, clock: old.clock };

    // Step 1: [a, b] — every process reads b's entries, writes stay under a.
    const step1 = setup({ encrypt: { keys: [A, B] } }, shared);
    await step1.cache.set("step1", 1);
    expect(envelopeKeyId(await storedBytes(old.driver, "step1"))).toBe("a");

    // Step 2: [b, a] — new writes under b, a's entries still read.
    const step2 = setup({ encrypt: { keys: [B, A] } }, shared);
    expect(await step2.cache.get("before")).toBe(SENTINEL);
    await step2.cache.set("after", 2);
    expect(envelopeKeyId(await storedBytes(old.driver, "after"))).toBe("b");
    expect(await step1.cache.get("after")).toBe(2);

    // Step 3: [b] — a's entries, if any are left, are misses (not deleted).
    const step3 = setup({ encrypt: { keys: [B] } }, shared);
    expect(await step3.cache.get("after")).toBe(2);
    expect(await step3.cache.get("before")).toBeUndefined();
    expect(decryptErrors(step3.errors).map((error) => error.keyId)).toEqual([
      "a",
    ]);
    expect(await old.driver.get("cache", "before")).toBeDefined();
  });
});

describe("a keys function", () => {
  test("is waited for on first use, and called once for many operations", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const keys = provider(async () => {
      await gate;
      return [A];
    });
    const { cache } = setup({ encrypt: { keys } });
    const writes = Promise.all([cache.set("x", 1), cache.set("y", 2)]);
    const read = cache.get("x");
    await Bun.sleep(5);
    expect(keys.calls).toBe(1);
    release();
    expect(await writes).toEqual([true, true]);
    await read;
    expect(await cache.get("y")).toBe(2);
    expect(keys.calls).toBe(1);
  });

  test("slower than the cache's timeout: a read misses and a write resolves false; it is used once it answers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const keys = provider(async () => {
      await gate;
      return [A];
    });
    const { cache, errors } = setup({ encrypt: { keys }, timeout: 20 });
    expect(await cache.set("k", 1)).toBe(false);
    expect(await cache.get("k")).toBeUndefined();
    expect(errors.map((event) => event.phase)).toEqual(["encrypt"]);
    release();
    await Bun.sleep(1);
    expect(await cache.set("k", 1)).toBe(true);
    expect(await cache.get("k")).toBe(1);
    expect(keys.calls).toBe(1);
  });

  test("an unknown key id refreshes it once, so a peer's new key is learned without a restart", async () => {
    const peer = setup({ encrypt: { keys: [B, A] } });
    await peer.cache.set("k", SENTINEL);
    const keys = provider([A], [B, A]);
    const { cache } = setup(
      { encrypt: { keys } },
      { driver: peer.driver, clock: peer.clock },
    );
    expect(await cache.get("k")).toBe(SENTINEL);
    expect(keys.calls).toBe(2);
  });

  test("the early refresh runs at most once per 10 s", async () => {
    const peer = setup({ encrypt: { keys: [{ id: "z", key: ringKey(9) }] } });
    await peer.cache.set("k", SENTINEL);
    const keys = provider([A]);
    const { cache, clock, errors } = setup(
      { encrypt: { keys } },
      { driver: peer.driver, clock: peer.clock },
    );
    expect(await cache.get("k")).toBeUndefined();
    expect(keys.calls).toBe(2);
    expect(await cache.get("k")).toBeUndefined();
    clock.advance(9_999);
    expect(await cache.get("k")).toBeUndefined();
    expect(keys.calls).toBe(2);
    clock.advance(1);
    expect(await cache.get("k")).toBeUndefined();
    expect(keys.calls).toBe(3);
    expect(decryptErrors(errors).map((error) => error.reason)).toEqual([
      "unknown-key",
      "unknown-key",
      "unknown-key",
      "unknown-key",
    ]);
  });

  test("keyRefresh calls it again after that many ms, and the next operations use the new ring", async () => {
    const keys = provider([A], [B, A]);
    const { cache, clock, driver } = setup({
      encrypt: { keys, keyRefresh: 60_000 },
    });
    await cache.set("one", 1);
    expect(envelopeKeyId(await storedBytes(driver, "one"))).toBe("a");
    clock.advance(59_999);
    await cache.set("two", 2);
    expect(keys.calls).toBe(1);
    clock.advance(1);
    await cache.set("three", 3); // starts the refresh, still under a
    await Bun.sleep(1);
    expect(keys.calls).toBe(2);
    await cache.set("four", 4);
    expect(envelopeKeyId(await storedBytes(driver, "four"))).toBe("b");
    expect(await cache.get("one")).toBe(1);
  });

  test("a rejection is an error event, and the previous ring stays", async () => {
    const keys = provider([A], new Error("KMS unavailable"));
    const { cache, clock, errors } = setup({
      encrypt: { keys, keyRefresh: 1_000 },
    });
    await cache.set("k", 1);
    clock.advance(1_000);
    expect(await cache.get("k")).toBe(1); // starts the refresh
    await Bun.sleep(1);
    expect(keys.calls).toBe(2);
    expect(await cache.get("k")).toBe(1);
    expect(await cache.set("k2", 2)).toBe(true);
    const failures = errors.filter((event) => event.key === undefined);
    expect(failures.map((event) => event.phase)).toEqual(["decrypt"]);
    expect((failures[0].error as Error).message).toBe(
      "the encrypt.keys function failed; the previous ring stays",
    );
    expect(((failures[0].error as Error).cause as Error).message).toBe(
      "KMS unavailable",
    );
  });

  test("an invalid ring is refused whole, never half-applied", async () => {
    const peer = setup({ encrypt: { keys: [B] } });
    await peer.cache.set("k", SENTINEL);
    const keys = provider([A], [B, { id: "short", key: new Uint8Array(16) }]);
    const { cache, errors } = setup(
      { encrypt: { keys } },
      { driver: peer.driver, clock: peer.clock },
    );
    // The unknown id refreshes; the answer holds b but is invalid.
    expect(await cache.get("k")).toBeUndefined();
    expect(keys.calls).toBe(2);
    const failure = errors.find((event) => event.key === undefined)!;
    expect((failure.error as Error).cause).toBeInstanceOf(TypeError);
    expect(((failure.error as Error).cause as Error).message).toContain(
      "encrypt.keys()[1].key must be exactly 32 bytes",
    );
    expect(await cache.set("mine", 1)).toBe(true);
    expect(envelopeKeyId(await storedBytes(peer.driver, "mine"))).toBe("a");
  });

  test("with no ring yet, writes resolve false and reads miss; a later operation (after 1 s) tries again", async () => {
    const keys = provider(new Error("boot race"), [A]);
    const { cache, clock, errors } = setup({ encrypt: { keys } });
    expect(await cache.set("k", 1)).toBe(false);
    expect(await cache.set("k", 1)).toBe(false);
    expect(keys.calls).toBe(1);
    expect(errors.map((event) => [event.phase, event.key])).toEqual([
      ["encrypt", undefined],
      ["encrypt", "k"],
      ["encrypt", "k"],
    ]);
    expect((errors[0].error as Error).message).toBe(
      "the encrypt.keys function failed, and there is no ring yet",
    );
    clock.advance(1_000);
    expect(await cache.set("k", 1)).toBe(true);
    expect(await cache.get("k")).toBe(1);
  });

  test("a synchronous keys function works too", async () => {
    let calls = 0;
    const { cache } = setup({
      encrypt: {
        keys: () => {
          calls++;
          return [A];
        },
      },
    });
    expect(await cache.set("k", 1)).toBe(true);
    expect(await cache.get("k")).toBe(1);
    expect(calls).toBe(1);
  });
});
