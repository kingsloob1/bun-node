import type {
  JobRecord,
  JobsDriver,
  JobState,
  QueueRef,
  RepeatRecord,
} from "../drivers/index";
import type {
  QueueDriverEvent,
  QueueEventName,
  QueueEventPayloads,
} from "../shared/events";
import type { Logger } from "../shared/logger";
import type { BunQueueEvents, BunQueueOptions, JobOptions } from "./types";
import { deserializeError } from "@kingsleyweb/bun-common";
import { resolveDriver } from "../drivers/index";
import { TypedEmitterBase } from "../shared/emitter";
import { ConfigError, QueueClosedError } from "../shared/errors";
import { queueEvent } from "../shared/events";
import { newId, newToken } from "../shared/ids";
import { assertJsonSafe } from "../shared/json";
import { assertNamespace, assertSegment } from "../shared/keys";
import { createJobsLogger } from "../shared/logger";
import { Job } from "./Job";
import { resolveJobOptions, resolveRunAt } from "./options";
import { nextOccurrence, repeatJobId, toRepeatRecord } from "./repeat";

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
 */
export class BunQueue<
  TData = unknown,
  TResult = unknown,
  TName extends string = string,
> extends TypedEmitterBase<BunQueueEvents<TData, TResult>> {
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
    this.#subscribe = options.subscribe ?? false;
    // Defaults to `subscribe` so nothing changes for anyone relying on the
    // two being one flag; settable on its own so a producer can publish
    // without also paying for a subscription.
    this.#publishes = options.publish ?? this.#subscribe;
    this.#logger = createJobsLogger(
      options.logger,
      { namespace: this.namespace, queue: this.name },
      `queue:${this.name}`,
    );
  }

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
  async add(
    name: TName,
    data: TData,
    options?: JobOptions,
  ): Promise<Job<TData, TResult>> {
    await this.connect();

    if (options?.repeat) {
      return await this.#addRepeatable(name, data, options);
    }

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
  async addBulk(
    entries: { name: TName; data: TData; opts?: JobOptions }[],
  ): Promise<Job<TData, TResult>[]> {
    await this.connect();

    // A repeat is a definition plus a first occurrence, so it cannot be part
    // of a bulk insert; adding them one at a time keeps that explicit.
    if (entries.some((entry) => entry.opts?.repeat)) {
      const added: Job<TData, TResult>[] = [];
      for (const entry of entries) {
        added.push(await this.add(entry.name, entry.data, entry.opts));
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

  /** One job by id, or `null`. */
  async getJob(id: string): Promise<Job<TData, TResult> | null> {
    await this.connect();
    const record = await this.driver.getJob(this.ref, id);
    return record
      ? new Job<TData, TResult>(this.driver, this.ref, record)
      : null;
  }

  /** Jobs in the given state(s). */
  async list(
    state: JobState | JobState[],
    options?: { offset?: number; limit?: number; order?: "asc" | "desc" },
  ): Promise<Job<TData, TResult>[]> {
    await this.connect();

    const records = await this.driver.listJobs(
      this.ref,
      Array.isArray(state) ? state : [state],
      {
        offset: options?.offset ?? 0,
        limit: options?.limit ?? 100,
        order: options?.order ?? "asc",
      },
    );

    return records.map(
      (record) => new Job<TData, TResult>(this.driver, this.ref, record),
    );
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

  /** Returns a finished job to the queue. */
  async retry(
    id: string,
    options?: { resetAttempts?: boolean },
  ): Promise<boolean> {
    await this.connect();
    return await this.driver.retryJob(
      this.ref,
      id,
      options?.resetAttempts ?? true,
      Date.now(),
    );
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

  /** Removes finished jobs older than `olderThan` milliseconds. */
  async clean(
    state: "completed" | "failed" | "dead" | "waiting" | "delayed",
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
    return await this.driver.listRepeats(this.ref);
  }

  /** Removes a repeat definition and the occurrence it had scheduled. */
  async removeRepeatable(key: string): Promise<boolean> {
    await this.connect();

    const definition = await this.driver.getRepeat(this.ref, key);
    if (!definition) {
      return false;
    }

    if (definition.nextJobId) {
      await this.driver.removeJob(this.ref, definition.nextJobId);
    }

    return await this.driver.removeRepeat(this.ref, key);
  }

  /** Closes the subscription and, if this queue built the driver, the driver. */
  async close(): Promise<void> {
    this.#closed = true;

    await this.#unsubscribe?.();
    this.#unsubscribe = undefined;

    if (this.#ownsDriver) {
      await this.driver.close();
    }
  }

  /* --- internals --------------------------------------------------------- */

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
    const repeat = options.repeat!;
    const definition = toRepeatRecord(this.ref, name, data, opts, repeat, now);

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

    const jobId = repeatJobId(merged.key, firstRunAt);
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

    this.safeEmit("repeatScheduled", merged.key, firstRunAt);
    await this.#publish("repeatScheduled", {
      key: merged.key,
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
   */
  async #publish<Name extends QueueEventName>(
    type: Name,
    payload: QueueEventPayloads[Name],
  ): Promise<void> {
    if (!this.#publishes) {
      return;
    }

    try {
      await this.driver.publish(
        queueEvent(
          {
            ns: this.namespace,
            target: this.name,
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
    const job = await this.getJob(event.payload.id);

    if (!job) {
      return;
    }

    switch (event.type) {
      case "added":
      case "duplicate":
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
