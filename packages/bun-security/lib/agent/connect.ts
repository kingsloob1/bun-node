/**
 * `connectAgent` (control-plane.md §7, topologies.md §4, PR-CP4): the
 * service side of the control plane. It keeps an engine (`createSecurity`)
 * on the service's signed bundle and the control plane's bans:
 *
 * - **Start**: the last known good is read and verified again with the
 *   deploy-time keys before the control plane is asked; a bad one is
 *   ignored with a critical alert, and the engine stays on the host's own
 *   policy. The highest version ever accepted is a floor across restarts.
 * - **Bundles**: pulled every 30 s with `If-None-Match`, and at once on a
 *   nudge; each verified (`verifyBundle`: signature, service, newer than
 *   the floor, `notBefore`) before its artefacts are fetched and checked
 *   and it is loaded. A refused one keeps the last good bundle in force,
 *   with one critical alert per distinct version or `ETag`; past
 *   `expiresAt` it warns and keeps enforcing.
 * - **Bans**: `GET /agent/bans?since=` every 5 s and on a nudge, the whole
 *   set every 60 s; each batch verified with the bundle keys and bound to
 *   its request, so a forged or replayed batch is refused.
 * - **Heartbeats** every 30 s, saying what it enforces and its health
 *   (`signature-failing` while every fetch fails its signature).
 * - **The nudge**: server-sent events, each signed; reconnected with
 *   backoff from 1 s to 60 s. Pull is the source of truth; a lost nudge
 *   costs at most one poll.
 * - **Events**: given a source (PR-CP1's ring), the batcher posts them.
 *
 * Every request is signed with the agent's key and bound to its route;
 * every answer's signature is checked before it is read.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Duration, Logger, LoggerLike } from "@kingsleyweb/bun-common";
import {
  ConfigError,
  createLogger,
  resolveLogger,
  toDurationMs,
} from "@kingsleyweb/bun-common";
import type { BanBatch } from "../bundle/bans";
import type { BundlePublicKey, SecurityBundle } from "../bundle/bundle";
import type { BanRecord } from "../store/types";
import type { AgentEventBatch, AgentEventSource } from "./events";
import type { EventBatcher } from "./batcher";
import type {
  AgentHeartbeat,
  AgentNudge,
  AgentNudgeEvent,
  AgentRoute,
} from "./protocol";
import type { AgentState } from "./state";
import { verifyBanBatch } from "../bundle/bans";
import { verifyBundle } from "../bundle/bundle";
import { createEventBatcher } from "./batcher";
import {
  AGENT_HEADER,
  AGENT_ID_PATTERN,
  AGENT_REQUEST_ID_HEADER,
  AGENT_ROUTES,
  AGENT_SIGNATURE_HEADER,
  AGENT_SIGNATURE_WINDOW_MS,
  agentEnvelope,
  agentRequestId,
  artefactSignedBody,
  notModifiedBody,
} from "./protocol";
import { EMPTY_STATE, readState, writeState } from "./state";

/** The engine calls the agent makes: `createSecurity()`'s, structurally. */
export interface AgentEngine {
  /** Loads a policy (the bundle's effective policy); throws for one it refuses. */
  readonly load: (policy: never) => unknown;
  /** Bans a subject; the ban, with its id. */
  readonly ban: (input: {
    readonly ip?: string;
    readonly user?: string;
    readonly apiKeyHash?: string;
    readonly action?: "ban" | "challenge";
    readonly duration?: Duration | null;
    readonly reason?: string;
    readonly by?: string;
    readonly code?: string;
  }) => { readonly id: string };
  /** Lifts a ban by id. */
  readonly unban: (id: string, options?: { readonly by?: string }) => unknown;
}

