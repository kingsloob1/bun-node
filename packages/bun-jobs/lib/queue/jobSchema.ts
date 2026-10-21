/**
 * Job data and result schemas (plan `docs/plans/bun-validate/` §4.8): what a
 * definition, a queue or a worker declares with `schema: { data, result }`,
 * and the checks the queue and the worker run with it.
 *
 * - **At enqueue** `BunQueue` checks the data before anything is written, and
 *   stores what the producer sent (its JSON form), never the schema's output.
 * - **Before the handler** `BunQueueWorker` checks the stored data again, and
 *   hands the handler the schema's output: as it is in-process, through a
 *   `jsonClone` to a `Worker`, a child process or a container.
 * - **After the handler** the worker checks the result, when
 *   `resultValidation` asks it to, before recording the completion.
 *
 * Every check runs through bun-common's `validateStandard`, so an issue never
 * carries the value that failed. A queue or worker with no schema runs none of
 * this: its paths read one property and go on as before.
 */
import type {
  Policy,
  StandardOutcome,
  StandardSchemaV1,
  ValidationIssue,
} from "@kingsleyweb/bun-common";
import type { Logger } from "../shared/logger";
import {
  attachContract,
  defineTransport,
  validateStandard,
} from "@kingsleyweb/bun-common";
import { ConfigError, JobDataValidationError } from "../shared/errors";
import { assertJsonSafe } from "../shared/json";

/* --- public shapes ------------------------------------------------------ */

/**
 * A job's schemas, each any [Standard Schema](https://standardschema.dev)
 * (zod, valibot, arktype, yup, bun-jobs' own `s`, ...).
 */
export interface JobSchema {
  /**
   * Checks what a job carries: at enqueue (the producer's value is stored,
   * not the schema's output) and before its handler runs (which receives the
   * output). Must accept its own stored input every time it runs.
   */
  data?: StandardSchemaV1;
  /**
   * Checks what the handler answers with, under `resultValidation` (default
   * `"off"`). What is stored is what the handler returned.
   */
  result?: StandardSchemaV1;
}

/**
 * What a failed data check does, per site; each `"error"` by default.
 *
 * - `enqueue`: `"error"` rejects the add or update with a
 *   `JobDataValidationError` and writes nothing; `"warn"` writes it and logs
 *   one warning (no values); `"off"` does not check.
 * - `process`: `"error"` fails the attempt with an `UnrecoverableJobError`,
 *   straight to `dead`; `"warn"` runs the handler with the **stored input**
 *   and logs one warning; `"off"` does not check, and the handler gets the
 *   stored input.
 *
 * A queue reads `enqueue`; a worker reads `process` (and `enqueue` for a
 * `job.updateData()` its processor makes).
 */
export interface JobDataValidation {
  /** At enqueue (and update): `"error"` (default), `"warn"` or `"off"`. */
  enqueue?: Policy;
  /** Before the handler runs: `"error"` (default), `"warn"` or `"off"`. */
  process?: Policy;
}

/**
 * The validation options a definition, a queue and a worker take beside
 * their own.
 */
export interface JobValidationOptions<S extends JobSchema = JobSchema> {
  /**
   * The job's schemas, `{ data, result }`. On `define()` they are lifted out
   * of the options into `definition.schema`, so the options stay plain data.
   */
  schema?: S;
  /** What a failed data check does, at enqueue and before the handler. */
  dataValidation?: JobDataValidation;
  /**
   * What a result that fails `schema.result` does: `"off"` (default) does
   * not check; `"warn"` completes the job and logs one warning; `"error"`
   * fails the attempt, retryably, with no `completed` event and nothing
   * stored or delivered to a parent.
   */
  resultValidation?: Policy;
}

/**
 * `schema` as a producer's options type it, so `new BunQueue(name, { schema })`
 * infers what `add` takes (the data schema's input) and what a job's
 * `returnValue` is (the result schema's input: the handler's return, stored
 * as it was).
 */
export interface ProducerJobSchema<TData, TResult> extends JobSchema {
  /** Checks what a job carries; its input type is what `add` takes. */
  data?: StandardSchemaV1<TData, unknown>;
  /** Checks what the handler answers with; its input type is the stored result. */
  result?: StandardSchemaV1<TResult, unknown>;
}

