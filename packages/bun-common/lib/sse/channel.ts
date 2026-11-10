/**
 * `createSseChannel()`: a broadcast channel of event streams
 * (bun-native-routes plan §16.14, PR-sse2b), express-sse's conveniences on
 * top of {@link SseWriter}'s guarantees:
 *
 * - **Initial state** for each new subscriber (express-sse's `initial`,
 *   `updateInit`, `dropInit`), sent to that subscriber alone, before any live
 *   event, also when it is computed asynchronously (live events wait for it).
 * - **One encode per event.** `send()` encodes once and queues the same
 *   bytes on every subscriber's writer **without awaiting any**, so a client
 *   that stopped reading stalls nobody else; its own writer's
 *   `maxQueuedBytes` disconnects it, and the channel forgets it.
 * - **Replay** (`replay: N`, off by default): the last N events are kept,
 *   and a subscriber whose `Last-Event-ID` is among them gets the later ones
 *   instead of the initial state. An id that is not (too old, another
 *   process's, garbage) is a miss: the initial state, never part of the
 *   buffer, which would hide a gap. Ids are matched as exact strings; the
 *   ids the channel assigns carry a per-instance prefix, so a restarted
 *   process never matches an old one.
 * - **Topics**: a send with a `topic` reaches that topic's subscribers
 *   (an index, so its cost follows its recipients); one without reaches all;
 *   a subscriber with no topics gets broadcasts only.
 * - **One heartbeat** timer for the channel, not one per subscriber.
 * - **Across processes**, through a transport the deployment provides
 *   ({@link SseChannelTransport}): each local send is delivered at once and
 *   published; remote ones are delivered and kept for replay with their
 *   sender's id.
 * - **`close()`** ends every subscriber; later ones get `204`, which tells
 *   `EventSource` to stop reconnecting.
 *
 * Browser-safe: the writer, the format and the contract core only. Nothing
 * runs at load: a channel's timer and transport start with the channel.
 */
import type { Logger, LoggerLike } from "../logging";
import type { SseMessage } from "./format";
import type { SseIdleTimeoutServer } from "./response";
import type { SseWriterOptions, SseWriter } from "./writer";
import { isPromiseLike } from "../contract/model";
import { resolveLogger } from "../logging";
import { encodeSseEvent } from "./format";
import { sseResponse } from "./response";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What a function `initial` is told about the subscriber it is for. */
export interface SseInitialContext {
  /**
   * `"none"`: a new client (no `Last-Event-ID`). `"miss"`: it sent a
   * `Last-Event-ID` the channel cannot replay from (older than the buffer,
   * another process's, or replay is off), so it may have missed events: the
   * initial state can say so (prepend a `reset` event, send a fuller
   * snapshot).
   */
  readonly replay: "none" | "miss";
  /** The client's `Last-Event-ID`, when it sent one. */
  readonly lastEventId?: string;
  /** The subscriber's topics; empty for broadcasts only. */
  readonly topics: ReadonlySet<string>;
}

/**
 * A channel's initial state: the events each new subscriber gets first, or
 * a function of the subscriber returning them (possibly asynchronously).
 */
type SseInitial =
  | readonly SseMessage[]
  | ((
      context: SseInitialContext,
    ) => readonly SseMessage[] | PromiseLike<readonly SseMessage[]>);

/** One event as a transport carries it between processes. */
export interface SseTransportEnvelope {
  /** The publishing channel instance, so it ignores its own echo. */
  readonly origin: string;
  /** The event, its `id` already assigned (when the sender's `replay` is on). JSON-serialisable. */
  readonly message: SseMessage;
  /** The event's topic; absent for a broadcast. */
  readonly topic?: string;
}

/**
 * A bus between the processes serving one channel (Redis pub/sub, Postgres
 * `LISTEN`, NATS, …): the channel publishes each local send and delivers
 * each remote one. Ordering is each receiver's arrival order, which the bus
 * defines.
 */
