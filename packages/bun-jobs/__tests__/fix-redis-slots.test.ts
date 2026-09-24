import type { QueueRef } from "../lib/index";
import process from "node:process";
import { RedisClient as BunRedis } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import { resolveMetricsOptions } from "../lib/drivers/metrics";
import * as scripts from "../lib/drivers/redis/scripts";
import { RedisDriver, RedisKeys } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";

/**
 * B4 of the 2026-09-22 deep check: in `cluster: true` every queue script
 * declared the namespace's untagged `queues` set beside the queue's
 * `{queue}`-tagged keys, which Redis Cluster rejects with `CROSSSLOT`.
 *
 * There is no cluster to test against, so this computes what a cluster
 * would: the hash slot of every key each script call and each multi-key
 * blocking pop declares, the way Redis does (CRC16/XMODEM of the hash tag, or
 * of the whole key, mod 16384). A standalone server does not enforce slots,
 * which is how the bug survived the `cluster: true` tests.
 */

const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

/** CRC16/XMODEM, the checksum Redis Cluster slots keys by. */
function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** The cluster hash slot of a key, hash tags included. */
function hashSlot(key: string): number {
  const open = key.indexOf("{");
  if (open !== -1) {
    const close = key.indexOf("}", open + 1);
    if (close > open + 1) {
      key = key.slice(open + 1, close);
    }
  }
  return crc16(new TextEncoder().encode(key)) % 16384;
}

/** Whether every key lands in one slot. */
function oneSlot(keys: readonly string[]): boolean {
  return new Set(keys.map(hashSlot)).size <= 1;
}

describe("hashSlot (the checker itself)", () => {
  it("matches Redis's documented slots", () => {
    // From the Redis Cluster specification's examples and CLUSTER KEYSLOT.
    expect(hashSlot("123456789")).toBe(12739);
    expect(hashSlot("foo")).toBe(12182);
    expect(hashSlot("{user1000}.following")).toBe(
      hashSlot("{user1000}.followers"),
    );
    expect(hashSlot("foo{}{bar}")).toBe(hashSlot("foo{}{bar}"));
    expect(hashSlot("foo{bar}{zap}")).toBe(hashSlot("bar"));
  });

  it("negative control: the old key list is rejected", () => {
    const keys = new RedisKeys({ prefix: "bun-jobs", cluster: true });
    const q = { ns: "account", queue: "mail" };
    const tagged = keys.queue(q);

    // The list queue scripts were handed before the fix.
    const before = [
      tagged.wait,
      tagged.delayed,
      tagged.failed,
      tagged.active,
      tagged.completed,
      tagged.dead,
      tagged.meta,
      tagged.seq,
      tagged.wake,
      keys.queues(q.ns),
      tagged.children,
    ];
    expect(oneSlot(before)).toBe(false);

    // And the list they are handed now.
    expect(oneSlot(keys.queueScriptKeys(q))).toBe(true);
    expect(keys.queueScriptKeys(q)).not.toContain(keys.queues(q.ns));
  });
});

/** Cleanups to run after each test, newest first. */
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** One script call or multi-key pop the driver made. */
interface Recorded {
  /** `script` for EVAL/EVALSHA, `blpop` for a blocking pop. */
  kind: "script" | "blpop";
  /** The script's source (resolved from its SHA), or `BLPOP`. */
  source: string;
  /** The keys it declared. */
  keys: string[];
}

/**
 * A real client behind a proxy recording every script's declared keys and
 * every blocking pop's keys, including on the connections it duplicates.
 */
function recordingClient(record: Recorded[]): BunRedis {
  const shas = new Map<string, string>();

  const wrap = (real: BunRedis): BunRedis =>
    new Proxy(real, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        const call = (...args: unknown[]): unknown =>
          (value as (...a: unknown[]) => unknown).apply(target, args);

        if (property === "eval" || property === "evalsha") {
          return (...args: unknown[]) => {
            const [head, count, ...rest] = args as [
              string,
              number,
              ...string[],
            ];
            record.push({
              kind: "script",
              source: property === "eval" ? head : (shas.get(head) ?? head),
              keys: rest.slice(0, Number(count)),
            });
            return call(...args);
          };
        }
        if (property === "script") {
          return async (...args: unknown[]) => {
            const sha = (await call(...args)) as unknown;
            if (args[0] === "LOAD" && typeof sha === "string") {
              shas.set(sha, String(args[1]));
            }
            return sha;
          };
        }
        if (property === "blpop") {
          return (...args: unknown[]) => {
            record.push({
              kind: "blpop",
              source: "BLPOP",
              keys: (args.slice(0, -1) as string[]).map(String),
            });
            return call(...args);
          };
        }
        if (property === "send") {
          return (command: string, args: string[]) => {
            if (command.toUpperCase() === "BLPOP") {
              record.push({
                kind: "blpop",
                source: "BLPOP",
                keys: args.slice(0, -1),
              });
            }
            return call(command, args);
          };
        }
        if (property === "duplicate") {
          return async () => wrap((await call()) as BunRedis);
        }
        return call;
      },
    });

  const real = new BunRedis(URL!);
  cleanups.push(async () => real.close());
  return wrap(real);
}

/** Every queue script's source this driver can run. */
function queueScripts(): Map<string, string> {
  // Rendered as a driver with default metrics options renders them.
  const metrics = resolveMetricsOptions(undefined);
  const rendered = scripts.renderScripts({
    secondRetentionMs: metrics.secondRetentionMs,
    minuteRetentionMs: metrics.minuteRetentionMs,
  });
  const all = new Map<string, string>();
  for (const [name, value] of [
    ...Object.entries(scripts),
    ...Object.entries(rendered),
  ]) {
    if (typeof value === "string" && value.includes("local WAIT, DELAYED")) {
      all.set(value, name);
    }
  }
  return all;
}

