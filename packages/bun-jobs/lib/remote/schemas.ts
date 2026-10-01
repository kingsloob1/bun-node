/**
 * The remote-worker protocol's messages as schemas: one definition for the
 * validator, the TypeScript types (`types.ts` is held equal to these by
 * `__tests__/remote/remote-protocol.type-test.ts`) and, later, the protocol's
 * JSON Schema document.
 *
 * Built with the management API's builder (`api/schema/builder.ts`), whose
 * runtime graph is browser-safe: it imports bun-common for types only. Every
 * object here allows unknown properties and passes them through, because a
 * receiver ignores what it does not know (`worker-runtimes.md` §5.12).
 *
 * Internal: `./remote` exports the types, not these values, so its
 * declarations never reach bun-common's (and with it Bun's) types.
 */

import type { Infer, PropertySchema, Schema } from "../api/schema/builder";
import { MAX_JOB_ID_LENGTH, RUN_LOG_LEVELS } from "../api/contract/constants";
import { s } from "../api/schema/builder";
import { WORKER_PROTOCOL_VERSION } from "./constants";

/** An object schema that keeps the properties it does not know. */
function open<const P extends Record<string, PropertySchema>>(
  properties: P,
  description?: string,
) {
  return s.object(properties, { additionalProperties: true, description });
}

/* --- scalars ------------------------------------------------------------- */

/** An epoch-ms instant. */
const instant = () => s.integer({ minimum: 0 });
/** A non-negative count or duration in ms. */
const count = () => s.integer({ minimum: 0 });
/** A 1-based counter. */
const ordinal = () => s.integer({ minimum: 1 });
/** A job id, bounded as the queue bounds it. */
const jobId = () => s.string({ minLength: 1, maxLength: MAX_JOB_ID_LENGTH });
/** A non-empty identifier. */
const ident = () => s.string({ minLength: 1 });
/** A problem code: upper-case words, so a code from a newer peer still parses. */
const code = () => s.string({ pattern: /^[A-Z][A-Z0-9_]*$/ });
/** 128 random bits as unpadded base64url. */
const nonce = () => s.string({ pattern: /^[\w-]{22}$/ });
/** A protocol version list. */
const versions = () => s.array(ordinal(), { minItems: 1 });
/** A feature map: name to version string. */
const features = () => s.record(s.string());
/** The envelope version. */
const version = () => s.literal(WORKER_PROTOCOL_VERSION);
/** The informative `at`. */
const at = () => s.optional(instant());

/* --- shared pieces ------------------------------------------------------- */

export const RemoteWorkerRefSchema = open({ id: ident(), key: ident() });

export const RemoteCapacitySchema = open({
  inFlight: count(),
  max: count(),
  accepting: s.optional(s.boolean()),
});

export const RemoteErrorSchema = open({
  name: s.string(),
  message: s.string(),
  code: s.optional(s.union(s.string(), s.number())),
  stack: s.optional(s.string()),
  cause: s.optional(s.unknown()),
  data: s.optional(s.record(s.unknown())),
});

export const RemoteOutcomeLogSchema = open({ at: instant(), line: s.string() });

export const RemoteJobRefSchema = open({ job: jobId(), attempt: ordinal() });

export const RemoteJobParentSchema = open({ queue: ident(), id: jobId() });

export const RemoteInvokeJobSchema = open({
  id: jobId(),
  name: ident(),
  data: s.unknown(),
  attempt: ordinal(),
  maxAttempts: s.optional(ordinal()),
  createdAt: s.optional(instant()),
  priority: s.optional(s.integer()),
  timeoutMs: s.optional(count()),
  idempotencyKey: ident(),
  fence: ident(),
  delivery: ordinal(),
  repeatKey: s.optional(s.nullable(s.string())),
  parent: s.optional(s.nullable(RemoteJobParentSchema)),
});

/** The fields every completed outcome has, without its job and attempt. */
const resultFields = {
  op: s.literal("result"),
  fence: ident(),
  status: s.literal("completed"),
  result: s.optional(s.unknown()),
  progress: s.optional(s.unknown()),
  durationMs: s.optional(s.number({ minimum: 0 })),
  logs: s.optional(s.array(RemoteOutcomeLogSchema)),
  at: at(),
};

/** The fields every failed outcome has, without its job and attempt. */
const failFields = {
  op: s.literal("fail"),
  fence: ident(),
  status: s.enum(["failed", "failed-fatal", "handler-not-found"]),
  error: RemoteErrorSchema,
  retryAfterMs: s.optional(count()),
  progress: s.optional(s.unknown()),
  durationMs: s.optional(s.number({ minimum: 0 })),
  logs: s.optional(s.array(RemoteOutcomeLogSchema)),
  at: at(),
};

