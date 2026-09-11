import type { SerializedError } from "@kingsleyweb/bun-common";
import type { RedisClient } from "bun";
import type {
  ConnectionInput,
  ConnectionOptions,
} from "../../shared/connection";
import type {
  ClaimOptions,
  DriverCapabilities,
  DriverEvent,
  EventKind,
  EventOfKind,
  FailOutcome,
  JobRecord,
  JobsDriver,
  JobState,
  LockInfo,
  QueuedTrigger,
  QueueRef,
  RepeatRecord,
  ResolvedJobOptions,
  Retention,
  RunRecord,
} from "../driver";
import { jsonClone, sleep } from "@kingsleyweb/bun-common";
import { RedisClient as BunRedis } from "bun";
import { resolveConnectionUrl } from "../../shared/connection";
import { DriverError } from "../../shared/errors";
import { safeJsonParse } from "../../shared/json";
import { RedisKeys } from "./keys";
import * as scripts from "./scripts";

/**
 * A driver backed by Redis.
 *
 * Redis has no transaction that can branch on what it reads — `MULTI` queues
 * commands and cannot look at a reply — so every decision here is a Lua
 * script instead. A script is the unit of atomicity: the server runs it start
 * to finish with nothing interleaved, which is precisely the guarantee
 * claiming a job needs. The scripts live in `scripts.ts`, cached by SHA and
 * re-sent whenever the server says it has forgotten them.
 *
 * It is also the only backend here that can wait properly. `BLPOP` on a wake
 * list means a worker learns about a job in about a millisecond rather than
 * on its next poll, which is why `blockingWait` is `true` — and why the
 * blocking pop and the subscriber each get their own connection, since a
 * connection inside a blocking call can do nothing else.
 */

/**
 * The score of the first entry in a `WITHSCORES` reply.
 *
 * The client hands those back as member/score pairs rather than the flat
 * array the protocol describes, and a future version may not; reading both
 * shapes costs a line and removes the question.
 */
function firstScore(reply: unknown): number | null {
  if (!Array.isArray(reply) || reply.length === 0) {
    return null;
  }

  const head = reply[0];
  const score = Array.isArray(head) ? head[1] : reply[1];

  return score === undefined ? null : Number(score);
}

/** How long a blocking pop waits, at most, before the caller checks again. */
const MAX_BLOCK_SECONDS = 5;

/**
 * How many jobs go into one add script.
 *
 * A script takes its arguments as one flat list, and each job contributes its
 * values, so a large chunk is both a large packet and a long stretch of Redis's
 * single thread — during which every other client waits. Measured across chunk
 * sizes for 5,000 jobs, the curve is shallow and flattens here: 60.6ms at 100,
 * 57.5ms at 200, 55.4ms at 500, 55.7ms at 1,000, 57.2ms at 2,500. 500 also
 * happens to be the batch size a caller adding in pages tends to reach for, so
 * a page becomes one round trip rather than three.
 */
const ADD_CHUNK = 500;

/**
 * Job fields stored as JSON rather than as scalars.
 *
 * A hash keeps the scalars the scripts compare on — state, priority, runAt,
 * the lock token — readable and writable from Lua without parsing anything,
 * while the payloads stay opaque strings, exactly as every other driver
 * stores them.
 */
type JsonField =
  | "data"
  | "opts"
  | "progress"
  | "returnValue"
  | "failedReason"
  | "stacktrace";

/** Options for {@link RedisDriver}. */
export interface RedisDriverOptions extends ConnectionInput {
  /** A connection string. Wins over `connection` when both are given. */
  url?: string;
  /** The connection as fields, for when a URL is not what you have. */
  connection?: ConnectionOptions;
  /**
   * Prepended to every key, ahead of the namespace, so this driver's keys are
   * one `SCAN` away in a Redis it shares. Defaults to `bun-jobs`.
   */
  keyPrefix?: string;
  /**
   * Whether the server is a cluster. Keys are then hash-tagged per queue and
   * per runner, because a script may only touch one slot.
   */
  cluster?: boolean;
  /** An already-connected client, when the application has one to share. */
  client?: RedisClient;
  /** How long a blocking wait lasts, at most. Defaults to 5 seconds. */
  maxBlockSeconds?: number;
}

export class RedisDriver implements JobsDriver {
  /** Identifies the implementation in errors and capability checks. */
  readonly name = "redis";

  /**
   * The only backend that can wait rather than poll: a worker blocks on the
   * queue's wake list and hears about a job in about a millisecond.
   */
  readonly capabilities: DriverCapabilities = {
    blockingWait: true,
    events: "push",
    multiProcess: true,
    multiHost: true,
  };

