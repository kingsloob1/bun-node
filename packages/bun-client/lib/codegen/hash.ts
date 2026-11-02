/**
 * The documents' hash (typed-client plan §3.0): bun-common's `typesHash`
 * (`bun-common/lib/docs/hash.ts`), copied rather than imported, because the
 * generator must run where bun-common is not installed (a third-party API,
 * a separate client repo). `__tests__/codegen/hash.test.ts` asserts the two
 * agree, so a change to one that the other lacks fails.
 *
 * It is what a generated file's header records, and what the dev endpoint
 * (PR-M2) serves as its `ETag`, so the watcher (PR-C3) can compare them.
 */

/** JSON with every object's keys sorted, at every depth; arrays keep their order. */
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
 * SHA-256 over the canonical JSON of `{ asyncapi, openapi }` (an absent
 * document left out), as its first 16 lowercase hex characters: the same
 * value bun-common's `typesHash` gives for the same documents.
 *
 * @param documents The OpenAPI document, and the AsyncAPI one when there is one.
 * @returns 16 lowercase hex characters.
 */
export function documentsHash(documents: {
  /** The OpenAPI document. Default: none. */
  readonly openapi?: object;
  /** The AsyncAPI document. Default: none. */
  readonly asyncapi?: object;
}): string {
  const covered: Record<string, unknown> = {};
  if (documents.asyncapi !== undefined) covered.asyncapi = documents.asyncapi;
  if (documents.openapi !== undefined) covered.openapi = documents.openapi;
  return new Bun.CryptoHasher("sha256")
    .update(canonicalJson(covered))
    .digest("hex")
    .slice(0, 16);
}
