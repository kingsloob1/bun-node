import type { RunRecord } from "../../drivers/index";
import type { RunnerStatus } from "../../runner/types";
import type { ScheduleInput } from "../../shared/schedule";
import type { ResolvedJobsApiConfig } from "../config";
import type { Infer } from "../schema/builder";
import type { AnyRouteDef } from "./define";
import { ConfigError, NotSupportedError } from "../../shared/errors";
import { ApiError } from "../errors";
import {
  historyQuerySchema,
  HistorySchema,
  KillBodySchema,
  KillResultSchema,
  ResumeBodySchema,
  RunnerInfoSchema,
  RunnerListSchema,
  RunnerPausedSchema,
  RunnerStatsSchema,
  ScheduleBodySchema,
  ScheduleResultSchema,
  TriggerBodySchema,
  TriggerOutcomeSchema,
} from "../schemas/runners";
import { toRunnerInfoDto, toRunRecordDto } from "../serialize";
import { defineRoute } from "./define";
import {
  REMOTE_LATENCY_NOTE,
  RunnerParams,
  runnerTarget,
  toEpoch,
} from "./support";

/** Errors every route naming a runner can answer with. */
const RUNNER_ERRORS = ["INVALID_NAME", "RUNNER_NOT_FOUND"] as const;

/** A schedule body turned into what `updateSchedule` takes: date-times become `Date`s. */
function toScheduleInput(
  schedule: Infer<typeof ScheduleBodySchema>["schedule"],
): ScheduleInput {
  if (schedule === null || typeof schedule !== "object") {
    return schedule;
  }
  if ("at" in schedule) {
    return { at: new Date(toEpoch(schedule.at)) };
  }
  if ("every" in schedule) {
    return {
      every: schedule.every,
      ...(schedule.anchor === undefined
        ? {}
        : { anchor: new Date(toEpoch(schedule.anchor)) }),
    };
  }
  return schedule;
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
        "Runners registered in this process (`local: true`, with name and status), then the ids of runners only other processes registered (`local: false`).",
      tags: ["Runners"],
      responses: { 200: RunnerListSchema },
      handler: async ({ services }) => {
        const { local, remote } = await services.runners.list();
        const items: {
          id: string;
          local: boolean;
          name?: string;
          status?: RunnerStatus;
        }[] = [
          ...local.map((runner) => ({
            id: runner.id,
            local: true,
            name: runner.name,
            status: runner.status,
          })),
          ...remote.map((id) => ({ id, local: false })),
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
      description: `A cron expression, an interval in ms, \`{ cron, tz? }\`, \`{ every, anchor? }\`, \`{ at }\`, or \`null\` for none. A malformed schedule is 400 \`INVALID_SCHEDULE\`, and nothing is written. ${REMOTE_LATENCY_NOTE}`,
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
