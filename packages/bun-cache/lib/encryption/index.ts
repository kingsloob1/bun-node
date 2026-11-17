/**
 * Field sealing: bun-cache's envelope (the encryption plan's §4.3) for one
 * value at a time, outside a cache. A value is sealed with AES-256-GCM under
 * a key derived per seal from a ring key, the same ring format as
 * `createCache`'s `encrypt.keys`, and bound to a `purpose` and to the parts a
 * caller names (a table, a row id, a field name), so a sealed value copied
 * anywhere else does not open. bun-security seals its store's secrets with it
 * (its storage.md §8).
 *
 * The bytes are the cache's envelope (magic `"BE"`, version 1, cipher 1, the
 * key id, a 16-byte salt, a 12-byte nonce, the ciphertext, a 16-byte tag)
 * under different labels:
 *
 * ```
 * K      = HKDF-SHA-256(ikm = ring key, salt = "", info = "bun-cache/field/1/aes-256-gcm/" ‖ purpose)
 * K_salt = HMAC-SHA-256(K, "field" ‖ salt ‖ 0x01)
 * sealed = AES-256-GCM(K_salt, nonce, value, AAD)
 * AAD    = for each of "bun-cache/field/1", purpose, then each bind part:
 *            u32 LE length ‖ UTF-8   (the bind count, u32 LE, after purpose)
 *          ‖ envelope bytes 0 .. end of nonce
 * ```
 *
 * A key shared by mistake between a cache and a field, or between two
 * purposes, derives a different K for each, so neither opens the other's
 * bytes. The ring's first key seals; every key opens what it sealed, so a
 * rotation adds a key in front and keeps the old ones until nothing sealed
 * under them is left.
 *
 * Synchronous throughout, and server-only (`node:crypto`).
 */
import { CacheDecryptError } from "../core/errors";
import type { RingKey, ResolvedRing } from "../core/encrypt";
import type { CacheKeyRing } from "../core/types";
import {
  CIPHER_IDS,
  ENVELOPE_VERSION,
  envelopeKeyId,
  isEnvelope,
  openBuiltIn,
  parseBuiltIn,
  parseKey,
  resolveRing,
  sealBuiltIn,
} from "../core/encrypt";

export { CacheDecryptError } from "../core/errors";
export type { CacheKey, CacheKeyRing } from "../core/types";

/**
 * The persisted labels of a sealed field: changing one changes every sealed
 * value, so they are versioned in their text, and differ from the cache's
 * (`bun-cache/enc/1`).
 */
export const FIELD_LABELS = {
  /** The AAD's first part. */
  aad: "bun-cache/field/1",
  /** The HKDF `info` a ring key's K is derived under, followed by `/` and the purpose. */
  hkdf: "bun-cache/field/1/aes-256-gcm",
  /** The per-seal key's expand label. */
  field: "field",
} as const;

/** A purpose: 1–128 printable ASCII characters, no space. */
const PURPOSE = /^[\x21-\x7E]{1,128}$/;

/** The text encoder every string goes through. */
const encoder = new TextEncoder();

/** What a sealed value is bound to. */
export interface FieldContext {
  /**
   * Who seals, for domain separation: 1–128 printable ASCII characters
   * (`"bun-security/store"`). It is folded into the key derivation, so two
   * purposes never share a key, even under the same ring.
   */
  readonly purpose: string;
  /**
   * Where the value lives (a table, a row id, a field name, …): every part
   * is authenticated, in order, so the value opens only under the same
   * parts. Default: none.
   */
  readonly bind?: readonly string[];
}

/**
 * A ring validated once, for many seals and opens: {@link fieldKeyRing}'s
 * answer. Its key bytes stay inside it; only the ids show.
 */
export interface FieldKeyRing {
  /** The id of the key that seals: the ring's first. */
  readonly primaryKeyId: string;
  /** Every key's id, in ring order. */
  readonly keyIds: readonly string[];
}

/** A {@link FieldKeyRing}: the validated keys, and each purpose's derived ring once used. */
class FieldKeys implements FieldKeyRing {
  readonly primaryKeyId: string;
  readonly keyIds: readonly string[];
  /** The ring keys, parsed to bytes (copies of the caller's). */
  readonly #keys: readonly { readonly id: string; readonly key: Uint8Array }[];
  /** Each purpose's ring, derived on first use. */
  readonly #byPurpose = new Map<string, ResolvedRing>();

  constructor(keys: CacheKeyRing, where: string) {
    // Validates the whole ring once, with the cache's own messages.
    resolveRing(keys, where, FIELD_LABELS.hkdf);
    this.#keys = keys.map((item, index) => ({
      id: item.id,
      key: parseKey(item.key, `${where}[${index}].key`),
    }));
    this.keyIds = Object.freeze(this.#keys.map((item) => item.id));
    this.primaryKeyId = this.keyIds[0]!;
  }

  /** The ring derived for `purpose`. */
  ringFor(purpose: string): ResolvedRing {
    let ring = this.#byPurpose.get(purpose);
    if (ring === undefined) {
      ring = resolveRing(this.#keys, "fieldKeyRing", hkdfInfo(purpose));
      this.#byPurpose.set(purpose, ring);
    }
    return ring;
  }
}

/**
 * Validates a key ring once, for many seals and opens: the same format as
 * `createCache`'s `encrypt.keys` (`[{ id, key }]`, the first seals, 32-byte
 * keys as bytes, hex, base64 or base64url). Throws a `TypeError` naming
 * what is wrong, never showing a key.
 */
