import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  ChildOutcome,
  ChildRecordResult,
  ClaimOptions,
  DriverCapabilities,
  DriverEvent,
  EventKind,
  EventOfKind,
  FailOutcome,
  JobFlow,
  JobPage,
  JobPatch,
  JobQuery,
  JobRecord,
  JobRef,
  JobsDriver,
  JobState,
  LockInfo,
  QueuedTrigger,
  QueueRef,
  QueueStateEntry,
  RepeatRecord,
  Retention,
  RunRecord,
  ThroughputBucket,
  WorkerInfo,
} from "./driver";
import type { PendingThroughput, ThroughputWriteResult } from "./readApis";
import { Buffer } from "node:buffer";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { jsonClone, sleep } from "@kingsleyweb/bun-common";
import { assertWritableStateName } from "../queue/windows";
import { DriverError } from "../shared/errors";
import { EventRetention } from "../shared/eventRetention";
import { fitName } from "../shared/fit";
import { newId } from "../shared/ids";
import { safeJsonParse } from "../shared/json";
import { PauseCache } from "../shared/pauseCache";
import { compareCodePoints } from "../shared/strings";
import {
  decodeName,
  decodeSegment,
  encodeName,
  encodeSegment,
  MAX_ENCODED_NAME,
  NAME_MAX,
  NAME_OVERHEAD,
} from "./file-names";
import { awaitsDelivery, flowKey, listsChild, unsettledChildren } from "./flow";
import {
  jobFilter,
  matchesFilter,
  orderByIds,
  sortWorkers,
  sumBuckets,
  THROUGHPUT_RETENTION_MS,
  ThroughputBuffer,
} from "./readApis";

/**
 * A driver backed by a directory, for processes that share a filesystem.
 *
 * It exists because "several processes on one box" is the common case that
 * neither the memory driver (one process) nor Redis/SQL (a service to run)
 * serves well. Everything it guarantees comes from two POSIX primitives:
 * `open(…, "wx")`, which exactly one process can win, and `rename`, which is
 * atomic and fails with `ENOENT` for whoever arrives second. Claiming a job
 * is* renaming its index entry — the process that renames it, has it.
 *
 * Records live at a stable path and the state directories hold empty marker
 * files, so reading a job by id is one read rather than a scan, and a marker
 * that disagrees with its record (a crash between the two writes) is healed
 * on the next claim instead of corrupting anything.
 *
 * Scope: one host, or a filesystem with real POSIX semantics. Not NFS, and
 * `capabilities.multiHost` says so.
 */

/**
 * How long a write lock is respected before it is treated as abandoned.
 *
 * The critical section is one small read and one small write, so a lock held
 * for longer than this belongs to a process that is gone. Keeping it short
 * matters: a crash must not stall every other process for the whole window.
 */
const LOCK_STALE_MS = 1_000;

/** How long to keep trying for a lock that is merely contended. */
const LOCK_WAIT_MS = 15_000;

/** How long to wait between attempts at a contended write lock. */
const LOCK_RETRY_MS = 5;

/**
 * How long a transition keeps retrying a marker somebody else has moved.
 *
 * Twice `LOCK_STALE_MS`, because the marker may be held by a process that
 * died holding it, and a hold is only healed once it is older than that.
 */
const HOLD_PATIENCE_MS = LOCK_STALE_MS * 2;

/** How often `waitForJob` and event subscribers look for changes. */
const POLL_MS = 25;

/** Every job state, in the order `countJobs` reports them. */
const STATES: JobState[] = [
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "dead",
  // Its own directory, which no claim or promotion ever reads: that is the
  // whole of what keeps a parent waiting on children from running early.
  "waiting-children",
];

/** States holding a job that is due later. */
const SCHEDULED_STATES: JobState[] = ["delayed", "failed"];

/** Priorities may be negative; the offset keeps marker names sortable. */
const PRIORITY_OFFSET = 1_048_576;

/** How many waiting markers' job names a driver remembers for exclusion. */
const NAME_CACHE_SIZE = 10_000;

/** How many files a read API reads at once: job records, worker records. */
const READ_CONCURRENCY = 16;

/**
 * A throughput bucket file's name: the minute's start, in epoch milliseconds,
 * then `.jsonl`. Nothing else in `throughput/` matches, `.tmp` files included.
 */
const THROUGHPUT_FILE = /^(\d+)\.jsonl$/;

/** Options for {@link FileDriver}. */
export interface FileDriverOptions {
  /** Directory the driver owns. Created on demand. */
  root: string;
  /** How often to poll for new work and events. Defaults to 25ms. */
  pollInterval?: number;
  /**
   * How long a stored event is kept, in milliseconds.
   *
   * Defaults to an hour. Events are a live notification channel rather than an
   * audit trail, and this backend writes each one down — so without a limit
   * the log grows for as long as the queue runs. Set `0` to keep everything,
   * and prune it yourself.
   */
  eventRetentionMs?: number;
}

export class FileDriver implements JobsDriver {
  /** Identifies the implementation in errors and capability checks. */
  readonly name = "file";
  /** Decides when this driver should prune its stored events. */
  readonly #eventRetention: EventRetention;

  /**
   * Several processes on one host can share this safely. `multiHost` is
   * `false` on purpose: the guarantees rest on POSIX `rename` and `O_EXCL`,
   * which network filesystems do not reliably provide.
   */
  readonly capabilities: DriverCapabilities = {
    blockingWait: false,
    events: "poll",
    multiProcess: true,
    multiHost: false,
  };

