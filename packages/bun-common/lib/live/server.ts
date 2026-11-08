/**
 * Live invalidation's server half (typed-client plan `websocket.md` §9, TC
 * D15, PR-W4): {@link liveInvalidation} serves {@link liveContract} as a
 * `defineChannel` at `/__live`, with its SSE fallback at `/__live/sse`, and
 * {@link publishTags} tells every subscriber of a tag that it was
 * invalidated.
 *
 * ```ts
 * import { liveInvalidation, publishTags } from "@kingsleyweb/bun-common/live";
 *
 * app.use(liveInvalidation(app, { authorize, source: cache })); // before the routes
 * app.patch("/users/:id", validate(…), handler)
 *   .describe({ cache: { invalidates: ["user:{id}", "users"] } }); // published on a 2xx
 * publishTags(["user:42"]);                                       // or by hand
 * ```
 *
 * - **Topics**: each tag is a Bun pub/sub topic, refcounted: a socket that
 *   subscribes to a tag joins its topic, and an invalidation is published
 *   only on the topics somebody holds. A frame carries one tag, so a socket
 *   subscribed to two tags of one invalidation gets two frames with the same
 *   `seq` (the client dedupes by it).
 * - **Resume**: the process numbers its invalidations (`seq`) within an
 *   epoch (random per process) and keeps the last 1024 in a ring
 *   (bun-jobs' hub is the model). A client that reconnects subscribes to
 *   its tags, then sends `resume` with its cursor, and is replayed what it
 *   missed for the tags it holds, before the `hello` answering it (an
 *   invalidation it also heard live since the `subscribe` comes twice, with
 *   the same `seq`); when the epoch changed, the cursor is ahead of the
 *   server, or what it missed fell off the ring, it gets a `gap` instead,
 *   and invalidates everything.
 * - **Sources**: {@link publishTags}; a route's `cache.invalidates` (TC
 *   §8.1, `.describe({ cache })`, or bun-nest's `@Describe`), filled from
 *   the request's params, when its response is a 2xx (unless its handler
 *   publishes its own: bun-nest's `@Invalidates`); and a cache's tag invalidations when `source`
 *   is given (bun-cache's `invalidate` event, which `invalidateTags`
 *   emits, either mode).
 * - **Across processes**: the ring, the epoch and the subscribers are this
 *   process's. With a `bus` (or `connectLiveBus()`, `./bus.ts`), every
 *   invalidation is also published to the other processes on the bus, which
 *   number it in their own epoch and deliver it to their subscribers; when
 *   one may have been lost, they send a `gap`. Without one, a client sees
 *   another process's invalidations only by its own route, cache or
 *   `publishTags` call (bun-cache's bus does not emit `invalidate` for
 *   another process's invalidation).
 */
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { BunRequest } from "../BunRequest";
import type { BunResponse } from "../BunResponse";
import type { BunServer, NextFunction, RouterHandler } from "../types/general";
import type { SseSendOf } from "../sse/writer";
import type { LiveBus } from "./bus";
import type { LiveCursor } from "./contract";
import type { LiveChannel, Stream } from "./hub";
import { BunRouter } from "../BunRouter";
import { defineChannel } from "../channel";
import { attachContract, getContract } from "../contract/transport";
import { routeDocFor } from "../docs/routeDoc";
import { ConfigError } from "../errors";
import { sse } from "../sse/declaration";
import { connectLiveBus, forwardToBus } from "./bus";
import { LIVE_MAX_TAG_LENGTH, liveContract } from "./contract";
import {
  chunked,
  cursorNow,
  deliverLocally,
  GAP_TOPIC,
  hub,
  isGap,
  isTag,
  MAX_SUBSCRIBED,
  missed,
  ref,
  topicOf,
  unref,
} from "./hub";

export { restartLiveEpoch } from "./hub";

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/** Options for {@link liveInvalidation}. */
export interface LiveInvalidationOptions {
  /**
   * Runs before the channel's upgrade and before the SSE fallback, as
   * `docsRouter`'s `authorize` does: call `next()` to let the client in, or
   * answer (a `401`) to refuse it. **Required**: an invalidation names the
   * data that changed. `(req, res, next) => next()` opens it to everyone.
   */
  authorize: RouterHandler;
  /**
   * A cache whose tag invalidations are published too: anything with
   * bun-cache's `on("invalidate", listener)` (a `createCache()` cache, or
   * one of its namespaces, which share their events). Every
   * `invalidateTags()` on it, in either mode, publishes its tags. Default:
   * none.
   */
  source?: {
    /** Listens for an event; answers the function that stops listening. */
    on: (
      event: "invalidate",
      listener: (event: { readonly tags: readonly string[] }) => void,
    ) => () => void;
  };
  /**
   * A bus to the other processes serving (or publishing) live invalidation,
   * so an invalidation published in any of them reaches the subscribers of
   * every one: bun-cache's `cacheLiveBus(redisBus(url))`
   * (`@kingsleyweb/bun-cache/live`), or any {@link LiveBus}. Connected with
   * `connectLiveBus(bus, { logger: app.logger })` for the life of the
   * process; call `connectLiveBus` yourself to close it, or in a process
   * that publishes without serving. One bus per process: another one throws
   * a `ConfigError`. Default: none (this process's subscribers only).
   */
  bus?: LiveBus;
}