/**
 * `schema` as a worker's options type it, so `new BunQueueWorker(name,
 * processor, { schema })` infers what the processor's `job.data` is (the data
 * schema's output) and what it must answer with (the result schema's input).
 */
export interface ProcessorJobSchema<TData, TResult> extends JobSchema {
  /** Checks what a job carries; its output type is the processor's `job.data`. */
  data?: StandardSchemaV1<unknown, TData>;
  /** Checks what the processor answers with; its input type is what it returns. */
  result?: StandardSchemaV1<TResult, unknown>;
}

/**
 * What a {@link BunQueue} takes beside its `BunQueueOptions` (plan
 * bun-validate §4.8): the schemas its adds and updates are checked with.
 * Kept apart from `BunQueueOptions` so options typed without a schema still
 * pass to a queue whose type arguments are given.
 *
 * @typeParam TData What `add` takes: inferred from `schema.data`'s input.
 * @typeParam TResult What a job's `returnValue` is: inferred from
 * `schema.result`'s input.
 */
export interface QueueValidationOptions<TData = unknown, TResult = unknown> {
  /**
   * The schemas every job added here is checked with: `schema.data` at
   * enqueue and on update. What is stored is what the producer sent, never
   * the schema's output. On a `BunJobs` registry queue a defined name's own
   * `schema` wins over this. `schema.result` only types `returnValue` here:
   * a worker checks results.
   */
  schema?: ProducerJobSchema<TData, TResult>;
  /**
   * What a failed data check does here: `enqueue` is `"error"` (reject,
   * write nothing) by default, or `"warn"` (write, and log one warning with
   * no values) or `"off"`. A defined name's own `dataValidation` wins over it.
   * `process` is a worker's, and ignored here.
   */
  dataValidation?: JobDataValidation;
}

/**
 * What a {@link BunQueueWorker} takes beside its `BunQueueWorkerOptions`
 * (plan bun-validate §4.8): the schemas it checks each job and result with.
 * Kept apart from `BunQueueWorkerOptions` for the same reason as
 * {@link QueueValidationOptions}.
 *
 * @typeParam TData The processor's `job.data`: inferred from `schema.data`'s
 * output.
 * @typeParam TResult What the processor answers with: inferred from
 * `schema.result`'s input.
 */
export interface WorkerValidationOptions<TData = unknown, TResult = unknown> {
  /**
   * The schemas this worker checks every job with: `schema.data` before the
   * processor runs, which then receives its output (through a `jsonClone` on
   * a `Worker`, child-process, container or custom target), and
   * `schema.result` on what it answers, under `resultValidation`. Without one
   * this worker checks nothing. On a `BunJobs` registry worker a defined
   * name's own `schema` wins over this.
   */
  schema?: ProcessorJobSchema<TData, TResult>;
  /**
   * What a failed data check does here: `process` is `"error"` by default
   * (the attempt fails with an `UnrecoverableJobError`, straight to `dead`),
   * or `"warn"` (the processor runs with the stored input, and one warning is
   * logged) or `"off"`; `enqueue` applies to a `job.updateData()` made inside
   * the processor. A defined name's own `dataValidation` wins over it.
   */
  dataValidation?: JobDataValidation;
  /**
   * What a result failing `schema.result` does: `"off"` (default) does not
   * check; `"warn"` completes the job and logs one warning (no values);
   * `"error"` fails the attempt, retryably, with no `completed` event and
   * nothing stored or delivered to a parent. A defined name's own
   * `resultValidation` wins over it.
   */
  resultValidation?: Policy;
}

/** The data type a handler receives under schemas `S`: the data schema's output. */
export type SchemaData<S> = S extends {
  data: infer D extends StandardSchemaV1;
}
  ? StandardSchemaV1.InferOutput<D>
  : unknown;

/** The type a handler answers with under schemas `S`: the result schema's input. */
export type SchemaResult<S> = S extends {
  result: infer R extends StandardSchemaV1;
}
  ? StandardSchemaV1.InferInput<R>
  : unknown;

