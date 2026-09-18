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
import { jsonClone } from "@kingsleyweb/bun-common";
import { assertWritableStateName } from "../queue/windows";
import { compareCodePoints } from "../shared/strings";
import { awaitsDelivery, flowKey, listsChild, unsettledChildren } from "./flow";
import {
  jobFilter,
  matchesFilter,
  orderByIds,
  sortWorkers,
  sumBuckets,
  THROUGHPUT_RETENTION_MS,
  throughputBucket,
} from "./readApis";

/**
 * The in-process driver: `Map`s, no I/O, no dependencies.
 *
 * It is the reference implementation of the contract — every rule the other
 * drivers work to reproduce is readable here in a few lines — and the backend
 * the test suite runs against by default. It is also genuinely useful for a
 * single-process application that wants scheduling and a queue without
 * standing up Redis.
 *
 * Atomicity is free: every operation below runs to completion without
 * awaiting, so the event loop cannot interleave two of them. That is exactly
 * what the other drivers buy with `SET NX`, `SKIP LOCKED` and `rename`.
 *
 * What it cannot do is cross a process. `capabilities.multiProcess` is
 * `false`, and a runner lock taken here means nothing to another process — so
 * a `single`-mode runner is only cluster-wide with a shared backend.
 */

/** A runner's stored state. */
interface RunnerState {
  /** The current lock, if held. */
  lock?: LockInfo;
  /** State fields, including counters. */
  fields: Map<string, string>;
  /** Run history, newest first. */
  history: RunRecord[];
  /** Triggers parked while a run holds the lock, oldest first. */
  queued: QueuedTrigger[];
}

/** A queue's stored state. */
interface QueueState {
  /** Every job, by id. */
  jobs: Map<string, JobRecord>;
  /** Insertion order, for a stable FIFO tie-break at equal priority. */
  order: Map<string, number>;
  /**
   * Ids of the waiting jobs, kept in claim order.
   *
   * Claiming used to build this list every time: materialise every job in the
   * queue, filter it down to the waiting ones, sort them, take the first.
   * That is O(n log n) per claim over jobs that are mostly not candidates, and
   * it showed — 0.022ms per claim at a backlog of 100 against 0.308ms at
   * 5,000, so the in-process driver drained at 7,088/s where Redis, over a
   * socket, managed 37,165/s.
   *
   * Maintained by {@link MemoryDriver.#setState} alone, which is what keeps it
   * honest: every state change in this driver goes through there.
   */
  waiting: string[];
  /**
   * Where {@link QueueState.waiting} actually starts.
   *
   * Claiming takes from the front, and splicing index 0 of a long array moves
   * every remaining element. A cursor makes that O(1); the dead prefix is
   * compacted once it is worth the copy.
   */
  waitingFrom: number;
  /**
   * How many jobs are `delayed` or `failed`.
   *
   * Promotion used to walk every job in the queue before every claim, looking
   * for something due. Almost always there is nothing scheduled at all, and a
   * count says so without looking.
   */
  scheduled: number;
  /** Repeat definitions, by key. */
  repeats: Map<string, RepeatRecord>;
  /**
   * Each job's log lines, oldest first, by job id.
   *
   * Removed in {@link MemoryDriver.#delete}, which every removal goes through,
   * so a log cannot outlive its job or be inherited by a later job that
   * reuses the id.
   */
  logs: Map<string, string[]>;
  /** Named values stored on the queue, for compare-and-set. */
  state: Map<string, QueueStateEntry>;
  /** Worker heartbeat records, by worker id; lapsed ones are dropped when listed. */
  workers: Map<string, WorkerInfo>;
  /**
   * Completions and failed attempts per minute, by the minute's start. Counted
   * in `completeJob` and `failJob`; minutes older than the retention before
   * the latest are dropped when a new minute starts.
   */
  throughput: Map<number, ThroughputBucket>;
  /** Whether claiming is paused for every worker. */
  paused: boolean;
  /** Next insertion sequence number. */
  seq: number;
  /** Resolvers of the callers waiting in `waitForJob`. */
  waiters: Set<() => void>;
}

/** Everything stored under one namespace. */
interface NamespaceState {
  /** Runner state, by runner key. */
  runners: Map<string, RunnerState>;
  /** Queue state, by queue name. */
  queues: Map<string, QueueState>;
  /** Event listeners, by `<kind>:<target>`. */
  subscribers: Map<string, Set<(event: DriverEvent) => void>>;
}

/** States a job can be claimed from once due. */
const PENDING_STATES: JobState[] = ["waiting"];

/** States holding a job that is due later. */
const SCHEDULED_STATES: JobState[] = ["delayed", "failed"];

/** How long a claimed-out prefix may grow before the waiting list is copied. */
const COMPACT_AFTER = 1_000;

export class MemoryDriver implements JobsDriver {
  /** Identifies the implementation in errors and capability checks. */
  readonly name = "memory";

