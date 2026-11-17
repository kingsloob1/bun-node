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
import { addAgentEventsRoute, addAgentRoutes } from "./agentRoutes";
import { sha256Of } from "./artefacts";
import type { SecurityApiLive } from "./live/transports";
import { LiveHub } from "./live/hub";
import { setLiveHooks } from "./liveHooks";
import { createLive, isUpgrade, liveDocsRouter } from "./live/transports";

/** Two AsyncAPI documents as one: the second's channels, operations and components added to the first's. */
function mergeAsyncApi(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): Record<string, unknown> {
  const section = (
    doc: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> =>
    (doc[key] as Record<string, unknown> | undefined) ?? {};
  const components: Record<string, unknown> = {
    ...section(first, "components"),
  };
  for (const [key, value] of Object.entries(section(second, "components"))) {
    components[key] = {
      ...((components[key] as Record<string, unknown> | undefined) ?? {}),
      ...(value as Record<string, unknown>),
    };
  }
  return {
    ...first,
    channels: { ...section(first, "channels"), ...section(second, "channels") },
    operations: {
      ...section(first, "operations"),
      ...section(second, "operations"),
    },
    components,
  };
}

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
  /** The AsyncAPI 3.0 document of the live stream: its SSE route and its WebSocket channel. */
  readonly asyncapi: () => Record<string, unknown>;
  /**
   * The live hub (ui.md §6): `attach(adapter)` adds the WebSocket channel at
   * `<basePath>/live` (after the router is mounted; `secureAdmin` does it),
   * `publishBatch` and `publishBan` are PR-CP4's hooks, `close()` ends every
   * live connection.
   */
  readonly live: SecurityApiLive;
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
  /**
   * Adds an artefact (an IP-intelligence database) to the configured
   * artefact store, for bundles to reference by its SHA-256 and agents to
   * fetch; its hash and size. Publishing it in a bundle is a later PR.
   * Throws a `ConfigError` without `agents.artefacts`, or past
   * `agents.maxArtefactBytes`.
   */
  readonly addArtefact: (
    bytes: Uint8Array,
  ) => Promise<{ readonly sha256: string; readonly size: number }>;
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
  if (options.agentEvents !== undefined && resolved.agents !== undefined) {
    throw new ConfigError(
      "createSecurityApi(): agents serves POST /agent/events on its own signed requests; leave agentEvents out",
    );
  }
  if (options.agentEvents !== undefined) {
    const agents = agentEventsRoute(
      resolved.store,
      options.agentEvents,
      resolved.now,
    );
    router.use("/agent/events", agents.guard);
    router.post("/agent/events", agents.handle);
  }
  // The agents' own routes first: agent authentication, never an operator's.
  if (resolved.agents !== undefined && plane.agents !== undefined) {
    const context = {
      plane,
      registry: plane.agents,
      options: resolved.agents,
      logger,
    };
    // PR-CP1's POST /agent/events on the agents' signed requests: the
    // header checks in a guard (before a deferred body is read), the
    // body's signature and its route in the handler.
    addAgentEventsRoute(router, context);
    addAgentRoutes(router, context);
  }
  const hub = new LiveHub(plane, { now: resolved.now });
  const live = createLive(hub, resolved);
  // CP4's stored batches and bans, to the hub.
  setLiveHooks(plane, {
    publishBatch: (service, batch) => hub.publishBatch(service, batch),
    publishBan: (ban) => hub.publishBan(ban),
  });
  const liveDocs = liveDocsRouter();
  // A WebSocket upgrade to /live is the channel's, on the adapter: the
  // router passes it on untouched (the SSE route would answer it otherwise).
  router.use("/live", (req, _res, next) => {
    if (isUpgrade(req)) next("router");
    else next();
  });
  for (const spec of routes(resolved, hub))
    addRoute(router, spec, resolved, plane, guard);

  const documents = {
    openapi: () =>
      generateOpenApi(router, {
        title: resolved.docs.title,
        version: resolved.docs.version,
        servers: [{ url: resolved.basePath }],
      }).document as unknown as Record<string, unknown>,
    asyncapi: () =>
      mergeAsyncApi(
        generateAsyncApi(router, {
          title: resolved.docs.title,
          version: resolved.docs.version,
        }).document as unknown as Record<string, unknown>,
        generateAsyncApi(liveDocs, {
          title: resolved.docs.title,
          version: resolved.docs.version,
        }).document as unknown as Record<string, unknown>,
      ),
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
    live,
    ...documents,
    verifyAudit: async () => await plane.audit.verify(),
    addArtefact: async (bytes: Uint8Array) => {
      const store = resolved.agents?.artefacts;
      if (store === undefined) {
        throw new ConfigError(
          "addArtefact(): configure agents.artefacts first",
        );
      }
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength > resolved.agents!.maxArtefactBytes
      ) {
        throw new ConfigError(
          `addArtefact(): an artefact is bytes, at most ${resolved.agents!.maxArtefactBytes}`,
        );
      }
      const sha256 = sha256Of(bytes);
      await store.put(sha256, bytes);
      return { sha256, size: bytes.byteLength };
    },
    checkpointAudit: async () => await plane.audit.checkpointNow(),
    purgeAudit: async ({ before }: { readonly before: number }) => {
      if (!Number.isSafeInteger(before) || before < 0) {
        throw new ConfigError("purgeAudit(): before must be a time in ms");
      }
      return await plane.audit.purge(before);
    },
  });
}
