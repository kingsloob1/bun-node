/**
 * Keys and namespaces (plan §3.7). The driver receives the namespace and the
 * stored key separately (`get(ns, key)`); the namespace is a chain
 * (`app:users`), optionally versioned (`app@v3`), and a key longer than
 * `maxKeyLength` bytes is stored as `#` + its SHA-256, with the full key kept
 * in the entry header to detect a collision.
 */

/** A namespace segment: letters, digits, `.`, `_`, `-`; no colons (the chain separator). */
const SEGMENT = /^[\w.-]+$/;

/**
 * Validates a namespace or a `namespace(name)` argument, and answers the
 * cleaned value. Throws a `TypeError` on an empty or malformed segment.
 */
export function checkNamespace(name: string, what = "namespace"): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new TypeError(`a cache ${what} must not be empty`);
  }
  for (const segment of trimmed.split(":")) {
    if (!SEGMENT.test(segment)) {
      throw new TypeError(
        `a cache ${what}'s segments may hold letters, digits, ".", "_" and "-" (got ${JSON.stringify(
          name,
        )})`,
      );
    }
  }
  return trimmed;
}

/**
 * The full namespace a cache stores under: `namespace`, with `@version`
 * appended when a version is given (§3.7).
 */
export function fullNamespace(namespace: string, version?: string): string {
  const ns = checkNamespace(namespace);
  if (version === undefined) {
    return ns;
  }
  const cleaned = checkNamespace(version, "version");
  return `${ns}@${cleaned}`;
}

/**
 * The stored form of a key: itself, or — longer than `maxKeyLength` bytes —
 * `"#"` plus the SHA-256 (hex) of the full key. The entry header keeps the
 * full key, so a hash collision reads as a miss rather than as the wrong
 * value (§3.7).
 */
export function storedKey(key: string, maxKeyLength: number): string {
  if (new TextEncoder().encode(key).byteLength <= maxKeyLength) {
    return key;
  }
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(key);
  return `#${hasher.digest("hex")}`;
}
