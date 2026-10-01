/**
 * Signing and verifying an HTTP envelope (`worker-runtimes.md` §5.6).
 *
 * ```
 * payload   = t "." d "." raw    a request (d = "q") or a response (d = "r") with a body
 * payload   = t "." "q" "." id   a bodyless request (GET, HEAD)
 * signature = hex(HMAC-SHA256(secret, payload))
 * header    = "t=" t ",v1=" signature
 * ```
 *
 * `t` is Unix seconds, in decimal; `d` the direction, one ASCII letter; `raw`
 * the exact body bytes; `id` the `bun-jobs-id` header's value, which the
 * bodyless form brings under the MAC. Every separator is ASCII `.`.
 *
 * **The direction is in the MAC.** One secret signs both ways, so without it
 * a signed response (an `invoke-result`) captured on the wire and sent back
 * to the remote would verify as a request. The signer and the verifier each
 * say which they handle (`direction: "request" | "response"`): a remote's
 * server verifies requests and signs responses, the gateway the reverse, and
 * a signature made for one is `SIGNATURE_INVALID` as the other.
 *
 * **Bodyless or not is decided by the caller, never guessed from the bytes.**
 * The body is passed as `null` for a bodyless request, which on HTTP is
 * exactly a `GET` or `HEAD`; every other method, `POST` included, is signed
 * over its body, even an empty one (`t ".q."`). Only a request can be
 * bodyless. The two forms cannot sign the same bytes: an `id` is one to 200
 * characters of {@link REMOTE_ID_PATTERN}, never empty, so `t ".q." id` is
 * never an empty body's `t ".q."`; and a body consisting of nothing but such a
 * token (which no JSON envelope is) is refused by both the signer
 * (`ConfigError`) and the verifier (`SIGNATURE_INVALID`), so a `GET`'s
 * signature cannot be replayed as a `POST` whose body is its id.
 *
 * **The bodyless form binds no method and no path.** That is sound while the
 * only signed bodyless request is the handshake `GET`, whose path is fixed.
 * If a later `GET` carries a path or query parameter that means something,
 * the method and the path must be bound into its payload then.
 *
 * The same scheme signs a request and its response, in both directions. A
 * verifier checks, in order: that the header parses, and for a bodyless
 * request that it has an id (`SIGNATURE_MISSING`);
 * that one `v1` matches one configured key, compared in constant time
 * (`SIGNATURE_INVALID`); that `t` is within the replay window of its own
 * clock **in either direction** (`SIGNATURE_TIMESTAMP`); and, when given a
 * nonce store, that it has not seen this signed payload before (`REPLAYED`).
 * The MAC comes first, so `SIGNATURE_TIMESTAMP` and `REPLAYED` are only ever
 * said of an authentic request: a skewed clock is never mistaken for a wrong
 * key.
 *
 * Browser-safe: WebCrypto by default. The host injects `node:crypto` through
 * {@link signEnvelopeWith} and {@link verifyEnvelopeWith}, which are internal.
 */

import type { HmacSha256 } from "./mac";
import type { RemoteNonceStore } from "./nonce";
import { ConfigError } from "../shared/errors";
import { REMOTE_SIGNATURE_WINDOW_MS } from "./constants";
import {
  constantTimeEqual,
  fromHex,
  subtleHmacSha256,
  toHex,
  utf8,
} from "./mac";

/**
 * The shared secret, or a rotation list. A signer uses the first key; a
 * verifier accepts any. Rotate by putting the new key first everywhere,
 * deploying, then removing the old one.
 */
export type RemoteSecret = string | readonly string[];

/** The bytes signed: a string is signed as its UTF-8, which is what `fetch` sends. */
export type RemoteBody = string | Uint8Array | ArrayBuffer;

/**
 * Which way a signed message travels: a `request` goes from the gateway to a
 * remote, a `response` back. Signed into the payload as `q` or `r`.
 */
export type RemoteSignatureDirection = "request" | "response";

/**
 * What a bodyless request's `bun-jobs-id` must be: 1 to 200 of letters,
 * digits, `_`, `.`, `:`, `~` and `-`. No `{`, no whitespace, so it can never
 * be mistaken for a JSON body.
 */
export const REMOTE_ID_PATTERN = /^[\w.:~-]{1,200}$/;

