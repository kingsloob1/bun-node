/**
 * At-rest encryption (the encryption plan, PR-E1): the sealed envelope, the
 * built-in `"aes-256-gcm"`, key rings and `keys` functions, and user ciphers,
 * resolved once at `createCache` into the shape the core calls.
 *
 * The envelope (the plan's §4.3) wraps a whole core entry — header, full key
 * and payload, format 1 or 2 — with copies of the entry's tags and hard
 * expiry, which the core then trusts over the driver's clear copies:
 *
 * ```
 * offset  size  field                                    (built-in cipher)
 * 0       2     magic "BE"
 * 2       1     envelope version 1
 * 3       1     cipher id: 1 = "aes-256-gcm"; 128–255 a user cipher
 * 4       1     key id length L (1–32)
 * 5       L     key id, UTF-8
 * 5+L     16    salt
 * 21+L    12    nonce
 * 33+L    n     ciphertext of the sealed body
 * 33+L+n  16    GCM tag
 *
 * sealed body = u8 body version (1)
 *             | f64 LE expiresAt (-1 = none)
 *             | u16 LE tag count | per tag: u16 LE length, UTF-8
 *             | the core entry (lib/core/header.ts)
 * ```
 *
 * A user cipher's entry is bytes 0–3, then whatever its `seal` answered.
 *
 * Each built-in seal derives its own key (§4.2), so GCM's 2^32 random-nonce
 * limit per key never applies:
 *
 * ```
 * K      = HKDF-SHA-256(ikm = ring key, salt = "", info = "bun-cache/enc/1/aes-256-gcm")   once per key
 * K_salt = HMAC-SHA-256(K, "entry" ‖ salt ‖ 0x01)   (HKDF-Expand to 32 bytes)               per seal
 * sealed = AES-256-GCM(K_salt, nonce, body, AAD)
 * AAD    = "bun-cache/enc/1" 0 ‖ namespace 0 ‖ key 0 ‖ encrypt.aad 0 ‖ envelope bytes 0 .. end of nonce
 * ```
 *
 * The salt and nonce come from `crypto.getRandomValues`: 0.04 µs for 12
 * bytes, where `randomBytes(12)` took 2.8 µs on Bun (the plan's §3.1).
 */
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { isPromiseLike } from "./compression";
import { CacheDecryptError } from "./errors";
import type {
  CacheCipher,
  CacheCipherContext,
  CacheEncryptOptions,
  CacheKeyRing,
} from "./types";

/** The envelope's version byte. Bump on any incompatible change. */
export const ENVELOPE_VERSION = 1;

/** The cipher ids the package owns (1–127); a user cipher takes 128–255. */
export const CIPHER_IDS = {
  /** The built-in AES-256-GCM with a key per entry. */
  "aes-256-gcm": 1,
} as const;

/** The ids a user cipher may take. */
export const CUSTOM_CIPHER_RANGE = { min: 128, max: 255 } as const;

/**
 * The persisted labels (the plan's §14): changing one changes every stored
 * entry, so they are versioned in their text.
 */
export const ENCRYPTION_LABELS = {
  /** The AAD's first part. */
  aad: "bun-cache/enc/1",
  /** The HKDF `info` that derives a ring key's AES-256-GCM key. */
  hkdf: "bun-cache/enc/1/aes-256-gcm",
  /** The per-entry key's expand label. */
  entry: "entry",
} as const;

/** A ring key's length, in bytes. */
const KEY_BYTES = 32;
/** The per-entry salt's length, in bytes. */
const SALT_BYTES = 16;
/** The GCM nonce's length, in bytes. */
const NONCE_BYTES = 12;
/** The GCM tag's length, in bytes. */
const TAG_BYTES = 16;
/** The longest `encrypt.aad`, in bytes. */
const MAX_AAD_BYTES = 1024;
/** The sealed body's own version byte. */
const SEALED_BODY_VERSION = 1;
/** A key id: 1–32 of `A-Z a-z 0-9 . _ -` (ASCII, so characters are bytes). */
const KEY_ID = /^[\w.-]{1,32}$/;
/** An unknown key id refreshes a `keys` function at most once per this many ms. */
const UNKNOWN_KEY_REFRESH_MS = 10_000;
/** A `keys` function that failed is called again at most once per this many ms. */
const PROVIDER_RETRY_MS = 1_000;