/* ------------------------------------------------------------------ *
 * Publishing
 * ------------------------------------------------------------------ */

/** What a live socket carries as `ws.data.custom`: the server it was upgraded on, which its topics are published on. */
interface LiveSocketData {
  /** The accepting server. */
  readonly server: BunServer | undefined;
}

/**
 * Publishes an invalidation of `tags`: numbered, kept in the ring for
 * resume, and sent to every socket and SSE stream subscribed to one of them
 * (a tag nobody holds costs nothing but its place in the ring); with a live
 * bus connected, also published on it, to every other process's
 * subscribers. Duplicates are dropped; an empty list does nothing.
 * Synchronous: the sends are queued, and reach each socket in publication
 * order (the bus publish follows, in a microtask).
 *
 * @param tags The invalidated tags, as the client files its queries under
 *   them (`"user:42"`): each a string of 1 to 512 characters.
 * @throws TypeError for a tag that is not such a string.
 */
export function publishTags(tags: readonly string[]): void {
  const given: unknown = tags;
  if (!Array.isArray(given))
    throw new TypeError("publishTags(): expected an array of tags");
  for (const tag of given as readonly unknown[]) {
    if (!isTag(tag))
      throw new TypeError(
        `publishTags(): a tag is a string of 1 to ${LIVE_MAX_TAG_LENGTH} characters`,
      );
  }
  const unique = [...new Set(tags)];
  if (unique.length === 0) return;
  deliverLocally(unique);
  forwardToBus(unique);
}

/* ------------------------------------------------------------------ *
 * The route source: `cache.invalidates` on success
 * ------------------------------------------------------------------ */

/** A template's `{name}`. */
const PLACEHOLDER = /\{([^{}]+)\}/g;

/**
 * The tags `templates` name for `params`: each `{name}` filled with the
 * param's value; a template naming a param the request lacks (or one that
 * is not a scalar) is skipped, as bun-client's query layer fills them.
 */
