import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  Collection,
  Db,
  Filter,
  MongoClient,
  MongoClientOptions,
  UpdateFilter,
} from "mongodb";
import type {
  ConnectionInput,
  ConnectionOptions,
} from "../../shared/connection";
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
  ResolvedJobOptions,
  Retention,
  RunRecord,
} from "../driver";
import { jsonClone, sleep } from "@kingsleyweb/bun-common";
import {
  databaseFromUrl,
  resolveConnectionUrl,
  resolveNames,
} from "../../shared/connection";
import { ConfigError, DriverError } from "../../shared/errors";
import { PauseCache } from "../../shared/pauseCache";

/**
 * A driver backed by MongoDB.
 *
 * MongoDB earns its place here because its document updates are atomic on
 * their own: a claim is one `findOneAndUpdate` whose filter names the state it
 * expects, so the server hands the document to exactly one caller and tells
 * everyone else it matched nothing. No transaction, and therefore no replica
 * set required — a standalone `mongod` is enough.
 *
 * Two details are deliberate. Payloads are stored as JSON strings rather than
 * as documents: BSON forbids `.` and `$` in field names, and a job's data is
 * the caller's, not ours to restrict — this way what comes back is byte for
 * byte what every other driver returns. And a runner's history and queued
 * triggers use `$push`/`$slice` and `$pop`, so bounding and FIFO order are the
 * server's job rather than a read-modify-write race waiting to happen.
 *
 * The client is an **optional peer dependency**: nothing here is loaded unless
 * this driver is constructed, so a project that does not use MongoDB never
 * installs it.
 */

/** How often a polling wait re-checks, in milliseconds. */
const POLL_MS = 50;

/** The collections this driver uses. */
export const MONGO_COLLECTIONS = ["jobs", "locks", "kv", "events"] as const;

/** One of the collections this driver uses. */
export type MongoCollection = (typeof MONGO_COLLECTIONS)[number];

/** MongoDB's duplicate-key error, which is how "someone got there first" arrives. */
const DUPLICATE_KEY = 11000;

/** States holding a job that is due later. */
const SCHEDULED: JobState[] = ["delayed", "failed"];

/** Options for {@link MongoDriver}. */
export interface MongoDriverOptions extends ConnectionInput {
  /**
   * A connection string. Wins over `connection` when both are given, so an
   * environment variable can override a config file.
   */
  url?: string;
  /** The connection as fields, for when a URL is not what you have. */
  connection?: ConnectionOptions;
  /**
   * Database to use. Defaults to the one named in the URL's path, and falls
   * back to `bun_jobs`.
   */
  database?: string;
  /** Prepended to every collection name. Defaults to `bun_jobs_`. */
  collectionPrefix?: string;
  /**
   * Exact collection names, for an existing database that was not named here.
   * Given as-is, so a name set this way ignores `collectionPrefix`.
   */
  collections?: Partial<Record<MongoCollection, string>>;
  /** Options passed to the `MongoClient` this driver creates. */
  clientOptions?: MongoClientOptions;
  /** An already-connected client, when the application has one to share. */
  client?: MongoClient;
  /** How often a wait re-checks for work. Defaults to 50ms. */
  pollInterval?: number;
}

/** A job as it is stored: identifiers and ordering keys plain, payloads JSON. */
interface JobDocument {
  /** `<ns>:<queue>:<id>`, which is what makes an add idempotent. */
  _id: string;
  /** The namespace the job belongs to. */
  ns: string;
  /** The queue it belongs to. */
  queue: string;
  /** The job's id within that queue. */
  id: string;
  /** The job's name. */
  name: string;
  /** Where the job is. */
  state: JobState;
  /** Lower runs first. */
  priority: number;
  /** When it becomes claimable. */
  runAt: number;
  /** When it was added. */
  createdAt: number;
  /** When the current or last attempt started. */
  processedOn: number | null;
  /** When it completed or died. */
  finishedOn: number | null;
  /** When retention removes it. */
  expiresAt: number | null;
  /** How many attempts have been made. */
  attemptsMade: number;
  /** How many are allowed. */
  maxAttempts: number;
  /** How many times it stalled. */
  stalledCount: number;
  /** The worker holding it. */
  workerId: string | null;
  /** That worker's lock token. */
  lockToken: string | null;
  /** When the lock expires. */
  lockExpiresAt: number | null;
  /** The repeat series that produced it. */
  repeatKey: string | null;
  /** The caller's payload, as JSON. */
  data: string;
  /** Resolved options, as JSON. */
  opts: string;
  /** Latest progress, as JSON. */
  progress: string;
  /** The processor's result, as JSON. */
  returnValue: string;
  /** The most recent failure, as JSON. */
  failedReason: string;
  /** Recent failures, as JSON. */
  stacktrace: string;
}

/** A lock as it is stored. */
interface LockDocument {
  /** `<ns>:<key>`. */
  _id: string;
  /** The namespace. */
  ns: string;
  /** The lock's key. */
  key: string;
  /** Who holds it. */
  token: string;
  /** When it lapses. */
  expiresAt: number;
}

