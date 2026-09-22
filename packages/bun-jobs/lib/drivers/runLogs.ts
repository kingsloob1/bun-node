import type {
  RunLogInput,
  RunLogLine,
  RunLogPage,
  RunLogQuery,
} from "./driver";
import { Buffer } from "node:buffer";

/**
 * The parts of run-log storage every driver agrees on, in one place.
 *
 * Five backends store a run's lines five different ways — an array, a JSONL
 * file, rows, a Redis list, documents — but they must all answer the same
 * questions identically, because one cross-driver suite asserts every one of
 * them. What a line "costs", which lines a cap drops, and what a filtered page
 * looks like are therefore decided here rather than five times.
 */

/**
 * What one line counts as against {@link RunLogCaps.maxBytes}.
 *
 * The text's UTF-8 bytes and nothing else. Not the stream, not the timestamp,
 * and not whatever framing the backend wraps it in — JSON on the file and
 * Redis drivers, columns on SQL, a BSON document on MongoDB — so that the same
 * lines are bounded to the same number wherever they are stored.
 */
export function runLogBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** A line as an in-memory store holds it: the line, plus what it costs. */
export interface StoredRunLogLine extends RunLogLine {
  /** {@link runLogBytes} of its text, kept so a trim need not recompute it. */
  bytes: number;
}

/**
 * Numbers an incoming line and measures it.
 *
 * One place decides how the optional fields are stored: `level` and
 * `truncated` are written **only when they are there**, so a line without them
 * reads back without them on every backend, and `toEqual` in the contract
 * suite means the same thing for all eight.
 */
export function storeRunLogLine(
  /** The line as capture handed it over. */
  line: RunLogInput,
  /** The number to give it, from the run's own sequence. */
  seq: number,
): StoredRunLogLine {
  return {
    seq,
    stream: line.stream,
    at: line.at,
    text: line.text,
    bytes: runLogBytes(line.text),
    ...(line.level === undefined ? {} : { level: line.level }),
    ...(line.truncated ? { truncated: true as const } : {}),
  };
}

/** A stored line as the contract hands it back: everything but its size. */
export function readRunLogLine(line: StoredRunLogLine): RunLogLine {
  const { bytes: _bytes, ...rest } = line;
  return rest;
}

/**
 * How many of the oldest lines have to go for the caps to hold.
 *
 * Counted from the front, because both caps drop oldest-first: that is what
 * makes a run's log a *tail* of its output, and what lets `dropped` be read
 * off the gap in the numbering.
 *
 * Returns 0 when the log already fits, and never more than there are lines —
 * a single line over `maxBytes` on its own is kept, since dropping it would
 * leave an empty log and lose the only thing there was to show.
 */
export function runLogOverflow(
  /** The run's lines, oldest first. */
  lines: readonly StoredRunLogLine[],
  /** The caps to apply; `0` on either means unbounded. */
  caps: { maxLines: number; maxBytes: number },
): number {
  let drop = 0;

  if (caps.maxLines > 0 && lines.length > caps.maxLines) {
    drop = lines.length - caps.maxLines;
  }

  if (caps.maxBytes > 0) {
    let bytes = 0;
    for (let index = drop; index < lines.length; index++) {
      bytes += lines[index]!.bytes;
    }

    // One line always survives: an empty log says less than an over-long one.
    while (bytes > caps.maxBytes && drop < lines.length - 1) {
      bytes -= lines[drop]!.bytes;
      drop++;
    }
  }

  return drop;
}

/**
 * Applies {@link RunLogQuery}'s filters, order and page to lines already read.
 *
 * `dropped` and `lastSeq` are passed in rather than derived from `lines`,
 * because both describe the run's whole log and the filters must not move
 * them — a tail with a `stream` filter resumes from the last line *stored*,
 * or it re-reads everything the filter excluded.
 */
export function pageRunLog(
  /**
   * The run's lines, oldest first, unfiltered. A store's own `bytes` is
   * stripped on the way out: it is bookkeeping, not part of the contract.
   */
  lines: readonly (RunLogLine & { bytes?: number })[],
  /** What to filter, order and page by. */
  opts: RunLogQuery,
  /** The run's totals, which the filters do not change. */
  totals: { dropped: number; lastSeq: number },
): RunLogPage {
  const matched = lines.filter((line) => matchesRunLogQuery(line, opts));
  const ordered = opts.order === "desc" ? matched.toReversed() : matched;
  const offset = Math.max(0, Math.floor(opts.offset));
  const limit = Math.max(0, Math.floor(opts.limit));

  return {
    lines: ordered
      .slice(offset, offset + limit)
      .map(({ bytes: _bytes, ...line }) => line),
    count: matched.length,
    dropped: totals.dropped,
    lastSeq: totals.lastSeq,
  };
}

/** Whether one line passes a query's `since` and `stream` filters. */
export function matchesRunLogQuery(
  /** The line to test. */
  line: Pick<RunLogLine, "seq" | "stream">,
  /** The filters; either being absent passes everything. */
  opts: Pick<RunLogQuery, "since" | "stream">,
): boolean {
  if (opts.since !== undefined && line.seq <= opts.since) {
    return false;
  }

  return opts.stream === undefined || line.stream === opts.stream;
}

/** What {@link RunnerDriver.getRunLog} answers for a run it knows nothing of. */
export function emptyRunLog(): RunLogPage {
  return { lines: [], count: 0, dropped: 0, lastSeq: 0 };
}