export interface SseChannelTransport {
  /** Publishes one event to the other processes. A rejection goes to the channel's `onError`. */
  publish: (envelope: SseTransportEnvelope) => void | PromiseLike<void>;
  /** Starts delivering the other processes' events (its own may come back too); returns the unsubscribe. */
  subscribe: (listener: (envelope: SseTransportEnvelope) => void) => () => void;
}

/** {@link createSseChannel}'s options. */
export interface SseChannelOptions {
  /**
   * The events each new subscriber gets first, before any live one: a list
   * (encoded once), or a function of the subscriber ({@link SseInitialContext}),
   * possibly asynchronous; live events wait for it. A throw or rejection goes
   * to {@link onError}, and the live events still go out. Not part of the
   * replay buffer. Default: none.
   */
  readonly initial?: SseInitial;
  /**
   * How many of the last events to keep for `Last-Event-ID` resumption.
   * With a count, events sent without an `id` get one
   * (`<idPrefix><n>`). A count, not a byte bound: the buffer holds that many
   * encoded events. Default `0` (off; ids are only those given).
   */
  readonly replay?: number;
  /**
   * The ms between heartbeat comments (`:`), one timer for the whole
   * channel, skipped after an interval in which a broadcast was sent; `0`
   * turns them off. The subscribers' own writers send none. Default
   * `15_000`.
   */
  readonly heartbeatMs?: number;
  /**
   * The options of each subscriber's writer (`maxQueuedBytes`,
   * `highWaterMark`, `open`, `retry`, `compress`, `logger`). The channel
   * owns ids, replay and the heartbeat, so `ids`, `resume` and `heartbeatMs`
   * are not taken; nor is `contract`: the channel sends encoded bytes.
   * Default: the writer's defaults.
   */
  readonly writer?: Omit<
    SseWriterOptions,
    "contract" | "validation" | "ids" | "resume" | "heartbeatMs" | "onError"
  >;
  /** Carries events between processes ({@link SseChannelTransport}). Default: none (process-local). */
  readonly transport?: SseChannelTransport;
  /**
   * The prefix of the ids the channel assigns (with `replay`). Default: one
   * per channel instance (its creation time and a random part, then `.`), so
   * an id from before a restart never matches a new event.
   */
  readonly idPrefix?: string;
  /**
   * Called with an error of a function `initial`, a transport's `publish`,
   * a `listen()` listener, or a writer that refused the channel's bytes
   * (which is then closed and dropped). Default: logged (with
   * `writer.logger`, or a console logger).
   */
  readonly onError?: (error: unknown) => void;
}

/** How one subscriber joins: its topics, and the `Last-Event-ID` to resume from. */
export interface SseSubscribeOptions {
  /** The topics it receives besides broadcasts. Default: none (broadcasts only). */
  readonly topics?: Iterable<string>;
  /**
   * The `Last-Event-ID` to resume from. Default: the request's
   * (`subscribe()`, `response()`) or the writer's (`attach()`).
   */
  readonly lastEventId?: string;
}

/** How a subscriber started. */
export type SseReplayOutcome = "none" | "hit" | "current" | "miss";

/** One subscriber of a channel. */
export interface SseSubscription {
  /** Its writer; `undefined` for a {@link SseChannel.listen} subscriber. */
  readonly writer?: SseWriter;
  /**
   * `"none"`: no `Last-Event-ID`, so the initial state. `"hit"`: the id was
   * in the buffer, and the {@link replayed} later events were sent instead
   * of the initial state. `"current"`: the id is the newest event, so
   * nothing was. `"miss"`: an id the buffer does not hold, so the initial
   * state (told so, {@link SseInitialContext.replay}).
   */
  readonly replay: SseReplayOutcome;
  /** How many buffered events were replayed (`"hit"` only); `0` otherwise. */
  readonly replayed: number;
  /** Settles once the initial state (or the replay) is queued; never rejects. */
  readonly ready: Promise<void>;
  /** Removes the subscriber; its writer stays open. Safe to call more than once. */
  unsubscribe: () => void;
}