  /** In-process only: no other process can see these `Map`s. */
  readonly capabilities: DriverCapabilities = {
    blockingWait: true,
    events: "local",
    multiProcess: false,
    multiHost: false,
  };

  /** All state, by namespace. */
  readonly #namespaces = new Map<string, NamespaceState>();

  /* --- lifecycle --------------------------------------------------- */

  async connect(): Promise<void> {
    // Nothing to open; `connect()` exists so callers need not special-case.
  }

  async close(): Promise<void> {
    // Release anyone blocked in `waitForJob`, or their promises never settle.
    for (const namespace of this.#namespaces.values()) {
      for (const queue of namespace.queues.values()) {
        for (const wake of queue.waiters) {
          wake();
        }
        queue.waiters.clear();
      }
      namespace.subscribers.clear();
    }
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async purge(ns: string): Promise<void> {
    const namespace = this.#namespaces.get(ns);
    if (!namespace) {
      return;
    }

    for (const queue of namespace.queues.values()) {
      for (const wake of queue.waiters) {
        wake();
      }
    }
    this.#namespaces.delete(ns);
  }

  async listRunners(ns: string): Promise<string[]> {
    return [...(this.#namespaces.get(ns)?.runners.keys() ?? [])].map((key) =>
      key.replace(/^r:/, ""),
    );
  }

  async listQueues(ns: string): Promise<string[]> {
    return [...(this.#namespaces.get(ns)?.queues.keys() ?? [])];
  }

  /* --- runner: locks ----------------------------------------------- */

  async acquireLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    const runner = this.#runner(ns, key);
    const held = runner.lock;

    if (held && held.expiresAt > now && held.token !== token) {
      return false;
    }

    runner.lock = { token, expiresAt: now + ttlMs };
    return true;
  }

  async renewLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    const runner = this.#runner(ns, key);
    if (!runner.lock || runner.lock.token !== token) {
      return false;
    }

    // An expired lock is not renewable: someone else may already have taken
    // it, so the caller has to learn it lost rather than quietly continue.
    if (runner.lock.expiresAt <= now) {
      return false;
    }

    runner.lock.expiresAt = now + ttlMs;
    return true;
  }

  async releaseLock(ns: string, key: string, token: string): Promise<boolean> {
    const runner = this.#runner(ns, key);
    if (!runner.lock || runner.lock.token !== token) {
      return false;
    }

    runner.lock = undefined;
    return true;
  }

  async getLock(
    ns: string,
    key: string,
    now: number,
  ): Promise<LockInfo | null> {
    const held = this.#existingRunner(ns, key)?.lock;
    return held && held.expiresAt > now ? { ...held } : null;
  }

  /* --- runner: state, history, queued triggers ---------------------- */

  async getState(ns: string, key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.#existingRunner(ns, key)?.fields ?? []);
  }

  async setState(
    ns: string,
    key: string,
    fields: Record<string, string | number | null>,
  ): Promise<void> {
    const runner = this.#runner(ns, key);
    for (const [field, value] of Object.entries(fields)) {
      if (value === null) {
        runner.fields.delete(field);
      } else {
        runner.fields.set(field, String(value));
      }
    }
  }

  async incrementCounters(
    ns: string,
    key: string,
    deltas: Record<string, number>,
  ): Promise<Record<string, number>> {
    const runner = this.#runner(ns, key);
    const updated: Record<string, number> = {};

    for (const [field, delta] of Object.entries(deltas)) {
      const current = Number(runner.fields.get(field) ?? 0);
      const next = (Number.isFinite(current) ? current : 0) + delta;
      runner.fields.set(field, String(next));
      updated[field] = next;
    }

    return updated;
  }

  async appendHistory(
    ns: string,
    key: string,
    record: RunRecord,
    keep: number,
  ): Promise<void> {
    const runner = this.#runner(ns, key);
    runner.history.unshift(jsonClone(record));
    if (keep > 0 && runner.history.length > keep) {
      runner.history.length = keep;
    }
  }

  async updateHistory(
    ns: string,
    key: string,
    runId: string,
    patch: Partial<RunRecord>,
  ): Promise<boolean> {
    const runner = this.#runner(ns, key);
    const index = runner.history.findIndex((entry) => entry.runId === runId);
    if (index === -1) {
      return false;
    }

    runner.history[index] = { ...runner.history[index], ...jsonClone(patch) };
    return true;
  }

  async listHistory(
    ns: string,
    key: string,
    limit?: number,
  ): Promise<RunRecord[]> {
    const history = this.#existingRunner(ns, key)?.history ?? [];
    const slice = limit && limit > 0 ? history.slice(0, limit) : history;
    return slice.map((entry) => ({ ...entry }));
  }

  async clearHistory(ns: string, key: string): Promise<void> {
    this.#runner(ns, key).history = [];
  }

  async pushQueuedTrigger(
    ns: string,
    key: string,
    trigger: QueuedTrigger,
    max: number,
  ): Promise<boolean> {
    const runner = this.#runner(ns, key);
    if (max > 0 && runner.queued.length >= max) {
      return false;
    }

    runner.queued.push(jsonClone(trigger));
    return true;
  }

  async popQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    return this.#existingRunner(ns, key)?.queued.shift() ?? null;
  }

  async countQueuedTriggers(ns: string, key: string): Promise<number> {
    return this.#existingRunner(ns, key)?.queued.length ?? 0;
  }

  async clearQueuedTriggers(ns: string, key: string): Promise<number> {
    const runner = this.#runner(ns, key);
    const count = runner.queued.length;
    runner.queued = [];
    return count;
  }

  /* --- queue: jobs -------------------------------------------------- */

  async ensureQueue(q: QueueRef): Promise<void> {
    this.#queue(q);
  }

  async addJob(
    q: QueueRef,
    job: JobRecord,
  ): Promise<{ job: JobRecord; added: boolean }> {
    const queue = this.#queue(q);
    const existing = queue.jobs.get(job.id);
    if (existing) {
      return { job: { ...existing }, added: false };
    }

    const stored = jsonClone(job);
    queue.jobs.set(stored.id, stored);
    queue.order.set(stored.id, queue.seq++);

    if (stored.state === "waiting") {
      // `order` has to be set first: it is the comparator's last tie-break, so
      // inserting before it is known would place the job against a zero.
      this.#enterWaiting(queue, stored);
      this.#wake(queue);
    } else if (SCHEDULED_STATES.includes(stored.state)) {
      // A job can arrive already delayed or failed, and the promotion guard
      // reads this count rather than looking.
      queue.scheduled++;
    }

    return { job: { ...stored }, added: true };
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
    const queue = this.#queue(q);
    if (queue.paused) {
      return null;
    }

    // Due delayed jobs are not promoted here: that is the worker's maintenance,
    // which `maintenance: false` turns off, as on every other driver.

    // The index is already in claim order, so the first due entry is the
    // answer. Walking past a not-yet-due one matters because `runAt` can move
    // forward under a job that is already waiting — a retry sets both — and
    // the index is ordered by priority, not by time.
    const job = this.#firstClaimable(queue, opts.now, opts.excludeNames);

    if (!job) {
      return null;
    }

    this.#setState(queue, job, "active");
    job.attemptsMade += 1;
    job.processedOn = opts.now;
    job.lockToken = opts.token;
    job.lockExpiresAt = opts.now + opts.lockMs;
    job.workerId = opts.workerId;

    return { ...job };
  }

  async extendJobLock(
    q: QueueRef,
    id: string,
    token: string,
    lockMs: number,
    now: number,
  ): Promise<boolean> {
    const job = this.#queue(q).jobs.get(id);
    if (!job || job.state !== "active" || job.lockToken !== token) {
      return false;
    }

    job.lockExpiresAt = now + lockMs;
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
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    if (!job || job.state !== "active" || job.lockToken !== token) {
      return false;
    }

    this.#setState(queue, job, "completed");
    job.finishedOn = now;
    job.returnValue = jsonClone(result);
    job.lockToken = null;
    job.lockExpiresAt = null;
    job.workerId = null;

    this.#count(queue, now, "completed");
    this.#applyRetention(queue, job, retention, now);
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
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    if (!job || job.state !== "active" || job.lockToken !== token) {
      return false;
    }

    job.failedReason = jsonClone(error);
    job.stacktrace = [jsonClone(error), ...job.stacktrace].slice(
      0,
      Math.max(0, keepStacktraces),
    );
    job.lockToken = null;
    job.lockExpiresAt = null;
    job.workerId = null;
    this.#count(queue, now, "failed");

    if (outcome.retry) {
      this.#setState(queue, job, "failed");
      job.runAt = outcome.runAt;
      job.finishedOn = null;
      return true;
    }

    this.#setState(queue, job, "dead");
    job.finishedOn = now;
    this.#applyRetention(queue, job, outcome.retention, now);
    return true;
  }

  async updateProgress(
    q: QueueRef,
    id: string,
    progress: unknown,
  ): Promise<boolean> {
    const job = this.#queue(q).jobs.get(id);
    if (!job) {
      return false;
    }

    job.progress = jsonClone(progress);
    return true;
  }

  async updateJob(
    q: QueueRef,
    id: string,
    patch: JobPatch,
    now: number,
  ): Promise<JobRecord | null> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);