/** The magic's two bytes, "BE". */
const MAGIC_0 = 0x42;
/** See {@link MAGIC_0}. */
const MAGIC_1 = 0x45;

/** The HKDF-Expand counter byte that ends the per-entry key's input. */
const EXPAND_COUNTER = new Uint8Array([1]);

/** One resolved ring key. */
interface RingKey {
  /** Its id. */
  id: string;
  /** Its id's UTF-8 bytes, as written into the envelope. */
  idBytes: Uint8Array;
  /** K: the AES-256-GCM key derived from it by HKDF (never the ring key itself). */
  derived: Buffer;
}

/** A resolved, validated ring. */
export interface ResolvedRing {
  /** The key that seals: the ring's first. */
  primary: RingKey;
  /** Every key, by id. */
  byId: ReadonlyMap<string, RingKey>;
}

/** An entry that opened. */
export interface OpenedEntry {
  /** The core entry's bytes (lib/core/header.ts). */
  entry: Uint8Array;
  /** The sealed hard expiry, epoch ms; `null` when never. */
  expiresAt: number | null;
  /** The sealed tags. */
  tags: readonly string[];
  /** The ring key's id, for the built-in cipher. */
  keyId: string | undefined;
}

/** What the core lends the encryption: its clock, its operation timeout and its `error` events. */
export interface EncryptionHooks {
  /** The cache's clock (`now`), epoch ms. */
  now: () => number;
  /** The cache's `timeout`: the longest an operation waits on a `keys` function. `undefined`: no bound. */
  timeout: number | undefined;
  /** Reports a `keys` function that rejected or answered an invalid ring, as the phase of the operation that called it. */
  onProviderError: (error: Error, phase: "encrypt" | "decrypt") => void;
}

/** The text encoder every name goes through. */
const encoder = new TextEncoder();

/** The decoder of key ids (ASCII, checked after) and tags (refusing invalid UTF-8). */
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/** The AAD's label, encoded once. */
const AAD_LABEL = encoder.encode(ENCRYPTION_LABELS.aad);

/**
 * Parses a ring key into its 32 bytes, or throws a `TypeError` that never
 * shows the value: a `Uint8Array` of 32 bytes, or 32 bytes as hex (64
 * characters), base64 or base64url (43 characters, or 44 with one `=`).
 */
function parseKey(key: unknown, where: string): Uint8Array {
  if (key instanceof Uint8Array) {
    if (key.byteLength === KEY_BYTES) {
      return key.slice();
    }
  } else if (typeof key === "string") {
    let bytes: Buffer | undefined;
    if (/^[\da-f]{64}$/i.test(key)) {
      bytes = Buffer.from(key, "hex");
    } else if (/^[\w+/-]{43}=?$/.test(key)) {
      // Buffer's base64 decoder reads base64url too; one alphabet only.
      if (!(/[+/]/.test(key) && /[-_]/.test(key))) {
        bytes = Buffer.from(key, "base64");
      }
    }
    if (bytes?.byteLength === KEY_BYTES) {
      return new Uint8Array(bytes);
    }
  }
  throw new TypeError(
    `${where} must be exactly 32 bytes: a Uint8Array, or a string of 32 bytes as hex, base64 or base64url (generate one with \`openssl rand -base64 32\`); passphrases are not accepted`,
  );
}

/**
 * Validates a key ring and derives each key's K, or throws a `TypeError`
 * naming what is wrong: not an array, empty, a malformed or duplicate id, a
 * key that is not 32 bytes.
 */
