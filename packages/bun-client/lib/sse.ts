/**
 * `@kingsleyweb/bun-client/sse`: typed, validated server-sent events
 * (typed-client plan, `sse.md`, PR-S1).
 *
 * ```ts
 * const stream = sse(api, "GET /jobs/:id/events", { params: { id } });
 * for await (const e of stream) {
 *   if (e.event === "progress") bar.set(e.data.percent); // data narrowed
 * }
 * stream.on("done", (d) => toast(d.result));
 * ```
 *
 * - **Over `fetch`, through the client** (S-D2): each connection is the
 *   client's own call (`api.request`), so its headers, auth (and refresh),
 *   middleware and request validation apply, and a refreshed token reaches
 *   the next reconnection. Never `EventSource`, which sends no custom
 *   headers (and which Bun does not have). The parser is `./sseParser`.
 * - **Resume** (S-D3): the last event ID seen goes out as `Last-Event-ID`
 *   on every reconnection (and `lastEventId` starts one).
 * - **Reconnection** (§3.2): after the server's `retry:` if it sent one,
 *   else `reconnect.initialMs` (3 s), doubling on consecutive failures to
 *   `reconnect.maxMs` (30 s), each wait between half of it and all of it;
 *   the count starts over once a connection has stayed open 60 s. A
 *   `Retry-After` header on a failed status wins. A stream the server ends
 *   is reconnected too, as `EventSource` does.
 * - **Stops** on a `204`, {@link EventStream.close}, the call's `signal`, or a
 *   status in `fatalStatuses` (every 4xx but 408 and 429; with reconnection
 *   off, any failed status): a status the route declares (or any, when the
 *   manifest lists none) ends it with the client's `HttpError`, its body
 *   read and typed; any other with {@link StreamClosedError}. A success that
 *   is not a `text/event-stream` is a {@link StreamClosedError} too.
 * - **Gap** (S-D4): an event named `gap` is delivered like any other, and
 *   `on("$gap")` fires with it.
 * - **Validation** (§3.3, TC §5.6): each event's data, by its name, under the
 *   client's, the route's and the call's `validate`, as the stream's status
 *   says (`response`, or `response[200]`): on in development, off in
 *   production; a failure warns and delivers, `"drop"` discards it and fires
 *   `on("$invalid")`, `"throw"` ends the stream with the `ValidationError`.
 *   The checks load lazily (`./validation`, and `./sseChecks` beside it),
 *   as the core client's do.
 * - **Backpressure** (§3.4): the iterator reads the body only as fast as it
 *   is consumed. Listeners (`on`) read eagerly and drop nothing; an iterator
 *   beside them then buffers what it has not taken yet.
 *
 * Browser-safe; it imports nothing of the `.` entry's client (it reaches
 * the client's configuration through the client object), so an HTTP-only
 * bundle carries none of it, and this entry none of the HTTP pipeline.
 */
import type { Jsonify } from "./jsonify";
import type {
  CallParts,
  Client,
  ClientConfig,
  ClientFlags,
  ClientMiddleware,
  FailureMode,
  RouteMap,
  ValidationConfig,
} from "./types";
import type { StreamEvent } from "./sseChecks";
import type { CallChecks, Checks } from "./validation";
import {
  ClientError,
  HttpError,
  NetworkError,
  TimeoutError,
  ValidationError,
} from "./errors";
import { retryAfterMs } from "./retry";
import { SseParser } from "./sseParser";

/** The keys of `R` that are event streams (`stream: "sse"`). */
type SseKeyOf<R> = {
  [K in keyof R]: R[K] extends { stream: "sse" } ? K : never;
}[keyof R] &
  string;

/** An entry's events by name: its `events`, else any name with `unknown` data. */
type EventsOf<E> = E extends { events: infer V extends object }
  ? V
  : Record<string, unknown>;

/** The keys of `T` whose property is required. */
type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * One event of the event map `M` as a stream delivers it: its name, its
 * `data` after JSON, and the last event ID as of it (absent when the
 * stream has set none). A union over the names, so `event` narrows `data`.
 */
type EventOf<M> = {
  [N in keyof M & string]: {
    /** The event's name (`message` for one with no `event:` line). */
    readonly event: N;
    /** Its data, decoded as the route declares (JSON by default). */
    readonly data: Jsonify<M[N]>;
    /** The last event ID as of this event; absent when there is none. */
    readonly id?: string;
  };
}[keyof M & string];

