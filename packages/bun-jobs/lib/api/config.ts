import type {
  BunRequest,
  BunRouter,
  BunWebSocketHandlerType,
  CorsOptions,
  Logger,
  LoggerLike,
  RouterHandler,
  WebSocketClientData,
} from "@kingsleyweb/bun-common";
import type { Server } from "bun";
import type { BunJobs } from "../BunJobs";
import type {
  DriverEvent,
  JobRecord,
  JobsDriver,
  RepeatRecord,
  RunRecord,
} from "../drivers/index";
import type { BunQueue } from "../queue/BunQueue";
import type { BunRunner } from "../runner/BunRunner";
import type { BunRunnerManager } from "../runner/BunRunnerManager";
import type { RemoteRunnerInfo } from "../runner/types";
import type {
  EventDto,
  JobDto,
  RepeatableDto,
  RunnerInfoDto,
  RunRecordDto,
} from "./serialize";
import { resolveLogger } from "@kingsleyweb/bun-common";
import { ConfigError } from "../shared/errors";
import { assertSegment } from "../shared/keys";

/**
 * The management API's configuration: what `createJobsApi` accepts, and the
 * one place that turns it into a validated, defaulted shape.
 *
 * Everything that can be wrong about a configuration is refused here, at
 * construction, with a `ConfigError` — an API that starts and then answers
 * every request with a 500 (or, worse, answers them all without asking
 * `authorize`) is a failure discovered in production.
 */

/** Which half of the package the API exposes: routes, channels and spec entries alike. */
export type JobsApiMode = "jobs" | "runner" | "both";

/** Every action `authorize` can be asked about. The list is the source of truth for specs and pruning. */
export const JOBS_API_ACTIONS = [
  "meta.read",
  "docs.read",
  "queues.list",
  "queues.read",
  "queues.pause",
  "queues.resume",
  "queues.drain",
  "queues.clean",
  "queues.limits",
  "metrics.read",
  "workers.list",
  "jobs.list",
  "jobs.read",
  "jobs.logs",
  "jobs.add",
  "jobs.update",
  "jobs.retry",
  "jobs.retryAll",
  "jobs.remove",
  "jobs.promote",
  "repeatables.list",
  "repeatables.remove",
  "definitions.list",
  "runners.list",
  "runners.read",
  "runners.trigger",
  "runners.pause",
  "runners.resume",
  "runners.kill",
  "runners.reschedule",
  "runners.resetStats",
  "events.connect",
  "events.subscribe",
] as const;

/** One authorizable action. */
export type JobsApiAction = (typeof JOBS_API_ACTIONS)[number];

/**
 * Actions that change state; all are removed by `readOnly: true`.
 *
 * `queues.limits` is only ever the `PUT`: reading limits is `queues.read`.
 */
export const JOBS_API_MUTATIONS: ReadonlySet<JobsApiAction> =
  new Set<JobsApiAction>([
    "queues.pause",
    "queues.resume",
    "queues.drain",
    "queues.clean",
    "queues.limits",
    "jobs.add",
    "jobs.update",
    "jobs.retry",
    "jobs.retryAll",
    "jobs.remove",
    "jobs.promote",
    "repeatables.remove",
    "runners.trigger",
    "runners.pause",
    "runners.resume",
    "runners.kill",
    "runners.reschedule",
    "runners.resetStats",
  ]);

/** Actions excluded when `actions` is not given, because they write caller-supplied payloads. */
export const JOBS_API_OPT_IN_ACTIONS: ReadonlySet<JobsApiAction> =
  new Set<JobsApiAction>(["jobs.add", "jobs.update"]);

/** Whether an action changes state. */
export function isMutation(action: JobsApiAction): boolean {
  return JOBS_API_MUTATIONS.has(action);
}

/** What `authorize` is told about the request being decided. */
export interface JobsApiAuthorizeContext {
  /** The action being attempted. */
  action: JobsApiAction;
  /** Whether the action changes state. */
  mutation: boolean;
  /** Which transport is asking: an HTTP route, or a WebSocket upgrade/subscription. */
  transport: "http" | "ws";
  /** The queue the action targets, when it targets one. Already validated as a segment. */
  queue?: string;
  /** The job the action targets, for single-job routes and `job` channels. */
  jobId?: string;
  /** Every id of a bulk operation, capped by `limits.maxBulkIds`. `authorize` is called once, not per id. */
  jobIds?: readonly string[];
  /** The runner the action targets, when it targets one. */
  runner?: string;
  /** The WebSocket channel being subscribed to, e.g. `"queue/mail"`. */
  channel?: string;
  /** The matched route, for HTTP: method and the route pattern (not the concrete URL). */
  route?: {
    /** The HTTP method, upper case. */
    method: string;
    /** The route pattern under `basePath`, e.g. `"/queues/:queue/jobs/:id"`. */
    path: string;
  };
}

/** What `authorize` answers. `true`/`false` are shorthands for allow/deny (403). */
export type JobsApiAuthorizeResult =
  | boolean
  | {
      /** Allowed. */
      allow: true;
    }
  | {
      /** Denied. */
      allow: false;
      /** `401` when the caller is unauthenticated, `403` (the default) when they lack the permission. */
      status?: 401 | 403;
      /** Safe, client-visible reason. Never put secrets here. */
      reason?: string;
    };

/** Decides whether a request may perform an action. May be async. */
export type JobsApiAuthorize = (
  req: BunRequest,
  context: JobsApiAuthorizeContext,
) => JobsApiAuthorizeResult | Promise<JobsApiAuthorizeResult>;

