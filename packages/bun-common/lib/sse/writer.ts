/**
 * `SseWriter`: a writer onto one event stream (bun-native-routes plan §16.3,
 * PR-sse2), the body `res.sse()` and `sseResponse()` send. What it does,
 * each for a measured reason (§16.2, §16.9):
 *
 * - **Opens at once**: an opening comment (`: ok`) is the first chunk,
 *   because Bun sends no header block before a body's first chunk.
 * - **Backpressure**: the body is a byte stream with a byte-length
 *   high-water mark (64 KiB), and `send()` resolves at once below it and
 *   otherwise when the client has read (one shared promise per backed-up
 *   period, and one shared resolved promise below the mark: no allocation
 *   per call, §16.14 C2).
 * - **A bound**: past `maxQueuedBytes` queued (8 MiB) a client that stopped
 *   reading is disconnected, not buffered without limit.
 * - **A heartbeat**: an empty comment every `heartbeatMs` (15 s) without
 *   other bytes, for proxies and for noticing a dead peer.
 * - **Stops** on `close()`, the client leaving (the body cancelled, or
 *   `signal`), or the bound; `onClose`, `signal` and `closed` say so, and
 *   `send()` resolves `false` from then on.
 *
 * And the typed client's four additions (typed-client plan `sse.md` §4):
 *
 * 1. **`contract`**: an `sse({ … })` declaration types `send()` by event
 *    name and checks each event with the contract core's sender guard
 *    **before** it is encoded, so a bad event is refused to the caller and
 *    never cuts the stream.
 * 2. **Ids**: `send({ id })`, or `ids: "auto"`, which numbers the events.
 * 3. **Resume**: a request's `Last-Event-ID` is handed to `resume`, whose
 *    events are replayed before any live one, or whose `"gap"` sends the
 *    declared `gap` event.
 * 4. **`retry`** with the opening, and the heartbeat comments.
 *
 * Browser-safe: web streams and timers only, and the contract core.
 */
import type { Logger, LoggerLike } from "../logging";
import type { Policy, WireInput } from "../contract/model";
import type { SseDataFormat, SseEventMap, SseEvents } from "./declaration";
import type { StandardSchemaV1 } from "../types/standardSchema";
import type { SseMessage } from "./format";
import { ContractError, createSender } from "../contract/guard";
import { isPromiseLike } from "../contract/model";
import { nestedOf } from "../contract/schemas";
import { resolveLogger } from "../logging";
import { formatSseBlock, sseDataText } from "./format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The fields of a block besides its event and data. */
interface SseBlockFields {
  /** The `id:` (see {@link SseMessage.id}); with `ids: "auto"`, assigned when absent. */
  readonly id?: string | number;
  /** A `retry:` sent with the event, ms (see {@link SseMessage.retry}). */
  readonly retry?: number;
  /** A comment sent with the event (see {@link SseMessage.comment}). */
  readonly comment?: string;
}

/** The `data` field of an event whose declaration is `S`: none for `null`, else the schema's wire input. */
type EventDataField<S> = S extends StandardSchemaV1
  ? {
      /** The event's data: the schema's input (its output where the input is `unknown`). */
      readonly data: WireInput<S>;
    }
  : {
      /** An event declared `null` carries no data. */
      readonly data?: undefined;
    };

/**
 * One event a writer with the contract `sse(E)` sends: a union over the
 * declared names, so `event` selects the type of `data`. A declared
 * `message` may also leave `event` out (a client calls an event without
 * one `message`).
 *
 * `event` is the name itself, not a conditional type over it, so a literal
 * in a `resume` hook's array or an `sseResponse()` source keeps its type
 * while the call's contract is still being inferred.
 *
 * @typeParam E The declaration's events.
 */
export type SseContractEvent<E extends SseEventMap = SseEventMap> =
  | {
      [K in keyof E & string]: {
        /** The event's name. */
        readonly event: K;
      } & EventDataField<E[K]> &
        SseBlockFields;
    }[keyof E & string]
  | ("message" extends keyof E
      ? {
          /** No name: the event is `message`. */
          readonly event?: undefined;
        } & EventDataField<E["message"]> &
          SseBlockFields
      : never);

