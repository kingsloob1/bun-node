import type {
  ClearJobLogsResult,
  EditableJobOptionKey,
  JobQuery,
  JobRecord,
  JobRef,
  JobsDriver,
  JobState,
  QueueRef,
  RepeatRecord,
  ThroughputBucket,
  WorkerInfo,
} from "../drivers/index";
import type {
  QueueDriverEvent,
  QueueEventName,
  QueueEventPayloads,
} from "../shared/events";
import type { DateParser } from "../shared/humanTime";
import type { Logger } from "../shared/logger";
import type { JobEvent, JobHooks } from "./Job";
import type {
  JobDefaultsPatch,
  JobDefaultsUpdate,
  StoredJobDefaults,
} from "./jobDefaults";
import type { QueueLimits, StoredLimits } from "./limits";
import type {
  AdHocJobName,
  ApplyJobDefaultsOptions,
  ApplyJobDefaultsResult,
  BulkEntriesOf,
  BulkJobsOf,
  BunQueueEvents,
  BunQueueOptions,
  FlowNode,
  FlowNodeOf,
  FlowResult,
  JobAddArgs,
  JobDataOf,
  JobDefaultsInfo,
  JobDefaultsWriteOptions,
  JobDefaultsWriteResult,
  JobMap,
  JobMapData,
  JobMapOf,
  JobMapResult,
  JobName,
  JobOptions,
  JobsPage,
  ListJobsOptions,
  QueueEventsOf,
  QueueJobOf,
  QueueThroughput,
  RepeatableInfo,
  RetryAllOptions,
  RetryAllOptionsOf,
  TypedJob,
  TypedJobName,
  UntypedJobName,
  UpdateDataOf,
} from "./types";
import type { DebouncePointer } from "./windows";
import { deserializeError, sleep } from "@kingsleyweb/bun-common";
import {
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_APPLY_STATES,
  JOB_LIST_SORTS,
} from "../api/contract/constants";
import {
  attributionFilter,
  countAdded,
  findJobPage,
  findJobsByScan,
  getJobsByIds,
  jobFilter,
  listWorkerRecords,
  resolveDriver,
  sortsByCreated,
  supportsCreatedSort,
  supportsWorkers,
  THROUGHPUT_BUCKET_MS,
  THROUGHPUT_RETENTION_MS,
  throughputBucket,
} from "../drivers/index";
import { TypedEmitterBase } from "../shared/emitter";
import {
  ConfigError,
  JobsError,
  NotSupportedError,
  QueueClosedError,
} from "../shared/errors";
import { queueEvent } from "../shared/events";
import { fitName } from "../shared/fit";
import { assertDateParser, parseDuration } from "../shared/humanTime";
import { newId, newToken } from "../shared/ids";
import { assertJsonSafe } from "../shared/json";
import { assertNamespace, assertSegment } from "../shared/keys";
import { createJobsLogger } from "../shared/logger";
import { Job } from "./Job";
import {
  describeJobDefaults,
  isJobDefaultKey,
  JobDefaultsCache,
  openWalkCursor,
  overriddenKeys,
  readJobDefaults,
  resetJobDefaults,
  sealWalkCursor,
  supportsJobDefaults,
  writeJobDefaults,
} from "./jobDefaults";
import { LIMITS_STATE, normalizeLimits, QueueLimiter } from "./limits";
import {
  assertJobId,
  assertRepeatKey,
  CALLER_REPEAT_KEY_PREFIX,
  DERIVED_NAME_LIMITS,
  displayRepeatKey,
  resolveJobOptions,
  resolveLayeredJobOptions,
  resolveRunAt,
  shortenJobId,
} from "./options";
import { nextOccurrence, repeatJobId, toRepeatRecord } from "./repeat";
import {
  clearRepeatDisabled,
  disableRepeatSeries,
  enableRepeatSeries,
  findRepeat,
  isRepeatDisabled,
  requireRepeatControl,
} from "./repeatControl";
import { retryJob } from "./retry";
import {
  DEBOUNCE_PREFIX,
  debounceIsPending,
  setReservedState,
  sweepWindows,
  THROTTLE_PREFIX,
} from "./windows";

/**
 * The queue a typed {@link BunJobs} context hands back for its registry queue:
 * `add` takes a declared name and exactly that name's payload.
 *
 * Reads — `getJob`, `getJobs`, `list`, `page` — and the events answer with a
 * `TypedJob`, discriminated by name: checking `job.name` narrows `job.data`
 * and `job.returnValue` to that name's types. Its `TData`/`TResult` are the
 * unions* of every declared job's, which is what remains for the methods
 * that take or give a payload with no name beside it.
 *
 * @typeParam TJobs The declared job map.
 */
export type RegistryQueue<TJobs extends JobMapOf<TJobs>> = BunQueue<
  JobMapData<TJobs>,
  JobMapResult<TJobs>,
  JobName<TJobs>,
  TJobs
>;

/** How many times a debounce or throttle retries a pointer it lost. */
const WINDOW_ATTEMPTS = 12;

/**
 * How long a debounce waits before looking again at a pointer whose job
 * another producer has not finished writing. Short enough that an add is not
 * noticeably held up, long enough that {@link WINDOW_ATTEMPTS} attempts span
 * an ordinary backend round trip rather than being spent in a spin.
 */
const WINDOW_RETRY_MS = 5;

/** How many finished jobs `retryAll` reads at a time. */
const RETRY_PAGE = 200;

/** How many retries `retryJobs` and `retryAll` send the driver at once. */
const RETRY_CONCURRENCY = 16;

/** How many jobs one `applyJobDefaults()` call examines when the caller names no `limit`. */
const DEFAULT_APPLY_LIMIT = 1_000;

/**
 * `queue.applyJobDefaults()` was asked to apply an override version that is
 * no longer the stored one: somebody saved or reset the queue's job defaults
 * since the caller read them. Nothing was written. Read them again, confirm,
 * and start the walk over with the new `seq`.
 *
 * The management API answers it with 409 `DEFAULTS_CHANGED`.
 */
export class JobDefaultsChangedError extends JobsError {
  /** The queue, the `seq` the caller asked to apply, and the `seq` stored now. */
  declare readonly context: {
    queue: string;
    expectedSeq: number;
    seq: number;
  };

  constructor(
    /** The queue whose defaults moved on. */
    queue: string,
    /** The version the caller asked to apply. */
    expectedSeq: number,
    /** The version stored now. */
    seq: number,
  ) {
    super(
      `The job defaults of queue "${queue}" changed since they were confirmed (applying seq ${expectedSeq}, stored seq ${seq})`,
      "DEFAULTS_CHANGED",
      { queue, expectedSeq, seq },
    );
  }
}

/**
 * Splits a `define()` definition's options into the layer a stored override
 * may replace — its editable job options (`JOB_DEFAULT_KEYS`) — and the rest
 * (`delay`, `runAt`, `repeat`, `deadLetter`, …), which describe the job and
 * stay merged under the call's options as before.
 *
 * The first is passed to {@link addDefinedJob} as `definition`, so a
 * definition's `attempts: 5` is a default a queue's stored override beats
 * (decision D3), not an option recorded as explicit.
 */
export function splitDefinitionDefaults(defaults: JobOptions): {
  /** The editable options, a layer under the override. */
  definition: JobOptions;
  /** Everything else, to merge under the call's own options. */
  rest: JobOptions;
} {
  const definition: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(defaults)) {
    if (isJobDefaultKey(key)) {
      definition[key] = value;
    } else {
      rest[key] = value;
    }
  }

  return { definition: definition as JobOptions, rest: rest as JobOptions };
}

/** Set by `BunQueue`'s static block: its private add, reachable from {@link addDefinedJob}. */
let addWithDefinition: (
  queue: BunQueue<unknown, unknown, string>,
  name: string,
  data: unknown,
  options: JobOptions | undefined,
  definition: JobOptions,
) => Promise<Job<unknown, unknown>>;

/**
 * Adds a job to `queue` with a `define()` definition's editable options as
 * their own layer — under the queue's stored override, over its
 * `defaultJobOptions` — rather than merged into the call's options, where
 * they would count as explicit. `options` are the call's own (with the
 * definition's other options already under them; see
 * {@link splitDefinitionDefaults}).
 *
 * How `JobBuilder` and `BunJobs` add a defined job. Internal: not re-exported
 * from the package.
 */
export async function addDefinedJob<TData, TResult>(
  queue: BunQueue<TData, TResult, string>,
  name: string,
  data: TData,
  options: JobOptions | undefined,
  definition: JobOptions,
): Promise<Job<TData, TResult>> {
  // The queue's own type parameters only constrain its public overloads;
  // the private add underneath takes any payload.
  return (await addWithDefinition(
    queue as unknown as BunQueue<unknown, unknown, string>,
    name,
    data,
    options,
    definition,
  )) as Job<TData, TResult>;
}

/** One node of a flow once it has been checked, with its queue and id fixed. */
interface PlannedFlowNode {
  /** The node as the caller gave it. */
  node: FlowNode;
  /** The queue it goes in. */
  queue: string;
  /** Its id: the caller's `jobId`, or one generated for it. */
  id: string;
  /** Its children, planned the same way, in the order given. */
  children: PlannedFlowNode[];
}

/**
 * The producer and management side of a queue.
 *
 * A queue is a name inside a namespace, and nothing more: it has no server,
 * no registration step and no owner. Producers and consumers find each other
 * because they name the same namespace and queue against the same backend,
 * which is why two services can share one Redis without agreeing on anything
 * beyond that.
 *
 * ```ts
 * const mail = new BunQueue("mail", { namespace: "account", driver });
 * await mail.add("welcome", { userId: 7 }, { attempts: 3 });
 * ```
 *
 * @typeParam TData What its jobs carry.
 * @typeParam TResult What running one answers with.
 * @typeParam TName The job names it takes, `string` by default.
 * @typeParam TJobs A declared job map, for the registry queue a typed
 * `BunJobs` hands back (see `RegistryQueue`): `add` then checks the name and
 * its payload, and reads and events answer with a `TypedJob`. The default,
 * `JobMap`, means none, and every signature is as it was.
 */
export class BunQueue<
  TData = unknown,
  TResult = unknown,
  TName extends string = string,
  TJobs extends JobMapOf<TJobs> = JobMap,
> extends TypedEmitterBase<
  QueueEventsOf<TData, TResult, TJobs>,
  BunQueueEvents<TData, TResult>
