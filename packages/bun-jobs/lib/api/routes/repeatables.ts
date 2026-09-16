import type { AnyRouteDef } from "./define";
import { ApiError } from "../errors";
import { s } from "../schema/builder";
import { DefinitionListSchema, RepeatableSchema } from "../schemas/jobs";
import { toRepeatableDto } from "../serialize";
import { defineRoute } from "./define";
import { QueueParams, queueTarget, RepeatableParams } from "./support";

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
      method: "GET",
      path: "/definitions",
      operationId: "listDefinitions",
      action: "definitions.list",
      mode: "jobs",
      needsJobsSource: true,
      summary: "The job definitions this context knows",
      description:
        "Each definition's name and options. Handlers are code, and never leave the process.",
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
            }),
          ),
        },
      }),
    }),
  ];
}