/**
 * What `send()` takes: with a contract, one of its events
 * ({@link SseContractEvent}); without one, any {@link SseMessage} or
 * pre-encoded bytes (`encodeSseEvent()`).
 *
 * Written as a union rather than a conditional on `C`, so a literal event
 * name in a `resume` hook's return or an `sseResponse()` source keeps its
 * type while the call's contract is still being inferred. (A literal inside
 * an event's `data`, such as a `z.enum()` value, is still widened in a
 * function's returned array: give such an array a type, or use `as const`.)
 *
 * @typeParam C The writer's contract (`sse({ … })`), or `undefined`.
 */
export type SseSendOf<C extends SseEvents | undefined = undefined> =
  | SseContractEvent<Exclude<C, undefined>["events"]>
  | (undefined extends C ? SseMessage | Uint8Array : never);

/**
 * What a `resume` hook returns: the events to replay (in order, before any
 * live one), `"gap"` to send the declared `gap` event (the client then
 * knows it missed events and refetches), or nothing to replay none.
 *
 * @typeParam C The writer's contract, or `undefined`.
 */
export type SseReplay<C extends SseEvents | undefined = undefined> =
  | readonly SseSendOf<C>[]
  | Iterable<SseSendOf<C>>
  | AsyncIterable<SseSendOf<C>>
  | "gap"
  | undefined
  | void;

/**
 * The options of a writer (`res.sse(options)`, `sseResponse(source,
 * options)`).
 *
 * @typeParam C The contract (`sse({ … })`), or `undefined`.
 */
export interface SseWriterOptions<C extends SseEvents | undefined = undefined> {
  /**
   * An `sse({ … })` declaration (the route's own, from a shared module):
   * `send()` is then typed by it, and each event is checked against it
   * before it is encoded, under {@link validation}. Its `data` decides how
   * an event's data is written: `"json"` (the default) `JSON.stringify`s
   * every value, strings included, so a reader parsing JSON gets them back;
   * `"text"` writes the string as it is. Pre-encoded bytes are refused (a
   * `TypeError`): they cannot be checked. Default: none (untyped, unchecked).
   */
  readonly contract?: C;
  /**
   * What a mismatch against {@link contract} does: `"error"` (the default)
   * refuses the event (a synchronous vendor's `ContractError` is thrown by
   * `send()`, an asynchronous one's rejects its promise) and sends nothing;
   * `"warn"` logs it once per event and sends it; `"off"` checks nothing.
   */
  readonly validation?: Policy;
  /**
   * Where a `"warn"` mismatch, a slow client's disconnection and an error
   * of `resume` (with no {@link onError}) are logged. Any logger bun-common
   * adapts (`resolveLogger`). Default: a console logger.
   */
  readonly logger?: LoggerLike;
  /**
   * `"auto"` numbers the events that carry no `id`: 1, 2, 3, … per stream,
   * continuing after the request's `Last-Event-ID` when that is a
   * non-negative integer (a resumed stream keeps counting), and after any
   * integer `id` sent explicitly. Comments and `id`/`retry`-only blocks
   * take none. Default: no ids but those given.
   */
  readonly ids?: "auto";
  /**
   * Called once, when the request carried a `Last-Event-ID`, with it: its
   * events are sent first (live `send()`s wait behind them), or `"gap"`
   * sends `{ event: "gap" }` (declare `gap: null` in the contract). An error
   * (a throw, a rejection, a replayed event refused) goes to
   * {@link onError}. Default: none (the id is only readable as
   * `writer.lastEventId`).
   */
  readonly resume?: (
    lastEventId: string,
    writer: SseWriter<NoInfer<C>>,
  ) => SseReplay<NoInfer<C>> | Promise<SseReplay<NoInfer<C>>>;
  /**
   * A `retry:` sent with the opening: the ms a client waits before it
   * reconnects. A non-negative integer. Default: none (the client's own,
   * 3 s for `EventSource` and bun-client).
   */
  readonly retry?: number;
  /**
   * The ms between heartbeat comments (`:`), sent only when nothing else was
   * written since the last one; `0` turns them off. Default `15_000`. The
   * request is exempt from Bun's `idleTimeout` either way; the heartbeat is
   * for proxies (nginx's `proxy_read_timeout` is 60 s) and dead peers.
   */
  readonly heartbeatMs?: number;
  /** Bytes queued before `send()` waits for the client to read. Default `65_536`. */
  readonly highWaterMark?: number;
  /**
   * Bytes queued past which a client that stopped reading is disconnected
   * (the stream is errored and closed). Default `8_388_608` (8 MiB);
   * `Infinity` never.
   */
  readonly maxQueuedBytes?: number;
  /**
   * The first block, sent at once so the headers reach the client (Bun sends
   * none before the first chunk); `false` sends none (the headers then wait
   * for the first event). Default `{ comment: "ok" }`.
   */
  readonly open?: SseMessage | false;
  /**
   * `true` lets `compression()` and proxies transform the stream: the
   * `Cache-Control` is then `no-cache` alone. Default `false`:
   * `no-cache, no-transform`, which `compression()` skips (§16.5, S7).
   * Read by `res.sse()` and `sseResponse()`, which set the headers.
   */
  readonly compress?: boolean;
  /**
   * Called with an error of `resume` (or of `sseResponse()`'s source)
   * instead of the default, which logs it and closes the stream. The writer
   * is still open: the hook may send an event (none is sent by default, so
   * no message leaks, S5) and should close it. An error it throws is
   * logged. Default: none.
   */
  readonly onError?: (error: unknown, writer: SseWriter<NoInfer<C>>) => void;
}

