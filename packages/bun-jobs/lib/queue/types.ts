import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  DriverConfig,
  JobsDriver,
  JobState,
  RepeatRecord,
  Retention,
  ThroughputBucket,
} from "../drivers/index";
import type { DateParser } from "../shared/humanTime";
import type { Logger, LoggerLike } from "../shared/logger";
import type {
  BackoffStrategies,
  BackoffStrategy,
  JobBackoffOptions,
} from "./backoff";
import type { IsolationMode, IsolationOptions } from "./isolation";
import type { Job } from "./Job";

/**
 * The queue's public types.
 *
 * A job is a name, a payload and a set of options; everything else here
 * describes when it may run, how often it may be retried, and how long its
 * outcome is kept.
 */

/**
 * How a repeatable job repeats.
 *
 * ```ts
 * { every: 60_000 }
 * { every: "2 days" }                                     // or "every 2 days", "daily"
 * { every: "0 9 * * 1", tz: "Europe/London" }             // cron, by its shape
 * { every: "every 2 weeks starting 1st december 2026" }   // interval + start
 * { every: "every day from 1 dec 2026 until 31 dec 2026" }// interval + window
 * { every: "1 hour", startAt: "tomorrow at 9am" }
 * ```
 *
 * Words are read when the job is added, so "starting tomorrow" means tomorrow
 * from then. Reading dates needs the optional `chrono-node`; an interval alone
 * does not. A series is identified by its schedule and start, so a phrase that
 * names a relative start gives a new series each time it resolves differently;
 * give `key` when re-adding one must update it.
 */
export interface RepeatOptions {
  /** Cron expression, five- or six-field (seconds first). */
  cron?: string;
  /** IANA time zone the cron expression is read in. */
  tz?: string;
  /**
   * How often, as an alternative to `cron`: milliseconds, a duration
   * (`"2 days"`), a cron expression, or a phrase that may also name the start
   * and end (`"every 2 weeks starting 1st december 2026"`). Dates inside the
   * phrase fill `startAt`/`endAt` only when those are not given.
   */
  every?: number | string;
  /** Do not run before this instant — a `Date`, epoch milliseconds, or words. */
  startAt?: Date | number | string;
  /** Do not run after this instant — a `Date`, epoch milliseconds, or words. */
  endAt?: Date | number | string;
  /** Stop after this many occurrences. */
  limit?: number;
  /** Identifies the series. Defaults to one derived from the other options. */
  key?: string;
  /** Run once as soon as the series is created, then follow the schedule. */
  immediately?: boolean;
  /**
   * Run every occurrence that was missed while nothing was consuming, rather
   * than skipping to the next one. Defaults to `false`.
   */
  catchUp?: boolean;
}

/** Everything `add()` accepts about one job. */
export interface JobOptions {
  /**
   * Identifies the job, and doubles as its idempotency key: adding the same
   * id twice returns the existing job untouched. Defaults to a fresh id.
   */
  jobId?: string;
  /** Lower runs first; ties break FIFO. Defaults to `0`. */
  priority?: number;
  /** Milliseconds to wait before the job may run. */
  delay?: number;
  /** Absolute time the job may run. Wins over `delay`. */
  runAt?: Date | number;
  /** Total attempts, including the first. Defaults to `1`. */
  attempts?: number;
  /**
   * Delay between attempts: a number of milliseconds, or a schedule.
   * Defaults to exponential from 1s, capped at 5 minutes, with jitter.
   */
  backoff?: number | JobBackoffOptions;
  /** Per-attempt timeout in milliseconds. `0` (the default) means none. */
  timeout?: number;
  /**
   * How long a completed job is kept: `true` removes it immediately, `false`
   * keeps it forever, a number keeps that many, `{ count, ttl }` does both.
   * Defaults to a 24-hour TTL.
   */
  removeOnComplete?: Retention;
  /** The same, for a job that exhausted its attempts. Defaults to `false`. */
  removeOnFail?: Retention;
  /** How many stack traces a failing job keeps. Defaults to `5`. */
  keepStacktraces?: number;
  /**
   * A queue, in the same namespace, that receives a copy of this job when it
   * dies — as a {@link DeadLetter} carrying the original id, data and error.
   * Wins over the worker's `deadLetterQueue`. The dead job itself is kept or
   * removed by `removeOnFail` as usual.
   */
  deadLetter?: string;
  /**
   * Keeps one pending job per `id` instead of adding another each time.
   *
   * While a job added under this id has not started, a further add replaces
   * its data and pushes its run time back to `ttl` from now; once it has
   * started, the next add is a new job. The first add's other options stay.
   * `ttl` is milliseconds or a duration such as `"30 seconds"`. Not with
   * `repeat`, `jobId` or `throttle`.
   */
  debounce?: DebounceOptions;
  /**
   * Adds at most one job per `id` per `ttl`: an add inside the window adds
   * nothing and answers with the job that opened it. Not with `repeat`,
   * `jobId` or `debounce`.
   */
  throttle?: DebounceOptions;
  /**
   * How many log lines the job keeps, newest last; older lines are dropped.
   * `0` keeps every line. Defaults to `1000`.
   */
  keepLogs?: number;
  /** Makes this a repeatable job. */
  repeat?: RepeatOptions;
  /**
   * For a child in a flow: when it fails for good, its parent carries on,
   * with the failure available beside the other children's results. By
   * default a failed child fails its parent. Defaults to `false`.
   */
  ignoreFailure?: boolean;
}

/**
 * One job in a flow, with the jobs it waits on.
 *
 * A job with `children` is added waiting on them and runs once they have all
 * settled; it reads their results with `job.getChildrenValues()`. Children
 * may be in any queue of the same namespace, and have children of their own.
 */
export interface FlowNode<TData = unknown> {
  /** The job's name. */
  name: string;
  /** Its payload. */
  data: TData;
  /**
   * Its options. `repeat`, `debounce` and `throttle` are not allowed in a
   * flow; `ignoreFailure` on a child lets its parent carry on without it.
   */
  opts?: JobOptions;
  /**
   * The queue it goes in, in the same namespace. Defaults to its parent's
   * queue, and for the top of the flow to the queue `addFlow` is called on.
   */
  queue?: string;
  /** The jobs that must settle before this one runs. */
  children?: FlowNode[];
}

/**
 * A flow as it was added: each job, with its children in the same shape.
 *
 * @typeParam TData The top job's payload type.
 * @typeParam TResult The top job's result type.
 * @typeParam TJob The top job's type: `Job<TData, TResult>` by default, a
 * `TypedJob` from a registry-bound queue.
 */
