/**
 * Name hashing (the encryption plan's §7, PR-E2): `encrypt.hashNames` in the
 * core. Every name the drivers, L1 and the bus see is a keyed hash bound to
 * its kind and namespace; events keep the plaintext; `describeKey` answers
 * the stored forms; the option is validated at `createCache`.
 *
 * The guarantees here are each checked against a recording driver and a
 * recording bus, which see every argument the core hands them.
 */
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHmac, hkdfSync } from "node:crypto";
import { createTestLogger } from "@kingsleyweb/bun-common";
import type {
  BusMessage,
  CacheBus,
  CacheDriver,
  CacheNameContext,
  StoredEntry,
} from "../../lib/index";
import { createCache, memoryDriver } from "../../lib/index";
import { KEY_A, testCipher } from "./encryptionHelpers";

/** The names key every hashing cache here uses (not a ring key). */
const NAMES_KEY = new Uint8Array(32).fill(9);

/** The encryption every hashing cache here uses. */
const ENCRYPT = {
  keys: [{ id: "a", key: KEY_A }],
  hashNames: { key: NAMES_KEY },
};

/** The plan's §7.1 by hand: hex128(HMAC-SHA-256(HKDF(key, "bun-cache/names/1"), input)). */
function expectedHash(input: string, key: Uint8Array = NAMES_KEY): string {
  const derived = Buffer.from(
    hkdfSync("sha256", key, new Uint8Array(0), "bun-cache/names/1", 32),
  );
  return createHmac("sha256", derived).update(input).digest("hex").slice(0, 32);
}

/** Every string a driver or bus call was handed, flattened: names, entry keys, tags, bus messages. */
interface Recorder {
  /** The strings seen, one per argument part. */
  seen: string[];
  /** The entries handed to `set`. */
  entries: StoredEntry[];
}

/** Collects every string in `value` (arrays, plain objects), skipping byte payloads. */
function strings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      strings(item, out);
    }
  } else if (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array)
  ) {
    for (const [field, item] of Object.entries(value)) {
      out.push(field);
      strings(item, out);
    }
  }
}