/** What {@link SseChannel.subscribe} needs of a response: bun-common's `BunResponse` has it. */
interface SseChannelResponse {
  /** Opens the event stream (`res.sse()`). */
  sse: (options?: SseWriterOptions) => SseWriter;
  /** Sets the status, for the `204` of a closed channel. */
  status: (code: number) => unknown;
  /** Ends the response, for the `204` of a closed channel. */
  end: () => unknown;
}

/** The options of {@link SseChannel.handler}. */
interface SseHandlerOptions<Req> {
  /** The subscriber's topics, or a function of the request giving them. Default: none. */
  readonly topics?: Iterable<string> | ((req: Req) => Iterable<string>);
}

/** The options of {@link SseChannel.response}: a subscriber's, plus the server to exempt. */
interface SseChannelResponseInit extends SseSubscribeOptions {
  /** The server serving the request, to exempt it from Bun's `idleTimeout` (a native route's second argument). Default: none. */
  readonly server?: SseIdleTimeoutServer;
}

/** The options of {@link SseChannel.listen}: a subscriber's, plus what to call when the channel closes. */
interface SseListenOptions extends SseSubscribeOptions {
  /** Called once if the channel closes while subscribed. Default: none. */
  readonly onEnd?: () => void;
}

/** One sent event, encoded once. */
interface Entry {
  /** The event, its id assigned. */
  readonly message: SseMessage;
  /** Its bytes. */
  readonly bytes: Uint8Array;
  /** Its topic; `undefined` for a broadcast. */
  readonly topic: string | undefined;
}

/** One registered subscriber. */
interface Sink {
  /** Queues bytes on its writer (a writer subscriber). */
  readonly bytes: ((bytes: Uint8Array) => void) | undefined;
  /** Hands it an event (a `listen()` subscriber). */
  readonly message: ((message: SseMessage) => void) | undefined;
  /** Its topics. */
  readonly topics: ReadonlySet<string>;
  /** Live events held while an asynchronous initial state is computed; `undefined` otherwise. */
  held: Entry[] | undefined;
  /** Ends it when the channel closes. */
  readonly end: () => void;
}

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------

/** The heartbeat comment, encoded once. Built on first use, so nothing runs at load. */
let heartbeatBytes: Uint8Array | undefined;

/** A settled `ready`. */
const READY: Promise<void> = Promise.resolve();

/** The default logger, made on first use. */
let defaultLogger: Logger | undefined;

/**
 * A broadcast channel of event streams. Make one with
 * {@link createSseChannel}; see the module's documentation for what it
 * guarantees.
 *
 * ```ts
 * const prices = createSseChannel({ initial: () => [{ event: "snapshot", data: book.snapshot() }], replay: 100 });
 * app.get("/prices", prices.handler());
 * prices.send({ event: "tick", data: { p: 101.5 } });
 * ```
 */