export interface FlowResult<
  TData = unknown,
  TResult = unknown,
  TJob = Job<TData, TResult>,
> {
  /** The job. */
  job: TJob;
  /** Its children, in the order they were given. */
  children: FlowResult[];
}

/** Which debounce or throttle a job belongs to, and for how long. */
export interface DebounceOptions {
  /** Jobs sharing this id are debounced or throttled together. */
  id: string;
  /** The window: milliseconds, or a duration such as `"30 seconds"`. */
  ttl: number | string;
}

/* --- the typed job registry ------------------------------------------ *
 *
 * A service knows its own job names at compile time, and knows what each one
 * carries. Declaring that once, as a map, is what lets `define`, `now`,
 * `schedule`, `create` and a registry-bound `add` check the name and infer the
 * payload — rather than every call site repeating `<Mail>` and nothing
 * catching the one that repeats it wrong.
 *
 * The map is opt-in, and its absence is the default: a `BunJobs` with no type
 * argument is `BunJobs<JobMap>`, whose keys are `string`, and every signature
 * below reads that as "no map declared" and falls back to exactly the types
 * the package had before.
 */

/**
 * What one name in a {@link JobMap} carries, and what running it answers with.
 *
 * `data` is required — a job with no payload declares `data: void` — because
 * an entry is always an object with those keys. A bare payload type is
 * deliberately *not* accepted: `{ data: Buffer }` would be ambiguous between
 * "an entry whose data is a Buffer" and "a payload that happens to have a
 * `data` field", and one spelling that always means the same thing is worth
 * more than the characters the other would save.
 */
export interface JobTypeEntry {
  /** What a job of this name carries. `void` for one with no payload. */
  data: unknown;
  /**
   * What its handler answers with. Omitted means `unknown`, which is what a
   * job whose return value nothing reads should say.
   */
  result?: unknown;
}

/**
 * A service's jobs declared as types: each name it defines, mapped to what
 * that job carries and what running it answers with.
 *
 * ```ts
 * interface Jobs {
 *   "send-report": { data: { month: string }; result: string };
 *   "reindex": { data: void };
 * }
 *
 * const jobs = new BunJobs<Jobs>({ namespace: "reports", driver });
 * ```
 *
 * `JobMap` itself is also the default type argument, and that is the whole
 * back-compatibility mechanism: `keyof JobMap` is `string`, so
 * `string extends keyof TJobs` is true exactly when no map was declared, and
 * every signature keyed on it falls back to its former shape.
 */
export type JobMap = Record<string, JobTypeEntry>;

/**
 * The constraint a declared map has to satisfy.
 *
 * Written as a mapped type over `TJobs`'s *own* keys rather than as
 * `Record<string, JobTypeEntry>`, because a map is meant to be written as an
 * `interface` and an interface has no implicit index signature — it would fail
 * `Record` for that reason alone, with a message about index signatures that
 * says nothing about the entry that is actually wrong. This way the error
 * names the offending entry.
 */
export type JobMapOf<TJobs> = { [TName in keyof TJobs]: JobTypeEntry };

/**
 * `TWhen` for a context that declared a job map, and `never` for one that did
 * not — which makes a signature written in terms of it uncallable there.
 *
 * This, and {@link WhenUndeclared}, are how the typed and untyped overloads of
 * one method are kept mutually exclusive. Without the gate the wider overload
 * catches what the narrow one rejects, and a wrong payload compiles.
 */
export type WhenDeclared<TJobs, TWhen> = string extends keyof TJobs
  ? never
  : TWhen;

/**
 * `TWhen` for a context that declared no job map, and `never` for one that
 * did. The mirror of {@link WhenDeclared}.
 */
export type WhenUndeclared<TJobs, TWhen> = string extends keyof TJobs
  ? TWhen
  : never;

/** Every name a map declares; `string` for a context with no map. */
export type JobName<TJobs> = keyof TJobs & string;

/**
 * The names the narrow, map-checked overloads accept: the declared ones, and
 * `never` when nothing was declared.
 */
export type TypedJobName<TJobs> = WhenDeclared<TJobs, keyof TJobs & string>;

/**
 * The names the wide, back-compatible overloads accept: any string when no map
 * was declared, and `never` when one was.
 */
export type UntypedJobName<TJobs> = WhenUndeclared<TJobs, string>;

/**
 * What one declared name's entry says its jobs carry.
 *
 * Read with `infer` rather than as `TJobs[TName]["data"]` so it answers
 * `unknown` — never an error — for a `TJobs` that turns out not to describe
 * that name. `TName` is one name here; {@link JobDataOf} is what handles a
 * union of them.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TName One declared name.
 */
export type JobEntryData<
  TJobs,
  TName extends keyof TJobs,
> = TJobs[TName] extends { data: infer TData } ? TData : unknown;

/**
 * What one declared name's entry says running it answers with — `unknown`
 * when the entry leaves `result` out.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TName One declared name.
 */
export type JobEntryResult<
  TJobs,
  TName extends keyof TJobs,
> = TJobs[TName] extends { result: infer TResult } ? TResult : unknown;

/**
 * Every member of a union, as one intersection — computed by placing each
 * member in a contravariant position and inferring once across them all.
 *
 * Each member arrives here already boxed as a whole payload, so a payload
 * that is itself a union (`{ kind: "a" } | { kind: "b" }`) stays one union
 * rather than being intersected with itself into `never`.
 *
 * @typeParam TBoxed A union of `(value: T) => void`, one per member to intersect.
 */
type IntersectBoxed<TBoxed> = [TBoxed] extends [(value: infer TAll) => void]
  ? TAll
  : never;

/**
 * `true` when `T` is a union of two or more members, `false` for one.
 *
 * Each member is compared with the whole: only a union is wider than every
 * one of its members.
 *
 * @typeParam T The type to test.
 * @typeParam TWhole `T` itself, kept whole while `T` distributes.
 */
type IsUnion<T, TWhole = T> = T extends unknown
  ? [TWhole] extends [T]
    ? false
    : true
  : never;

/**
 * An intersection of object types, flattened into the one object type it
 * describes — `{ a: string } & { b: number }` as `{ a: string; b: number }`.
 *
 * Only ever an equivalence. The mapped copy always accepts what `T` accepts;
 * it is used only when `T` accepts the copy too, and otherwise `T` is left as
 * it is — a class with private members, or a callable, loses something a
 * mapped type cannot copy. Not an object at all, `T` is left alone.
 * Distributes, so each member of a union is flattened on its own.
 *
 * @typeParam T The type to flatten.
 */
type Flatten<T> = T extends object
  ? [{ [TKey in keyof T]: T[TKey] }] extends [T]
    ? { [TKey in keyof T]: T[TKey] }
    : T
  : T;