  /** How keys are named. */
  readonly keys: RedisKeys;

  /** The connection commands run on. */
  readonly #client: RedisClient;
  /** Whether this driver opened the connection and must close it. */
  readonly #ownsClient: boolean;
  /** The connection URL, so extra connections can be made from it. */
  readonly #url: string;
  /** Longest a blocking pop waits. */
  readonly #maxBlock: number;
  /** Cached script SHAs, so a script is sent once rather than per call. */
  readonly #shas = new Map<string, string>();
  /** The connection reserved for blocking pops, once anything waits. */
  #blocking: RedisClient | undefined;
  /** The connection reserved for pub/sub, once anything subscribes. */
  #subscriber: RedisClient | undefined;
  /** Channels with listeners, so `close()` can unsubscribe them. */
  readonly #channels = new Map<string, Set<(event: DriverEvent) => void>>();
  /** Resolves once the client is connected. */
  #ready: Promise<void> | undefined;

  constructor(options: RedisDriverOptions) {
    this.#url = resolveConnectionUrl(
      options,
      { scheme: "redis", tlsScheme: "rediss", host: "127.0.0.1", port: 6379 },
      "The Redis driver",
    );

    this.keys = new RedisKeys({
      prefix: options.keyPrefix,
      cluster: options.cluster,
    });