/** What `on` takes: an event's name, `"$gap"` when the stream declares a `gap` event, or `"$invalid"`. */
type ListenerName<M> =
  (keyof M & string) | ("gap" extends keyof M ? "$gap" : never) | "$invalid";

/** The listener for `name`: an event's `(data, event)`, or a `ValidationError` for `"$invalid"`. */
type Listener<M, N> = N extends "$invalid"
  ? (error: ValidationError) => void
  : N extends "$gap"
    ? Listener<M, "gap">
    : N extends keyof M & string
      ? (data: Jsonify<M[N]>, event: Extract<EventOf<M>, { event: N }>) => void
      : never;

/**
 * A typed event stream (`sse.md` §3.1): what {@link sse} returns. It
 * connects when it is first read (`for await`, or a listener).
 *
 * @typeParam M The route's events by name (a generated entry's `events`),
 *   each its data's wire type.
 */
export interface EventStream<
  M extends object = Record<string, unknown>,
> extends AsyncIterable<EventOf<M>> {
  /**
   * Calls `listener` for every event named `name`, as it is read (reading
   * eagerly from then on); `"$gap"` for the declared `gap` event, as well
   * as `"gap"`; `"$invalid"` for an event `"drop"` discarded. Returns a
   * function that removes it. A listener that throws is logged, and the
   * stream carries on.
   */
  on: <N extends ListenerName<M>>(
    name: N,
    listener: Listener<M, N>,
  ) => () => void;
  /** What a reconnection sends as `Last-Event-ID` (`""`: none): the last `id:` the stream committed. */
  readonly lastEventId: string;
  /**
   * Settles when the stream ends: fulfilled on a `204`, `close()`, or a
   * stream the server ends with reconnection off; rejected with what ended
   * it otherwise (the `signal`'s reason, an `HttpError`, a
   * {@link StreamClosedError}, a `ValidationError` under `"throw"`, a
   * `NetworkError` with reconnection off).
   */
  readonly closed: Promise<void>;
  /** Stops reading and reconnecting; the iterator ends and {@link closed} fulfils. */
  close: () => void;
}

/** Reconnection timing (`sse.md` §3.2). */
interface ReconnectConfig {
  /** The wait before the first reconnection when the server sent no `retry:`, ms. Default `3_000`. */
  initialMs?: number;
  /** The longest wait, ms (a server's `retry:` above it is still honoured). Default `30_000`. */
  maxMs?: number;
}

/**
 * Validation for a stream: the HTTP call's {@link ValidationConfig}, whose
 * `response` (or `response[status]`) switches the events' checks, plus
 * `"drop"` for a failed event.
 */
type StreamValidation = Omit<ValidationConfig, "onFailure"> & {
  /**
   * What a failure does: as the HTTP call's, plus, for the events,
   * `"drop"`: discard the event and fire `on("$invalid")`. Default:
   * `{ request: "throw", response: "warn" }`.
   */
  onFailure?:
    | FailureMode
    | {
        /** For a request part. Default `"throw"`. */
        request?: FailureMode;
        /** For an event (and an error status's body). Default `"warn"`. */
        response?: FailureMode | "drop";
      };
};

/** A stream's options beside the route's typed parts. */
interface StreamConfig {
  /** Ends the stream; it rejects with the signal's reason. Default: none. */
  signal?: AbortSignal;
  /** Milliseconds each connection may take to answer (not to stream); `false` for none. Default: the client's. */
  timeout?: number | false;
  /** Middleware for the stream's requests, inside the client's and the route's. Default: none. */
  middleware?: readonly ClientMiddleware[];
  /**
   * Validation for this stream, merged per key over the client's and the
   * route's (TC §6.2); `false` turns it all off. Default: theirs.
   */
  validate?: StreamValidation | false;
  /** The `Last-Event-ID` to send on the first connection (a stream resumed across page loads). Default: none. */
  lastEventId?: string;
  /** Reconnection timing; `false`: a stream that ends stays ended. Default: see {@link ReconnectConfig}. */
  reconnect?: ReconnectConfig | false;
  /**
   * The server's heartbeat interval, ms: with no byte for twice it plus 5 s
   * (a comment counts), the connection is dropped and reconnected.
   * Default: none (no watchdog).
   */
  heartbeatMs?: number;
  /**
   * Statuses that end the stream instead of reconnecting (a `2xx` other
   * than `204` never does). Default: every 4xx but 408 and 429.
   */
  fatalStatuses?: readonly number[];
  /**
   * How each event's `data` is decoded: `"json"` parses it (data that does
   * not parse is delivered as its text, and is a validation issue), `"text"`
   * delivers it as it is; as bun-common's `sse(events, { data })`. Default
   * `"json"`.
   */
  data?: "json" | "text";
}

