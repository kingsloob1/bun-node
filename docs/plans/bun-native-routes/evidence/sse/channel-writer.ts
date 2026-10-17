/**
 * The prototype `SseStream` (prototype-sse.ts) with one change the channel
 * measurement asked for: `send()` returns **shared** promises. The stock
 * writer allocates a promise per call, and past the high-water mark a
 * promise plus a waiter closure per call, which a hub that never awaits
 * piles up on a stalled client until `maxQueuedBytes` trips (~146k of them
 * for 58-byte events at 8 MiB; channel-perf.ts measures the cost). Here a
 * call under the mark returns one resolved constant, and every call during
 * one backed-up period returns the same drain promise.
 *
 * Only what the channel uses is copied (no heartbeat, no signal): the
 * channel runs one shared heartbeat, and `sseShared()` wires the abort.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { SseStreamOptions } from "./prototype-sse";
import { encodeSseEvent, SSE_HEADERS } from "./prototype-sse";

const TRUE = Promise.resolve(true);
const FALSE = Promise.resolve(false);

/** A byte writer onto one event stream whose `send()` allocates nothing per call. */
export class SharedDrainWriter {
  /** The response body. */
  readonly readable: ReadableStream<Uint8Array>;
  #c!: ReadableStreamDefaultController<Uint8Array>;
  #closed = false;
  #drain: PromiseWithResolvers<boolean> | undefined;
  readonly #max: number;
  readonly #listeners: (() => void)[] = [];

  constructor(opts: SseStreamOptions = {}) {
    this.#max = opts.maxQueuedBytes ?? 8 * 1024 * 1024;
    this.readable = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          this.#c = c;
        },
        pull: () => this.#wake(),
        cancel: () => this.#finish(),
      },
      new ByteLengthQueuingStrategy({ highWaterMark: opts.highWaterMark ?? 64 * 1024 }),
    );
    if (opts.open !== false) this.send(encodeSseEvent(opts.open ?? { comment: "ok" }));
  }

  /** True once closed by either side. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Runs `fn` once the stream closes. */
  onClose(fn: () => void): void {
    if (this.#closed) queueMicrotask(fn);
    else this.#listeners.push(fn);
  }

  /** Queues bytes; the promise is shared (see the file comment). */
  send(bytes: Uint8Array): Promise<boolean> {
    if (this.#closed) return FALSE;
    try {
      this.#c.enqueue(bytes);
    } catch {
      this.#finish();
      return FALSE;
    }
    const desired = this.#c.desiredSize ?? 0;
    if (-desired > this.#max) {
      try {
        this.#c.error(new Error("SSE client too slow"));
      } catch {}
      this.#finish();
      return FALSE;
    }
    if (desired > 0) return TRUE;
    return (this.#drain ??= Promise.withResolvers<boolean>()).promise;
  }

  /** Ends the stream after what is queued. */
  close(): void {
    if (this.#closed) return;
    try {
      this.#c.close();
    } catch {}
    this.#finish();
  }

  #wake(): void {
    const d = this.#drain;
    this.#drain = undefined;
    d?.resolve(!this.#closed);
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake();
    for (const f of this.#listeners.splice(0)) f();
  }
}

/** `sse()` over {@link SharedDrainWriter}: headers, idle exemption, abort on disconnect. */
export function sseShared(req: BunRequest, res: BunResponse, opts: SseStreamOptions = {}): SharedDrainWriter {
  const w = new SharedDrainWriter(opts);
  const signal = req.request.signal;
  if (signal.aborted) w.close();
  else signal.addEventListener("abort", () => w.close(), { once: true });
  const server = req.server as (Bun.Server<unknown> & { timeout?: unknown }) | undefined;
  if (typeof server?.timeout === "function") server.timeout(req.request, 0);
  for (const [k, v] of Object.entries(SSE_HEADERS)) if (!res.hasHeader(k)) res.setHeader(k, v);
  res.send(w.readable);
  return w;
}
