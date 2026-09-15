import type { JobRecord } from "../lib/drivers/driver";
import { afterAll, describe, expect, it } from "bun:test";
import {
  decodeName,
  decodeSegment,
  encodeName,
  encodeSegment,
} from "../lib/drivers/file-names";
import { FileDriver } from "../lib/index";
import { compareCodePoints } from "../lib/shared/strings";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";
import { driverContract } from "./helpers/driverContract";

/**
 * The file driver against the shared contract, plus the guarantees that are
 * specific to a filesystem: markers healing after a crash, and one directory
 * per namespace.
 */

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

driverContract("file", async () => {
  const tmp = await makeTmpDir("bun-jobs-contract");
  cleanups.push(tmp.cleanup);
  return { driver: new FileDriver({ root: tmp.path }) };
});

describe("file driver: records written before flows", () => {
  it("reads a record with no flow key as flow: null, however it is read", async () => {
    const tmp = await makeTmpDir("bun-jobs-legacy-flow");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();

    try {
      const q = { ns: testNamespace(), queue: "legacy" };
      const now = Date.now();
      // Stored exactly as an older version wrote it: no `flow` key at all.
      const { flow: _flow, ...legacy } = makeJob({ id: "old", runAt: now });
      await driver.addJob(q, legacy as JobRecord);

      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const onDisk = JSON.parse(
        await readFile(
          join(tmp.path, q.ns, "queues", q.queue, "jobs", "old.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      // Without this the test would prove nothing: the key must be absent.
      expect("flow" in onDisk).toBe(false);

      expect((await driver.getJob(q, "old"))?.flow).toBeNull();

      const listed = await driver.listJobs(q, ["waiting"], {
        offset: 0,
        limit: 10,
        order: "asc",
      });
      expect(listed.map((job) => job.flow)).toEqual([null]);

      const again = await driver.addJob(q, legacy as JobRecord);
      expect(again.added).toBe(false);
      expect(again.job.flow).toBeNull();

      const claimed = await driver.claimJob(q, {
        workerId: "w1",
        token: "t1",
        lockMs: 1000,
        now,
      });
      expect(claimed?.flow).toBeNull();

      // A write through the driver fills it in, so the next read needs no help.
      expect(
        await driver.completeJob(q, "old", "t1", "done", false, Date.now()),
      ).toBe(true);
      expect((await driver.getJob(q, "old"))?.flow).toBeNull();
    } finally {
      await driver.close();
    }
  });
});

describe("file driver: filesystem specifics", () => {
  it("heals an index marker whose record is gone", async () => {
    const tmp = await makeTmpDir("bun-jobs-heal");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();

    const q = { ns: testNamespace(), queue: "healing" };
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "ghost", runAt: now }));

    // Simulate a crash between the record write and the marker write by
    // deleting the record out from under the index.
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(tmp.path, q.ns, "queues", q.queue, "jobs", "ghost.json"));

    // The claim must skip and clean up rather than hand out a broken job.
    expect(
      await driver.claimJob(q, {
        workerId: "w1",
        token: "t1",
        lockMs: 1000,
        now,
      }),
    ).toBeNull();
    expect((await driver.countJobs(q)).waiting).toBe(0);

    await driver.close();
  });

  it("gives each namespace its own directory", async () => {
    const tmp = await makeTmpDir("bun-jobs-ns");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();

    const first = testNamespace("alpha");
    const second = testNamespace("beta");
    await driver.addJob({ ns: first, queue: "shared" }, makeJob({ id: "x" }));
    await driver.addJob({ ns: second, queue: "shared" }, makeJob({ id: "x" }));

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tmp.path);
    expect(entries).toContain(first);
    expect(entries).toContain(second);

    await driver.purge(first);
    expect(await readdir(tmp.path)).not.toContain(first);
    expect(
      await driver.getJob({ ns: second, queue: "shared" }, "x"),
    ).not.toBeNull();

    await driver.close();
  });

  it("keeps claim order across a restart", async () => {
    const tmp = await makeTmpDir("bun-jobs-order");
    cleanups.push(tmp.cleanup);

    const ns = testNamespace();
    const q = { ns, queue: "ordered" };
    const now = Date.now();

    const first = new FileDriver({ root: tmp.path });
    await first.connect();
    await first.addJobs(q, [
      makeJob({ id: "a", priority: 0, createdAt: now, runAt: now }),
      makeJob({ id: "b", priority: -1, createdAt: now + 1, runAt: now }),
      makeJob({ id: "c", priority: 0, createdAt: now + 2, runAt: now }),
    ]);
    await first.close();

    // A different instance — a restarted process — sees the same order,
    // because the order lives in the index file names.
    const second = new FileDriver({ root: tmp.path });
    await second.connect();

    const claimed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const job = await second.claimJob(q, {
        workerId: "w",
        token: `t${i}`,
        lockMs: 5000,
        now,
      });
      if (job) {
        claimed.push(job.id);
      }
    }

    expect(claimed).toEqual(["b", "a", "c"]);
    await second.close();
  });
});

