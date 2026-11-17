/**
 * `createSecurityApi` (control-plane.md §4): the control plane's
 * management API, a bun-common router to mount on the admin listener
 * (`secureAdmin`), never on a protected service's public one.
 */
import type {
  Logger,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import {
  BunRouter,
  ConfigError,
  createLogger,
  ResponseValidationError,
  resolveLogger,
  ValidationError,
} from "@kingsleyweb/bun-common";
import {
  generateAsyncApi,
  generateOpenApi,
} from "@kingsleyweb/bun-common/lib/docs";
import type { SecurityApiOptions } from "./options";
import type { AuditCheckpoint } from "../store/types";
import type { AuditVerifyDto } from "./contract/types";
import { csrf } from "../http/csrf";
import { agentEventsRoute } from "./agentEvents";
import { resolveOptions } from "./options";
import { ControlPlane } from "./plane";
import { ApiProblem } from "./problems";
import { addRoute, sendProblem } from "./route";
import { routes } from "./routes";

/** What {@link createSecurityApi} returns. */
export interface SecurityApi {
  /** The routes, to mount at {@link basePath}: `app.use(api.basePath, api.router)`. */
  readonly router: BunRouter;
  /** Where to mount it. */
  readonly basePath: string;
  /** The control plane's logic, for a host's own jobs (recompiling, reading). */
  readonly plane: ControlPlane;
  /** The OpenAPI 3.1 document of the routes. */
  readonly openapi: () => Record<string, unknown>;
  /** The AsyncAPI 3.0 document of the live stream. */
  readonly asyncapi: () => Record<string, unknown>;
  /**
   * Recomputes the audit chain and checks every checkpoint, stored and
   * read back from the sinks; names the first entry where it broke (and
   * alerts `audit.verifyFailed`). Run it on a schedule.
   */
  readonly verifyAudit: () => Promise<AuditVerifyDto>;
  /** Signs and writes a checkpoint of the chain's head now; `null` when the chain is empty. */
  readonly checkpointAudit: () => Promise<AuditCheckpoint | null>;
  /**
   * Retention (a host's scheduled job, never a route): deletes audit
   * entries older than `before` (ms), only up to the latest checkpoint
   * older than it, so the oldest kept entry stays anchored. The purge is
   * itself audited. How many entries went.
   */
  readonly purgeAudit: (options: {
    readonly before: number;
  }) => Promise<number>;
}

/**
 * The management API over `options.store`. Throws a `ConfigError` for a
 * missing `authenticate`, neither `authorize` nor `owners`, no step-up
 * hook without `approvals: "two-person"` or `allowWithoutStepUp`, a
 * missing or bad `signing` key, or a read-only store.
 *
 * ```ts
 * const api = createSecurityApi({
 *   store: sqliteStore({ path: "./security.sqlite" }),
 *   authenticate: (req) => sessions.operatorOf(req),
 *   owners: ["op_alice"],
 *   stepUp: { verify: (req, op) => mfa.freshFor(req, op), challenge: () => "/mfa" },
 *   signing: { keyId: "sk_2026_11", privateKey: process.env.BUNDLE_KEY! },
 * });
 * adminApp.use(api.basePath, api.router);
 * ```
 */
export function createSecurityApi(options: SecurityApiOptions): SecurityApi {
  const resolved = resolveOptions(options);
  const logger: Logger = resolveLogger(
    options.logger,
    createLogger({ name: "bun-security" }),
  );
  const plane = new ControlPlane(resolved, logger);
  const router = new BunRouter();
  const guard =
    resolved.csrf === false
      ? undefined
      : csrf({ origins: resolved.csrf.origins, onlyWithCookies: true });
  if (options.agentEvents !== undefined) {
    const agents = agentEventsRoute(
      resolved.store,
      options.agentEvents,
      resolved.now,
    );
    router.use("/agent/events", agents.guard);
    router.post("/agent/events", agents.handle);
  }
  for (const spec of routes(resolved))
    addRoute(router, spec, resolved, plane, guard);

  const documents = {
    openapi: () =>
      generateOpenApi(router, {
        title: resolved.docs.title,
        version: resolved.docs.version,
        servers: [{ url: resolved.basePath }],
      }).document as unknown as Record<string, unknown>,
    asyncapi: () =>
      generateAsyncApi(router, {
        title: resolved.docs.title,
        version: resolved.docs.version,
      }).document as unknown as Record<string, unknown>,
  };
  router.get("/openapi.json", (_req, res) =>
    res.json(documents.openapi() as never),
  );
  router.get("/asyncapi.json", (_req, res) =>
    res.json(documents.asyncapi() as never),
  );

  router.use(((error, _req, res, _next) => {
    if (error instanceof ApiProblem) {
      sendProblem(res, error);
      return;
    }
    if (error instanceof ValidationError) {
      sendProblem(
        res,
        new ApiProblem(400, "invalid_request", "the request is not valid", {
          issues: error.issues.map((issue) => ({
            message: issue.message,
            path: [
              issue.target,
              ...(issue.path === undefined || issue.path === ""
                ? []
                : issue.path.split(".")),
            ],
          })),
        }),
      );
      return;
    }
    if (error instanceof ResponseValidationError) {
      logger.error("bun-security api: an answer did not match its contract", {
        error,
      });
    } else {
      logger.error("bun-security api: a request failed", { error });
    }
    sendProblem(res, new ApiProblem(500, "internal", "the request failed"));
  }) satisfies RouterErrorMiddlewareHandler);

  return Object.freeze({
    router,
    basePath: resolved.basePath,
    plane,
    ...documents,
    verifyAudit: async () => await plane.audit.verify(),
    checkpointAudit: async () => await plane.audit.checkpointNow(),
    purgeAudit: async ({ before }: { readonly before: number }) => {
      if (!Number.isSafeInteger(before) || before < 0) {
        throw new ConfigError("purgeAudit(): before must be a time in ms");
      }
      return await plane.audit.purge(before);
    },
  });
}
