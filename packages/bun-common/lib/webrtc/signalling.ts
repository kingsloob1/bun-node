/**
 * `signallingContract` (typed-client plan, `webrtc.md` §3, PR-R1): a ready-made
 * WebRTC signalling channel, a `channelContract()` whose messages are the
 * browser's own shapes (`RTCSessionDescriptionInit`, `RTCIceCandidateInit`)
 * addressed to a named peer in a room. The relay that serves it is
 * `signallingRelay` (`./relay.ts`); a client opens it with bun-client's
 * `channel()` and hands it to `connectPeer` (bun-client `./webrtc`).
 *
 * ```ts
 * // shared, browser-safe module
 * export const signalling = signallingContract({ path: "/rtc/:room" });
 * ```
 *
 * | Client → relay (`receives`) | Relay → client (`sends`) |
 * |---|---|
 * | `join { peer }`, answered with `peers` | `peers { peers }`: the others already in the room |
 * | `leave` (no data) | `join { peer }` / `leave { peer }`: another peer came or went |
 * | `offer { to, description }` | `offer { from, description }` |
 * | `answer { to, description }` | `answer { from, description }` |
 * | `candidate { to, candidate }` | `candidate { from, candidate }` |
 *
 * plus the channel's implicit `error` frame, which the relay also answers a
 * frame for a peer that is not in the sender's room with.
 *
 * The schemas are written here, with no vendor, so this module takes no
 * dependency; each carries its JSON Schema, so the AsyncAPI document
 * describes the messages. They keep only the declared fields (anything else
 * a frame carries is dropped, never relayed) and bound every string: a peer
 * name 1–128 characters, an SDP 64 KiB, a candidate line 4 KiB.
 *
 * Browser-safe: it imports only the contract core.
 */
import type {
  ChannelContract,
  ChannelRequestSchemas,
  ChannelSpec,
} from "../contract/channel";
import type { SchemaWithJson } from "../contract/schemas";
import type { StandardSchemaV1 } from "../types/standardSchema";
import { channelContract } from "../contract/channel";
import { toConverter } from "../contract/schemas";

/* ------------------------------------------------------------------ *
 * The messages' data
 * ------------------------------------------------------------------ */

/** The longest peer name, in characters. */
const MAX_PEER = 128;
/** The longest SDP, in characters. */
const MAX_SDP = 65_536;
/** The longest candidate line, in characters. */
const MAX_CANDIDATE = 4_096;

/** An offer's session description (`RTCSessionDescriptionInit` with `type: "offer"`). */
interface OfferDescription {
  /** `"offer"`. */
  type: "offer";
  /** The offer's SDP. */
  sdp: string;
}

/** An answer's session description (`RTCSessionDescriptionInit` with `type: "answer"` or `"pranswer"`). */
interface AnswerDescription {
  /** `"answer"`, or `"pranswer"` for a provisional one. */
  type: "answer" | "pranswer";
  /** The answer's SDP. */
  sdp: string;
}

/** An ICE candidate (`RTCIceCandidateInit`); `candidate: ""` is the end of candidates. */
interface IceCandidate {
  /** The candidate line (`candidate:…`), `""` for the end of candidates. */
  candidate: string;
  /** The media stream's identification tag, when known. */
  sdpMid?: string | null;
  /** The index of the media description, when known. */
  sdpMLineIndex?: number | null;
  /** The ICE username fragment, when known. */
  usernameFragment?: string | null;
}

/** A schema of this module: what it checks, and its JSON Schema. */
type Schema<T> = SchemaWithJson<T, T>;

/** A check: given a value and where it sits, the issues it pushes or the value it keeps. */
type Check = (
  value: unknown,
  path: readonly PropertyKey[],
  issues: StandardSchemaV1.Issue[],
) => unknown;

/** A field of an object check: its check, and whether it may be absent. */
interface Field {
  /** The field's check. */
  readonly check: Check;
  /** The field's JSON Schema. */
  readonly json: Record<string, unknown>;
  /** Whether the field may be absent. */
  readonly optional?: boolean;
}