describe.skipIf(!URL)(
  "cluster: every script's keys share one slot (B4)",
  () => {
    it("runs every queue script with single-slot keys, and wakes on one slot", async () => {
      const record: Recorded[] = [];
      const driver = new RedisDriver({
        url: URL,
        cluster: true,
        client: recordingClient(record),
        maxBlockSeconds: 1,
      });
      const ns = testNamespace("slots");
      cleanups.push(async () => {
        await driver.purge(ns);
        await driver.close();
      });

      const q: QueueRef = { ns, queue: "mail" };
      const other: QueueRef = { ns, queue: "sms" };
      const now = Date.now();
      const lock = { workerId: "w", lockMs: 60_000, now };

      // Adds, claims and every settle.
      await driver.addJob(q, makeJob({ id: "a", runAt: now }));
      await driver.addJobs(q, [
        makeJob({ id: "b", runAt: now }),
        makeJob({ id: "c", runAt: now }),
        makeJob({ id: "d", runAt: now }),
        makeJob({ id: "e", runAt: now }),
        makeJob({ id: "late", state: "delayed", runAt: now - 1 }),
      ]);
      const a = await driver.claimJob(q, { ...lock, token: "ta" });
      expect(a?.id).toBe("a");
      await driver.claimJob(q, { ...lock, token: "tx", excludeNames: ["zz"] });
      const many = await driver.claimJobs(q, { ...lock, token: "tm" }, 2);
      expect(many).toHaveLength(2);
      await driver.extendJobLock(q, "a", "ta", 60_000, now);
      await driver.updateProgress(q, "a", 50);
      await driver.completeJob(q, "a", "ta", { ok: true }, true, now);
      await driver.completeJobs(
        q,
        "nobody",
        [{ id: "zz", result: 1, retention: true }],
        now,
      );
      await driver.failJob(
        q,
        many[0]!.id,
        "tm",
        { name: "Error", message: "x" },
        { retry: false, retention: false },
        now,
        5,
      );
      await driver.buryJob(
        q,
        many[1]!.id,
        { name: "Error", message: "y" },
        { retention: false, keepStacktraces: 5, token: "tm" },
        now,
      );

      // Maintenance.
      await driver.promoteDelayed(q, now, 100);
      await driver.recoverStalled(q, now + 120_000, 1, 100);
      await driver.retryJob(q, many[0]!.id, true, now);
      await driver.addJob(
        q,
        makeJob({ id: "later", state: "delayed", runAt: now + 60_000 }),
      );
      await driver.promoteJob(q, "later", now);
      await driver.updateJob(q, "later", { data: { v: 2 } }, now);
      await driver.rewritePendingOptions(q, {
        states: ["waiting"],
        values: { attempts: 4 },
        cursor: null,
        limit: 10,
        includeUnmarked: true,
        dryRun: true,
        now,
      });
      await driver.removeJob(q, "later");
      await driver.cleanJobs(q, "dead", 0, 10, now + 1);
      await driver.cleanJobs(q, "waiting", 0, 10, now + 1);
      await driver.pruneExpired(q, now, 100);

      // Reads.
      await driver.listJobs(q, ["waiting", "dead"], {
        offset: 0,
        limit: 10,
        order: "asc",
      });
      await driver.countJobs(q);
      await driver.findJobs(q, {
        states: ["waiting", "completed"],
        offset: 0,
        limit: 10,
        order: "asc",
        names: ["test"],
      });
      // A keyset cursor page, which resolves its seek in a script of its own.
      await driver.findJobs(q, {
        states: ["waiting", "completed"],
        offset: 0,
        limit: 10,
        order: "asc",
        after: {
          values: [now],
          id: "later",
          state: "waiting",
          stateValues: [0, now],
        },
      });
      await driver.getThroughput(q, { from: now - 60_000, to: now });

      // Flows.
      await driver.addJob(
        q,
        makeJob({
          id: "parent",
          state: "waiting-children",
          runAt: now,
          flow: {
            parent: null,
            children: [{ queue: "mail", id: "kid" }],
            pending: 1,
            values: {},
            failures: {},
            recorded: false,
          },
        }),
      );
      await driver.recordChild(
        q,
        "parent",
        { queue: "mail", id: "kid" },
        { completed: true, value: 1 },
        now,
      );
      await driver.requeueParent(q, "parent", now);
      await driver.markChildRecorded(q, "kid", false, now);

      // Pending work goes last.
      await driver.drainQueue(q, true);

      // Two queues waiting at once, and a wake: whatever the blocking pop
      // declares must be one slot too.
      const waits = [driver.waitForJob(q, 300), driver.waitForJob(other, 300)];
      await Bun.sleep(50);
      await driver.addJob(other, makeJob({ id: "w", runAt: Date.now() }));
      await Promise.all(waits);

      // Every call declared one slot.
      const crossed = record.filter((call) => !oneSlot(call.keys));
      expect(
        crossed.map((call) => ({
          script: queueScripts().get(call.source) ?? call.kind,
          keys: call.keys,
        })),
      ).toEqual([]);

      // And every queue script ran at least once, so none escaped the check.
      const ran = new Set(record.map((call) => call.source));
      const missed = [...queueScripts()]
        .filter(([source]) => !ran.has(source))
        .map(([, name]) => name);
      expect(missed).toEqual([]);

      // A blocking pop happened, and was checked.
      expect(record.some((call) => call.kind === "blpop")).toBe(true);

      // `listQueues` still learns every queue added to, though the set is no
      // longer written from inside the script.
      expect((await driver.listQueues(ns)).sort()).toEqual(["mail", "sms"]);
    }, 20_000);
  },
);