/** Hooks that shape what leaves the process: redact, trim, or enrich. */
export interface JobsApiSerializers {
  /**
   * Maps a stored job to what a client sees. Receives the default DTO (already
   * without `lockToken`) and the raw record. Return a new object; mutating is
   * allowed but not required. Runs for lists, single reads, children and lookups.
   */
  job?: (dto: JobDto, record: JobRecord, req: BunRequest) => JobDto;
  /** Maps a repeat definition. */
  repeatable?: (
    dto: RepeatableDto,
    record: RepeatRecord,
    req: BunRequest,
  ) => RepeatableDto;
  /**
   * Maps runner info, for runners registered in this process or another.
   * Default omits `file` unless `exposeRunnerFiles` is on.
   */
  runner?: (
    dto: RunnerInfoDto,
    info: RemoteRunnerInfo,
    req: BunRequest,
  ) => RunnerInfoDto;
  /** Maps one run record (history, activeRuns, lastRun). */
  run?: (dto: RunRecordDto, record: RunRecord, req: BunRequest) => RunRecordDto;
  /**
   * Maps an event before it is sent to one WebSocket session; `null` drops it
   * for that session. Receives the upgrade request of the session.
   */
  event?: (
    dto: EventDto,
    event: DriverEvent,
    req: BunRequest,
  ) => EventDto | null;
  /** Include `stack` on serialised errors. Defaults to `false`. */
  exposeStacks?: boolean;
  /** Include a runner's absolute handler `file` path. Defaults to `false`. */
  exposeRunnerFiles?: boolean;
  /** Include host/pid on workers, run records and `runningOn`. Defaults to `true` (operators need it). */
  exposeHosts?: boolean;
}

/** Hard caps that bound the cost of any single request. */
export interface JobsApiLimits {
  /** Largest `limit` a job list accepts. Defaults to `100`. */
  maxPageSize?: number;
  /** `limit` when none is given. Defaults to `20`; may not exceed `maxPageSize`. */
  defaultPageSize?: number;
  /** Most ids in a bulk body (`lookup`, bulk retry/remove/promote). Defaults to `1000`. */
  maxBulkIds?: number;
  /** Most jobs a single `retry-all` may move. Defaults to `10000`. */
  maxRetryAll?: number;
  /** Largest `limit` for `clean`. Defaults to `10000`. */
  maxClean?: number;
  /** Largest log page. Defaults to `500`. */
  maxLogPage?: number;
  /** Largest runner history page. Defaults to `200`. */
  maxHistory?: number;
  /** Most queues summarised by `/queues` and `/overview`. Defaults to `500`. */
  maxQueues?: number;
  /** How long the known-queue (and known-runner) list is cached for 404 checks, in ms. `0` disables caching. Defaults to `2000`. */
  queueCacheMs?: number;
  /** Largest request body accepted for `jobs.add`/`jobs.update`, in bytes. Defaults to `1048576`. */
  maxJobDataBytes?: number;
}

/** Every limit, with its default applied. */
export type ResolvedJobsApiLimits = Readonly<Required<JobsApiLimits>>;

/** The limits used when none are given. */
export const DEFAULT_JOBS_API_LIMITS: ResolvedJobsApiLimits = Object.freeze({
  maxPageSize: 100,
  defaultPageSize: 20,
  maxBulkIds: 1000,
  maxRetryAll: 10_000,
  maxClean: 10_000,
  maxLogPage: 500,
  maxHistory: 200,
  maxQueues: 500,
  queueCacheMs: 2000,
  maxJobDataBytes: 1_048_576,
});

/**
 * An OpenAPI 3.1 security scheme, as `docs.securitySchemes` takes it. Only the
 * fields the AsyncAPI mapping reads are typed; the rest pass through.
 */
export type OpenApiSecurityScheme =
  | {
      /** An API key. */
      type: "apiKey";
      /** Where the key is sent. */
      in: "header" | "query" | "cookie";
      /** The header, query parameter or cookie name. */
      name: string;
      /** Human description. */
      description?: string;
    }
  | {
      /** An HTTP authentication scheme. */
      type: "http";
      /** The scheme, e.g. `"bearer"` or `"basic"`. */
      scheme: string;
      /** A hint at the bearer token's format, e.g. `"JWT"`. */
      bearerFormat?: string;
      /** Human description. */
      description?: string;
    }
  | {
      /** OAuth 2. */
      type: "oauth2";
      /** The flows, in OpenAPI form. */
      flows: Record<string, unknown>;
      /** Human description. */
      description?: string;
    }
  | {
      /** OpenID Connect discovery. */
      type: "openIdConnect";
      /** The discovery document's URL. */
      openIdConnectUrl: string;
      /** Human description. */
      description?: string;
    };

/** Docs endpoints and pages. */
export interface JobsApiDocsOptions {
  /** Path (under `basePath`) of the OpenAPI JSON. Defaults to `"/openapi.json"`. */
  openapiPath?: string;
  /** Path of the AsyncAPI JSON. Defaults to `"/asyncapi.json"`. Absent when the WebSocket is off. */
  asyncapiPath?: string;
  /** Serve HTML viewers loaded from a CDN. Defaults to `false`. */
  ui?: boolean;
  /** Path of the Swagger UI page. Defaults to `"/docs"`. */
  uiPath?: string;
  /** Path of the AsyncAPI viewer page. Defaults to `"/docs/asyncapi"`. */
  asyncapiUiPath?: string;
  /** `info.title` of both documents. Defaults to `"bun-jobs management API (<namespace>)"`. */
  title?: string;
  /** `info.version` of both documents. Defaults to the bun-jobs package version. */
  version?: string;
  /** `info.description`, Markdown. */
  description?: string;
  /** OpenAPI `servers`. Defaults to `[{ url: basePath }]` (relative, so it works behind any host). */
  servers?: {
    /** The server URL. */
    url: string;
    /** Human description. */
    description?: string;
  }[];
  /** AsyncAPI server host (`host:port`) and protocol. Defaults to deriving from the docs request's `Host`. */
  asyncapiServer?: {
    /** `host:port`. */
    host: string;
    /** `ws` or `wss`. */
    protocol: "ws" | "wss";
  };
  /**
   * Security schemes to declare, keyed by name, in OpenAPI 3.1 form. They are
   * mapped to AsyncAPI 3.0 equivalents. `authorize` stays opaque; this is documentation.
   */
  securitySchemes?: Record<string, OpenApiSecurityScheme>;
  /** Requirement applied to every operation. Defaults to every scheme, each with `[]`. */
  security?: Record<string, string[]>[];
  /** CDN assets, pinned. Override to self-host or mirror; versions must be exact semvers. */
  cdn?: {
    /** Defaults to `"https://cdn.jsdelivr.net/npm"`. */
    baseUrl?: string;
    /** Exact `swagger-ui-dist` version and SRI hashes for its bundle and CSS. */
    swaggerUi?: {
      /** Exact semver. */
      version: string;
      /** `sha384-` hashes of the bundle and stylesheet. */
      integrity?: {
        /** Hash of the script. */
        js: string;
        /** Hash of the stylesheet. */
        css: string;
      };
    };
    /** Exact `@asyncapi/react-component` version and SRI hashes. */
    asyncapi?: {
      /** Exact semver. */
      version: string;
      /** `sha384-` hashes of the bundle and stylesheet. */
      integrity?: {
        /** Hash of the script. */
        js: string;
        /** Hash of the stylesheet. */
        css: string;
      };
    };
  };
}

