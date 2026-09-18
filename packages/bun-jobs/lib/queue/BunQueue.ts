import type {
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
import type { QueueLimits, StoredLimits } from "./limits";
import type {
  AdHocJobName,
  BulkEntriesOf,
  BulkJobsOf,
  BunQueueEvents,
  BunQueueOptions,
  FlowNode,
  FlowNodeOf,
  FlowResult,
  JobAddArgs,
  JobDataOf,
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
  findJobPage,
  findJobsByScan,
  getJobsByIds,
  listWorkerRecords,
  resolveDriver,
  supportsWorkers,
  THROUGHPUT_BUCKET_MS,
  THROUGHPUT_RETENTION_MS,
  throughputBucket,
} from "../drivers/index";
import { TypedEmitterBase } from "../shared/emitter";
import {
  ConfigError,
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
import { LIMITS_STATE, normalizeLimits, QueueLimiter } from "./limits";
import {
  assertJobId,
  assertRepeatKey,
  CALLER_REPEAT_KEY_PREFIX,
  DERIVED_NAME_LIMITS,
  displayRepeatKey,
  resolveJobOptions,
  resolveRunAt,
  shortenJobId,
} from "./options";
import { nextOccurrence, repeatJobId, toRepeatRecord } from "./repeat";
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
   * declared, so a registry-bound queue cannot reach it.
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
      return await this.#addWindowed(jobName, payload, options);
    }

    if (options?.repeat) {
      return await this.#addRepeatable(jobName, payload, options);
    }

    return await this.#addSimple(jobName, payload, options);
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
  ): Promise<Job<TData, TResult>> {
    const record = this.#buildRecord(name, data, options);
    const { job, added } = await this.driver.addJob(this.ref, record);
    const view = new Job<TData, TResult>(this.driver, this.ref, job, added);

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

    const records = entries.map((entry) =>
      this.#buildRecord(entry.name, entry.data, entry.opts),
    );
    const results = await this.driver.addJobs(this.ref, records);

    return results.map(({ job, added }) => {
      const view = new Job<TData, TResult>(this.driver, this.ref, job, added);
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
    return record
      ? new Job<TData, TResult>(this.driver, this.ref, record)
      : null;
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
   * ```
   *
   * Without `name` or `search` this is exactly the read it always was. With
   * them, `offset` and `limit` count matching jobs. See {@link ListJobsOptions}
   * for what a search costs.
   */
  async list(
    state: JobState | JobState[],
    options?: ListJobsOptions,
  ): Promise<QueueJobOf<TData, TResult, TJobs>[]> {
    await this.connect();

    const states = Array.isArray(state) ? state : [state];
    const records =
      options?.name === undefined && options?.search === undefined
        ? await this.driver.listJobs(this.ref, states, {
            offset: options?.offset ?? 0,
            limit: options?.limit ?? 100,
            order: options?.order ?? "asc",
          })
        : (
            await findJobPage(
              this.driver,
              this.ref,
              this.#query(states, options),
            )
          ).jobs;

    return records.map((record) =>
      this.#typed(new Job<TData, TResult>(this.driver, this.ref, record)),
    );
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
      jobs: page.jobs.map((record) =>
        this.#typed(new Job<TData, TResult>(this.driver, this.ref, record)),
      ),
      total,
    };
  }

  /** A driver query from a caller's list options. */
  #query(states: JobState[], options: ListJobsOptions | undefined): JobQuery {
    const name = options?.name;

    return {
      states,
      offset: options?.offset ?? 0,
      limit: options?.limit ?? 100,
      order: options?.order ?? "asc",
      ...(name === undefined
        ? {}
        : { names: Array.isArray(name) ? name : [name] }),
      ...(options?.search === undefined ? {} : { search: options.search }),
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
      record
        ? this.#typed(new Job<TData, TResult>(this.driver, this.ref, record))
        : null,
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
        const view = new Job(this.driver, ref, existing, false);
        await this.#announceAdded(view, false);
        return { job: view, children: [] };
      }
    }

    const results: FlowResult[] = [];
    for (const child of children) {
      results.push(await this.#addFlowNode(child, { queue, id }));
    }

    // Built after the children are in, so its `createdAt` follows theirs.
    const base = this.#buildRecord(node.name as TName, node.data as TData, {
      ...node.opts,
      jobId: id,
    });
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
    const view = new Job(this.driver, ref, job, added);
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

    return record
      ? this.#typed(
          new Job<TData, TResult>(this.driver, this.ref, record, false),
        )
      : null;
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

  /** Every repeat definition in this queue. */
  async listRepeatables(): Promise<RepeatRecord[]> {
    await this.connect();
    const stored = await this.driver.listRepeats(this.ref);

    // Shown as the caller named it. `removeRepeatable` takes either spelling,
    // so a key from here can be handed straight back.
    return stored.map((record) => ({
      ...record,
      key: displayRepeatKey(record.key),
    }));
  }

  /** Removes a repeat definition and the occurrence it had scheduled. */
  async removeRepeatable(key: string): Promise<boolean> {
    await this.connect();

    // Either spelling: the key as `listRepeatables()` reports it, or the one
    // the caller gave to `repeat.key`, which is stored namespaced.
    //
    // The listed spelling is matched first, and only a stored series that
    // *displays* as `key` counts. Looking the raw key up first was wrong: a
    // caller key of `k:nightly` is stored as `k:k:nightly` and listed as
    // `k:nightly`, while `k:nightly` is also the stored spelling of the series
    // keyed `nightly` — so removing the one listed removed the other.
    const stored = [key, `${CALLER_REPEAT_KEY_PREFIX}${key}`];
    let definition: RepeatRecord | null = null;

    for (const candidate of stored) {
      const found = await this.driver.getRepeat(this.ref, candidate);
      if (found && displayRepeatKey(found.key) === key) {
        definition = found;
        break;
      }
    }

    // Then the spelling the caller originally supplied, for a key containing
    // `|`, whose prefix stays visible when listed.
    definition ??= await this.driver.getRepeat(this.ref, stored[1]!);

    if (!definition) {
      return false;
    }

    if (definition.nextJobId) {
      await this.driver.removeJob(this.ref, definition.nextJobId);
    }

    return await this.driver.removeRepeat(this.ref, definition.key);
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
          const view = new Job<TData, TResult>(
            this.driver,
            this.ref,
            updated,
            false,
          );
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
          const view = new Job<TData, TResult>(
            this.driver,
            this.ref,
            existing,
            false,
          );
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

      const added = await this.#addSimple(name, data, {
        ...rest,
        jobId,
        ...(kind === "debounce"
          ? { runAt: now + ttl }
          : options.runAt !== undefined
            ? { runAt: options.runAt }
            : options.delay !== undefined
              ? { delay: options.delay }
              : {}),
      });

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

    return options.filter
      ? options.filter(new Job<TData, TResult>(this.driver, this.ref, record))
      : true;
  }

  /** Emits and publishes one `retried` for a batch, when it retried anything. */
  async #announceRetried(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    this.safeEmit("retried", ids);
    await this.#publish("retried", { ids });
  }

  /** Builds the record a driver stores, applying defaults and validation. */
  #buildRecord(
    name: string,
    data: TData,
    options: JobOptions | undefined,
    overrides?: Partial<JobRecord>,
  ): JobRecord {
    const now = Date.now();
    const opts = resolveJobOptions(this.#defaults, options);
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
  ): Promise<Job<TData, TResult>> {
    const now = Date.now();
    const opts = resolveJobOptions(this.#defaults, options);
    const given = options.repeat!;
    // A caller's own key is namespaced so it can never equal a generated one
    // (`<name>|<schedule>|<start>`) and take that series over.
    const repeat =
      given.key === undefined
        ? given
        : // Checked in `add()`, before anything was written.
          { ...given, key: `${CALLER_REPEAT_KEY_PREFIX}${given.key}` };
    const definition = toRepeatRecord(
      this.ref,
      name,
      data,
      opts,
      repeat,
      now,
      this.dateParser,
    );

    const existing = await this.driver.getRepeat(this.ref, definition.key);
    const merged: RepeatRecord = existing
      ? { ...definition, count: existing.count, createdAt: existing.createdAt }
      : definition;

    const firstRunAt = repeat.immediately ? now : nextOccurrence(merged, now);

    if (firstRunAt === null) {
      await this.driver.upsertRepeat(this.ref, {
        ...merged,
        nextRunAt: null,
        nextJobId: null,
        updatedAt: now,
      });

      throw new ConfigError(
        `The repeat "${definition.key}" has no occurrences left to schedule`,
        { key: definition.key },
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
    );

    const { job, added } = await this.driver.addJob(this.ref, record);

    await this.driver.upsertRepeat(this.ref, {
      ...merged,
      nextRunAt: firstRunAt,
      nextJobId: jobId,
      updatedAt: now,
    });

    // The key as the caller named it, here and on the wire: the prefix is
    // storage, not contract.
    const shown = displayRepeatKey(merged.key);
    this.safeEmit("repeatScheduled", shown, firstRunAt);
    await this.#publish("repeatScheduled", {
      key: shown,
      nextRunAt: firstRunAt,
    });

    const view = new Job<TData, TResult>(this.driver, this.ref, job, added);
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
