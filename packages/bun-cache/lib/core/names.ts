/**
 * Name hashing (the encryption plan's §7, PR-E2): `encrypt.hashNames` stores
 * keys, namespaces and tags as keyed hashes, so a dump of the store shows
 * none of them. It runs **in the core**, so the drivers, L1, the flight map,
 * the stamp cache and the bus all see one consistent set of hashed names.
 *
 * The built-in hash is HMAC-SHA-256 under a key of its own — never one of
 * the encryption keys, and never rotated: a changed names key orphans every
 * stored name, as a `version` bump does. Each name is bound to its kind and,
 * for keys and tags, to its namespace, so the same key in two namespaces
 * hashes apart and a dump does not show which tenants hold the same key:
 *
 * ```
 * K_names     = HKDF-SHA-256(ikm = hashNames.key, salt = "", info = "bun-cache/names/1")
 * stored ns   = hex128(HMAC-SHA-256(K_names, "ns"  0x00 full namespace))
 * stored key  = hex128(HMAC-SHA-256(K_names, "key" 0x00 full namespace 0x00 full key))
 * stored tag  = hex128(HMAC-SHA-256(K_names, "tag" 0x00 full namespace 0x00 tag))
 * ```
 *
 * `hex128` is the lower-case hex of the first 16 bytes: 32 characters, which
 * every driver's naming rules accept as they are. Two keys colliding only
 * overwrite each other's entries — a miss, never a wrong value, since the
 * sealed header keeps the full key and the core checks it on every read.
 */
import { Buffer } from "node:buffer";
import { hkdfSync } from "node:crypto";
import { parseKey } from "./encrypt";
import { STALE_STAMP_PREFIX } from "./keys";
import type {
  CacheEncryptOptions,
  CacheKeyRing,
  CacheNameContext,
} from "./types";

/**
 * The persisted labels (the plan's §14): changing one renames every stored
 * name, so they are versioned in their text.
 */
export const NAME_LABELS = {
  /** The HKDF `info` that derives the names key. */
  hkdf: "bun-cache/names/1",
  /** A namespace's HMAC input label. */
  namespace: "ns",
  /** A key's HMAC input label. */
  key: "key",
  /** A tag's HMAC input label. */
  tag: "tag",
} as const;

/** How many names the memo keeps: hot keys repeat, and an HMAC costs about 0.5 µs. */
const MEMO_SIZE = 10_000;

/** A user hash's longest answer, in UTF-8 bytes. */
const MAX_USER_HASH_BYTES = 200;

/** The hex characters of a stored name: the first 128 bits of the HMAC. */
const HEX_CHARS = 32;

/** The text encoder every name goes through. */
const encoder = new TextEncoder();

/** The `hashNames` option, as `CacheEncryptOptions` declares it. */
type HashNamesOption = NonNullable<CacheEncryptOptions["hashNames"]>;

/**
 * One cache's name hashing, resolved at `createCache`. Every method is
 * synchronous: the HMAC is `Bun.CryptoHasher`, and a user `hash` must answer
 * a string.
 */
export class NameHasher {
  /** K_names, for the built-in HMAC; `undefined` with a user hash. */
  readonly #key: Buffer | undefined;
  /** The user hash, when `hashNames.hash` is given. */
  readonly #hash:
    ((name: string, context: CacheNameContext) => string) | undefined;
  /** The memo: `kind \0 namespace \0 name` → the stored name, oldest first. */
  readonly #memo = new Map<string, string>();
  /** The kinds whose determinism a user hash has already proven (the first name of each is hashed twice). */
  readonly #proven = new Set<CacheNameContext["kind"]>();