/** A stream's options for entry `E`: its typed parts plus {@link StreamConfig}. */
type SseOptions<E> = CallParts<E> & StreamConfig;

/** The arguments after the key: the options are required when a typed part is. */
type SseArgs<E> = [RequiredKeys<CallParts<E>>] extends [never]
  ? [options?: SseOptions<E>]
  : [options: SseOptions<E>];

/**
 * A status ended the stream that is not one the route declares (or a
 * success that is not an event stream), so there is no typed body to give:
 * `fatalStatuses` (`sse.md` §3.3). A declared one is the client's
 * `HttpError`.
 */
export class StreamClosedError extends ClientError {
  /** The status that ended it. */
  readonly status: number;
  /** The response, its body unread. */
  readonly response: Response;

  /**
   * @param key      The route key.
   * @param response The response that ended it.
   * @param reason   Why, for the message.
   */
  constructor(key: string, response: Response, reason: string) {
    super(`${key}: the event stream ended: ${reason}`, { key });
    this.name = "StreamClosedError";
    this.status = response.status;
    this.response = response;
  }
}

/** The symbol the client keeps its configuration under (`client.ts`). */
const CONFIG = Symbol.for("@kingsleyweb/bun-client");

/** Why the stream's own controller aborted on `close()`: not an error. */
const CLOSED = Symbol("closed");

/** An HTTP call's result, as the stream reads it. */
interface CallResult {
  /** A 2xx status. */
  readonly ok: boolean;
  /** The status. */
  readonly status: number;
  /** A failed status's body, read (and checked) by the client. */
  readonly error?: unknown;
  /** The response; an event stream's body still unread. */
  readonly response: Response;
}

/** The checks module, imported on first use and shared by every stream. */
let validationModule: Promise<typeof import("./validation")> | undefined;

/** The event checks (`./sseChecks`), imported on first use beside `./validation`. */
let sseChecksModule: Promise<typeof import("./sseChecks")> | undefined;

/** A stream's checks: the call's (for its plan) and the event checker. */
interface StreamChecks {
  /** The call's checks, from the client's, the route's and the call's levels. */
  readonly calls: CallChecks;
  /** Checks one event (`./sseChecks`). */
  readonly checkEvent: (typeof import("./sseChecks"))["checkEvent"];
}

/** Each client's checks, by its configuration, so its schemas load once. */
const CHECKS = new WeakMap<object, Promise<Checks>>();

/** Whether a validation level could turn a check on (as `client.ts` decides). */
function mayCheck(level: object | false | undefined): boolean {
  return (
    typeof level === "object" &&
    Object.entries(level).some(
      ([name, value]) =>
        name !== "onFailure" && value !== false && value !== undefined,
    )
  );
}

/**
 * The one `process` read here, `process.env.NODE_ENV`, as `client.ts`
 * reads it (a type, erased; a bundler's define replaces it).
 */
declare const process: {
  /** The environment; only `NODE_ENV` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
};

/** Development unless the configuration or `NODE_ENV` says production (TC §5.5). */
function isDevelopment(config: ClientConfig): boolean {
  if (config.mode !== undefined) return config.mode === "development";
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return true;
  }
}

/** Waits `ms`, or until `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Decodes an event's data: JSON (undefined for none; the text when it does not parse) or text. */
function decode(
  raw: string | undefined,
  format: "json" | "text",
): { value: unknown; parsed: boolean } {
  if (format === "text" || raw === undefined)
    return { value: raw, parsed: true };
  if (raw === "") return { value: undefined, parsed: false };
  try {
    return { value: JSON.parse(raw) as unknown, parsed: true };
  } catch {
    return { value: raw, parsed: false };
  }
}

/** A drop of the connection the stream will retry (or surface, with reconnection off). */
class Dropped extends Error {}

