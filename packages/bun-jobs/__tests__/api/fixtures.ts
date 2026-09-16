import type {
  JobsApiAuthorizeContext,
  JobsApiConfig,
} from "../../lib/api/config";
import type { AnyRouteDef } from "../../lib/api/routes/define";
import type { JobsDriver } from "../../lib/index";
import { BunRouter, createTestLogger } from "@kingsleyweb/bun-common";
import { JOBS_API_ACTIONS } from "../../lib/api/config";
import { createJobsApi } from "../../lib/api/createJobsApi";
import { defineRoute } from "../../lib/api/routes/define";
import { s } from "../../lib/api/schema/builder";
import { JobStateSchema } from "../../lib/api/schemas/common";
import { BunJobs, MemoryDriver, runnerKey } from "../../lib/index";

/**
 * Shared fixtures for the API's route and spec tests: synthetic routes that
 * exercise every part of the registrar and generator the built-in routes do
 * not yet reach (params, bodies, mutations, modes, driver requirements).
 */

/** A named component only the runner-side test route uses, to test pruning. */
export const TestRunnerThingSchema = s.named(
  "TestRunnerThing",
  s.object({ ok: s.boolean() }),
);

/** A named component only a jobs-side test route uses. */
export const TestItemSchema = s.named(
  "TestItem",
  s.object({ queue: s.string(), id: s.integer(), ids: s.array(s.string()) }),
);

/** Synthetic routes, one per registrar feature. */
export function testRoutes(): AnyRouteDef[] {
  return [
    defineRoute({
      method: "POST",
      path: "/queues/:queue/items/:id/retry",
      operationId: "retryItem",
      action: "jobs.retry",
      mode: "jobs",
      summary: "A mutation with params, query and body",
      tags: ["Jobs"],
      params: s.query(
        s.object({
          queue: s.string({ pattern: "^[\\w.-]+$" }),
          id: s.integer({ minimum: 1 }),
        }),
      ),
      query: s.query(
        s.object({
          state: s.optional(s.array(JobStateSchema)),
          limit: s.optional(s.integer({ minimum: 1, default: 20 })),
        }),
      ),
      body: s.object({ ids: s.array(s.string(), { maxItems: 2 }) }),
      responses: { 200: TestItemSchema, 204: null },
      errors: ["QUEUE_NOT_FOUND", "BULK_LIMIT"],
      target: ({ params, body }) => ({ queue: params.queue, jobIds: body.ids }),
      handler: ({ params, body }) =>
        body.ids.length === 0
          ? { status: 204 }
          : { body: { queue: params.queue, id: params.id, ids: body.ids } },
    }),
    defineRoute({
      method: "GET",
      path: "/runners/:runner/thing",
      operationId: "getRunnerThing",
      action: "runners.read",
      mode: "runner",
      summary: "A runner-side route",
      tags: ["Runners"],
      responses: { 200: TestRunnerThingSchema },
      target: ({ params }) => ({ runner: params.runner }),
      handler: () => ({ body: { ok: true } }),
    }),
    defineRoute({
      method: "GET",
      path: "/logs-test",
      operationId: "getLogsTest",
      action: "jobs.logs",
      mode: "jobs",
      requires: ["getJobLogs"],
      summary: "A route needing an optional driver method",
      tags: ["Jobs"],
      responses: { 200: s.object({ ok: s.boolean() }) },
      handler: () => ({ body: { ok: true } }),
    }),
    defineRoute({
      method: "GET",
      path: "/definitions-test",
      operationId: "listDefinitionsTest",
      action: "definitions.list",
      mode: "jobs",
      needsJobsSource: true,
      summary: "A route needing a jobs source",
      tags: ["Jobs"],
      responses: { 200: s.object({ ok: s.boolean() }) },
      handler: () => ({ body: { ok: true } }),
    }),
    defineRoute({
      method: "GET",
      path: "/wrong-body",
      operationId: "getWrongBody",
      action: "jobs.read",
      mode: "jobs",
      summary: "A route whose handler breaks its own contract",
      tags: ["Jobs"],
      responses: { 200: s.object({ ok: s.boolean() }) },
      handler: () => ({ body: { ok: "yes" } as unknown as { ok: boolean } }),
    }),
    defineRoute({
      method: "POST",
      path: "/add-test",
      operationId: "addTest",
      action: "jobs.add",
      mode: "jobs",
      summary: "An opt-in route",
      tags: ["Jobs"],
      responses: { 204: null },
      handler: () => ({}),
    }),
  ];
}