/**
 * The intersection of the payloads of `TName` that are objects, or of those
 * that are not — `TObjects` says which — and `unknown` when there are none.
 *
 * Split so the object half can be flattened and the rest, such as `void`,
 * kept beside it: flattening `{ month: string } & void` whole would drop the
 * `void`, and accept payloads the intersection refuses.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TName The names, a union.
 * @typeParam TObjects `true` for the payloads that are objects, `false` for
 * the rest.
 */
type PayloadPart<
  TJobs,
  TName extends keyof TJobs,
  TObjects extends boolean,
> = IntersectBoxed<
  TName extends keyof TJobs
    ? (
        [JobEntryData<TJobs, TName>] extends [object] ? true : false
      ) extends TObjects
      ? (value: JobEntryData<TJobs, TName>) => void
      : never
    : never
>;

/**
 * The payload a job of `TName` may be given, according to the map.
 *
 * For one name, that name's `data`. For a *union* of names it is the
 * intersection of their payloads, because it is a value going in: a payload
 * handed to "whichever of these it turns out to be" has to satisfy each of
 * them. So two names that carry the same shape accept that shape, and two
 * whose shapes cannot both hold — `{ month: string }` and `void` — accept
 * nothing, which is exactly what their union should accept.
 *
 * The union would be the unsound choice: `now(name as "a" | "b", payloadOfA)`
 * would compile and run `b`'s handler on `a`'s payload.
 *
 * The object payloads' part of the intersection is flattened for display —
 * `{ userId: string } & { userId: string }` reads as `{ userId: string }` —
 * only where that is an exact equivalence; see {@link Flatten}.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TName A declared name, or a union of them.
 */
export type JobDataOf<TJobs, TName extends keyof TJobs> =
  true extends IsUnion<TName>
    ? Flatten<PayloadPart<TJobs, TName, true>> &
        PayloadPart<TJobs, TName, false>
    : JobEntryData<TJobs, TName>;

/**
 * What a job of `TName` answers with, according to the map — `unknown` when
 * its entry leaves `result` out.
 *
 * For a union of names, the union of their results: this is a value coming
 * out*, and a job of any one of those names may be the one that answered.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TName A declared name, or a union of them.
 */
export type JobResultOf<
  TJobs,
  TName extends keyof TJobs,
> = TName extends keyof TJobs ? JobEntryResult<TJobs, TName> : never;

/**
 * What a handler defined for `TName` must answer with. For one name, that
 * name's result; for a union, the intersection of theirs, since the handler
 * is registered under whichever one the name turns out to be at runtime and
 * must satisfy that one — so it has to satisfy each.
 *
 * A single name reads its entry directly, so a handler's literal return —
 * `() => ({ via: "email" })` for a declared `{ via: "email" }` — keeps its
 * literal; see {@link JobHandlerResultOfEach}.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TName A declared name, or a union of them.
 */
export type JobHandlerResultOf<
  TJobs,
  TName extends keyof TJobs,
> = JobHandlerResultOfEach<TJobs, TName, TName>;

/**
 * {@link JobHandlerResultOf}, distributed over `TName` with the whole union
 * kept in `TWhole`.
 *
 * Each member of a union answers with its own result intersected with every
 * member's. That is the same type as the plain intersection, but spelled so
 * that the member's own result is visible in it: TypeScript decides whether a
 * handler's `return { via: "email" }` keeps its literal from the *constraint*
 * of the return type while `TName` is being inferred, and the bare
 * intersection's constraint is `unknown`, which widens `"email"` to `string`.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TName One member of `TWhole`, as distribution hands it over.
 * @typeParam TWhole Every name the handler is defined for.
 */
type JobHandlerResultOfEach<
  TJobs,
  TName extends keyof TJobs,
  TWhole extends keyof TJobs,
> = TName extends keyof TJobs
  ? [TWhole] extends [TName]
    ? JobEntryResult<TJobs, TName>
    : JobEntryResult<TJobs, TName> &
        IntersectBoxed<
          TWhole extends keyof TJobs
            ? (value: JobEntryResult<TJobs, TWhole>) => void
            : never
        >
  : never;

/**
 * The arguments that carry a payload, as a tuple: optional exactly when
 * leaving it out is itself a valid payload.
 *
 * That is `[undefined] extends [TData]`, not `[TData] extends [void |
 * undefined]`, and the difference matters for a union name: two names
 * carrying `{ month: string }` and `void` intersect to `{ month: string } &
 * void`, which *is* assignable to `void` — so the second test would make the
 * payload optional for a pair that should accept nothing. Asking whether
 * `undefined` is a valid payload gives the right answer for `void`,
 * `undefined`, `unknown` and every union containing `undefined`, and refuses
 * that pair.
 *
 * @typeParam TData The payload type the call takes.
 */
export type DataArgs<TData> = [undefined] extends [TData]
  ? [data?: TData]
  : [data: TData];

/**
 * The trailing arguments of an immediate add — the payload, required unless
 * leaving it out is valid (see {@link DataArgs}), then the job's options.
 *
 * @typeParam TData The payload type the call takes.
 */
export type JobAddArgs<TData> = [...DataArgs<TData>, options?: JobOptions];

/**
 * A name the escape-hatch `add` accepts: one literal the map does *not*
 * declare. `never` — so the call cannot compile — for a declared name, whose
 * payload the checked overload already knows, and for plain `string`, which
 * could be any declared name at runtime.
 *
 * Distributes over a union, so of `"scratch" | "send-report"` only
 * `"scratch"` survives.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TName The name the escape hatch was given, as a literal.
 */
export type AdHocJobName<TJobs, TName extends string> = string extends TName
  ? never
  : TName extends JobName<TJobs>
    ? never
    : TName;

/**
 * A job read from the registry, discriminated by its name: checking
 * `job.name` narrows `job.data` and `job.returnValue` to that name's types.
 *
 * `TName` narrows it to some of the declared names, and defaults to all of
 * them. A job read back is typed on the assumption that the map describes
 * everything on the registry queue — a job added through the escape hatch,
 * under a name this map does not declare, is not described by it.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TName The names to include; every declared name by default.
 */
export type TypedJob<TJobs, TName extends JobName<TJobs> = JobName<TJobs>> = {
  [TEach in TName]: Job<JobDataOf<TJobs, TEach>, JobResultOf<TJobs, TEach>> & {
    /** The name, as the literal that discriminates this job. */
    readonly name: TEach;
  };
}[TName];

/**
 * What a handler defined for `TName` is given and must answer with: a job
 * discriminated by name, and that name's result.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TName The name, or names, the handler is defined for.
 */