export class SseChannel {
  /** The options. */
  readonly #options: SseChannelOptions;
  /** How many events to keep; `0` keeps none. */
  readonly #replay: number;
  /** The heartbeat interval, ms; `0` sends none. */
  readonly #heartbeatMs: number;
  /** The prefix of assigned ids. */
  readonly #idPrefix: string;
  /** This instance, as a transport envelope's `origin`. */
  readonly #origin: string;
  /** Every subscriber. */
  readonly #sinks = new Set<Sink>();
  /** The subscribers of each topic. */
  readonly #byTopic = new Map<string, Set<Sink>>();
  /** The replay buffer, a ring of {@link #replay} slots. */
  readonly #ring: (Entry | undefined)[] = [];
  /** The ring's next slot. */
  #ringNext = 0;
  /** Each buffered event's slot, by id; the last occurrence of an id wins. */
  readonly #slotById = new Map<string, number>();
  /** The last assigned id's number. */
  #seq = 0;
  /** The initial state as given. */
  #initial: SseInitial | undefined;
  /** A list initial state, encoded once. */
  #initialEntries: Entry[] | undefined;
  /** Set by `close()`. */
  #closed = false;
  /** The heartbeat timer, running while there is a subscriber. */
  #timer: ReturnType<typeof setInterval> | undefined;
  /** Set by a broadcast, cleared by the heartbeat: a beat is sent only after a quiet interval. */
  #broadcastSinceBeat = false;
  /** Stops the transport's delivery. */
  readonly #stopTransport: (() => void) | undefined;
  /** The logger, resolved on first use. */
  #logger: Logger | undefined;

