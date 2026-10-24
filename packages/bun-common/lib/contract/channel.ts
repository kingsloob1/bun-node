/**
 * A WebSocket channel's pure contract half (bun-validate V8, plan
 * `docs/plans/bun-validate/` §4.6.1, §4.12 M7/m12): the `websocket`
 * transport (both sides keyed by `type`, one part `data`), the channel's
 * declaration shape, the frame shapes (the error frame included), and
 * `channelContract()`, building the contract the server binding
 * (`../channel.ts`'s `defineChannel`) and a browser client share. Nothing
 * here imports a Bun or Node API, so this module is browser-safe.
 */
import type { StandardSchemaV1 } from "../types/standardSchema";
import type { AnyContract, Policy, ValidationIssue } from "./model";
import { documented } from "./schemas";
import { defineTransport } from "./transport";

/* ------------------------------------------------------------------ *
 * The transport and the declaration
 * ------------------------------------------------------------------ */

/**
 * The WebSocket transport: both sides keyed by the message's `type`, one
 * part, `data`. A channel's contract is declared with
 * {@link channelContract}; the transport is exported for documents'
 * and the typed client's reading of its spec.
 */
export const wsTransport = defineTransport({
  name: "websocket",
  inbound: { key: "type", parts: ["data"] },
  outbound: { key: "type", parts: ["data"] },
});

/**
 * The upgrade request's schemas (bun-common's `validate()` targets minus
 * `body`: an upgrade is a GET). Checked before the upgrade answers 101; a
 * failure answers the refusal and no socket opens.
 */
export type ChannelRequestSchemas = {
  readonly [
    P in "params" | "query" | "headers" | "cookies" | "signedCookies"
  ]?: StandardSchemaV1;
};

/** A channel's message map (`receives` or `sends`): message type to its data's schema, or `null` for no data. */
export type ChannelMessages = Readonly<Record<string, StandardSchemaV1 | null>>;

/** What a channel carries beside its schemas (plan §4.12 M7): read by the typed client's channel model. */
export interface ChannelMeta {
  /** The route path the channel is served on. */
  readonly path: string;
  /** The envelope: the frame's correlation field, `"id"` by default. */
  readonly envelope: { readonly idField: string };
  /** An inbound type to the outbound type answering it, where one does. */
  readonly replies: Readonly<Record<string, string>>;
  /** Whether binary frames are accepted: the client may send the JSON envelope as a binary frame (decoded as UTF-8, checked like a text frame). Default `false`: a binary frame is an `UNSUPPORTED_DATA` error. */
  readonly binary: boolean;
  /** The subprotocol the upgrade answers, when one is set. */
  readonly subprotocol: string | undefined;
  /** The topics the channel publishes on, when declared. */
  readonly topics: readonly string[] | undefined;
  /** An SSE endpoint carrying the same messages, when one exists. */
  readonly fallback: string | undefined;
}

/** What {@link channelContract} takes (and {@link defineChannel}). */
export interface ChannelSpec {
  /** The route path the channel is served on. */
  readonly path: string;
  /** The upgrade request's schemas (checked before the 101). */
  readonly request?: ChannelRequestSchemas;
  /** Client → server messages, keyed by `type`; a `null` value means the message carries no data. */
  readonly receives: ChannelMessages;
  /** Server → client messages, keyed by `type`; the implicit `error` frame is added when none is declared. */
  readonly sends: ChannelMessages;
  /** The policies: `in` for received frames (default `"error"`), `out` for sent ones (default `"error"`). */
  readonly messageValidation?: { readonly in?: Policy; readonly out?: Policy };
  /** Close with `1007` on an invalid frame instead of answering it and staying open. Default `false`. */
  readonly closeOnInvalid?: boolean;
  /** Binary frames are accepted: the client may send the JSON envelope as a binary frame (decoded as UTF-8, checked like a text frame). Default `false`. */
  readonly binary?: boolean;
  /** The subprotocol the upgrade answers with. */
  readonly subprotocol?: string;
  /** The envelope's correlation field. Default `"id"`. */
  readonly envelope?: { readonly idField?: string };
  /** An inbound type to the outbound type answering it, where one does. */
  readonly replies?: Readonly<Record<string, string>>;
  /** The topics the channel publishes on, when declared. */
  readonly topics?: readonly string[];
  /** An SSE endpoint carrying the same messages, when one exists. */
  readonly fallback?: string;
  /** A stable name and prose for generated documents. */
  readonly meta?: { readonly name?: string; readonly description?: string };
}

/* ------------------------------------------------------------------ *
 * The frames
 * ------------------------------------------------------------------ */

/** The wire envelope of a typed channel message. */
export interface ChannelMessage<T = string, D = unknown> {
  /** The message's type (the key of the channel's maps). */
  type: T;
  /** The correlation id, when the frame carries one. */
  id?: string;
  /** The message's data. */
  data?: D;
}

/** The error codes a channel answers with (Q10's shape). */
export type ChannelErrorCode =
  "VALIDATION" | "UNKNOWN_MESSAGE" | "UNSUPPORTED_DATA";