export type TypedJobProcessor<TJobs, TName extends JobName<TJobs>> = (
  job: TypedJob<TJobs, TName>,
  ctx: ProcessorContext,
) =>
  | JobHandlerResultOf<TJobs, TName>
  | Promise<JobHandlerResultOf<TJobs, TName>>;

/**
 * The payload property of an entry that names its job: optional exactly when
 * leaving it out is a valid payload — the object form of {@link DataArgs}.
 *
 * @typeParam TData The payload type the entry takes.
 */
export type DataField<TData> = [undefined] extends [TData]
  ? {
      /** The payload; may be left out, since that is a valid payload. */
      data?: TData;
    }
  : {
      /** The payload. */
      data: TData;
    };

/**
 * One entry of `addBulk` on a registry-bound queue, discriminated by name:
 * each declared name with exactly its payload. An entry whose `name` is a
 * union is checked against every member, so its payload has to suit each.
 *
 * Written as a distributive conditional over `TName`, rather than a mapped
 * type, so that `addBulk` can infer each entry's name from it.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TName The names to include; every declared name by default.
 */
export type RegistryBulkEntry<
  TJobs,
  TName extends JobName<TJobs> = JobName<TJobs>,
> =
  TName extends JobName<TJobs>
    ? {
        /** A declared name. */
        name: TName;
        /** The job's options. */
        opts?: JobOptions;
      } & DataField<JobDataOf<TJobs, TName>>
    : never;

/**
 * A flow node that stays on the registry queue — the top of a flow added
 * there, or a descendant that names no `queue` of its own and so inherits it —
 * discriminated by name like {@link RegistryBulkEntry}.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TName The names to include; every declared name by default.
 * `addFlow` infers it from the top node, to type the job it answers with.
 */
export type RegistryFlowNode<
  TJobs,
  TName extends JobName<TJobs> = JobName<TJobs>,
> =
  TName extends JobName<TJobs>
    ? {
        /** A declared name. */
        name: TName;
        /** Its options, as on {@link FlowNode}. */
        opts?: JobOptions;
        /**
         * Left out: the node is on its parent's queue, the registry's. A node
         * on another queue is a {@link ForeignFlowNode}.
         */
        queue?: undefined;
        /** The jobs that must settle before this one runs. */
        children?: RegistryFlowChild<TJobs>[];
      } & DataField<JobDataOf<TJobs, TName>>
    : never;

/**
 * A node in a registry flow that names a queue of its own. The map does not
 * describe another queue, so its name and payload are unchecked, as on an
 * untyped queue — and so are its children, which inherit that queue.
 *
 * Naming the registry queue itself here, rather than leaving `queue` out, is
 * the one way past the check: a type cannot say "any string but this one",
 * so leave `queue` out for a node that belongs on the registry queue.
 */
export interface ForeignFlowNode extends FlowNode {
  /** The queue it goes in: one other than the registry's. */
  queue: string;
}

/**
 * A child in a registry flow: a {@link RegistryFlowNode} when it inherits the
 * registry queue, a {@link ForeignFlowNode} when it names another.
 *
 * @typeParam TJobs The declared job map.
 */
export type RegistryFlowChild<TJobs> =
  | RegistryFlowNode<TJobs>
  | ForeignFlowNode;

/**
 * What `addBulk` takes: plain entries with no declared map, exactly as
 * before, and with one, a {@link RegistryBulkEntry} per entry whose name is
 * inferred into `TNames` — which is what lets the result be typed entry by
 * entry.
 *
 * @typeParam TData The queue's payload type when no map is declared.
 * @typeParam TName The queue's job names when no map is declared.
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 * @typeParam TNames Each entry's name, in order: a tuple for an array
 * literal, an array of every declared name for an array built elsewhere.
 */
export type BulkEntriesOf<
  TData,
  TName,
  TJobs,
  TNames extends readonly string[],
> = string extends keyof TJobs
  ? {
      /** The job's name. */
      name: TName;
      /** Its payload. */
      data: TData;
      /** Its options. */
      opts?: JobOptions;
    }[]
  : {
      [TIndex in keyof TNames]: RegistryBulkEntry<
        TJobs,
        TNames[TIndex] & JobName<TJobs>
      >;
    };

/**
 * What `addBulk` answers with: plain jobs with no declared map, exactly as
 * before, and with one, each entry's job as a {@link TypedJob} of that
 * entry's name — a tuple, in order, for an array literal, and
 * `TypedJob<TJobs>[]` for an array whose names are not known statically.
 *
 * @typeParam TData The queue's payload type when no map is declared.
 * @typeParam TResult The queue's result type when no map is declared.
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 * @typeParam TNames Each entry's name, as {@link BulkEntriesOf} inferred it.
 */
export type BulkJobsOf<
  TData,
  TResult,
  TJobs,
  TNames extends readonly string[],
> = string extends keyof TJobs
  ? Job<TData, TResult>[]
  : {
      [TIndex in keyof TNames]: TypedJob<
        TJobs,
        TNames[TIndex] & JobName<TJobs>
      >;
    };

/**
 * What `addFlow` takes: a {@link FlowNode} with no declared map, exactly as
 * before, and a {@link RegistryFlowNode} with one, whose top name is inferred
 * into `TTop`.
 *
 * @typeParam TData The queue's payload type when no map is declared.
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 * @typeParam TTop The top node's name on a registry-bound queue.
 */
export type FlowNodeOf<
  TData,
  TJobs,
  TTop extends JobName<TJobs> = JobName<TJobs>,
> = string extends keyof TJobs
  ? FlowNode<TData>
  : RegistryFlowNode<TJobs, TTop>;

/**
 * The payload `update` may write: the queue's own with no declared map, and
 * on a registry-bound queue one valid for *every* declared name — the
 * intersection of their payloads. `update` is given an id, not a name, so the
 * job it changes could be any of them; a payload suiting only one would be
 * written under another's name as readily. See the README for changing a
 * payload on a map whose shapes differ.
 *
 * @typeParam TData The queue's payload type when no map is declared.
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 */
export type UpdateDataOf<TData, TJobs> = string extends keyof TJobs
  ? TData
  : JobDataOf<TJobs, JobName<TJobs>>;

/**
 * Every declared job's data as one union — what a registry-bound queue reads
 * back where the name is not known statically and a {@link TypedJob} does
 * not apply.
 *
 * Mapped and then indexed, so the union is built one entry at a time.
 */
export type JobMapData<TJobs> = {
  [TName in keyof TJobs]: JobDataOf<TJobs, TName>;
}[keyof TJobs];

