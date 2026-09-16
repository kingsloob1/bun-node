import type { Infer } from "../../lib/api/schema/builder";
import type {
  JobOptionsSchema,
  JobSchema,
  RepeatableSchema,
} from "../../lib/api/schemas/jobs";
import type {
  JobCountsSchema,
  QueueLimitsInputSchema,
  StoredLimitsSchema,
} from "../../lib/api/schemas/queues";
import type {
  RunnerInfoSchema,
  RunnerScheduleSchema,
  RunnerStatsSchema,
  RunRecordSchema,
  TriggerOutcomeSchema,
} from "../../lib/api/schemas/runners";
/**
 * Compile-time assertions that the route schemas describe the real bun-jobs
 * types: a field added to `ResolvedJobOptions`, `RunnerSchedule` or
 * `StoredLimits` without the schema following fails here. Checked by `tsc`.
 *
 * DTOs carrying an `ErrorDto` are checked for assignability rather than
 * equality: the schema describes `cause` loosely, since it cannot recurse.
 */
import type {
  JobDto,
  RepeatableDto,
  RunnerInfoDto,
  RunRecordDto,
} from "../../lib/api/serialize";
import type {
  JobState,
  QueueLimits,
  ResolvedJobOptions,
  RunnerSchedule,
  RunnerStats,
  StoredLimits,
  TriggerOutcome,
} from "../../lib/index";
import { s } from "../../lib/api/schema/builder";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type OptionsEqual = Equal<Infer<typeof JobOptionsSchema>, ResolvedJobOptions>;
export type OptionsMatch = Expect<OptionsEqual>;

type ScheduleEqual = Equal<Infer<typeof RunnerScheduleSchema>, RunnerSchedule>;
export type ScheduleMatches = Expect<ScheduleEqual>;

type OutcomeEqual = Equal<Infer<typeof TriggerOutcomeSchema>, TriggerOutcome>;
export type OutcomeMatches = Expect<OutcomeEqual>;

type StatsEqual = Equal<Infer<typeof RunnerStatsSchema>, RunnerStats>;
export type StatsMatch = Expect<StatsEqual>;

type CountsEqual = Equal<
  Infer<typeof JobCountsSchema>,
  Record<JobState, number>
>;
export type CountsMatch = Expect<CountsEqual>;

type LimitsEqual = Equal<Infer<typeof StoredLimitsSchema>, StoredLimits>;
export type LimitsMatch = Expect<LimitsEqual>;

type InputFits =
  Infer<typeof QueueLimitsInputSchema> extends QueueLimits ? true : false;
export type LimitsInputFits = Expect<InputFits>;

type JobFits = JobDto extends Infer<typeof JobSchema> ? true : false;
export type JobDtoFits = Expect<JobFits>;

type RepeatableFits =
  RepeatableDto extends Infer<typeof RepeatableSchema> ? true : false;
export type RepeatableDtoFits = Expect<RepeatableFits>;

type RunFits =
  RunRecordDto extends Infer<typeof RunRecordSchema> ? true : false;
export type RunRecordDtoFits = Expect<RunFits>;

type RunnerFits =
  RunnerInfoDto extends Infer<typeof RunnerInfoSchema> ? true : false;
export type RunnerInfoDtoFits = Expect<RunnerFits>;

/* --- negative controls ----------------------------------------------- */

const _LimitsWithoutNames = s.object({
  rate: s.optional(s.object({ max: s.integer(), duration: s.integer() })),
  concurrency: s.optional(s.integer()),
});
type NoNamesEqual = Equal<Infer<typeof _LimitsWithoutNames>, StoredLimits>;
// @ts-expect-error — limits without per-name limits are not StoredLimits.
export type NoNamesMatch = Expect<NoNamesEqual>;

const _ScheduleWithoutAt = s.nullable(
  s.union(
    s.object({ cron: s.string(), tz: s.optional(s.string()) }),
    s.object({ every: s.integer(), anchor: s.optional(s.integer()) }),
  ),
);
type NoAtEqual = Equal<Infer<typeof _ScheduleWithoutAt>, RunnerSchedule>;
// @ts-expect-error — a schedule without `{ at }` is not RunnerSchedule.
export type NoAtMatch = Expect<NoAtEqual>;

const _JobWithoutQueue = s.object({ id: s.string() });
type NoQueueFits =
  JobDto extends Infer<typeof _JobWithoutQueue>
    ? Infer<typeof _JobWithoutQueue> extends JobDto
      ? true
      : false
    : false;
// @ts-expect-error — a partial job schema does not describe JobDto both ways.
export type NoQueueMatch = Expect<NoQueueFits>;
