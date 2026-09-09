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
import { jsonClone } from "@kingsleyweb/bun-common";

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
  /** Repeat definitions, by key. */
  repeats: Map<string, RepeatRecord>;
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
    const held = this.#runner(ns, key).lock;
    return held && held.expiresAt > now ? { ...held } : null;
  }

  /* --- runner: state, history, queued triggers ---------------------- */

  async getState(ns: string, key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.#runner(ns, key).fields);
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
    const history = this.#runner(ns, key).history;
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
    return this.#runner(ns, key).queued.shift() ?? null;
  }

  async countQueuedTriggers(ns: string, key: string): Promise<number> {
    return this.#runner(ns, key).queued.length;
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
      this.#wake(queue);
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

    // Anything due is claimable, so promote before looking.
    this.#promoteDue(queue, opts.now, Number.POSITIVE_INFINITY);

    const candidates = [...queue.jobs.values()]
      .filter((job) => job.state === "waiting" && job.runAt <= opts.now)
      .sort((a, b) => this.#compareWaiting(queue, a, b));

    const job = candidates[0];
    if (!job) {
      return null;
    }

    job.state = "active";
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

    job.state = "completed";
    job.finishedOn = now;
    job.returnValue = jsonClone(result);
    job.lockToken = null;
    job.lockExpiresAt = null;
    job.workerId = null;

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

    if (outcome.retry) {
      job.state = "failed";
      job.runAt = outcome.runAt;
      job.finishedOn = null;
      return true;
    }

    job.state = "dead";
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

  async getJob(q: QueueRef, id: string): Promise<JobRecord | null> {
    const job = this.#queue(q).jobs.get(id);
    return job ? { ...job } : null;
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
    };

    for (const job of this.#queue(q).jobs.values()) {
      counts[job.state] += 1;
    }

    return counts;
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
    const job = this.#queue(q).jobs.get(id);
    if (!job || job.state === "active" || job.state === "waiting") {
      return false;
    }

    job.state = "waiting";
    job.runAt = now;
    job.finishedOn = null;
    job.expiresAt = null;
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

    job.state = "waiting";
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
        job.state = "dead";
        job.finishedOn = now;
        dead.push(job.id);
      } else {
        job.state = "waiting";
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
    state: "completed" | "failed" | "dead" | "waiting" | "delayed",
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

      if (job.expiresAt !== null && job.expiresAt <= now) {
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
        (includeDelayed && SCHEDULED_STATES.includes(job.state));

      if (drainable) {
        this.#delete(queue, job.id);
        removed++;
      }
    }

    return removed;
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

    const claimable = [...queue.jobs.values()].some(
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

  async subscribe(
    ns: string,
    kind: "queue" | "runner",
    target: string,
    listener: (event: DriverEvent) => void,
  ): Promise<() => Promise<void>> {
    const namespace = this.#namespace(ns);
    const key = `${kind}:${target}`;
    const listeners = namespace.subscribers.get(key) ?? new Set();
    listeners.add(listener);
    namespace.subscribers.set(key, listeners);

    return async () => {
      listeners.delete(listener);
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

  /** A queue's state, created on first use. */
  #queue(q: QueueRef): QueueState {
    const namespace = this.#namespace(q.ns);
    let queue = namespace.queues.get(q.queue);
    if (!queue) {
      queue = {
        jobs: new Map(),
        order: new Map(),
        repeats: new Map(),
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
    queue.order.delete(id);
    return queue.jobs.delete(id);
  }

  /** Claim order: priority, then when it was added, then insertion order. */
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
    let promoted = 0;

    for (const job of queue.jobs.values()) {
      if (promoted >= limit) {
        break;
      }

      if (SCHEDULED_STATES.includes(job.state) && job.runAt <= now) {
        job.state = "waiting";
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
        this.#delete(queue, stale.id);
      }
    }
  }
}