describe("file driver: promotion racing a claim", () => {
  /**
   * A job must survive being promoted while someone else is claiming.
   *
   * Promotion has two steps — move the marker out of `failed` into `waiting`,
   * and rewrite the record — and between them the marker says `waiting` while
   * the record still says `failed`. That is indistinguishable from the litter
   * a crash leaves behind, and claiming used to delete such a marker. The
   * record itself was untouched, so the job ended up in no index at all: gone,
   * silently, with no error anywhere.
   *
   * The cross-process retry suite found this as jobs that never completed, and
   * spent 45 seconds timing out on each before saying so.
   *
   * The half-promoted state is built directly rather than raced for, because a
   * race that reproduces once in twenty runs is not a regression test.
   */
  it("does not delete the marker of a half-promoted job", async () => {
    const tmp = await makeTmpDir("bun-jobs-race");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "raced" };
    const now = Date.now();

    // A job mid-retry: failed, with its backoff already elapsed.
    await driver.addJob(
      q,
      makeJob({ id: "mid", state: "failed", runAt: now - 1000 }),
    );

    const { readdir, rename } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const index = join(tmp.path, q.ns, "queues", q.queue, "index");

    // Step one of a promotion, and only step one.
    const [marker] = await readdir(join(index, "failed"));
    await rename(
      join(index, "failed", marker!),
      join(index, "waiting", marker!),
    );

    // The claim heals it forward rather than skipping it: the record's time
    // has come, so the only thing between it and `waiting` was a write this
    // claim is about to make anyway.
    const claimed = await driver.claimJob(q, {
      workerId: "w1",
      token: "t1",
      lockMs: 5000,
      now,
    });

    expect(claimed?.id).toBe("mid");

    // And the marker moved on to `active` rather than being deleted, which is
    // what used to strand the record in no index at all.
    expect(await readdir(join(index, "waiting"))).toEqual([]);
    expect((await readdir(join(index, "active"))).length).toBe(1);
    expect((await driver.countJobs(q)).active).toBe(1);

    await driver.purge(q.ns);
    await driver.close();
  });
});