/** The stream behind {@link EventStream}. */
class Stream {
  /** {@link EventStream.lastEventId}: the `lastEventId` option, then each committed `id:`. */
  lastEventId: string;
  /** {@link EventStream.closed}. */
  readonly closed: Promise<void>;
  /** The client each connection is a call of. */
  readonly #api: Client<RouteMap>;
  /** The route key. */
  readonly #key: string;
  /** The call's options, the route's parts and the stream's own. */
  readonly #options: StreamConfig & Record<string, unknown>;
  /** The client's configuration (validation, schemas, mode, logger, manifest); `{}` for a client without one. */
  readonly #config: ClientConfig;
  /** Aborted by `close()` (with `CLOSED`) or the call's signal (with its reason): ends every wait. */
  readonly #abort = new AbortController();
  /** The listeners, by event name (and `$gap`, `$invalid`). */
  readonly #listeners = new Map<string, Set<(...args: never[]) => void>>();
  /** Events read but not yet taken by the iterator. */
  readonly #queue: StreamEvent[] = [];
  /** An iterator waiting while listeners read, woken by the next event or the end. */
  readonly #waiters: (() => void)[] = [];
  /** The connect-read-reconnect generator, started by the first read. */
  #source: AsyncGenerator<StreamEvent, void> | undefined;
  /** The read in flight: one at a time, shared by the iterator and the listeners' loop. */
  #reading: Promise<void> | undefined;
  /** The iterator was taken (it is taken once). */
  #iterating = false;
  /** A listener was added, so reading runs eagerly. */
  #eager = false;
  /** The stream ended. */
  #done = false;
  /** What ended it, for the iterator to throw once; `undefined` for a clean end. */
  #error: { value: unknown } | undefined;
  /** Settles {@link closed}: fulfilled without an error, rejected with one. */
  #settle!: (error?: { value: unknown }) => void;

