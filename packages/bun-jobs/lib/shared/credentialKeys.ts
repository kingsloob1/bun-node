/**
 * Internal: whether a key (a `describe()` fact's, a log field's) names a
 * credential, and whether text holds a URL with credentials in it. One rule, shared by the status serializer's fact filter
 * (`isServableFact`) and a provider's redacting logger, so the two never
 * disagree about which names are secret.
 */

/**
 * The words that make a key look like a credential, singular or plural. A
 * backstop must fail safe, so a key counts when any of its words is one of
 * these (see {@link keyWords}) **or** when the whole key, lower case with its
 * separators removed, ends with one: `apiKey`, `api_key`, `apikey`,
 * `sessiontoken`, `clientsecret` and `dbPassword` all count, while
 * `author`, `keyspace` and `tokenizerModel` do not. `monkey` counts too,
 * which errs the safe way.
 */
const CREDENTIAL_WORDS = [
  "token",
  "secret",
  "key",
  "password",
  "passwd",
  "pwd",
  "credential",
  "auth",
  "authorization",
  "bearer",
  "private",
  "cookie",
  "session",
] as const;

/** One of {@link CREDENTIAL_WORDS}, as a whole word, optionally plural. */
const CREDENTIAL_WORD = new RegExp(`^(?:${CREDENTIAL_WORDS.join("|")})s?$`);

/** A key, joined, that ends with one of {@link CREDENTIAL_WORDS}. */
const CREDENTIAL_SUFFIX = new RegExp(`(?:${CREDENTIAL_WORDS.join("|")})s?$`);

/**
 * A key's words, lower case: split at camelCase humps and at `_`, `-`, `.`
 * and spaces (`secretArn` → `secret`, `arn`; `API_KEY` → `api`, `key`).
 */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/** Whether `key` names a credential, by {@link CREDENTIAL_WORDS}' rule. */
export function isCredentialKey(key: string): boolean {
  const words = keyWords(key);
  return (
    words.some((word) => CREDENTIAL_WORD.test(word)) ||
    CREDENTIAL_SUFFIX.test(words.join(""))
  );
}

/**
 * A URL carrying userinfo — `scheme://user:pass@host`, or any `://…@`, a
 * token alone included (`https://ghp_…@github.com`, a Sentry DSN): a
 * connection string with its credential in it.
 */
export const URL_USERINFO = /:\/\/[^/\s]*@/;
