/**
 * The live layer's implementation (typed-client plan `websocket.md` §9, TC
 * D15, PR-W4), loaded by `./query`'s `live()` with `import()` on its first
 * call, so a query-only bundle carries none of it. It in turn loads
 * `./channel` (or `./sse`) the same way.
 *
 * - **Tags**: every query with an observer is held under its tags
 *   (`tagsOfQuery`: the route's declared ones and its responses'
 *   `Cache-Tag`/`Surrogate-Key`), refcounted, so a tag is subscribed once
 *   whatever the number of queries under it, and dropped with its last
 *   query; the changes of one task go out together.
 * - **Invalidation**: an `invalidate` frame invalidates the queries holding
 *   its tags (query-core refetches the active ones). One invalidation may
 *   arrive as several frames with the same `seq` (one per tag on the
 *   server's pub/sub), so a query is invalidated once per `seq`.
 * - **Resume**: the client keeps the server's cursor (`{ epoch, seq }`, from
 *   every `hello` and `invalidate`); after a reconnect it sends `subscribe`
 *   with every tag it holds, then `resume` with the cursor it had, and the
 *   server replays what it missed. A `gap`, or a `hello` or `invalidate` of another
 *   epoch (a restarted server), invalidates every query.
 * - **Transports**: bun-common's live channel (`./channel`, at `/__live`
 *   under the client's `baseUrl`), or its SSE fallback (`./sse`, at
 *   `/__live/sse`, the tags in the query, the cursor as `Last-Event-ID`):
 *   SSE when asked, when the platform has no `WebSocket`, or when the
 *   socket has not opened 3 s after the start (a proxy that refuses
 *   upgrades).
 */
import type { Query, QueryClient } from "@tanstack/query-core";
import type { ChannelClient, ChannelDescriptor } from "./channel";
import type { EventStream } from "./sse";

/** A position in the server's invalidations. */
interface Cursor {
  /** The server process's epoch. */
  epoch: string;
  /** The last invalidation's number in it. */
  seq: number;
}

/** The live channel's types, as bun-common's `liveContract` declares them (§9). */
interface LiveEntry {
  /** The client sends. */
  receives: {
    /** Tags to add. */
    subscribe: { tags: string[] };
    /** Tags to drop. */
    unsubscribe: { tags: string[] };
    /** The cursor kept, after a reconnect. */
    resume: Cursor;
  };
  /** The server sends. */
  sends: {
    /** Tags one invalidation hit. */
    invalidate: Cursor & { tags: string[] };
    /** The server cannot replay what was missed. */
    gap: Cursor;
    /** Where the server is. */
    hello: Cursor;
  };
  /** The replied types. */
  replies: { subscribe: "hello"; resume: "hello" };
}

/** The live channel, as a descriptor (bun-common's `liveContract`, which this package cannot import). */
export const LIVE_CHANNEL: ChannelDescriptor<LiveEntry> = {
  path: "/__live",
  replies: { subscribe: "hello", resume: "hello" },
};

/** The SSE fallback's route key. */
export const LIVE_SSE_KEY = "GET /__live/sse";

/** How long the channel may take to open before the SSE fallback replaces it, ms. */
const OPEN_DEADLINE_MS = 3_000;

/** The most tags one `subscribe` carries (the server's limit). */
const MAX_TAGS = 256;

/** The symbol the client keeps its configuration under (`client.ts`). */
const CONFIG = Symbol.for("@kingsleyweb/bun-client");

/** What `live()` takes of the client. */
export interface LiveApi {
  /** Builds a URL (the channel's). */
  readonly url: (...args: never[]) => string;
  /** Calls a route (the SSE fallback's). */
  readonly request: (...args: never[]) => Promise<unknown>;
}

/** `live()`'s options, as `./query` declares them. */
export interface StartOptions {
  /** `"websocket"` or `"sse"`; `undefined` picks. */
  readonly transport?: "websocket" | "sse";
}

/** A transport: what the layer tells the server. */
interface Transport {
  /** The held tags changed. */
  readonly changed: (
    added: readonly string[],
    removed: readonly string[],
  ) => void;
  /** Stops it. */
  readonly close: () => void;
}

/** `tags` in frames of at most {@link MAX_TAGS}. */
function chunked(tags: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let at = 0; at < tags.length; at += MAX_TAGS)
    out.push(tags.slice(at, at + MAX_TAGS));
  return out;
}

/** `value` as a cursor, if it is one. */
function asCursor(value: unknown): Cursor | undefined {
  const v = value as Partial<Cursor> | null | undefined;
  return typeof v?.epoch === "string" &&
    typeof v.seq === "number" &&
    Number.isSafeInteger(v.seq)
    ? { epoch: v.epoch, seq: v.seq }
    : undefined;
}