  constructor(option: HashNamesOption) {
    if (typeof option !== "object" || option === null) {
      throw new TypeError(
        "encrypt.hashNames must be { key } (an HMAC key of 32 bytes) or { hash } (a function)",
      );
    }
    const { key, hash } = option as { key?: unknown; hash?: unknown };
    if ((key === undefined) === (hash === undefined)) {
      throw new TypeError(
        "encrypt.hashNames takes exactly one of key (an HMAC key of 32 bytes) and hash (a function)",
      );
    }
    if (hash !== undefined) {
      if (typeof hash !== "function") {
        throw new TypeError(
          "encrypt.hashNames.hash must be a function (name, context) => string",
        );
      }
      this.#hash = hash as (name: string, context: CacheNameContext) => string;
      this.#key = undefined;
      return;
    }
    const raw = parseKey(key, "encrypt.hashNames.key");
    this.#key = Buffer.from(
      hkdfSync("sha256", raw, new Uint8Array(0), NAME_LABELS.hkdf, 32),
    );
    raw.fill(0);
    this.#hash = undefined;
  }

  /** A namespace's stored form. */
  namespace(namespace: string): string {
    return this.#stored("namespace", namespace, namespace);
  }

  /** A key's stored form, bound to its full namespace. */
  key(namespace: string, key: string): string {
    return this.#stored("key", namespace, key);
  }

  /** A tag's stored form, bound to its full namespace. */
  tag(namespace: string, tag: string): string {
    return this.#stored("tag", namespace, tag);
  }

  /** The stored forms of `tags`, in order. */
  tags(namespace: string, tags: readonly string[]): string[] {
    return tags.map((tag) => this.tag(namespace, tag));
  }

  /** A name's stored form, through the memo. */
  #stored(
    kind: CacheNameContext["kind"],
    namespace: string,
    name: string,
  ): string {
    const id = `${kind}\0${namespace}\0${name}`;
    const known = this.#memo.get(id);
    if (known !== undefined) {
      return known;
    }
    const stored =
      this.#hash === undefined
        ? this.#hmac(kind, namespace, name)
        : this.#userHash(kind, namespace, name);
    if (this.#memo.size >= MEMO_SIZE) {
      this.#memo.delete(this.#memo.keys().next().value!);
    }
    this.#memo.set(id, stored);
    return stored;
  }

  /** The built-in: hex128 of the HMAC over the kind's label and the name, bound to its namespace. */
  #hmac(
    kind: CacheNameContext["kind"],
    namespace: string,
    name: string,
  ): string {
    const hasher = new Bun.CryptoHasher("sha256", this.#key);
    hasher.update(NAME_LABELS[kind]);
    hasher.update("\0");
    hasher.update(namespace);
    if (kind !== "namespace") {
      hasher.update("\0");
      hasher.update(name);
    }
    return hasher.digest("hex").slice(0, HEX_CHARS);
  }

  /** The user hash, its answer checked; the first name of each kind is hashed twice, and must hash alike. */
  #userHash(
    kind: CacheNameContext["kind"],
    namespace: string,
    name: string,
  ): string {
    const context: CacheNameContext = { kind, namespace };
    const stored = this.#hash!(name, context);
    if (typeof stored !== "string") {
      throw new TypeError(
        `encrypt.hashNames.hash must answer a string (it answered ${typeof stored} for a ${kind})`,
      );
    }
    const bytes = encoder.encode(stored).byteLength;
    if (bytes < 1 || bytes > MAX_USER_HASH_BYTES || /[\0\n\r]/.test(stored)) {
      throw new TypeError(
        `encrypt.hashNames.hash must answer 1–${MAX_USER_HASH_BYTES} bytes with no NUL or newline (it answered ${bytes} bytes for a ${kind})`,
      );
    }
    if (kind === "tag" && stored.startsWith(STALE_STAMP_PREFIX)) {
      // It would read as another tag's stale stamp (soft purge, R21).
      throw new TypeError(
        "encrypt.hashNames.hash must not answer a tag's name starting with U+0001, which marks soft purge's stale stamps",
      );
    }
    if (!this.#proven.has(kind)) {
      if (this.#hash!(name, { kind, namespace }) !== stored) {
        throw new TypeError(
          `encrypt.hashNames.hash must be deterministic: the same ${kind} hashed twice answered two names`,
        );
      }
      this.#proven.add(kind);
    }
    return stored;
  }
}

/**
 * Resolves `encrypt.hashNames` at `createCache`: `undefined` when it is off.
 * Throws a `TypeError` naming the option when it is malformed, and answers
 * whether its key is the same bytes as a static ring key (allowed — HKDF
 * keeps the two apart — but warned).
 */
export function resolveNameHasher(
  encrypt: CacheEncryptOptions | undefined,
): { hasher: NameHasher; sharesRingKey: boolean } | undefined {
  const option = encrypt?.hashNames;
  if (option === undefined) {
    return undefined;
  }
  const hasher = new NameHasher(option);
  let sharesRingKey = false;
  const names = (option as { key?: unknown }).key;
  const ring = encrypt?.keys;
  if (names !== undefined && Array.isArray(ring)) {
    const own = parseKey(names, "encrypt.hashNames.key");
    for (const ringKey of ring as CacheKeyRing) {
      let theirs: Uint8Array | undefined;
      try {
        theirs = parseKey(ringKey.key, "encrypt.keys");
      } catch {
        // The ring's own validation names a malformed key.
        continue;
      }
      if (Buffer.from(own).equals(theirs)) {
        sharesRingKey = true;
      }
      theirs.fill(0);
    }
    own.fill(0);
  }
  return { hasher, sharesRingKey };
}