/** The docs options with their paths defaulted and validated. */
export type ResolvedJobsApiDocsOptions = JobsApiDocsOptions &
  Readonly<
    Required<
      Pick<
        JobsApiDocsOptions,
        "openapiPath" | "asyncapiPath" | "ui" | "uiPath" | "asyncapiUiPath"
      >
    >
  >;

/** The live event socket. */
export interface JobsApiWebSocketOptions {
  /** Path under `basePath`. Defaults to `"/ws"`. Exact match: no trailing slash. */
  path?: string;
  /**
   * Serve the socket on its own port with its own `BunWebSocket` server instead
   * of the host's. Defaults to `undefined` (same port).
   *
   * **Recommended for NestJS apps that use WebSocket gateways.** A gateway
   * declared with a `"/*"` (or `"*"`) namespace matches every path below it,
   * including this socket's, so on the shared HTTP server it also receives
   * these connections and will try to read their frames as its own. Every
   * connection this API upgrades is marked (`ws.data.custom.bunJobsApi`), and
   * this API ignores anything it did not mark, so such a gateway can filter
   * them out — but a dedicated port avoids the overlap by construction.
   *
   * Give every gateway an explicit namespace either way: one declared without
   * a namespace binds to `/`, which cannot be told apart from anything else.
   */
  port?: number;
  /** Application heartbeat interval, in ms. `0` disables it. Defaults to `25000`. */
  heartbeatMs?: number;
  /** Most channel subscriptions one connection may hold. Defaults to `50`. */
  maxSubscriptions?: number;
  /** Most concurrent connections across the API. Defaults to `1000`. */
  maxConnections?: number;
  /** Largest client frame, in bytes. Defaults to `16384`. */
  maxMessageBytes?: number;
  /** Client messages allowed per second per connection (token bucket, burst x2). Defaults to `20`. */
  messagesPerSecond?: number;
  /** Buffered bytes above which a session stops receiving and is marked lagging. Defaults to `1048576`. */
  maxBufferedBytes?: number;
  /** How long a session may stay lagging before it is closed with `4008`. Defaults to `30000`. */
  slowConsumerTimeoutMs?: number;
  /** Events kept for resume: most entries and oldest age. Defaults to `{ size: 1000, maxAgeMs: 300000 }`. */
  replay?:
    | {
        /** Most events kept. Defaults to `1000`. */
        size?: number;
        /** Oldest event kept, in ms. Defaults to `300000`. */
        maxAgeMs?: number;
      }
    | false;
  /**
   * Origins allowed to upgrade, besides the same origin. Defaults to same-origin
   * only (`Origin` host equals `Host`), and to any origin when the request has
   * no `Origin` (non-browser clients). `"*"` allows every origin.
   */
  allowedOrigins?: (string | RegExp)[] | "*";
  /** Coalesce `progress` events per job to at most one per interval, in ms. `0` sends all. Defaults to `250`. */
  coalesceProgressMs?: number;
}

/** The socket options with every default applied. */
export interface ResolvedJobsApiWebSocketOptions {
  /** Path under `basePath`, starting with `/`. */
  path: string;
  /** Dedicated port, or `undefined` for the host's. */
  port: number | undefined;
  /** Heartbeat interval in ms; `0` disables it. */
  heartbeatMs: number;
  /** Most subscriptions per connection. */
  maxSubscriptions: number;
  /** Most concurrent connections. */
  maxConnections: number;
  /** Largest client frame, in bytes. */
  maxMessageBytes: number;
  /** Client messages allowed per second. */
  messagesPerSecond: number;
  /** Buffered bytes that mark a session lagging. */
  maxBufferedBytes: number;
  /** How long a session may lag before it is closed. */
  slowConsumerTimeoutMs: number;
  /** Resume buffer bounds, or `false` for no resume. */
  replay: { size: number; maxAgeMs: number } | false;
  /** Origins allowed besides the same origin, or `"*"`. */
  allowedOrigins: readonly (string | RegExp)[] | "*";
  /** Progress coalescing interval in ms; `0` sends all. */
  coalesceProgressMs: number;
}

/** CSRF defence for cookie-authenticated deployments. */
export interface JobsApiCsrfOptions {
  /**
   * Refuse mutations whose `Content-Type` is not `application/json` with `415`.
   * Applies to every `POST` (the one mutating method a cross-site form or
   * beacon can send without a preflight) and to any other mutation that
   * carries a body. Defaults to `true`.
   */
  requireJson?: boolean;
  /** Require this header on mutations (any non-empty value), forcing a CORS preflight. Defaults to `false`. */
  header?: string | false;
  /**
   * Origins whose mutations are accepted besides the same origin. A mutation
   * with `Sec-Fetch-Site: cross-site`, or an `Origin` that is neither the same
   * origin nor listed, is refused with `403`. Defaults to none (same-origin only).
   */
  allowedOrigins?: (string | RegExp)[];
}

/** The CSRF options with defaults applied, or `false` when disabled. */
export type ResolvedJobsApiCsrfOptions =
  | {
      /** Whether mutations must be `application/json`. */
      requireJson: boolean;
      /** Required header name, lower case, or `false`. */
      header: string | false;
      /** Origins accepted besides the same origin. */
      allowedOrigins: readonly (string | RegExp)[];
    }
  | false;