export function resolveRing(ring: unknown, where: string): ResolvedRing {
  if (!Array.isArray(ring)) {
    throw new TypeError(`${where} must be an array of { id, key }`);
  }
  const keys = ring as unknown[];
  if (keys.length === 0) {
    throw new TypeError(`${where} must hold at least one key`);
  }
  const byId = new Map<string, RingKey>();
  let primary: RingKey | undefined;
  for (const [index, item] of keys.entries()) {
    const at = `${where}[${index}]`;
    if (typeof item !== "object" || item === null) {
      throw new TypeError(`${at} must be an object { id, key }`);
    }
    const { id, key } = item as { id?: unknown; key?: unknown };
    if (typeof id !== "string" || !KEY_ID.test(id)) {
      throw new TypeError(
        `${at}.id must be 1–32 characters of letters, digits, ".", "_" and "-" (got ${JSON.stringify(id)})`,
      );
    }
    if (byId.has(id)) {
      throw new TypeError(`${at}.id "${id}" is already in the ring`);
    }
    const raw = parseKey(key, `${at}.key`);
    const derived = Buffer.from(
      hkdfSync("sha256", raw, new Uint8Array(0), ENCRYPTION_LABELS.hkdf, 32),
    );
    raw.fill(0);
    const resolved: RingKey = { id, idBytes: encoder.encode(id), derived };
    byId.set(id, resolved);
    primary ??= resolved;
  }
  return { primary: primary!, byId };
}

/** Throws a `TypeError` unless `cipher` is a well-formed user cipher. */
function checkCipher(cipher: unknown, where: string): CacheCipher {
  const candidate = cipher as Partial<CacheCipher> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.seal !== "function" ||
    typeof candidate.open !== "function"
  ) {
    throw new TypeError(
      `${where} must be "aes-256-gcm" or a user cipher { id, seal, open }`,
    );
  }
  const id = candidate.id;
  if (
    typeof id !== "number" ||
    !Number.isInteger(id) ||
    id < CUSTOM_CIPHER_RANGE.min ||
    id > CUSTOM_CIPHER_RANGE.max
  ) {
    throw new TypeError(
      `${where}: a user cipher's id must be an integer in ${CUSTOM_CIPHER_RANGE.min}–${CUSTOM_CIPHER_RANGE.max} (1–127 are reserved), not ${String(id)}`,
    );
  }
  return candidate as CacheCipher;
}

/**
 * The AAD of one entry (the plan's §4.5): the label, the plaintext full
 * namespace and key, `encrypt.aad`, each followed by a 0 byte, then the
 * envelope's prefix (through the nonce for the built-in; bytes 0–3 for a
 * user cipher).
 */
function buildAad(
  namespace: string,
  key: string,
  extra: Uint8Array,
  prefix: Uint8Array,
): Uint8Array {
  const label = AAD_LABEL;
  const ns = encoder.encode(namespace);
  const k = encoder.encode(key);
  const out = new Uint8Array(
    label.length + ns.length + k.length + extra.length + 4 + prefix.length,
  );
  let at = 0;
  for (const part of [label, ns, k, extra]) {
    out.set(part, at);
    at += part.length + 1; // the 0 byte after each part is already there
  }
  out.set(prefix, at);
  return out;
}

/** A user cipher's envelope prefix: the magic, the version and its id. */
function userCipherPrefix(cipherId: number): Uint8Array {
  return new Uint8Array([MAGIC_0, MAGIC_1, ENVELOPE_VERSION, cipherId]);
}

/**
 * The context the core hands a user cipher for one entry: its plaintext
 * names and the AAD built from them, `aad` (`encrypt.aad`'s bytes) and the
 * envelope's four-byte prefix. `runCacheCipherConformance` builds its
 * contexts here, so the cipher is checked against what the core sends.
 */
export function cipherContext(
  namespace: string,
  key: string,
  aad: Uint8Array,
  cipherId: number,
): CacheCipherContext {
  return {
    namespace,
    key,
    aad: buildAad(namespace, key, aad, userCipherPrefix(cipherId)),
  };
}

