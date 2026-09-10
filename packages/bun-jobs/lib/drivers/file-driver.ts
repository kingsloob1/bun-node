import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  ClaimOptions,
  DriverCapabilities,
  DriverEvent,
  FailOutcome,
  JobRecord,
  JobsDriver,
  JobState,
  LockInfo,
  QueuedTrigger,
  QueueRef,
  RepeatRecord,
  Retention,
  RunRecord,
} from "./driver";
import { Buffer } from "node:buffer";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { jsonClone, sleep } from "@kingsleyweb/bun-common";
import { DriverError } from "../shared/errors";
import { newId } from "../shared/ids";
import { safeJsonParse } from "../shared/json";
import { PauseCache } from "../shared/pauseCache";

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
];

/** States holding a job that is due later. */
const SCHEDULED_STATES: JobState[] = ["delayed", "failed"];

/** Priorities may be negative; the offset keeps marker names sortable. */
const PRIORITY_OFFSET = 1_048_576;

/** Options for {@link FileDriver}. */
export interface FileDriverOptions {
  /** Directory the driver owns. Created on demand. */
  root: string;
  /** How often to poll for new work and events. Defaults to 25ms. */
  pollInterval?: number;
}

export class FileDriver implements JobsDriver {
  /** Identifies the implementation in errors and capability checks. */
  readonly name = "file";

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

  constructor(options: FileDriverOptions) {
    this.root = options.root;
    this.#poll = options.pollInterval ?? POLL_MS;
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
    await rm(join(this.root, ns), { recursive: true, force: true });
  }

  async listRunners(ns: string): Promise<string[]> {
    return await this.#list(join(this.root, ns, "runners"));
  }

