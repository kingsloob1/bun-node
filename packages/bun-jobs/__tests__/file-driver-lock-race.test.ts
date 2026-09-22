import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { FileDriver } from "../lib/drivers/file-driver";
import { encodeSegment } from "../lib/drivers/file-names";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * `renewLock` against a `releaseLock` that lands between its read and its
 * write — from another process, which is what `BunRunner`'s own guards cannot
 * prevent. Two driver instances over one directory stand in for the two
 * processes, and the renewal is held at that exact point by the driver's test
 * seam: no sleeps, no timing, the interleaving is forced.
 */

/**
 * The driver's `renewLock` seam. Registered rather than exported, so it is no
 * part of the module's surface; the description must match the driver's. A
 * drift would leave the gate never running, which every test here catches by
 * asserting the gate ran.
 */
const RENEW_LOCK_GATE = Symbol.for("bun-jobs: FileDriver renewLock gate");

/** Sets (or, with `undefined`, clears) `driver`'s `renewLock` seam. */
function setRenewLockGate(
  driver: FileDriver,
  gate: (() => Promise<void>) | undefined,
): void {
  Reflect.set(driver, RENEW_LOCK_GATE, gate);
}

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** Two drivers over one fresh directory, as two processes would share it. */
async function twoProcesses(): Promise<{
  root: string;
  renewer: FileDriver;
  releaser: FileDriver;
}> {
  const tmp = await makeTmpDir("bun-jobs-lock-race");
  cleanups.push(tmp.cleanup);
  const renewer = new FileDriver({ root: tmp.path });
  const releaser = new FileDriver({ root: tmp.path });
  await renewer.connect();
  return { root: tmp.path, renewer, releaser };
}

/** Whatever `lock.json` files are left under a runner's directory. */
async function lockFiles(root: string, ns: string): Promise<string[]> {
  const runners = join(root, encodeSegment(ns), "runners");
  const found: string[] = [];

  for (const runner of await readdir(runners).catch(() => [])) {
    for (const entry of await readdir(join(runners, runner))) {
      if (entry.startsWith("lock.")) {
        found.push(entry);
      }
    }
  }

  return found;
}

describe("file driver: renewLock against a concurrent release", () => {
  it("answers false and does not re-create a lock released between its read and its write", async () => {
    const { root, renewer, releaser } = await twoProcesses();
    const ns = testNamespace("lock-race");
    const now = Date.now();

    expect(await renewer.acquireLock(ns, "job", "t-1", 30_000, now)).toBe(true);

    let released: boolean | undefined;
    setRenewLockGate(renewer, async () => {
      // The renewal has read its lock and seen it live. The release lands
      // now, in full, before the renewal writes.
      released = await releaser.releaseLock(ns, "job", "t-1");
    });

    const renewed = await renewer.renewLock(ns, "job", "t-1", 30_000, now + 1);

    // The gate ran, so this is the interleaving under test, not a lucky one.
    expect(released).toBe(true);
    expect(renewed).toBe(false);
    // Nothing left behind: not the lock, and not the mutex guarding it.
    expect(await lockFiles(root, ns)).toEqual([]);
    expect(await renewer.getLock(ns, "job", now + 2)).toBeNull();

    // And the lock is free for anyone at once, not after the 30 s TTL.
    setRenewLockGate(renewer, undefined);
    expect(await releaser.acquireLock(ns, "job", "t-2", 30_000, now + 3)).toBe(
      true,
    );
  });

  it("still renews when nothing released the lock meanwhile", async () => {
    const { root, renewer } = await twoProcesses();
    const ns = testNamespace("lock-renew");
    const now = Date.now();

    expect(await renewer.acquireLock(ns, "job", "t-1", 1_000, now)).toBe(true);

    let gated = false;
    setRenewLockGate(renewer, async () => {
      gated = true;
    });

    expect(await renewer.renewLock(ns, "job", "t-1", 30_000, now + 500)).toBe(
      true,
    );
    expect(gated).toBe(true);
    expect((await renewer.getLock(ns, "job", now + 5_000))?.token).toBe("t-1");
    expect(await lockFiles(root, ns)).toEqual(["lock.json"]);
  });

  it("does not renew a lock another token took over between its read and its write", async () => {
    const { renewer, releaser } = await twoProcesses();
    const ns = testNamespace("lock-steal");
    const now = Date.now();

    expect(await renewer.acquireLock(ns, "job", "t-1", 30_000, now)).toBe(true);

    setRenewLockGate(renewer, async () => {
      // Released and taken by somebody else in the gap.
      expect(await releaser.releaseLock(ns, "job", "t-1")).toBe(true);
      expect(
        await releaser.acquireLock(ns, "job", "t-2", 30_000, now + 1),
      ).toBe(true);
    });

    expect(await renewer.renewLock(ns, "job", "t-1", 60_000, now + 2)).toBe(
      false,
    );
    // The newcomer's lock stands, untouched by the stale renewal.
    expect(await renewer.getLock(ns, "job", now + 3)).toEqual({
      token: "t-2",
      expiresAt: now + 1 + 30_000,
    });
  });
});
