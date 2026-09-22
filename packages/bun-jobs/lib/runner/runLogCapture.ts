import type { LogFields, Logger, LogLevel } from "@kingsleyweb/bun-common";
import type { RunLogCaps, RunLogInput, RunnerDriver } from "../drivers/index";
import type { RunLogStream } from "../shared/constants";
import type { ResolvedRunLogCaptureOptions, RunLogOptions } from "./types";
import { Buffer } from "node:buffer";
import {
  RUN_LOG_FLUSH_BYTES,
  RUN_LOG_FLUSH_LINES,
  RUN_LOG_FLUSH_MS,
  RUN_LOG_GRACE_MS,
  RUN_LOG_HINT_MS,
} from "../shared/constants";

/**
 * Capturing one run's output and handing it to the store.
 *
 * A run says things in three ways — it writes to `stdout`, it writes to
 * `stderr`, and it calls `ctx.log()` — and all three arrive here as lines,
 * which are buffered and flushed to {@link RunnerDriver.appendRunLog} in
 * batches. The store numbers them (see `RunLogInput`), so capture never
 * assigns a `seq` and never has to know what the run's last number was.
 *
 * Two rules shape everything below:
 *
 * - **Capture never changes a run's outcome.** A store that throws, a store
 *   that cannot hold logs at all, a run past its capture ceiling — each drops
 *   lines quietly and lets the run finish. Nothing here rejects, and the one
 *   promise the runner awaits (`close`) is bounded by
 *   `RUN_LOG_GRACE_MS`.
 * - **Capture never blocks the run.** `line()` and `output()` return `void`
 *   and cost a `push`; the flush happens on a promise chain of its own, and
 *   there is no round trip per line. A chatty child therefore cannot deadlock
 *   on a parent that is waiting for a database.
 *
 * What escapes it, deliberately: output written by native code inside the
 * child (a C library writing to fd 1 directly still reaches the pipe, but a
 * library that writes to the terminal does not), and anything a program the
 * handler itself launched prints to its own stdio rather than inheriting the
 * child's. Capture sees the child's two pipes and its IPC channel, nothing
 * else. A `worker` or `in-process` run has no pipes: its console calls arrive
 * through `consoleCapture.ts` instead, and reach {@link RunLogCapture.output}
 * exactly as a pipe's chunks do.
 *
 * Every line is redacted (`ResolvedRunLogCaptureOptions.redact`) as it is
 * emitted — before the per-line cut and before any byte of it is counted, so
 * every cap measures the line exactly as it will be stored.
 *
 * When the store accepts lines and the run's `lastSeq` grows, capture calls
 * its `hint` — the runner's `logs` event — throttled to one per
 * `RUN_LOG_HINT_MS`, with the newest `lastSeq` and nothing else: never a line.
 */

/** What a run's log holds, as the last append reported it. */
export interface RunLogTotals {
  /** How many lines the run's log holds now, after the store's caps. */
  count: number;
  /** How many of the run's lines the store's caps have dropped. */
  dropped: number;
}

/** Everything {@link RunLogCapture} needs to store one run's lines. */
export interface RunLogCaptureInit {
  /** The driver to append to; it must implement `appendRunLog`. */
  driver: RunnerDriver;
  /** The namespace the runner belongs to. */
  namespace: string;
  /** The runner's storage key. */
  key: string;
  /** The run whose log this is. */
  runId: string;
  /** The caps the store applies on every append. */
  caps: RunLogCaps;
  /** The resolved capture settings: the per-line and per-run byte ceilings. */
  options: ResolvedRunLogCaptureOptions;
  /** Where a capture failure is reported — once per run, never per line. */
  logger: Logger;
  /**
   * Which of the child's stdio streams are actually piped to this process, so
   * {@link RunLogCapture.close} knows which ends to wait for. Empty for a
   * `worker` or `in-process` run, which has no pipe of its own.
   */
  streams?: readonly ("stdout" | "stderr")[];
  /**
   * The clock, so a test can pin `at`. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Told that the run's stored log grew, with its new `lastSeq` — the number
   * of the last line the store holds. Throttled here to one call per
   * `RUN_LOG_HINT_MS`, the rest collapsing into one trailing call with the
   * newest value, and called once more at {@link RunLogCapture.close} if the
   * last value was not yet announced. Never passed a line. A hint that throws
   * is ignored. Omit it and nothing is announced.
   */
  hint?: (lastSeq: number) => void;
}

