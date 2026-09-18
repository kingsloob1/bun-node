import type { Retention } from "../drivers/driver";
import type { BunQueue } from "./BunQueue";
import type { Job } from "./Job";
import type { JobOptions, RepeatOptions } from "./types";
import { ConfigError } from "../shared/errors";
import {
  looksLikeCron,
  parseDuration,
  parseWhen,
  readRecurrence,
} from "../shared/humanTime";

/**
 * Everything a job can be told, in one object — all of it except the name.
 *
 * The same vocabulary as the builder's methods, so `withOptions({ every: "2
 * days" })` and `.every("2 days")` are one thing written two ways: durations
 * and phrases are read identically, and the definition's defaults sit under
 * both. It exists for the call site where the description is *data* — loaded
 * from config, built by a form, passed through from somewhere else — and a
 * chain of method calls would mean unpacking an object only to repack it.
 *
 * The raw `JobOptions` names are accepted too, because they are what the rest
 * of the package documents. Where a builder name and a raw name mean the same
 * thing — `in` and `delay`, `on` and `runAt`, `unique` and `jobId` — giving
 * both is rejected rather than resolved: there is no order of precedence a
 * reader could be expected to guess.
 */
export interface JobBuilderOptions<TData = unknown> {
  /** What the job carries. Replaces anything given before. */
  data?: TData;

  /** Repeat on an interval: `"2 days"`, milliseconds, or a cron expression. */
  every?: number | string;
  /** Run at a moment — a `Date`, epoch milliseconds, or a phrase. */
  on?: Date | number | string;
  /** Run after a delay: `"5 minutes"`, or milliseconds. */
  in?: number | string;
  /** Begin a repeating series at a moment rather than at once. */
  startingAt?: Date | number | string;
  /** End a repeating series at a moment — a `Date`, milliseconds, or words. */
  endingAt?: Date | number | string;
  /** Stop a repeating series after this many occurrences. */
  limit?: number;
  /** Read a cron expression in this IANA time zone. */
  tz?: string;
  /** Run every occurrence missed while nothing was consuming. */
  catchUp?: boolean;
  /** Run the first occurrence at once, then follow the schedule. */
  immediately?: boolean;
  /** Name the repeat series yourself instead of deriving it from its schedule. */
  repeatKey?: string;

  /** Lower runs first. */
  priority?: number;
  /** How many times to try before the job is dead. */
  attempts?: number;
  /** How long one attempt may take: `"30 seconds"`, or milliseconds. */
  timeout?: number | string;
  /** How long to wait between attempts. */
  backoff?: JobOptions["backoff"];
  /** An id of your choosing, which is also the idempotency key. */
  unique?: string;
  /** A queue that receives a copy of the job if it dies. */
  deadLetter?: string;
  /** Keep one pending job per id: see {@link JobOptions.debounce}. */
  debounce?: JobOptions["debounce"];
  /** At most one job per id per window: see {@link JobOptions.throttle}. */
  throttle?: JobOptions["throttle"];
  /** How many log lines the job keeps. */
  keepLogs?: number;
  /** What to do with the job once it completes. */
  removeOnComplete?: Retention;
  /** What to do with the job once it is dead. */
  removeOnFail?: Retention;
  /** How many failed attempts' stack traces to keep on the record. */
  keepStacktraces?: number;

  /** The raw name for `unique`. Do not give both. */
  jobId?: string;
  /** The raw name for `in`, in milliseconds. Do not give both. */
  delay?: number;
  /** The raw name for `on`. Do not give both. */
  runAt?: Date | number;
  /** A whole repeat description, merged under `every`, `limit` and the rest. */
  repeat?: RepeatOptions;
}

/**
 * How a series set with `repeatEvery()` runs, beyond how often: every field of
 * `RepeatOptions` except the schedule itself, with the same meaning and the
 * same defaults.
 */
export type RepeatEveryOptions = Omit<RepeatOptions, "cron" | "every">;

/**
 * Saying what to run, when, and with what — in that order, in words.
 *
 * ```ts
 * await jobs.schedule("sendMails").every("2 days").withData(list).start();
 * await jobs.run("sendMail").in("5 minutes").withData(mail).start();
 * await jobs.process("report").on("2nd december 2026").start();
 * ```
 *
 * The positional form this replaces — `schedule(when, name, data, options)` —
 * put the least important argument first and the interesting ones last, and
 * gave every variation its own method: one for a delay, one for a date, one
 * for an interval, each with the same four parameters in a different order.
 * Here there is one thing to learn and the sentence reads in the order it is
 * thought.
 *
 * Nothing happens until `start()`. A builder that is never started adds no
 * job, which is what makes it safe to pass one around and finish describing it
 * somewhere else.
 */
