/**
 * A prototype of the SSE helpers §16 proposes, written outside the packages
 * (no library change) so the perf and backpressure spikes can measure the
 * design rather than guess at it. Names here are placeholders pending the
 * maintainer's approval (§16.10).
 *
 * - `formatSseEvent` / `encodeSseEvent`: the wire format (WHATWG HTML
 *   "Server-sent events" §9.2.6 event stream format).
 * - `SseStream`: a writer over a byte `ReadableStream` with awaitable
 *   backpressure, a heartbeat, a bounded queue and abort on disconnect.
 * - `sseResponse()`: a standalone `Response` for native routes or `fetch`.
 * - `sse(req, res)`: the shape `res.sse()` would have on BunResponse,
 *   built on `res.send(stream)` so the adapter's own finalisation applies.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";

/** One event. Every field optional; an event with only `comment` is a comment. */
export interface SseMessage {
  /** The payload. A non-string is JSON-serialised; each line becomes a `data:` line. */
  data?: unknown;
  /** The `event:` type; `message` on the client when absent. No CR/LF. */
  event?: string;
  /** The `id:`, which the client sends back as `Last-Event-ID`. No CR/LF/NUL. */
  id?: string | number;
  /** The `retry:` reconnection delay, ms; a non-negative integer. */
  retry?: number;
  /** A `:` comment line (ignored by clients; heartbeats use it). */
  comment?: string;
}

const LINE = /\r\n|\r|\n/;
const BAD_FIELD = /[\r\n]/;

/** The text of one event, terminated by its blank line. */
export function formatSseEvent(m: SseMessage): string {
  let out = "";
  if (m.comment !== undefined) {
    for (const line of m.comment.split(LINE)) out += `:${line ? ` ${line}` : ""}\n`;
  }
  if (m.event !== undefined) {
    if (BAD_FIELD.test(m.event)) throw new TypeError("event must not contain CR or LF");
    out += `event: ${m.event}\n`;
  }
  if (m.id !== undefined) {
    const id = String(m.id);
    if (BAD_FIELD.test(id) || id.includes("\0")) throw new TypeError("id must not contain CR, LF or NUL");
    out += `id: ${id}\n`;
  }
  if (m.retry !== undefined) {
    if (!Number.isInteger(m.retry) || m.retry < 0) throw new TypeError("retry must be a non-negative integer");
    out += `retry: ${m.retry}\n`;
  }
  if (m.data !== undefined) {
    const text = typeof m.data === "string" ? m.data : JSON.stringify(m.data);
    for (const line of text.split(LINE)) out += `data: ${line}\n`;
  }
  return `${out}\n`;
}

const encoder = new TextEncoder();
/** {@link formatSseEvent}, encoded once — for broadcasting one event to many streams. */
export function encodeSseEvent(m: SseMessage): Uint8Array {
  return encoder.encode(formatSseEvent(m));
}

export interface SseStreamOptions {
  /** A comment sent every `heartbeatMs`; `0` disables. Default 15 000. */
  heartbeatMs?: number;
  /** Bytes queued before `send()`'s promise waits for the client. Default 64 KiB. */
  highWaterMark?: number;
  /** Bytes queued before the stream is closed as a slow consumer. Default 8 MiB; `Infinity` never. */
  maxQueuedBytes?: number;
  /** Closes the stream when it aborts (the request's signal). */
  signal?: AbortSignal;
  /** Sent first (Bun holds the headers until the first chunk). Default `": ok"`. */
  open?: SseMessage | false;
}

/** A writer onto one event stream. */
export class SseStream {
  readonly readable: ReadableStream<Uint8Array>;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #waiters: (() => void)[] = [];
  #closed = false;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  readonly #max: number;
  readonly #closeListeners: (() => void)[] = [];

