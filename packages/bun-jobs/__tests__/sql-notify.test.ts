import process from "node:process";
import { describe, expect, it } from "bun:test";
import { SqlDriver } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";

/**
 * Postgres `LISTEN`/`NOTIFY`, which is off unless asked for.
 *
 * It ends a worker's wait the instant a job lands rather than at its next
 * poll. That is worth less than it sounds with an adaptive poll — the first
 * re-check is a millisecond after a queue drains — and carrying the signal
 * inside the insert costs the producer 5-9%, so the default is off and this
 * covers the opt-in.
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_POSTGRES_URL;

describe.skipIf(!URL)("SQL driver: LISTEN/NOTIFY", () => {
  it("wakes a waiter the poll could not have reached yet", async () => {
    // A deliberately huge poll interval. The wait's backoff doubles from 1ms
    // towards this ceiling, so after a couple of seconds the next poll is
    // seconds away and cannot be what notices the job. Only the notification
    // can end the wait quickly, which is what makes this test mean something —
    // at the default 50ms ceiling, polling wins the race often enough that the
    // same assertion passes with notifications switched off.
    const driver = new SqlDriver({
      url: URL,
      notify: true,
      pollInterval: 60_000,
    });
    const q = { ns: testNamespace(), queue: "notified" };
    await driver.connect();
    await driver.ensureQueue(q);

    const waiting = driver.waitForJob(q, 30_000);
    await Bun.sleep(2_500);

    const addedAt = Date.now();
    await driver.addJob(q, makeJob({ id: "arrived" }));
    await waiting;

    expect(Date.now() - addedAt).toBeLessThan(500);

    await driver.purge(q.ns);
    await driver.close();
  }, 45_000);

  it("still finds a job when nothing announced it", async () => {
    const driver = new SqlDriver({ url: URL, notify: true });
    const q = { ns: testNamespace(), queue: "unannounced" };
    await driver.connect();
    await driver.ensureQueue(q);

    // Added through a second connection that has notifications off, so no
    // signal is sent at all. Polling underneath is what has to catch this —
    // a promotion by another process's sweep looks exactly like it.
    const quiet = new SqlDriver({ url: URL });
    await quiet.addJob(q, makeJob({ id: "silent" }));
    await quiet.close();

    await driver.waitForJob(q, 30_000);
    expect(await driver.getJob(q, "silent")).not.toBeNull();

    await driver.purge(q.ns);
    await driver.close();
  }, 45_000);

  it("is off unless it is asked for", async () => {
    const driver = new SqlDriver({ url: URL });
    await driver.connect();

    // Nothing observable changes, so the guarantee is that the default path
    // still works end to end without a listener anywhere.
    const q = { ns: testNamespace(), queue: "quiet" };
    await driver.ensureQueue(q);
    await driver.addJob(q, makeJob({ id: "polled" }));
    await driver.waitForJob(q, 5_000);

    expect(await driver.getJob(q, "polled")).not.toBeNull();

    await driver.purge(q.ns);
    await driver.close();
  }, 20_000);
});
