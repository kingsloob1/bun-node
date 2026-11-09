import type { Job, ProcessorContext } from "@kingsleyweb/bun-jobs";
import type { ExternalContextCreator, ParamsFactory } from "@nestjs/core";
import { UnrecoverableJobError } from "@kingsleyweb/bun-jobs";
import { ForbiddenException } from "@nestjs/common";
import { StandardValidationException } from "../validation";
import { JobParamType } from "./decorators/params";
import { JobForbiddenError } from "./errors";
import {
  NEST_BODY_PARAMTYPE,
  NEST_FORBIDDEN_MESSAGE,
  NEST_PARAMTYPES_METADATA,
  NEST_ROUTE_ARGS_METADATA,
} from "./metadata";

/**
 * The one module that calls Nest's `ExternalContextCreator` (ECC), the seam
 * Nest's maintainer points library authors at. It has no `@publicApi` tag and is
 * not in the docs, so a change to it fails loudly here, and in the conformance
 * tests beside an HTTP route.
 */

/** What `getType()` answers around a job, in guards, interceptors and filters. */
export const BUN_JOBS_CONTEXT_TYPE = "bun-jobs";

/** What a guard's denial does: end the job, or retry it like any error. */
export type OnDenied = "fail" | "retry";

/** What a failed validation pipe does: end the job, or retry it like any error. */
export type OnInvalid = "fail" | "retry";

/** How one handler's failures are read. */
export interface FailurePolicy {
  /** `Class.method`, for messages. */
  readonly label: string;
  /** See {@link OnDenied}. Defaults to `"fail"`. */
  readonly onDenied?: OnDenied;
  /** See {@link OnInvalid}. Defaults to `"fail"`. */
  readonly onInvalid?: OnInvalid;
}

/** The arguments a handler is called with, which every enhancer sees too. */
type JobArgs = [job: Job<any, any, any>, ctx: ProcessorContext];

/** How `(job, ctx)` becomes each decorated parameter. */
const jobsParamsFactory: ParamsFactory = {
  exchangeKeyForValue(type: number, data: unknown, args: JobArgs) {
    const [job, ctx] = args;
    switch (type) {
      case NEST_BODY_PARAMTYPE:
        return data === undefined || data === null
          ? job.data
          : (job.data as Record<string, unknown> | null | undefined)?.[
              data as string
            ];
      case JobParamType.Id:
        return job.id;
      case JobParamType.Name:
        return job.name;
      case JobParamType.Job:
        return job;
      case JobParamType.Context:
        return ctx;
      case JobParamType.Signal:
        return ctx.signal;
      case JobParamType.Progress:
        return (value: Parameters<Job["updateProgress"]>[0]) =>
          job.updateProgress(value);
      case JobParamType.Logger:
        return ctx.logger;
      case JobParamType.Attempt:
        return ctx.attempt;
      default:
        return undefined;
    }
  },
};

/**
 * Wraps one method in the Nest pipeline.
 *
 * All three options are passed, because they default only as a whole: `{
 * guards: true }` alone silently turns off interceptors and filters. The method
 * is the unbound one on the instance, because `@UseGuards` and `@SetMetadata`
 * are read from the very function given. Global enhancers are copied here, so
 * this runs at bootstrap, after `app.useGlobalGuards()`.
 */
export function buildPipeline(
  /** Nest's creator. */
  ecc: ExternalContextCreator,
  /** The processor, or a per-job instance. */
  instance: object,
  /** The method's name. */
  method: string,
  /** The job's context id, for a per-job instance. */
  contextId?: Parameters<ExternalContextCreator["create"]>[5],
): (job: Job<any, any, any>, ctx: ProcessorContext) => Promise<unknown> {
  return ecc.create(
    instance as Record<string, (...args: unknown[]) => unknown>,
    (instance as Record<string, (...args: unknown[]) => unknown>)[method]!,
    method,
    NEST_ROUTE_ARGS_METADATA,
    jobsParamsFactory,
    contextId,
    undefined,
    { guards: true, interceptors: true, filters: true },
    BUN_JOBS_CONTEXT_TYPE,
  ) as (job: Job<any, any, any>, ctx: ProcessorContext) => Promise<unknown>;
}

/**
 * What a failure of the pipeline means for the job. A guard's denial and a
 * failed validation pipe would otherwise be retried like any error, and a retry
 * asks the same question of the same data. Everything else passes through.
 */
export function mapPipelineFailure(
  /** What the pipeline threw, after the filters. */
  error: unknown,
  /** The job. */
  job: Job<any, any, any>,
  /** How this handler reads failures. */
  policy: FailurePolicy,
): unknown {
  if (
    policy.onDenied !== "retry" &&
    error instanceof ForbiddenException &&
    error.message === NEST_FORBIDDEN_MESSAGE
  ) {
    return new JobForbiddenError(
      `${policy.label}: a guard denied job ${job.id} ("${job.name}")`,
      { name: job.name, jobId: job.id },
      { cause: error },
    );
  }
  if (
    policy.onInvalid !== "retry" &&
    error instanceof StandardValidationException
  ) {
    return new UnrecoverableJobError(
      `${policy.label}: job ${job.id} ("${job.name}") cannot run: ${error.message}`,
      { name: job.name, jobId: job.id, issues: error.issues },
      { cause: error },
    );
  }
  return error;
}

/**
 * The positions of a method's parameters that no decorator fills. Once any is
 * decorated, ECC fills only those, and the rest arrive as `null`.
 *
 * @returns The undecorated positions, from 0; none when no parameter is decorated.
 */
export function undecoratedParams(
  /** The class. */
  target: { prototype: object },
  /** The method's name. */
  method: string,
): number[] {
  const decorated = decoratedParams(target, method);
  if (decorated.size === 0) {
    return [];
  }
  const handler = (target.prototype as Record<string, unknown>)[method] as {
    length: number;
  };
  const declared = Reflect.getMetadata(
    NEST_PARAMTYPES_METADATA,
    target.prototype,
    method,
  ) as readonly unknown[] | undefined;
  const count = declared?.length ?? handler.length;
  return Array.from({ length: count }, (_, index) => index).filter(
    (index) => !decorated.has(index),
  );
}

/** The positions of a method's parameters that a decorator fills. */
export function decoratedParams(
  /** The class. */
  target: object,
  /** The method's name. */
  method: string,
): Set<number> {
  const metadata = (Reflect.getMetadata(
    NEST_ROUTE_ARGS_METADATA,
    target,
    method,
  ) ?? {}) as Record<string, { index: number }>;
  return new Set(Object.values(metadata).map(({ index }) => index));
}
