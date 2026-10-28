/**
 * The Redis driver's suite (plan §7.7), registered once per lane: the
 * conformance kit — with its two-process pass and the bus-gap case (a
 * dropped subscriber connection) — and the driver's specifics.
 *
 * - **`redis.test.ts`**: the local server `BUN_CACHE_TEST_REDIS_URL` (or
 *   `BUN_JOBS_TEST_REDIS_URL`) names, database 15, the repository's test
 *   database (`bun scripts/setup-databases.ts --print-env`).
 * - **`upstash.test.ts`**: an opt-in managed Redis across the internet,
 *   `BUN_CACHE_TEST_UPSTASH_REDIS_URL` (a `rediss://…upstash.io` URL; never
 *   committed). Each command is a round trip of ~300 ms there, it has no
 *   `CLIENT KILL`, and its `PEXPIRETIME` sits a few ms off the `PEXPIREAT`
 *   sent: {@link RedisLane} carries those differences, nothing else.
 *
 * Test data: every key carries this run's prefix
 * (`bun-cache-test:<pid>-<time>`), and the end of the file deletes exactly the
 * keys under the prefixes it used.
 */
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import type { Socket } from "bun";
import type { BusMessage, CacheBus, StoredEntry } from "../../lib/index";
import { createCache, redisBus, redisDriver } from "../../lib/index";
import type { RedisDriverOptions } from "../../lib/drivers/redis";
import { RedisCacheDriver } from "../../lib/drivers/redis";
import { runCacheDriverConformance } from "../../lib/testing/index";
import { deleteRedisPrefix } from "./backends";

/** How a Redis lane differs from the local server's: a remote, managed one (Upstash) answers slower and supports less. */
export interface RedisLane {
  /** The lane's name in the titles: `redis` (local), `upstash`. */
  name: string;
  /**
   * How the kit's bus-gap case drops the bus's subscriber connection, both
   * server-side so Bun reconnects it: `"client-kill"` sends `CLIENT KILL` from
   * a helper connection; `"quit"` sends `QUIT` on the subscriber itself, for
   * a server without `CLIENT KILL` (Upstash: "Command is not available").
   */
  busGap: "client-kill" | "quit";
  /**
   * How far a key's `PEXPIRETIME` may sit from the `PEXPIREAT` the driver
   * sent, in ms. `0` on a local Redis; Upstash reports it a few ms off
   * (measured -35 to +22 ms, `PXAT` the same).
   */
  expiryToleranceMs: number;
  /** A TTL that lapses within a test yet outlives the round trips that write and read it, in ms. */
  shortTtlMs: number;
  /** Rounds of the fence-against-invalidation race (three round trips each). */
  raceRounds: number;
}

/** The local server's lane: exact expiry, 60 ms TTLs, 60 race rounds. */
export const LOCAL_REDIS_LANE: RedisLane = {
  name: "redis",
  busGap: "client-kill",
  expiryToleranceMs: 0,
  shortTtlMs: 60,
  raceRounds: 60,
};

/** An entry for the specifics. */
function entry(
  key: string,
  bytes: number[],
  tags: readonly string[] = [],
  expiresAt: number | null = null,
): StoredEntry {
  return { key, value: new Uint8Array(bytes), expiresAt, tags };
}

/** Waits until `condition` holds, checking every 10 ms; throws after `timeoutMs`. */
async function waitFor(
  what: string,
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await Bun.sleep(10);
  }
}

/** The pub/sub connection a driver's bus subscribes on, by its `CLIENT SETNAME`; killed server-side so Bun reconnects it. */
async function killSubscriber(
  helper: RedisClient,
  bus: CacheBus,
): Promise<void> {
  const name = (bus as CacheBus & { connectionName: string }).connectionName;
  const list = (await helper.send("CLIENT", [
    "LIST",
    "TYPE",
    "pubsub",
  ])) as string;
  const line = list.split("\n").find((each) => each.includes(` name=${name} `));
  const id = /\bid=(\d+)/.exec(line ?? "")?.[1];
  if (id === undefined) {
    throw new Error(`no pub/sub connection named ${name}`);
  }
  await helper.send("CLIENT", ["KILL", "ID", id]);
}

/**
 * A TCP relay in front of the server at `url` that holds every chunk `delayMs`
 * each way, so a local Redis answers like a distant one. Answers the relayed
 * URL (same credentials and database) and a `stop()`.
 */
