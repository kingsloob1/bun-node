/**
 * A broadcast channel over the §16 writer: express-sse's conveniences (an
 * initial state for new subscribers, a list sent as one event per item, a
 * ready route handler) on top of `sse()`'s guarantees. Prototype only; names
 * are proposals (channel-README.md, "Names").
 *
 * One `send()` encodes once and enqueues the same bytes on every subscriber
 * without awaiting any of them, so a client that stopped reading is dropped
 * by its own writer's `maxQueuedBytes` and stalls nobody else.
 *
 * `CHANNEL_MUTATE=<name>[,…]` plants one bug per name, for the tests'
 * negative controls (channel-controls.ts). Not part of the design.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { SseMessage, SseStreamOptions } from "./prototype-sse";
import { encodeSseEvent, sse, sseResponse } from "./prototype-sse";

const MUTATE = new Set((process.env.CHANNEL_MUTATE ?? "").split(",").filter(Boolean));
const HEARTBEAT = encodeSseEvent({ comment: "" });

/** What the channel needs of a writer: `sse()`'s `SseStream` satisfies it. */
export interface SseChannelWriter {
  /** Enqueues encoded bytes; the channel never awaits the result. */
  send: (bytes: Uint8Array) => unknown;
  /** True once closed by either side. */
  readonly closed: boolean;
  /** Runs `fn` once the writer closes. */
  onClose: (fn: () => void) => void;
  /** Ends the stream. */
  close: () => void;
}

/** Passed to a function `initial`, so it can tailor (or mark) the snapshot. */
export interface SseInitialContext {
  /** `"none"` for a new client, `"miss"` when its `Last-Event-ID` could not be replayed. */
  replay: "none" | "miss";
  /** The client's `Last-Event-ID`, if it sent one. */
  lastEventId?: string;
  /** The subscriber's topics (empty: broadcasts only). */
  topics: ReadonlySet<string>;
}

/** What one event looks like on a cross-process transport. */
export interface SseTransportEnvelope {
  /** The publishing channel instance, so it can ignore its own echo. */
  origin: string;
  /** The event, its `id` already assigned. JSON-serialisable. */
  message: SseMessage;
  /** The event's topic; absent for a broadcast. */
  topic?: string;
}

/** Cross-process fan-out: the channel publishes each local send and delivers each remote one. */
export interface SseChannelTransport {
  /** Publishes one event to every other process. */
  publish: (envelope: SseTransportEnvelope) => void | Promise<void>;
  /** Starts delivery of other processes' events; returns the unsubscribe. */
  subscribe: (listener: (envelope: SseTransportEnvelope) => void) => () => void;
}

/** {@link createSseChannel}'s options. */
export interface SseChannelOptions {
  /** Sent to each new subscriber first (express-sse's `initial`); a function is called per subscriber. */
  initial?: SseMessage[] | ((ctx: SseInitialContext) => SseMessage[] | Promise<SseMessage[]>);
  /** Keep the last N events for `Last-Event-ID` resumption; ids are assigned when absent. Default 0 (off). */
  replay?: number;
  /** One shared heartbeat comment for every subscriber, ms; `0` disables. Default 15 000. */
  heartbeatMs?: number;
  /** Options for each subscriber's writer (`maxQueuedBytes`, `highWaterMark`, `open`). */
  writer?: Omit<SseStreamOptions, "signal" | "heartbeatMs">;
  /** Cross-process fan-out. Default: none (process-local). */
  transport?: SseChannelTransport;
  /** Prefix of assigned ids; default a per-instance epoch, so a restarted process never reuses one. */
  idPrefix?: string;
  /** Topic routing: an index of topic → subscribers, or a scan of all of them. Prototype comparison only. Default `"index"`. */
  routing?: "index" | "scan";
  /** The encoder (tests count its calls). Default `encodeSseEvent`. */
  encode?: (message: SseMessage) => Uint8Array;
  /** Builds a subscriber's writer. Default the prototype `sse()`. */
  createWriter?: (req: BunRequest, res: BunResponse, opts: SseStreamOptions) => SseChannelWriter;
  /** Called with a transport publish error. Default: ignored. */
  onError?: (error: unknown) => void;
}

