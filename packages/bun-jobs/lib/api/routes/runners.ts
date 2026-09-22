import type { RunRecord } from "../../drivers/index";
import type { RunnerConfigInfo, RunnerStatus } from "../../runner/types";
import type { ScheduleInput } from "../../shared/schedule";
import type { ResolvedJobsApiConfig } from "../config";
import type { Infer } from "../schema/builder";
import type { RunnerConfigDto } from "../serialize";
import type { AnyRouteDef } from "./define";
import { supportsRunnerConfig } from "../../runner/config";
import { validateCron } from "../../shared/cron";
import { ConfigError, NotSupportedError } from "../../shared/errors";
import { runnerKey } from "../../shared/keys";
import { normalizeSchedule } from "../../shared/schedule";
import { MAX_DATE_MS, RUNNER_CONFIG_BOUNDS } from "../contract/constants";
import { ApiError } from "../errors";
import { s } from "../schema/builder";
import {
  ClearHistoryQuerySchema,
  ClearHistoryResultSchema,
  historyQuerySchema,
  HistorySchema,
  KillBodySchema,
  KillResultSchema,
  ResumeBodySchema,
  RunIdSchema,
  RunLogPageSchema,
  runLogsQuerySchema,
  RunnerConfigBodySchema,
  RunnerConfigSchema,
  RunnerIdSchema,
  RunnerInfoSchema,
  RunnerListSchema,
  RunnerPausedSchema,
  RunnerStatsSchema,
  ScheduleBodySchema,
  ScheduleResultSchema,
  TriggerBodySchema,
  TriggerOutcomeSchema,
} from "../schemas/runners";
import {
  toRunLogLineDto,
  toRunnerConfigDto,
  toRunnerInfoDto,
  toRunRecordDto,
} from "../serialize";
import { defineRoute } from "./define";
import {
  mapBounded,
  REMOTE_LATENCY_NOTE,
  RunnerParams,
  runnerTarget,
  toEpoch,
} from "./support";

/** Errors every route naming a runner can answer with. */
const RUNNER_ERRORS = ["INVALID_NAME", "RUNNER_NOT_FOUND"] as const;

/**
 * `:runner/runs/:runId`. Declared here rather than beside {@link RunnerParams}
 * because the run id is the runner routes' alone.
 */
const RunParams = s.query(
  s.object({ runner: RunnerIdSchema, runId: RunIdSchema }),
);

/** A time from a schedule body, as the `Date` `updateSchedule` is given. */
function toScheduleTime(value: number | string): Date {
  return new Date(toEpoch(value));
}

/** A schedule body turned into what `updateSchedule` takes: date-times become `Date`s. */
function toScheduleInput(
  schedule: Infer<typeof ScheduleBodySchema>["schedule"],
): ScheduleInput {
  if (schedule === null || typeof schedule !== "object") {
    return schedule;
  }
  if ("at" in schedule) {
    return { at: toScheduleTime(schedule.at) };
  }
  if ("every" in schedule) {
    return {
      every: schedule.every,
      ...(schedule.anchor === undefined
        ? {}
        : { anchor: toScheduleTime(schedule.anchor) }),
    };
  }
  return schedule;
}

/** Whether the schedule normaliser refuses `input` — the rule a part is re-checked with. */
function normaliserRefuses(input: ScheduleInput): boolean {
  try {
    normalizeSchedule(input);
    return false;
  } catch (error) {
    if (error instanceof ConfigError) {
      return true;
    }
    throw error;
  }
}

/**
 * Which part of a schedule a refused `PUT /runners/:runner/schedule` body got
 * wrong, as a VALIDATION-style issue path. Found by re-checking each part with
 * the same validators the schedule goes through, never by reading the message.
 *
 * Over HTTP it answers `schedule.cron`, `schedule.tz`, or `schedule` for a bare
 * cron string: the body schema refuses a bad interval, anchor or time with 400
 * `VALIDATION` before the schedule is normalised. The other parts are still
 * blamed correctly for a body that reaches this without that schema.
 */