/** An alert the agent raises (a critical one means it refused something signed). */
export interface AgentAlert {
  /** What happened. */
  readonly kind:
    | "state.invalid"
    | "bundle.refused"
    | "bundle.replayed"
    | "bundle.expired"
    | "bundle.unloadable"
    | "bans.refused"
    | "bans.replayed"
    | "artefact.mismatch";
  /** `warning` or `critical`. */
  readonly severity: "warning" | "critical";
  /** For people. */
  readonly message: string;
  /** When, epoch ms. */
  readonly at: number;
  /** The facts. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/** An artefact the loaded bundle needs, on disk. */
export interface AgentArtefact {
  /** Its kind (`mmdb-country`). */
  readonly kind: string;
  /** Its SHA-256. */
  readonly sha256: string;
  /** Where it is. */
  readonly path: string;
}

/** Options of {@link connectAgent}. */
export interface ConnectAgentOptions {
  /** The control plane's API base, as mounted (`https://cp.internal/security/api`); the agent routes are under `/agent`. */
  readonly url: string;
  /** The agent's id, from `POST /agents`. */
  readonly agent: string;
  /** Its secret (shown once at creation or rotation); a list during a rotation, the new one first. From the environment. */
  readonly secret: string | readonly string[];
  /** The service it serves (its key's). */
  readonly service: string;
  /** The bundle public keys, by key id, from deployment (never from the control plane). */
  readonly publicKeys: Readonly<Record<string, BundlePublicKey>>;
  /** The engine it keeps current. */
  readonly security: AgentEngine;
  /** The last known good's file (`0600`). */
  readonly stateFile: string;
  /** Where artefacts are kept; required when a bundle references any. */
  readonly artefactDir?: string;
  /** Called with a bundle's artefacts on disk, before the bundle is loaded (to open an IP-intel database). */
  readonly onArtefacts?: (
    artefacts: readonly AgentArtefact[],
  ) => void | Promise<void>;
  /** How often the bundle is pulled. Default `"30s"`. */
  readonly pollInterval?: Duration;
  /** How often ban changes are pulled. Default `"5s"`. */
  readonly banPollInterval?: Duration;
  /** How often the whole ban set is pulled. Default `"60s"`. */
  readonly reconcileInterval?: Duration;
  /** How often it beats. Default `"30s"`. */
  readonly heartbeatInterval?: Duration;
  /** Whether to hold the nudge stream open. Default `true`. */
  readonly nudge?: boolean;
  /**
   * `false`: no timer and no nudge; nothing is fetched until the host calls
   * `sync()`, `reconcile()` or `heartbeat()` (a host driving it itself, or a
   * test). Default `true`.
   */
  readonly start?: boolean;
  /** Events to send (PR-CP1's ring and recorder); absent, none are sent. */
  readonly events?: AgentEventSource;
  /** The fetch to use. Default `fetch`. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Where it logs. */
  readonly logger?: LoggerLike;
  /** Called with each alert (and logged). */
  readonly onAlert?: (alert: AgentAlert) => void;
  /** The clock. Default `Date.now`. */
  readonly now?: () => number;
}

/** What the agent enforces and how it is doing. */
export interface AgentStatusReport {
  /** The bundle in force; `null` on the host's own policy. */
  readonly bundle: {
    readonly version: number;
    readonly keyId: string;
    readonly expired: boolean;
  } | null;
  /** The highest version ever accepted. */
  readonly floor: number;
  /** The control plane's bans held: the sequence reached, how many. */
  readonly bans: { readonly seq: string; readonly count: number };
  /** `ok`, or `signature-failing`. */
  readonly health: "ok" | "signature-failing";
  /** The last failure. */
  readonly lastError: string | null;
  /** Whether the nudge stream is open. */
  readonly nudged: boolean;
}

/** A running agent. */
export interface SecurityAgent {
  /** Resolves once the last known good is loaded (or found absent or bad), before the control plane is asked. */
  readonly ready: Promise<void>;
  /** What it enforces now. */
  readonly status: () => AgentStatusReport;
  /** Pulls the bundle and the ban changes now. */
  readonly sync: () => Promise<void>;
  /** Pulls the whole ban set now. */
  readonly reconcile: () => Promise<void>;
  /** Sends a heartbeat now. */
  readonly heartbeat: () => Promise<void>;
  /** The event batcher, when events are configured. */
  readonly events: EventBatcher | undefined;
  /** Stops every timer and the nudge. */
  readonly close: () => Promise<void>;
}

/** This protocol's version, sent in heartbeats. */
export const AGENT_PROTOCOL_VERSION = "bun-security-agent/1";

/** A received document's signature value, for telling refusals apart. */
function signatureText(value: unknown): string {
  const signature = (value as { signature?: { value?: unknown } } | null)
    ?.signature?.value;
  return typeof signature === "string" ? signature : "";
}

/** A refusal of a signed answer. */
class AnswerRefused extends Error {}

/** Connects an agent (see the module's description). Throws a `ConfigError` for a bad option. */
export function connectAgent(options: ConnectAgentOptions): SecurityAgent {
  if (typeof options !== "object" || options === null) {
    throw new ConfigError("connectAgent(): options must be an object");
  }
  if (!AGENT_ID_PATTERN.test(options.agent ?? "")) {
    throw new ConfigError("connectAgent(): agent must be an agent id");
  }
  const secrets =
    typeof options.secret === "string"
      ? [options.secret]
      : [...(options.secret ?? [])];
  if (
    secrets.length === 0 ||
    secrets.some((secret) => typeof secret !== "string" || secret === "")
  ) {
    throw new ConfigError(
      "connectAgent(): secret must be the agent's secret (or a list, the new one first)",
    );
  }
  if (typeof options.service !== "string" || options.service === "") {
    throw new ConfigError("connectAgent(): service is required");
  }
  if (Object.keys(options.publicKeys ?? {}).length === 0) {
    throw new ConfigError(
      "connectAgent(): publicKeys must name the bundle key(s), from deployment, never from the control plane",
    );
  }
  if (typeof options.stateFile !== "string" || options.stateFile === "") {
    throw new ConfigError(
      "connectAgent(): stateFile is required (the last known good)",
    );
  }
  let base: URL;
  try {
    base = new URL(options.url);
  } catch {
    throw new ConfigError(
      "connectAgent(): url must be the control plane's API base URL",
    );
  }
  const root = base.href.replace(/\/+$/, "");
  const now = options.now ?? Date.now;
  const fetchFn =
    options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const logger: Logger = resolveLogger(
    options.logger,
    createLogger({ name: "bun-security-agent" }),
  );
  const pollMs = toDurationMs(
    options.pollInterval ?? "30s",
    "connectAgent(): pollInterval",
  );
  const banPollMs = toDurationMs(
    options.banPollInterval ?? "5s",
    "connectAgent(): banPollInterval",
  );
  const reconcileMs = toDurationMs(
    options.reconcileInterval ?? "60s",
    "connectAgent(): reconcileInterval",
  );
  let heartbeatMs = toDurationMs(
    options.heartbeatInterval ?? "30s",
    "connectAgent(): heartbeatInterval",
  );

  let state: AgentState = EMPTY_STATE;
  let current: { bundle: SecurityBundle; expired: boolean } | null = null;
  let banSeq = 0n;
  /** The control plane's bans applied, by their store id. */
  const applied = new Map<string, { record: BanRecord; engineId: string }>();
  /** Whether the last bundle fetched, and the last ban batch, failed their signatures. */
  const failing = { bundle: false, bans: false };
  let lastError: string | null = null;
  let nudged = false;
  let closed = false;
  /** Whether the agent is still running (a function: the loops re-read it). */
  const isOpen = () => !closed;
  const alerted = new Set<string>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let nudgeAbort: AbortController | undefined;

  /** Raises `alert` (once per `key`, when given). */
  const alert = (input: Omit<AgentAlert, "at">, key?: string) => {
    if (key !== undefined) {
      if (alerted.has(key)) return;
      alerted.add(key);
    }
    const out: AgentAlert = { ...input, at: now() };
    if (out.severity === "critical")
      logger.error(`bun-security agent: ${out.message}`, {
        kind: out.kind,
        detail: out.detail,
      });
    else
      logger.warn(`bun-security agent: ${out.message}`, {
        kind: out.kind,
        detail: out.detail,
      });
    try {
      options.onAlert?.(out);
    } catch (error) {
      logger.error("bun-security agent: onAlert threw", { error });
    }
  };

  /** Marks the last bundle or ban batch fetched as refused (health `signature-failing`) or verified. */
  const signatures = (what: "bundle" | "bans", ok: boolean, error?: string) => {
    failing[what] = !ok;
    if (!ok) lastError = error ?? null;
    else if (!failing.bundle && !failing.bans) lastError = null;
  };
  /** The health a heartbeat reports. */
  const health = (): "ok" | "signature-failing" =>
    failing.bundle || failing.bans ? "signature-failing" : "ok";

  /** A signed request to the control plane; the answer, its signature checked. */
  const call = async (
    route: AgentRoute,
    method: "GET" | "POST",
    path: string,
    body?: { readonly bytes: Uint8Array; readonly gzip?: boolean },
    headers: Record<string, string> = {},
    idParts: string[] = [],
  ): Promise<{
    status: number;
    bytes: Uint8Array;
    headers: Headers;
    id: string | null;
  }> => {
    const id = body === undefined ? agentRequestId(route, ...idParts) : null;
    const signature = await agentEnvelope.signEnvelope(body?.bytes ?? null, {
      direction: "request",
      secret: secrets,
      now: now(),
      ...(id === null ? {} : { id }),
    });
    const response = await fetchFn(`${root}${path}`, {
      method,
      headers: {
        [AGENT_HEADER]: options.agent,
        [AGENT_SIGNATURE_HEADER]: signature,
        ...(id === null ? {} : { [AGENT_REQUEST_ID_HEADER]: id }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(body?.gzip === true ? { "content-encoding": "gzip" } : {}),
        ...headers,
      },
      // The signature covers the content; gzip is only how it travels.
      ...(body === undefined
        ? {}
        : { body: body.gzip === true ? gzipSync(body.bytes) : body.bytes }),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    // A bodyless answer (a 304) is signed over a text naming this request;
    // an artefact over a text naming its bytes' SHA-256.
    const signed =
      route === AGENT_ROUTES.artefact && response.status === 200
        ? artefactSignedBody(createHash("sha256").update(bytes).digest("hex"))
        : bytes.byteLength === 0
          ? notModifiedBody(id ?? "")
          : bytes;
    const verdict = await agentEnvelope.verifyEnvelope(
      signed,
      response.headers.get(AGENT_SIGNATURE_HEADER),
      {
        direction: "response",
        secret: secrets,
        now: now(),
        windowMs: AGENT_SIGNATURE_WINDOW_MS,
      },
    );
    if (!verdict.ok) {
      throw new AnswerRefused(
        `the control plane's answer to ${route} (${response.status}) is not signed with this agent's key: ${verdict.detail}`,
      );
    }
    return { status: response.status, bytes, headers: response.headers, id };
  };

  /** JSON from bytes. */
  const json = (bytes: Uint8Array): unknown =>
    JSON.parse(new TextDecoder().decode(bytes));

  /** Saves the state, logging a failure. */
  const save = async () => {
    try {
      await writeState(options.stateFile, state);
    } catch (error) {
      logger.error(
        "bun-security agent: the last known good could not be written",
        { error },
      );
    }
  };

  /** Fetches and checks the bundle's artefacts; their paths, or `undefined` when one is missing or wrong. */
  const artefacts = async (
    bundle: SecurityBundle,
  ): Promise<AgentArtefact[] | undefined> => {
    const out: AgentArtefact[] = [];
    if (bundle.artefacts.length === 0) return out;
    if (options.artefactDir === undefined) {
      alert(
        {
          kind: "artefact.mismatch",
          severity: "critical",
          message: `bundle ${bundle.version} references artefacts and no artefactDir is configured; it is not loaded`,
          detail: { version: bundle.version },
        },
        `artefact-dir:${bundle.version}`,
      );
      return undefined;
    }
    await mkdir(options.artefactDir, { recursive: true });
    for (const artefact of bundle.artefacts) {
      const path = join(options.artefactDir, artefact.sha256);
      const have = await stat(path).then(
        () => true,
        () => false,
      );
      if (!have) {
        const answer = await call(
          AGENT_ROUTES.artefact,
          "GET",
          `/agent/artefacts/${artefact.sha256}`,
          undefined,
          {},
          [artefact.sha256],
        );
        const sha256 = createHash("sha256").update(answer.bytes).digest("hex");
        if (answer.status !== 200 || sha256 !== artefact.sha256) {
          alert(
            {
              kind: "artefact.mismatch",
              severity: "critical",
              message: `artefact ${artefact.sha256} of bundle ${bundle.version} could not be fetched or does not match its hash; the bundle is not loaded`,
              detail: { sha256: artefact.sha256, status: answer.status },
            },
            `artefact:${artefact.sha256}:${answer.status}`,
          );
          return undefined;
        }
        const temporary = join(
          options.artefactDir,
          `.${artefact.sha256}.${randomUUID()}.tmp`,
        );
        try {
          await writeFile(temporary, answer.bytes, { mode: 0o600 });
          await chmod(temporary, 0o600);
          await rename(temporary, path);
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
      }
      out.push({ kind: artefact.kind, sha256: artefact.sha256, path });
    }
    return out;
  };

  /** Loads a verified bundle into the engine; whether it went in. */
  const load = async (
    bundle: SecurityBundle,
    expired: boolean,
  ): Promise<boolean> => {
    const files = await artefacts(bundle);
    if (files === undefined) return false;
    try {
      await options.onArtefacts?.(files);
      options.security.load(bundle.effective as never);
    } catch (error) {
      alert(
        {
          kind: "bundle.unloadable",
          severity: "critical",
          message: `bundle ${bundle.version} verified but the engine refused it; the last good one stays in force`,
          detail: {
            version: bundle.version,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        `unloadable:${bundle.version}`,
      );
      return false;
    }
    current = { bundle, expired };
    if (expired) {
      alert(
        {
          kind: "bundle.expired",
          severity: "warning",
          message: `bundle ${bundle.version} is past its expiry; it stays in force until a newer one arrives`,
          detail: { version: bundle.version, expiresAt: bundle.expiresAt },
        },
        `expired:${bundle.version}`,
      );
    }
    return true;
  };

  /** Bans `record`'s subject in the engine; the engine's ban id. */
  const banInto = (record: BanRecord): string => {
    const subject =
      record.subject.type === "user"
        ? { user: record.subject.value }
        : record.subject.type === "apiKey"
          ? // Already keyed by the control plane: never keyed twice.
            { apiKeyHash: record.subject.value }
          : { ip: record.subject.value };
    return options.security.ban({
      ...subject,
      action: record.action,
      duration:
        record.expiresAt === null
          ? null
          : `${Math.max(1, record.expiresAt - now())}ms`,
      reason: record.reason,
      by: record.createdBy ?? "control plane",
      ...(record.code === undefined ? {} : { code: record.code }),
    }).id;
  };

  /** Applies a ban record to the engine (or takes it away when it is no longer in force). */
  const applyBan = (record: BanRecord) => {
    const active =
      record.liftedAt === null &&
      (record.expiresAt === null || record.expiresAt > now());
    const had = applied.get(record.id);
    if (had !== undefined) {
      applied.delete(record.id);
      // Another scope's ban of the same subject keeps the engine's ban: re-applied below.
      options.security.unban(had.engineId, {
        by: record.liftedBy ?? "control plane",
      });
      for (const other of applied.values()) {
        if (other.engineId === had.engineId)
          applied.set(other.record.id, {
            record: other.record,
            engineId: banInto(other.record),
          });
      }
    }
    if (active) applied.set(record.id, { record, engineId: banInto(record) });
  };

  /** Applies a whole set: what is not in it is taken away. */
  const applyFull = (bans: readonly BanRecord[]) => {
    const keep = new Set(bans.map((ban) => ban.id));
    for (const [id, had] of [...applied]) {
      if (!keep.has(id))
        applyBan({ ...had.record, liftedAt: now(), liftedBy: "control plane" });
    }
    for (const ban of bans) {
      const had = applied.get(ban.id);
      if (had === undefined || had.record.revision !== ban.revision)
        applyBan(ban);
    }
  };

  /** Reads and verifies the last known good. */
  const start = async () => {
    const read = await readState(options.stateFile);
    if (read.kind === "unreadable") {
      alert({
        kind: "state.invalid",
        severity: "critical",
        message: `the last known good (${options.stateFile}) is unreadable; starting on the host's own policy`,
        detail: { error: read.error },
      });
      return;
    }
    if (read.kind === "missing") return;
    state = read.state;
    if (state.bundle !== null) {
      const verdict = verifyBundle(state.bundle, options.publicKeys, {
        service: options.service,
        now,
      });
      if (!verdict.ok || state.bundle.version > state.floor) {
        alert({
          kind: "state.invalid",
          severity: "critical",
          message: `the last known good bundle fails verification (${verdict.ok ? "above the floor" : verdict.reason}); it is ignored and the host's own policy stays in force`,
          detail: { reason: verdict.ok ? "floor" : verdict.reason },
        });
        state = { ...state, bundle: null, etag: null };
      } else if (!(await load(verdict.bundle, verdict.expired))) {
        state = { ...state, bundle: null, etag: null };
      }
    }
    if (state.bans !== null) {
      const batch = state.bans;
      // Its request binding was checked when it arrived; the signature and service are checked again.
      const verdict = verifyBanBatch(batch, options.publicKeys, {
        service: options.service,
        since: BigInt(/^\d{1,30}$/.test(batch.since) ? batch.since : "0"),
        request: batch.request,
      });
      if (verdict.ok && batch.full) {
        applyFull(batch.bans);
        banSeq = verdict.seq;
      } else {
        alert({
          kind: "state.invalid",
          severity: "critical",
          message:
            "the last known good ban set fails verification; it is ignored",
          detail: { reason: verdict.ok ? "not a full set" : verdict.reason },
        });
        state = { ...state, bans: null };
      }
    }
  };

  const ready = start().catch((error: unknown) => {
    logger.error(
      "bun-security agent: the last known good could not be loaded",
      { error },
    );
  });

  /** Pulls the bundle. */
  const pullBundle = async () => {
    const answer = await call(
      AGENT_ROUTES.bundle,
      "GET",
      "/agent/bundle",
      undefined,
      state.etag === null ? {} : { "if-none-match": state.etag },
    );
    if (answer.status === 304) {
      signatures("bundle", true);
      return;
    }
    if (answer.status !== 200) {
      lastError = `GET /agent/bundle answered ${answer.status}`;
      return;
    }
    const etag = answer.headers.get("etag");
    const value = json(answer.bytes) as SecurityBundle;
    if (
      current !== null &&
      value?.signature?.value === current.bundle.signature.value
    ) {
      signatures("bundle", true);
      return;
    }
    const verdict = verifyBundle(value, options.publicKeys, {
      service: options.service,
      after: state.floor,
      now,
    });
    if (!verdict.ok) {
      const key = `${verdict.reason}:${String((value as { version?: unknown })?.version)}:${etag ?? ""}`;
      signatures("bundle", false, `bundle refused: ${verdict.reason}`);
      alert(
        verdict.reason === "replayed"
          ? {
              kind: "bundle.replayed",
              severity: "critical",
              message: `a validly signed bundle older than the one in force was offered (version ${String((value as { version?: unknown })?.version)}, in force ${state.floor}): someone may be replaying; refused`,
              detail: {
                version: (value as { version?: unknown })?.version ?? null,
                floor: state.floor,
              },
            }
          : {
              kind: "bundle.refused",
              severity: "critical",
              message: `a bundle was refused (${verdict.reason}); the last good one stays in force`,
              detail: { reason: verdict.reason, etag },
            },
        key,
      );
      return;
    }
    if (!(await load(verdict.bundle, verdict.expired))) return;
    signatures("bundle", true);
    state = {
      ...state,
      bundle: verdict.bundle,
      etag,
      floor: Math.max(state.floor, verdict.bundle.version),
    };
    await save();
  };

  /** Pulls ban changes, or the whole set. */
  const pullBans = async (full: boolean) => {
    const since = banSeq;
    const answer = await call(
      AGENT_ROUTES.bans,
      "GET",
      `/agent/bans?since=${since}${full ? "&full=1" : ""}`,
    );
    if (answer.status !== 200) {
      lastError = `GET /agent/bans answered ${answer.status}`;
      return;
    }
    const value = json(answer.bytes) as BanBatch;
    const verdict = verifyBanBatch(value, options.publicKeys, {
      service: options.service,
      since,
      request: answer.id ?? "",
    });
    if (!verdict.ok) {
      signatures("bans", false, `ban batch refused: ${verdict.reason}`);
      alert(
        verdict.reason === "replayed"
          ? {
              kind: "bans.replayed",
              severity: "critical",
              message:
                "a ban batch made for another request was offered: someone may be replaying; refused",
              detail: { since: String(since) },
            }
          : {
              kind: "bans.refused",
              severity: "critical",
              message: `a ban batch was refused (${verdict.reason}); the bans held stay in force`,
              detail: { reason: verdict.reason },
            },
        `bans:${verdict.reason}:${signatureText(value)}`,
      );
      return;
    }
    signatures("bans", true);
    if (verdict.batch.full) {
      applyFull(verdict.batch.bans);
      state = { ...state, bans: verdict.batch };
      await save();
    } else {
      for (const record of verdict.batch.bans) applyBan(record);
    }
    banSeq = verdict.seq;
  };

  /** Sends a heartbeat. */
  const heartbeat = async () => {
    const beat: AgentHeartbeat = {
      route: "heartbeat",
      sentAt: now(),
      agentVersion: AGENT_PROTOCOL_VERSION,
      bundle:
        current === null
          ? null
          : {
              version: current.bundle.version,
              keyId: current.bundle.signature.keyId,
              expired: current.expired,
            },
      bans: { seq: String(banSeq), count: applied.size },
      health: health(),
      ...(lastError === null ? {} : { lastError: lastError.slice(0, 500) }),
    };
    const answer = await call(
      AGENT_ROUTES.heartbeat,
      "POST",
      "/agent/heartbeat",
      { bytes: new TextEncoder().encode(JSON.stringify(beat)) },
    );
    if (answer.status === 200) {
      const interval = (json(answer.bytes) as { intervalMs?: unknown })
        .intervalMs;
      if (Number.isSafeInteger(interval) && (interval as number) >= 1_000)
        heartbeatMs = interval as number;
    }
  };

  /** Work in flight (a pull, a save, a heartbeat): `close()` waits for it. */
  const inflight = new Set<Promise<unknown>>();
  /** Tracks `work` until it settles. */
  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    void work.then(
      () => inflight.delete(work),
      () => inflight.delete(work),
    );
    return work;
  };

  /** Runs `task`, logging a failure. */
  const guard = async (what: string, task: () => Promise<void>) => {
    try {
      await track(task());
    } catch (error) {
      lastError = `${what}: ${error instanceof Error ? error.message : String(error)}`;
      if (error instanceof AnswerRefused) {
        signatures(what.includes("ban") ? "bans" : "bundle", false, lastError);
      }
      logger.warn(`bun-security agent: ${what} failed`, { error });
    }
  };

  /** Repeats `task` every `ms()` until closed. */
  const every = (ms: () => number, task: () => Promise<void>) => {
    const tick = async () => {
      if (closed) return;
      await task();
      if (closed) return;
      const timer = setTimeout(() => void tick(), ms());
      (timer as { unref?: () => void }).unref?.();
      timers.push(timer);
      if (timers.length > 16) timers.splice(0, timers.length - 16);
    };
    return tick;
  };

  const sync = async () => {
    await guard("pulling the bundle", pullBundle);
    await guard("pulling bans", () => pullBans(banSeq === 0n));
  };

  /** A nudge's event: its signature checked, then a pull. */
  const onNudge = async (data: string) => {
    let event: AgentNudgeEvent;
    try {
      event = JSON.parse(data) as AgentNudgeEvent;
    } catch {
      return;
    }
    const verdict = await agentEnvelope.verifyEnvelope(
      event.body,
      event.signature,
      {
        direction: "response",
        secret: secrets,
        now: now(),
        windowMs: AGENT_SIGNATURE_WINDOW_MS,
      },
    );
    if (!verdict.ok) {
      logger.warn(
        "bun-security agent: a nudge with a bad signature was ignored",
        { detail: verdict.detail },
      );
      return;
    }
    const nudge = JSON.parse(event.body) as AgentNudge;
    if (nudge.reason === "bundle")
      await guard("pulling the bundle", pullBundle);
    else await guard("pulling bans", () => pullBans(false));
  };

  /** Holds the nudge stream open, reconnecting with backoff 1 s → 60 s. */
  const nudgeLoop = async () => {
    let backoff = 1_000;
    while (isOpen()) {
      nudgeAbort = new AbortController();
      try {
        const id = agentRequestId(AGENT_ROUTES.nudge);
        const signature = await agentEnvelope.signEnvelope(null, {
          direction: "request",
          secret: secrets,
          now: now(),
          id,
        });
        const response = await fetchFn(`${root}/agent/nudge`, {
          method: "GET",
          headers: {
            [AGENT_HEADER]: options.agent,
            [AGENT_SIGNATURE_HEADER]: signature,
            [AGENT_REQUEST_ID_HEADER]: id,
            accept: "text/event-stream",
          },
          signal: nudgeAbort.signal,
        });
        if (response.status !== 200 || response.body === null)
          throw new Error(`the nudge answered ${response.status}`);
        nudged = true;
        backoff = 1_000;
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          for (
            let end = buffer.indexOf("\n\n");
            end >= 0;
            end = buffer.indexOf("\n\n")
          ) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data === "") continue;
            await onNudge(data);
          }
        }
      } catch (error) {
        if (closed) return;
        logger.debug("bun-security agent: the nudge stream closed", { error });
      }
      nudged = false;
      if (closed) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, backoff);
        (timer as { unref?: () => void }).unref?.();
      });
      backoff = Math.min(backoff * 2, 60_000);
    }
  };