/**
 * A {@link JobMap} built from a record of schemas, one entry per job name:
 * `data` is the data schema's **output** (what the handler receives) and
 * `result` the result schema's **input** (what the handler returns, stored
 * as it was). A name with no data schema carries `unknown`.
 *
 * ```ts
 * const schemas = {
 *   sendEmail: { data: z.object({ to: z.email() }), result: z.object({ id: z.string() }) },
 * };
 *
 * const jobs = new BunJobs<JobMapFromSchemas<typeof schemas>>({ namespace, driver });
 * jobs.define("sendEmail", async (job) => send(job.data.to), { schema: schemas.sendEmail });
 * ```
 *
 * @typeParam S Each job name's {@link JobSchema}.
 */
export type JobMapFromSchemas<
  S extends { readonly [name: string]: JobSchema },
> = {
  [TName in keyof S]: {
    /** The data schema's output: what the handler receives. */
    data: SchemaData<S[TName]>;
    /** The result schema's input: what the handler returns. */
    result: SchemaResult<S[TName]>;
  };
};

/* --- the jobs transport -------------------------------------------------- */

/**
 * The jobs transport (plan §4.1.1): a job's `data` inbound, its handler's
 * `result` outbound, no key. A definition with a schema carries a contract on
 * it, so `describeContract(getContract(definition))` lists its rows.
 *
 * @internal
 */
export const jobsTransport = defineTransport({
  name: "jobs",
  wire: "json",
  inbound: { parts: ["data"] },
  outbound: { parts: ["result"] },
});

/**
 * Attaches the jobs contract of `schema` to `carrier` (a definition), named
 * after the job: `inbound: { data }`, `outbound: { result }`, each side only
 * when its schema is given.
 */
export function attachJobContract<X extends object>(
  carrier: X,
  schema: JobSchema,
  name: string,
): X {
  // Each side only when its schema is given: "nothing declared" and
  // "declared empty" read differently in `describeContract`. The type of the
  // declaration is the full one; the transport checks the object at runtime.
  const def: {
    inbound?: { data: StandardSchemaV1 };
    outbound?: { result: StandardSchemaV1 };
  } = {};
  if (schema.data !== undefined) def.inbound = { data: schema.data };
  if (schema.result !== undefined) def.outbound = { result: schema.result };
  return attachContract(
    carrier,
    jobsTransport.contract(
      def as {
        inbound: { data: StandardSchemaV1 };
        outbound: { result: StandardSchemaV1 };
      },
      { name },
    ),
  );
}

/* --- compiled checks ------------------------------------------------------ */

/**
 * The key a queue or worker carries a per-name check lookup under: set by
 * `BunJobs` on its registry queue and the workers it creates for it, once a
 * definition has a schema. Internal.
 */
export const JOB_CHECKS: unique symbol = Symbol("bun-jobs: job checks");

/**
 * One name's (or one queue's or worker's) schemas and policies, checked once
 * where they were declared. A policy left `undefined` falls back to the
 * queue's or worker's own, then to the default. Internal.
 */
export interface JobCheck {
  /** The data schema, if any. */
  readonly data: StandardSchemaV1 | undefined;
  /** The result schema, if any. */
  readonly result: StandardSchemaV1 | undefined;
  /** The enqueue policy, when this layer set one. */
  readonly enqueue: Policy | undefined;
  /** The process policy, when this layer set one. */
  readonly process: Policy | undefined;
  /** The result policy, when this layer set one. */
  readonly resultPolicy: Policy | undefined;
  /** The definition's name, when a definition declared it; for messages. */
  readonly definition: string | undefined;
}

/** Finds a job name's {@link JobCheck}, or `undefined` for none. Internal. */
export type JobCheckLookup = (name: string) => JobCheck | undefined;

/**
 * A job name's data check on one queue, as that queue resolves it: the
 * check, which has a data schema, and the enqueue policy beneath the check's
 * own. What a flow's pre-write pass runs for a node. Internal.
 */
export interface QueueDataCheck {
  /** The check: the definition's on a registry queue, else the queue's own. */
  readonly check: JobCheck;
  /** The queue's own enqueue policy, used when the check sets none. */
  readonly policy: Policy;
}

