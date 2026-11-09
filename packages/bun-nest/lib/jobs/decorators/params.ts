import type { Job } from "@kingsleyweb/bun-jobs";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { PipeTransform, Type } from "@nestjs/common";
import { NEST_BODY_PARAMTYPE, NEST_ROUTE_ARGS_METADATA } from "../metadata";
import { StandardSchemaPipe } from "../../validation";

/**
 * The parameter types recorded under Nest's `ROUTE_ARGS_METADATA`. Above Nest's
 * `RouteParamtypes` (0 to 15 on 12.2.0), so they never meet one; Nest tells a
 * pipe that a type it does not know is `"custom"`.
 */
export const JobParamType = {
  /** `job.id`. */
  Id: 100,
  /** `job.name`. */
  Name: 101,
  /** The `Job`. */
  Job: 102,
  /** The `ProcessorContext`. */
  Context: 103,
  /** `ctx.signal`. */
  Signal: 104,
  /** A function reporting progress. */
  Progress: 105,
  /** `ctx.logger`. */
  Logger: 106,
  /** `ctx.attempt`. */
  Attempt: 107,
} as const;

/** A pipe, as Nest takes one on a parameter: a class it builds, or an instance. */
export type JobPipe = Type<PipeTransform> | PipeTransform;

/** The object form of {@link JobData}. */
export interface JobDataOptions {
  /** One field of `job.data`, rather than the whole of it. */
  property?: string;
  /**
   * A Standard Schema to validate the value with: bun-validate's
   * `StandardSchemaPipe(schema)` on this parameter, ahead of `pipes`. It is
   * always the pipe, on Nest 11 and 12, and is not also recorded for Nest 12's
   * `StandardSchemaValidationPipe`, so it never validates twice.
   */
  schema?: StandardSchemaV1;
  /** Further pipes on this parameter. */
  pipes?: readonly JobPipe[];
}

/**
 * Reports a job's progress, what {@link JobProgress} injects. A value written
 * after the attempt was given up is dropped, silently, as `job.updateProgress`
 * does.
 */
export type JobProgressFn = (
  /** The progress: a number, or an object. */
  value: Parameters<Job["updateProgress"]>[0],
) => Promise<void>;

/** Records one parameter under Nest's key, as `assignMetadata` does. */
function recordParam(
  type: number,
  data: string | undefined,
  pipes: readonly JobPipe[],
): ParameterDecorator {
  return (target, key, index) => {
    if (key === undefined) {
      return;
    }
    const args = (Reflect.getMetadata(
      NEST_ROUTE_ARGS_METADATA,
      target.constructor,
      key,
    ) ?? {}) as Record<string, unknown>;
    Reflect.defineMetadata(
      NEST_ROUTE_ARGS_METADATA,
      { ...args, [`${type}:${index}`]: { index, data, pipes } },
      target.constructor,
      key,
    );
  };
}

/** Whether a first argument is a pipe rather than the object form. */
function isPipe(value: object): value is JobPipe {
  return (
    typeof value === "function" ||
    typeof (value as { transform?: unknown }).transform === "function"
  );
}

/**
 * The job's data, or one field of it, with pipes: like `@Body()`, and recorded
 * as Nest's BODY type, as microservices' `@Payload()` is. So a pipe is told
 * `"body"`, and **an app's global `ValidationPipe` or `StandardValidationPipe`
 * validates job data with no change**, which also means every global pipe sees
 * it.
 *
 * ```ts
 * @Process("welcome")
 * welcome(@JobData(new StandardSchemaPipe(Email)) data: Email) { … }
 * digest(@JobData("userId") userId: string, @JobData({ schema: Digest }) data: Digest) { … }
 * ```
 *
 * A pipe cannot type its parameter, so annotate it, with
 * `StandardSchemaV1.InferOutput<typeof Schema>` or a `SchemaDto` class. A failed
 * `StandardSchemaPipe` ends the job with no retry; see `onInvalid`.
 *
 * @param propertyOrPipeOrOptions A field's name, a first pipe, or {@link JobDataOptions}.
 * @param pipes Further pipes.
 */
export function JobData(
  propertyOrPipeOrOptions?: string | JobPipe | JobDataOptions,
  ...pipes: JobPipe[]
): ParameterDecorator {
  if (
    propertyOrPipeOrOptions === undefined ||
    typeof propertyOrPipeOrOptions === "string"
  ) {
    return recordParam(NEST_BODY_PARAMTYPE, propertyOrPipeOrOptions, pipes);
  }
  if (isPipe(propertyOrPipeOrOptions)) {
    return recordParam(NEST_BODY_PARAMTYPE, undefined, [
      propertyOrPipeOrOptions,
      ...pipes,
    ]);
  }
  const { property, schema, pipes: more = [] } = propertyOrPipeOrOptions;
  return recordParam(NEST_BODY_PARAMTYPE, property, [
    ...(schema === undefined ? [] : [new StandardSchemaPipe(schema)]),
    ...more,
    ...pipes,
  ]);
}

/** `job.id`, with pipes. @param pipes The parameter's pipes. */
export function JobId(...pipes: JobPipe[]): ParameterDecorator {
  return recordParam(JobParamType.Id, undefined, pipes);
}

/** `job.name`, with pipes. @param pipes The parameter's pipes. */
export function JobName(...pipes: JobPipe[]): ParameterDecorator {
  return recordParam(JobParamType.Name, undefined, pipes);
}

/**
 * The bun-jobs `Job` itself: `log`, `updateProgress`, `extendLock`, `fail`, and
 * `getChildrenValues()` for a flow parent.
 */
export function CurrentJob(): ParameterDecorator {
  return recordParam(JobParamType.Job, undefined, []);
}

/** The `ProcessorContext`: `signal`, `logger`, `attempt`, `log`, `heartbeat`. */
export function JobContext(): ParameterDecorator {
  return recordParam(JobParamType.Context, undefined, []);
}

/** `ctx.signal`: aborted on a timeout, a worker's close and a lost lock. */
export function JobSignal(): ParameterDecorator {
  return recordParam(JobParamType.Signal, undefined, []);
}

/**
 * A {@link JobProgressFn}. A value reported after the attempt was given up is
 * dropped, silently, as bun-jobs does.
 */
export function JobProgress(): ParameterDecorator {
  return recordParam(JobParamType.Progress, undefined, []);
}

/** `ctx.logger`, bound to the job's ids. */
export function JobLogger(): ParameterDecorator {
  return recordParam(JobParamType.Logger, undefined, []);
}

/** `ctx.attempt`, from 1. */
export function JobAttempt(): ParameterDecorator {
  return recordParam(JobParamType.Attempt, undefined, []);
}