  /**
   * @param api     The client.
   * @param key     The route key.
   * @param options The call's options.
   */
  constructor(
    api: Client<RouteMap>,
    key: string,
    options: StreamConfig & Record<string, unknown>,
  ) {
    this.#api = api;
    this.#key = key;
    this.#options = options;
    this.#config =
      ((api as unknown as Record<symbol, unknown>)[CONFIG] as
        ClientConfig | undefined) ?? {};
    this.lastEventId = options.lastEventId ?? "";
    this.closed = new Promise<void>((resolve, reject) => {
      this.#settle = (error) =>
        error === undefined ? resolve() : reject(error.value as Error);
    });
    // Rejections are the iterator's and the awaiting caller's to see.
    this.closed.catch(() => {});
    const signal = options.signal;
    if (signal?.aborted) this.#stop(signal.reason);
    else
      signal?.addEventListener("abort", () => this.#stop(signal.reason), {
        once: true,
      });
  }

  on(name: string, listener: (...args: never[]) => void): () => void {
    let set = this.#listeners.get(name);
    if (set === undefined) this.#listeners.set(name, (set = new Set()));
    set.add(listener);
    if (!this.#eager) {
      this.#eager = true;
      void (async () => {
        while (!this.#done) await this.#read();
      })();
    }
    return () => void set.delete(listener);
  }

  close(): void {
    this.#stop(CLOSED);
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (this.#iterating)
      throw new ClientError(`${this.#key}: an event stream is iterated once`, {
        key: this.#key,
      });
    this.#iterating = true;
    return {
      next: async () => {
        for (;;) {
          const event = this.#queue.shift();
          if (event !== undefined) return { value: event, done: false };
          if (this.#done) {
            const error = this.#error;
            this.#error = undefined;
            if (error !== undefined) throw error.value as Error;
            return { value: undefined, done: true };
          }
          if (this.#eager)
            await new Promise<void>((resolve) => this.#waiters.push(resolve));
          else await this.#read();
        }
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  /** Ends everything: `CLOSED` cleanly, anything else as the error. */
  #stop(reason: unknown): void {
    if (this.#done || this.#abort.signal.aborted) return;
    this.#abort.abort(reason);
    this.#queue.length = 0;
    // An idle source (suspended at a yield, or never started) ends now; a
    // read in flight sees the abort and ends itself.
    if (this.#reading === undefined) {
      void this.#source?.return();
      this.#finish(reason === CLOSED ? undefined : { value: reason });
    }
  }

  /** Marks the stream ended, settles `closed` and wakes the iterator. */
  #finish(error?: { value: unknown }): void {
    if (this.#done) return;
    this.#done = true;
    this.#error = error;
    this.#settle(error);
    for (const wake of this.#waiters.splice(0)) wake();
  }

  /** Reads one event (or the end) from the source; one read at a time. */
  #read(): Promise<void> {
    this.#source ??= this.#run();
    return (this.#reading ??= this.#source.next().then(
      (result) => {
        this.#reading = undefined;
        if (result.done) {
          const reason = this.#abort.signal.reason as unknown;
          this.#finish(
            this.#abort.signal.aborted && reason !== CLOSED
              ? { value: reason }
              : undefined,
          );
        } else this.#deliver(result.value);
      },
      (error: unknown) => {
        this.#reading = undefined;
        this.#finish({ value: error });
      },
    ));
  }

  /** Hands an event to its listeners (and `$gap`'s) and to the iterator. */
  #deliver(event: StreamEvent): void {
    // An event read while close() or the signal ended the stream is dropped.
    if (this.#abort.signal.aborted) return;
    this.#emit(event.event, event.data, event);
    if (event.event === "gap") this.#emit("$gap", event.data, event);
    if (this.#iterating) this.#queue.push(event);
    for (const wake of this.#waiters.splice(0)) wake();
  }

  /** Calls the listeners of `name`; one that throws is logged. */
  #emit(name: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(name) ?? []) {
      try {
        (listener as (...values: unknown[]) => void)(...args);
      } catch (error) {
        (this.#config.logger ?? console).error(
          `${this.#key}: an event listener threw`,
          error,
        );
      }
    }
  }

  /** The event checks, when anything may check an event; loaded lazily. */
  async #checks(): Promise<StreamChecks | undefined> {
    const config = this.#config;
    const development = isDevelopment(config);
    const levels = [
      config.validate,
      config.routes?.[this.#key]?.validate,
      this.#options.validate as ValidationConfig | false | undefined,
    ];
    if (
      !(development && config.schemas !== undefined) &&
      !levels.some(mayCheck)
    )
      return undefined;
    let checks = CHECKS.get(config);
    if (checks === undefined) {
      checks = (validationModule ??= import("./validation")).then((module) =>
        module.createChecks({
          development,
          source: config.schemas as never,
          logger: config.logger ?? console,
          errors: { ClientError, ValidationError },
        }),
      );
      CHECKS.set(config, checks);
    }
    const [calls, events] = await Promise.all([
      checks,
      (sseChecksModule ??= import("./sseChecks")),
    ]);
    return { calls: calls(this.#key, levels), checkEvent: events.checkEvent };
  }

  /** Connects, reads, validates and reconnects: the events, in order. */
  async *#run(): AsyncGenerator<StreamEvent, void> {
    const key = this.#key;
    const signal = this.#abort.signal;
    const {
      lastEventId: _lastEventId,
      reconnect,
      heartbeatMs,
      fatalStatuses,
      data,
      validate,
      middleware,
      ...call
    } = this.#options;
    const format = data ?? "json";
    const initialMs = (reconnect || {}).initialMs ?? 3_000;
    const maxMs = (reconnect || {}).maxMs ?? 30_000;
    const fatal = (status: number) =>
      fatalStatuses?.includes(status) ??
      (status >= 400 && status < 500 && status !== 408 && status !== 429);
    // The HTTP call takes no "drop": an error status's body warns instead.
    const httpValidate =
      typeof validate === "object" &&
      typeof validate.onFailure === "object" &&
      validate.onFailure.response === "drop"
        ? {
            ...validate,
            onFailure: { ...validate.onFailure, response: "warn" },
          }
        : validate;
    const declared = (
      this.#config.manifest as
        Record<string, { statuses?: readonly number[] } | undefined> | undefined
    )?.[key]?.statuses;
    const checks = await this.#checks();
    // Innermost: what the stream asks for, and where it resumes from.
    const resume: ClientMiddleware = (ctx, next) => {
      const headers = ctx.request.headers;
      if (!headers.has("accept")) headers.set("accept", "text/event-stream");
      if (this.lastEventId !== "")
        headers.set("last-event-id", this.lastEventId);
      return next();
    };
    let retry: number | undefined;
    let failures = 0;

    for (;;) {
      let after: number | undefined;
      let opened = 0;
      try {
        const result = (await this.#api.request(
          key as never,
          {
            ...call,
            signal,
            validate: httpValidate,
            retry: false,
            throwOnError: false,
            undeclaredStatus: "result",
            middleware: [...(middleware ?? []), resume],
          } as never,
        )) as unknown as CallResult;
        const { response, status } = result;
        if (!result.ok) {
          if (fatal(status) || reconnect === false)
            throw declared === undefined || declared.includes(status)
              ? new HttpError(status, result.error, response, key)
              : new StreamClosedError(key, response, `status ${status}`);
          after = retryAfterMs(response.headers.get("retry-after"));
          throw new Dropped(`status ${status}`);
        }
        if (status === 204) return;
        const type = response.headers.get("content-type") ?? "";
        if (!/^text\/event-stream\b/i.test(type) || response.body === null) {
          await response.body?.cancel().catch(() => {});
          throw new StreamClosedError(
            key,
            response,
            `status ${status} is not a text/event-stream (${type || "no content-type"})`,
          );
        }

        opened = Date.now();
        // What checks this connection's events, as its status says.
        const plan = await checks?.calls.events(status);
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
        const parser = new SseParser(this.lastEventId);
        let stalled = false;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          if (heartbeatMs === undefined) return;
          clearTimeout(watchdog);
          watchdog = setTimeout(
            () => {
              stalled = true;
              void reader.cancel().catch(() => {});
            },
            heartbeatMs * 2 + 5_000,
          );
        };
        const cancel = () => void reader.cancel().catch(() => {});
        signal.addEventListener("abort", cancel, { once: true });
        try {
          arm();
          for (;;) {
            let chunk: Awaited<ReturnType<typeof reader.read>>;
            try {
              chunk = await reader.read();
            } catch (error) {
              if (signal.aborted) return;
              throw new Dropped("the event stream failed", { cause: error });
            }
            if (signal.aborted) return;
            if (stalled)
              throw new Dropped(
                `no byte for ${heartbeatMs! * 2 + 5_000} ms (heartbeatMs ${heartbeatMs})`,
              );
            if (chunk.done) {
              // EventSource reconnects to a stream the server ended.
              if (reconnect === false) return;
              throw new Dropped("the server ended the stream");
            }
            arm();
            for (const message of parser.push(
              decoder.decode(chunk.value, { stream: true }),
            )) {
              const decoded = decode(message.data, format);
              let event: StreamEvent =
                message.id === ""
                  ? { event: message.name, data: decoded.value }
                  : {
                      event: message.name,
                      data: decoded.value,
                      id: message.id,
                    };
              if (plan !== undefined) {
                const { value, issues } = await checks!.checkEvent(
                  plan.route,
                  status,
                  plan.plan,
                  event,
                  { raw: message.data, parsed: decoded.parsed },
                );
                if (issues.length === 0) event = value;
                else {
                  const error = new ValidationError(
                    key,
                    "response",
                    issues,
                    status,
                  );
                  if (plan.mode === "throw") throw error;
                  if (plan.mode === "drop") {
                    this.#emit("$invalid", error);
                    continue;
                  }
                  if (plan.mode === "warn")
                    (this.#config.logger ?? console).warn(error.message);
                  else plan.mode(error);
                }
              }
              this.lastEventId = message.id;
              yield event;
              if (signal.aborted) return;
            }
            this.lastEventId = parser.lastEventId;
            if (parser.retry !== undefined) retry = parser.retry;
          }
        } finally {
          clearTimeout(watchdog);
          signal.removeEventListener("abort", cancel);
          cancel();
        }
      } catch (error) {
        if (signal.aborted) return;
        const network =
          error instanceof Dropped ||
          error instanceof NetworkError ||
          error instanceof TimeoutError;
        if (!network) throw error;
        if (reconnect === false)
          throw error instanceof Dropped
            ? new NetworkError(`${key}: ${error.message}`, {
                key,
                cause: error.cause,
              })
            : error;
      }
      // A connection that stayed open a minute starts the count over.
      if (opened !== 0 && Date.now() - opened >= 60_000) failures = 0;
      failures++;
      const base = retry ?? initialMs;
      const delay = Math.min(base * 2 ** (failures - 1), Math.max(maxMs, base));
      await wait(after ?? delay * (0.5 + Math.random() * 0.5), signal);
      if (signal.aborted) return;
    }
  }
}

/**
 * Opens a typed event stream on a route of the client's map whose entry is
 * `stream: "sse"` (`sse.md` §3). Nothing is sent until the stream is first
 * read.
 *
 * @param api     The client (`createClient<Routes>()`): its base URL,
 *   fetch, headers, auth, middleware, manifest and validation apply.
 * @param key     The route key, `"GET /jobs/:id/events"`.
 * @param options The route's params, query, headers (and a body, for a
 *   `POST` stream), and the stream's own options.
 */
export function sse<
  R extends RouteMap<R>,
  F extends ClientFlags,
  K extends SseKeyOf<R>,
>(
  api: Client<R, F>,
  key: K,
  ...args: SseArgs<R[K]>
): EventStream<EventsOf<R[K]>>;
export function sse(api: object, key: string, options: object = {}): unknown {
  return new Stream(
    api as Client<RouteMap>,
    key,
    options as StreamConfig & Record<string, unknown>,
  );
}