/** One stream's line assembly state. */
interface StreamState {
  /** Bytes read since the last newline, still waiting for one. */
  partial: string;
  /**
   * Set once the line being assembled has passed `maxLineBytes` and been
   * emitted cut: the rest of it is discarded until the next newline, so one
   * enormous line becomes one truncated line rather than a run of them.
   */
  overflowed: boolean;
  /** Whether the stream has reported that it is over. */
  ended: boolean;
}

/** How long `close` waits between checks for the pipes to finish, in ms. */
const DRAIN_POLL_MS = 5;

/**
 * What a line becomes when redaction itself fails. Failing closed: a line that
 * could not be checked for secrets is not stored as it was.
 */
export const REDACTION_FAILED_TEXT =
  "[bun-jobs] line withheld: redaction failed";

/**
 * Cuts `text` to at most `maxBytes` UTF-8 bytes, never mid-character.
 *
 * Slicing the encoded bytes and decoding what is left would leave a partial
 * code point at the end, which decodes to `U+FFFD` — a line that ends in a
 * replacement character reads as corrupt storage rather than as a line that
 * was too long. Walking back over the continuation bytes (`10xxxxxx`) first
 * means the cut always lands on a character boundary.
 */
export function cutToBytes(
  /** The line to cut. */
  text: string,
  /** The most UTF-8 bytes to keep; `0` or less keeps nothing. */
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return { text, truncated: false };
  }

  let end = Math.max(0, maxBytes);
  // 0b10xxxxxx marks a continuation byte: back up until the cut is the start
  // of a character.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end--;
  }

  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * Renders a structured log call to the one line the `log` stream stores.
 *
 * `key=value` pairs after the message, JSON-quoted only where a bare value
 * would be ambiguous, so the common case (`count=3`, `file=/tmp/x`) stays
 * readable and an awkward one (a value with a space, a quote or an `=`) stays
 * unambiguous.
 */