  constructor(opts: SseStreamOptions = {}) {
    this.#max = opts.maxQueuedBytes ?? 8 * 1024 * 1024;
    this.readable = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          this.#controller = c;
        },
        pull: () => this.#wake(),
        cancel: () => this.#finish(),
      },
      new ByteLengthQueuingStrategy({ highWaterMark: opts.highWaterMark ?? 64 * 1024 }),
    );
    if (opts.open !== false) this.#enqueue(encodeSseEvent(opts.open ?? { comment: "ok" }));
    const hb = opts.heartbeatMs ?? 15_000;
    if (hb > 0) this.#heartbeat = setInterval(() => this.comment(""), hb);
    if (opts.signal) {
      if (opts.signal.aborted) this.#finish();
      else opts.signal.addEventListener("abort", () => this.#finish(), { once: true });
    }
  }

  /** True once closed by either side. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Runs `fn` once the stream closes (client gone, server close, or `close()`). */
  onClose(fn: () => void): void {
    if (this.#closed) queueMicrotask(fn);
    else this.#closeListeners.push(fn);
  }

  /**
   * Queues one event. Resolves at once while under the high-water mark, or
   * once the client has read enough; resolves `false` if the stream is closed.
   */
  send(m: SseMessage | Uint8Array): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    this.#enqueue(m instanceof Uint8Array ? m : encodeSseEvent(m));
    if (this.#closed) return Promise.resolve(false);
    if ((this.#controller.desiredSize ?? 0) > 0) return Promise.resolve(true);
    return new Promise((resolve) => this.#waiters.push(() => resolve(!this.#closed)));
  }

  /** A comment line (`: text`). */
  comment(text: string): void {
    if (!this.#closed) this.#enqueue(encodeSseEvent({ comment: text }));
  }

  /** Ends the stream after what is queued. */
  close(): void {
    if (this.#closed) return;
    try {
      this.#controller.close();
    } catch {}
    this.#finish();
  }

  #enqueue(bytes: Uint8Array): void {
    try {
      this.#controller.enqueue(bytes);
    } catch {
      this.#finish();
      return;
    }
    // A client that stopped reading: close rather than buffer without bound.
    if (-(this.#controller.desiredSize ?? 0) > this.#max) {
      try {
        this.#controller.error(new Error("SSE client too slow"));
      } catch {}
      this.#finish();
    }
  }

  #wake(): void {
    const w = this.#waiters;
    this.#waiters = [];
    for (const f of w) f();
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    this.#wake();
    for (const f of this.#closeListeners.splice(0)) f();
  }
}

/** The response headers every helper sends. */
export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
};

/**
 * A standalone `Response` (native routes, `Bun.serve` fetch, tests). The
 * source is an async iterable of messages, or a function given the stream.
 * When `server` and `request` are passed, the request is exempted from
 * `idleTimeout`.
 */
export function sseResponse(
  source: AsyncIterable<SseMessage> | ((s: SseStream) => unknown),
  init: SseStreamOptions & { request?: Request; server?: Bun.Server<unknown>; headers?: HeadersInit; status?: number } = {},
): Response {
  const stream = new SseStream({ signal: init.request?.signal, ...init });
  if (init.server && init.request) init.server.timeout(init.request, 0);
  const run = async (): Promise<void> => {
    try {
      if (typeof source === "function") {
        await source(stream);
        return;
      }
      for await (const m of source) {
        if (!(await stream.send(m))) return;
      }
      stream.close();
    } catch (error) {
      await stream.send({ event: "error", data: error instanceof Error ? error.message : String(error) });
      stream.close();
    }
  };
  void run();
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(SSE_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(stream.readable, { status: init.status ?? 200, headers });
}

/** What `res.sse(options)` would do on BunResponse, prototyped as a function. */
export function sse(req: BunRequest, res: BunResponse, opts: SseStreamOptions = {}): SseStream {
  const stream = new SseStream({ signal: req.request.signal, ...opts });
  // The fetch() stub server has no `timeout`; a real one does.
  const server = req.server as (Bun.Server<unknown> & { timeout?: unknown }) | undefined;
  if (typeof server?.timeout === "function") server.timeout(req.request, 0);
  for (const [k, v] of Object.entries(SSE_HEADERS)) if (!res.hasHeader(k)) res.setHeader(k, v);
  res.send(stream.readable);
  return stream;
}