/** Encodes the sealed body: its version, the hard expiry, the tags, then the core entry. */
export function encodeSealedBody(
  entry: Uint8Array,
  expiresAt: number | null,
  tags: readonly string[],
): Uint8Array {
  if (tags.length > 0xffff) {
    throw new RangeError(
      `an encrypted entry holds at most 65,535 tags, not ${tags.length}`,
    );
  }
  const encoded = tags.map((tag) => {
    const bytes = encoder.encode(tag);
    if (bytes.length > 0xffff) {
      throw new RangeError(
        "an encrypted entry's tag is at most 65,535 bytes of UTF-8",
      );
    }
    return bytes;
  });
  let length = 1 + 8 + 2 + entry.length;
  for (const bytes of encoded) {
    length += 2 + bytes.length;
  }
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  out[0] = SEALED_BODY_VERSION;
  view.setFloat64(1, expiresAt ?? -1, true);
  view.setUint16(9, encoded.length, true);
  let at = 11;
  for (const bytes of encoded) {
    view.setUint16(at, bytes.length, true);
    out.set(bytes, at + 2);
    at += 2 + bytes.length;
  }
  out.set(entry, at);
  return out;
}

/** Decodes a sealed body; throws a `CacheDecryptError` (`"malformed"`) when it does not parse. */
function decodeSealedBody(
  body: Uint8Array,
  keyId: string | undefined,
): OpenedEntry {
  const malformed = (): CacheDecryptError =>
    new CacheDecryptError({ reason: "malformed", keyId });
  if (body.length < 11 || body[0] !== SEALED_BODY_VERSION) {
    throw malformed();
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const sealedExpiry = view.getFloat64(1, true);
  if (!(
    sealedExpiry === -1 ||
    (Number.isFinite(sealedExpiry) && sealedExpiry >= 0)
  )) {
    throw malformed();
  }
  const count = view.getUint16(9, true);
  const tags: string[] = [];
  let at = 11;
  for (let index = 0; index < count; index++) {
    if (at + 2 > body.length) {
      throw malformed();
    }
    const length = view.getUint16(at, true);
    if (at + 2 + length > body.length) {
      throw malformed();
    }
    try {
      tags.push(strictDecoder.decode(body.subarray(at + 2, at + 2 + length)));
    } catch {
      throw malformed();
    }
    at += 2 + length;
  }
  return {
    entry: body.subarray(at),
    expiresAt: sealedExpiry === -1 ? null : sealedExpiry,
    tags,
    keyId,
  };
}

/** The per-entry key: HKDF-Expand(K, "entry" ‖ salt, 32) = HMAC-SHA-256(K, "entry" ‖ salt ‖ 0x01). */
function entryKey(derived: Buffer, salt: Uint8Array): Buffer {
  return new Bun.CryptoHasher("sha256", derived)
    .update(ENCRYPTION_LABELS.entry)
    .update(salt)
    .update(EXPAND_COUNTER)
    .digest();
}

/** Seals `body` under the ring key `key` with the built-in cipher, into a whole envelope. */
function sealBuiltIn(
  ringKey: RingKey,
  body: Uint8Array,
  namespace: string,
  key: string,
  extra: Uint8Array,
): Uint8Array {
  const idLength = ringKey.idBytes.length;
  const saltAt = 5 + idLength;
  const nonceAt = saltAt + SALT_BYTES;
  const bodyAt = nonceAt + NONCE_BYTES;
  const out = new Uint8Array(bodyAt + body.length + TAG_BYTES);
  out[0] = MAGIC_0;
  out[1] = MAGIC_1;
  out[2] = ENVELOPE_VERSION;
  out[3] = CIPHER_IDS["aes-256-gcm"];
  out[4] = idLength;
  out.set(ringKey.idBytes, 5);
  // The salt and the nonce, in one draw.
  crypto.getRandomValues(out.subarray(saltAt, bodyAt));
  const cipher = createCipheriv(
    "aes-256-gcm",
    entryKey(ringKey.derived, out.subarray(saltAt, nonceAt)),
    out.subarray(nonceAt, bodyAt),
  );
  cipher.setAAD(buildAad(namespace, key, extra, out.subarray(0, bodyAt)));
  const head = cipher.update(body);
  out.set(head, bodyAt);
  // GCM is a stream mode: `final` adds nothing, but must run for the tag.
  out.set(cipher.final(), bodyAt + head.length);
  out.set(cipher.getAuthTag(), bodyAt + body.length);
  return out;
}

/** A built-in envelope's parts, parsed but not opened. */
interface BuiltInEnvelope {
  /** The key id. */
  keyId: string;
  /** Where the ciphertext starts (the prefix ends). */
  bodyAt: number;
}

/** Parses a built-in envelope's prefix; throws `"malformed"` when it does not parse. */
function parseBuiltIn(bytes: Uint8Array): BuiltInEnvelope {
  const idLength = bytes.length > 4 ? bytes[4] : 0;
  const bodyAt = 5 + idLength + SALT_BYTES + NONCE_BYTES;
  if (idLength < 1 || idLength > 32 || bytes.length < bodyAt + TAG_BYTES) {
    throw new CacheDecryptError({ reason: "malformed" });
  }
  let keyId: string;
  try {
    keyId = strictDecoder.decode(bytes.subarray(5, 5 + idLength));
  } catch {
    throw new CacheDecryptError({ reason: "malformed" });
  }
  if (!KEY_ID.test(keyId)) {
    throw new CacheDecryptError({ reason: "malformed" });
  }
  return { keyId, bodyAt };
}

/** Opens a parsed built-in envelope with its ring key; throws `"auth"` when the tag fails. */
function openBuiltIn(
  ringKey: RingKey,
  bytes: Uint8Array,
  envelope: BuiltInEnvelope,
  namespace: string,
  key: string,
  extra: Uint8Array,
): Uint8Array {
  const { bodyAt, keyId } = envelope;
  const saltAt = bodyAt - NONCE_BYTES - SALT_BYTES;
  const nonceAt = bodyAt - NONCE_BYTES;
  const tagAt = bytes.length - TAG_BYTES;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      entryKey(ringKey.derived, bytes.subarray(saltAt, nonceAt)),
      bytes.subarray(nonceAt, bodyAt),
    );
    decipher.setAAD(buildAad(namespace, key, extra, bytes.subarray(0, bodyAt)));
    decipher.setAuthTag(bytes.subarray(tagAt));
    const head = decipher.update(bytes.subarray(bodyAt, tagAt));
    const tail = decipher.final();
    if (tail.length === 0) {
      return head;
    }
    return Buffer.concat([head, tail]);
  } catch {
    throw new CacheDecryptError({ reason: "auth", keyId });
  }
}

