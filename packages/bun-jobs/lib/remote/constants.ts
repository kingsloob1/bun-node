/**
 * The remote-worker protocol's wire constants: its version, the HTTP headers,
 * every message `op`, the feature strings a remote advertises, and the problem
 * codes either side may answer with.
 *
 * **Browser-safe by construction.** This file imports nothing, so an executor
 * running in a V8 isolate (a Cloudflare Worker, a Deno Deploy function) can
 * bundle it. Every value here is a **wire string**: once an executor speaks
 * it, changing it is as hard as changing a stored value.
 *
 * Designed in `docs/plans/worker-runtimes.md` §5.3–§5.6 and
 * `docs/plans/remote-transports.md` §4.1–§4.2, §4.10.
 */

/**
 * The remote-worker protocol version this build speaks. Sent as
 * `bun-jobs-protocol` on every request and as `v` in every envelope; a remote
 * lists every version it speaks in the handshake's `protocols`.
 */
export const WORKER_PROTOCOL_VERSION = 1 as const;

/**
 * The HTTP headers the protocol defines, by role. Lower case, as HTTP/2 and
 * `Headers` normalise them.
 */
export const REMOTE_HEADERS = Object.freeze({
  /** The protocol version the sender chose: the highest both sides speak. */
  protocol: "bun-jobs-protocol",
  /**
   * `t=<unix seconds>,v1=<hex HMAC-SHA256>`, over `t "." d "." rawBody`
   * (`d` is `q` for a request, `r` for a response), or `t ".q." id` for a
   * bodyless request.
   */
  signature: "bun-jobs-signature",
  /** The envelope's own id: unique per request, transport retries included. */
  id: "bun-jobs-id",
} as const);

/**
 * Every message `op`, on every binding.
 *
 * The first twenty are the session messages of `remote-transports.md` §4.1.
 * The last three exist only on the HTTP exchange shape: `handshake` (the
 * `GET` answer, `worker-runtimes.md` §5.4), `invoke-result` (the unary invoke
 * answer, §5.5) and `cancel-result` (the cancel answer, §5.3).
 */
export const REMOTE_OPS = [
  "hello",
  "welcome",
  "invoke",
  "accepted",
  "rejected",
  "progress",
  "log",
  "heartbeat",
  "ping",
  "pong",
  "health",
  "health-result",
  "result",
  "fail",
  "cancel",
  "status",
  "status-result",
  "ack",
  "close",
  "problem",
  "handshake",
  "invoke-result",
  "cancel-result",
] as const;

/** One message `op`. */
export type RemoteOp = (typeof REMOTE_OPS)[number];

/**
 * The feature strings a remote may advertise in its handshake's (or
 * `welcome`'s) `features` map, each with its own version string (`"v1"`).
 * Unknown keys are ignored, so a third-party executor can lag feature by
 * feature rather than all at once.
 */
export const WORKER_PROTOCOL_FEATURES = [
  "cancel",
  "idempotency",
  "fencing",
  "progress-stream",
  "replay-protection",
  "session",
  "health",
  "canary",
  "attempt-status",
  "stream-resume",
  "resume",
] as const;

/** One feature string. */
export type WorkerProtocolFeature = (typeof WORKER_PROTOCOL_FEATURES)[number];

/**
 * Every problem code the protocol defines. A transport-level failure arrives
 * as an RFC 9457 problem (`urn:bun-jobs:error:<CODE>`), a `close` or a
 * `rejected` carrying one of these; a job's own failure never does (it is a
 * serialised error inside a `fail` outcome).
 *
 * - `UNSUPPORTED_OP`: the receiver does not implement this `op` (HTTP 400,
 *   or a non-fatal `problem`). The capability is recorded absent.
 * - `UNSUPPORTED_PROTOCOL`: no version in common (HTTP 400 or `close`,
 *   listing the versions it does speak).
 * - `SIGNATURE_MISSING`: no signature, or one that does not parse (401).
 * - `SIGNATURE_INVALID`: the MAC matches no configured key (401).
 * - `SIGNATURE_TIMESTAMP`: authentic, but `t` is outside the replay window
 *   in either direction (401).
 * - `REPLAYED`: authentic and fresh, but already seen within the window (401).
 * - `STALE_FENCE`: an attempt older than one already seen for the job.
 * - `BUSY`, `DRAINING`: not now; neither burns an attempt.
 * - `DUPLICATE_RUNNING`: the same attempt is running on another instance.
 * - `TOO_LARGE`: a body above the receiver's `maxBodyBytes`.
 * - `VALIDATION`: an authentic message that is not valid JSON or does not
 *   match its `op`'s schema (HTTP 400, with `issues`). The management API's
 *   code for the same failure, so every bun-jobs problem reads alike.
 * - `INTERNAL`: the receiver itself failed to answer (HTTP 500), never a
 *   job's failure; the management API's code for the same thing. A gateway
 *   treats it as a transport error.
 * - `SEQUENCE_GAP`, `FRAME_TOO_LARGE`: a session frame out of sequence, or
 *   above the session's `maxMessageBytes`; the session closes and resumes.
 * - `ATTEMPT_UNKNOWN`: a `status` for an attempt the executor never had, or
 *   no longer remembers.
 * - `COMPLETE`: the `close` that ends a streamed invoke normally.
 */
export const REMOTE_PROBLEM_CODES = [
  "UNSUPPORTED_OP",
  "UNSUPPORTED_PROTOCOL",
  "SIGNATURE_MISSING",
  "SIGNATURE_INVALID",
  "SIGNATURE_TIMESTAMP",
  "REPLAYED",
  "STALE_FENCE",
  "BUSY",
  "DRAINING",
  "DUPLICATE_RUNNING",
  "TOO_LARGE",
  "VALIDATION",
  "INTERNAL",
  "SEQUENCE_GAP",
  "FRAME_TOO_LARGE",
  "ATTEMPT_UNKNOWN",
  "COMPLETE",
] as const;

/** One problem code. */
export type RemoteProblemCode = (typeof REMOTE_PROBLEM_CODES)[number];

/**
 * The replay window, and its ceiling: a signature whose timestamp is further
 * than this from the verifier's clock, **in either direction**, is refused.
 * A verifier may narrow it, never widen it.
 */
export const REMOTE_SIGNATURE_WINDOW_MS = 300_000;
