/**
 * The signed envelope (bun-security plan §15.1, PR-P4), published as the
 * browser-safe subpath `@kingsleyweb/bun-common/envelope` and re-exported
 * from the package root: an HMAC-SHA256 signature over a message's exact
 * bytes, its direction and a timestamp, verified in constant time within a
 * replay window, with an optional nonce store against replays. Moved from
 * bun-jobs' remote protocol, which re-exports it unchanged; bun-security's
 * signed agent requests use it too.
 *
 * ```ts
 * const header = await signEnvelope(body, { direction: "request", secret });
 * const result = await verifyEnvelope(body, header, {
 *   direction: "request",
 *   secret,
 *   nonces: createRemoteNonceCache(),
 * });
 * if (!result.ok) return new Response(null, { status: result.status });
 * ```
 *
 * Browser-safe: nothing here imports a Bun or Node API.
 */
export type { HmacSha256 } from "./mac";
export { subtleHmacSha256 } from "./mac";
export type {
  EnvelopeConfigError,
  RemoteNonceCacheOptions,
  RemoteNonceStore,
} from "./nonce";
export {
  createRemoteNonceCache,
  envelopeCodec,
  REMOTE_ID_PATTERN,
  REMOTE_SIGNATURE_WINDOW_MS,
  signEnvelope,
  signEnvelopeWith,
  verifyEnvelope,
  verifyEnvelopeWith,
} from "./signing";
export type {
  EnvelopeCodec,
  EnvelopeCodecOptions,
  EnvelopeHeaderNames,
  RemoteBody,
  RemoteSecret,
  RemoteSignatureDirection,
  SignEnvelopeOptions,
  VerifyEnvelopeOptions,
  VerifyEnvelopeResult,
} from "./signing";