export const RemoteResultOutcomeSchema = open({
  job: jobId(),
  attempt: ordinal(),
  ...resultFields,
});

export const RemoteFailOutcomeSchema = open({
  job: jobId(),
  attempt: ordinal(),
  ...failFields,
});

export const RemoteRejectedOutcomeSchema = open({
  op: s.literal("rejected"),
  job: jobId(),
  attempt: ordinal(),
  fence: s.optional(ident()),
  code: code(),
  retryAfterMs: s.optional(count()),
  at: at(),
});

export const RemoteOutcomeSchema = s.union(
  RemoteResultOutcomeSchema,
  RemoteFailOutcomeSchema,
  RemoteRejectedOutcomeSchema,
);

export const RemoteRetainedOutcomeSchema = s.union(
  open(resultFields),
  open(failFields),
);

export const RemoteAttemptStatusSchema = open({
  job: jobId(),
  attempt: ordinal(),
  state: s.enum(["running", "done", "unknown"]),
  outcome: s.optional(RemoteRetainedOutcomeSchema),
});

export const RemoteCancelReasonSchema = s.enum([
  "timeout",
  "lock-lost",
  "closing",
  "cancelled",
]);

export const RemoteCancelledJobSchema = open({
  job: jobId(),
  attempt: ordinal(),
  cancelled: s.boolean(),
});

export const RemoteHealthCheckSchema = open({
  id: ident(),
  status: s.enum(["pass", "fail"]),
  detail: s.optional(s.string()),
});

export const RemoteRunningAttemptSchema = open({
  job: jobId(),
  attempt: ordinal(),
  since: instant(),
});

/** A problem as a session carries it; extra members (`supported`) pass through. */
export const RemoteProblemSchema = open({
  type: s.string(),
  title: s.string(),
  status: s.integer({ minimum: 100, maximum: 599 }),
  code: s.string(),
  detail: s.optional(s.string()),
  instance: s.optional(s.string()),
  issues: s.optional(
    s.array(
      open({
        target: s.enum(["params", "query", "body", "headers"]),
        path: s.string(),
        message: s.string(),
      }),
    ),
  ),
  context: s.optional(s.record(s.unknown())),
});

/* --- the HTTP envelopes ---------------------------------------------- */

export const HandshakeEnvelopeSchema = open({
  v: version(),
  op: s.literal("handshake"),
  protocols: versions(),
  authenticated: s.optional(s.nullable(s.boolean())),
  name: s.optional(s.string()),
  runtime: s.optional(s.string()),
  sdk: s.optional(s.string()),
  names: s.optional(s.array(ident())),
  maxBatch: ordinal(),
  maxDurationMs: ordinal(),
  maxBodyBytes: s.optional(ordinal()),
  features: s.optional(features()),
  secretHash: s.optional(s.string({ pattern: /^[0-9a-f]{64}$/ })),
  now: instant(),
});

/** The invoke's fields, shared by the envelope and the session message. */
const invokeFields = {
  v: version(),
  op: s.literal("invoke"),
  id: ident(),
  kind: s.optional(s.literal("job")),
  now: instant(),
  deadlineAt: instant(),
  namespace: ident(),
  queue: ident(),
  jobs: s.array(RemoteInvokeJobSchema, { minItems: 1 }),
  at: at(),
};

export const InvokeEnvelopeSchema = open({
  ...invokeFields,
  worker: RemoteWorkerRefSchema,
});

export const InvokeResultEnvelopeSchema = open({
  v: version(),
  op: s.literal("invoke-result"),
  id: ident(),
  now: instant(),
  outcomes: s.array(RemoteOutcomeSchema),
  capacity: s.optional(RemoteCapacitySchema),
  at: at(),
});

/** The cancel's fields without `v` and `id`. */
const cancelFields = {
  op: s.literal("cancel"),
  jobs: s.array(RemoteJobRefSchema, { minItems: 1 }),
  reason: s.optional(RemoteCancelReasonSchema),
  at: at(),
};

export const CancelEnvelopeSchema = open({
  v: version(),
  id: ident(),
  ...cancelFields,
});

export const CancelResultEnvelopeSchema = open({
  v: version(),
  op: s.literal("cancel-result"),
  id: ident(),
  jobs: s.array(RemoteCancelledJobSchema),
  at: at(),
});

/** The ping's fields without `v`. */
const pingFields = { op: s.literal("ping"), id: ident(), at: at() };

export const PingEnvelopeSchema = open({ v: version(), ...pingFields });

/** The pong's fields without `v`. */
const pongFields = {
  op: s.literal("pong"),
  id: ident(),
  capacity: s.optional(RemoteCapacitySchema),
  at: at(),
};