/** Everything `createJobsApi` accepts. */
export interface JobsApiConfig {
  /**
   * The context to manage: queues come from `jobs.listQueues()` and
   * `jobs.queue(name)`, runners from `jobs.runners`, events from `jobs.notifier()`.
   * Either this or `queues`/`runners` is required.
   */
  jobs?: BunJobs;
  /**
   * Which queues are reachable. `"all"` (the default with `jobs`) is every queue
   * the backend knows in the namespace. A list restricts to those. `BunQueue`
   * instances may be given without `jobs`; names need `jobs`.
   */
  queues?: "all" | readonly (string | BunQueue<any, any, any>)[];
  /**
   * Which runners are reachable. Defaults to `jobs.runners`. `false` means none.
   * With a manager, every runner in the namespace can be read and controlled —
   * one registered in another process through the backend — except that only
   * the process running a runner can kill its runs or reset its stats. A fixed
   * list reaches only the runners listed.
   */
  runners?: BunRunnerManager | readonly BunRunner<any, any>[] | false;
  /** Which half to expose. Defaults to `"both"` when both sources exist, else the one present. */
  mode?: JobsApiMode;
  /**
   * Absolute path the router will be mounted at, e.g. `"/admin/jobs"`. Required:
   * it forms the WebSocket path, the spec `servers` and the docs page links.
   * Mount with `use(api.basePath, api.router)` so the two cannot disagree.
   * `"/"` is refused: the API's JSON 404 would answer for the whole host.
   */
  basePath: string;
  /** Registers no mutating route, and prunes them from the spec. Defaults to `false`. */
  readOnly?: boolean;
  /**
   * Per-request authorization for HTTP and WebSocket. **Required** unless
   * `allowUnauthenticated` is `true`; construction throws `ConfigError` otherwise.
   */
  authorize?: JobsApiAuthorize;
  /**
   * Explicitly allow every request with no `authorize`. For local development
   * only; a warning is logged every time the API is created. Ignored when
   * `authorize` is given. Defaults to `false`.
   */
  allowUnauthenticated?: boolean;
  /**
   * Allow-list of actions to expose. Anything absent is neither routed nor
   * documented. Defaults to every action except `JOBS_API_OPT_IN_ACTIONS`.
   */
  actions?: readonly JobsApiAction[];
  /**
   * Middleware run inside the API router before any route (after CORS): session
   * loading, JWT verification, a rate limiter. Also run on WebSocket upgrades.
   */
  middleware?: readonly RouterHandler[];
  /**
   * CORS via bun-common's `cors()`. Defaults to `false` (no CORS headers;
   * same-origin only).
   *
   * With `credentials: true` the origin must be an explicit list of origin
   * strings (or a function): a wildcard (`"*"`, `true`, absent), a `RegExp`
   * and `"null"` are refused, since each can reflect an attacker's origin
   * with credentials. A function origin is accepted, and owns the decision
   * entirely — it must allow only origins you trust.
   */
  cors?: CorsOptions | false;
  /**
   * Trust `X-Forwarded-Proto` and `X-Forwarded-Host` when deciding whether a
   * request's `Origin` is the same origin (the CSRF check on mutations and the
   * WebSocket upgrade check). Enable only behind a proxy that sets both and
   * strips any a client sent. Defaults to `false`: the request URL's scheme and
   * its `Host` are compared — so behind a TLS-terminating proxy that does not
   * preserve them, list the public origin in `csrf.allowedOrigins` instead.
   */
  trustProxy?: boolean;
  /**
   * CSRF defence for cookie-authenticated deployments. Defaults to
   * `{ requireJson: true, header: false }`. `false` disables it.
   */
  csrf?: JobsApiCsrfOptions | false;
  /** Docs endpoints. `false` removes the JSON endpoints too (the functions still work). */
  docs?: JobsApiDocsOptions | false;
  /** Live events. `false` disables the socket and the AsyncAPI document. */
  websocket?: JobsApiWebSocketOptions | false;
  /** Size and cost caps. */
  limits?: JobsApiLimits;
  /** Logger, or anything `resolveLogger` accepts. Defaults to the `jobs` context's logger. */
  logger?: LoggerLike;
  /** Redaction and shaping hooks. */
  serialize?: JobsApiSerializers;
  /** Allow `args` in `POST /runners/:runner/trigger`. Defaults to `false`. */
  runnerTriggerArgs?: boolean;
  /**
   * Names `POST /queues/:queue/jobs` may add. Defaults to the names in
   * `jobs.definitions()` (read at request time), or none without `jobs`.
   * `"any"` allows every name.
   */
  addableNames?: readonly string[] | "any";
  /** Validate every response body against its schema and log a mismatch. Defaults to `false`; on in tests. */
  validateResponses?: boolean;
}

/** One registered route, after pruning. */
export interface JobsApiRouteInfo {
  /** HTTP method, upper case. */
  method: string;
  /** Full path pattern, including `basePath`. */
  path: string;
  /** Its OpenAPI operation id, unique within the API. */
  operationId: string;
  /** The action it authorizes. */
  action: JobsApiAction;
  /** Whether it changes state. */
  mutation: boolean;
}

/**
 * An OpenAPI 3.1 document, as `generateOpenApi` builds it. Typed loosely on
 * purpose: only the version is pinned, and the document is checked against
 * the OpenAPI 3.1 meta-schema in the tests rather than modelled here.
 */
export interface OpenApiDocument {
  /** The OpenAPI version. */
  openapi: "3.1.0";
  /** Every other top-level field. */
  [key: string]: unknown;
}

/** An AsyncAPI 3.0 document, loose in the same way as {@link OpenApiDocument}. */
export interface AsyncApiDocument {
  /** The AsyncAPI version. */
  asyncapi: "3.0.0";
  /** Every other top-level field. */
  [key: string]: unknown;
}

/**
 * Session data stashed on each socket, as `ws.data.custom`: produced once the
 * upgrade guard has allowed the connection, never by the client.
 */
export interface JobsApiSocketData {
  /**
   * Marks a connection this API upgraded, as `ws.data.custom.bunJobsApi`.
   *
   * The socket's handler ignores anything without it, and another handler on
   * the same server — a NestJS gateway whose `"/*"` namespace also matches
   * this path — can use it to ignore ours.
   */
  bunJobsApi: true;
  /** Identifies the session; reported to the client in `hello`. */
  sessionId: string;
  /** The upgrade request, passed to every later `authorize` and `serialize.event`. */
  request: BunRequest;
}