  const batcher =
    options.events === undefined
      ? undefined
      : createEventBatcher({
          service: options.service,
          source: options.events,
          now,
          send: async (batch: AgentEventBatch) => {
            try {
              const answer = await call(
                AGENT_ROUTES.events,
                "POST",
                "/agent/events",
                {
                  bytes: new TextEncoder().encode(JSON.stringify(batch)),
                  gzip: true,
                },
              );
              const retry = Number(answer.headers.get("retry-after"));
              return {
                status: answer.status,
                ...(Number.isFinite(retry) && retry > 0
                  ? { retryAfterSeconds: retry }
                  : {}),
              };
            } catch {
              return { status: 0 };
            }
          },
        });

  // The control plane is asked only once the last known good is in.
  void ready.then(() => {
    if (closed || options.start === false) return;
    void every(
      () => pollMs,
      () => guard("pulling the bundle", pullBundle),
    )();
    void every(
      () => banPollMs,
      () => guard("pulling bans", () => pullBans(banSeq === 0n)),
    )();
    const reconcile = every(
      () => reconcileMs,
      () => guard("reconciling bans", () => pullBans(true)),
    );
    const first = setTimeout(() => void reconcile(), reconcileMs);
    (first as { unref?: () => void }).unref?.();
    timers.push(first);
    void every(
      () => heartbeatMs,
      () => guard("a heartbeat", heartbeat),
    )();
    if (options.nudge !== false) void nudgeLoop();
  });

  return Object.freeze({
    ready,
    status: (): AgentStatusReport => ({
      bundle:
        current === null
          ? null
          : {
              version: current.bundle.version,
              keyId: current.bundle.signature.keyId,
              expired: current.expired,
            },
      floor: state.floor,
      bans: { seq: String(banSeq), count: applied.size },
      health: health(),
      lastError,
      nudged,
    }),
    sync: async () => {
      await track(
        (async () => {
          await ready;
          await sync();
        })(),
      );
    },
    reconcile: async () => {
      await track(
        (async () => {
          await ready;
          await guard("reconciling bans", () => pullBans(true));
        })(),
      );
    },
    heartbeat: async () => {
      await track(
        (async () => {
          await ready;
          await guard("a heartbeat", heartbeat);
        })(),
      );
    },
    events: batcher,
    close: async () => {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      nudgeAbort?.abort();
      batcher?.close();
      // What was started finishes (and is saved) before close() resolves: the last known good
      // then holds what the agent enforced (found by T1's restart case).
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  });
}
