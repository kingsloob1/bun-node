/**
 * The documents' hash (typed-client plan §3.0, §8.2 item 2): the change
 * detector a typed client's tooling compares — the dev sync's `ETag` and
 * greeting (PR-M2), a generated file's header and its `--check` (PR-C2), a
 * persisted query cache's buster (PR-C8).
 *
 * Imports nothing: Bun's `CryptoHasher` does the hashing.
 */

/**
 * JSON with every object's keys sorted, at every depth; arrays keep their
 * order (it is meaningful: `required`, `enum`, `x-bun-errors`). What
 * `JSON.stringify` leaves out (an `undefined` property, a function) is left
 * out here too.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      return child;
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(child).sort()) {
      sorted[key] = (child as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

/**
 * The hash of a server's documents: SHA-256 over the canonical JSON (keys
 * sorted at every depth) of `{ asyncapi, openapi }` — an absent document
 * left out — as the first 16 lowercase hex characters (64 bits).
 *
 * Deterministic: the same documents hash the same in any process, whatever
 * order their keys were built in. **Every** change to the documents changes
 * it, prose included (a `summary`, a `description`): the documents are the
 * model and are hashed whole (typed-client plan §3.0). A consumer that wants
 * to ignore prose hashes a copy without it.
 *
 * ```ts
 * const hash = typesHash({
 *   openapi: generateOpenApi(app, { title: "API", version: "1" }).document,
 *   asyncapi: generateAsyncApi(app, { title: "API", version: "1" }).document,
 * });
 * ```
 *
 * @param documents The documents. Either may be absent, and the hash then
 *   covers the other alone.
 * @returns 16 lowercase hex characters.
 * @throws TypeError when `documents` is not an object, or a document given is
 *   not one.
 */
export function typesHash(documents: {
  /**
   * The OpenAPI document (`generateOpenApi(...).document`, or any OpenAPI
   * 3.x document). Default: none.
   */
  readonly openapi?: Readonly<Record<string, unknown>>;
  /**
   * The AsyncAPI document (`generateAsyncApi(...).document`, bun-nest's
   * `gatewayAsyncApi(...)`, or any AsyncAPI 3.x document). Default: none.
   */
  readonly asyncapi?: Readonly<Record<string, unknown>>;
}): string {
  if (typeof documents !== "object" || documents === null) {
    throw new TypeError(
      "typesHash(): expected { openapi?, asyncapi? }, the documents to hash",
    );
  }
  const covered: Record<string, unknown> = {};
  for (const name of ["asyncapi", "openapi"] as const) {
    const document = documents[name];
    if (document === undefined) continue;
    if (
      typeof document !== "object" ||
      document === null ||
      Array.isArray(document)
    ) {
      throw new TypeError(`typesHash(): ${name} must be a document object`);
    }
    covered[name] = document;
  }
  return new Bun.CryptoHasher("sha256")
    .update(canonicalJson(covered))
    .digest("hex")
    .slice(0, 16);
}