/**
 * The error frame (plan §8.1 Q10): an invalid message is answered
 * `{ type: "error", id?, code: "VALIDATION", status: 400, issues }` (the
 * bun-jobs socket's shape plus the issues, value-free), an unknown message
 * type with `code: "UNKNOWN_MESSAGE"`, and a binary frame the channel did
 * not declare with `code: "UNSUPPORTED_DATA"`. The socket stays open, unless
 * the channel sets `closeOnInvalid` (then it closes with `1007`).
 */
export interface ChannelErrorFrame {
  /** `"error"`. */
  type: "error";
  /** The offending frame's id, echoed. */
  id?: string;
  /** What failed. */
  code: ChannelErrorCode;
  /** 400. */
  status: number;
  /** Every issue (value-free), for a `VALIDATION`. */
  issues?: readonly ValidationIssue[];
  /** What went wrong, for a non-validation error. */
  detail?: string;
}

/** The error frame for one issue list, or one detail. */
export function channelErrorFrame(
  code: ChannelErrorCode,
  body: { issues?: readonly ValidationIssue[]; detail?: string },
  id?: string,
): ChannelErrorFrame {
  return {
    type: "error",
    ...(id === undefined ? {} : { id }),
    code,
    status: 400,
    ...(body.issues === undefined ? {} : { issues: body.issues }),
    ...(body.detail === undefined ? {} : { detail: body.detail }),
  };
}

/** The implicit `error` frame's payload, as JSON Schema (M6's `documented()`), for the declared outbound key. */
const ERROR_PAYLOAD_JSON = {
  type: "object",
  properties: {
    code: { enum: ["VALIDATION", "UNKNOWN_MESSAGE", "UNSUPPORTED_DATA"] },
    status: { type: "integer" },
    detail: { type: "string" },
    issues: { type: "array", items: { type: "object" } },
  },
  required: ["code", "status"],
} as const;

/* ------------------------------------------------------------------ *
 * The contract
 * ------------------------------------------------------------------ */

/** A side's declaration normalized: each message type to its parts (`null` is `{ data: null }`, plan M7/P5). */
function normalizeSide(
  messages: ChannelMessages,
  side: string,
): Record<string, { data: StandardSchemaV1 | null }> {
  const out: Record<string, { data: StandardSchemaV1 | null }> = {};
  for (const [type, schema] of Object.entries(messages)) {
    if (schema !== null && !isStandardSchema(schema)) {
      throw new TypeError(
        `defineChannel(): the ${side} "${type}" must be a Standard Schema or null`,
      );
    }
    out[type] = { data: schema };
  }
  return out;
}

/** Whether `value` is a Standard Schema (has a `~standard.validate`). */
function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return false;
  }
  const props = (value as { "~standard"?: { validate?: unknown } })[
    "~standard"
  ];
  return typeof props?.validate === "function";
}

/** A channel's contract: the `websocket` transport's, built from the spec, with the channel's meta (M7) and its spec carried. */
export interface ChannelContract<S extends ChannelSpec = ChannelSpec> {
  /** The contract (both sides of the `websocket` transport, the implicit `error` key declared). */
  readonly contract: AnyContract;
  /** The channel's meta (the typed client reads it). */
  readonly meta: ChannelMeta;
  /** The channel's spec, as declared. */
  readonly spec: S;
}

/**
 * Builds a channel's contract from its spec: both sides of the `websocket`
 * transport (each message type normalized to `{ data }`, a `null` entry
 * meaning no data), with the implicit `error` frame as a declared outbound
 * key (documents read it through `describeContract`), and the channel's meta
 * (M7) carried. Browser-safe; the server binding is `../channel.ts`'s
 * `defineChannel`.
 *
 * @param spec The channel's declaration. A `receives`/`sends` entry that is
 *   not a Standard Schema or `null` throws a `TypeError` here, at the
 *   declaration.
 */
export function channelContract<const S extends ChannelSpec>(
  spec: S,
): ChannelContract<S> {
  if (typeof spec?.path !== "string" || !spec.path.startsWith("/")) {
    throw new TypeError(
      'defineChannel(): "path" must be a route path (starting with "/")',
    );
  }
  const receives = normalizeSide(spec.receives, "receives");
  const sends = normalizeSide(spec.sends, "sends");
  if (!("error" in sends)) {
    sends.error = { data: documented(ERROR_PAYLOAD_JSON) };
  }
  const meta: ChannelMeta = {
    path: spec.path,
    envelope: { idField: spec.envelope?.idField ?? "id" },
    replies: spec.replies ?? {},
    binary: spec.binary === true,
    subprotocol: spec.subprotocol,
    topics: spec.topics,
    fallback: spec.fallback,
  };
  const contract = wsTransport.contract(
    { inbound: receives, outbound: sends },
    { name: spec.meta?.name ?? spec.path, description: spec.meta?.description },
  );
  return { contract, meta, spec };
}
