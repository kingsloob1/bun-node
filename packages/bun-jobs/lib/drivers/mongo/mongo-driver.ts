import type { SerializedError } from "@kingsleyweb/bun-common";
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
import type { PendingThroughput, ThroughputWriteResult } from "../readApis";
import type { SchemaChange, SchemaSyncOptions } from "../schemaSync";
import { jsonClone, sleep } from "@kingsleyweb/bun-common";
import { assertWritableStateName } from "../../queue/windows";
import {
  databaseFromUrl,
  resolveConnectionUrl,
  resolveNames,
} from "../../shared/connection";
import { ConfigError, DriverError } from "../../shared/errors";
import { EventRetention } from "../../shared/eventRetention";
import { newId } from "../../shared/ids";
import { PauseCache } from "../../shared/pauseCache";
import { BURIABLE_STATES, canBury } from "../bury";
import { EventGaps } from "../eventGaps";
import { flowKey, unsettledChildren } from "../flow";
import {
  emptyCounts,
  escapeRegExp,
  jobFilter,
  orderByIds,
  sortWorkers,
  sumBuckets,
  sumStates,
  THROUGHPUT_RETENTION_MS,
  ThroughputBuffer,
} from "../readApis";
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
 * How many jobs a claim with excluded names reads from the head of the queue.
 *
 * Short, so a job that arrives at the head is seen on the very next claim
 * however far into a block of excluded jobs the continuation has moved.
 */
const EXCLUDE_HEAD_WINDOW = 64;

/**
 * How many jobs a claim with excluded names reads past the head, resuming
 * where the previous claim stopped.
 *
 * A `$nin` in the claim filter used to fetch every excluded waiting job ahead
 * of the first allowed one — measured, 10,001 documents examined and 65ms per
 * attempt behind 10,000 capped jobs, repeated on every retry while the name
 * stayed capped. A window bounds one claim's cost; the cursor is what makes
 * successive claims reach the end.
 */
const EXCLUDE_SCAN_WINDOW = 1_000;

/** How many exclusion cursors one driver keeps before forgetting the oldest. */
const EXCLUDE_CURSOR_LIMIT = 1_000;

/** The claim-order position of a job, and the one field a window filters on. */
type ClaimPosition = Pick<
  JobDocument,
  "_id" | "name" | "priority" | "createdAt"
>;

/** What reading one window of candidates found. */
interface ClaimWindow {
  /** The job claimed from the window, when one was. */
  claimed: JobRecord | null;
  /** How many documents the window returned. */
  count: number;
  /** The last position the window returned. Absent when it returned none. */
  last?: ClaimPosition;
}

/** Orders two claim positions as the claim index does. */
function compareClaimPositions(a: ClaimPosition, b: ClaimPosition): number {
  return (
    a.priority - b.priority ||
    a.createdAt - b.createdAt ||
    (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)
  );
}

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
 * How many times recording on a parent, or requeueing one, decides afresh
 * after the parent changed under it. Each round is a complete decision, so
 * more than a couple means something keeps rewriting the parent.
 */
const RECORD_CHILD_ROUNDS = 5;

/**
 * Leaves out a flow child whose parent has not recorded its outcome yet,
 * which no retention may remove. A job in no flow has no `flow.parent` and
 * always passes.
 */
const NOT_AWAITING_DELIVERY = {
  $nor: [
    { "flow.parent": { $type: "object" }, "flow.recorded": { $ne: true } },
  ],
};

/**
 * How many log lines one orphan sweep reads, per job the maintenance batch
 * allows.
 *
 * The sweep walks lines rather than jobs because that is what the index can
 * bound; a job's lines are adjacent in it, so this is roughly how many lines a
 * logging job is assumed to keep before a sweep spans fewer jobs than asked.
 */
const LOG_SWEEP_LINES_PER_JOB = 10;

/* --- the `mongodb` surface this driver uses -------------------------------- *
 *
 * Declared here rather than imported from `mongodb`, which is an *optional*
 * peer. This package ships raw TypeScript — `main`/`types` point at
 * `lib/index.ts` — so a consumer compiles these files, and `skipLibCheck` does
 * not apply to them the way it would to a `.d.ts`. A static
 * `import type { … } from "mongodb"` in a file reachable from the barrel is
 * therefore `TS2307` for everyone who has not installed the driver, followed
 * by a cascade of implicit-`any` errors under `noImplicitAny`. Measured on an
 * isolated consumer: 27 errors in this file with `mongodb` absent, 0 with it.
 *
 * These are *structural*, so a real `MongoClient`/`Db` still satisfies them and
 * an application can go on sharing its own client. Only what this driver
 * actually calls is declared; everything unread is left opaque.
 * `chrono-node`, the other optional peer, is kept at arm's length the same way.
 * ------------------------------------------------------------------------- */

/**
 * A document's server-assigned `_id`. Opaque here: never built, never read,
 * and never relied on for ordering.
 */
export interface ObjectIdLike {
  /** Declared so a bare `{}` is not assignable; `mongodb`'s `ObjectId` has it. */
  toHexString: () => string;
}

/** A query document — open by nature: `$or`, `$in`, `$lte`, `$exists`, … */
export type FilterLike = Record<string, unknown>;

/**
 * An update — `$set`, `$inc`, `$unset`, `$push`, `$setOnInsert` — or an
 * aggregation pipeline, which is how this driver expresses an update whose new
 * value depends on the old one (`$cond`, `$max`, `$mergeObjects`).
 */
export type UpdateFilterLike = Record<string, unknown> | unknown[];

/**
 * Options handed to the `MongoClient` constructor, passed straight through.
 *
 * Deliberately open: this driver neither reads nor validates them, and naming
 * the real option type is exactly what this block exists to avoid.
 */
export type MongoClientOptionsLike = Record<string, unknown>;

/** The cursor `find()` returns, with the operations this driver chains onto it. */
export interface FindCursorLike<TDoc> {
  /** Orders the results. */
  sort: (spec: Record<string, 1 | -1>) => FindCursorLike<TDoc>;
  /** Caps how many come back. */
  limit: (count: number) => FindCursorLike<TDoc>;
  /** Skips this many first. */
  skip: (count: number) => FindCursorLike<TDoc>;
  /**
   * Narrows the fields, and with them the document type.
   *
   * `TShape` is constrained exactly as the driver library constrains its own
   * `project<T extends Document>`. Left unconstrained, a real `MongoClient` is
   * not* assignable to {@link MongoClientLike} — TypeScript reports that
   * `TShape` "could be instantiated with an arbitrary type" — which would
   * quietly break lending the driver a client of your own.
   */
  project: <TShape extends Record<string, unknown> = Record<string, unknown>>(
    spec: Record<string, unknown>,
  ) => FindCursorLike<TShape>;
  /** Drains the cursor. */
  toArray: () => Promise<TDoc[]>;
  /** The next document, or `null` at the end. */
  next: () => Promise<TDoc | null>;
}

