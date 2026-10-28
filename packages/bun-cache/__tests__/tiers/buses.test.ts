/**
 * The separable buses (plan §4.2): `redisBus` and `pgBus` against real
 * servers, under one contract — delivery to every subscriber, unsubscribe,
 * foreign payloads ignored, a reconnect reported as a gap with delivery
 * resuming, close — plus each one carrying a real L1's invalidations between
 * two caches on a shared SQLite file (the bus replacing the driver's own).
 *
 * Servers: `BUN_CACHE_TEST_REDIS_URL` / `BUN_CACHE_TEST_POSTGRES_URL`,
 * falling back to the `BUN_JOBS_TEST_*` ones. Unset skips visibly; set but
 * unreachable fails, naming the variable. Test data: channels carrying this
 * run's pid and a timestamp (pub/sub stores nothing).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { RedisClient, SQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import type { BusMessage, Cache, CacheBus } from "../../lib/index";
import {
  createCache,
  pgBus,
  postgresDriver,
  redisBus,
  sqliteDriver,
} from "../../lib/index";
import type { PostgresCacheDriver } from "../../lib/drivers/postgres";
import {
  reachError,
  redisBackend,
  redisReachError,
  sqlBackends,
} from "../drivers/backends";
import { reportNotConfigured, reportUnreachable } from "../drivers/sqlSuite";
import { waitFor } from "./helpers";

/** A unique suffix for this run's channels. */
const run = `${process.pid}_${Date.now().toString(36)}`;

/** What one bus implementation gives the shared contract. */
interface BusUnderTest {
  /** A new bus on a fresh channel (or on `channel`, to share one). */
  make: (channel?: string) => CacheBus & {
    /** The channel. */
    readonly channel: string;
  };
  /** Sends a payload that is not a bus message onto `channel`, from outside. */
  sendForeign: (channel: string, payload: string) => Promise<void>;
  /** Drops `bus`'s subscriber connection server-side, so it reconnects. */
  dropSubscriber: (bus: CacheBus) => Promise<void>;
  /** Closes the helper clients. */
  close: () => Promise<void>;
}

/** A message for the contract cases. */
function message(n: number, extra: Partial<BusMessage> = {}): BusMessage {
  return {
    type: "delete",
    namespace: `ns-${run}`,
    keys: [`k${n}`],
    at: Date.now(),
    origin: "contract",
    ...extra,
  };
}

