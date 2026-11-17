/**
 * The agent routes (control-plane.md §4 and §7, PR-CP4), on the API's
 * router under `/agent`, with agent authentication, never an operator's:
 *
 * - the agent is named by `x-bun-security-agent`; an unknown one is a 401
 *   and a log line, never an audit entry;
 * - a revoked key, a signature out of the ±60 s window and the per-agent
 *   rate limit (600 a minute) are refused before the body is read; the
 *   body is read up to `maxBodyBytes`; then the envelope (P4) is verified
 *   with the agent's secret (and a rotated-out one while accepted), each
 *   signature once (the nonce claimed in the store), and the route the
 *   request is bound to checked;
 * - a known agent's refusal is an audit event, at most one a minute per
 *   agent (the rest are logged), so no one can grow the chain by sending
 *   garbage under an agent's id;
 * - every answer to a known agent is signed with its key (`response`).
 *
 * `GET /agent/bundle` (`ETag`), `GET /agent/bans?since=&full=` (a ban
 * batch signed with the bundle key), `GET /agent/artefacts/:sha256`,
 * `POST /agent/heartbeat` and `GET /agent/nudge` (server-sent events) are
 * here; `POST /agent/events` is PR-CP1's, on {@link agentRequest}.
 */
import type {
  BunRequest,
  BunResponse,
  BunRouter,
  Logger,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import type { StoredDoc } from "../store/types";
import type { BanBatch } from "../bundle/bans";
import type { AgentHeartbeat, AgentNudge, AgentRoute } from "../agent/protocol";
import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";
import { banBatchSigningBytes, BAN_BATCH_FORMAT } from "../bundle/bans";
import { EventBatchError, ingestEventBatch } from "../analytics/batch";
import type { AgentEventBatch } from "../analytics/batch";
import { liveHooksOf } from "./liveHooks";
import { MAX_PAGE_LIMIT } from "../store/types";
import {
  AGENT_HEADER,
  AGENT_REQUEST_ID_HEADER,
  AGENT_ROUTES,
  AGENT_SIGNATURE_HEADER,
  AGENT_SIGNATURE_WINDOW_MS,
  agentEnvelope,
  agentRouteOf,
  artefactSignedBody,
  MAX_HEARTBEAT_FEEDS,
  MAX_HEARTBEAT_WARNINGS,
  notModifiedBody,
} from "../agent/protocol";
import type { AgentKeyBody, AgentRegistry } from "./agents";
import type { ResolvedAgentsOptions } from "./options";
import type { ControlPlane } from "./plane";
import { auditContext } from "./audit/context";
import { SHA256_PATTERN, sha256Of } from "./artefacts";
import { ApiProblem } from "./problems";
import { serviceScope } from "./scopes";

/** A verified agent request, as a route handler gets it. */
export interface AgentRequest {
  /** The agent's key record. */
  readonly doc: StoredDoc;
  /** Its body. */
  readonly key: AgentKeyBody;
  /** Its id. */
  readonly agent: string;
  /** Its service. */
  readonly service: string;
  /** The secret that verified the request: the answer is signed with it. */
  readonly secret: string;
  /** The request's signed id (bodyless requests), for the answer and a ban batch. */
  readonly requestId: string | null;
  /** The body read (empty for a bodyless request). */
  readonly body: Uint8Array;
}

/** What {@link agentRequest} answers: the request, or that it was refused (and answered). */
export type AgentRequestOutcome =
  | { readonly ok: true; readonly request: AgentRequest }
  | { readonly ok: false };

/** The context the agent routes share. */
export interface AgentRouteContext {
  /** The control plane. */
  readonly plane: ControlPlane;
  /** The agents. */
  readonly registry: AgentRegistry;
  /** The agents' options. */
  readonly options: ResolvedAgentsOptions;
  /** Where refusals are logged. */
  readonly logger: Logger;
}

/** What {@link checkAgentHeaders} established, for the body's check. */
export interface HeaderState {
  /** The agent's key record. */
  readonly doc: StoredDoc;
  /** Its body. */
  readonly key: AgentKeyBody;
  /** Its id. */
  readonly agent: string;
  /** The signature header. */
  readonly signature: string;
  /** The secrets it may be signed with. */
  readonly secrets: readonly string[];
  /** Refuses a known agent (audited at most once a minute), answering for it. */
  readonly refuseKnown: (
    problem: ApiProblem,
    extra?: Readonly<Record<string, string>>,
  ) => Promise<{ readonly ok: false }>;
}

/** The headers' check, handed from a `use` guard to the route's handler. */
const HEADER_CHECKED = new WeakMap<Request, HeaderState>();

/**
 * Authenticates an agent's request for `route` in full: the headers
 * ({@link checkAgentHeaders}: the agent, its key not revoked, the time, the
 * rate) and then the body ({@link verifyAgentBody}: the signature over it,
 * the route). Answers a refusal itself; `ok: false` means it did.
 */
export async function agentRequest(
  req: BunRequest,
  res: BunResponse,
  route: AgentRoute,
  context: AgentRouteContext,
): Promise<AgentRequestOutcome> {
  return await verifyAgentBody(req, res, route, context);
}

/**
 * A `use` guard for an agent route (PR-CP1's `POST /agent/events`): the
 * header checks, before the router reads a deferred body; the route's
 * handler then calls {@link verifyAgentBody}.
 */
export function agentGuard(
  route: AgentRoute,
  context: AgentRouteContext,
): RouterHandler {
  return async (req, res, next) => {
    try {
      const checked = await checkAgentHeaders(req, res, route, context);
      if (checked.ok) next();
    } catch (error) {
      next(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

/** The body of `request`, at most `max` bytes; `undefined` past it. */
async function readCapped(
  request: Request,
  max: number,
): Promise<Uint8Array | undefined> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > max) return undefined;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = (await reader.read()) as { done: boolean; value: Uint8Array };
    if (chunk.done) break;
    const value = chunk.value;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** The `t` (Unix seconds) of a signature header, or `undefined`. */
function signatureTime(header: string): number | undefined {
  const match = /(?:^|,)t=(\d{1,12})(?:,|$)/.exec(header);
  return match === null ? undefined : Number(match[1]);
}

/** Signs `body` (or, bodyless, the request's id) for `secret` and sends it. */
export async function sendSigned(
  res: BunResponse,
  status: number,
  body: string | Uint8Array | null,
  secret: string,
  requestId: string | null,
  now: number,
  headers: Readonly<Record<string, string>> = {},
  signedAs?: string,
): Promise<void> {
  // A bodyless answer (a 304) is signed over a text naming its request;
  // an artefact over a text naming its bytes' SHA-256.
  const signed = signedAs ?? body ?? notModifiedBody(requestId ?? "");
  const signature = await agentEnvelope.signEnvelope(signed, {
    direction: "response",
    secret,
    now,
  });
  res.status(status).set(AGENT_SIGNATURE_HEADER, signature);
  for (const [name, value] of Object.entries(headers)) res.set(name, value);
  if (body === null) res.send("");
  else if (typeof body === "string") {
    if (!res.hasHeader("content-type"))
      res.set("content-type", "application/json");
    res.send(body);
  } else res.send(body);
}

/** Answers `problem`, signed when the agent is known. */
async function refuse(
  res: BunResponse,
  problem: ApiProblem,
  secret: string | undefined,
  now: number,
  headers: Readonly<Record<string, string>> = {},
): Promise<void> {
  const body = JSON.stringify(problem.toBody());
  if (secret === undefined) {
    res.status(problem.status).set("content-type", "application/problem+json");
    for (const [name, value] of Object.entries(headers)) res.set(name, value);
    res.send(body);
    return;
  }
  await sendSigned(res, problem.status, body, secret, null, now, {
    "content-type": "application/problem+json",
    ...headers,
  });
}

/**
 * The first half of {@link agentRequest}, what the headers alone decide:
 * a known agent, its key not revoked, the signature's time within ±60 s,
 * the per-agent rate. Nothing reads the body. Answers a refusal itself.
 */
export async function checkAgentHeaders(
  req: BunRequest,
  res: BunResponse,
  route: AgentRoute,
  context: AgentRouteContext,
): Promise<
  { readonly ok: true; readonly state: HeaderState } | { readonly ok: false }
> {
  const { plane, registry, options, logger } = context;
  const headers = req.request.headers;
  const agent = headers.get(AGENT_HEADER) ?? "";
  const signature = headers.get(AGENT_SIGNATURE_HEADER);
  const doc = await registry.key(agent);
  if (doc === undefined || signature === null) {
    // Not a known agent: the log only, never the chain.
    logger.info("bun-security agent: refused a request from no known agent", {
      route,
      address: req.ip ?? null,
    });
    await refuse(
      res,
      new ApiProblem(
        401,
        "unauthenticated",
        "sign the request with a known agent's key",
      ),
      undefined,
      plane.now(),
    );
    return { ok: false };
  }
  const key = doc.doc as AgentKeyBody;
  const secrets = registry.secretsOf(key);
  /** Refuses a known agent: an audit event at most once a minute per agent, signed. */
  const refuseKnown = async (
    problem: ApiProblem,
    extra: Readonly<Record<string, string>> = {},
  ) => {
    const fresh = await plane.store
      .claimKey(`agentRefusedAudit:${agent}`, 60_000)
      .catch(() => false);
    if (fresh) {
      await auditContext
        .run(
          {
            actor: { id: agent, kind: "agent" },
            address: req.ip ?? null,
            sessionId: null,
            requestId: headers.get(AGENT_REQUEST_ID_HEADER) ?? "agent",
            permissions: [],
            stepUp: false,
            incomplete: false,
          },
          async () =>
            await plane.audit.event(
              "agent.refused",
              serviceScope(key.service),
              {
                outcome: "refused",
                reason: problem.code,
                detail: problem.message,
                route,
                target: { kind: "agentKey", id: agent },
              },
            ),
        )
        .catch((error: unknown) =>
          logger.error("bun-security agent: a refusal could not be audited", {
            error,
          }),
        );
    } else {
      logger.warn("bun-security agent: refused a known agent's request", {
        agent,
        route,
        reason: problem.code,
      });
    }
    await refuse(res, problem, secrets[0], plane.now(), extra);
    return { ok: false } as const;
  };
  if (key.revokedAt !== null) {
    return await refuseKnown(
      new ApiProblem(401, "unauthenticated", "this agent's key is revoked"),
    );
  }
  const t = signatureTime(signature);
  if (
    t === undefined ||
    Math.abs(plane.now() - t * 1000) > AGENT_SIGNATURE_WINDOW_MS
  ) {
    return await refuseKnown(
      new ApiProblem(
        401,
        "unauthenticated",
        "the signature is outside the ±60 s window (check the clocks)",
      ),
    );
  }
  const minute = Math.floor(plane.now() / 60_000);
  const used = await plane.store.incrementCounter(
    `agentRate:${agent}:${minute}`,
    120_000,
  );
  if (used.count > options.rateLimit) {
    const retry = String(
      Math.max(1, Math.ceil(((minute + 1) * 60_000 - plane.now()) / 1000)),
    );
    logger.warn("bun-security agent: an agent is over its rate limit", {
      agent,
      route,
    });
    await refuse(
      res,
      new ApiProblem(
        429,
        "rate_limited",
        `at most ${options.rateLimit} requests a minute per agent`,
      ),
      secrets[0],
      plane.now(),
      { "retry-after": retry },
    );
    return { ok: false };
  }
  const state: HeaderState = {
    doc,
    key,
    agent,
    signature,
    secrets,
    refuseKnown,
  };
  HEADER_CHECKED.set(req.request, state);
  return { ok: true, state };
}

/**
 * The second half of {@link agentRequest}: the body (read capped, or the
 * bytes the router kept), the envelope's signature over it, the route it
 * is bound to. Runs {@link checkAgentHeaders} first when a guard did not.
 */
export async function verifyAgentBody(
  req: BunRequest,
  res: BunResponse,
  route: AgentRoute,
  context: AgentRouteContext,
): Promise<AgentRequestOutcome> {
  const { plane, registry, options, logger } = context;
  const headers = req.request.headers;
  let state = HEADER_CHECKED.get(req.request);
  if (state === undefined) {
    const checked = await checkAgentHeaders(req, res, route, context);
    if (!checked.ok) return { ok: false };
    state = checked.state;
  }
  const { doc, key, agent, signature, secrets, refuseKnown } = state;
  const isBodyless = req.method === "GET" || req.method === "HEAD";
  let body: Uint8Array = new Uint8Array(0);
  if (!isBodyless) {
    // The signature covers the body's content (decoded, when sent gzip).
    // bun-common's router has read the body before any route runs (under
    // its own limits; measured even with the adapter's `deferBody`) and kept
    // its bytes (`req.buffer`, decoded); a body still unread is read here,
    // capped.
    const tooLarge = () =>
      refuseKnown(
        new ApiProblem(
          413,
          "too_large",
          `a body is at most ${options.maxBodyBytes} bytes`,
        ),
      );
    if (!req.request.bodyUsed) {
      const read = await readCapped(req.request, options.maxBodyBytes);
      if (read === undefined) return await tooLarge();
      body = read;
      if ((headers.get("content-encoding") ?? "").toLowerCase() === "gzip") {
        try {
          body = gunzipSync(body, {
            maxOutputLength: options.maxBodyBytes * 8,
          });
        } catch {
          return await tooLarge();
        }
      }
    } else {
      const kept = req.buffer;
      if (kept === undefined) {
        return await refuseKnown(
          new ApiProblem(
            400,
            "invalid_request",
            "the request's bytes were not kept (bun-common's retainBuffer is off), so its signature cannot be checked",
          ),
        );
      }
      body = new Uint8Array(kept.buffer, kept.byteOffset, kept.byteLength);
      // Decoded already when it came gzip: then the cap is the decoded one.
      const gzip =
        (headers.get("content-encoding") ?? "").toLowerCase() === "gzip";
      if (body.byteLength > options.maxBodyBytes * (gzip ? 8 : 1))
        return await tooLarge();
    }
  }
  const requestId = isBodyless ? headers.get(AGENT_REQUEST_ID_HEADER) : null;
  const verdict = await agentEnvelope.verifyEnvelope(
    isBodyless ? null : body,
    signature,
    {
      direction: "request",
      secret: secrets,
      now: plane.now(),
      windowMs: AGENT_SIGNATURE_WINDOW_MS,
      id: requestId,
      nonces: {
        remember: async (nonce, expiresAt, now) =>
          await plane.store.claimKey(
            `agentNonce:${nonce}`,
            Math.max(1, Math.ceil(expiresAt - now)),
          ),
      },
    },
  );
  if (!verdict.ok) {
    return await refuseKnown(
      new ApiProblem(401, "unauthenticated", verdict.detail),
    );
  }
  // The route bound into the request: a bodyless id's tag; a body's `route` (checked by its handler).
  if (isBodyless && (requestId === null || agentRouteOf(requestId) !== route)) {
    return await refuseKnown(
      new ApiProblem(
        401,
        "unauthenticated",
        `the request was signed for another route than ${route}`,
      ),
    );
  }
  const secret = secrets[verdict.keyIndex]!;
  await auditContext.run(
    {
      actor: { id: agent, kind: "agent" },
      address: req.ip ?? null,
      sessionId: null,
      requestId: requestId ?? "agent",
      permissions: [],
      stepUp: false,
      incomplete: false,
    },
    async () =>
      await registry
        .verified(doc, verdict.keyIndex)
        .catch((error: unknown) =>
          logger.error(
            "bun-security agent: could not record an agent's contact",
            { error },
          ),
        ),
  );
  return {
    ok: true,
    request: {
      doc,
      key,
      agent,
      service: key.service,
      secret,
      requestId,
      body,
    },
  };
}

/** A JSON body bound to `route`, or `undefined`. */
function boundJson(
  body: Uint8Array,
  route: AgentRoute,
): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return typeof value === "object" &&
      value !== null &&
      (value as { route?: unknown }).route === route
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `value` is a heartbeat's shape. */
export function isHeartbeat(
  value: Record<string, unknown>,
): value is AgentHeartbeat & Record<string, unknown> {
  const bundle = value.bundle as Record<string, unknown> | null | undefined;
  const bans = value.bans as Record<string, unknown> | undefined;
  return (
    Number.isSafeInteger(value.sentAt) &&
    typeof value.agentVersion === "string" &&
    value.agentVersion.length <= 50 &&
    (bundle === null ||
      (typeof bundle === "object" &&
        bundle !== undefined &&
        Number.isSafeInteger(bundle.version) &&
        typeof bundle.keyId === "string" &&
        typeof bundle.expired === "boolean")) &&
    typeof bans === "object" &&
    bans !== null &&
    typeof bans.seq === "string" &&
    /^\d{1,30}$/.test(bans.seq) &&
    Number.isSafeInteger(bans.count) &&
    (value.health === "ok" || value.health === "signature-failing") &&
    (value.lastError === undefined ||
      (typeof value.lastError === "string" && value.lastError.length <= 500)) &&
    (value.warnings === undefined || isWarnings(value.warnings)) &&
    (value.intel === undefined || isIntel(value.intel))
  );
}

/** Whether `value` is a heartbeat's intel status (bounded, PR-AN). */
function isIntel(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { feeds, ...rest } = value as Record<string, unknown>;
  const time = (t: unknown) =>
    t === null || (Number.isSafeInteger(t) && (t as number) >= 0);
  return (
    Object.keys(rest).length === 0 &&
    Array.isArray(feeds) &&
    feeds.length <= MAX_HEARTBEAT_FEEDS &&
    feeds.every((item: unknown) => {
      if (typeof item !== "object" || item === null) return false;
      const f = item as Record<string, unknown>;
      return (
        Object.keys(f).every((key) =>
          ["id", "size", "refreshedAt", "attemptedAt", "error"].includes(key),
        ) &&
        typeof f.id === "string" &&
        f.id.length > 0 &&
        f.id.length <= 64 &&
        Number.isSafeInteger(f.size) &&
        (f.size as number) >= 0 &&
        time(f.refreshedAt) &&
        time(f.attemptedAt) &&
        (f.error === undefined ||
          (typeof f.error === "string" && f.error.length <= 200))
      );
    })
  );
}

/** A warning's kind: a dotted name. */
const WARNING_KIND = /^[a-z][a-z0-9.-]{0,59}$/;

/** Whether `value` is a heartbeat's warnings (bounded, PR-CP6). */
function isWarnings(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_HEARTBEAT_WARNINGS &&
    value.every((item: unknown) => {
      if (typeof item !== "object" || item === null) return false;
      const w = item as Record<string, unknown>;
      return (
        Object.keys(w).every(
          (key) => key === "kind" || key === "since" || key === "share",
        ) &&
        typeof w.kind === "string" &&
        WARNING_KIND.test(w.kind) &&
        Number.isSafeInteger(w.since) &&
        (w.since as number) >= 0 &&
        (w.share === undefined ||
          (typeof w.share === "number" && w.share >= 0 && w.share <= 1))
      );
    })
  );
}

/**
 * The ban batch for a service: the whole active set (`full`, or from 0),
 * or what changed after `since` in its scopes; signed with the bundle key
 * and bound to the request.
 */
export async function banBatchFor(
  plane: ControlPlane,
  service: string,
  since: bigint,
  full: boolean,
  request: string,
): Promise<BanBatch> {
  const scopes = await plane.scopesAbove(service);
  const store = plane.store;
  const bans: BanBatch["bans"][number][] = [];
  let seq: bigint;
  const whole = full || since === 0n;
  if (whole) {
    // The head first: a change after it is in this set and in the next delta too (idempotent).
    seq = (await store.changesSince(0n, 1)).head;
    let cursor: string | undefined;
    do {
      const page = await store.listBans({
        limit: MAX_PAGE_LIMIT,
        scopes,
        active: true,
        ...(cursor === undefined ? {} : { cursor }),
      });
      bans.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
  } else {
    const { changes } = await store.changesSince(since, 1_000);
    const ids = [
      ...new Set(
        changes
          .filter((change) => change.kind === "ban")
          .map((change) => change.id),
      ),
    ];
    for (const id of ids) {
      const ban = await store.getBan(id);
      if (ban !== undefined && scopes.includes(ban.scope)) bans.push(ban);
    }
    seq = changes.at(-1)?.seq ?? since;
  }
  const unsigned: Omit<BanBatch, "signature"> = {
    format: BAN_BATCH_FORMAT,
    service,
    request,
    since: String(since),
    seq: String(seq),
    full: whole,
    issuedAt: plane.now(),
    bans,
  };
  const value = await plane.signer.sign(banBatchSigningBytes(unsigned));
  return {
    ...unsigned,
    signature: {
      alg: "Ed25519",
      keyId: plane.signer.keyId,
      value: Buffer.from(value).toString("base64"),
    },
  };
}

/**
 * PR-CP1's `POST /agent/events` on the agents' signed requests (the
 * coordinator's split): the guard, a `use` middleware that runs before the
 * router reads a deferred body, checks the headers (the agent, its key,
 * the time, the rate) and leaves the body unread; the handler verifies the
 * signature over the body (decoded, at most 1 MiB as sent and 8 MiB
 * decompressed), checks it is bound to `route: "events"`, stores the batch
 * once (`ingestEventBatch`) and answers signed.
 */
export function addAgentEventsRoute(
  router: BunRouter,
  context: AgentRouteContext,
): void {
  const { plane } = context;
  const guard: RouterHandler = async (req, res, next) => {
    if (req.method !== "POST") {
      next();
      return;
    }
    try {
      const checked = await checkAgentHeaders(
        req,
        res,
        AGENT_ROUTES.events,
        context,
      );
      if (!checked.ok) return;
      // The body stays unread: the handler reads it within its own bounds.
      if (req.hasDeferredBody) req.setParseBodyOptions(false);
      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const handle: RouterHandler = async (req, res, next) => {
    try {
      const encoding = (
        req.request.headers.get("content-encoding") ?? "identity"
      )
        .trim()
        .toLowerCase();
      if (encoding !== "identity" && encoding !== "gzip") {
        await refuse(
          res,
          new ApiProblem(
            415,
            "unsupported_encoding",
            `an event batch is gzip or identity, not ${encoding}`,
          ),
          undefined,
          plane.now(),
        );
        return;
      }
      const outcome = await verifyAgentBody(
        req,
        res,
        AGENT_ROUTES.events,
        context,
      );
      if (!outcome.ok) return;
      const { request } = outcome;
      const batch = boundJson(request.body, AGENT_ROUTES.events);
      if (batch === undefined) {
        await refuse(
          res,
          new ApiProblem(
            401,
            "unauthenticated",
            "the body was not signed for the events route",
          ),
          request.secret,
          plane.now(),
        );
        return;
      }
      try {
        const result = await ingestEventBatch(plane.store, batch, {
          service: request.service,
        });
        if (!result.duplicate) {
          try {
            liveHooksOf(plane).publishBatch(
              request.service,
              batch as unknown as AgentEventBatch,
            );
          } catch (error) {
            context.logger.error(
              "bun-security agent: the live hub's batch hook threw",
              { error },
            );
          }
        }
        await sendSigned(
          res,
          200,
          JSON.stringify({ duplicate: result.duplicate }),
          request.secret,
          null,
          plane.now(),
        );
      } catch (error) {
        if (!(error instanceof EventBatchError)) throw error;
        const code =
          error.status === 403
            ? "forbidden"
            : error.status === 413
              ? "too_large"
              : error.status === 415
                ? "unsupported_encoding"
                : "invalid_request";
        await refuse(
          res,
          new ApiProblem(error.status, code, error.message),
          request.secret,
          plane.now(),
        );
      }
    } catch (error) {
      next(error instanceof Error ? error : new Error(String(error)));
    }
  };
  (
    router as unknown as {
      use: (path: string, handler: RouterHandler) => unknown;
    }
  ).use("/agent/events", guard);
  (
    router as unknown as {
      post: (path: string, handler: RouterHandler) => unknown;
    }
  ).post("/agent/events", handle);
}

/** Registers the agent routes on `router` (under the API's base). */
export function addAgentRoutes(
  router: BunRouter,
  context: AgentRouteContext,
): void {
  const { plane, registry, options, logger } = context;

  /** Wraps a handler: authenticated for `route`, run as the agent, errors answered. */
  const handle =
    (
      route: AgentRoute,
      run: (
        request: AgentRequest,
        req: BunRequest,
        res: BunResponse,
      ) => Promise<void>,
    ): RouterHandler =>
    async (req, res, next) => {
      try {
        const outcome = await agentRequest(req, res, route, context);
        if (!outcome.ok) return;
        const request = outcome.request;
        await auditContext.run(
          {
            actor: { id: request.agent, kind: "agent" },
            address: req.ip ?? null,
            sessionId: null,
            requestId: request.requestId ?? "agent",
            permissions: [],
            stepUp: false,
            incomplete: false,
          },
          async () => {
            try {
              await run(request, req, res);
            } catch (error) {
              if (error instanceof ApiProblem) {
                await refuse(res, error, request.secret, plane.now());
                return;
              }
              throw error;
            }
          },
        );
      } catch (error) {
        next(error instanceof Error ? error : new Error(String(error)));
      }
    };

  const get = (path: string, handler: RouterHandler) =>
    (
      router as unknown as {
        get: (path: string, handler: RouterHandler) => unknown;
      }
    ).get(path, handler);
  const post = (path: string, handler: RouterHandler) =>
    (
      router as unknown as {
        post: (path: string, handler: RouterHandler) => unknown;
      }
    ).post(path, handler);

  get(
    "/agent/bundle",
    handle(AGENT_ROUTES.bundle, async (request, req, res) => {
      const ifNoneMatch = req.request.headers.get("if-none-match") ?? undefined;
      const found = await plane.store.getBundle(request.service, ifNoneMatch);
      if (found === undefined) {
        throw new ApiProblem(
          404,
          "not_found",
          `no bundle is compiled for service "${request.service}" yet`,
        );
      }
      if (found === "not-modified") {
        await sendSigned(
          res,
          304,
          null,
          request.secret,
          request.requestId,
          plane.now(),
          { etag: ifNoneMatch ?? "" },
        );
        return;
      }
      await sendSigned(
        res,
        200,
        JSON.stringify(found.bundle),
        request.secret,
        null,
        plane.now(),
        {
          etag: found.etag,
          "cache-control": "no-store",
        },
      );
    }),
  );

  get(
    "/agent/bans",
    handle(AGENT_ROUTES.bans, async (request, req, res) => {
      const query = new URL(req.request.url).searchParams;
      const sinceText = query.get("since") ?? "0";
      if (!/^\d{1,30}$/.test(sinceText)) {
        throw new ApiProblem(
          400,
          "invalid_request",
          "since must be a change sequence (decimal)",
        );
      }
      const full = query.get("full") === "1" || query.get("full") === "true";
      const batch = await banBatchFor(
        plane,
        request.service,
        BigInt(sinceText),
        full,
        request.requestId!,
      );
      await sendSigned(
        res,
        200,
        JSON.stringify(batch),
        request.secret,
        null,
        plane.now(),
        { "cache-control": "no-store" },
      );
    }),
  );

  get(
    "/agent/artefacts/:sha256",
    handle(AGENT_ROUTES.artefact, async (request, req, res) => {
      const sha256 = String(
        (req.params as Record<string, string>).sha256 ?? "",
      );
      // The id binds the artefact too: `artefact.<sha256>.<random>`.
      if (
        !SHA256_PATTERN.test(sha256) ||
        request.requestId?.split(".")[1] !== sha256
      ) {
        throw new ApiProblem(
          400,
          "invalid_request",
          "the request was not signed for this artefact",
        );
      }
      const bytes =
        options.artefacts === undefined
          ? undefined
          : await options.artefacts.get(sha256);
      if (bytes === undefined)
        throw new ApiProblem(404, "not_found", `no artefact ${sha256}`);
      if (bytes.byteLength > options.maxArtefactBytes) {
        throw new ApiProblem(
          413,
          "too_large",
          `the artefact is over ${options.maxArtefactBytes} bytes`,
        );
      }
      await sendSigned(
        res,
        200,
        bytes,
        request.secret,
        null,
        plane.now(),
        {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
        },
        artefactSignedBody(sha256Of(bytes)),
      );
    }),
  );

  post(
    "/agent/heartbeat",
    handle(AGENT_ROUTES.heartbeat, async (request, _req, res) => {
      const beat = boundJson(request.body, AGENT_ROUTES.heartbeat);
      if (beat === undefined) {
        throw new ApiProblem(
          401,
          "unauthenticated",
          "the body was not signed for the heartbeat route",
        );
      }
      if (!isHeartbeat(beat))
        throw new ApiProblem(400, "invalid_request", "a malformed heartbeat");
      await registry.heartbeat(request.doc, beat);
      await sendSigned(
        res,
        200,
        JSON.stringify({
          at: plane.now(),
          intervalMs: registry.heartbeatIntervalMs,
        }),
        request.secret,
        null,
        plane.now(),
      );
    }),
  );

  get(
    "/agent/nudge",
    handle(AGENT_ROUTES.nudge, async (request, _req, res) => {
      const stream = res.sse({ logger });
      const scopes = new Set(await plane.scopesAbove(request.service));
      const own = serviceScope(request.service);
      /** Sends a signed nudge. */
      const nudge = (reason: AgentNudge["reason"]) => {
        const body = JSON.stringify({
          route: "nudge",
          reason,
          at: plane.now(),
        } satisfies AgentNudge);
        void agentEnvelope
          .signEnvelope(body, {
            direction: "response",
            secret: request.secret,
            now: plane.now(),
          })
          .then((signature) =>
            stream.send({ event: "nudge", data: { body, signature } }),
          )
          .catch(() => undefined);
      };
      const off = plane.listen((event) => {
        if (event.event === "bundle.compiled" && event.scope === own)
          nudge("bundle");
        else if (event.event === "ban.changed" && scopes.has(event.scope))
          nudge("bans");
      });
      // Another control-plane instance's change reaches this one through the store's pushed feed.
      let last = (await plane.store.changesSince(0n, 1)).head;
      const unsubscribe = plane.store.subscribe?.(
        (head) => {
          if (head <= last) return;
          void plane.store
            .changesSince(last, 1_000)
            .then(async ({ changes }) => {
              last = changes.at(-1)?.seq ?? last;
              if (
                changes.some(
                  (change) =>
                    change.kind === "bundle" && change.id === request.service,
                )
              )
                nudge("bundle");
              for (const change of changes.filter((c) => c.kind === "ban")) {
                const ban = await plane.store.getBan(change.id);
                if (ban !== undefined && scopes.has(ban.scope)) {
                  nudge("bans");
                  break;
                }
              }
            });
        },
        () => nudge("bans"),
      );
      stream.onClose(() => {
        off();
        unsubscribe?.();
      });
    }),
  );
}
