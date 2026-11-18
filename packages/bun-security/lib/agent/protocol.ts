/**
 * The agent protocol (control-plane.md §7, PR-CP4): what the agent and the
 * control plane's `/agent/*` routes share. Every request is signed with the
 * agent's key on P4's envelope (direction `request`), every answer with
 * the same key (direction `response`), within ±60 s, each signature once.
 *
 * A request is bound to its route (the user's decision): a bodyless
 * request's signed id starts with the route's tag (`bundle.<random>`), and
 * a body carries `route`; the control plane refuses either on another
 * route, so a captured request cannot be sent somewhere else.
 */
import { randomUUID } from "node:crypto";
import { ConfigError } from "@kingsleyweb/bun-common";
import { envelopeCodec } from "@kingsleyweb/bun-common/envelope";

/** The header naming the agent. */
export const AGENT_HEADER = "x-bun-security-agent";

/** The header carrying a request's or an answer's envelope signature. */
export const AGENT_SIGNATURE_HEADER = "x-bun-security-signature";

/** The header carrying a bodyless request's signed id (and its answer's). */
export const AGENT_REQUEST_ID_HEADER = "x-bun-security-id";

/** How far a signature's time may be from the verifier's clock, either way (control-plane.md §7.2). */
export const AGENT_SIGNATURE_WINDOW_MS = 60_000;

/** The routes' tags, bound into each request. */
export const AGENT_ROUTES = /* @__PURE__ */ Object.freeze({
  bundle: "bundle",
  bans: "bans",
  artefact: "artefact",
  heartbeat: "heartbeat",
  nudge: "nudge",
  events: "events",
  banReports: "banReports",
} as const);

/** A route's tag. */
export type AgentRoute = (typeof AGENT_ROUTES)[keyof typeof AGENT_ROUTES];

/** An agent id: 1 to 64 of letters, digits, `_` and `-`. */
export const AGENT_ID_PATTERN = /^[\w-]{1,64}$/;

/** The envelope with this protocol's header names and bun-common's `ConfigError`. */
export const agentEnvelope = /* @__PURE__ */ envelopeCodec({
  headers: { signature: AGENT_SIGNATURE_HEADER, id: AGENT_REQUEST_ID_HEADER },
  configError: (message, details) => new ConfigError(message, details),
});

/** A bodyless request's id for `route`: its tag, then `parts` (each id-safe), then a random part. */
export function agentRequestId(route: AgentRoute, ...parts: string[]): string {
  return [route, ...parts, randomUUID().replaceAll("-", "")].join(".");
}

/** The route tag a request id names. */
export function agentRouteOf(id: string): string {
  return id.slice(0, Math.max(0, id.indexOf(".")));
}

/**
 * What a bodyless answer's signature covers (a `304`, which carries no
 * body): this text, naming the request it answers, so it binds to it.
 */
export function notModifiedBody(requestId: string): string {
  return JSON.stringify({ notModified: requestId });
}

/**
 * What an artefact's answer's signature covers: this text, naming the
 * SHA-256 of the bytes sent (any bytes, an id-like text included, can be
 * an artefact; the agent checks the hash it is told against what it got).
 */
export function artefactSignedBody(sha256: string): string {
  return JSON.stringify({ artefact: sha256 });
}

/** An agent's health, as it reports it. */
export type AgentReportedHealth = "ok" | "signature-failing";

/** The most warnings a heartbeat carries (PR-CP6). */
export const MAX_HEARTBEAT_WARNINGS = 16;

/**
 * A warning in force on the enforcement point, from its engine's
 * `status().warnings` (PR-CP6): its kind (`store.unavailable`,
 * `trust.internal`, `feed.refresh-failed`, `state.evictions`,
 * `login.failure-rate`, `store.distinct-fallback`, …), since when, and its
 * share where it has one. Never its message: that is for the host's log.
 */
export interface AgentWarning {
  /** The warning's kind. */
  readonly kind: string;
  /** Since when, epoch ms. */
  readonly since: number;
  /** The last minute's share, 0 to 1, where the kind has one. */
  readonly share?: number;
}

/** The most IP feeds a heartbeat reports (PR-AN). */
export const MAX_HEARTBEAT_FEEDS = 32;

/** One IP feed's state in a heartbeat (PR-AN). */
export interface AgentFeedStatus {
  /** The feed's id. */
  readonly id: string;
  /** Its size: the entries it holds. */
  readonly size: number;
  /** When it last refreshed, epoch ms; `null` never. */
  readonly refreshedAt: number | null;
  /** When a refresh was last tried, epoch ms; `null` never. */
  readonly attemptedAt: number | null;
  /** The last failure, at most 200 characters. */
  readonly error?: string;
}