/**
 * Every declared job's result as one union; see {@link JobMapData}.
 *
 * `unknown` whenever any entry leaves `result` out — `unknown` absorbs every
 * other member of a union, and that is the truth: a job of that name may
 * have answered with anything. Nothing reads a result through this where the
 * name is at hand. A {@link TypedJob} narrows `returnValue` per name, and the
 * name-scoped events (`completed:send-report`) carry that name's own result.
 */
export type JobMapResult<TJobs> = {
  [TName in keyof TJobs]: JobResultOf<TJobs, TName>;
}[keyof TJobs];

/** What a worker calls for each job. */
export type JobProcessor<TData = unknown, TResult = unknown> = (
  job: Job<TData, TResult>,
  ctx: ProcessorContext,
) => TResult | Promise<TResult>;

/** The second argument a processor receives. */
export interface ProcessorContext {
  /**
   * Aborted when the attempt times out, the worker is closing, or the job's
   * lock is lost. Long work should check it.
   */
  signal: AbortSignal;
  /** Logger bound to this job's ids. */
  logger: Logger;
  /** The worker's id. */
  workerId: string;
  /** 1-based attempt number. */
  attempt: number;
  /**
   * Extends the job's lock now, rather than waiting for the next heartbeat.
   * For a step that will take longer than `lockDuration` on its own.
   */
  heartbeat: () => Promise<void>;
  /**
   * Appends a line to the job's log, which outlives this attempt — readable
   * with `job.getLogs()` or `queue.getJobLogs(id)` from anywhere. Answers with
   * how many lines the log keeps.
   */
  log: (line: string) => Promise<number>;
}

/** Options for a {@link BunQueue}. */
export interface BunQueueOptions {
  /**
   * The namespace this queue belongs to. Required: the same queue name in
   * two namespaces is two queues, which is what keeps services sharing a
   * backend from colliding.
   */
  namespace: string;
  /** Where jobs live. A config is built and closed here; an instance is shared. */
  driver?: JobsDriver | DriverConfig;
  /** Logger, or anything `resolveLogger` accepts. */
  logger?: LoggerLike;
  /** Defaults merged under every `add()`. */
  defaultJobOptions?: JobOptions;
  /**
   * Re-emit events from other processes, so a producer can watch jobs a
   * worker elsewhere is running. Off by default: it costs a subscription.
   */
  subscribe?: boolean;
  /**
   * Publish this queue's events for other processes to receive.
   *
   * Separate from {@link BunQueueOptions.subscribe}, which it used to be
   * folded into — publishing was gated on whether *this* instance also
   * listened. That is the wrong way round for the arrangement it matters most
   * in: a dashboard subscribes and never produces, while the producers it
   * wants to watch listen to nothing and therefore said nothing.
   *
   * Defaults to whatever `subscribe` is, so existing behaviour is unchanged;
   * set it explicitly to publish without listening. It is not on by default
   * because each event is a round trip, and on a busy queue that is a round
   * trip per job.
   */
  publish?: boolean;
  /**
   * Awaited before each event is published. `BunJobs` passes one so an event
   * published the moment a queue, worker or runner is created waits for the
   * notifiers it opened to finish subscribing, instead of being lost. Unset,
   * nothing is awaited.
   */
  publishGate?: () => Promise<void>;
  /**
   * Reads the dates in phrases — `on("2nd december 2026")`, `every("every 2
   * weeks from payday")`, `repeat: { startAt: "tomorrow at 9am" }`. Defaults
   * to `chrono-node`, loaded when a phrase first needs it.
   *
   * Give one to read dates `chrono-node` does not, or to avoid installing it.
   * Checked when the queue is built; see `DateParser` for the shape.
   */
  dateParser?: DateParser;
}

/** Options for a {@link BunQueueWorker}. */
export interface BunQueueWorkerOptions {
  /**
   * Publish this worker's job events for other processes to receive.
   *
   * Off by default, and worth turning on for the case it exists for: the
   * worker is the only thing that knows a job became active, reported
   * progress, completed, failed or stalled, so without this a producer or a
   * dashboard elsewhere can only observe what it did itself.
   *
   * Each event is a round trip. On a queue draining thousands of jobs a second
   * that is the dominant cost of turning it on, which is why it is a choice.
   */
  publish?: boolean;
  /**
   * Awaited before each event is published. `BunJobs` passes one so an event
   * published the moment a queue, worker or runner is created waits for the
   * notifiers it opened to finish subscribing, instead of being lost. Unset,
   * nothing is awaited.
   */
  publishGate?: () => Promise<void>;
  /** The namespace to consume from. Must match the producer's. */
  namespace: string;
  /** Where jobs live. A config is built and closed here; an instance is shared. */
  driver?: JobsDriver | DriverConfig;
  /** Logger, or anything `resolveLogger` accepts. */
  logger?: LoggerLike;
  /** Identifies this worker in job records and logs. Defaults to a fresh id. */
  id?: string;
  /** How many jobs to process at once. Defaults to `1`. */
  concurrency?: number;
  /** How long a claim's lock lives. Defaults to 30000. */
  lockDuration?: number;
  /** How often to renew it. Defaults to a third of `lockDuration`. */
  heartbeatInterval?: number;
  /** How often to sweep for jobs whose worker died. Defaults to 30000. */
  stalledInterval?: number;
  /** How many times a job may stall before it is buried. Defaults to `1`. */
  maxStalledCount?: number;
  /** How long to wait between claim attempts. Defaults to 1000. */
  pollInterval?: number;
  /** Longest to block waiting for work on a blocking driver. Defaults to 5000. */
  maxBlock?: number;
  /**
   * Also promote delayed jobs, recover stalled ones, prune expired results
   * and heal repeat series. Every worker does this by default: each
   * operation is idempotent, so no leader election is needed and no single
   * process is load-bearing.
   */
  maintenance?: boolean;
  /** Start consuming as soon as it is constructed. Defaults to `false`. */
  autorun?: boolean;
  /** Milliseconds of quiet before `drained` is emitted. Defaults to 0. */
  drainDelay?: number;
  /**
   * How often the worker writes its heartbeat record — id, host, pid,
   * concurrency, jobs in flight, paused — which is what `queue.listWorkers()`
   * reads, in milliseconds. Defaults to `10000`; `0` turns reporting off.
   *
   * One write per interval per worker, and one each on start, pause, resume
   * and a concurrency change, never one per job. A record lapses three
   * intervals after its last write, so a worker that dies stops being listed
   * within that; one that closes removes its record straight away. Separate
   * from `maintenance`, because a worker that leaves maintenance to others is
   * still a worker.
   */
  reportInterval?: number;
  /**
   * Where a processor *file* runs each attempt:
   *
   * - `"in-process"` (the default) imports it once and calls it on the
   *   worker's thread, exactly like a function processor.
   * - `"worker"` runs each attempt in a fresh `Worker`: a separate JavaScript
   *   context that can be terminated, in the same process.
   * - `"spawn"` runs each attempt in a child process: the only mode where a
   *   processor that ignores its signal can be killed for certain.
   *
   * Only for a processor given as a file path or URL. The file default-exports
   * the same `(job, ctx) => result` a function processor is; `defineProcessor`
   * types it. In a child, `job.log`, `job.updateProgress`, `job.touch` and
   * `ctx.heartbeat` work through the worker; operations that change the
   * stored job directly are unavailable.
   */
  isolation?: IsolationMode;
  /** Timeouts and executor options for isolated processors. */
  isolationOptions?: IsolationOptions;
  /**
   * Named backoff strategies, for jobs whose `backoff.type` names one.
   *
   * Resolved here, on the worker, because a job's options are stored and a
   * function cannot be. A job naming a strategy this worker was not given
   * falls back to the default backoff and logs a warning rather than losing
   * its remaining attempts. A worker from `BunJobs` is given the strategies
   * registered with `defineBackoff`.
   */
  backoffStrategies?: BackoffStrategies | Record<string, BackoffStrategy>;
  /**
   * The dead-letter queue for jobs that do not name their own `deadLetter`.
   * Unset by default: a dead job stays where it died.
   */
  deadLetterQueue?: string;
  /**
   * How long the queue's stored limits are trusted before a worker reads them
   * again, in milliseconds. A change made with `queue.setLimits()` reaches
   * every worker within this. Defaults to `1000`.
   */
  limitsRefreshInterval?: number;
  /**
   * Whether a running worker keeps the process alive while it waits for work.
   * Defaults to `true`, as `BunRunner`'s option of the same name does.
   *
   * Every wait the worker makes is unref'd, so that it never holds up a
   * process that has other reasons to exit. Without this, a process whose
   * only work *is* a worker — a worker service — would exit the moment its
   * queue went idle. Set `false` for a script that runs a worker alongside
   * work of its own and should exit when that work is done.
   *
   * `false` releases only the worker's own hold. Whether anything else holds
   * the process depends on the driver's client: the Redis, Postgres and
   * MongoDB clients keep an open connection that holds it by itself, and none
   * of them can be unref'd — with one of those, close the driver (or
   * `jobs.close()`) once the script's own work is done. Bun's MySQL client,
   * used for MySQL and MariaDB, does not hold the process, and neither do the
   * memory, file and SQLite drivers, so an idle process on any of those exits.
   */
  waitToExit?: boolean;
}