/** Options for {@link signEnvelope}. */
export interface SignEnvelopeOptions {
  /**
   * Whether this is a request (the gateway signing what it sends) or a
   * response (a remote signing its answer). Required: it is in the payload.
   */
  direction: RemoteSignatureDirection;
  /** The secret, or a rotation list whose first key signs. */
  secret: RemoteSecret;
  /** The signing clock, epoch ms. Default `Date.now()`. */
  now?: number;
  /**
   * The request's `bun-jobs-id`. Required, and signed, when the body is
   * `null` (a `GET` or `HEAD`); ignored when there is a body, whose own `id`
   * the MAC already covers. Must match `REMOTE_ID_PATTERN`.
   */
  id?: string | null;
}

/** Options for {@link verifyEnvelope}. */
export interface VerifyEnvelopeOptions {
  /**
   * What this verifier accepts: `request` on a remote's server, `response` on
   * the gateway. A signature made for the other direction is
   * `SIGNATURE_INVALID`. Required: it is in the payload.
   */
  direction: RemoteSignatureDirection;
  /** The secret, or a rotation list any of whose keys verifies. */
  secret: RemoteSecret;
  /** The verifying clock, epoch ms. Default `Date.now()`. */
  now?: number;
  /**
   * How far `t` may be from `now`, either way, in ms. Default and ceiling
   * `300_000` (`REMOTE_SIGNATURE_WINDOW_MS`): it may be narrowed, never
   * widened, since a wider window is a longer replay.
   */
  windowMs?: number;
  /**
   * Where to remember what was seen, so a repeat within the window is
   * `REPLAYED`. Omitted, nothing is remembered. What is remembered is the
   * signed payload's MAC, so a replay is caught whatever headers it is sent
   * with, and a transport retry (a new envelope `id`, so new bytes) is not.
   * A bodyless request's payload includes its id, so two `GET`s in one
   * second with different ids are different payloads.
   */
  nonces?: RemoteNonceStore;
  /**
   * The request's `bun-jobs-id` header, as received. Required when the body
   * is `null` (a `GET` or `HEAD`): absent, or outside `REMOTE_ID_PATTERN`, the
   * request is `SIGNATURE_MISSING`. Ignored when there is a body.
   */
  id?: string | null;
}

/** What {@link verifyEnvelope} decided. */
export type VerifyEnvelopeResult =
  | {
      /** The envelope is authentic, fresh and, with a nonce store, new. */
      ok: true;
      /** The signature's `t`, Unix seconds. */
      timestamp: number;
      /** Which configured key verified it: `0` is the current key, more is an older one still listed. */
      keyIndex: number;
    }
  | {
      /** The envelope is refused. */
      ok: false;
      /** The problem code to answer with. */
      code:
        | "SIGNATURE_MISSING"
        | "SIGNATURE_INVALID"
        | "SIGNATURE_TIMESTAMP"
        | "REPLAYED";
      /** The HTTP status to answer with: always `401`. */
      status: 401;
      /** A human description, safe to return to the caller. */
      detail: string;
      /** With `SIGNATURE_TIMESTAMP`: the verifier's clock minus the signature's, in ms. */
      skewMs?: number;
    };

/** A signature header longer than this is refused unread. */
const MAX_HEADER_LENGTH = 1024;
/** At most this many `v1` elements are compared. */
const MAX_SIGNATURES = 8;
/** A `t` element: decimal digits, Unix seconds. */
const TIMESTAMP = /^\d{1,12}$/;
/** An element name, `v1` or a future scheme's. */
const ELEMENT_NAME = /^[a-z][a-z0-9]*$/;
/** A `v1` element: 32 bytes of hex. */
const V1 = /^[\da-f]{64}$/i;

/** The keys of a secret, as bytes, after checking it is usable. Internal; the frame codec shares it. */
export function keysOf(secret: RemoteSecret): Uint8Array[] {
  const list: readonly unknown[] =
    typeof secret === "string" ? [secret] : (secret as readonly unknown[]);
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError(
      "A remote secret must be a non-empty string or a non-empty list of them",
    );
  }
  return list.map((key, index) => {
    if (typeof key !== "string" || key.length === 0) {
      throw new ConfigError(
        "Every key in a remote secret must be a non-empty string",
        { index },
      );
    }
    return utf8(key);
  });
}