/** A string of `min`–`max` characters. */
function text(min: number, max: number): Field {
  return {
    json: { type: "string", minLength: min, maxLength: max },
    check(value, path, issues) {
      if (typeof value !== "string") {
        issues.push({ message: "Expected a string", path });
      } else if (value.length < min || value.length > max) {
        issues.push({ message: `Expected ${min}–${max} characters`, path });
      }
      return value;
    },
  };
}

/** One of `values`. */
function oneOf(values: readonly string[]): Field {
  return {
    json: { type: "string", enum: values },
    check(value, path, issues) {
      if (typeof value !== "string" || !values.includes(value)) {
        issues.push({
          message: `Expected ${values.map((v) => `"${v}"`).join(" or ")}`,
          path,
        });
      }
      return value;
    },
  };
}

/** An optional field that may also be `null`, around `inner`. */
function nullable(inner: Field): Field {
  return {
    optional: true,
    json: { anyOf: [inner.json, { type: "null" }] },
    check: (value, path, issues) =>
      value === null ? null : inner.check(value, path, issues),
  };
}

/** A whole number from 0 to 65535. */
const index: Field = {
  json: { type: "integer", minimum: 0, maximum: 65_535 },
  check(value, path, issues) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 65_535
    ) {
      issues.push({ message: "Expected a whole number 0–65535", path });
    }
    return value;
  },
};

/** An object of `fields`: only they are kept, each checked. */
function object(fields: Readonly<Record<string, Field>>): Field {
  const entries = Object.entries(fields);
  return {
    json: {
      type: "object",
      properties: Object.fromEntries(entries.map(([k, f]) => [k, f.json])),
      required: entries.filter(([, f]) => f.optional !== true).map(([k]) => k),
    },
    check(value, path, issues) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        issues.push({ message: "Expected an object", path });
        return value;
      }
      const out: Record<string, unknown> = {};
      for (const [key, field] of entries) {
        const member = (value as Record<string, unknown>)[key];
        if (member === undefined) {
          if (field.optional !== true) {
            issues.push({ message: "Required", path: [...path, key] });
          }
          continue;
        }
        out[key] = field.check(member, [...path, key], issues);
      }
      return out;
    },
  };
}

/** An array of `item`, at most `max` long. */
function list(item: Field, max: number): Field {
  return {
    json: { type: "array", items: item.json, maxItems: max },
    check(value, path, issues) {
      if (!Array.isArray(value) || value.length > max) {
        issues.push({ message: `Expected an array of at most ${max}`, path });
        return value;
      }
      return value.map((member, i) => item.check(member, [...path, i], issues));
    },
  };
}

/** The Standard Schema of `field` (synchronous; vendor `bun-common/webrtc`), with its JSON Schema. */
function schema<T>(field: Field): Schema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "bun-common/webrtc",
      validate(value) {
        const issues: StandardSchemaV1.Issue[] = [];
        const out = field.check(value, [], issues);
        return issues.length > 0 ? { issues } : { value: out as T };
      },
      jsonSchema: toConverter(field.json),
    },
  };
}

/** A peer's name. */
const peer = text(1, MAX_PEER);

/** An offer's description. */
const offerDescription = object({
  type: oneOf(["offer"]),
  sdp: text(1, MAX_SDP),
});

/** An answer's description. */
const answerDescription = object({
  type: oneOf(["answer", "pranswer"]),
  sdp: text(1, MAX_SDP),
});

/** An ICE candidate. */
const iceCandidate = object({
  candidate: text(0, MAX_CANDIDATE),
  sdpMid: nullable(text(0, 64)),
  sdpMLineIndex: nullable(index),
  usernameFragment: nullable(text(0, 256)),
});

/** The largest `peers` list: no room is bigger. */
const MAX_ROOM = 1_024;

