/**
 * The text frame (`remote-transports.md` §4.3.1, §4.4.1): one message on a
 * text transport (`http-stream`, `sse`, `ws`), with the fields that
 * authenticate and sequence it.
 *
 * ```
 * frame = "BJ1" SP seq SP ack SP mac SP json
 * mac   = base64url-unpadded(HMAC-SHA256(key, "BJ1" LF sid LF dir LF seq LF ack LF json))
 * ```
 *
 * One line of UTF-8, with no raw CR or LF anywhere in it. `seq` and `ack`
 * are canonical decimal (no sign, no leading zero); `mac` is 43 characters;
 * `json` is the rest of the line, kept byte for byte. The MAC covers `seq`,
 * `ack` and `json` exactly as sent, plus two things the line does not carry:
 *
 * - `sid`, the session: `nonceDialler "." nonceDialled` on a session
 *   transport, the invoke envelope's `id` on an `http-stream` response, and
 *   for the handshake `-` (`hello`) or the `hello`'s nonce (`welcome`);
 * - `dir`, the **sender's** role, `g` or `e`. A frame MAC'd by one side
 *   never verifies as the other's, so a captured frame cannot be reflected
 *   back at its sender. This is the frame's counterpart of the HTTP
 *   signature's `q`/`r` label (`../signing.ts`).
 *
 * The two MACs cannot be confused for each other: an HTTP signature's
 * payload starts with its decimal `t`, a frame's with `BJ1` and a line feed.
 *
 * **Parsed with `indexOf`, never `split(" ", 4)`.** JavaScript's `split`
 * with a limit discards the remainder, which here is the JSON; the reader
 * finds the four spaces and keeps the rest intact.
 *
 * **The MAC is checked before the JSON is parsed**, and the line's length
 * before either, so a peer that sends garbage costs one comparison, not a
 * parse. The MAC goes through the seam in `../mac.ts`: WebCrypto by default,
 * `node:crypto` injected by the Bun-only host.
 *
 * Internal (Q-2.3): not exported from `./remote`. Browser-safe.
 */

import type { HmacSha256 } from "../mac";
import type { RemoteNonceStore } from "../nonce";
import { ConfigError } from "../../shared/errors";
import { REMOTE_SIGNATURE_WINDOW_MS } from "../constants";
import { constantTimeEqual, subtleHmacSha256, utf8 } from "../mac";
import { REMOTE_ID_PATTERN } from "../signing";

/** The magic that opens every text frame, and the first line of its MAC input. Protocol version 1. */
export const TEXT_FRAME_MAGIC = "BJ1";

/** The session id a `hello` is MAC'd with: no session exists yet. */
export const HELLO_SID = "-";

/** A sender's role, as it is MAC'd: `g` the gateway, `e` the executor. */
export type FrameRole = "g" | "e";

/** The three messages that are never sequenced (`seq` 0). */
export const UNSEQUENCED_OPS: ReadonlySet<string> = new Set([
  "hello",
  "welcome",
  "ack",
]);

/** A frame's message: a JSON object with a string `op`. */
export interface FrameMessage {
  /** Which message this is. */
  op: string;
  /** Every other field, unvalidated: the session layer applies the schemas. */
  [field: string]: unknown;
}

/** What a frame says besides its message. */
export interface FrameHeader {
  /** The session id, MAC'd but not sent. */
  sid: string;
  /** The sender's role, MAC'd but not sent. */
  dir: FrameRole;
  /** The sequence number: `0` for `hello`, `welcome` and `ack`, from `1` otherwise. */
  seq: number;
  /** The highest `seq` received contiguously from the peer; `0` when none. */
  ack: number;
}

/** A 128-bit nonce: 22 characters of unpadded base64url. */
export const FRAME_NONCE_PATTERN = /^[\w-]{22}$/;

/** `seq` and `ack` on the wire: canonical decimal, at most 16 digits. */
const DECIMAL = /^(?:0|[1-9]\d{0,15})$/;

/** The base64url alphabet, by value. */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Each base64url character's value, or `-1`. */
const B64_VALUE = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let index = 0; index < B64.length; index++) {
    table[B64.charCodeAt(index)] = index;
  }
  return table;
})();

