import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  Collection,
  Db,
  Filter,
  MongoClient,
  MongoClientOptions,
  ObjectId,
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
  EventKind,
  EventOfKind,
  FailOutcome,
  JobPatch,
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
import type { SchemaChange, SchemaSyncOptions } from "../schemaSync";
import { jsonClone, sleep } from "@kingsleyweb/bun-common";
import {
  databaseFromUrl,
  resolveConnectionUrl,
  resolveNames,
} from "../../shared/connection";
import { ConfigError, DriverError } from "../../shared/errors";
import { EventRetention } from "../../shared/eventRetention";
import { PauseCache } from "../../shared/pauseCache";
import { resolveSyncOptions } from "../schemaSync";

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

/**
 * The collections this driver uses.
 *
 * Job logs have a collection of their own rather than an array on the job:
 * a claim returns the whole document, so lines kept on it would ride along on
 * every claim of a job that logs, and grow the document the claim index
 * points at.
 */
export const MONGO_COLLECTIONS = [
  "jobs",
  "locks",
  "kv",
  "events",
  "jobLogs",
] as const;

/** One of the collections this driver uses. */
export type MongoCollection = (typeof MONGO_COLLECTIONS)[number];

/** MongoDB's duplicate-key error, which is how "someone got there first" arrives. */
/**
 * Indexes earlier versions of this driver created on the jobs collection.
 *
 * Named explicitly rather than inferred. MongoDB names an index after its key
 * pattern, so an index this driver no longer defines is indistinguishable from
 * one somebody added by hand — dropping "anything we do not recognise" would
 * eventually delete a user's index. A list of what *we* retired cannot.
 *
 * `ns_1_queue_1_state_1_priority_1_createdAt_1` is the claim index from before
 * `_id` joined the key. Without `_id` the index does not cover the claim's
 * sort, so MongoDB fell back to a blocking in-memory sort of every matching
 * document: measured on a 2,000-job queue, 2,000 documents examined to return
 * one, at 2.75ms per claim and growing with the backlog.
 */
const RETIRED_INDEXES = [
  "ns_1_queue_1_state_1_priority_1_createdAt_1",
] as const;

const DUPLICATE_KEY = 11000;

/**
 * How many times a push may lose the race to create the state document.
 *
 * It can only lose to a creation, and a document is created once — so one
 * retry is the reasoning, and this is the margin on it.
 */
const CREATE_RETRIES = 3;

/**
 * How many jobs go into one `insertMany`.
 *
 * The server caps a batch at 100,000 documents and 16MB, and the driver splits
 * anything larger on its own, so this is not the server's limit — it bounds how
 * many documents are built in memory at once, and how much one rejected batch
 * has to be reported on.
 */
const INSERT_CHUNK = 1_000;

/** States holding a job that is due later. */
const SCHEDULED: JobState[] = ["delayed", "failed"];

/** The states whose due time `updateJob` may move. */
const PENDING: JobState[] = ["waiting", "delayed"];

/**
 * How many times a priority change may lose the race to rewrite `opts`.
 *
 * It can only lose to another priority change landing between its read and
 * its write, so one retry is the reasoning, and this is the margin on it.
 */
const PATCH_RETRIES = 3;

/**
 * How many log lines one orphan sweep reads, per job the maintenance batch
 * allows.
 *
 * The sweep walks lines rather than jobs because that is what the index can
 * bound; a job's lines are adjacent in it, so this is roughly how many lines a
 * logging job is assumed to keep before a sweep spans fewer jobs than asked.
 */