/** A driver that records every argument it is handed, over a memory driver. */
function recordingDriver(
  inner: CacheDriver = memoryDriver(),
  overrides: Partial<CacheDriver> = {},
): { driver: CacheDriver; recorder: Recorder } {
  const recorder: Recorder = { seen: [], entries: [] };
  const driver = new Proxy(inner, {
    get(target, property) {
      if (property in overrides) {
        return overrides[property as keyof CacheDriver];
      }
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function" || property === "onEviction") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        if (property === "set") {
          recorder.entries.push(args[1] as StoredEntry);
        }
        for (const arg of args) {
          if (typeof arg !== "function") {
            strings(arg, recorder.seen);
          }
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { driver, recorder };
}

/** A bus that records every message, delivering each to the subscribers in this process. */
function recordingBus(): CacheBus & { messages: BusMessage[] } {
  const listeners = new Set<(message: BusMessage) => void>();
  const messages: BusMessage[] = [];
  return {
    name: "recording",
    messages,
    async publish(message) {
      messages.push(message);
      for (const listener of listeners) {
        listener(message);
      }
    },
    async subscribe(onMessage) {
      listeners.add(onMessage);
      return async () => {
        listeners.delete(onMessage);
      };
    },
    async close() {},
  };
}

/** The plaintext names the full-coverage test writes; none may reach a driver or the bus. */
const PLAIN = ["tenant-acme", "user:42", "invoice:8", "hits", "org:7", "vip"];

describe("hashNames: what the drivers and the bus see", () => {
  test("every driver call and bus message names hashed forms, never a plaintext name", async () => {
    const { driver, recorder } = recordingDriver();
    const bus = recordingBus();
    const cache = createCache({
      driver,
      namespace: "tenant-acme",
      sweepInterval: 0,
      l1: true,
      bus,
      encrypt: ENCRYPT,
    });
    try {
      await cache.set("user:42", { plan: "pro" }, { tags: ["org:7", "vip"] });
      expect(await cache.get("user:42")).toEqual({ plan: "pro" });
      expect(await cache.get("user:42", { tier: "l2" })).toEqual({
        plan: "pro",
      });
      expect(
        await cache.getMany(["user:42", "invoice:8"], { tier: "l2" }),
      ).toEqual([{ plan: "pro" }, undefined]);
      expect(await cache.has("invoice:8")).toBe(false);
      await cache.getOrSet("invoice:8", () => 8, {
        lock: true,
        tags: ["org:7"],
      });
      expect(await cache.touch("invoice:8", 60_000)).toBe(true);
      expect(await cache.increment("hits", 5)).toBe(5);
      expect(await cache.get("hits", { tier: "l2" })).toBe(5);
      await cache.invalidateTags(["org:7"]);
      expect(await cache.get("user:42")).toBeUndefined();
      await cache.delete("hits");
      await cache.deleteMany(["invoice:8"]);
      await cache.clear();
      expect(recorder.seen.length).toBeGreaterThan(20);
      const busText = JSON.stringify(bus.messages);
      expect(bus.messages.length).toBeGreaterThan(4);
      for (const name of PLAIN) {
        expect(recorder.seen.filter((seen) => seen.includes(name))).toEqual([]);
        expect(busText.includes(name)).toBe(false);
      }
      const described = cache.describeKey("user:42", ["org:7"]);
      expect(recorder.seen).toContain(described.namespace);
      expect(recorder.seen).toContain(described.key);
      expect(recorder.seen).toContain(described.tags[0]);
      expect(
        bus.messages.every((m) => m.namespace === described.namespace),
      ).toBe(true);
    } finally {
      await cache.close();
    }
  });

  test("the stored entry carries hashed tags in clear and the plaintext ones sealed", async () => {
    const { driver, recorder } = recordingDriver();
    const cache = createCache({
      driver,
      namespace: "app",
      sweepInterval: 0,
      encrypt: ENCRYPT,
    });
    await cache.set("user:42", 1, { tags: ["org:7"] });
    const [entry] = recorder.entries;
    expect(entry.key).toBe(expectedHash("key\0app\0user:42"));
    expect(entry.tags).toEqual([expectedHash("tag\0app\0org:7")]);
    // `getEntry` answers the sealed, plaintext tags.
    expect((await cache.getEntry("user:42"))?.tags).toEqual(["org:7"]);
    await cache.close();
  });
});

describe("hashNames: the hash", () => {
  test("the built-in is the plan's HMAC: hex128, bound to the kind and the namespace", () => {
    const cache = createCache({
      driver: memoryDriver(),
      namespace: "app",
      version: "v3",
      sweepInterval: 0,
      encrypt: ENCRYPT,
    });
    const described = cache.describeKey("user:42", ["org:7"]);
    expect(described).toEqual({
      namespace: expectedHash("ns\0app@v3"),
      key: expectedHash("key\0app@v3\0user:42"),
      tags: [expectedHash("tag\0app@v3\0org:7")],
    });
    expect(described.key).toMatch(/^[\da-f]{32}$/);
    // A key and a tag spelled alike hash apart.
    expect(cache.describeKey("org:7").key).not.toBe(described.tags[0]);
    // The same key and tag in another namespace hash apart: a dump does not
    // show which tenants share one.
    const other = cache.namespace("other").describeKey("user:42", ["org:7"]);
    expect(other.namespace).toBe(expectedHash("ns\0app@v3:other"));
    expect(other.key).not.toBe(described.key);
    expect(other.tags[0]).not.toBe(described.tags[0]);
  });

  test("a long key is the HMAC too: no `#` + SHA-256 step", () => {
    const cache = createCache({
      driver: memoryDriver(),
      namespace: "app",
      sweepInterval: 0,
      encrypt: ENCRYPT,
    });
    const long = "k".repeat(500);
    expect(cache.describeKey(long).key).toBe(expectedHash(`key\0app\0${long}`));
  });

  test("the memo is bounded and never answers a wrong name", () => {
    const cache = createCache({
      driver: memoryDriver(),
      namespace: "app",
      sweepInterval: 0,
      encrypt: ENCRYPT,
    });
    const first = cache.describeKey("k0").key;
    for (let index = 1; index <= 10_050; index++) {
      cache.describeKey(`k${index}`);
    }
    expect(cache.describeKey("k0").key).toBe(first);
    expect(first).toBe(expectedHash("key\0app\0k0"));
  });

  test("another names key hashes apart, and that cache sees nothing", async () => {
    const driver = memoryDriver();
    const one = createCache({ driver, sweepInterval: 0, encrypt: ENCRYPT });
    const two = createCache({
      driver,
      sweepInterval: 0,
      encrypt: { ...ENCRYPT, hashNames: { key: new Uint8Array(32).fill(8) } },
    });
    const plain = createCache({
      driver,
      sweepInterval: 0,
      encrypt: { keys: ENCRYPT.keys },
    });
    await one.set("k", "v");
    expect(await one.get("k")).toBe("v");
    expect(await two.get("k")).toBeUndefined();
    expect(await plain.get("k")).toBeUndefined();
    expect(two.describeKey("k").key).not.toBe(one.describeKey("k").key);
    await driver.close();
  });

  test("a user hash replaces the HMAC, told each name's kind and namespace", async () => {
    const calls: [string, CacheNameContext][] = [];
    const hash = (name: string, context: CacheNameContext): string => {
      calls.push([name, context]);
      return `${context.kind[0]}-${Bun.hash(`${context.namespace}|${name}`).toString(16)}`;
    };
    const { driver, recorder } = recordingDriver();
    const cache = createCache({
      driver,
      namespace: "app",
      sweepInterval: 0,
      encrypt: { ...ENCRYPT, hashNames: { hash } },
    });
    await cache.set("user:42", 1, { tags: ["org:7"] });
    expect(await cache.get("user:42")).toBe(1);
    expect(calls).toContainEqual([
      "app",
      { kind: "namespace", namespace: "app" },
    ]);
    expect(calls).toContainEqual([
      "user:42",
      { kind: "key", namespace: "app" },
    ]);
    expect(calls).toContainEqual(["org:7", { kind: "tag", namespace: "app" }]);
    const [entry] = recorder.entries;
    expect(entry.key.startsWith("k-")).toBe(true);
    expect(entry.tags[0].startsWith("t-")).toBe(true);
    await cache.close();
  });

  test("a user hash works beside a user cipher", async () => {
    const cache = createCache({
      driver: memoryDriver(),
      sweepInterval: 0,
      encrypt: {
        cipher: testCipher(),
        hashNames: {
          hash: (name, context) => `${context.kind}.${name.length}`,
        },
      },
    });
    await cache.set("user:42", "v");
    expect(await cache.get("user:42")).toBe("v");
    expect(cache.describeKey("user:42").key).toBe("key.7");
    await cache.close();
  });

  test("a user hash's answer is checked on first use", () => {
    const make = (hash: (name: string) => string) =>
      createCache({
        driver: memoryDriver(),
        sweepInterval: 0,
        encrypt: { ...ENCRYPT, hashNames: { hash } },
      });
    expect(() => make(() => "")).toThrow(/1–200 bytes/);
    expect(() => make(() => "a\nb")).toThrow(/no NUL or newline/);
    expect(() => make(() => "a\0b")).toThrow(/no NUL or newline/);
    expect(() => make(() => "x".repeat(201))).toThrow(/1–200 bytes/);
    expect(() => make(() => 42 as unknown as string)).toThrow(/a string/);
    let calls = 0;
    // The namespace is hashed at createCache, twice: the second answer differs.
    expect(() => make(() => `n${calls++}`)).toThrow(/deterministic/);
    // A key's first hash is checked too.
    const cache = make((name) => (name === "flaky" ? `f${calls++}` : name));
    expect(() => cache.describeKey("flaky")).toThrow(/deterministic/);
  });
});

describe("hashNames: behaviour that stays the same", () => {
  test("clear() on a view empties that namespace only; its parent and sibling keep theirs", async () => {
    const driver = memoryDriver();
    const root = createCache({
      driver,
      namespace: "app",
      sweepInterval: 0,
      encrypt: ENCRYPT,
    });
    const users = root.namespace("users");
    const orders = root.namespace("orders");
    await root.set("k", "root");
    await users.set("k", "users");
    await orders.set("k", "orders");
    await users.clear();
    expect(await users.get("k")).toBeUndefined();
    expect(await orders.get("k")).toBe("orders");
    expect(await root.get("k")).toBe("root");
    // The driver holds the entry under the view's hashed namespace.
    expect(
      await driver.get(
        orders.describeKey("k").namespace,
        orders.describeKey("k").key,
      ),
    ).toBeDefined();
    await root.clear();
    expect(await root.get("k")).toBeUndefined();
    expect(await orders.get("k")).toBe("orders");
    await driver.close();
  });

  test("invalidateTags reaches the entries on an index driver and a stamps driver", async () => {
    const stampsDriver = memoryDriver();
    const stamps: CacheDriver = new Proxy(stampsDriver, {
      get(target, property) {
        if (property === "capabilities") {
          return { ...target.capabilities, tags: "stamps", fence: "none" };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    for (const driver of [memoryDriver(), stamps]) {
      const cache = createCache({ driver, sweepInterval: 0, encrypt: ENCRYPT });
      await cache.set("a", 1, { tags: ["org:7"] });
      await cache.set("b", 2, { tags: ["org:8"] });
      await Bun.sleep(2);
      await cache.invalidateTags(["org:7"]);
      expect(await cache.get("a")).toBeUndefined();
      expect(await cache.get("b")).toBe(2);
      await cache.close();
    }
  });

  test("two processes' L1 copies stay coherent over the bus, on hashed names", async () => {
    const driver = memoryDriver();
    const bus = recordingBus();
    const options = {
      driver,
      sweepInterval: 0,
      l1: true,
      bus,
      encrypt: ENCRYPT,
    } as const;
    const one = createCache(options);
    const two = createCache(options);
    await Bun.sleep(5);
    await one.set("k", "v1", { tags: ["t"] });
    expect(await two.get("k")).toBe("v1"); // two's L1 now holds it
    await one.set("k", "v2", { tags: ["t"] });
    expect(await two.get("k")).toBe("v2"); // a backfilled copy
    await one.invalidateTags(["t"]);
    expect(await two.get("k")).toBeUndefined();
    expect(two.stats().l1?.invalidations).toBeGreaterThan(0);
    // A writer's own copy (`#l1CopyOfWrite`) is indexed by the hashed tags too.
    await Bun.sleep(2); // past the stamp's millisecond
    await one.set("k", "v3", { tags: ["t"] });
    expect(await one.get("k")).toBe("v3");
    expect(one.stats().l1?.hits).toBeGreaterThan(0);
    const before = one.stats().l1!.invalidations;
    await two.invalidateTags(["t"]);
    expect(one.stats().l1!.invalidations).toBe(before + 1);
    expect(await one.get("k")).toBeUndefined();
    expect(JSON.stringify(bus.messages).includes('"k"')).toBe(false);
    await driver.close();
  });

  test("counters: the name is hashed, the value stays a plain integer", async () => {
    const driver = memoryDriver();
    const cache = createCache({ driver, sweepInterval: 0, encrypt: ENCRYPT });
    expect(await cache.increment("hits", 2)).toBe(2);
    expect(await cache.decrement("hits")).toBe(1);
    const { namespace, key } = cache.describeKey("hits");
    expect((await driver.getCounter!(namespace, key))?.value).toBe(1);
    expect(await driver.getCounter!("cache", "hits")).toBeUndefined();
    expect(await cache.get("hits")).toBe(1);
    await cache.close();
  });

  test("events keep the plaintext names", async () => {
    const cache = createCache({
      driver: memoryDriver(),
      namespace: "app",
      sweepInterval: 0,
      encrypt: ENCRYPT,
    });
    const seen: string[] = [];
    cache.on("set", (event) =>
      seen.push(`set ${event.namespace} ${event.key}`),
    );
    cache.on("hit", (event) =>
      seen.push(`hit ${event.namespace} ${event.key}`),
    );
    cache.on("miss", (event) =>
      seen.push(`miss ${event.namespace} ${event.key}`),
    );
    cache.on("invalidate", (event) =>
      seen.push(`invalidate ${event.namespace} ${event.tags.join(",")}`),
    );
    await cache.set("user:42", 1, { tags: ["org:7"] });
    await cache.get("user:42");
    await cache.get("user:43");
    await cache.invalidateTags(["org:7"]);
    expect(seen).toEqual([
      "set app user:42",
      "hit app user:42",
      "miss app user:43",
      "invalidate app org:7",
    ]);
    await cache.close();
  });

  test("the core's key-bearing log line names the stored key", async () => {
    const { logger, events } = createTestLogger();
    const inner = memoryDriver();
    const noLock: CacheDriver = new Proxy(inner, {
      get(target, property) {
        if (property === "capabilities") {
          return { ...target.capabilities, lock: false };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const cache = createCache({
      driver: noLock,
      sweepInterval: 0,
      logger,
      encrypt: ENCRYPT,
    });
    await cache.getOrSet("user:42", () => 1, { lock: true });
    const line = events.find((event) =>
      event.message.includes("cross-process lock"),
    );
    expect(line?.fields).toEqual({ key: cache.describeKey("user:42").key });
    expect(JSON.stringify(events).includes("user:42")).toBe(false);
    await cache.close();
  });

  test("describeKey without hashNames answers the names as stored", () => {
    const cache = createCache({
      driver: memoryDriver(),
      namespace: "app",
      sweepInterval: 0,
    });
    expect(cache.describeKey("user:42", ["org:7"])).toEqual({
      namespace: "app",
      key: "user:42",
      tags: ["org:7"],
    });
    expect(cache.namespace("u").describeKey("k").namespace).toBe("app:u");
    const long = "k".repeat(300);
    expect(cache.describeKey(long).key).toBe(
      `#${new Bun.CryptoHasher("sha256").update(long).digest("hex")}`,
    );
  });
});

describe("hashNames: validation at createCache", () => {
  const driver = memoryDriver();

  test("needs a cipher", () => {
    expect(() =>
      // @ts-expect-error -- a compile error too (encrypt.type-test.ts); this is the runtime check, for JavaScript callers and casts
      createCache({ driver, encrypt: { hashNames: { key: NAMES_KEY } } }),
    ).toThrow(/encrypt\.hashNames needs a cipher/);
    expect(() =>
      createCache({
        driver,
        hashNames: { key: NAMES_KEY },
      } as unknown as Parameters<typeof createCache>[0]),
    ).toThrow(/hashNames is an encrypt option/);
  });

  test("takes exactly one of key and hash, each well-formed", () => {
    const withNames = (hashNames: unknown) => () =>
      createCache({
        driver,
        encrypt: {
          keys: ENCRYPT.keys,
          hashNames: hashNames as { key: Uint8Array },
        },
      });
    expect(withNames({})).toThrow(/exactly one of key/);
    expect(withNames({ key: NAMES_KEY, hash: () => "x" })).toThrow(
      /exactly one of key/,
    );
    expect(withNames({ hash: "x" })).toThrow(/must be a function/);
    expect(withNames({ key: new Uint8Array(16) })).toThrow(
      /encrypt\.hashNames\.key must be exactly 32 bytes/,
    );
    expect(withNames("secret")).toThrow(/must be \{ key \}/);
    // Hex, base64 and base64url spellings of 32 bytes are keys.
    for (const key of [
      Buffer.from(NAMES_KEY).toString("hex"),
      Buffer.from(NAMES_KEY).toString("base64"),
      Buffer.from(NAMES_KEY).toString("base64url"),
    ]) {
      const cache = withNames({ key })();
      expect(cache.describeKey("k").key).toBe(expectedHash("key\0cache\0k"));
    }
  });

  test("a names key that is also a ring key is allowed, and warned", () => {
    const { logger, events } = createTestLogger();
    createCache({
      driver,
      logger,
      encrypt: { keys: ENCRYPT.keys, hashNames: { key: KEY_A } },
    });
    expect(
      events.filter((event) => event.message.includes("hashNames.key is also")),
    ).toHaveLength(1);
    const quiet = createTestLogger();
    createCache({ driver, logger: quiet.logger, encrypt: ENCRYPT });
    expect(quiet.events).toHaveLength(0);
  });
});