/** Whether `bytes` starts with the envelope's magic. */
export function isEnvelope(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === MAGIC_0 && bytes[1] === MAGIC_1;
}

/**
 * The key id a built-in envelope names — unauthenticated, so for an envelope
 * this process just sealed, or for a report that names it as such;
 * `undefined` for any other bytes, or an id that is not a well-formed one
 * (so a planted envelope cannot put arbitrary text into a log line).
 */
export function envelopeKeyId(bytes: Uint8Array): string | undefined {
  if (
    !isEnvelope(bytes) ||
    bytes.length < 5 ||
    bytes[3] !== CIPHER_IDS["aes-256-gcm"] ||
    bytes[4] < 1 ||
    bytes[4] > 32 ||
    bytes.length < 5 + bytes[4]
  ) {
    return undefined;
  }
  let keyId: string;
  try {
    keyId = strictDecoder.decode(bytes.subarray(5, 5 + bytes[4]));
  } catch {
    return undefined;
  }
  return KEY_ID.test(keyId) ? keyId : undefined;
}

/**
 * One cache's encryption: validates `encrypt` at `createCache` (a
 * `TypeError` naming the option), then seals and opens entries. Synchronous
 * for a static ring and the built-in cipher; a `keys` function not yet
 * answered, or an async user cipher, answers a promise.
 */