export const PongEnvelopeSchema = open({ v: version(), ...pongFields });

/** The health probe's fields without `v`. */
const healthFields = { op: s.literal("health"), id: ident(), at: at() };

export const HealthEnvelopeSchema = open({ v: version(), ...healthFields });

/** The health answer's fields without `v`. */
const healthResultFields = {
  op: s.literal("health-result"),
  id: ident(),
  ok: s.boolean(),
  capacity: s.optional(RemoteCapacitySchema),
  checks: s.optional(s.array(RemoteHealthCheckSchema)),
  at: at(),
};

export const HealthResultEnvelopeSchema = open({
  v: version(),
  ...healthResultFields,
});

/** The status question's fields without `v` and `id`. */
const statusFields = {
  op: s.literal("status"),
  jobs: s.array(RemoteJobRefSchema, { minItems: 1 }),
  at: at(),
};

export const StatusEnvelopeSchema = open({
  v: version(),
  id: ident(),
  ...statusFields,
});

/** The status answer's fields without `v` and `id`. */
const statusResultFields = {
  op: s.literal("status-result"),
  jobs: s.array(RemoteAttemptStatusSchema),
  at: at(),
};

export const StatusResultEnvelopeSchema = open({
  v: version(),
  id: ident(),
  ...statusResultFields,
});

/* --- the session messages -------------------------------------------- */

export const HelloMessageSchema = open({
  op: s.literal("hello"),
  v: version(),
  protocols: versions(),
  role: s.enum(["gateway", "executor"]),
  nonce: nonce(),
  t: s.integer({ minimum: 0 }),
  worker: s.optional(RemoteWorkerRefSchema),
  want: s.optional(
    open({
      keepaliveMs: s.optional(ordinal()),
      heartbeatMs: s.optional(ordinal()),
      ackDelayMs: s.optional(count()),
    }),
  ),
  resume: s.optional(s.nullable(s.record(s.unknown()))),
  features: s.optional(features()),
  at: at(),
});

export const WelcomeMessageSchema = open({
  op: s.literal("welcome"),
  v: version(),
  protocol: ordinal(),
  role: s.enum(["gateway", "executor"]),
  nonce: nonce(),
  name: s.optional(s.string()),
  runtime: s.optional(s.string()),
  sdk: s.optional(s.string()),
  names: s.array(ident()),
  maxBatch: ordinal(),
  maxDurationMs: ordinal(),
  maxMessageBytes: s.optional(ordinal()),
  timing: s.optional(
    open({
      keepaliveMs: s.optional(ordinal()),
      heartbeatMs: s.optional(ordinal()),
    }),
  ),
  capacity: RemoteCapacitySchema,
  features: s.optional(features()),
  resumed: s.optional(s.nullable(s.record(s.unknown()))),
  now: instant(),
  at: at(),
});

export const InvokeMessageSchema = open({
  ...invokeFields,
  worker: s.optional(RemoteWorkerRefSchema),
});

export const AcceptedMessageSchema = open({
  op: s.literal("accepted"),
  job: jobId(),
  attempt: ordinal(),
  fence: ident(),
  duplicate: s.optional(s.boolean()),
  at: at(),
});

export const ProgressMessageSchema = open({
  op: s.literal("progress"),
  job: jobId(),
  attempt: ordinal(),
  pseq: count(),
  progress: s.unknown(),
  at: at(),
});

export const LogMessageSchema = open({
  op: s.literal("log"),
  job: jobId(),
  attempt: ordinal(),
  level: s.enum(RUN_LOG_LEVELS),
  message: s.string(),
  at: at(),
});

export const HeartbeatMessageSchema = open({
  op: s.literal("heartbeat"),
  running: s.array(RemoteRunningAttemptSchema),
  capacity: RemoteCapacitySchema,
  at: at(),
});

export const PingMessageSchema = open(pingFields);
export const PongMessageSchema = open(pongFields);
export const HealthMessageSchema = open(healthFields);
export const HealthResultMessageSchema = open(healthResultFields);
export const CancelMessageSchema = open(cancelFields);
export const StatusMessageSchema = open(statusFields);
export const StatusResultMessageSchema = open(statusResultFields);

export const AckMessageSchema = open({ op: s.literal("ack") });

export const CloseMessageSchema = open({
  op: s.literal("close"),
  code: code(),
  drain: s.optional(s.boolean()),
  retryAfterMs: s.optional(count()),
  supported: s.optional(versions()),
  at: at(),
});

export const ProblemMessageSchema = open({
  op: s.literal("problem"),
  problem: RemoteProblemSchema,
  fatal: s.boolean(),
  at: at(),
});