export function fieldKeyRing(keys: CacheKeyRing): FieldKeyRing {
  return new FieldKeys(keys, "fieldKeyRing(keys)");
}

/** The HKDF `info` of a purpose. */
function hkdfInfo(purpose: string): string {
  return `${FIELD_LABELS.hkdf}/${purpose}`;
}

/** Throws a `TypeError` unless `context` is a well-formed {@link FieldContext}. */
function checkContext(context: FieldContext, where: string): readonly string[] {
  if (typeof context !== "object" || context === null) {
    throw new TypeError(`${where}: context must be { purpose, bind? }`);
  }
  if (typeof context.purpose !== "string" || !PURPOSE.test(context.purpose)) {
    throw new TypeError(
      `${where}: context.purpose must be 1–128 printable ASCII characters with no space`,
    );
  }
  const bind = context.bind ?? [];
  if (
    !Array.isArray(bind) ||
    !bind.every((part): part is string => typeof part === "string")
  ) {
    throw new TypeError(`${where}: context.bind must be a list of strings`);
  }
  return bind;
}

/** The ring for `purpose`: a {@link FieldKeyRing}'s, or a plain ring validated and derived now. */
function ringOf(
  ring: CacheKeyRing | FieldKeyRing,
  purpose: string,
  where: string,
): ResolvedRing {
  return ring instanceof FieldKeys
    ? ring.ringFor(purpose)
    : resolveRing(ring, `${where}: ring`, hkdfInfo(purpose));
}

/** The AAD: each part length-prefixed (the bind count after the purpose), then the envelope's prefix. */
function fieldAad(
  purpose: string,
  bind: readonly string[],
  prefix: Uint8Array,
): Uint8Array {
  const parts = [FIELD_LABELS.aad, purpose, ...bind].map((part) =>
    encoder.encode(part),
  );
  let length = 4 + prefix.length;
  for (const part of parts) length += 4 + part.length;
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [index, part] of parts.entries()) {
    view.setUint32(at, part.length, true);
    out.set(part, at + 4);
    at += 4 + part.length;
    if (index === 1) {
      view.setUint32(at, bind.length, true);
      at += 4;
    }
  }
  out.set(prefix, at);
  return out;
}

/**
 * Seals one value (bytes, or a string as UTF-8) under the ring's first key,
 * bound to `context`: the envelope's bytes. Throws a `TypeError` for a
 * malformed ring, context or value.
 */
export function sealField(
  value: Uint8Array | string,
  ring: CacheKeyRing | FieldKeyRing,
  context: FieldContext,
): Uint8Array {
  const bind = checkContext(context, "sealField");
  const body = typeof value === "string" ? encoder.encode(value) : value;
  if (!(body instanceof Uint8Array)) {
    throw new TypeError("sealField: value must be a Uint8Array or a string");
  }
  const { primary } = ringOf(ring, context.purpose, "sealField");
  return sealBuiltIn(
    primary,
    body,
    (prefix) => fieldAad(context.purpose, bind, prefix),
    FIELD_LABELS.field,
  );
}

/**
 * Opens a sealed value with the ring key its envelope names, under the same
 * `context` it was sealed with: the value's bytes. Throws a
 * {@link CacheDecryptError}: `"auth"` (a changed byte, a wrong key under a
 * known id, another context), `"unknown-key"` (no ring key has its id),
 * `"unencrypted"` (not an envelope), `"malformed"` or `"cipher"` (not the
 * built-in cipher); a `TypeError` for a malformed ring or context.
 */
export function openField(
  sealed: Uint8Array,
  ring: CacheKeyRing | FieldKeyRing,
  context: FieldContext,
): Uint8Array {
  const bind = checkContext(context, "openField");
  if (!(sealed instanceof Uint8Array)) {
    throw new TypeError("openField: sealed must be a Uint8Array");
  }
  const resolved = ringOf(ring, context.purpose, "openField");
  const subject = "sealed field";
  if (!isEnvelope(sealed)) {
    throw new CacheDecryptError({ reason: "unencrypted", subject });
  }
  if (sealed.length < 4 || sealed[2] !== ENVELOPE_VERSION) {
    throw new CacheDecryptError({ reason: "malformed", subject });
  }
  if (sealed[3] !== CIPHER_IDS["aes-256-gcm"]) {
    throw new CacheDecryptError({ reason: "cipher", subject });
  }
  let envelope: ReturnType<typeof parseBuiltIn>;
  try {
    envelope = parseBuiltIn(sealed);
  } catch {
    throw new CacheDecryptError({ reason: "malformed", subject });
  }
  const ringKey: RingKey | undefined = resolved.byId.get(envelope.keyId);
  if (ringKey === undefined) {
    throw new CacheDecryptError({
      reason: "unknown-key",
      keyId: envelope.keyId,
      subject,
    });
  }
  try {
    return openBuiltIn(
      ringKey,
      sealed,
      envelope,
      (prefix) => fieldAad(context.purpose, bind, prefix),
      FIELD_LABELS.field,
    );
  } catch {
    throw new CacheDecryptError({
      reason: "auth",
      keyId: envelope.keyId,
      subject,
    });
  }
}

/**
 * The key id a sealed value's envelope names, unauthenticated (for choosing
 * what to re-seal after a rotation, never for trusting it); `undefined` for
 * bytes that are not a well-formed envelope.
 */
export function fieldKeyId(sealed: Uint8Array): string | undefined {
  return envelopeKeyId(sealed);
}
