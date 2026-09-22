import type { JobsDriver, RunRecord } from "../lib/index";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { RedisDriver } from "../lib/index";
import { newToken } from "../lib/shared/ids";
import { makeJob, testNamespace } from "./helpers";

/**
 * The Redis driver finds a stored record by its identifier, never by a
 * substring of the text it is stored as.
 *
 * `UPDATE_HISTORY` used to pick the first history entry whose JSON merely
 * held the run id somewhere, so a run whose `result` or `error.message` quoted a
 * later run's id had its own record overwritten by that run's when it
 * settled, and the later run's record was never updated. The lock and the
 * stalled-job reply had the same family of fault: an identifier read out of
 * stored text by the first `|`, which a caller's token or a job id may hold.
 *
 * ```bash
 * BUN_JOBS_TEST_REDIS_URL=redis://127.0.0.1:6379/15 bun test redis-history-match
 * ```
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

/** Drivers to close when the suite ends. */
const drivers: JobsDriver[] = [];

/**
 * The exact namespaces this file created, purged by name when the suite ends,
 * never by a prefix sweep: other sessions share that server.
 */
const namespaces: string[] = [];

afterAll(async () => {
  await Promise.allSettled(drivers.map((driver) => driver.close()));

  if (URL && namespaces.length > 0) {
    const janitor = new RedisDriver({ url: URL });

    try {
      for (const ns of namespaces.splice(0)) {
        await janitor.purge(ns).catch(() => undefined);
      }
    } finally {
      await janitor.close();
    }
  }
});

/** A driver on the configured server, tracked for cleanup. */
function makeDriver(): RedisDriver {
  const driver = new RedisDriver({ url: URL });
  drivers.push(driver);
  return driver;
}

/** A namespace of this file's own, remembered so it is purged afterwards. */
function namespace(): string {
  const ns = testNamespace();
  namespaces.push(ns);
  return ns;
}

/** The runner every history test writes under. */
const RUNNER = "history-match";

/** A running record for one run, with anything the test wants on top. */
function running(runId: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    runnerId: RUNNER,
    attempt: 1,
    source: "manual",
    mode: "in-process",
    host: "test-host",
    startedAt: 1_000,
    status: "running",
    ...extra,
  };
}

/** The history by run id, so an assertion can name the record it means. */
async function byRunId(
  driver: RedisDriver,
  ns: string,
): Promise<Map<string, RunRecord[]>> {
  const found = new Map<string, RunRecord[]>();

  for (const record of await driver.listHistory(ns, RUNNER)) {
    found.set(record.runId, [...(found.get(record.runId) ?? []), record]);
  }

  return found;
}

/** What settling a run writes. */
const SETTLED: Partial<RunRecord> = {
  status: "success",
  finishedAt: 2_000,
  durationMs: 1_000,
  result: { settled: true },
};

/**
 * Stores `other` newest, so a text search from the head reaches it before
 * `target`, then settles `target` and checks both records.
 */
async function settleBehind(target: string, other: RunRecord): Promise<void> {
  const driver = makeDriver();
  const ns = namespace();

  await driver.appendHistory(ns, RUNNER, running(target), 50);
  await driver.appendHistory(ns, RUNNER, other, 50);

  expect(await driver.updateHistory(ns, RUNNER, target, SETTLED)).toBe(true);

  const history = await byRunId(driver, ns);
  // Two records, one each: an overwrite leaves two copies of the target.
  expect([...history.keys()].sort()).toEqual([other.runId, target].sort());
  expect(history.get(other.runId)).toEqual([other]);
  expect(history.get(target)).toEqual([{ ...running(target), ...SETTLED }]);
}

describe.skipIf(!URL)(
  "Redis driver: a history entry is matched by its runId",
  () => {
    it("leaves a run whose result names the settling run alone", async () => {
      await settleBehind(
        "run-b",
        running("run-a", {
          status: "success",
          finishedAt: 1_500,
          result: { triggered: ["run-b"] },
        }),
      );
    });

    it("leaves a run whose error message names the settling run alone", async () => {
      await settleBehind(
        "run-b",
        running("run-a", {
          status: "failed",
          finishedAt: 1_500,
          error: { name: "Error", message: "waited on run-b and gave up" },
        }),
      );
    });

    it("settles run-1, not run-10, whose id it is a prefix of", async () => {
      await settleBehind("run-1", running("run-10"));
    });

    it("settles run-10, with run-1 stored ahead of it", async () => {
      await settleBehind("run-10", running("run-1"));
    });

    it("treats an id full of Lua pattern characters as plain text", async () => {
      const target = "r%1.-[x]^$*+?(";
      // Both an id that holds the target, and a result that quotes it: either
      // would be matched first by a plain or a pattern search from the head.
      await settleBehind(`a${target}z`, running("other"));
      await settleBehind(
        target,
        running("quotes-it", { result: `see ${target} and a${target}z` }),
      );
    });

    it("reports a run with no record, however many records quote its id", async () => {
      const driver = makeDriver();
      const ns = namespace();
      const quoting = running("run-a", { result: "run-ghost" });

      await driver.appendHistory(ns, RUNNER, quoting, 50);

      expect(await driver.updateHistory(ns, RUNNER, "run-ghost", SETTLED)).toBe(
        false,
      );
      expect(await driver.listHistory(ns, RUNNER)).toEqual([quoting]);
    });
  },
);

describe.skipIf(!URL)(
  "Redis driver: identifiers holding the '|' separator",
  () => {
    it("keeps a lock whose token holds a '|' from every other token", async () => {
      const driver = makeDriver();
      const ns = namespace();
      const now = Date.now();
      const mine = `mine|${newToken()}`;

      expect(await driver.acquireLock(ns, "piped", mine, 5_000, now)).toBe(
        true,
      );
      expect(await driver.getLock(ns, "piped", now)).toEqual({
        token: mine,
        expiresAt: now + 5_000,
      });
      // Split at the first '|', the owner read as 'mine' with no expiry, and
      // any other token took the lock as free.
      expect(
        await driver.acquireLock(ns, "piped", newToken(), 5_000, now + 1),
      ).toBe(false);
      expect(await driver.renewLock(ns, "piped", mine, 5_000, now + 2)).toBe(
        true,
      );
      expect(await driver.releaseLock(ns, "piped", mine)).toBe(true);
      expect(await driver.getLock(ns, "piped", now + 3)).toBeNull();
    });

    it("recovers a stalled job whose id is '|' as requeued, not as the marker", async () => {
      const driver = makeDriver();
      const q = { ns: namespace(), queue: "stalled" };
      const now = Date.now();

      for (const id of ["before", "|", "after"]) {
        await driver.addJob(q, makeJob({ id, runAt: now }));
        await driver.claimJob(q, {
          workerId: "gone",
          token: newToken(),
          lockMs: 10,
          now,
        });
      }

      const first = await driver.recoverStalled(q, now + 1_000, 1, 10);
      expect([...first.requeued].sort()).toEqual(["after", "before", "|"]);
      expect(first.dead).toEqual([]);

      for (let i = 0; i < 3; i++) {
        await driver.claimJob(q, {
          workerId: "gone",
          token: newToken(),
          lockMs: 10,
          now: now + 1_000,
        });
      }

      const second = await driver.recoverStalled(q, now + 2_000, 1, 10);
      expect(second.requeued).toEqual([]);
      expect([...second.dead].sort()).toEqual(["after", "before", "|"]);
      expect((await driver.getJob(q, "|"))?.state).toBe("dead");
    });
  },
);