    if (!job || (patch.onlyIn && !patch.onlyIn.includes(job.state))) {
      return null;
    }

    if (
      patch.runAt !== undefined &&
      job.state !== "waiting" &&
      job.state !== "delayed"
    ) {
      return null;
    }

    if (patch.data !== undefined) {
      job.data = jsonClone(patch.data);
    }

    if (patch.priority !== undefined && patch.priority !== job.priority) {
      // The waiting index is ordered by priority, so a waiting job has to be
      // taken out before its key changes and put back after.
      const reindex = job.state === "waiting";

      if (reindex) {
        this.#leaveWaiting(queue, id);
      }

      job.priority = patch.priority;
      job.opts = { ...job.opts, priority: patch.priority };

      if (reindex) {
        this.#enterWaiting(queue, job);
      }
    }

    if (patch.runAt !== undefined) {
      job.runAt = patch.runAt;
      this.#setState(queue, job, patch.runAt > now ? "delayed" : "waiting");
    }

    if (job.state === "waiting") {
      this.#wake(queue);
    }

    return { ...job };
  }

  async addJobLog(
    q: QueueRef,
    id: string,
    line: string,
    keep: number,
  ): Promise<number> {
    const queue = this.#queue(q);

    if (!queue.jobs.has(id)) {
      return 0;
    }

    let logs = queue.logs.get(id);

    if (!logs) {
      logs = [];
      queue.logs.set(id, logs);
    }

    logs.push(line);

    if (keep > 0 && logs.length > keep) {
      logs.splice(0, logs.length - keep);
    }

    return logs.length;
  }

  async getJobLogs(
    q: QueueRef,
    id: string,
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<{ logs: string[]; count: number }> {
    const logs = this.#queue(q).logs.get(id) ?? [];
    const ordered = opts.order === "desc" ? logs.toReversed() : logs;

    return {
      logs: ordered.slice(opts.offset, opts.offset + opts.limit),
      count: logs.length,
    };
  }

  async getJob(q: QueueRef, id: string): Promise<JobRecord | null> {
    const job = this.#queue(q).jobs.get(id);
    return job ? { ...job } : null;
  }

  async recordChild(
    q: QueueRef,
    parentId: string,
    child: JobRef,
    outcome: ChildOutcome,
    now: number,
  ): Promise<ChildRecordResult> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(parentId);
    // A job that does not list this child is not its parent, whatever the
    // child believes: a flow re-added under the same parent id, say.
    if (!job?.flow || !listsChild(job.flow, child)) {
      return "missing";
    }

    const flow = job.flow;
    const key = flowKey(child);
    if (Object.hasOwn(flow.values, key) || Object.hasOwn(flow.failures, key)) {
      return "already";
    }

    const settles = outcome.completed || outcome.ignored;

    if (job.state === "dead") {
      if (!settles) {
        return "parent-dead";
      }
      // Kept for a retry of the parent, which then does not wait on it.
      this.#storeOutcome(flow, key, outcome);
      return "recorded";
    }

    if (job.state !== "waiting-children") {
      return "already";
    }

    if (!settles) {
      // A child that failed buries its parent, which can then never run.
      job.failedReason = jsonClone(outcome.error);
      job.finishedOn = now;
      this.#setState(queue, job, "dead");
      this.#count(queue, now, "failed");
      return "buried";
    }

    this.#storeOutcome(flow, key, outcome);
    flow.pending = Math.max(0, flow.pending - 1);
    if (flow.pending > 0) {
      return "recorded";
    }

    const released = job.runAt > now ? "delayed" : "waiting";
    this.#setState(queue, job, released);
    if (released === "waiting") {
      this.#wake(queue);
    }
    return "released";
  }

  /** Stores a settled child's value or ignored failure on its parent's flow. */
  #storeOutcome(flow: JobFlow, key: string, outcome: ChildOutcome): void {
    if (outcome.completed) {
      flow.values[key] = jsonClone(outcome.value ?? null);
    } else {
      flow.failures[key] = jsonClone(outcome.error);
    }
  }

  async requeueParent(q: QueueRef, id: string, now: number): Promise<boolean> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    if (!job || job.state !== "dead" || !job.flow) {
      return false;
    }

    job.flow.pending = unsettledChildren(job.flow);
    job.failedReason = null;
    job.finishedOn = null;
    job.expiresAt = null;

    if (job.flow.pending > 0) {
      this.#setState(queue, job, "waiting-children");
    } else {
      const released = job.runAt > now ? "delayed" : "waiting";
      this.#setState(queue, job, released);
      if (released === "waiting") {
        this.#wake(queue);
      }
    }

    return true;
  }

  async markChildRecorded(
    q: QueueRef,
    id: string,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    if (!job) {
      return false;
    }

    job.flow = {
      parent: job.flow?.parent ?? null,
      children: job.flow?.children ?? [],
      pending: job.flow?.pending ?? 0,
      values: job.flow?.values ?? {},
      failures: job.flow?.failures ?? {},
      recorded: true,
    };

    if (job.state === "completed" || job.state === "dead") {
      this.#applyRetention(queue, job, retention, now);
    }

    return true;
  }

  async listJobs(
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<JobRecord[]> {
    const queue = this.#queue(q);
    const wanted = new Set(states);
    const single = states.length === 1 ? states[0] : undefined;

    const sorted = [...queue.jobs.values()]
      .filter((job) => wanted.has(job.state))
      .sort((a, b) => {
        if (single === "waiting") {
          return this.#compareWaiting(queue, a, b);
        }
        return this.#sortKey(a, single) - this.#sortKey(b, single);
      });

    if (opts.order === "desc") {
      sorted.reverse();
    }

    return sorted
      .slice(opts.offset, opts.offset + opts.limit)
      .map((job) => ({ ...job }));
  }

  async countJobs(q: QueueRef): Promise<Record<JobState, number>> {
    const counts: Record<JobState, number> = {
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      dead: 0,
      "waiting-children": 0,
    };

    for (const job of this.#queue(q).jobs.values()) {
      counts[job.state] += 1;
    }

    return counts;
  }

  async findJobs(q: QueueRef, query: JobQuery): Promise<JobPage> {
    const queue = this.#queue(q);
    const filter = jobFilter(query);
    const wanted = new Set(query.states);
    const single = query.states.length === 1 ? query.states[0] : undefined;

    const matching = [...queue.jobs.values()]
      .filter(
        (job) =>
          wanted.has(job.state) &&
          (!filter || matchesFilter(filter, job.id, job.name)),
      )
      .sort((a, b) =>
        single === "waiting"
          ? this.#compareWaiting(queue, a, b)
          : this.#sortKey(a, single) - this.#sortKey(b, single),
      );

    if (query.order === "desc") {
      matching.reverse();
    }

    const offset = Math.max(0, Math.floor(query.offset));
    const jobs = matching
      .slice(offset, offset + Math.max(0, Math.floor(query.limit)))
      .map((job) => ({ ...job }));

    return query.total ? { jobs, total: matching.length } : { jobs };
  }

  async getJobs(q: QueueRef, ids: string[]): Promise<(JobRecord | null)[]> {
    const queue = this.#queue(q);
    const found = new Map<string, JobRecord | null>();

    for (const id of ids) {
      const job = queue.jobs.get(id);
      found.set(id, job ? { ...job } : null);
    }

    return orderByIds(ids, found);
  }

  async registerWorker(q: QueueRef, worker: WorkerInfo): Promise<void> {
    const queue = this.#queue(q);

    // Records lapsed as of this report go now, not only when somebody lists.
    for (const [id, other] of queue.workers) {
      if (other.expiresAt <= worker.heartbeatAt) {
        queue.workers.delete(id);
      }
    }

    queue.workers.set(worker.id, { ...worker });
  }

  async removeWorker(q: QueueRef, id: string): Promise<boolean> {
    return this.#queue(q).workers.delete(id);
  }

  async listWorkers(q: QueueRef, now: number): Promise<WorkerInfo[]> {
    const queue = this.#queue(q);
    const live: WorkerInfo[] = [];

    for (const [id, worker] of queue.workers) {
      if (worker.expiresAt > now) {
        live.push({ ...worker });
      } else {
        queue.workers.delete(id);
      }
    }

    return sortWorkers(live);
  }

  async countJobsByQueue(
    ns: string,
  ): Promise<Record<string, Record<JobState, number>>> {
    const result: Record<string, Record<JobState, number>> = {};

    for (const name of this.#namespaces.get(ns)?.queues.keys() ?? []) {
      result[name] = await this.countJobs({ ns, queue: name });
    }

    return result;
  }

  async getThroughput(
    q: QueueRef,
    range: { from: number; to: number },
  ): Promise<ThroughputBucket[]> {
    return sumBuckets(this.#queue(q).throughput.values(), range);
  }

  /**
   * Counts a completion or a failed attempt in the minute of `now`, and drops
   * minutes past the retention once a new minute starts — so the sweep runs
   * once a minute at most, never per job.
   */
  #count(queue: QueueState, now: number, kind: "completed" | "failed"): void {
    const at = throughputBucket(now);
    let bucket = queue.throughput.get(at);

    if (!bucket) {
      bucket = { at, completed: 0, failed: 0 };
      queue.throughput.set(at, bucket);

      for (const minute of queue.throughput.keys()) {
        if (minute < at - THROUGHPUT_RETENTION_MS) {
          queue.throughput.delete(minute);
        }
      }
    }

    bucket[kind] += 1;
  }

  async removeJob(q: QueueRef, id: string): Promise<boolean> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    if (!job || job.state === "active") {
      return false;
    }

    return this.#delete(queue, id);
  }

  async retryJob(
    q: QueueRef,
    id: string,
    resetAttempts: boolean,
    now: number,
  ): Promise<boolean> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    // A parent waiting on children is not finished; moving it would run it
    // before they settle.
    if (
      !job ||
      job.state === "active" ||
      job.state === "waiting" ||
      job.state === "waiting-children"
    ) {
      return false;
    }

    this.#setState(queue, job, "waiting");
    job.runAt = now;
    job.finishedOn = null;
    job.expiresAt = null;
    if (job.flow) {
      // The outcome it ends with this time has not reached its parent.
      job.flow.recorded = false;
    }
    if (resetAttempts) {
      job.attemptsMade = 0;
      job.stalledCount = 0;
    }

    this.#wake(this.#queue(q));
    return true;
  }

  async promoteJob(q: QueueRef, id: string, now: number): Promise<boolean> {
    const queue = this.#queue(q);
    const job = queue.jobs.get(id);
    if (!job || (job.state !== "delayed" && job.state !== "failed")) {
      return false;
    }

    this.#setState(queue, job, "waiting");
    job.runAt = now;
    this.#wake(queue);
    return true;
  }

  async promoteDelayed(
    q: QueueRef,
    now: number,
    limit: number,
  ): Promise<number> {
    return this.#promoteDue(this.#queue(q), now, limit);
  }

  async recoverStalled(
    q: QueueRef,
    now: number,
    maxStalledCount: number,
    limit: number,
  ): Promise<{ requeued: string[]; dead: string[] }> {
    const queue = this.#queue(q);
    const requeued: string[] = [];
    const dead: string[] = [];

    for (const job of queue.jobs.values()) {
      if (requeued.length + dead.length >= limit) {
        break;
      }

      if (
        job.state !== "active" ||
        job.lockExpiresAt === null ||
        job.lockExpiresAt > now
      ) {
        continue;
      }

      job.stalledCount += 1;
      job.lockToken = null;
      job.lockExpiresAt = null;
      job.workerId = null;

      if (job.stalledCount > maxStalledCount) {
        this.#setState(queue, job, "dead");
        job.finishedOn = now;
        this.#count(queue, now, "failed");
        dead.push(job.id);
      } else {
        this.#setState(queue, job, "waiting");
        job.runAt = now;
        requeued.push(job.id);
      }
    }

    if (requeued.length > 0) {
      this.#wake(queue);
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
    const queue = this.#queue(q);
    const cutoff = now - olderThanMs;
    const removed: string[] = [];

    for (const job of [...queue.jobs.values()]) {
      if (removed.length >= limit) {
        break;
      }

      if (job.state !== state) {
        continue;
      }

      const stamp = job.finishedOn ?? job.createdAt;
      if (stamp <= cutoff) {
        this.#delete(queue, job.id);
        removed.push(job.id);
      }
    }

    return removed;
  }

  async pruneExpired(q: QueueRef, now: number, limit: number): Promise<number> {
    const queue = this.#queue(q);
    let removed = 0;

    for (const job of [...queue.jobs.values()]) {
      if (removed >= limit) {
        break;
      }

      if (
        job.expiresAt !== null &&
        job.expiresAt <= now &&
        !awaitsDelivery(job)
      ) {
        this.#delete(queue, job.id);
        removed++;
      }
    }

    return removed;
  }

  async drainQueue(q: QueueRef, includeDelayed: boolean): Promise<number> {
    const queue = this.#queue(q);
    let removed = 0;

    for (const job of [...queue.jobs.values()]) {
      const drainable =
        job.state === "waiting" ||
        job.state === "waiting-children" ||
        (includeDelayed && SCHEDULED_STATES.includes(job.state));

      if (drainable) {
        this.#delete(queue, job.id);
        removed++;
      }
    }

    return removed;
  }

  async getQueueState(
    q: QueueRef,
    name: string,
  ): Promise<QueueStateEntry | null> {
    const entry = this.#queue(q).state.get(name);
    return entry
      ? { value: jsonClone(entry.value), version: entry.version }
      : null;
  }

  async setQueueState(
    q: QueueRef,
    name: string,
    value: unknown,
    expected: number | null,
    options?: { internal?: symbol },
  ): Promise<number | null> {
    assertWritableStateName(name, options);

    const state = this.#queue(q).state;
    const current = state.get(name);

    if ((current?.version ?? null) !== expected) {
      return null;
    }

    if (value === null) {
      state.delete(name);
      return 0;
    }

    const version = (current?.version ?? 0) + 1;
    state.set(name, { value: jsonClone(value), version });
    return version;
  }

  async listQueueState(
    q: QueueRef,
    options: { prefix: string; after?: string; limit: number },
  ): Promise<string[]> {
    const names = [...this.#queue(q).state.keys()]
      .filter(
        (name) =>
          name.startsWith(options.prefix) &&
          (options.after === undefined ||
            compareCodePoints(name, options.after) > 0),
      )
      .sort(compareCodePoints);

    return names.slice(0, Math.max(0, options.limit));
  }

  async pauseQueue(q: QueueRef): Promise<void> {
    this.#queue(q).paused = true;
  }

  async resumeQueue(q: QueueRef): Promise<void> {
    const queue = this.#queue(q);
    queue.paused = false;
    this.#wake(queue);
  }

  async isQueuePaused(q: QueueRef): Promise<boolean> {
    return this.#queue(q).paused;
  }

  /* --- queue: repeats ---------------------------------------------- */

  async upsertRepeat(q: QueueRef, def: RepeatRecord): Promise<void> {
    this.#queue(q).repeats.set(def.key, jsonClone(def));
  }

  async getRepeat(q: QueueRef, key: string): Promise<RepeatRecord | null> {
    const repeat = this.#queue(q).repeats.get(key);
    return repeat ? { ...repeat } : null;
  }

  async listRepeats(q: QueueRef): Promise<RepeatRecord[]> {
    return [...this.#queue(q).repeats.values()].map((repeat) => ({
      ...repeat,
    }));
  }

  async removeRepeat(q: QueueRef, key: string): Promise<boolean> {
    return this.#queue(q).repeats.delete(key);
  }

  /* --- queue: waiting & events -------------------------------------- */

  async nextDelayedAt(q: QueueRef): Promise<number | null> {
    let earliest: number | null = null;

    for (const job of this.#queue(q).jobs.values()) {
      if (!SCHEDULED_STATES.includes(job.state)) {
        continue;
      }
      if (earliest === null || job.runAt < earliest) {
        earliest = job.runAt;
      }
    }

    return earliest;
  }

  async waitForJob(
    q: QueueRef,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const queue = this.#queue(q);

    // A paused queue has nothing claimable however many jobs are waiting;
    // saying otherwise turns a caller's wait loop into a busy loop.
    const claimable =
      !queue.paused &&
      [...queue.jobs.values()].some(
        (job) => PENDING_STATES.includes(job.state) && job.runAt <= Date.now(),
      );

    if (claimable || signal?.aborted || timeoutMs <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        queue.waiters.delete(finish);
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };

      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      queue.waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  async publish(event: DriverEvent): Promise<void> {
    const namespace = this.#namespace(event.ns);
    const listeners = namespace.subscribers.get(
      `${event.kind}:${event.target}`,
    );

    for (const listener of listeners ?? []) {
      listener(event);
    }
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

    const namespace = this.#namespace(ns);
    const key = `${kind}:${target}`;
    const listeners = namespace.subscribers.get(key) ?? new Set();
    listeners.add(deliver);
    namespace.subscribers.set(key, listeners);

    return async () => {
      listeners.delete(deliver);
      if (listeners.size === 0) {
        namespace.subscribers.delete(key);
      }
    };
  }

  /* --- internals ---------------------------------------------------- */

  /** The namespace's state, created on first use. */
  #namespace(ns: string): NamespaceState {
    let namespace = this.#namespaces.get(ns);
    if (!namespace) {
      namespace = {
        runners: new Map(),
        queues: new Map(),
        subscribers: new Map(),
      };
      this.#namespaces.set(ns, namespace);
    }
    return namespace;
  }

  /** A runner's state, created on first use. */
  #runner(ns: string, key: string): RunnerState {
    const namespace = this.#namespace(ns);
    let runner = namespace.runners.get(key);
    if (!runner) {
      runner = { fields: new Map(), history: [], queued: [] };
      namespace.runners.set(key, runner);
    }
    return runner;
  }

  /**
   * A runner's state if it already has any, without bringing one into being.
   *
   * Every read goes through this rather than {@link MemoryDriver.#runner}:
   * asking a question about a runner must not create it. It used to, so
   * merely inspecting an id — which `info()` does through `getLock` and
   * `getState` — put that id into `listRunners()` for good, and kept its
   * namespace alive for as long as the driver. Every other driver answers a
   * read without writing; this is that behaviour.
   */
  #existingRunner(ns: string, key: string): RunnerState | undefined {
    return this.#namespaces.get(ns)?.runners.get(key);
  }

  /** A queue's state, created on first use. */
  #queue(q: QueueRef): QueueState {
    const namespace = this.#namespace(q.ns);
    let queue = namespace.queues.get(q.queue);
    if (!queue) {
      queue = {
        jobs: new Map(),
        order: new Map(),
        waiting: [],
        waitingFrom: 0,
        scheduled: 0,
        repeats: new Map(),
        logs: new Map(),
        state: new Map(),
        workers: new Map(),
        throughput: new Map(),
        paused: false,
        seq: 0,
        waiters: new Set(),
      };
      namespace.queues.set(q.queue, queue);
    }
    return queue;
  }

  /** Releases everyone waiting for work. */
  #wake(queue: QueueState): void {
    for (const wake of [...queue.waiters]) {
      wake();
    }
  }

  /** Removes a job and its ordering entry. */
  #delete(queue: QueueState, id: string): boolean {
    const job = queue.jobs.get(id);

    if (job && SCHEDULED_STATES.includes(job.state)) {
      queue.scheduled--;
    }

    queue.order.delete(id);
    queue.logs.delete(id);
    this.#leaveWaiting(queue, id);
    return queue.jobs.delete(id);
  }

  /** Claim order: priority, then when it was added, then insertion order. */
  /**
   * Moves a job to a new state, keeping the waiting index in step.
   *
   * Every state change in this driver goes through here. That is the whole
   * design: an index maintained at nine separate assignment sites is an index
   * that goes stale the first time someone adds a tenth, and a stale one here
   * means a job that is never claimed.
   */
  #setState(queue: QueueState, job: JobRecord, state: JobState): void {
    if (job.state === state) {
      return;
    }

    if (job.state === "waiting") {
      this.#leaveWaiting(queue, job.id);
    }

    if (SCHEDULED_STATES.includes(job.state)) {
      queue.scheduled--;
    }

    job.state = state;

    if (state === "waiting") {
      this.#enterWaiting(queue, job);
    }

    if (SCHEDULED_STATES.includes(state)) {
      queue.scheduled++;
    }
  }

  /** The first waiting job that is due, in claim order, or `null`. */
  #firstClaimable(
    queue: QueueState,
    now: number,
    excludeNames?: string[],
  ): JobRecord | null {
    const excluded =
      excludeNames && excludeNames.length > 0 ? new Set(excludeNames) : null;

    for (let at = queue.waitingFrom; at < queue.waiting.length; at++) {
      const job = queue.jobs.get(queue.waiting[at]!);

      if (
        job &&
        job.state === "waiting" &&
        job.runAt <= now &&
        !excluded?.has(job.name)
      ) {
        return job;
      }
    }

    return null;
  }

  /** Inserts a job into the waiting index, in claim order. */
  #enterWaiting(queue: QueueState, job: JobRecord): void {
    // Binary search for the insertion point rather than pushing and re-sorting:
    // the list is already ordered, so placing one job is a comparison per
    // halving rather than a sort of the whole thing.
    let low = queue.waitingFrom;
    let high = queue.waiting.length;

    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = queue.jobs.get(queue.waiting[middle]!);

      if (other && this.#compareWaiting(queue, other, job) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    queue.waiting.splice(low, 0, job.id);
  }

  /** Takes a job out of the waiting index. */
  #leaveWaiting(queue: QueueState, id: string): void {
    const at = queue.waiting.indexOf(id, queue.waitingFrom);

    if (at < 0) {
      return;
    }

    // Taking the head is the common case — that is what claiming does — and
    // moving the cursor costs nothing where splicing would move the rest of
    // the array.
    if (at === queue.waitingFrom) {
      queue.waitingFrom++;

      // Compact once the dead prefix is most of the array, so the copy is paid
      // once per many claims rather than once per claim.
      if (
        queue.waitingFrom > COMPACT_AFTER &&
        queue.waitingFrom * 2 > queue.waiting.length
      ) {
        queue.waiting = queue.waiting.slice(queue.waitingFrom);
        queue.waitingFrom = 0;
      }

      return;
    }

    queue.waiting.splice(at, 1);
  }

  #compareWaiting(queue: QueueState, a: JobRecord, b: JobRecord): number {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return (queue.order.get(a.id) ?? 0) - (queue.order.get(b.id) ?? 0);
  }

  /**
   * The timestamp a state is naturally ordered by. Listing several states at
   * once falls back to creation time, the only key they all share.
   */
  #sortKey(job: JobRecord, single: JobState | undefined): number {
    switch (single) {
      case "delayed":
      case "failed":
        return job.runAt;
      case "active":
        return job.lockExpiresAt ?? job.processedOn ?? job.createdAt;
      case "completed":
      case "dead":
        return job.finishedOn ?? job.createdAt;
      default:
        return job.createdAt;
    }
  }

  /** Moves due `delayed`/`failed` jobs to `waiting`; returns how many moved. */
  #promoteDue(queue: QueueState, now: number, limit: number): number {
    // Nothing is delayed or failed, so there is nothing to promote and no
    // reason to look at every job in the queue to find that out.
    if (queue.scheduled === 0) {
      return 0;
    }

    let promoted = 0;

    for (const job of queue.jobs.values()) {
      if (promoted >= limit) {
        break;
      }

      if (SCHEDULED_STATES.includes(job.state) && job.runAt <= now) {
        this.#setState(queue, job, "waiting");
        promoted++;
      }
    }

    if (promoted > 0) {
      this.#wake(queue);
    }

    return promoted;
  }

  /**
   * Applies retention to a job that just finished: remove it now, cap how
   * many of its state are kept, and/or stamp when it expires.
   */
  #applyRetention(
    queue: QueueState,
    job: JobRecord,
    retention: Retention,
    now: number,
  ): void {
    if (retention === true) {
      this.#delete(queue, job.id);
      return;
    }

    if (retention === false || retention === undefined) {
      job.expiresAt = null;
      return;
    }

    const count = typeof retention === "number" ? retention : retention.count;
    const ttl = typeof retention === "number" ? undefined : retention.ttl;

    job.expiresAt = ttl && ttl > 0 ? now + ttl : null;

    if (count !== undefined && count >= 0) {
      const sameState = [...queue.jobs.values()]
        .filter((other) => other.state === job.state)
        .sort(
          (a, b) =>
            (b.finishedOn ?? b.createdAt) - (a.finishedOn ?? a.createdAt),
        );

      for (const stale of sameState.slice(count)) {
        // A child whose parent has not taken its outcome yet stays.
        if (!awaitsDelivery(stale)) {
          this.#delete(queue, stale.id);
        }
      }
    }
  }
}