/** What a writer is built with: its options, plus what the request gives it. */
export interface SseWriterInit<
  C extends SseEvents | undefined = undefined,
> extends SseWriterOptions<C> {
  /**
   * The request's `Last-Event-ID` (`""` is none): read as
   * {@link SseWriter.lastEventId}, handed to `resume`, and where `ids:
   * "auto"` continues from. `res.sse()` and `sseResponse({ request })` fill
   * it. Default: none.
   */
  readonly lastEventId?: string | null;
  /**
   * Closes the writer when it aborts: the request's signal, which aborts
   * when the client leaves. `res.sse()` and `sseResponse({ request })` fill
   * it. Default: none.
   */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/** `send()`'s answer below the high-water mark: one shared promise. */
const SENT: Promise<boolean> = Promise.resolve(true);
/** `send()`'s answer once closed: one shared promise. */
const CLOSED: Promise<boolean> = Promise.resolve(false);
/** A settled step, the chain's start. */
const SETTLED: Promise<void> = Promise.resolve();

/** A decimal integer as an id writes it: no sign, no leading zero. */
const INTEGER_ID = /^(?:0|[1-9]\d{0,15})$/;

/** The default logger, made on first use. */
let defaultLogger: Logger | undefined;

/** One encoder for every writer. */
const encoder = new TextEncoder();

/**
 * Whether `value` is an async iterable (a replay or a source to read with
 * `for await`) rather than a plain iterable. Internal.
 *
 * @param value A replay or source.
 * @internal
 */
export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}

/** A writer's guard: the contract core's sender, over `{ event, data, id }`. */
type EventGuard = (message: unknown) => unknown;

/** What an ordered step resolves to: its backpressure answer, boxed so the chain does not wait for it. */
interface Queued {
  /** `send()`'s answer for the step. */
  readonly sent: Promise<boolean>;
}

/** Set by `SseWriter`'s static block: hands an error to a writer's `onError` (or logs it and closes). */
let failWriter: (
  writer: SseWriter<SseEvents | undefined>,
  error: unknown,
) => void;

