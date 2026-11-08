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
 *   `CLIENT KILL`, its `PEXPIRETIME` sits a few ms off the `PEXPIREAT`
 *   sent, and it takes the `keyLocking` flag local Redis refuses:
 *   {@link RedisLane} carries those differences, nothing else.
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
import {
  RedisCacheDriver,
  SET_MANY_STAGED_BYTES,
  STAGE_FRAME_BYTES,
} from "../../lib/drivers/redis";
import { runCacheDriverConformance } from "../../lib/testing/index";
import { deleteRedisPrefix, redisRawDump } from "./backends";
import { registerSetManyChunkTests } from "./setManyChunks";

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
  /**
   * Whether every driver the suite builds sets `keyLocking` (Upstash's
   * `allow-key-locking` script flag), so the kit and the specifics run
   * key-locked. Only on a server that accepts the flag.
   */
  keyLocking: boolean;
  /**
   * Whether the server accepts the `allow-key-locking` script flag: Upstash
   * does; Redis refuses it ("Unexpected flag in script shebang", Redis
   * 8.0.5, measured), and the suite then checks the driver says so.
   */
  acceptsKeyLocking: boolean;
}

/** The local server's lane: exact expiry, 60 ms TTLs, 60 race rounds, no key locking (Redis refuses the flag). */
export const LOCAL_REDIS_LANE: RedisLane = {
  name: "redis",
  busGap: "client-kill",
  expiryToleranceMs: 0,
  shortTtlMs: 60,
  raceRounds: 60,
  keyLocking: false,
  acceptsKeyLocking: false,
};

/**
 * A script made to enforce Upstash's `allow-key-locking` rule on any Redis:
 * every key a `redis.call`/`redis.pcall` names must share a hash tag with a
 * key in `KEYS` (Upstash: "Dynamic keys are not allowed in Lua scripts when
 * 'allow-key-locking' flag is set", measured 2026-10-28), else the script
 * fails with `KEYLOCK`. The key is a command's first argument, and every
 * argument of `UNLINK`, `DEL` and `EXISTS` — the commands the driver's
 * scripts send. A hash tag is what is between the first `{` and the first
 * `}` after it, when not empty; otherwise the whole key.
 */
function enforceKeyLockingRule(source: string): string {
  const prelude = `
local function __kl_tag(k)
  local s = string.find(k, '{', 1, true)
  if s then
    local e = string.find(k, '}', s + 1, true)
    if e and e > s + 1 then return string.sub(k, s + 1, e - 1) end
  end
  return k
end
local __kl_locked = {}
for _, k in ipairs(KEYS) do __kl_locked[__kl_tag(k)] = true end
local function __kl_check(cmd, ...)
  local args = {...}
  local n = 1
  local c = string.upper(cmd)
  if c == 'UNLINK' or c == 'DEL' or c == 'EXISTS' then n = #args end
  for i = 1, n do
    if not __kl_locked[__kl_tag(args[i])] then error('KEYLOCK a key outside the locked hash tags: ' .. args[i]) end
  end
end
local function __kl_call(cmd, ...) __kl_check(cmd, ...) return redis.call(cmd, ...) end
local function __kl_pcall(cmd, ...) __kl_check(cmd, ...) return redis.pcall(cmd, ...) end
`;
  const body = source
    .replaceAll("redis.call(", "__kl_call(")
    .replaceAll("redis.pcall(", "__kl_pcall(");
  return `${prelude}\n${body}`;
}

/** An entry for the specifics. */
function entry(
  key: string,
  bytes: number[],
  tags: readonly string[] = [],
  expiresAt: number | null = null,
): StoredEntry {
  return { key, value: new Uint8Array(bytes), expiresAt, tags };
}

/**
 * The bound of a specific that waits with {@link waitFor}, in ms: beyond the
 * wait's 5 s, so a message that never comes fails the test with the wait's
 * own message, not bun:test's timeout (its default is 5 s too) and the
 * wait's error landing after it, as an unhandled error between tests.
 */
const WAITING_TEST_TIMEOUT_MS = 15_000;