/** The signalling messages: what the relay receives and sends, and its one reply. */
export interface SignallingMessages {
  /** Client → relay. */
  readonly receives: {
    /** Join the room as `peer` (unique in the room); answered with `peers`. */
    readonly join: Schema<{ peer: string }>;
    /** Leave the room (the socket stays open; closing it leaves too). */
    readonly leave: null;
    /** An offer for the peer `to`. */
    readonly offer: Schema<{ to: string; description: OfferDescription }>;
    /** An answer for the peer `to`. */
    readonly answer: Schema<{ to: string; description: AnswerDescription }>;
    /** A trickled ICE candidate for the peer `to`. */
    readonly candidate: Schema<{ to: string; candidate: IceCandidate }>;
  };
  /** Relay → client. */
  readonly sends: {
    /** The reply to `join`: the other peers already in the room. */
    readonly peers: Schema<{ peers: string[] }>;
    /** Another peer joined the room. */
    readonly join: Schema<{ peer: string }>;
    /** Another peer left the room (or its socket closed). */
    readonly leave: Schema<{ peer: string }>;
    /** An offer from the peer `from`. */
    readonly offer: Schema<{ from: string; description: OfferDescription }>;
    /** An answer from the peer `from`. */
    readonly answer: Schema<{ from: string; description: AnswerDescription }>;
    /** A trickled ICE candidate from the peer `from`. */
    readonly candidate: Schema<{ from: string; candidate: IceCandidate }>;
  };
  /** `join` is answered with `peers`, echoing its id. */
  readonly replies: { readonly join: "peers" };
}

/** The messages, built once: every signalling contract shares these schemas. */
const MESSAGES: SignallingMessages = {
  receives: {
    join: schema(object({ peer })),
    leave: null,
    offer: schema(object({ to: peer, description: offerDescription })),
    answer: schema(object({ to: peer, description: answerDescription })),
    candidate: schema(object({ to: peer, candidate: iceCandidate })),
  },
  sends: {
    peers: schema(object({ peers: list(peer, MAX_ROOM) })),
    join: schema(object({ peer })),
    leave: schema(object({ peer })),
    offer: schema(object({ from: peer, description: offerDescription })),
    answer: schema(object({ from: peer, description: answerDescription })),
    candidate: schema(object({ from: peer, candidate: iceCandidate })),
  },
  replies: { join: "peers" },
};

/* ------------------------------------------------------------------ *
 * The contract
 * ------------------------------------------------------------------ */

/** What {@link signallingContract} takes: a channel declaration without its messages, which are fixed. */
export interface SignallingOptions {
  /** The route path the relay is served on; its params name the room (`/rtc/:room`). A path without params is one room. */
  readonly path: string;
  /** The upgrade request's schemas, checked before the 101 (a room slug, a token in the query). Default: none. */
  readonly request?: ChannelRequestSchemas;
  /** The policies, as a channel's: `in` for frames received (default `"error"`), `out` for frames sent (default `"error"`). */
  readonly messageValidation?: ChannelSpec["messageValidation"];
  /** Close with `1007` on an invalid frame instead of answering it. Default `false`. */
  readonly closeOnInvalid?: boolean;
  /** The subprotocol the upgrade answers with. Default: none. */
  readonly subprotocol?: string;
  /** A stable name and prose for generated documents. Default: the path. */
  readonly meta?: ChannelSpec["meta"];
}

/** A signalling channel's declaration: the options given, with the fixed messages. */
export type SignallingSpec<O extends SignallingOptions = SignallingOptions> =
  Omit<O, keyof SignallingMessages> & SignallingMessages;

/**
 * Builds a signalling channel's contract: a `channelContract()` with the
 * fixed signalling messages (see the module's table) on `options.path`.
 * Browser-safe, so one shared module serves the relay (`signallingRelay`)
 * and the client (bun-client's `channel()` and `connectPeer`).
 *
 * @param options The channel's path and, optionally, its upgrade checks,
 *   policies, subprotocol and documents' name. A path that does not start
 *   with `/` throws a `TypeError`.
 */
export function signallingContract<const O extends SignallingOptions>(
  options: O,
): ChannelContract<SignallingSpec<O>> {
  const spec = {
    ...options,
    receives: MESSAGES.receives,
    sends: MESSAGES.sends,
    replies: MESSAGES.replies,
    meta: {
      description:
        "WebRTC signalling: join a room, then relay offers, answers and ICE candidates to a named peer in it",
      ...options.meta,
    },
  } as unknown as SignallingSpec<O>;
  return channelContract(spec);
}
