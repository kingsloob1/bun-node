/**
 * `createSecurityApi`'s options and their checks (control-plane.md §4, §5):
 * a store, the host's `authenticate`, `authorize` or deploy-time `owners`,
 * the step-up hook or approvals, the bundle signer, CSRF.
 */
import type { AgentEventsOptions } from "./agentEvents";
import type { BunRequest, Duration, LoggerLike } from "@kingsleyweb/bun-common";
import { ConfigError, toDurationMs } from "@kingsleyweb/bun-common";
import type { SecurityStoreDriver } from "../store/types";
import type { SecurityApiPermission } from "./contract/constants";
import type { PolicyScopeId, SecurityAlertDto } from "./contract/types";
import type { BundleSigner, ResolvedSigner } from "./signing";
import type { BreakGlassOptions } from "./audit/breakglass";
import type { AuditSigner, AuditSigning } from "./audit/keys";
import type { CheckpointSink } from "./audit/sinks";
import type { KeyObject } from "node:crypto";
import { createPublicKey } from "node:crypto";
import { DEFAULT_SECURITY_CSRF_HEADER } from "./contract/constants";
import { resolveSigner } from "./signing";
import { BreakGlass } from "./audit/breakglass";
import { resolveAuditSigner } from "./audit/keys";

/** Who is calling, as the host's `authenticate` says. */
export interface Operator {
  /** Their stable id (the identity provider's subject). */
  readonly id: string;
  /** Their display name. */
  readonly name?: string;
  /** The host's session id, recorded in audit entries (never a secret: an id, not the cookie). */
  readonly sessionId?: string;
}

/** What a permission is checked on: a scope. */
export interface PermissionTarget {
  /** The scope (`global`, `group:<id>`, `service:<id>`). */
  readonly scope: PolicyScopeId;
}

/** The host's step-up (control-plane.md §5.3): a fresh second factor. */
export interface StepUpHook {
  /** Whether `operator` proved their second factor within the last few minutes on this request's session. */
  readonly verify: (
    req: BunRequest,
    operator: Operator,
  ) => boolean | Promise<boolean>;
  /** Where to send the operator to prove it (a URL), for the `401` the API answers. */
  readonly challenge: (req: BunRequest) => string;
}