describe("file driver: a job changed or logged across a crash", () => {
  /**
   * The contract test sees a forgotten log only when the re-added job happens
   * to read the same file. A removal path that forgot it while the file name
   * differed would leak silently, so this looks at the disk itself.
   */
  it("leaves no log file behind, however the job goes", async () => {
    const tmp = await makeTmpDir("bun-jobs-log-files");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "log-files" };
    const now = Date.now();

    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const logs = join(tmp.path, q.ns, "queues", q.queue, "logs");
    const remaining = async () =>
      await readdir(logs).catch(() => [] as string[]);

    /** Adds a logged job, removes it with `remove`, and expects no log file. */
    async function removedWithoutTrace(
      id: string,
      remove: () => Promise<unknown>,
    ) {
      await driver.addJob(q, makeJob({ id, runAt: now }));
      expect(await driver.addJobLog(q, id, `line for ${id}`, 0)).toBe(1);
      expect(await remaining()).toHaveLength(1);

      await remove();

      expect(await driver.getJob(q, id)).toBeNull();
      expect(await remaining()).toEqual([]);
    }

    const claim = async () => {
      const token = `t-${Math.random()}`;
      await driver.claimJob(q, { workerId: "w", token, lockMs: 30_000, now });
      return token;
    };

    await removedWithoutTrace("removed", () => driver.removeJob(q, "removed"));
    await removedWithoutTrace("drained", () => driver.drainQueue(q, true));
    await removedWithoutTrace("completed", async () => {
      await driver.completeJob(q, "completed", await claim(), null, true, now);
    });
    await removedWithoutTrace("dead", async () => {
      await driver.failJob(
        q,
        "dead",
        await claim(),
        { name: "Error", message: "boom" },
        { retry: false, retention: true },
        now,
        1,
      );
    });
    await removedWithoutTrace("cleaned", async () => {
      await driver.completeJob(q, "cleaned", await claim(), null, false, now);
      await driver.cleanJobs(q, "completed", 0, 100, now + 1);
    });
    await removedWithoutTrace("expired", async () => {
      await driver.completeJob(
        q,
        "expired",
        await claim(),
        null,
        { ttl: 1 },
        now,
      );
      await driver.pruneExpired(q, now + 1_000, 100);
    });
    await removedWithoutTrace("capped", async () => {
      await driver.completeJob(q, "capped", await claim(), null, 0, now);
    });

    await driver.purge(q.ns);
    await driver.close();
  });

  /**
   * `updateJob` moves a job's marker out of the index while it rewrites the
   * record. A process that dies holding it must not take the job with it: the
   * hold is filed by whatever the record says once it is old enough to be
   * abandoned.
   */
  it("files a marker held by a process that died", async () => {
    const tmp = await makeTmpDir("bun-jobs-hold");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "held" };
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "orphan", runAt: now }));

    const { mkdir, readdir, rename } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(tmp.path, q.ns, "queues", q.queue);
    const [marker] = await readdir(join(dir, "index", "waiting"));

    // A hold taken two seconds ago by a process that never came back.
    await mkdir(join(dir, "held"), { recursive: true });
    await rename(
      join(dir, "index", "waiting", marker!),
      join(dir, "held", `${Date.now() - 2_000}.waiting.${marker}`),
    );
    expect((await driver.countJobs(q)).waiting).toBe(0);

    await driver.recoverStalled(q, now, 1, 100);

    expect(await readdir(join(dir, "held"))).toEqual([]);
    const claimed = await driver.claimJob(q, {
      workerId: "w",
      token: "t",
      lockMs: 30_000,
      now,
    });
    expect(claimed?.id).toBe("orphan");

    await driver.purge(q.ns);
    await driver.close();
  });

  /**
   * A claim renames the marker into `active` before it writes the record, so
   * a crash between the two leaves an active marker over a waiting record.
   * Once the lock that claim would have held expires, the job goes back.
   */
  it("returns a job whose claim died before writing the record", async () => {
    const tmp = await makeTmpDir("bun-jobs-half-claim");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "half-claimed" };
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "half", runAt: now }));

    const { readdir, rename } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const index = join(tmp.path, q.ns, "queues", q.queue, "index");
    const [marker] = await readdir(join(index, "waiting"));

    // Step one of a claim with a 1s lock, and only step one.
    await rename(
      join(index, "waiting", marker!),
      join(index, "active", `${String(now + 1_000).padStart(13, "0")}-half`),
    );

    // Not while the lock could still be live...
    await driver.recoverStalled(q, now, 1, 100);
    expect((await driver.countJobs(q)).active).toBe(1);

    // ...but once it has expired, the marker goes back where the record says.
    await driver.recoverStalled(q, now + 2_000, 1, 100);
    expect(await driver.countJobs(q)).toMatchObject({ waiting: 1, active: 0 });
    expect(
      (
        await driver.claimJob(q, {
          workerId: "w",
          token: "t",
          lockMs: 30_000,
          now,
        })
      )?.id,
    ).toBe("half");

    await driver.purge(q.ns);
    await driver.close();
  });

  it("lets a completion through while its job is being patched", async () => {
    const tmp = await makeTmpDir("bun-jobs-patch-active");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "patched-active" };
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "busy", runAt: now, data: { v: 1 } }));
    const claimed = await driver.claimJob(q, {
      workerId: "w",
      token: "t",
      lockMs: 30_000,
      now,
    });
    expect(claimed?.id).toBe("busy");

    // Many patches racing one completion: the completion must succeed rather
    // than read a held or renamed marker as a lost lock, and the job must end
    // up completed with its marker in `completed`.
    const patches = Array.from({ length: 20 }, async (_, v) => {
      return await driver.updateJob(q, "busy", { data: { v } }, now);
    });
    const [completed] = await Promise.all([
      driver.completeJob(q, "busy", "t", "done", false, now),
      ...patches,
    ]);

    expect(completed).toBe(true);
    expect((await driver.getJob(q, "busy"))?.state).toBe("completed");
    expect(await driver.countJobs(q)).toMatchObject({
      active: 0,
      completed: 1,
    });

    await driver.purge(q.ns);
    await driver.close();
  });
});