function delayedRelay(
  url: string,
  delayMs: number,
): { url: string; stop: () => void } {
  const target = new URL(url);
  /** Per inbound connection: the upstream socket once open, and what arrived before it. */
  interface Relay {
    /** The connection to the real server. */
    upstream?: Socket<undefined>;
    /** Chunks from the client that arrived before `upstream` opened. */
    pending: Uint8Array[];
  }
  const server = Bun.listen<Relay>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        client.data = { pending: [] };
        const upstream = await Bun.connect({
          hostname: target.hostname,
          port: Number(target.port || 6379),
          socket: {
            data(_socket, chunk) {
              const copy = new Uint8Array(chunk);
              setTimeout(() => client.write(copy), delayMs);
            },
            close() {
              client.end();
            },
          },
        });
        client.data.upstream = upstream;
        for (const chunk of client.data.pending) {
          upstream.write(chunk);
        }
      },
      data(client, chunk) {
        const copy = new Uint8Array(chunk);
        setTimeout(() => {
          if (client.data.upstream === undefined) {
            client.data.pending.push(copy);
          } else {
            client.data.upstream.write(copy);
          }
        }, delayMs);
      },
      close(client) {
        client.data.upstream?.end();
      },
    },
  });
  const relayed = new URL(url);
  relayed.hostname = "127.0.0.1";
  relayed.port = String(server.port);
  return { url: relayed.toString(), stop: () => server.stop(true) };
}

/**
 * A `RedisClient` seen through a proxy, for the cases that need a server to
 * answer differently (a flushed script cache, a cluster node). Methods are
 * bound to the real client; `override` replaces some.
 */
