/**
 * `describeChannel()` metadata (AD (e), plan `docs/plans/api-docs-generation/`
 * §5.1): what a **bare** `ws()` route contributes to the generated AsyncAPI
 * document, and the store it lives in.
 *
 * A channel declared with `defineChannel` documents itself — its contract
 * carries the messages, the meta the subprotocol/topics/fallback — so this
 * declaration is for a route `BunWebSocket` knows only as a path with
 * lifecycle handlers (§5.1's re-scoped role: `WsChannelDoc` enriches a raw
 * `ws()` route's otherwise-honest-but-useless stub).
 *
 * The store is a module-level `WeakMap` keyed on the `BunWebSocket` instance
 * (a dropped adapter's docs go with it), of path → doc maps, mirroring
 * `./routeDoc`'s terminal-callback store. Never consulted at request time.
 *
 * This module is imported by `BunWebSocket.ts`, so it must not import the
 * generator (`./asyncapi`) or the socket itself — types only, no runtime edge.
 */
import type { StandardSchemaV1 } from "../types/standardSchema";
import type { JsonSchemaLike } from "./convert";

/** One message on a channel (plan §5.1). */
export interface WsMessageDoc {
  /** One-line summary. Default: none. */
  summary?: string;
  /**
   * The payload's schema — any Standard Schema, or a raw JSON Schema. Default:
   * unconstrained (`{}`).
   */
  payload?: StandardSchemaV1 | JsonSchemaLike;
  /** Media type. Default: `"application/json"`. */
  contentType?: string;
  /**
   * Named examples of the payload, validated against it in the generator's
   * tests. Default: none.
   */
  examples?: Readonly<Record<string, unknown>>;
  /**
   * The message id this one is answered with, for a request/response pair
   * (AsyncAPI `operation.reply`). Names a key of the opposite map. Default:
   * none.
   */
  reply?: string;
}

/** Documents a bare WebSocket route's messages (plan §5.1, re-scoped). */
export interface WsChannelDoc {
  /** The channel's title. Default: the path. */
  title?: string;
  /** CommonMark description. Default: none. */
  description?: string;
  /** Messages a client sends to the server (AsyncAPI `receive`, from the app's view). Default: one unconstrained stub message. */
  receives?: Readonly<Record<string, WsMessageDoc>>;
  /** Messages the server sends to a client (AsyncAPI `send`). Default: one unconstrained stub message. */
  sends?: Readonly<Record<string, WsMessageDoc>>;
  /** The subprotocol clients must request. Default: none declared. */
  subprotocol?: string;
}

/** The store: adapter → (path → its doc). Weak, so a dropped adapter's docs go with it. */
const channelDocs = new WeakMap<object, Map<string, WsChannelDoc>>();

/**
 * Records `doc` for a `BunWebSocket` route's path; called by
 * `BunWebSocket.describeChannel()`. Calling it twice for one path merges,
 * last write winning per (top-level) key.
 */
export function attachChannelDoc(
  socket: object,
  path: string,
  doc: WsChannelDoc,
): void {
  let docs = channelDocs.get(socket);
  if (docs === undefined) {
    docs = new Map();
    channelDocs.set(socket, docs);
  }
  const existing = docs.get(path);
  docs.set(path, existing === undefined ? doc : { ...existing, ...doc });
}

/** The doc recorded for one of a `BunWebSocket`'s route paths, if any. */
export function channelDocFor(
  socket: object,
  path: string,
): WsChannelDoc | undefined {
  return channelDocs.get(socket)?.get(path);
}