describe("file driver: removal and writes racing a patch", () => {
  /** Every path under the queue directory that names `id`. */
  async function traces(
    root: string,
    q: { ns: string; queue: string },
    id: string,
  ) {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const entries = await readdir(join(root, q.ns, "queues", q.queue), {
      recursive: true,
    });
    return entries.filter((entry) => entry.includes(id));
  }

  /**
   * A removal used to delete the marker and the record directly. Landing while
   * `updateJob` held the marker, it deleted a record the patch then wrote back:
   * a removed job, returned, with no marker — in no index, and never claimed.
   */
  it("keeps a removed job removed, however many patches race it", async () => {
    const tmp = await makeTmpDir("bun-jobs-remove-race");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "remove-race" };
    const now = Date.now();

    for (let round = 0; round < 25; round++) {
      const id = `r${round}x`;
      await driver.addJob(q, makeJob({ id, runAt: now, data: { v: -1 } }));
      await driver.addJobLog(q, id, "before", 0);

      const patch = (v: number) =>
        v % 3 === 0
          ? driver.updateJob(q, id, { runAt: now + 60_000, data: { v } }, now)
          : v % 3 === 1
            ? driver.updateJob(q, id, { priority: v }, now)
            : driver.updateJob(q, id, { runAt: now, data: { v } }, now);

      const racers: Promise<unknown>[] = [];
      let removed: Promise<boolean> | undefined;

      for (let v = 0; v < 30; v++) {
        if (v === 15) {
          removed = driver.removeJob(q, id);
          racers.push(removed);
        }
        racers.push(patch(v), driver.addJobLog(q, id, `line ${v}`, 5));
      }

      await Promise.all(racers);

      expect(await removed).toBe(true);
      expect(await driver.getJob(q, id)).toBeNull();
      // No record, no marker in any index, no hold, no log.
      expect(await traces(tmp.path, q, id)).toEqual([]);
    }

    expect(await driver.countJobs(q)).toMatchObject({ waiting: 0, delayed: 0 });

    await driver.purge(q.ns);
    await driver.close();
  });

  /**
   * `updateProgress` was a read and a write with nothing around it, which was
   * safe while nothing else rewrote an active record. `updateJob` does, and
   * each could write the other's change away.
   */
  it("loses neither a progress report nor a patch that races it", async () => {
    const tmp = await makeTmpDir("bun-jobs-progress-race");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "progress-race" };
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "busy", runAt: now }));
    await driver.claimJob(q, {
      workerId: "w",
      token: "t",
      lockMs: 30_000,
      now,
    });

    for (let round = 0; round < 30; round++) {
      const [progressed, patched] = await Promise.all([
        driver.updateProgress(q, "busy", { round }),
        driver.updateJob(q, "busy", { data: { round } }, now),
      ]);
      expect(progressed).toBe(true);
      expect(patched).not.toBeNull();

      const job = await driver.getJob(q, "busy");
      expect(job?.progress).toEqual({ round });
      expect(job?.data).toEqual({ round });
    }

    // And the marker still agrees with the record, so the holder can finish.
    expect(await driver.completeJob(q, "busy", "t", null, false, now)).toBe(
      true,
    );
    expect(await driver.countJobs(q)).toMatchObject({
      active: 0,
      completed: 1,
    });

    await driver.purge(q.ns);
    await driver.close();
  });
});

describe("file driver: waiting for work that is already there", () => {
  /**
   * A job added before the wait starts must not cost a full poll interval.
   *
   * `waitForJob` watches a `wake` file for a change, and the snapshot it
   * compares against is taken when the wait begins. A job that lands between a
   * claim coming back empty and the wait starting has already touched `wake`,
   * so the snapshot is of the *new* value and nothing changes it again — the
   * worker then sleeps out its whole budget with a claimable job sitting in
   * the queue.
   *
   * That is the round-trip p90 of 1001ms against a p50 of 1.69ms: a lost
   * wakeup, and `DEFAULT_POLL_INTERVAL` is exactly 1,000ms.
   */
  it("returns at once when a job is already waiting", async () => {
    const tmp = await makeTmpDir("bun-jobs-wake");
    const driver = new FileDriver({ root: tmp.path });

    try {
      const q = { ns: testNamespace(), queue: "already-there" };
      await driver.ensureQueue(q);

      // Exactly the order that loses the wakeup: the job lands, touching
      // `wake`, and only then does anybody wait.
      await driver.addJob(q, makeJob({ id: "present" }));

      const started = performance.now();
      await driver.waitForJob(q, 1_000);
      const waited = performance.now() - started;

      // Generous, because the point is the difference between "noticed" and
      // "slept the whole budget", not a precise timing.
      expect(waited).toBeLessThan(250);
    } finally {
      await driver.close();
      await tmp.cleanup();
    }
  }, 15_000);
});