/** One collection, with the operations this driver performs on it. */
export interface CollectionLike<TDoc> {
  /** One matching document, or `null`. */
  findOne: (
    filter: FilterLike,
    options?: Record<string, unknown>,
  ) => Promise<TDoc | null>;
  /**
   * A cursor over the matching documents. The type argument narrows the
   * result, which this driver uses with a `projection` to read back only the
   * few fields a scan compares on.
   */
  find: <TResult = TDoc>(
    filter?: FilterLike,
    options?: Record<string, unknown>,
  ) => FindCursorLike<TResult>;
  /**
   * A cursor over an aggregation's results, used here for grouped counts.
   *
   * `TResult` is constrained, and the pipeline is a mutable array, for the
   * same reason as {@link FindCursorLike.project}: either difference makes a
   * real `MongoClient` unassignable to {@link MongoClientLike}.
   */
  aggregate: <
    TResult extends Record<string, unknown> = Record<string, unknown>,
  >(
    pipeline: unknown[],
    options?: Record<string, unknown>,
  ) => FindCursorLike<TResult>;
  /** Inserts one document. */
  insertOne: (
    doc: unknown,
    options?: Record<string, unknown>,
  ) => Promise<{ insertedId: unknown }>;
  /** Inserts several documents. */
  insertMany: (
    docs: unknown[],
    options?: Record<string, unknown>,
  ) => Promise<{ insertedCount: number }>;
  /** Updates the first match. */
  updateOne: (
    filter: FilterLike,
    update: UpdateFilterLike,
    options?: Record<string, unknown>,
  ) => Promise<UpdateResultLike>;
  /** Updates every match. */
  updateMany: (
    filter: FilterLike,
    update: UpdateFilterLike,
    options?: Record<string, unknown>,
  ) => Promise<UpdateResultLike>;
  /** Replaces the first match wholesale. */
  replaceOne: (
    filter: FilterLike,
    replacement: unknown,
    options?: Record<string, unknown>,
  ) => Promise<UpdateResultLike>;
  /** Deletes the first match. */
  deleteOne: (
    filter: FilterLike,
    options?: Record<string, unknown>,
  ) => Promise<{ deletedCount: number }>;
  /** Deletes every match. */
  deleteMany: (
    filter: FilterLike,
    options?: Record<string, unknown>,
  ) => Promise<{ deletedCount: number }>;
  /** Updates one document and answers with it, which is this driver's claim. */
  findOneAndUpdate: (
    filter: FilterLike,
    update: UpdateFilterLike,
    options?: Record<string, unknown>,
  ) => Promise<TDoc | null>;
  /** Deletes one document and answers with it. */
  findOneAndDelete: (
    filter: FilterLike,
    options?: Record<string, unknown>,
  ) => Promise<TDoc | null>;
  /** How many documents match. */
  countDocuments: (
    filter?: FilterLike,
    options?: Record<string, unknown>,
  ) => Promise<number>;
  /** The distinct values of one field. */
  distinct: (field: string, filter?: FilterLike) => Promise<unknown[]>;
  /** Several writes in one round trip. */
  bulkWrite: (
    operations: unknown[],
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Creates one index, answering with its name. */
  createIndex: (
    spec: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<string>;
  /** Creates several indexes. */
  createIndexes: (
    specs: Record<string, unknown>[],
    options?: Record<string, unknown>,
  ) => Promise<string[]>;
  /** Every index on the collection, as the server describes it. */
  indexes: () => Promise<IndexDescriptionLike[]>;
  /** Drops one index by name. */
  dropIndex: (name: string) => Promise<unknown>;
}

/** What an update answers with; only the counts are read. */
export interface UpdateResultLike {
  /** How many documents matched the filter. */
  matchedCount: number;
  /** How many were actually changed. */
  modifiedCount: number;
  /** How many were inserted because nothing matched. */
  upsertedCount: number;
  /** The `_id` of an upserted document, when there was one. */
  upsertedId?: unknown;
}

/** One index, as `indexes()` describes it. */
export interface IndexDescriptionLike {
  /** The index's name, which is how this driver decides whether it owns it. */
  name?: string;
  /** The keys it covers. */
  key: Record<string, unknown>;
  /** Anything else the server reports, unread here. */
  [field: string]: unknown;
}

/** One database, with the operations this driver performs on it. */
export interface DbLike {
  /** A collection by name. */
  collection: <TDoc = Record<string, unknown>>(
    name: string,
  ) => CollectionLike<TDoc>;
  /** Runs a database command; used only to ping. */
  command: (
    command: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

/**
 * A connected client, as the `client` option accepts one.
 *
 * Deliberately the *smallest* shape that lets this driver work, because it is
 * public: it is what `MongoDriverOptions.client` is typed as, so every member
 * named here is a thing a real `MongoClient` must match exactly. Requiring
 * `db()` to return {@link DbLike} did not work — the collection surface below
 * it is generic in several places, and matching `mongodb`'s own variance on
 * all of them made a genuine client *unassignable*, which would have broken
 * the very case the option exists for.
 *
 * So the database is `unknown` here and asserted as {@link DbLike} at the one
 * place it is obtained. The detailed shape stays internal, where it still
 * type-checks every call this driver makes.
 */
export interface MongoClientLike {
  /** Connects, or resolves at once when already connected. */
  connect: () => Promise<unknown>;
  /** A database by name, or the one the URL named. */
  db: (name?: string) => unknown;
  /** Closes the connection. */
  close: () => Promise<void>;
}

/** The `MongoClient` class itself, as this driver constructs it. */
export type MongoClientConstructor = new (
  url: string,
  options?: MongoClientOptionsLike,
) => MongoClientLike;

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
  clientOptions?: MongoClientOptionsLike;
  /**
   * An already-connected client, when the application has one to share.
   *
   * Typed structurally ({@link MongoClientLike}) rather than as `mongodb`'s
   * `MongoClient`, so this file never names an optional peer. A real client
   * satisfies it.
   */
  client?: MongoClientLike;
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
  /**
   * Its place in a flow. Absent (or `null`) for a job in none, which is also
   * how every document written before flows existed reads back.
   */
  flow?: FlowDocument | null;
}

/**
 * A job's flow as it is stored.
 *
 * A sub-document rather than one JSON string, so recording a child can be a
 * single conditional update that touches one entry and the pending count on
 * the server: a string would have to be read, edited and written back, which
 * without a replica set is not atomic.
 */
interface FlowDocument {
  /** The job this one is a child of, when it is one. */
  parent: JobRef | null;
  /** The jobs this one waits on, when it is a parent. */
  children: JobRef[];
  /** How many of `children` have not settled yet. */
  pending: number;
  /**
   * Completed children's results, as JSON, keyed by the `encodeFlowKey` form
   * of `queue:id`. Both halves are encoded: a key may hold `.` or start with
   * `$`, and a result may hold keys that do, none of which a field path or a
   * pipeline update may contain as-is.
   */
  values: Record<string, string>;
  /** Ignored children's failures, as JSON, keyed like `values`. */
  failures: Record<string, string>;
  /** Whether this child's outcome has been recorded on its parent. */
  recorded: boolean;
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
  /** An arbitrary JSON document, for queue metadata, repeats and queue state. */
  value?: string;
  /**
   * A queue state entry's version, which a compare-and-set names in its
   * filter. Present on queue state documents only, so it also tells them apart.
   */
  version?: number;
  /**
   * When a worker record (`w:<queue>:<id>`) lapses, in epoch milliseconds.
   * Top-level and numeric so a listing can delete lapsed records conditionally.
   */
  expiresAt?: number;
  /** The queue a throughput bucket (`m:<queue>:<minute>:<shard>`) counts. */
  queue?: string;
  /** A throughput bucket's minute, in epoch milliseconds. */
  at?: number;
  /** Jobs a throughput bucket's shard counted completing in its minute. */
  completed?: number;
  /** Failed attempts a throughput bucket's shard counted in its minute. */
  failed?: number;
  /** When it last changed. */
  updatedAt: number;
}

/**
 * Width a throughput key's minute is zero-padded to, so keys sort by minute and
 * a range over `key` reads a span of minutes. Fifteen digits hold every epoch
 * millisecond until the year 33658.
 */
const THROUGHPUT_KEY_DIGITS = 15;

/** A minute as it appears in a throughput key: zero-padded, never negative. */
function throughputKeyMinute(at: number): string {
  return String(Math.max(0, Math.floor(at))).padStart(
    THROUGHPUT_KEY_DIGITS,
    "0",
  );
}

/** One line of a job's log, as it is stored. */
interface JobLogDocument {
  /** Assigned by the server; not used for ordering. */
  _id?: ObjectIdLike;
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
  /**
   * The event's place in its channel, from a counter the server increments.
   * Absent on events published before events were numbered.
   */
  seq?: number;
  /** The event, as JSON. */
  payload: string;
  /** When it was published. */
  at: number;
}

/**
 * Prefix of the key-value entry holding a channel's event counter. Starts with
 * an underscore pair so it cannot collide with a runner's key.
 */
const EVENT_SEQ_PREFIX = "__events_seq:";

/**
 * The MongoDB driver.
 *
 * Needs **MongoDB 4.2 or later**: flows record a child's outcome and requeue
 * a parent with update pipelines (`findOneAndUpdate` with an array), which
 * older servers reject.
 */
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
  readonly #clientOptions?: MongoClientOptionsLike;
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
  /**
   * Where a claim with excluded names resumes past the head window: the last
   * position a full continuation window examined without finding an allowed
   * job, keyed by queue and exclusion set. Absent means start after the head.
   * Per instance and bounded to {@link EXCLUDE_CURSOR_LIMIT} entries, oldest
   * forgotten first — losing one only costs a rescan from the head.
   */
  readonly #excludeCursors = new Map<string, ClaimPosition>();

  /**
   * This instance's throughput shard: part of every bucket key it writes, so
   * processes never contend on one document and a reader sums the shards.
   */
  readonly #throughputShard = newId();
  /**
   * Completions and failures counted in memory and written once a second.
   * The bucket lives in another collection than the job, so it cannot ride
   * the job's update; this keeps it off the per-job path entirely.
   */
  readonly #throughput = new ThroughputBuffer(
    async (batch) => await this.#writeThroughput(batch),
  );

  /** The last log sequence number this instance handed out. */
  #lastLogSeq = 0;

  /** The client, once connected. */
  #client: MongoClientLike | undefined;
  /** Resolves once the client is connected and the indexes exist. */
  #ready: Promise<DbLike> | undefined;

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

    // Write the last throughput counts while the client is still open.
    await this.#throughput.close();

    if (this.#ownsClient && this.#client) {
      await this.#client.close();
      this.#client = undefined;
      this.#ready = undefined;
    }
  }