/**
 * Finds the data check for a job of `name` written to the queue named
 * `queue`, for a flow node on a queue other than the one `addFlow` was
 * called on; `undefined` when that queue checks nothing (or this process
 * cannot see how it would). Internal.
 */
export type QueueCheckLookup = (
  queue: string,
  name: string,
) => QueueDataCheck | undefined;

/**
 * The key a queue carries its {@link QueueCheckLookup} under: set by
 * `BunJobs` on every queue it creates once any schema exists in the context,
 * so a flow added on one queue checks its nodes on the others. Internal.
 */
export const QUEUE_CHECKS: unique symbol = Symbol("bun-jobs: queue checks");

/**
 * The key of a queue's method answering its own {@link QueueDataCheck} for a
 * job name, or `undefined` when it checks none. Internal.
 */
export const DATA_CHECK: unique symbol = Symbol("bun-jobs: data check");

/**
 * The key of a queue's `addFlow` taking a {@link QueueCheckLookup} of the
 * caller's, for the management API, which has resolved every queue a flow
 * writes to (and may hold queues no `BunJobs` context made). Internal.
 */
export const ADD_FLOW: unique symbol = Symbol("bun-jobs: add flow");

/** The three policy words. */
const POLICIES: ReadonlySet<string> = new Set<Policy>(["off", "warn", "error"]);

/** Refuses a policy that is not one of the three words. */
function assertPolicy(value: unknown, what: string): Policy | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !POLICIES.has(value)) {
    throw new ConfigError(`${what} must be "off", "warn" or "error"`, {
      [what]: typeof value === "string" ? value : typeof value,
    });
  }
  return value as Policy;
}

/** Refuses a schema that is not a Standard Schema. */
function assertSchema(
  value: unknown,
  what: string,
): StandardSchemaV1 | undefined {
  if (value === undefined) return undefined;
  const props =
    (typeof value === "object" || typeof value === "function") && value !== null
      ? (value as { "~standard"?: { validate?: unknown } })["~standard"]
      : undefined;
  if (typeof props?.validate !== "function") {
    throw new ConfigError(
      `${what} must be a Standard Schema (zod, valibot, arktype, s, ...)`,
      { what },
    );
  }
  return value as StandardSchemaV1;
}

/**
 * Checks the validation options a definition, queue or worker was given and
 * compiles them, or answers `undefined` when there is no schema to check with
 * (policies alone are kept by the caller as its defaults).
 *
 * @param options    The options as given, possibly by plain JavaScript.
 * @param where      Who gave them, for messages (`define("x")`, `queue "mail"`).
 * @param definition The definition's name, when a definition gave them.
 */
export function compileJobCheck(
  options: JobValidationOptions | undefined,
  where: string,
  definition?: string,
): JobCheck | undefined {
  if (options === undefined) return undefined;
  const { schema, dataValidation, resultValidation } = options;
  const enqueue = assertPolicy(
    dataValidation?.enqueue,
    `${where}: dataValidation.enqueue`,
  );
  const process = assertPolicy(
    dataValidation?.process,
    `${where}: dataValidation.process`,
  );
  const resultPolicy = assertPolicy(
    resultValidation,
    `${where}: resultValidation`,
  );
  if (schema === undefined) return undefined;
  if (typeof schema !== "object" || schema === null) {
    throw new ConfigError(
      `${where}: schema must be an object { data, result }`,
    );
  }
  const data = assertSchema(schema.data, `${where}: schema.data`);
  const result = assertSchema(schema.result, `${where}: schema.result`);
  if (data === undefined && result === undefined) return undefined;
  return { data, result, enqueue, process, resultPolicy, definition };
}

/**
 * The policies a queue or worker was given for itself, checked: the
 * fallbacks under every {@link JobCheck}.
 */
export function ownPolicies(
  options: JobValidationOptions | undefined,
  where: string,
): { enqueue: Policy; process: Policy; result: Policy } {
  return {
    enqueue:
      assertPolicy(
        options?.dataValidation?.enqueue,
        `${where}: dataValidation.enqueue`,
      ) ?? "error",
    process:
      assertPolicy(
        options?.dataValidation?.process,
        `${where}: dataValidation.process`,
      ) ?? "error",
    result:
      assertPolicy(options?.resultValidation, `${where}: resultValidation`) ??
      "off",
  };
}