/** Unpadded base64url of some bytes. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const n =
      (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    out +=
      B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const n = bytes[index]! << 16;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]!;
  }
  return out;
}

/** The length of a MAC on the wire: 32 bytes as unpadded base64url. */
export const FRAME_MAC_LENGTH = 43;

/**
 * The 32 bytes of a 43-character MAC, or `undefined` when it is not one. The
 * last character carries two unused bits, which must be zero: otherwise four
 * different strings would decode to the same MAC, and a frame would have
 * more than one valid spelling.
 */
export function macFromBase64Url(text: string): Uint8Array | undefined {
  if (text.length !== FRAME_MAC_LENGTH) {
    return undefined;
  }
  const out = new Uint8Array(32);
  let bits = 0;
  let buffer = 0;
  let at = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const value = code < 128 ? B64_VALUE[code]! : -1;
    if (value < 0) {
      return undefined;
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 0xff;
    }
  }
  return (buffer & ((1 << bits) - 1)) === 0 ? out : undefined;
}

/** A fresh 128-bit nonce for `hello` or `welcome`. */
export function createFrameNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** A session's id: the dialler's nonce, `.`, the dialled side's. */
export function sessionId(nonceDialler: string, nonceDialled: string): string {
  for (const nonce of [nonceDialler, nonceDialled]) {
    if (!FRAME_NONCE_PATTERN.test(nonce)) {
      throw new ConfigError("A session nonce is 22 characters of base64url", {
        nonce,
      });
    }
  }
  return `${nonceDialler}.${nonceDialled}`;
}

/** Whether a string is usable as a frame's `sid`: `-`, or an id with no line break in it. */
function isSid(sid: unknown): sid is string {
  return (
    typeof sid === "string" &&
    (sid === HELLO_SID || REMOTE_ID_PATTERN.test(sid))
  );
}

/**
 * Which `sid` an op must be MAC'd with, when the op fixes it: a `hello`
 * exactly `-`, a `welcome` a nonce, and nothing else `-`. Checked on both
 * sides, so a frame cannot be moved between the handshake and a session or
 * a stream, whatever ids the gateway picks.
 */
function sidFits(op: string, sid: string): boolean {
  if (op === "hello") {
    return sid === HELLO_SID;
  }
  if (op === "welcome") {
    return FRAME_NONCE_PATTERN.test(sid);
  }
  return sid !== HELLO_SID;
}

/** The MAC input: `"BJ1" LF sid LF dir LF seq LF ack LF json`, as UTF-8. */
export function frameMacInput(
  sid: string,
  dir: FrameRole,
  seq: string,
  ack: string,
  json: string,
): Uint8Array {
  return utf8(`${TEXT_FRAME_MAGIC}\n${sid}\n${dir}\n${seq}\n${ack}\n${json}`);
}

/** Whether a number is usable as `seq` or `ack`. */
function isCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Whether a string holds a raw CR or LF. */
function hasLineBreak(text: string): boolean {
  return text.includes("\n") || text.includes("\r");
}

/** Options for {@link encodeTextFrame}. */
export interface EncodeTextFrameOptions extends FrameHeader {
  /** The signing key: the first of the secret's keys, as UTF-8 bytes. */
  key: Uint8Array;
  /** The MAC implementation. Default WebCrypto; the host passes `node:crypto`. */
  mac?: HmacSha256;
}

/**
 * Encodes and MACs one message as a text frame. The message is serialised
 * here, with `JSON.stringify`, so the bytes MAC'd are the bytes sent. Throws
 * `ConfigError` for anything that could only be a bug on this side: a `seq`
 * that disagrees with the op, an unusable `sid` or role, or a message that
 * serialises to something other than a JSON object.
 */