/** The socket half. */
export interface JobsApiWebSocket {
  /** Full path, `basePath + websocket.path`. */
  readonly path: string;
  /** Open sessions. */
  readonly sessions: number;
  /**
   * The port of the dedicated server when `websocket.port` is set (the bound
   * one, when it was `0`), or `undefined` when the socket shares the host's.
   */
  readonly port: number | undefined;
  /** A `Bun.serve`-shaped handler, for hosts that route upgrades themselves. */
  readonly handler: BunWebSocketHandlerType<JobsApiSocketData>;
  /**
   * Registers the upgrade guard and the `ws()` route on a router that has a
   * `BunWebSocket` (a bun-common `BunHttpAdapter`, its `instance`, or
   * bun-nest's `getInstance()`). Throws `ConfigError` if none is attached,
   * when `websocket.port` serves the socket itself, or after `close()`.
   */
  attach: (target: BunRouter | { instance: BunRouter }) => void;
  /**
   * For raw `Bun.serve`: `null` when `req` is not an upgrade for this socket,
   * `undefined` once upgraded, or the refusal `Response` (400/401/403/404/429).
   * Pass {@link handler} as the server's `websocket`.
   */
  upgrade: (
    req: Request,
    server: Server<WebSocketClientData<JobsApiSocketData>>,
  ) => Promise<Response | undefined | null>;
}

/** A mounted-anywhere management API. */
export interface JobsApi {
  /** The HTTP API. Mount with `use(api.basePath, api.router)`. */
  readonly router: BunRouter;
  /** The normalised `basePath`, no trailing slash. */
  readonly basePath: string;
  /** The effective mode. */
  readonly mode: JobsApiMode;
  /** Every registered route, after pruning: method, full path, action, mutation. */
  readonly routes: readonly JobsApiRouteInfo[];
  /** The socket, or `undefined` when `websocket: false` or `events.subscribe` is not allowed. */
  readonly websocket: JobsApiWebSocket | undefined;
  /** The OpenAPI 3.1 document for exactly what is routed. Built once, returned as a fresh deep copy. */
  openapi: () => OpenApiDocument;
  /** The AsyncAPI 3.0 document, or `undefined` with no socket. */
  asyncapi: () => AsyncApiDocument | undefined;
  /**
   * Closes sessions (1001), the notifier the API opened, and a dedicated socket
   * server. Never closes the `BunJobs`, queues, runners or driver.
   */
  close: () => Promise<void>;
}

/** The serializer hooks with the three switches defaulted. */
export type ResolvedJobsApiSerializers = JobsApiSerializers &
  Readonly<
    Required<
      Pick<
        JobsApiSerializers,
        "exposeStacks" | "exposeRunnerFiles" | "exposeHosts"
      >
    >
  >;

/** A configuration after `resolveConfig`: validated, normalised and defaulted. */
export interface ResolvedJobsApiConfig {
  /** The context, when one was given. */
  jobs: BunJobs | undefined;
  /** The namespace every source belongs to. */
  namespace: string;
  /** The driver behind the sources, for capability probes. */
  driver: JobsDriver;
  /**
   * Reachable queues: `"all"` to ask the backend, or the configured names
   * mapped to a given instance (or `undefined` when only a name was given, to
   * be built with `jobs.queue(name)`). An empty map means no queue source.
   */
  queues: "all" | ReadonlyMap<string, BunQueue<any, any, any> | undefined>;
  /** Reachable runners, or `false` for none. */
  runners: BunRunnerManager | readonly BunRunner<any, any>[] | false;
  /** The effective mode. */
  mode: JobsApiMode;
  /** Absolute mount path, no trailing slash. */
  basePath: string;
  /** Whether mutations are removed. */
  readOnly: boolean;
  /** The authorization hook, or `undefined` when `allowUnauthenticated` stands in. */
  authorize: JobsApiAuthorize | undefined;
  /** Whether requests are allowed with no `authorize`. Only ever `true` when `authorize` is absent. */
  allowUnauthenticated: boolean;
  /** Actions allowed by `actions` (or its default), before `readOnly` is applied. */
  actions: ReadonlySet<JobsApiAction>;
  /** Actions actually enabled: {@link actions} minus mutations under `readOnly`. */
  enabledActions: ReadonlySet<JobsApiAction>;
  /** Middleware run before every route and on upgrades. */
  middleware: readonly RouterHandler[];
  /** CORS options, or `false`. */
  cors: CorsOptions | false;
  /** CSRF options, or `false`. */
  csrf: ResolvedJobsApiCsrfOptions;
  /**
   * Whether `X-Forwarded-Host` and `X-Forwarded-Proto` are trusted when the
   * same-origin and CSRF checks decide what origin a request was sent to.
   * Defaults to `false`: a header a client can set must not be able to make a
   * cross-site request look same-origin. Turn it on only behind a proxy that
   * overwrites both headers.
   */
  trustProxy: boolean;
  /** Docs options, or `false`. */
  docs: ResolvedJobsApiDocsOptions | false;
  /** Socket options, or `false`. */
  websocket: ResolvedJobsApiWebSocketOptions | false;
  /** Every limit, defaulted. */
  limits: ResolvedJobsApiLimits;
  /** The API's logger, bound to `component: "jobs-api"`. */
  logger: Logger;
  /** Serializer hooks and switches. */
  serialize: ResolvedJobsApiSerializers;
  /** Whether trigger `args` are accepted. */
  runnerTriggerArgs: boolean;
  /**
   * Names jobs may be added under: a list, `"any"`, or `"defined"` for the
   * names in `jobs.definitions()` at request time.
   */
  addableNames: readonly string[] | "any" | "defined";
  /** Whether response bodies are validated against their schemas. */
  validateResponses: boolean;
}

/** A path segment the API accepts in `basePath` and sub-paths: no route syntax, no dot segments. */
const PATH_SEGMENT = /^[\w.~-]+$/;

/** Validates and normalises an absolute path; returns it without a trailing slash. */
function normalizePath(
  value: unknown,
  what: string,
  allowRoot: boolean,
): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new ConfigError(
      `${what} must be an absolute path starting with "/"`,
      {
        value,
      },
    );
  }
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed === "") {
    if (allowRoot) {
      return "/";
    }
    throw new ConfigError(
      `${what} may not be "/": the API's JSON 404 would answer for every route of the host`,
      { value },
    );
  }
  for (const segment of trimmed.slice(1).split("/")) {
    // Route syntax (`:param`, `*`, `(`) would make the mount a pattern, and the
    // WebSocket path is matched exactly — the two would silently disagree.
    if (!PATH_SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new ConfigError(
        `${what} may only contain "/"-separated segments of letters, digits, "_", ".", "~" and "-"`,
        { value },
      );
    }
  }
  return trimmed;
}

