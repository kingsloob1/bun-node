import { readdir, readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { FileDriver } from "../lib/drivers/file-driver";
import { encodeSegment } from "../lib/drivers/file-names";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * `acquireLock` against a contender arriving while the winner's `lock.json`
 * exists but is still empty.
 *
 * The winner's exclusive create and its write of the token are two steps. A
 * contender whose own create failed in between took the mutex, read an empty
 * file, judged it stale, renamed it away and took the lock itself — while the
 * winner went on to report success too. Two holders, so a `single` runner ran
 * in two processes at once. Measured before the fix: 24 double acquisitions in
 * 3,000 raced pairs under CPU load, none unloaded.
 *
 * Two driver instances over one directory stand in for the two processes; the
 * winner is held between its create and its write by the driver's test seam,
 * so the interleaving is forced rather than hoped for.
 */

/**
 * The driver's `acquireLock` seam. Registered rather than exported; the
 * description must match the driver's, and every test asserts the gate ran.
 */
const ACQUIRE_LOCK_GATE = Symbol.for("bun-jobs: FileDriver acquireLock gate");

/** Sets (or, with `undefined`, clears) `driver`'s `acquireLock` seam. */
function setAcquireLockGate(
  driver: FileDriver,
  gate: (() => Promise<void>) | undefined,
): void {
  Reflect.set(driver, ACQUIRE_LOCK_GATE, gate);
}

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** Two drivers over one fresh directory, as two processes would share it. */
async function twoProcesses(): Promise<{
  root: string;
  winner: FileDriver;
  contender: FileDriver;
}> {
  const tmp = await makeTmpDir("bun-jobs-acquire-race");
  cleanups.push(tmp.cleanup);
  const winner = new FileDriver({ root: tmp.path });
  const contender = new FileDriver({ root: tmp.path });
  await winner.connect();
  return { root: tmp.path, winner, contender };
}

/** The directory holding a runner key's `lock.json`. */
async function lockDir(root: string, ns: string): Promise<string> {
  const runners = join(root, encodeSegment(ns), "runners");
  const [runner] = await readdir(runners);
  return join(runners, runner ?? "");
}

describe("file driver: acquireLock against a lock still being written", () => {
  it("refuses a contender while the winner's lock.json is still empty", async () => {
    const { winner, contender } = await twoProcesses();
    const ns = testNamespace("acquire-race");
    const now = Date.now();

    let contended: boolean | undefined;
    setAcquireLockGate(winner, async () => {
      // lock.json exists, empty: the winner has created it and not yet
      // written its token. The contender arrives now, in full.
      contended = await contender.acquireLock(ns, "job", "t-b", 30_000, now);
    });

    const won = await winner.acquireLock(ns, "job", "t-a", 30_000, now);

    // The gate ran, so this is the interleaving under test.
    expect(contended).toBe(false);
    expect(won).toBe(true);

    // Exactly one holder, and it is the winner: its lock is the one on disk,
    // it can renew it, and the contender cannot.
    expect((await winner.getLock(ns, "job", now + 1))?.token).toBe("t-a");
    expect(await winner.renewLock(ns, "job", "t-a", 30_000, now + 2)).toBe(
      true,
    );
    expect(await contender.renewLock(ns, "job", "t-b", 30_000, now + 3)).toBe(
      false,
    );
  });

  it("breaks an empty lock.json once it is older than the TTL, as a crash mid-create leaves it", async () => {
    const { root, winner, contender } = await twoProcesses();
    const ns = testNamespace("acquire-crash");
    const now = Date.now();

    // A process that died between its create and its write: an empty file.
    // Backdated a minute, so it reads as long abandoned.
    setAcquireLockGate(winner, async () => {
      const old = new Date(now - 60_000);
      await utimes(join(await lockDir(root, ns), "lock.json"), old, old);
      throw new Error("crashed before writing");
    });
    await expect(
      winner.acquireLock(ns, "job", "t-dead", 30_000, now),
    ).rejects.toThrow("crashed before writing");
    setAcquireLockGate(winner, undefined);
    expect(
      await readFile(join(await lockDir(root, ns), "lock.json"), "utf8"),
    ).toBe("");

    // Left empty and a minute old: a leftover, not a lock being written.
    expect(await contender.acquireLock(ns, "job", "t-b", 30_000, now)).toBe(
      true,
    );
    expect((await contender.getLock(ns, "job", now + 1))?.token).toBe("t-b");
  });
});
