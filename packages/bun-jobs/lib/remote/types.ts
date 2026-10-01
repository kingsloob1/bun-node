/**
 * The remote-worker protocol's message shapes, as TypeScript types.
 *
 * Two families. The **envelopes** are what the HTTP exchange shape sends and
 * answers (`worker-runtimes.md` §5.3–§5.5): each carries `v` and an `id`,
 * because an HTTP request is signed and identified on its own. The **session
 * messages** are `remote-transports.md` §4.1–§4.2's twenty, which ride inside
 * an authenticated session (or a streamed response) and so carry neither.
 * Where an operation exists on both (`invoke`, `cancel`, `ping`, `health`,
 * `status`), the session message is the envelope without `v`/`id`.
 *
 * **Unknown fields are allowed everywhere** (forward compatibility,
 * `worker-runtimes.md` §5.12): a receiver ignores what it does not know.
 * `at` is the sender's clock, informative only, and never required: the
 * gateway's `now` and `deadlineAt` are the authoritative times.
 *
 * Browser-safe: type-only imports of sibling browser-safe modules. Each type
 * has a schema in `schemas.ts` with the same shape, held equal by
 * `__tests__/remote/remote-protocol.type-test.ts`.
 */

import type { RunLogLevel } from "../api/contract/constants";
import type { ProblemDto } from "../api/contract/types";
import type { WORKER_PROTOCOL_VERSION } from "./constants";

/** The envelope version: `WORKER_PROTOCOL_VERSION`. */
export type RemoteEnvelopeVersion = typeof WORKER_PROTOCOL_VERSION;

/* --- shared pieces ------------------------------------------------------- */

/** The gateway-side worker an invoke comes from, for joining logs to the Workers page. */
export interface RemoteWorkerRef {
  /** The worker's incarnation id (changes on every restart). */
  id: string;
  /** The worker's stable key (`<service>.<queue>`), the same across restarts. */
  key: string;
}

/** How much work a remote can take, sent on every answer that can carry it. */
export interface RemoteCapacity {
  /** Attempts running now. */
  inFlight: number;
  /** The most it runs at once. */
  max: number;
  /** `false` while draining or unready: send it nothing new. Absent means `true`. */
  accepting?: boolean;
}

/**
 * A job error as it crosses the wire: bun-common's `SerializedError` shape,
 * so the gateway rebuilds it with `deserializeError()`. `cause` is loose here
 * because a schema cannot express the recursion; the serializer bounds it.
 */
export interface RemoteError {
  /** The error's class name; `UnrecoverableJobError` round-trips by it. */
  name: string;
  /** The error's message. */
  message: string;
  /** The error's `code`, when it had one. */
  code?: string | number;
  /** The stack trace, when the remote chooses to send it. */
  stack?: string;
  /** The serialised `cause`, itself a serialised error. */
  cause?: unknown;
  /** The error's other own properties, JSON-cloned. */
  data?: Record<string, unknown>;
}

/** One log line returned with a unary outcome. */
export interface RemoteOutcomeLog {
  /** When it was written, epoch ms, on the remote's clock (informative). */
  at: number;
  /** The line. */
  line: string;
}

/** One attempt of one job, named by both halves. */
export interface RemoteJobRef {
  /** The job's id. */
  job: string;
  /** The attempt, 1-based (`attemptsMade` at the claim). */
  attempt: number;
}

/** One job in an invoke. Deliberately not the whole record: no `opts`, stack trace or return value. */
export interface RemoteInvokeJob {
  /** The job's id. */
  id: string;
  /** The job's name: which handler runs it. */
  name: string;
  /** The job's data, as stored: any JSON. */
  data: unknown;
  /** The attempt, 1-based. */
  attempt: number;
  /** How many attempts the job has in all. */
  maxAttempts?: number;
  /** When the job was created, epoch ms, gateway clock. */
  createdAt?: number;
  /** The job's priority. */
  priority?: number;
  /** The job's own timeout in ms; absent means only the invoke's `deadlineAt` applies. */
  timeoutMs?: number;
  /**
   * `<namespace>:<queue>:<jobId>:<attempt>`: the same on every transport
   * retry of one attempt, different on a new attempt.
   */
  idempotencyKey: string;
  /** `<lockToken>:<processedOn>`: grows with every claim, so a stale attempt is recognisable. */
  fence: string;
  /** How many times this attempt has been sent, 1-based. A transport retry raises it; `attempt` stays. */
  delivery: number;
  /** The repeatable schedule that produced the job, or `null`. */
  repeatKey?: string | null;
  /** The job's parent in a flow, or `null`. */
  parent?: RemoteJobParent | null;
}