/** Every context a test opened, for closing afterwards. */
export const openContexts: BunJobs[] = [];

/**
 * A context over the memory driver (or the one given). The driver is typed as
 * the contract rather than `MemoryDriver`, so a test can pass one with some
 * optional methods hidden and exercise a route's pruning.
 */
export function jobsContext(
  namespace = "api-routes",
  driver: JobsDriver = new MemoryDriver(),
): BunJobs {
  const jobs = new BunJobs({ namespace, driver });
  openContexts.push(jobs);
  return jobs;
}

/** A configuration with the required fields filled in. */
export function apiConfig(
  overrides: Partial<JobsApiConfig> = {},
): JobsApiConfig {
  return {
    jobs: jobsContext(),
    basePath: "/admin/jobs",
    authorize: () => true,
    logger: createTestLogger().logger,
    ...overrides,
  };
}

/** What one request through a harness answered. */
export interface HarnessResponse {
  /** The HTTP status. */
  status: number;
  /** The parsed JSON body, or `undefined` for an empty one. */
  body: any;
  /** The raw body text. */
  text: string;
  /** The response headers. */
  headers: Headers;
}

/** Every harness created, so a suite can check none saw a response break its schema. */
export const openHarnesses: { mismatches: () => unknown[] }[] = [];

/**
 * A mounted API for route tests: every action enabled, `validateResponses` on,
 * no queue-membership cache, and every `authorize` call recorded. Override
 * anything.
 */
export function harness(overrides: Partial<JobsApiConfig> = {}) {
  const { logger, events } = createTestLogger();
  const calls: JobsApiAuthorizeContext[] = [];
  // An explicit `jobs: undefined` means "no jobs source", not "make one". A
  // test that asks for none never touches `jobs`, so it is typed as present.
  const jobs = (
    "jobs" in overrides ? overrides.jobs : jobsContext()
  ) as BunJobs;
  const api = createJobsApi({
    basePath: "/admin/jobs",
    logger,
    validateResponses: true,
    actions: [...JOBS_API_ACTIONS],
    limits: { queueCacheMs: 0 },
    authorize: (_req, context) => {
      calls.push(context);
      return true;
    },
    ...overrides,
    jobs,
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);

  /** Sends one request under the base path; non-GET requests are JSON. */
  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HarnessResponse> {
    const init: RequestInit = {
      method,
      headers:
        method === "GET"
          ? headers
          : { "content-type": "application/json", ...headers },
    };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const response = await root.fetch(`/admin/jobs${path}`, init);
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
      text,
      headers: response.headers,
    };
  }

  /** Responses that did not match their declared schema. */
  const mismatches = () =>
    events
      .filter(
        (event) =>
          event.message === "jobs api response did not match its schema",
      )
      .map((event) => event.fields);

  const created = { jobs, api, root, call, calls, events, mismatches };
  openHarnesses.push(created);
  return created;
}

/** The in-process handler fixture that returns its arguments. */
export const ECHO_HANDLER = new URL(
  "../fixtures/handlers/echo.ts",
  import.meta.url,
);

/** The in-process handler fixture that sleeps, honouring its abort signal. */
export const SLEEP_HANDLER = new URL(
  "../fixtures/handlers/sleep.ts",
  import.meta.url,
);

/**
 * Makes the backend know a runner the way another process's `start()` does:
 * by persisting its state under the shared driver and namespace.
 */
export async function registerRunnerElsewhere(
  jobs: BunJobs,
  id: string,
): Promise<void> {
  await jobs.driver.connect();
  await jobs.driver.setState(jobs.namespace, runnerKey(id), {
    name: id,
    paused: "0",
    updatedAt: Date.now(),
  });
}
