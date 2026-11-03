/**
 * `sse()`, an event stream's declaration (bun-validate V3b, plan
 * `docs/plans/bun-validate/` §4.4.1, §4.7): a `text/event-stream` body
 * checked event by event by the response gate, the events an `SseWriter`'s
 * `contract` types and checks (bun-native-routes PR-sse2), and what OpenAPI
 * lists as `x-sse-events`. It lives here rather than in `responseBodies.ts`,
 * which re-exports it, so the browser-safe `@kingsleyweb/bun-common/sse`
 * carries it: a module shared by a server and its typed client declares the
 * events once.
 *
 * Browser-safe: it imports only the contract core.
 */
import type { AnyContract, Schema } from "../contract/model";
import type { StandardSchemaV1 } from "../types/standardSchema";
import { markKind, markNested } from "../contract/schemas";
import { sseTransport } from "../contract/sse";
import { isSchema } from "../contract/transport";

/**
 * How an `sse()` event's `data` reaches its schema: `"json"` parses the
 * event's data (its `data:` lines joined with `\n`) as JSON, and a data that
 * does not parse is a mismatch; `"text"` hands the schema the string as it is.
 */
export type SseDataFormat = "json" | "text";

/** Options of {@link sse}. */
export interface SseOptions<D extends SseDataFormat = SseDataFormat> {
  /** How each event's `data` is decoded for its schema ({@link SseDataFormat}). Default `"json"`. */
  readonly data?: D;
}

/** An `sse()` declaration's events: name to the schema of its `data`, or `null` for an event that carries none. */
export type SseEventMap = Readonly<Record<string, StandardSchemaV1 | null>>;

/** A `text/event-stream` body checked event by event: what {@link sse} returns. */
export interface SseEvents<
  E extends SseEventMap = SseEventMap,
  D extends SseDataFormat = SseDataFormat,
> extends StandardSchemaV1<unknown, unknown> {
  /** Always `"sse"`. */
  readonly kind: "sse";
  /** The declared events (`message` is the name of an event with no `event:` line). */
  readonly events: E;
  /** How each event's `data` is decoded. */
  readonly data: D;
}

/** Whether `value` is a plain object (a literal, or one with a null prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** The `~standard` of a helper that describes a stream: run directly, it refuses every value. */
/**
 * @param vendor The helper's vendor name.
 * @internal
 */
export function streamProps(
  vendor: string,
): StandardSchemaV1.Props<unknown, unknown> {
  return {
    version: 1,
    vendor,
    validate: () => ({
      issues: [
        {
          message:
            "A streamed body is checked chunk by chunk by the response gate, not as one value",
        },
      ],
    }),
  };
}

/**
 * Declares a `text/event-stream` body checked **event by event**: the bytes
 * are framed into events across chunk boundaries (lines ending in CRLF, LF
 * or CR; a blank line ends an event; comments, and blocks with only `id:` or
 * `retry:`, are not events), the schema is chosen by the event's name
 * (`message` when it has no `event:` line), and its `data` is decoded as
 * `options.data` says. An undeclared name is a mismatch; a `null` event must
 * carry no data. An event the stream ends in the middle of is not checked
 * (a client never dispatches it).
 *
 * Under `"error"` the stream stops at the bad event: the write (or piped
 * chunk) completing it is not sent, and the stream is cut off and logged at
 * `error`. Its events are listed by `describeContract` as the row's `nested`
 * rows, keyed by `event` with the parts `data` and `id`.
 *
 * @param events  Event name to the schema of its `data`, or `null`.
 * @param options `data` ({@link SseDataFormat}); default `"json"`.
 */
export function sse<
  const E extends SseEventMap,
  const D extends SseDataFormat = "json",
>(events: E, options?: SseOptions<D>): SseEvents<E, D> {
  if (!isPlainObject(events)) {
    throw new TypeError("sse(): expected an object of event names");
  }
  const outbound: Record<string, { data: Schema | null }> = {};
  for (const [name, schema] of Object.entries(events)) {
    if (/[\r\n]/.test(name)) {
      throw new TypeError(
        `sse(): ${JSON.stringify(name)} is not an event name (it holds a line break)`,
      );
    }
    if (schema !== null && !isSchema(schema)) {
      throw new TypeError(
        `sse(): event ${JSON.stringify(name)} must be a Standard Schema or null`,
      );
    }
    outbound[name] = { data: schema };
  }
  const data = (options?.data ?? "json") as D;
  if (data !== "json" && data !== "text") {
    throw new TypeError('sse(): data must be "json" or "text"');
  }
  const out: SseEvents<E, D> = {
    kind: "sse",
    events,
    data,
    "~standard": streamProps("bun-common/sse"),
  };
  const contract: AnyContract = sseTransport.contract({ outbound } as never);
  return markNested(markKind(out, "sse"), contract);
}