export async function encodeTextFrame(
  message: FrameMessage,
  options: EncodeTextFrameOptions,
): Promise<string> {
  const { sid, dir, seq, ack, key } = options;
  // An array cannot get past this: JSON gives it no op, and the serialised
  // JSON is checked to be an object below.
  if (
    message === null ||
    typeof message !== "object" ||
    typeof message.op !== "string"
  ) {
    throw new ConfigError("A frame carries a JSON object with a string op");
  }
  if (!isSid(sid) || !sidFits(message.op, sid)) {
    throw new ConfigError("This sid cannot carry this op", {
      sid,
      op: message.op,
    });
  }
  if (dir !== "g" && dir !== "e") {
    throw new ConfigError('dir is the sender\'s role: "g" or "e"', { dir });
  }
  if (!isCounter(seq) || !isCounter(ack)) {
    throw new ConfigError("seq and ack are non-negative safe integers", {
      seq,
      ack,
    });
  }
  if ((seq === 0) !== UNSEQUENCED_OPS.has(message.op)) {
    throw new ConfigError("seq is 0 exactly for hello, welcome and ack", {
      seq,
      op: message.op,
    });
  }
  if (!(key instanceof Uint8Array) || key.length === 0) {
    throw new ConfigError("A frame key is the secret's UTF-8 bytes, not empty");
  }
  // Without indentation, JSON.stringify escapes every CR and LF, so the
  // line cannot break; but a toJSON can turn the object into anything.
  const json = JSON.stringify(message) as string | undefined;
  if (json === undefined || !json.startsWith("{")) {
    throw new ConfigError("A frame's message must serialise to a JSON object");
  }
  const seqText = String(seq);
  const ackText = String(ack);
  const mac = await (options.mac ?? subtleHmacSha256)(
    key,
    frameMacInput(sid, dir, seqText, ackText, json),
  );
  return `${TEXT_FRAME_MAGIC} ${seqText} ${ackText} ${toBase64Url(mac)} ${json}`;
}

/** A frame's fields as found on the line, before anything is verified. */
export interface ParsedTextFrame {
  /** `seq` as sent. */
  seqText: string;
  /** `ack` as sent. */
  ackText: string;
  /** The MAC's 32 bytes. */
  mac: Uint8Array;
  /** The JSON, untouched. */
  json: string;
}

/** Why a frame was refused. */
export type TextFrameRefusal =
  /** Longer than the receiver's limit: `FRAME_TOO_LARGE`. Checked first, before anything is read. */
  | "too-large"
  /** Not a text frame: the magic, a field, a line break, or JSON that is not an object with an op. */
  | "malformed"
  /** The MAC matches no key, for this session and this sender: `SIGNATURE_INVALID`. */
  | "mac"
  /** Authentic, but its `seq` or its `sid` disagrees with its op. */
  | "context";

/** What {@link parseTextFrame} found. */
export type ParseTextFrameResult =
  | {
      /** The line has a text frame's shape. */
      ok: true;
      /** Its fields. */
      frame: ParsedTextFrame;
    }
  | {
      /** It does not. */
      ok: false;
      /** `too-large` or `malformed`. */
      reason: "too-large" | "malformed";
      /** What is wrong, safe to log. */
      detail: string;
    };

/** Whether a string is over `limit` bytes as UTF-8, counted only when its length cannot decide. */
function utf8LengthOver(text: string, limit: number): boolean {
  // Every UTF-16 unit is at least one UTF-8 byte and at most three (a
  // surrogate pair is two units and four bytes), so most lines are decided
  // without counting.
  if (text.length > limit) {
    return true;
  }
  if (text.length * 3 <= limit) {
    return false;
  }
  return utf8(text).length > limit;
}

/** A refusal. */
function refuse<R extends string>(
  reason: R,
  detail: string,
): { ok: false; reason: R; detail: string } {
  return { ok: false, reason, detail };
}

/**
 * Splits a text frame into its fields, checking only their shape: the
 * magic, two canonical decimals, a canonical 43-character MAC and a
 * non-empty single-line remainder. Nothing is verified or parsed as JSON.
 * `maxBytes` bounds the whole line's UTF-8 length.
 */
