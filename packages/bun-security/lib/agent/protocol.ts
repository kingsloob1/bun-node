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
