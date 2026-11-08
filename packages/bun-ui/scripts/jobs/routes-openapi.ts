/**
 * The management API's OpenAPI document, for `bun-client generate --module`:
 * the source of `app/jobs/api/routes.gen.ts`, the typed client's route map
 * (typed-client plan §11, the pilot).
 *
 * ```bash
 * bun run gen:client     # rewrites app/jobs/api/routes.gen.ts
 * bun run check:client   # the same with --check: exit 1 when it is stale
 * ```
 *
 * The document is the one a real `createJobsApi()` serves, built in process
 * over the memory driver, with every route the UI may call: both modes, every
 * action (the opt-in ones included: `queues.summon`, `jobs.add`, …), not
 * read-only. Its CSRF defence is the API's default (`requireJson`, no
 * header), so the map types no CSRF header: the header's name is the
 * deployment's (`JobsUiConfig.csrfHeader`), and the app's client adds it to
 * every mutation itself (`ApiClient.headers`). The problems it documents
 * (403 `CSRF_REJECTED`, 415 `UNSUPPORTED_MEDIA_TYPE`) are typed all the same.
 *
 * Not part of the app: it imports the bun-jobs package root (drivers, the
 * server), which no browser module may.
 */
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";

/** The namespace the document is built in: it names nothing in the routes. */
const NAMESPACE = "bun-ui-jobs";

/** Builds the document `generate --module` reads: `{ openapi }`. */
export default async function routesOpenApi(): Promise<{
  /** The OpenAPI 3.1 document of every route the UI may call. */
  openapi: ReturnType<ReturnType<typeof createJobsApi>["openapi"]>;
}> {
  const jobs = new BunJobs({
    namespace: NAMESPACE,
    driver: new MemoryDriver(),
  });
  try {
    const api = createJobsApi({
      jobs,
      mode: "both",
      readOnly: false,
      // The routes are keyed relative to it, so its value reaches only the
      // document's `servers`, which the map does not use.
      basePath: "/jobs-api",
      actions: [...JOBS_API_ACTIONS],
      authorize: () => true,
      logger: noopLogger,
    });
    return { openapi: api.openapi() };
  } finally {
    await jobs.close();
  }
}