/* --- by op ------------------------------------------------------------- */

/** Every HTTP envelope's schema, by its `op`. */
export const REMOTE_ENVELOPE_SCHEMAS = Object.freeze({
  handshake: HandshakeEnvelopeSchema,
  invoke: InvokeEnvelopeSchema,
  "invoke-result": InvokeResultEnvelopeSchema,
  cancel: CancelEnvelopeSchema,
  "cancel-result": CancelResultEnvelopeSchema,
  ping: PingEnvelopeSchema,
  pong: PongEnvelopeSchema,
  health: HealthEnvelopeSchema,
  "health-result": HealthResultEnvelopeSchema,
  status: StatusEnvelopeSchema,
  "status-result": StatusResultEnvelopeSchema,
});

/** Every session message's schema, by its `op`: `remote-transports.md` §4.1's twenty. */
export const REMOTE_MESSAGE_SCHEMAS = Object.freeze({
  hello: HelloMessageSchema,
  welcome: WelcomeMessageSchema,
  invoke: InvokeMessageSchema,
  accepted: AcceptedMessageSchema,
  rejected: RemoteRejectedOutcomeSchema,
  progress: ProgressMessageSchema,
  log: LogMessageSchema,
  heartbeat: HeartbeatMessageSchema,
  ping: PingMessageSchema,
  pong: PongMessageSchema,
  health: HealthMessageSchema,
  "health-result": HealthResultMessageSchema,
  result: RemoteResultOutcomeSchema,
  fail: RemoteFailOutcomeSchema,
  cancel: CancelMessageSchema,
  status: StatusMessageSchema,
  "status-result": StatusResultMessageSchema,
  ack: AckMessageSchema,
  close: CloseMessageSchema,
  problem: ProblemMessageSchema,
});

/** An envelope `op`. */
export type RemoteEnvelopeOp = keyof typeof REMOTE_ENVELOPE_SCHEMAS;
/** A session message `op`. */
export type RemoteMessageOp = keyof typeof REMOTE_MESSAGE_SCHEMAS;

/** What validating a message produced: the typed value, or the issues found. */
export type RemoteParseResult<T> =
  | {
      /** The message is valid. */
      ok: true;
      /** The validated message, unknown properties kept. */
      value: T;
    }
  | {
      /** The message is not valid. */
      ok: false;
      /** Each problem, with its dotted path (`""` for the message itself). */
      issues: { path: string; message: string }[];
    };

/** Runs one schema synchronously and flattens its issues. */
function run<T>(
  schema: Schema<unknown, any>,
  value: unknown,
): RemoteParseResult<T> {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    // The builder's validator is synchronous; a promise here is a bug.
    throw new TypeError("remote schemas validate synchronously");
  }
  if (result.issues) {
    return {
      ok: false,
      issues: result.issues.map((issue) => ({
        path: (issue.path ?? [])
          .map((segment) =>
            String(typeof segment === "object" ? segment.key : segment),
          )
          .join("."),
        message: issue.message,
      })),
    };
  }
  return { ok: true, value: result.value as T };
}

/** The `op` of a parsed JSON value, if it has a string one. */
function opOf(value: unknown): string | undefined {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as { op?: unknown }).op === "string"
    ? (value as { op: string }).op
    : undefined;
}

/**
 * Validates a parsed HTTP envelope by its `op`. An `op` that is not an
 * envelope's is reported as an issue at `op`, so the caller can answer
 * `UNSUPPORTED_OP` rather than a generic validation failure.
 */
export function parseRemoteEnvelope(
  value: unknown,
): RemoteParseResult<
  Infer<(typeof REMOTE_ENVELOPE_SCHEMAS)[RemoteEnvelopeOp]>
> {
  const op = opOf(value);
  if (op === undefined || !Object.hasOwn(REMOTE_ENVELOPE_SCHEMAS, op)) {
    return { ok: false, issues: [{ path: "op", message: "Unsupported op" }] };
  }
  return run(REMOTE_ENVELOPE_SCHEMAS[op as RemoteEnvelopeOp], value);
}

/** Validates a parsed session message by its `op`; see {@link parseRemoteEnvelope}. */
export function parseRemoteMessage(
  value: unknown,
): RemoteParseResult<Infer<(typeof REMOTE_MESSAGE_SCHEMAS)[RemoteMessageOp]>> {
  const op = opOf(value);
  if (op === undefined || !Object.hasOwn(REMOTE_MESSAGE_SCHEMAS, op)) {
    return { ok: false, issues: [{ path: "op", message: "Unsupported op" }] };
  }
  return run(REMOTE_MESSAGE_SCHEMAS[op as RemoteMessageOp], value);
}