export function renderRunLogLine(
  /** The message the caller gave. */
  message: string,
  /** Its structured fields, if any. */
  fields?: LogFields,
): string {
  if (!fields) {
    return message;
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}=${renderValue(value)}`);
  }

  return parts.length === 0 ? message : `${message} ${parts.join(" ")}`;
}

/** One field's value as the rendered line spells it. */
function renderValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  }

  if (value instanceof Error) {
    return JSON.stringify(`${value.name}: ${value.message}`);
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A circular or otherwise unserialisable field must not cost the line.
    return String(value);
  }
}

/** UTF-8 bytes of one line's text — what every cap here counts. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Buffers one run's captured lines and flushes them to the store.
 *
 * Created per run by `BunRunner`, and only when the driver can store run logs
 * at all: a driver without `appendRunLog` gets no capture object, so there is
 * no per-line branch for the case.
 */
export class RunLogCapture {
  /** Where lines are stored. */
  readonly #driver: RunnerDriver;
  /** The namespace the runner belongs to. */
  readonly #namespace: string;
  /** The runner's storage key. */
  readonly #key: string;
  /** The run whose log this is. */
  readonly #runId: string;
  /** The caps handed to the store on every append. */
  readonly #caps: RunLogCaps;
  /** The resolved per-line and per-run byte ceilings. */
  readonly #options: ResolvedRunLogCaptureOptions;
  /** Where a capture failure is reported, once. */
  readonly #logger: Logger;
  /** The clock. */
  readonly #now: () => number;

  /** Lines waiting for the next flush. */
  #buffer: RunLogInput[] = [];
  /** UTF-8 bytes of the text in {@link #buffer}. */
  #bufferBytes = 0;
  /** UTF-8 bytes this run has handed over in total, against `captureBytes`. */
  #captured = 0;
  /** Set once the capture ceiling was reached: nothing more is accepted. */
  #ceilinged = false;
  /** Set once an append threw: the rest of the run's lines are dropped. */
  #failed = false;
  /** Set by {@link close}: `output`/`line` stop accepting. */
  #closed = false;
  /** The `RUN_LOG_FLUSH_MS` timer, when a partial buffer is waiting. */
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Appends run one at a time, so the store numbers lines in capture order. */
  #chain: Promise<void> = Promise.resolve();
  /** What the last append said the log holds. */
  #totals: RunLogTotals = { count: 0, dropped: 0 };
  /** Announces the log's growth; see {@link RunLogCaptureInit.hint}. */
  readonly #hint: ((lastSeq: number) => void) | undefined;
  /** The newest `lastSeq` the store has reported. */
  #lastSeq = 0;
  /** The newest `lastSeq` already announced. */
  #announced = 0;
  /** When the last hint went out, epoch ms. */
  #hintAt = Number.NEGATIVE_INFINITY;
  /** The trailing-hint timer, while one is waiting out the window. */
  #hintTimer: ReturnType<typeof setTimeout> | undefined;

  /** Per-stream line assembly, for the piped streams. */
  readonly #streams: Record<"stdout" | "stderr", StreamState> = {
    stdout: { partial: "", overflowed: false, ended: false },
    stderr: { partial: "", overflowed: false, ended: false },
  };

  /** Which streams are piped here, and so must end before the final flush. */
  readonly #piped: readonly ("stdout" | "stderr")[];

  constructor(init: RunLogCaptureInit) {
    this.#driver = init.driver;
    this.#namespace = init.namespace;
    this.#key = init.key;
    this.#runId = init.runId;
    this.#caps = init.caps;
    this.#options = init.options;
    this.#logger = init.logger;
    this.#now = init.now ?? Date.now;
    this.#piped = init.streams ?? [];
    this.#hint = init.hint;
  }

  /** What the last append said this run's log holds. */
  get totals(): RunLogTotals {
    return this.#totals;
  }

  /**
   * Takes a chunk of a child's piped stream and turns whole lines into log
   * lines.
   *
   * A chunk is whatever the pipe handed over, so a line can arrive in pieces
   * and two lines can arrive in one chunk; what is left after the last newline
   * is held until the rest of it comes. `\r\n` loses its `\r`, matching what
   * `RunLogLine.text` promises.
   */
  output(
    /** Which of the child's streams the chunk came from. */
    stream: "stdout" | "stderr",
    /** The text read from it, exactly as decoded. */
    chunk: string,
  ): void {
    if (this.#closed || chunk === "") {
      return;
    }

    const state = this.#streams[stream];
    let rest = chunk;

    for (;;) {
      const newline = rest.indexOf("\n");

      if (state.overflowed) {
        // The rest of an over-long line is discarded rather than buffered:
        // holding it would let one line without a newline grow without bound
        // in a parent that is not even storing it.
        if (newline === -1) {
          return;
        }
        state.overflowed = false;
        state.partial = "";
        rest = rest.slice(newline + 1);
        continue;
      }

      if (newline === -1) {
        state.partial += rest;
        this.#spill(stream);
        return;
      }

      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);

      state.partial += piece;
      const text = state.partial;
      state.partial = "";
      this.#emit(stream, text.endsWith("\r") ? text.slice(0, -1) : text);
    }
  }

  /**
   * Reports that one piped stream is over, so {@link close} need not wait for
   * it. Whatever the stream left without a trailing newline is stored as an
   * ordinary line.
   */
  endOutput(
    /** The stream that ended. */
    stream: "stdout" | "stderr",
  ): void {
    const state = this.#streams[stream];
    if (state.ended) {
      return;
    }
    state.ended = true;

    if (state.partial !== "" && !state.overflowed && !this.#closed) {
      const text = state.partial;
      state.partial = "";
      this.#emit(stream, text.endsWith("\r") ? text.slice(0, -1) : text);
    }
    state.partial = "";
  }

  /**
   * Stores one structured line on the `log` stream: what `ctx.log()` and a
   * forwarded `ctx.logger` record both become.
   */
  line(
    /** The message. */
    message: string,
    /** Its level and fields; both optional. */
    options: RunLogOptions = {},
  ): void {
    if (this.#closed) {
      return;
    }

    this.#emit("log", renderRunLogLine(message, options.fields), options.level);
  }

  /**
   * Flushes whatever is buffered and resolves when the store has it.
   *
   * Never rejects: a failed append is reported once and swallowed, exactly as
   * a flush on the timer is.
   */
  async flush(): Promise<void> {
    this.#enqueue();
    await this.#chain;
  }

  /**
   * Ends capture: waits for the piped streams to finish, flushes what is left
   * and reports what the run's log holds.
   *
   * Bounded by `RUN_LOG_GRACE_MS` — a child's last writes are still in flight
   * when it exits, and cutting capture at the exit loses exactly the lines
   * that explain a failure — but no longer: the runner awaits this before it
   * finishes the run record, so an unresponsive store must not hold a run
   * open.
   */
  async close(): Promise<RunLogTotals> {
    if (this.#closed) {
      await this.#chain;
      return this.#totals;
    }

    const deadline = this.#now() + RUN_LOG_GRACE_MS;
    // The pipes are read by a loop of their own, so the last chunk can land
    // after the child's exit has already settled the run.
    while (
      this.#piped.some((stream) => !this.#streams[stream].ended) &&
      this.#now() < deadline
    ) {
      await Bun.sleep(DRAIN_POLL_MS);
    }

    for (const stream of this.#piped) {
      this.endOutput(stream);
    }

    this.#closed = true;
    this.#clearTimer();
    this.#enqueue();

    // Either the append lands or the grace runs out and the run carries on.
    // The chain never rejects (see `#drain`), and the timer is cleared as soon
    // as it does land, so a slow store cannot keep the process alive.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, deadline - this.#now()));
      timer.unref?.();
      void this.#chain.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    // The run is over: its last `lastSeq` is announced now rather than at the
    // end of a throttle window nobody needs to wait out.
    this.#clearHintTimer();
    this.#sendHint();

    return this.#totals;
  }

  /**
   * Emits a line that has already been assembled: cut to `maxLineBytes` on a
   * character boundary, then buffered.
   */
  #emit(stream: RunLogStream, raw: string, level?: LogLevel): void {
    // Redacted first, so the cut below and every byte count after it measure
    // the line as it will be stored — a secret replaced by a short marker
    // frees its bytes, and a line cut first could leave half a secret behind.
    const text = this.#redact(raw);

    // `0` is unbounded here, as it is for every other cap in the package.
    const cut =
      this.#options.maxLineBytes > 0
        ? cutToBytes(text, this.#options.maxLineBytes)
        : { text, truncated: false };

    this.#push({
      stream,
      at: this.#now(),
      text: cut.text,
      ...(cut.truncated ? { truncated: true as const } : {}),
      ...(level === undefined ? {} : { level }),
    });
  }

  /** One line with its secrets scrubbed; withheld outright if that fails. */
  #redact(text: string): string {
    const redact = this.#options.redact;
    if (!redact) {
      return text;
    }

    try {
      return redact(text);
    } catch {
      return REDACTION_FAILED_TEXT;
    }
  }

  /**
   * Notes the store's newest `lastSeq`, and announces it: at once when the
   * last hint is a window old, otherwise once the window is up.
   */
  #announce(lastSeq: number): void {
    if (!this.#hint || lastSeq <= this.#lastSeq) {
      return;
    }
    this.#lastSeq = lastSeq;

    if (this.#closed) {
      // A late append, after `close` gave up waiting for it: nothing is left
      // to collapse it with.
      this.#clearHintTimer();
      this.#sendHint();
      return;
    }

    const wait = this.#hintAt + RUN_LOG_HINT_MS - Date.now();
    if (wait <= 0) {
      this.#clearHintTimer();
      this.#sendHint();
      return;
    }

    if (this.#hintTimer === undefined) {
      this.#hintTimer = setTimeout(() => {
        this.#hintTimer = undefined;
        this.#sendHint();
      }, wait);
      this.#hintTimer.unref?.();
    }
  }

  /** Sends the hint for the newest `lastSeq`, if it has not gone out yet. */
  #sendHint(): void {
    if (!this.#hint || this.#lastSeq <= this.#announced) {
      return;
    }
    this.#announced = this.#lastSeq;
    this.#hintAt = Date.now();

    try {
      this.#hint(this.#lastSeq);
    } catch {
      // A hint is a courtesy to subscribers; it never costs the run anything.
    }
  }

  /** Stops the trailing-hint timer. */
  #clearHintTimer(): void {
    if (this.#hintTimer !== undefined) {
      clearTimeout(this.#hintTimer);
      this.#hintTimer = undefined;
    }
  }

  /**
   * Emits the line being assembled early, cut, when it has grown past the
   * per-line cap with no newline in sight.
   *
   * Checked in UTF-16 units, which are never more than the UTF-8 bytes of the
   * same string: over the cap in units is always over it in bytes, so this
   * never cuts a line that would have fitted, and holding at most `maxLineBytes`
   * units bounds what one line can cost in memory.
   */
  #spill(stream: "stdout" | "stderr"): void {
    const state = this.#streams[stream];
    if (
      this.#options.maxLineBytes <= 0 ||
      state.overflowed ||
      state.partial.length <= this.#options.maxLineBytes
    ) {
      return;
    }

    const text = state.partial;
    state.partial = "";
    state.overflowed = true;
    this.#emit(stream, text);
  }

  /** Buffers one line, and flushes when a threshold says to. */
  #push(line: RunLogInput): void {
    if (this.#ceilinged || this.#failed) {
      return;
    }

    const bytes = byteLength(line.text);

    if (
      this.#options.captureBytes > 0 &&
      this.#captured + bytes > this.#options.captureBytes
    ) {
      this.#ceilinged = true;
      // One line in the log itself, rather than a second drop counter that
      // would disagree with what `getRunLog` reports: the reader is told where
      // the output stops instead of being shown a log that just ends.
      const notice = `[bun-jobs] run log capture stopped: this run reached its captureBytes ceiling of ${this.#options.captureBytes} bytes`;
      this.#buffer.push({
        stream: "log",
        at: this.#now(),
        text: notice,
        level: "warn",
      });
      this.#bufferBytes += byteLength(notice);
      this.#clearTimer();
      this.#enqueue();
      return;
    }

    this.#captured += bytes;
    this.#buffer.push(line);
    this.#bufferBytes += bytes;

    if (
      this.#buffer.length >= RUN_LOG_FLUSH_LINES ||
      this.#bufferBytes >= RUN_LOG_FLUSH_BYTES
    ) {
      this.#clearTimer();
      this.#enqueue();
      return;
    }

    this.#arm();
  }

  /** Arms the `RUN_LOG_FLUSH_MS` timer, if it is not already running. */
  #arm(): void {
    if (this.#timer !== undefined) {
      return;
    }

    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#enqueue();
    }, RUN_LOG_FLUSH_MS);
    this.#timer.unref?.();
  }

  /** Stops the flush timer. */
  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * Puts one flush on the chain.
   *
   * Serialised rather than concurrent because the store numbers the lines:
   * two appends in flight at once would interleave a run's output.
   */
  #enqueue(): void {
    this.#chain = this.#chain.then(async () => {
      await this.#drain();
    });
  }

  /** Hands the buffer to the store; never rejects. */
  async #drain(): Promise<void> {
    if (this.#buffer.length === 0) {
      return;
    }

    const lines = this.#buffer;
    this.#buffer = [];
    this.#bufferBytes = 0;

    if (this.#failed) {
      return;
    }

    try {
      const result = await this.#driver.appendRunLog!(
        this.#namespace,
        this.#key,
        this.#runId,
        lines,
        this.#caps,
      );
      this.#totals = { count: result.count, dropped: result.dropped };
      this.#announce(result.lastSeq);
    } catch (error) {
      // Once per run, not once per line: a store that is down is one fact.
      this.#failed = true;
      this.#logger.warn(
        "Could not store this run's log lines; capture is off for the rest of the run",
        { error, runId: this.#runId },
      );
    }
  }
}