/** Validates a numeric option as an integer within bounds. */
function integerOption(
  value: number | undefined,
  fallback: number,
  what: string,
  min: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < min) {
    throw new ConfigError(`${what} must be an integer of at least ${min}`, {
      value,
    });
  }
  return value;
}

/** Whether a queue entry is an instance rather than a name. */
function isQueueInstance(entry: unknown): entry is BunQueue<any, any, any> {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { name?: unknown }).name === "string" &&
    typeof (entry as { namespace?: unknown }).namespace === "string"
  );
}

/** Whether a runners option is a manager rather than a list. */
function isRunnerManager(value: unknown): value is BunRunnerManager {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { list?: unknown }).list === "function" &&
    typeof (value as { discover?: unknown }).discover === "function"
  );
}

/** Resolves the limits, refusing values that would make a cap meaningless. */
function resolveLimits(
  limits: JobsApiLimits | undefined,
): ResolvedJobsApiLimits {
  const d = DEFAULT_JOBS_API_LIMITS;
  const l = limits ?? {};
  const resolved = {
    maxPageSize: integerOption(
      l.maxPageSize,
      d.maxPageSize,
      "limits.maxPageSize",
      1,
    ),
    defaultPageSize: integerOption(
      l.defaultPageSize,
      Math.min(d.defaultPageSize, l.maxPageSize ?? d.maxPageSize),
      "limits.defaultPageSize",
      1,
    ),
    maxBulkIds: integerOption(
      l.maxBulkIds,
      d.maxBulkIds,
      "limits.maxBulkIds",
      1,
    ),
    maxRetryAll: integerOption(
      l.maxRetryAll,
      d.maxRetryAll,
      "limits.maxRetryAll",
      1,
    ),
    maxClean: integerOption(l.maxClean, d.maxClean, "limits.maxClean", 1),
    maxLogPage: integerOption(
      l.maxLogPage,
      d.maxLogPage,
      "limits.maxLogPage",
      1,
    ),
    maxHistory: integerOption(
      l.maxHistory,
      d.maxHistory,
      "limits.maxHistory",
      1,
    ),
    maxQueues: integerOption(l.maxQueues, d.maxQueues, "limits.maxQueues", 1),
    queueCacheMs: integerOption(
      l.queueCacheMs,
      d.queueCacheMs,
      "limits.queueCacheMs",
      0,
    ),
    maxJobDataBytes: integerOption(
      l.maxJobDataBytes,
      d.maxJobDataBytes,
      "limits.maxJobDataBytes",
      1,
    ),
  };
  if (resolved.defaultPageSize > resolved.maxPageSize) {
    throw new ConfigError(
      "limits.defaultPageSize may not exceed limits.maxPageSize",
      {
        defaultPageSize: resolved.defaultPageSize,
        maxPageSize: resolved.maxPageSize,
      },
    );
  }
  return Object.freeze(resolved);
}

/**
 * Refuses CORS that would let any site make credentialed requests.
 *
 * bun-common's `cors()` defaults `origin` to `"*"`, and `true` (or a `"*"`
 * inside a list) reflects whatever `Origin` arrives — which, with
 * `credentials: true`, hands every website on the internet an authenticated
 * session against the admin API.
 */
function resolveCors(
  cors: CorsOptions | false | undefined,
): CorsOptions | false {
  if (cors === undefined || cors === false) {
    return false;
  }
  if (typeof cors !== "object" || cors === null) {
    throw new ConfigError("cors must be an options object or false", { cors });
  }
  if (cors.credentials === true) {
    const origin = cors.origin;
    const entries = Array.isArray(origin) ? origin : [origin];
    const wildcard =
      origin === undefined || origin === true || entries.includes("*");
    if (wildcard) {
      throw new ConfigError(
        "cors with credentials: true needs an explicit origin allow-list, not a wildcard",
        { origin: origin === undefined ? "*" : String(origin) },
      );
    }
    // A pattern reflects whatever it happens to match — an unanchored one
    // matches a hostile subdomain — and `"null"` is the origin of every
    // sandboxed frame and `file:` page. With credentials, neither is safe.
    if (entries.some((entry) => entry instanceof RegExp)) {
      throw new ConfigError(
        "cors with credentials: true needs origin strings, not patterns: list each origin",
        { origin: String(origin) },
      );
    }
    if (entries.includes("null")) {
      throw new ConfigError(
        'cors with credentials: true may not allow the "null" origin',
        { origin: String(origin) },
      );
    }
  }
  return { ...cors };
}