/** A key/value document: runner state, queue metadata, repeat definitions. */
interface KvDocument {
  /** `<ns>:<key>`. */
  _id: string;
  /** The namespace. */
  ns: string;
  /** The key within it. */
  key: string;
  /** String fields (runner state). */
  fields?: Record<string, string>;
  /** Numeric counters, kept apart so `$inc` can be used. */
  counters?: Record<string, number>;
  /** Run history, newest first, each entry JSON. */
  history?: string[];
  /** Queued triggers, oldest first, each entry JSON. */
  queued?: string[];
  /** An arbitrary JSON document, for queue metadata and repeats. */
  value?: string;
  /** When it last changed. */
  updatedAt: number;
}

/** An event as it is stored. */
interface EventDocument {
  /** The namespace. */
  ns: string;
  /** `<kind>:<target>`. */
  channel: string;
  /** The event, as JSON. */
  payload: string;
  /** When it was published. */
  at: number;
}

export class MongoDriver implements JobsDriver {
  /** Identifies the implementation in errors and capability checks. */
  readonly name = "mongodb";

  /**
   * A document update is atomic on its own, so claiming is safe from any
   * number of processes and hosts. Waiting is polled: change streams would be
   * lower-latency but need a replica set, and a standalone server is the
   * common case.
   */
  readonly capabilities: DriverCapabilities = {
    blockingWait: false,
    events: "poll",
    multiProcess: true,
    multiHost: true,
  };

  /** The database this driver uses. */
  readonly database: string;
  /** The resolved collection names. */
  readonly collections: Record<MongoCollection, string>;

  /** The connection URL, resolved from a URL or from fields. */
  /** Pause flags, so a claim does not read one per call. */
  readonly #pauseCache = new PauseCache();
  readonly #url: string;
  /** Options for the client this driver creates. */
  readonly #clientOptions?: MongoClientOptions;
  /** How often a wait re-checks. */
  readonly #poll: number;
  /** Whether this driver created the client and must close it. */
  readonly #ownsClient: boolean;
  /** Active event subscriptions, so `close()` can stop them. */
  readonly #subscriptions = new Set<() => void>();

  /** The client, once connected. */
  #client: MongoClient | undefined;
  /** Resolves once the client is connected and the indexes exist. */
  #ready: Promise<Db> | undefined;

  constructor(options: MongoDriverOptions) {
    this.#url = resolveConnectionUrl(
      options,
      {
        scheme: "mongodb",
        tlsScheme: "mongodb+srv",
        host: "127.0.0.1",
        port: 27017,
      },
      "The MongoDB driver",
    );

    this.database =
      options.database ??
      (typeof options.connection?.database === "string"
        ? options.connection.database
        : undefined) ??
      databaseFromUrl(this.#url) ??
      "bun_jobs";

    this.collections = resolveNames(MONGO_COLLECTIONS, {
      prefix: options.collectionPrefix,
      overrides: options.collections,
      defaultPrefix: "bun_jobs_",
    });

    this.#clientOptions = options.clientOptions;
    this.#poll = options.pollInterval ?? POLL_MS;
    this.#client = options.client;
    this.#ownsClient = !options.client;
  }

  /* --- lifecycle ---------------------------------------------------- */

  async connect(): Promise<void> {
    // One connect per instance, shared by every concurrent caller.
    this.#ready ??= this.#open();
    await this.#ready;
  }