export class EntryEncryption {
  /** Whether an entry that is not an envelope is read as a plain one (`acceptUnencrypted`). */
  readonly acceptUnencrypted: boolean;
  /** `encrypt.aad`'s bytes; empty when unset. */
  readonly #aad: Uint8Array;
  /** The user cipher that seals, when `cipher` is one; `undefined`: the built-in seals. */
  readonly #writer: CacheCipher | undefined;
  /** The user ciphers that open, by id: `cipher`'s and `previous`'s. */
  readonly #userCiphers: ReadonlyMap<number, CacheCipher>;
  /** The `keys` function, when `keys` is one. */
  readonly #provider: (() => CacheKeyRing | Promise<CacheKeyRing>) | undefined;
  /** `keyRefresh`, in ms. */
  readonly #keyRefresh: number | undefined;
  /** The core's hooks. */
  readonly #hooks: EncryptionHooks;
  /** The current ring; `undefined` before a `keys` function first answers, and always with a user cipher. */
  #ring: ResolvedRing | undefined;
  /** The `keys` call in flight. */
  #pending: Promise<ResolvedRing | undefined> | undefined;
  /** When the ring was last installed. */
  #fetchedAt = Number.NEGATIVE_INFINITY;
  /** When a `keys` call last failed. */
  #failedAt = Number.NEGATIVE_INFINITY;
  /** When an unknown key id last refreshed the ring. */
  #unknownRefreshAt = Number.NEGATIVE_INFINITY;

  constructor(option: CacheEncryptOptions, hooks: EncryptionHooks) {
    if (typeof option !== "object" || option === null) {
      throw new TypeError("encrypt must be an options object");
    }
    this.#hooks = hooks;
    this.acceptUnencrypted = option.acceptUnencrypted === true;
    const userCiphers = new Map<number, CacheCipher>();
    const cipher = option.cipher ?? "aes-256-gcm";
    if (cipher === "aes-256-gcm") {
      this.#writer = undefined;
      const keys = option.keys;
      if (typeof keys === "function") {
        this.#provider = keys;
      } else if (keys === undefined) {
        throw new TypeError(
          "encrypt.keys is required by the built-in cipher (or give a user cipher as encrypt.cipher)",
        );
      } else {
        this.#ring = resolveRing(keys, "encrypt.keys");
      }
      if (option.keyRefresh !== undefined) {
        if (this.#provider === undefined) {
          throw new TypeError(
            "encrypt.keyRefresh applies to a keys function, not to a static ring",
          );
        }
        if (!(Number.isFinite(option.keyRefresh) && option.keyRefresh > 0)) {
          throw new TypeError(
            `encrypt.keyRefresh must be a positive number of ms, not ${String(option.keyRefresh)}`,
          );
        }
      }
      this.#keyRefresh = option.keyRefresh;
    } else {
      if (typeof cipher === "string") {
        throw new TypeError(
          `encrypt.cipher must be "aes-256-gcm" or a user cipher, not ${JSON.stringify(cipher)}`,
        );
      }
      const writer = checkCipher(cipher, "encrypt.cipher");
      if (option.keys !== undefined || option.keyRefresh !== undefined) {
        throw new TypeError(
          "encrypt.keys and encrypt.keyRefresh are the built-in cipher's: a user cipher (encrypt.cipher) manages its own keys",
        );
      }
      this.#writer = writer;
      this.#provider = undefined;
      this.#keyRefresh = undefined;
      userCiphers.set(writer.id, writer);
    }
    for (const [index, previous] of (option.previous ?? []).entries()) {
      const where = `encrypt.previous[${index}]`;
      const checked = checkCipher(previous, where);
      if (userCiphers.has(checked.id)) {
        throw new TypeError(
          `${where}: cipher id ${checked.id} is already taken by another cipher`,
        );
      }
      userCiphers.set(checked.id, checked);
    }
    this.#userCiphers = userCiphers;
    const aad = option.aad ?? new Uint8Array(0);
    if (typeof aad !== "string" && !(aad instanceof Uint8Array)) {
      throw new TypeError("encrypt.aad must be a string or a Uint8Array");
    }
    const aadBytes =
      typeof aad === "string" ? encoder.encode(aad) : aad.slice();
    if (aadBytes.length > MAX_AAD_BYTES) {
      throw new TypeError(
        `encrypt.aad is at most ${MAX_AAD_BYTES} bytes, not ${aadBytes.length}`,
      );
    }
    this.#aad = aadBytes;
  }