const LOG_SWEEP_LINES_PER_JOB = 10;

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
  /**
   * Reconcile the collections' indexes with this version's, on connect.
   *
   * Off by default. `createIndex` is idempotent and connecting already creates
   * what is missing, so what this adds is the retirement of indexes earlier
   * versions created — see {@link RETIRED_INDEXES}.
   */
  syncSchema?: boolean | SchemaSyncOptions;
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
  /** When the current or last attempt started. Absent on a job yet to run. */
  processedOn?: number | null;
  /** When it completed or died. Absent until it has. */
  finishedOn?: number | null;
  /** When retention removes it. Absent while it has no expiry. */
  expiresAt?: number | null;
  /** How many attempts have been made. Absent means none. */
  attemptsMade?: number;
  /** How many are allowed. */
  maxAttempts: number;
  /** How many times it stalled. Absent means never. */
  stalledCount?: number;
  /** The worker holding it. Absent while unclaimed. */
  workerId?: string | null;
  /** That worker's lock token. Absent while unclaimed. */
  lockToken?: string | null;
  /** When the lock expires. Absent while unclaimed. */
  lockExpiresAt?: number | null;
  /** The repeat series that produced it. Absent when it is a one-off. */
  repeatKey?: string | null;
  /** The caller's payload, as JSON. */
  data: string;
  /** Resolved options, as JSON. */
  opts: string;
  /** Latest progress, as JSON. Absent until reported. */
  progress?: string;
  /** The processor's result, as JSON. Absent until it has one. */
  returnValue?: string;
  /** The most recent failure, as JSON. Absent until it has one. */
  failedReason?: string;
  /** Recent failures, as JSON. Absent until it has one. */
  stacktrace?: string;
  /**
   * Names this job's log lines. Absent until the job logs its first line, so
   * adding, claiming and settling a job never write it — and never read back
   * through `#toRecord`, which is not part of the record.
   *
   * A random token rather than anything derived from the job: a job completed
   * and re-added under its id in the same millisecond is identical in every
   * field that could be derived, and has to start with an empty log anyway.
   */
  logKey?: string;
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

/** One line of a job's log, as it is stored. */
interface JobLogDocument {
  /** Assigned by the server; not used for ordering. */
  _id?: ObjectId;
  /** The namespace the job belongs to. */
  ns: string;
  /** The queue it belongs to. */
  queue: string;
  /** The job's id within that queue. Used only by the orphan sweep. */
  jobId: string;
  /**
   * The owning job's `logKey`.
   *
   * What ties a line to one *incarnation* of an id. Completing with retention
   * `true` deletes the job in one operation and leaves its lines behind — a
   * second delete there would tax the hottest path for a feature most jobs
   * never use. Reads and trims match on this, so a job added later under the
   * same id, which gets a key of its own, sees none of those lines, and a sweep
   * removes them eventually.
   */
  logKey: string;
  /** Orders lines within a job; see `MongoDriver.#nextLogSeq`. */
  seq: number;
  /** The line, verbatim. */
  line: string;
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
  /** Decides when this driver should prune its stored events. */
  readonly #eventRetention: EventRetention;

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
  /** What to reconcile on connect, if anything. */
  readonly #syncOnConnect: boolean | SchemaSyncOptions;
  /** Whether this driver created the client and must close it. */
  readonly #ownsClient: boolean;
  /** Active event subscriptions, so `close()` can stop them. */
  readonly #subscriptions = new Set<() => void>();
  /**
   * Where each queue's orphaned-log sweep resumes: the last job id it read,
   * keyed by `<ns>:<queue>`. Absent means start from the beginning. Per
   * instance, which is all a rotation needs — several workers sweeping from
   * different points only covers the log sooner.
   */
  readonly #logSweepFrom = new Map<string, string>();

  /** The last log sequence number this instance handed out. */
  #lastLogSeq = 0;

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
    this.#syncOnConnect = options.syncSchema ?? false;
    this.#eventRetention = new EventRetention(options.eventRetentionMs);
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
    attemptsLeft = CREATE_RETRIES,
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
        // Someone created it first, so the atomic path applies now. Bounded,
        // because this recursed without a limit: each retry can only lose to
        // a *creation*, and the document is created once — but "can only" is
        // reasoning, and an unbounded recursion driven by a remote server's
        // errors is a hang or a blown stack if that reasoning is ever wrong.
        if (attemptsLeft <= 0) {
          throw new DriverError("mongodb", "pushQueuedTrigger", error, {
            key,
            reason: "the state document kept being created underneath this",
          });
        }

