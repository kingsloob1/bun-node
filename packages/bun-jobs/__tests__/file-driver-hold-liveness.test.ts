import type { JobRecord } from "../lib/drivers/driver";
import type { SpawnedProcess } from "./helpers/spawnBun";
import { mkdir, readdir, rename, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { FileDriver } from "../lib/drivers/file-driver";
import { encodeSegment } from "../lib/drivers/file-names";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";
import { spawnBun } from "./helpers/spawnBun";

/**
 * The file driver's holds — a job's marker renamed out of the index into
 * `held/` for as long as one change needs the job to stand still — against a
 * holder that is alive but not running (`SIGSTOP`, a GC pause, a CPU-bound
 * in-process handler, a frozen container) for longer than a second, on one
 * host.
 *
 * Every hold more than a second old used to be healed — filed back into the
 * index by its job's record — by whoever looked: a worker's maintenance pass,
 * or any change waiting for the marker. So a paused holder's job was taken
 * from under it, and once it resumed it wrote the record it had computed
 * before, over whatever had happened since: a removed job came back, a patch
 * was lost, a claimed or completed job was written back as it had been.
 *
 * Each case runs the holder in a real process (`fixtures/processes/
 * hold-holder.ts`), held inside an `updateJob` with the marker taken and the
 * record not yet written, because only another process is paused
 * independently of the one healing. The write locks' version of this is
 * `file-driver-lock-liveness.test.ts`.
 */

const QUEUE = "hold-liveness";

const HOLDER = join(import.meta.dir, "fixtures/processes/hold-holder.ts");

/**
 * How long a stopped holder stays stopped: past `LOCK_STALE_MS` (1 s), when
 * its hold used to be healed, and past `HOLD_PATIENCE_MS` (2 s), when a
 * waiter for its marker used to give up.
 */
const PAUSE_MS = 3_000;

/**
 * A pause past two whole `HOLD_PATIENCE_MS` windows: a removal, a patch or a
 * progress report waits one, then tries once more before saying the marker
 * stayed held. Still well under `LOCK_ABANDONED_MS` (10 s).
 */
const LONG_PAUSE_MS = 5_000;

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

/**
 * A fresh root, a driver over it, and a queue holding the job `job`: waiting
 * and due, unless `job` says otherwise.
 */
async function setup(job: Partial<JobRecord> = {}): Promise<{
  root: string;
  driver: FileDriver;
  q: { ns: string; queue: string };
}> {
  const tmp = await makeTmpDir("bun-jobs-hold-liveness");
  const q = { ns: testNamespace("hold-liveness"), queue: QUEUE };
  const driver = new FileDriver({ root: tmp.path });
  cleanups.push(async () => {
    await driver.close();
    await tmp.cleanup();
  });
  await driver.connect();
  await driver.addJob(q, makeJob({ id: "job", runAt: Date.now(), ...job }));
  return { root: tmp.path, driver, q };
}

/**
 * Starts a holder patching `job` with `patch` and waits for it to be inside
 * its hold. Its process is killed (by PID) when the file's tests end, whatever
 * state it is left in.
 */
async function startHolder(
  root: string,
  q: { ns: string; queue: string },
  patch: Record<string, unknown>,
  go?: string,
): Promise<SpawnedProcess> {
  const env: Record<string, string> = {
    ROOT: root,
    NS: q.ns,
    QUEUE: q.queue,
    ID: "job",
    PATCH: JSON.stringify(patch),
  };
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
    throw new Error(`the holder never took the hold: ${await holder.errors}`);
  }
  return holder;
}

/** Lets a holder started with `go` carry on, and waits for it to finish. */
async function resume(holder: SpawnedProcess, go: string): Promise<number> {
  await writeFile(go, "");
  process.kill(holder.proc.pid, "SIGCONT");
  return await holder.exited;
}

/** `q`'s directory under `root`, as the driver names it. */
function queueDir(root: string, q: { ns: string; queue: string }): string {
  return join(root, encodeSegment(q.ns), "queues", encodeSegment(q.queue));
}

/**
 * Every file in `held/`, at any depth, relative to it: where a job's marker is
 * while somebody holds it.
 */
async function holds(
  root: string,
  q: { ns: string; queue: string },
): Promise<string[]> {
  const entries = await readdir(join(queueDir(root, q), "held"), {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name).slice(
        join(queueDir(root, q), "held").length + 1,
      ),
    );
}

/** Every marker of `job` in the index, as `<state>/<marker>`. */
async function markers(
  root: string,
  q: { ns: string; queue: string },
): Promise<string[]> {
  const index = join(queueDir(root, q), "index");
  const found: string[] = [];
  for (const state of await readdir(index).catch(() => [])) {
    for (const marker of await readdir(join(index, state)).catch(() => [])) {
      if (marker.endsWith("-job")) {
        found.push(`${state}/${marker}`);
      }
    }
  }
  return found;
}