/** The keys `define()` lifts out of a definition's options. */
const VALIDATION_KEYS = [
  "schema",
  "dataValidation",
  "resultValidation",
] as const;

/**
 * Splits `define()`'s options into the definition's own (plain data, served
 * by `GET /definitions` and applied as job defaults) and the validation
 * options lifted beside them.
 */
export function liftValidation<T extends object>(
  options: T & JobValidationOptions,
): {
  options: Omit<T, keyof JobValidationOptions>;
  validation: JobValidationOptions;
} {
  let lifted = false;
  for (const key of VALIDATION_KEYS) {
    if (key in options) {
      lifted = true;
      break;
    }
  }
  if (!lifted) {
    return { options, validation: {} };
  }
  const { schema, dataValidation, resultValidation, ...rest } = options;
  const validation: JobValidationOptions = {};
  if (schema !== undefined) validation.schema = schema;
  if (dataValidation !== undefined) validation.dataValidation = dataValidation;
  if (resultValidation !== undefined)
    validation.resultValidation = resultValidation;
  return { options: rest, validation };
}

/** Runs one schema over a value, flattening issues under `target`, value-free. */
export function runJobSchema(
  schema: StandardSchemaV1,
  value: unknown,
  target: "data" | "result",
): StandardOutcome<unknown> | Promise<StandardOutcome<unknown>> {
  return validateStandard(schema, value, target);
}

/** The issues as a warning carries them: no values, ever. */
function issueFields(
  issues: readonly ValidationIssue[],
): { target: string; path: string; message: string }[] {
  return issues.map((issue) => ({
    target: issue.target,
    path: issue.path,
    message: issue.message,
  }));
}

/**
 * Logs the one warning a `"warn"` policy asks for: what was checked, where,
 * and the issues, never the value.
 */
export function warnJobIssues(
  logger: Logger,
  message: string,
  fields: Record<string, unknown>,
  issues: readonly ValidationIssue[],
): void {
  logger.warn(message, { ...fields, issues: issueFields(issues) });
}

/**
 * Checks data about to be written — an add, an update — with `check`'s data
 * schema under its enqueue policy (or `fallback`): nothing to do answers
 * `undefined` at once, a pass answers nothing, `"warn"` logs one warning and
 * passes, and `"error"` throws (or rejects with) a
 * {@link JobDataValidationError}. What is checked is the data's JSON form,
 * which is what is stored and what the worker's check will read back: `null`
 * for a job with no data.
 *
 * @param check    The name's (or the queue's) compiled check, if any.
 * @param fallback The queue's or worker's own enqueue policy.
 * @param name     The job's name.
 * @param queue    The queue it is written to.
 * @param data     The data as the producer gave it.
 * @param logger   Where a `"warn"` goes.
 * @param context  Extra detail for the error and the warning (an id, an index).
 */
export function checkJobDataWrite(
  check: JobCheck | undefined,
  fallback: Policy,
  name: string,
  queue: string,
  data: unknown,
  logger: Logger,
  context?: Record<string, unknown>,
): void | Promise<void> {
  const schema = check?.data;
  if (schema === undefined) return undefined;
  const policy = check!.enqueue ?? fallback;
  if (policy === "off") return undefined;
  const settle = (outcome: StandardOutcome<unknown>): void => {
    if (outcome.ok) return;
    const detail = {
      ...context,
      ...(check!.definition === undefined
        ? {}
        : { definition: check!.definition }),
    };
    if (policy === "error") {
      throw new JobDataValidationError(
        name,
        queue,
        "data",
        outcome.issues,
        detail,
      );
    }
    warnJobIssues(
      logger,
      'Job data did not pass its schema; written anyway (dataValidation.enqueue is "warn")',
      { name, queue, ...detail },
      outcome.issues,
    );
  };
  // JSON has no `undefined`: a job added with no data is stored, and read
  // back by every backend, as `null`, so that is what the worker will check.
  const stored = assertJsonSafe(data, "job data");
  const outcome = runJobSchema(
    schema,
    stored === undefined ? null : stored,
    "data",
  );
  return outcome instanceof Promise ? outcome.then(settle) : settle(outcome);
}