  /**
   * @param options The channel's options ({@link SseChannelOptions}). A
   *   negative or fractional `replay`, or a negative `heartbeatMs`, throws a
   *   `TypeError`.
   */
  constructor(options: SseChannelOptions = {}) {
    const replay = options.replay ?? 0;
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    if (!Number.isSafeInteger(replay) || replay < 0) {
      throw new TypeError(
        "SseChannel: replay must be a non-negative integer (an event count)",
      );
    }
    if (!Number.isFinite(heartbeatMs) || heartbeatMs < 0) {
      throw new TypeError(
        "SseChannel: heartbeatMs must be a non-negative number",
      );
    }
    this.#options = options;
    this.#replay = replay;
    this.#heartbeatMs = heartbeatMs;
    this.#origin = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.#idPrefix = options.idPrefix ?? `${this.#origin}.`;
    this.setInitial(options.initial);
    this.#stopTransport = options.transport?.subscribe((envelope) =>
      this.#receive(envelope),
    );
  }

  /** How many subscribers the channel has now. */
  get size(): number {
    return this.#sinks.size;
  }

  /** `true` once {@link close} was called. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Opens `res.sse()` (with the channel's `writer` options) and subscribes
   * it; the subscriber is removed when its writer closes (the client left,
   * the slow-client bound, `close()`). The `Last-Event-ID` is the
   * request's, unless `options` gives one. A closed channel answers `204`
   * and returns `undefined`.
   *
   * @param _req    The request (the writer reads its `Last-Event-ID` through `res`).
   * @param res     The response: bun-common's `BunResponse` (`@Res()` in a Nest handler).
   * @param options The subscriber's topics and `Last-Event-ID`.
   */
  subscribe(
    _req: unknown,
    res: SseChannelResponse,
    options: SseSubscribeOptions = {},
  ): SseSubscription | undefined {
    if (this.#closed) {
      res.status(204);
      res.end();
      return undefined;
    }
    const writer = res.sse({ ...this.#options.writer, heartbeatMs: 0 });
    return this.attach(writer, options);
  }

  /**
   * A route handler that subscribes each request (express-sse's `init`):
   * `app.get("/prices", channel.handler())`. `topics` may be a function of
   * the request; annotate its parameter (`(req: BunRequest) =>
   * [req.params.room]`), since the route's own type does not reach it.
   *
   * @param options The subscribers' topics.
   * @typeParam Req The request type the topics function reads, from its annotation.
   */
  handler<Req = unknown>(
    options: SseHandlerOptions<Req> = {},
  ): (req: NoInfer<Req>, res: SseChannelResponse) => void {
    const { topics } = options;
    return (req, res) => {
      this.subscribe(req, res, {
        topics: typeof topics === "function" ? topics(req) : topics,
      });
    };
  }

  /**
   * A subscribed event stream as a `Response`, for a native route or
   * `Bun.serve`'s `fetch`: `(req, server) => channel.response(req, { server
   * })`. A closed channel answers `204`.
   *
   * @param request The request: its signal ends the subscription when the client leaves, and its `Last-Event-ID` is resumed from.
   * @param init    The subscriber's topics and `Last-Event-ID`, and the server to exempt from `idleTimeout`.
   */
  response(request: Request, init: SseChannelResponseInit = {}): Response {
    if (this.#closed) return new Response(null, { status: 204 });
    const { server, ...options } = init;
    return sseResponse(
      (writer) => {
        this.attach(writer, options);
      },
      { ...this.#options.writer, heartbeatMs: 0, request, server },
    );
  }

  /**
   * Subscribes a writer you opened (the primitive under {@link subscribe}
   * and {@link response}); it is removed when the writer closes. Open it
   * with `heartbeatMs: 0`: the channel sends the heartbeat. An untyped
   * writer: the channel queues encoded bytes on it. On a closed channel the
   * writer is closed at once.
   *
   * @param writer  The writer.
   * @param options The subscriber's topics, and a `Last-Event-ID` other than the writer's.
   */
  attach(
    writer: SseWriter,
    options: SseSubscribeOptions = {},
  ): SseSubscription {
    const sink: Sink = {
      bytes: (bytes) => {
        try {
          void writer.send(bytes);
        } catch (error) {
          // A writer that refuses bytes (one with a contract, cast past
          // `attach()`'s type) is closed and dropped; the others still get
          // the event.
          this.#error(error, "subscriber's writer");
          writer.close();
          this.#remove(sink);
        }
      },
      message: undefined,
      topics: new Set(options.topics),
      held: undefined,
      end: () => writer.close(),
    };
    if (this.#closed) {
      writer.close();
      return closedSubscription(writer);
    }
    const subscription = this.#add(
      sink,
      options.lastEventId ?? writer.lastEventId,
      writer,
    );
    writer.onClose(() => this.#remove(sink));
    return subscription;
  }

  /**
   * Subscribes a function that gets each event as a message, for an adapter
   * that formats events itself (bun-nest's `channelObservable()` for
   * `@Sse()`). It gets the initial state or the replay first, as any
   * subscriber, but no heartbeat. Call `unsubscribe()` when its client
   * leaves; `onEnd` runs if the channel closes first. On a closed channel,
   * `onEnd` is called at once.
   *
   * @param listener Called with each event, in order.
   * @param options  The subscriber's topics, `Last-Event-ID` and `onEnd`.
   */
  listen(
    listener: (message: SseMessage) => void,
    options: SseListenOptions = {},
  ): SseSubscription {
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      options.onEnd?.();
    };
    if (this.#closed) {
      end();
      return closedSubscription(undefined);
    }
    return this.#add(
      {
        bytes: undefined,
        message: (message) => {
          try {
            listener(message);
          } catch (error) {
            // One listener's throw never keeps the event from the others.
            this.#error(error, "listener");
          }
        },
        topics: new Set(options.topics),
        held: undefined,
        end,
      },
      options.lastEventId,
      undefined,
    );
  }

  /**
   * Sends one event to every subscriber of `topic` (every subscriber, for
   * none), encoding it once and awaiting none. With `replay`, an event
   * without an `id` gets one, and the event is kept; with a transport, it is
   * published. Returns how many subscribers it was handed to (`0` once
   * closed). Throws a `TypeError` for a malformed event, as
   * `formatSseEvent` does, before anything is sent.
   *
   * @param message The event.
   * @param options Its topic.
   */
  send(message: SseMessage, options: { readonly topic?: string } = {}): number {
    if (this.#closed) return 0;
    const entry = this.#prepare(message, options.topic);
    this.#keep(entry);
    this.#publish(entry);
    return this.#deliver([entry]);
  }

  /**
   * Sends one event per item (express-sse's `serialize`), in order, as one
   * chunk per subscriber: each item is an event's `data`, under one `event`
   * name and `topic`. Returns how many subscribers they were queued for.
   *
   * @param items   The events' data.
   * @param options Their `event` name and topic.
   */
  sendList(
    items: readonly unknown[],
    options: { readonly event?: string; readonly topic?: string } = {},
  ): number {
    if (this.#closed || items.length === 0) return 0;
    // Every item is encoded before any is kept or sent: a malformed one
    // throws with nothing sent.
    const entries = items.map((data, index) =>
      this.#prepare({ event: options.event, data }, options.topic, index),
    );
    for (const entry of entries) {
      this.#keep(entry);
      this.#publish(entry);
    }
    return this.#deliver(entries);
  }

  /**
   * Replaces the initial state new subscribers get (express-sse's
   * `updateInit`); subscribers already connected are not sent it.
   *
   * @param initial The events, or a function of the subscriber; `undefined` for none.
   */
  setInitial(initial: SseInitial | undefined): void {
    this.#initial = initial;
    this.#initialEntries =
      typeof initial === "function" || initial === undefined
        ? undefined
        : initial.map((message) => this.#entry(message, undefined));
  }

  /** Drops the initial state (express-sse's `dropInit`). */
  clearInitial(): void {
    this.setInitial(undefined);
  }

  /**
   * Ends every subscriber (their streams end after what is queued; a
   * `listen()` subscriber's `onEnd` runs), stops the heartbeat and the
   * transport, and refuses new subscribers (`204`). Safe to call more than
   * once.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopHeartbeat();
    this.#stopTransport?.();
    const sinks = [...this.#sinks];
    this.#sinks.clear();
    this.#byTopic.clear();
    for (const sink of sinks) sink.end();
  }

  // -------------------------------------------------------------------------

  /** The logger. */
  #log(): Logger {
    const option: LoggerLike | undefined = this.#options.writer?.logger;
    return (this.#logger ??=
      option === undefined
        ? (defaultLogger ??= resolveLogger(undefined))
        : resolveLogger(option));
  }

  /** Reports an error of `initial` or a transport. */
  #error(error: unknown, what: string): void {
    const hook = this.#options.onError;
    if (hook === undefined) {
      this.#log().error(`an event channel's ${what} failed`, { error });
      return;
    }
    try {
      hook(error);
    } catch (thrown) {
      this.#log().error("an event channel's onError threw", { error: thrown });
    }
  }

  /** `message` encoded, as one entry. */
  #entry(message: SseMessage, topic: string | undefined): Entry {
    return { message, bytes: encodeSseEvent(message), topic };
  }

  /**
   * One event to send: its id assigned (with replay), encoded.
   *
   * @param offset Its place among events prepared together, whose ids follow on.
   */
  #prepare(message: SseMessage, topic: string | undefined, offset = 0): Entry {
    if (this.#replay === 0) return this.#entry(message, topic);
    const isEvent = message.event !== undefined || message.data !== undefined;
    return this.#entry(
      message.id === undefined && isEvent
        ? { ...message, id: `${this.#idPrefix}${this.#seq + 1 + offset}` }
        : message,
      topic,
    );
  }

  /** Keeps a prepared event for replay (and counts its assigned id). */
  #keep(entry: Entry): void {
    if (this.#replay === 0) return;
    if (entry.message.id === `${this.#idPrefix}${this.#seq + 1}`) this.#seq++;
    this.#buffer(entry);
  }

  /** Keeps `entry` in the ring, evicting the oldest. */
  #buffer(entry: Entry): void {
    const slot = this.#ringNext;
    const evicted = this.#ring[slot];
    if (evicted?.message.id !== undefined) {
      const id = String(evicted.message.id);
      if (this.#slotById.get(id) === slot) this.#slotById.delete(id);
    }
    this.#ring[slot] = entry;
    this.#ringNext = (slot + 1) % this.#replay;
    if (entry.message.id !== undefined) {
      this.#slotById.set(String(entry.message.id), slot);
    }
  }

  /** The buffered events after the one with `id`, oldest first; `undefined` when `id` is not buffered. */
  #after(id: string): Entry[] | undefined {
    const slot = this.#slotById.get(id);
    if (slot === undefined) return undefined;
    const later: Entry[] = [];
    for (let at = (slot + 1) % this.#replay; at !== this.#ringNext;) {
      const entry = this.#ring[at];
      if (entry !== undefined) later.push(entry);
      at = (at + 1) % this.#replay;
    }
    return later;
  }

  /** Publishes a local event on the transport. */
  #publish(entry: Entry): void {
    const transport = this.#options.transport;
    if (transport === undefined) return;
    const envelope: SseTransportEnvelope =
      entry.topic === undefined
        ? { origin: this.#origin, message: entry.message }
        : { origin: this.#origin, message: entry.message, topic: entry.topic };
    try {
      const published = transport.publish(envelope);
      if (isPromiseLike(published)) {
        published.then(undefined, (error: unknown) =>
          this.#error(error, "transport publish"),
        );
      }
    } catch (error) {
      this.#error(error, "transport publish");
    }
  }

  /** Delivers another process's event (and ignores this one's echo). */
  #receive(envelope: SseTransportEnvelope): void {
    if (this.#closed || envelope.origin === this.#origin) return;
    const entry = this.#entry(envelope.message, envelope.topic);
    if (this.#replay > 0) this.#buffer(entry);
    this.#deliver([entry]);
  }

  /** Queues `entries` (one topic) on every subscriber they reach; returns how many. */
  #deliver(entries: readonly Entry[]): number {
    const topic = entries[0].topic;
    const bytes =
      entries.length === 1
        ? entries[0].bytes
        : concat(entries.map((entry) => entry.bytes));
    const targets =
      topic === undefined ? this.#sinks : this.#byTopic.get(topic);
    if (targets === undefined) return 0;
    if (topic === undefined) this.#broadcastSinceBeat = true;
    // Counted first: a subscriber its own delivery removes (a slow client's
    // bound, a refusing writer) was still handed the event.
    const reached = targets.size;
    for (const sink of targets) {
      if (sink.held !== undefined) sink.held.push(...entries);
      else if (sink.bytes !== undefined) sink.bytes(bytes);
      else for (const entry of entries) sink.message?.(entry.message);
    }
    return reached;
  }

  /** Sends `sink` the entries it may see (broadcasts and its topics'). */
  #push(sink: Sink, entries: readonly Entry[]): void {
    const mine = entries.filter(
      (entry) => entry.topic === undefined || sink.topics.has(entry.topic),
    );
    if (mine.length === 0) return;
    if (sink.bytes !== undefined) {
      sink.bytes(concat(mine.map((entry) => entry.bytes)));
    } else {
      for (const entry of mine) sink.message?.(entry.message);
    }
  }

  /** Registers `sink` and sends it the replay or the initial state. */
  #add(
    sink: Sink,
    lastEventId: string | undefined,
    writer: SseWriter | undefined,
  ): SseSubscription {
    const id = lastEventId === "" ? undefined : lastEventId;
    // The buffered events after the id that this subscriber may see.
    const later =
      id === undefined || this.#replay === 0
        ? undefined
        : this.#after(id)?.filter(
            (entry) =>
              entry.topic === undefined || sink.topics.has(entry.topic),
          );
    const replay: SseReplayOutcome =
      id === undefined
        ? "none"
        : later === undefined
          ? "miss"
          : later.length > 0
            ? "hit"
            : "current";

    this.#sinks.add(sink);
    for (const topic of sink.topics) {
      let set = this.#byTopic.get(topic);
      if (set === undefined) this.#byTopic.set(topic, (set = new Set()));
      set.add(sink);
    }
    this.#startHeartbeat();

    const subscription = (ready: Promise<void>): SseSubscription => ({
      writer,
      replay,
      replayed: replay === "hit" ? later!.length : 0,
      ready,
      unsubscribe: () => this.#remove(sink),
    });

    if (later !== undefined) {
      this.#push(sink, later);
      return subscription(READY);
    }
    const initial = this.#initial;
    if (initial === undefined) return subscription(READY);
    if (typeof initial !== "function") {
      this.#push(sink, this.#initialEntries ?? []);
      return subscription(READY);
    }

    const release = (messages: readonly SseMessage[]): void => {
      const held = sink.held ?? [];
      sink.held = undefined;
      if (!this.#sinks.has(sink)) return;
      let entries: Entry[];
      try {
        entries = messages.map((message) => this.#entry(message, undefined));
      } catch (error) {
        this.#error(error, "initial state");
        entries = [];
      }
      this.#push(sink, [...entries, ...held]);
    };
    const context: SseInitialContext = {
      replay: replay === "miss" ? "miss" : "none",
      ...(id === undefined ? {} : { lastEventId: id }),
      topics: sink.topics,
    };
    let result: readonly SseMessage[] | PromiseLike<readonly SseMessage[]>;
    try {
      result = initial(context);
    } catch (error) {
      this.#error(error, "initial state");
      return subscription(READY);
    }
    if (!isPromiseLike(result)) {
      release(result);
      return subscription(READY);
    }
    // Live events wait for the snapshot, so it always goes first.
    sink.held = [];
    const ready = Promise.resolve(result).then(release, (error: unknown) => {
      this.#error(error, "initial state");
      release([]);
    });
    return subscription(ready);
  }

  /** Forgets `sink`. */
  #remove(sink: Sink): void {
    if (!this.#sinks.delete(sink)) return;
    for (const topic of sink.topics) {
      const set = this.#byTopic.get(topic);
      set?.delete(sink);
      if (set?.size === 0) this.#byTopic.delete(topic);
    }
    if (this.#sinks.size === 0) this.#stopHeartbeat();
  }

  /** Starts the heartbeat with the first subscriber. */
  #startHeartbeat(): void {
    if (this.#heartbeatMs === 0 || this.#timer !== undefined) return;
    const timer = setInterval(() => this.#beat(), this.#heartbeatMs);
    (timer as { unref?: () => void }).unref?.();
    this.#timer = timer;
  }

  /** Stops the heartbeat. */
  #stopHeartbeat(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One heartbeat to every writer subscriber, unless a broadcast went out since the last. */
  #beat(): void {
    if (this.#broadcastSinceBeat) {
      this.#broadcastSinceBeat = false;
      return;
    }
    const bytes = (heartbeatBytes ??= encodeSseEvent({ comment: "" }));
    for (const sink of this.#sinks) {
      if (sink.held === undefined) sink.bytes?.(bytes);
    }
  }
}

/** The subscription a closed channel hands out. */
function closedSubscription(writer: SseWriter | undefined): SseSubscription {
  return {
    writer,
    replay: "none",
    replayed: 0,
    ready: READY,
    unsubscribe: () => {},
  };
}

/** `parts` as one array (the same array for one part). */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * A broadcast channel of event streams (express-sse's `new SSE()`, with
 * replay, topics and a cross-process transport): see {@link SseChannel}.
 *
 * ```ts
 * import { createSseChannel } from "@kingsleyweb/bun-common/sse";
 *
 * const prices = createSseChannel({
 *   initial: async () => [{ event: "snapshot", data: await book.snapshot() }],
 *   replay: 100, // the last 100 events, for Last-Event-ID
 * });
 * app.get("/prices", prices.handler());
 * prices.send({ event: "tick", data: { p: 101.5 } }); // the number of subscribers reached
 * ```
 *
 * @param options The channel's options ({@link SseChannelOptions}).
 */
export function createSseChannel(options: SseChannelOptions = {}): SseChannel {
  return new SseChannel(options);
}
