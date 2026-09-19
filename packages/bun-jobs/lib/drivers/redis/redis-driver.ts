import type { SerializedError } from "@kingsleyweb/bun-common";
import type { RedisClient } from "bun";
import type {
  ConnectionInput,
  ConnectionOptions,
} from "../../shared/connection";
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
  ResolvedJobOptions,
  Retention,
  RunRecord,
  ThroughputBucket,
  WorkerInfo,
} from "../driver";
import { Buffer } from "node:buffer";
import { jsonClone } from "@kingsleyweb/bun-common";
import { RedisClient as BunRedis } from "bun";
import { assertWritableStateName } from "../../queue/windows";
import { resolveConnectionUrl } from "../../shared/connection";
import { DriverError } from "../../shared/errors";
import { safeJsonParse } from "../../shared/json";
import { waitForAny } from "../../shared/wait";
import {
  jobFilter,
  matchesFilter,
  orderByIds,
  sortWorkers,
  sumBuckets,
  sumStates,
  THROUGHPUT_BUCKET_MS,
  THROUGHPUT_RETENTION_MS,
} from "../readApis";
import { RedisKeys } from "./keys";
import * as scripts from "./scripts";

/** Every answer `RECORD_CHILD` may give; anything else is a fault. */
const CHILD_RECORD_RESULTS = new Set<ChildRecordResult>([
  "recorded",
  "released",
  "buried",
  "already",
  "parent-dead",
  "missing",
]);

/**
 * A flow reference as JSON, keys always `queue` then `id`. The skeleton is
 * written with it and `RECORD_CHILD` searches the skeleton for it, so the two
 * must produce the same bytes for the same reference.
 */
function flowRefJson(ref: JobRef): string {
  return JSON.stringify({ queue: ref.queue, id: ref.id });
}

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
 * How many set members one `FIND_NAMES` call reads while a filtered
 * `findJobs` walks a state. Each member costs the script one `HMGET` and the
 * reply an id and a name, so this bounds both how long one call holds Redis's
 * single thread and how large a reply gets.
 */