export function scheduleIssuePath(
  schedule: Infer<typeof ScheduleBodySchema>["schedule"],
): string {
  if (schedule === null || typeof schedule !== "object") {
    return "schedule";
  }
  if ("cron" in schedule) {
    if (!validateCron(schedule.cron)) {
      return "schedule.cron";
    }
    return schedule.tz !== undefined &&
      !validateCron(schedule.cron, { tz: schedule.tz })
      ? "schedule.tz"
      : "schedule";
  }
  if ("at" in schedule) {
    return "schedule.at";
  }
  return schedule.anchor !== undefined &&
    normaliserRefuses({ every: 1, anchor: toScheduleTime(schedule.anchor) })
    ? "schedule.anchor"
    : "schedule.every";
}

/** Errors both configuration routes can answer with. */
const CONFIG_ERRORS = [
  ...RUNNER_ERRORS,
  "CONFIG_NOT_ALLOWED",
  "RUNNER_NOT_CONFIGURABLE",
] as const;

/**
 * Where each overridable setting sits in `RunnerConfigBody`, so a refusal the
 * runtime blames on a *state field* is reported against the field the client
 * actually sent. `runMode` and `maxConcurrency` are one body property.
 */
const CONFIG_ISSUE_PATH: Record<string, string> = {
  executionMode: "executionMode",
  runMode: "concurrency.runMode",
  maxConcurrency: "concurrency.maxConcurrency",
};

/**
 * How soon a configuration change reaches the owners, for the route
 * descriptions.
 */
const CONFIG_LATENCY_NOTE = `The override is stored and announced. Each owner adopts it when it hears — as soon as it is published where it listens for \`control\` events (\`remoteControl: "auto"\`, the default, does on Redis and memory), and at its next sync otherwise — and reports back through \`appliedSeq\`. It applies from the **next** run: a run in flight keeps the mode it started with, and lowering \`maxConcurrency\` or switching \`parallel\` → \`single\` never kills one. An owner that cannot honour a field drops it, keeps its code's value and says why in \`error\`.`;

/**
 * Turns the runtime's `ConfigError` into the right problem, by its
 * `context.reason` and never by its message.
 *
 * - `"empty"` / `"invalid"` — the client's body: 400 `VALIDATION`, with the
 *   issue on the body property `context.field` came from.
 * - `"not-allowed"` — the runner's code forbids that execution mode: 409
 *   `CONFIG_NOT_ALLOWED`, naming the modes it does permit, since that is what
 *   the caller needs to choose again.
 * - `"not-configurable"` — no owner has started since remote configuration
 *   shipped, so nothing would ever adopt the override: 409
 *   `RUNNER_NOT_CONFIGURABLE`.
 *
 * Anything else is re-thrown: a `ConfigError` from elsewhere may name
 * internals, and the error handler answers those generically.
 *
 * Exported so the table can be asserted directly: the schema refuses a bad
 * enum or an out-of-range cap before the runtime ever sees it, so `"invalid"`
 * cannot be reached over HTTP — it is the guard for a patch that arrives any
 * other way.
 */
export function configError(error: unknown, runner: string): unknown {
  if (!(error instanceof ConfigError) || error instanceof NotSupportedError) {
    return error;
  }
  const context = error.context ?? {};
  const reason = context.reason;
  const field = typeof context.field === "string" ? context.field : undefined;

  if (reason === "empty" || reason === "invalid") {
    return new ApiError("VALIDATION", 400, error.message, {
      cause: error,
      issues: [
        {
          target: "body",
          path: (field && CONFIG_ISSUE_PATH[field]) ?? "",
          message: error.message,
        },
      ],
    });
  }
  if (reason === "not-allowed") {
    const allowed = Array.isArray(context.allowed)
      ? (context.allowed as string[])
      : [];
    return new ApiError(
      "CONFIG_NOT_ALLOWED",
      409,
      `Runner "${runner}" does not permit executionMode "${String(
        context.executionMode,
      )}"${allowed.length > 0 ? `; it permits ${allowed.join(", ")}` : ""}`,
      {
        cause: error,
        context: {
          runner,
          ...(context.executionMode === undefined
            ? {}
            : { executionMode: context.executionMode }),
          allowed,
        },
      },
    );
  }
  if (reason === "not-configurable") {
    return new ApiError("RUNNER_NOT_CONFIGURABLE", 409, error.message, {
      cause: error,
      context: { runner },
    });
  }
  return error;
}