/** A header name: an RFC 9110 token. */
const HEADER_NAME = /^[!#$%&'*+.^`|~\w-]+$/;

/** Resolves the CSRF options. */
function resolveCsrf(
  csrf: JobsApiCsrfOptions | false | undefined,
): ResolvedJobsApiCsrfOptions {
  if (csrf === false) {
    return false;
  }
  const options = csrf ?? {};
  const header = options.header ?? false;
  if (
    header !== false &&
    (typeof header !== "string" || !HEADER_NAME.test(header))
  ) {
    throw new ConfigError("csrf.header must be a valid header name or false", {
      header,
    });
  }
  return Object.freeze({
    requireJson: options.requireJson ?? true,
    header: header === false ? false : header.toLowerCase(),
    allowedOrigins: Object.freeze([...(options.allowedOrigins ?? [])]),
  });
}

/** Resolves the docs options. */
function resolveDocs(
  docs: JobsApiDocsOptions | false | undefined,
): ResolvedJobsApiDocsOptions | false {
  if (docs === false) {
    return false;
  }
  const options = docs ?? {};
  return {
    ...options,
    openapiPath: normalizePath(
      options.openapiPath ?? "/openapi.json",
      "docs.openapiPath",
      false,
    ),
    asyncapiPath: normalizePath(
      options.asyncapiPath ?? "/asyncapi.json",
      "docs.asyncapiPath",
      false,
    ),
    ui: options.ui ?? false,
    uiPath: normalizePath(options.uiPath ?? "/docs", "docs.uiPath", false),
    asyncapiUiPath: normalizePath(
      options.asyncapiUiPath ?? "/docs/asyncapi",
      "docs.asyncapiUiPath",
      false,
    ),
  };
}

/** Resolves the socket options. */
function resolveWebSocket(
  websocket: JobsApiWebSocketOptions | false | undefined,
): ResolvedJobsApiWebSocketOptions | false {
  if (websocket === false) {
    return false;
  }
  const o = websocket ?? {};
  if (
    o.port !== undefined &&
    (!Number.isInteger(o.port) || o.port < 0 || o.port > 65_535)
  ) {
    throw new ConfigError("websocket.port must be a port number", {
      port: o.port,
    });
  }
  const replay =
    o.replay === false
      ? false
      : {
          size: integerOption(o.replay?.size, 1000, "websocket.replay.size", 1),
          maxAgeMs: integerOption(
            o.replay?.maxAgeMs,
            300_000,
            "websocket.replay.maxAgeMs",
            1,
          ),
        };
  return {
    path: normalizePath(o.path ?? "/ws", "websocket.path", false),
    port: o.port,
    heartbeatMs: integerOption(
      o.heartbeatMs,
      25_000,
      "websocket.heartbeatMs",
      0,
    ),
    maxSubscriptions: integerOption(
      o.maxSubscriptions,
      50,
      "websocket.maxSubscriptions",
      1,
    ),
    maxConnections: integerOption(
      o.maxConnections,
      1000,
      "websocket.maxConnections",
      1,
    ),
    maxMessageBytes: integerOption(
      o.maxMessageBytes,
      16_384,
      "websocket.maxMessageBytes",
      1,
    ),
    messagesPerSecond: integerOption(
      o.messagesPerSecond,
      20,
      "websocket.messagesPerSecond",
      1,
    ),
    maxBufferedBytes: integerOption(
      o.maxBufferedBytes,
      1_048_576,
      "websocket.maxBufferedBytes",
      1,
    ),
    slowConsumerTimeoutMs: integerOption(
      o.slowConsumerTimeoutMs,
      30_000,
      "websocket.slowConsumerTimeoutMs",
      1,
    ),
    replay,
    allowedOrigins:
      o.allowedOrigins === "*"
        ? "*"
        : Object.freeze([...(o.allowedOrigins ?? [])]),
    coalesceProgressMs: integerOption(
      o.coalesceProgressMs,
      250,
      "websocket.coalesceProgressMs",
      0,
    ),
  };
}

/** Resolves `actions` into a set, refusing names that are not actions. */
function resolveActions(
  actions: readonly JobsApiAction[] | undefined,
): ReadonlySet<JobsApiAction> {
  if (actions === undefined) {
    return new Set(
      JOBS_API_ACTIONS.filter((action) => !JOBS_API_OPT_IN_ACTIONS.has(action)),
    );
  }
  if (!Array.isArray(actions)) {
    throw new ConfigError("actions must be an array of action names", {
      actions,
    });
  }
  const known = new Set<string>(JOBS_API_ACTIONS);
  const unknown = actions.filter((action) => !known.has(action));
  if (unknown.length > 0) {
    throw new ConfigError(`Unknown action(s): ${unknown.join(", ")}`, {
      unknown,
    });
  }
  return new Set(actions);
}

/**
 * Validates a configuration and applies every default.
 *
 * Throws {@link ConfigError} when:
 * - neither `jobs` nor `queues`/`runners` is given, or `queues` names a queue without `jobs`;
 * - `mode` asks for a half with no source, or sources span namespaces;
 * - `basePath` (or a docs/socket sub-path) is not a plain absolute path;
 * - there is no `authorize` and `allowUnauthenticated` is not `true`;
 * - `actions` names an unknown action;
 * - `cors` pairs `credentials: true` with a wildcard origin;
 * - a limit is not a usable integer.
 *
 * With `allowUnauthenticated` and no `authorize`, logs a warning.
 */
export function resolveConfig(config: JobsApiConfig): ResolvedJobsApiConfig {
  if (typeof config !== "object" || config === null) {
    throw new ConfigError("createJobsApi needs a configuration object");
  }

  const jobs = config.jobs;
  const queueOption = config.queues;
  const runnerOption = config.runners;

  if (
    !jobs &&
    queueOption === undefined &&
    (runnerOption === undefined || runnerOption === false)
  ) {
    throw new ConfigError(
      "createJobsApi needs `jobs`, or `queues`/`runners` to manage",
    );
  }

  // Queues.
  let queues: ResolvedJobsApiConfig["queues"];
  const instances: BunQueue<any, any, any>[] = [];
  if (queueOption === undefined || queueOption === "all") {
    if (!jobs && queueOption === "all") {
      throw new ConfigError('queues: "all" needs `jobs` to list queues from');
    }
    queues = jobs ? "all" : new Map();
  } else if (Array.isArray(queueOption)) {
    const map = new Map<string, BunQueue<any, any, any> | undefined>();
    for (const entry of queueOption as readonly unknown[]) {
      if (typeof entry === "string") {
        if (!jobs) {
          throw new ConfigError(
            `queues names "${entry}" without \`jobs\`: pass the BunQueue instance, or \`jobs\``,
            { queue: entry },
          );
        }
        assertSegment(entry, "queue name");
        if (!map.has(entry)) {
          map.set(entry, undefined);
        }
      } else if (isQueueInstance(entry)) {
        const existing = map.get(entry.name);
        if (existing && existing !== entry) {
          throw new ConfigError(
            `queues lists two different instances named "${entry.name}"`,
            {
              queue: entry.name,
            },
          );
        }
        map.set(entry.name, entry);
        instances.push(entry);
      } else {
        throw new ConfigError(
          "queues entries must be names or BunQueue instances",
          {
            entry: String(entry),
          },
        );
      }
    }
    queues = map;
  } else {
    throw new ConfigError(
      'queues must be "all" or a list of names and BunQueue instances',
    );
  }

  // Runners.
  let runners: ResolvedJobsApiConfig["runners"];
  if (runnerOption === undefined) {
    runners = jobs ? jobs.runners : false;
  } else if (runnerOption === false) {
    runners = false;
  } else if (isRunnerManager(runnerOption)) {
    runners = runnerOption;
  } else if (Array.isArray(runnerOption)) {
    const ids = new Set<string>();
    for (const runner of runnerOption as readonly BunRunner<any, any>[]) {
      if (ids.has(runner.id)) {
        throw new ConfigError(`runners lists "${runner.id}" twice`, {
          id: runner.id,
        });
      }
      ids.add(runner.id);
    }
    runners =
      runnerOption.length > 0 ? Object.freeze([...runnerOption]) : false;
  } else {
    throw new ConfigError(
      "runners must be a BunRunnerManager, a list of BunRunners, or false",
    );
  }

  // Namespace and driver: every source must agree, or one API would quietly
  // manage two services' queues under one name.
  const runnerList =
    runners === false
      ? []
      : isRunnerManager(runners)
        ? runners.list()
        : runners;
  const namespaces = new Set<string>();
  if (jobs) {
    namespaces.add(jobs.namespace);
  }
  for (const queue of instances) {
    namespaces.add(queue.namespace);
  }
  if (runners !== false && isRunnerManager(runners)) {
    namespaces.add(runners.namespace);
  }
  for (const runner of runnerList) {
    namespaces.add(runner.namespace);
  }
  if (namespaces.size > 1) {
    throw new ConfigError(
      "Every queue and runner must belong to one namespace",
      {
        namespaces: [...namespaces],
      },
    );
  }
  const namespace = [...namespaces][0];
  const driver =
    jobs?.driver ??
    instances[0]?.driver ??
    (runners !== false && isRunnerManager(runners)
      ? runners.driver
      : undefined) ??
    runnerList[0]?.driver;
  if (namespace === undefined || driver === undefined) {
    throw new ConfigError(
      "createJobsApi could not find a driver: give `jobs`, a BunQueue, or a runner with a driver",
    );
  }

  // Mode.
  const hasQueues = queues === "all" || queues.size > 0;
  const hasRunners = runners !== false;
  let mode: JobsApiMode;
  if (config.mode === undefined) {
    if (!hasQueues && !hasRunners) {
      throw new ConfigError(
        "createJobsApi has no queues and no runners to manage",
      );
    }
    mode = hasQueues && hasRunners ? "both" : hasQueues ? "jobs" : "runner";
  } else {
    if (
      config.mode !== "jobs" &&
      config.mode !== "runner" &&
      config.mode !== "both"
    ) {
      throw new ConfigError('mode must be "jobs", "runner" or "both"', {
        mode: config.mode,
      });
    }
    if (
      (config.mode !== "runner" && !hasQueues) ||
      (config.mode !== "jobs" && !hasRunners)
    ) {
      throw new ConfigError(
        `mode "${config.mode}" asks for a half with no source`,
        {
          mode: config.mode,
          queues: hasQueues,
          runners: hasRunners,
        },
      );
    }
    mode = config.mode;
  }

  const basePath = normalizePath(config.basePath, "basePath", false);

  // Authorization: fail closed at construction.
  if (
    config.authorize !== undefined &&
    typeof config.authorize !== "function"
  ) {
    throw new ConfigError("authorize must be a function");
  }
  const allowUnauthenticated =
    !config.authorize && config.allowUnauthenticated === true;
  if (!config.authorize && !allowUnauthenticated) {
    throw new ConfigError(
      "createJobsApi needs `authorize`, or `allowUnauthenticated: true` for local development",
    );
  }

  const readOnly = config.readOnly ?? false;
  const actions = resolveActions(config.actions);
  const enabledActions = new Set(
    [...actions].filter(
      (action) => !(readOnly && JOBS_API_MUTATIONS.has(action)),
    ),
  );

  const middleware = config.middleware ?? [];
  if (
    !Array.isArray(middleware) ||
    middleware.some((handler) => typeof handler !== "function")
  ) {
    throw new ConfigError("middleware must be an array of handler functions");
  }

  let addableNames: ResolvedJobsApiConfig["addableNames"];
  if (config.addableNames === undefined) {
    addableNames = jobs ? "defined" : Object.freeze([]);
  } else if (config.addableNames === "any") {
    addableNames = "any";
  } else if (
    Array.isArray(config.addableNames) &&
    config.addableNames.every((name) => typeof name === "string")
  ) {
    addableNames = Object.freeze([...config.addableNames]);
  } else {
    throw new ConfigError('addableNames must be a list of names or "any"');
  }

  const logger = resolveLogger(config.logger ?? jobs?.logger).child({
    component: "jobs-api",
    namespace,
  });

  if (allowUnauthenticated) {
    logger.warn(
      "jobs api allows unauthenticated requests: every route is open to anyone who can reach it",
      { basePath },
    );
  }

  const serialize = config.serialize ?? {};

  return {
    jobs,
    namespace,
    driver,
    queues,
    runners,
    mode,
    basePath,
    readOnly,
    authorize: config.authorize,
    allowUnauthenticated,
    actions,
    enabledActions,
    middleware: Object.freeze([...middleware]),
    cors: resolveCors(config.cors),
    csrf: resolveCsrf(config.csrf),
    trustProxy: config.trustProxy ?? false,
    docs: resolveDocs(config.docs),
    websocket: resolveWebSocket(config.websocket),
    limits: resolveLimits(config.limits),
    logger,
    serialize: {
      ...serialize,
      exposeStacks: serialize.exposeStacks ?? false,
      exposeRunnerFiles: serialize.exposeRunnerFiles ?? false,
      exposeHosts: serialize.exposeHosts ?? true,
    },
    runnerTriggerArgs: config.runnerTriggerArgs ?? false,
    addableNames,
    validateResponses: config.validateResponses ?? false,
  };
}

/** Whether an action is enabled by the static limits (`actions`, `readOnly`). */
export function isActionEnabled(
  config: Pick<ResolvedJobsApiConfig, "enabledActions">,
  action: JobsApiAction,
): boolean {
  return config.enabledActions.has(action);
}

/** Whether jobs may be added under `name`. */
export function isAddableName(
  config: Pick<ResolvedJobsApiConfig, "addableNames" | "jobs">,
  name: string,
): boolean {
  if (config.addableNames === "any") {
    return true;
  }
  if (config.addableNames === "defined") {
    return (
      config.jobs
        ?.definitions()
        .some((definition) => definition.name === name) ?? false
    );
  }
  return config.addableNames.includes(name);
}