  async listQueues(ns: string): Promise<string[]> {
    return await this.#list(join(this.root, ns, "queues"));
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
    let trigger: QueuedTrigger | null = null;

    await this.#mutateState(ns, key, (state) => {
      trigger = state.queued.shift() ?? null;
    });

    return trigger;
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
    await this.ensureQueue(q);
    const path = this.#jobPath(q, job.id);
    const record = jsonClone(job);

    // The record file *is* the idempotency key: exactly one caller creates it.
    if (!(await this.#createExclusive(path, JSON.stringify(record)))) {
      const existing = await this.#readJson<JobRecord>(path);
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

    for (const marker of markers) {
      const id = markerId(marker);
      const record = await this.#readJson<JobRecord>(this.#jobPath(q, id));

      if (!record) {
        // The record is gone: the marker is litter from a removed job.
        await rm(join(waiting, marker), { force: true });
        continue;
      }

      if (record.state !== "waiting" || record.runAt > opts.now) {
        // A marker that disagrees with its record is a crash between two
        // writes; heal it rather than claiming something twice.
        if (record.state !== "waiting") {
          await rm(join(waiting, marker), { force: true });
        }
        continue;
      }

      const claimed: JobRecord = {
        ...record,
        state: "active",
        attemptsMade: record.attemptsMade + 1,
        processedOn: opts.now,
        lockToken: opts.token,
        lockExpiresAt: opts.now + opts.lockMs,
        workerId: opts.workerId,
      };

      // Whoever renames the marker owns the job. The loser gets ENOENT.
      if (!(await this.#move(q, marker, "waiting", claimed))) {
        continue;
      }

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
    const record = await this.#readJson<JobRecord>(this.#jobPath(q, id));
    if (!record || record.state !== "active" || record.lockToken !== token) {
      return false;
    }

    const marker = this.#markerFor(record);
    const updated = { ...record, lockExpiresAt: now + lockMs };

    if (!(await this.#move(q, marker, "active", updated))) {
      return false;
    }

    await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(updated));
    return true;
  }

  async completeJob(
    q: QueueRef,
    id: string,
    token: string,
    result: unknown,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    const record = await this.#readJson<JobRecord>(this.#jobPath(q, id));
    if (!record || record.state !== "active" || record.lockToken !== token) {
      return false;
    }

    const completed: JobRecord = {
      ...record,
      state: "completed",
      finishedOn: now,
      returnValue: jsonClone(result),
      lockToken: null,
      lockExpiresAt: null,
      workerId: null,
    };

    if (!(await this.#move(q, this.#markerFor(record), "active", completed))) {
      return false;
    }

    await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(completed));
    await this.#applyRetention(q, completed, retention, now);
    return true;
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
    const record = await this.#readJson<JobRecord>(this.#jobPath(q, id));
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
      : { ...base, state: "dead", finishedOn: now };

    if (!(await this.#move(q, this.#markerFor(record), "active", updated))) {
      return false;
    }

    await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(updated));

    if (!outcome.retry) {
      await this.#applyRetention(q, updated, outcome.retention, now);
    }

    return true;
  }

  async updateProgress(
    q: QueueRef,
    id: string,
    progress: unknown,
  ): Promise<boolean> {
    const path = this.#jobPath(q, id);
    const record = await this.#readJson<JobRecord>(path);
    if (!record) {
      return false;
    }

    await this.#writeAtomic(
      path,
      JSON.stringify({ ...record, progress: jsonClone(progress) }),
    );
    return true;
  }

  async getJob(q: QueueRef, id: string): Promise<JobRecord | null> {
    return await this.#readJson<JobRecord>(this.#jobPath(q, id));
  }

  async listJobs(
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<JobRecord[]> {
    const dir = this.#queueDir(q);
    const found: JobRecord[] = [];

    for (const state of states) {
      const markers = (await this.#list(join(dir, "index", state))).sort();
      for (const marker of markers) {
        const record = await this.#readJson<JobRecord>(
          this.#jobPath(q, markerId(marker)),
        );
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
    } satisfies Record<JobState, number>;

    for (const state of STATES) {
      counts[state] = (await this.#list(join(dir, "index", state))).length;
    }

    return counts;
  }

  async removeJob(q: QueueRef, id: string): Promise<boolean> {
    const record = await this.#readJson<JobRecord>(this.#jobPath(q, id));
    if (!record || record.state === "active") {
      return false;
    }

    await this.#delete(q, record);
    return true;
  }

  async retryJob(
    q: QueueRef,
    id: string,
    resetAttempts: boolean,
    now: number,
  ): Promise<boolean> {
    const record = await this.#readJson<JobRecord>(this.#jobPath(q, id));
    if (!record || record.state === "active" || record.state === "waiting") {
      return false;
    }

    const updated: JobRecord = {
      ...record,
      state: "waiting",
      runAt: now,
      finishedOn: null,
      expiresAt: null,
      ...(resetAttempts ? { attemptsMade: 0, stalledCount: 0 } : {}),
    };

    await this.#move(q, this.#markerFor(record), record.state, updated);
    await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(updated));
    await this.#touchWake(q);
    return true;
  }

  async promoteJob(q: QueueRef, id: string, now: number): Promise<boolean> {
    const record = await this.#readJson<JobRecord>(this.#jobPath(q, id));
    if (!record || !SCHEDULED_STATES.includes(record.state)) {
      return false;
    }

    const updated: JobRecord = { ...record, state: "waiting", runAt: now };
    if (
      !(await this.#move(q, this.#markerFor(record), record.state, updated))
    ) {
      return false;
    }

    await this.#writeAtomic(this.#jobPath(q, id), JSON.stringify(updated));
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

        const record = await this.#readJson<JobRecord>(
          this.#jobPath(q, markerId(marker)),
        );
        if (!record || record.state !== state || record.runAt > now) {
          continue;
        }

        const updated: JobRecord = { ...record, state: "waiting" };
        if (!(await this.#move(q, marker, state, updated))) {
          continue;
        }

        await this.#writeAtomic(
          this.#jobPath(q, record.id),
          JSON.stringify(updated),
        );
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

    for (const marker of (await this.#list(dir)).sort()) {
      if (requeued.length + dead.length >= limit) {
        break;
      }

      // The marker's prefix is when the lock expires.
      if (Number(marker.split("-")[0]) > now) {
        break;
      }

      const record = await this.#readJson<JobRecord>(
        this.#jobPath(q, markerId(marker)),
      );
      if (!record || record.state !== "active") {
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

    return { requeued, dead };
  }

  async cleanJobs(
    q: QueueRef,
    state: "completed" | "failed" | "dead" | "waiting" | "delayed",
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

      const record = await this.#readJson<JobRecord>(
        this.#jobPath(q, markerId(marker)),
      );
      if (!record || record.state !== state) {
        continue;
      }

      if ((record.finishedOn ?? record.createdAt) <= cutoff) {
        await this.#delete(q, record);
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

        const record = await this.#readJson<JobRecord>(
          this.#jobPath(q, markerId(marker)),
        );
        if (record?.expiresAt !== null && (record?.expiresAt ?? 0) <= now) {
          if (record) {
            await this.#delete(q, record);
            removed++;
          }
        }
      }
    }

    return removed;
  }

  async drainQueue(q: QueueRef, includeDelayed: boolean): Promise<number> {
    const states: JobState[] = includeDelayed
      ? ["waiting", ...SCHEDULED_STATES]
      : ["waiting"];
    let removed = 0;

    for (const state of states) {
      for (const marker of await this.#list(
        join(this.#queueDir(q), "index", state),
      )) {
        const record = await this.#readJson<JobRecord>(
          this.#jobPath(q, markerId(marker)),
        );
        if (record && record.state === state) {
          await this.#delete(q, record);
          removed++;
        }
      }
    }

    return removed;
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
    const before = await this.#mtime(wake);

    while (Date.now() < deadline && !signal?.aborted) {
      // A change to the wake file means someone added or promoted work; the
      // caller still has to claim, since another worker may get there first.
      if ((await this.#mtime(wake)) !== before) {
        return;
      }

      await sleep(Math.min(this.#poll, Math.max(1, deadline - Date.now())), {
        unref: true,
      }).catch(() => {});
    }
  }

  async publish(event: DriverEvent): Promise<void> {
    const path = this.#eventsPath(event);
    await mkdir(join(path, ".."), { recursive: true });
    // One line, appended: writes below the pipe-buffer size are atomic on
    // POSIX, so concurrent publishers cannot interleave within a line.
    await writeFile(path, `${JSON.stringify(event)}\n`, { flag: "a" });
  }

  async subscribe(
    ns: string,
    kind: "queue" | "runner",
    target: string,
    listener: (event: DriverEvent) => void,
  ): Promise<() => Promise<void>> {
    const path = this.#eventsPath({ ns, kind, target });
    await mkdir(join(path, ".."), { recursive: true });

    let offset = await this.#size(path);
    let stopped = false;

    const timer = setInterval(() => {
      void (async () => {
        if (stopped) {
          return;
        }

        const size = await this.#size(path);
        if (size <= offset) {
          // A truncated (rotated) file starts over.
          offset = size < offset ? 0 : offset;
          return;
        }

        const handle = await open(path, "r").catch(() => null);
        if (!handle) {
          return;
        }

        try {
          const buffer = Buffer.alloc(size - offset);
          await handle.read(buffer, 0, buffer.length, offset);
          offset = size;

          for (const line of buffer.toString("utf8").split("\n")) {
            if (!line.trim()) {
              continue;
            }
            const event = safeJsonParse<DriverEvent | null>(line, null);
            if (event && event.ns === ns && event.target === target) {
              listener(event);
            }
          }
        } finally {
          await handle.close();
        }
      })();
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

  /** Directory holding one runner's lock, state and events. */
  #runnerDir(ns: string, key: string): string {
    return join(this.root, ns, "runners", key.replace(/^r:/, ""));
  }

  /** Directory holding one queue. */
  #queueDir(q: QueueRef): string {
    return join(this.root, q.ns, "queues", q.queue);
  }

  /** Path of a job's record. */
  #jobPath(q: QueueRef, id: string): string {
    return join(this.#queueDir(q), "jobs", `${encodeURIComponent(id)}.json`);
  }

  /** Path of a repeat definition. */
  #repeatPath(q: QueueRef, key: string): string {
    return join(
      this.#queueDir(q),
      "repeats",
      `${encodeURIComponent(key)}.json`,
    );
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
   */
  #markerFor(record: JobRecord): string {
    switch (record.state) {
      case "waiting":
        return `${pad(record.priority + PRIORITY_OFFSET, 8)}-${pad(record.createdAt, 13)}-${encodeURIComponent(record.id)}`;
      case "delayed":
      case "failed":
        return `${pad(record.runAt, 13)}-${encodeURIComponent(record.id)}`;
      case "active":
        return `${pad(record.lockExpiresAt ?? 0, 13)}-${encodeURIComponent(record.id)}`;
      default:
        return `${pad(record.finishedOn ?? record.createdAt, 13)}-${encodeURIComponent(record.id)}`;
    }
  }

  /** Creates the marker for a newly added job. */
  async #addMarker(q: QueueRef, record: JobRecord): Promise<void> {
    const dir = join(this.#queueDir(q), "index", record.state);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, this.#markerFor(record)), "");
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

  /** Removes a job: its marker first, so nothing can claim a missing record. */
  async #delete(q: QueueRef, record: JobRecord): Promise<void> {
    await rm(
      join(this.#queueDir(q), "index", record.state, this.#markerFor(record)),
      {
        force: true,
      },
    );
    await rm(this.#jobPath(q, record.id), { force: true });
  }

  /** Removes a finished job now, caps how many are kept, or stamps its TTL. */
  async #applyRetention(
    q: QueueRef,
    record: JobRecord,
    retention: Retention,
    now: number,
  ): Promise<void> {
    if (retention === true) {
      await this.#delete(q, record);
      return;
    }

    if (retention === false || retention === undefined) {
      return;
    }

    const count = typeof retention === "number" ? retention : retention.count;
    const ttl = typeof retention === "number" ? undefined : retention.ttl;

    if (ttl && ttl > 0) {
      await this.#writeAtomic(
        this.#jobPath(q, record.id),
        JSON.stringify({ ...record, expiresAt: now + ttl }),
      );
    }

    if (count === undefined || count < 0) {
      return;
    }

    // Markers sort by finish time, so the oldest beyond the cap are first.
    const dir = join(this.#queueDir(q), "index", record.state);
    const markers = (await this.#list(dir)).sort();

    for (const marker of markers.slice(
      0,
      Math.max(0, markers.length - count),
    )) {
      const stale = await this.#readJson<JobRecord>(
        this.#jobPath(q, markerId(marker)),
      );
      if (stale) {
        await this.#delete(q, stale);
      }
    }
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
      await writeFile(temp, contents);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw new DriverError("file", "writeAtomic", error, { path });
    }
  }

  /** Modification time in milliseconds, or `0` when the file is absent. */
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
        await rm(path, { force: true });
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

/** Left-pads a number so lexical order matches numeric order. */
function pad(value: number, width: number): string {
  return String(Math.max(0, Math.floor(value))).padStart(width, "0");
}

/** The job id encoded in a marker name. */
function markerId(marker: string): string {
  const parts = marker.split("-");
  // Ids are URI-encoded, so any "-" beyond the numeric prefixes is part of it.
  const prefixes = parts.length > 2 && /^\d+$/.test(parts[1]) ? 2 : 1;
  return decodeURIComponent(parts.slice(prefixes).join("-"));
}
