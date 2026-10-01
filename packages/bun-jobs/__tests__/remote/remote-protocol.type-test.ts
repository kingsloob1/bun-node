import type { SerializedError } from "@kingsleyweb/bun-common";
import type * as Remote from "@kingsleyweb/bun-jobs/remote";
import type { Infer } from "../../lib/api/schema/builder";
import type * as S from "../../lib/remote/schemas";
import type * as T from "../../lib/remote/types";

/**
 * Compile-time checks, run by the tests typecheck rather than `bun test`:
 * every protocol type in `lib/remote/types.ts` is exactly what its schema
 * validates into, so the documented type and the enforced shape cannot
 * drift. Negative controls are `@ts-expect-error` lines: if the assertion
 * under one stopped failing, the directive itself would become the error.
 */

type Equal<X, Y> =
  (<V>() => V extends X ? 1 : 2) extends <V>() => V extends Y ? 1 : 2
    ? true
    : false;
type Expect<V extends true> = V;

/** Recursively flattens, so intersections and `Omit`s compare as plain shapes. */
type Deep<V> = V extends (infer U)[]
  ? Deep<U>[]
  : V extends object
    ? { [K in keyof V]: Deep<V[K]> }
    : V;

/** Equality after flattening both sides all the way down. */
type DeepEqual<X, Y> = Equal<Deep<X>, Deep<Y>>;

/** A schema's output against a type. */
type Matches<Schema, Type> = DeepEqual<Infer<Schema>, Type>;

/* --- shared pieces ----------------------------------------------------- */

export type QueueRefOk = Expect<
  Matches<typeof S.RemoteQueueRefSchema, T.RemoteQueueRef>
>;
export type JobRefOk = Expect<
  Matches<typeof S.RemoteJobRefSchema, T.RemoteJobRef>
>;
export type CancelledJobOk = Expect<
  Matches<typeof S.RemoteCancelledJobSchema, T.RemoteCancelledJob>
>;
export type WorkerRefOk = Expect<
  Matches<typeof S.RemoteWorkerRefSchema, T.RemoteWorkerRef>
>;
export type CapacityOk = Expect<
  Matches<typeof S.RemoteCapacitySchema, T.RemoteCapacity>
>;
export type ErrorOk = Expect<
  Matches<typeof S.RemoteErrorSchema, T.RemoteError>
>;
export type InvokeJobOk = Expect<
  Matches<typeof S.RemoteInvokeJobSchema, T.RemoteInvokeJob>
>;
export type OutcomeOk = Expect<
  Matches<typeof S.RemoteOutcomeSchema, T.RemoteOutcome>
>;
export type RetainedOk = Expect<
  Matches<typeof S.RemoteRetainedOutcomeSchema, T.RemoteRetainedOutcome>
>;
export type AttemptStatusOk = Expect<
  Matches<typeof S.RemoteAttemptStatusSchema, T.RemoteAttemptStatus>
>;
export type CancelReasonOk = Expect<
  Matches<typeof S.RemoteCancelReasonSchema, T.RemoteCancelReason>
>;
export type ProblemOk = Expect<
  Matches<typeof S.RemoteProblemSchema, T.ProblemMessage["problem"]>
>;

/* --- envelopes --------------------------------------------------------- */

export type HandshakeOk = Expect<
  Matches<typeof S.HandshakeEnvelopeSchema, Remote.HandshakeEnvelope>
>;
export type InvokeOk = Expect<
  Matches<typeof S.InvokeEnvelopeSchema, Remote.InvokeEnvelope>
>;
export type InvokeResultOk = Expect<
  Matches<typeof S.InvokeResultEnvelopeSchema, Remote.InvokeResultEnvelope>
>;
export type CancelOk = Expect<
  Matches<typeof S.CancelEnvelopeSchema, Remote.CancelEnvelope>
>;
export type CancelResultOk = Expect<
  Matches<typeof S.CancelResultEnvelopeSchema, Remote.CancelResultEnvelope>
>;
export type PingOk = Expect<
  Matches<typeof S.PingEnvelopeSchema, Remote.PingEnvelope>
>;
export type PongOk = Expect<
  Matches<typeof S.PongEnvelopeSchema, Remote.PongEnvelope>
>;
export type HealthOk = Expect<
  Matches<typeof S.HealthEnvelopeSchema, Remote.HealthEnvelope>
>;
export type HealthResultOk = Expect<
  Matches<typeof S.HealthResultEnvelopeSchema, Remote.HealthResultEnvelope>