  /** The directory this driver owns. */
  readonly root: string;
  /** How often to poll for new work and events. */
  /** Pause flags, so a claim does not read one per call. */
  readonly #pauseCache = new PauseCache();
  readonly #poll: number;
  /** Active event subscriptions, so `close()` can stop them. */
  readonly #subscriptions = new Set<() => void>();
  /**
   * Job names by waiting marker path, so a claim excluding names does not read
   * the same capped job's record on every call. A waiting marker's name holds
   * the job's `createdAt` and id, and a job's name never changes, so an entry
   * cannot go stale short of an id reused within the same millisecond — and
   * the claim checks the name again under the rename anyway. Insertion-ordered,
   * so the oldest entry goes first past {@link NAME_CACHE_SIZE}.
   */
  readonly #names = new Map<string, string>();
  /**
   * Completions and failed attempts counted in memory and appended to
   * `throughput/<minute>.jsonl` once a second, so counting a job costs a `Map`
   * update rather than a file write. Flushed by `getThroughput` and `close`.
   */
  readonly #throughput = new ThroughputBuffer(
    async (batch) => await this.#writeThroughput(batch),
  );

  constructor(options: FileDriverOptions) {
    this.root = options.root;
    this.#poll = options.pollInterval ?? POLL_MS;
    this.#eventRetention = new EventRetention(options.eventRetentionMs);
  }

  /* --- lifecycle ---------------------------------------------------- */

  async connect(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async close(): Promise<void> {
    for (const stop of this.#subscriptions) {
      stop();
    }
    this.#subscriptions.clear();
    await this.#throughput.close();
  }

  /** Writes the counts gathered in memory and not yet written. */
  async flushThroughput(): Promise<void> {
    await this.#throughput.flush();
  }

  async ping(): Promise<boolean> {
    try {
      await stat(this.root);
      return true;
    } catch {
      return false;
    }
  }

  async purge(ns: string): Promise<void> {
    // Forgotten first, then any write already in flight waited out: its
    // `mkdir` would otherwise put the queue's directory back after the `rm`.
    this.#throughput.forget(ns);
    await this.#throughput.flush().catch(() => undefined);
    await rm(join(this.root, encodeSegment(ns)), {
      recursive: true,
      force: true,
    });
  }

  async listRunners(ns: string): Promise<string[]> {
    return await this.#listSegments(
      join(this.root, encodeSegment(ns), "runners"),
    );
  }

  async listQueues(ns: string): Promise<string[]> {
    return await this.#listSegments(
      join(this.root, encodeSegment(ns), "queues"),
    );
  }

  /* --- runner: locks -------------------------------------------------- */

  async acquireLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    const dir = this.#runnerDir(ns, key);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "lock.json");
    const info: LockInfo = { token, expiresAt: now + ttlMs };

    if (await this.#createExclusive(path, JSON.stringify(info))) {
      return true;
    }

    const held = await this.#readJson<LockInfo>(path);

    // Ours already, or expired: either way we may take it.
    if (held && held.token !== token && held.expiresAt > now) {
      return false;
    }

    if (held?.token === token) {
      await this.#writeAtomic(path, JSON.stringify(info));
      return true;
    }

    // Break a stale lock by renaming it away first: exactly one process can
    // win that rename, and the loser sees ENOENT and backs off.
    const claimed = join(dir, `lock.stale-${newId()}`);
    try {
      await rename(path, claimed);
    } catch {
      return false;
    }

    await rm(claimed, { force: true });
    return await this.#createExclusive(path, JSON.stringify(info));
  }

  async renewLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    const path = join(this.#runnerDir(ns, key), "lock.json");
    const held = await this.#readJson<LockInfo>(path);

    if (!held || held.token !== token || held.expiresAt <= now) {
      return false;
    }

    await this.#writeAtomic(
      path,
      JSON.stringify({ token, expiresAt: now + ttlMs }),
    );
    return true;
  }

  async releaseLock(ns: string, key: string, token: string): Promise<boolean> {
    const path = join(this.#runnerDir(ns, key), "lock.json");
    const held = await this.#readJson<LockInfo>(path);

    if (!held || held.token !== token) {
      return false;
    }

    await rm(path, { force: true });
    return true;
  }

  async getLock(
    ns: string,
    key: string,
    now: number,
  ): Promise<LockInfo | null> {
    const held = await this.#readJson<LockInfo>(
      join(this.#runnerDir(ns, key), "lock.json"),
    );
    return held && held.expiresAt > now ? held : null;
  }

  /* --- runner: state -------------------------------------------------- */

  async getState(ns: string, key: string): Promise<Record<string, string>> {
    const state = await this.#readState(ns, key);
    return { ...state.fields };
  }

  async setState(
    ns: string,
    key: string,
    fields: Record<string, string | number | null>,
  ): Promise<void> {
    await this.#mutateState(ns, key, (state) => {
      for (const [field, value] of Object.entries(fields)) {
        if (value === null) {
          delete state.fields[field];
        } else {
          state.fields[field] = String(value);
        }
      }
    });
  }

  async incrementCounters(
    ns: string,
    key: string,
    deltas: Record<string, number>,
  ): Promise<Record<string, number>> {
    const updated: Record<string, number> = {};

    await this.#mutateState(ns, key, (state) => {
      for (const [field, delta] of Object.entries(deltas)) {
        const current = Number(state.fields[field] ?? 0);
        const next = (Number.isFinite(current) ? current : 0) + delta;
        state.fields[field] = String(next);
        updated[field] = next;
      }
    });

    return updated;
  }

  async appendHistory(
    ns: string,
    key: string,
    record: RunRecord,
    keep: number,
  ): Promise<void> {
    await this.#mutateState(ns, key, (state) => {
      state.history.unshift(jsonClone(record));
      if (keep > 0 && state.history.length > keep) {
        state.history.length = keep;
      }
    });
  }

  async updateHistory(
    ns: string,
    key: string,
    runId: string,
    patch: Partial<RunRecord>,
  ): Promise<boolean> {
    let found = false;

    await this.#mutateState(ns, key, (state) => {
      const index = state.history.findIndex((entry) => entry.runId === runId);
      if (index === -1) {
        return;
      }
      state.history[index] = { ...state.history[index], ...jsonClone(patch) };
      found = true;
    });

    return found;
  }

  async listHistory(
    ns: string,
    key: string,
    limit?: number,
  ): Promise<RunRecord[]> {
    const state = await this.#readState(ns, key);
    return limit && limit > 0 ? state.history.slice(0, limit) : state.history;
  }

  async clearHistory(ns: string, key: string): Promise<void> {
    await this.#mutateState(ns, key, (state) => {
      state.history = [];
    });
  }

  async pushQueuedTrigger(
    ns: string,
    key: string,
    trigger: QueuedTrigger,
    max: number,
  ): Promise<boolean> {
    let pushed = false;

    await this.#mutateState(ns, key, (state) => {
      if (max > 0 && state.queued.length >= max) {
        return;
      }
      state.queued.push(jsonClone(trigger));
      pushed = true;
    });

    return pushed;
  }

  async popQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    // Read first: a mutation writes the runner's state file, and asking an
    // unknown runner whether it has anything queued must not create it.
    if ((await this.#readState(ns, key)).queued.length === 0) {
      return null;
    }

    let trigger: QueuedTrigger | null = null;

    await this.#mutateState(ns, key, (state) => {
      trigger = state.queued.shift() ?? null;
    });

    return trigger;
  }

  async peekQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    // A read alone: nothing is taken, and an unknown runner is not created.
    return (await this.#readState(ns, key)).queued[0] ?? null;
  }

  async countQueuedTriggers(ns: string, key: string): Promise<number> {
    return (await this.#readState(ns, key)).queued.length;
  }

  async clearQueuedTriggers(ns: string, key: string): Promise<number> {
    let count = 0;

    await this.#mutateState(ns, key, (state) => {
      count = state.queued.length;
      state.queued = [];
    });

    return count;
  }

  /* --- queue: jobs ---------------------------------------------------- */

  async ensureQueue(q: QueueRef): Promise<void> {
    const dir = this.#queueDir(q);
    await mkdir(join(dir, "jobs"), { recursive: true });
    await mkdir(join(dir, "repeats"), { recursive: true });
    for (const state of STATES) {
      await mkdir(join(dir, "index", state), { recursive: true });
    }
  }

  async addJob(
    q: QueueRef,
    job: JobRecord,
  ): Promise<{ job: JobRecord; added: boolean }> {
    this.#assertNameFits(job.id, "id", "addJob");
    await this.ensureQueue(q);
    const path = this.#jobPath(q, job.id);
    // `undefined` is not JSON; every other driver stores it as null.
    const record = jsonClone({ ...job, data: job.data ?? null });

    // The record file *is* the idempotency key: exactly one caller creates it.
    if (!(await this.#createExclusive(path, JSON.stringify(record)))) {
      const existing = await this.#readJob(path);
      return { job: existing ?? record, added: false };
    }

    await this.#addMarker(q, record);

    if (record.state === "waiting") {
      await this.#touchWake(q);
    }

    return { job: record, added: true };
  }

  async addJobs(
    q: QueueRef,
    jobs: JobRecord[],
  ): Promise<{ job: JobRecord; added: boolean }[]> {
    const results: { job: JobRecord; added: boolean }[] = [];
    for (const job of jobs) {
      results.push(await this.addJob(q, job));
    }
    return results;
  }

  async claimJob(q: QueueRef, opts: ClaimOptions): Promise<JobRecord | null> {
    await this.ensureQueue(q);

    if (await this.#pauseCache.read(q, () => this.isQueuePaused(q))) {
      return null;
    }

    // No `promoteDelayed` here: it ran before every claim whether or not
    // anything was delayed. Promotion keeps the reported state honest, it is
    // not what makes a job claimable, and the worker sweeps at 1Hz.

    const waiting = join(this.#queueDir(q), "index", "waiting");
    const markers = (await this.#list(waiting)).sort();
    const lockExpiresAt = opts.now + opts.lockMs;
    const excluded =
      opts.excludeNames && opts.excludeNames.length > 0
        ? new Set(opts.excludeNames)
        : null;

    for (const marker of markers) {
      const id = markerId(marker);

      // Exclusion is decided *before* the rename, from a plain read, and only
      // when there is something to exclude. Renaming a capped job's marker into
      // `active` and back would have it count as active meanwhile, and — worse
      // — make it vanish from `waiting` for every other claim, `updateJob` and
      // removal, none of which excluded it: a worker without the cap would skip
      // the job, and might sleep believing the queue empty. Reading first leaves
      // the index untouched. A stale read costs nothing here, because exclusion
      // is advisory — the checks that matter still run on the record read
      // under the rename below.
      if (excluded && (await this.#isExcluded(q, waiting, marker, excluded))) {
        continue;
      }

      // Whoever renames the marker owns the job, and the loser gets ENOENT.
      //
      // The rename comes *before* the record is read, which is what makes a
      // claim safe against `updateJob`. Read first, and a patch that took the
      // marker, rewrote the record and put the marker back under the same name
      // lands in between: the rename still succeeds, and the claim writes the
      // copy it read over the patch — the worker runs the old payload while
      // `updateJob` has already answered with the new one. Holding the marker
      // first means the record read below is the one that won. It costs
      // nothing: the same rename, read and write, in a different order.
      const taken = join(
        this.#queueDir(q),
        "index",
        "active",
        activeMarker(lockExpiresAt, id),
      );
      try {
        await rename(join(waiting, marker), taken);
      } catch {
        continue;
      }

      const record = await this.#readJob(this.#jobPath(q, id));

      if (!record) {
        // The record is gone: the marker is litter from a removed job.
        await rm(taken, { force: true });
        continue;
      }

      // A record in `delayed` or `failed` whose time has come is claimable:
      // the only thing between it and `waiting` is a promotion write, and this
      // claim is about to overwrite the state anyway.
      const due = record.runAt <= opts.now;
      const promotable =
        due && (record.state === "delayed" || record.state === "failed");

      // An excluded name is one more way of being not claimable *now*: the
      // pre-check above could only have missed it on an id reused under a
      // different name since, but a cap is only as good as its last check.
      if (
        !due ||
        (record.state !== "waiting" && !promotable) ||
        excluded?.has(record.name)
      ) {
        // The marker disagrees with its record. That is either litter from a
        // crash or a promotion in flight, and from here the two are
        // indistinguishable — so only a record that can no longer *become*
        // waiting is safe to clean up after, and the rest goes back exactly
        // where it was.
        //
        // Deleting the rest loses jobs. `promoteDelayed` once moved the marker
        // into `waiting` before rewriting the record, so for that instant the
        // record still read `failed`; a claim that removed the marker there
        // left a record no index pointed at, and nothing ever ran it again. The
        // cross-process retry suite found it as jobs that simply never
        // finished, after 45 seconds of waiting each.
        //
        // A crash before the marker goes back leaves it in `active` under a
        // record that is not, which `recoverStalled` re-files once the lock
        // this claim would have taken has expired.
        if (record.state === "completed" || record.state === "dead") {
          await rm(taken, { force: true });
        } else {
          await rename(taken, join(waiting, marker)).catch(() => undefined);
        }
        continue;
      }

      const claimed: JobRecord = {
        ...record,
        state: "active",
        attemptsMade: record.attemptsMade + 1,
        processedOn: opts.now,
        lockToken: opts.token,
        lockExpiresAt,
        workerId: opts.workerId,
      };

      await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(claimed));
      return claimed;
    }

    return null;
  }

  async extendJobLock(
    q: QueueRef,
    id: string,
    token: string,
    lockMs: number,
    now: number,
  ): Promise<boolean> {
    const deadline = Date.now() + HOLD_PATIENCE_MS;

    for (;;) {
      const record = await this.#readJob(this.#jobPath(q, id));
      if (!record || record.state !== "active" || record.lockToken !== token) {
        return false;
      }

      const marker = this.#markerFor(record);
      const updated = { ...record, lockExpiresAt: now + lockMs };

      if (await this.#move(q, marker, "active", updated)) {
        await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(updated));
        return true;
      }

      if (!(await this.#retryLostRename(q, id, token, marker, deadline))) {
        return false;
      }
    }
  }

  async completeJob(
    q: QueueRef,
    id: string,
    token: string,
    result: unknown,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    const deadline = Date.now() + HOLD_PATIENCE_MS;

    for (;;) {
      const record = await this.#readJob(this.#jobPath(q, id));
      if (!record || record.state !== "active" || record.lockToken !== token) {
        return false;
      }

      const completed: JobRecord = {
        ...record,
        state: "completed",
        finishedOn: now,
        returnValue: jsonClone(result ?? null),
        expiresAt: expiryFor(retention, now, record.expiresAt),
        lockToken: null,
        lockExpiresAt: null,
        workerId: null,
      };

      const marker = this.#markerFor(record);

      if (await this.#move(q, marker, "active", completed)) {
        await this.#writeAtomic(
          this.#jobPath(q, id),
          JSON.stringify(completed),
        );
        // Counted once the transition has landed, and in memory: no I/O here.
        this.#throughput.add(q, now, 1, 0);
        await this.#applyRetention(q, completed, retention);
        return true;
      }

      if (!(await this.#retryLostRename(q, id, token, marker, deadline))) {
        return false;
      }
    }
  }

  async failJob(
    q: QueueRef,
    id: string,
    token: string,
    error: SerializedError,
    outcome: FailOutcome,
    now: number,
    keepStacktraces: number,
  ): Promise<boolean> {
    const deadline = Date.now() + HOLD_PATIENCE_MS;

    for (;;) {
      const record = await this.#readJob(this.#jobPath(q, id));
      if (!record || record.state !== "active" || record.lockToken !== token) {
        return false;
      }

      const base: JobRecord = {
        ...record,
        failedReason: jsonClone(error),
        stacktrace: [jsonClone(error), ...record.stacktrace].slice(
          0,
          Math.max(0, keepStacktraces),
        ),
        lockToken: null,
        lockExpiresAt: null,
        workerId: null,
      };

      const updated: JobRecord = outcome.retry
        ? { ...base, state: "failed", runAt: outcome.runAt, finishedOn: null }
        : {
            ...base,
            state: "dead",
            finishedOn: now,
            expiresAt: expiryFor(outcome.retention, now, base.expiresAt),
          };

      const marker = this.#markerFor(record);

      if (await this.#move(q, marker, "active", updated)) {
        await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(updated));
        // A failed attempt, retried or dead alike; in memory, no I/O here.
        this.#throughput.add(q, now, 0, 1);

        if (!outcome.retry) {
          await this.#applyRetention(q, updated, outcome.retention);
        }

        return true;
      }

      if (!(await this.#retryLostRename(q, id, token, marker, deadline))) {
        return false;
      }
    }
  }

  async updateProgress(
    q: QueueRef,
    id: string,
    progress: unknown,
  ): Promise<boolean> {
    const path = this.#jobPath(q, id);
    const active = join(this.#queueDir(q), "index", "active");
    const deadline = Date.now() + HOLD_PATIENCE_MS;

    for (;;) {
      const record = await this.#readJob(path);
      if (!record) {
        return false;
      }

      // Progress is reported by the processor, so this is nearly always an
      // active job. Anything else is rare enough to take the full hold.
      if (record.state !== "active") {
        const updated = await this.#mutateJob(q, id, (current) => ({
          ...current,
          progress: jsonClone(progress ?? null),
        }));
        return updated !== null;
      }

      // A read-modify-write with nothing around it used to be safe, because
      // nothing else rewrote an active job's record in place. `updateJob` does,
      // and each would write over the other's change. So this renames the
      // marker as `extendJobLock` does — one millisecond more lock gives it a
      // new name — and the rename is the exclusion: a patch holding the marker
      // makes it fail, and it makes a patch or completion that read the record
      // first miss the old name and read again. One rename, and no second read.
      //
      // Every writer of an active record now changes the marker's name, which
      // is what lets a successful rename prove the record read is current. The
      // cost is a lock that creeps a millisecond per report until the next
      // `extendJobLock` resets it.
      const marker = this.#markerFor(record);
      const updated: JobRecord = {
        ...record,
        progress: jsonClone(progress ?? null),
        lockExpiresAt: (record.lockExpiresAt ?? 0) + 1,
      };

      let moved = true;
      try {
        await rename(
          join(active, marker),
          join(active, this.#markerFor(updated)),
        );
      } catch {
        moved = false;
      }

      if (moved) {
        await this.#writeAtomic(path, JSON.stringify(updated));
        return true;
      }

      if (Date.now() >= deadline) {
        return false;
      }

      const fresh = await this.#readJob(path);
      if (fresh?.state === "active" && this.#markerFor(fresh) === marker) {
        await this.#healHolds(q);
        await sleep(LOCK_RETRY_MS, { unref: true }).catch(() => {});
      }
    }
  }

  async updateJob(
    q: QueueRef,
    id: string,
    patch: JobPatch,
    now: number,
  ): Promise<JobRecord | null> {
    const updated = await this.#mutateJob(q, id, (record) => {
      // Judged against the record read *under the hold*, which is what makes
      // `onlyIn` hold at the moment of the write rather than of some earlier
      // read: a claim cannot slip between the check and the change.
      if (patch.onlyIn && !patch.onlyIn.includes(record.state)) {
        return null;
      }

      if (
        patch.runAt !== undefined &&
        record.state !== "waiting" &&
        record.state !== "delayed"
      ) {
        return null;
      }

      const next: JobRecord = { ...record };

      if (patch.data !== undefined) {
        next.data = jsonClone(patch.data);
      }

      if (patch.priority !== undefined) {
        next.priority = patch.priority;
        next.opts = { ...next.opts, priority: patch.priority };
      }

      if (patch.runAt !== undefined) {
        next.runAt = patch.runAt;
        next.state = patch.runAt > now ? "delayed" : "waiting";
      }

      return next;
    });

    if (updated?.state === "waiting") {
      await this.#touchWake(q);
    }

    return updated;
  }

  async addJobLog(
    q: QueueRef,
    id: string,
    line: string,
    keep: number,
  ): Promise<number> {
    // Under the job's own hold, which removal takes too. That is what keeps a
    // log from outliving its job: an append cannot land between a removal
    // deleting the log and deleting the record, so a log file exists only
    // while its record does. It also serialises appends to one job, which
    // counting and trimming — a read and a rewrite — need.
    const held = await this.#holdJob(q, id, () => true);
    if (!held) {
      return 0;
    }

    const path = this.#logPath(q, held.record);

    try {
      await mkdir(join(path, ".."), { recursive: true });
      const existing = await this.#readText(path);
      // Only newline-terminated lines count. A crash mid-append leaves a
      // partial last line, and appending after it would fuse the two into one
      // line that is neither.
      const whole = existing.slice(0, existing.lastIndexOf("\n") + 1);
      const encoded = `${JSON.stringify(line)}\n`;
      let count = countLines(whole) + 1;

      if (keep > 0 && count > keep) {
        await this.#writeAtomic(path, dropLines(whole, count - keep) + encoded);
        count = keep;
      } else if (whole.length !== existing.length) {
        await this.#writeAtomic(path, whole + encoded);
      } else {
        await writeFile(path, encoded, { flag: "a" });
      }

      return count;
    } finally {
      await this.#place(q, held.hold, held.record);

      // A claim that found the marker held moved on, and may have gone to
      // sleep believing the queue empty.
      if (held.record.state === "waiting") {
        await this.#touchWake(q);
      }
    }
  }

  async getJobLogs(
    q: QueueRef,
    id: string,
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<{ logs: string[]; count: number }> {
    const record = await this.#readJob(this.#jobPath(q, id));
    if (!record) {
      return { logs: [], count: 0 };
    }

    const text = await this.#readText(this.#logPath(q, record));
    // The last element is whatever follows the final newline: empty for a
    // complete log, a partial line for one an append is still writing.
    const lines = text.split("\n").slice(0, -1);
    const ordered = opts.order === "desc" ? lines.toReversed() : lines;

    return {
      logs: ordered
        .slice(opts.offset, opts.offset + opts.limit)
        .map((encoded) => safeJsonParse<string>(encoded, encoded)),
      count: lines.length,
    };
  }

  async recordChild(
    q: QueueRef,
    parentId: string,
    child: JobRef,
    outcome: ChildOutcome,
    now: number,
  ): Promise<ChildRecordResult> {
    const key = flowKey(child);
    const settles = outcome.completed || outcome.ignored;

    /** What recording would answer from `record`, without writing anything. */
    const answer = (record: JobRecord | null): ChildRecordResult | "write" => {
      if (!record?.flow || !listsChild(record.flow, child)) {
        return "missing";
      }
      if (
        Object.hasOwn(record.flow.values, key) ||
        Object.hasOwn(record.flow.failures, key)
      ) {
        return "already";
      }
      if (record.state === "dead") {
        return settles ? "write" : "parent-dead";
      }
      return record.state === "waiting-children" ? "write" : "already";
    };

    // Under the parent's hold, like every other change here: two children
    // finishing at once each read the parent, and without the hold the second
    // write would put back the `pending` count the first had just lowered —
    // a parent that then never runs.
    const held = await this.#holdJob(
      q,
      parentId,
      (record) => answer(record) === "write",
    );

    if (!held) {
      // `#holdJob` answers `null` for three different things, and only two of
      // them are answers. Guessing for the third — somebody kept the marker
      // past `HOLD_PATIENCE_MS` — could have the caller mark the child recorded
      // and let its retention remove it, with the outcome never delivered and
      // nothing left for healing to find. So that one throws.
      const current = answer(await this.#readJob(this.#jobPath(q, parentId)));
      if (current !== "write") {
        return current;
      }
      throw new DriverError(
        "file",
        "recordChild",
        new Error("the parent's marker stayed held"),
        { id: parentId, child: key },
      );
    }

    const { record: current, hold } = held;
    const flow = current.flow!;
    // New objects throughout: `current` is also what the hold is put back by
    // if the write below fails.
    const stored: JobFlow = {
      ...flow,
      values: outcome.completed
        ? { ...flow.values, [key]: jsonClone(outcome.value ?? null) }
        : flow.values,
      failures: outcome.completed
        ? flow.failures
        : { ...flow.failures, [key]: jsonClone(outcome.error) },
    };
    let updated: JobRecord;
    let result: ChildRecordResult;

    if (current.state === "dead") {
      // Kept for a retry of the parent, which then does not wait on it.
      updated = { ...current, flow: stored };
      result = "recorded";
    } else if (!outcome.completed && !outcome.ignored) {
      // A child that failed buries its parent, which can then never run.
      updated = {
        ...current,
        state: "dead",
        failedReason: jsonClone(outcome.error),
        finishedOn: now,
      };
      result = "buried";
    } else {
      const pending = Math.max(0, flow.pending - 1);
      updated = {
        ...current,
        flow: { ...stored, pending },
        state:
          pending > 0
            ? "waiting-children"
            : current.runAt > now
              ? "delayed"
              : "waiting",
      };
      result = pending > 0 ? "recorded" : "released";
    }

    try {
      await this.#writeAtomic(
        this.#jobPath(q, parentId),
        JSON.stringify(updated),
      );
    } catch (error) {
      await this.#place(q, hold, current);
      throw error;
    }

    await this.#release(q, hold, current, updated);

    // A parent buried by a failed child is a failure too.
    if (result === "buried") {
      this.#throughput.add(q, now, 0, 1);
    }

    if (updated.state === "waiting") {
      await this.#touchWake(q);
    }

    return result;
  }

  async requeueParent(q: QueueRef, id: string, now: number): Promise<boolean> {
    const updated = await this.#mutateJob(q, id, (record) => {
      if (record.state !== "dead" || !record.flow) {
        return null;
      }

      // Counted here, under the hold: an outcome recorded in the meantime
      // is then never counted as still to come.
      const remaining = unsettledChildren(record.flow);
      return {
        ...record,
        flow: { ...record.flow, pending: remaining },
        failedReason: null,
        finishedOn: null,
        expiresAt: null,
        state:
          remaining > 0
            ? "waiting-children"
            : record.runAt > now
              ? "delayed"
              : "waiting",
      };
    });

    if (!updated) {
      return false;
    }

    if (updated.state === "waiting") {
      await this.#touchWake(q);
    }

    return true;
  }

  async markChildRecorded(
    q: QueueRef,
    id: string,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    const updated = await this.#mutateJob(q, id, (record) => {
      const finished = record.state === "completed" || record.state === "dead";

      return {
        ...record,
        flow: {
          parent: record.flow?.parent ?? null,
          children: record.flow?.children ?? [],
          pending: record.flow?.pending ?? 0,
          values: record.flow?.values ?? {},
          failures: record.flow?.failures ?? {},
          recorded: true,
        },
        // The TTL goes in with the same write, as completion does it: a
        // second write afterwards could land over a patch, or under one.
        expiresAt: finished
          ? expiryFor(retention, now, record.expiresAt)
          : record.expiresAt,
      };
    });

    if (!updated) {
      return false;
    }

    if (updated.state === "completed" || updated.state === "dead") {
      await this.#applyRetention(q, updated, retention);
    }

    return true;
  }

  async getJob(q: QueueRef, id: string): Promise<JobRecord | null> {
    return await this.#readJob(this.#jobPath(q, id));
  }

  async listJobs(
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<JobRecord[]> {
    const dir = this.#queueDir(q);
    const found: JobRecord[] = [];

    // One state is already in order by its markers' names, so only the page
    // asked for is read — a maintenance pass paging through a large state
    // then costs one directory listing and `limit` reads, not every record.
    if (states.length === 1) {
      const state = states[0]!;
      const markers = (await this.#list(join(dir, "index", state))).sort();
      if (opts.order === "desc") {
        markers.reverse();
      }

      // A marker whose record has moved on is skipped without counting, so
      // the page is exactly what a full read and slice would give.
      let skip = opts.offset;
      for (const marker of markers) {
        if (found.length >= opts.limit) {
          break;
        }
        const record = await this.#readJob(this.#jobPath(q, markerId(marker)));
        if (!record || record.state !== state) {
          continue;
        }
        if (skip > 0) {
          skip--;
          continue;
        }
        found.push(record);
      }

      return found;
    }

    for (const state of states) {
      const markers = (await this.#list(join(dir, "index", state))).sort();
      for (const marker of markers) {
        const record = await this.#readJob(this.#jobPath(q, markerId(marker)));
        if (record && record.state === state) {
          found.push(record);
        }
      }
    }

    // Several states at once have no shared order but creation time.
    if (states.length > 1) {
      found.sort((a, b) => a.createdAt - b.createdAt);
    }

    if (opts.order === "desc") {
      found.reverse();
    }

    return found.slice(opts.offset, opts.offset + opts.limit);
  }

  async countJobs(q: QueueRef): Promise<Record<JobState, number>> {
    const dir = this.#queueDir(q);
    const counts = {
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      dead: 0,
      "waiting-children": 0,
    } satisfies Record<JobState, number>;

    for (const state of STATES) {
      counts[state] = (await this.#list(join(dir, "index", state))).length;
    }

    return counts;
  }

  /* --- queue: read APIs ------------------------------------------------ */

  /**
   * A page narrowed by name or search. There is no index on names, so a
   * filtered read opens the records of the states asked for — a single state
   * a bounded batch at a time, stopping once the page is full unless a total
   * is wanted. Unfiltered, it is `listJobs` (a single state reads only the
   * page) and a total is the markers counted. The payload is never matched.
   */
  async findJobs(q: QueueRef, query: JobQuery): Promise<JobPage> {
    const filter = jobFilter(query);
    const offset = Math.max(0, Math.floor(query.offset));
    const limit = Math.max(0, Math.floor(query.limit));
    // Each state once: a job is in one state, so it is one match.
    const states = [...new Set(query.states)];
    const index = join(this.#queueDir(q), "index");

    if (!filter) {
      const jobs =
        limit === 0
          ? []
          : await this.listJobs(q, states, {
              offset,
              limit,
              order: query.order,
            });

      if (!query.total) {
        return { jobs };
      }

      let total = 0;
      for (const state of states) {
        total += (await this.#list(join(index, state))).length;
      }
      return { jobs, total };
    }

    const jobs: JobRecord[] = [];

    // One state is already in order by its markers' names, as in `listJobs`.
    if (states.length === 1) {
      const state = states[0]!;
      const markers = (await this.#list(join(index, state))).sort();
      if (query.order === "desc") {
        markers.reverse();
      }

      let skip = offset;
      let total = 0;

      for (let at = 0; at < markers.length; at += READ_CONCURRENCY) {
        if (!query.total && jobs.length >= limit) {
          break;
        }

        for (const record of await this.#readMarked(
          q,
          markers.slice(at, at + READ_CONCURRENCY),
        )) {
          // A marker whose record has moved on is not a match, as in `listJobs`.
          if (
            !record ||
            record.state !== state ||
            !matchesFilter(filter, record.id, record.name)
          ) {
            continue;
          }

          total++;
          if (skip > 0) {
            skip--;
          } else if (jobs.length < limit) {
            jobs.push(record);
          }
        }
      }

      return query.total ? { jobs, total } : { jobs };
    }

    // Several states share no order but creation time, which needs them all.
    const matching: JobRecord[] = [];
    for (const state of states) {
      const markers = (await this.#list(join(index, state))).sort();

      for (let at = 0; at < markers.length; at += READ_CONCURRENCY) {
        for (const record of await this.#readMarked(
          q,
          markers.slice(at, at + READ_CONCURRENCY),
        )) {
          if (
            record &&
            record.state === state &&
            matchesFilter(filter, record.id, record.name)
          ) {
            matching.push(record);
          }
        }
      }
    }

    // Filtering before a stable sort leaves the order `listJobs` would give.
    matching.sort((a, b) => a.createdAt - b.createdAt);
    if (query.order === "desc") {
      matching.reverse();
    }

    jobs.push(...matching.slice(offset, offset + limit));
    return query.total ? { jobs, total: matching.length } : { jobs };
  }

  /** Several jobs by id: each distinct id read once, a bounded batch at a time. */
  async getJobs(q: QueueRef, ids: string[]): Promise<(JobRecord | null)[]> {
    const distinct = [...new Set(ids)];
    const found = new Map<string, JobRecord | null>();

    for (let at = 0; at < distinct.length; at += READ_CONCURRENCY) {
      const chunk = distinct.slice(at, at + READ_CONCURRENCY);
      const records = await Promise.all(
        chunk.map(async (id) => await this.#readJob(this.#jobPath(q, id))),
      );
      chunk.forEach((id, index) => found.set(id, records[index] ?? null));
    }

    return orderByIds(ids, found);
  }

  /** Writes a worker's record over its last one, by rename, so a read sees one whole. */
  async registerWorker(q: QueueRef, worker: WorkerInfo): Promise<void> {
    await this.#writeAtomic(
      this.#workerPath(q, worker.id),
      JSON.stringify(worker),
    );

    // Records lapsed as of this report go now, not only when somebody lists:
    // one directory read per report, never per job.
    await this.listWorkers(q, worker.heartbeatAt);
  }

  /** Removes a worker's record; of two removals at once, one unlink wins. */
  async removeWorker(q: QueueRef, id: string): Promise<boolean> {
    try {
      await unlink(this.#workerPath(q, id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw new DriverError("file", "removeWorker", error, { id });
    }
  }

  /** The workers whose records outlast `now`, deleting lapsed ones on the way. */
  async listWorkers(q: QueueRef, now: number): Promise<WorkerInfo[]> {
    const dir = join(this.#queueDir(q), "workers");
    // Only a finished `<encoded id>.json`: not a `.tmp` from an interrupted
    // write, nor a lapsed record set aside mid-delete. An encoded name never
    // contains a dot, so the first dot ends it.
    const files = (await this.#list(dir)).filter((file) => {
      const dot = file.indexOf(".");
      return (
        dot > 0 &&
        file.slice(dot) === ".json" &&
        decodeName(file.slice(0, dot)) !== null
      );
    });
    const live: WorkerInfo[] = [];

    for (let at = 0; at < files.length; at += READ_CONCURRENCY) {
      const chunk = files.slice(at, at + READ_CONCURRENCY);
      const records = await Promise.all(
        chunk.map(
          async (file) => await this.#readJson<WorkerInfo>(join(dir, file)),
        ),
      );

      for (const [index, worker] of records.entries()) {
        if (!worker) {
          continue;
        }

        if (worker.expiresAt > now) {
          live.push(worker);
        } else {
          await this.#dropLapsedWorker(join(dir, chunk[index]!), now);
        }
      }
    }

    return sortWorkers(live);
  }

  /** Counts per state for every queue directory in the namespace. */
  async countJobsByQueue(
    ns: string,
  ): Promise<Record<string, Record<JobState, number>>> {
    const result: Record<string, Record<JobState, number>> = {};

    for (const queue of await this.listQueues(ns)) {
      result[queue] = await this.countJobs({ ns, queue });
    }

    return result;
  }

  /**
   * Completions and failed attempts per minute in `[from, to]`: this driver's
   * own pending counts written first, then every line of every bucket file in
   * range summed — one line per process per flush, so writers never share one.
   */
  async getThroughput(
    q: QueueRef,
    range: { from: number; to: number },
  ): Promise<ThroughputBucket[]> {
    await this.#throughput.flush();

    const dir = this.#throughputDir(q);
    const rows: ThroughputBucket[] = [];

    for (const file of await this.#list(dir)) {
      const match = THROUGHPUT_FILE.exec(file);
      const at = Number(match?.[1]);
      if (!match || at < range.from || at > range.to) {
        continue;
      }

      // Newline-terminated lines only: a partial last line is an append in
      // flight, or one a crash cut short.
      const lines = (await this.#readText(join(dir, file))).split("\n");
      for (const line of lines.slice(0, -1)) {
        const row = safeJsonParse<Partial<ThroughputBucket> | null>(line, null);
        if (row) {
          rows.push({
            at,
            completed: Number(row.completed) || 0,
            failed: Number(row.failed) || 0,
          });
        }
      }
    }

    return sumBuckets(rows, range);
  }

  async removeJob(q: QueueRef, id: string): Promise<boolean> {
    return await this.#deleteJob(q, id, (record) => record.state !== "active");
  }

  async retryJob(
    q: QueueRef,
    id: string,
    resetAttempts: boolean,
    now: number,
  ): Promise<boolean> {
    // Under a hold, like `updateJob`: a retry that wrote the copy it read
    // before the rename would put back whatever a patch had just replaced.
    const updated = await this.#mutateJob(q, id, (record) => {
      // A parent waiting on children is not finished; moving it would run it
      // before they settle.
      if (
        record.state === "active" ||
        record.state === "waiting" ||
        record.state === "waiting-children"
      ) {
        return null;
      }

      return {
        ...record,
        state: "waiting",
        runAt: now,
        finishedOn: null,
        expiresAt: null,
        // The outcome it ends with this time has not reached its parent.
        flow: record.flow ? { ...record.flow, recorded: false } : null,
        ...(resetAttempts ? { attemptsMade: 0, stalledCount: 0 } : {}),
      };
    });

    if (!updated) {
      return false;
    }

    await this.#touchWake(q);
    return true;
  }

  async promoteJob(q: QueueRef, id: string, now: number): Promise<boolean> {
    const updated = await this.#mutateJob(q, id, (record) => {
      if (!SCHEDULED_STATES.includes(record.state)) {
        return null;
      }

      return { ...record, state: "waiting", runAt: now };
    });

    if (!updated) {
      return false;
    }

    await this.#touchWake(q);
    return true;
  }

  async promoteDelayed(
    q: QueueRef,
    now: number,
    limit: number,
  ): Promise<number> {
    const dir = this.#queueDir(q);
    let promoted = 0;

    for (const state of SCHEDULED_STATES) {
      const markers = (await this.#list(join(dir, "index", state))).sort();

      for (const marker of markers) {
        if (promoted >= limit) {
          break;
        }

        // The marker's prefix is the due time, so an unripe one ends the scan.
        if (Number(marker.split("-")[0]) > now) {
          break;
        }

        // Hold the marker, then read. Reading first and writing `waiting` over
        // what was read races `updateJob`: a patch that pushes this job's
        // `runAt` back and replaces its data lands between the read and the
        // write, and the promotion then writes the old copy over it — the
        // debounce case, exactly when the job falls due.
        const hold = await this.#hold(q, state, marker);
        if (!hold) {
          continue;
        }

        const record = await this.#readJob(this.#jobPath(q, markerId(marker)));

        if (!record) {
          await rm(hold, { force: true });
          continue;
        }

        // `waiting` is allowed as well as the state being swept: a promotion
        // that wrote the record and then died leaves exactly that, and this
        // pass has to finish the job rather than skip it forever.
        if (
          (record.state !== state && record.state !== "waiting") ||
          record.runAt > now
        ) {
          await this.#place(q, hold, record);
          continue;
        }

        const updated: JobRecord = { ...record, state: "waiting" };

        // Record first, marker second. The other order leaves a window where
        // the marker says `waiting` and the record does not, which a claim
        // running at that moment cannot tell from litter. A crash in between
        // leaves a hold that `recoverStalled` files by the record.
        try {
          await this.#writeAtomic(
            this.#jobPath(q, record.id),
            JSON.stringify(updated),
          );
        } catch (error) {
          await this.#place(q, hold, record);
          throw error;
        }

        await this.#release(q, hold, record, updated);
        promoted++;
      }
    }

    if (promoted > 0) {
      await this.#touchWake(q);
    }

    return promoted;
  }

  async recoverStalled(
    q: QueueRef,
    now: number,
    maxStalledCount: number,
    limit: number,
  ): Promise<{ requeued: string[]; dead: string[] }> {
    const dir = join(this.#queueDir(q), "index", "active");
    const requeued: string[] = [];
    const dead: string[] = [];

    // Markers taken out of the index by a process that died holding them.
    await this.#healHolds(q);

    for (const marker of (await this.#list(dir)).sort()) {
      if (requeued.length + dead.length >= limit) {
        break;
      }

      // The marker's prefix is when the lock expires.
      if (Number(marker.split("-")[0]) > now) {
        break;
      }

      const record = await this.#readJob(this.#jobPath(q, markerId(marker)));

      if (!record) {
        // Litter: a claim that found no record and died before removing it.
        await rm(join(dir, marker), { force: true });
        continue;
      }

      if (record.state !== "active") {
        // A claim renames the marker before it writes the record, so one that
        // died in between leaves the marker here under a record that is still
        // `waiting`. Nothing else ever looks for it in `active`: file it where
        // the record says it belongs. Only once the lock it would have taken
        // has expired, so a claim still in flight is never disturbed.
        await this.#place(q, join(dir, marker), record);
        continue;
      }

      const stalledCount = record.stalledCount + 1;
      const buried = stalledCount > maxStalledCount;

      const updated: JobRecord = {
        ...record,
        stalledCount,
        lockToken: null,
        lockExpiresAt: null,
        workerId: null,
        ...(buried
          ? { state: "dead" as const, finishedOn: now }
          : { state: "waiting" as const, runAt: now }),
      };

      if (!(await this.#move(q, marker, "active", updated))) {
        continue;
      }

      await this.#writeAtomic(
        this.#jobPath(q, record.id),
        JSON.stringify(updated),
      );
      (buried ? dead : requeued).push(record.id);
    }

    if (requeued.length > 0) {
      await this.#touchWake(q);
    }

    // A burial is a failure, counted as a failed attempt is.
    if (dead.length > 0) {
      this.#throughput.add(q, now, 0, dead.length);
    }

    return { requeued, dead };
  }

  async cleanJobs(
    q: QueueRef,
    state:
      | "completed"
      | "failed"
      | "dead"
      | "waiting"
      | "delayed"
      | "waiting-children",
    olderThanMs: number,
    limit: number,
    now: number,
  ): Promise<string[]> {
    const cutoff = now - olderThanMs;
    const removed: string[] = [];

    for (const marker of await this.#list(
      join(this.#queueDir(q), "index", state),
    )) {
      if (removed.length >= limit) {
        break;
      }

      const record = await this.#readJob(this.#jobPath(q, markerId(marker)));
      if (!record) {
        continue;
      }

      const expired = (candidate: JobRecord) =>
        candidate.state === state &&
        (candidate.finishedOn ?? candidate.createdAt) <= cutoff;

      if (await this.#deleteJob(q, record.id, expired, record)) {
        removed.push(record.id);
      }
    }

    return removed;
  }

  async pruneExpired(q: QueueRef, now: number, limit: number): Promise<number> {
    let removed = 0;

    for (const state of ["completed", "dead"] as const) {
      for (const marker of await this.#list(
        join(this.#queueDir(q), "index", state),
      )) {
        if (removed >= limit) {
          break;
        }

        const record = await this.#readJob(this.#jobPath(q, markerId(marker)));
        const due = (candidate: JobRecord) =>
          candidate.state === state &&
          candidate.expiresAt !== null &&
          candidate.expiresAt <= now &&
          // A child whose parent has not taken its outcome yet stays.
          !awaitsDelivery(candidate);

        if (record && (await this.#deleteJob(q, record.id, due, record))) {
          removed++;
        }
      }
    }

    return removed;
  }

  async drainQueue(q: QueueRef, includeDelayed: boolean): Promise<number> {
    // A parent waiting on children is queued work that has not run, so it
    // goes with `waiting` whether or not delayed jobs are drained too.
    const states: JobState[] = includeDelayed
      ? ["waiting", "waiting-children", ...SCHEDULED_STATES]
      : ["waiting", "waiting-children"];
    let removed = 0;

    for (const state of states) {
      for (const marker of await this.#list(
        join(this.#queueDir(q), "index", state),
      )) {
        const record = await this.#readJob(this.#jobPath(q, markerId(marker)));
        if (
          record &&
          (await this.#deleteJob(
            q,
            record.id,
            (candidate) => candidate.state === state,
            record,
          ))
        ) {
          removed++;
        }
      }
    }

    return removed;
  }

  async getQueueState(
    q: QueueRef,
    name: string,
  ): Promise<QueueStateEntry | null> {
    // A name too long to be a file name cannot have been written.
    if (encodeName(name).length > MAX_ENCODED_NAME) {
      return null;
    }

    // No lock: every write lands by rename, so a read sees one whole version.
    return await this.#readJson<QueueStateEntry>(this.#statePath(q, name));
  }

  async setQueueState(
    q: QueueRef,
    name: string,
    value: unknown,
    expected: number | null,
    options?: { internal?: symbol },
  ): Promise<number | null> {
    assertWritableStateName(name, options);
    // Before anything is written or locked. This package's own names are
    // fitted to the budget, so only a caller's name can be refused here.
    this.#assertNameFits(name, "name", "setQueueState");

    const path = this.#statePath(q, name);

    // The compare and the write under one lock file, which is what makes them
    // one step across processes: `O_EXCL` lets exactly one process in, and the
    // write goes through a rename so a reader outside the lock never sees half
    // of it. Creating an absent entry takes the same lock rather than an
    // exclusive create of its own, so a delete cannot land between somebody's
    // check for absence and their create.
    const release = await this.#lockFile(
      `${path.slice(0, -".json".length)}.lock`,
    );

    try {
      const current = await this.#readJson<QueueStateEntry>(path);

      if ((current?.version ?? null) !== expected) {
        return null;
      }

      if (value === null) {
        await unlink(path).catch(() => undefined);
        return 0;
      }

      const version = (current?.version ?? 0) + 1;
      await this.#writeAtomic(
        path,
        JSON.stringify({ version, value } satisfies QueueStateEntry),
      );
      return version;
    } finally {
      await release();
    }
  }

  async listQueueState(
    q: QueueRef,
    options: { prefix: string; after?: string; limit: number },
  ): Promise<string[]> {
    const names: string[] = [];

    for (const file of await this.#list(join(this.#queueDir(q), "state"))) {
      // Only a finished `<encoded name>.json` is an entry. The directory also
      // holds `.lock` files (an orphan outlives a crashed compare-and-set),
      // `.stale` locks mid-break and `.tmp` files from an interrupted atomic
      // write. An encoded name never contains a dot, so the first dot ends it
      // and only `.json` straight after makes an entry.
      const dot = file.indexOf(".");
      if (dot === -1 || file.slice(dot) !== ".json") {
        continue;
      }

      const name = decodeName(file.slice(0, dot));
      if (name === null) {
        // Not a name this driver wrote; nothing it could be looked up by.
        continue;
      }

      // Compared decoded, because the prefix is literal text rather than an
      // encoded fragment — and with `compareCodePoints`, never `>`. JavaScript
      // compares UTF-16 units, so `"\u{1F600}" > "￿"` is false, and a page
      // ending at U+FFFF would silently drop the emoji from the next one.
      if (
        name.startsWith(options.prefix) &&
        (options.after === undefined ||
          compareCodePoints(name, options.after) > 0)
      ) {
        names.push(name);
      }
    }

    // Code-point order, as the contract requires; the default `sort()` is
    // UTF-16 order, which puts U+10000 and above ahead of U+E000–U+FFFF.
    names.sort(compareCodePoints);
    return names.slice(0, Math.max(0, options.limit));
  }

  async pauseQueue(q: QueueRef): Promise<void> {
    await this.#setMeta(q, { paused: true });
    this.#pauseCache.write(q, true);
  }

  async resumeQueue(q: QueueRef): Promise<void> {
    await this.#setMeta(q, { paused: false });
    await this.#touchWake(q);
    this.#pauseCache.write(q, false);
  }

  async isQueuePaused(q: QueueRef): Promise<boolean> {
    const meta = await this.#readJson<{ paused?: boolean }>(
      join(this.#queueDir(q), "meta.json"),
    );
    return meta?.paused === true;
  }

  /* --- queue: repeats ------------------------------------------------- */

  async upsertRepeat(q: QueueRef, def: RepeatRecord): Promise<void> {
    await this.ensureQueue(q);
    await this.#writeAtomic(this.#repeatPath(q, def.key), JSON.stringify(def));
  }

  async getRepeat(q: QueueRef, key: string): Promise<RepeatRecord | null> {
    return await this.#readJson<RepeatRecord>(this.#repeatPath(q, key));
  }

  async listRepeats(q: QueueRef): Promise<RepeatRecord[]> {
    const dir = join(this.#queueDir(q), "repeats");
    const found: RepeatRecord[] = [];

    for (const file of await this.#list(dir)) {
      const record = await this.#readJson<RepeatRecord>(join(dir, file));
      if (record) {
        found.push(record);
      }
    }

    return found;
  }

  async removeRepeat(q: QueueRef, key: string): Promise<boolean> {
    const path = this.#repeatPath(q, key);
    if (!(await this.#readJson<RepeatRecord>(path))) {
      return false;
    }

    await rm(path, { force: true });
    return true;
  }

  /* --- queue: waiting and events --------------------------------------- */

  async nextDelayedAt(q: QueueRef): Promise<number | null> {
    let earliest: number | null = null;

    for (const state of SCHEDULED_STATES) {
      const markers = (
        await this.#list(join(this.#queueDir(q), "index", state))
      ).sort();

      const first = markers[0];
      if (!first) {
        continue;
      }

      // Markers sort by due time, so the first is the earliest.
      const due = Number(first.split("-")[0]);
      if (Number.isFinite(due) && (earliest === null || due < earliest)) {
        earliest = due;
      }
    }

    return earliest;
  }

  async waitForJob(
    q: QueueRef,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const wake = join(this.#queueDir(q), "wake");

    // Snapshotted *before* the first look for work, and the order is the whole
    // point. This watches `wake` for a change, so anything that arrived before
    // the snapshot is already folded into it and will never look like one —
    // and a caller reaches here precisely because its claim came back empty,
    // which is the window a job most often lands in. Taking the snapshot first
    // and then looking means a job landing either side of it is caught: before,
    // by the look; after, by the change.
    //
    // Getting this backwards cost a full poll interval. Measured, round-trip
    // p90 was 1001ms against a p50 of 1.69ms — `DEFAULT_POLL_INTERVAL` exactly,
    // spent asleep with a claimable job sitting in the queue.
    const before = await this.#mtime(wake);

    if (await this.#hasWaiting(q)) {
      return;
    }

    // The gap between polls grows from a millisecond up to the configured
    // interval, rather than being flat. Without a push channel this loop is the
    // only thing that notices a new job, and a flat interval makes a job that
    // arrives just after a poll wait the whole of it — a tail, not an average.
    // Measured on Postgres, that was p99 53ms against a 50ms interval; backing
    // off brought it to 4ms while leaving an idle worker's cost where it was.
    let wait = 1;

    while (Date.now() < deadline && !signal?.aborted) {
      // A change to the wake file means someone added or promoted work; the
      // caller still has to claim, since another worker may get there first.
      if ((await this.#mtime(wake)) !== before) {
        return;
      }

      await sleep(Math.min(wait, Math.max(1, deadline - Date.now())), {
        unref: true,
      }).catch(() => {});
      wait = Math.min(this.#poll, wait * 2);
    }
  }

  async publish(event: DriverEvent): Promise<void> {
    this.#pruneEvents(event.ns);
    const path = this.#eventsPath(event);
    await mkdir(join(path, ".."), { recursive: true });
    // One line, appended: writes below the pipe-buffer size are atomic on
    // POSIX, so concurrent publishers cannot interleave within a line.
    await writeFile(path, `${JSON.stringify(event)}\n`, { flag: "a" });
  }

  /**
   * Drops event logs under `ns` that have nothing left worth keeping.
   *
   * **Whole files, never part of one.** A subscriber reads this log by byte
   * offset and treats the file shrinking as a rotation, starting again from
   * zero — so rewriting a log to keep its newer half would make every
   * subscriber replay the events that survived. Truncating a log whose *last*
   * write is already past the cutoff has nothing to replay.
   *
   * Modification time is the last append, which is exactly the question being
   * asked, and reading it does not mean parsing the file.
   */
  /**
   * Prunes this namespace's stored events, if it is time to.
   *
   * Deliberately not awaited: a publisher should not wait on housekeeping for
   * a log it is not reading, and a failure here costs disk rather than
   * correctness. `EventRetention` records the attempt either way, so a delete
   * that keeps failing does not become a write per event.
   */
  #pruneEvents(ns: string): void {
    const before = this.#eventRetention.due(ns);

    if (before === null) {
      return;
    }

    void this.cleanEvents(ns, before).catch(() => undefined);
  }

  async cleanEvents(ns: string, before: number): Promise<number> {
    let dropped = 0;

    for (const path of await this.#eventLogs(ns)) {
      if ((await this.#mtime(path)) >= before) {
        continue;
      }

      // Already empty: truncating it again would report work that did not
      // happen, and emptying a log updates its modification time, so every
      // later sweep would find it stale and count it afresh.
      if ((await this.#size(path)) === 0) {
        continue;
      }

      // Truncate rather than unlink: a subscriber holds the path, and an empty
      // file is the rotation it already understands.
      await Bun.write(path, "").catch(() => undefined);
      dropped++;
    }

    return dropped;
  }

  /** Every event log under one namespace, queues and runners alike. */
  async #eventLogs(ns: string): Promise<string[]> {
    const logs: string[] = [];

    const queues = join(this.root, encodeSegment(ns), "queues");
    const runners = join(this.root, encodeSegment(ns), "runners");

    for (const [dir, targets] of [
      [queues, await this.#list(queues)],
      [runners, await this.#list(runners)],
    ] as const) {
      for (const target of targets) {
        logs.push(join(dir, target, "events.jsonl"));
      }
    }

    return logs;
  }

  async subscribe<TKind extends EventKind>(
    ns: string,
    kind: TKind,
    target: string,
    listener: (event: EventOfKind<TKind>) => void,
  ): Promise<() => Promise<void>> {
    // Widened once, here, because everything below works on the envelope
    // rather than on one subsystem's events. The narrowing is the caller's:
    // asking for `"queue"` is what makes their listener see queue events only.
    const deliver = listener as (event: DriverEvent) => void;

    const path = this.#eventsPath({ ns, kind, target });
    await mkdir(join(path, ".."), { recursive: true });

    let offset = await this.#size(path);
    let stopped = false;
    /** Whether a poll is still reading, so the next one does not overlap it. */
    let reading = false;

    const timer = setInterval(() => {
      if (stopped || reading) {
        return;
      }

      reading = true;
      void (async () => {
        const size = await this.#size(path);
        if (size <= offset) {
          // A truncated (rotated) file starts over. Only trustworthy because
          // polls never overlap: a stale one could otherwise see a size below
          // an offset its successor had already moved, and replay the log.
          offset = size < offset ? 0 : offset;
          return;
        }

        const handle = await open(path, "r").catch(() => null);
        if (!handle) {
          return;
        }

        try {
          const buffer = Buffer.alloc(size - offset);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            offset,
          );

          // Complete lines only. A line can be caught half written — another
          // process's append split across writes, or a short read — and the
          // offset used to move past it all the same, so the half failed to
          // parse and the rest never started a line: the event was lost. The
          // tail after the last newline is read again, whole, next time.
          const chunk = buffer.subarray(0, bytesRead);
          const end = chunk.lastIndexOf(0x0a);
          if (end === -1) {
            return;
          }
          offset += end + 1;

          for (const line of chunk
            .subarray(0, end)
            .toString("utf8")
            .split("\n")) {
            if (!line.trim()) {
              continue;
            }
            const event = safeJsonParse<DriverEvent | null>(line, null);
            if (event && event.ns === ns && event.target === target) {
              deliver(event);
            }
          }
        } finally {
          await handle.close();
        }
      })()
        .catch(() => {
          // A failed poll is retried on the next tick.
        })
        .finally(() => {
          reading = false;
        });
    }, this.#poll);
    timer.unref?.();

    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };

    this.#subscriptions.add(stop);

    return async () => {
      stop();
      this.#subscriptions.delete(stop);
    };
  }

  /* --- paths ------------------------------------------------------------ */
  //
  // Every name becomes a file name through `file-names.ts`, never as typed:
  // on a case-insensitive filesystem (macOS, Windows) `Report` and `report`
  // would otherwise be one file. Namespaces, queue names and runner ids go
  // through `encodeSegment`, which keeps them readable; ids, state names and
  // repeat keys through `encodeName`, which also keeps their order.

  /** Directory holding one runner's lock, state and events. */
  #runnerDir(ns: string, key: string): string {
    return join(
      this.root,
      encodeSegment(ns),
      "runners",
      encodeSegment(key.replace(/^r:/, "")),
    );
  }

  /** Directory holding one queue. */
  #queueDir(q: QueueRef): string {
    return join(
      this.root,
      encodeSegment(q.ns),
      "queues",
      encodeSegment(q.queue),
    );
  }

  /**
   * Refuses an id whose *encoded* name would not fit in a file name.
   *
   * The shared character cap does not bound this. `encodeName` is a per
   * character expansion — up to 3 for ASCII punctuation and 9 for a BMP
   * character outside Latin — so an id of 191 characters, every one of them
   * legal, can encode to over 1,700. And the encoded id is only part of the
   * name: a marker prepends an ordering key, and an atomic write appends
   * `.<pid>.<uuid>.tmp`, which is the widest of them.
   *
   * Checked here, when a record is created, rather than inside `#jobPath`:
   * that is on every read too, and `getJob` of an over-long id should answer
   * `null` rather than throw. Without this the failure was an `ENAMETOOLONG`
   * rewrapped as a bare `DriverError` naming only the path — and on the marker
   * and hold paths it was swallowed entirely and reported as lost contention.
   */
  #assertNameFits(
    /** The job id or queue-state name. */
    name: string,
    /** What it is, as the message and context name it: `"id"`, `"name"`. */
    what: string,
    /** The driver operation refusing it. */
    operation: string,
  ): void {
    const encoded = encodeName(name).length;

    if (encoded > MAX_ENCODED_NAME) {
      throw new DriverError(
        "file",
        operation,
        new Error(
          `the ${what} encodes to ${encoded} bytes as a file name, and the most is ${MAX_ENCODED_NAME} (${NAME_MAX} minus ${NAME_OVERHEAD} for the marker and temp-file suffixes)`,
        ),
        { [what]: name, encoded, max: MAX_ENCODED_NAME, nameMax: NAME_MAX },
      );
    }
  }

  /** Path of a job's record. */
  #jobPath(q: QueueRef, id: string): string {
    return join(this.#queueDir(q), "jobs", `${encodeName(id)}.json`);
  }

  /**
   * Path of a job's log: one JSON-encoded line per entry, so a line holding a
   * newline still reads back as one entry.
   *
   * The name carries `createdAt` as well as the id. A job removed and added
   * again under the same id is a different job with a different `createdAt`, so
   * a log its predecessor left behind — a crash between deleting the record and
   * the log, or an append racing the removal — is never read as its own.
   */
  #logPath(q: QueueRef, record: Pick<JobRecord, "id" | "createdAt">): string {
    return join(
      this.#queueDir(q),
      "logs",
      `${encodeName(record.id)}.${record.createdAt}.jsonl`,
    );
  }

  /**
   * Path of a named value stored on a queue. Inside the queue's directory, so
   * `purge` takes it with the queue, and a lock beside it shares the stem.
   */
  #statePath(q: QueueRef, name: string): string {
    return join(this.#queueDir(q), "state", `${encodeName(name)}.json`);
  }

  /** Directory markers are moved into while their job is being changed. */
  #heldDir(q: QueueRef): string {
    return join(this.#queueDir(q), "held");
  }

  /**
   * Path of a worker's heartbeat record. Its own directory in the queue's, so
   * `purge` takes it with the queue and `listQueues` never sees it.
   */
  #workerPath(q: QueueRef, id: string): string {
    return join(this.#queueDir(q), "workers", `${encodeName(id)}.json`);
  }

  /**
   * Directory of a queue's throughput bucket files, one `<minute>.jsonl` per
   * minute. Its own directory, so no bucket name meets any other file's.
   */
  #throughputDir(q: QueueRef): string {
    return join(this.#queueDir(q), "throughput");
  }

  /**
   * Path of a repeat definition.
   *
   * The key is fitted to the file-name budget rather than refused: a series
   * key, generated or not, can be 191 legal characters that encode to far more
   * than a file name holds, and refusing it would throw where the caller never
   * chose. The fitting is invisible — `listRepeats` reads each key from the
   * record, never from a file name — and deterministic, so every lookup of one
   * key reaches one file.
   */
  #repeatPath(q: QueueRef, key: string): string {
    const name = fitName(key, {
      maxLength: MAX_ENCODED_NAME,
      measured: {
        max: MAX_ENCODED_NAME,
        measure: (value) => encodeName(value).length,
      },
    });
    return join(this.#queueDir(q), "repeats", `${encodeName(name)}.json`);
  }

  /** Path of the events log for one target. */
  #eventsPath(event: {
    ns: string;
    kind: "queue" | "runner";
    target: string;
  }): string {
    return event.kind === "queue"
      ? join(
          this.#queueDir({ ns: event.ns, queue: event.target }),
          "events.jsonl",
        )
      : join(this.#runnerDir(event.ns, event.target), "events.jsonl");
  }

  /* --- index markers ----------------------------------------------------- */

  /**
   * The marker name for a record. The prefix is what its state is ordered
   * by, zero-padded so a lexical `readdir` sort *is* the claim order.
   *
   * The id comes last, through `encodeName`, which preserves code-point order
   * and emits ASCII only. So a marker name is all ASCII, the default `sort()`
   * on markers is already byte (and so code-point) order, and ties on the
   * prefix break by id exactly as `compareCodePoints` would — non-ASCII ids
   * included, which `encodeURIComponent` (`%` sorting before every letter) got
   * wrong. The encoded id never contains `-`, so the marker splits one way.
   */
  #markerFor(record: JobRecord): string {
    switch (record.state) {
      case "waiting":
        return `${pad(record.priority + PRIORITY_OFFSET, 8)}-${pad(record.createdAt, 13)}-${encodeName(record.id)}`;
      case "delayed":
      case "failed":
        return `${pad(record.runAt, 13)}-${encodeName(record.id)}`;
      case "active":
        return activeMarker(record.lockExpiresAt ?? 0, record.id);
      // By creation, not by the finish time the default uses: a parent
      // requeued after being buried has had `finishedOn` cleared, and one
      // that still carried it would sort as if it had finished.
      case "waiting-children":
        return `${pad(record.createdAt, 13)}-${encodeName(record.id)}`;
      default:
        return `${pad(record.finishedOn ?? record.createdAt, 13)}-${encodeName(record.id)}`;
    }
  }

  /** Creates the marker for a newly added job. */
  async #addMarker(q: QueueRef, record: JobRecord): Promise<void> {
    const dir = join(this.#queueDir(q), "index", record.state);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, this.#markerFor(record)), "");
  }

  /**
   * Moves a job's marker to where `updated` belongs. The rename is the
   * mutual exclusion: whoever completes it owns the transition, and whoever
   * arrives second gets `ENOENT` and `false`.
   */
  async #move(
    q: QueueRef,
    marker: string,
    from: JobState,
    updated: JobRecord,
  ): Promise<boolean> {
    const dir = join(this.#queueDir(q), "index");
    const target = join(dir, updated.state, this.#markerFor(updated));
    await mkdir(join(dir, updated.state), { recursive: true });

    try {
      await rename(join(dir, from, marker), target);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Changes one job while holding its marker, and answers with what was
   * written — or `null` when there is no such job or `decide` refuses it.
   *
   * The marker is the job's lock everywhere else in this driver, so it is here
   * too: renamed out of the index into `held/`, which no claim, completion or
   * promotion looks in, the job cannot move under the change. The record is
   * read again once held, `decide` judges *that* copy, the record is written,
   * and the marker goes back wherever the new record says it belongs.
   *
   * Record before marker, as `promoteDelayed` does, so a crash at any point
   * leaves a hold whose record is either the old job or the new one — both
   * whole — and `#healHolds` files the marker by whichever it finds.
   *
   * `decide` is called twice, once to refuse without taking anything and once
   * under the hold, so it must not have side effects.
   */
  async #mutateJob(
    q: QueueRef,
    id: string,
    decide: (record: JobRecord) => JobRecord | null,
  ): Promise<JobRecord | null> {
    const held = await this.#holdJob(
      q,
      id,
      (record) => decide(record) !== null,
    );
    if (!held) {
      return null;
    }

    const { record: current, hold } = held;
    let updated = decide(current);

    if (!updated) {
      await this.#place(q, hold, current);
      return null;
    }

    // An active job's marker is named by its lock expiry. A change that leaves
    // that alone would put the marker back under the name it was taken from,
    // and a completion that read the record before the change would still find
    // it and write its stale copy over this one. One millisecond more lock
    // renames the marker, so that completion misses and reads again instead.
    if (
      updated.state === "active" &&
      current.state === "active" &&
      this.#markerFor(updated) === this.#markerFor(current)
    ) {
      updated = { ...updated, lockExpiresAt: (current.lockExpiresAt ?? 0) + 1 };
    }

    try {
      await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(updated));
    } catch (error) {
      await this.#place(q, hold, current);
      throw error;
    }

    await this.#release(q, hold, current, updated);
    return updated;
  }

  /**
   * Removes a job while holding its marker, and says whether it did — `false`
   * when there is no such job, `accept` refuses the record read under the
   * hold, or somebody else kept the marker past `HOLD_PATIENCE_MS`.
   *
   * Every path that deletes a job comes through here — `removeJob`,
   * `cleanJobs`, `pruneExpired`, `drainQueue` and retention, by count or on
   * completion — so none of them can forget the log, and none can race a
   * change.
   *
   * **Why a hold, rather than `updateJob` checking afterwards.** A removal
   * that just deleted the marker and the record could land while a patch held
   * the marker, and the patch's record write then brought the job back.
   * Having the patch look afterwards for a removal it missed and undo its write
   * is a check-then-act of its own: between the look and the undo, the id can
   * be added again, and the undo deletes the new job. Taking the same marker
   * leaves no window. Whichever of the two renames it first, the other cannot
   * until the first puts it back — and a removal never puts it back.
   *
   * **Log, then record, then the hold.** A crash after the log goes leaves a
   * hold `#healHolds` returns to the index with its record, so the job survives
   * the failed removal, without its log. A crash after the record goes leaves a
   * hold with no record, which it discards. Neither leaves a log without a
   * record, and `addJobLog` takes the same hold, so no append can recreate one
   * in between.
   *
   * `known` stands in for the first read when the caller has just read the
   * record anyway: a listing sweep, or retention straight after a completion.
   * The record is still read again under the hold.
   */
  async #deleteJob(
    q: QueueRef,
    id: string,
    accept: (record: JobRecord) => boolean,
    known?: JobRecord,
  ): Promise<boolean> {
    const held = await this.#holdJob(q, id, accept, known);
    if (!held) {
      return false;
    }

    await unlink(this.#logPath(q, held.record)).catch(() => undefined);

    try {
      await unlink(this.#jobPath(q, id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.#place(q, held.hold, held.record);
        throw new DriverError("file", "deleteJob", error, { id });
      }
    }

    await unlink(held.hold).catch(() => undefined);
    return true;
  }

  /**
   * Takes a job's marker out of the index for as long as the caller needs the
   * job to stand still, and answers with the record as read under the hold —
   * or `null` when there is no such job, `accept` refuses it, or somebody else
   * kept hold of it past `HOLD_PATIENCE_MS`.
   *
   * The caller owns the hold it gets back, and must end it: put the marker
   * back with `#place`/`#release`, or delete it along with the job.
   *
   * `accept` is asked twice, once before taking anything and once of the copy
   * read under the hold, so it must not have side effects.
   */
  async #holdJob(
    q: QueueRef,
    id: string,
    accept: (record: JobRecord) => boolean,
    known?: JobRecord,
  ): Promise<HeldJob | null> {
    const path = this.#jobPath(q, id);
    const deadline = Date.now() + HOLD_PATIENCE_MS;
    let first: JobRecord | undefined = known;

    for (;;) {
      const record = first ?? (await this.#readJob(path));
      first = undefined;

      if (!record || !accept(record)) {
        return null;
      }

      const marker = this.#markerFor(record);
      const hold = await this.#hold(q, record.state, marker);

      if (!hold) {
        if (Date.now() >= deadline) {
          return null;
        }

        // The marker is not where the record says. If the record has moved on
        // since, somebody finished a transition: read again and decide afresh.
        // If it has not, somebody is part-way through one — a claim renames
        // before it writes — or holds the marker; wait for them.
        const fresh = await this.#readJob(path);
        if (
          fresh &&
          fresh.state === record.state &&
          this.#markerFor(fresh) === marker
        ) {
          await this.#healHolds(q);
          await sleep(LOCK_RETRY_MS, { unref: true }).catch(() => {});
        }
        continue;
      }

      const current = await this.#readJob(path);

      if (!current) {
        await rm(hold, { force: true });
        return null;
      }

      // The record moved between the first read and the hold: the marker held
      // is not this record's. Put it where the record says and start over.
      if (
        current.state !== record.state ||
        this.#markerFor(current) !== marker
      ) {
        await this.#place(q, hold, current);
        continue;
      }

      if (!accept(current)) {
        await this.#place(q, hold, current);
        return null;
      }

      return { record: current, hold };
    }
  }

  /**
   * Takes a marker out of the index, and answers with where it now is — or
   * `null` when somebody else got to it first.
   *
   * The hold's name starts with when it was taken, which is how `#healHolds`
   * tells a hold whose process died from one still in use. A marker's own
   * modification time would not do: `rename` keeps it, and it dates from when
   * the job was added.
   */
  async #hold(
    q: QueueRef,
    state: JobState,
    marker: string,
  ): Promise<string | null> {
    const dir = this.#heldDir(q);
    const from = join(this.#queueDir(q), "index", state, marker);
    const path = join(dir, `${Date.now()}.${state}.${marker}`);

    try {
      await rename(from, path);
      return path;
    } catch {
      // Made on the first failure rather than in `ensureQueue`, which runs on
      // every add and claim; a missing directory and a missing marker both
      // arrive as ENOENT, so try once more.
      await mkdir(dir, { recursive: true });
    }

    try {
      await rename(from, path);
      return path;
    } catch {
      return null;
    }
  }

  /** Moves a marker to where `record` says it belongs. `false` when it is gone. */
  async #place(q: QueueRef, from: string, record: JobRecord): Promise<boolean> {
    const dir = join(this.#queueDir(q), "index", record.state);
    const target = join(dir, this.#markerFor(record));

    try {
      await rename(from, target);
      return true;
    } catch {
      await mkdir(dir, { recursive: true }).catch(() => undefined);
    }

    try {
      await rename(from, target);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns a held marker to the index for `after`, the record just written.
   *
   * The hold can be gone: a holder slow enough to look dead has had it filed
   * by `#healHolds`, which placed it by whichever record it read — `before` or
   * `after`. If it was `before`, move it on from there.
   */
  async #release(
    q: QueueRef,
    hold: string,
    before: JobRecord,
    after: JobRecord,
  ): Promise<void> {
    if (await this.#place(q, hold, after)) {
      return;
    }

    await this.#place(
      q,
      join(this.#queueDir(q), "index", before.state, this.#markerFor(before)),
      after,
    );
  }

  /** Files every hold older than `LOCK_STALE_MS` by its job's record. */
  async #healHolds(q: QueueRef): Promise<void> {
    const dir = this.#heldDir(q);
    const now = Date.now();

    for (const name of await this.#list(dir)) {
      const hold = parseHold(name);
      if (!hold || now - hold.stamp <= LOCK_STALE_MS) {
        continue;
      }

      const path = join(dir, name);
      const record = await this.#readJob(
        this.#jobPath(q, markerId(hold.marker)),
      );

      if (!record) {
        await rm(path, { force: true });
        continue;
      }

      await this.#place(q, path, record);
    }
  }

  /**
   * Whether a lock holder whose marker rename failed should read again and
   * retry, rather than report the lock lost.
   *
   * A failed rename used to mean exactly that. It no longer does: `updateJob`
   * may hold the marker for a moment, or have renamed it by bumping the lock a
   * millisecond. So look at the record: if the lock is still this token's, the
   * job is still ours, and the marker is either somewhere new (retry at once)
   * or on its way back (wait a beat). Only the failure path pays for this.
   */
  async #retryLostRename(
    q: QueueRef,
    id: string,
    token: string,
    marker: string,
    deadline: number,
  ): Promise<boolean> {
    if (Date.now() >= deadline) {
      return false;
    }

    const fresh = await this.#readJob(this.#jobPath(q, id));
    if (!fresh || fresh.state !== "active" || fresh.lockToken !== token) {
      return false;
    }

    if (this.#markerFor(fresh) === marker) {
      await this.#healHolds(q);
      await sleep(LOCK_RETRY_MS, { unref: true }).catch(() => {});
    }

    return true;
  }

  /**
   * Whether the job behind a waiting marker has an excluded name. `false` when
   * its record is missing: the claim's own path deals with litter.
   */
  async #isExcluded(
    q: QueueRef,
    waiting: string,
    marker: string,
    excluded: Set<string>,
  ): Promise<boolean> {
    const key = join(waiting, marker);
    let name = this.#names.get(key);

    if (name === undefined) {
      const record = await this.#readJob(this.#jobPath(q, markerId(marker)));
      if (!record) {
        return false;
      }

      name = record.name;
      if (this.#names.size >= NAME_CACHE_SIZE) {
        this.#names.delete(this.#names.keys().next().value!);
      }
      this.#names.set(key, name);
    }

    return excluded.has(name);
  }

  /**
   * Removes a finished job now, or caps how many are kept. A TTL is already in
   * the record, put there by `expiryFor` when the job finished.
   */
  async #applyRetention(
    q: QueueRef,
    record: JobRecord,
    retention: Retention,
  ): Promise<void> {
    const sameState = (candidate: JobRecord) =>
      candidate.state === record.state;

    if (retention === true) {
      await this.#deleteJob(q, record.id, sameState, record);
      return;
    }

    if (retention === false || retention === undefined) {
      return;
    }

    // A TTL is not stamped here: `expiryFor` put it in the record the
    // completion wrote. A second write afterwards, with nothing around it,
    // could land over a patch — or a patch over it, and the job would then
    // never expire.
    const count = typeof retention === "number" ? retention : retention.count;

    if (count === undefined || count < 0) {
      return;
    }

    // Markers sort by finish time, so the oldest beyond the cap are first.
    const dir = join(this.#queueDir(q), "index", record.state);
    const markers = (await this.#list(dir)).sort();

    // A child whose parent has not taken its outcome yet stays — checked
    // again under the hold, since it may be marked recorded in between.
    const sweepable = (candidate: JobRecord) =>
      sameState(candidate) && !awaitsDelivery(candidate);

    for (const marker of markers.slice(
      0,
      Math.max(0, markers.length - count),
    )) {
      const stale = await this.#readJob(this.#jobPath(q, markerId(marker)));
      if (stale && !awaitsDelivery(stale)) {
        await this.#deleteJob(q, stale.id, sweepable, stale);
      }
    }
  }

  /* --- read API helpers ---------------------------------------------------- */

  /** The records behind some index markers, read at once; `null` where missing. */
  async #readMarked(
    q: QueueRef,
    markers: string[],
  ): Promise<(JobRecord | null)[]> {
    return await Promise.all(
      markers.map(
        async (marker) =>
          await this.#readJob(this.#jobPath(q, markerId(marker))),
      ),
    );
  }

  /**
   * Deletes a worker record found lapsed at `now` — unless the worker reported
   * again since it was read. The record is renamed aside first, which exactly
   * one caller wins, and the copy it moved is read again: still lapsed, it is
   * dropped; live, it goes back, unless a newer report has taken the path.
   */
  async #dropLapsedWorker(path: string, now: number): Promise<void> {
    const aside = `${path}.${newId()}.lapsed`;

    try {
      await rename(path, aside);
    } catch {
      return;
    }

    const moved = await this.#readJson<WorkerInfo>(aside);
    if (moved && moved.expiresAt > now) {
      await link(aside, path).catch(() => undefined);
    }
    await rm(aside, { force: true });
  }

  /**
   * Writes one batch of throughput counts: a JSON line per entry, appended to
   * its queue's `throughput/<minute>.jsonl`.
   *
   * No lock. Each append is one small `O_APPEND` write, which POSIX makes
   * atomic, so processes appending to the same minute cannot interleave within
   * a line — and each line is this process's count, summed on read. An entry
   * whose append fails is counted again for the next flush rather than failing
   * the batch, which would re-add the entries that did land and count them
   * twice. Then, per queue written, minute files older than the retention
   * before the latest minute in the batch are deleted: one listing per queue
   * per flush, never per job.
   */
  async #writeThroughput(
    batch: PendingThroughput[],
  ): Promise<ThroughputWriteResult> {
    const latest = new Map<string, number>();
    const unwritten: PendingThroughput[] = [];
    let failure: unknown;

    for (const entry of batch) {
      const dir = this.#throughputDir(entry.q);
      const line = `${JSON.stringify({
        at: entry.at,
        completed: entry.completed,
        failed: entry.failed,
      })}\n`;

      try {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${entry.at}.jsonl`), line, { flag: "a" });
      } catch (error) {
        // Reported, so only this line is written again.
        unwritten.push(entry);
        failure ??= error;
        continue;
      }

      latest.set(dir, Math.max(latest.get(dir) ?? entry.at, entry.at));
    }

    for (const [dir, at] of latest) {
      const cutoff = at - THROUGHPUT_RETENTION_MS;

      for (const file of await this.#list(dir)) {
        const match = THROUGHPUT_FILE.exec(file);
        if (match && Number(match[1]) < cutoff) {
          await unlink(join(dir, file)).catch(() => undefined);
        }
      }
    }

    return failure === undefined
      ? { unwritten }
      : { unwritten, error: failure };
  }

  /* --- primitives --------------------------------------------------------- */

  /**
   * Directory entries, or `[]` when the directory does not exist yet.
   * Temporary files from an interrupted atomic write are skipped, so a crash
   * mid-write cannot be mistaken for an index entry.
   */
  async #list(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).filter((entry) => !entry.endsWith(".tmp"));
    } catch {
      return [];
    }
  }

  /**
   * Directory names under `dir`, decoded back into the segments they encode.
   * An entry `encodeSegment` could not have written is not one of ours.
   */
  async #listSegments(dir: string): Promise<string[]> {
    const segments: string[] = [];

    for (const entry of await this.#list(dir)) {
      const segment = decodeSegment(entry);
      if (segment !== null) {
        segments.push(segment);
      }
    }

    return segments;
  }

  /** A file's text, or `""` when it is missing. */
  async #readText(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }

  /**
   * A job's record, or `null` when it is missing or malformed.
   *
   * Every record read goes through here rather than `#readJson`, because a
   * record written before flows existed has no `flow` key at all, and the
   * contract says `null`. Filling it in at the one place records are read
   * means no caller sees `undefined`, and no write carries it forward.
   */
  async #readJob(path: string): Promise<JobRecord | null> {
    const record = await this.#readJson<JobRecord>(path);
    if (record && record.flow === undefined) {
      record.flow = null;
    }
    return record;
  }

  /** Parses a JSON file, or `null` when it is missing or malformed. */
  async #readJson<T>(path: string): Promise<T | null> {
    try {
      return safeJsonParse<T | null>(await readFile(path, "utf8"), null);
    } catch {
      return null;
    }
  }

  /**
   * Creates a file only if it does not exist. `O_EXCL` is the primitive the
   * whole driver rests on: exactly one caller can win.
   */
  async #createExclusive(path: string, contents: string): Promise<boolean> {
    await mkdir(join(path, ".."), { recursive: true });

    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(contents);
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw new DriverError("file", "createExclusive", error, { path });
    }
  }

  /** Writes via a temp file and a rename, so a reader never sees a partial file. */
  async #writeAtomic(path: string, contents: string): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    const temp = `${path}.${process.pid}.${newId()}.tmp`;

    try {
      // `Bun.write` rather than `node:fs`. Measured on this exact shape — a
      // ~400 byte JSON record — it is 7.3us against 19.1us, and this runs on
      // every add, claim, promotion and completion. Reads stay on `node:fs`:
      // `Bun.file().json()` measured 16.8us against 16.4us, so there is
      // nothing to gain and it reports a missing file differently.
      await Bun.write(temp, contents);
      await rename(temp, path);
    } catch (error) {
      // Best effort: the temp file may never have been created — a name too
      // long fails before it is — and a failure here must not replace the
      // error that explains what went wrong.
      await rm(temp, { force: true }).catch(() => undefined);
      throw new DriverError("file", "writeAtomic", error, { path });
    }
  }

  /** Modification time in milliseconds, or `0` when the file is absent. */
  /**
   * Whether anything is sitting in the queue's waiting index.
   *
   * Only asked once per wait, at the top, so the cost is a single `readdir` on
   * a directory that is almost always empty — a caller only waits because its
   * claim just came back with nothing.
   */
  async #hasWaiting(q: QueueRef): Promise<boolean> {
    const waiting = join(this.#queueDir(q), "index", "waiting");
    return (await this.#list(waiting)).length > 0;
  }

  async #mtime(path: string): Promise<number> {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** File size in bytes, or `0` when absent. */
  async #size(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  }

  /** Touches the file workers watch for new work. */
  async #touchWake(q: QueueRef): Promise<void> {
    await this.#writeAtomic(
      join(this.#queueDir(q), "wake"),
      String(Date.now()),
    );
  }

  /** Merges fields into a queue's metadata. */
  async #setMeta(q: QueueRef, fields: Record<string, unknown>): Promise<void> {
    await this.ensureQueue(q);
    const path = join(this.#queueDir(q), "meta.json");
    const meta = (await this.#readJson<Record<string, unknown>>(path)) ?? {};
    await this.#writeAtomic(path, JSON.stringify({ ...meta, ...fields }));
  }

  /** A runner's persisted state, with defaults for a first read. */
  async #readState(
    ns: string,
    key: string,
  ): Promise<{
    fields: Record<string, string>;
    history: RunRecord[];
    queued: QueuedTrigger[];
  }> {
    const state = await this.#readJson<{
      fields?: Record<string, string>;
      history?: RunRecord[];
      queued?: QueuedTrigger[];
    }>(join(this.#runnerDir(ns, key), "state.json"));

    return {
      fields: state?.fields ?? {},
      history: state?.history ?? [],
      queued: state?.queued ?? [],
    };
  }

  /**
   * Read-modify-writes a runner's state while holding an exclusive lock file,
   * so two processes cannot both read, both modify, and both write.
   */
  async #mutateState(
    ns: string,
    key: string,
    mutate: (state: {
      fields: Record<string, string>;
      history: RunRecord[];
      queued: QueuedTrigger[];
    }) => void,
  ): Promise<void> {
    const dir = this.#runnerDir(ns, key);
    await mkdir(dir, { recursive: true });
    const lock = join(dir, "state.lock");
    const release = await this.#lockFile(lock);

    try {
      const state = await this.#readState(ns, key);
      mutate(state);
      await this.#writeAtomic(join(dir, "state.json"), JSON.stringify(state));
    } finally {
      await release();
    }
  }

  /** Takes an exclusive lock file, breaking one left behind by a crash. */
  async #lockFile(path: string): Promise<() => Promise<void>> {
    const deadline = Date.now() + LOCK_WAIT_MS;

    while (Date.now() < deadline) {
      if (await this.#createExclusive(path, String(Date.now()))) {
        return async () => {
          await rm(path, { force: true });
        };
      }

      const held = await this.#mtime(path);
      if (held > 0 && Date.now() - held > LOCK_STALE_MS) {
        // Whoever held this is gone; break it and race for it again.
        //
        // By renaming it aside, not deleting it. Two processes can both judge
        // the same lock stale, and with `rm` the slower one deletes the lock the
        // faster one has just created in its place — both then hold it, which
        // for `setQueueState` means two compare-and-sets winning. Only one
        // rename of a given file succeeds, and the file it moved is checked:
        // still stale, it is dropped; fresh, it was somebody's live lock, and
        // goes back unless the path has been taken again meanwhile.
        const aside = `${path}.${newId()}.stale`;
        try {
          await rename(path, aside);
        } catch {
          continue;
        }

        if (Date.now() - (await this.#mtime(aside)) <= LOCK_STALE_MS) {
          await link(aside, path).catch(() => undefined);
        }
        await rm(aside, { force: true });
        continue;
      }

      await sleep(LOCK_RETRY_MS, { unref: true }).catch(() => {});
    }

    throw new DriverError(
      "file",
      "lockFile",
      new Error(`Timed out waiting for ${path}`),
      { path },
    );
  }
}

