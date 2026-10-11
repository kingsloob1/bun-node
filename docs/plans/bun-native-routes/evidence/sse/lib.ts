/**
 * Shared bits for the SSE spikes: a timestamped event-stream reader, so each
 * probe can say *when* each event reached the client, not only that it did.
 *
 * The reader splits on a blank line (LF LF) only, which is all these spikes'
 * servers emit; the real parser (WHATWG, CR/LF/CRLF) is bun-jobs'
 * `lib/remote/protocol/sse.ts`, and a test reader for the packages is part of
 * the plan (§16.6).
 */

/** One event block as the client saw it, with its arrival time. */
export interface Arrival {
  /** Milliseconds since the reader's `t0`. */
  at: number;
  /** The raw block, without its terminating blank line. */
  block: string;
}

/** What {@link readEvents} saw. */
export interface ReadOutcome {
  /** Every block, in arrival order. */
  events: Arrival[];
  /** How the stream ended: `done`, `error: …`, or `timeout` (still open). */
  end: string;
  /** When it ended, ms since `t0`. */
  endAt: number;
}

/**
 * Reads `body` until it ends, errors, `max` blocks arrive, or `timeoutMs`
 * passes. Blocks consisting only of comment lines are kept (`: ping`).
 */
export async function readEvents(
  body: ReadableStream<Uint8Array> | null,
  t0: number,
  opts: { max?: number; timeoutMs?: number } = {},
): Promise<ReadOutcome> {
  const events: Arrival[] = [];
  if (!body) {
    return { events, end: "no body", endAt: ms(t0) };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = opts.timeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(resolve, deadline, "timeout");
  });
  try {
    while (events.length < (opts.max ?? Infinity)) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next === "timeout") {
        void reader.cancel().catch(() => undefined);
        return { events, end: "timeout", endAt: ms(t0) };
      }
      if (next.done) {
        return { events, end: "done", endAt: ms(t0) };
      }
      buffer += decoder.decode(next.value, { stream: true });
      let i = buffer.indexOf("\n\n");
      while (i !== -1) {
        const block = buffer.slice(0, i).replace(/^\n+/, "");
        buffer = buffer.slice(i + 2);
        if (block) {
          events.push({ at: ms(t0), block });
        }
        i = buffer.indexOf("\n\n");
      }
    }
    void reader.cancel().catch(() => undefined);
    return { events, end: `max ${opts.max}`, endAt: ms(t0) };
  } catch (error) {
    return {
      events,
      end: `error: ${(error as Error).message ?? String(error)}`,
      endAt: ms(t0),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Milliseconds since `t0`, rounded. */
export function ms(t0: number): number {
  return Math.round(performance.now() - t0);
}

/** A compact one-line rendering of an outcome. */
export function show(o: ReadOutcome): string {
  const ev = o.events
    .map((e) => `${e.at}ms:${JSON.stringify(e.block)}`)
    .join(" ");
  return `[${ev}] end=${o.end}@${o.endAt}ms`;
}

/** Prints a labelled line and returns it, for the results file. */
export function log(label: string, value: unknown): void {
  console.log(`${label.padEnd(58)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
}