/** Resolves `"pending"` if `work` has not settled within `ms`. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | "pending"> {
  return await Promise.race([
    work,
    Bun.sleep(ms).then(() => "pending" as const),
  ]);
}

/** A claim of whatever is next in `q`, as a worker makes it. */
async function claim(driver: FileDriver, q: { ns: string; queue: string }) {
  return await driver.claimJob(q, {
    workerId: "hold-liveness",
    token: "hold-liveness-token",
    lockMs: 60_000,
    now: Date.now(),
  });
}

describe("file driver: a hold whose holder is alive but paused", () => {
  it("is not taken by a removal, and the removed job does not come back", async () => {
    const { root, driver, q } = await setup();
    const go = join(root, "go");
    const holder = await startHolder(root, q, { priority: 7 }, go);

    // Frozen inside its hold: the record read, the patched one not written.
    process.kill(holder.proc.pid, "SIGSTOP");

    const removal = driver.removeJob(q, "job");
    const early = await within(removal, LONG_PAUSE_MS);

    expect(await resume(holder, go)).toBe(0);
    const removed = await removal;

    // The removal waited for the holder rather than taking its marker...
    expect(early).toBe("pending");
    expect(removed).toBe(true);
    // ...so it removed the patched job for good: no record, no marker.
    expect(await driver.getJob(q, "job")).toBeNull();
    expect(await markers(root, q)).toEqual([]);
    expect(await holds(root, q)).toEqual([]);
  }, 30_000);

  it("is not taken by another patch, and neither change is lost", async () => {
    const { root, driver, q } = await setup();
    const go = join(root, "go");
    const holder = await startHolder(root, q, { priority: 7 }, go);

    process.kill(holder.proc.pid, "SIGSTOP");

    const patch = driver.updateJob(q, "job", { data: { by: "waiter" } }, 0);
    const early = await within(patch, LONG_PAUSE_MS);

    expect(await resume(holder, go)).toBe(0);
    await patch;

    expect(early).toBe("pending");
    // Both patches landed, one after the other.
    const job = await driver.getJob(q, "job");
    expect(job?.priority).toBe(7);
    expect(job?.data).toEqual({ by: "waiter" });
    expect(await markers(root, q)).toHaveLength(1);
  }, 30_000);

  it("is left alone by a maintenance pass, so no claim takes the job under it", async () => {
    const { root, driver, q } = await setup();
    const go = join(root, "go");
    const holder = await startHolder(root, q, { priority: 7 }, go);

    process.kill(holder.proc.pid, "SIGSTOP");

    // Past the second after which a hold used to be taken for a dead one.
    await Bun.sleep(1_500);
    await driver.recoverStalled(q, Date.now(), 1, 100);
    const during = await claim(driver, q);

    expect(await resume(holder, go)).toBe(0);

    expect(during).toBeNull();
    // Once the holder is done, the job is claimed as it left it, and the
    // claim's completion is the job's last word.
    const claimed = await claim(driver, q);
    expect(claimed?.priority).toBe(7);
    expect(
      await driver.completeJob(
        q,
        "job",
        "hold-liveness-token",
        "done",
        false,
        Date.now(),
      ),
    ).toBe(true);
    expect((await driver.getJob(q, "job"))?.state).toBe("completed");
    expect(await markers(root, q)).toHaveLength(1);
  }, 30_000);

  it("is waited out by its job's completion, which is not reported as a lost lock", async () => {
    const { root, driver, q } = await setup();
    expect((await claim(driver, q))?.id).toBe("job");
    const go = join(root, "go");
    const holder = await startHolder(root, q, { data: { by: "holder" } }, go);

    process.kill(holder.proc.pid, "SIGSTOP");

    const completion = driver.completeJob(
      q,
      "job",
      "hold-liveness-token",
      "done",
      false,
      Date.now(),
    );
    const early = await within(completion, PAUSE_MS);

    expect(await resume(holder, go)).toBe(0);
    const completed = await completion;

    expect(early).toBe("pending");
    // The worker still held the job when the patch let go, so it completed
    // it, and the completion was not written over by the patch.
    expect(completed).toBe(true);
    const job = await driver.getJob(q, "job");
    expect(job?.state).toBe("completed");
    expect(job?.data).toEqual({ by: "holder" });
    expect(await markers(root, q)).toHaveLength(1);
  }, 30_000);

  it("is waited out by a progress report on its job", async () => {
    const { root, driver, q } = await setup();
    expect((await claim(driver, q))?.id).toBe("job");
    const go = join(root, "go");
    const holder = await startHolder(root, q, { data: { by: "holder" } }, go);

    process.kill(holder.proc.pid, "SIGSTOP");

    const report = driver.updateProgress(q, "job", 50);
    const early = await within(report, LONG_PAUSE_MS);

    expect(await resume(holder, go)).toBe(0);

    expect(early).toBe("pending");
    expect(await report).toBe(true);
    const job = await driver.getJob(q, "job");
    expect(job?.progress).toBe(50);
    expect(job?.data).toEqual({ by: "holder" });
    expect(await markers(root, q)).toHaveLength(1);
  }, 30_000);
});