  /** Writes the counts gathered in memory and not yet written. */
  async flushThroughput(): Promise<void> {
    await this.#throughput.flush();
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
    // Counts not yet written would otherwise recreate the purged buckets.
    this.#throughput.forget(ns);
    // A write already in flight would otherwise land after the deletes.
    await this.#throughput.flush().catch(() => undefined);
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
      // A queue state entry named `...:meta` would match the pattern too, so
      // those are told apart by the version only they carry.
      (await this.#kv())
        .find({
          ns,
          key: { $regex: "^q:.*:meta$" },
          version: { $exists: false },
        })
        .toArray(),
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
    } as UpdateFilterLike);
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
    const filter: FilterLike =
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
      } as UpdateFilterLike,
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

  async peekQueuedTrigger(
    ns: string,
    key: string,
  ): Promise<QueuedTrigger | null> {
    const kv = await this.#kv();

    // A find, not an update: the head `$pop: -1` would take, left in place,
    // and no document is created for a runner that has none.
    const document = await kv.findOne({ _id: this.#stateId(ns, key) });
    const head = document?.queued?.[0];
    return head ? (JSON.parse(head) as QueuedTrigger) : null;
  }

  async popQueuedTriggerIf(
    ns: string,
    key: string,
    expectedId: string,
  ): Promise<QueuedTrigger | null> {
    const kv = await this.#kv();
    const id = this.#stateId(ns, key);

    // Queued triggers are stored as JSON *strings*, so the server cannot
    // filter on `queued.0.id`. It can compare the head as a whole, though:
    // read it, check the id here, then pop only if the head is still that
    // exact string. That is a compare-and-swap in one document update — a
    // pop or a push landing in between changes `queued.0` and the filter no
    // longer matches. A stored record is never rewritten in place, so a head
    // that no longer matches means the inspected record is gone from the
    // front, and `null` is the answer rather than a retry.
    const document = await kv.findOne({ _id: id });
    const head = document?.queued?.[0];
    if (!head || (JSON.parse(head) as QueuedTrigger).id !== expectedId) {
      return null;
    }

    const previous = await kv.findOneAndUpdate(
      { _id: id, "queued.0": head },
      { $pop: { queued: -1 } },
      { returnDocument: "before" },
    );

    const taken = previous?.queued?.[0];
    return taken ? (JSON.parse(taken) as QueuedTrigger) : null;
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

    if (opts.excludeNames && opts.excludeNames.length > 0) {
      return await this.#claimExcluding(jobs, q, opts, opts.excludeNames);
    }

    // One atomic document update: the server picks the document, applies the
    // claim and returns it, so exactly one caller can receive any given job.
    const claimed = await jobs.findOneAndUpdate(
      {
        ns: q.ns,
        queue: q.queue,
        state: "waiting",
        runAt: { $lte: opts.now },
      },
      this.#claimUpdate(opts),
      {
        sort: { priority: 1, createdAt: 1, _id: 1 },
        returnDocument: "after",
      },
    );

    return claimed ? this.#toRecord(claimed) : null;
  }

  /** The update that turns a waiting job into one held by the claimer. */
  #claimUpdate(opts: ClaimOptions): UpdateFilterLike {
    return {
      $set: {
        state: "active",
        processedOn: opts.now,
        lockToken: opts.token,
        lockExpiresAt: opts.now + opts.lockMs,
        workerId: opts.workerId,
      },
      $inc: { attemptsMade: 1 },
    };
  }

  /**
   * Claims the first due job whose name is not excluded, in bounded steps.
   *
   * `name` is not in the claim index, so filtering on it server-side fetches
   * every excluded job ahead of the first allowed one. Instead candidates are
   * read in index order from two windows — a short one at the head, so new
   * work is seen promptly, and a longer one resuming from a per-queue cursor,
   * so a block of excluded jobs is crossed a window per claim — filtered here,
   * and taken one at a time by id. The take names `state: "waiting"`, so a
   * candidate somebody else claimed first is simply passed over.
   */
  async #claimExcluding(
    jobs: CollectionLike<JobDocument>,
    q: QueueRef,
    opts: ClaimOptions,
    excludeNames: string[],
  ): Promise<JobRecord | null> {
    const excluded = new Set(excludeNames);
    const key = [q.ns, q.queue, ...[...excluded].sort()].join("\u0000");
    const due: FilterLike = {
      ns: q.ns,
      queue: q.queue,
      state: "waiting",
      runAt: { $lte: opts.now },
    };

    const head = await this.#claimWindow(
      jobs,
      due,
      undefined,
      EXCLUDE_HEAD_WINDOW,
      excluded,
      opts,
    );

    if (head.claimed) {
      return head.claimed;
    }

    // The head held everything due: there is nothing past it to resume into.
    if (!head.last || head.count < EXCLUDE_HEAD_WINDOW) {
      this.#excludeCursors.delete(key);
      return null;
    }

    // Resume from whichever is further in: the cursor, or the end of the head
    // (a cursor the head has overtaken would only re-read the head).
    const saved = this.#excludeCursors.get(key);
    const from =
      saved && compareClaimPositions(saved, head.last) > 0 ? saved : head.last;

    const rest = await this.#claimWindow(
      jobs,
      due,
      from,
      EXCLUDE_SCAN_WINDOW,
      excluded,
      opts,
    );

    this.#excludeCursors.delete(key);

    if (rest.count < EXCLUDE_SCAN_WINDOW || !rest.last) {
      // Short: the window reached the end of what is due, so the next claim
      // starts after the head again.
      return rest.claimed;
    }

    // Full: nothing allowed means the next claim looks past this window;
    // a claim means the window may hold more, so the next one reads it again.
    this.#excludeCursors.set(key, rest.claimed ? from : rest.last);

    if (this.#excludeCursors.size > EXCLUDE_CURSOR_LIMIT) {
      const oldest = this.#excludeCursors.keys().next().value;

      if (oldest !== undefined) {
        this.#excludeCursors.delete(oldest);
      }
    }

    return rest.claimed;
  }

  /**
   * Reads one index-ordered window of due jobs after `after` (from the head
   * when absent), and claims the first one whose name is allowed.
   */
  async #claimWindow(
    jobs: CollectionLike<JobDocument>,
    due: FilterLike,
    after: ClaimPosition | undefined,
    limit: number,
    excluded: ReadonlySet<string>,
    opts: ClaimOptions,
  ): Promise<ClaimWindow> {
    // "After" as a disjunction of compound comparisons, one per sort key, so
    // each branch is a bounded range of the claim index rather than a filter
    // applied to a scan from the start of the queue.
    const filter: FilterLike = after
      ? {
          ...due,
          $or: [
            { priority: { $gt: after.priority } },
            { priority: after.priority, createdAt: { $gt: after.createdAt } },
            {
              priority: after.priority,
              createdAt: after.createdAt,
              _id: { $gt: after._id },
            },
          ],
        }
      : due;

    const window = await jobs
      .find<ClaimPosition>(filter, {
        sort: { priority: 1, createdAt: 1, _id: 1 },
        limit,
        batchSize: limit,
        projection: { _id: 1, name: 1, priority: 1, createdAt: 1 },
      })
      .toArray();

    for (const candidate of window) {
      if (excluded.has(candidate.name)) {
        continue;
      }

      const claimed = await jobs.findOneAndUpdate(
        { _id: candidate._id, state: "waiting", runAt: { $lte: opts.now } },
        this.#claimUpdate(opts),
        { returnDocument: "after" },
      );

      if (claimed) {
        return { claimed: this.#toRecord(claimed), count: window.length };
      }
    }

    return { claimed: null, count: window.length, last: window.at(-1) };
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

    this.#throughput.add(q, now, 1, 0);
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

    // A failed attempt counts whether it is retried or dead.
    this.#throughput.add(q, now, 0, 1);

    if (!outcome.retry) {
      await this.#applyRetention(q, id, "dead", outcome.retention);
    }

    return true;
  }

  async buryJob(
    q: QueueRef,
    id: string,
    error: SerializedError,
    opts: { retention: Retention; keepStacktraces: number; token?: string },
    now: number,
  ): Promise<JobRecord | null> {
    const jobs = await this.#jobs();
    const existing = await this.getJob(q, id);

    if (!existing || !canBury(existing, opts.token)) {
      return null;
    }

    // Built from the read, as `failJob` builds it; the filter is what decides
    // whether the job is buried.
    const stacktrace = [error, ...existing.stacktrace].slice(
      0,
      Math.max(0, opts.keepStacktraces),
    );
    const expiresAt =
      typeof opts.retention === "object" &&
      opts.retention?.ttl &&
      opts.retention.ttl > 0
        ? now + opts.retention.ttl
        : null;

    const updated = await jobs.updateOne(
      {
        _id: this.#jobId(q, id),
        $or: [
          { state: { $in: [...BURIABLE_STATES] } },
          ...(opts.token === undefined
            ? []
            : [{ state: "active", lockToken: opts.token }]),
        ],
      },
      {
        $set: {
          state: "dead",
          finishedOn: now,
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
      return null;
    }

    this.#throughput.add(q, now, 0, 1);
    await this.#applyRetention(q, id, "dead", opts.retention);

    // Read back, unless retention removed it: then as it was buried.
    return (
      (await this.getJob(q, id)) ?? {
        ...existing,
        state: "dead",
        finishedOn: now,
        expiresAt,
        failedReason: error,
        stacktrace,
        lockToken: null,
        lockExpiresAt: null,
        workerId: null,
      }
    );
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

    const filter: FilterLike = {
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
      .project<{ _id: ObjectIdLike }>({ _id: 1 })
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

  /**
   * Records a child's outcome on its parent as one conditional update.
   *
   * Without a replica set MongoDB is atomic per document and no further, so
   * each write is one statement whose filter carries every check: the parent
   * lists this child, holds no entry for it yet — what makes a repeat match
   * nothing — and is in the state the write is for. A settled child on a
   * waiting parent is a pipeline update, so storing the entry, counting it
   * off and — only when that reaches zero — releasing the parent all happen
   * together; two updates would leave a crash between them holding a parent
   * at zero pending that no repeat could release.
   *
   * When no write matches, one read says why. Only a parent that changed
   * state between the write and the read — buried by a sibling, say — sends
   * it round again, and each round is a fresh, complete decision.
   */
  async recordChild(
    q: QueueRef,
    parentId: string,
    child: JobRef,
    outcome: ChildOutcome,
    now: number,
  ): Promise<ChildRecordResult> {
    const jobs = await this.#jobs();
    const _id = this.#jobId(q, parentId);
    const key = encodeFlowKey(flowKey(child));
    const settles = outcome.completed || outcome.ignored;
    const entry = outcome.completed
      ? {
          path: `flow.values.${key}`,
          json: JSON.stringify(outcome.value ?? null),
        }
      : { path: `flow.failures.${key}`, json: JSON.stringify(outcome.error) };

    const unrecorded = (state: JobState) =>
      ({
        _id,
        state,
        flow: { $type: "object" },
        "flow.children": { $elemMatch: { queue: child.queue, id: child.id } },
        [`flow.values.${key}`]: { $exists: false },
        [`flow.failures.${key}`]: { $exists: false },
      }) as FilterLike;

    for (let round = 0; round < RECORD_CHILD_ROUNDS; round++) {
      if (!settles) {
        // A child that failed buries its parent, which can then never run.
        const buried = await jobs.updateOne(unrecorded("waiting-children"), {
          $set: {
            state: "dead",
            failedReason: JSON.stringify(outcome.error),
            finishedOn: now,
          },
        });
        if (buried.matchedCount > 0) {
          // A parent buried by a failed child is a failure too.
          this.#throughput.add(q, now, 0, 1);
          return "buried";
        }
      } else {
        const counted = await jobs.findOneAndUpdate(
          unrecorded("waiting-children"),
          [
            {
              $set: {
                // `$literal`, because a pipeline reads a string starting with
                // `$` as a field path, and a JSON string can.
                [entry.path]: { $literal: entry.json },
                "flow.pending": {
                  $max: [0, { $subtract: ["$flow.pending", 1] }],
                },
              },
            },
            {
              // A later stage sees the earlier one's output: this reads the
              // decremented count.
              $set: {
                state: {
                  $cond: {
                    if: { $lte: ["$flow.pending", 0] },
                    then: {
                      $cond: {
                        if: { $gt: ["$runAt", now] },
                        then: "delayed",
                        else: "waiting",
                      },
                    },
                    else: "$state",
                  },
                },
              },
            },
          ],
          { returnDocument: "after", projection: { state: 1 } },
        );
        // No wake to send: workers find a newly waiting job by polling
        // `waitForJob`, which this driver has no push channel to shortcut.
        if (counted) {
          return counted.state === "waiting-children" ? "recorded" : "released";
        }

        // A buried parent keeps the outcome for its retry. A plain `$set`,
        // not a pipeline, so the JSON string is stored as the value it is.
        const kept = await jobs.updateOne(unrecorded("dead"), {
          $set: { [entry.path]: entry.json },
        });
        if (kept.matchedCount > 0) {
          return "recorded";
        }
      }

      const current = await jobs.findOne(
        { _id },
        {
          projection: {
            state: 1,
            "flow.children": 1,
            [`flow.values.${key}`]: 1,
            [`flow.failures.${key}`]: 1,
          },
        },
      );
      const flow = current?.flow;

      if (
        !current ||
        !flow ||
        !(flow.children ?? []).some(
          (ref) => ref.queue === child.queue && ref.id === child.id,
        )
      ) {
        return "missing";
      }
      if (
        flow.values?.[key] !== undefined ||
        flow.failures?.[key] !== undefined
      ) {
        return "already";
      }
      if (current.state === "dead" && !settles) {
        return "parent-dead";
      }
      if (current.state !== "dead" && current.state !== "waiting-children") {
        return "already";
      }
      // Its state moved between the write and the read: decide again.
    }

    throw new DriverError(
      "mongodb",
      "recordChild",
      new Error("the parent kept changing state while it was recorded on"),
      { id: parentId, child: flowKey(child) },
    );
  }

  /**
   * Returns a buried parent to waiting on its children, as one conditional
   * pipeline update — the pipeline is what lets a parent with nothing left to
   * wait on choose waiting or delayed from its own `runAt`.
   *
   * The count left is taken from the outcomes the parent holds, read first;
   * the update then matches only while they are exactly what was read, so an
   * outcome recorded in between sends it round to count again rather than
   * leaving the parent waiting on a child it already has.
   */
  async requeueParent(q: QueueRef, id: string, now: number): Promise<boolean> {
    const jobs = await this.#jobs();
    const _id = this.#jobId(q, id);

    for (let round = 0; round < RECORD_CHILD_ROUNDS; round++) {
      const current = await jobs.findOne(
        { _id, state: "dead", flow: { $type: "object" } },
        { projection: { flow: 1 } },
      );
      if (!current?.flow) {
        return false;
      }

      const remaining = unsettledChildren(decodeFlow(current.flow));
      const moved = await this.#requeueAt(
        {
          _id,
          state: "dead",
          "flow.values": current.flow.values ?? {},
          "flow.failures": current.flow.failures ?? {},
        } as FilterLike,
        remaining,
        now,
      );
      if (moved) {
        return true;
      }
    }

    throw new DriverError(
      "mongodb",
      "requeueParent",
      new Error("the parent's outcomes kept changing while it was requeued"),
      { id },
    );
  }

  /** The requeue write itself, for {@link MongoDriver.requeueParent}. */
  async #requeueAt(
    filter: FilterLike,
    remaining: number,
    now: number,
  ): Promise<boolean> {
    const jobs = await this.#jobs();
    const result = await jobs.updateOne(filter, [
      {
        $set: {
          "flow.pending": { $literal: remaining },
          finishedOn: null,
          expiresAt: null,
          state:
            remaining > 0
              ? { $literal: "waiting-children" }
              : {
                  $cond: {
                    if: { $gt: ["$runAt", now] },
                    then: "delayed",
                    else: "waiting",
                  },
                },
        },
      },
      // Absent reads back as no reason, like a job that never failed.
      { $unset: ["failedReason"] },
    ]);

    return result.matchedCount > 0;
  }

  /**
   * Marks a child recorded, in one pipeline update that also creates the flow
   * when the job has none, then applies the retention its settling deferred.
   */
  async markChildRecorded(
    q: QueueRef,
    id: string,
    retention: Retention,
    now: number,
  ): Promise<boolean> {
    const jobs = await this.#jobs();
    const _id = this.#jobId(q, id);
    const empty: FlowDocument = {
      parent: null,
      children: [],
      pending: 0,
      values: {},
      failures: {},
      recorded: false,
    };

    const marked = await jobs.findOneAndUpdate(
      { _id },
      [
        {
          $set: {
            // Later operands win, and a null or absent flow is ignored, so an
            // existing flow keeps everything but `recorded`.
            flow: {
              $mergeObjects: [
                { $literal: empty },
                { $ifNull: ["$flow", {}] },
                { $literal: { recorded: true } },
              ],
            },
          },
        },
      ],
      { returnDocument: "after", projection: { state: 1 } },
    );

    if (!marked) {
      return false;
    }

    if (marked.state !== "completed" && marked.state !== "dead") {
      return true;
    }

    // Exactly what completeJob and failJob do with a retention: an expiry for
    // a TTL, then removal or the count sweep.
    if (typeof retention === "object" && retention?.ttl && retention.ttl > 0) {
      await jobs.updateOne(
        { _id, state: marked.state },
        { $set: { expiresAt: now + retention.ttl } },
      );
    }

    await this.#applyRetention(q, id, marked.state, retention);
    return true;
  }

  async listJobs(
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ): Promise<JobRecord[]> {
    const jobs = await this.#jobs();

    const documents = await jobs
      .find({ ns: q.ns, queue: q.queue, state: { $in: states } })
      .sort(this.#listSort(states, opts.order))
      .skip(opts.offset)
      .limit(opts.limit)
      .toArray();

    return documents.map((document) => this.#toRecord(document));
  }

  /**
   * The sort a listing of `states` uses. A single state is listed in its own
   * natural order — the one every driver shares, see `JobsDriver.listJobs` —
   * and several states share only creation time. Delayed and failed ride the
   * promotion index.
   */
  #listSort(states: JobState[], order: "asc" | "desc"): Record<string, 1 | -1> {
    const direction = order === "asc" ? 1 : -1;
    const single = states.length === 1 ? states[0] : undefined;

    return single === "waiting"
      ? { priority: direction, createdAt: direction, _id: direction }
      : single === "delayed" || single === "failed"
        ? { runAt: direction, _id: direction }
        : single === "active"
          ? { lockExpiresAt: direction, _id: direction }
          : single === "completed" || single === "dead"
            ? { finishedOn: direction, _id: direction }
            : { createdAt: direction, _id: direction };
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
      "waiting-children": 0,
    } satisfies Record<JobState, number>;

    for (const row of grouped) {
      if (row._id in counts) {
        counts[row._id] = row.total;
      }
    }

    return counts;
  }

  /* --- read APIs ------------------------------------------------------ */

  /**
   * A filtered page as one `find` over the claim-order index's prefix, sorted
   * the way `listJobs` sorts. A search is a case-insensitive regex over `id`
   * and `name` with the input escaped, so every character matches itself; the
   * payload is never matched. A total with a filter is a `countDocuments` with
   * the same filter, sent alongside the page; without one it is the states'
   * counts summed.
   */
  async findJobs(q: QueueRef, query: JobQuery): Promise<JobPage> {
    const jobs = await this.#jobs();
    const filter = jobFilter(query);
    const offset = Math.max(0, Math.floor(query.offset));
    const limit = Math.max(0, Math.floor(query.limit));

    const where: FilterLike = {
      ns: q.ns,
      queue: q.queue,
      state: { $in: query.states },
    };

    if (filter?.names) {
      where.name = { $in: [...filter.names] };
    }

    if (filter?.search !== undefined) {
      const pattern = { $regex: escapeRegExp(filter.search), $options: "i" };
      where.$or = [{ id: pattern }, { name: pattern }];
    }

    // `limit(0)` means "no limit" to MongoDB, so an empty page is not asked for.
    const page =
      limit === 0
        ? Promise.resolve([])
        : jobs
            .find(where)
            .sort(this.#listSort(query.states, query.order))
            .skip(offset)
            .limit(limit)
            .toArray();

    const total = !query.total
      ? undefined
      : filter
        ? jobs.countDocuments(where)
        : this.countJobs(q).then((counts) => sumStates(counts, query.states));

    const [documents, counted] = await Promise.all([page, total]);
    const records = documents.map((document) => this.#toRecord(document));

    return counted === undefined
      ? { jobs: records }
      : { jobs: records, total: counted };
  }

  /** Several jobs by id in one `find` on `_id`, answered in the order asked. */
  async getJobs(q: QueueRef, ids: string[]): Promise<(JobRecord | null)[]> {
    if (ids.length === 0) {
      return [];
    }

    const jobs = await this.#jobs();
    const distinct = [...new Set(ids)];
    const documents = await jobs
      .find({ _id: { $in: distinct.map((id) => this.#jobId(q, id)) } })
      .toArray();

    const found = new Map<string, JobRecord | null>();
    for (const document of documents) {
      found.set(document.id, this.#toRecord(document));
    }

    return orderByIds(ids, found);
  }

  /**
   * Replaces the worker's record in the key/value collection, under
   * `w:<queue>:<id>`, with `expiresAt` top-level so lapsed records can be
   * deleted by a filter.
   */
  async registerWorker(q: QueueRef, worker: WorkerInfo): Promise<void> {
    const kv = await this.#kv();
    const key = `${this.#workerPrefix(q)}${worker.id}`;
    const _id = `${q.ns}:${key}`;

    await kv.replaceOne(
      { _id },
      {
        ns: q.ns,
        key,
        value: JSON.stringify(worker),
        expiresAt: worker.expiresAt,
        updatedAt: Date.now(),
      },
      { upsert: true },
    );

    // Records lapsed as of this report go now, not only when somebody lists.
    const prefix = this.#workerPrefix(q);
    await kv.deleteMany({
      ns: q.ns,
      key: { $gte: prefix, $lt: prefixUpperBound(prefix) },
      expiresAt: { $lte: worker.heartbeatAt },
    });
  }

  /** Deletes a worker's record, answering whether there was one. */
  async removeWorker(q: QueueRef, id: string): Promise<boolean> {
    const kv = await this.#kv();
    const deleted = await kv.deleteOne({
      _id: `${q.ns}:${this.#workerPrefix(q)}${id}`,
    });
    return deleted.deletedCount > 0;
  }

  /**
   * The queue's live workers: a range read over `{ns, key}` for the queue's
   * worker prefix. Lapsed records are deleted on the way, conditionally on
   * still being lapsed, so a worker that reported again in between keeps its
   * record.
   */
  async listWorkers(q: QueueRef, now: number): Promise<WorkerInfo[]> {
    const kv = await this.#kv();
    const prefix = this.#workerPrefix(q);
    const documents = await kv
      .find({ ns: q.ns, key: { $gte: prefix, $lt: prefixUpperBound(prefix) } })
      .toArray();

    const live: WorkerInfo[] = [];
    const lapsed: string[] = [];

    for (const document of documents) {
      if (document.value === undefined) {
        continue;
      }

      if ((document.expiresAt ?? 0) > now) {
        live.push(JSON.parse(document.value) as WorkerInfo);
      } else {
        lapsed.push(document._id);
      }
    }

    if (lapsed.length > 0) {
      await kv.deleteMany({ _id: { $in: lapsed }, expiresAt: { $lte: now } });
    }

    return sortWorkers(live);
  }

  /** Every queue's state counts in the namespace, as one aggregation. */
  async countJobsByQueue(
    ns: string,
  ): Promise<Record<string, Record<JobState, number>>> {
    const jobs = await this.#jobs();

    const grouped = await jobs
      .aggregate<{
        _id: { queue: string; state: JobState };
        total: number;
      }>([
        { $match: { ns } },
        {
          $group: {
            _id: { queue: "$queue", state: "$state" },
            total: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const result: Record<string, Record<JobState, number>> = {};

    for (const row of grouped) {
      const counts = (result[row._id.queue] ??= emptyCounts());
      if (row._id.state in counts) {
        counts[row._id.state] = row.total;
      }
    }

    return result;
  }

  /**
   * Completions and failed attempts per minute. Writes what this instance has
   * counted first, then reads the queue's bucket keys across the range — every
   * shard's — and sums them by minute.
   */
  async getThroughput(
    q: QueueRef,
    range: { from: number; to: number },
  ): Promise<ThroughputBucket[]> {
    if (range.to < range.from) {
      return [];
    }

    await this.#throughput.flush();

    const kv = await this.#kv();
    const prefix = this.#throughputPrefix(q);
    const documents = await kv
      .find({
        ns: q.ns,
        key: {
          $gte: `${prefix}${throughputKeyMinute(range.from)}`,
          $lt: `${prefix}${throughputKeyMinute(range.to + 1)}`,
        },
      })
      .toArray();

    return sumBuckets(
      documents.map((document) => ({
        at: document.at ?? 0,
        completed: document.completed ?? 0,
        failed: document.failed ?? 0,
      })),
      range,
    );
  }

  /** The key prefix of a queue's worker records: `w:<queue>:`. */
  #workerPrefix(q: QueueRef): string {
    return `w:${q.queue}:`;
  }

  /** The key prefix of a queue's throughput buckets: `m:<queue>:`. */
  #throughputPrefix(q: QueueRef): string {
    return `m:${q.queue}:`;
  }

  /**
   * Writes one batch of throughput counts: a single `bulkWrite` of `$inc`
   * upserts on this instance's shard of each bucket, then, per queue written,
   * one delete of the minutes past the retention before the latest one in the
   * batch.
   */
  async #writeThroughput(
    batch: PendingThroughput[],
  ): Promise<ThroughputWriteResult> {
    if (batch.length === 0) {
      return { unwritten: [] };
    }

    const kv = await this.#kv();
    const updatedAt = Date.now();
    const latest = new Map<string, { q: QueueRef; at: number }>();
    let unwritten: PendingThroughput[] = [];
    let failure: unknown;

    try {
      await kv.bulkWrite(
        batch.map((entry) => {
          const key = `${this.#throughputPrefix(entry.q)}${throughputKeyMinute(entry.at)}:${this.#throughputShard}`;
          const queueKey = `${entry.q.ns}\n${entry.q.queue}`;
          const seen = latest.get(queueKey);
          if (!seen || entry.at > seen.at) {
            latest.set(queueKey, { q: entry.q, at: entry.at });
          }

          return {
            updateOne: {
              filter: { _id: `${entry.q.ns}:${key}` },
              update: {
                $inc: { completed: entry.completed, failed: entry.failed },
                $set: { updatedAt },
                $setOnInsert: {
                  ns: entry.q.ns,
                  key,
                  at: entry.at,
                  queue: entry.q.queue,
                },
              },
              upsert: true,
            },
          };
        }),
        { ordered: false },
      );
    } catch (error) {
      // Unordered, so every operation was attempted, and the error names the
      // refused ones by position. An error naming none says nothing about what
      // landed, so it is thrown and the whole batch goes back.
      const refused = bulkWriteFailures(error);
      if (refused === null) {
        throw error;
      }
      unwritten = batch.filter((_, index) => refused.has(index));
      failure = error;
    }

    for (const { q, at } of latest.values()) {
      const prefix = this.#throughputPrefix(q);
      // Best-effort: counts that landed stay landed, and the next write
      // for this queue deletes again.
      await kv
        .deleteMany({
          ns: q.ns,
          key: {
            $gte: prefix,
            $lt: `${prefix}${throughputKeyMinute(at - THROUGHPUT_RETENTION_MS)}`,
          },
        })
        .catch(() => undefined);
    }

    return failure === undefined
      ? { unwritten }
      : { unwritten, error: failure };
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
        state: { $nin: ["active", "waiting", "waiting-children"] },
      },
      // A pipeline, so a flow child's `recorded` is cleared in the same write
      // — its next outcome has not reached its parent — while a job in no
      // flow keeps none: `$$REMOVE` leaves an absent field absent.
      [
        {
          $set: {
            state: { $literal: "waiting" },
            runAt: { $literal: now },
            finishedOn: null,
            expiresAt: null,
            ...(resetAttempts
              ? { attemptsMade: { $literal: 0 }, stalledCount: { $literal: 0 } }
              : {}),
            flow: {
              $cond: {
                if: { $eq: [{ $type: "$flow" }, "object"] },
                then: {
                  $mergeObjects: ["$flow", { $literal: { recorded: false } }],
                },
                else: { $ifNull: ["$flow", "$$REMOVE"] },
              },
            },
          },
        },
      ],
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
        ...NOT_AWAITING_DELIVERY,
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
    // A parent waiting on children is queued work that has not started, so a
    // drain takes it along with the waiting jobs.
    const states: JobState[] = includeDelayed
      ? ["waiting", "waiting-children", ...SCHEDULED]
      : ["waiting", "waiting-children"];

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

  async getQueueState(
    q: QueueRef,
    name: string,
  ): Promise<QueueStateEntry | null> {
    const kv = await this.#kv();
    const document = await kv.findOne({ _id: this.#queueStateId(q, name) });

    return document?.value !== undefined && document.version !== undefined
      ? { value: JSON.parse(document.value), version: document.version }
      : null;
  }

  /**
   * Each branch is a single-document write whose filter carries the
   * condition, so the server checks and writes in one step: of many callers
   * naming the same version, one matches and the rest match nothing. Creation
   * gets the same guarantee from the `_id` being unique.
   */
  async setQueueState(
    q: QueueRef,
    name: string,
    value: unknown,
    expected: number | null,
    options?: { internal?: symbol },
  ): Promise<number | null> {
    assertWritableStateName(name, options);

    const kv = await this.#kv();
    const _id = this.#queueStateId(q, name);

    if (value === null) {
      if (expected === null) {
        // Deleting what must not exist changes nothing; it only succeeds if
        // that is still true.
        return (await kv.findOne({ _id }, { projection: { _id: 1 } }))
          ? null
          : 0;
      }

      const result = await kv.deleteOne({ _id, version: expected });
      return result.deletedCount === 1 ? 0 : null;
    }

    const encoded = JSON.stringify(value);

    if (expected === null) {
      try {
        await kv.insertOne({
          _id,
          ns: q.ns,
          key: `q:${q.queue}:state:${name}`,
          value: encoded,
          version: 1,
          updatedAt: Date.now(),
        });
        return 1;
      } catch (error) {
        if (isDuplicateKey(error)) {
          return null;
        }
        throw new DriverError("mongodb", "setQueueState", error, {
          queue: q.queue,
        });
      }
    }

    // `updateOne` rather than `findOneAndUpdate`: the new version is known
    // without the document, so there is nothing worth sending back.
    const result = await kv.updateOne(
      { _id, version: expected },
      {
        $set: { value: encoded, version: expected + 1, updatedAt: Date.now() },
      },
    );
    return result.matchedCount === 1 ? expected + 1 : null;
  }

  /**
   * A range on `_id` rather than a regex: the prefix is matched literally
   * whatever it contains, and the range walks the `_id` index directly, so
   * the query is covered — no document is fetched.
   *
   * Ordering is the server's, which for a collection without a collation (this
   * driver never creates one) is UTF-8 byte order, i.e. code point order. That
   * is JavaScript's order for every name except one that mixes U+E000–U+FFFF
   * with characters above U+FFFF, which UTF-16 sorts the other way round.
   *
   * A deletion is a real `deleteOne`, so a deleted entry has no document left
   * to be listed.
   */
  async listQueueState(
    q: QueueRef,
    options: { prefix: string; after?: string; limit: number },
  ): Promise<string[]> {
    const limit = Math.floor(options.limit);
    // `limit(0)` means "no limit" to MongoDB, and a negative one means "a
    // single batch", so a limit of nothing has to be answered here.
    if (!(limit > 0)) {
      return [];
    }

    const kv = await this.#kv();
    const base = this.#queueStateId(q, "");
    const lower = base + options.prefix;
    const range: { $gte: string; $lt: string; $gt?: string } = {
      $gte: lower,
      $lt: prefixUpperBound(lower),
    };
    if (options.after !== undefined) {
      range.$gt = base + options.after;
    }

    const documents = await kv
      .find({ _id: range }, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();

    return documents.map((document) => document._id.slice(base.length));
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

  /**
   * Stores an event under the next number in its channel.
   *
   * Numbered by a counter the server increments, not ordered by `_id`: an
   * ObjectId is made by the client, and only its first four bytes are time — to
   * the second — so within a second two processes' ids sort by their random
   * middle bytes. A subscriber following `_id` passed over a second process's
   * events for good whenever that came out lower, about half the time. The
   * counter costs one round trip per published event, which only producers
   * that asked to publish pay.
   */
  async publish(event: DriverEvent): Promise<void> {
    this.#pruneEvents(event.ns);
    const channel = `${event.kind}:${event.target}`;
    const [kv, events] = await Promise.all([this.#kv(), this.#events()]);
    const key = `${EVENT_SEQ_PREFIX}${channel}`;

    const counter = await kv.findOneAndUpdate(
      { _id: `${event.ns}:${key}` },
      {
        $inc: { "counters.seq": 1 },
        $setOnInsert: { ns: event.ns, key },
      },
      { upsert: true, returnDocument: "after" },
    );

    await events.insertOne({
      ns: event.ns,
      channel,
      seq: counter?.counters?.seq ?? 0,
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
    // history it was not there for.
    const latest = await events
      .find({ ns, channel, seq: { $exists: true } })
      .sort({ seq: -1 })
      .limit(1)
      .toArray();

    const gaps = new EventGaps(latest[0]?.seq ?? 0);
    let stopped = false;

    const timer = setInterval(() => {
      void (async () => {
        if (stopped) {
          return;
        }

        const now = Date.now();
        const retry = gaps.retry(now);
        const documents = await events
          .find({
            ns,
            channel,
            $or: [
              { seq: { $gt: gaps.cursor } },
              ...(retry.length > 0 ? [{ seq: { $in: retry } }] : []),
            ],
          })
          .sort({ seq: 1 })
          .limit(200)
          .toArray();

        for (const document of documents) {
          if (document.seq !== undefined && gaps.accept(document.seq, now)) {
            deliver(JSON.parse(document.payload) as DriverEvent);
          }
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
  async #open(): Promise<DbLike> {
    let MongoClientCtor: MongoClientConstructor;

    try {
      // Imported here, not at the top: the package is an optional peer, so a
      // project that never constructs this driver never needs it installed.
      //
      // Through a `string`-typed specifier rather than the literal, so the
      // compiler does not try to resolve it either — a bare
      // `import("mongodb")` is a `TS2307` site for a consumer without the
      // package just as a static import is, and this file has to compile in
      // their project.
      const specifier: string = "mongodb";
      const loaded = (await import(specifier)) as {
        MongoClient?: MongoClientConstructor;
        default?: { MongoClient?: MongoClientConstructor };
      };

      // Both shapes, because the specifier is typed `string`: with no literal
      // to analyse, the loader cannot apply its CommonJS interop, so
      // `mongodb`'s exports may arrive under `default` rather than on the
      // module object.
      const constructor = loaded.MongoClient ?? loaded.default?.MongoClient;

      if (typeof constructor !== "function") {
        throw new TypeError("mongodb did not export MongoClient");
      }

      MongoClientCtor = constructor;
    } catch (error) {
      throw new ConfigError(
        'The MongoDB driver needs the "mongodb" package: install it with `bun add mongodb`',
        { cause: String(error) },
      );
    }

    try {
      this.#client ??= new MongoClientCtor(this.#url, this.#clientOptions);
      await this.#client.connect();

      // The one place the database is obtained, and so the one place the
      // internal shape is asserted. See {@link MongoClientLike}.
      const db = this.#client.db(this.database) as DbLike;
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
      // Following a channel: by its number, and asking again for the ones a
      // poll passed over.
      {
        collection: this.collections.events,
        key: { ns: 1, channel: 1, seq: 1 },
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
    db: DbLike,
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
  async #createIndexes(db: DbLike): Promise<void> {
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

    // Retired indexes are not dropped here. Dropping one is a schema change,
    // and schema changes are `syncSchema`'s to plan and apply — so a plain
    // connect, `syncSchema: false`, `dryRun` and `indexes: false` all leave
    // them where they are.
  }

  /** The database, connecting on first use. */
  async #db(): Promise<DbLike> {
    this.#ready ??= this.#open();
    return await this.#ready;
  }

  /** The jobs collection. */
  async #jobs(): Promise<CollectionLike<JobDocument>> {
    return (await this.#db()).collection<JobDocument>(this.collections.jobs);
  }

  /** The locks collection. */
  async #locks(): Promise<CollectionLike<LockDocument>> {
    return (await this.#db()).collection<LockDocument>(this.collections.locks);
  }

  /** The key/value collection. */
  async #kv(): Promise<CollectionLike<KvDocument>> {
    return (await this.#db()).collection<KvDocument>(this.collections.kv);
  }

  /** The events collection. */
  async #events(): Promise<CollectionLike<EventDocument>> {
    return (await this.#db()).collection<EventDocument>(
      this.collections.events,
    );
  }

  /** The job-logs collection. */
  async #jobLogs(): Promise<CollectionLike<JobLogDocument>> {
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

  /**
   * The `_id` of a queue state entry. Built like a queue's `meta` key, so
   * `purge` takes it with the rest of the namespace.
   */
  #queueStateId(q: QueueRef, name: string): string {
    return `${q.ns}:q:${q.queue}:state:${name}`;
  }

  /** Applies an update to a runner's state, creating the document if needed. */
  async #upsertState(
    ns: string,
    key: string,
    update: UpdateFilterLike,
  ): Promise<void> {
    const kv = await this.#kv();

    await kv.updateOne(
      { _id: this.#stateId(ns, key) },
      {
        ...update,
        $setOnInsert: { ns, key: `${key}:state` },
      } as UpdateFilterLike,
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

    // Written whether or not the job is otherwise fresh: a parent is added
    // brand-new in every other respect, and its flow is what holds it back.
    if (job.flow) {
      document.flow = encodeFlow(job.flow);
    }

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
      flow: document.flow ? decodeFlow(document.flow) : null,
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

    // A flow child whose parent has not recorded its outcome is skipped — but
    // still counted towards the cap, which only ever keeps more, never fewer.
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
        // Checked on the delete itself, so a child between the read and here
        // is judged by what it is now.
        ...NOT_AWAITING_DELIVERY,
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
 * The smallest string greater than every string that starts with `prefix`,
 * in MongoDB's (code point) order: the prefix with its last code point
 * incremented. Trailing U+10FFFF cannot be incremented, so it is dropped and
 * the code point before it carries instead. Surrogates are skipped, since a
 * string holding one lone cannot be stored.
 *
 * Callers pass a prefix ending in the `:` of a fixed base, so there is always
 * a code point to increment.
 */
function prefixUpperBound(prefix: string): string {
  const codePoints = Array.from(prefix, (char) => char.codePointAt(0)!);

  while (codePoints.at(-1) === 0x10ffff) {
    codePoints.pop();
  }

  const last = codePoints.pop();
  if (last === undefined) {
    throw new RangeError("A prefix of only U+10FFFF has no upper bound");
  }

  codePoints.push(last === 0xd7ff ? 0xe000 : last + 1);
  return String.fromCodePoint(...codePoints);
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
/**
 * A flow child key (`queue:id`) made safe as one field-path segment.
 *
 * A path splits on `.`, and a segment may not start with `$` or hold a NUL, so
 * those are percent-encoded — and `%` itself, which keeps the encoding
 * reversible and distinct keys distinct.
 */
function encodeFlowKey(key: string): string {
  return key.replace(
    /[%.$\0]/g,
    (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** The `queue:id` key a stored segment was encoded from. */
function decodeFlowKey(segment: string): string {
  const unescape = (_: string, hex: string): string =>
    String.fromCharCode(Number.parseInt(hex, 16));

  return segment.replace(/%([0-9A-F]{2})/g, unescape);
}

/** A flow as it is stored: keys encoded, values and failures JSON. */
function encodeFlow(flow: JobFlow): FlowDocument {
  const encode = (entries: Record<string, unknown>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [
        encodeFlowKey(key),
        JSON.stringify(value ?? null),
      ]),
    );

  return {
    parent: flow.parent
      ? { queue: flow.parent.queue, id: flow.parent.id }
      : null,
    children: flow.children.map((ref) => ({ queue: ref.queue, id: ref.id })),
    pending: flow.pending,
    values: encode(flow.values),
    failures: encode(flow.failures),
    recorded: flow.recorded,
  };
}

/** A stored flow as the record's plain one, keyed `queue:id`. */
function decodeFlow(stored: FlowDocument): JobFlow {
  const decode = <T>(entries: Record<string, string> | undefined) =>
    Object.fromEntries(
      Object.entries(entries ?? {}).map(([segment, json]) => [
        decodeFlowKey(segment),
        JSON.parse(json) as T,
      ]),
    );

  return {
    parent: stored.parent ?? null,
    children: stored.children ?? [],
    pending: stored.pending ?? 0,
    values: decode<unknown>(stored.values),
    failures: decode<SerializedError>(stored.failures),
    recorded: stored.recorded ?? false,
  };
}

function parseOrDefault<T>(value: string | undefined, fallback: T): T {
  return value === undefined ? fallback : (JSON.parse(value) as T);
}

/** Escapes a value for use inside a regular expression. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The positions of the operations an unordered bulk write refused, read from
 * the error it threw, or `null` when the error names none — which says nothing
 * about what landed. `writeErrors` is one error or several, depending on how
 * many there were.
 */
function bulkWriteFailures(error: unknown): Set<number> | null {
  const reported = (error as { writeErrors?: unknown } | null)?.writeErrors;
  const list = Array.isArray(reported) ? reported : reported ? [reported] : [];

  if (list.length === 0) {
    return null;
  }

  const positions = new Set<number>();
  for (const writeError of list as { index?: unknown }[]) {
    if (typeof writeError?.index !== "number") {
      return null;
    }
    positions.add(writeError.index);
  }

  return positions;
}