/** Per-subscriber options. */
export interface SseSubscribeOptions {
  /** Topics to receive besides broadcasts. Default none. */
  topics?: Iterable<string>;
  /** Overrides the request's `Last-Event-ID`. */
  lastEventId?: string;
}

/** How a subscriber started: fresh, replayed after its id, already current, or not replayable. */
export type SseReplayOutcome = "none" | "hit" | "current" | "miss";

/** One registered subscriber. */
export interface SseSubscription {
  /** Its writer (absent for a `listen()` subscriber). */
  readonly writer?: SseChannelWriter;
  /** How it started; on `"hit"`, `replayed` events were sent. */
  readonly replay: SseReplayOutcome;
  /** Events replayed from the buffer. */
  readonly replayed: number;
  /** Settles once the initial state or replay has been queued. */
  readonly ready: Promise<void>;
  /** Removes the subscriber (the writer stays open). */
  unsubscribe: () => void;
}

interface Entry { message: SseMessage; bytes: Uint8Array; topic?: string }
interface Sink {
  bytes?: (b: Uint8Array) => unknown;
  message?: (m: SseMessage) => void;
  topics: Set<string>;
  held: Entry[] | null;
  end: () => void;
}

/** A process-local broadcast hub of SSE subscribers. */
export class SseChannel {
  readonly #o: SseChannelOptions;
  readonly #encode: (m: SseMessage) => Uint8Array;
  readonly #sinks = new Set<Sink>();
  readonly #byTopic = new Map<string, Set<Sink>>();
  readonly #ring: Entry[] = [];
  readonly #origin = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  #seq = 0;
  #initial: SseChannelOptions["initial"];
  /** A static initial state, encoded once when set. */
  #initialEntries: Entry[] | undefined;
  #closed = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #unsubscribeTransport: (() => void) | undefined;

  constructor(options: SseChannelOptions = {}) {
    this.#o = options;
    this.#encode = options.encode ?? encodeSseEvent;
    this.setInitial(options.initial);
    const hb = options.heartbeatMs ?? 15_000;
    if (hb > 0) this.#timer = setInterval(() => this.#each(undefined, (s) => s.bytes?.(HEARTBEAT)), hb).unref();
    this.#unsubscribeTransport = options.transport?.subscribe((env) => {
      if ((env.origin !== this.#origin || MUTATE.has("no-origin-check")) && !this.#closed) this.#deliver([this.#remember(env.message, env.topic)]);
    });
  }

