/**
 * Signing and verifying an HTTP envelope (`worker-runtimes/README.md` §5.6).
 *
 * The envelope moved to bun-common (`@kingsleyweb/bun-common/envelope`,
 * bun-security plan §15.1, PR-P4), where bun-security's signed requests use
 * the same copy. This module binds it to bun-jobs: the same names, the same
 * wire format, the same checks and messages (`bun-jobs-signature`,
 * `bun-jobs-id`), and bun-jobs' own `ConfigError` for an unusable option.
 * See bun-common's `lib/envelope/signing.ts` for the format and the checks.
 *
 * Browser-safe: bun-common's envelope entry imports no Bun or Node API.
 */

import type {
  EnvelopeCodec,
  HmacSha256,
  RemoteBody,
  RemoteSecret,
  SignEnvelopeOptions,
  VerifyEnvelopeOptions,
  VerifyEnvelopeResult,
} from "@kingsleyweb/bun-common/envelope";
import { envelopeCodec } from "@kingsleyweb/bun-common/envelope";
import { ConfigError } from "../shared/errors";

export { REMOTE_ID_PATTERN } from "@kingsleyweb/bun-common/envelope";
export type {
  RemoteBody,
  RemoteSecret,
  RemoteSignatureDirection,
  SignEnvelopeOptions,
  VerifyEnvelopeOptions,
  VerifyEnvelopeResult,
} from "@kingsleyweb/bun-common/envelope";

/**
 * The envelope with bun-jobs' errors and header names. Internal. Annotated
 * so the declaration names the browser-safe `./envelope` entry: inferred,
 * tsc named bun-common's root for the type, which loaded the root's
 * declarations, and `@types/node`, into a browser consumer of `./remote`.
 */
export const remoteCodec: EnvelopeCodec = /* @__PURE__ */ envelopeCodec({
  configError: (message, details) => new ConfigError(message, details),
  headers: { signature: "bun-jobs-signature", id: "bun-jobs-id" },
});

/** The keys of a secret, as bytes, after checking it is usable. Internal; the frame codec shares it. */
export function keysOf(secret: RemoteSecret): Uint8Array[] {
  return remoteCodec.keysOf(secret);
}

/** {@link signEnvelope} through a given MAC: the seam the host injects `node:crypto` through. */
export function signEnvelopeWith(
  mac: HmacSha256,
  body: RemoteBody | null,
  options: SignEnvelopeOptions,
): Promise<string> {
  return remoteCodec.signEnvelopeWith(mac, body, options);
}

/** {@link verifyEnvelope} through a given MAC: the seam the host injects `node:crypto` through. */
export function verifyEnvelopeWith(
  mac: HmacSha256,
  body: RemoteBody | null,
  header: string | null | undefined,
  options: VerifyEnvelopeOptions,
): Promise<VerifyEnvelopeResult> {
  return remoteCodec.verifyEnvelopeWith(mac, body, header, options);
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
  return remoteCodec.signEnvelope(body, options);
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
  return remoteCodec.verifyEnvelope(body, header, options);
}
