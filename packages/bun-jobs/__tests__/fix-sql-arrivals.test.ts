import type { SQL } from "bun";
import process from "node:process";
import { SQL as BunSQL } from "bun";
import { describe, expect, it } from "bun:test";
import { Arrivals } from "../lib/drivers/sql/arrivals";
import { SqlDriver } from "../lib/index";
import { makeJob, testNamespace, waitFor } from "./helpers";

/**
 * A `NOTIFY` that lands while nobody is waiting is not lost.
 *
 * A worker registers its wait only after its claim came back empty, and after
 * the promotion and next-due reads that follow. A job committed in that gap
 * announced itself to no waiter, and the wait used to cover it with a `COUNT`
 * poll on every idle pass. The channel now counts its notifications, a claim
 * records the count as it starts, and the wait compares.
 */

/** A stand-in for Bun's client: `listen` hands back the callback to fire. */
function fakeListener(): {
  sql: SQL;
  fire: (channel: string) => void;
} {
  const callbacks = new Map<string, () => void>();
  const sql = {
    listen: async (channel: string, callback: () => void) => {
      callbacks.set(channel, callback);
      return { unlisten: async () => {} };
    },
  } as unknown as SQL;

  return { sql, fire: (channel) => callbacks.get(channel)?.() };
}

describe("SQL arrivals: a notification before the wait", () => {
  it("ends the wait at once when the channel fired after the mark", async () => {
    const { sql, fire } = fakeListener();
    const arrivals = new Arrivals(sql, true);
    const q = { ns: "n", queue: "q" };

    // The first wait establishes the registration; it times out quietly.
    expect(await arrivals.wait(q, 1)).toBe(false);

    arrivals.mark(q);
    // The job lands while nobody waits: the claim has not come back yet.
    fire(arrivals.channel(q));

    const mark = arrivals.take(q);
    expect(mark.state).toBe("moved");

    const started = performance.now();
    expect(await arrivals.wait(q, 2_000, undefined, mark.since)).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);

    await arrivals.close();
  });

  it("reports a quiet channel as quiet, and still wakes on a later notify", async () => {
    const { sql, fire } = fakeListener();
    const arrivals = new Arrivals(sql, true);
    const q = { ns: "n", queue: "quiet" };
    await arrivals.wait(q, 1);

    arrivals.mark(q);
    const mark = arrivals.take(q);
    expect(mark.state).toBe("quiet");

    const waiting = arrivals.wait(q, 2_000, undefined, mark.since);
    fire(arrivals.channel(q));
    expect(await waiting).toBe(true);

    // Taken once: a second take has no mark to judge by.
    expect(arrivals.take(q).state).toBe("none");
    await arrivals.close();
  });

  it("keeps the earliest mark, and forgets it for a claim that took a job", async () => {
    const { sql, fire } = fakeListener();
    const arrivals = new Arrivals(sql, true);
    const q = { ns: "n", queue: "shared" };
    await arrivals.wait(q, 1);

    // Two claimers on one driver: the notify between their marks must still
    // count for the first.
    arrivals.mark(q);
    fire(arrivals.channel(q));
    arrivals.mark(q);
    expect(arrivals.take(q).state).toBe("moved");

    arrivals.mark(q);
    arrivals.unmark(q);
    expect(arrivals.take(q).state).toBe("none");
    await arrivals.close();
  });

  it("records nothing before the channel listens, and nothing when disabled", async () => {
    const { sql } = fakeListener();
    const q = { ns: "n", queue: "cold" };

    const cold = new Arrivals(sql, true);
    cold.mark(q);
    expect(cold.take(q).state).toBe("none");
    await cold.close();

    const off = new Arrivals(sql, false);
    off.mark(q);
    expect(off.take(q).state).toBe("none");
    expect(await off.wait(q, 50)).toBe(false);
  });
});

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_POSTGRES_URL;

describe.skipIf(!URL)("SQL driver: Postgres wait after a missed NOTIFY", () => {
  it("returns without a statement when the job was announced before the wait", async () => {
    const client = new BunSQL({ url: URL! });
    /** The poll statements the wait issued. */
    let polls = 0;
    const counted = new Proxy(client, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (key === "unsafe") {
          return (text: string, params?: unknown[]) => {
            if (/COUNT\(\*\) AS total|SELECT 1 AS found/.test(text)) polls++;
            return target.unsafe(text, params as never);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const worker = new SqlDriver({
      sql: counted,
      adapter: "postgres",
      tablePrefix: "bun_jobs_test_",
      pollInterval: 60_000,
    });
    const producer = new SqlDriver({
      url: URL,
      tablePrefix: "bun_jobs_test_",
    });
    const q = { ns: testNamespace("missed"), queue: "missed" };

    try {
      await worker.connect();
      await producer.connect();

      // A first empty claim and wait, so the worker is listening.
      const claim = { workerId: "w", token: "t", lockMs: 30_000 };
      expect(
        await worker.claimJob(q, { ...claim, now: Date.now() }),
      ).toBeNull();
      await worker.waitForJob(q, 5);

      // The worker's claim comes back empty...
      expect(
        await worker.claimJob(q, { ...claim, now: Date.now() }),
      ).toBeNull();

      // ...and before it starts waiting, a job lands and is announced. The
      // test's own listener is registered on the worker's client, after the
      // worker's: registrations share one connection and each is handed every
      // notification, so once this one has heard it the worker's has too. (A
      // listener on a connection of its own, plus a fixed grace, raced the
      // worker's under load.)
      let heard = false;
      const channel = `bunjobs_${Bun.hash(`${q.ns}:${q.queue}`).toString(36)}`;
      const listening = await client.listen(channel, () => {
        heard = true;
      });
      await producer.addJob(q, makeJob({ id: "early", runAt: Date.now() }));
      await waitFor(() => heard, { timeout: 5_000 });
      await listening.unlisten();

      polls = 0;
      const started = performance.now();
      await worker.waitForJob(q, 20_000);
      const took = performance.now() - started;

      expect(took).toBeLessThan(500);
      // The job was known without asking: before the fix, the wait's opening
      // poll was the only thing that saw it.
      expect(polls).toBe(0);
    } finally {
      await producer.purge(q.ns).catch(() => {});
      await worker.close().catch(() => {});
      await producer.close().catch(() => {});
      await client.close().catch(() => {});
    }
  }, 30_000);

  it("waits for the notification when nothing landed", async () => {
    const client = new BunSQL({ url: URL! });
    const worker = new SqlDriver({
      sql: client,
      adapter: "postgres",
      tablePrefix: "bun_jobs_test_",
    });
    const producer = new SqlDriver({ url: URL, tablePrefix: "bun_jobs_test_" });
    const q = { ns: testNamespace("quiet"), queue: "quiet" };

    try {
      await worker.connect();
      const claim = { workerId: "w", token: "t", lockMs: 30_000 };
      expect(
        await worker.claimJob(q, { ...claim, now: Date.now() }),
      ).toBeNull();
      await worker.waitForJob(q, 5);
      expect(
        await worker.claimJob(q, { ...claim, now: Date.now() }),
      ).toBeNull();

      const waiting = worker.waitForJob(q, 20_000);
      await Bun.sleep(50);
      const addedAt = performance.now();
      await producer.addJob(q, makeJob({ id: "later", runAt: Date.now() }));
      await waiting;
      expect(performance.now() - addedAt).toBeLessThan(500);
    } finally {
      await producer.purge(q.ns).catch(() => {});
      await worker.close().catch(() => {});
      await producer.close().catch(() => {});
      await client.close().catch(() => {});
    }
  }, 30_000);
});