  /** Subscribers registered now. */
  get size(): number { return this.#sinks.size; }
  /** True after `close()`. */
  get closed(): boolean { return this.#closed; }

  /** Opens `res.sse()` (the prototype `sse()`), registers it, and removes it on close. Answers 204 once closed. */
  subscribe(req: BunRequest, res: BunResponse, opts: SseSubscribeOptions = {}): SseSubscription | undefined {
    if (this.#closed) {
      void res.status(204).end();
      return undefined;
    }
    const make = this.#o.createWriter ?? sse;
    const writer = make(req, res, { ...this.#o.writer, heartbeatMs: 0 });
    const sub = this.attach(writer, { lastEventId: req.get("last-event-id") ?? undefined, ...opts });
    // A planted bug: unsubscribe on the request's abort (Node's req.on("close") idiom) instead of the writer's close.
    if (MUTATE.has("unsubscribe-on-signal")) req.request.signal.addEventListener("abort", () => sub.unsubscribe());
    return sub;
  }

  /** A route handler: `app.get("/events", channel.handler())`. `topics` may read the request. */
  handler(opts: { topics?: Iterable<string> | ((req: BunRequest) => Iterable<string>) } = {}): (req: BunRequest, res: BunResponse) => void {
    return (req, res) => void this.subscribe(req, res, { topics: typeof opts.topics === "function" ? opts.topics(req) : opts.topics });
  }

  /** For a native route or `Bun.serve`'s `fetch`: a streaming `Response` subscribed to the channel. */
  response(request: Request, init: SseSubscribeOptions & { server?: Bun.Server<unknown> } = {}): Response {
    if (this.#closed) return new Response(null, { status: 204 });
    const lastEventId = init.lastEventId ?? request.headers.get("last-event-id") ?? undefined;
    return sseResponse((w) => void this.attach(w, { ...init, lastEventId }), { ...this.#o.writer, request, server: init.server, heartbeatMs: 0 });
  }

  /** Registers any writer. The primitive under `subscribe()` and `response()`. */
  attach(writer: SseChannelWriter, opts: SseSubscribeOptions = {}): SseSubscription {
    const sink: Sink = { bytes: (b) => writer.send(b), topics: new Set(opts.topics), held: null, end: () => writer.close() };
    const sub = this.#add(sink, opts.lastEventId, writer);
    if (!MUTATE.has("no-unsubscribe") && !MUTATE.has("unsubscribe-on-signal")) writer.onClose(() => this.#remove(sink));
    return sub;
  }

  /** A message-level subscriber, for adapters that format events themselves (Nest's `@Sse()`). */
  listen(fn: (message: SseMessage) => void, opts: SseSubscribeOptions & { onEnd?: () => void } = {}): SseSubscription {
    return this.#add({ message: fn, topics: new Set(opts.topics), held: null, end: () => opts.onEnd?.() }, opts.lastEventId);
  }

  /** Encodes once and enqueues on every matching subscriber; never awaits one. Returns how many it reached. */
  send(message: SseMessage, opts: { topic?: string } = {}): number {
    if (this.#closed) return 0;
    const entry = this.#remember(message, opts.topic);
    this.#publish(entry);
    return this.#deliver([entry]);
  }

  /** express-sse's `serialize`: one event per item, delivered as one chunk, in order. */
  sendList(items: readonly unknown[], opts: { event?: string; topic?: string } = {}): number {
    if (this.#closed || items.length === 0) return 0;
    const list = MUTATE.has("sendlist-reverse") ? [...items].reverse() : items;
    const entries = list.map((data) => this.#remember({ data, event: opts.event }, opts.topic));
    for (const e of entries) this.#publish(e);
    return this.#deliver(entries);
  }

  /** express-sse's `updateInit`. */
  setInitial(initial: SseChannelOptions["initial"]): void {
    this.#initial = initial;
    this.#initialEntries = Array.isArray(initial) ? initial.map((m) => ({ message: m, bytes: this.#encode(m) })) : undefined;
  }

  /** express-sse's `dropInit`. */
  clearInitial(): void {
    this.setInitial(undefined);
  }

  /** Ends every subscriber and refuses new ones (204, which stops `EventSource` reconnecting). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#unsubscribeTransport?.();
    const sinks = [...this.#sinks];
    this.#sinks.clear();
    this.#byTopic.clear();
    if (!MUTATE.has("close-no-end")) for (const s of sinks) s.end();
  }

  #remember(message: SseMessage, topic?: string): Entry {
    const replay = this.#o.replay ?? 0;
    const m = replay > 0 && message.id === undefined ? { ...message, id: `${MUTATE.has("plain-ids") ? "" : (this.#o.idPrefix ?? `${this.#origin}.`)}${++this.#seq}` } : message;
    const entry: Entry = { message: m, bytes: this.#encode(m), topic };
    if (replay > 0) {
      this.#ring.push(entry);
      if (this.#ring.length > replay) this.#ring.shift();
    }
    return entry;
  }

  #publish(entry: Entry): void {
    const t = this.#o.transport;
    if (!t) return;
    try {
      void Promise.resolve(t.publish({ origin: this.#origin, message: entry.message, topic: entry.topic })).catch((e) => this.#o.onError?.(e));
    } catch (error) {
      this.#o.onError?.(error);
    }
  }

  /** Visits the subscribers an event with `topic` reaches (all of them for a broadcast). */
  #each(topic: string | undefined, fn: (s: Sink) => void): number {
    let n = 0;
    const visit = (s: Sink): void => {
      fn(s);
      n++;
    };
    if (topic === undefined || MUTATE.has("topics-leak")) this.#sinks.forEach(visit);
    else if (this.#o.routing === "scan") this.#sinks.forEach((s) => s.topics.has(topic) && visit(s));
    else this.#byTopic.get(topic)?.forEach(visit);
    return n;
  }

  #deliver(entries: Entry[]): number {
    const topic = entries[0].topic;
    const one = entries.length === 1 ? entries[0].bytes : concat(entries.map((e) => e.bytes));
    if (MUTATE.has("await-each")) {
      const targets: Sink[] = [];
      const n = this.#each(topic, (s) => targets.push(s));
      void (async () => { for (const s of targets) await s.bytes?.(one); })();
      return n;
    }
    return this.#each(topic, (s) => {
      if (s.held) s.held.push(...entries);
      else if (s.bytes) s.bytes(MUTATE.has("encode-per-sink") ? concat(entries.map((e) => this.#encode(e.message))) : one);
      else for (const e of entries) s.message?.(e.message);
    });
  }

  #push(s: Sink, entries: Entry[]): void {
    const mine = entries.filter((e) => e.topic === undefined || s.topics.has(e.topic));
    if (mine.length === 0) return;
    if (s.bytes) s.bytes(concat(mine.map((e) => e.bytes)));
    else for (const e of mine) s.message?.(e.message);
  }

  #add(sink: Sink, lastEventId: string | undefined, writer?: SseChannelWriter): SseSubscription {
    let replay: SseReplayOutcome = lastEventId === undefined ? "none" : "miss";
    let backlog: Entry[] = [];
    if (lastEventId !== undefined) {
      const i = this.#ring.findLastIndex((e) => String(e.message.id) === lastEventId);
      if (i >= 0) {
        backlog = this.#ring.slice(MUTATE.has("replay-include-last") ? i : i + 1);
        replay = backlog.length > 0 ? "hit" : "current";
      }
    }
    this.#sinks.add(sink);
    for (const t of sink.topics) {
      let set = this.#byTopic.get(t);
      if (!set) this.#byTopic.set(t, (set = new Set()));
      set.add(sink);
    }
    let ready = Promise.resolve();
    if (replay === "hit" || replay === "current") this.#push(sink, backlog);
    else if (replay === "miss" && MUTATE.has("miss-sends-buffer")) this.#push(sink, this.#ring);
    else if (this.#initial) {
      const init = this.#initial;
      const ctx: SseInitialContext = { replay, lastEventId, topics: sink.topics };
      if (typeof init !== "function") this.#push(sink, this.#initialEntries ?? []);
      else {
        if (!MUTATE.has("initial-unheld")) sink.held = [];
        const release = (msgs: SseMessage[]): void => {
          const held = sink.held ?? [];
          sink.held = null;
          if (this.#sinks.has(sink)) this.#push(sink, [...msgs.map((m) => ({ message: m, bytes: this.#encode(m) })), ...held]);
        };
        // A failed snapshot is reported and skipped; the live events held meanwhile still go out.
        ready = Promise.resolve().then(() => init(ctx)).then(release, (error: unknown) => {
          this.#o.onError?.(error);
          release([]);
        });
      }
    }
    return { writer, replay, replayed: replay === "hit" ? backlog.length : 0, ready, unsubscribe: () => this.#remove(sink) };
  }

  #remove(sink: Sink): void {
    if (!this.#sinks.delete(sink)) return;
    for (const t of sink.topics) {
      const set = this.#byTopic.get(t);
      set?.delete(sink);
      if (set?.size === 0) this.#byTopic.delete(t);
    }
  }
}

/** Creates a channel. */
export function createSseChannel(options: SseChannelOptions = {}): SseChannel {
  return new SseChannel(options);
}

/** An in-memory bus standing in for Redis/NATS/Postgres LISTEN: each `transport()` is one "process". */
export function createMemoryBus(): { transport: () => SseChannelTransport } {
  const listeners = new Set<(e: SseTransportEnvelope) => void>();
  return {
    transport: () => ({
      publish: (env) => {
        const copy = JSON.parse(JSON.stringify(env)) as SseTransportEnvelope; // what a wire would do
        queueMicrotask(() => { for (const l of listeners) l(copy); });
      },
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    }),
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