function proxied(
  client: RedisClient,
  override: Partial<Record<keyof RedisClient, unknown>>,
): RedisClient {
  return new Proxy(client, {
    get(target, property, _receiver) {
      if (Object.hasOwn(override, property)) {
        return override[property as keyof RedisClient];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** Registers the kit and the specifics against the server at `url`, as `lane` says. */
export async function registerRedisSuite(
  url: string,
  lane: RedisLane = LOCAL_REDIS_LANE,
): Promise<void> {
  const run = `bun-cache-test:${process.pid}-${Date.now().toString(36)}`;
  const prefixes = new Set<string>();
  /** A prefix of this run's, recorded so the end of the file deletes its keys. */
  const prefix = (suffix: string): string => {
    const value = `${run}:${suffix}`;
    prefixes.add(value);
    return value;
  };
  const opened: RedisCacheDriver[] = [];
  /** A driver on this run's keys, closed at the end. */
  const make = (
    suffix: string,
    extra: Partial<RedisDriverOptions> = {},
  ): RedisCacheDriver => {
    const driver = new RedisCacheDriver({
      url,
      prefix: prefix(suffix),
      ...extra,
    });
    opened.push(driver);
    return driver;
  };
  const helper = new RedisClient(url);

  afterAll(async () => {
    for (const driver of opened) {
      await driver.close().catch(() => undefined);
    }
    for (const each of prefixes) {
      await deleteRedisPrefix(url, each);
    }
    helper.close();
  });

  const kitOptions = { url, prefix: prefix("kit") };
  // Without CLIENT KILL, the gap is a QUIT sent on the bus's own subscriber
  // connection, so the kit's driver runs on a client whose duplicate() (the
  // bus subscribes on one) is kept. The driver never closes a given client.
  const kitClient = new RedisClient(url);
  let kitSubscriber: RedisClient | undefined;
  const kitDriver =
    lane.busGap === "quit"
      ? new RedisCacheDriver({
          prefix: kitOptions.prefix,
          client: proxied(kitClient, {
            duplicate: async () => {
              kitSubscriber = await kitClient.duplicate();
              return kitSubscriber;
            },
          }),
        })
      : new RedisCacheDriver(kitOptions);
  await kitDriver.connect();
  await runCacheDriverConformance(
    lane.name,
    () => ({
      driver: kitDriver,
      cleanup: async () => {
        await kitDriver.close();
        kitClient.close();
      },
    }),
    {
      crossProcess: {
        module: new URL("../../lib/drivers/redis.ts", import.meta.url).pathname,
        export: "redisDriver",
        options: kitOptions,
      },
      // A pushed bus: the gap is a dropped subscriber connection, whatever
      // was published while it reconnects being lost.
      busGap: async () => {
        if (lane.busGap === "client-kill") {
          await killSubscriber(helper, kitDriver.bus);
        } else {
          if (kitSubscriber === undefined) {
            throw new Error("the bus has no subscriber connection yet");
          }
          await kitSubscriber.send("QUIT", []);
        }
      },
      skip: [
        {
          id: "expiry.sweep",
          reason:
            "expiry is native (PEXPIREAT): Redis reclaims expired entries itself, and sweep prunes only tag sets and stamps (covered in the specifics)",
        },
      ],
    },
  );

  describe(`${lane.name} specifics`, () => {
    const driver = make("spec");
    const ns = `spec-${process.pid}`;
    /** Asserts a key's server-side expiry is `at`, within the lane's tolerance. */
    const expectExpiry = async (key: string, at: number): Promise<void> => {
      const actual = Number(await helper.send("PEXPIRETIME", [key]));
      if (lane.expiryToleranceMs === 0) {
        expect(actual).toBe(at);
      } else {
        expect(Math.abs(actual - at)).toBeLessThanOrEqual(
          lane.expiryToleranceMs,
        );
      }
    };
    /** A key's full name under a driver's prefix, as the layout says (§7.7). */
    const keyOf = (
      on: RedisCacheDriver,
      namespace: string,
      kind: string,
      key: string,
    ): string => `${on.prefix}:{${namespace}}:${kind}:${key}`;

    test("the key layout: a frame per entry with native expiry, a set per tag, a hash per counter, stamps and tag sets without a TTL", async () => {
      const at = Date.now() + 60_000;
      await driver.set(ns, entry("k", [0, 10, 255], ["red", "blue"], at));
      const ek = keyOf(driver, ns, "e", "k");
      await expectExpiry(ek, at);
      const frame = (await helper.getBuffer(ek))!;
      const newline = frame.indexOf(10);
      expect(new TextDecoder().decode(frame.subarray(0, newline))).toBe(
        `1 ${at} ["red","blue"]`,
      );
      expect([...frame.subarray(newline + 1)]).toEqual([0, 10, 255]);
      const tk = keyOf(driver, ns, "t", "red");
      expect(await helper.smembers(tk)).toEqual(["k"]);
      expect(await helper.pttl(tk)).toBe(-1);

      await driver.deleteByTags(ns, ["blue"], Date.now() + 60_000);
      const sk = keyOf(driver, ns, "s", "blue");
      expect(await helper.get(sk)).toMatch(/^\d+ \d+$/);
      expect(await helper.pttl(sk)).toBe(-1);
      // The entry went with both its memberships.
      expect(await helper.exists(ek)).toBe(false);
      expect(await helper.smembers(tk)).toEqual([]);

      const later = Date.now() + 30_000;
      await driver.increment(ns, "c", 3, later);
      const nk = keyOf(driver, ns, "n", "c");
      expect(await helper.hmget(nk, "n", "x")).toEqual(["3", String(later)]);
      await expectExpiry(nk, later);
    });

    test("any namespace is safe: look-alikes never share keys, and one that spells the key structure (`}:t:`) cannot mislead the sweep", async () => {
      // The core allows `:` and `@` in namespaces; a driver is handed any
      // string, glob characters and braces included.
      const spaces = [
        `${ns}-a`,
        `${ns}-a:b`,
        `${ns}-x*`,
        `${ns}-xy`,
        `${ns}-q?`,
        `${ns}-qz`,
        `${ns}-b}`,
        `${ns}-b`,
        `${ns}-[c]`,
        `${ns}-c`,
      ];
      for (const [index, space] of spaces.entries()) {
        await driver.set(space, entry("k", [index], ["t"]));
      }
      expect(await helper.exists(keyOf(driver, `${ns}-a~3ab`, "e", "k"))).toBe(
        true,
      );
      // Clearing each pattern-like namespace leaves its look-alike.
      for (const index of [0, 2, 4, 6, 8]) {
        await driver.clear(spaces[index]);
        expect(await driver.get(spaces[index], "k")).toBeUndefined();
        expect([...(await driver.get(spaces[index + 1], "k"))!.value]).toEqual([
          index + 1,
        ]);
      }
      for (const index of [1, 3, 5, 7, 9]) {
        expect(
          await driver.deleteByTags(spaces[index], ["t"], Date.now() + 60_000),
        ).toBe(1);
      }
      // The sweep reads a key's namespace back from its name: a namespace
      // spelling `}:t:` would, unencoded, make its tag set read as another
      // namespace's, whose entries are absent — and lose live members.
      const sweeper = make("forge");
      const forged = `${ns}-f}:t:x`;
      await sweeper.set(forged, entry("k", [1], ["t"]));
      await sweeper.sweep(Date.now(), 1_000);
      expect(
        await sweeper.deleteByTags(forged, ["t"], Date.now() + 60_000),
      ).toBe(1);
    });

    test("clear takes entries, counters and tag sets; stamps and locks stay", async () => {
      const space = `${ns}-clear`;
      await driver.set(space, entry("k", [1], ["t"]));
      await driver.increment(space, "c", 1, null);
      await driver.setStamps(space, ["s"], Date.now(), Date.now() + 60_000);
      expect(await driver.acquireLock(space, "l", "me", 60_000)).toBe(true);
      await driver.clear(space);
      expect(await driver.get(space, "k")).toBeUndefined();
      expect(await driver.getCounter(space, "c")).toBeUndefined();
      expect(await helper.exists(keyOf(driver, space, "t", "t"))).toBe(false);
      expect((await driver.getStamps(space, ["s"])).has("s")).toBe(true);
      expect(await driver.acquireLock(space, "l", "you", 60_000)).toBe(false);
    });

    test("a prefix with glob characters matches only itself", async () => {
      const starred = make("g*");
      const neighbour = make("gz");
      await starred.set(ns, entry("k", [1]));
      await neighbour.set(ns, entry("k", [2]));
      await starred.clear(ns);
      expect(await starred.get(ns, "k")).toBeUndefined();
      expect([...(await neighbour.get(ns, "k"))!.value]).toEqual([2]);
    });

    test("an overwrite drops the old tags: invalidating one the entry no longer carries leaves it", async () => {
      await driver.set(ns, entry("retag", [1], ["old"]));
      await driver.set(ns, entry("retag", [2], ["new"]));
      expect(await driver.deleteByTags(ns, ["old"], Date.now() + 60_000)).toBe(
        0,
      );
      expect([...(await driver.get(ns, "retag"))!.value]).toEqual([2]);
      expect(await driver.deleteByTags(ns, ["new"], Date.now() + 60_000)).toBe(
        1,
      );
    });

    test("keys are exact: case, spaces, colons and braces make different keys", async () => {
      const keys = ["a", "A", "a ", "a:b", "{a}", "a\nb"];
      for (const [index, key] of keys.entries()) {
        await driver.set(ns, entry(key, [index], [`tag:${key}`]));
      }
      for (const [index, key] of keys.entries()) {
        const read = await driver.get(ns, key);
        expect(read?.key).toBe(key);
        expect([...read!.value]).toEqual([index]);
        expect(read!.tags).toEqual([`tag:${key}`]);
      }
      expect(await driver.delete(ns, keys)).toBe(keys.length);
    });

    test("counters: below zero, replacing an entry, replaced by a set, restarting once expired", async () => {
      expect(await driver.increment(ns, "neg", -3, null)).toBe(-3);
      expect(await driver.increment(ns, "neg", -2, null)).toBe(-5);
      expect(await driver.increment(ns, "neg", 7, null)).toBe(2);

      await driver.set(ns, entry("was-entry", [9], ["x"]));
      expect(await driver.increment(ns, "was-entry", 4, null)).toBe(4);
      expect(await driver.get(ns, "was-entry")).toBeUndefined();
      expect(await driver.deleteByTags(ns, ["x"], Date.now() + 60_000)).toBe(0);
      expect((await driver.getCounter(ns, "was-entry"))?.value).toBe(4);

      await driver.set(ns, entry("was-entry", [5]));
      expect(await driver.getCounter(ns, "was-entry")).toBeUndefined();
      expect([...(await driver.get(ns, "was-entry"))!.value]).toEqual([5]);

      const created = Date.now();
      await driver.increment(ns, "expiring", 10, Date.now() + lane.shortTtlMs);
      expect(
        (await driver.getCounter(ns, "expiring"))?.createdAt,
      ).toBeGreaterThanOrEqual(created);
      await Bun.sleep(lane.shortTtlMs + 20);
      const later = Date.now() + 60_000;
      expect(await driver.increment(ns, "expiring", 1, later)).toBe(1);
      expect((await driver.getCounter(ns, "expiring"))?.expiresAt).toBe(later);

      // A counter and an entry, one each.
      expect(await driver.delete(ns, ["neg", "was-entry", "nothing"])).toBe(2);
      await expect(driver.increment(ns, "frac", 0.5, null)).rejects.toThrow(
        TypeError,
      );
    });

    test("touch rewrites an entry's expiry in its frame and on the key, and a counter's", async () => {
      const at = Date.now() + 60_000;
      await driver.set(ns, entry("t", [7], ["tt"], Date.now() + 30_000));
      expect(await driver.touch(ns, "t", at)).toBe(true);
      expect((await driver.get(ns, "t"))?.expiresAt).toBe(at);
      expect([...(await driver.get(ns, "t"))!.value]).toEqual([7]);
      expect((await driver.get(ns, "t"))?.tags).toEqual(["tt"]);
      const ek = keyOf(driver, ns, "e", "t");
      await expectExpiry(ek, at);
      expect(await driver.touch(ns, "t", null)).toBe(true);
      expect((await driver.get(ns, "t"))?.expiresAt).toBeNull();
      expect(await helper.pttl(ek)).toBe(-1);

      await driver.increment(ns, "tc", 1, null);
      expect(await driver.touch(ns, "tc", at)).toBe(true);
      expect((await driver.getCounter(ns, "tc"))?.expiresAt).toBe(at);
      expect(await driver.touch(ns, "absent", at)).toBe(false);
    });

    test("an expired entry is a miss everywhere, even before Redis reclaims it", async () => {
      // The driver's clock runs ahead of the server's: Redis still holds the
      // key, but its expiry has passed for the reader.
      const ahead = make("clock", { now: () => Date.now() + 120_000 });
      await ahead.set(ns, entry("soon", [1], [], Date.now() + 60_000));
      expect(await helper.exists(keyOf(ahead, ns, "e", "soon"))).toBe(true);
      expect(await ahead.get(ns, "soon")).toBeUndefined();
      expect((await ahead.getMany(ns, ["soon"]))[0]).toBeUndefined();
      await ahead.increment(ns, "n", 1, Date.now() + 60_000);
      expect(await ahead.getCounter(ns, "n")).toBeUndefined();
    });

    test("sweep prunes tag sets of entries gone underneath (expired, evicted) and lapsed stamps, and keeps live ones", async () => {
      const sweeper = make("sweep");
      const space = `${ns}-sweep`;
      await sweeper.set(space, entry("live", [1], ["t"]));
      await sweeper.set(space, entry("evicted", [2], ["t", "u"]));
      // An eviction: the key vanishes without the driver's knowing.
      await helper.unlink(keyOf(sweeper, space, "e", "evicted"));
      const now = Date.now();
      await sweeper.setStamps(space, ["old"], now - 120_000, now - 60_000);
      await sweeper.setStamps(space, ["fresh"], now, now + 60_000);
      expect(await sweeper.sweep(Date.now(), 1_000)).toBe(3);
      expect(await helper.smembers(keyOf(sweeper, space, "t", "t"))).toEqual([
        "live",
      ]);
      expect(await helper.exists(keyOf(sweeper, space, "t", "u"))).toBe(false);
      expect(await helper.exists(keyOf(sweeper, space, "s", "old"))).toBe(
        false,
      );
      expect((await sweeper.getStamps(space, ["fresh"])).has("fresh")).toBe(
        true,
      );
      // Invalidation still finds what is left.
      expect(
        await sweeper.deleteByTags(space, ["t"], Date.now() + 60_000),
      ).toBe(1);
    });

    test("a lock re-taken by its owner is refreshed, not refused, and lapses natively", async () => {
      expect(await driver.acquireLock(ns, "re", "me", 30_000)).toBe(true);
      expect(await driver.acquireLock(ns, "re", "me", 30_000)).toBe(true);
      expect(await driver.acquireLock(ns, "re", "you", 30_000)).toBe(false);
      expect(await helper.pttl(keyOf(driver, ns, "l", "re"))).toBeGreaterThan(
        29_000,
      );
    });

    test("the fence holds under a concurrent invalidation: a pre-invalidation write never survives it", async () => {
      // Each round races a fenced write, whose load began before, against an
      // invalidation of its tag from another connection, either side first.
      // Whichever lands first, nothing may be left: either the write was
      // fenced, or the invalidation deleted it.
      const raceNs = `race-${process.pid}`;
      const other = make("spec");
      const survivors: number[] = [];
      for (let round = 0; round < lane.raceRounds; round++) {
        const key = `k${round}`;
        const tag = `t${round}`;
        const startedAt = Date.now() - 1;
        await Promise.all([
          (async () => {
            await Bun.sleep(round % 2 === 0 ? round % 3 : 0);
            await driver.set(raceNs, entry(key, [1], [tag]), {
              tags: [tag],
              createdAt: startedAt,
            });
          })(),
          (async () => {
            await Bun.sleep(round % 2 === 1 ? round % 3 : 0);
            await other.deleteByTags(raceNs, [tag], Date.now() + 60_000);
          })(),
        ]);
        if ((await driver.get(raceNs, key)) !== undefined) {
          survivors.push(round);
        }
      }
      expect(survivors).toEqual([]);
    });

    test("a script the server forgot (NOSCRIPT) is sent again with EVAL", async () => {
      const client = new RedisClient(url);
      let forgotten = 0;
      const wrapped = proxied(client, {
        evalsha: async () => {
          forgotten++;
          throw new Error("NOSCRIPT No matching script. Please use EVAL.");
        },
      });
      const forgetful = new RedisCacheDriver({
        client: wrapped,
        prefix: prefix("noscript"),
      });
      expect(await forgetful.set(ns, entry("k", [1], ["t"]))).toBe("stored");
      expect(await forgetful.increment(ns, "c", 2, null)).toBe(2);
      expect(await forgetful.deleteByTags(ns, ["t"], Date.now() + 60_000)).toBe(
        1,
      );
      expect(forgotten).toBe(3);
      // Any other script error is the caller's.
      const failing = new RedisCacheDriver({
        client: proxied(client, {
          evalsha: async () => {
            throw new Error("ERR something else");
          },
        }),
        prefix: prefix("noscript"),
      });
      await expect(failing.set(ns, entry("k", [1]))).rejects.toThrow(
        "something else",
      );
      await forgetful.close();
      await failing.close();
      client.close();
    });

    test("an existing client is used and never closed; the bus's duplicate is", async () => {
      const client = new RedisClient(url);
      await client.connect();
      const shared = new RedisCacheDriver({
        client,
        prefix: prefix("shared"),
      });
      await shared.set(ns, entry("k", [1]));
      const received: BusMessage[] = [];
      await shared.subscribe(
        (message) => received.push(message),
        () => {},
      );
      const name = (shared.bus as CacheBus & { connectionName: string })
        .connectionName;
      await shared.close();
      expect(client.connected).toBe(true);
      expect(await client.send("PING", [])).toBe("PONG");
      const list = (await helper.send("CLIENT", ["LIST"])) as string;
      expect(list.includes(` name=${name} `)).toBe(false);
      client.close();
    });

    test("the bus is redisBus's: a separate redisBus on the same prefix hears the driver, and the driver hears it", async () => {
      const busPrefix = prefix("bus");
      const a = make("bus");
      const separate = redisBus({ url, prefix: busPrefix });
      const heardBySeparate: BusMessage[] = [];
      const heardByDriver: BusMessage[] = [];
      await separate.subscribe(
        (message) => heardBySeparate.push(message),
        () => {},
      );
      await a.subscribe(
        (message) => heardByDriver.push(message),
        () => {},
      );
      const fromDriver: BusMessage = {
        type: "invalidate-tags",
        namespace: "app",
        tags: ["users"],
        at: Date.now(),
        origin: "driver",
      };
      await a.publish(fromDriver);
      const fromBus: BusMessage = {
        type: "delete",
        namespace: "app",
        keys: ["k"],
        at: Date.now(),
        origin: "bus",
      };
      await separate.publish(fromBus);
      await waitFor(
        "both messages on both sides",
        () => heardBySeparate.length === 2 && heardByDriver.length === 2,
      );
      expect(heardBySeparate).toEqual([fromDriver, fromBus]);
      expect(heardByDriver).toEqual([fromDriver, fromBus]);
      expect((a.bus as CacheBus & { channel: string }).channel).toBe(
        `${busPrefix}:bus`,
      );
      await separate.close();
    });

    test("a cache over the driver: getOrSet, tags, counters, and an L1 kept coherent by the driver's bus", async () => {
      const space = `cache-${process.pid}`;
      const one = createCache({
        driver: make("cache"),
        namespace: space,
        sweepInterval: 0,
        l1: true,
      });
      const two = createCache({
        driver: make("cache"),
        namespace: space,
        sweepInterval: 0,
        l1: true,
      });
      let loads = 0;
      const load = async () => {
        loads++;
        return { n: loads };
      };
      expect(await one.getOrSet("k", load, { tags: ["g"] })).toEqual({ n: 1 });
      expect(await two.getOrSet("k", load, { tags: ["g"] })).toEqual({ n: 1 });
      // Two's L1 fills once its bus subscription is up (until then a read
      // goes to the driver and is not copied): read until it holds k.
      for (let tries = 0; (two.stats().l1?.entries ?? 0) === 0; tries++) {
        expect(tries).toBeLessThan(200);
        expect(await two.get("k")).toEqual({ n: 1 });
        await Bun.sleep(10);
      }
      await one.invalidateTags(["g"]);
      // The fence counts a stamp at the load's own millisecond as newer (the
      // kit's note), so the reload starts a tick later and is stored.
      await Bun.sleep(2);
      expect(await one.getOrSet("k", load, { tags: ["g"] })).toEqual({ n: 2 });
      // Two's L1 copy was dropped by the bus message, not served stale.
      await waitFor(
        "two's L1 to drop k",
        () => (two.stats().l1?.invalidations ?? 0) > 0,
      );
      expect(await two.get("k")).toEqual({ n: 2 });
      expect(await one.increment("hits", 5)).toBe(5);
      expect(await two.get("hits")).toBe(5);
      await one.close();
      await two.close();
    });

    test("an unreachable server fails the first connect within firstConnectTimeout, naming it", async () => {
      // A port nothing listens on: bound once by the OS, then released.
      const probe = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data() {} },
      });
      const port = probe.port;
      probe.stop(true);
      const down = redisDriver({
        url: `redis://127.0.0.1:${port}`,
        firstConnectTimeout: 300,
      });
      const started = Date.now();
      await expect(down.get(ns, "k")).rejects.toThrow(
        `no connection to 127.0.0.1:${port}`,
      );
      expect(Date.now() - started).toBeLessThan(3_000);
      await down.close();
    });

    // A relay can only slow a plain connection: a TLS one names the real host.
    test.skipIf(!url.startsWith("redis://"))(
      "a distant server, whose first connect takes over a second, is reached within the default firstConnectTimeout",
      async () => {
        // 550 ms each way: Bun's connect (HELLO and SELECT, pipelined) takes
        // one round trip, 1.1 s here — what a TLS connect to a managed Redis
        // in another region measured (Upstash: 549–1004 ms). The old 1 s
        // default refused it.
        const relay = delayedRelay(url, 550);
        const far = make("far", { url: relay.url });
        try {
          const started = Date.now();
          await far.connect();
          expect(Date.now() - started).toBeGreaterThan(1_000);
          expect(await far.get(ns, "absent")).toBeUndefined();
        } finally {
          await far.close();
          relay.stop();
        }
      },
      15_000,
    );

    test("cluster: true, and a connection to a cluster node, fail naming oven-sh/bun#22947", async () => {
      expect(() => redisDriver({ url, cluster: true })).toThrow(
        /Redis Cluster is not supported yet.*22947/,
      );
      const client = new RedisClient(url);
      const clusterNode = new RedisCacheDriver({
        client: proxied(client, {
          send: async (command: string, args: string[]) =>
            command === "INFO" && args[0] === "cluster"
              ? "# Cluster\r\ncluster_enabled:1\r\n"
              : await client.send(command, args),
        }),
        prefix: prefix("cluster"),
      });
      await expect(clusterNode.get(ns, "k")).rejects.toThrow(/22947/);
      await clusterNode.close();
      client.close();
    });

    test("options are checked before anything connects", () => {
      expect(() => redisDriver({ url, prefix: "" })).toThrow(TypeError);
      expect(() => redisDriver({ url, prefix: "a{b" })).toThrow(TypeError);
      expect(() => redisDriver({ url, firstConnectTimeout: -1 })).toThrow(
        TypeError,
      );
      expect(() => redisDriver({})).toThrow(TypeError);
      // Connection fields build the URL, database included.
      const fields = new RedisCacheDriver({
        connection: { host: "127.0.0.1", port: 6379, database: 15 },
      });
      expect(fields.prefix).toBe("bun-cache");
      void fields.close();
    });
  });
}