export class JobBuilder<TData = unknown, TResult = unknown> {
  /** The queue the job will be added to. */
  readonly #queue: BunQueue<TData, TResult, string>;
  /** The name it is added under. */
  readonly #name: string;
  /** Defaults from the job's definition, under whatever this builder sets. */
  readonly #defaults: JobOptions;
  /** What the job carries. */
  #data: TData | undefined;
  /** What this builder has been told, so far. */
  #options: JobOptions = {};
  /** The repeat being described, if any. */
  #repeat: RepeatOptions | undefined;
  /**
   * The last instant given by `on()` or `startingAt()` — a `Date`, epoch
   * milliseconds or words — resolved when `start()` is awaited. One slot for
   * both, so whichever was said last stands, in any order and in any form.
   */
  #when:
    | {
        /** The instant as given. */
        value: Date | number | string;
        /** Whether it was given as when the job runs, or when the series begins. */
        is: "runAt" | "startAt";
        /** Whether `repeatEvery()` set it, so a later `repeatEvery()` replaces it. */
        byRepeatEvery: boolean;
      }
    | undefined;

  /**
   * Whether a repeating series has been described at all — by `every()`,
   * `repeatEvery()`, `withOptions()`, or one of the series setters.
   *
   * {@link JobDraft} uses it to refuse a series setter called before
   * `repeatEvery()`. It cannot tell otherwise: the series is private, and
   * spreading an absent one (`{ ...undefined, limit: 5 }`) quietly
   * manufactures a repeat with nothing to repeat.
   */
  get hasSeries(): boolean {
    return this.#repeat !== undefined;
  }

  constructor(
    /** The queue the job will be added to. */
    queue: BunQueue<TData, TResult, string>,
    /** The name it is added under. */
    name: string,
    /** What the job carries, when it was given up front. */
    data?: TData,
    /** Defaults from the job's definition. */
    defaults: JobOptions = {},
  ) {
    this.#queue = queue;
    this.#name = name;
    this.#data = data;
    this.#defaults = defaults;
  }

  /**
   * Sets what the job carries, replacing anything given before.
   *
   * Usable at any point, including after the schedule, so the sentence can be
   * written in whichever order reads best.
   */
  withData(data: TData): this {
    this.#data = data;
    return this;
  }

  /**
   * Repeats the job.
   *
   * ```ts
   * .every(60_000)                                     // milliseconds
   * .every("2 days")  .every("every 2 days")           // a duration
   * .every("daily")   .every("every other day")        // words
   * .every("0 9 * * 1")                                // cron, by its shape
   * .every("every 2 weeks starting 1st december 2026") // with a start
   * .every("every day from 1 dec 2026 until 31 dec")   // with a window
   * .every("every monday")                             // weekly, from monday
   * ```
   *
   * A phrase that names dates sets where the series starts and stops as well
   * as how often; `startingAt()`, `on()` and `endingAt()` still win over them,
   * being the more specific thing to have said. Reading dates needs the
   * optional `chrono-node`; an interval alone does not. See `readRecurrence`
   * for why "every day at 9am" drifts across daylight saving and cron does not.
   *
   * Only one schedule stands: calling `every()` again replaces the interval,
   * the cron expression and any dates its earlier phrase named.
   *
   * The same strings work as `repeat.every` on `queue.add()`; a phrase is
   * handed to the queue as written, which reads its dates when the job is
   * added — so "starting tomorrow" on a builder finished an hour later still
   * means tomorrow.
   */
  every(interval: number | string): this {
    if (typeof interval === "number") {
      return this.#setSchedule({ every: interval });
    }

    const duration = parseDuration(interval.replace(/^(?:every|each)\s+/i, ""));

    if (duration !== null) {
      return this.#setSchedule({ every: duration });
    }

    if (looksLikeCron(interval)) {
      return this.#setSchedule({ cron: interval });
    }

    // Read now, so a phrase that is not an interval fails at this call rather
    // than when the job is added. The queue reads it again then, for its dates.
    readRecurrence(interval, "every()", Date.now(), this.#queue.dateParser);
    return this.#setSchedule({ every: interval });
  }

  /** Replaces the schedule — and with it any dates an earlier phrase named. */
  #setSchedule(schedule: { every: number | string } | { cron: string }): this {
    const { every: _every, cron: _cron, ...rest } = this.#repeat ?? {};
    this.#repeat = { ...rest, ...schedule };
    return this;
  }