/** A repeat series as {@link BunQueue.listRepeatables} reports it. */
export interface RepeatableInfo extends RepeatRecord {
  /**
   * Whether the series is disabled: it schedules nothing until it is enabled
   * again. Always `false` on a driver without queue state.
   */
  disabled: boolean;
}

/**
 * What a dead-letter queue receives: the job that died, as it was.
 *
 * Added under the original job's name, so a worker on the dead-letter queue
 * can dispatch on it exactly as the original worker did, and with an id
 * derived from the original's, so a failure noticed twice files one letter.
 */
export interface DeadLetter<TData = unknown> {
  /** The queue the job died in. */
  queue: string;
  /** Its id there. */
  id: string;
  /** Its name. */
  name: string;
  /** What it carried. */
  data: TData;
  /** The failure that killed it. */
  failedReason: SerializedError;
  /** How many attempts it had made. */
  attemptsMade: number;
  /** When it died, in epoch milliseconds. */
  diedAt: number;
}

/**
 * Which finished jobs {@link BunQueue.retryAll} returns to the queue.
 *
 * @typeParam TData The jobs' payload type.
 * @typeParam TResult The jobs' result type.
 * @typeParam TJob The job type `filter` is handed: `Job<TData, TResult>` by
 * default, a `TypedJob` on a registry-bound queue.
 * @typeParam TName The type of `name`: any string by default; on a
 * registry-bound queue, the literal that narrows what `filter` is handed.
 */
export interface RetryAllOptions<
  TData = unknown,
  TResult = unknown,
  TJob = Job<TData, TResult>,
  TName extends string = string,
> {
  /** Only jobs with this name. */
  name?: TName;
  /**
   * Only jobs whose last failure matches: a substring of, or a pattern tested
   * against, `"<error name>: <message>"`. A job with no failure never matches,
   * so this selects nothing among completed jobs.
   */
  reason?: string | RegExp;
  /** Only jobs this returns `true` for. Applied after `name` and `reason`. */
  filter?: (job: TJob) => boolean;
  /** Stop after this many. Defaults to every match. */
  limit?: number;
  /** Start their attempts again from zero. Defaults to `true`, as `retry()` does. */
  resetAttempts?: boolean;
}

/**
 * The job a registry-bound `retryAll`'s `filter` is handed, given the `name`
 * it was told to match: a {@link TypedJob} of that name when the map declares
 * it, and a plain `Job<unknown, unknown>` when it does not — a name added
 * through the escape hatch, or a `string` that could be anything.
 *
 * Distributes over a union, so `"send-report" | "audit"` is handed either.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TRetryName The `name` option, or every declared name without one.
 */
export type RetryJobOf<TJobs, TRetryName extends string> =
  TRetryName extends JobName<TJobs>
    ? TypedJob<TJobs, TRetryName>
    : Job<unknown, unknown>;

/**
 * What `retryAll` takes: {@link RetryAllOptions} exactly as before with no
 * declared map, and with one, options whose `name` narrows the job `filter`
 * is handed — `{ name: "send-report", filter: (job) => job.data.month … }`.
 *
 * @typeParam TData The queue's payload type when no map is declared.
 * @typeParam TResult The queue's result type when no map is declared.
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 * @typeParam TRetryName The `name` option on a registry-bound queue.
 */
export type RetryAllOptionsOf<
  TData,
  TResult,
  TJobs,
  TRetryName extends string,
> = string extends keyof TJobs
  ? RetryAllOptions<TData, TResult>
  : RetryAllOptions<
      JobMapData<TJobs>,
      JobMapResult<TJobs>,
      RetryJobOf<TJobs, TRetryName>,
      TRetryName
    >;

/**
 * The events that are about one job, and so can be scoped to its name.
 *
 * Everything else is about the queue — it was paused, it was drained — or
 * about an id with no name to hand: `removed` and `promoted` carry an id, and
 * `stalled` carries several. Scoping those would mean fetching a record to
 * work out an event name, which is the wrong way round.
 */