/** Waits until `condition` holds, checking every 10 ms; throws after `timeoutMs`; a test that calls it takes {@link WAITING_TEST_TIMEOUT_MS}. */
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
      keyLocking: lane.keyLocking,
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

  const kitOptions = {
    url,
    prefix: prefix("kit"),
    keyLocking: lane.keyLocking,
  };
  // Without CLIENT KILL, the gap is a QUIT sent on the bus's own subscriber
  // connection, so the kit's driver runs on a client whose duplicate() (the
  // bus subscribes on one) is kept. The driver never closes a given client.
  const kitClient = new RedisClient(url);
  let kitSubscriber: RedisClient | undefined;
  const kitDriver =
    lane.busGap === "quit"
      ? new RedisCacheDriver({
          prefix: kitOptions.prefix,
          keyLocking: lane.keyLocking,
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
      rawDump: async () => await redisRawDump(url, kitOptions.prefix),
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

  // Local only: on a remote, billed lane a thousand-entry batch costs more
  // than it proves (`setManyChunks.ts`).
  if (lane === LOCAL_REDIS_LANE) {
    describe(`${lane.name} setMany chunks`, () => {
      registerSetManyChunkTests(make("chunks"), { atomic: false });
    });

    describe(`${lane.name} set's script: the fence in one read, memberships kept`, () => {
      const driver = make("setscript");
      const ns = `setscript-${process.pid}`;
      /** Whether `key` is a member of `tag`'s set. */
      const member = async (tag: string, key: string): Promise<boolean> =>
        Number(
          await helper.send("SISMEMBER", [
            `${driver.prefix}:{${ns}}:t:${tag}`,
            key,
          ]),
        ) === 1;

      test("the fence reads every tag's stamp: only the last one stamped still fences; a lapsed or older stamp does not", async () => {
        const now = Date.now();
        await driver.setStamps(ns, ["s3"], now, now + 60_000);
        await driver.setStamps(ns, ["lapsed"], now, now - 1);
        await driver.setStamps(ns, ["older"], now - 5_000, now + 60_000);
        const fence = (tags: string[]) => ({ tags, createdAt: now - 1 });
        expect(
          await driver.set(
            ns,
            entry("k", [1], ["s1", "s2", "s3"]),
            fence(["s1", "s2", "s3"]),
          ),
        ).toBe("fenced");
        expect(await driver.get(ns, "k")).toBeUndefined();
        expect(
          await driver.set(
            ns,
            entry("k", [2], ["lapsed", "older", "none"]),
            fence(["lapsed", "older", "none"]),
          ),
        ).toBe("stored");
        expect((await driver.get(ns, "k"))?.value).toEqual(new Uint8Array([2]));
      });

      test("replacing an entry keeps the memberships of the tags it keeps, drops the others and adds the new", async () => {
        await driver.set(ns, entry("r", [1], ["keep", "drop"]));
        await driver.set(ns, entry("r", [2], ["keep", "add"]));
        expect(await member("keep", "r")).toBe(true);
        expect(await member("drop", "r")).toBe(false);
        expect(await member("add", "r")).toBe(true);
        expect((await driver.get(ns, "r"))?.tags).toEqual(["keep", "add"]);
        expect(await driver.deleteByTags(ns, ["drop"], Date.now() + 1000)).toBe(
          0,
        );
        expect(await driver.deleteByTags(ns, ["keep"], Date.now() + 1000)).toBe(
          1,
        );
        expect(await member("add", "r")).toBe(false);
        // Untagged now: every membership goes.
        await driver.set(ns, entry("u", [1], ["a", "b"]));
        await driver.set(ns, entry("u", [2]));
        expect(await member("a", "u")).toBe(false);
        expect(await member("b", "u")).toBe(false);
        expect((await driver.get(ns, "u"))?.value).toEqual(new Uint8Array([2]));
      });
    });

    // Local only, like the chunks: a few MiB of writes, on a billed lane.
    describe(`${lane.name} large frames (staged outside Lua)`, () => {
      const ns = `big-${process.pid}`;
      /** Each `SET` the driver sends outside a script, by key. */
      const staged: string[] = [];
      const client = new RedisClient(url);
      const driver = new RedisCacheDriver({
        prefix: prefix("big"),
        client: proxied(client, {
          send: async (command: string, args: string[]) => {
            if (command === "SET") {
              staged.push(args[0]);
            }
            return await client.send(command, args);
          },
        }),
      });
      afterAll(async () => {
        await driver.close();
        client.close();
      });
      /** Bytes of `size`, each `seed`. */
      const bytes = (size: number, seed: number): number[] =>
        Array.from({ length: size }, () => seed);
      /** The run's keys of this driver's namespace that are staging keys. */
      const stagingKeys = async (): Promise<string[]> => {
        const keys = (await helper.send("KEYS", [
          `${driver.prefix}:*`,
        ])) as string[];
        return keys.filter((key) => key.includes("}:w:"));
      };
      /** The server-side key of an entry. */
      const entryKey = (key: string): string =>
        `${driver.prefix}:{${ns}}:e:${key}`;

      test("a frame from STAGE_FRAME_BYTES up is written by a plain SET and renamed into place; a smaller one is not", async () => {
        staged.length = 0;
        await driver.set(ns, entry("small", bytes(STAGE_FRAME_BYTES - 200, 1)));
        expect(staged).toEqual([]);
        await driver.set(ns, entry("large", bytes(STAGE_FRAME_BYTES, 2)));
        expect(staged).toHaveLength(1);
        expect(staged[0]).toContain(`{${ns}}:w:`);
        expect(await stagingKeys()).toEqual([]);
        const read = await driver.get(ns, "large");
        expect(read?.value).toEqual(
          new Uint8Array(bytes(STAGE_FRAME_BYTES, 2)),
        );
        expect((await driver.get(ns, "small"))?.value.byteLength).toBe(
          STAGE_FRAME_BYTES - 200,
        );
      });

      test("a staged entry keeps its own expiry, and one with none keeps none (the staging key's TTL does not carry over)", async () => {
        const at = Date.now() + 120_000;
        await driver.set(ns, entry("ttl", bytes(100_000, 3), [], at));
        expect(
          Number(await helper.send("PEXPIRETIME", [entryKey("ttl")])),
        ).toBe(at);
        await driver.set(ns, entry("forever", bytes(100_000, 4)));
        expect(Number(await helper.send("PTTL", [entryKey("forever")]))).toBe(
          -1,
        );
        // Replacing a staged entry that had an expiry with one that has none.
        await driver.set(ns, entry("ttl", bytes(100_000, 5)));
        expect(Number(await helper.send("PTTL", [entryKey("ttl")]))).toBe(-1);
      });

      test("a fenced staged write stores nothing and leaves no staging key", async () => {
        const now = Date.now();
        await driver.setStamps(ns, ["fence"], now, now + 60_000);
        expect(
          await driver.set(ns, entry("fenced", bytes(50_000, 6), ["fence"]), {
            tags: ["fence"],
            createdAt: now - 1,
          }),
        ).toBe("fenced");
        expect(await driver.get(ns, "fenced")).toBeUndefined();
        expect(await stagingKeys()).toEqual([]);
      });

      test("replacing a large entry drops its old tag memberships, a header past 4 KiB of tags included", async () => {
        const many = Array.from(
          { length: 200 },
          (_, index) => `a-long-tag-name-${index}`,
        );
        await driver.set(ns, entry("tagged", bytes(1024 * 1024, 7), many));
        await driver.set(ns, entry("tagged", bytes(200_000, 8), ["kept"]));
        for (const tag of [many[0], many[199]]) {
          expect(
            await helper.send("SISMEMBER", [
              `${driver.prefix}:{${ns}}:t:${tag}`,
              "tagged",
            ]),
          ).toBe(0);
        }
        expect(
          await driver.deleteByTags(ns, [many[5]], Date.now() + 1000),
        ).toBe(0);
        expect((await driver.get(ns, "tagged"))?.tags).toEqual(["kept"]);
        expect(await driver.deleteByTags(ns, ["kept"], Date.now() + 1000)).toBe(
          1,
        );
      });

      test("a large entry replaces a counter, and delete counts it once", async () => {
        await driver.increment(ns, "both", 3, null);
        await driver.set(ns, entry("both", bytes(30_000, 9), ["t-both"]));
        expect(await driver.getCounter(ns, "both")).toBeUndefined();
        expect(await driver.delete(ns, ["both"])).toBe(1);
        expect(await driver.get(ns, "both")).toBeUndefined();
      });

      test("delete still counts and removes a foreign empty value at an entry key", async () => {
        await helper.send("SET", [entryKey("foreign"), ""]);
        expect(await driver.delete(ns, ["foreign", "absent"])).toBe(1);
        expect(await helper.send("EXISTS", [entryKey("foreign")])).toBe(0);
      });
    });

    // Local only, like the chunks: tens of MiB of writes, on a billed lane.
    describe(`${lane.name} setMany and setManyFenced stage large frames`, () => {
      const ns = `bigmany-${process.pid}`;
      const client = new RedisClient(url);
      /** Each staging `SET` the driver sends, by key. */
      const staged: string[] = [];
      /** Each script call's arguments after its keys. */
      const scripts: (string | Uint8Array)[][] = [];
      /** Faults to inject: a staging `SET` to refuse (its index among a call's), or a script failure. */
      const faults: { failStage?: number; failScript?: boolean } = {};
      const driver = new RedisCacheDriver({
        prefix: prefix("bigmany"),
        client: proxied(client, {
          send: async (command: string, args: string[]) => {
            if (command === "SET" && args[0].includes("}:w:")) {
              staged.push(args[0]);
              if (faults.failStage === staged.length - 1) {
                throw new Error("staging SET refused (injected)");
              }
            }
            return await client.send(command, args);
          },
          evalsha: async (
            sha: string,
            numkeys: number,
            ...rest: (string | Uint8Array)[]
          ) => {
            scripts.push(rest.slice(numkeys));
            if (faults.failScript === true) {
              throw new Error("script failed (injected)");
            }
            return await client.evalsha(sha, numkeys, ...(rest as string[]));
          },
        }),
      });
      afterAll(async () => {
        await driver.close();
        client.close();
      });
      /** Bytes of `size`, each `seed`. */
      const bytes = (size: number, seed: number): number[] =>
        Array.from({ length: size }, () => seed);
      /** A `size`-byte entry whose bytes are all `seed` (a typed array, so a MiB is cheap). */
      const big = (
        key: string,
        size: number,
        seed: number,
        tags: readonly string[] = [],
        expiresAt: number | null = null,
      ): StoredEntry => ({
        key,
        value: new Uint8Array(size).fill(seed),
        expiresAt,
        tags,
      });
      /** The run's staging keys of this driver, once the commands sent before have run. */
      const stagingKeys = async (): Promise<string[]> => {
        // The driver's connection runs commands in order: a PING on it
        // waits for an unlink it sent without awaiting.
        await client.send("PING", []);
        const keys = (await helper.send("KEYS", [
          `${driver.prefix}:*`,
        ])) as string[];
        return keys.filter((key) => key.includes("}:w:"));
      };
      /** The server-side key of an entry. */
      const entryKey = (key: string): string =>
        `${driver.prefix}:{${ns}}:e:${key}`;
      /** The largest byte argument any script was given since `from`. */
      const largestArgument = (from = 0): number =>
        Math.max(
          0,
          ...scripts
            .slice(from)
            .flat()
            .map((each) => (typeof each === "string" ? 0 : each.byteLength)),
        );
      /** Clears the recordings and faults. */
      const reset = (): void => {
        staged.length = 0;
        scripts.length = 0;
        delete faults.failStage;
        delete faults.failScript;
      };

      test("setMany stages each frame from STAGE_FRAME_BYTES up and renames it into place; no script argument carries one", async () => {
        const at = Date.now() + 120_000;
        await driver.set(ns, big("forever", 20_000, 1, [], at));
        await driver.set(ns, big("dup", 10, 1));
        reset();
        await driver.setMany(ns, [
          big("small", 100, 2, ["s"]),
          big("edge", STAGE_FRAME_BYTES, 3, ["t"]),
          big("ttl", 1024 * 1024, 4, ["t"], at),
          // Had an expiry: the staged rename must not leave one.
          big("forever", 100_000, 5),
          // A key twice: the last write wins, and both staging keys go.
          big("dup", 50_000, 6, ["t"]),
          big("dup", 20, 7),
        ]);
        expect(staged).toHaveLength(4);
        expect(staged.every((key) => key.includes(`{${ns}}:w:`))).toBe(true);
        expect(scripts).toHaveLength(1);
        expect(largestArgument()).toBeLessThan(STAGE_FRAME_BYTES);
        expect(await stagingKeys()).toEqual([]);
        const [small, edge, ttl, forever, dup] = await driver.getMany(ns, [
          "small",
          "edge",
          "ttl",
          "forever",
          "dup",
        ]);
        expect(small?.value).toEqual(new Uint8Array(bytes(100, 2)));
        expect(edge?.value).toEqual(new Uint8Array(STAGE_FRAME_BYTES).fill(3));
        expect(ttl?.value).toEqual(new Uint8Array(1024 * 1024).fill(4));
        expect(ttl?.expiresAt).toBe(at);
        expect(
          Number(await helper.send("PEXPIRETIME", [entryKey("ttl")])),
        ).toBe(at);
        expect(forever?.value.byteLength).toBe(100_000);
        expect(Number(await helper.send("PTTL", [entryKey("forever")]))).toBe(
          -1,
        );
        expect(dup?.value).toEqual(new Uint8Array(bytes(20, 7)));
        // The tag index: "t" reaches edge and ttl, not dup (its last write is untagged).
        expect(await driver.deleteByTags(ns, ["t"], Date.now() + 1000)).toBe(2);
        expect(await driver.get(ns, "dup")).toBeDefined();
      });

      test("staged frames leave the script's 8 MiB argument budget: 70 MiB of 1 MiB entries is two scripts, cut by SET_MANY_STAGED_BYTES", async () => {
        reset();
        const size = 1024 * 1024;
        const batch = Array.from({ length: 70 }, (_, index) =>
          big(`m${index}`, size, index % 251),
        );
        await driver.setMany(ns, batch);
        // A frame is the value and its 7-byte header ("1 - []\n").
        const perScript = Math.floor(SET_MANY_STAGED_BYTES / (size + 7));
        expect(perScript).toBe(63);
        expect(scripts).toHaveLength(Math.ceil(70 / perScript));
        expect(staged).toHaveLength(70);
        expect(largestArgument()).toBeLessThan(STAGE_FRAME_BYTES);
        expect(await stagingKeys()).toEqual([]);
        const back = await driver.getMany(
          ns,
          batch.map((each) => each.key),
        );
        back.forEach((each, index) => {
          expect(each?.value.byteLength).toBe(size);
          expect(each?.value[size - 1]).toBe(index % 251);
        });
        await driver.delete(
          ns,
          batch.map((each) => each.key),
        );
      }, 60_000);

      test("setManyFenced stages large frames too: a fenced one is unlinked and stores nothing, a stored one is renamed into place", async () => {
        const now = Date.now();
        await driver.setStamps(ns, ["f"], now, now + 60_000);
        await driver.set(ns, big("kept", 10, 1));
        reset();
        const old = { tags: ["f"], createdAt: now - 1 };
        const fresh = { tags: ["f"], createdAt: now + 1 };
        const at = now + 120_000;
        const outcomes = await driver.setManyFenced(ns, [
          { entry: big("kept", 200_000, 2, ["f"]), fence: old },
          { entry: big("bigok", 300_000, 3, ["f"], at), fence: fresh },
          { entry: big("smallno", 10, 4, ["f"]), fence: old },
          { entry: big("smallok", 10, 5, ["f"]), fence: fresh },
          { entry: big("plain", 50_000, 6) },
        ]);
        expect(outcomes).toEqual([
          "fenced",
          "stored",
          "fenced",
          "stored",
          "stored",
        ]);
        expect(staged).toHaveLength(3);
        expect(scripts).toHaveLength(1);
        expect(largestArgument()).toBeLessThan(STAGE_FRAME_BYTES);
        expect(await stagingKeys()).toEqual([]);
        const [kept, bigok, smallno, smallok, plain] = await driver.getMany(
          ns,
          ["kept", "bigok", "smallno", "smallok", "plain"],
        );
        expect(kept?.value).toEqual(new Uint8Array(bytes(10, 1)));
        expect(bigok?.value).toEqual(new Uint8Array(300_000).fill(3));
        expect(
          Number(await helper.send("PEXPIRETIME", [entryKey("bigok")])),
        ).toBe(at);
        expect(smallno).toBeUndefined();
        expect(smallok?.value).toEqual(new Uint8Array(bytes(10, 5)));
        expect(Number(await helper.send("PTTL", [entryKey("plain")]))).toBe(-1);
        expect(plain?.value.byteLength).toBe(50_000);
      });

      test("a staging write that failed fails its chunk whole: nothing is written, the other staging keys go, and the error is the write's", async () => {
        for (const which of ["setMany", "setManyFenced"] as const) {
          await driver.setMany(ns, [big("fa", 10, 1), big("fc", 10, 1)]);
          reset();
          faults.failStage = 1;
          const batch = [
            big("fa", 30_000, 2),
            big("fb", 30_000, 3),
            big("fc", 10, 4),
            big("fd", 40_000, 5),
          ];
          const failure = await (
            which === "setMany"
              ? driver.setMany(ns, batch)
              : driver.setManyFenced(
                  ns,
                  batch.map((entry) => ({ entry })),
                )
          )
            .then(() => undefined)
            .catch((error: unknown) => error as Error);
          expect(failure?.message).toBe("staging SET refused (injected)");
          // The script ran, found a staging key missing, and wrote nothing.
          expect(scripts).toHaveLength(1);
          expect(staged).toHaveLength(3);
          const [fa, fb, fc, fd] = await driver.getMany(ns, [
            "fa",
            "fb",
            "fc",
            "fd",
          ]);
          expect(fa?.value).toEqual(new Uint8Array(bytes(10, 1)));
          expect(fb).toBeUndefined();
          expect(fc?.value).toEqual(new Uint8Array(bytes(10, 1)));
          expect(fd).toBeUndefined();
          expect(await stagingKeys()).toEqual([]);
        }
      });

      test("a script that failed after its frames were staged leaves no staging key, and its error is thrown", async () => {
        for (const which of ["setMany", "setManyFenced"] as const) {
          reset();
          faults.failScript = true;
          const batch = [big("ga", 30_000, 2), big("gb", 40_000, 3)];
          const failure = await (
            which === "setMany"
              ? driver.setMany(ns, batch)
              : driver.setManyFenced(
                  ns,
                  batch.map((entry) => ({ entry })),
                )
          )
            .then(() => undefined)
            .catch((error: unknown) => error as Error);
          expect(failure?.message).toBe("script failed (injected)");
          expect(staged).toHaveLength(2);
          expect(await stagingKeys()).toEqual([]);
          expect(await driver.getMany(ns, ["ga", "gb"])).toEqual([
            undefined,
            undefined,
          ]);
        }
      });
    });
  }

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
        keyLocking: lane.keyLocking,
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
        keyLocking: lane.keyLocking,
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
        keyLocking: lane.keyLocking,
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

    test(
      "the bus is redisBus's: a separate redisBus on the same prefix hears the driver, and the driver hears it",
      async () => {
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
      },
      WAITING_TEST_TIMEOUT_MS,
    );

    test(
      "a cache over the driver: getOrSet, tags, counters, and an L1 kept coherent by the driver's bus",
      async () => {
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
        expect(await one.getOrSet("k", load, { tags: ["g"] })).toEqual({
          n: 1,
        });
        expect(await two.getOrSet("k", load, { tags: ["g"] })).toEqual({
          n: 1,
        });
        // Two's L1 fills once its bus subscription is up (until then a read
        // goes to the driver and is not copied): read until it holds k.
        for (let tries = 0; (two.stats().l1?.entries ?? 0) === 0; tries++) {
          expect(tries).toBeLessThan(200);
          expect(await two.get("k")).toEqual({ n: 1 });
          await Bun.sleep(10);
        }
        // The reload right after the invalidation is stored (§3.6).
        await one.invalidateTags(["g"]);
        expect(await one.getOrSet("k", load, { tags: ["g"] })).toEqual({
          n: 2,
        });
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
      },
      WAITING_TEST_TIMEOUT_MS,
    );

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

    test.skipIf(lane.keyLocking)(
      "every script keeps to its KEYS' hash tag (Upstash's allow-key-locking rule, enforced on this server)",
      async () => {
        // Each script reaches EVAL (EVALSHA answers NOSCRIPT) made to fail on
        // a key outside the hash tags of its KEYS, as Upstash refuses one
        // under the flag. Every script and branch runs below.
        const client = new RedisClient(url);
        const sources = new Set<string>();
        const enforced = new RedisCacheDriver({
          prefix: prefix("keylock-rule"),
          client: proxied(client, {
            evalsha: async () => {
              throw new Error("NOSCRIPT No matching script. Please use EVAL.");
            },
            eval: async (
              source: string,
              numkeys: number,
              ...rest: string[]
            ) => {
              sources.add(source);
              return await client.eval(
                enforceKeyLockingRule(source),
                numkeys,
                ...rest,
              );
            },
          }),
        });
        try {
          // The rule bites: the same wrapping refuses a key of another tag
          // and lets one of KEYS' tag through.
          const ruled = enforceKeyLockingRule(
            "return redis.call('EXISTS', ARGV[1])",
          );
          await expect(
            client.eval(
              ruled,
              1,
              `${enforced.prefix}:{a}:x`,
              `${enforced.prefix}:{b}:x`,
            ),
          ).rejects.toThrow(/KEYLOCK/);
          expect(
            await client.eval(
              ruled,
              1,
              `${enforced.prefix}:{a}:x`,
              `${enforced.prefix}:{a}:y`,
            ),
          ).toBe(0);

          const space = `${ns}-keylock`;
          const now = Date.now();
          // set: new, tagged, fenced against an older stamp; replacing an
          // entry with old tags; replacing a counter.
          await enforced.setStamps(space, ["f"], now - 10, now + 60_000);
          expect(
            await enforced.set(space, entry("a", [1], ["red", "f"]), {
              tags: ["f"],
              createdAt: now,
            }),
          ).toBe("stored");
          expect(await enforced.set(space, entry("a", [2], ["blue"]))).toBe(
            "stored",
          );
          await enforced.increment(space, "c", 1, null);
          await enforced.set(space, entry("c", [3], ["red"]));
          // A staged (large) write, stored and fenced.
          const large = Array.from({ length: STAGE_FRAME_BYTES }, () => 7);
          expect(
            await enforced.set(space, entry("big", large, ["red", "f"])),
          ).toBe("stored");
          expect(
            await enforced.set(space, entry("big", large, ["f"]), {
              tags: ["f"],
              createdAt: now - 20,
            }),
          ).toBe("fenced");
          // setMany and setManyFenced, a staged and an inline frame each;
          // fenced and stored.
          await enforced.setMany(space, [
            entry("m1", large, ["red"]),
            entry("m2", [8], ["grey"]),
          ]);
          expect(
            await enforced.setManyFenced(space, [
              {
                entry: entry("m1", large, ["f"]),
                fence: { tags: ["f"], createdAt: now - 20 },
              },
              {
                entry: entry("m3", large, ["f"]),
                fence: { tags: ["f"], createdAt: now },
              },
              { entry: entry("m4", [9]) },
            ]),
          ).toEqual(["fenced", "stored", "stored"]);
          // increment: new, existing, over an entry.
          await enforced.increment(space, "n", 2, now + 60_000);
          expect(await enforced.increment(space, "n", 3, now + 60_000)).toBe(5);
          expect(await enforced.increment(space, "c", 4, null)).toBe(4);
          // touch: an entry, a counter, nothing.
          expect(await enforced.touch(space, "a", now + 30_000)).toBe(true);
          expect(await enforced.touch(space, "n", null)).toBe(true);
          expect(await enforced.touch(space, "none", null)).toBe(false);
          // deleteByTags over members carrying other tags; delete of an
          // entry, a counter and an absent key.
          await enforced.set(space, entry("b", [4], ["red", "green"]));
          await enforced.set(space, entry("d", [5], ["green"]));
          expect(
            await enforced.deleteByTags(space, ["blue", "green"], now + 60_000),
          ).toBe(3);
          await enforced.set(space, entry("e", [6], ["red"]));
          expect(await enforced.delete(space, ["e", "n", "absent"])).toBe(2);
          // locks: taken, re-taken, released.
          expect(await enforced.acquireLock(space, "l", "me", 60_000)).toBe(
            true,
          );
          expect(await enforced.acquireLock(space, "l", "me", 60_000)).toBe(
            true,
          );
          expect(await enforced.releaseLock(space, "l", "me")).toBe(true);
          // sweep: a tag set of a gone entry, and a lapsed stamp.
          await enforced.set(space, entry("gone", [7], ["purple"]));
          await helper.unlink(keyOf(enforced, space, "e", "gone"));
          await enforced.setStamps(space, ["old"], now - 120_000, now - 60_000);
          expect(
            await enforced.sweep(Date.now(), 1_000),
          ).toBeGreaterThanOrEqual(2);
          // All eleven scripts ran under the rule.
          expect(sources.size).toBe(11);
        } finally {
          await enforced.close();
          client.close();
        }
      },
    );

    test.skipIf(lane.acceptsKeyLocking)(
      "keyLocking on a server that refuses the flag: the first script fails naming the option; reads still answer",
      async () => {
        const refused = make("keylock-refused", { keyLocking: true });
        const failure = await refused
          .set(ns, entry("k", [1], ["t"]))
          .then(() => undefined)
          .catch((error: unknown) => error as Error);
        expect(failure?.message).toMatch(
          /^redisDriver: keyLocking is set, and .* refused Upstash's allow-key-locking script flag \(.*Unexpected flag in script shebang: allow-key-locking.*\)\. The flag is Upstash's: plain Redis rejects it\. Remove keyLocking for this server\.$/,
        );
        expect(await refused.get(ns, "k")).toBeUndefined();
        expect(await refused.getCounter(ns, "c")).toBeUndefined();
        // Nothing was written.
        expect(await helper.exists(keyOf(refused, ns, "e", "k"))).toBe(false);
      },
    );

    test.skipIf(!lane.keyLocking)(
      "keyLocking: every script the driver sends carries the flag (and allow-oom where it only removes) and runs, and the server honours it (a key-locked script reaching another hash tag is refused)",
      async () => {
        const client = new RedisClient(url);
        const sources: string[] = [];
        const locked = new RedisCacheDriver({
          prefix: prefix("keylock-on"),
          keyLocking: true,
          client: proxied(client, {
            evalsha: async () => {
              throw new Error("NOSCRIPT No matching script. Please use EVAL.");
            },
            eval: async (
              source: string,
              numkeys: number,
              ...rest: string[]
            ) => {
              sources.push(source);
              return await client.eval(source, numkeys, ...rest);
            },
          }),
        });
        try {
          const space = `${ns}-keylock-on`;
          expect(await locked.set(space, entry("k", [1], ["t"]))).toBe(
            "stored",
          );
          expect(await locked.increment(space, "c", 2, null)).toBe(2);
          expect(
            await locked.deleteByTags(space, ["t"], Date.now() + 60_000),
          ).toBe(1);
          // A script that only removes runs with allow-oom as well.
          expect(await locked.delete(space, ["c"])).toBe(1);
          expect(
            sources.map((source) => source.slice(0, source.indexOf("\n"))),
          ).toEqual([
            "#!lua flags=allow-key-locking",
            "#!lua flags=allow-key-locking",
            "#!lua flags=allow-key-locking",
            "#!lua flags=allow-key-locking,allow-oom",
          ]);
          // Upstash honours the flag rather than ignoring it: a key outside
          // the locked hash tags is refused.
          await expect(
            client.eval(
              "#!lua flags=allow-key-locking\nreturn redis.call('EXISTS', ARGV[1])",
              1,
              `${locked.prefix}:{a}:x`,
              `${locked.prefix}:{b}:x`,
            ),
          ).rejects.toThrow(/Dynamic keys are not allowed/);
        } finally {
          await locked.close();
          client.close();
        }
      },
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
        keyLocking: lane.keyLocking,
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