const FIND_CHUNK = 500;

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
  | "stacktrace"
  | "flow";

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
  /**
   * An already-connected client, when the application has one to share. It
   * carries commands and scripts only; `url` is still required, because
   * blocking waits and pub/sub each need a connection of their own, and the
   * driver opens those from it. Without `url` the constructor throws a
   * `ConfigError`.
   */
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
  /**
   * The blocking pop in flight per wake key, so waits share one rather than
   * stacking up behind each other on the single blocking connection.
   */
  readonly #pops = new Map<string, Promise<unknown>>();
  /** How many callers are currently waiting on each key's pop. */
  readonly #waiters = new Map<string, number>();
  /**
   * Keys whose pop took a wake token with nobody left to give it to.
   *
   * `BLPOP` is a destructive read of a list, so a token it takes is gone for
   * everyone. A pop whose caller has since given up would therefore swallow
   * the wake an `add()` sent and leave that job waiting out a whole further
   * period; remembering it here hands it to the next waiter instead.
   */
  readonly #missed = new Set<string>();
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

    // Closing the connection settles any parked pop; nothing may be carried
    // over to a driver that connects again.
    this.#pops.clear();
    this.#waiters.clear();
    this.#missed.clear();

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

    // A runner exists once it has written state — on `start()`, whether or
    // not it ever takes a lock, as a parallel-mode runner never does.
    await this.#client.sadd(this.keys.runners(ns), this.#runnerId(key));

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

  async peekQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    await this.connect();

    // `LINDEX 0` is the element `LPOP` takes next, read without removing it;
    // a missing key answers `nil` and is not created.
    const head = await this.#client.lindex(
      this.keys.runner(ns, this.#runnerId(key)).queued,
      0,
    );

    return head ? safeJsonParse<QueuedTrigger | null>(head, null) : null;
  }

  async popQueuedTriggerIf(
    ns: string,
    key: string,
    expectedId: string,
  ): Promise<QueuedTrigger | null> {
    await this.connect();

    // One script — `LINDEX 0`, compare the id, `LPOP` — so the head checked
    // is the head taken, whatever other clients do meanwhile.
    const head = await this.#run(
      scripts.POP_QUEUED_IF,
      [this.keys.runner(ns, this.#runnerId(key)).queued],
      [expectedId],
    );

    return typeof head === "string"
      ? safeJsonParse<QueuedTrigger | null>(head, null)
      : null;
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
      // Last, because they are variadic. None at all is how the script knows
      // to take the plain head read.
      ...(opts.excludeNames ?? []),
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
      // Last, because they are variadic. None at all is how the script knows
      // to take the plain head read.
      ...(opts.excludeNames ?? []),
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

  async buryJob(
    q: QueueRef,
    id: string,
    error: SerializedError,
    opts: { retention: Retention; keepStacktraces: number; token?: string },
    now: number,
  ): Promise<JobRecord | null> {
    await this.connect();

    const existing = await this.getJob(q, id);
    if (!existing) {
      return null;
    }

    // Built here, as `failJob` builds it: the script only swaps it in. The
    // state and lock are checked in the script, which is what counts.
    const stacktrace = [error, ...existing.stacktrace].slice(
      0,
      Math.max(0, opts.keepStacktraces),
    );
    const { mode, count, ttl } = this.#retention(opts.retention);

    const buried = await this.#runQueue(q, scripts.BURY, [
      id,
      opts.token ?? "",
      String(now),
      JSON.stringify(error),
      JSON.stringify(stacktrace),
      mode,
      count,
      ttl,
    ]);

    const fields = this.#toObject(buried);
    return fields ? this.#toRecord(fields) : null;
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

  /**
   * Changes a job's data, priority or due time in one script.
   *
   * Everything the script cannot know without a clock is settled here first:
   * the state a new `runAt` leads to, and which states the patch allows. An
   * empty allowed set can match nothing, so it costs no round trip at all.
   */
  async updateJob(
    q: QueueRef,
    id: string,
    patch: JobPatch,
    now: number,
  ): Promise<JobRecord | null> {
    const pending: JobState[] = ["waiting", "delayed"];
    let allowed: JobState[] | undefined = patch.onlyIn;

    // Only a pending job has a due time to move.
    if (patch.runAt !== undefined) {
      allowed = (allowed ?? pending).filter((state) => pending.includes(state));
    }

    if (allowed && allowed.length === 0) {
      return null;
    }

    await this.connect();

    const reply = await this.#runQueue(q, scripts.UPDATE_JOB, [
      id,
      patch.data === undefined ? "0" : "1",
      patch.data === undefined ? "" : JSON.stringify(patch.data),
      patch.priority === undefined ? "0" : "1",
      patch.priority === undefined ? "" : String(patch.priority),
      patch.runAt === undefined ? "0" : "1",
      patch.runAt === undefined ? "" : String(patch.runAt),
      patch.runAt !== undefined && patch.runAt > now ? "delayed" : "waiting",
      ...(allowed ?? []),
    ]);

    const fields = this.#toObject(reply);
    return fields ? this.#toRecord(fields) : null;
  }

  async addJobLog(
    q: QueueRef,
    id: string,
    line: string,
    keep: number,
  ): Promise<number> {
    await this.connect();
    const keys = this.keys.queue(q);

    const count = await this.#run(
      scripts.ADD_JOB_LOG,
      [`${keys.jobPrefix}${id}`, `${keys.logPrefix}${id}`],
      [line, String(Math.max(0, Math.floor(keep)))],
    );

    return Number(count ?? 0);
  }

  async getJobLogs(
    q: QueueRef,
    id: string,
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<{ logs: string[]; count: number }> {
    await this.connect();

    const reply = await this.#run(
      scripts.GET_JOB_LOGS,
      [`${this.keys.queue(q).logPrefix}${id}`],
      [
        String(Math.max(0, Math.floor(opts.offset))),
        String(Math.max(0, Math.floor(opts.limit))),
        opts.order,
      ],
    );

    // The count leads, and the lines follow in the order asked for. They are
    // bulk strings, so they arrive exactly as they were pushed.
    const [count, ...lines] = Array.isArray(reply) ? reply : [0];
    return { logs: lines.map(String), count: Number(count ?? 0) };
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

  /**
   * Records a child's outcome on its parent in one script on the parent's
   * queue — see `RECORD_CHILD` for how it stays repeat-safe without decoding
   * anything.
   */
  async recordChild(
    q: QueueRef,
    parentId: string,
    child: JobRef,
    outcome: ChildOutcome,
    now: number,
  ): Promise<ChildRecordResult> {
    await this.connect();

    let kind: "completed" | "ignored" | "failed" = "failed";
    let payload: unknown = null;

    if (outcome.completed) {
      kind = "completed";
      payload = outcome.value ?? null;
    } else {
      kind = outcome.ignored ? "ignored" : "failed";
      payload = outcome.error;
    }

    const reply = await this.#runQueue(q, scripts.RECORD_CHILD, [
      parentId,
      `${child.queue}:${child.id}`,
      kind,
      // Encoded once, here, and stored as sent: the script never decodes it.
      JSON.stringify(payload) ?? "null",
      String(now),
      // Exactly as `#values` writes each entry of `children`.
      flowRefJson(child),
    ]);

    if (!CHILD_RECORD_RESULTS.has(reply as ChildRecordResult)) {
      // Guessing would be worse than failing: an answer that lets the child's
      // retention run could lose an outcome that was never stored.
      throw new DriverError(
        "redis",
        "recordChild",
        new Error(`unexpected reply ${String(reply)}`),
        { id: parentId },
      );
    }

    return reply as ChildRecordResult;
  }

  async requeueParent(q: QueueRef, id: string, now: number): Promise<boolean> {
    await this.connect();

    const moved = await this.#runQueue(q, scripts.REQUEUE_PARENT, [
      id,
      String(now),
    ]);

    return Number(moved) === 1;
  }

  async markChildRecorded(
    q: QueueRef,
    id: string,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    await this.connect();
    const { mode, count, ttl } = this.#retention(retention);

    const marked = await this.#runQueue(q, scripts.MARK_CHILD_RECORDED, [
      id,
      String(now),
      mode,
      count,
      ttl,
    ]);

    return Number(marked) === 1;
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

    const [waiting, delayed, active, completed, failed, dead, children] =
      counts ?? [];

    return {
      waiting: Number(waiting ?? 0),
      delayed: Number(delayed ?? 0),
      active: Number(active ?? 0),
      completed: Number(completed ?? 0),
      failed: Number(failed ?? 0),
      dead: Number(dead ?? 0),
      "waiting-children": Number(children ?? 0),
    };
  }

  /**
   * A page of jobs narrowed by name or a search.
   *
   * Unfiltered, this is `listJobs` plus, when asked, the states' counts.
   * Filtered, there is no index on names to use, so the states' sets are
   * walked in `listJobs` order a {@link FIND_CHUNK} at a time through
   * `FIND_NAMES`, which answers each job's id and name only; the filter runs
   * here. The walk stops once the page is full unless a total is wanted, and
   * the page's full records are then read in one batch.
   */
  async findJobs(q: QueueRef, query: JobQuery): Promise<JobPage> {
    // Nothing matches an empty name list, or no states: answered here, as the
    // SQL and memory drivers do, rather than walking every set to find so.
    if (query.names?.length === 0 || query.states.length === 0) {
      return query.total ? { jobs: [], total: 0 } : { jobs: [] };
    }

    await this.connect();

    const filter = jobFilter(query);
    const offset = Math.max(0, Math.floor(query.offset));
    const limit = Math.max(0, Math.floor(query.limit));

    if (!filter) {
      const [jobs, counts] = await Promise.all([
        limit === 0
          ? Promise.resolve([])
          : this.listJobs(q, query.states, {
              offset,
              limit,
              order: query.order,
            }),
        query.total ? this.countJobs(q) : Promise.resolve(null),
      ]);

      return counts
        ? { jobs, total: sumStates(counts, query.states) }
        : { jobs };
    }

    // The order LIST_JOBS concatenates sets in: as given, reversed for desc.
    const states =
      query.order === "desc" ? [...query.states].reverse() : query.states;
    const ids: string[] = [];
    let skip = offset;
    let total = 0;

    walk: for (const state of states) {
      for (let start = 0; ; start += FIND_CHUNK) {
        if (!query.total && ids.length >= limit) {
          break walk;
        }

        const reply = await this.#runQueue(q, scripts.FIND_NAMES, [
          state,
          String(start),
          String(FIND_CHUNK),
          query.order,
        ]);
        const pairs = Array.isArray(reply) ? reply.map(String) : [];

        for (let index = 0; index < pairs.length; index += 2) {
          const id = pairs[index]!;
          const name = this.#decodeName(pairs[index + 1]!);

          if (name === null || !matchesFilter(filter, id, name)) {
            continue;
          }

          total++;

          if (skip > 0) {
            skip--;
          } else if (ids.length < limit) {
            ids.push(id);
          }
        }

        if (pairs.length < FIND_CHUNK * 2) {
          break;
        }
      }
    }

    // A job removed since its name was read has no record, and is left out.
    const jobs = (await this.getJobs(q, ids)).filter(
      (job): job is JobRecord => job !== null,
    );

    return query.total ? { jobs, total } : { jobs };
  }

  /**
   * Several jobs by id, one `HGETALL` per distinct id sent together — the
   * client pipelines them onto one connection — and answered in the order
   * asked.
   */
  async getJobs(q: QueueRef, ids: string[]): Promise<(JobRecord | null)[]> {
    if (ids.length === 0) {
      return [];
    }

    await this.connect();

    const distinct = [...new Set(ids)];
    const records = await Promise.all(
      distinct.map(async (id) => await this.getJob(q, id)),
    );

    return orderByIds(
      ids,
      new Map(distinct.map((id, index) => [id, records[index] ?? null])),
    );
  }

  /**
   * Writes a worker's record and its expiry in one script, which also removes lapsed
   * records and gives both keys a relative lifetime — see `REGISTER_WORKER`.
   */
  async registerWorker(q: QueueRef, worker: WorkerInfo): Promise<void> {
    await this.connect();
    const keys = this.keys.queue(q);
    // Twice the record's own lifetime, and never under a second: the keys
    // outlive every live record, measured on the server's clock.
    const ttl = 2 * Math.max(1_000, worker.expiresAt - worker.heartbeatAt);

    await this.#run(
      scripts.REGISTER_WORKER,
      [keys.workers, keys.workersExpiry],
      [
        worker.id,
        JSON.stringify(worker),
        String(worker.expiresAt),
        String(worker.heartbeatAt),
        String(Math.ceil(ttl)),
      ],
    );
  }

  async removeWorker(q: QueueRef, id: string): Promise<boolean> {
    await this.connect();
    const keys = this.keys.queue(q);

    const removed = await this.#run(
      scripts.REMOVE_WORKER,
      [keys.workers, keys.workersExpiry],
      [id],
    );

    return Number(removed) > 0;
  }

  /** The live workers, removing lapsed records in the same script. */
  async listWorkers(q: QueueRef, now: number): Promise<WorkerInfo[]> {
    await this.connect();
    const keys = this.keys.queue(q);

    const reply = await this.#run(
      scripts.LIST_WORKERS,
      [keys.workers, keys.workersExpiry],
      [String(now)],
    );

    const workers = (Array.isArray(reply) ? reply : [])
      .map((entry) => safeJsonParse<WorkerInfo | null>(String(entry), null))
      .filter((worker): worker is WorkerInfo => worker !== null);

    return sortWorkers(workers);
  }

  /** Counts for every queue the namespace's queue set names, sent together. */
  async countJobsByQueue(
    ns: string,
  ): Promise<Record<string, Record<JobState, number>>> {
    const names = await this.listQueues(ns);
    const counts = await Promise.all(
      names.map(async (queue) => await this.countJobs({ ns, queue })),
    );

    return Object.fromEntries(
      names.map((queue, index) => [queue, counts[index]!]),
    );
  }

  /**
   * The minutes in `[from, to]` from the hashes COMPLETE and FAIL count into.
   * The range is cut to the minutes retention can still hold — a day and one
   * minute back from `to` — so a careless range cannot make the script walk
   * years of empty minutes.
   */
  async getThroughput(
    q: QueueRef,
    range: { from: number; to: number },
  ): Promise<ThroughputBucket[]> {
    const last =
      Math.floor(range.to / THROUGHPUT_BUCKET_MS) * THROUGHPUT_BUCKET_MS;
    const first = Math.max(
      Math.ceil(range.from / THROUGHPUT_BUCKET_MS) * THROUGHPUT_BUCKET_MS,
      last - THROUGHPUT_RETENTION_MS,
    );

    if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) {
      return [];
    }

    await this.connect();

    const reply = await this.#runQueue(q, scripts.GET_THROUGHPUT, [
      String(first),
      String(last),
    ]);
    const flat = Array.isArray(reply) ? reply : [];
    const rows: { at: number; completed: number; failed: number }[] = [];

    for (let index = 0; index + 2 < flat.length; index += 3) {
      rows.push({
        at: Number(flat[index]),
        completed: Number(flat[index + 1]),
        failed: Number(flat[index + 2]),
      });
    }

    return sumBuckets(rows, range);
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

  /* --- queue: state ----------------------------------------------------- */

  async getQueueState(
    q: QueueRef,
    name: string,
  ): Promise<QueueStateEntry | null> {
    await this.connect();

    // One read for both fields, so the value and its version always match.
    const [version, value] = await this.#client.hmget(
      `${this.keys.queue(q).statePrefix}${name}`,
      ["version", "value"],
    );

    return version === null || version === undefined
      ? null
      : {
          value: safeJsonParse<unknown>(value ?? undefined, null),
          version: Number(version),
        };
  }

  async setQueueState(
    q: QueueRef,
    name: string,
    value: unknown,
    expected: number | null,
    options?: { internal?: symbol },
  ): Promise<number | null> {
    assertWritableStateName(name, options);

    await this.connect();

    const keys = this.keys.queue(q);
    const version = await this.#run(
      scripts.SET_QUEUE_STATE,
      [`${keys.statePrefix}${name}`, keys.stateNames],
      [
        expected === null ? "" : String(expected),
        value === null ? "1" : "0",
        value === null ? "" : (JSON.stringify(value) ?? "null"),
        name,
      ],
    );

    return version === null || version === undefined ? null : Number(version);
  }

  async listQueueState(
    q: QueueRef,
    options: { prefix: string; after?: string; limit: number },
  ): Promise<string[]> {
    const limit = Math.floor(options.limit);

    // Redis reads a negative LIMIT count as "no limit", so answer here.
    if (!(limit > 0)) {
      return [];
    }

    await this.connect();

    const { prefix, after } = options;

    // Start at whichever is later: just past `after`, or the prefix itself.
    // An `after` that sorts below the prefix would otherwise start the range
    // among names that do not match, and the cut below would stop at once.
    // Compared as bytes, because that is how BYLEX compares.
    const start =
      after !== undefined &&
      Buffer.compare(Buffer.from(after), Buffer.from(prefix)) >= 0
        ? `(${after}`
        : `[${prefix}`;

    // Every member has score 0, so BYLEX orders them by their UTF-8 bytes.
    // For ASCII — and any names without characters above U+FFFF — that is the
    // JavaScript code-unit order the contract sorts by. Names mixing
    // characters above U+FFFF with ones in U+E000–U+FFFF can order
    // differently: UTF-16 puts the surrogate pair first, UTF-8 puts it last.
    const members = (await this.#client.send("ZRANGE", [
      this.keys.queue(q).stateNames,
      start,
      "+",
      "BYLEX",
      "LIMIT",
      "0",
      String(limit),
    ])) as string[] | null;

    // Names sharing a prefix are contiguous from the start, so the first one
    // that does not begin with it ends the matches. Cutting after LIMIT still
    // honours `limit`: every match is ahead of every non-match in the page.
    const names: string[] = [];

    for (const member of members ?? []) {
      if (!member.startsWith(prefix)) {
        break;
      }
      names.push(member);
    }

    return names;
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

    const key = this.keys.queue(q).wake;

    // A wake that landed while nobody was listening goes to the next waiter.
    // Without this the token a pop took just after its caller gave up was
    // simply lost, and the job that sent it waited out the next full period.
    if (this.#missed.delete(key)) {
      return;
    }

    // A blocking pop occupies its connection for the whole wait, so it gets
    // one of its own rather than stalling every other command.
    const blocking = await this.#blockingClient();
    const seconds = Math.min(this.#maxBlock, Math.max(0.01, timeoutMs / 1000));

    // The signal cannot interrupt a blocking call, so the wait is bounded by
    // the timeout the caller asked for and checked again on the way out.
    //
    // The caller's signal outlives this wait — a worker passes the same one to
    // every wait it makes — so nothing may be left listening on it when the
    // pop wins, which on a busy queue is every job. See `waitForAny`.
    const pop = this.#pop(blocking, key, seconds);
    this.#waiters.set(key, (this.#waiters.get(key) ?? 0) + 1);

    try {
      await waitForAny(timeoutMs, { signal, others: [pop] });
    } finally {
      this.#waiters.set(key, Math.max(0, (this.#waiters.get(key) ?? 1) - 1));
    }
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

  /**
   * The blocking pop for a wake key, started if one is not already running.
   *
   * A `BLPOP` cannot be called off, so an abandoned one stays parked on the
   * connection until the server times it out — and because Redis serves one
   * connection's commands in order, a second pop issued meanwhile queues
   * behind it. Sharing the one in flight fixes both: nothing stacks up, and
   * the token it eventually takes reaches whoever is waiting by then rather
   * than a caller that has gone.
   *
   * The hot path is a `Map` lookup and no extra Redis command at all. A
   * caller that joins a pop started with a shorter budget may be released
   * early with nothing to claim; it simply waits again, which is what it does
   * after any empty claim.
   */
  #pop(client: RedisClient, key: string, seconds: number): Promise<unknown> {
    const running = this.#pops.get(key);
    if (running) {
      return running;
    }

    const pop = client
      .blpop(key, seconds)
      .catch(() => null)
      .then((token) => {
        this.#pops.delete(key);

        // Resolved before any waiter has stopped awaiting it, so this count
        // still includes them — nobody left means every caller gave up.
        if (token !== null && (this.#waiters.get(key) ?? 0) === 0) {
          this.#missed.add(key);
        }

        return token;
      });

    this.#pops.set(key, pop);
    return pop;
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

    // A job in no flow stops here, and the script writes none of the flow
    // fields; the reader takes their absence as `flow: null`.
    if (!job.flow) {
      return values;
    }

    const { parent, children, pending, recorded } = job.flow;
    values.push(
      // Each reference rebuilt with its keys in one fixed order, which is
      // what lets `RECORD_CHILD` find a child by substring — see
      // `flowRefJson`. Written by hand, so the order is not the caller's.
      `{"parent":${parent ? flowRefJson(parent) : "null"},"children":[${children
        .map((ref) => flowRefJson(ref))
        .join(",")}]}`,
      String(pending),
      recorded ? "1" : "0",
    );

    // Outcomes a record arrives with, as name/value pairs after the named
    // fields — the same one field per child that `RECORD_CHILD` writes.
    for (const [key, value] of Object.entries(job.flow.values)) {
      values.push(
        `${scripts.FLOW_VALUE_PREFIX}${key}`,
        JSON.stringify(value ?? null),
      );
    }
    for (const [key, error] of Object.entries(job.flow.failures)) {
      values.push(
        `${scripts.FLOW_FAILURE_PREFIX}${key}`,
        JSON.stringify(error),
      );
    }

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
      // A job in a flow carries it from the start, so it is never "fresh".
      !job.flow &&
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

  /**
   * A name as `FIND_NAMES` tags it: `j` then a JSON string literal, `r` then
   * the name itself, or `-` (answered `null`) for a job whose hash has gone.
   * A literal that does not parse — which the script's cut never produces —
   * reads as `null` too, rather than matching on a mangled name.
   */
  #decodeName(tagged: string): string | null {
    const tag = tagged[0];

    if (tag === "r") {
      return tagged.slice(1);
    }

    if (tag === "j") {
      const name = safeJsonParse<unknown>(tagged.slice(1), null);
      return typeof name === "string" ? name : null;
    }

    return null;
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

    // `updateJob` never rewrites the blob — see `UPDATE_JOB` — so a patched
    // payload sits in `data` and a patched priority in `optsPriority`, and
    // either wins over the blob's copy. A record from before the blob keeps
    // its payload in `data` too, so one rule reads both shapes.
    const opts =
      blob.opts ?? json<ResolvedJobOptions>("opts", {} as ResolvedJobOptions);
    const optsPriority = nullable("optsPriority");

    return {
      id: fields.id,
      name: blob.name ?? fields.name,
      data:
        fields.data !== undefined
          ? json<unknown>("data", null)
          : (blob.data ?? null),
      opts: optsPriority === null ? opts : { ...opts, priority: optsPriority },
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
      flow: this.#toFlow(fields),
    };
  }

  /**
   * A job's flow, assembled from the fields that hold it, or `null` for a job
   * in none — including every hash written before flows existed.
   *
   * `flow` holds the parent and children, `flowPending` and `flowRecorded` the
   * two parts scripts change, and each child outcome has a field of its own.
   * A job with only `flowRecorded` was marked by `markChildRecorded` without
   * ever being in a flow, and reads as an empty one.
   */
  #toFlow(fields: Record<string, string>): JobFlow | null {
    const skeleton = safeJsonParse<Pick<JobFlow, "parent" | "children"> | null>(
      fields.flow,
      null,
    );

    if (!skeleton && fields.flowRecorded !== "1") {
      return null;
    }

    const values: Record<string, unknown> = {};
    const failures: Record<string, SerializedError> = {};

    for (const [field, stored] of Object.entries(fields)) {
      if (field.startsWith(scripts.FLOW_VALUE_PREFIX)) {
        values[field.slice(scripts.FLOW_VALUE_PREFIX.length)] =
          safeJsonParse<unknown>(stored, null);
      } else if (field.startsWith(scripts.FLOW_FAILURE_PREFIX)) {
        const error = safeJsonParse<SerializedError | null>(stored, null);
        if (error) {
          failures[field.slice(scripts.FLOW_FAILURE_PREFIX.length)] = error;
        }
      }
    }

    return {
      parent: skeleton?.parent ?? null,
      children: skeleton?.children ?? [],
      pending: Number(fields.flowPending ?? 0) || 0,
      values,
      failures,
      recorded: fields.flowRecorded === "1",
    };
  }
}