/** A clock reading, checked. */
function clockOf(now: number | undefined): number {
  const value = now ?? Date.now();
  if (!Number.isFinite(value)) {
    throw new ConfigError("now must be a finite epoch-ms number", { now });
  }
  return value;
}

/** The bytes of a body. */
function bytesOf(body: RemoteBody): Uint8Array {
  if (typeof body === "string") {
    return utf8(body);
  }
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

/** Bytes that may appear in an id: `\w`, `.`, `:`, `~`, `-`. */
function isIdByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f ||
    byte === 0x2e ||
    byte === 0x3a ||
    byte === 0x7e ||
    byte === 0x2d
  );
}

/**
 * Whether a body is nothing but an id token: the one body whose payload a
 * bodyless request could also sign, so the one body both sides refuse.
 */
function isIdToken(body: Uint8Array): boolean {
  return body.length > 0 && body.length <= 200 && body.every(isIdByte);
}

/** The label a direction is signed as. */
const LABELS: Readonly<Record<RemoteSignatureDirection, string>> = {
  request: "q",
  response: "r",
};

/** The label for a direction, after checking it is one, and that a bodyless message is a request. */
function labelOf(direction: unknown, bodyless: boolean): string {
  if (direction !== "request" && direction !== "response") {
    throw new ConfigError('direction must be "request" or "response"', {
      direction,
    });
  }
  if (bodyless && direction !== "request") {
    throw new ConfigError(
      "Only a request can be bodyless: a response is always signed over its body",
    );
  }
  return LABELS[direction];
}