export function parseTextFrame(
  line: string,
  maxBytes?: number,
): ParseTextFrameResult {
  if (typeof line !== "string") {
    return refuse("malformed", "A frame is a string");
  }
  if (maxBytes !== undefined && utf8LengthOver(line, maxBytes)) {
    return refuse("too-large", `The frame is over ${maxBytes} bytes`);
  }
  const s1 = line.indexOf(" ");
  if (s1 !== TEXT_FRAME_MAGIC.length || !line.startsWith(TEXT_FRAME_MAGIC)) {
    return refuse("malformed", `A text frame starts "${TEXT_FRAME_MAGIC} "`);
  }
  const s2 = line.indexOf(" ", s1 + 1);
  const s3 = s2 < 0 ? -1 : line.indexOf(" ", s2 + 1);
  const s4 = s3 < 0 ? -1 : line.indexOf(" ", s3 + 1);
  if (s4 < 0) {
    return refuse("malformed", "A text frame has five fields");
  }
  const seqText = line.slice(s1 + 1, s2);
  const ackText = line.slice(s2 + 1, s3);
  if (!DECIMAL.test(seqText) || !isCounter(Number(seqText))) {
    return refuse("malformed", "seq is not a canonical decimal");
  }
  if (!DECIMAL.test(ackText) || !isCounter(Number(ackText))) {
    return refuse("malformed", "ack is not a canonical decimal");
  }
  const mac = macFromBase64Url(line.slice(s3 + 1, s4));
  if (mac === undefined) {
    return refuse(
      "malformed",
      "mac is not 43 characters of canonical base64url",
    );
  }
  const json = line.slice(s4 + 1);
  if (json.length === 0) {
    return refuse("malformed", "The frame has no message");
  }
  if (hasLineBreak(line)) {
    return refuse("malformed", "A text frame is one line: no CR or LF");
  }
  return { ok: true, frame: { seqText, ackText, mac, json } };
}

/** Options for {@link decodeTextFrame}. */
export interface DecodeTextFrameOptions {
  /** The secret's keys as UTF-8 bytes; any of them verifies (rotation). */
  keys: readonly Uint8Array[];
  /** The session id this frame must belong to. */
  sid: string;
  /** The **sender's** role: the peer's, never this side's own. */
  dir: FrameRole;
  /** The longest line accepted, in UTF-8 bytes. Omitted, no limit. */
  maxBytes?: number;
  /** The MAC implementation. Default WebCrypto; the host passes `node:crypto`. */
  mac?: HmacSha256;
}

/** A verified frame. */
export interface DecodedTextFrame {
  /** The sequence number. */
  seq: number;
  /** The peer's acknowledgement. */
  ack: number;
  /** The message, parsed. */
  message: FrameMessage;
  /** The message exactly as received. */
  json: string;
  /** Which key verified it: `0` the current one. */
  keyIndex: number;
}

/** What {@link decodeTextFrame} decided. */
export type DecodeTextFrameResult =
  | {
      /** The frame is authentic and well formed. */
      ok: true;
      /** It. */
      frame: DecodedTextFrame;
    }
  | {
      /** The frame is refused. */
      ok: false;
      /** Why. */
      reason: TextFrameRefusal;
      /** What is wrong, safe to log. */
      detail: string;
    };

/**
 * Parses, authenticates and reads one text frame, in that order: the
 * length, the shape, the MAC under `sid` and `dir` (every key tried, each
 * compared in constant time), and only then the JSON. Resolves a refusal
 * rather than throwing; throws `ConfigError` only for unusable options.
 *
 * Replay and order are not decided here: a valid frame may still be a
 * duplicate or out of sequence. `TextFrameWindow` (`./sequence.ts`) decides
 * that, and a `hello`'s freshness is {@link admitHello}'s.
 */