  /**
   * Seals a core entry, with its hard expiry and tags, into the bytes the
   * driver stores. Throws (or rejects) when it cannot: no ring yet, a user
   * cipher that threw or answered something other than a `Uint8Array`, a
   * tag too long to seal. Nothing is ever stored unsealed.
   */
  seal(
    namespace: string,
    key: string,
    entry: Uint8Array,
    expiresAt: number | null,
    tags: readonly string[],
  ): Uint8Array | Promise<Uint8Array> {
    const body = encodeSealedBody(entry, expiresAt, tags);
    const writer = this.#writer;
    if (writer !== undefined) {
      const prefix = userCipherPrefix(writer.id);
      const sealed = writer.seal(
        body,
        cipherContext(namespace, key, this.#aad, writer.id),
      );
      const finish = (output: Uint8Array): Uint8Array => {
        if (!(output instanceof Uint8Array)) {
          throw new TypeError("a user cipher's seal must answer a Uint8Array");
        }
        const out = new Uint8Array(prefix.length + output.length);
        out.set(prefix);
        out.set(output, prefix.length);
        return out;
      };
      return isPromiseLike(sealed)
        ? Promise.resolve(sealed).then(finish)
        : finish(sealed);
    }
    const sealWith = (ring: ResolvedRing | undefined): Uint8Array => {
      if (ring === undefined) {
        throw new Error(
          "no encryption key: the encrypt.keys function has not answered a ring",
        );
      }
      return sealBuiltIn(ring.primary, body, namespace, key, this.#aad);
    };
    const ring = this.#ringFor("encrypt");
    return isPromiseLike(ring)
      ? Promise.resolve(ring).then(sealWith)
      : sealWith(ring);
  }

  /**
   * Opens stored bytes. Answers the opened entry; `undefined` for a plain
   * (unsealed) entry when `acceptUnencrypted` is on — the caller reads it as
   * it is. Throws (or rejects) a {@link CacheDecryptError} otherwise.
   */
  open(
    namespace: string,
    key: string,
    bytes: Uint8Array,
  ): OpenedEntry | undefined | Promise<OpenedEntry> {
    if (!isEnvelope(bytes)) {
      if (this.acceptUnencrypted) {
        return undefined;
      }
      throw new CacheDecryptError({ reason: "unencrypted" });
    }
    if (bytes.length < 4 || bytes[2] !== ENVELOPE_VERSION) {
      throw new CacheDecryptError({ reason: "malformed" });
    }
    const cipherId = bytes[3];
    if (cipherId === CIPHER_IDS["aes-256-gcm"]) {
      if (this.#writer !== undefined) {
        // A user cipher's cache has no ring to open the built-in's entries.
        throw new CacheDecryptError({ reason: "cipher" });
      }
      const envelope = parseBuiltIn(bytes);
      const openWith = (ringKey: RingKey | undefined): OpenedEntry => {
        if (ringKey === undefined) {
          throw new CacheDecryptError({
            reason: "unknown-key",
            keyId: envelope.keyId,
          });
        }
        const body = openBuiltIn(
          ringKey,
          bytes,
          envelope,
          namespace,
          key,
          this.#aad,
        );
        return decodeSealedBody(body, envelope.keyId);
      };
      const ring = this.#ringFor("decrypt");
      const lookup = (current: ResolvedRing | undefined) =>
        this.#lookup(current, envelope.keyId);
      if (isPromiseLike(ring)) {
        return Promise.resolve(ring).then(lookup).then(openWith);
      }
      const ringKey = lookup(ring);
      return isPromiseLike(ringKey)
        ? Promise.resolve(ringKey).then(openWith)
        : openWith(ringKey);
    }
    const cipher = this.#userCiphers.get(cipherId);
    if (cipher === undefined) {
      throw new CacheDecryptError({ reason: "cipher" });
    }
    const failed = (cause: unknown): CacheDecryptError =>
      cause instanceof CacheDecryptError
        ? cause
        : new CacheDecryptError({ reason: "cipher", cause });
    const finish = (output: unknown): OpenedEntry => {
      if (!(output instanceof Uint8Array)) {
        throw new CacheDecryptError({
          reason: "cipher",
          cause: new TypeError("a user cipher's open must answer a Uint8Array"),
        });
      }
      return decodeSealedBody(output, undefined);
    };
    let opened: Uint8Array | Promise<Uint8Array>;
    try {
      // A copy: the cipher may keep or change what it is given.
      opened = cipher.open(
        bytes.slice(4),
        cipherContext(namespace, key, this.#aad, cipherId),
      );
    } catch (cause) {
      throw failed(cause);
    }
    return isPromiseLike(opened)
      ? Promise.resolve(opened).then(finish, (cause: unknown) => {
          throw failed(cause);
        })
      : finish(opened);
  }

  /**
   * The ring for an operation: the static one; or the `keys` function's —
   * called on first use (and waited for, at most the cache's `timeout`), and
   * again in the background every `keyRefresh` ms. A failed call is retried
   * by a later operation, at most once per second.
   */
  #ringFor(
    phase: "encrypt" | "decrypt",
  ): ResolvedRing | undefined | Promise<ResolvedRing | undefined> {
    if (this.#provider === undefined) {
      return this.#ring;
    }
    const now = this.#hooks.now();
    const retryable = now - this.#failedAt >= PROVIDER_RETRY_MS;
    if (this.#ring !== undefined) {
      if (
        this.#keyRefresh !== undefined &&
        this.#pending === undefined &&
        retryable &&
        now - this.#fetchedAt >= this.#keyRefresh
      ) {
        void this.#fetch(phase);
      }
      return this.#ring;
    }
    if (this.#pending === undefined) {
      if (!retryable) {
        return undefined;
      }
      return this.#wait(this.#fetch(phase));
    }
    return this.#wait(this.#pending);
  }

  /**
   * The ring key of `keyId`. When the ring has none and keys come from a
   * function, the function is called again — at most once per 10 s — so a
   * process learns a peer's new key without a restart.
   */
  #lookup(
    ring: ResolvedRing | undefined,
    keyId: string,
  ): RingKey | undefined | Promise<RingKey | undefined> {
    const found = ring?.byId.get(keyId);
    if (found !== undefined || this.#provider === undefined) {
      return found;
    }
    const now = this.#hooks.now();
    if (now - this.#unknownRefreshAt < UNKNOWN_KEY_REFRESH_MS) {
      return undefined;
    }
    this.#unknownRefreshAt = now;
    return this.#wait(this.#pending ?? this.#fetch("decrypt")).then(
      (refreshed) => refreshed?.byId.get(keyId),
    );
  }