/** `t "." label "." raw`, as bytes. */
function payloadOf(t: string, label: string, body: Uint8Array): Uint8Array {
  const prefix = utf8(`${t}.${label}.`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

/** A parsed signature header. */
interface ParsedSignature {
  /** `t` exactly as sent: the MAC covers these characters. */
  t: string;
  /** Every `v1` MAC sent. */
  macs: Uint8Array[];
}

/** Parses a signature header; `undefined` when it is absent or malformed. */
function parseSignature(
  header: string | null | undefined,
): ParsedSignature | undefined {
  if (typeof header !== "string" || header.length > MAX_HEADER_LENGTH) {
    return undefined;
  }
  let t: string | undefined;
  const macs: Uint8Array[] = [];
  for (const element of header.split(",")) {
    const equals = element.indexOf("=");
    if (equals < 0) {
      return undefined;
    }
    const name = element.slice(0, equals).trim();
    const value = element.slice(equals + 1).trim();
    if (name === "t") {
      if (t !== undefined || !TIMESTAMP.test(value)) {
        return undefined;
      }
      t = value;
    } else if (name === "v1") {
      if (!V1.test(value) || macs.length === MAX_SIGNATURES) {
        return undefined;
      }
      macs.push(fromHex(value)!);
    } else if (!ELEMENT_NAME.test(name)) {
      return undefined;
    }
    // Another scheme's element (`v2=`) is skipped, so one can be added
    // beside `v1` without breaking this verifier.
  }
  return t === undefined || macs.length === 0 ? undefined : { t, macs };
}

/** {@link signEnvelope} through a given MAC: the seam the host injects `node:crypto` through. */
export async function signEnvelopeWith(
  mac: HmacSha256,
  body: RemoteBody | null,
  options: SignEnvelopeOptions,
): Promise<string> {
  const label = labelOf(options.direction, body === null);
  const [key] = keysOf(options.secret);
  const t = String(Math.floor(clockOf(options.now) / 1000));
  let signed: Uint8Array;
  if (body === null) {
    if (typeof options.id !== "string" || !REMOTE_ID_PATTERN.test(options.id)) {
      throw new ConfigError(
        "A bodyless request is signed over its id: pass one matching REMOTE_ID_PATTERN",
        { id: options.id },
      );
    }
    signed = utf8(options.id);
  } else {
    signed = bytesOf(body);
    if (isIdToken(signed)) {
      throw new ConfigError(
        "A body that is a bare id token could be taken for a bodyless request's payload; send a JSON envelope",
      );
    }
  }
  const signature = await mac(key!, payloadOf(t, label, signed));
  return `t=${t},v1=${toHex(signature)}`;
}

/** {@link verifyEnvelope} through a given MAC: the seam the host injects `node:crypto` through. */
export async function verifyEnvelopeWith(
  mac: HmacSha256,
  body: RemoteBody | null,
  header: string | null | undefined,
  options: VerifyEnvelopeOptions,
): Promise<VerifyEnvelopeResult> {
  const label = labelOf(options.direction, body === null);
  const keys = keysOf(options.secret);
  const now = clockOf(options.now);
  const windowMs = options.windowMs ?? REMOTE_SIGNATURE_WINDOW_MS;
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

  const parsed = parseSignature(header);
  if (parsed === undefined) {
    return {
      ok: false,
      code: "SIGNATURE_MISSING",
      status: 401,
      detail: "No bun-jobs-signature header, or one that does not parse",
    };
  }

  let signed: Uint8Array;
  if (body === null) {
    if (typeof options.id !== "string" || !REMOTE_ID_PATTERN.test(options.id)) {
      return {
        ok: false,
        code: "SIGNATURE_MISSING",
        status: 401,
        detail:
          "A bodyless request is signed over its bun-jobs-id, and it has none, or one that is not an id",
      };
    }
    signed = utf8(options.id);
  } else {
    signed = bytesOf(body);
    if (isIdToken(signed)) {
      return {
        ok: false,
        code: "SIGNATURE_INVALID",
        status: 401,
        detail:
          "A body that is a bare id token is refused: it could be a bodyless request's payload",
      };
    }
  }
  const payload = payloadOf(parsed.t, label, signed);
  let keyIndex = -1;
  /** The MAC under the first key: the nonce, whichever key verified. */
  let nonce = "";
  for (let index = 0; index < keys.length && keyIndex < 0; index++) {
    const expected = await mac(keys[index]!, payload);
    if (index === 0) {
      nonce = toHex(expected);
    }
    for (const sent of parsed.macs) {
      if (constantTimeEqual(expected, sent)) {
        keyIndex = index;
      }
    }
  }
  if (keyIndex < 0) {
    return {
      ok: false,
      code: "SIGNATURE_INVALID",
      status: 401,
      detail: "The signature matches no configured key",
    };
  }

  const timestamp = Number(parsed.t);
  const skewMs = now - timestamp * 1000;
  // Both directions: a one-sided check lets a future-dated `t` replay forever.
  if (Math.abs(skewMs) > windowMs) {
    return {
      ok: false,
      code: "SIGNATURE_TIMESTAMP",
      status: 401,
      detail: `The signature's timestamp is ${Math.round(skewMs / 1000)} s from this clock, outside the ${windowMs / 1000} s window`,
      skewMs,
    };
  }

  // Held one ms past the last instant the window accepts this `t`.
  if (
    options.nonces &&
    !(await options.nonces.remember(
      nonce,
      timestamp * 1000 + windowMs + 1,
      now,
    ))
  ) {
    return {
      ok: false,
      code: "REPLAYED",
      status: 401,
      detail: "This signed request was already received",
    };
  }
  return { ok: true, timestamp, keyIndex };
}

/**
 * Signs an envelope's raw body and returns the `bun-jobs-signature` header
 * value, `t=<unix seconds>,v1=<hex>`, over `t "." d "." raw` where `d` is
 * `q` for a request and `r` for a response. Sign the exact bytes sent: a
 * string is signed as its UTF-8, so send that same string. For a bodyless
 * request (a `GET` or `HEAD`) pass `null` and the request's `bun-jobs-id` as
 * `id`: the payload is then `t ".q." id`. With a rotation list, the first key
 * signs.
 */
export function signEnvelope(
  body: RemoteBody | null,
  options: SignEnvelopeOptions,
): Promise<string> {
  return signEnvelopeWith(subtleHmacSha256, body, options);
}

/**
 * Verifies a `bun-jobs-signature` header against the raw body received —
 * before parsing it, and never against a re-serialised object. `direction`
 * says what this side accepts: `request` on a remote, `response` on the
 * gateway. For a `GET` or `HEAD`, pass `null` and the received `bun-jobs-id`
 * as `id`; for every other method pass the body, even an empty one. Resolves a
 * result rather than throwing for a refused envelope, carrying the problem
 * code and the `401` to answer with; throws `ConfigError` only for unusable
 * options.
 */
export function verifyEnvelope(
  body: RemoteBody | null,
  header: string | null | undefined,
  options: VerifyEnvelopeOptions,
): Promise<VerifyEnvelopeResult> {
  return verifyEnvelopeWith(subtleHmacSha256, body, header, options);
}
