/**
 * `POST /agent/events` (README §8.5, control-plane.md §9, PR-CP1): where an
 * agent posts its event batches. In this order, so an attack's volume
 * costs the control plane as little as it can:
 *
 * 1. the agent is authenticated while the body stream is still unread, on
 *    an adapter that defers bodies (`authenticate`, PR-CP4's signed
 *    requests); `401` without one. Bytes the runtime has already buffered
 *    from the socket are not covered: that needs bun-common's before-read
 *    hook. On an adapter that reads bodies before routing, the body has
 *    been read (under the adapter's caps) before this runs;
 * 2. a per-agent rate limit (`rateLimit` batches a second); `429`;
 * 3. the body is read to at most 1 MiB, refused past it without reading on
 *    (`413`), and decompressed to at most 8 MiB;
 * 4. the batch is stored once (`ingestEventBatch`): another service's is
 *    `403`, a malformed one `400`, and a resent one answers
 *    `{ duplicate: true }`.
 */
import type {
  BunRequest,
  BunResponse,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import type { SecurityStoreDriver } from "../store/types";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  decodeEventBatch,
  EVENT_BATCH_LIMITS,
  EventBatchError,
  ingestEventBatch,
} from "../analytics/batch";
import { ApiProblem } from "./problems";

/** An authenticated agent. */
export interface AgentIdentity {
  /** The agent's id (its key's), for the rate limit. */
  readonly id: string;
  /** The service its key belongs to: the only one whose events it may post. */
  readonly service: string;
}

/** The `agentEvents` option of `createSecurityApi`. */
export interface AgentEventsOptions {
  /**
   * Authenticates an agent's request without reading its body (its
   * headers, its signature over them): the agent, or `undefined` for none.
   * PR-CP4's signed requests.
   */
  readonly authenticate: (
    req: BunRequest,
  ) => AgentIdentity | undefined | Promise<AgentIdentity | undefined>;
  /** Batches an agent may post a second. Default 5 (an agent sends one). */
  readonly rateLimit?: number;
}

/** Reads a request's body, refusing it past `limit` bytes without reading on. */
async function readBounded(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    throw new EventBatchError(413, "an event batch is at most 1 MiB as sent");
  }
  const stream: ReadableStream<Uint8Array> | null = request.body;
  if (stream === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early cancels the stream: nothing past the bound is read.
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) {
      throw new EventBatchError(413, "an event batch is at most 1 MiB as sent");
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The problem an {@link EventBatchError} answers with. */
function problemOf(error: EventBatchError): ApiProblem {
  switch (error.status) {
    case 403:
      return new ApiProblem(403, "forbidden", error.message);
    case 413:
      return new ApiProblem(413, "too_large", error.message);
    case 415:
      return new ApiProblem(415, "unsupported_encoding", error.message);
    default:
      return new ApiProblem(400, "invalid_request", error.message);
  }
}

/** The route's two halves: the guard (a `use` middleware, before any body is read) and the handler. */
export interface AgentEventsRoute {
  /**
   * Mounted with `use` on the path, so it runs before the router reads a
   * deferred body: authenticates the agent, applies the rate limit, and
   * leaves the body unread for the handler.
   */
  readonly guard: RouterHandler;
  /** The `POST` handler: reads the body within its bounds and stores the batch once. */
  readonly handle: RouterHandler;
}

/** The agent a request's guard authenticated. */
const AGENTS = new WeakMap<object, AgentIdentity>();

/** An `Error` for `next()`: an {@link EventBatchError} as its problem. */
function toError(error: unknown): Error {
  if (error instanceof EventBatchError) return problemOf(error);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The route; see the module's description. The agent is authenticated
 * before the body is read when the adapter defers bodies (`request: {
 * deferBody: true }`, as `secureAdmin` sets): the guard runs first and
 * turns the router's body read off for the route. On an adapter that reads
 * bodies before routing, the body arrives already read, under the adapter's
 * own caps.
 */
export function agentEventsRoute(
  store: SecurityStoreDriver,
  options: AgentEventsOptions,
  now: () => number,
): AgentEventsRoute {
  if (typeof options?.authenticate !== "function") {
    throw new ConfigError(
      "createSecurityApi(): agentEvents.authenticate is required: how an agent's request is authenticated",
    );
  }
  if (store.appendEvents === undefined) {
    throw new ConfigError(
      `createSecurityApi(): agentEvents needs a store with analytics; "${store.name}" has none`,
    );
  }
  const rateLimit = options.rateLimit ?? 5;
  if (!Number.isSafeInteger(rateLimit) || rateLimit < 1) {
    throw new ConfigError(
      "createSecurityApi(): agentEvents.rateLimit must be a positive whole number",
    );
  }
  let second = -1;
  /** Batches this second, by agent id (authenticated agents only, so bounded by their number). */
  const counts = new Map<string, number>();

  const guard: RouterHandler = async (
    req: BunRequest,
    res: BunResponse,
    next,
  ) => {
    if (req.method !== "POST") {
      next();
      return;
    }
    try {
      const agent = await options.authenticate(req);
      if (agent === undefined) {
        throw new ApiProblem(
          401,
          "unauthenticated",
          "an agent's signed request is required",
        );
      }
      const thisSecond = Math.floor(now() / 1_000);
      if (thisSecond !== second) {
        second = thisSecond;
        counts.clear();
      }
      const count = (counts.get(agent.id) ?? 0) + 1;
      counts.set(agent.id, count);
      if (count > rateLimit) {
        res.set("retry-after", "1");
        throw new ApiProblem(
          429,
          "rate_limited",
          "this agent posts too many batches",
        );
      }
      // The body stays unread: the handler reads it within its own bounds.
      if (req.hasDeferredBody) req.setParseBodyOptions(false);
      AGENTS.set(req.request, agent);
      next();
    } catch (error) {
      next(toError(error));
    }
  };

  const handle: RouterHandler = async (
    req: BunRequest,
    res: BunResponse,
    next,
  ) => {
    try {
      const agent = AGENTS.get(req.request);
      if (agent === undefined) {
        throw new ApiProblem(
          401,
          "unauthenticated",
          "an agent's signed request is required",
        );
      }
      const encoding = req.request.headers.get("content-encoding");
      let batch: unknown;
      const stream = req.request.body;
      if (stream !== null && !stream.locked && !req.request.bodyUsed) {
        batch = decodeEventBatch(
          await readBounded(req.request, EVENT_BATCH_LIMITS.compressedBytes),
          encoding,
        );
      } else {
        // Read, decoded and parsed by the adapter before routing, under its
        // own caps.
        batch = req.body;
      }
      const result = await ingestEventBatch(store, batch, {
        service: agent.service,
      });
      res.status(200).json({ duplicate: result.duplicate });
    } catch (error) {
      next(toError(error));
    }
  };

  return Object.freeze({ guard, handle });
}