/**
 * Starts the live layer over `client`'s cache; answers the function that
 * stops it.
 *
 * @param api     The client: its `baseUrl` and configuration.
 * @param client  The `QueryClient` whose queries are kept fresh.
 * @param options The transport.
 * @param tagsOf  `./query`'s `tagsOfQuery`.
 */
export function startLive(
  api: LiveApi,
  client: QueryClient,
  options: StartOptions,
  tagsOf: (client: QueryClient, query: Query) => string[],
): () => void {
  const config = (api as unknown as Record<symbol, unknown>)[CONFIG] as
    { logger?: Pick<Console, "warn" | "error"> } | undefined;
  const logger = config?.logger ?? console;
  /** Each observed query's held tags, by hash. */
  const holders = new Map<string, ReadonlySet<string>>();
  /** Each held tag's number of queries. */
  const refs = new Map<string, number>();
  const added = new Set<string>();
  const removed = new Set<string>();
  let flushing = false;
  let stopped = false;
  let cursor: Cursor | undefined;
  /** The invalidation (`epoch:seq`) each query last took. */
  const taken = new WeakMap<Query, string>();
  let transport: Transport | undefined;

  /** Every query invalid; the active ones refetch. */
  const invalidateAll = (): void => {
    void client.invalidateQueries();
  };

  /** Takes a cursor the server sent: another epoch than the one kept invalidates everything. */
  const moveTo = (next: Cursor, replace: boolean): void => {
    if (cursor !== undefined && cursor.epoch !== next.epoch) {
      cursor = next;
      invalidateAll();
      return;
    }
    cursor =
      replace || cursor === undefined
        ? next
        : { epoch: next.epoch, seq: Math.max(cursor.seq, next.seq) };
  };

  const handlers = {
    hello(data: unknown): void {
      const next = asCursor(data);
      if (next !== undefined) moveTo(next, false);
    },
    gap(data: unknown): void {
      const next = asCursor(data);
      if (next === undefined) return;
      cursor = next;
      invalidateAll();
    },
    invalidate(data: unknown): void {
      const next = asCursor(data);
      const tags = (data as { tags?: unknown } | null)?.tags;
      if (next === undefined || !Array.isArray(tags)) return;
      const epochMoved = cursor !== undefined && cursor.epoch !== next.epoch;
      moveTo(next, false);
      if (epochMoved) return;
      const key = `${next.epoch}:${next.seq}`;
      const wanted = new Set(tags.filter((tag) => typeof tag === "string"));
      // Chosen first, then invalidated: `invalidateQueries` runs its
      // predicate twice (to mark, then to refetch).
      const hits = client.getQueryCache().findAll({
        predicate: (query) =>
          taken.get(query) !== key &&
          tagsOf(client, query).some((tag) => wanted.has(tag)),
      });
      if (hits.length === 0) return;
      for (const query of hits) taken.set(query, key);
      const set = new Set(hits);
      void client.invalidateQueries({ predicate: (query) => set.has(query) });
    },
  };

  /** Sends the changes of this task, once it ends. */
  const schedule = (): void => {
    if (flushing) return;
    flushing = true;
    queueMicrotask(() => {
      flushing = false;
      if (stopped || (added.size === 0 && removed.size === 0)) return;
      const plus = [...added];
      const minus = [...removed];
      added.clear();
      removed.clear();
      transport?.changed(plus, minus);
    });
  };

  const hold = (tag: string): void => {
    const count = (refs.get(tag) ?? 0) + 1;
    refs.set(tag, count);
    if (count === 1 && !removed.delete(tag)) added.add(tag);
  };
  const release = (tag: string): void => {
    const count = (refs.get(tag) ?? 0) - 1;
    if (count > 0) {
      refs.set(tag, count);
      return;
    }
    refs.delete(tag);
    if (!added.delete(tag)) removed.add(tag);
  };

  /** Brings `query`'s held tags up to date: its tags while it has an observer, none otherwise. */
  const sync = (query: Query, gone = false): void => {
    const hash = query.queryHash;
    const before = holders.get(hash);
    const now: ReadonlySet<string> =
      !gone && query.getObserversCount() > 0
        ? new Set(tagsOf(client, query))
        : new Set();
    if (before === undefined && now.size === 0) return;
    for (const tag of now) if (!before?.has(tag)) hold(tag);
    for (const tag of before ?? []) if (!now.has(tag)) release(tag);
    if (now.size === 0) holders.delete(hash);
    else holders.set(hash, now);
    schedule();
  };

  const cache = client.getQueryCache();
  for (const query of cache.getAll()) sync(query);
  const unsubscribe = cache.subscribe((event) => {
    if (event.type === "observerResultsUpdated") return;
    sync(event.query as Query, event.type === "removed");
  });

  /** The SSE transport: one stream over the held tags, reopened when one is added. */
  const viaSse = async (): Promise<Transport> => {
    const { sse } = await import("./sse");
    let stream: EventStream<Record<string, unknown>> | undefined;
    const open = (): void => {
      const previous = stream;
      stream = undefined;
      previous?.close();
      if (stopped || refs.size === 0) return;
      const lastEventId =
        previous?.lastEventId ||
        (cursor === undefined ? undefined : `${cursor.epoch}:${cursor.seq}`);
      const opened = (
        sse as unknown as (
          api: LiveApi,
          key: string,
          options: object,
        ) => EventStream<Record<string, unknown>>
      )(api, LIVE_SSE_KEY, {
        query: { tag: [...refs.keys()] },
        ...(lastEventId ? { lastEventId } : {}),
      });
      stream = opened;
      opened.on("invalidate", (data: unknown) => handlers.invalidate(data));
      opened.on("gap", (data: unknown) => handlers.gap(data));
      opened.on("hello", (data: unknown) => handlers.hello(data));
      opened.closed.catch((error: unknown) => {
        if (stream === opened)
          logger.error("live(): the live stream ended", error);
      });
    };
    open();
    return {
      changed(plus, minus) {
        // A dropped tag can wait for the next reopen; an added one cannot.
        if (plus.length > 0 || (minus.length > 0 && refs.size === 0)) open();
      },
      close: () => {
        const last = stream;
        stream = undefined;
        last?.close();
      },
    };
  };

  /** The WebSocket transport; falls back to SSE when the socket never opens. */
  const viaChannel = async (): Promise<Transport> => {
    const { channel } = await import("./channel");
    let everOpened = false;
    const room: ChannelClient<LiveEntry> = channel(api, LIVE_CHANNEL, {
      async resubscribe(r) {
        // Subscribe first, then resume from the cursor kept before the
        // drop: the server replays what was missed for every tag held (an
        // invalidation also heard live meanwhile is taken once, by its seq).
        const from = cursor;
        for (const part of chunked([...refs.keys()]))
          handlers.hello(await r.request("subscribe", { tags: part }));
        // A hello of another epoch has already invalidated everything.
        if (from !== undefined && cursor?.epoch === from.epoch)
          handlers.hello(await r.request("resume", from));
      },
    });
    room.on("invalidate", (data) => handlers.invalidate(data));
    room.on("gap", (data) => handlers.gap(data));
    room.on("hello", (data) => handlers.hello(data));
    const own: { -readonly [K in keyof Transport]: Transport[K] } = {
      changed(plus, minus) {
        if (room.state !== "open") return; // the next open subscribes them all
        if (minus.length > 0)
          for (const part of chunked(minus))
            room.send("unsubscribe", { tags: part });
        for (const part of chunked(plus))
          room.request("subscribe", { tags: part }).then(
            (data) => handlers.hello(data),
            (error: unknown) =>
              logger.warn("live(): a subscribe failed", error),
          );
      },
      close: () => room.close(),
    };
    // The channel says "connecting" until its first open, however many
    // attempts fail; one that has not opened by the deadline (a proxy that
    // refuses upgrades, a platform whose sockets cannot reach the server)
    // gives way to the SSE fallback.
    const deadline = setTimeout(() => {
      if (everOpened || stopped || transport !== own) return;
      room.close();
      logger.warn(
        `live(): the live channel did not open within ${OPEN_DEADLINE_MS} ms; using its SSE fallback`,
      );
      void viaSse().then((next) => {
        if (stopped) next.close();
        else transport = next;
      });
    }, OPEN_DEADLINE_MS);
    room.on("$state", (state) => {
      if (state !== "open") return;
      everOpened = true;
      clearTimeout(deadline);
    });
    const close = own.close;
    own.close = () => {
      clearTimeout(deadline);
      close();
    };
    return own;
  };

  const useSse =
    options.transport === "sse" ||
    (options.transport === undefined &&
      typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "function");
  void (useSse ? viaSse() : viaChannel()).then(
    (started) => {
      if (stopped) started.close();
      else transport ??= started;
    },
    (error: unknown) => logger.error("live(): could not start", error),
  );

  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    transport?.close();
  };
}