  /**
   * Repeats the job, replacing everything said about the series before.
   *
   * ```ts
   * .repeatEvery("1 day", { tz: "Europe/London", limit: 30 })
   * ```
   *
   * The interval is read exactly as `every()` reads it. Unlike `every()`,
   * which changes only the schedule, this is a whole description: a `limit`,
   * `tz`, `endAt` or any other series option given by an earlier call, or by
   * `limit()`/`tz()`/`withOptions()`, is dropped unless given again. A start
   * given by an earlier `repeatEvery()` is dropped the same way; one given by
   * `on()` or `startingAt()` is a separate statement and stays, unless this
   * call gives `startAt`, which then stands as the later word.
   */
  repeatEvery(
    interval: number | string,
    options: RepeatEveryOptions = {},
  ): this {
    try {
      this.every(interval);
    } catch (error) {
      // The same reading, reported under the name the caller wrote.
      if (error instanceof ConfigError) {
        throw new ConfigError(
          error.message.replaceAll("every()", "repeatEvery()"),
          { ...error.context, interval },
        );
      }
      throw error;
    }

    const { every, cron } = this.#repeat ?? {};
    this.#repeat = {
      ...(every !== undefined ? { every } : {}),
      ...(cron !== undefined ? { cron } : {}),
      ...(options.endAt !== undefined ? { endAt: options.endAt } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.tz !== undefined ? { tz: options.tz } : {}),
      ...(options.catchUp !== undefined ? { catchUp: options.catchUp } : {}),
      ...(options.immediately !== undefined
        ? { immediately: options.immediately }
        : {}),
      ...(options.key !== undefined ? { key: options.key } : {}),
    };

    if (this.#when?.byRepeatEvery) {
      this.#when = undefined;
    }