describe("file driver: listing queue state after a crash", () => {
  /**
   * The state directory holds more than entries: the lock beside each one,
   * a lock being broken, and the temp file of an atomic write. A crash can
   * leave any of them behind with no entry, and a sweep that lists one would
   * go looking for an entry that does not exist, every time, for good.
   */
  it("lists neither a leftover temp file nor an orphaned lock", async () => {
    const tmp = await makeTmpDir("bun-jobs-state-list");
    const driver = new FileDriver({ root: tmp.path });

    try {
      const q = { ns: testNamespace(), queue: "state-leftovers" };
      await driver.ensureQueue(q);
      // Names that themselves end in the suffixes being skipped must survive.
      await driver.setQueueState(q, "debounce:live", {}, null);
      await driver.setQueueState(q, "debounce:x.lock", {}, null);
      await driver.setQueueState(q, "debounce:y.tmp", {}, null);

      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const dir = join(tmp.path, q.ns, "queues", q.queue, "state");
      const gone = encodeName("debounce:gone");

      // Exactly the shapes the driver writes: a crashed `#writeAtomic`, a
      // crashed compare-and-set's lock, and a lock renamed aside to break it.
      await writeFile(join(dir, `${gone}.json.${process.pid}.abc.tmp`), "{}");
      await writeFile(join(dir, `${gone}.lock`), String(Date.now()));
      await writeFile(join(dir, `${gone}.lock.abc.stale`), String(Date.now()));

      expect(
        await driver.listQueueState(q, { prefix: "debounce:", limit: 10 }),
      ).toEqual(["debounce:live", "debounce:x.lock", "debounce:y.tmp"]);
    } finally {
      await driver.close();
      await tmp.cleanup();
    }
  });

  it("answers [] for a queue with no state directory", async () => {
    const tmp = await makeTmpDir("bun-jobs-state-none");
    const driver = new FileDriver({ root: tmp.path });

    try {
      const q = { ns: testNamespace(), queue: "never-stated" };
      expect(await driver.listQueueState(q, { prefix: "", limit: 10 })).toEqual(
        [],
      );
    } finally {
      await driver.close();
      await tmp.cleanup();
    }
  });
});

/**
 * Every way a case-insensitive or normalization-insensitive filesystem could
 * see two of our file names as one. macOS folds case and normalization, Windows
 * folds case; Linux does neither, so a collision is invisible here unless the
 * names themselves are checked.
 */
const FOLDS: [string, (value: string) => string][] = [
  ["lowercase", (value) => value.toLowerCase()],
  ["uppercase", (value) => value.toUpperCase()],
  ["NFC + lowercase", (value) => value.normalize("NFC").toLowerCase()],
  ["NFD + lowercase", (value) => value.normalize("NFD").toLowerCase()],
  ["NFKC + lowercase", (value) => value.normalize("NFKC").toLowerCase()],
];

/** Names that differ only in ways some filesystem ignores. */
const LOOKALIKES: [string, string][] = [
  ["Report", "report"],
  ["REPORT", "report"],
  ["Report", "REPORT"],
  ["A", "a"],
  ["Z", "z"],
  ["Mail:Welcome", "mail:welcome"],
  ["résumé", "resume"],
  ["é", "é"], // é precomposed, and e + combining acute
  ["É", "é"], // É and é
  ["Å", "Å"], // Å and the angstrom sign
  ["ﬁ", "fi"], // the fi ligature
  ["ǅ", "ǆ"], // titlecase and lowercase dž
  ["İ", "i"], // dotted capital I
  ["ß", "ss"],
  ["\u{1F600}", "\uD83D"], // an emoji, and its lone high surrogate
];

