import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { BunQueue } from "../../queue/BunQueue";
import type { Logger } from "../../shared/logger";
import type { AnyRouteDef } from "./define";
import { toJsonSchema } from "@kingsleyweb/bun-common";
import { findRepeat } from "../../queue/repeatControl";
import { ApiError } from "../errors";
import { s } from "../schema/builder";
import { DefinitionListSchema, RepeatableSchema } from "../schemas/jobs";
import { toRepeatableDto } from "../serialize";
import { defineRoute } from "./define";
import { QueueParams, queueTarget, RepeatableParams } from "./support";

/**
 * The vendors `/definitions` has already reported as unconvertible to JSON
 * Schema: each is warned about once per process, not once per definition or
 * request (plan bun-validate V5b).
 */
const UNCONVERTIBLE = new Set<string>();

/**
 * One side of a definition's `schema` as a JSON Schema document, `{}` when no
 * conversion path could describe it (the warning is logged once per vendor).
 * Both sides convert with `direction: "input"`: `data` is what a client
 * sends, and `result` is what it receives, and the wire rule holds the server
 * to the schema's input (plan §4.12, M2 — there is no
 * `responseOutput: "parsed"` here).
 */
function definitionSide(
  schema: StandardSchemaV1,
  logger: Logger,
  definition: string,
): Record<string, unknown> {
  return toJsonSchema(schema, {
    direction: "input",
    onWarning: (warning) => {
      if (UNCONVERTIBLE.has(warning.vendor)) {
        return;
      }
      UNCONVERTIBLE.add(warning.vendor);
      logger.warn(
        `A job schema from vendor "${warning.vendor}" could not be converted to JSON Schema; "/definitions" publishes {} for it`,
        {
          vendor: warning.vendor,
          stage: warning.stage,
          definition,
          message: warning.message,
        },
      );
    },
  });
}

/** The repeatable-series routes, and the definitions list. */
export function repeatableRoutes(): AnyRouteDef[] {
  return [
    defineRoute({
      method: "GET",
      path: "/queues/:queue/repeatables",
      operationId: "listRepeatables",
      action: "repeatables.list",
      mode: "jobs",
      summary: "The queue's repeat series",
      description:
        "Omits each series' `data` unless `include=data` asks for it.",
      tags: ["Jobs"],
      params: QueueParams,
      query: s.query(
        s.object({ include: s.optional(s.array(s.enum(["data"]))) }),
      ),
      responses: { 200: s.object({ items: s.array(RepeatableSchema) }) },
      errors: ["INVALID_NAME", "QUEUE_NOT_FOUND"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ req, params, query, services }) => {
        const queue = await services.queues.get(params.queue);
        const include = new Set(query.include ?? []);
        const records = await queue.listRepeatables();
        return {
          body: {
            items: records.map((record) =>
              toRepeatableDto(
                record,
                { queue: queue.name, include, req },
                services.config.serialize,
              ),
            ),
          },
        };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/queues/:queue/repeatables/:key",
      operationId: "removeRepeatable",
      action: "repeatables.remove",
      mode: "jobs",
      summary: "Remove a repeat series and the occurrence it had scheduled",
      tags: ["Jobs"],
      params: RepeatableParams,
      responses: { 204: null },
      errors: ["INVALID_NAME", "QUEUE_NOT_FOUND", "REPEATABLE_NOT_FOUND"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, services }) => {
        const queue = await services.queues.get(params.queue);
        if (!(await queue.removeRepeatable(params.key))) {
          throw new ApiError(
            "REPEATABLE_NOT_FOUND",
            404,
            `Repeat series "${params.key}" was not found`,
            { context: { queue: queue.name, key: params.key } },
          );
        }
        return { status: 204 };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/repeatables/:key/disable",
      operationId: "disableRepeatable",
      action: "repeatables.disable",
      mode: "jobs",
      requires: ["getQueueState", "setQueueState"],
      summary: "Stop a repeat series without removing it",
      description:
        "Removes the series' pending occurrence and schedules no further one until it is enabled; an occurrence already running finishes. The series stays, listed with `disabled: true`. Disabling a disabled series changes nothing.",
      tags: ["Jobs"],
      params: RepeatableParams,
      responses: { 200: s.object({ disabled: s.literal(true) }) },
      errors: ["INVALID_NAME", "QUEUE_NOT_FOUND", "REPEATABLE_NOT_FOUND"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, services }) => {
        const queue = await services.queues.get(params.queue);
        await toggleSeries(
          queue,
          params.key,
          queue.disableRepeatable(params.key),
        );
        return { body: { disabled: true } };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/queues/:queue/repeatables/:key/enable",
      operationId: "enableRepeatable",
      action: "repeatables.enable",
      mode: "jobs",
      requires: ["getQueueState", "setQueueState"],
      summary: "Restart a disabled repeat series",
      description:
        "Schedules the series' next occurrence from now: occurrences missed while it was disabled are not run. Enabling an enabled series changes nothing.",
      tags: ["Jobs"],
      params: RepeatableParams,
      responses: { 200: s.object({ enabled: s.literal(true) }) },
      errors: ["INVALID_NAME", "QUEUE_NOT_FOUND", "REPEATABLE_NOT_FOUND"],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, services }) => {
        const queue = await services.queues.get(params.queue);
        await toggleSeries(
          queue,
          params.key,
          queue.enableRepeatable(params.key),
        );
        return { body: { enabled: true } };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/definitions",
      operationId: "listDefinitions",
      action: "definitions.list",
      mode: "jobs",
      needsJobsSource: true,
      summary: "The job definitions this context knows",
      description:
        "Each definition's name and options, and its `schema: { data, result }` as JSON Schema when it declares one (`data` is what a client sends, `result` what it receives; a side whose vendor could not be converted is `{}`). Handlers are code, and never leave the process.",
      tags: ["Jobs"],
      responses: { 200: DefinitionListSchema },
      handler: ({ services }) => ({
        body: {
          items: (services.config.jobs?.definitions() ?? []).map(
            (definition) => ({
              name: definition.name,
              // Through JSON, so a `Date` or a stray function in the options
              // cannot reach the response as anything but JSON.
              options: JSON.parse(
                JSON.stringify(definition.options ?? {}),
              ) as Record<string, unknown>,
              ...(definition.schema === undefined
                ? {}
                : {
                    schema: {
                      ...(definition.schema.data === undefined
                        ? {}
                        : {
                            data: definitionSide(
                              definition.schema.data,
                              services.config.logger,
                              definition.name,
                            ),
                          }),
                      ...(definition.schema.result === undefined
                        ? {}
                        : {
                            result: definitionSide(
                              definition.schema.result,
                              services.config.logger,
                              definition.name,
                            ),
                          }),
                    },
                  }),
            }),
          ),
        },
      }),
    }),
  ];
}

/**
 * Awaits a disable or enable, and answers 404 when it changed nothing because
 * there is no such series. `false` otherwise means the series already was as
 * asked, which is not a problem: both routes are idempotent.
 */
async function toggleSeries(
  queue: BunQueue<unknown, unknown, string>,
  key: string,
  toggling: Promise<boolean>,
): Promise<void> {
  if ((await toggling) || (await findRepeat(queue.driver, queue.ref, key))) {
    return;
  }

  throw new ApiError(
    "REPEATABLE_NOT_FOUND",
    404,
    `Repeat series "${key}" was not found`,
    { context: { queue: queue.name, key } },
  );
}
