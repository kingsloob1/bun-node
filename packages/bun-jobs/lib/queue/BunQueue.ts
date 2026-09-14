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
import type { DateParser } from "../shared/humanTime";
import type { Logger } from "../shared/logger";
import type { QueueLimits, StoredLimits } from "./limits";
import type {
  BunQueueEvents,
  BunQueueOptions,
  JobOptions,
  RetryAllOptions,
} from "./types";
import { deserializeError } from "@kingsleyweb/bun-common";
import { resolveDriver } from "../drivers/index";
import { TypedEmitterBase } from "../shared/emitter";
import { ConfigError, QueueClosedError } from "../shared/errors";
import { queueEvent } from "../shared/events";
import { assertDateParser } from "../shared/humanTime";
import { newId, newToken } from "../shared/ids";
import { assertJsonSafe } from "../shared/json";
import { assertNamespace, assertSegment } from "../shared/keys";
import { createJobsLogger } from "../shared/logger";
import { Job } from "./Job";
import { LIMITS_STATE, normalizeLimits, QueueLimiter } from "./limits";
import { resolveJobOptions, resolveRunAt } from "./options";
import { nextOccurrence, repeatJobId, toRepeatRecord } from "./repeat";

/** How many finished jobs `retryAll` reads at a time. */
const RETRY_PAGE = 200;

/** How many retries `retryJobs` and `retryAll` send the driver at once. */
const RETRY_CONCURRENCY = 16;

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
    this.dateParser =
      options.dateParser === undefined
        ? undefined
        : assertDateParser(options.dateParser);
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
  async retryAll(
    state: "dead" | "failed" | "completed",
    options: RetryAllOptions<TData, TResult> = {},
  ): Promise<string[]> {
    await this.connect();

    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const reset = options.resetAttempts ?? true;
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

        if (this.#matchesRetry(record, options)) {
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

  /** Retries ids a bounded number at a time, and answers with those that went. */
  async #retryIds(ids: string[], resetAttempts: boolean): Promise<string[]> {
    const now = Date.now();
    const retried: string[] = [];

    for (let at = 0; at < ids.length; at += RETRY_CONCURRENCY) {
      const chunk = ids.slice(at, at + RETRY_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((id) =>
          this.driver.retryJob(this.ref, id, resetAttempts, now),
        ),
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