describe("file driver: names on a case-insensitive filesystem", () => {
  it("encodes lookalike names to files no fold can merge", () => {
    for (const [left, right] of LOOKALIKES) {
      const a = encodeName(left);
      const b = encodeName(right);

      for (const [fold, apply] of FOLDS) {
        if (apply(a) === apply(b)) {
          throw new Error(`${fold} merges ${a} (${left}) and ${b} (${right})`);
        }
      }

      expect(decodeName(a)).toBe(left);
      expect(decodeName(b)).toBe(right);
    }
  });

  it("round-trips every UTF-16 unit, emoji included, and stays fold-proof", () => {
    const encodings = new Set<string>();

    for (let unit = 0; unit <= 0xffff; unit++) {
      const name = String.fromCharCode(unit);
      const encoded = encodeName(name);

      if (decodeName(encoded) !== name) {
        throw new Error(`U+${unit.toString(16)} does not round-trip`);
      }
      encodings.add(encoded.toLowerCase().normalize("NFKC"));
    }

    // Every one of the 65,536 still distinct once folded.
    expect(encodings.size).toBe(0x10000);

    for (const name of ["\u{1F600}", "a\u{10FFFF}b", "\u{10000}", "x\uDC00y"]) {
      expect(decodeName(encodeName(name))).toBe(name);
    }
  });

  it("writes only characters no filesystem folds or treats as a separator", () => {
    for (const name of [
      ...LOOKALIKES.flat(),
      "order-42.retry",
      "a/b\\c",
      "  trailing. ",
      "CON",
    ]) {
      // Lowercase ASCII, digits and the three escape characters: no letter to
      // fold, nothing to normalize, and no `-` or `.` to split a marker on.
      expect(encodeName(name)).toMatch(/^[0-9a-z%_~]*$/);
    }
  });

  it("keeps the code-point order of the names it encodes", () => {
    const alphabet = [
      " ",
      "!",
      "-",
      ".",
      "/",
      "0",
      "9",
      ":",
      "@",
      "A",
      "Z",
      "[",
      "_",

      "`",
      "a",
      "z",
      "{",
      "~",
      "",
      "",
      "é",
      "߿",

      "ࠀ",
      "퟿",
      "",
      "￿",
      "\u{10000}",
      "\u{1F600}",

      "\u{10FFFF}",
    ];
    // Park–Miller: the product stays below 2^53, so every step is exact. A
    // multiplier near 2^30 loses bits in a double and falls into a short
    // cycle, and the loop below then never collects enough names.
    let seed = 7;
    const random = (limit: number) => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % limit;
    };

    const names = new Set<string>(alphabet);
    while (names.size < 3_000) {
      let name = "";
      for (let length = random(5); length >= 0; length--) {
        name += alphabet[random(alphabet.length)];
      }
      names.add(name);
    }

    const byName = [...names].sort(compareCodePoints).map(encodeName);
    // The default sort is what a directory of encoded names is sorted with.
    expect(byName.toSorted()).toEqual(byName);
  });

  it("refuses a file name the encoder could not have written", () => {
    for (const foreign of [
      "Report", // uppercase is never literal
      "a.b",
      "a-b",
      "%zz",
      "%41", // `A` is written `_a`
      "_",
      "_7",
      "~c3", // a truncated sequence
      "~c1~81", // an overlong `A`
      "~ed~a0~bd~ed~b8~80", // a pair written as two halves
    ]) {
      expect(decodeName(foreign)).toBeNull();
    }

    for (const foreign of ["Mail", "^", "^A", "~41", "a/b"]) {
      expect(decodeSegment(foreign)).toBeNull();
    }
  });

  it("keeps queue and namespace directories readable, and apart by case", () => {
    // What `assertSegment` allows, lowercase: exactly as typed.
    for (const segment of ["orders", "t-0199a8c2-1b2e", "mail_v2.retry"]) {
      expect(encodeSegment(segment)).toBe(segment);
    }

    for (const [left, right] of [
      ["Mail", "mail"],
      ["MAIL", "mail"],
      ["Orders-EU", "orders-eu"],
      ["résumé", "resume"],
      ["é", "é"],
    ]) {
      const a = encodeSegment(left!);
      const b = encodeSegment(right!);

      for (const [fold, apply] of FOLDS) {
        if (apply(a) === apply(b)) {
          throw new Error(`${fold} merges ${a} and ${b}`);
        }
      }

      expect(decodeSegment(a)).toBe(left!);
      expect(decodeSegment(b)).toBe(right!);
    }

    expect(encodeSegment("Mail")).toBe("^mail");
  });

  /**
   * The driver has no seam for swapping its filesystem — every path goes
   * straight to `node:fs` — so this cannot run it against a case-folding one.
   * It checks the property that makes the fold harmless instead: after
   * writing every kind of name the driver turns into a file, in lookalike
   * pairs, no directory holds two entries that any fold would merge.
   */
  it("leaves no two files on disk that a folding filesystem would merge", async () => {
    const tmp = await makeTmpDir("bun-jobs-fold");
    const driver = new FileDriver({ root: tmp.path });

    try {
      const base = testNamespace();
      const variants = [
        "Report",
        "report",
        "REPORT",
        "résumé",
        "resume",
        "résumé",
      ];
      const now = Date.now();

      for (const ns of [`${base}-A`, `${base}-a`]) {
        for (const queue of ["Mail", "mail"]) {
          const q = { ns, queue };

          for (const id of variants) {
            expect(
              (await driver.addJob(q, makeJob({ id, runAt: now }))).added,
            ).toBe(true);
            expect(await driver.addJobLog(q, id, `log of ${id}`, 0)).toBe(1);
            expect(await driver.setQueueState(q, id, { id }, null)).toBe(1);
          }

          // Waiting, active and completed markers, and a delayed one.
          const claimed = await driver.claimJob(q, {
            workerId: "w",
            token: "t",
            lockMs: 30_000,
            now,
          });
          await driver.completeJob(q, claimed!.id, "t", null, false, now);
          await driver.claimJob(q, {
            workerId: "w",
            token: "t2",
            lockMs: 30_000,
            now,
          });
          await driver.updateJob(
            q,
            variants.at(-1)!,
            { runAt: now + 60_000 },
            now,
          );

          for (const id of variants) {
            expect((await driver.getJob(q, id))?.id).toBe(id);
            expect((await driver.getQueueState(q, id))?.value).toEqual({ id });
            expect(
              (
                await driver.getJobLogs(q, id, {
                  offset: 0,
                  limit: 5,
                  order: "asc",
                })
              ).logs,
            ).toEqual([`log of ${id}`]);
          }
          expect(
            await driver.listQueueState(q, { prefix: "", limit: 20 }),
          ).toEqual(variants.toSorted(compareCodePoints));
        }

        for (const runner of ["r:Nightly", "r:nightly"]) {
          expect(await driver.acquireLock(ns, runner, "t", 30_000, now)).toBe(
            true,
          );
        }
        expect((await driver.listQueues(ns)).toSorted()).toEqual([
          "Mail",
          "mail",
        ]);
        expect((await driver.listRunners(ns)).toSorted()).toEqual([
          "Nightly",
          "nightly",
        ]);
      }

      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(tmp.path, { recursive: true });
      expect(entries.length).toBeGreaterThan(50);

      for (const [fold, apply] of FOLDS) {
        const seen = new Map<string, string>();
        for (const entry of entries) {
          const folded = apply(entry);
          const clash = seen.get(folded);
          if (clash !== undefined) {
            throw new Error(`${fold} merges ${clash} and ${entry}`);
          }
          seen.set(folded, entry);
        }
      }

      // No uppercase letter and nothing outside ASCII anywhere below the root.
      for (const entry of entries) {
        expect(entry).toMatch(/^[\x21-\x7E]*$/);
        expect(entry).not.toMatch(/[A-Z]/);
      }
    } finally {
      await driver.close();
      await tmp.cleanup();
    }
  });

  /**
   * URI-encoded ids kept their dashes, so the id was found by guessing how
   * many numeric prefixes a marker had. A delayed job whose id began with
   * digits and a dash looked like a waiting marker, and lost its first part.
   */
  it("finds a job whose id looks like a marker prefix", async () => {
    const tmp = await makeTmpDir("bun-jobs-marker-id");
    const driver = new FileDriver({ root: tmp.path });

    try {
      const q = { ns: testNamespace(), queue: "marker-ids" };
      const now = Date.now();
      const id = "1700000000000-abc";

      await driver.addJob(q, makeJob({ id, state: "delayed", runAt: now - 1 }));
      expect(
        (
          await driver.listJobs(q, ["delayed"], {
            offset: 0,
            limit: 5,
            order: "asc",
          })
        ).map((job) => job.id),
      ).toEqual([id]);
      expect(await driver.promoteDelayed(q, now, 10)).toBe(1);

      const claimed = await driver.claimJob(q, {
        workerId: "w",
        token: "t",
        lockMs: 30_000,
        now,
      });
      expect(claimed?.id).toBe(id);
    } finally {
      await driver.close();
      await tmp.cleanup();
    }
  });

  it("claims ties on priority and creation time in code-point order of id", async () => {
    const tmp = await makeTmpDir("bun-jobs-tie-order");
    const driver = new FileDriver({ root: tmp.path });

    try {
      const q = { ns: testNamespace(), queue: "ties" };
      const now = Date.now();
      const ids = ["\u{1F600}", "￿", "z", "é", "", "Y", "b", " ", "-"];

      for (const id of ids) {
        await driver.addJob(
          q,
          makeJob({ id, createdAt: now, runAt: now, priority: 0 }),
        );
      }

      const claimed: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        const job = await driver.claimJob(q, {
          workerId: "w",
          token: `t${i}`,
          lockMs: 30_000,
          now,
        });
        claimed.push(job!.id);
      }

      expect(claimed).toEqual(ids.toSorted(compareCodePoints));
    } finally {
      await driver.close();
      await tmp.cleanup();
    }
  });
});