/** A job whose marker the caller has taken out of the index. */
interface HeldJob {
  /** The job's record, as read once the marker was held. */
  record: JobRecord;
  /** Where the marker is while held; the caller must place or delete it. */
  hold: string;
}

/**
 * When a finished job should expire under `retention`: now plus its TTL when
 * it has one, and otherwise whatever the record already said.
 */
function expiryFor(
  retention: Retention,
  now: number,
  current: number | null,
): number | null {
  if (typeof retention === "object" && retention.ttl && retention.ttl > 0) {
    return now + retention.ttl;
  }
  return current;
}

/** Left-pads a number so lexical order matches numeric order. */
function pad(value: number, width: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(width, "0");
}

/** The marker name of an active job, which is ordered by its lock expiry. */
function activeMarker(lockExpiresAt: number, id: string): string {
  return `${pad(lockExpiresAt, 13)}-${encodeName(id)}`;
}

/** Splits a hold's name into when it was taken and the marker it holds. */
function parseHold(name: string): { stamp: number; marker: string } | null {
  // `<stamp>.<state>.<marker>`: none of the three contains a dot (an encoded
  // id never does), but reading only the first two keeps that from mattering.
  const first = name.indexOf(".");
  const second = name.indexOf(".", first + 1);
  const stamp = Number(name.slice(0, first));

  if (first <= 0 || second <= first || !Number.isFinite(stamp)) {
    return null;
  }

  return { stamp, marker: name.slice(second + 1) };
}

/** How many newline-terminated lines `text` holds. */
function countLines(text: string): number {
  let count = 0;
  for (
    let at = text.indexOf("\n");
    at !== -1;
    at = text.indexOf("\n", at + 1)
  ) {
    count++;
  }
  return count;
}

/** `text` without its first `lines` lines. */
function dropLines(text: string, lines: number): string {
  let at = -1;
  for (let dropped = 0; dropped < lines; dropped++) {
    at = text.indexOf("\n", at + 1);
    if (at === -1) {
      return "";
    }
  }
  return text.slice(at + 1);
}

/**
 * The job id encoded in a marker name.
 *
 * Everything after the last `-`, because `encodeName` never emits one. The
 * old URI-encoded ids kept their dashes, and telling a waiting marker's two
 * numeric prefixes from one prefix and an id that merely *began* with digits
 * and a dash — `1700000000000-abc`, delayed — was a guess that got it wrong.
 *
 * `""` for a name this driver did not write: no record lives there, so every
 * caller treats the file as litter.
 */
function markerId(marker: string): string {
  return decodeName(marker.slice(marker.lastIndexOf("-") + 1)) ?? "";
}