/**
 * Runs one configuration write and shapes what it answers, mapping the
 * runtime's refusals to problems. Both writes return the configuration they
 * produced, so nothing is re-read.
 */
async function writeConfig(
  runner: string,
  write: () => Promise<RunnerConfigInfo>,
): Promise<RunnerConfigDto> {
  try {
    return toRunnerConfigDto(await write());
  } catch (error) {
    throw configError(error, runner);
  }
}

/**
 * The runner routes. Every runner in the namespace can be read and controlled
 * — one registered here directly, one registered by another process through
 * the backend — except that only this process can kill its own runs or reset
 * its runner's stats.
 */
export function runnerRoutes(config: ResolvedJobsApiConfig): AnyRouteDef[] {
  const { limits } = config;
  return [
    defineRoute({
      method: "GET",
      path: "/runners",
      operationId: "listRunners",
      action: "runners.list",
      mode: "runner",
      summary: "Every runner in the namespace",
      description:
        "Runners registered in this process (`isLocal: true`, with name and lifecycle `status`), then runners only other processes registered (`isLocal: false`). `local` is a deprecated copy of `isLocal`. Every item carries `isPaused` and `isRunning`, read from the backend with one bounded read per runner.",
      tags: ["Runners"],
      responses: { 200: RunnerListSchema },
      handler: async ({ services }) => {
        const { local, remote } = await services.runners.list();
        // One backend read per runner, bounded: paused and running come from
        // the backend, as `GET /runners/:runner` reports them.
        const flags = async (id: string) => {
          const { controller } = await services.runners.resolve(id);
          const { isPaused, isRunning } = await controller.info();
          return { isPaused, isRunning };
        };
        const items: {
          id: string;
          isLocal: boolean;
          local: boolean;
          name?: string;
          status?: RunnerStatus;
          isPaused: boolean;
          isRunning: boolean;
        }[] = [
          ...(await mapBounded(local, async (runner) => ({
            id: runner.id,
            isLocal: true,
            local: true,
            name: runner.name,
            status: runner.status,
            ...(await flags(runner.id)),
          }))),
          ...(await mapBounded(remote, async (id) => ({
            id,
            isLocal: false,
            local: false,
            ...(await flags(id)),
          }))),
        ];
        return { body: { items } };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/runners/:runner",
      operationId: "getRunner",
      action: "runners.read",
      mode: "runner",
      summary:
        "One runner: schedule, state, lock holder, counters and last run",
      description:
        "Read from the backend, so it is the same from any process. `local` adds this process's own view when the runner is registered here.",
      tags: ["Runners"],
      params: RunnerParams,
      responses: { 200: RunnerInfoSchema },
      errors: RUNNER_ERRORS,
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ req, params, services }) => {
        const { controller } = await services.runners.resolve(params.runner);
        return {
          body: toRunnerInfoDto(
            await controller.info(),
            req,
            services.config.serialize,
          ),
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/runners/:runner/history",
      operationId: "getRunnerHistory",
      action: "runners.read",
      mode: "runner",
      summary: "The runner's recent runs, newest first, from any process",
      tags: ["Runners"],
      params: RunnerParams,
      query: historyQuerySchema(limits.maxHistory),
      responses: { 200: HistorySchema },
      errors: RUNNER_ERRORS,
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ req, params, query, services }) => {
        const { controller } = await services.runners.resolve(params.runner);
        const records = await controller.history(query.limit);
        return {
          body: {
            items: records.map((record) =>
              toRunRecordDto(
                record as RunRecord,
                req,
                services.config.serialize,
              ),
            ),
          },
        };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/runners/:runner/history",
      operationId: "clearRunnerHistory",
      action: "runners.clearHistory",
      mode: "runner",
      requires: ["removeRuns"],
      summary: "Remove the runner's finished runs, keeping those in progress",
      description:
        "Removes every finished run — its history record and its run log — and leaves each run still in progress untouched, record and log whole, so a live run's log keeps growing and never loses its start. **Works for a runner registered in another process**: unlike `POST /runners/{runner}/stats/reset` and `POST /runners/{runner}/kill` it needs no owner, because it acts on what the backend stores. A run is in progress when the serving process is executing it (the runner is registered here), when the runner's live lock holder is executing it, or when its record still says `running` and it started less than `staleAfter` ago. A `running` record none of those vouch for is a run whose process crashed, and is removed with the finished ones. The limit: a parallel run holds no lock, so a live parallel run in another process older than `staleAfter` is removed too, and when it settles it finds no record to update — raise `staleAfter` for runners whose runs last longer than a day. The lifetime counters (`GET /runners/{runner}/stats`) and the analytics series are untouched. A backend that cannot remove individual runs has this route pruned, so it never answers 501 and never falls back to dropping the runs in progress.",
      tags: ["Runners"],
      params: RunnerParams,
      query: ClearHistoryQuerySchema,
      responses: { 200: ClearHistoryResultSchema },
      errors: RUNNER_ERRORS,
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ params, query, services }) => {
        const { controller } = await services.runners.resolve(params.runner);
        // The controller's `clearHistory` — the runner's own when it is
        // registered here, so its executing runs are kept — never the
        // driver's, which would drop the runs in progress with the rest.
        const { removed, kept } = await controller.clearHistory({
          staleAfter: query.staleAfter,
        });
        return { body: { removed, kept } };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/runners/:runner/runs/:runId/logs",
      operationId: "getRunLogs",
      action: "runners.logs",
      mode: "runner",
      requires: ["getRunLog"],
      summary: "A page of one run's captured output",
      description: `Lines are numbered from one by the store, and the numbering survives a trim — so a gap means the caps dropped those lines. \`since\` is an **exclusive** lower bound on \`seq\`: send the previous page's \`lastSeq\` back to tail. \`dropped\` and \`lastSeq\` are the run's own, never filtered by \`since\` or \`stream\`, which is what lets a filtered tail resume correctly. At most \`limits.maxLogPage\` lines a page.

**409 \`LOGS_NOT_RETAINED\` is not a 200 with no items.** The 409 says no log is kept for this run to read: either the backend keeps none at all (\`meta.features.runnerLogs\` is \`false\`) or this run's log has aged out of the retained set while its history record survived — the record is settled and its \`logLines\` is absent. A 200 with an empty \`items\` says the run is known, its log is retained, and it simply logged nothing (\`logLines\` is \`0\`) — or that it is **still running** and has not flushed a line yet, which is \`live: true\` with no counters on the record, since capture writes those when the run settles. A run neither the history nor the log store has heard of is 404 \`RUN_NOT_FOUND\`, as \`POST /runners/{runner}/kill\` answers one. A backend that cannot read run logs at all has this route pruned, so it never answers 501.`,
      tags: ["Runners"],
      params: RunParams,
      query: runLogsQuerySchema(limits.maxLogPage),
      responses: { 200: RunLogPageSchema },
      errors: [...RUNNER_ERRORS, "RUN_NOT_FOUND", "LOGS_NOT_RETAINED"],
      // The run is not part of the target: `AuthorizeTarget` has no run field,
      // and the kill route — the other one naming a run — authorizes on the
      // runner too. A host deciding by run reads `req` itself.
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ params, query, services }) => {
        const { id, controller } = await services.runners.resolve(
          params.runner,
        );
        const { driver, namespace } = controller;
        // `requires` prunes the route on a *configured* driver that cannot
        // read run logs; this is the controller's own, which a runner may have
        // been registered with. A backend that can read but never write keeps
        // no log for any run — it is exactly `features.runnerLogs === false`,
        // which `GET /meta` reports — so it says so rather than answering an
        // empty page a client would read as "the run was quiet".
        if (!driver.getRunLog || !driver.appendRunLog) {
          throw new ApiError(
            "LOGS_NOT_RETAINED",
            409,
            `This backend keeps no run logs, so run "${params.runId}" has none to read`,
            { context: { runner: id, runId: params.runId } },
          );
        }
        const [page, history] = await Promise.all([
          driver.getRunLog(namespace, runnerKey(id), params.runId, {
            offset: query.offset,
            limit: query.limit,
            order: query.order,
            ...(query.since === undefined ? {} : { since: query.since }),
            ...(query.stream === undefined ? {} : { stream: query.stream }),
          }),
          // The run's own record, for whether it exists and whether it is
          // still going. The log store cannot answer either: it is keyed by
          // run id alone and reads an unknown run as an empty log.
          controller.history(limits.maxHistory),
        ]);
        const record = history.find((run) => run.runId === params.runId);
        // Nothing in the store for this run. Three different facts read the
        // same way here, and the run's own record tells them apart:
        //
        // - no record at all: nobody has heard of this run     -> 404;
        // - a record without `logLines`: a retained run whose log is gone,
        //   because the counter is written by capture and survives with the
        //   record — so its absence means the log was never kept or has
        //   aged out of `keepRuns` ahead of the history                -> 409;
        // - a record with `logLines` (`0` included): the log IS retained and
        //   the run was simply quiet                                   -> 200.
        //
        // …except while the run is still going, which is the one case where a
        // missing counter means neither: capture writes the counters onto the
        // record when the run settles, so a run in flight has none yet and its
        // store is legitimately empty until the first flush. That is a quiet
        // live run — 200 and `live: true` — never an aged-out one.
        //
        // Gated on the store being empty, so a record predating the counters
        // whose lines are still there is served rather than hidden.
        if (page.lastSeq === 0 && page.dropped === 0) {
          if (!record) {
            throw new ApiError(
              "RUN_NOT_FOUND",
              404,
              `Run "${params.runId}" was not found`,
              { context: { runner: id, runId: params.runId } },
            );
          }
          if (record.logLines === undefined && record.status !== "running") {
            throw new ApiError(
              "LOGS_NOT_RETAINED",
              409,
              `No log is kept for run "${params.runId}"; it was never captured or has aged out`,
              { context: { runner: id, runId: params.runId } },
            );
          }
        }
        // `live` and `capped` are the route's, not the store's. `live` is the
        // run's status: the store knows nothing about the run. `capped` is
        // `dropped` in the present tense — a cap is dropping the oldest lines
        // *as new ones arrive*, which needs both a cap that has already bitten
        // and a run still producing, so what is here is a moving tail.
        const live = record?.status === "running";
        return {
          body: {
            items: page.lines.map(toRunLogLineDto),
            page: {
              offset: query.offset,
              limit: query.limit,
              total: page.count,
              hasMore: query.offset + page.lines.length < page.count,
            },
            dropped: page.dropped,
            capped: live && page.dropped > 0,
            live,
            lastSeq: page.lastSeq,
          },
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/runners/:runner/stats",
      operationId: "getRunnerStats",
      action: "runners.read",
      mode: "runner",
      summary: "The runner's lifetime counters, shared by every process",
      tags: ["Runners"],
      params: RunnerParams,
      responses: { 200: RunnerStatsSchema },
      errors: RUNNER_ERRORS,
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ params, services }) => {
        const { controller } = await services.runners.resolve(params.runner);
        return { body: await controller.stats() };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/runners/:runner/trigger",
      operationId: "triggerRunner",
      action: "runners.trigger",
      mode: "runner",
      summary: "Ask for a run",
      description: `202 when the run started or was queued, 200 when it was skipped (with the reason). \`args\` is refused unless the API was created with \`runnerTriggerArgs: true\`. ${REMOTE_LATENCY_NOTE}`,
      tags: ["Runners"],
      params: RunnerParams,
      body: TriggerBodySchema,
      bodyOptional: true,
      responses: { 200: TriggerOutcomeSchema, 202: TriggerOutcomeSchema },
      errors: [...RUNNER_ERRORS, "ARGS_NOT_ALLOWED", "RUNNER_STOPPED"],
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ params, body, services }) => {
        if (body.args !== undefined && !services.config.runnerTriggerArgs) {
          throw new ApiError(
            "ARGS_NOT_ALLOWED",
            400,
            "This API does not accept run arguments",
          );
        }
        const { controller } = await services.runners.resolve(params.runner);
        const outcome = await controller.trigger({
          ...(body.force === undefined ? {} : { force: body.force }),
          ...(body.args === undefined ? {} : { args: body.args }),
        });
        // A runner's state can appear in the backend with its first trigger.
        services.runners.invalidate();
        return {
          status: outcome.outcome === "skipped" ? 200 : 202,
          body: outcome,
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/runners/:runner/pause",
      operationId: "pauseRunner",
      action: "runners.pause",
      mode: "runner",
      summary: "Pause the runner everywhere",
      description: `Owners stop starting scheduled and manual runs; a run in flight carries on. ${REMOTE_LATENCY_NOTE}`,
      tags: ["Runners"],
      params: RunnerParams,
      responses: { 200: RunnerPausedSchema },
      errors: RUNNER_ERRORS,
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ params, services }) => {
        const { controller } = await services.runners.resolve(params.runner);
        await controller.pause();
        services.runners.invalidate();
        return { body: { paused: true } };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/runners/:runner/resume",
      operationId: "resumeRunner",
      action: "runners.resume",
      mode: "runner",
      summary: "Resume the runner everywhere",
      description: `\`triggerNow\` also asks for a run. ${REMOTE_LATENCY_NOTE}`,
      tags: ["Runners"],
      params: RunnerParams,
      body: ResumeBodySchema,
      bodyOptional: true,
      responses: { 200: RunnerPausedSchema },
      errors: RUNNER_ERRORS,
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ params, body, services }) => {
        const { controller } = await services.runners.resolve(params.runner);
        await controller.resume({ triggerNow: body.triggerNow });
        services.runners.invalidate();
        return { body: { paused: false } };
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/runners/:runner/schedule",
      operationId: "rescheduleRunner",
      action: "runners.reschedule",
      mode: "runner",
      summary: "Replace and persist the runner's schedule",
      description: `A cron expression, an interval in ms, \`{ cron, tz? }\`, \`{ every, anchor? }\`, \`{ at }\`, or \`null\` for none. An interval below 1, or a time a \`Date\` cannot hold (epoch ms above ${MAX_DATE_MS}, or a string that is not an RFC 3339 date-time), is 400 \`VALIDATION\`. A cron expression or time zone the scheduler refuses is 400 \`INVALID_SCHEDULE\`, with one \`issues\` entry whose \`path\` names the part at fault — \`schedule.cron\`, \`schedule.tz\`, or \`schedule\` for a bare cron string — and nothing is written. ${REMOTE_LATENCY_NOTE}`,
      tags: ["Runners"],
      params: RunnerParams,
      body: ScheduleBodySchema,
      responses: { 200: ScheduleResultSchema },
      errors: [...RUNNER_ERRORS, "INVALID_SCHEDULE"],
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ params, body, services }) => {
        const { controller } = await services.runners.resolve(params.runner);
        try {
          await controller.updateSchedule(toScheduleInput(body.schedule));
        } catch (error) {
          if (
            error instanceof ConfigError &&
            !(error instanceof NotSupportedError)
          ) {
            throw new ApiError("INVALID_SCHEDULE", 400, error.message, {
              cause: error,
              issues: [
                {
                  target: "body",
                  path: scheduleIssuePath(body.schedule),
                  message: error.message,
                },
              ],
            });
          }
          throw error;
        }
        services.runners.invalidate();
        const info = await controller.info();
        return {
          body: {
            schedule: info.schedule,
            nextRunAt: info.nextRunAt ? info.nextRunAt.getTime() : null,
          },
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/runners/:runner/kill",
      operationId: "killRunner",
      action: "runners.kill",
      mode: "runner",
      summary: "Kill one run, or every active run, in this process",
      description:
        "Only the process executing a run can stop it: a runner registered only in another process is 409 `RUNNER_NOT_LOCAL`. Answers 202 at once with the runs targeted; with `wait: true`, 200 once they have settled, which can take the runner's `closeTimeout` plus `killTimeout`.",
      tags: ["Runners"],
      params: RunnerParams,
      body: KillBodySchema,
      bodyOptional: true,
      responses: { 200: KillResultSchema, 202: KillResultSchema },
      errors: [...RUNNER_ERRORS, "RUNNER_NOT_LOCAL", "RUN_NOT_FOUND"],
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ params, body, services }) => {
        const runner = await services.runners.requireLocal(
          params.runner,
          "kill",
        );
        if (body.runId !== undefined && !runner.activeRuns.has(body.runId)) {
          throw new ApiError(
            "RUN_NOT_FOUND",
            404,
            `Run "${body.runId}" is not active in this process`,
            { context: { runner: runner.id, runId: body.runId } },
          );
        }
        const runIds =
          body.runId === undefined
            ? [...runner.activeRuns.keys()]
            : [body.runId];
        const killing = runner.kill(body.runId, {
          ...(body.force === undefined ? {} : { force: body.force }),
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        });
        if (body.wait) {
          await killing;
          return { status: 200, body: { runIds } };
        }
        killing.catch((error: unknown) => {
          services.config.logger.error("jobs api kill failed", {
            error,
            runner: runner.id,
          });
        });
        return { status: 202, body: { runIds } };
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/runners/:runner/config",
      operationId: "configureRunner",
      action: "runners.configure",
      mode: "runner",
      enabledWhen: (resolved) => supportsRunnerConfig(resolved.driver),
      summary: "Override the runner's executor and overlap settings",
      description: `A **merge patch**: a field left out is untouched, and \`null\` clears that override so the runner goes back to what its own code asked for. \`maxConcurrency\` only means anything under \`runMode: "parallel"\`, so the two are sent together as \`concurrency\`; it must be a whole number between ${RUNNER_CONFIG_BOUNDS.maxConcurrency.min} and ${RUNNER_CONFIG_BOUNDS.maxConcurrency.max} (400 \`VALIDATION\` at \`concurrency.maxConcurrency\` otherwise), or \`null\` for unlimited, which is not bounded. An execution mode the runner's code does not permit is 409 \`CONFIG_NOT_ALLOWED\`, listing the ones it does; a runner no owner has started since remote configuration shipped is 409 \`RUNNER_NOT_CONFIGURABLE\`, because the override would be stored and never adopted. ${CONFIG_LATENCY_NOTE}`,
      tags: ["Runners"],
      params: RunnerParams,
      body: RunnerConfigBodySchema,
      responses: { 200: RunnerConfigSchema },
      errors: CONFIG_ERRORS,
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ params, body, services }) => {
        const { controller } = await services.runners.resolve(params.runner);
        return {
          body: await writeConfig(
            params.runner,
            async () => await controller.updateConfig(body),
          ),
        };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/runners/:runner/config",
      operationId: "resetRunnerConfig",
      action: "runners.configure",
      mode: "runner",
      enabledWhen: (resolved) => supportsRunnerConfig(resolved.driver),
      summary: "Drop every override, back to what the runner's code asks for",
      description: `Clears all three settings at once. The version keeps counting up rather than restarting, so an owner that had adopted version 3 still sees a newer one — which is why this answers 200 with the configuration rather than 204. ${CONFIG_LATENCY_NOTE}`,
      tags: ["Runners"],
      params: RunnerParams,
      responses: { 200: RunnerConfigSchema },
      errors: CONFIG_ERRORS,
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ params, services }) => {
        const { controller } = await services.runners.resolve(params.runner);
        return {
          body: await writeConfig(
            params.runner,
            async () => await controller.resetConfig(),
          ),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/runners/:runner/stats/reset",
      operationId: "resetRunnerStats",
      action: "runners.resetStats",
      mode: "runner",
      summary: "Reset the runner's counters to zero",
      description:
        "Only for a runner registered in this process: otherwise 409 `RUNNER_NOT_LOCAL`.",
      tags: ["Runners"],
      params: RunnerParams,
      responses: { 204: null },
      errors: [...RUNNER_ERRORS, "RUNNER_NOT_LOCAL"],
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ params, services }) => {
        const runner = await services.runners.requireLocal(
          params.runner,
          "resetStats",
        );
        await runner.resetStats();
        return { status: 204 };
      },
    }),
  ];
}