/** Registers the contract for one bus. */
function busContract(name: string, under: () => BusUnderTest): void {
  describe(`${name} bus: the contract`, () => {
    const opened: CacheBus[] = [];
    let it: BusUnderTest;
    const make = (channel?: string) => {
      it ??= under();
      const bus = it.make(channel);
      opened.push(bus);
      return bus;
    };
    afterAll(async () => {
      for (const bus of opened) {
        await bus.close();
      }
      await it?.close();
    });

    test("a message reaches every subscriber, exactly as published, in order", async () => {
      const publisher = make();
      const listener = make(publisher.channel);
      const first: BusMessage[] = [];
      const second: BusMessage[] = [];
      await publisher.subscribe(
        (each) => first.push(each),
        () => {},
      );
      await listener.subscribe(
        (each) => second.push(each),
        () => {},
      );
      const sent = [
        message(1),
        message(2, { type: "set" }),
        message(3, { type: "invalidate-tags", keys: undefined, tags: ["t"] }),
        message(4, { type: "clear", keys: undefined }),
      ];
      for (const each of sent) {
        await publisher.publish(each);
      }
      await waitFor(
        "every delivery",
        () => first.length === 4 && second.length === 4,
      );
      expect(first).toEqual(sent);
      expect(second).toEqual(sent);
    });

    test("an unsubscribed listener hears nothing more; the others do", async () => {
      const bus = make();
      const kept: BusMessage[] = [];
      const dropped: BusMessage[] = [];
      await bus.subscribe(
        (each) => kept.push(each),
        () => {},
      );
      const unsubscribe = await bus.subscribe(
        (each) => dropped.push(each),
        () => {},
      );
      await bus.publish(message(1));
      await waitFor("the first delivery", () => dropped.length === 1);
      await unsubscribe();
      await bus.publish(message(2));
      await waitFor("the second delivery", () => kept.length === 2);
      await Bun.sleep(50);
      expect(dropped.length).toBe(1);
    });

    test("a payload that is not JSON is ignored", async () => {
      const bus = make();
      const received: BusMessage[] = [];
      await bus.subscribe(
        (each) => received.push(each),
        () => {},
      );
      await it.sendForeign(bus.channel, "not json {");
      await bus.publish(message(1));
      await waitFor("the real message", () => received.length === 1);
      expect(received).toEqual([message(1, { at: received[0].at })]);
    });

    test("a dropped connection is a gap, and delivery resumes after it", async () => {
      const bus = make();
      const received: BusMessage[] = [];
      let gaps = 0;
      await bus.subscribe(
        (each) => received.push(each),
        () => {
          gaps++;
        },
      );
      await it.dropSubscriber(bus);
      await waitFor("the gap", () => gaps === 1, 10_000);
      // Delivery resumes once the channel is back; publish until it lands.
      await waitFor(
        "delivery after the reconnect",
        async () => {
          await bus.publish(message(9));
          await Bun.sleep(20);
          return received.length > 0;
        },
        10_000,
      );
    });

    test("close() is idempotent; a closed bus refuses to publish or subscribe", async () => {
      const bus = make();
      await bus.subscribe(
        () => {},
        () => {},
      );
      await bus.close();
      await bus.close();
      await expect(bus.publish(message(1))).rejects.toThrow(/closed/);
      await expect(
        bus.subscribe(
          () => {},
          () => {},
        ),
      ).rejects.toThrow(/closed/);
    });

    test("it keeps two caches' L1s coherent over a shared SQLite file (replacing the driver's polled bus)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "bun-cache-bus-"));
      const path = join(dir, "cache.db");
      const channel = make().channel;
      const caches: Cache[] = [];
      try {
        for (let index = 0; index < 2; index++) {
          caches.push(
            createCache({
              driver: sqliteDriver({ path, busPollInterval: 60_000 }),
              l1: true,
              bus: it.make(channel),
              sweepInterval: 0,
            }),
          );
        }
        const [a, b] = caches;
        for (const cache of caches) {
          await waitFor(
            "the subscription",
            () => cache.stats().l1!.flushes >= 1,
          );
        }
        await a.set("k", "v1");
        expect(await b.get("k")).toBe("v1");
        expect(await b.get("k")).toBe("v1");
        expect(b.stats().l1!.hits).toBe(1);
        const started = performance.now();
        await a.set("k", "v2");
        // The SQLite bus polls once a minute here: only this bus can tell B.
        await waitFor("B to drop its copy", async () => {
          return (await b.get("k")) === "v2";
        });
        const window = performance.now() - started;
        expect(window).toBeLessThan(1_000);
        await a.invalidateTags(["none"]);
        await a.delete("k");
        await waitFor(
          "the delete",
          async () => (await b.get("k")) === undefined,
        );
      } finally {
        for (const cache of caches) {
          await cache.close();
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Redis                                                              */
/* ------------------------------------------------------------------ */

const redis = redisBackend();
if (redis.url === undefined) {
  reportNotConfigured("redis", redis.variable);
} else {
  const unreachable = await redisReachError(redis.url);
  if (unreachable !== undefined) {
    reportUnreachable("redis", redis.variable, unreachable);
  } else {
    const url = redis.url;
    let next = 0;
    busContract("redis", () => {
      const helper = new RedisClient(url);
      return {
        make: (channel) => {
          const bus = redisBus({
            url,
            ...(channel === undefined
              ? { prefix: `bun-cache-test:${run}:${next++}` }
              : { channel }),
          }) as CacheBus & { channel: string };
          return bus;
        },
        sendForeign: async (channel, payload) => {
          await helper.publish(channel, payload);
        },
        dropSubscriber: async (bus) => {
          // Only this bus's own connection, found by its CLIENT SETNAME.
          const name = (bus as unknown as { connectionName: string })
            .connectionName;
          const list = (await helper.send("CLIENT", [
            "LIST",
            "TYPE",
            "pubsub",
          ])) as string;
          const line = list
            .split("\n")
            .find((each) => each.includes(` name=${name} `));
          const id = /\bid=(\d+)/.exec(line ?? "")?.[1];
          if (id === undefined) {
            throw new Error(`no pub/sub connection named ${name}`);
          }
          await helper.send("CLIENT", ["KILL", "ID", id]);
        },
        close: () => {
          helper.close();
          return Promise.resolve();
        },
      };
    });

    describe("redis bus: specifics", () => {
      test("the channel is <prefix>:bus, or `channel` as given; a url or a client is required", async () => {
        const named = redisBus({ url, prefix: "app" }) as CacheBus & {
          channel: string;
        };
        expect(named.channel).toBe("app:bus");
        const exact = redisBus({ url, channel: "x" }) as CacheBus & {
          channel: string;
        };
        expect(exact.channel).toBe("x");
        expect((redisBus(url) as CacheBus & { channel: string }).channel).toBe(
          "bun-cache:bus",
        );
        expect(() => redisBus({})).toThrow(TypeError);
        await named.close();
        await exact.close();
      });

      test("a given client is published on and never closed; the subscriber is a duplicate of it", async () => {
        const client = new RedisClient(url);
        await client.connect();
        const bus = redisBus({ client, prefix: `bun-cache-test:${run}:given` });
        const received: BusMessage[] = [];
        await bus.subscribe(
          (each) => received.push(each),
          () => {},
        );
        await bus.publish(message(1));
        await waitFor("the delivery", () => received.length === 1);
        await bus.close();
        expect(client.connected).toBe(true);
        expect(await client.send("PING", [])).toBe("PONG");
        client.close();
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Postgres                                                           */
/* ------------------------------------------------------------------ */

const postgres = sqlBackends().find((backend) => backend.name === "postgres")!;
if (postgres.url === undefined) {
  reportNotConfigured("postgres", postgres.variable);
} else {
  const unreachable = await reachError(postgres);
  if (unreachable !== undefined) {
    reportUnreachable("postgres", postgres.variable, unreachable);
  } else {
    const url = postgres.url;
    let next = 0;
    busContract("postgres", () => {
      const helper = new SQL(url);
      return {
        make: (channel) =>
          pgBus({
            url,
            channel: channel ?? `bun_cache_test_${run}_${next++}`,
          }) as CacheBus & { channel: string },
        sendForeign: async (channel, payload) => {
          await helper.notify(channel, payload);
        },
        dropSubscriber: async (bus) => {
          // Only the backend LISTENing on this bus's own channel.
          const channel = (bus as CacheBus & { channel: string }).channel;
          const rows = await helper.unsafe<{ pid: number }[]>(
            "SELECT pid FROM pg_stat_activity WHERE query = $1",
            [`LISTEN "${channel}"`],
          );
          if (rows.length === 0) {
            throw new Error(`no backend LISTENing on ${channel}`);
          }
          for (const row of rows) {
            await helper.unsafe("SELECT pg_terminate_backend($1)", [row.pid]);
          }
        },
        close: async () => {
          await helper.close();
        },
      };
    });

    describe("postgres bus: specifics", () => {
      test("its default channel is the postgres driver's, on the same prefix or tables, and the two interoperate", async () => {
        const prefix = `bun_cache_test_${process.pid}_pgbus_`;
        const driver = postgresDriver({ url, prefix }) as PostgresCacheDriver;
        const bus = pgBus({ url, prefix }) as CacheBus & { channel: string };
        try {
          expect(bus.channel).toBe(driver.channel);
          expect(
            (
              pgBus({ url, tables: { entries: "x_entries" } }) as CacheBus & {
                channel: string;
              }
            ).channel,
          ).toBe(
            (
              postgresDriver({
                url,
                tables: { entries: "x_entries" },
              }) as PostgresCacheDriver
            ).channel,
          );
          const received: BusMessage[] = [];
          await bus.subscribe(
            (each) => received.push(each),
            () => {},
          );
          // The driver's own publish (no tables are touched by NOTIFY).
          await driver.publish(message(1));
          await waitFor("the driver's message", () => received.length === 1);
          expect(received[0]).toEqual(message(1, { at: received[0].at }));
        } finally {
          await bus.close();
          await driver.close();
        }
      });

      test("a message past the payload cap goes out as a clear of its namespace, keeping its origin", async () => {
        const bus = pgBus({ url, channel: `bun_cache_test_${run}_big` });
        try {
          const received: BusMessage[] = [];
          await bus.subscribe(
            (each) => received.push(each),
            () => {},
          );
          const keys = Array.from({ length: 2_000 }, (_, n) => `key-${n}`);
          await bus.publish(message(1, { type: "set", keys, origin: "me" }));
          await waitFor("the flush", () => received.length === 1);
          expect(received[0]).toMatchObject({
            type: "clear",
            namespace: `ns-${run}`,
            origin: "me",
          });
          expect(received[0].keys).toBeUndefined();
        } finally {
          await bus.close();
        }
      });

      test("a channel that is not an identifier, or a bad prefix, throws", () => {
        expect(() => pgBus({ url, channel: "no spaces" })).toThrow(TypeError);
        expect(() => pgBus({ url, prefix: "1bad" })).toThrow(TypeError);
        expect(() => pgBus({})).toThrow(TypeError);
      });

      test("a given client is never closed", async () => {
        const sql = new SQL(url);
        const bus = pgBus({ sql, channel: `bun_cache_test_${run}_given` });
        await bus.subscribe(
          () => {},
          () => {},
        );
        await bus.close();
        expect((await sql`SELECT 1 AS one`)[0].one).toBe(1);
        await sql.close();
      });
    });
  }
}