describe("file driver: a held marker is still the queue's", () => {
  it("is counted as due and walked by a rewrite while it is held", async () => {
    const { root, driver, q } = await setup({
      state: "delayed",
      runAt: Date.now() - 1_000,
    });
    const go = join(root, "go");
    const holder = await startHolder(root, q, { data: { by: "holder" } }, go);
    process.kill(holder.proc.pid, "SIGSTOP");

    // Out of the index, in this host's directory under `held/`.
    expect(await markers(root, q)).toEqual([]);
    expect(await holds(root, q)).toHaveLength(1);
    const demand = await driver.countDemand(q, Date.now(), { cap: 100 });
    const walk = await driver.rewritePendingOptions(q, {
      states: ["delayed"],
      values: { attempts: 4 },
      cursor: null,
      limit: 100,
      includeUnmarked: true,
      dryRun: true,
      now: Date.now(),
    });

    expect(await resume(holder, go)).toBe(0);

    expect(demand.dueNow).toBe(1);
    expect(walk.examined).toBe(1);
  }, 30_000);
});

describe("file driver: a hold nobody holds any more", () => {
  it("is healed once its holder has died", async () => {
    const { root, driver, q } = await setup();
    const holder = await startHolder(root, q, { priority: 7 });

    process.kill(holder.proc.pid, "SIGKILL");
    await holder.exited;

    const started = Date.now();
    expect(await driver.removeJob(q, "job")).toBe(true);
    // The stale time and a little, not the live-holder ceiling.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await markers(root, q)).toEqual([]);
    expect(await holds(root, q)).toEqual([]);
  }, 30_000);

  it("is healed when its holder's process is alive but has held it for over ten seconds", async () => {
    const { root, driver, q } = await setup();
    const holder = await startHolder(root, q, { priority: 7 });
    process.kill(holder.proc.pid, "SIGSTOP");

    // The same hold, dated eleven seconds back: a live process id holding a
    // marker that long is a dead holder whose id was reused.
    const [held] = await holds(root, q);
    const dir = join(queueDir(root, q), "held");
    // `<stamp>-<pid>.<state>.<marker>`: only the stamp changes, so it still
    // names the holder, whose process is alive.
    const name = held.split("/").at(-1)!;
    expect(name).toMatch(/^\d+-[0-9a-z]+\./);
    const older = `${Date.now() - 11_000}${name.slice(name.indexOf("-"))}`;
    await rename(
      join(dir, held),
      join(dir, held.slice(0, -name.length), older),
    );

    await driver.recoverStalled(q, Date.now(), 1, 100);

    expect(await holds(root, q)).toEqual([]);
    expect(await markers(root, q)).toHaveLength(1);
    expect((await claim(driver, q))?.id).toBe("job");
  }, 30_000);

  it("is healed by its age when its holder is on another host", async () => {
    const { root, driver, q } = await setup();
    const holder = await startHolder(root, q, { priority: 7 });
    process.kill(holder.proc.pid, "SIGSTOP");

    // The same live holder's hold, as one taken on a host whose process ids
    // mean nothing here: only its age says anything about it.
    const [held] = await holds(root, q);
    const dir = join(queueDir(root, q), "held");
    // `<host>/<stamp>-<pid>.<state>.<marker>`: the same name, another host.
    const parts = held.split("/");
    expect(parts).toHaveLength(2);
    await mkdir(join(dir, "helsewhere"));
    await rename(join(dir, held), join(dir, "helsewhere", parts[1]));

    await Bun.sleep(1_500);
    await driver.recoverStalled(q, Date.now(), 1, 100);

    expect(await holds(root, q)).toEqual([]);
    expect(await markers(root, q)).toHaveLength(1);
  }, 30_000);
  it("tidies another host's empty directory away once it has gone quiet", async () => {
    const { root, driver, q } = await setup();
    const holder = await startHolder(root, q, { priority: 7 });
    const [held] = await holds(root, q);
    const ours = held.split("/")[0];
    process.kill(holder.proc.pid, "SIGKILL");
    await holder.exited;

    const dir = join(queueDir(root, q), "held");
    await mkdir(join(dir, "hquiet"));
    await mkdir(join(dir, "hbusy"));
    const past = (Date.now() - 11_000) / 1000;
    await utimes(join(dir, "hquiet"), past, past);
    await utimes(join(dir, ours), past, past);

    await Bun.sleep(1_100);
    await driver.recoverStalled(q, Date.now(), 1, 100);

    // The dead holder's hold is healed; the quiet host's empty directory goes,
    // a host that touched its own lately keeps it, and this host keeps its.
    expect(await holds(root, q)).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual(["hbusy", ours].sort());
  }, 30_000);
});
