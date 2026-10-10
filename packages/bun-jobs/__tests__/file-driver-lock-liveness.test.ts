import type { SpawnedProcess } from "./helpers/spawnBun";
import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { FileDriver } from "../lib/drivers/file-driver";
import { encodeName, encodeSegment } from "../lib/drivers/file-names";
import { makeTmpDir, testNamespace } from "./helpers";
import { spawnBun } from "./helpers/spawnBun";

/**
 * The file driver's write locks against a holder that is alive but not
 * running — `SIGSTOP`, a GC pause, a CPU-bound in-process handler, a frozen
 * container — for longer than the lock's stale time, on one host.
 *
 * A waiter used to break any lock whose file was more than a second old, and
 * every release deleted the lock file whoever owned it. So a holder paused for
 * a second lost its lock, the waiter's compare-and-set and the holder's both
 * won, and the holder's release then deleted the waiter's successor's lock,
 * which carried the double hold on down the line.
 *
 * Each case runs the holder in a real process (`fixtures/processes/
 * lock-holder.ts`), held inside a compare-and-set's critical section, because
 * only another process is paused independently of the waiter.
 */

/** The queue `fixtures/processes/lock-holder.ts` writes to. */
const QUEUE = "lock-liveness";

const HOLDER = join(import.meta.dir, "fixtures/processes/lock-holder.ts");

/** Longer than `LOCK_STALE_MS` twice over: what a paused holder must survive. */
const PAUSE_MS = 2_500;

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

/** A fresh root, a driver over it, and a queue whose `counter` is at version 1. */
async function setup(): Promise<{
  root: string;
  ns: string;
  driver: FileDriver;
  q: { ns: string; queue: string };
}> {
  const tmp = await makeTmpDir("bun-jobs-lock-liveness");
  const ns = testNamespace("lock-liveness");
  const q = { ns, queue: QUEUE };
  const driver = new FileDriver({ root: tmp.path });
  cleanups.push(async () => {
    await driver.close();
    await tmp.cleanup();
  });
  await driver.ensureQueue(q);
  expect(await driver.setQueueState(q, "counter", "initial", null)).toBe(1);
  return { root: tmp.path, ns, driver, q };
}

/** Where a holder is, once it is inside the lock. */
interface Holding {
  /** The lock file it holds. */
  lock: string;
  /** Its process id. */
  pid: number;
}

/**
 * Starts a holder and waits for it to be inside the lock. Its process is
 * killed (by PID) when the file's tests end, whatever state it is left in.
 */
async function startHolder(
  root: string,
  ns: string,
  go?: string,
): Promise<{ holder: SpawnedProcess; holding: Holding }> {
  const env: Record<string, string> = { ROOT: root, NS: ns };
  if (go) {
    env.GO = go;
  }
  const holder = spawnBun(HOLDER, env);
  cleanups.push(async () => {
    if (holder.proc.exitCode === null && holder.proc.signalCode === null) {
      process.kill(holder.proc.pid, "SIGCONT");
      process.kill(holder.proc.pid, "SIGKILL");
    }
    await holder.exited;
  });

  if (!(await holder.printed('"holding":true'))) {
    throw new Error(`the holder never took the lock: ${await holder.errors}`);
  }
  return {
    holder,
    holding: {
      lock: counterLock(root, { ns, queue: QUEUE }),
      pid: holder.proc.pid,
    },
  };
}

/** The lock file of `q`'s `counter` entry under `root`, as the driver names it. */
function counterLock(root: string, q: { ns: string; queue: string }): string {
  const queue = join(
    root,
    encodeSegment(q.ns),
    "queues",
    encodeSegment(q.queue),
  );
  return join(queue, "state", `${encodeName("counter")}.lock`);
}

/** Resolves `"pending"` if `work` has not settled within `ms`. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | "pending"> {
  return await Promise.race([
    work,
    Bun.sleep(ms).then(() => "pending" as const),
  ]);
}

describe("file driver: a held lock whose holder is alive but paused", () => {
  it("is not broken while its holder is stopped, and only one compare-and-set wins", async () => {
    const { root, ns, driver, q } = await setup();
    const go = join(root, "go");
    const { holder, holding } = await startHolder(root, ns, go);

    // Frozen inside the critical section: its read done, its write not.
    process.kill(holding.pid, "SIGSTOP");

    const theirs = driver.setQueueState(q, "counter", "waiter", 1);
    const early = await within(theirs, PAUSE_MS);

    await writeFile(go, "");
    process.kill(holding.pid, "SIGCONT");
    const [mine, exitCode] = await Promise.all([theirs, holder.exited]);
    const won = (await holder.output)
      .split("\n")
      .filter((line) => line.startsWith('{"won"'))
      .map((line) => (JSON.parse(line) as { won: number | null }).won);

    // The waiter waited for the holder rather than breaking its lock...
    expect(early).toBe("pending");
    // ...so the holder's compare-and-set won, and the waiter's lost to it.
    expect(exitCode).toBe(0);
    expect(won).toEqual([2]);
    expect(mine).toBeNull();
    expect(await driver.getQueueState(q, "counter")).toEqual({
      version: 2,
      value: "holder",
    });
  }, 20_000);

  it("keeps the lock file fresh while its holder's event loop runs", async () => {
    const { root, ns } = await setup();
    const go = join(root, "go");
    const { holder, holding } = await startHolder(root, ns, go);

    // Held for longer than the stale time, sampling the file's age as it goes.
    const ages: number[] = [];
    const until = Date.now() + PAUSE_MS;
    while (Date.now() < until) {
      await Bun.sleep(100);
      ages.push(Date.now() - (await stat(holding.lock)).mtimeMs);
    }

    await writeFile(go, "");
    expect(await holder.exited).toBe(0);

    // Never once old enough for a waiter on another host to call it stale.
    expect(Math.max(...ages)).toBeLessThan(1_000);
  }, 20_000);

  it("leaves a lock it no longer owns to its new owner on release", async () => {
    const { root, ns } = await setup();
    const go = join(root, "go");
    const { holder, holding } = await startHolder(root, ns, go);

    // Somebody else's lock in its place, as a break and a retake would leave.
    const foreign = JSON.stringify({
      token: "someone-else",
      pid: process.pid,
      host: "elsewhere",
    });
    await writeFile(holding.lock, foreign);

    await writeFile(go, "");
    expect(await holder.exited).toBe(0);

    expect(await readFile(holding.lock, "utf8")).toBe(foreign);
  }, 20_000);
});

describe("file driver: a lock nobody holds any more", () => {
  it("is broken once its holder has died", async () => {
    const { root, ns, driver, q } = await setup();
    const { holder, holding } = await startHolder(root, ns);

    process.kill(holding.pid, "SIGKILL");
    await holder.exited;

    const started = Date.now();
    expect(await driver.setQueueState(q, "counter", "after", 1)).toBe(2);
    // The stale time and a little, not the live-holder ceiling.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it("is broken by its age when it does not say who holds it", async () => {
    const { driver, q, root } = await setup();
    const lock = counterLock(root, q);

    // What an earlier version wrote: a bare timestamp, from a crash 5 s ago.
    await writeFile(lock, String(Date.now() - 5_000));
    const past = (Date.now() - 5_000) / 1000;
    await utimes(lock, past, past);

    expect(await driver.setQueueState(q, "counter", "after", 1)).toBe(2);
  }, 20_000);
});