    if (options.startAt !== undefined) {
      this.#when = {
        value: options.startAt,
        is: "startAt",
        byRepeatEvery: true,
      };
    }

    return this;
  }

  /**
   * Runs the job at a given moment — a `Date`, epoch milliseconds, or words.
   *
   * On a repeating job this is when the series *begins* rather than when one
   * occurrence runs, because those are the same sentence: "every 2 days, on
   * the 1st of December" starts then and repeats from there.
   */
  on(when: Date | number | string): this {
    // One slot with `startingAt()`: whatever was said last replaces the rest,
    // phrase or instant, whichever of the two methods said it.
    this.#when = { value: when, is: "runAt", byRepeatEvery: false };
    delete this.#options.runAt;
    return this;
  }

  /** Runs the job after a delay — `"5 minutes"`, or milliseconds. */
  in(delay: number | string): this {
    if (typeof delay === "number") {
      this.#options.delay = delay;
      return this;
    }

    const duration = parseDuration(delay.replace(/^in\s+/i, ""));

    if (duration === null) {
      throw new ConfigError(`in() could not read "${delay}" as a duration`, {
        delay,
      });
    }

    this.#options.delay = duration;
    return this;
  }

  /** Starts a repeating series at a given moment rather than at once. */
  startingAt(when: Date | number | string): this {
    // The same slot `on()` writes, so the later of the two stands.
    this.#when = { value: when, is: "startAt", byRepeatEvery: false };
    return this;
  }

  /** Ends a repeating series at a given moment — a `Date`, milliseconds, or words. */
  endingAt(when: Date | number | string): this {
    this.#repeat = { ...this.#repeat, endAt: when };
    return this;
  }

  /**
   * Stops a repeating series after this many occurrences: a whole number of at
   * least 1. Needs a series first — `every()`, `repeatEvery()` or
   * `withOptions()` — and throws `ConfigError` without one, rather than
   * inventing a repeat with nothing to repeat.
   */
  limit(occurrences: number): this {
    if (this.#repeat === undefined) {
      throw new ConfigError(
        "limit() sets one option of a repeating series, so it needs every() or repeatEvery() before it",
        { method: "limit()" },
      );
    }

    if (!Number.isInteger(occurrences) || occurrences < 1) {
      throw new ConfigError(
        "limit() needs a whole number of occurrences, at least 1",
        { method: "limit()", limit: occurrences },
      );
    }

    this.#repeat = { ...this.#repeat, limit: occurrences };
    return this;
  }

  /**
   * Reads the series' schedule in this IANA time zone. Checked here, for an
   * interval series as well as a cron one, so a misspelt zone fails at the
   * call that gave it rather than when an occurrence is first computed.
   */
  tz(zone: string): this {
    if (!isTimeZone(zone)) {
      throw new ConfigError(`tz() does not know the time zone "${zone}"`, {
        method: "tz()",
        tz: zone,
      });
    }

    this.#repeat = { ...this.#repeat, tz: zone };
    return this;
  }

  /** Runs every occurrence missed while nothing was consuming. */
  catchUp(enabled = true): this {
    this.#repeat = { ...this.#repeat, catchUp: enabled };
    return this;
  }

  /** Runs the first occurrence immediately, then follows the schedule. */
  immediately(enabled = true): this {
    this.#repeat = { ...this.#repeat, immediately: enabled };
    return this;
  }

  /** Lower runs first. */
  priority(value: number): this {
    this.#options.priority = value;
    return this;
  }

  /** How many times to try before the job is dead. */
  attempts(count: number): this {
    this.#options.attempts = count;
    return this;
  }

  /** How long one attempt may take — `"30 seconds"`, or milliseconds. */
  timeout(limit: number | string): this {
    this.#options.timeout =
      typeof limit === "number" ? limit : requireDuration(limit, "timeout()");
    return this;
  }

  /** How long to wait between attempts. */
  backoff(strategy: JobOptions["backoff"]): this {
    this.#options.backoff = strategy;
    return this;
  }

  /**
   * Gives the job an id of your choosing, which is also its idempotency key.
   *
   * Adding the same id twice adds nothing the second time, and comes back with
   * what is already stored.
   *
   * On a repeating job it names the series instead. Each occurrence of a
   * series has to have an id derived from the series and its due time — that
   * is what stops several producers scheduling one occurrence twice — so a
   * single fixed id cannot belong to any of them. An explicit `repeatKey` still
   * wins.
   */
  unique(id: string): this {
    this.#options.jobId = id;
    return this;
  }

  /**
   * Names a queue, in the same namespace, that receives a copy of the job if
   * it dies — with its id, data and the error that killed it.
   */
  deadLetter(queue: string): this {
    this.#options.deadLetter = queue;
    return this;
  }

  /**
   * Keeps one pending job per `id`: adding again before it starts replaces
   * its data and pushes its run time back to `ttl` from now.
   *
   * ```ts
   * await jobs.run("reindex", { doc }).debounce(doc.id, "30 seconds").start();
   * ```
   */
  debounce(id: string, ttl: number | string): this {
    this.#options.debounce = { id, ttl };
    return this;
  }

  /**
   * Adds at most one job per `id` per `ttl`; an add inside the window adds
   * nothing and answers with the job that opened it.
   */
  throttle(id: string, ttl: number | string): this {
    this.#options.throttle = { id, ttl };
    return this;
  }

  /** How many log lines the job keeps, newest last. `0` keeps every line. */
  keepLogs(lines: number): this {
    this.#options.keepLogs = lines;
    return this;
  }

  /**
   * Describes the job with one object instead of a chain.
   *
   * ```ts
   * await jobs.schedule("sendMails")
   *   .withOptions({ every: "2 days", data: list, attempts: 5 })
   *   .start();
   * ```
   *
   * Every field goes through the method of the same name, so a duration, a
   * phrase or a cron expression is read exactly as the chain would read it and
   * fails with the same message. It can be mixed with the chain in either
   * order; whatever is said last wins, as it would for two method calls.
   *
   * Also the escape hatch: anything `add()` accepts can be said here, under
   * either the builder's name for it or the raw one.
   */
  withOptions(options: JobBuilderOptions<TData>): this {
    rejectBoth(options, "in", "delay");
    rejectBoth(options, "on", "runAt");
    rejectBoth(options, "unique", "jobId");

    // A whole repeat object first, so the individual fields refine it rather
    // than being overwritten by it.
    if (options.repeat) {
      this.#repeat = { ...this.#repeat, ...options.repeat };
    }

    if (options.data !== undefined) this.withData(options.data);

    if (options.every !== undefined) this.every(options.every);
    if (options.on !== undefined) this.on(options.on);
    if (options.runAt !== undefined) this.on(options.runAt);
    if (options.in !== undefined) this.in(options.in);
    if (options.delay !== undefined) this.in(options.delay);
    if (options.startingAt !== undefined) this.startingAt(options.startingAt);
    if (options.endingAt !== undefined) this.endingAt(options.endingAt);
    if (options.limit !== undefined) this.limit(options.limit);
    if (options.tz !== undefined) this.tz(options.tz);
    if (options.catchUp !== undefined) this.catchUp(options.catchUp);
    if (options.immediately !== undefined)
      this.immediately(options.immediately);
    if (options.repeatKey !== undefined) {
      this.#repeat = { ...this.#repeat, key: options.repeatKey };
    }

    if (options.priority !== undefined) this.priority(options.priority);
    if (options.attempts !== undefined) this.attempts(options.attempts);
    if (options.timeout !== undefined) this.timeout(options.timeout);
    if (options.backoff !== undefined) this.backoff(options.backoff);
    if (options.unique !== undefined) this.unique(options.unique);
    if (options.deadLetter !== undefined) this.deadLetter(options.deadLetter);
    if (options.debounce !== undefined) {
      this.debounce(options.debounce.id, options.debounce.ttl);
    }
    if (options.throttle !== undefined) {
      this.throttle(options.throttle.id, options.throttle.ttl);
    }
    if (options.keepLogs !== undefined) this.keepLogs(options.keepLogs);
    if (options.jobId !== undefined) this.unique(options.jobId);

    if (options.removeOnComplete !== undefined) {
      this.#options.removeOnComplete = options.removeOnComplete;
    }
    if (options.removeOnFail !== undefined) {
      this.#options.removeOnFail = options.removeOnFail;
    }
    if (options.keepStacktraces !== undefined) {
      this.#options.keepStacktraces = options.keepStacktraces;
    }

    return this;
  }

  /**
   * Adds the job, and answers with it.
   *
   * The only method that does anything. Everything before it describes.
   */
  async start(): Promise<Job<TData, TResult>> {
    const options: JobOptions = { ...this.#defaults, ...this.#options };
    // Worked on as a copy, so starting the same builder twice reads its
    // phrases twice rather than inheriting the first reading.
    let repeat: RepeatOptions | undefined = this.#repeat
      ? { ...this.#repeat }
      : undefined;

    if (this.#when !== undefined) {
      const { value, is } = this.#when;
      const at =
        typeof value === "string"
          ? parseWhen(value, is, Date.now(), this.#queue.dateParser)
          : value;

      if (is === "startAt" || repeat) {
        repeat = { ...repeat, startAt: at };
      } else {
        options.runAt = at;
      }
    }

    // On a series the queue reads only `repeat.startAt`, and silently ignores
    // `runAt` — so one that still stands here (from the definition's
    // defaults) says where the series begins, unless a start was given.
    if (repeat && options.runAt !== undefined) {
      repeat.startAt ??= options.runAt;
      delete options.runAt;
    }

    if (repeat) {
      options.repeat = { ...repeat, ...options.repeat };

      // Occurrence ids are derived, so the queue would drop this silently.
      if (options.jobId !== undefined) {
        options.repeat.key ??= options.jobId;
        delete options.jobId;
      }
    }

    return await this.#queue.add(this.#name, this.#data as TData, options);
  }
}

/** Refuses an options object that says one thing under both of its names. */
function rejectBoth(
  options: JobBuilderOptions<unknown>,
  builderName: keyof JobBuilderOptions<unknown>,
  rawName: keyof JobBuilderOptions<unknown>,
): void {
  if (options[builderName] !== undefined && options[rawName] !== undefined) {
    throw new ConfigError(
      `withOptions() was given both "${builderName}" and "${rawName}", which mean the same thing; give one`,
      { [builderName]: options[builderName], [rawName]: options[rawName] },
    );
  }
}

/** Reads a duration, or says which method could not read it. */
function requireDuration(input: string, what: string): number {
  const ms = parseDuration(input);

  if (ms === null) {
    throw new ConfigError(`${what} could not read "${input}" as a duration`, {
      input,
    });
  }

  return ms;
}

/**
 * Whether `zone` names a time zone this runtime knows. `Intl` is the
 * authority the schedule is later read with, so asking it now gives the same
 * answer that an occurrence would.
 */
function isTimeZone(zone: string): boolean {
  if (typeof zone !== "string" || zone.length === 0) {
    return false;
  }

  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