export type JobScopedEvent =
  | "added"
  | "duplicate"
  | "waiting"
  | "delayed"
  | "active"
  | "progress"
  | "completed"
  | "failed"
  | "retrying"
  | "dead"
  | "deadLettered"
  | "debounced"
  | "throttled";

/**
 * The same job events, qualified by the job's name.
 *
 * `queue.on("completed:sendEmail", ...)` fires only for jobs named
 * `sendEmail`, with exactly the arguments `completed` takes. A consumer that
 * runs twenty kinds of job through one queue would otherwise filter by name in
 * every listener, which is both noisier and slower — every listener runs for
 * every job.
 *
 * The unqualified event still fires as well, so a listener that wants all of
 * them is unaffected.
 */
export type JobScopedEvents<TEvents, TName extends string = string> = {
  [Event in keyof TEvents &
    JobScopedEvent as `${Event}:${TName}`]: TEvents[Event];
};

/**
 * Events a {@link BunQueue} emits.
 *
 * @typeParam TData The jobs' payload type.
 * @typeParam TResult The jobs' result type.
 * @typeParam TJob The job type listeners are handed: `Job<TData, TResult>` by default, a `TypedJob` on a registry-bound queue.
 */
// eslint-disable-next-line ts/consistent-type-definitions
type BunQueueBaseEvents<
  TData = unknown,
  TResult = unknown,
  TJob = Job<TData, TResult>,
> = {
  /** A job was added. */
  added: (job: TJob) => void;
  /** An `add()` matched an existing id, so nothing was added. */
  duplicate: (job: TJob) => void;
  /** A job became claimable. */
  waiting: (job: TJob) => void;
  /** A job was added for later. */
  delayed: (job: TJob, runAt: number) => void;
  /** A worker claimed a job. */
  active: (job: TJob) => void;
  /** A job reported progress. */
  progress: (job: TJob, value: unknown) => void;
  /** A job completed. */
  completed: (job: TJob, result: TResult) => void;
  /** An attempt failed. */
  failed: (job: TJob, error: Error) => void;
  /** An attempt failed and another is due. */
  retrying: (job: TJob, error: Error, runAt: number) => void;
  /** A job exhausted its attempts, or failed unrecoverably. */
  dead: (job: TJob, error: Error) => void;
  /**
   * Jobs were recovered from workers that died holding them.
   *
   * A batch, matching `BunQueueWorkerEvents.stalled` and the wire. It used to
   * be `(jobId: string)` here and `(ids: string[])` there, for one event that
   * only ever has one source — so a listener saw a different shape depending
   * on which object it attached to, and the cross-process path could not have
   * satisfied both.
   */
  stalled: (ids: string[]) => void;
  /** A job was removed. */
  removed: (jobId: string) => void;
  /** A job was made claimable early. */
  promoted: (jobId: string) => void;
  /** The queue was paused. */
  paused: () => void;
  /** The queue was resumed. */
  resumed: () => void;
  /** Pending jobs were dropped. */
  drained: (count: number) => void;
  /** Finished jobs were removed. */
  cleaned: (ids: string[], state: JobState) => void;
  /** Finished jobs were returned to the queue together, by `retryJobs` or `retryAll`. */
  retried: (ids: string[]) => void;
  /**
   * An add found a pending job with the same debounce id, replaced its data
   * and pushed its run time back, rather than adding another.
   */
  debounced: (job: TJob) => void;
  /** An add fell inside a throttle window; `job` is the one that opened it. */
  throttled: (job: TJob) => void;
  /** A repeat series scheduled its next occurrence. */
  repeatScheduled: (key: string, nextRunAt: number) => void;
  /** Something failed outside a job. */
  error: (error: Error, context: string) => void;
};

/**
 * Everything a {@link BunQueue} emits: each event, and the same
 * events qualified by a job's name.
 */
export type BunQueueEvents<
  TData = unknown,
  TResult = unknown,
> = BunQueueBaseEvents<TData, TResult> &
  JobScopedEvents<BunQueueBaseEvents<TData, TResult>>;

/**
 * Events a {@link BunQueueWorker} emits.
 *
 * @typeParam TData The jobs' payload type.
 * @typeParam TResult The jobs' result type.
 * @typeParam TJob The job type listeners are handed: `Job<TData, TResult>` by default, a `TypedJob` on the registry worker.
 */
// eslint-disable-next-line ts/consistent-type-definitions
type BunQueueWorkerBaseEvents<
  TData = unknown,
  TResult = unknown,
  TJob = Job<TData, TResult>,
> = {
  /** The worker connected and started consuming. */
  ready: () => void;
  /** A job was claimed. */
  active: (job: TJob) => void;
  /** A job reported progress. */
  progress: (job: TJob, value: unknown) => void;
  /** A job completed. */
  completed: (job: TJob, result: TResult) => void;
  /** An attempt failed. */
  failed: (job: TJob, error: Error) => void;
  /** An attempt failed and another is due. */
  retrying: (job: TJob, error: Error, runAt: number) => void;
  /** A job exhausted its attempts. */
  dead: (job: TJob, error: Error) => void;
  /** A dead job was copied to its dead-letter queue, as `letter`. */
  deadLettered: (job: TJob, letter: Job<DeadLetter<TData>, unknown>) => void;
  /** Jobs were recovered from workers that died holding them. */
  stalled: (ids: string[]) => void;
  /** A job's lock was lost mid-attempt. */
  lockLost: (job: TJob) => void;
  /** There was nothing left to claim. */
  drained: () => void;
  /** The worker stopped claiming. */
  paused: () => void;
  /** The worker resumed claiming. */
  resumed: () => void;
  /** The worker began shutting down. */
  closing: () => void;
  /** The worker finished shutting down. */
  closed: () => void;
  /** Something failed outside a job. */
  error: (error: Error, context: string) => void;
};

/**
 * Everything a {@link BunQueueWorker} emits: each event, and the same
 * events qualified by a job's name.
 */
export type BunQueueWorkerEvents<
  TData = unknown,
  TResult = unknown,
> = BunQueueWorkerBaseEvents<TData, TResult> &
  JobScopedEvents<BunQueueWorkerBaseEvents<TData, TResult>>;

/**
 * Name-scoped events for a declared map: `completed:send-report` is heard
 * with that name's own job and result, rather than the whole map's union.
 *
 * Built by pairing each scopable event with each declared name and reading
 * the pair back out of the key. The event half never contains a colon, so
 * `${infer TEvent}:${infer TName}` splits at the right one even when a job
 * name contains colons of its own.
 *
 * @typeParam TJobs The declared job map.
 * @typeParam TEvents The unscoped event map, which says which events scope.
 * @typeParam TPerName Each declared name's own event map.
 */
