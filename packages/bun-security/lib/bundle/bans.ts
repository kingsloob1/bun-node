/**
 * Signed ban batches (control-plane.md §7, the user's decision for PR-CP4):
 * what the control plane answers an agent's `GET /agent/bans`, signed with
 * the **bundle key** (Ed25519 over the canonical JSON of everything but
 * `signature`, as a bundle is), so a ban forged into the control plane's
 * database, or into the answer, is refused by the agent, which holds only
 * the deploy-time public keys.
 *
 * A batch names the request it answers (the agent's signed request id),
 * the `since` it was asked from and the change sequence it reaches
 * (`seq`): an agent refuses a batch made for another request, so an older
 * batch replayed (even one asked from the same `since`) cannot take back a
 * lift or put back a lifted ban.
 */
import { Buffer } from "node:buffer";
import { verify } from "node:crypto";
import type { BanRecord } from "../store/types";
import type { BundlePublicKey, BundleSignature } from "./bundle";
import { canonicalJson, publicKeyOf } from "./bundle";

/** A ban batch's format id. */
export const BAN_BATCH_FORMAT = "bun-security.bans/1";

/** The bans an agent is sent: every ban whose scope covers its service. */
export interface BanBatch {
  /** {@link BAN_BATCH_FORMAT}. */
  readonly format: typeof BAN_BATCH_FORMAT;
  /** The service it was made for. */
  readonly service: string;
  /** The id of the signed request it answers. */
  readonly request: string;
  /** The change sequence the agent asked from, as decimal text (`"0"` for everything). */
  readonly since: string;
  /** The change sequence it reaches, as decimal text: the agent's next `since`. */
  readonly seq: string;
  /** `true`: the whole active set (replace); `false`: what changed after `since` (apply). */
  readonly full: boolean;
  /** When it was made, epoch ms. */
  readonly issuedAt: number;
  /** The bans: active ones, and, in a delta, lifted or expired ones to take away. */
  readonly bans: readonly BanRecord[];
  /** The signature over the rest. */
  readonly signature: BundleSignature;
}

/** What {@link verifyBanBatch} checks the batch against. */
export interface VerifyBanBatchOptions {
  /** The service this agent is. */
  readonly service: string;
  /** The `since` the agent asked from. */
  readonly since: bigint;
  /** The id of the request the agent sent. */
  readonly request: string;
}

/** Why {@link verifyBanBatch} refused a batch. */
export type BanBatchRefusal =
  | "malformed"
  | "format"
  | "unknown-key"
  | "signature"
  | "wrong-service"
  | "replayed";

/** What {@link verifyBanBatch} decided. */
export type BanBatchVerdict =
  | { readonly ok: true; readonly batch: BanBatch; readonly seq: bigint }
  | { readonly ok: false; readonly reason: BanBatchRefusal };

/** The bytes a ban batch's signature covers. */
export function banBatchSigningBytes(
  batch: Omit<BanBatch, "signature"> | BanBatch,
): Uint8Array {
  const { signature: _signature, ...rest } = batch as BanBatch;
  return new TextEncoder().encode(canonicalJson(rest));
}

/** A sequence's decimal text, or `undefined`. */
function sequence(text: unknown): bigint | undefined {
  return typeof text === "string" && /^\d{1,30}$/.test(text)
    ? BigInt(text)
    : undefined;
}

/** Whether `value` has a batch's shape. */
function isBatch(value: unknown): value is BanBatch {
  if (typeof value !== "object" || value === null) return false;
  const batch = value as Record<string, unknown>;
  const signature = batch.signature as Record<string, unknown> | undefined;
  return (
    typeof batch.format === "string" &&
    typeof batch.service === "string" &&
    typeof batch.request === "string" &&
    sequence(batch.since) !== undefined &&
    sequence(batch.seq) !== undefined &&
    typeof batch.full === "boolean" &&
    Number.isSafeInteger(batch.issuedAt) &&
    Array.isArray(batch.bans) &&
    typeof signature === "object" &&
    signature !== null &&
    signature.alg === "Ed25519" &&
    typeof signature.keyId === "string" &&
    typeof signature.value === "string"
  );
}

/**
 * Verifies a ban batch against the deploy-time public keys: its shape, its
 * format, a known key, the signature, the service, and that it answers the
 * `since` asked and does not go back. Never throws for a bad batch.
 */
export function verifyBanBatch(
  value: unknown,
  keys: Readonly<Record<string, BundlePublicKey>>,
  options: VerifyBanBatchOptions,
): BanBatchVerdict {
  if (!isBatch(value)) return { ok: false, reason: "malformed" };
  if (value.format !== BAN_BATCH_FORMAT) return { ok: false, reason: "format" };
  const key = Object.hasOwn(keys, value.signature.keyId)
    ? keys[value.signature.keyId]
    : undefined;
  if (key === undefined) return { ok: false, reason: "unknown-key" };
  let holds: boolean;
  try {
    holds = verify(
      null,
      banBatchSigningBytes(value),
      publicKeyOf(key),
      Buffer.from(value.signature.value, "base64"),
    );
  } catch {
    holds = false;
  }
  if (!holds) return { ok: false, reason: "signature" };
  if (value.service !== options.service)
    return { ok: false, reason: "wrong-service" };
  const since = sequence(value.since)!;
  const seq = sequence(value.seq)!;
  if (
    value.request !== options.request ||
    since !== options.since ||
    seq < since
  ) {
    return { ok: false, reason: "replayed" };
  }
  return { ok: true, batch: value, seq };
}