  async close(): Promise<void> {
    for (const stop of this.#subscriptions) {
      stop();
    }
    this.#subscriptions.clear();

    if (this.#ownsClient && this.#client) {
      await this.#client.close();
      this.#client = undefined;
      this.#ready = undefined;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const db = await this.#db();
      await db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async purge(ns: string): Promise<void> {
    const db = await this.#db();

    for (const name of Object.values(this.collections)) {
      await db.collection(name).deleteMany({ ns });
    }
  }

  async listRunners(ns: string): Promise<string[]> {
    const kv = await this.#kv();

    // A runner exists as soon as it has state or a lock, whichever came first.
    const [state, locks] = await Promise.all([
      kv.find({ ns, key: { $regex: "^r:.*:state$" } }).toArray(),
      (await this.#locks()).find({ ns, key: { $regex: "^r:" } }).toArray(),
    ]);

    const ids = new Set<string>();
    for (const document of state) {
      ids.add(document.key.slice(2, -":state".length));
    }
    for (const document of locks) {
      ids.add(document.key.slice(2));
    }

    return [...ids];
  }

  async listQueues(ns: string): Promise<string[]> {
    const [jobs, kv] = await Promise.all([
      (await this.#jobs()).distinct("queue", { ns }),
      (await this.#kv()).find({ ns, key: { $regex: "^q:.*:meta$" } }).toArray(),
    ]);

    const names = new Set<string>(jobs as string[]);
    for (const document of kv) {
      names.add(document.key.slice(2, -":meta".length));
    }

    return [...names];
  }

  /* --- runner: locks -------------------------------------------------- */

  async acquireLock(
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    const locks = await this.#locks();

    try {
      // The filter says "free, lapsed, or already mine". An upsert that
      // matches nothing tries to insert, and the `_id` collision is the
      // server telling us someone else holds it.
      const result = await locks.updateOne(
        {
          _id: `${ns}:${key}`,
          $or: [{ expiresAt: { $lte: now } }, { token }],
        },
        {
          $set: { ns, key, token, expiresAt: now + ttlMs },
        },
        { upsert: true },
      );

      return result.modifiedCount > 0 || result.upsertedCount > 0;
    } catch (error) {
      if (isDuplicateKey(error)) {
        return false;
      }

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
    const locks = await this.#locks();

    const result = await locks.updateOne(
      { _id: `${ns}:${key}`, token, expiresAt: { $gt: now } },
      { $set: { expiresAt: now + ttlMs } },
    );

    return result.matchedCount > 0;
  }

  async releaseLock(ns: string, key: string, token: string): Promise<boolean> {
    const locks = await this.#locks();
    const result = await locks.deleteOne({ _id: `${ns}:${key}`, token });
    return result.deletedCount > 0;
  }

  async getLock(
    ns: string,
    key: string,
    now: number,
  ): Promise<LockInfo | null> {
    const locks = await this.#locks();

    const held = await locks.findOne({
      _id: `${ns}:${key}`,
      expiresAt: { $gt: now },
    });

    return held ? { token: held.token, expiresAt: held.expiresAt } : null;
  }

  /* --- runner: state -------------------------------------------------- */

  async getState(ns: string, key: string): Promise<Record<string, string>> {
    const kv = await this.#kv();
    const document = await kv.findOne({ _id: this.#stateId(ns, key) });

    if (!document) {
      return {};
    }

    // Counters live apart so `$inc` can be used on them; the contract is
    // strings, so they are rendered back as strings here.
    const fields: Record<string, string> = { ...document.fields };
    for (const [field, value] of Object.entries(document.counters ?? {})) {
      fields[field] = String(value);
    }

    return fields;
  }

  async setState(
    ns: string,
    key: string,
    fields: Record<string, string | number | null>,
  ): Promise<void> {
    const set: Record<string, string | number> = { updatedAt: Date.now() };
    const unset: Record<string, ""> = {};

    for (const [field, value] of Object.entries(fields)) {
      if (value === null) {
        // A field may be a string or a counter, and the caller does not care.
        unset[`fields.${field}`] = "";
        unset[`counters.${field}`] = "";
      } else {
        set[`fields.${field}`] = String(value);
      }
    }

    await this.#upsertState(ns, key, {
      $set: set,
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    });
  }

  async incrementCounters(
    ns: string,
    key: string,
    deltas: Record<string, number>,
  ): Promise<Record<string, number>> {
    const increments: Record<string, number> = {};
    for (const [field, delta] of Object.entries(deltas)) {
      increments[`counters.${field}`] = delta;
    }

    const kv = await this.#kv();

    // `$inc` is atomic, so concurrent runners cannot lose a count between a
    // read and a write.
    const updated = await kv.findOneAndUpdate(
      { _id: this.#stateId(ns, key) },
      {
        $inc: increments,
        $set: { ns, key: `${key}:state`, updatedAt: Date.now() },
      },
      { upsert: true, returnDocument: "after" },
    );

    const counters = updated?.counters ?? {};
    const result: Record<string, number> = {};
    for (const field of Object.keys(deltas)) {
      result[field] = counters[field] ?? deltas[field];
    }

    return result;
  }

  async appendHistory(
    ns: string,
    key: string,
    record: RunRecord,
    keep: number,
  ): Promise<void> {
    await this.#upsertState(ns, key, {
      $set: { updatedAt: Date.now() },
      // Newest first, trimmed by the server: no read, no race.
      $push: {
        history: {
          $each: [JSON.stringify(record)],
          $position: 0,
          ...(keep > 0 ? { $slice: keep } : {}),
        },
      },
    } as UpdateFilter<KvDocument>);
  }

  async updateHistory(
    ns: string,
    key: string,
    runId: string,
    patch: Partial<RunRecord>,
  ): Promise<boolean> {
    const kv = await this.#kv();
    const document = await kv.findOne({ _id: this.#stateId(ns, key) });
    const history = document?.history ?? [];

    const index = history.findIndex(
      (entry) => (JSON.parse(entry) as RunRecord).runId === runId,
    );

    if (index === -1) {
      return false;
    }

    const merged = {
      ...(JSON.parse(history[index]) as RunRecord),
      ...jsonClone(patch),
    };

    // Positional, so only the entry that was read is replaced; a concurrent
    // append shifts nothing under it because appends go to position 0 and
    // this update is matched on the entry's own contents.
    const result = await kv.updateOne(
      { _id: this.#stateId(ns, key), history: history[index] },
      { $set: { [`history.$`]: JSON.stringify(merged) } },
    );

    return result.matchedCount > 0;
  }

  async listHistory(
    ns: string,
    key: string,
    limit?: number,
  ): Promise<RunRecord[]> {
    const kv = await this.#kv();
    const document = await kv.findOne({ _id: this.#stateId(ns, key) });
    const history = document?.history ?? [];
    const slice = limit && limit > 0 ? history.slice(0, limit) : history;

    return slice.map((entry) => JSON.parse(entry) as RunRecord);
  }

  async clearHistory(ns: string, key: string): Promise<void> {
    await this.#upsertState(ns, key, {
      $set: { history: [], updatedAt: Date.now() },
    });
  }

  async pushQueuedTrigger(
    ns: string,
    key: string,
    trigger: QueuedTrigger,
    max: number,
  ): Promise<boolean> {
    const kv = await this.#kv();
    const id = this.#stateId(ns, key);

    // The bound is part of the filter, so the length check and the push are
    // one operation: two processes racing cannot both find room.
    const filter: Filter<KvDocument> =
      max > 0
        ? {
            _id: id,
            $expr: { $lt: [{ $size: { $ifNull: ["$queued", []] } }, max] },
          }
        : { _id: id };

    const result = await kv.updateOne(
      filter,
      {
        $set: { ns, key: `${key}:state`, updatedAt: Date.now() },
        $push: { queued: JSON.stringify(trigger) },
      } as UpdateFilter<KvDocument>,
      { upsert: false },
    );

    if (result.matchedCount > 0) {
      return true;
    }

    // Nothing matched: either the document does not exist yet, or it is full.
    const existing = await kv.findOne({ _id: id });
    if (existing) {
      return false;
    }

    try {
      await kv.insertOne({
        _id: id,
        ns,
        key: `${key}:state`,
        queued: [JSON.stringify(trigger)],
        updatedAt: Date.now(),
      });
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) {
        // Someone created it first; try again against the document.
        return await this.pushQueuedTrigger(ns, key, trigger, max);
      }
      throw new DriverError("mongodb", "pushQueuedTrigger", error, { key });
    }
  }

  async popQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    const kv = await this.#kv();

    // `$pop: -1` removes the head atomically, and the document returned is
    // the one *before* the update, so its head is what was taken.
    const previous = await kv.findOneAndUpdate(
      { _id: this.#stateId(ns, key), queued: { $exists: true, $ne: [] } },
      { $pop: { queued: -1 } },
      { returnDocument: "before" },
    );

    const head = previous?.queued?.[0];
    return head ? (JSON.parse(head) as QueuedTrigger) : null;
  }

  async countQueuedTriggers(ns: string, key: string): Promise<number> {
    const kv = await this.#kv();
    const document = await kv.findOne({ _id: this.#stateId(ns, key) });
    return document?.queued?.length ?? 0;
  }

  async clearQueuedTriggers(ns: string, key: string): Promise<number> {
    const kv = await this.#kv();

    const previous = await kv.findOneAndUpdate(
      { _id: this.#stateId(ns, key) },
      { $set: { queued: [], updatedAt: Date.now() } },
      { returnDocument: "before" },
    );

    return previous?.queued?.length ?? 0;
  }

  /* --- queue: jobs ------------------------------------------------------ */

  async ensureQueue(q: QueueRef): Promise<void> {
    const kv = await this.#kv();
    const id = `${q.ns}:q:${q.queue}:meta`;

    try {
      await kv.insertOne({
        _id: id,
        ns: q.ns,
        key: `q:${q.queue}:meta`,
        value: JSON.stringify({ paused: false }),
        updatedAt: Date.now(),
      });
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw new DriverError("mongodb", "ensureQueue", error, {
          queue: q.queue,
        });
      }
    }
  }

  async addJob(
    q: QueueRef,
    job: JobRecord,
  ): Promise<{ job: JobRecord; added: boolean }> {
    const jobs = await this.#jobs();

    try {
      await jobs.insertOne(this.#toDocument(q, job));
      return { job: jsonClone(job), added: true };
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw new DriverError("mongodb", "addJob", error, { id: job.id });
      }

      // The id is the idempotency key, so a collision means it is already here.
      const existing = await this.getJob(q, job.id);
      return { job: existing ?? jsonClone(job), added: false };
    }
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
    if (await this.#pauseCache.read(q, () => this.isQueuePaused(q))) {
      return null;
    }

    // No `promoteDelayed` here: it ran before every claim whether or not
    // anything was delayed. Promotion keeps the reported state honest, it is
    // not what makes a job claimable, and the worker sweeps at 1Hz.

    const jobs = await this.#jobs();

    // One atomic document update: the server picks the document, applies the
    // claim and returns it, so exactly one caller can receive any given job.
    const claimed = await jobs.findOneAndUpdate(
      {
        ns: q.ns,
        queue: q.queue,
        state: "waiting",
        runAt: { $lte: opts.now },
      },
      {
        $set: {
          state: "active",
          processedOn: opts.now,
          lockToken: opts.token,
          lockExpiresAt: opts.now + opts.lockMs,
          workerId: opts.workerId,
        },
        $inc: { attemptsMade: 1 },
      },
      {
        sort: { priority: 1, createdAt: 1, _id: 1 },
        returnDocument: "after",
      },
    );

    return claimed ? this.#toRecord(claimed) : null;
  }

  async extendJobLock(
    q: QueueRef,
    id: string,
    token: string,
    lockMs: number,
    now: number,
  ): Promise<boolean> {
    const jobs = await this.#jobs();

    const result = await jobs.updateOne(
      { _id: this.#jobId(q, id), state: "active", lockToken: token },
      { $set: { lockExpiresAt: now + lockMs } },
    );

    return result.matchedCount > 0;
  }

  async completeJob(
    q: QueueRef,
    id: string,
    token: string,
    result: unknown,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    const jobs = await this.#jobs();

    const expiresAt =
      typeof retention === "object" && retention?.ttl && retention.ttl > 0
        ? now + retention.ttl
        : null;

    const updated = await jobs.updateOne(
      { _id: this.#jobId(q, id), state: "active", lockToken: token },
      {
        $set: {
          state: "completed",
          finishedOn: now,
          returnValue: JSON.stringify(result ?? null),
          expiresAt,
          lockToken: null,
          lockExpiresAt: null,
          workerId: null,
        },
      },
    );

    if (updated.matchedCount === 0) {
      return false;
    }

    await this.#applyRetention(q, id, "completed", retention);
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
    const jobs = await this.#jobs();
    const existing = await jobs.findOne({ _id: this.#jobId(q, id) });

    if (
      !existing ||
      existing.state !== "active" ||
      existing.lockToken !== token
    ) {
      return false;
    }

    const stacktrace = [
      error,
      ...(JSON.parse(existing.stacktrace) as SerializedError[]),
    ].slice(0, Math.max(0, keepStacktraces));

    const retention = outcome.retry ? false : outcome.retention;
    const expiresAt =
      !outcome.retry &&
      typeof retention === "object" &&
      retention?.ttl &&
      retention.ttl > 0
        ? now + retention.ttl
        : null;

    const updated = await jobs.updateOne(
      { _id: this.#jobId(q, id), state: "active", lockToken: token },
      {
        $set: {
          state: outcome.retry ? "failed" : "dead",
          runAt: outcome.retry ? outcome.runAt : existing.runAt,
          finishedOn: outcome.retry ? null : now,
          expiresAt,
          failedReason: JSON.stringify(error),
          stacktrace: JSON.stringify(stacktrace),
          lockToken: null,
          lockExpiresAt: null,
          workerId: null,
        },
      },
    );

    if (updated.matchedCount === 0) {
      return false;
    }

    if (!outcome.retry) {
      await this.#applyRetention(q, id, "dead", outcome.retention);
    }

    return true;
  }

  async updateProgress(
    q: QueueRef,
    id: string,
    progress: unknown,
  ): Promise<boolean> {
    const jobs = await this.#jobs();

    const result = await jobs.updateOne(
      { _id: this.#jobId(q, id) },
      { $set: { progress: JSON.stringify(progress ?? null) } },
    );

    return result.matchedCount > 0;
  }

  async getJob(q: QueueRef, id: string): Promise<JobRecord | null> {
    const jobs = await this.#jobs();
    const document = await jobs.findOne({ _id: this.#jobId(q, id) });
    return document ? this.#toRecord(document) : null;
  }

  async listJobs(
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<JobRecord[]> {
    const jobs = await this.#jobs();
    const direction = opts.order === "asc" ? 1 : -1;

    // A single state is listed in its own natural order; several states share
    // only creation time.
    const sort =
      states.length === 1 && states[0] === "waiting"
        ? { priority: direction, createdAt: direction, _id: direction }
        : { createdAt: direction, _id: direction };

    const documents = await jobs
      .find({ ns: q.ns, queue: q.queue, state: { $in: states } })
      .sort(sort as Record<string, 1 | -1>)
      .skip(opts.offset)
      .limit(opts.limit)
      .toArray();

    return documents.map((document) => this.#toRecord(document));
  }

  async countJobs(q: QueueRef): Promise<Record<JobState, number>> {
    const jobs = await this.#jobs();

    const grouped = await jobs
      .aggregate<{
        _id: JobState;
        total: number;
      }>([
        { $match: { ns: q.ns, queue: q.queue } },
        { $group: { _id: "$state", total: { $sum: 1 } } },
      ])
      .toArray();

    const counts = {
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      dead: 0,
    } satisfies Record<JobState, number>;

    for (const row of grouped) {
      if (row._id in counts) {
        counts[row._id] = row.total;
      }
    }

    return counts;
  }

  async removeJob(q: QueueRef, id: string): Promise<boolean> {
    const jobs = await this.#jobs();

    const result = await jobs.deleteOne({
      _id: this.#jobId(q, id),
      state: { $ne: "active" },
    });

    return result.deletedCount > 0;
  }

  async retryJob(
    q: QueueRef,
    id: string,
    resetAttempts: boolean,
    now: number,
  ): Promise<boolean> {
    const jobs = await this.#jobs();

    const result = await jobs.updateOne(
      {
        _id: this.#jobId(q, id),
        state: { $nin: ["active", "waiting"] },
      },
      {
        $set: {
          state: "waiting",
          runAt: now,
          finishedOn: null,
          expiresAt: null,
          ...(resetAttempts ? { attemptsMade: 0, stalledCount: 0 } : {}),
        },
      },
    );

    return result.matchedCount > 0;
  }

  async promoteJob(q: QueueRef, id: string, now: number): Promise<boolean> {
    const jobs = await this.#jobs();

    const result = await jobs.updateOne(
      { _id: this.#jobId(q, id), state: { $in: SCHEDULED } },
      { $set: { state: "waiting", runAt: now } },
    );

    return result.matchedCount > 0;
  }

  async promoteDelayed(
    q: QueueRef,
    now: number,
    limit: number,
  ): Promise<number> {
    const jobs = await this.#jobs();

    // `updateMany` takes no limit, so the batch is chosen first and then
    // updated by id — still conditional on the state, so a concurrent claim
    // is not undone.
    const due = await jobs
      .find({
        ns: q.ns,
        queue: q.queue,
        state: { $in: SCHEDULED },
        runAt: { $lte: now },
      })
      .sort({ runAt: 1 })
      .limit(Math.max(1, Math.floor(limit)))
      .project<{ _id: string }>({ _id: 1 })
      .toArray();

    if (due.length === 0) {
      return 0;
    }

    const result = await jobs.updateMany(
      {
        _id: { $in: due.map((document) => document._id) },
        state: { $in: SCHEDULED },
      },
      { $set: { state: "waiting" } },
    );

    return result.modifiedCount;
  }

  async recoverStalled(
    q: QueueRef,
    now: number,
    maxStalledCount: number,
    limit: number,
  ): Promise<{ requeued: string[]; dead: string[] }> {
    const jobs = await this.#jobs();

    const stalled = await jobs
      .find({
        ns: q.ns,
        queue: q.queue,
        state: "active",
        lockExpiresAt: { $lte: now },
      })
      .sort({ lockExpiresAt: 1 })
      .limit(Math.max(1, Math.floor(limit)))
      .toArray();

    const requeued: string[] = [];
    const dead: string[] = [];

    for (const document of stalled) {
      const count = document.stalledCount + 1;
      const buried = count > maxStalledCount;

      // Still conditional on being stalled, so a worker that recovered in the
      // meantime is not robbed of its job.
      const result = await jobs.updateOne(
        {
          _id: document._id,
          state: "active",
          lockExpiresAt: { $lte: now },
        },
        {
          $set: {
            state: buried ? "dead" : "waiting",
            stalledCount: count,
            runAt: now,
            finishedOn: buried ? now : null,
            lockToken: null,
            lockExpiresAt: null,
            workerId: null,
          },
        },
      );

      if (result.matchedCount > 0) {
        (buried ? dead : requeued).push(document.id);
      }
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
    const jobs = await this.#jobs();
    const cutoff = now - olderThanMs;

    const stale = await jobs
      .find({
        ns: q.ns,
        queue: q.queue,
        state,
        $or: [
          { finishedOn: { $ne: null, $lte: cutoff } },
          { finishedOn: null, createdAt: { $lte: cutoff } },
        ],
      })
      .limit(Math.max(1, Math.floor(limit)))
      .toArray();

    if (stale.length === 0) {
      return [];
    }

    await jobs.deleteMany({
      _id: { $in: stale.map((document) => document._id) },
    });
    return stale.map((document) => document.id);
  }

  async pruneExpired(q: QueueRef, now: number, limit: number): Promise<number> {
    const jobs = await this.#jobs();

    const expired = await jobs
      .find({
        ns: q.ns,
        queue: q.queue,
        expiresAt: { $ne: null, $lte: now },
      })
      .limit(Math.max(1, Math.floor(limit)))
      .project<{ _id: string }>({ _id: 1 })
      .toArray();

    if (expired.length === 0) {
      return 0;
    }

    const result = await jobs.deleteMany({
      _id: { $in: expired.map((document) => document._id) },
    });

    return result.deletedCount;
  }

  async drainQueue(q: QueueRef, includeDelayed: boolean): Promise<number> {
    const jobs = await this.#jobs();
    const states: JobState[] = includeDelayed
      ? ["waiting", ...SCHEDULED]
      : ["waiting"];

    const result = await jobs.deleteMany({
      ns: q.ns,
      queue: q.queue,
      state: { $in: states },
    });

    return result.deletedCount;
  }

  async pauseQueue(q: QueueRef): Promise<void> {
    await this.#writeValue(q.ns, `q:${q.queue}:meta`, { paused: true });
    this.#pauseCache.write(q, true);
  }

  async resumeQueue(q: QueueRef): Promise<void> {
    await this.#writeValue(q.ns, `q:${q.queue}:meta`, { paused: false });
    this.#pauseCache.write(q, false);
  }

  async isQueuePaused(q: QueueRef): Promise<boolean> {
    const meta = await this.#readValue<{ paused?: boolean }>(
      q.ns,
      `q:${q.queue}:meta`,
    );

    return meta?.paused === true;
  }

  /* --- queue: repeats ---------------------------------------------------- */

  async upsertRepeat(q: QueueRef, def: RepeatRecord): Promise<void> {
    await this.#writeValue(q.ns, `q:${q.queue}:repeat:${def.key}`, def);
  }

  async getRepeat(q: QueueRef, key: string): Promise<RepeatRecord | null> {
    return await this.#readValue<RepeatRecord>(
      q.ns,
      `q:${q.queue}:repeat:${key}`,
    );
  }

  async listRepeats(q: QueueRef): Promise<RepeatRecord[]> {
    const kv = await this.#kv();

    const documents = await kv
      .find({ ns: q.ns, key: { $regex: `^q:${escapeRegex(q.queue)}:repeat:` } })
      .toArray();

    return documents
      .map((document) =>
        document.value ? (JSON.parse(document.value) as RepeatRecord) : null,
      )
      .filter((record): record is RepeatRecord => record !== null);
  }

  async removeRepeat(q: QueueRef, key: string): Promise<boolean> {
    const kv = await this.#kv();

    const result = await kv.deleteOne({
      _id: `${q.ns}:q:${q.queue}:repeat:${key}`,
    });

    return result.deletedCount > 0;
  }

  /* --- queue: waiting and events ------------------------------------------ */

  async nextDelayedAt(q: QueueRef): Promise<number | null> {
    const jobs = await this.#jobs();

    const next = await jobs
      .find({ ns: q.ns, queue: q.queue, state: { $in: SCHEDULED } })
      .sort({ runAt: 1 })
      .limit(1)
      .project<{ runAt: number }>({ runAt: 1 })
      .toArray();

    return next[0]?.runAt ?? null;
  }

  async waitForJob(
    q: QueueRef,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const jobs = await this.#jobs();

    // The gap between polls grows from a millisecond up to the configured
    // interval, rather than being flat. Without a push channel this loop is the
    // only thing that notices a new job, and a flat interval makes a job that
    // arrives just after a poll wait the whole of it — a tail, not an average.
    // Measured on Postgres, that was p99 53ms against a 50ms interval; backing
    // off brought it to 4ms while leaving an idle worker's cost where it was.
    let wait = 1;

    while (Date.now() < deadline && !signal?.aborted) {
      const claimable = await jobs.findOne(
        {
          ns: q.ns,
          queue: q.queue,
          state: "waiting",
          runAt: { $lte: Date.now() },
        },
        { projection: { _id: 1 } },
      );

      // Only a *claimable* job ends the wait; a paused queue has none.
      if (claimable && !(await this.isQueuePaused(q))) {
        return;
      }

      await sleep(Math.min(wait, Math.max(1, deadline - Date.now())), {
        unref: true,
      }).catch(() => {});
      wait = Math.min(this.#poll, wait * 2);
    }
  }

  async publish(event: DriverEvent): Promise<void> {
    const events = await this.#events();

    await events.insertOne({
      ns: event.ns,
      channel: `${event.kind}:${event.target}`,
      payload: JSON.stringify(event),
      at: event.at,
    });
  }

  async subscribe(
    ns: string,
    kind: "queue" | "runner",
    target: string,
    listener: (event: DriverEvent) => void,
  ): Promise<() => Promise<void>> {
    const events = await this.#events();
    const channel = `${kind}:${target}`;

    // Start from the present: a subscriber is told what happens next, not the
    // history it was not there for. ObjectIds increase over time, so they
    // order the log without a counter.
    const latest = await events
      .find({ ns, channel })
      .sort({ _id: -1 })
      .limit(1)
      .toArray();

    let cursor = latest[0]?._id;
    let stopped = false;

    const timer = setInterval(() => {
      void (async () => {
        if (stopped) {
          return;
        }

        const documents = await events
          .find({
            ns,
            channel,
            ...(cursor ? { _id: { $gt: cursor } } : {}),
          })
          .sort({ _id: 1 })
          .limit(200)
          .toArray();

        for (const document of documents) {
          cursor = document._id;
          listener(JSON.parse(document.payload) as DriverEvent);
        }
      })().catch(() => {
        // A failed poll is retried on the next tick.
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

  /* --- internals ------------------------------------------------------------ */

  /** Connects the client and creates the indexes. */
  async #open(): Promise<Db> {
    let MongoClientCtor: typeof MongoClient;

    try {
      // Imported here, not at the top: the package is an optional peer, so a
      // project that never constructs this driver never needs it installed.
      ({ MongoClient: MongoClientCtor } = await import("mongodb"));
    } catch (error) {
      throw new ConfigError(
        'The MongoDB driver needs the "mongodb" package: install it with `bun add mongodb`',
        { cause: String(error) },
      );
    }

    try {
      this.#client ??= new MongoClientCtor(this.#url, this.#clientOptions);
      await this.#client.connect();

      const db = this.#client.db(this.database);
      await this.#createIndexes(db);
      return db;
    } catch (error) {
      // A failed connect must not be remembered as done.
      this.#ready = undefined;
      throw new DriverError("mongodb", "connect", error, {
        database: this.database,
      });
    }
  }

  /** Creates the indexes the hot paths need. Safe to run repeatedly. */
  async #createIndexes(db: Db): Promise<void> {
    const jobs = db.collection<JobDocument>(this.collections.jobs);

    await jobs.createIndexes([
      // Claim order: the queue's due, waiting jobs, cheapest first.
      { key: { ns: 1, queue: 1, state: 1, priority: 1, createdAt: 1 } },
      // Promotion: what is due but not yet claimable.
      { key: { ns: 1, queue: 1, state: 1, runAt: 1 } },
      // Stalled recovery: active jobs whose lock has lapsed.
      { key: { ns: 1, queue: 1, state: 1, lockExpiresAt: 1 } },
      // Cleaning and retention.
      { key: { ns: 1, queue: 1, state: 1, finishedOn: 1 } },
      { key: { expiresAt: 1 } },
    ]);

    await db
      .collection<KvDocument>(this.collections.kv)
      .createIndex({ ns: 1, key: 1 });

    await db
      .collection<EventDocument>(this.collections.events)
      .createIndex({ ns: 1, channel: 1, _id: 1 });
  }

  /** The database, connecting on first use. */
  async #db(): Promise<Db> {
    this.#ready ??= this.#open();
    return await this.#ready;
  }

  /** The jobs collection. */
  async #jobs(): Promise<Collection<JobDocument>> {
    return (await this.#db()).collection<JobDocument>(this.collections.jobs);
  }

  /** The locks collection. */
  async #locks(): Promise<Collection<LockDocument>> {
    return (await this.#db()).collection<LockDocument>(this.collections.locks);
  }

  /** The key/value collection. */
  async #kv(): Promise<Collection<KvDocument>> {
    return (await this.#db()).collection<KvDocument>(this.collections.kv);
  }

  /** The events collection. */
  async #events(): Promise<Collection<EventDocument>> {
    return (await this.#db()).collection<EventDocument>(
      this.collections.events,
    );
  }

  /** The `_id` of a job. Deterministic, which is what makes an add idempotent. */
  #jobId(q: QueueRef, id: string): string {
    return `${q.ns}:${q.queue}:${id}`;
  }

  /** The `_id` of a runner's state document. */
  #stateId(ns: string, key: string): string {
    return `${ns}:${key}:state`;
  }

  /** Applies an update to a runner's state, creating the document if needed. */
  async #upsertState(
    ns: string,
    key: string,
    update: UpdateFilter<KvDocument>,
  ): Promise<void> {
    const kv = await this.#kv();

    await kv.updateOne(
      { _id: this.#stateId(ns, key) },
      {
        ...update,
        $setOnInsert: { ns, key: `${key}:state` },
      } as UpdateFilter<KvDocument>,
      { upsert: true },
    );
  }

  /** Reads a JSON document out of the key/value collection. */
  async #readValue<T>(ns: string, key: string): Promise<T | null> {
    const kv = await this.#kv();
    const document = await kv.findOne({ _id: `${ns}:${key}` });
    return document?.value ? (JSON.parse(document.value) as T) : null;
  }

  /** Writes a JSON document into the key/value collection. */
  async #writeValue(ns: string, key: string, value: unknown): Promise<void> {
    const kv = await this.#kv();

    await kv.updateOne(
      { _id: `${ns}:${key}` },
      {
        $set: { value: JSON.stringify(value), updatedAt: Date.now() },
        $setOnInsert: { ns, key },
      },
      { upsert: true },
    );
  }

  /**
   * A job record as the document that is stored.
   *
   * Payloads become JSON strings because BSON forbids `.` and `$` in field
   * names, and a job's data belongs to the caller: encoding it keeps any key
   * legal and guarantees it returns exactly as every other driver returns it.
   */
  #toDocument(q: QueueRef, job: JobRecord): JobDocument {
    return {
      _id: this.#jobId(q, job.id),
      ns: q.ns,
      queue: q.queue,
      id: job.id,
      name: job.name,
      state: job.state,
      priority: job.priority,
      runAt: job.runAt,
      createdAt: job.createdAt,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      expiresAt: job.expiresAt,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.maxAttempts,
      stalledCount: job.stalledCount,
      workerId: job.workerId,
      lockToken: job.lockToken,
      lockExpiresAt: job.lockExpiresAt,
      repeatKey: job.repeatKey,
      data: JSON.stringify(job.data ?? null),
      opts: JSON.stringify(job.opts),
      progress: JSON.stringify(job.progress ?? null),
      returnValue: JSON.stringify(job.returnValue ?? null),
      failedReason: JSON.stringify(job.failedReason ?? null),
      stacktrace: JSON.stringify(job.stacktrace ?? []),
    };
  }

  /** A stored document as a job record. */
  #toRecord(document: JobDocument): JobRecord {
    return {
      id: document.id,
      name: document.name,
      data: JSON.parse(document.data) as unknown,
      opts: JSON.parse(document.opts) as ResolvedJobOptions,
      state: document.state,
      priority: document.priority,
      runAt: document.runAt,
      createdAt: document.createdAt,
      processedOn: document.processedOn,
      finishedOn: document.finishedOn,
      expiresAt: document.expiresAt,
      attemptsMade: document.attemptsMade,
      maxAttempts: document.maxAttempts,
      stalledCount: document.stalledCount,
      progress: JSON.parse(document.progress) as unknown,
      returnValue: JSON.parse(document.returnValue) as unknown,
      failedReason: JSON.parse(document.failedReason) as SerializedError | null,
      stacktrace: JSON.parse(document.stacktrace) as SerializedError[],
      lockToken: document.lockToken,
      lockExpiresAt: document.lockExpiresAt,
      workerId: document.workerId,
      repeatKey: document.repeatKey,
    };
  }

  /** Removes a finished job now, or caps how many of its state are kept. */
  async #applyRetention(
    q: QueueRef,
    id: string,
    state: JobState,
    retention: Retention,
  ): Promise<void> {
    if (retention === true) {
      const jobs = await this.#jobs();
      await jobs.deleteOne({ _id: this.#jobId(q, id) });
      return;
    }

    const count =
      typeof retention === "number"
        ? retention
        : retention && typeof retention === "object"
          ? retention.count
          : undefined;

    if (count === undefined || count < 0) {
      return;
    }

    const jobs = await this.#jobs();

    const stale = await jobs
      .find({ ns: q.ns, queue: q.queue, state })
      .sort({ finishedOn: -1, createdAt: -1 })
      .skip(Math.max(0, Math.floor(count)))
      .limit(1000)
      .project<{ _id: string }>({ _id: 1 })
      .toArray();

    if (stale.length > 0) {
      await jobs.deleteMany({
        _id: { $in: stale.map((document) => document._id) },
      });
    }
  }
}

/** Whether an error is MongoDB's "this key already exists". */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === DUPLICATE_KEY
  );
}

/** Escapes a value for use inside a regular expression. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