> {
  /** The queue's name within its namespace. */
  readonly name: string;
  /** The namespace it belongs to. */
  readonly namespace: string;
  /** Where jobs live. */
  readonly driver: JobsDriver;

  /** Identifies this instance, so it can ignore its own published events. */
  readonly #origin = newToken();
  /** Whether this instance built the driver and must close it. */
  readonly #ownsDriver: boolean;
  /** Defaults merged under every `add()`. */
  readonly #defaults?: JobOptions;
  /** How long a read of a queue's stored job defaults is trusted, ms. */
  readonly #jobDefaultsRefreshMs: number;
  /**
   * The stored job defaults as this producer last read them, one cache per
   * queue it adds to: its own, and any other queue a flow puts a node in.
   */
  readonly #jobDefaults = new Map<string, JobDefaultsCache>();
  /**
   * The last values read from each of those caches and until when they may
   * be used without asking the cache again — the synchronous fast path of
   * the add, so a warm add awaits nothing it did not await before.
   */
  readonly #freshDefaults = new Map<
    string,
    {
      /** The stored override's values. */
      values: JobDefaultsPatch;
      /** Epoch ms after which they must be read again. */
      until: number;
      /**
       * Epoch ms after which an add starts a background read ahead of
       * `until` — three quarters through the interval — so a busy producer
       * renews the answer before it expires and never awaits the read (C14).
       */
      renewAt: number;
    }
  >();

  /** Queues whose read-ahead is in flight, so an add starts at most one. */
  readonly #renewing = new Set<string>();
  /**
   * Bumped per queue by every prime (a write's own answer), so a read-ahead
   * that started before one cannot replace what it set when it lands.
   */
  readonly #primes = new Map<string, number>();

  /** Logger bound to this queue. */
  readonly #logger: Logger;
  /** Whether to re-emit other processes' events. */
  readonly #subscribe: boolean;
  /** Whether this queue announces its events to other processes. */
  readonly #publishes: boolean;
  /** Awaited before each publish; see `BunQueueOptions.publishGate`. */
  readonly #publishGate: (() => Promise<void>) | undefined;

  /** Cancels the cross-process subscription, once opened. */
  #unsubscribe?: () => Promise<void>;
  /** Whether `connect()` has run. */
  #connected = false;
  /** Whether `close()` has run. */
  #closed = false;

  constructor(name: string, options: BunQueueOptions) {
    super();

    this.name = assertSegment(name, "queue name");
    this.namespace = assertNamespace(options.namespace);

    const { driver, owned } = resolveDriver(options.driver);
    this.driver = driver;
    this.#ownsDriver = owned;
    this.#defaults = options.defaultJobOptions;
    // Built now, so a bad interval is refused by the constructor rather than
    // by the first add.
    const ownDefaults = new JobDefaultsCache(
      driver,
      { ns: this.namespace, queue: this.name },
      options.jobDefaultsRefreshInterval,
    );
    this.#jobDefaultsRefreshMs = ownDefaults.refreshMs;
    this.#jobDefaults.set(this.name, ownDefaults);
    this.dateParser =
      options.dateParser === undefined
        ? undefined
        : assertDateParser(options.dateParser);
    this.#subscribe = options.subscribe ?? false;
    // Defaults to `subscribe` so nothing changes for anyone relying on the
    // two being one flag; settable on its own so a producer can publish
    // without also paying for a subscription.
    this.#publishes = options.publish ?? this.#subscribe;
    this.#publishGate = options.publishGate;
    this.#logger = createJobsLogger(
      options.logger,
      { namespace: this.namespace, queue: this.name },
      `queue:${this.name}`,
    );
  }

  /**
   * What reads dates in phrases for jobs added here, when one was given;
   * otherwise `chrono-node` does.
   */
  readonly dateParser: DateParser | undefined;

  /** This queue's reference, as the driver wants it. */
  get ref(): QueueRef {
    return { ns: this.namespace, queue: this.name };
  }

  /** The queue's logger. */
  get logger(): Logger {
    return this.#logger;
  }

  /**
   * How long this queue trusts the stored job defaults it last read, ms
   * (`BunQueueOptions.jobDefaultsRefreshInterval`): how long a saved change
   * may take to reach its adds.
   */
  get jobDefaultsRefreshInterval(): number {
    return this.#jobDefaultsRefreshMs;
  }

  static {
    addWithDefinition = async (queue, name, data, options, definition) =>
      await queue.#add(name, data, options, definition);
  }

  /**
   * Connects the driver and, when asked, subscribes to other processes'
   * events. Called automatically by every method, so it is rarely needed
   * directly; idempotent either way.
   */
  async connect(): Promise<void> {
    if (this.#closed) {
      throw new QueueClosedError(this.name);
    }

    if (this.#connected) {
      return;
    }

    await this.driver.connect();
    // Started, not awaited, beside `ensureQueue`: the first add then finds
    // the stored job defaults already read (or joins the read in flight)
    // instead of adding a round trip of its own between its caller and the
    // job being stored. A failure here is the first add's to report, when it
    // reads again.
    void this.#readStoredDefaults(this.name).catch(() => undefined);
    await this.driver.ensureQueue(this.ref);
    this.#connected = true;

    if (this.#subscribe) {
      this.#unsubscribe = await this.driver.subscribe(
        this.namespace,
        "queue",
        this.name,
        (event) => {
          void this.#onRemoteEvent(event);
        },
      );
    }
  }

  /* --- producing ------------------------------------------------------ */

  /**
   * Adds a job.
   *
   * `jobId` doubles as an idempotency key: adding one that already exists
   * returns the stored job untouched with `wasAdded: false` and emits
   * `duplicate`, so a producer that retries cannot double-enqueue.
   *
   * With `repeat`, adding a series that is disabled (see
   * {@link BunQueue.disableRepeatable}) keeps it disabled. Its stored
   * definition is still replaced — schedule, time zone, limit, payload — so
   * enabling it later schedules from the new one. But no occurrence is added,
   * and nothing is announced: no `repeatScheduled` (nor `added`/`duplicate`)
   * is emitted locally or published to other instances. The job returned is
   * the occurrence that would have been scheduled, with `wasAdded: false`; it
   * is not stored, so `getJob(job.id)` answers `null`, while `job.enable()`
   * still restarts its series.
   */
  add<TAddName extends TypedJobName<TJobs>>(
    name: TAddName,
    ...args: JobAddArgs<JobDataOf<TJobs, TAddName>>
  ): Promise<TypedJob<TJobs, TAddName>>;
  /**
   * Adds a job under a name the registry does *not* declare — the escape
   * hatch a registry-bound queue keeps for work another deployment defines.
   *
   * Both type arguments are required: the name, then its payload. The name is
   * spelled twice because TypeScript cannot infer one type argument while
   * being told another, and it has to be a type argument for this overload to
   * refuse a declared name — without that, `add<Wrong>("send-report", wrong)`
   * would compile past the checked overload above. So a declared name, or a
   * plain `string` that could be one, makes this overload uncallable; and with
   * no type arguments the payload stays at its `never` default, so a typo'd
   * name cannot land here either.
   *
   * Only a deployment that defines the name can run such a job: this
   * service's own registry worker claims every job on its queue, and fails one
   * whose name it has no definition for. For ad-hoc work this service runs
   * itself, use a queue of its own — `jobs.queue<Payload>("scratch")` with a
   * `jobs.worker` on it.
   *
   * ```ts
   * await queue.add<"audit", { note: string }>("audit", { note: "one off" });
   * ```
   */
  add<
    TAdHocName extends string = never,
    TAdHoc = never,
    TAdHocResult = unknown,
  >(
    name: AdHocJobName<TJobs, TAdHocName>,
    ...args: JobAddArgs<NoInfer<TAdHoc>>
  ): Promise<Job<TAdHoc, TAdHocResult>>;
  /**
   * Adds a job to a queue with no declared registry — the signature this
   * method has always had. `UntypedJobName` collapses to `never` once a map is
   * declared, so a registry-bound queue cannot reach it. Re-adding a
   * disabled repeat series schedules nothing, as the first overload says.
   */
  add(
    name: UntypedJobName<TJobs> & TName,
    data: TData,
    options?: JobOptions,
  ): Promise<Job<TData, TResult>>;
  // The overloads above are the public surface; `any` here is the usual
  // implementation-signature widening, invisible to callers. The arguments
  // after the name are a plain rest because the checked overloads' are a
  // tuple TypeScript cannot relate to fixed parameters while it is generic.
  async add(name: string, ...args: unknown[]): Promise<Job<any, any>> {
    const [data, options] = args as [unknown, JobOptions | undefined];

    // Inside, the queue's own names for these two. Which overload was taken
    // has already decided that they agree.
    return await this.#add(name as TName, data as TData, options);
  }

  /**
   * The body of {@link add}, in the queue's own types. The class's internal
   * callers — `addBulk`, the debounce and throttle windows — come through here
   * rather than through the overloads, whose name parameters cannot be
   * resolved while `TJobs` is still a type parameter.
   */
  async #add(
    jobName: TName,
    payload: TData,
    options?: JobOptions,
    /** A `define()` definition's editable options, as their own layer; see `addDefinedJob`. */
    definition?: JobOptions,
  ): Promise<Job<TData, TResult>> {
    await this.connect();

    // The caller's own id, checked once, here — before any path below derives
    // an id of its own from it.
    if (options?.jobId !== undefined) {
      assertJobId(options.jobId, "jobId");
    }

    // So is a series key the caller chose, before anything is written: a bad
    // one must not leave a first occurrence behind with no series to own it.
    if (options?.repeat?.key !== undefined) {
      assertRepeatKey(options.repeat.key);
    }

    if (options?.debounce || options?.throttle) {
      return await this.#addWindowed(jobName, payload, options, definition);
    }

    if (options?.repeat) {
      return await this.#addRepeatable(jobName, payload, options, definition);
    }

    return await this.#addSimple(jobName, payload, options, definition);
  }

  /**
   * Adds one plain job — no window, no repeat — and emits for it.
   *
   * Split out of {@link BunQueue.add} so a windowed add can reach it with the
   * id it derived, without that id going back through the caller-facing check
   * at the top of `add` and being refused for looking like what it is.
   */
  async #addSimple(
    name: TName,
    data: TData,
    options?: JobOptions,
    /** A `define()` definition's editable options, as their own layer. */
    definition?: JobOptions,
    /** The stored job defaults, when the caller has already read them. */
    storedDefaults?: JobDefaultsPatch,
  ): Promise<Job<TData, TResult>> {
    const read = storedDefaults ?? this.#storedDefaults(this.name);
    // Awaited only when it is a read: a warm add awaits nothing new.
    const override = read instanceof Promise ? await read : read;
    const record = this.#buildRecord(name, data, options, undefined, {
      definition,
      override,
    });
    const { job, added } = await this.driver.addJob(this.ref, record);
    const view = this.#view(job, added);

    if (!added) {
      this.safeEmitScoped("duplicate", job.name, view);
      await this.#publish("duplicate", { id: job.id });
      return view;
    }

    this.safeEmitScoped("added", job.name, view);
    await this.#publish("added", { id: job.id });

    // Which of the two it is depends on whether it is claimable now, and a
    // remote listener has no way to work that out from `added` alone.
    if (job.state === "waiting") {
      this.safeEmitScoped("waiting", job.name, view);
      await this.#publish("waiting", { id: job.id });
    } else {
      this.safeEmitScoped("delayed", job.name, view, job.runAt);
      await this.#publish("delayed", { id: job.id, runAt: job.runAt });
    }

    return view;
  }

  /** Adds several jobs, each with the same per-id idempotency as `add()`. */
  async addBulk<TNames extends JobName<TJobs>[] | []>(
    entries: BulkEntriesOf<TData, TName, TJobs, TNames>,
  ): Promise<BulkJobsOf<TData, TResult, TJobs, TNames>> {
    const added = await this.#addBulk(
      entries as { name: TName; data: TData; opts?: JobOptions }[],
    );

    // The same objects in the same order; only the declared map can say what
    // each entry's name implies, and the signature is where it says it.
    return added as BulkJobsOf<TData, TResult, TJobs, TNames>;
  }

  /**
   * The body of {@link addBulk}, in the queue's own types. On a
   * registry-bound queue the entries were checked name by name at the call;
   * that check is a conditional type this generic body cannot resolve.
   */
  async #addBulk(
    entries: { name: TName; data: TData; opts?: JobOptions }[],
  ): Promise<Job<TData, TResult>[]> {
    await this.connect();

    // Every caller's id checked before anything is written, so one bad entry
    // does not leave the rest of the batch half-added.
    for (const entry of entries) {
      if (entry.opts?.jobId !== undefined) {
        assertJobId(entry.opts.jobId, "jobId");
      }

      if (entry.opts?.repeat?.key !== undefined) {
        assertRepeatKey(entry.opts.repeat.key);
      }
    }

    // A repeat is a definition plus a first occurrence, so it cannot be part
    // of a bulk insert; adding them one at a time keeps that explicit.
    if (entries.some((entry) => entry.opts?.repeat)) {
      const added: Job<TData, TResult>[] = [];
      for (const entry of entries) {
        added.push(await this.#add(entry.name, entry.data, entry.opts));
      }
      return added;
    }

    // One read of the stored defaults for the whole batch, at most.
    const read = this.#storedDefaults(this.name);
    const override = read instanceof Promise ? await read : read;
    const records = entries.map((entry) =>
      this.#buildRecord(entry.name, entry.data, entry.opts, undefined, {
        override,
      }),
    );
    const results = await this.driver.addJobs(this.ref, records);

    return results.map(({ job, added }) => {
      const view = this.#view(job, added);
      this.safeEmit(added ? "added" : "duplicate", view);
      return view;
    });
  }

  /* --- reading -------------------------------------------------------- */

  /**
   * One job by id, or `null`. On a registry-bound queue, a `TypedJob`:
   * checking its `name` narrows its data and result.
   */
  async getJob(id: string): Promise<QueueJobOf<TData, TResult, TJobs> | null> {
    const job = await this.#getJob(id);
    return job ? this.#typed(job) : null;
  }

  /** {@link getJob} as this class itself reads it, untyped by any map. */
  async #getJob(id: string): Promise<Job<TData, TResult> | null> {
    await this.connect();
    const record = await this.driver.getJob(this.ref, id);
    return record ? this.#view(record) : null;
  }

  /**
   * A job as this queue's callers see it: unchanged without a declared map,
   * and described as a `TypedJob` with one. The object is the same either way
   * — only a map can say what its name implies, and this is where it does.
   */
  #typed(job: Job<TData, TResult>): QueueJobOf<TData, TResult, TJobs> {
    return job as QueueJobOf<TData, TResult, TJobs>;
  }

  /**
   * Jobs in the given state(s), optionally narrowed to a name or a search.
   *
   * ```ts
   * await queue.list("dead", { name: "sendEmail", limit: 20 });
   * await queue.list(["waiting", "delayed"], { search: "invoice-42" });
   * await queue.list("completed", { workerKey: "emails", finishedFrom: Date.now() - 3_600_000 });
   * await queue.list("delayed", { sort: "createdAt", order: "desc" }); // newest first
   * ```
   *
   * Without a filter (`name`, `search`, `workerKey`, `workerId`,
   * `finishedFrom`, `finishedTo`) or `sort: "createdAt"` this is exactly the
   * read it always was. With one, `offset` and `limit` count matching jobs.
   * See {@link ListJobsOptions} for what each costs.
   *
   * Throws a `ConfigError`, rather than answering an empty page, for an empty
   * or inverted `finishedFrom`/`finishedTo` range, for `workerKey` or
   * `workerId` on a driver without `capabilities.jobAttribution` (a custom
   * one, or a SQL table from before the stamp's columns until `syncSchema()`
   * adds them), and for `sort: "createdAt"` on a driver that does not
   * implement `countAddedJobs` (Redis, file) — rather than a page silently in
   * the natural order.
   */
  async list(
    state: JobState | JobState[],
    options?: ListJobsOptions,
  ): Promise<QueueJobOf<TData, TResult, TJobs>[]> {
    await this.connect();

    const states = Array.isArray(state) ? state : [state];
    const query = this.#query(states, options);
    const records =
      jobFilter(query) === null &&
      attributionFilter(query) === null &&
      !sortsByCreated(query)
        ? await this.driver.listJobs(this.ref, states, {
            offset: options?.offset ?? 0,
            limit: options?.limit ?? 100,
            order: options?.order ?? "asc",
          })
        : (await findJobPage(this.driver, this.ref, query)).jobs;

    return records.map((record) => this.#typed(this.#view(record)));
  }

  /**
   * A page of jobs and how many matched in all — what a paginated table
   * needs, in one call.
   *
   * ```ts
   * const { jobs, total } = await queue.page("completed", { offset: 40, limit: 20 });
   * ```
   *
   * The total costs one count on top of the page: with no filter it is the
   * states' counts, and with one every job in those states is looked at.
   * Refuses the same filters {@link list} does.
   */
  async page(
    state: JobState | JobState[],
    options?: ListJobsOptions,
  ): Promise<JobsPage<TData, TResult, QueueJobOf<TData, TResult, TJobs>>> {
    await this.connect();

    const states = Array.isArray(state) ? state : [state];
    const query: JobQuery = { ...this.#query(states, options), total: true };
    const page = await findJobPage(this.driver, this.ref, query);

    // A driver's own `findJobs` may answer without the total it was asked
    // for. The page's length is not the total, so the scan counts it instead.
    const total =
      page.total ??
      (
        await findJobsByScan(this.driver, this.ref, {
          ...query,
          offset: 0,
          limit: 0,
        })
      ).total ??
      0;

    return {
      jobs: page.jobs.map((record) => this.#typed(this.#view(record))),
      total,
    };
  }

  /**
   * A driver query from a caller's list options. Each of these is a
   * `ConfigError` rather than an empty page, which would read as "nothing
   * matched" — the answers the API gives the same filters as 400s:
   *
   * - a bound that is not a valid date or timestamp;
   * - an empty or inverted range (`finishedTo` not after `finishedFrom`);
   * - `workerKey` or `workerId` on a driver without
   *   `capabilities.jobAttribution`, which has no stamp to match. A range
   *   alone needs no stamp and is answered everywhere;
   * - a `sort` that is not one of `JOB_LIST_SORTS`, and `"createdAt"` on a
   *   driver that does not implement `countAddedJobs` — the method whose
   *   presence promises the sort. Its `findJobs` would answer in the natural
   *   order, and the scan that could sort instead reads every job in the
   *   states on every page.
   *
   * Read after `connect()`: a SQL driver's capability is live, and settled by
   * connecting.
   */
  #query(states: JobState[], options: ListJobsOptions | undefined): JobQuery {
    const name = options?.name;
    const sort = options?.sort;
    const workerKey = options?.workerKey;
    const workerId = options?.workerId;
    const finishedFrom = listBound(options?.finishedFrom, "finishedFrom");
    const finishedTo = listBound(options?.finishedTo, "finishedTo");

    if (
      finishedFrom !== undefined &&
      finishedTo !== undefined &&
      finishedTo <= finishedFrom
    ) {
      throw new ConfigError(
        "finishedTo must be later than finishedFrom; finishedTo is exclusive, so an equal or earlier one is a range no job can finish in",
        { finishedFrom, finishedTo },
      );
    }

    if (
      (workerKey !== undefined || workerId !== undefined) &&
      this.driver.capabilities.jobAttribution !== true
    ) {
      throw new ConfigError(
        `This backend does not record which worker ran a job (driver "${this.driver.name}" reports capabilities.jobAttribution as false), so list() and page() cannot filter by workerKey or workerId: no job carries a stamp to match. On a SQL backend, run driver.syncSchema(), or construct the driver with syncSchema: true, to add the columns it needs.`,
        { driver: this.driver.name, capabilities: { jobAttribution: false } },
      );
    }

    if (
      sort !== undefined &&
      !(JOB_LIST_SORTS as readonly unknown[]).includes(sort)
    ) {
      throw new ConfigError(
        `sort must be one of ${JOB_LIST_SORTS.map((each) => `"${each}"`).join(", ")}`,
        { sort },
      );
    }

    if (sort === "createdAt" && !supportsCreatedSort(this.driver)) {
      throw new ConfigError(
        `This backend cannot order jobs by creation time (driver "${this.driver.name}" does not implement countAddedJobs, whose presence promises sort: "createdAt"), so list() and page() cannot take sort: "createdAt": its pages would come back in the natural order. Leave sort unset, or "natural", for the state's own order.`,
        { driver: this.driver.name, sort, needs: "countAddedJobs" },
      );
    }

    return {
      states,
      offset: options?.offset ?? 0,
      limit: options?.limit ?? 100,
      order: options?.order ?? "asc",
      ...(sort === "createdAt" ? { sort } : {}),
      ...(name === undefined
        ? {}
        : { names: Array.isArray(name) ? name : [name] }),
      ...(options?.search === undefined ? {} : { search: options.search }),
      ...(workerKey === undefined
        ? {}
        : { workerKeys: Array.isArray(workerKey) ? workerKey : [workerKey] }),
      ...(workerId === undefined
        ? {}
        : { workerIds: Array.isArray(workerId) ? workerId : [workerId] }),
      ...(finishedFrom === undefined ? {} : { finishedFrom }),
      ...(finishedTo === undefined ? {} : { finishedTo }),
    };
  }

  /**
   * Several jobs by id, in one round trip where the backend allows: one entry
   * per id, in the order given, `null` for an id with no job.
   */
  async getJobs(
    ids: string[],
  ): Promise<(QueueJobOf<TData, TResult, TJobs> | null)[]> {
    await this.connect();
    const records = await getJobsByIds(this.driver, this.ref, ids);

    return records.map((record) =>
      record ? this.#typed(this.#view(record)) : null,
    );
  }

  /**
   * The workers consuming this queue right now, in any process: each one's
   * id, host, pid, concurrency, jobs in flight, whether it is paused, when it
   * started and when it last reported.
   *
   * As fresh as each worker's last report — `reportInterval`, ten seconds by
   * default. A worker that died is listed until its record lapses, three
   * intervals after its last report.
   *
   * On a driver with no worker registry the records live in queue state; on
   * one with neither this throws {@link NotSupportedError}, as
   * `jobs.listWorkers()` does.
   */
  async listWorkers(): Promise<WorkerInfo[]> {
    await this.connect();

    if (!supportsWorkers(this.driver)) {
      throw new NotSupportedError(this.driver.name, "listWorkers", {
        needs: "listWorkers()",
      });
    }

    return await listWorkerRecords(this.driver, this.ref, Date.now());
  }

  /**
   * Completed jobs and failed attempts per minute, for the last `minutes`
   * minutes including the current one.
   *
   * ```ts
   * const { buckets, completed, failed } = await queue.getThroughput({ minutes: 15 });
   * ```
   *
   * Counted by the driver as jobs finish, so it covers every worker in every
   * process and survives retention removing the jobs themselves. Kept for a
   * day. On a backend that cannot count inside its completion write, a count
   * can arrive up to a second late — see the README.
   */
  async getThroughput(options?: {
    /** How many minutes, the current one included. Defaults to `60`; at most `1440`. */
    minutes?: number;
  }): Promise<QueueThroughput> {
    await this.connect();
    const driver = this.#requireDriver("getThroughput()", "getThroughput");

    const minutes = options?.minutes ?? 60;
    const most = THROUGHPUT_RETENTION_MS / THROUGHPUT_BUCKET_MS;

    if (!Number.isInteger(minutes) || minutes < 1 || minutes > most) {
      throw new ConfigError(
        `minutes must be a whole number from 1 to ${most}`,
        { minutes },
      );
    }

    const to = throughputBucket(Date.now());
    const from = to - (minutes - 1) * THROUGHPUT_BUCKET_MS;
    const stored = new Map(
      (await driver.getThroughput!(this.ref, { from, to })).map((bucket) => [
        bucket.at,
        bucket,
      ]),
    );

    const buckets: ThroughputBucket[] = [];
    let completed = 0;
    let failed = 0;

    for (let at = from; at <= to; at += THROUGHPUT_BUCKET_MS) {
      const bucket = stored.get(at);
      const entry = {
        at,
        completed: bucket?.completed ?? 0,
        failed: bucket?.failed ?? 0,
      };
      completed += entry.completed;
      failed += entry.failed;
      buckets.push(entry);
    }

    return {
      interval: THROUGHPUT_BUCKET_MS,
      from,
      to,
      buckets,
      completed,
      failed,
    };
  }

  /**
   * Of the jobs **added** to this queue in a range — created at or after
   * `from` and before `to` — how many are in each state **now**. Every state
   * is present, zero when none is in it.
   *
   * ```ts
   * const hour = await queue.countAdded({ from: Date.now() - 3_600_000, to: Date.now() });
   * // { waiting: 3, active: 1, completed: 40, dead: 2, ... }
   * ```
   *
   * **Only jobs still stored**: one retention (`removeOnComplete`,
   * `removeOnFail`) or a remove, clean or drain has deleted is not counted,
   * so on a queue that removes finished jobs `completed` and `dead`
   * undercount. `failed` is the state — failed, a retry pending — not failed
   * attempts; `getThroughput()` counts those, by when they happened.
   *
   * A `ConfigError` for a bound that is not a valid date or timestamp, or a
   * `to` not after `from`; a {@link NotSupportedError} (a `ConfigError` too)
   * on a driver without `countAddedJobs` (Redis, file). No span limit here:
   * the management API caps its routes at `MAX_ADDED_BY_STATE_SPAN_MS`.
   */
  async countAdded(range: {
    /** Start, **inclusive**: a `Date` or epoch ms. */
    from: Date | number;
    /** End, **exclusive**: a `Date` or epoch ms. Must be after `from`. */
    to: Date | number;
  }): Promise<Record<JobState, number>> {
    await this.connect();
    const from = addedBound(range.from, "from");
    const to = addedBound(range.to, "to");

    if (to <= from) {
      throw new ConfigError(
        "to must be later than from; to is exclusive, so an equal or earlier one is a range no job can be added in",
        { from, to },
      );
    }

    const counts = await countAdded(
      this.#requireDriver("countAdded()", "countAddedJobs"),
      this.ref.ns,
      { from, to },
      this.ref.queue,
    );

    return counts[this.ref.queue]!;
  }

  /** How many jobs are in each state, or in one state. */
  async count(): Promise<Record<JobState, number>>;
  async count(state: JobState): Promise<number>;
  async count(state?: JobState): Promise<Record<JobState, number> | number> {
    await this.connect();
    const counts = await this.driver.countJobs(this.ref);
    return state ? counts[state] : counts;
  }

  /* --- managing -------------------------------------------------------- */

  /** Removes a job. Refused while it is active. */
  async remove(id: string): Promise<boolean> {
    await this.connect();
    const removed = await this.driver.removeJob(this.ref, id);

    if (removed) {
      this.safeEmit("removed", id);
      await this.#publish("removed", { id });
    }

    return removed;
  }

  /**
   * Returns a finished job to the queue.
   *
   * A retry that went emits and publishes `retried` with `[id]`, the same
   * event `retryJobs` and `retryAll` send for a batch, so a listener or a
   * live-events job channel hears about one retry as it does about many. A
   * retry that changed nothing (an unknown id, a job not finished) sends
   * nothing.
   */
  async retry(
    id: string,
    options?: { resetAttempts?: boolean },
  ): Promise<boolean> {
    await this.connect();
    const retried = await this.#retryOne(
      id,
      options?.resetAttempts ?? true,
      Date.now(),
    );

    if (retried) {
      await this.#announceRetried([id]);
    }

    return retried;
  }

  /**
   * Retries one job. A parent that a child's failure buried goes back to
   * waiting on the children that have not settled, rather than running
   * without them; retry the failed child as well and the parent runs once it
   * completes.
   */
  async #retryOne(
    id: string,
    resetAttempts: boolean,
    now: number,
  ): Promise<boolean> {
    return await retryJob(this.driver, this.ref, id, resetAttempts, now);
  }

  /**
   * Adds a flow: a job and the jobs it waits on, to any depth.
   *
   * The whole tree is checked before anything is written: every job's queue,
   * its options, and that no `queue:id` appears twice anywhere in it — a
   * repeated id, or a child with the id of one of its ancestors, would leave a
   * parent waiting on an outcome that can never arrive.
   *
   * Jobs are then added **children first, each parent after its children**.
   * A parent's `createdAt` therefore postdates every child it lists, so the
   * grace period maintenance allows a missing child starts when the add
   * finished. A child that finishes before its parent exists is delivered as
   * soon as the parent arrives. An add interrupted part-way leaves children
   * with no parent, which maintenance releases to their own retention after
   * the grace period; running the same `addFlow` again, with the same ids,
   * adds only what is missing.
   *
   * Child ids are chosen up front, so the parent lists them. A job whose
   * `jobId` already exists keeps the children it already has: nothing is
   * added below it. Jobs in other queues of this namespace take this queue's
   * default options, and their `added` events are published on their own
   * queue.
   */
  async addFlow<TTop extends JobName<TJobs>>(
    node: FlowNodeOf<TData, TJobs, TTop>,
  ): Promise<
    FlowResult<TData, TResult, QueueJobOf<TData, TResult, TJobs, TTop>>
  > {
    await this.connect();
    this.#requireDriver(
      "addFlow()",
      "recordChild",
      "requeueParent",
      "markChildRecorded",
    );

    // On a registry-bound queue the node was checked name by name at the call;
    // the plan below reads it as the plain shape it is at runtime.
    const plan = this.#planFlow(node as FlowNode, this.name, new Set(), []);
    return (await this.#addFlowNode(plan, null)) as FlowResult<
      TData,
      TResult,
      QueueJobOf<TData, TResult, TJobs, TTop>
    >;
  }

  /**
   * Checks one node of a flow and everything below it, and fixes every id.
   * Throws a `ConfigError` before the caller has written anything.
   *
   * `seen` holds every `queue:id` placed in the tree so far; `ancestors` the
   * chain above this node, which only sharpens the message.
   */
  #planFlow(
    node: FlowNode,
    queueName: string,
    seen: Set<string>,
    ancestors: string[],
  ): PlannedFlowNode {
    const queue = assertSegment(queueName, "flow queue name");

    for (const option of ["repeat", "debounce", "throttle"] as const) {
      if (node.opts?.[option] !== undefined) {
        throw new ConfigError(`A job in a flow cannot use ${option}`, {
          name: node.name,
          option,
        });
      }
    }

    const id =
      node.opts?.jobId === undefined
        ? newId()
        : assertJobId(node.opts.jobId, "flow node jobId");
    const key = `${queue}:${id}`;

    if (seen.has(key)) {
      const ancestor = ancestors.includes(key);
      throw new ConfigError(
        ancestor
          ? `A job in a flow cannot be a child of itself: ${key} appears among its own ancestors`
          : `A flow cannot hold the same job twice: ${key} appears more than once`,
        { name: node.name, job: key, ancestors },
      );
    }
    seen.add(key);

    const children = (node.children ?? []).map((child) =>
      this.#planFlow(child, child.queue ?? queue, seen, [...ancestors, key]),
    );

    return { node, queue, id, children };
  }

  /** Adds one planned node of a flow: its children first, then itself. */
  async #addFlowNode(
    plan: PlannedFlowNode,
    parent: JobRef | null,
  ): Promise<FlowResult> {
    const { node, queue, id, children } = plan;
    const ref: QueueRef = { ns: this.namespace, queue };

    // A job that is already there keeps the children it already has, so none
    // are added below it — they could never be recorded on it.
    if (node.opts?.jobId !== undefined) {
      const existing = await this.driver.getJob(ref, id);
      if (existing) {
        const view = new Job(
          this.driver,
          ref,
          existing,
          false,
          this.#hooksFor(ref.queue),
        );
        await this.#announceAdded(view, false);
        return { job: view, children: [] };
      }
    }

    const results: FlowResult[] = [];
    for (const child of children) {
      results.push(await this.#addFlowNode(child, { queue, id }));
    }

    // Built after the children are in, so its `createdAt` follows theirs.
    // With the stored defaults of the node's own queue: a flow reaching k
    // queues reads at most k of them.
    const read = this.#storedDefaults(queue);
    const override = read instanceof Promise ? await read : read;
    const base = this.#buildRecord(
      node.name as TName,
      node.data as TData,
      { ...node.opts, jobId: id },
      undefined,
      { override },
    );
    const record: JobRecord = {
      ...base,
      state: children.length > 0 ? "waiting-children" : base.state,
      flow: {
        parent,
        children: children.map((child) => ({
          queue: child.queue,
          id: child.id,
        })),
        pending: children.length,
        values: {},
        failures: {},
        recorded: false,
      },
    };

    const { job, added } = await this.driver.addJob(ref, record);
    const view = new Job(
      this.driver,
      ref,
      job,
      added,
      this.#hooksFor(ref.queue),
    );
    await this.#announceAdded(view, added);

    return { job: view, children: added ? results : [] };
  }

  /**
   * Tells listeners about a job a flow added, by state: on this queue's own
   * emitter when it is in this queue, and published on its own queue either
   * way, so a listener there hears about it too.
   */
  async #announceAdded(view: Job<any, any>, added: boolean): Promise<void> {
    const queue = view.queue.queue;
    const local = queue === this.name;
    const job = view as Job<TData, TResult>;

    if (!added) {
      if (local) {
        this.safeEmitScoped("duplicate", view.name, job);
      }
      await this.#publish("duplicate", { id: view.id }, queue);
      return;
    }

    if (local) {
      this.safeEmitScoped("added", view.name, job);
    }
    await this.#publish("added", { id: view.id }, queue);

    if (view.state === "waiting") {
      if (local) {
        this.safeEmitScoped("waiting", view.name, job);
      }
      await this.#publish("waiting", { id: view.id }, queue);
    } else if (view.state === "delayed") {
      if (local) {
        this.safeEmitScoped("delayed", view.name, job, view.runAt);
      }
      await this.#publish("delayed", { id: view.id, runAt: view.runAt }, queue);
    }
  }

  /**
   * Returns several finished jobs to the queue, and answers with the ids that
   * went — an id that was missing, running or already pending is left out.
   */
  async retryJobs(
    ids: string[],
    options?: { resetAttempts?: boolean },
  ): Promise<string[]> {
    await this.connect();
    const retried = await this.#retryIds(ids, options?.resetAttempts ?? true);
    await this.#announceRetried(retried);
    return retried;
  }

  /**
   * Returns every finished job in a state that matches to the queue — the
   * re-drive for a dead-letter backlog once whatever killed it is fixed.
   *
   * ```ts
   * await queue.retryAll("dead", { reason: /ECONNREFUSED/ });
   * await queue.retryAll("dead", { name: "sendEmail", limit: 500 });
   * ```
   *
   * Walks the state a page at a time rather than loading it whole, so a
   * backlog of a million is as safe to re-drive as ten.
   */
  async retryAll<TRetryName extends string = JobName<TJobs>>(
    state: "dead" | "failed" | "completed",
    options?: RetryAllOptionsOf<TData, TResult, TJobs, TRetryName>,
  ): Promise<string[]> {
    await this.connect();

    // On a registry-bound queue `name` and `filter` were checked against each
    // other at the call; that check is a conditional type this generic body
    // cannot resolve, and at runtime the options are the plain shape.
    const selection = (options ?? {}) as RetryAllOptions<TData, TResult>;

    const limit = selection.limit ?? Number.POSITIVE_INFINITY;
    const reset = selection.resetAttempts ?? true;
    const retried: string[] = [];
    // Jobs that did not match stay in the state, so the next page starts after
    // them; jobs that were retried left it, so they are not counted.
    let offset = 0;

    while (retried.length < limit) {
      const page = await this.driver.listJobs(this.ref, [state], {
        offset,
        limit: RETRY_PAGE,
        order: "asc",
      });

      if (page.length === 0) {
        break;
      }

      const chosen: string[] = [];
      let skipped = 0;

      for (const record of page) {
        if (retried.length + chosen.length >= limit) {
          break;
        }

        if (this.#matchesRetry(record, selection)) {
          chosen.push(record.id);
        } else {
          skipped++;
        }
      }

      const done = await this.#retryIds(chosen, reset);
      retried.push(...done);
      offset += skipped;

      // A chosen job that was not retried has been taken by someone else and
      // left the state, so it shifts nothing. But a page that moved nothing at
      // all would be read again identically, forever; step past it instead.
      if (done.length === 0 && skipped === 0) {
        offset += page.length;
      }
    }

    await this.#announceRetried(retried);
    return retried;
  }

  /**
   * Changes a stored job's data, priority or run time, and answers with the
   * job as it now is — or `null` when there is no such job, or it is in a
   * state the patch cannot apply to.
   *
   * `runAt` moves only a waiting or delayed job. `onlyIn` makes the whole
   * change conditional on the job's state, checked in the same step as the
   * write.
   */
  async update(
    id: string,
    patch: {
      /**
       * The new payload. On a registry-bound queue, one valid for every
       * declared name (see `UpdateDataOf`): the id does not say which job
       * this is.
       */
      data?: UpdateDataOf<TData, TJobs>;
      /** The new priority. */
      priority?: number;
      /** When it may run: a `Date`, or epoch milliseconds. */
      runAt?: Date | number;
      /** Change it only while it is in one of these states. */
      onlyIn?: JobState[];
    },
  ): Promise<QueueJobOf<TData, TResult, TJobs> | null> {
    await this.connect();
    const driver = this.#requireDriver("update()", "updateJob");

    if (patch.priority !== undefined && !Number.isFinite(patch.priority)) {
      throw new ConfigError("priority must be a number", {
        priority: patch.priority,
      });
    }

    const runAt =
      patch.runAt instanceof Date ? patch.runAt.getTime() : patch.runAt;

    if (runAt !== undefined && !Number.isFinite(runAt)) {
      throw new ConfigError("runAt must be a valid date or timestamp", {
        runAt: patch.runAt,
      });
    }

    const record = await driver.updateJob!(
      this.ref,
      id,
      {
        ...(patch.data !== undefined
          ? { data: assertJsonSafe(patch.data, "job data") }
          : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(runAt !== undefined ? { runAt } : {}),
        ...(patch.onlyIn ? { onlyIn: patch.onlyIn } : {}),
      },
      Date.now(),
    );

    return record ? this.#typed(this.#view(record, false)) : null;
  }

  /**
   * Removes debounce and throttle pointers that no longer stand for anything
   * — a debounce whose job has started or gone, a throttle whose window has
   * closed — and answers with how many went.
   *
   * Workers do this on their own once a minute; this is the same thing on
   * demand. Safe while producers are adding: a pointer moved in the meantime
   * is left alone.
   */
  async cleanWindows(options?: {
    /** The most entries to examine. Defaults to `1000`. */
    limit?: number;
  }): Promise<number> {
    await this.connect();
    const driver = this.#requireDriver(
      "cleanWindows()",
      "listQueueState",
      "getQueueState",
      "setQueueState",
    );

    let remaining = Math.max(1, options?.limit ?? 1_000);
    let after: string | undefined;
    let removed = 0;

    while (remaining > 0) {
      const page = Math.min(remaining, 200);
      const sweep = await sweepWindows(driver, this.ref, {
        now: Date.now(),
        limit: page,
        ...(after !== undefined ? { after } : {}),
      });

      removed += sweep.removed;
      remaining -= page;

      if (sweep.next === undefined) {
        break;
      }

      after = sweep.next;
    }

    return removed;
  }

  /** A page of a job's log, oldest first unless asked otherwise. */
  async getJobLogs(
    id: string,
    options?: {
      /** Lines to skip. Defaults to `0`. */
      offset?: number;
      /** Lines to return. Defaults to `100`. */
      limit?: number;
      /** `asc` is oldest first, the default. */
      order?: "asc" | "desc";
    },
  ): Promise<{ logs: string[]; count: number }> {
    await this.connect();
    const driver = this.#requireDriver("getJobLogs()", "getJobLogs");

    return await driver.getJobLogs!(this.ref, id, {
      offset: options?.offset ?? 0,
      limit: options?.limit ?? 100,
      order: options?.order ?? "asc",
    });
  }

  /**
   * Empties a job's log, answering how many lines went.
   *
   * Refused while the job is `active` — `{ status: "active" }`, nothing
   * removed — for the reason removing an active job is: its worker is still
   * writing the log, and clearing it would leave one that looks whole while
   * missing its start. The driver checks that in the same step as the
   * removal, so there is no window between a read and the clear. An unknown
   * id is `{ status: "missing" }`.
   *
   * Afterwards the log reads as never written: `getJobLogs` counts `0`, the
   * next `job.log()` answers `1`, and `keepLogs` trims from there. The job
   * itself, its state and every counter are untouched, and no event is sent.
   * Throws `NotSupportedError` on a driver without `clearJobLogs`.
   */
  async clearJobLogs(id: string): Promise<ClearJobLogsResult> {
    await this.connect();
    const driver = this.#requireDriver("clearJobLogs()", "clearJobLogs");
    return await driver.clearJobLogs!(this.ref, id);
  }

  /** Makes a delayed or retry-pending job claimable now. */
  async promote(id: string): Promise<boolean> {
    await this.connect();
    const promoted = await this.driver.promoteJob(this.ref, id, Date.now());

    if (promoted) {
      this.safeEmit("promoted", id);
      await this.#publish("promoted", { id });
    }

    return promoted;
  }

  /**
   * Sets the queue's limits for every worker in every process, or removes
   * them with `null`.
   *
   * ```ts
   * await queue.setLimits({
   *   rate: { max: 100, duration: "1 minute" },
   *   concurrency: 20,
   *   names: { sendEmail: { concurrency: 5 } },
   * });
   * ```
   *
   * Stored on the queue, so a worker started tomorrow in another process
   * enforces the same numbers, and a change reaches running workers within
   * their `limitsRefreshInterval`. Enforcement is approximate — see
   * `QueueLimiter` — and a name at its limit is skipped, not waited behind.
   */
  async setLimits(limits: QueueLimits | null): Promise<void> {
    await this.connect();
    const driver = this.#limitsDriver();
    const stored = limits === null ? null : normalizeLimits(limits);

    for (let attempt = 0; attempt < 12; attempt++) {
      const current = await driver.getQueueState!(this.ref, LIMITS_STATE);

      if (stored === null && !current) {
        return;
      }

      const written = await driver.setQueueState!(
        this.ref,
        LIMITS_STATE,
        stored,
        current?.version ?? null,
      );

      if (written !== null) {
        return;
      }
    }

    throw new ConfigError(
      `Could not store limits for queue "${this.name}": they kept changing underneath`,
      { queue: this.name },
    );
  }

  /** The queue's stored limits, with durations in milliseconds, or `null`. */
  async getLimits(): Promise<StoredLimits | null> {
    await this.connect();
    const entry = await this.#limitsDriver().getQueueState!(
      this.ref,
      LIMITS_STATE,
    );
    return (entry?.value as StoredLimits | undefined) ?? null;
  }

  /** The driver, checked to be able to store limits. */
  #limitsDriver(): JobsDriver {
    if (!QueueLimiter.supports(this.driver)) {
      throw new ConfigError(
        `The ${this.driver.name} driver cannot store queue limits: it does not implement getQueueState and setQueueState`,
        { driver: this.driver.name },
      );
    }

    return this.driver;
  }

  /* --- job defaults --------------------------------------------------- */

  /**
   * The queue's job defaults: what this queue's code asks for
   * (`defaultJobOptions` over the built-ins), the stored override every
   * producer adds under, and what a job passing none of the options gets.
   *
   * Always reads the stored override afresh (and refreshes this queue's
   * cache with it). On a driver without queue state there is never an
   * override: `seq` is `0` and `override` `{}`.
   */
  async getJobDefaults(): Promise<JobDefaultsInfo> {
    await this.connect();
    const stored = await readJobDefaults(this.driver, this.ref);
    this.#primeStoredDefaults(this.name, stored);
    return this.#describeJobDefaults(stored);
  }

  /**
   * Merges `update` into the queue's stored job defaults: a key left out is
   * untouched, `null` clears it so the code's value applies again. Every
   * producer on every process adds under the result within its
   * `jobDefaultsRefreshInterval` (this queue at once). An option passed
   * explicitly on an `add()` still wins over it.
   *
   * Jobs already pending keep what they were given; `applyJobDefaults()`
   * rewrites them. An unknown key or a value outside `JOB_DEFAULTS_BOUNDS` is
   * a `ConfigError`, before anything is written; a driver without queue state
   * throws `NotSupportedError`. With `expectedSeq`, a write that finds the
   * override moved on changes nothing and answers `contended: true`.
   */
  async setJobDefaults(
    update: Readonly<JobDefaultsUpdate>,
    options?: JobDefaultsWriteOptions,
  ): Promise<JobDefaultsWriteResult> {
    await this.connect();
    const { stored, contended } = await writeJobDefaults(
      this.driver,
      this.ref,
      update,
      {
        ...(options?.expectedSeq === undefined
          ? {}
          : { expectedSeq: options.expectedSeq }),
        ...(options?.by === undefined ? {} : { by: options.by }),
      },
    );
    this.#primeStoredDefaults(this.name, stored);
    return { ...this.#describeJobDefaults(stored), contended };
  }

  /**
   * Clears every key of the queue's stored job defaults, so jobs added from
   * now on get the code's values again. Stored as an empty override rather
   * than deleted, so `seq` keeps rising. **Jobs already pending keep what they
   * were given** — including jobs `applyJobDefaults()` rewrote, whose earlier
   * values nothing kept.
   */
  async resetJobDefaults(
    options?: JobDefaultsWriteOptions,
  ): Promise<JobDefaultsWriteResult> {
    await this.connect();
    const { stored, contended } = await resetJobDefaults(
      this.driver,
      this.ref,
      {
        ...(options?.expectedSeq === undefined
          ? {}
          : { expectedSeq: options.expectedSeq }),
        ...(options?.by === undefined ? {} : { by: options.by }),
      },
    );
    this.#primeStoredDefaults(this.name, stored);
    return { ...this.#describeJobDefaults(stored), contended };
  }

  /**
   * Rewrites jobs already pending with the stored override's values — one
   * bounded call of a resumable walk: loop on the answer's `next` until it is
   * `null`. Irreversible: a rewritten job's earlier values are not kept.
   *
   * - Each call re-reads the stored override and throws
   *   {@link JobDefaultsChangedError} when its `seq` is no longer `options.seq`,
   *   writing nothing — so a walk of many calls applies one version or stops.
   * - Only keys the override sets are written (`keys` narrows them), never a
   *   key a job's own `add()` passed, and never a job without the explicit
   *   record unless `includeUnmarked`.
   * - Walks `waiting`, `delayed`, `failed` and `waiting-children` (or
   *   `states`) in claim order; `active`, `completed` and `dead` never.
   *
   * Throws `ConfigError` when the override sets nothing (or `keys` names a key
   * it does not set), and `NotSupportedError` when the driver has no queue
   * state or no `rewritePendingOptions`.
   */
  async applyJobDefaults(
    options: ApplyJobDefaultsOptions,
  ): Promise<ApplyJobDefaultsResult> {
    await this.connect();

    if (!supportsJobDefaults(this.driver)) {
      throw new NotSupportedError(this.driver.name, "setQueueState", {
        needs: "applyJobDefaults()",
      });
    }

    const driver = this.#requireDriver(
      "applyJobDefaults()",
      "rewritePendingOptions",
    );

    if (!Number.isInteger(options.seq) || options.seq < 0) {
      throw new ConfigError("seq must be a whole number, 0 or more", {
        seq: options.seq,
      });
    }

    const stored = await readJobDefaults(driver, this.ref);
    this.#primeStoredDefaults(this.name, stored);

    if (stored.seq !== options.seq) {
      throw new JobDefaultsChangedError(this.name, options.seq, stored.seq);
    }

    const overridden = overriddenKeys(stored.values);

    if (overridden.length === 0) {
      throw new ConfigError(
        `The job defaults of queue "${this.name}" override nothing, so there is nothing to apply`,
        { queue: this.name, seq: stored.seq },
      );
    }

    let keys: EditableJobOptionKey[] = overridden;

    if (options.keys !== undefined) {
      for (const key of options.keys) {
        if (!isJobDefaultKey(key)) {
          throw new ConfigError(
            `"${String(key)}" is not an editable job option`,
            {
              key,
              keys: JOB_DEFAULT_KEYS,
            },
          );
        }

        if (!overridden.includes(key)) {
          throw new ConfigError(
            `The job defaults of queue "${this.name}" do not override "${key}", so it cannot be applied`,
            { key, overridden },
          );
        }
      }

      keys = overridden.filter((key) => options.keys!.includes(key));

      if (keys.length === 0) {
        throw new ConfigError("keys must name at least one overridden key", {
          keys: options.keys,
          overridden,
        });
      }
    }

    const values: JobDefaultsPatch = {};
    for (const key of keys) {
      (values as Record<string, unknown>)[key] = stored.values[key];
    }

    const dryRun = options.dryRun ?? false;
    const states = options.states
      ? [...options.states]
      : [...JOB_DEFAULTS_APPLY_STATES];
    // The cursor handed out names this walk, and one from any other walk —
    // another queue's, another version's, other states or keys — is refused
    // rather than resumed from a position that means nothing here (B15).
    const walk = {
      ns: this.namespace,
      queue: this.name,
      seq: stored.seq,
      states,
      keys,
    };
    const result = await driver.rewritePendingOptions!(this.ref, {
      states,
      values,
      cursor:
        options.cursor === undefined || options.cursor === null
          ? null
          : openWalkCursor(walk, options.cursor),
      limit: options.limit ?? DEFAULT_APPLY_LIMIT,
      includeUnmarked: options.includeUnmarked ?? false,
      dryRun,
      now: Date.now(),
    });

    return {
      ...result,
      next: result.next === null ? null : sealWalkCursor(walk, result.next),
      seq: stored.seq,
      keys,
      dryRun,
    };
  }

  /**
   * The stored job defaults of `queue` (this one, or a flow node's): the
   * values themselves, synchronously, while this queue's last read is
   * fresh — so a warm add pays no round trip **and no extra await**, and
   * keeps exactly the timing it had before job defaults existed — otherwise
   * a promise of one read through the queue's {@link JobDefaultsCache}.
   */
  #storedDefaults(queue: string): JobDefaultsPatch | Promise<JobDefaultsPatch> {
    const fresh = this.#freshDefaults.get(queue);

    if (fresh !== undefined) {
      const now = Date.now();

      if (now < fresh.until) {
        if (now >= fresh.renewAt && !this.#renewing.has(queue)) {
          this.#renewStoredDefaults(queue, now);
        }

        return fresh.values;
      }
    }

    return this.#readStoredDefaults(queue);
  }

  /**
   * Reads `queue`'s stored job defaults ahead of expiry, in the background,
   * and makes the answer the fresh one. Never awaited by an add; a read that
   * fails leaves the current answer to expire, and the add after that reads
   * (and reports) as it always has.
   */
  #renewStoredDefaults(queue: string, now: number): void {
    this.#renewing.add(queue);
    const primes = this.#primes.get(queue) ?? 0;
    void this.#jobDefaultsFor(queue)
      .refresh(now)
      .then((stored) => {
        if ((this.#primes.get(queue) ?? 0) === primes) {
          this.#freshDefaults.set(queue, this.#freshEntry(stored.values, now));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.#renewing.delete(queue);
      });
  }

  /** A fast-path entry for values read at `now`. */
  #freshEntry(
    values: JobDefaultsPatch,
    now: number,
  ): { values: JobDefaultsPatch; until: number; renewAt: number } {
    const refresh = this.#jobDefaultsRefreshMs;
    return {
      values,
      until: now + refresh,
      renewAt: now + Math.floor((refresh * 3) / 4),
    };
  }

  /**
   * One read of `queue`'s stored job defaults through its cache (which
   * shares a read in flight), remembered for the synchronous path until the
   * refresh interval has passed since the read began.
   */
  async #readStoredDefaults(queue: string): Promise<JobDefaultsPatch> {
    const now = Date.now();
    const values = await this.#jobDefaultsFor(queue).get(now);

    if (this.#jobDefaultsRefreshMs > 0) {
      this.#freshDefaults.set(queue, this.#freshEntry(values, now));
    }

    return values;
  }

  /**
   * Replaces `queue`'s cached stored job defaults with what a write (or a
   * fresh read) just returned, so this queue's own adds use it at once.
   */
  #primeStoredDefaults(queue: string, stored: StoredJobDefaults): void {
    const now = Date.now();
    this.#primes.set(queue, (this.#primes.get(queue) ?? 0) + 1);
    this.#jobDefaultsFor(queue).prime(stored, now);

    if (this.#jobDefaultsRefreshMs > 0) {
      this.#freshDefaults.set(queue, this.#freshEntry(stored.values, now));
    } else {
      this.#freshDefaults.delete(queue);
    }
  }

  /** The cache of `queue`'s stored job defaults, made on first use. */
  #jobDefaultsFor(queue: string): JobDefaultsCache {
    let cache = this.#jobDefaults.get(queue);

    if (!cache) {
      cache = new JobDefaultsCache(
        this.driver,
        { ns: this.namespace, queue },
        this.#jobDefaultsRefreshMs,
      );
      this.#jobDefaults.set(queue, cache);
    }

    return cache;
  }

  /** `stored` described against this queue's own code defaults. */
  #describeJobDefaults(stored: StoredJobDefaults): JobDefaultsInfo {
    return {
      ...describeJobDefaults(
        resolveJobOptions(this.#defaults, undefined),
        stored,
      ),
      propagationMs: this.#jobDefaultsRefreshMs,
    };
  }

  /** Stops every worker on every process from claiming. */
  async pause(): Promise<void> {
    await this.connect();
    await this.driver.pauseQueue(this.ref);
    this.safeEmit("paused");
    await this.#publish("paused", {});
  }

  /** Lets workers claim again. */
  async resume(): Promise<void> {
    await this.connect();
    await this.driver.resumeQueue(this.ref);
    this.safeEmit("resumed");
    await this.#publish("resumed", {});
  }

  /** Whether claiming is paused. */
  async isPaused(): Promise<boolean> {
    await this.connect();
    return await this.driver.isQueuePaused(this.ref);
  }

  /** Drops pending jobs. Never touches what a worker is already running. */
  async drain(options?: { delayed?: boolean }): Promise<number> {
    await this.connect();
    const removed = await this.driver.drainQueue(
      this.ref,
      options?.delayed ?? false,
    );

    this.safeEmit("drained", removed);
    await this.#publish("drained", { count: removed });
    return removed;
  }

  /**
   * Removes jobs in `state` older than `olderThan` milliseconds. Cleaning
   * `waiting-children` removes parents only; their children stay.
   */
  async clean(
    state:
      | "completed"
      | "failed"
      | "dead"
      | "waiting"
      | "delayed"
      | "waiting-children",
    options: { olderThan: number; limit?: number },
  ): Promise<string[]> {
    await this.connect();

    const removed = await this.driver.cleanJobs(
      this.ref,
      state,
      options.olderThan,
      options.limit ?? 1000,
      Date.now(),
    );

    if (removed.length > 0) {
      this.safeEmit("cleaned", removed, state);
      await this.#publish("cleaned", { ids: removed, state });
    }

    return removed;
  }

  /* --- repeats ---------------------------------------------------------- */

  /**
   * Every repeat definition in this queue, each with whether it is
   * `disabled`. A disabled series reports `nextRunAt` and `nextJobId` as
   * `null`: it has no next occurrence until it is enabled.
   */
  async listRepeatables(): Promise<RepeatableInfo[]> {
    await this.connect();
    const stored = await this.driver.listRepeats(this.ref);

    // Shown as the caller named it. `removeRepeatable` takes either spelling,
    // so a key from here can be handed straight back.
    return await Promise.all(
      stored.map(async (record) => {
        const disabled = await isRepeatDisabled(
          this.driver,
          this.ref,
          record.key,
        );
        return {
          ...record,
          key: displayRepeatKey(record.key),
          // Disabling clears both in the stored record. Null here too, so an
          // occurrence a worker raced past the flag — pointed to until
          // maintenance removes it — is not reported as the series' next.
          ...(disabled ? { nextRunAt: null, nextJobId: null } : {}),
          disabled,
        };
      }),
    );
  }

  /**
   * Removes a repeat definition and the occurrence it had scheduled, and
   * clears its disabled flag, so a series added again under the same key
   * starts enabled.
   *
   * Takes either spelling of the key: as `listRepeatables()` reports it, or
   * as the caller gave it to `repeat.key`.
   */
  async removeRepeatable(key: string): Promise<boolean> {
    await this.connect();
    const definition = await findRepeat(this.driver, this.ref, key);

    if (!definition) {
      return false;
    }

    if (definition.nextJobId) {
      await this.driver.removeJob(this.ref, definition.nextJobId);
    }

    const removed = await this.driver.removeRepeat(this.ref, definition.key);
    await clearRepeatDisabled(this.driver, this.ref, definition.key);
    return removed;
  }

  /**
   * Stops a repeat series: its pending occurrence is removed and no further
   * one is scheduled, until {@link BunQueue.enableRepeatable}. The series
   * stays, listed as `disabled`. An occurrence already running finishes.
   *
   * Takes either spelling of the key, as `removeRepeatable` does. Answers
   * whether this call disabled it — `false` for an unknown key or a series
   * already disabled. Needs a driver with queue state: without it this
   * throws `NotSupportedError`, whatever the key.
   */
  async disableRepeatable(key: string): Promise<boolean> {
    await this.connect();
    requireRepeatControl(this.driver, "disableRepeatable()");
    const definition = await findRepeat(this.driver, this.ref, key);

    return definition
      ? await disableRepeatSeries(
          this.driver,
          this.ref,
          definition.key,
          Date.now(),
          "disableRepeatable()",
        )
      : false;
  }

  /**
   * Restarts a series {@link BunQueue.disableRepeatable} stopped, scheduling
   * its next occurrence from now: nothing it missed while disabled is run.
   * Answers whether this call enabled it — `false` for an unknown key or a
   * series that was not disabled. Needs a driver with queue state: without
   * it this throws `NotSupportedError`, whatever the key.
   */
  async enableRepeatable(key: string): Promise<boolean> {
    await this.connect();
    requireRepeatControl(this.driver, "enableRepeatable()");
    const definition = await findRepeat(this.driver, this.ref, key);

    if (!definition) {
      return false;
    }

    const enabled = await enableRepeatSeries(
      this.driver,
      this.ref,
      definition.key,
      Date.now(),
      "enableRepeatable()",
    );

    if (enabled) {
      const next = await this.driver.getRepeat(this.ref, definition.key);
      if (next?.nextRunAt != null) {
        const shown = displayRepeatKey(definition.key);
        this.safeEmit("repeatScheduled", shown, next.nextRunAt);
        await this.#publish("repeatScheduled", {
          key: shown,
          nextRunAt: next.nextRunAt,
        });
      }
    }

    return enabled;
  }

  /** Closes the subscription and, if this queue built the driver, the driver. */
  async close(): Promise<void> {
    this.#closed = true;

    await this.#unsubscribe?.();
    this.#unsubscribe = undefined;

    // Counts the driver gathered in memory, whether or not this queue owns it:
    // a process sharing one driver may exit without ever closing it.
    try {
      await this.driver.flushThroughput?.();
    } catch (error) {
      this.#logger.warn("Could not write throughput counts", { error });
    }
    // The analytics buckets the driver counted beside them, for the same
    // reason: a queue's per-second and per-minute job series live there.
    try {
      await this.driver.flushMetrics?.();
    } catch (error) {
      this.#logger.warn("Could not write analytics counts", { error });
    }

    if (this.#ownsDriver) {
      await this.driver.close();
    }
  }

  /* --- internals --------------------------------------------------------- */

  /**
   * Adds a debounced or throttled job.
   *
   * Both keep a pointer per id in queue state — the job that currently stands
   * for that id — and move it with a compare-and-set, which is what keeps a
   * crowd of producers adding at once down to one job:
   *
   * - **Debounce** replaces a pointed-to job's data and pushes its run time
   *   back, but only while it is still waiting or delayed (checked in the same
   *   step as the write). A job that has started, or is gone, is replaced.
   * - **Throttle** answers with the pointed-to job while its window is open,
   *   and otherwise opens a new window with a new job.
   *
   * The pointer is moved *before* the job is added. A crash between the two
   * leaves a pointer to a job that does not exist, which the next add treats
   * exactly like a finished one; the reverse order could leave a second job.
   */
  async #addWindowed(
    name: TName,
    data: TData,
    options: JobOptions,
    /** A `define()` definition's editable options, as their own layer. */
    definition?: JobOptions,
  ): Promise<Job<TData, TResult>> {
    const kind = options.debounce ? "debounce" : "throttle";
    const window = (options.debounce ?? options.throttle)!;

    if (options.debounce && options.throttle) {
      throw new ConfigError("A job cannot be both debounced and throttled", {
        debounce: options.debounce,
        throttle: options.throttle,
      });
    }

    if (options.repeat || options.jobId !== undefined) {
      throw new ConfigError(
        `${kind} cannot be combined with ${options.repeat ? "repeat" : "jobId"}: it chooses the job's id itself`,
        { [kind]: window },
      );
    }

    if (typeof window.id !== "string" || window.id.length === 0) {
      throw new ConfigError(`${kind}.id is required`, { [kind]: window });
    }

    // The window id is a caller's, and becomes both a queue-state key and part
    // of the job's id, so it is held to the same rules as any other.
    assertJobId(window.id, `${kind}.id`);

    const ttl =
      typeof window.ttl === "string" ? parseDuration(window.ttl) : window.ttl;

    if (ttl === null || !Number.isFinite(ttl) || ttl <= 0) {
      throw new ConfigError(
        `${kind}.ttl must be a positive number of milliseconds or a duration such as "30 seconds"`,
        { ttl: window.ttl },
      );
    }

    const driver = this.#requireDriver(
      `add({ ${kind} })`,
      "getQueueState",
      "setQueueState",
      "updateJob",
    );
    const {
      debounce: _debounce,
      throttle: _throttle,
      delay: _delay,
      runAt: _runAt,
      ...rest
    } = options;
    // Fitted like any name this package derives, so a legal window id always
    // makes a storable pointer name. The prefix is at the head and survives
    // fitting, which is how `sweepWindows` still finds it.
    const pointerName = fitName(
      `${kind === "debounce" ? DEBOUNCE_PREFIX : THROTTLE_PREFIX}${window.id}`,
      DERIVED_NAME_LIMITS,
    );
    // Read before the pointer can move, never between moving it and storing
    // the job it names: other producers read a moved pointer whose job is not
    // there yet as "not yet written" and retry, so that gap must stay as
    // short as it was.
    const read = this.#storedDefaults(this.name);
    const override = read instanceof Promise ? await read : read;

    for (let attempt = 0; attempt < WINDOW_ATTEMPTS; attempt++) {
      const now = Date.now();
      const pointer = await driver.getQueueState!(this.ref, pointerName);
      const current = pointer?.value as
        | (DebouncePointer & { until?: number })
        | undefined;

      if (current && kind === "debounce") {
        const updated = await driver.updateJob!(
          this.ref,
          current.jobId,
          {
            data: assertJsonSafe(data, "job data"),
            runAt: now + ttl,
            onlyIn: ["waiting", "delayed"],
          },
          now,
        );

        if (updated) {
          const view = this.#view(updated, false);
          this.safeEmitScoped("debounced", name, view);
          await this.#publish("debounced", { id: updated.id });
          return view;
        }

        // A `null` should mean the pending job has started or is gone, and
        // only then may the window move to a new one. But a driver can also
        // answer `null` because it could not get at the job in time — the file
        // driver gives up on a marker somebody else holds — and replacing the
        // job then would leave two where the caller asked for one. So look:
        // still waiting or delayed means the update simply did not land, and
        // it is tried again.
        const pending = await this.driver.getJob(this.ref, current.jobId);
        if (pending?.state === "waiting" || pending?.state === "delayed") {
          continue;
        }

        // No job at all, under a pointer nobody has confirmed: another
        // producer moved it a moment ago and has not finished writing the job
        // it names. Treating that as a finished job and opening a window of
        // our own is exactly what leaves two jobs where the caller asked for
        // one, so wait a beat and read again. A pointer that stays unconfirmed
        // past `WINDOW_PENDING_MS` belongs to a producer that died, and falls
        // through to be replaced as it always was.
        if (!pending && debounceIsPending(current, now)) {
          await sleep(WINDOW_RETRY_MS, { unref: true }).catch(() => undefined);
          continue;
        }
      }

      if (current && kind === "throttle" && (current.until ?? 0) > now) {
        const existing = await this.driver.getJob(this.ref, current.jobId);

        if (existing) {
          const view = this.#view(existing, false);
          this.safeEmitScoped("throttled", name, view);
          await this.#publish("throttled", { id: existing.id });
          return view;
        }
      }

      // The pointer name keeps its literal prefix — `sweepWindows` finds it by
      // that — but the job's own id may be shortened to fit.
      const jobId = shortenJobId(`${pointerName}:${newId()}`);
      const moved = await setReservedState(
        driver,
        this.ref,
        pointerName,
        kind === "throttle"
          ? { jobId, until: now + ttl }
          : ({ jobId, at: now } satisfies DebouncePointer),
        pointer?.version ?? null,
      );

      if (moved === null) {
        // Another producer moved the pointer first: its job is now the one to
        // debounce into, or the window it opened is the one to respect.
        continue;
      }

      const added = await this.#addSimple(
        name,
        data,
        {
          ...rest,
          jobId,
          ...(kind === "debounce"
            ? { runAt: now + ttl }
            : options.runAt !== undefined
              ? { runAt: options.runAt }
              : options.delay !== undefined
                ? { delay: options.delay }
                : {}),
        },
        definition,
        override,
      );

      if (kind === "debounce") {
        // The job exists now, so confirm the pointer that named it before it
        // did. This is what gives everyone else's compare-and-set something to
        // catch: until the version moves, a sweep or a second producer that
        // read the unconfirmed pointer would judge it by a job that was not
        // there yet, and delete or replace a live window. One extra write per
        // window *opened* — never per debounced add, which is the path that
        // repeats. A pointer somebody else has already moved fails the
        // compare-and-set and is left as theirs.
        await setReservedState(
          driver,
          this.ref,
          pointerName,
          { jobId, at: now, ready: true } satisfies DebouncePointer,
          moved,
        );
      }

      return added;
    }

    throw new ConfigError(
      `Could not ${kind} "${window.id}": it kept changing underneath`,
      { [kind]: window },
    );
  }

  /** The driver, checked to implement the optional methods a feature needs. */
  #requireDriver(
    what: string,
    ...methods: (keyof JobsDriver & string)[]
  ): JobsDriver {
    for (const method of methods) {
      if (typeof this.driver[method] !== "function") {
        // A `ConfigError` still — `NotSupportedError` extends it and keeps the
        // `CONFIG` code — but one that says which driver lacks which method in
        // its type as well as its text, so a caller can branch on it.
        throw new NotSupportedError(this.driver.name, method, { needs: what });
      }
    }

    return this.driver;
  }

  /** Retries ids a bounded number at a time, and answers with those that went. */
  async #retryIds(ids: string[], resetAttempts: boolean): Promise<string[]> {
    const now = Date.now();
    const retried: string[] = [];

    for (let at = 0; at < ids.length; at += RETRY_CONCURRENCY) {
      const chunk = ids.slice(at, at + RETRY_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((id) => this.#retryOne(id, resetAttempts, now)),
      );

      chunk.forEach((id, index) => {
        if (results[index]) {
          retried.push(id);
        }
      });
    }

    return retried;
  }

  /** Whether a finished job is one `retryAll` was asked for. */
  #matchesRetry(
    record: JobRecord,
    options: RetryAllOptions<TData, TResult>,
  ): boolean {
    if (options.name !== undefined && record.name !== options.name) {
      return false;
    }

    if (options.reason !== undefined) {
      if (!record.failedReason) {
        return false;
      }

      const text = `${record.failedReason.name}: ${record.failedReason.message}`;

      if (typeof options.reason === "string") {
        if (!text.includes(options.reason)) {
          return false;
        }
      } else {
        // A global or sticky pattern remembers where it stopped; start over.
        options.reason.lastIndex = 0;

        if (!options.reason.test(text)) {
          return false;
        }
      }
    }

    return options.filter ? options.filter(this.#view(record)) : true;
  }

  /**
   * A view of a job in this queue, which announces what it does to itself —
   * `remove()`, `promote()`, `retry()`, an outside `fail()` — as this queue's
   * methods of the same name do.
   */
  #view(record: JobRecord, wasAdded?: boolean): Job<TData, TResult> {
    return new Job<TData, TResult>(
      this.driver,
      this.ref,
      record,
      wasAdded,
      this.#hooksFor(this.name),
    );
  }

  /**
   * The hooks a view of a job in `queue` carries: announced as this queue
   * announces its own, on `queue`. Local listeners hear only about jobs in
   * this queue; other queues' hear through the published events.
   */
  #hooksFor(queue: string): JobHooks {
    return {
      onEvent: async (event) => await this.#onJobEvent(queue, event),
    };
  }

  /** Emits and publishes what a job view in `queue` did to itself. */
  async #onJobEvent(queue: string, event: JobEvent): Promise<void> {
    const own = queue === this.name;

    switch (event.type) {
      case "removed":
      case "promoted":
        if (own) {
          this.safeEmit(event.type, event.id);
        }
        await this.#publish(event.type, { id: event.id }, queue);
        return;

      case "retried":
        if (own) {
          this.safeEmit("retried", [event.id]);
        }
        await this.#publish("retried", { ids: [event.id] }, queue);
        return;

      case "buried": {
        const { record, error } = event;
        if (own) {
          const job = this.#view(record);
          const failure = deserializeError(error);
          this.safeEmitScoped("failed", record.name, job, failure);
          this.safeEmitScoped("dead", record.name, job, failure);
        }
        await this.#publish("failed", { id: record.id, error }, queue);
        await this.#publish("dead", { id: record.id, error }, queue);
      }
    }
  }

  /** Emits and publishes one `retried` for a batch, when it retried anything. */
  async #announceRetried(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    this.safeEmit("retried", ids);
    await this.#publish("retried", { ids });
  }

  /**
   * Builds the record a driver stores, applying defaults and validation.
   *
   * The options resolve from every layer, highest first: the call's own
   * `options`, the queue's stored `override`, the `define()` `definition`,
   * this queue's `defaultJobOptions`, the built-ins — and record which of
   * the editable ones the call passed itself (`opts.explicit`).
   */
  #buildRecord(
    name: string,
    data: TData,
    options: JobOptions | undefined,
    overrides?: Partial<JobRecord>,
    layers?: {
      /** A `define()` definition's editable options. */
      definition?: JobOptions;
      /** The queue's stored job defaults, as read for this add. */
      override?: JobDefaultsPatch;
    },
  ): JobRecord {
    const now = Date.now();
    const opts = resolveLayeredJobOptions(
      {
        code: this.#defaults,
        definition: layers?.definition,
        override: layers?.override,
      },
      options,
    );
    const runAt = resolveRunAt({ ...this.#defaults, ...options }, now);

    if (typeof name !== "string" || name.length === 0) {
      throw new ConfigError("A job name is required", { name });
    }

    return {
      // Deliberately *not* checked here. This is also where ids this package
      // derived arrive — a repeat occurrence carries its series key, which a
      // cron expression or a time zone puts a `/` in — and a derived id is
      // shortened to fit rather than refused. A caller's own id is checked
      // once, in `add` and `addBulk`, before anything derives from it.
      id: options?.jobId ?? newId(),
      name,
      // Checked here, at the boundary, so an unserialisable payload is
      // reported by the call that supplied it rather than by a driver later.
      data: assertJsonSafe(data, "job data"),
      opts,
      state: runAt > now ? "delayed" : "waiting",
      priority: opts.priority,
      runAt,
      createdAt: now,
      processedOn: null,
      finishedOn: null,
      expiresAt: null,
      attemptsMade: 0,
      maxAttempts: opts.attempts,
      stalledCount: 0,
      progress: null,
      returnValue: null,
      failedReason: null,
      stacktrace: [],
      lockToken: null,
      lockExpiresAt: null,
      workerId: null,
      repeatKey: null,
      flow: null,
      ...overrides,
    };
  }

  /**
   * Creates or updates a repeat series and schedules its first occurrence.
   *
   * The occurrence's id is derived from the series and its due time, so this
   * is safe to call from any number of producers: the second one adds
   * nothing.
   */
  async #addRepeatable(
    name: TName,
    data: TData,
    options: JobOptions,
    /** A `define()` definition's editable options, as their own layer. */
    definition?: JobOptions,
  ): Promise<Job<TData, TResult>> {
    const now = Date.now();
    // The series stores the code's layers and the explicit mask, never the
    // stored override: each occurrence takes the override current when it is
    // built (the worker overlays it), so a later save or reset reaches every
    // future occurrence.
    const opts = resolveLayeredJobOptions(
      { code: this.#defaults, definition },
      options,
    );
    const read = this.#storedDefaults(this.name);
    const override = read instanceof Promise ? await read : read;
    const given = options.repeat!;
    // A caller's own key is namespaced so it can never equal a generated one
    // (`<name>|<schedule>|<start>`) and take that series over.
    const repeat =
      given.key === undefined
        ? given
        : // Checked in `add()`, before anything was written.
          { ...given, key: `${CALLER_REPEAT_KEY_PREFIX}${given.key}` };
    const series = toRepeatRecord(
      this.ref,
      name,
      data,
      opts,
      repeat,
      now,
      this.dateParser,
    );

    const existing = await this.driver.getRepeat(this.ref, series.key);
    const merged: RepeatRecord = existing
      ? { ...series, count: existing.count, createdAt: existing.createdAt }
      : series;

    const firstRunAt = repeat.immediately ? now : nextOccurrence(merged, now);

    if (firstRunAt === null) {
      await this.driver.upsertRepeat(this.ref, {
        ...merged,
        nextRunAt: null,
        nextJobId: null,
        updatedAt: now,
      });

      throw new ConfigError(
        `The repeat "${series.key}" has no occurrences left to schedule`,
        { key: series.key },
      );
    }

    // Shortened, never refused: a series key is derived from the job's name
    // and schedule, so a long name must not make the series unaddable. Every
    // site that derives this id shortens it the same deterministic way, which
    // is what keeps two workers scheduling one occurrence idempotent.
    // Built from the *displayed* key, which is what keeps it unambiguous: a
    // caller key without `|` cannot equal a generated key, and one with `|`
    // keeps its prefix here too, so two series can never derive one id.
    const jobId = shortenJobId(
      repeatJobId(displayRepeatKey(merged.key), firstRunAt),
    );
    const record = this.#buildRecord(
      name,
      data,
      { ...options, jobId, runAt: firstRunAt },
      { repeatKey: merged.key },
      { definition, override },
    );

    // A disabled series stays disabled when it is added again: the definition
    // is updated, so a change to its schedule or options sticks and `enable()`
    // schedules from it, but nothing is scheduled and nothing announced —
    // neither emitted here nor published. The caller gets the occurrence that
    // would have been added, unstored, with `wasAdded: false` — the shape a
    // debounced or duplicate add answers with — so a producer that re-adds its
    // series on every start does not break once one of them is disabled.
    if (await isRepeatDisabled(this.driver, this.ref, merged.key)) {
      await this.driver.upsertRepeat(this.ref, {
        ...merged,
        nextRunAt: null,
        nextJobId: null,
        updatedAt: now,
      });

      return this.#view(record, false);
    }

    // The definition is written *before* its first occurrence, never after.
    // A worker schedules the next occurrence the moment it claims one, from
    // the definition it reads then, and reads a missing definition as a series
    // removed while its occurrence was queued — so it schedules nothing more.
    // An `immediately()` occurrence is claimable as soon as it is added, and a
    // fast claim (the file driver's batch claim, measured) landed in the gap
    // before a definition written afterwards: the series ran once and stopped.
    // An occurrence whose add then fails is not lost either: the definition
    // names it, and the worker's repeat heal adds it back.
    await this.driver.upsertRepeat(this.ref, {
      ...merged,
      nextRunAt: firstRunAt,
      nextJobId: jobId,
      updatedAt: now,
    });

    const { job, added } = await this.driver.addJob(this.ref, record);

    // The key as the caller named it, here and on the wire: the prefix is
    // storage, not contract.
    const shown = displayRepeatKey(merged.key);
    this.safeEmit("repeatScheduled", shown, firstRunAt);
    await this.#publish("repeatScheduled", {
      key: shown,
      nextRunAt: firstRunAt,
    });

    const view = this.#view(job, added);
    this.safeEmit(added ? "added" : "duplicate", view);
    return view;
  }

  /**
   * Publishes an event for other processes, when anything is listening.
   *
   * `type` selects the payload's shape, so a mismatched pair is a compile
   * error here rather than a surprise in a subscriber three processes away.
   * `target` is the queue the event is about; a flow can add jobs to others.
   */
  async #publish<Name extends QueueEventName>(
    type: Name,
    payload: QueueEventPayloads[Name],
    target: string = this.name,
  ): Promise<void> {
    if (!this.#publishes) {
      return;
    }

    await this.#publishGate?.();

    try {
      await this.driver.publish(
        queueEvent(
          {
            ns: this.namespace,
            target,
            type,
            origin: this.#origin,
          },
          payload,
        ),
      );
    } catch (error) {
      this.#logger.warn("Could not publish a queue event", { error, type });
    }
  }

  /**
   * Re-emits an event from another process, with the arguments its local
   * signature actually takes.
   *
   * This used to reconstruct every event the same way: fetch the job named by
   * `id`, emit `(job)`. That is right for about half of them and quietly wrong
   * for the rest — `removed` and `promoted` handed listeners a `Job` where the
   * local signature says `string`, and `delayed`, `progress`, `completed`,
   * `retrying` and `dead` lost their second argument entirely. A listener
   * therefore saw a different shape depending on which process emitted, which
   * is the sort of thing that is only ever found in production.
   *
   * The envelope carries ids and scalars rather than records — some transports
   * cap a message at a few kilobytes — so a job is fetched only for the events
   * whose signature needs one, and only when somebody is listening.
   */
  /**
   * Whether anything is listening for an event, under any name it can take.
   *
   * A remote event costs a fetch, so one nobody wants is dropped before
   * paying for it. That check used to be `listenerCount(type)` alone, which
   * silently skipped a listener registered only on the qualified form — and
   * the whole point of `completed:sendEmail` is to be the only thing someone
   * listens for.
   *
   * The qualified name cannot be known without the job, and the job cannot be
   * fetched without deciding to, so the question is asked the other way round:
   * is anyone listening for *any* qualification of this event.
   */
  #wants(type: string): boolean {
    if (this.listenerCount(type as never) > 0) {
      return true;
    }

    const scoped = `${type}:`;
    return this.eventNames().some(
      (name) => typeof name === "string" && name.startsWith(scoped),
    );
  }

  async #onRemoteEvent(event: QueueDriverEvent): Promise<void> {
    if (event.origin === this.#origin) {
      return;
    }

    if (!this.#wants(event.type)) {
      return;
    }

    // An `Error` does not survive JSON, so the wire carries a
    // `SerializedError` and it is turned back into one here. Local listeners
    // get a real `Error` whichever process raised it.
    switch (event.type) {
      case "paused":
      case "resumed":
        this.safeEmit(event.type);
        return;

      case "drained":
        this.safeEmit("drained", event.payload.count);
        return;

      case "cleaned":
        this.safeEmit("cleaned", event.payload.ids, event.payload.state);
        return;

      case "stalled":
        this.safeEmit("stalled", event.payload.ids);
        return;

      case "retried":
        this.safeEmit("retried", event.payload.ids);
        return;

      case "removed":
      case "promoted":
        this.safeEmit(event.type, event.payload.id);
        return;

      case "repeatScheduled":
        this.safeEmit(
          "repeatScheduled",
          event.payload.key,
          event.payload.nextRunAt,
        );
        return;
    }

    // Everything left is about one job, and hands the listener the job itself.
    const job = await this.#getJob(event.payload.id);

    if (!job) {
      return;
    }

    switch (event.type) {
      case "added":
      case "duplicate":
      case "debounced":
      case "throttled":
      case "waiting":
      case "active":
        this.safeEmitScoped(event.type, job.name, job);
        return;

      case "delayed":
        this.safeEmitScoped("delayed", job.name, job, event.payload.runAt);
        return;

      case "progress":
        this.safeEmitScoped("progress", job.name, job, event.payload.progress);
        return;

      case "completed":
        this.safeEmitScoped(
          "completed",
          job.name,
          job,
          event.payload.returnValue as TResult,
        );
        return;

      case "failed":
        this.safeEmitScoped(
          "failed",
          job.name,
          job,
          deserializeError(event.payload.error),
        );
        return;

      case "dead":
        this.safeEmitScoped(
          "dead",
          job.name,
          job,
          deserializeError(event.payload.error),
        );
        return;

      case "retrying":
        this.safeEmitScoped(
          "retrying",
          job.name,
          job,
          deserializeError(event.payload.error),
          event.payload.runAt,
        );
    }
  }
}

/** A `countAdded()` bound as epoch ms, or a `ConfigError` naming it. */
function addedBound(value: Date | number, option: "from" | "to"): number {
  const ms = value instanceof Date ? value.getTime() : value;

  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new ConfigError(`${option} must be a valid date or timestamp`, {
      [option]: value,
    });
  }

  return ms;
}

/**
 * A list option's `finishedFrom`/`finishedTo` as epoch ms, or `undefined`
 * when absent. Anything that is not a valid date or timestamp is a
 * `ConfigError`, as `update()` treats `runAt`.
 */
function listBound(
  value: Date | number | undefined,
  option: "finishedFrom" | "finishedTo",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const ms = value instanceof Date ? value.getTime() : value;

  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new ConfigError(`${option} must be a valid date or timestamp`, {
      [option]: value,
    });
  }

  return ms;
}
