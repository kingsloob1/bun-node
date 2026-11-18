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
import type { AuditVerifyDto, CompiledBundleDto } from "./contract/types";
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
import { Alerting } from "./alerts/alerting";
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
  /**
   * Whether the break-glass account is configured: what a UI shows a
   * signed-out operator, who cannot read `/meta` (bun-ui's `/security`).
   */
  readonly breakGlass: boolean;
  /** The AsyncAPI 3.0 document of the live stream: its SSE route and its WebSocket channel. */
  readonly asyncapi: () => Record<string, unknown>;
  /**
   * The live hub (ui.md §6): `attach(adapter)` adds the WebSocket channel at
   * `<basePath>/live` (after the router is mounted; `secureAdmin` does it),
   * `publishBatch` and `publishBan` are PR-CP4's hooks, `close()` ends every
   * live connection.
   */
  readonly live: SecurityApiLive;
  /** Alerting, when `alerts` is set: `evaluate()`, `test(channel)`, `deadLetters()`, `stats()`, `close()`. */
  readonly alerts: Alerting | undefined;
  /**
   * Recomputes the audit chain and checks every checkpoint, stored and
   * read back from the sinks; names the first entry where it broke (and
   * alerts `audit.verifyFailed`). Run it on a schedule.
   */
  readonly verifyAudit: () => Promise<AuditVerifyDto>;
  /**
   * Runs the bundle repair pass now (#847): recompiles each service bundle
   * left behind the heads of its policies, as a publish cut off before its
   * bundles leaves it; audited as `bundle.repair`. The API runs it at start
   * and every `bundleRepair.interval` by itself unless `bundleRepair:
   * false`. The bundles compiled.
   */
  readonly repairBundles: () => Promise<readonly CompiledBundleDto[]>;
  /**
   * Runs the retention pass of the agents' automatic bans now: deletes
   * those that ended more than `bans.autoRetention` ago (30 days by
   * default), audited as `bans.purge` with the count; `0` with
   * `autoRetention: false`. The count.
   */
  readonly purgeAutoBans: () => Promise<number>;
  /** Stops what the API runs by itself (the bundle repair and ban retention passes, alerting). The store is the host's: never closed here. */
  readonly close: () => void;
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
  const alerts =
    options.alerts === undefined
      ? undefined
      : new Alerting(plane, options.alerts);
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
  for (const spec of routes(resolved, hub, alerts))
    addRoute(router, spec, resolved, plane, guard);

  const documents = {
    openapi: () =>
      liftPolicyComponent(
        generateOpenApi(router, {
          title: resolved.docs.title,
          version: resolved.docs.version,
          servers: [{ url: resolved.basePath }],
        }).document,
      ),
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

  // The bundle repair pass (#847): at start, then every interval; one pass
  // at a time; a failing pass is logged and the next one tries again.
  let repairing: Promise<unknown> | undefined;
  const repairOnce = async (): Promise<readonly CompiledBundleDto[]> => {
    const graceMs =
      resolved.bundleRepairMs === undefined
        ? undefined
        : Math.min(30_000, resolved.bundleRepairMs / 2);
    return await plane.repairBundles(graceMs === undefined ? {} : { graceMs });
  };
  const scheduled = (): void => {
    if (repairing !== undefined) return;
    repairing = repairOnce()
      .then((compiled) => {
        if (compiled.length > 0) {
          logger.warn(
            "bun-security: bundles behind their policy heads were recompiled",
            { bundles: compiled },
          );
        }
      })
      .catch((error: unknown) => {
        logger.error("bun-security: the bundle repair pass failed", {
          error,
        });
      })
      .finally(() => {
        repairing = undefined;
      });
  };
  let repairTimer: ReturnType<typeof setInterval> | undefined;
  if (resolved.bundleRepairMs !== undefined) {
    queueMicrotask(scheduled);
    repairTimer = setInterval(scheduled, resolved.bundleRepairMs);
    repairTimer.unref?.();
  }

  // The retention of the agents' automatic bans: once an hour and at
  // start, one pass at a time; a failing pass is logged, the next retries.
  const purgeOnce = async (): Promise<number> =>
    resolved.autoBanRetentionMs === undefined
      ? 0
      : await plane.purgeAutoBans(plane.now() - resolved.autoBanRetentionMs);
  let purging: Promise<unknown> | undefined;
  const purgeScheduled = (): void => {
    if (purging !== undefined) return;
    purging = purgeOnce()
      .catch((error: unknown) => {
        logger.error("bun-security: the automatic-ban purge failed", {
          error,
        });
      })
      .finally(() => {
        purging = undefined;
      });
  };
  let purgeTimer: ReturnType<typeof setInterval> | undefined;
  if (resolved.autoBanRetentionMs !== undefined) {
    queueMicrotask(purgeScheduled);
    purgeTimer = setInterval(purgeScheduled, 3_600_000);
    purgeTimer.unref?.();
  }

  return Object.freeze({
    router,
    basePath: resolved.basePath,
    repairBundles: repairOnce,
    purgeAutoBans: purgeOnce,
    close: () => {
      if (repairTimer !== undefined) clearInterval(repairTimer);
      repairTimer = undefined;
      if (purgeTimer !== undefined) clearInterval(purgeTimer);
      purgeTimer = undefined;
      alerts?.close();
    },
    breakGlass: resolved.breakGlass !== undefined,
    plane,
    live,
    alerts,
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

/** The OpenAPI component the policy's JSON Schema is published under (PR-AN2). */
export const POLICY_COMPONENT = "SecurityPolicy";

/**
 * Moves every inline copy of the policy's JSON Schema (a node titled
 * {@link POLICY_COMPONENT}: the schemas embed it where a policy appears)
 * into one `components.schemas.SecurityPolicy`, each copy replaced by a
 * `$ref` to it (PR-AN2). The document is changed in place and returned.
 */
export function liftPolicyComponent(
  document: Record<string, unknown>,
): Record<string, unknown> {
  let body: Record<string, unknown> | undefined;
  const ref = { $ref: `#/components/schemas/${POLICY_COMPONENT}` };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== "object" || node === null) return node;
    const object = node as Record<string, unknown>;
    if (object.title === POLICY_COMPONENT && object.type === "object") {
      body ??= object;
      return { ...ref };
    }
    for (const [key, value] of Object.entries(object))
      object[key] = walk(value);
    return object;
  };
  for (const [key, value] of Object.entries(document))
    document[key] = walk(value);
  if (body === undefined) return document;
  const components = (document.components ?? {}) as Record<string, unknown>;
  const schemas = (components.schemas ?? {}) as Record<string, unknown>;
  document.components = {
    ...components,
    schemas: Object.fromEntries(
      [...Object.entries(schemas), [POLICY_COMPONENT, body] as const].sort(
        ([a], [b]) => (a < b ? -1 : 1),
      ),
    ),
  };
  return document;
}