        return await this.pushQueuedTrigger(
          ns,
          key,
          trigger,
          max,
          attemptsLeft - 1,
        );
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

  /**
   * Adds many jobs, in as few round trips as the collection allows.
   *
   * `insertMany` is unordered, which is what makes it usable here: an ordered
   * batch stops at the first duplicate and leaves the rest of the chunk
   * unwritten, whereas an unordered one inserts everything it can and reports
   * the collisions by position. That is exactly the contract this method needs,
   * because per-id idempotency means a duplicate is an ordinary outcome rather
   * than a failure — repeat scheduling depends on several workers noticing the
   * same occurrence and exactly one of them winning.
   *
   * A collision is the only write error tolerated. Anything else fails the
   * call, because it means the batch did not do what it said.
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

    const collection = await this.#jobs();
    const results: { job: JobRecord; added: boolean }[] = [];

    for (let start = 0; start < jobs.length; start += INSERT_CHUNK) {
      const chunk = jobs.slice(start, start + INSERT_CHUNK);
      /** Positions within this chunk whose id was already taken. */
      const collided = new Set<number>();

      try {
        await collection.insertMany(
          chunk.map((job) => this.#toDocument(q, job)),
          { ordered: false },
        );
      } catch (error) {
        const writeErrors = duplicateKeyPositions(error);

        if (!writeErrors) {
          throw new DriverError("mongodb", "addJobs", error);
        }

        for (const position of writeErrors) {
          collided.add(position);
        }
      }

      for (const [index, job] of chunk.entries()) {
        if (!collided.has(index)) {
          results.push({ job: jsonClone(job), added: true });
          continue;
        }

        // The id is the idempotency key, so a collision means it is already
        // here. Only a collision pays for the read that fetches what is.
        const existing = await this.getJob(q, job.id);
        results.push({ job: existing ?? jsonClone(job), added: false });
      }
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
      ...parseOrDefault<SerializedError[]>(existing.stacktrace, []),
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

  async updateJob(
    q: QueueRef,
    id: string,
    patch: JobPatch,
    now: number,
  ): Promise<JobRecord | null> {
    // Which states may be changed. The state a moved job lands in depends only
    // on the new time and `now`, both known here, so the whole rule becomes
    // part of the filter — and the check and the write are one operation.
    const allowed =
      patch.runAt === undefined
        ? patch.onlyIn
        : (patch.onlyIn ?? PENDING).filter((state) => PENDING.includes(state));

    if (allowed?.length === 0) {
      return null;
    }

    const filter: Filter<JobDocument> = {
      _id: this.#jobId(q, id),
      ...(allowed ? { state: { $in: allowed } } : {}),
    };

    // Written in the encoding `#toDocument` uses, so a patched job reads back
    // exactly as an added one does.
    const set: Partial<JobDocument> = {};

    if (patch.data !== undefined) {
      set.data = JSON.stringify(patch.data);
    }

    if (patch.runAt !== undefined) {
      set.runAt = patch.runAt;
      set.state = patch.runAt > now ? "delayed" : "waiting";
    }

    const jobs = await this.#jobs();

    if (patch.priority === undefined) {
      if (Object.keys(set).length === 0) {
        const found = await jobs.findOne(filter);
        return found ? this.#toRecord(found) : null;
      }

      const updated = await jobs.findOneAndUpdate(
        filter,
        { $set: set },
        { returnDocument: "after" },
      );

      return updated ? this.#toRecord(updated) : null;
    }

    // Priority lives twice: the plain field the claim index sorts on, which is
    // all reordering needs, and inside `opts`, which is a JSON string the
    // server cannot edit in place. The two may legitimately differ on a stored
    // record, so the reader cannot simply trust one — `opts` has to be
    // rewritten, and the read it is built from is pinned in the write's filter
    // so a concurrent change to it is retried rather than overwritten.
    for (let attempt = 0; attempt <= PATCH_RETRIES; attempt++) {
      const current = await jobs.findOne(filter, { projection: { opts: 1 } });

      if (!current) {
        return null;
      }

      const opts = JSON.parse(current.opts) as ResolvedJobOptions;

      const updated = await jobs.findOneAndUpdate(
        { ...filter, opts: current.opts },
        {
          $set: {
            ...set,
            priority: patch.priority,
            opts: JSON.stringify({ ...opts, priority: patch.priority }),
          },
        },
        { returnDocument: "after" },
      );

      if (updated) {
        return this.#toRecord(updated);
      }
    }

    throw new DriverError("mongodb", "updateJob", undefined, {
      id,
      reason: "the job's options kept changing underneath this",
    });
  }

  async addJobLog(
    q: QueueRef,
    id: string,
    line: string,
    keep: number,
  ): Promise<number> {
    const logKey = await this.#stampLogKey(q, id);

    if (logKey === null) {
      return 0;
    }

    const logs = await this.#jobLogs();
    const owner = { ns: q.ns, queue: q.queue, logKey };

    // A job removed between the stamp above and this insert leaves one
    // orphaned line. No job holds its key, so no later job under the id can
    // see it, and the sweep collects it.
    await logs.insertOne({
      ...owner,
      jobId: id,
      seq: this.#nextLogSeq(),
      line,
    });

    const count = await logs.countDocuments(owner);

    if (keep <= 0 || count <= keep) {
      return count;
    }

    const oldest = await logs
      .find(owner)
      .sort({ seq: 1 })
      .limit(count - keep)
      .project<{ _id: ObjectId }>({ _id: 1 })
      .toArray();

    const removed = await logs.deleteMany({
      _id: { $in: oldest.map((document) => document._id) },
    });

    return count - removed.deletedCount;
  }

  async getJobLogs(
    q: QueueRef,
    id: string,
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<{ logs: string[]; count: number }> {
    const jobs = await this.#jobs();
    const job = await jobs.findOne(
      { _id: this.#jobId(q, id) },
      { projection: { logKey: 1 } },
    );

    // No key means the job has never logged: nothing to look for.
    if (!job?.logKey) {
      return { logs: [], count: 0 };
    }

    const logs = await this.#jobLogs();
    const owner = { ns: q.ns, queue: q.queue, logKey: job.logKey };

    const [count, page] = await Promise.all([
      logs.countDocuments(owner),
      // A limit of 0 means "no limit" to MongoDB, and "nothing" to the caller.
      opts.limit > 0
        ? logs
            .find(owner)
            .sort({ seq: opts.order === "asc" ? 1 : -1 })
            .skip(Math.max(0, opts.offset))
            .limit(opts.limit)
            .project<{ line: string }>({ _id: 0, line: 1 })
            .toArray()
        : Promise.resolve([]),
    ]);

    return { logs: page.map((document) => document.line), count };
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

    // `findOneAndDelete` rather than `deleteOne`: still one operation, and it
    // hands back the `logKey` that says which lines were this job's.
    const removed = await jobs.findOneAndDelete(
      { _id: this.#jobId(q, id), state: { $ne: "active" } },
      { projection: { logKey: 1 } },
    );

    if (!removed) {
      return false;
    }

    await this.#deleteLogs(q, [removed]);
    return true;
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
      const count = (document.stalledCount ?? 0) + 1;
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
    await this.#deleteLogs(q, stale);

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
      .project<{ _id: string; logKey?: string }>({ _id: 1, logKey: 1 })
      .toArray();

    let deleted = 0;

    if (expired.length > 0) {
      const result = await jobs.deleteMany({
        _id: { $in: expired.map((document) => document._id) },
      });
      await this.#deleteLogs(q, expired);
      deleted = result.deletedCount;
    }

    // The worker calls this once a minute whether or not anything expired,
    // which makes it the place to collect what the paths that delete without
    // a second operation — retention on completion, a drain — left behind.
    await this.#sweepLogs(q, limit);

    return deleted;
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

    // A drain deletes without knowing which jobs it deleted, so their lines
    // cannot be named. A drain is an operator's action rather than a hot path,
    // so it pays for one bounded sweep; anything past the bound goes later.
    if (result.deletedCount > 0) {
      await this.#sweepLogs(q, result.deletedCount);
    }

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
    this.#pruneEvents(event.ns);
    const events = await this.#events();

    await events.insertOne({
      ns: event.ns,
      channel: `${event.kind}:${event.target}`,
      payload: JSON.stringify(event),
      at: event.at,
    });
  }

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
    const events = await this.#events();
    const removed = await events.deleteMany({ ns, at: { $lt: before } });

    return removed.deletedCount ?? 0;
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
          deliver(JSON.parse(document.payload) as DriverEvent);
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

      if (this.#syncOnConnect !== false) {
        await this.#syncSchema(
          db,
          typeof this.#syncOnConnect === "object" ? this.#syncOnConnect : {},
        );
      }

      return db;
    } catch (error) {
      // A failed connect must not be remembered as done.
      this.#ready = undefined;
      throw new DriverError("mongodb", "connect", error, {
        database: this.database,
      });
    }
  }

  /**
   * The indexes the hot paths need, as data.
   *
   * Described rather than created inline so {@link MongoDriver.syncSchema} can
   * compare them against what the database has, instead of the two having
   * separate ideas of what the indexes are.
   */
  #indexDefinitions(): { collection: string; key: Record<string, 1 | -1> }[] {
    return [
      // Claim order: the queue's due, waiting jobs, cheapest first.
      //
      // `_id` is in the key because it is in the claim's sort. Without it
      // MongoDB cannot walk the index in sort order and falls back to a
      // blocking in-memory sort of *every* matching document — measured on a
      // 2,000-job queue, 2,000 documents examined to return one, and 2.75ms
      // per claim that grew with the backlog.
      {
        collection: this.collections.jobs,
        key: { ns: 1, queue: 1, state: 1, priority: 1, createdAt: 1, _id: 1 },
      },
      // Promotion: what is due but not yet claimable.
      {
        collection: this.collections.jobs,
        key: { ns: 1, queue: 1, state: 1, runAt: 1 },
      },
      // Stalled recovery: active jobs whose lock has lapsed.
      {
        collection: this.collections.jobs,
        key: { ns: 1, queue: 1, state: 1, lockExpiresAt: 1 },
      },
      // Cleaning and retention.
      {
        collection: this.collections.jobs,
        key: { ns: 1, queue: 1, state: 1, finishedOn: 1 },
      },
      { collection: this.collections.jobs, key: { expiresAt: 1 } },
      { collection: this.collections.kv, key: { ns: 1, key: 1 } },
      {
        collection: this.collections.events,
        key: { ns: 1, channel: 1, _id: 1 },
      },
      // A job's log: counted, paged and trimmed by its key, in `seq` order.
      {
        collection: this.collections.jobLogs,
        key: { ns: 1, queue: 1, logKey: 1, seq: 1 },
      },
      // The orphan sweep walks a queue's lines by job id. `logKey` is in the
      // key so that walk is answered from the index alone, without fetching a
      // single line.
      {
        collection: this.collections.jobLogs,
        key: { ns: 1, queue: 1, jobId: 1, logKey: 1 },
      },
    ];
  }

