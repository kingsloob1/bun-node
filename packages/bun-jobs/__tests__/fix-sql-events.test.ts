import type { SqlAdapter } from "../lib/index";
import type { DriverEvent } from "../lib/shared/events";
import { join } from "node:path";
import process from "node:process";
import { SQL } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { SqlDriver } from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * One event poll per namespace per driver, however many channels it follows.
 *
 * Each `subscribe` used to run its own `setInterval` query, so a process
 * following thirty channels sent thirty queries every poll interval with
 * nothing happening. Now a namespace's subscriptions share one poll that asks
 * for all their channels and dispatches rows by channel.
 */

/** Every engine available here: SQLite always, the servers when configured. */
const ENGINES: { adapter: SqlAdapter; url?: string }[] = [
  { adapter: "sqlite" },
  ...(
    [
      ["postgres", process.env.BUN_JOBS_TEST_POSTGRES_URL],
      ["mysql", process.env.BUN_JOBS_TEST_MYSQL_URL],
      ["mariadb", process.env.BUN_JOBS_TEST_MARIADB_URL],
    ] as const
  )
    .filter(([, url]) => url)
    .map(([adapter, url]) => ({ adapter, url })),
];

/** Temporary directories to remove when the suite ends. */
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A client for `engine`, and the driver options that share its tables. */
async function open(engine: { adapter: SqlAdapter; url?: string }): Promise<{
  client: SQL;
  url: string;
  tablePrefix?: string;
}> {
  if (engine.url) {
    return {
      client: new SQL({
        url: engine.url.replace(/[?&]allowPublicKeyRetrieval=true/, ""),
        adapter: engine.adapter,
        allowPublicKeyRetrieval: true,
      } as ConstructorParameters<typeof SQL>[0]),
      url: engine.url,
      tablePrefix: "bun_jobs_test_",
    };
  }
  const tmp = await makeTmpDir("bun-jobs-fix-sql-events");
  cleanups.push(tmp.cleanup);
  const url = `sqlite://${join(tmp.path, "jobs.db")}`;
  return { client: new SQL(url), url };
}

/** A queue event on `target`, carrying `n` so order can be checked. */
function event(ns: string, target: string, n: number): DriverEvent {
  return {
    ns,
    kind: "queue",
    target,
    type: "waiting",
    at: Date.now(),
    origin: "test",
    id: `j${n}`,
    payload: { id: `j${n}`, n },
  } as unknown as DriverEvent;
}

for (const engine of ENGINES) {
  describe(`SQL driver: ${engine.adapter} shared event feed`, () => {
    it("polls once per interval for many channels, and dispatches each to its own", async () => {
      const { client, url, tablePrefix } = await open(engine);
      /** Event-table reads the subscriber's driver sent. */
      let polls = 0;
      const counted = new Proxy(client, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver) as unknown;
          if (key === "unsafe") {
            return (text: string, params?: unknown[]) => {
              if (/SELECT seq, (?:channel, )?payload FROM/.test(text)) polls++;
              return target.unsafe(text, params as never);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const subscriber = new SqlDriver({
        sql: counted,
        adapter: engine.adapter,
        tablePrefix,
        pollInterval: 50,
      });
      const publisher = new SqlDriver({
        url,
        adapter: engine.adapter,
        tablePrefix,
      });
      const ns = testNamespace("fixsql-feed");
      /** What each channel's listeners received, in order. */
      const got = new Map<string, number[]>();
      const record = (key: string) => (received: DriverEvent) => {
        got.set(key, [
          ...(got.get(key) ?? []),
          // The payload is the test's own (`event`), built through `unknown`.
          (received.payload as unknown as { n: number }).n,
        ]);
      };

      try {
        await subscriber.connect();
        await publisher.connect();

        // Published before anyone follows: owed to nobody.
        await publisher.publish(event(ns, "q0", -1));

        const stops: (() => Promise<void>)[] = [];
        for (let index = 0; index < 10; index++) {
          stops.push(
            await subscriber.subscribe(
              ns,
              "queue",
              `q${index}`,
              record(`q${index}`),
            ),
          );
        }
        // A second listener on one channel gets the same events.
        stops.push(
          await subscriber.subscribe(ns, "queue", "q3", record("q3b")),
        );

        // Idle: one read per interval, not one per subscription.
        await Bun.sleep(200);
        polls = 0;
        await Bun.sleep(1000);
        expect(polls).toBeLessThanOrEqual(25);
        expect(polls).toBeGreaterThan(0);

        for (let n = 0; n < 30; n++) {
          await publisher.publish(event(ns, `q${n % 10}`, n));
        }
        await waitFor(
          () =>
            [...got.values()].reduce((sum, list) => sum + list.length, 0) ===
            33,
          { timeout: 10_000 },
        );

        for (let index = 0; index < 10; index++) {
          expect(got.get(`q${index}`)).toEqual([index, index + 10, index + 20]);
        }
        expect(got.get("q3b")).toEqual([3, 13, 23]);

        // A subscriber joining a running feed starts from the present too.
        await publisher.publish(event(ns, "q11", 100));
        await Bun.sleep(150);
        stops.push(
          await subscriber.subscribe(ns, "queue", "q11", record("q11")),
        );
        await publisher.publish(event(ns, "q11", 101));
        await waitFor(() => (got.get("q11")?.length ?? 0) > 0, {
          timeout: 5_000,
        });
        await Bun.sleep(150);
        expect(got.get("q11")).toEqual([101]);

        // The last listener of a channel going stops its dispatch; the
        // others carry on.
        await stops[0]!();
        await publisher.publish(event(ns, "q0", 200));
        await publisher.publish(event(ns, "q1", 201));
        await waitFor(() => got.get("q1")?.at(-1) === 201, { timeout: 5_000 });
        await Bun.sleep(150);
        expect(got.get("q0")).toEqual([0, 10, 20]);

        // Every listener gone: the poll stops.
        for (const stop of stops.slice(1)) await stop();
        await Bun.sleep(100);
        polls = 0;
        await Bun.sleep(400);
        expect(polls).toBe(0);
      } finally {
        await publisher.purge(ns).catch(() => {});
        await subscriber.close();
        await publisher.close();
        await client.close();
      }
    }, 60_000);

    it("stops the poll when the driver closes", async () => {
      const { client, tablePrefix } = await open(engine);
      let polls = 0;
      const counted = new Proxy(client, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver) as unknown;
          if (key === "unsafe") {
            return (text: string, params?: unknown[]) => {
              if (/SELECT seq, (?:channel, )?payload FROM/.test(text)) polls++;
              return target.unsafe(text, params as never);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const driver = new SqlDriver({
        sql: counted,
        adapter: engine.adapter,
        tablePrefix,
        pollInterval: 20,
      });
      const ns = testNamespace("fixsql-feed-close");

      try {
        await driver.subscribe(ns, "queue", "a", () => {});
        await driver.subscribe(ns, "queue", "b", () => {});
        await waitFor(() => polls > 0, { timeout: 5_000 });
        await driver.close();
        polls = 0;
        await Bun.sleep(200);
        expect(polls).toBe(0);
      } finally {
        await client.close();
      }
    }, 30_000);
  });
}