/**
 * A writer onto one event stream. Build one with `res.sse()` or
 * `sseResponse()`, which also set the headers and exempt the request from
 * Bun's idle timeout; `new SseWriter()` gives the bare body
 * ({@link readable}) for a `Response` of your own.
 *
 * @typeParam C The contract (`sse({ … })`), or `undefined` for an untyped
 *   writer.
 */
export class SseWriter<C extends SseEvents | undefined = undefined> {
  /** The body: a byte stream of the blocks sent, for a `Response`. */
  readonly readable: ReadableStream<Uint8Array>;
  /** The request's `Last-Event-ID`, or `undefined` when it sent none (or `""`). */
  readonly lastEventId: string | undefined;
  /** Aborts when the writer closes, whatever closed it. */
  readonly signal: AbortSignal;

  /** The body's controller. */
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  /** The high-water mark, bytes. */
  readonly #hwm: number;
  /** The bound on queued bytes. */
  readonly #max: number;
  /** Aborts {@link signal}. */
  readonly #abort = new AbortController();
  /** Run once, on close. */
  #listeners: (() => void)[] = [];
  /** Set once closed: the stream is ended (or cut) and nothing more is queued. */
  #closed = false;
  /** Set by `close()` while ordered work is pending: nothing new is taken, and the stream ends once that work is queued. */
  #closing = false;
  /** The promise every `send()` of one backed-up period shares; `undefined` below the mark. */
  #drain: PromiseWithResolvers<boolean> | undefined;
  /** The heartbeat timer. */
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Set by every write, cleared by the heartbeat: a heartbeat is sent only after a quiet interval. */
  #wrote = false;
  /** The contract's sender guard; `undefined` without a contract (or under `"off"`). */
  readonly #guard: EventGuard | undefined;
  /** The contract's data format; `undefined` without a contract. */
  readonly #format: SseDataFormat | undefined;
  /** `ids: "auto"`. */
  readonly #autoIds: boolean;
  /** The last integer id sent (or resumed from), for `ids: "auto"`. */
  #lastId = 0;
  /**
   * The tail of the ordered work still pending (an event waiting for an
   * asynchronous verdict, the resume replay): a later `send()` goes behind
   * it. `undefined` when none is pending. It never rejects.
   */
  #chain: Promise<unknown> | undefined;
  /** The logger, resolved on first use. */
  #logger: Logger | undefined;
  /** The `logger` option. */
  readonly #loggerOption: LoggerLike | undefined;
  /** The `onError` option. */
  readonly #onError:
    ((error: unknown, writer: SseWriter<C>) => void) | undefined;