    this.#maxBlock = options.maxBlockSeconds ?? MAX_BLOCK_SECONDS;
    this.#client = options.client ?? new BunRedis(this.#url);
    this.#ownsClient = !options.client;
  }

  /* --- lifecycle ---------------------------------------------------- */

  async connect(): Promise<void> {
    this.#ready ??= this.#client.connect().then(() => undefined);
    await this.#ready;
  }

  async close(): Promise<void> {
    for (const channel of this.#channels.keys()) {
      await this.#subscriber?.unsubscribe(channel).catch(() => {});
    }
    this.#channels.clear();

    // The extra connections are always ours, whoever owns the main one.
    await this.#blocking?.close();
    await this.#subscriber?.close();
    this.#blocking = undefined;
    this.#subscriber = undefined;

    if (this.#ownsClient) {
      this.#client.close();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.connect();
      return (await this.#client.ping()) !== null;
    } catch {
      return false;
    }
  }

  async purge(ns: string): Promise<void> {
    await this.connect();

    // SCAN rather than KEYS: a namespace may hold a great many keys, and
    // KEYS blocks the server while it walks all of them.
    const pattern = `${this.keys.namespace(ns)}:*`;
    let cursor = "0";

    do {
      const [next, batch] = (await this.#client.send("SCAN", [
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        "500",
      ])) as [string, string[]];

      cursor = next;

      if (batch.length > 0) {
        await this.#client.send("DEL", batch);
      }
    } while (cursor !== "0");
  }

  async listRunners(ns: string): Promise<string[]> {
    await this.connect();
    return (await this.#client.smembers(this.keys.runners(ns))) ?? [];
  }

  async listQueues(ns: string): Promise<string[]> {
    await this.connect();
    return (await this.#client.smembers(this.keys.queues(ns))) ?? [];
  }

  /* --- runner: locks -------------------------------------------------- */

  async acquireLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    try {
      await this.connect();

      const taken = await this.#run(
        scripts.ACQUIRE_LOCK,
        [this.keys.runner(ns, this.#runnerId(key)).lock],
        [token, String(now), String(now + ttlMs), String(ttlMs)],
      );

      if (Number(taken) !== 1) {
        return false;
      }

      // A runner exists as soon as it has taken its lock.
      await this.#client.sadd(this.keys.runners(ns), this.#runnerId(key));
      return true;
    } catch {
      // Fail closed: never run exclusive work whose exclusivity is unproven.
      return false;
    }
  }

  async renewLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    await this.connect();

    const renewed = await this.#run(
      scripts.RENEW_LOCK,
      [this.keys.runner(ns, this.#runnerId(key)).lock],
      [token, String(now), String(now + ttlMs), String(ttlMs)],
    );

    return Number(renewed) === 1;
  }

  async releaseLock(ns: string, key: string, token: string): Promise<boolean> {
    await this.connect();

    const released = await this.#run(
      scripts.RELEASE_LOCK,
      [this.keys.runner(ns, this.#runnerId(key)).lock],
      [token],
    );

    return Number(released) === 1;
  }

  async getLock(
    ns: string,
    key: string,
    now: number,
  ): Promise<LockInfo | null> {
    await this.connect();

    const held = (await this.#run(
      scripts.GET_LOCK,
      [this.keys.runner(ns, this.#runnerId(key)).lock],
      [String(now)],
    )) as string | null;

    if (!held) {
      return null;
    }

    const separator = held.lastIndexOf("|");
    return {
      token: held.slice(0, separator),
      expiresAt: Number(held.slice(separator + 1)),
    };
  }

  /* --- runner: state -------------------------------------------------- */

  async getState(ns: string, key: string): Promise<Record<string, string>> {
    await this.connect();
    const state = await this.#client.hgetall(
      this.keys.runner(ns, this.#runnerId(key)).state,
    );

    return (state as Record<string, string> | null) ?? {};
  }

  async setState(
    ns: string,
    key: string,
    fields: Record<string, string | number | null>,
  ): Promise<void> {
    await this.connect();
    const stateKey = this.keys.runner(ns, this.#runnerId(key)).state;

    const set: string[] = [];
    const remove: string[] = [];

    for (const [field, value] of Object.entries(fields)) {
      if (value === null) {
        remove.push(field);
      } else {
        set.push(field, String(value));
      }
    }

    if (set.length > 0) {
      await this.#client.send("HSET", [stateKey, ...set]);
    }
    if (remove.length > 0) {
      await this.#client.send("HDEL", [stateKey, ...remove]);
    }
  }

  async incrementCounters(
    ns: string,
    key: string,
    deltas: Record<string, number>,
  ): Promise<Record<string, number>> {
    await this.connect();
    const stateKey = this.keys.runner(ns, this.#runnerId(key)).state;
    const updated: Record<string, number> = {};

    // `HINCRBY` is atomic, so concurrent runners cannot lose a count.
    for (const [field, delta] of Object.entries(deltas)) {
      updated[field] = Number(
        await this.#client.hincrby(stateKey, field, delta),
      );
    }

    return updated;
  }

  async appendHistory(
    ns: string,
    key: string,
    record: RunRecord,
    keep: number,
  ): Promise<void> {
    await this.connect();

    await this.#run(
      scripts.APPEND_HISTORY,
      [this.keys.runner(ns, this.#runnerId(key)).history],
      [JSON.stringify(record), String(keep)],
    );
  }

  async updateHistory(
    ns: string,
    key: string,
    runId: string,
    patch: Partial<RunRecord>,
  ): Promise<boolean> {
    await this.connect();
    const history = this.keys.runner(ns, this.#runnerId(key)).history;

    const entries = (await this.#client.lrange(history, 0, -1)) ?? [];
    const index = entries.findIndex(
      (entry) => safeJsonParse<RunRecord | null>(entry, null)?.runId === runId,
    );

    if (index === -1) {
      return false;
    }

    const merged = {
      ...safeJsonParse<RunRecord>(entries[index], {} as RunRecord),
      ...jsonClone(patch),
    };

    const updated = await this.#run(
      scripts.UPDATE_HISTORY,
      [history],
      [runId, JSON.stringify(merged)],
    );

    return Number(updated) === 1;
  }

  async listHistory(
    ns: string,
    key: string,
    limit?: number,
  ): Promise<RunRecord[]> {
    await this.connect();

    const entries =
      (await this.#client.lrange(
        this.keys.runner(ns, this.#runnerId(key)).history,
        0,
        limit && limit > 0 ? limit - 1 : -1,
      )) ?? [];

    return entries
      .map((entry) => safeJsonParse<RunRecord | null>(entry, null))
      .filter((record): record is RunRecord => record !== null);
  }

  async clearHistory(ns: string, key: string): Promise<void> {
    await this.connect();
    await this.#client.del(this.keys.runner(ns, this.#runnerId(key)).history);
  }

  async pushQueuedTrigger(
    ns: string,
    key: string,
    trigger: QueuedTrigger,
    max: number,
  ): Promise<boolean> {
    await this.connect();

    const pushed = await this.#run(
      scripts.PUSH_QUEUED,
      [this.keys.runner(ns, this.#runnerId(key)).queued],
      [JSON.stringify(trigger), String(max)],
    );

    return Number(pushed) === 1;
  }

  async popQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    await this.connect();

    const head = await this.#client.lpop(
      this.keys.runner(ns, this.#runnerId(key)).queued,
    );

    return head ? safeJsonParse<QueuedTrigger | null>(head, null) : null;
  }

  async countQueuedTriggers(ns: string, key: string): Promise<number> {
    await this.connect();
    return Number(
      await this.#client.llen(this.keys.runner(ns, this.#runnerId(key)).queued),
    );
  }

  async clearQueuedTriggers(ns: string, key: string): Promise<number> {
    await this.connect();
    const queued = this.keys.runner(ns, this.#runnerId(key)).queued;

    const count = Number(await this.#client.llen(queued));
    await this.#client.del(queued);
    return count;
  }

  /* --- queue: jobs ------------------------------------------------------ */

  async ensureQueue(q: QueueRef): Promise<void> {
    await this.connect();
    await this.#client.sadd(this.keys.queues(q.ns), q.queue);
  }

  async addJob(
    q: QueueRef,
    job: JobRecord,
  ): Promise<{ job: JobRecord; added: boolean }> {
    await this.connect();

    const values = this.#toValues(job);
    const added = await this.#runQueue(q, scripts.ADD_JOB, [
      q.queue,
      String(Date.now()),
      String(values.length),
      ...values,
    ]);

    if (Number(added) === 1) {
      return { job: jsonClone(job), added: true };
    }

    const existing = await this.getJob(q, job.id);
    return { job: existing ?? jsonClone(job), added: false };
  }

  /**
   * Adds many jobs with one script per chunk.
   *
   * The loop this replaces cost a round trip per job. Chunked because a script
   * takes its arguments as one flat list, and a very long one is both a large
   * packet and a long stretch of Redis's single thread.
   */
  async addJobs(
    q: QueueRef,
    jobs: JobRecord[],
  ): Promise<{ job: JobRecord; added: boolean }[]> {
    if (jobs.length === 0) {
      return [];
    }

    // One job is not a batch, and the singular path already reports precisely
    // what happened to it.
    if (jobs.length === 1) {
      return [await this.addJob(q, jobs[0]!)];
    }

    await this.connect();

    const results: { job: JobRecord; added: boolean }[] = [];

    for (let start = 0; start < jobs.length; start += ADD_CHUNK) {
      const chunk = jobs.slice(start, start + ADD_CHUNK);
      const args = [q.queue, String(Date.now()), String(chunk.length)];

      // Each job contributes a count and then that many values, in
      // `JOB_FIELDS` order. The count is how a brand-new job says it stopped
      // early; the script reads id, state, priority and runAt from fixed
      // positions within the values, so nothing else needs sending.
      for (const job of chunk) {
        const values = this.#toValues(job);
        args.push(String(values.length), ...values);
      }

      const reply = await this.#runQueue(q, scripts.ADD_JOBS, args);
      const flags = Array.isArray(reply) ? reply : [];

      for (const [index, job] of chunk.entries()) {
        const added = Number(flags[index] ?? 0) === 1;
        results.push({
          job: added
            ? jsonClone(job)
            : ((await this.getJob(q, job.id)) ?? jsonClone(job)),
          added,
        });
      }
    }

    return results;
  }

  async claimJob(q: QueueRef, opts: ClaimOptions): Promise<JobRecord | null> {
    await this.connect();

    const claimed = await this.#runQueue(q, scripts.CLAIM, [
      String(opts.now),
      opts.token,
      opts.workerId,
      String(opts.lockMs),
      "1000",
    ]);

    const fields = this.#toObject(claimed);
    return fields ? this.#toRecord(fields) : null;
  }

  /**
   * Claims several jobs in one script.
   *
   * The script is the unit of atomicity, so a batch is exactly as exclusive as
   * a single claim. The reply is one `HGETALL` per job rather than a joined
   * string, because job data is arbitrary JSON and any separator would show up
   * inside it sooner or later.
   */
  async claimJobs(
    q: QueueRef,
    opts: ClaimOptions,
    limit: number,
  ): Promise<JobRecord[]> {
    await this.connect();

    const claimed = await this.#runQueue(q, scripts.CLAIM_MANY, [
      String(opts.now),
      opts.token,
      opts.workerId,
      String(opts.lockMs),
      "1000",
      String(Math.max(1, Math.floor(limit))),
    ]);

    if (!Array.isArray(claimed)) {
      return [];
    }

    // `ZRANGE` yielded these in score order and the script preserved it, so
    // claim order needs no restoring here.
    const records: JobRecord[] = [];
    for (const entry of claimed) {
      const fields = this.#toObject(entry);
      if (fields) {
        records.push(this.#toRecord(fields));
      }
    }

    return records;
  }

  async extendJobLock(
    q: QueueRef,
    id: string,
    token: string,
    lockMs: number,
    now: number,
  ): Promise<boolean> {
    await this.connect();

    const extended = await this.#runQueue(q, scripts.EXTEND_LOCK, [
      id,
      token,
      String(now + lockMs),
    ]);

    return Number(extended) === 1;
  }

  async completeJob(
    q: QueueRef,
    id: string,
    token: string,
    result: unknown,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    await this.connect();
    const { mode, count, ttl } = this.#retention(retention);

    const completed = await this.#runQueue(q, scripts.COMPLETE, [
      id,
      token,
      String(now),
      JSON.stringify(result ?? null),
      mode,
      count,
      ttl,
    ]);

    return Number(completed) === 1;
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
    await this.connect();

    const existing = await this.getJob(q, id);
    if (!existing) {
      return false;
    }

    const stacktrace = [error, ...existing.stacktrace].slice(
      0,
      Math.max(0, keepStacktraces),
    );

    const { mode, count, ttl } = this.#retention(
      outcome.retry ? false : outcome.retention,
    );

    const failed = await this.#runQueue(q, scripts.FAIL, [
      id,
      token,
      String(now),
      JSON.stringify(error),
      JSON.stringify(stacktrace),
      outcome.retry ? "1" : "0",
      String(outcome.retry ? outcome.runAt : existing.runAt),
      mode,
      count,
      ttl,
    ]);

    return Number(failed) === 1;
  }

  async updateProgress(
    q: QueueRef,
    id: string,
    progress: unknown,
  ): Promise<boolean> {
    await this.connect();
    const key = `${this.keys.queue(q).jobPrefix}${id}`;

    if ((await this.#client.exists(key)) !== true) {
      return false;
    }

    await this.#client.hset(key, "progress", JSON.stringify(progress ?? null));
    return true;
  }

  async getJob(q: QueueRef, id: string): Promise<JobRecord | null> {
    await this.connect();

    const fields = (await this.#client.hgetall(
      `${this.keys.queue(q).jobPrefix}${id}`,
    )) as Record<string, string> | null;

    return fields && Object.keys(fields).length > 0
      ? this.#toRecord(fields)
      : null;
  }

  async listJobs(
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<JobRecord[]> {
    await this.connect();

    const ids = (await this.#runQueue(q, scripts.LIST_JOBS, [
      String(opts.offset),
      String(opts.limit),
      opts.order,
      ...states,
    ])) as string[] | null;

    const found: JobRecord[] = [];
    for (const id of ids ?? []) {
      const job = await this.getJob(q, id);
      if (job) {
        found.push(job);
      }
    }

    return found;
  }

  async countJobs(q: QueueRef): Promise<Record<JobState, number>> {
    await this.connect();

    const counts = (await this.#runQueue(q, scripts.COUNT_JOBS, [])) as
      | number[]
      | null;

    const [waiting, delayed, active, completed, failed, dead] = counts ?? [];

    return {
      waiting: Number(waiting ?? 0),
      delayed: Number(delayed ?? 0),
      active: Number(active ?? 0),
      completed: Number(completed ?? 0),
      failed: Number(failed ?? 0),
      dead: Number(dead ?? 0),
    };
  }

  async removeJob(q: QueueRef, id: string): Promise<boolean> {
    await this.connect();
    const removed = await this.#runQueue(q, scripts.REMOVE_JOB, [id]);
    return Number(removed) === 1;
  }

  async retryJob(
    q: QueueRef,
    id: string,
    resetAttempts: boolean,
    now: number,
  ): Promise<boolean> {
    await this.connect();

    const retried = await this.#runQueue(q, scripts.RETRY_JOB, [
      id,
      String(now),
      resetAttempts ? "1" : "0",
    ]);

    return Number(retried) === 1;
  }

  async promoteJob(q: QueueRef, id: string, now: number): Promise<boolean> {
    await this.connect();
    const promoted = await this.#runQueue(q, scripts.PROMOTE_JOB, [
      id,
      String(now),
    ]);
    return Number(promoted) === 1;
  }

  async promoteDelayed(
    q: QueueRef,
    now: number,
    limit: number,
  ): Promise<number> {
    await this.connect();

    const moved = await this.#runQueue(q, scripts.PROMOTE_DELAYED, [
      String(now),
      String(Math.max(1, Math.floor(limit))),
    ]);

    return Number(moved ?? 0);
  }

  async recoverStalled(
    q: QueueRef,
    now: number,
    maxStalledCount: number,
    limit: number,
  ): Promise<{ requeued: string[]; dead: string[] }> {
    await this.connect();

    const result = (await this.#runQueue(q, scripts.RECOVER_STALLED, [
      String(now),
      String(maxStalledCount),
      String(Math.max(1, Math.floor(limit))),
    ])) as string[] | null;

    // Lua cannot return nested tables, so the two lists arrive separated by a
    // marker.
    const separator = (result ?? []).indexOf("|");
    return {
      requeued: (result ?? []).slice(0, separator === -1 ? 0 : separator),
      dead: separator === -1 ? [] : (result ?? []).slice(separator + 1),
    };
  }

  async cleanJobs(
    q: QueueRef,
    state: "completed" | "failed" | "dead" | "waiting" | "delayed",
    olderThanMs: number,
    limit: number,
    now: number,
  ): Promise<string[]> {
    await this.connect();

    const removed = (await this.#runQueue(q, scripts.CLEAN, [
      state,
      String(now - olderThanMs),
      String(Math.max(1, Math.floor(limit))),
    ])) as string[] | null;

    return removed ?? [];
  }

  async pruneExpired(q: QueueRef, now: number, limit: number): Promise<number> {
    await this.connect();

    const removed = await this.#runQueue(q, scripts.PRUNE_EXPIRED, [
      String(now),
      String(Math.max(1, Math.floor(limit))),
    ]);

    return Number(removed ?? 0);
  }

  async drainQueue(q: QueueRef, includeDelayed: boolean): Promise<number> {
    await this.connect();

    const removed = await this.#runQueue(q, scripts.DRAIN, [
      includeDelayed ? "1" : "0",
    ]);

    return Number(removed ?? 0);
  }

  async pauseQueue(q: QueueRef): Promise<void> {
    await this.connect();
    await this.#client.hset(this.keys.queue(q).meta, "paused", "1");
  }

  async resumeQueue(q: QueueRef): Promise<void> {
    await this.connect();
    const keys = this.keys.queue(q);

    await this.#client.hset(keys.meta, "paused", "0");
    // Wake whoever is blocked, so resuming takes effect at once.
    await this.#client.lpush(keys.wake, "1");
  }

  async isQueuePaused(q: QueueRef): Promise<boolean> {
    await this.connect();
    return (await this.#client.hget(this.keys.queue(q).meta, "paused")) === "1";
  }

  /* --- queue: repeats ---------------------------------------------------- */

  async upsertRepeat(q: QueueRef, def: RepeatRecord): Promise<void> {
    await this.connect();
    await this.#client.hset(
      this.keys.queue(q).repeats,
      def.key,
      JSON.stringify(def),
    );
  }

  async getRepeat(q: QueueRef, key: string): Promise<RepeatRecord | null> {
    await this.connect();
    const stored = await this.#client.hget(this.keys.queue(q).repeats, key);
    return stored ? safeJsonParse<RepeatRecord | null>(stored, null) : null;
  }

  async listRepeats(q: QueueRef): Promise<RepeatRecord[]> {
    await this.connect();

    const stored = (await this.#client.hgetall(
      this.keys.queue(q).repeats,
    )) as Record<string, string> | null;

    return Object.values(stored ?? {})
      .map((entry) => safeJsonParse<RepeatRecord | null>(entry, null))
      .filter((record): record is RepeatRecord => record !== null);
  }

  async removeRepeat(q: QueueRef, key: string): Promise<boolean> {
    await this.connect();
    const removed = await this.#client.send("HDEL", [
      this.keys.queue(q).repeats,
      key,
    ]);
    return Number(removed) > 0;
  }

  /* --- queue: waiting and events ------------------------------------------ */

  async nextDelayedAt(q: QueueRef): Promise<number | null> {
    await this.connect();
    const keys = this.keys.queue(q);
    let earliest: number | null = null;

    for (const set of [keys.delayed, keys.failed]) {
      const head = await this.#client.send("ZRANGE", [
        set,
        "0",
        "0",
        "WITHSCORES",
      ]);

      const score = firstScore(head);
      if (score !== null && (earliest === null || score < earliest)) {
        earliest = score;
      }
    }

    return earliest;
  }

  async waitForJob(
    q: QueueRef,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.connect();

    if (signal?.aborted || timeoutMs <= 0) {
      return;
    }

    // A blocking pop occupies its connection for the whole wait, so it gets
    // one of its own rather than stalling every other command.
    const blocking = await this.#blockingClient();
    const seconds = Math.min(this.#maxBlock, Math.max(0.01, timeoutMs / 1000));

    // The signal cannot interrupt a blocking call, so the wait is bounded by
    // the timeout the caller asked for and checked again on the way out.
    await Promise.race([
      blocking.blpop(this.keys.queue(q).wake, seconds).catch(() => null),
      sleep(timeoutMs, { signal, unref: true }).catch(() => null),
    ]);
  }

  async publish(event: DriverEvent): Promise<void> {
    await this.connect();

    await this.#client.publish(
      this.keys.channel(event.ns, event.kind, event.target),
      JSON.stringify(event),
    );
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

    await this.connect();

    const channel = this.keys.channel(ns, kind, target);
    const subscriber = await this.#subscriberClient();

    let listeners = this.#channels.get(channel);

    if (!listeners) {
      listeners = new Set();
      this.#channels.set(channel, listeners);

      // One subscription per channel, however many listeners it has.
      await subscriber.subscribe(channel, (message: string) => {
        const event = safeJsonParse<DriverEvent | null>(message, null);
        if (!event) {
          return;
        }

        for (const each of this.#channels.get(channel) ?? []) {
          each(event);
        }
      });
    }

    listeners.add(deliver);

    return async () => {
      const current = this.#channels.get(channel);
      current?.delete(deliver);

      if (current && current.size === 0) {
        this.#channels.delete(channel);
        await subscriber.unsubscribe(channel).catch(() => {});
      }
    };
  }

  /* --- internals ------------------------------------------------------------ */

  /** The runner id inside a `r:<id>` key. */
  #runnerId(key: string): string {
    return key.replace(/^r:/, "");
  }

  /** The connection reserved for blocking pops, made on first use. */
  async #blockingClient(): Promise<RedisClient> {
    this.#blocking ??= await this.#client.duplicate();
    await this.#blocking.connect();
    return this.#blocking;
  }

  /** The connection reserved for pub/sub, made on first use. */
  async #subscriberClient(): Promise<RedisClient> {
    this.#subscriber ??= await this.#client.duplicate();
    await this.#subscriber.connect();
    return this.#subscriber;
  }

  /**
   * Runs a script, sending its source only when the server has forgotten it.
   *
   * `EVALSHA` keeps the script off the wire on every call after the first;
   * `NOSCRIPT` means the server was restarted or its cache flushed, and the
   * answer is simply to send the source again.
   */
  async #run(source: string, keys: string[], args: string[]): Promise<unknown> {
    const sha = this.#shas.get(source);

    if (sha) {
      try {
        return await this.#client.evalsha(sha, keys.length, ...keys, ...args);
      } catch (error) {
        if (!/NOSCRIPT/i.test((error as Error).message)) {
          throw new DriverError("redis", "evalsha", error);
        }
        this.#shas.delete(source);
      }
    }

    try {
      const result = await this.#client.eval(
        source,
        keys.length,
        ...keys,
        ...args,
      );

      // Cache the digest for next time, but never let that failure matter.
      void this.#client
        .script("LOAD", source)
        .then((loaded) => {
          if (typeof loaded === "string") {
            this.#shas.set(source, loaded);
          }
        })
        .catch(() => {});

      return result;
    } catch (error) {
      throw new DriverError("redis", "eval", error);
    }
  }

  /** Runs a queue script with that queue's keys and prefix. */
  async #runQueue(
    q: QueueRef,
    source: string,
    args: string[],
  ): Promise<unknown> {
    return await this.#run(source, this.keys.queueScriptKeys(q), [
      this.keys.queue(q).jobPrefix,
      ...args,
    ]);
  }

  /** Retention as the three arguments the scripts read. */
  #retention(retention: Retention): {
    mode: string;
    count: string;
    ttl: string;
  } {
    if (retention === true) {
      return { mode: "remove", count: "0", ttl: "0" };
    }

    if (typeof retention === "number") {
      return { mode: "cap", count: String(retention), ttl: "0" };
    }

    if (retention && typeof retention === "object") {
      return {
        mode: retention.count === undefined ? "keep" : "cap",
        count: String(retention.count ?? 0),
        ttl: String(retention.ttl ?? 0),
      };
    }

    return { mode: "keep", count: "0", ttl: "0" };
  }

  /**
   * A job record as the values the add scripts take, in `JOB_FIELDS` order.
   *
   * Values only — the field names live in the script as a constant table, so
   * they are interned once when it is cached rather than once per job. That
   * halves the ARGV entries, and every entry is a string the Lua VM has to
   * intern on the way in: 10 for a fresh job where the name/value shape sent
   * 22.
   *
   * Written out in order rather than built and filtered. The obvious shape —
   * all twenty-two, then drop the ones a fresh job does not need — costs four
   * `JSON.stringify` calls whose results are discarded, a `Set` allocated per
   * job, and three more arrays from `entries`/`filter`/`flat`. Measured against
   * bee-queue's single `toData()`, that was 4.50µs a job to its 0.26µs, all of
   * it on the enqueue critical path.
   */
  #toValues(job: JobRecord): string[] {
    // The first FRESH_JOB_FIELD_COUNT of JOB_FIELDS, in that order. `blob`
    // carries the four fields no script ever touches, in one value — see
    // `JOB_FIELDS`. It is also one `JSON.stringify` where `data` and `opts`
    // were two.
    const values: string[] = [
      job.id,
      job.state,
      String(job.priority),
      String(job.runAt),
      String(job.createdAt),
      JSON.stringify({
        name: job.name,
        maxAttempts: job.maxAttempts,
        data: job.data ?? null,
        opts: job.opts,
      }),
    ];

    // Only `addJob` and `addJobs` call this, both writing a hash that does not
    // exist yet, so stopping here simply leaves the rest absent — and the
    // reader treats absent and default alike. For a brand-new job that is
    // every remaining field: each an empty string, a "null" or a zero.
    if (this.#isFreshJob(job)) {
      return values;
    }

    // The rest of JOB_FIELDS, in that order.
    values.push(
      job.processedOn === null ? "" : String(job.processedOn),
      job.finishedOn === null ? "" : String(job.finishedOn),
      job.expiresAt === null ? "" : String(job.expiresAt),
      String(job.attemptsMade),
      String(job.stalledCount),
      job.lockToken ?? "",
      job.lockExpiresAt === null ? "" : String(job.lockExpiresAt),
      job.workerId ?? "",
      job.repeatKey ?? "",
      JSON.stringify(job.progress ?? null),
      JSON.stringify(job.returnValue ?? null),
      JSON.stringify(job.failedReason ?? null),
      JSON.stringify(job.stacktrace ?? []),
    );

    return values;
  }

  /**
   * Whether a record carries nothing beyond what a brand-new job carries.
   *
   * `maxAttempts` is deliberately not omittable: an absent numeric field reads
   * back as zero, and zero is not this one's default.
   */
  #isFreshJob(job: JobRecord): boolean {
    return (
      job.processedOn === null &&
      job.finishedOn === null &&
      job.expiresAt === null &&
      job.lockToken === null &&
      job.lockExpiresAt === null &&
      job.workerId === null &&
      job.repeatKey === null &&
      job.attemptsMade === 0 &&
      job.stalledCount === 0 &&
      job.progress === null &&
      job.returnValue === null &&
      job.failedReason === null &&
      (job.stacktrace?.length ?? 0) === 0
    );
  }

  /** A flat `HGETALL` reply as an object, or `null` when the job is gone. */
  #toObject(reply: unknown): Record<string, string> | null {
    if (!reply) {
      return null;
    }

    // A script returns HGETALL as a flat array; the client returns an object.
    if (Array.isArray(reply)) {
      if (reply.length === 0) {
        return null;
      }

      const fields: Record<string, string> = {};
      for (let index = 0; index < reply.length; index += 2) {
        fields[String(reply[index])] = String(reply[index + 1]);
      }
      return fields;
    }

    const fields = reply as Record<string, string>;
    return Object.keys(fields).length > 0 ? fields : null;
  }

  /** Stored fields as a job record. */
  #toRecord(fields: Record<string, string>): JobRecord {
    const number = (name: string): number => Number(fields[name] ?? 0);
    const nullable = (name: string): number | null =>
      fields[name] === undefined || fields[name] === ""
        ? null
        : Number(fields[name]);
    const text = (name: string): string | null =>
      fields[name] === undefined || fields[name] === "" ? null : fields[name];
    const json = <T>(name: JsonField, fallback: T): T =>
      safeJsonParse<T>(fields[name], fallback);

    // `blob` holds `name`, `maxAttempts`, `data` and `opts` together. A record
    // written before it existed has them as four separate fields instead, and
    // both have to read back the same — nothing migrates a hash in place.
    const blob = safeJsonParse<{
      name?: string;
      maxAttempts?: number;
      data?: unknown;
      opts?: ResolvedJobOptions;
    }>(fields.blob, {});

    return {
      id: fields.id,
      name: blob.name ?? fields.name,
      data:
        blob.name === undefined
          ? json<unknown>("data", null)
          : (blob.data ?? null),
      opts:
        blob.opts ?? json<ResolvedJobOptions>("opts", {} as ResolvedJobOptions),
      state: fields.state as JobState,
      priority: number("priority"),
      runAt: number("runAt"),
      createdAt: number("createdAt"),
      processedOn: nullable("processedOn"),
      finishedOn: nullable("finishedOn"),
      expiresAt: nullable("expiresAt"),
      attemptsMade: number("attemptsMade"),
      maxAttempts: blob.maxAttempts ?? number("maxAttempts"),
      stalledCount: number("stalledCount"),
      progress: json<unknown>("progress", null),
      returnValue: json<unknown>("returnValue", null),
      failedReason: json<SerializedError | null>("failedReason", null),
      stacktrace: json<SerializedError[]>("stacktrace", []),
      lockToken: text("lockToken"),
      lockExpiresAt: nullable("lockExpiresAt"),
      workerId: text("workerId"),
      repeatKey: text("repeatKey"),
    };
  }
}