  /** Calls the `keys` function once; installs a valid answer, keeps the old ring otherwise (reporting why). */
  #fetch(phase: "encrypt" | "decrypt"): Promise<ResolvedRing | undefined> {
    const provider = this.#provider!;
    const pending: Promise<ResolvedRing | undefined> = Promise.resolve()
      .then(provider)
      .then((answer) => {
        // Validated whole before it replaces anything: never half-applied.
        const ring = resolveRing(answer, "encrypt.keys()");
        this.#ring = ring;
        this.#fetchedAt = this.#hooks.now();
        return ring;
      })
      .catch((cause: unknown) => {
        this.#failedAt = this.#hooks.now();
        this.#hooks.onProviderError(
          new Error(
            this.#ring === undefined
              ? "the encrypt.keys function failed, and there is no ring yet"
              : "the encrypt.keys function failed; the previous ring stays",
            { cause },
          ),
          phase,
        );
        return this.#ring;
      })
      .finally(() => {
        if (this.#pending === pending) {
          this.#pending = undefined;
        }
      });
    this.#pending = pending;
    return pending;
  }

  /** Waits for a `keys` call, at most the cache's `timeout`; `undefined` when it ran out (the call goes on). */
  async #wait(
    pending: Promise<ResolvedRing | undefined>,
  ): Promise<ResolvedRing | undefined> {
    const timeout = this.#hooks.timeout;
    if (timeout === undefined || !(timeout > 0)) {
      return await pending;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            resolve(undefined);
          }, timeout);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