/** What an agent's heartbeat says (`POST /agent/heartbeat`). */
export interface AgentHeartbeat {
  /** The route: `heartbeat`. */
  readonly route: "heartbeat";
  /** When it was sent, epoch ms. */
  readonly sentAt: number;
  /** The agent's package version. */
  readonly agentVersion: string;
  /** The bundle it enforces: version, signing key, past its expiry; `null` on the host's own policy. */
  readonly bundle: {
    readonly version: number;
    readonly keyId: string;
    readonly expired: boolean;
  } | null;
  /** The bans it holds from the control plane: the sequence reached, how many. */
  readonly bans: { readonly seq: string; readonly count: number };
  /** `ok`, or `signature-failing` while every bundle or ban batch fetched fails its signature. */
  readonly health: AgentReportedHealth;
  /** The last failure, when not `ok`, for operators. */
  readonly lastError?: string;
  /** The engine's warnings in force, at most {@link MAX_HEARTBEAT_WARNINGS} (PR-CP6); absent from an older agent. */
  readonly warnings?: readonly AgentWarning[];
  /** The engine's IP feeds, at most {@link MAX_HEARTBEAT_FEEDS} (PR-AN); absent without an intel that reports them. */
  readonly intel?: { readonly feeds: readonly AgentFeedStatus[] };
  /** Ban reports dropped since the last heartbeat (past the agent's rate cap, or unsendable); absent from an older agent. */
  readonly bansDropped?: number;
}

/** The most bans one report batch holds (`POST /agent/ban-reports`). */
export const MAX_BAN_REPORTS = 500;

/**
 * How an agent reports its engine's bans (the user's defaults, 2026-11-18):
 * a batch every `intervalMs`, at most {@link MAX_BAN_REPORTS} each; one
 * report per subject per `dedupeMs` unless the ban escalates (a later end,
 * permanent, or a higher ladder step); at most `perMinute` reports a
 * minute, the rest dropped and counted (`bansDropped`); at most `queue`
 * waiting while the control plane is unreachable.
 */
export const BAN_REPORT_LIMITS = /* @__PURE__ */ Object.freeze({
  intervalMs: 5_000,
  dedupeMs: 60_000,
  perMinute: 600,
  queue: 1_000,
});

/** One ban an agent's engine wrote itself, as reported (`POST /agent/ban-reports`). */
export interface AgentBanReport {
  /** What it refuses: an address, a range, or a user's or an API key's key. */
  readonly subject: {
    readonly type: "ip" | "cidr" | "user" | "apiKey";
    readonly value: string;
  };
  /** `ban` or `challenge`. */
  readonly action: "ban" | "challenge";
  /** Why (the engine's reason). */
  readonly reason: string;
  /** The rule that wrote it (`counted:<id>`, `ladder`, `canary:<id>`). */
  readonly rule?: string;
  /** When the engine started it, epoch ms. */
  readonly createdAt: number;
  /** When it ends, epoch ms; `null` until lifted. */
  readonly expiresAt: number | null;
  /** The ladder's step, for a ladder ban (1 for the lowest). */
  readonly step?: number;
  /** The problem code it answers with. */
  readonly code?: string;
}

/** A batch of ban reports: the bans an agent's engine wrote since the last one. */
export interface AgentBanReportBatch {
  /** The route: `banReports`. */
  readonly route: "banReports";
  /** When it was sent, epoch ms. */
  readonly sentAt: number;
  /** The bans, at most {@link MAX_BAN_REPORTS}. */
  readonly bans: readonly AgentBanReport[];
}

/** What the control plane answers a batch. */
export interface AgentBanReportAnswer {
  /** The reports stored (new or merged). */
  readonly stored: number;
  /** The reports of a ban an operator lifted since it started: not re-created. */
  readonly lifted: number;
}

/** What the control plane answers a heartbeat. */
export interface AgentHeartbeatAnswer {
  /** The control plane's clock, epoch ms (for the agent to see its skew). */
  readonly at: number;
  /** How often to beat, ms. */
  readonly intervalMs: number;
}

/** A nudge's signed body: the control plane saw a change worth a pull now. */
export interface AgentNudge {
  /** The route: `nudge`. */
  readonly route: "nudge";
  /** What changed: the service's bundle, or a ban in its scopes. */
  readonly reason: "bundle" | "bans";
  /** When, epoch ms. */
  readonly at: number;
}

/** A nudge as an event carries it: the body's text and its envelope signature. */
export interface AgentNudgeEvent {
  /** The {@link AgentNudge}'s JSON text, as signed. */
  readonly body: string;
  /** Its envelope signature (direction `response`). */
  readonly signature: string;
}