  /**
   * Reconciles the database with the indexes this version of the driver
   * expects, and reports every difference it found.
   *
   * MongoDB has no column types, so there is nothing here that can rewrite a
   * collection and nothing `alterColumns` could mean — every change a sync can
   * make on this backend is safe by construction. `createIndex` is idempotent,
   * which is why connecting already does most of this; the value of calling it
   * explicitly is the report, and `dryRun` in particular.
   *
   * Indexes are dropped only when they are on {@link RETIRED_INDEXES}. See
   * there for why a broader rule would eventually delete somebody's index.
   */
  async syncSchema(options: SchemaSyncOptions = {}): Promise<SchemaChange[]> {
    return await this.#syncSchema(await this.#db(), options);
  }

  /**
   * The sync itself, given a database rather than fetching one.
   *
   * Separate from the public method because opening the connection calls it,
   * and `#db()` awaits that same open: reaching for the database from in here
   * would wait on the promise it is running inside.
   */
  async #syncSchema(
    db: Db,
    options: SchemaSyncOptions,
  ): Promise<SchemaChange[]> {
    const resolved = resolveSyncOptions(options);
    const changes: SchemaChange[] = [];

    /** The index names each collection already has. */
    const existing = new Map<string, Set<string>>();

    for (const { collection } of this.#indexDefinitions()) {
      if (existing.has(collection)) {
        continue;
      }

      const names = await db
        .collection(collection)
        .indexes()
        .then((found) => new Set(found.map((index) => String(index.name))))
        .catch(() => new Set<string>());

      existing.set(collection, names);
    }

    for (const { collection, key } of this.#indexDefinitions()) {
      // MongoDB's own naming, which is what `indexes()` reports back.
      const name = Object.entries(key)
        .map(([field, direction]) => `${field}_${direction}`)
        .join("_");

      if (existing.get(collection)?.has(name)) {
        continue;
      }

      changes.push({
        kind: "create-index",
        table: collection,
        target: name,
        statement: `createIndex(${JSON.stringify(key)})`,
        reason: "the driver defines it and the collection does not have it",
        blocking: false,
        applied: false,
      });
    }

    for (const name of RETIRED_INDEXES) {
      if (!existing.get(this.collections.jobs)?.has(name)) {
        continue;
      }

      changes.push({
        kind: "drop-index",
        table: this.collections.jobs,
        target: name,
        statement: `dropIndex(${JSON.stringify(name)})`,
        reason:
          "the driver no longer defines it, and it costs a write per document",
        blocking: false,
        applied: false,
      });
    }

    if (resolved.dryRun) {
      return changes;
    }

    for (const change of changes) {
      if (
        change.kind === "create-index" &&
        !(resolved.add || resolved.indexes)
      ) {
        continue;
      }

      if (change.kind === "drop-index" && !resolved.indexes) {
        continue;
      }

      if (change.kind === "create-index") {
        const definition = this.#indexDefinitions().find(
          (index) =>
            index.collection === change.table &&
            Object.entries(index.key)
              .map(([field, direction]) => `${field}_${direction}`)
              .join("_") === change.target,
        );

        if (definition) {
          await db.collection(change.table).createIndex(definition.key);
          change.applied = true;
        }

        continue;
      }

      await db
        .collection(change.table)
        .dropIndex(change.target)
        .catch(() => undefined);
      change.applied = true;
    }

    return changes;
  }

  /** Creates the indexes the hot paths need. Safe to run repeatedly. */
  async #createIndexes(db: Db): Promise<void> {
    const byCollection = new Map<string, Record<string, 1 | -1>[]>();

    for (const { collection, key } of this.#indexDefinitions()) {
      byCollection.set(collection, [
        ...(byCollection.get(collection) ?? []),
        key,
      ]);
    }

    for (const [collection, keys] of byCollection) {
      await db
        .collection(collection)
        .createIndexes(keys.map((key) => ({ key })));
    }

    for (const name of RETIRED_INDEXES) {
      // Best-effort: absent on a fresh database, and may already be gone.
      await db
        .collection(this.collections.jobs)
        .dropIndex(name)
        .catch(() => undefined);
    }
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

  /** The job-logs collection. */
  async #jobLogs(): Promise<Collection<JobLogDocument>> {
    return (await this.#db()).collection<JobLogDocument>(
      this.collections.jobLogs,
    );
  }

  /**
   * A job's log key, giving it one if it has none yet; `null` when there is
   * no such job.
   *
   * Read first, stamp only when absent. Once a job has logged, every further
   * line costs one read of its document and no write to it — which matters
   * because a job that logs is usually active, and its worker is writing that
   * same document. A pipeline update with `$ifNull` would also be one round
   * trip, but a write on every line. The stamp's filter requires the key to be
   * absent, so two first lines racing agree on whichever key landed.
   */
  async #stampLogKey(q: QueueRef, id: string): Promise<string | null> {
    const jobs = await this.#jobs();
    const _id = this.#jobId(q, id);

    const existing = await jobs.findOne({ _id }, { projection: { logKey: 1 } });

    if (!existing) {
      return null;
    }

    if (existing.logKey) {
      return existing.logKey;
    }

    const stamped = await jobs.findOneAndUpdate(
      { _id, logKey: { $exists: false } },
      { $set: { logKey: crypto.randomUUID() } },
      { projection: { logKey: 1 }, returnDocument: "after" },
    );

    if (stamped?.logKey) {
      return stamped.logKey;
    }

    // Lost the race to another first line, or the job has just gone.
    const raced = await jobs.findOne({ _id }, { projection: { logKey: 1 } });
    return raced?.logKey ?? null;
  }

  /**
   * The next log sequence number: strictly increasing within this instance,
   * and close to wall-clock order across instances.
   *
   * Not the `ObjectId`, which looks ordered and is not quite: its low bytes
   * are a counter that starts at a random value and wraps, and the bytes above
   * it are random per process, so two lines in one second can sort either way.
   * Not `Date.now()` alone, which repeats within a millisecond. Milliseconds
   * times 1024 leave room for 1024 lines a millisecond before the `+ 1` takes
   * over, and stay exact in a double until the 23rd century.
   */
  #nextLogSeq(): number {
    this.#lastLogSeq = Math.max(Date.now() * 1024, this.#lastLogSeq + 1);
    return this.#lastLogSeq;
  }

  /**
   * Deletes the lines of jobs that are gone. A job that never logged has no
   * key, and costs nothing here.
   */
  async #deleteLogs(q: QueueRef, owners: { logKey?: string }[]): Promise<void> {
    const keys = owners
      .map((owner) => owner.logKey)
      .filter((key): key is string => typeof key === "string");

    if (keys.length === 0) {
      return;
    }

    const logs = await this.#jobLogs();

    for (let start = 0; start < keys.length; start += INSERT_CHUNK) {
      await logs.deleteMany({
        ns: q.ns,
        queue: q.queue,
        logKey: { $in: keys.slice(start, start + INSERT_CHUNK) },
      });
    }
  }

  /**
   * Deletes a bounded slice of a queue's orphaned log lines: those whose job
   * is gone, or has since been replaced by a job with the same id.
   *
   * Rotates through the queue by job id, resuming where the last sweep
   * stopped, so every call costs the same three bounded operations however
   * large the log is — a covered index read of the lines, one read of their
   * jobs, one delete — and repeated calls cover all of it.
   */
  async #sweepLogs(q: QueueRef, limit: number): Promise<void> {
    const logs = await this.#jobLogs();
    const key = `${q.ns}:${q.queue}`;
    const after = this.#logSweepFrom.get(key);
    const lines = Math.max(1, Math.floor(limit)) * LOG_SWEEP_LINES_PER_JOB;

    const scanned = await logs
      .find({
        ns: q.ns,
        queue: q.queue,
        ...(after === undefined ? {} : { jobId: { $gt: after } }),
      })
      .sort({ jobId: 1, logKey: 1 })
      .limit(lines)
      .project<{ jobId: string; logKey: string }>({
        _id: 0,
        jobId: 1,
        logKey: 1,
      })
      .toArray();

    // A short read reached the end, so the next sweep starts over. A full one
    // resumes after the last job it saw — skipping that job's remaining lines,
    // whose incarnation was judged here already.
    if (scanned.length < lines) {
      this.#logSweepFrom.delete(key);
    } else {
      this.#logSweepFrom.set(key, scanned.at(-1)!.jobId);
    }

    if (scanned.length === 0) {
      return;
    }

    const jobs = await this.#jobs();
    const live = await jobs
      .find({
        _id: {
          $in: [...new Set(scanned.map((line) => line.jobId))].map((id) =>
            this.#jobId(q, id),
          ),
        },
      })
      .project<{ logKey?: string }>({ _id: 0, logKey: 1 })
      .toArray();

    // A line is an orphan when no job holds its key: its job is gone, or was
    // replaced by one under the same id, which got a key of its own.
    const held = new Set(live.map((job) => job.logKey));

    await this.#deleteLogs(
      q,
      [...new Set(scanned.map((line) => line.logKey))]
        .filter((logKey) => !held.has(logKey))
        .map((logKey) => ({ logKey })),
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
    const document: JobDocument = {
      _id: this.#jobId(q, job.id),
      ns: q.ns,
      queue: q.queue,
      id: job.id,
      name: job.name,
      state: job.state,
      priority: job.priority,
      runAt: job.runAt,
      createdAt: job.createdAt,
      maxAttempts: job.maxAttempts,
      data: JSON.stringify(job.data ?? null),
      opts: JSON.stringify(job.opts),
    };

    // A brand-new job carries nothing else: every remaining field would be a
    // null, a zero, or the string "null". Leaving them out makes the document
    // smaller on the wire and in the collection, and the reader already treats
    // absent and default alike. `maxAttempts` stays above deliberately — an
    // absent number reads back as its default, and the default for that one is
    // not zero.
    if (this.#isFreshJob(job)) {
      return document;
    }

    document.processedOn = job.processedOn;
    document.finishedOn = job.finishedOn;
    document.expiresAt = job.expiresAt;
    document.attemptsMade = job.attemptsMade;
    document.stalledCount = job.stalledCount;
    document.workerId = job.workerId;
    document.lockToken = job.lockToken;
    document.lockExpiresAt = job.lockExpiresAt;
    document.repeatKey = job.repeatKey;
    document.progress = JSON.stringify(job.progress ?? null);
    document.returnValue = JSON.stringify(job.returnValue ?? null);
    document.failedReason = JSON.stringify(job.failedReason ?? null);
    document.stacktrace = JSON.stringify(job.stacktrace ?? []);

    return document;
  }

  /**
   * Whether a record carries nothing beyond what a brand-new job carries.
   *
   * A job in any other shape — restored from elsewhere, added already
   * finished, mid-retry — has to write every field, because the ones it would
   * otherwise skip are exactly the ones holding its state.
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
      // Absent and default are the same thing: a brand-new job writes none of
      // these, and a document stored before that was true writes all of them.
      // Both have to read back identically.
      processedOn: document.processedOn ?? null,
      finishedOn: document.finishedOn ?? null,
      expiresAt: document.expiresAt ?? null,
      attemptsMade: document.attemptsMade ?? 0,
      maxAttempts: document.maxAttempts,
      stalledCount: document.stalledCount ?? 0,
      progress: parseOrDefault<unknown>(document.progress, null),
      returnValue: parseOrDefault<unknown>(document.returnValue, null),
      failedReason: parseOrDefault<SerializedError | null>(
        document.failedReason,
        null,
      ),
      stacktrace: parseOrDefault<SerializedError[]>(document.stacktrace, []),
      lockToken: document.lockToken ?? null,
      lockExpiresAt: document.lockExpiresAt ?? null,
      workerId: document.workerId ?? null,
      repeatKey: document.repeatKey ?? null,
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

/**
 * The positions in an unordered batch that failed because the id was taken.
 *
 * Returns `null` when the error is not a batch write failure, or when any of
 * its write errors is something other than a collision — in both cases the
 * caller has no business carrying on, so the distinction is "all of these are
 * duplicates" rather than "some of them are".
 */
function duplicateKeyPositions(error: unknown): number[] | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const writeErrors = (error as { writeErrors?: unknown }).writeErrors;

  if (!Array.isArray(writeErrors) || writeErrors.length === 0) {
    return null;
  }

  const positions: number[] = [];

  for (const writeError of writeErrors as { index?: number; code?: number }[]) {
    if (
      writeError.code !== DUPLICATE_KEY ||
      typeof writeError.index !== "number"
    ) {
      return null;
    }

    positions.push(writeError.index);
  }

  return positions;
}

/** A JSON field that a brand-new job does not write, and its default. */
function parseOrDefault<T>(value: string | undefined, fallback: T): T {
  return value === undefined ? fallback : (JSON.parse(value) as T);
}

/** Escapes a value for use inside a regular expression. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