/** A flow parent, as an invoke names it. */
export interface RemoteJobParent {
  /** The parent's queue. */
  queue: string;
  /** The parent's id. */
  id: string;
}

/** A job completed: the `result` message, and a unary outcome. */
export interface RemoteResultOutcome {
  /** Discriminates the outcome. */
  op: "result";
  /** The job's id. */
  job: string;
  /** The attempt this answers. */
  attempt: number;
  /** The fence this answers; the gateway refuses an outcome for a stale one. */
  fence: string;
  /** Always `"completed"`. */
  status: "completed";
  /** The handler's return value, any JSON. */
  result?: unknown;
  /** The final progress value, so a lost last `progress` never leaves a job at 90%. */
  progress?: unknown;
  /** How long the handler ran, in ms. */
  durationMs?: number;
  /** Log lines, on a unary answer that could not stream them. */
  logs?: RemoteOutcomeLog[];
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** A job failed: the `fail` message, and a unary outcome. */
export interface RemoteFailOutcome {
  /** Discriminates the outcome. */
  op: "fail";
  /** The job's id. */
  job: string;
  /** The attempt this answers. */
  attempt: number;
  /** The fence this answers; the gateway refuses an outcome for a stale one. */
  fence: string;
  /**
   * `failed` retries per the job's attempts and backoff; `failed-fatal` goes
   * to `dead` at once; `handler-not-found` too, logged distinctly, and the
   * gateway drops the name from its cached handshake.
   */
  status: "failed" | "failed-fatal" | "handler-not-found";
  /** The error, serialised. */
  error: RemoteError;
  /** Overrides the job's backoff for this attempt only, in ms. */
  retryAfterMs?: number;
  /** The last progress value. */
  progress?: unknown;
  /** How long the handler ran, in ms. */
  durationMs?: number;
  /** Log lines, on a unary answer that could not stream them. */
  logs?: RemoteOutcomeLog[];
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/**
 * Not now: the `rejected` message, and a unary outcome. **Never burns an
 * attempt.** `code` is one of `BUSY`, `DRAINING`, `STALE_FENCE`,
 * `DUPLICATE_RUNNING` or `TOO_LARGE`; a receiver treats an unknown code as a
 * rejection all the same.
 */
export interface RemoteRejectedOutcome {
  /** Discriminates the outcome. */
  op: "rejected";
  /** The job's id. */
  job: string;
  /** The attempt this answers. */
  attempt: number;
  /** The fence this answers, when the remote saw one. */
  fence?: string;
  /** Why: a problem code. */
  code: string;
  /** How long to back off before sending to this remote again, in ms. */
  retryAfterMs?: number;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** One job's outcome in an `invoke-result`. A job left out is `unknown`: its lease lapses. */
export type RemoteOutcome =
  | RemoteResultOutcome
  | RemoteFailOutcome
  | RemoteRejectedOutcome;

/** A retained outcome, as a `status-result` repeats it: the outcome without its job and attempt. */
export type RemoteRetainedOutcome =
  | Omit<RemoteResultOutcome, "job" | "attempt">
  | Omit<RemoteFailOutcome, "job" | "attempt">;

/** What an executor knows of one attempt, in a `status-result`. */
export interface RemoteAttemptStatus {
  /** The job's id. */
  job: string;
  /** The attempt asked about. */
  attempt: number;
  /** `running`, `done` (with `outcome`) or `unknown` (never had it, or forgot it). */
  state: "running" | "done" | "unknown";
  /** The retained outcome, when `state` is `done`. */
  outcome?: RemoteRetainedOutcome;
}

/** Why the gateway cancels an attempt. */
export type RemoteCancelReason =
  | "timeout"
  | "lock-lost"
  | "closing"
  | "cancelled";

/** One attempt's answer in a `cancel-result`. */
export interface RemoteCancelledJob {
  /** The job's id. */
  job: string;
  /** The attempt asked about. */
  attempt: number;
  /** Whether a running attempt was found and its signal aborted. */
  cancelled: boolean;
}

/** One of the executor author's readiness checks, in a `health-result`. */
export interface RemoteHealthCheck {
  /** The check's id, chosen by the author (`"gpu"`, `"model-loaded"`). */
  id: string;
  /** Whether it passed. */
  status: "pass" | "fail";
  /** Why it failed, for the Workers page. */
  detail?: string;
}

/** An attempt running on an executor, in a `heartbeat`. */
export interface RemoteRunningAttempt {
  /** The job's id. */
  job: string;
  /** The attempt. */
  attempt: number;
  /** When the executor accepted it, epoch ms, its own clock. */
  since: number;
}

/* --- the HTTP envelopes ---------------------------------------------- */

/**
 * The answer to the handshake `GET`. An unsigned `GET` gets only the public
 * fields (`protocols`, `maxBatch`, `maxDurationMs`, `now`); a validly signed
 * one also gets the identifying ones, and the response is signed.
 */
export interface HandshakeEnvelope {
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** Discriminates the envelope. */
  op: "handshake";
  /** Every protocol version the remote speaks; the gateway picks the highest both speak. */
  protocols: number[];
  /** `true` for a valid signature, `false` for an invalid one, `null` for none sent. */
  authenticated?: boolean | null;
  /** A display name for the Workers page. Signed answers only. */
  name?: string;
  /** Free text: the runtime, for diagnostics. Signed answers only. */
  runtime?: string;
  /** Free text: the SDK and its version. Signed answers only. */
  sdk?: string;
  /** The job names it runs; `["*"]` means anything. Signed answers only. */
  names?: string[];
  /** The most jobs one invoke may carry; `1` is legal. */
  maxBatch: number;
  /** The longest one invoke may run here, in ms. */
  maxDurationMs: number;
  /** The request-body ceiling in bytes; 1 MiB when absent. */
  maxBodyBytes?: number;
  /** Opt-in capabilities, each with its own version string. Signed answers only. */
  features?: Record<string, string>;
  /** `sha256(secret)` in hex, so an operator can tell which key runs. Signed answers only. */
  secretHash?: string;
  /** The remote's clock, epoch ms, for measuring skew. */
  now: number;
}

/** Run these jobs: the invoke `POST`. */
export interface InvokeEnvelope {
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** Discriminates the envelope. */
  op: "invoke";
  /** The envelope's id, also sent as `bun-jobs-id`: unique per send, transport retries included. */
  id: string;
  /**
   * What the invoke carries: `"job"` attempts. Absent means `"job"`; a
   * runner's `"run"` is designed with `RemoteRunner`.
   */
  kind?: "job";
  /** The gateway's clock, epoch ms. Authoritative: a remote records this, never its own. */
  now: number;
  /** Epoch ms after which the gateway stops caring about the answer. */
  deadlineAt: number;
  /** The jobs' namespace. */
  namespace: string;
  /** The jobs' queue. */
  queue: string;
  /** The worker sending it. */
  worker: RemoteWorkerRef;
  /** The jobs, 1 to the remote's `maxBatch`. */
  jobs: RemoteInvokeJob[];
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** The unary answer to an invoke: one outcome per job, keyed by job id, in any order. */
export interface InvokeResultEnvelope {
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** Discriminates the envelope. */
  op: "invoke-result";
  /** The invoke's id, echoed. */
  id: string;
  /** The remote's clock, epoch ms. */
  now: number;
  /** The jobs' outcomes. */
  outcomes: RemoteOutcome[];
  /** The remote's capacity after this invoke. */
  capacity?: RemoteCapacity;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** Stop these attempts, if you can. A courtesy: the gateway does not wait for the answer. */
export interface CancelEnvelope {
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** Discriminates the envelope. */
  op: "cancel";
  /** The envelope's id, also sent as `bun-jobs-id`. */
  id: string;
  /** The attempts to stop. */
  jobs: RemoteJobRef[];
  /** Why. */
  reason?: RemoteCancelReason;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** The answer to a cancel. */
export interface CancelResultEnvelope {
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** Discriminates the envelope. */
  op: "cancel-result";
  /** The cancel's id, echoed. */
  id: string;
  /** Per attempt asked about, whether it was found running and aborted. */
  jobs: RemoteCancelledJob[];
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** Liveness and round-trip time, with no side effects. */
export interface PingEnvelope {
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** Discriminates the envelope. */
  op: "ping";
  /** The ping's id; the `pong` echoes it. */
  id: string;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** The answer to a ping. */
export interface PongEnvelope {
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** Discriminates the envelope. */
  op: "pong";
  /** The ping's id, echoed. */
  id: string;
  /** The answering side's capacity. */
  capacity?: RemoteCapacity;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** A readiness probe: run the author's checks and report capacity. */
export interface HealthEnvelope {
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** Discriminates the envelope. */
  op: "health";
  /** The probe's id; the answer echoes it. */
  id: string;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** The answer to a readiness probe. */
export interface HealthResultEnvelope {
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** Discriminates the envelope. */
  op: "health-result";
  /** The probe's id, echoed. */
  id: string;
  /** Whether it is ready for work: every check passed and it is not draining. */
  ok: boolean;
  /** Its capacity. */
  capacity?: RemoteCapacity;
  /** The author's checks. */
  checks?: RemoteHealthCheck[];
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** What happened to these attempts? Asked when an answer was lost. */
export interface StatusEnvelope {
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** Discriminates the envelope. */
  op: "status";
  /** The envelope's id, also sent as `bun-jobs-id`. */
  id: string;
  /** The attempts asked about. */
  jobs: RemoteJobRef[];
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** The answer to a status question. */
export interface StatusResultEnvelope {
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** Discriminates the envelope. */
  op: "status-result";
  /** The question's id, echoed. */
  id: string;
  /** Per attempt asked about, what the executor knows. */
  jobs: RemoteAttemptStatus[];
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** Every HTTP envelope. */
export type RemoteEnvelope =
  | HandshakeEnvelope
  | InvokeEnvelope
  | InvokeResultEnvelope
  | CancelEnvelope
  | CancelResultEnvelope
  | PingEnvelope
  | PongEnvelope
  | HealthEnvelope
  | HealthResultEnvelope
  | StatusEnvelope
  | StatusResultEnvelope;

/* --- the session messages (internal until a session API ships) --------- */

/** Timings a dialler asks for in `hello`. */
export interface RemoteWantedTimings {
  /** Send a `ping` after this long quiet in a direction, in ms. */
  keepaliveMs?: number;
  /** The executor's `heartbeat` interval, in ms. */
  heartbeatMs?: number;
  /** How long a bare `ack` may wait for a message to ride on, in ms. */
  ackDelayMs?: number;
}

/** Timings the dialled side settles on in `welcome`. */
export interface RemoteTimings {
  /** Send a `ping` after this long quiet in a direction, in ms. */
  keepaliveMs?: number;
  /** The executor's `heartbeat` interval, in ms. */
  heartbeatMs?: number;
}

/** Open or resume a session. MAC'd with the session id `-`; `t` is checked like a signature's. */
export interface HelloMessage {
  /** Discriminates the message. */
  op: "hello";
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** Every protocol version the dialler speaks. */
  protocols: number[];
  /** The dialler's role. */
  role: "gateway" | "executor";
  /** 128 random bits, base64url without padding: half the session id. */
  nonce: string;
  /** Unix seconds, checked against the replay window in both directions. */
  t: number;
  /** The gateway's worker, when the gateway dials. */
  worker?: RemoteWorkerRef;
  /** Timings the dialler asks for. */
  want?: RemoteWantedTimings;
  /** What to resume, or `null` for a new session (the reliability layer's shape). */
  resume?: Record<string, unknown> | null;
  /** The dialler's features. */
  features?: Record<string, string>;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** Accept a session: the handshake document, plus the session's own terms. */
export interface WelcomeMessage {
  /** Discriminates the message. */
  op: "welcome";
  /** The envelope version. */
  v: RemoteEnvelopeVersion;
  /** The protocol version chosen. */
  protocol: number;
  /** The dialled side's role. */
  role: "gateway" | "executor";
  /** 128 random bits, base64url without padding: the other half of the session id. */
  nonce: string;
  /** A display name for the Workers page. */
  name?: string;
  /** Free text: the runtime. */
  runtime?: string;
  /** Free text: the SDK and its version. */
  sdk?: string;
  /** The job names it runs; `["*"]` means anything. */
  names: string[];
  /** The most jobs one invoke may carry. */
  maxBatch: number;
  /** The longest one invoke may run here, in ms. */
  maxDurationMs: number;
  /** The largest message it accepts, in bytes. */
  maxMessageBytes?: number;
  /** The timings it settled on. */
  timing?: RemoteTimings;
  /** Its capacity now. */
  capacity: RemoteCapacity;
  /** Its features. */
  features?: Record<string, string>;
  /** What was resumed, or `null` (the reliability layer's shape). */
  resumed?: Record<string, unknown> | null;
  /** Its clock, epoch ms, for measuring skew. */
  now: number;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** `invoke` on a session: the envelope, with the worker optional (the session's `hello` named it). */
export type InvokeMessage = Omit<InvokeEnvelope, "worker"> & {
  /** The worker sending it; the session's `hello` already named it. */
  worker?: RemoteWorkerRef;
};

/** "I have it and have started", per job, within the accept timeout. */
export interface AcceptedMessage {
  /** Discriminates the message. */
  op: "accepted";
  /** The job's id. */
  job: string;
  /** The attempt. */
  attempt: number;
  /** The fence accepted. */
  fence: string;
  /** `true` when this joins an attempt already running here (same idempotency key). */
  duplicate?: boolean;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** A job's progress value. Unreliable on UDP, so `pseq` orders it. */
export interface ProgressMessage {
  /** Discriminates the message. */
  op: "progress";
  /** The job's id. */
  job: string;
  /** The attempt. */
  attempt: number;
  /** Per-attempt counter: a value older than one already applied is ignored. */
  pseq: number;
  /** The progress value, any JSON. */
  progress: unknown;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** A log line for a job. */
export interface LogMessage {
  /** Discriminates the message. */
  op: "log";
  /** The job's id. */
  job: string;
  /** The attempt. */
  attempt: number;
  /** The line's severity. */
  level: RunLogLevel;
  /** The line. */
  message: string;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** Every `heartbeatMs`, idle or not: what is running and how much room is left. */
export interface HeartbeatMessage {
  /** Discriminates the message. */
  op: "heartbeat";
  /** The attempts running now. */
  running: RemoteRunningAttempt[];
  /** Capacity now. */
  capacity: RemoteCapacity;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** `ping` on a session. */
export type PingMessage = Omit<PingEnvelope, "v">;
/** `pong` on a session. */
export type PongMessage = Omit<PongEnvelope, "v">;
/** `health` on a session. */
export type HealthMessage = Omit<HealthEnvelope, "v">;
/** `health-result` on a session. */
export type HealthResultMessage = Omit<HealthResultEnvelope, "v">;
/** `cancel` on a session. */
export type CancelMessage = Omit<CancelEnvelope, "v" | "id">;
/** `status` on a session. */
export type StatusMessage = Omit<StatusEnvelope, "v" | "id">;
/** `status-result` on a session. */
export type StatusResultMessage = Omit<StatusResultEnvelope, "v" | "id">;

/** A bare acknowledgement, when nothing else is going the other way in time. */
export interface AckMessage {
  /** Discriminates the message. */
  op: "ack";
}

/** Ending a session, with a problem code. */
export interface CloseMessage {
  /** Discriminates the message. */
  op: "close";
  /** Why: a problem code (`COMPLETE` for a streamed invoke's normal end). */
  code: string;
  /** `true`: no new invokes, in-flight attempts continue. */
  drain?: boolean;
  /** How long to wait before reconnecting, in ms. */
  retryAfterMs?: number;
  /** With `UNSUPPORTED_PROTOCOL`: the versions the sender speaks. */
  supported?: number[];
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** A protocol error as an RFC 9457 problem, without ending the session unless `fatal`. */
export interface ProblemMessage {
  /** Discriminates the message. */
  op: "problem";
  /** The problem. */
  problem: ProblemDto;
  /** Whether the session ends with it. */
  fatal: boolean;
  /** The sender's clock, epoch ms; informative. */
  at?: number;
}

/** Every session message. */
export type RemoteMessage =
  | HelloMessage
  | WelcomeMessage
  | InvokeMessage
  | AcceptedMessage
  | RemoteRejectedOutcome
  | ProgressMessage
  | LogMessage
  | HeartbeatMessage
  | PingMessage
  | PongMessage
  | HealthMessage
  | HealthResultMessage
  | RemoteResultOutcome
  | RemoteFailOutcome
  | CancelMessage
  | StatusMessage
  | StatusResultMessage
  | AckMessage
  | CloseMessage
  | ProblemMessage;
