import type { JobState } from "../../drivers/index";
import type { Schema } from "../schema/builder";
import { JOB_STATES } from "../contract/constants";
import { s } from "../schema/builder";

/**
 * Schemas shared by every route: the problem body, pages, errors, job
 * references and job states.
 */

/** Every job state, in lifecycle order. Defined in the contract. */
export { JOB_STATES };

/** Compile-time guard that every contract state is a driver `JobState`. */
const _everyStateIsAJobState: readonly JobState[] = JOB_STATES;

/**
 * Compile-time guard that {@link JOB_STATES} lists every `JobState`: adding a
 * state to the driver contract without adding it here fails this line.
 */
const _everyJobStateListed: Exclude<
  JobState,
  (typeof JOB_STATES)[number]
> extends never
  ? true
  : never = true;

/** A job state. */
export const JobStateSchema = s.named(
  "JobState",
  s.enum(JOB_STATES, { description: "Where a job is in its lifecycle." }),
);

/** A validation issue inside a problem. */
export const ProblemIssueSchema = s.object({
  target: s.enum(["params", "query", "body", "headers"]),
  path: s.string({
    description: 'Dotted path within the target, or "" for the target itself.',
  }),
  message: s.string(),
});

/** An RFC 9457 problem, as every error is answered. */
export const ProblemSchema = s.named(
  "Problem",
  s.object(
    {
      type: s.string({ description: "urn:bun-jobs:error:<CODE>" }),
      title: s.string(),
      status: s.integer({ minimum: 100, maximum: 599 }),
      code: s.string(),
      detail: s.optional(s.string()),
      instance: s.optional(s.string()),
      issues: s.optional(s.array(ProblemIssueSchema)),
      context: s.optional(s.record(s.unknown())),
    },
    {
      description:
        "RFC 9457 problem details, served as application/problem+json.",
    },
  ),
);

/**
 * A serialised error. `cause` is described loosely: the builder cannot express
 * a recursive schema, and the nesting is bounded (five levels) by the serializer.
 */
export const ErrorDtoSchema = s.named(
  "Error",
  s.object({
    name: s.string(),
    message: s.string(),
    code: s.optional(s.union(s.string(), s.number())),
    stack: s.optional(
      s.string({
        description:
          "The stack trace: present only when the API was created with `serialize.exposeStacks` (off by default).",
      }),
    ),
    data: s.optional(s.record(s.unknown())),
    cause: s.optional(
      s.unknown({ description: "The cause, shaped as an Error." }),
    ),
  }),
);

/** Where a page sits in its list. */
export const PageInfoSchema = s.named(
  "PageInfo",
  s.object({
    offset: s.integer({ minimum: 0 }),
    limit: s.integer({ minimum: 0 }),
    total: s.optional(s.integer({ minimum: 0 })),
    hasMore: s.boolean(),
  }),
);

/** A page of `item`s. */
export function pageOf<T>(item: Schema<T>) {
  return s.object({ items: s.array(item), page: PageInfoSchema });
}

/** A reference to a job: its queue and id. */
export const JobRefSchema = s.named(
  "JobRef",
  s.object({ queue: s.string(), id: s.string() }),
);