describe("file driver: read API files", () => {
  /** Adds a job, claims it and completes it at `now` through `driver`. */
  async function completeOne(
    driver: FileDriver,
    q: { ns: string; queue: string },
    id: string,
    now: number,
  ): Promise<void> {
    await driver.addJob(q, makeJob({ id, createdAt: now - 1, runAt: now - 1 }));
    const claimed = await driver.claimJob(q, {
      workerId: "w",
      token: `t-${id}`,
      lockMs: 60_000,
      now,
    });
    expect(claimed?.id).toBe(id);
    expect(await driver.completeJob(q, id, `t-${id}`, null, false, now)).toBe(
      true,
    );
  }

  it("flushes counts on close, and sums every process's lines for a minute", async () => {
    const tmp = await makeTmpDir("bun-jobs-throughput-files");
    cleanups.push(tmp.cleanup);
    const q = { ns: testNamespace(), queue: "tp" };
    const now = Date.now();
    const minute = Math.floor(now / 60_000) * 60_000;

    const first = new FileDriver({ root: tmp.path });
    const second = new FileDriver({ root: tmp.path });
    await completeOne(first, q, "a", now);
    await completeOne(second, q, "b", now);
    await completeOne(second, q, "c", now);

    // Nothing is written per job: counting is in memory until a flush.
    const { readdir, readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(tmp.path, q.ns, "queues", q.queue, "throughput");
    expect(await readdir(dir).catch(() => [])).toEqual([]);

    await first.close();
    await second.close();

    const lines = (await readFile(join(dir, `${minute}.jsonl`), "utf8"))
      .split("\n")
      .filter(Boolean);
    // One line per process, never one per job.
    expect(lines).toHaveLength(2);

    // Litter next to the buckets is not a bucket.
    await writeFile(join(dir, `${minute}.jsonl.123.tmp`), '{"completed":99}\n');
    await writeFile(join(dir, "notes.jsonl"), '{"completed":99}\n');

    const reader = new FileDriver({ root: tmp.path });
    try {
      expect(
        await reader.getThroughput(q, { from: minute, to: minute }),
      ).toEqual([{ at: minute, completed: 3, failed: 0 }]);
      // Neither the bucket files nor the worker records are queues.
      await reader.registerWorker(q, {
        id: "w1",
        queue: q.queue,
        host: "h",
        pid: 1,
        concurrency: 1,
        active: 0,
        paused: false,
        startedAt: now,
        heartbeatAt: now,
        expiresAt: now + 30_000,
      });
      expect(await reader.listQueues(q.ns)).toEqual([q.queue]);
    } finally {
      await reader.close();
    }
  });

  it("deletes a lapsed worker's file and ignores files that are not records", async () => {
    const tmp = await makeTmpDir("bun-jobs-worker-files");
    cleanups.push(tmp.cleanup);
    const driver = new FileDriver({ root: tmp.path });
    const q = { ns: testNamespace(), queue: "wk" };
    const now = Date.now();
    const worker = {
      queue: q.queue,
      host: "h",
      pid: 1,
      concurrency: 1,
      active: 0,
      paused: false,
      startedAt: now,
      heartbeatAt: now,
    };

    try {
      await driver.registerWorker(q, { ...worker, id: "gone", expiresAt: now });
      await driver.registerWorker(q, {
        ...worker,
        id: "here",
        expiresAt: now + 30_000,
      });

      const { readdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const dir = join(tmp.path, q.ns, "queues", q.queue, "workers");
      const live = JSON.stringify({ ...worker, id: "x", expiresAt: now + 1e9 });
      await writeFile(join(dir, `${encodeName("x")}.json.1.tmp`), live);
      await writeFile(join(dir, `${encodeName("x")}.json.1.lapsed`), live);

      expect((await driver.listWorkers(q, now)).map((w) => w.id)).toEqual([
        "here",
      ]);
      expect((await readdir(dir)).toSorted()).toEqual(
        [
          `${encodeName("here")}.json`,
          `${encodeName("x")}.json.1.lapsed`,
          `${encodeName("x")}.json.1.tmp`,
        ].toSorted(),
      );
    } finally {
      await driver.close();
    }
  });
});
