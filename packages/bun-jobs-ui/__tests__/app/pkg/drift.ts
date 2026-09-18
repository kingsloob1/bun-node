/**
 * Compile-time drift checks: every response shape the app mirrors in
 * `app/api/types.ts` must be IDENTICAL to the package's own type (or, where
 * the package has no named type, to the schema's inferred type). Checked by
 * `typecheck.test.ts`, which also proves a mismatch fails (`negative/`).
 */
import type * as Pkg from "@kingsleyweb/bun-jobs";
import type { Infer } from "@kingsleyweb/bun-jobs/lib/api/schema/builder.ts";
import type { PermissionsSchema } from "@kingsleyweb/bun-jobs/lib/api/schemas/meta.ts";
import type {
  OverviewSchema,
  PausedSchema,
  QueueListSchema,
  WorkerListSchema,
} from "@kingsleyweb/bun-jobs/lib/api/schemas/queues.ts";
import type * as Ui from "../../../app/api/types";

/** Flattens intersections and nested objects, so inferred and declared shapes compare structurally. */
export type Normalize<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]: Normalize<T[K]> }
    : T;

/** `true` only when A and B are the same type (after {@link Normalize}), optionality included. */
export type Equal<A, B> =
  (<T>() => T extends Normalize<A> ? 1 : 2) extends <
    T,
  >() => T extends Normalize<B> ? 1 : 2
    ? true
    : false;

/** Fails to compile unless `T` is `true`. */
export function assertType<T extends true>(_proof?: T): void {}

// Unions and constants.
assertType<Equal<Ui.JobState, Pkg.JobState>>();
assertType<Equal<Ui.JobsApiAction, Pkg.JobsApiAction>>();
assertType<Equal<Ui.JobsApiMode, Pkg.JobsApiMode>>();

// Named DTOs.
assertType<Equal<Ui.MetaDto, Pkg.MetaDto>>();
assertType<Equal<Ui.ProblemDto, Pkg.ProblemDto>>();
assertType<Equal<Ui.ProblemIssueDto, Pkg.ProblemIssueDto>>();
assertType<Equal<Ui.QueueSummaryDto, Pkg.QueueSummaryDto>>();
assertType<Equal<Ui.WorkerDto, Pkg.WorkerDto>>();
assertType<Equal<Ui.DriverCapabilities, Pkg.DriverCapabilities>>();
assertType<Equal<Ui.QueueThroughput, Pkg.QueueThroughput>>();
assertType<Equal<Ui.ThroughputBucket, Pkg.ThroughputBucket>>();
assertType<Equal<Ui.JobCounts, Record<Pkg.JobState, number>>>();

// Shapes with no named type: compared with the schema's inferred type.
assertType<Equal<Ui.Overview, Infer<typeof OverviewSchema>>>();
assertType<Equal<Ui.QueueList, Infer<typeof QueueListSchema>>>();
assertType<Equal<Ui.WorkerList, Infer<typeof WorkerListSchema>>>();
assertType<Equal<Ui.PausedResult, Infer<typeof PausedSchema>>>();

// Permissions is deliberately narrower than the schema's Record<string, boolean>
// (keys are actions, pruned ones absent): it must still be assignable to it.
assertType<
  Ui.Permissions extends Infer<typeof PermissionsSchema> ? true : false
>();
