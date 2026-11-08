import type { JobState, QueueRef } from "../lib/drivers/driver";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { FileDriver } from "../lib/index";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";

/**
 * The file driver's `countJobs` while jobs move between states.
 *
 * Its reads are one `readdir` per state directory, so a job that left a state
 * after that state was read, and arrived in one before it was read, was in
 * neither: the count came back short — zero pending for a queue about to run
 * a job. `builder-to-queue.test.ts` met it as a repeat occurrence running
 * after "nothing pending". Every move between the unfinished states is driven
 * here, each job moving once, while the count runs again and again; every
 * count must see every job. Counting one twice for an instant is allowed.
 *
 * The moves are the marker renames the driver itself makes, done directly, so
 * the test does not depend on how fast a claim is; with them, develop's order
 * (`waiting` first, `failed` fifth) lost jobs in every run measured.
 */

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

/** Every move between unfinished states the driver makes. */
const MOVES: [from: JobState, to: JobState][] = [
  ["failed", "waiting"], // promotion of a retry whose backoff elapsed
  ["delayed", "waiting"], // promotion
  ["active", "waiting"], // stall recovery, an immediate retry
  ["waiting", "active"], // a claim
  ["active", "delayed"], // a retry with a backoff
  ["active", "failed"], // a failed attempt with retries left
  ["waiting-children", "waiting"], // a parent whose children settled
];

/** Jobs per move. */
const PER_MOVE = 150;

/** States a job here can be in. */
const UNFINISHED: JobState[] = [
  "waiting",
  "delayed",
  "active",
  "failed",
  "waiting-children",
];

describe("file driver countJobs", () => {
  it("never misses a job moving between states mid-count", async () => {
    const tmp = await makeTmpDir("bun-jobs-count-moves");
    cleanups.push(tmp.cleanup);
    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q: QueueRef = { ns: testNamespace(), queue: "moving" };
    const now = Date.now();

    // One job to make the queue's directories, then markers placed directly:
    // countJobs counts marker files, and the moves below are renames of them.
    await driver.addJob(q, makeJob({ id: "seed", runAt: now }));
    const index = join(tmp.path, q.ns, "queues", q.queue, "index");
    for (const state of UNFINISHED) {
      await mkdir(join(index, state), { recursive: true });
    }
    const planned: { name: string; from: JobState; to: JobState }[] = [];
    for (const [from, to] of MOVES) {
      for (let i = 0; i < PER_MOVE; i++) {
        const name = `${now}-${from}-${to}-${i}`;
        await Bun.write(join(index, from, name), "");
        planned.push({ name, from, to });
      }
    }
    const total = planned.length + 1; // and the seed job, which stays waiting

    /** The unfinished jobs one count sees. */
    const counted = async () => {
      const counts = await driver.countJobs(q);
      return UNFINISHED.reduce((sum, state) => sum + counts[state], 0);
    };
    expect(await counted()).toBe(total);

    // The moves interleaved across their kinds, so every pair of directories
    // has a move in flight throughout.
    planned.sort(
      (a, b) =>
        Number(a.name.split("-").at(-1)) - Number(b.name.split("-").at(-1)),
    );
    // An object, so the loop below sees the mover set it.
    const progress = { moving: true };
    const mover = (async () => {
      for (const { name, from, to } of planned) {
        await rename(join(index, from, name), join(index, to, name));
      }
      progress.moving = false;
    })();

    const short: number[] = [];
    let counts = 0;
    while (progress.moving) {
      const seen = await counted();
      counts += 1;
      if (seen < total) {
        short.push(seen);
      }
    }
    await mover;

    // The counts ran while the jobs moved, and none came back short.
    expect(counts).toBeGreaterThan(5);
    expect(short).toEqual([]);
    // And every marker arrived, so nothing was lost but by the count.
    let arrived = 0;
    for (const state of UNFINISHED) {
      arrived += (await readdir(join(index, state))).length;
    }
    expect(arrived).toBe(total);
    expect(await counted()).toBe(total);
    await driver.close();
  });
});