/** Options for {@link createSecurityApi}. */
export interface SecurityApiOptions {
  /** The security store the API keeps its documents, versions and bundles in. */
  readonly store: SecurityStoreDriver;
  /** Who is calling: the host's SSO, login or trusted identity header; `null` for nobody. Required. */
  readonly authenticate: (
    req: BunRequest,
  ) => Operator | null | Promise<Operator | null>;
  /**
   * The host's own permission model: whether `operator` may use
   * `permission` on `target`. With it, the built-in roles are not used.
   */
  readonly authorize?: (
    operator: Operator,
    permission: SecurityApiPermission,
    target: PermissionTarget,
  ) => boolean | Promise<boolean>;
  /**
   * The built-in RBAC's first owners, by operator id: bound `owner` on
   * `global` from configuration, never from the store, so the first role
   * binding has someone to make it. Required without `authorize`.
   */
  readonly owners?: readonly string[];
  /** The host's step-up; without it, `approvals: "two-person"` or `allowWithoutStepUp`. */
  readonly stepUp?: StepUpHook;
  /** Run without a step-up hook or approvals: destructive changes need nothing more. Default `false`. */
  readonly allowWithoutStepUp?: boolean;
  /** `two-person`: a dangerous change waits for a second operator. Default `off` (Q17). */
  readonly approvals?: "off" | "two-person";
  /** How long an approval waits before it expires. Default `"24h"`. */
  readonly approvalTtl?: Duration;
  /** The bundle signer: an Ed25519 key, or a KMS hook. Required. */
  readonly signing: BundleSigner;
  /** How long a bundle is valid before an EP warns. Default `"7d"`. */
  readonly bundleTtl?: Duration;
  /** The audit log (control-plane.md §6). Required. */
  readonly audit: {
    /** The audit key, distinct from the bundle key: `{ keyId, privateKey }` or `{ keyId, sign, publicKey }`. */
    readonly signing: AuditSigning;
    /** Where every checkpoint is also written; at least one unless `allowNoExternalCheckpoints`. */
    readonly sinks?: readonly CheckpointSink[];
    /** Run with no external sink (development, tests); `verify` then says none is configured. Default `false`. */
    readonly allowNoExternalCheckpoints?: boolean;
    /** A checkpoint every this many entries. Default 1,000. */
    readonly checkpointEvery?: number;
    /** A checkpoint when the last is older than this. Default `"1h"`. */
    readonly checkpointInterval?: Duration;
    /** Retired audit keys' public halves (PEM), by key id, still accepted on their checkpoints. */
    readonly previousKeys?: Readonly<Record<string, string | KeyObject>>;
  };
  /** The break-glass account (Q11), opt-in: a password hash and a TOTP secret from the environment. */
  readonly breakGlass?: BreakGlassOptions;
  /** Called with each alert (break-glass login, a broken chain, an emergency, a failing sink); PR-CP6 routes them to channels. */
  readonly onAlert?: (alert: SecurityAlertDto) => void;
  /** Where the API is mounted. Default `/security/api`. */
  readonly basePath?: string;
  /**
   * The CSRF check on mutations: the header they must carry, and origins
   * trusted besides the API's own; `false` turns it off (an API used only
   * by non-browser clients). Default on, header `x-bun-security-csrf`.
   */
  readonly csrf?:
    | {
        /** The header a mutation must carry (any value). Default {@link DEFAULT_SECURITY_CSRF_HEADER}. */
        readonly header?: string;
        /** Origins trusted to send cross-site mutations. Default none. */
        readonly origins?: readonly string[];
      }
    | false;
  /** Title and version of the OpenAPI and AsyncAPI documents. */
  readonly docs?: {
    /** The documents' title. Default `bun-security management API`. */
    readonly title?: string;
    /** The documents' version. Default the protocol version. */
    readonly version?: string;
  };
  /**
   * `POST /agent/events`, where agents post their event batches (PR-CP1):
   * how an agent is authenticated (PR-CP4's signed requests), and its rate
   * limit. Absent: no such route. Needs a store with analytics.
   */
  readonly agentEvents?: AgentEventsOptions;
  /** Where errors are logged. Default a console logger named `bun-security`. */
  readonly logger?: LoggerLike;
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/** The options, checked and defaulted. */
export interface ResolvedSecurityApiOptions {
  /** As given. */
  readonly store: SecurityStoreDriver;
  /** As given. */
  readonly authenticate: SecurityApiOptions["authenticate"];
  /** As given. */
  readonly authorize: SecurityApiOptions["authorize"];
  /** The owners, as a set. */
  readonly owners: ReadonlySet<string>;
  /** As given. */
  readonly stepUp: StepUpHook | undefined;
  /** How step-up-guarded actions are guarded. */
  readonly guard: "hook" | "approvals" | "none";
  /** The approvals mode. */
  readonly approvals: "off" | "two-person";
  /** In milliseconds. */
  readonly approvalTtlMs: number;
  /** The signer. */
  readonly signer: ResolvedSigner;
  /** In milliseconds. */
  readonly bundleTtlMs: number;
  /** The audit log's settings, resolved. */
  readonly audit: {
    /** The audit key. */
    readonly signer: AuditSigner;
    /** The sinks. */
    readonly sinks: readonly CheckpointSink[];
    /** A checkpoint every this many entries. */
    readonly checkpointEvery: number;
    /** A checkpoint when the last is older than this, ms. */
    readonly checkpointIntervalMs: number;
    /** Retired keys, by id. */
    readonly previousKeys: ReadonlyMap<string, KeyObject>;
  };
  /** The break-glass account, when configured. */
  readonly breakGlass: BreakGlass | undefined;
  /** Raises an alert (logged as well). */
  readonly onAlert: (alert: SecurityAlertDto) => void;
  /** Normalised: a leading slash, no trailing one. */
  readonly basePath: string;
  /** The CSRF settings, or `false`. */
  readonly csrf:
    { readonly header: string; readonly origins: readonly string[] } | false;
  /** The documents' title and version. */
  readonly docs: { readonly title: string; readonly version: string };
  /** The clock. */
  readonly now: () => number;
}

/** A header name. */
const HEADER = /^[\w!#$%&'*+.^`|~-]+$/;

/** Checks `options`; throws a `ConfigError` naming the first problem. */
export function resolveOptions(
  options: SecurityApiOptions,
): ResolvedSecurityApiOptions {
  if (typeof options !== "object" || options === null) {
    throw new ConfigError("createSecurityApi(): options are required");
  }
  if (
    typeof options.store !== "object" ||
    options.store === null ||
    typeof options.store.get !== "function"
  ) {
    throw new ConfigError(
      "createSecurityApi(): store is required: a security store (memoryStore(), sqliteStore())",
    );
  }
  if (options.store.capabilities.readOnly) {
    throw new ConfigError(
      `createSecurityApi(): the store "${options.store.name}" is read-only; the management API writes`,
    );
  }
  if (typeof options.authenticate !== "function") {
    throw new ConfigError(
      "createSecurityApi(): authenticate is required: bun-security does not own identities (control-plane.md §5.1)",
    );
  }
  if (
    options.authorize !== undefined &&
    typeof options.authorize !== "function"
  ) {
    throw new ConfigError("createSecurityApi(): authorize must be a function");
  }
  const owners = options.owners ?? [];
  if (
    !Array.isArray(owners) ||
    owners.some((owner) => typeof owner !== "string" || owner === "")
  ) {
    throw new ConfigError(
      "createSecurityApi(): owners must be a list of operator ids",
    );
  }
  if (options.authorize === undefined && owners.length === 0) {
    throw new ConfigError(
      "createSecurityApi(): with the built-in roles, owners must name at least one operator id (the first owner is configured, never the first caller); or pass authorize",
    );
  }
  if (options.stepUp !== undefined) {
    if (
      typeof options.stepUp.verify !== "function" ||
      typeof options.stepUp.challenge !== "function"
    ) {
      throw new ConfigError(
        "createSecurityApi(): stepUp needs verify(req, operator) and challenge(req)",
      );
    }
  }
  const approvals = options.approvals ?? "off";
  if (approvals !== "off" && approvals !== "two-person") {
    throw new ConfigError(
      'createSecurityApi(): approvals must be "off" or "two-person"',
      { approvals },
    );
  }
  const guard =
    options.stepUp !== undefined
      ? "hook"
      : approvals === "two-person"
        ? "approvals"
        : "none";
  if (guard === "none" && options.allowWithoutStepUp !== true) {
    throw new ConfigError(
      'createSecurityApi(): destructive changes need a step-up hook (stepUp), or approvals: "two-person"; allowWithoutStepUp: true runs without either',
    );
  }
  const basePath = `/${(options.basePath ?? "/security/api").replaceAll(/^\/+|\/+$/g, "")}`;
  if (basePath === "/") {
    throw new ConfigError("createSecurityApi(): basePath must not be the root");
  }
  let csrf: ResolvedSecurityApiOptions["csrf"] = false;
  if (options.csrf !== false) {
    const header = (
      options.csrf?.header ?? DEFAULT_SECURITY_CSRF_HEADER
    ).toLowerCase();
    if (!HEADER.test(header)) {
      throw new ConfigError(
        "createSecurityApi(): csrf.header is not a header name",
        { header },
      );
    }
    csrf = { header, origins: [...(options.csrf?.origins ?? [])] };
  }
  const signer = resolveSigner(options.signing);
  const now = options.now ?? Date.now;
  return {
    store: options.store,
    authenticate: options.authenticate,
    authorize: options.authorize,
    owners: new Set(owners),
    stepUp: options.stepUp,
    guard,
    approvals,
    approvalTtlMs: toDurationMs(
      options.approvalTtl ?? "24h",
      "createSecurityApi(): approvalTtl",
    ),
    signer,
    bundleTtlMs: toDurationMs(
      options.bundleTtl ?? "7d",
      "createSecurityApi(): bundleTtl",
    ),
    basePath,
    csrf,
    docs: {
      title: options.docs?.title ?? "bun-security management API",
      version: options.docs?.version ?? "1",
    },
    now,
    audit: resolveAudit(options.audit, signer),
    breakGlass:
      options.breakGlass === undefined
        ? undefined
        : new BreakGlass(options.breakGlass, options.store, now),
    onAlert: options.onAlert ?? (() => {}),
  };
}

/** Checks the audit options. */
function resolveAudit(
  audit: SecurityApiOptions["audit"] | undefined,
  bundle: ResolvedSigner,
): ResolvedSecurityApiOptions["audit"] {
  if (typeof audit !== "object" || audit === null) {
    throw new ConfigError(
      "createSecurityApi(): audit is required: { signing, sinks } (control-plane.md §6); the control plane never runs unaudited",
    );
  }
  const signer = resolveAuditSigner(audit.signing, bundle);
  const sinks = [...(audit.sinks ?? [])];
  for (const sink of sinks) {
    if (typeof sink?.write !== "function" || typeof sink.name !== "string") {
      throw new ConfigError(
        "createSecurityApi(): audit.sinks holds something that is not a checkpoint sink",
      );
    }
  }
  if (sinks.length === 0 && audit.allowNoExternalCheckpoints !== true) {
    throw new ConfigError(
      "createSecurityApi(): audit.sinks needs at least one external checkpoint sink (fileCheckpointSink, webhookCheckpointSink, callbackCheckpointSink); allowNoExternalCheckpoints: true runs without",
    );
  }
  const every = audit.checkpointEvery ?? 1_000;
  if (!Number.isSafeInteger(every) || every < 1) {
    throw new ConfigError(
      "createSecurityApi(): audit.checkpointEvery must be a positive whole number",
    );
  }
  const previousKeys = new Map<string, KeyObject>();
  for (const [keyId, key] of Object.entries(audit.previousKeys ?? {})) {
    previousKeys.set(
      keyId,
      typeof key === "string" ? createPublicKey(key) : key,
    );
  }
  return {
    signer,
    sinks,
    checkpointEvery: every,
    checkpointIntervalMs: toDurationMs(
      audit.checkpointInterval ?? "1h",
      "createSecurityApi(): audit.checkpointInterval",
    ),
    previousKeys,
  };
}
