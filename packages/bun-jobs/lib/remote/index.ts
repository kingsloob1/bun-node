/**
 * `@kingsleyweb/bun-jobs/remote`: the remote-worker protocol, safe to import
 * in a browser or a V8 isolate.
 *
 * The protocol's version, headers, `op`s, feature strings and problem codes;
 * a type for every HTTP envelope; and `signEnvelope`/`verifyEnvelope`, the
 * HMAC-SHA256 signing every request and response carries, over WebCrypto.
 *
 * Nothing this entry reaches imports a driver, bun-common, or any `node:*` or
 * `bun:*` module: an executor on Cloudflare Workers or Deno Deploy bundles
 * it as it is. `__tests__/remote/remote-bundle.test.ts` holds it to that.
 */

export {
  REMOTE_HEADERS,
  REMOTE_OPS,
  REMOTE_PROBLEM_CODES,
  REMOTE_SIGNATURE_WINDOW_MS,
  WORKER_PROTOCOL_FEATURES,
  WORKER_PROTOCOL_VERSION,
} from "./constants";
export type {
  RemoteOp,
  RemoteProblemCode,
  WorkerProtocolFeature,
} from "./constants";
export { createRemoteNonceCache } from "./nonce";
export type { RemoteNonceCacheOptions, RemoteNonceStore } from "./nonce";
export { REMOTE_ID_PATTERN, signEnvelope, verifyEnvelope } from "./signing";
export type {
  RemoteBody,
  RemoteSecret,
  SignEnvelopeOptions,
  VerifyEnvelopeOptions,
  VerifyEnvelopeResult,
} from "./signing";
export type {
  CancelEnvelope,
  CancelResultEnvelope,
  HandshakeEnvelope,
  HealthEnvelope,
  HealthResultEnvelope,
  InvokeEnvelope,
  InvokeResultEnvelope,
  PingEnvelope,
  PongEnvelope,
  RemoteAttemptStatus,
  RemoteCancelledJob,
  RemoteCancelReason,
  RemoteCapacity,
  RemoteEnvelope,
  RemoteEnvelopeVersion,
  RemoteError,
  RemoteFailOutcome,
  RemoteHealthCheck,
  RemoteInvokeJob,
  RemoteJobParent,
  RemoteJobRef,
  RemoteOutcome,
  RemoteOutcomeLog,
  RemoteRejectedOutcome,
  RemoteResultOutcome,
  RemoteRetainedOutcome,
  RemoteWorkerRef,
  StatusEnvelope,
  StatusResultEnvelope,
} from "./types";