export async function decodeTextFrame(
  line: string,
  options: DecodeTextFrameOptions,
): Promise<DecodeTextFrameResult> {
  const { keys, sid, dir } = options;
  if (!isSid(sid)) {
    throw new ConfigError("Not a usable sid", { sid });
  }
  if (dir !== "g" && dir !== "e") {
    throw new ConfigError('dir is the sender\'s role: "g" or "e"', { dir });
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new ConfigError("At least one frame key is needed");
  }
  const parsed = parseTextFrame(line, options.maxBytes);
  if (!parsed.ok) {
    return parsed;
  }
  const { seqText, ackText, mac, json } = parsed.frame;
  const input = frameMacInput(sid, dir, seqText, ackText, json);
  const hmac = options.mac ?? subtleHmacSha256;
  let keyIndex = -1;
  for (let index = 0; index < keys.length && keyIndex < 0; index++) {
    if (constantTimeEqual(await hmac(keys[index]!, input), mac)) {
      keyIndex = index;
    }
  }
  if (keyIndex < 0) {
    return refuse(
      "mac",
      "The frame's MAC matches no key for this session and sender",
    );
  }
  let message: unknown;
  try {
    message = JSON.parse(json);
  } catch {
    return refuse("malformed", "The frame's message is not JSON");
  }
  if (
    message === null ||
    typeof message !== "object" ||
    typeof (message as { op?: unknown }).op !== "string"
  ) {
    return refuse(
      "malformed",
      "The frame's message is not an object with a string op",
    );
  }
  const op = (message as FrameMessage).op;
  const seq = Number(seqText);
  if ((seq === 0) !== UNSEQUENCED_OPS.has(op)) {
    return refuse(
      "context",
      `seq ${seq} cannot carry "${op}": 0 is for hello, welcome and ack`,
    );
  }
  if (!sidFits(op, sid)) {
    return refuse("context", `"${op}" cannot be MAC'd with this sid`);
  }
  return {
    ok: true,
    frame: {
      seq,
      ack: Number(ackText),
      message: message as FrameMessage,
      json,
      keyIndex,
    },
  };
}

/** Options for {@link admitHello}. */
export interface AdmitHelloOptions {
  /** The receiver's clock, epoch ms. Default `Date.now()`. */
  now?: number;
  /** How far `t` may be from `now`, either way, in ms. Default and ceiling `300_000`. */
  windowMs?: number;
  /** Where the nonces seen within the window are remembered. Required: a `hello` without one is a replay waiting to happen. */
  nonces: RemoteNonceStore;
}

/** What {@link admitHello} decided. */
export type AdmitHelloResult =
  | {
      /** Fresh and new. */
      ok: true;
    }
  | {
      /** Refused. */
      ok: false;
      /** `SIGNATURE_TIMESTAMP` (outside the window), `REPLAYED` (nonce seen) or `malformed` (no usable `t` or `nonce`). */
      code: "SIGNATURE_TIMESTAMP" | "REPLAYED" | "malformed";
      /** What is wrong, safe to log. */
      detail: string;
    };

/**
 * The handshake's replay rule (§4.4.1), for a `hello` whose frame already
 * verified: its `t` (Unix seconds) within the window of this clock in either
 * direction, then its `nonce` not seen within the window. The nonce is what
 * is remembered, so a nonce is single-use whatever else the `hello` says.
 */
export async function admitHello(
  hello: FrameMessage,
  options: AdmitHelloOptions,
): Promise<AdmitHelloResult> {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? REMOTE_SIGNATURE_WINDOW_MS;
  if (!Number.isFinite(now)) {
    throw new ConfigError("now must be a finite epoch-ms number", { now });
  }
  if (
    !Number.isSafeInteger(windowMs) ||
    windowMs <= 0 ||
    windowMs > REMOTE_SIGNATURE_WINDOW_MS
  ) {
    throw new ConfigError(
      `windowMs must be a whole number of ms above 0 and at most ${REMOTE_SIGNATURE_WINDOW_MS}`,
      { windowMs },
    );
  }
  if (typeof options.nonces?.remember !== "function") {
    throw new ConfigError("admitHello needs a nonce store");
  }
  const { t, nonce } = hello;
  if (
    hello.op !== "hello" ||
    !isCounter(t) ||
    typeof nonce !== "string" ||
    !FRAME_NONCE_PATTERN.test(nonce)
  ) {
    return {
      ok: false,
      code: "malformed",
      detail: "A hello carries t (Unix seconds) and a 22-character nonce",
    };
  }
  const skewMs = now - t * 1000;
  if (Math.abs(skewMs) > windowMs) {
    return {
      ok: false,
      code: "SIGNATURE_TIMESTAMP",
      detail: `The hello's t is ${Math.round(skewMs / 1000)} s from this clock, outside the ${windowMs / 1000} s window`,
    };
  }
  if (!(await options.nonces.remember(nonce, t * 1000 + windowMs + 1, now))) {
    return {
      ok: false,
      code: "REPLAYED",
      detail: "This hello's nonce was already received",
    };
  }
  return { ok: true };
}