type TypedScopedEvents<TJobs, TEvents, TPerName> = {
  [TKey in `${keyof TEvents & JobScopedEvent}:${JobName<TJobs>}`]: TKey extends `${infer TEvent extends keyof TEvents & JobScopedEvent}:${infer TName extends JobName<TJobs>}`
    ? TName extends keyof TPerName
      ? TEvent extends keyof TPerName[TName]
        ? TPerName[TName][TEvent]
        : never
      : never
    : never;
};

/** The queue events for one declared name, keyed by that name. */
type RegistryQueueEventsByName<TJobs> = {
  [TName in JobName<TJobs>]: BunQueueBaseEvents<
    JobDataOf<TJobs, TName>,
    JobResultOf<TJobs, TName>,
    TypedJob<TJobs, TName>
  >;
};

/**
 * What a registry-bound queue's listeners hear: every job event with a
 * {@link TypedJob}, so `job.name` narrows the rest of the job, and each
 * declared name's scoped events with exactly that name's job and result.
 */
export type RegistryQueueEvents<TJobs> = BunQueueBaseEvents<
  JobMapData<TJobs>,
  JobMapResult<TJobs>,
  TypedJob<TJobs>
> &
  TypedScopedEvents<
    TJobs,
    BunQueueBaseEvents<JobMapData<TJobs>, JobMapResult<TJobs>, TypedJob<TJobs>>,
    RegistryQueueEventsByName<TJobs>
  >;

/** The worker events for one declared name, keyed by that name. */
type RegistryWorkerEventsByName<TJobs> = {
  [TName in JobName<TJobs>]: BunQueueWorkerBaseEvents<
    JobDataOf<TJobs, TName>,
    JobResultOf<TJobs, TName>,
    TypedJob<TJobs, TName>
  >;
};

/**
 * What the listeners of a registry worker — the one `jobs.start()` returns —
 * hear. See {@link RegistryQueueEvents}.
 */
export type RegistryWorkerEvents<TJobs> = BunQueueWorkerBaseEvents<
  JobMapData<TJobs>,
  JobMapResult<TJobs>,
  TypedJob<TJobs>
> &
  TypedScopedEvents<
    TJobs,
    BunQueueWorkerBaseEvents<
      JobMapData<TJobs>,
      JobMapResult<TJobs>,
      TypedJob<TJobs>
    >,
    RegistryWorkerEventsByName<TJobs>
  >;

/**
 * The events a queue's listeners hear: the plain map for a queue with no
 * declared {@link JobMap}, exactly as before, and {@link RegistryQueueEvents}
 * for a registry-bound one.
 *
 * @typeParam TData The queue's payload type when no map is declared.
 * @typeParam TResult The queue's result type when no map is declared.
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 */
export type QueueEventsOf<TData, TResult, TJobs> = string extends keyof TJobs
  ? BunQueueEvents<TData, TResult>
  : RegistryQueueEvents<TJobs>;

/**
 * The worker counterpart of {@link QueueEventsOf}.
 *
 * @typeParam TData The worker's payload type when no map is declared.
 * @typeParam TResult The worker's result type when no map is declared.
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 */
export type WorkerEventsOf<TData, TResult, TJobs> = string extends keyof TJobs
  ? BunQueueWorkerEvents<TData, TResult>
  : RegistryWorkerEvents<TJobs>;

/**
 * What a queue's reads answer with: a plain `Job` for a queue with no declared
 * {@link JobMap}, exactly as before, and a {@link TypedJob} for a
 * registry-bound one.
 *
 * @typeParam TData The queue's payload type when no map is declared.
 * @typeParam TResult The queue's result type when no map is declared.
 * @typeParam TJobs The declared job map, or the default `JobMap` for none.
 * @typeParam TName On a registry-bound queue, the names the job may have:
 * every declared one by default, fewer where the call says which.
 */
export type QueueJobOf<
  TData,
  TResult,
  TJobs,
  TName extends JobName<TJobs> = JobName<TJobs>,
> = string extends keyof TJobs ? Job<TData, TResult> : TypedJob<TJobs, TName>;

/** A repeat definition as reported by `listRepeatables()`. */
export type Repeatable = RepeatRecord;

/** What `queue.list()` and `queue.page()` accept. */
export interface ListJobsOptions {
  /** Matching jobs to skip. Defaults to `0`. */
  offset?: number;
  /** The most jobs to return. Defaults to `100`. */
  limit?: number;
  /** `asc` is the state's natural order, the default; `desc` its reverse. */
  order?: "asc" | "desc";
  /**
   * Only jobs with this name, or one of these names, exactly. An empty array
   * matches nothing.
   */
  name?: string | string[];
  /**
   * Only jobs whose id or name contains this, ignoring case. Matched
   * literally, and never against the payload. Linear in the jobs in the
   * states asked for on every backend — no index serves a substring — so on a
   * large backlog pair it with a state that is small, or a name.
   */
  search?: string;
}

/**
 * A page of jobs, and how many matched in all.
 *
 * @typeParam TData The jobs' payload type.
 * @typeParam TResult The jobs' result type.
 * @typeParam TJob The job type the page holds: `Job<TData, TResult>` by default, a `TypedJob` from a registry-bound queue.
 */
export interface JobsPage<
  TData = unknown,
  TResult = unknown,
  TJob = Job<TData, TResult>,
> {
  /** The page. */
  jobs: TJob[];
  /** Every job that matched, ignoring `offset` and `limit`. */
  total: number;
}

/** A queue's recent throughput, a minute per bucket. */
export interface QueueThroughput {
  /** How long each bucket is, in milliseconds: `60000`. */
  interval: number;
  /** The start of the oldest bucket, in epoch milliseconds. */
  from: number;
  /** The start of the newest bucket — the current minute — in epoch milliseconds. */
  to: number;
  /**
   * One bucket per minute from `from` to `to`, oldest first, with zeros where
   * nothing finished. The newest is still filling.
   */
  buckets: ThroughputBucket[];
  /** Jobs completed across every bucket. */
  completed: number;
  /** Attempts failed across every bucket. */
  failed: number;
}

/** One queue in a namespace, as `jobs.getQueueSummaries()` reports it. */
export interface QueueSummary {
  /** The queue's name. */
  name: string;
  /** How many jobs are in each state. */
  counts: Record<JobState, number>;
  /** Every job in the queue, whatever its state. */
  total: number;
  /** Whether claiming is paused across every process. */
  paused: boolean;
}
