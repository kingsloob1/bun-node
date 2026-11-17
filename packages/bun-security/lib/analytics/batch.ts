/**
 * Shipping events to the control plane (README §8.5, control-plane.md §9):
 * the batch an agent posts to `/agent/events`, and the control plane's side
 * that decodes a posted body within its bounds and stores it once. The
 * agent's batcher, which builds one a second from an event ring and a
 * recorder and keeps a bounded retry queue, is PR-CP4's; so is the
 * authentication that tells `ingestEventBatch` which service the agent
 * belongs to.
 */
import type {
  CounterRow,
  SecurityEvent,
  SecurityStoreDriver,
} from "../store/types";
import { gunzipSync } from "node:zlib";
import { ConfigError } from "@kingsleyweb/bun-common";

/** The batch format's id. */
export const EVENT_BATCH_FORMAT = "bun-security.events/1";

/** The bounds of a posted batch (README §8.5). */
export const EVENT_BATCH_LIMITS = Object.freeze({
  /** Events a batch carries. */
  events: 500,
  /** Bytes of a posted body, as sent (gzip). */
  compressedBytes: 1024 * 1024,
  /** Bytes of a posted body once decompressed. */
  bodyBytes: 8 * 1024 * 1024,
});

/** What an agent posts to `/agent/events`. */
export interface AgentEventBatch {
  /** The format: {@link EVENT_BATCH_FORMAT}. */
  readonly format: typeof EVENT_BATCH_FORMAT;
  /** The batch's id, unique per batch; a resend keeps it, so it is stored once. */
  readonly batchId: string;
  /** The service the agent's key belongs to. */
  readonly service: string;
  /** When it was built, epoch milliseconds (for diagnostics). */
  readonly sentAt: number;
  /** The events, at most 500. */
  readonly events: readonly SecurityEvent[];
  /** The counter rows: the recorder's closed minutes and exact refusals. */
  readonly counters: readonly CounterRow[];
}

/** Why a posted batch was refused, and the status to answer with. */
export class EventBatchError extends Error {
  /** The HTTP status: 400 malformed, 403 another service's, 413 too large, 415 an unknown encoding. */
  readonly status: 400 | 403 | 413 | 415;

  constructor(
    /** The HTTP status. */
    status: 400 | 403 | 413 | 415,
    /** Why, for the problem's detail. */
    message: string,
  ) {
    super(message);
    this.name = "EventBatchError";
    this.status = status;
  }
}

/**
 * A posted body decoded within its bounds: at most 1 MiB as sent, 8 MiB
 * decompressed (a gzip bomb stops at the bound), then JSON. Throws an
 * {@link EventBatchError}.
 */
export function decodeEventBatch(
  body: Uint8Array,
  contentEncoding: string | null | undefined,
): unknown {
  if (body.byteLength > EVENT_BATCH_LIMITS.compressedBytes) {
    throw new EventBatchError(413, "an event batch is at most 1 MiB as sent");
  }
  const encoding = (contentEncoding ?? "identity").trim().toLowerCase();
  let bytes: Uint8Array;
  if (encoding === "gzip") {
    try {
      bytes = gunzipSync(body, {
        maxOutputLength: EVENT_BATCH_LIMITS.bodyBytes,
      });
    } catch (error) {
      if (
        error instanceof RangeError ||
        (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE"
      ) {
        throw new EventBatchError(
          413,
          "an event batch is at most 8 MiB decompressed",
        );
      }
      throw new EventBatchError(400, "an event batch's gzip did not decode");
    }
  } else if (encoding === "identity") {
    bytes = body;
  } else {
    throw new EventBatchError(
      415,
      `an event batch is gzip or identity, not ${encoding}`,
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new EventBatchError(400, "an event batch is not JSON");
  }
}

/**
 * Stores a posted batch for the agent's `service`, once: its events and
 * counters in one store call (`appendEvents`). Refuses another service's
 * batch (403), and a malformed one (400), before anything is written.
 */
export async function ingestEventBatch(
  store: SecurityStoreDriver,
  batch: unknown,
  agent: {
    /** The service the authenticated agent belongs to. */
    readonly service: string;
  },
): Promise<{ readonly duplicate: boolean }> {
  if (store.appendEvents === undefined) {
    throw new ConfigError(
      `ingestEventBatch(): the "${store.name}" store has no analytics`,
    );
  }
  if (typeof batch !== "object" || batch === null) {
    throw new EventBatchError(400, "an event batch must be an object");
  }
  const input = batch as Partial<AgentEventBatch>;
  if (input.format !== EVENT_BATCH_FORMAT) {
    throw new EventBatchError(
      400,
      `an event batch's format must be "${EVENT_BATCH_FORMAT}"`,
    );
  }
  if (typeof input.batchId !== "string") {
    throw new EventBatchError(400, "an event batch needs a batchId");
  }
  if (!Array.isArray(input.events) || !Array.isArray(input.counters)) {
    throw new EventBatchError(
      400,
      "an event batch carries events and counters lists",
    );
  }
  if (input.events.length > EVENT_BATCH_LIMITS.events) {
    throw new EventBatchError(
      413,
      `an event batch carries at most ${EVENT_BATCH_LIMITS.events} events`,
    );
  }
  const foreign =
    input.service !== agent.service ||
    input.events.some(
      (event) => (event as { service?: unknown }).service !== agent.service,
    ) ||
    input.counters.some(
      (row) => (row as { service?: unknown }).service !== agent.service,
    );
  if (foreign) {
    throw new EventBatchError(
      403,
      "an agent ships its own service's events only",
    );
  }
  try {
    return await store.appendEvents(
      input.batchId,
      input.events,
      input.counters,
    );
  } catch (error) {
    if (error instanceof ConfigError)
      throw new EventBatchError(400, error.message);
    throw error;
  }
}