  /**
   * @param init The options, plus the request's `Last-Event-ID` and signal
   *   ({@link SseWriterInit}). A bad option (a `contract` that is not an
   *   `sse()` declaration, a negative `heartbeatMs`, a `retry` that is not a
   *   non-negative integer) throws a `TypeError`.
   */
  constructor(init: SseWriterInit<C> = {}) {
    const hwm = init.highWaterMark ?? 64 * 1024;
    const max = init.maxQueuedBytes ?? 8 * 1024 * 1024;
    const heartbeat = init.heartbeatMs ?? 15_000;
    if (!(hwm >= 0) || !(max >= 0)) {
      throw new TypeError(
        "SseWriter: highWaterMark and maxQueuedBytes must be non-negative",
      );
    }
    if (!Number.isFinite(heartbeat) || heartbeat < 0) {
      throw new TypeError(
        "SseWriter: heartbeatMs must be a non-negative number",
      );
    }
    this.#hwm = hwm;
    this.#max = max;
    this.#loggerOption = init.logger;
    this.#onError = init.onError;
    this.#autoIds = init.ids === "auto";
    if (init.ids !== undefined && init.ids !== "auto") {
      throw new TypeError('SseWriter: ids must be "auto" or left out');
    }
    const last = init.lastEventId;
    this.lastEventId =
      typeof last === "string" && last.length > 0 ? last : undefined;
    if (this.lastEventId !== undefined && INTEGER_ID.test(this.lastEventId)) {
      this.#lastId = Number(this.lastEventId);
    }
    this.signal = this.#abort.signal;

    const contract = init.contract;
    if (contract !== undefined) {
      const nested = nestedOf(contract);
      if (nested === undefined) {
        throw new TypeError(
          "SseWriter: contract must be an sse({ … }) declaration",
        );
      }
      this.#format = contract.data;
      const guard = createSender(nested, "outbound", {
        policy: init.validation ?? "error",
        logger: this.#log(),
      });
      this.#guard = guard.checks ? (guard as unknown as EventGuard) : undefined;
    }

    this.readable = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: () => this.#wake(),
        cancel: () => this.#finish(),
      },
      new ByteLengthQueuingStrategy({ highWaterMark: hwm }),
    );

    const open = init.open ?? { comment: "ok" };
    if (open !== false || init.retry !== undefined) {
      void this.#enqueue(
        this.#encode(
          open === false
            ? { retry: init.retry }
            : init.retry === undefined
              ? open
              : { ...open, retry: init.retry },
          sseDataText(open === false ? undefined : open.data),
        ),
      );
    }

    if (heartbeat > 0) {
      const timer = setInterval(() => this.#beat(), heartbeat);
      (timer as { unref?: () => void }).unref?.();
      this.#heartbeat = timer;
    }

    const signal = init.signal;
    if (signal !== undefined) {
      // The client left: at once, whatever is still pending.
      if (signal.aborted) this.#closeNow();
      else
        signal.addEventListener("abort", () => this.#closeNow(), {
          once: true,
        });
    }

    if (this.lastEventId !== undefined && init.resume !== undefined) {
      this.#replay(init.resume, this.lastEventId);
    }
  }

  /**
   * `true` once the writer is closed, by either side, or `close()` was
   * called: from then on `send()` sends nothing and resolves `false`.
   */
  get closed(): boolean {
    return this.#closed || this.#closing;
  }

  /**
   * Calls `listener` once, when the writer closes (`close()`, the client
   * leaving, the slow-client bound), or in a microtask when it already has.
   * Returns a function that removes a listener not yet called. A listener
   * that throws is logged.
   *
   * @param listener Called with no argument.
   */
  onClose(listener: () => void): () => void {
    if (this.#closed) {
      queueMicrotask(() => this.#call(listener));
      return () => {};
    }
    this.#listeners.push(listener);
    return () => {
      const index = this.#listeners.indexOf(listener);
      if (index !== -1) this.#listeners.splice(index, 1);
    };
  }

  /**
   * Queues one event (or block). Resolves `true` at once while the queue is
   * under the high-water mark, otherwise once the client has read enough,
   * and `false` once the writer is closed (nothing is sent then).
   *
   * With a contract, the event is checked first (see
   * {@link SseWriterOptions.validation}): under `"error"` a mismatch throws
   * its `ContractError` here (a synchronous vendor) or rejects the promise
   * (an asynchronous one), and nothing is sent. Events keep their order
   * across asynchronous verdicts and the resume replay.
   *
   * Throws a `TypeError` for a malformed block (see `formatSseEvent`), and
   * for bytes given to a writer with a contract.
   *
   * @param message The event, or pre-encoded bytes (untyped writers only).
   */
  send(message: SseSendOf<C>): Promise<boolean> {
    if (this.#closed || this.#closing) return CLOSED;
    const value: SseMessage | Uint8Array = message;
    if (value instanceof Uint8Array) {
      if (this.#guard !== undefined || this.#format !== undefined) {
        throw new TypeError(
          "SseWriter: a writer with a contract checks its events, so it takes no pre-encoded bytes",
        );
      }
      return this.#chain === undefined
        ? this.#enqueue(value)
        : this.#ordered(SETTLED, () => this.#enqueue(value));
    }
    const verdict = this.#check(value);
    if (isPromiseLike(verdict)) {
      return this.#ordered(verdict, (settled) => {
        if (settled instanceof ContractError) throw settled;
        return this.#write(value);
      });
    }
    if (this.#chain !== undefined) {
      return this.#ordered(SETTLED, () => this.#write(value));
    }
    return this.#write(value);
  }

  /**
   * Queues a comment (`: text`, one per line), which clients ignore: a
   * keep-alive, or a note for a human reading the stream. Never checked.
   * Resolves as {@link send} does.
   *
   * @param text The comment; `""` is the bare `:`.
   */
  comment(text: string): Promise<boolean> {
    if (this.#closed || this.#closing) return CLOSED;
    return this.#enqueue(this.#encode({ comment: text }, undefined));
  }

  /**
   * Ends the stream after what is queued (events still waiting for an
   * asynchronous verdict or behind the resume replay included), and closes
   * the writer. Safe to call more than once.
   */
  close(): void {
    if (this.#closed || this.#closing) return;
    const pending = this.#chain;
    if (pending !== undefined) {
      this.#closing = true;
      void pending.then(() => this.#closeNow());
      return;
    }
    this.#closeNow();
  }

  /** Ends the stream now, after the bytes already queued. */
  #closeNow(): void {
    if (this.#closed) return;
    try {
      this.#controller.close();
    } catch {
      // Already cancelled or errored.
    }
    this.#finish();
  }

  // -------------------------------------------------------------------------

  static {
    failWriter = (writer, error) => writer.#fail(error);
  }

  /**
   * Hands `error` (from `resume`, or `sseResponse()`'s source) to
   * `onError`, or logs it and closes the writer.
   */
  #fail(error: unknown): void {
    const hook = this.#onError;
    if (hook === undefined) {
      if (!this.#closed) {
        this.#log().error("an event stream failed; closing it", { error });
      }
      // At once: live events queued behind a failed replay must not reach a
      // client that would then believe it is up to date.
      this.#closeNow();
      return;
    }
    try {
      hook(error, this);
    } catch (thrown) {
      this.#log().error("an event stream's onError threw", { error: thrown });
    }
  }

  /** The logger. */
  #log(): Logger {
    return (this.#logger ??=
      this.#loggerOption === undefined
        ? (defaultLogger ??= resolveLogger(undefined))
        : resolveLogger(this.#loggerOption));
  }

  /** Calls a close listener, logging what it throws. */
  #call(listener: () => void): void {
    try {
      listener();
    } catch (error) {
      this.#log().error("an event stream's onClose listener threw", {
        error,
      });
    }
  }

  /** Checks an event against the contract: `undefined` (pass), or the guard's verdict. */
  #check(message: SseMessage): unknown {
    const guard = this.#guard;
    if (guard === undefined) return undefined;
    const verdict = guard({
      event: message.event ?? "message",
      data: message.data,
      ...(message.id === undefined ? {} : { id: message.id }),
    });
    if (verdict instanceof ContractError) throw verdict;
    return verdict;
  }

  /** The text of an event's data, as the contract (or its absence) says. */
  #dataText(data: unknown): string | undefined {
    if (data === undefined) return undefined;
    if (this.#format === "json") {
      // `undefined` for a value JSON cannot represent.
      const text: string | undefined = JSON.stringify(data);
      return text;
    }
    return sseDataText(data);
  }

  /** Encodes `message` (assigning an auto id) and queues it. */
  #write(message: SseMessage): Promise<boolean> {
    if (this.#closed) return CLOSED;
    let block = message;
    const isEvent = message.event !== undefined || message.data !== undefined;
    if (message.id !== undefined) {
      const text = String(message.id);
      if (INTEGER_ID.test(text)) this.#lastId = Number(text);
    } else if (this.#autoIds && isEvent) {
      block = { ...message, id: ++this.#lastId };
    }
    return this.#enqueue(this.#encode(block, this.#dataText(message.data)));
  }

  /** One block as bytes. */
  #encode(message: SseMessage, data: string | undefined): Uint8Array {
    return encoder.encode(formatSseBlock(message, data));
  }

  /**
   * Runs `step` with `pending`'s value once everything queued before has
   * run, keeping the order; resolves as the step's `send()` would. The
   * chain waits for the step to queue its bytes, never for the client to
   * read them, so the queue's bound still applies.
   */
  #ordered<V>(
    pending: PromiseLike<V>,
    step: (value: V) => Promise<boolean>,
  ): Promise<boolean> {
    const previous = this.#chain ?? SETTLED;
    const queued: Promise<Queued> = previous.then(async () => {
      const value = await pending;
      return { sent: step(value) };
    });
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    this.#chain = tail;
    void tail.then(() => {
      if (this.#chain === tail) this.#chain = undefined;
    });
    return queued.then((box) => box.sent);
  }

  /** Runs the resume hook and replays its events ahead of every live one. */
  #replay(
    resume: NonNullable<SseWriterOptions<C>["resume"]>,
    lastEventId: string,
  ): void {
    const run = async (): Promise<void> => {
      try {
        const replay = await resume(lastEventId, this);
        if (replay === undefined || this.#closed) return;
        if (replay === "gap") {
          await this.#deliver({ event: "gap" });
          return;
        }
        if (isAsyncIterable(replay)) {
          for await (const event of replay as AsyncIterable<SseMessage>) {
            if (!(await this.#deliver(event))) return;
          }
        } else {
          for (const event of replay as Iterable<SseMessage>) {
            if (!(await this.#deliver(event))) return;
          }
        }
      } catch (error) {
        this.#fail(error);
      }
    };
    const done = run();
    this.#chain = done;
    void done.then(() => {
      if (this.#chain === done) this.#chain = undefined;
    });
  }

  /** Checks and writes one replayed event in place (the replay holds the chain), waiting for the client to read. */
  async #deliver(message: SseMessage): Promise<boolean> {
    if (this.#closed) return false;
    const verdict = this.#check(message);
    if (isPromiseLike(verdict)) {
      const settled = await verdict;
      if (settled instanceof ContractError) throw settled;
    }
    return this.#write(message);
  }

  /** Queues bytes: the backpressure answer, or `false` once closed (or past the bound). */
  #enqueue(bytes: Uint8Array): Promise<boolean> {
    if (this.#closed) return CLOSED;
    const controller = this.#controller;
    try {
      controller.enqueue(bytes);
    } catch {
      this.#finish();
      return CLOSED;
    }
    this.#wrote = true;
    const desired = controller.desiredSize ?? 0;
    if (this.#hwm - desired > this.#max) {
      // A client that stopped reading: close rather than buffer without bound.
      this.#log().warn(
        "an event stream's client stopped reading; disconnecting it",
        { queuedBytes: this.#hwm - desired, maxQueuedBytes: this.#max },
      );
      try {
        controller.error(new Error("The event stream's client is too slow"));
      } catch {
        // Already errored.
      }
      this.#finish();
      return CLOSED;
    }
    if (desired > 0) return SENT;
    return (this.#drain ??= Promise.withResolvers<boolean>()).promise;
  }

  /** The heartbeat: a bare comment, unless something was written since the last one. */
  #beat(): void {
    if (this.#wrote) {
      this.#wrote = false;
      return;
    }
    void this.comment("");
    this.#wrote = false;
  }

  /** Resolves the backed-up period's shared promise: the client read. */
  #wake(): void {
    const drain = this.#drain;
    this.#drain = undefined;
    drain?.resolve(!this.#closed);
  }

  /** Marks the writer closed: stops the heartbeat, aborts the signal, wakes the waiters, calls the listeners. */
  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#wake();
    this.#abort.abort();
    const listeners = this.#listeners;
    this.#listeners = [];
    for (const listener of listeners) this.#call(listener);
  }
}

/**
 * Hands `error` to `writer`'s `onError`, or logs it and closes the writer:
 * what `sseResponse()` does with an error of its source. Internal.
 *
 * @param writer The writer.
 * @param error  What failed.
 * @internal
 */
export function failSseWriter(
  writer: SseWriter<SseEvents | undefined>,
  error: unknown,
): void {
  failWriter(writer, error);
}