export function fillTagTemplates(
  templates: readonly string[],
  params: Readonly<Record<string, unknown>> | undefined,
): string[] {
  const out: string[] = [];
  for (const template of templates) {
    let missing = false;
    const tag = template.replace(PLACEHOLDER, (_match, name: string) => {
      const value = params?.[name];
      if (
        value === undefined ||
        value === null ||
        typeof value === "object" ||
        typeof value === "function"
      ) {
        missing = true;
        return "";
      }
      return String(value);
    });
    if (!missing && isTag(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * The reflect-metadata key marking a handler that publishes its own
 * invalidations: bun-nest's `@Invalidates` (typed-client plan
 * `nest-typed-routes.md` §4.3), whose interceptor publishes when the handler
 * succeeds rather than on the status. Written by value on both sides, as
 * `"bun:describe"` is.
 */
const SELF_PUBLISHING_METADATA = "bun:invalidates";

/** The reflect-metadata polyfill's reader, when it is loaded; read structurally. */
const reflectMeta = Reflect as unknown as {
  getMetadata?: (key: unknown, target: object) => unknown;
};

/** Whether `callback` publishes its own invalidations (see {@link SELF_PUBLISHING_METADATA}). */
function publishesItself(callback: unknown): boolean {
  return (
    (typeof callback === "function" ||
      (typeof callback === "object" && callback !== null)) &&
    reflectMeta.getMetadata?.(SELF_PUBLISHING_METADATA, callback) !== undefined
  );
}

/**
 * The middleware publishing a route's `cache.invalidates` once its response
 * is a 2xx: read from the matched route's doc (its terminal callback's, as
 * the documents read it) when the response is produced. A route whose
 * handler publishes its own (bun-nest's `@Invalidates`, marked with
 * `"bun:invalidates"` metadata) is left to it, so a success publishes once.
 */
function invalidatesOnSuccess(
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
): void {
  res.whenResponded((response) => {
    if (response.status < 200 || response.status >= 300) return;
    const callbacks = (req.route as { callbacks?: readonly unknown[] } | null)
      ?.callbacks;
    const terminal = callbacks?.at(-1);
    if (publishesItself(terminal)) return;
    const templates = routeDocFor(terminal)?.cache?.invalidates;
    if (templates === undefined || templates.length === 0) return;
    publishTags(fillTagTemplates(templates, req.params));
  });
  next();
}

/* ------------------------------------------------------------------ *
 * The SSE fallback
 * ------------------------------------------------------------------ */

/**
 * The fallback's events, declared with the channel's own schemas, so its
 * writer (`res.sse({ contract })`, PR-sse2) checks each before it is
 * encoded.
 */
const LIVE_EVENTS = sse({
  invalidate: liveContract.spec.sends.invalidate,
  gap: liveContract.spec.sends.gap,
  hello: liveContract.spec.sends.hello,
});

/** One event of the fallback, as its writer takes it. */
type LiveEvent = SseSendOf<typeof LIVE_EVENTS>;

/** A `Last-Event-ID` (`<epoch>:<seq>`) as a cursor, if it is one. */
function parseEventId(value: string): LiveCursor | undefined {
  const at = value.lastIndexOf(":");
  if (at <= 0) return undefined;
  const seq = Number(value.slice(at + 1));
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined;
  return { epoch: value.slice(0, at), seq };
}

/** The `tag` query values, as a list. */
function queryTags(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  return [...new Set(list.filter(isTag))];
}

/** The event id of `seq` in this epoch. */
const eventId = (seq: number): string => `${hub.epoch}:${seq}`;

/** The invalidation events after `after` that hit `tags`. */
function missedEvents(after: number, tags: ReadonlySet<string>): LiveEvent[] {
  const out: LiveEvent[] = [];
  for (const { seq, tags: hit } of missed(after, tags))
    for (const part of chunked(hit))
      out.push({
        event: "invalidate",
        data: { tags: part, seq, epoch: hub.epoch },
        id: eventId(seq),
      });
  return out;
}

/**
 * The SSE fallback's handler: `GET /__live/sse?tag=a&tag=b`, with the cursor
 * in `Last-Event-ID`, on bun-common's writer (`res.sse()`: the opening
 * comment, a heartbeat comment every 15 s, the exemption from Bun's
 * `idleTimeout`, backpressure and its bound). Its `resume` answers what the
 * cursor missed (or a `gap`, for one this process cannot replay or cannot
 * read) before any live event; then `hello`, then every invalidation of its
 * tags as it happens, each with the id `<epoch>:<seq>`.
 */
function sseHandler(req: BunRequest, res: BunResponse): void {
  const tags = queryTags(req.query.tag).slice(0, MAX_SUBSCRIBED);
  if (tags.length === 0) {
    res.status(400);
    res.json({ error: "Name the tags to watch: ?tag=<tag>, repeated" });
    return;
  }
  const held = new Set(tags);
  const writer = res.sse({
    contract: LIVE_EVENTS,
    resume: (lastEventId): LiveEvent[] => {
      const cursor = parseEventId(lastEventId);
      return cursor === undefined || isGap(cursor)
        ? [{ event: "gap", data: cursorNow(), id: eventId(hub.seq) }]
        : missedEvents(cursor.seq, held);
    },
  });
  // Behind the replay, as every live event is.
  void writer.send({ event: "hello", data: cursorNow(), id: eventId(hub.seq) });
  const stream: Stream = {
    tags: held,
    write: (data) =>
      void writer.send({ event: "invalidate", data, id: eventId(data.seq) }),
    gap: (cursor) =>
      void writer.send({ event: "gap", data: cursor, id: eventId(cursor.seq) }),
  };
  for (const tag of held) ref(tag);
  hub.streams.add(stream);
  writer.onClose(() => {
    if (!hub.streams.delete(stream)) return;
    for (const tag of held) unref(tag);
  });
}

/* ------------------------------------------------------------------ *
 * liveInvalidation()
 * ------------------------------------------------------------------ */

/** A socket opened: its state, and its server counted. */
function opened(ws: ServerWebSocket<unknown>, channel: LiveChannel): void {
  const data = ws.data as { custom?: LiveSocketData } | undefined;
  const server = data?.custom?.server;
  hub.sockets.set(ws, { tags: new Set(), server });
  // Every socket hears a gap (the bus's), whatever tags it holds.
  ws.subscribe(GAP_TOPIC);
  if (server === undefined) return;
  const known = hub.servers.get(server);
  if (known === undefined) hub.servers.set(server, { channel, sockets: 1 });
  else known.sockets++;
}

/** A socket closed: its tags and its server released. */
function closed(ws: ServerWebSocket<unknown>): void {
  const state = hub.sockets.get(ws);
  if (state === undefined) return;
  hub.sockets.delete(ws);
  for (const tag of state.tags) unref(tag);
  if (state.server === undefined) return;
  const known = hub.servers.get(state.server);
  if (known !== undefined && --known.sockets <= 0)
    hub.servers.delete(state.server);
}

/**
 * Serves live invalidation (`websocket.md` §9): {@link liveContract} at
 * `/__live` (a `defineChannel`, registered on `app`, whose socket router
 * serves it), and, on the returned router, the SSE fallback at
 * `/__live/sse` and the middleware that publishes a route's
 * `cache.invalidates` when its response is a 2xx. Mount the router before
 * the routes (`app.use(liveInvalidation(app, …))`, first): a middleware
 * sees only the requests that reach it.
 *
 * Both endpoints run `authorize` first. The SSE route is hidden from the
 * OpenAPI document (it has no validator, which a strict document refuses);
 * the channel is documented in the AsyncAPI one, with the fallback.
 *
 * @param app The router that serves the channel — normally the
 *   `BunHttpAdapter`. Without a `BunWebSocket` attached, only the SSE
 *   fallback is served, and a warning says so.
 * @param options {@link LiveInvalidationOptions}.
 * @throws ConfigError when `authorize` is missing.
 */
export function liveInvalidation(
  app: BunRouter,
  options: LiveInvalidationOptions,
): BunRouter {
  if (typeof options?.authorize !== "function") {
    throw new ConfigError(
      "liveInvalidation(): `authorize` is required — an invalidation names the data that changed; pass (req, res, next) => next() to open it to everyone",
    );
  }
  const { authorize, source, bus } = options;
  const logger = app.logger;
  // First: a second bus throws before anything is registered.
  if (bus !== undefined) connectLiveBus(bus, { logger });
  const router = new BunRouter();
  router.use(invalidatesOnSuccess);
  const fallback = liveContract.meta.fallback ?? "/__live/sse";
  router.get(fallback, authorize, sseHandler).describe({ hidden: true });

  if (app.getBunWebsocket() === undefined) {
    logger.warn(
      "liveInvalidation(): the router has no BunWebSocket attached, so the live channel is not served (the SSE fallback is)",
      { path: liveContract.meta.path },
    );
  } else {
    const channel = defineChannel(liveContract);
    const inner = channel.handler<LiveSocketData>({
      subscribe(ws, data) {
        const state = hub.sockets.get(ws);
        if (state === undefined) return cursorNow();
        for (const tag of data.tags) {
          if (state.tags.has(tag)) continue;
          if (state.tags.size >= MAX_SUBSCRIBED) {
            logger.warn(
              "liveInvalidation(): a socket holds the most tags it may; the rest of its subscribe is ignored",
              { limit: MAX_SUBSCRIBED },
            );
            break;
          }
          state.tags.add(tag);
          ws.subscribe(topicOf(tag));
          ref(tag);
        }
        return cursorNow();
      },
      unsubscribe(ws, data) {
        const state = hub.sockets.get(ws);
        if (state === undefined) return;
        for (const tag of data.tags) {
          if (!state.tags.delete(tag)) continue;
          ws.unsubscribe(topicOf(tag));
          unref(tag);
        }
      },
      resume(ws, cursor) {
        const state = hub.sockets.get(ws);
        if (state === undefined) return cursorNow();
        if (isGap(cursor)) {
          void channel.send(ws, "gap", cursorNow());
          return cursorNow();
        }
        for (const { seq, tags } of missed(cursor.seq, state.tags))
          for (const part of chunked(tags))
            void channel.send(ws, "invalidate", {
              tags: part,
              seq,
              epoch: hub.epoch,
            });
        return cursorNow();
      },
    });
    const handler: WebSocketHandler<never> = {
      ...inner,
      open(ws) {
        void inner.open?.(ws);
        opened(ws, channel);
      },
      close(ws, code, reason) {
        closed(ws);
        void inner.close?.(ws, code, reason);
      },
    };
    const contract = getContract(inner);
    if (contract !== undefined) attachContract(handler, contract);
    app.ws(
      channel.path,
      authorize,
      channel.checks(),
      handler,
      channel.options<LiveSocketData>((req) => ({
        custom: { server: req.server },
      })),
    );
  }

  if (source !== undefined) {
    source.on("invalidate", (event) => {
      const tags = Array.isArray(event?.tags) ? event.tags.filter(isTag) : [];
      if (tags.length > 0) publishTags(tags);
    });
  }
  return router;
}