>;
export type StatusOk = Expect<
  Matches<typeof S.StatusEnvelopeSchema, Remote.StatusEnvelope>
>;
export type StatusResultOk = Expect<
  Matches<typeof S.StatusResultEnvelopeSchema, Remote.StatusResultEnvelope>
>;

/* --- session messages -------------------------------------------------- */

export type HelloOk = Expect<
  Matches<typeof S.HelloMessageSchema, T.HelloMessage>
>;
export type WelcomeOk = Expect<
  Matches<typeof S.WelcomeMessageSchema, T.WelcomeMessage>
>;
export type InvokeMessageOk = Expect<
  Matches<typeof S.InvokeMessageSchema, T.InvokeMessage>
>;
export type AcceptedOk = Expect<
  Matches<typeof S.AcceptedMessageSchema, T.AcceptedMessage>
>;
export type ProgressOk = Expect<
  Matches<typeof S.ProgressMessageSchema, T.ProgressMessage>
>;
export type LogOk = Expect<Matches<typeof S.LogMessageSchema, T.LogMessage>>;
export type HeartbeatOk = Expect<
  Matches<typeof S.HeartbeatMessageSchema, T.HeartbeatMessage>
>;
export type PingMessageOk = Expect<
  Matches<typeof S.PingMessageSchema, T.PingMessage>
>;
export type PongMessageOk = Expect<
  Matches<typeof S.PongMessageSchema, T.PongMessage>
>;
export type HealthMessageOk = Expect<
  Matches<typeof S.HealthMessageSchema, T.HealthMessage>
>;
export type HealthResultMessageOk = Expect<
  Matches<typeof S.HealthResultMessageSchema, T.HealthResultMessage>
>;
export type CancelMessageOk = Expect<
  Matches<typeof S.CancelMessageSchema, T.CancelMessage>
>;
export type StatusMessageOk = Expect<
  Matches<typeof S.StatusMessageSchema, T.StatusMessage>
>;
export type StatusResultMessageOk = Expect<
  Matches<typeof S.StatusResultMessageSchema, T.StatusResultMessage>
>;
export type AckOk = Expect<Matches<typeof S.AckMessageSchema, T.AckMessage>>;
export type CloseOk = Expect<
  Matches<typeof S.CloseMessageSchema, T.CloseMessage>
>;
export type ProblemMessageOk = Expect<
  Matches<typeof S.ProblemMessageSchema, T.ProblemMessage>
>;

/** The message union is exactly what the by-op table validates into. */
export type MessageUnionOk = Expect<
  DeepEqual<
    Infer<(typeof S.REMOTE_MESSAGE_SCHEMAS)[S.RemoteMessageOp]>,
    T.RemoteMessage
  >
>;
export type EnvelopeUnionOk = Expect<
  DeepEqual<
    Infer<(typeof S.REMOTE_ENVELOPE_SCHEMAS)[S.RemoteEnvelopeOp]>,
    Remote.RemoteEnvelope
  >
>;

/** A by-op table names exactly its family's ops. */
export type EnvelopeOpsOk = Expect<
  Equal<S.RemoteEnvelopeOp, Remote.RemoteEnvelope["op"]>
>;
export type MessageOpsOk = Expect<
  Equal<S.RemoteMessageOp, T.RemoteMessage["op"]>
>;
export type AllOpsOk = Expect<
  Equal<S.RemoteEnvelopeOp | S.RemoteMessageOp, Remote.RemoteOp>
>;

/* --- the wire error ---------------------------------------------------- */

/** Whatever bun-common's `serializeError` produces is a valid `RemoteError`. */
export const _serialized = (error: SerializedError): Remote.RemoteError =>
  error;

/* --- negative controls ------------------------------------------------- */

export type ExtraFieldFails = Expect<
  // @ts-expect-error a type with one more required field is not the schema's
  Matches<typeof S.PingEnvelopeSchema, Remote.PingEnvelope & { extra: string }>
>;

export type RequiredFails = Expect<
  // @ts-expect-error an optional field made required is not the schema's
  Matches<
    typeof S.PingEnvelopeSchema,
    Omit<Remote.PingEnvelope, "at"> & { at: number }
  >
>;

export type WidenedFails = Expect<
  // @ts-expect-error a widened literal is not the schema's
  Matches<
    typeof S.RemoteFailOutcomeSchema,
    Omit<T.RemoteFailOutcome, "status"> & { status: string }
  >
>;

// @ts-expect-error an error with no message is not a RemoteError
export const _noMessage: Remote.RemoteError = { name: "Error" };
