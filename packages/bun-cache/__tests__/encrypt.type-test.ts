/**
 * Type-level assertions for `encrypt`'s two shapes (the encryption plan's
 * §10.2, made exclusive on 2026-10-29): the built-in `"aes-256-gcm"` needs
 * `keys`, a user `CacheCipher` refuses `keys` and `keyRefresh`, and
 * `hashNames` takes exactly one of `key` and `hash`. Each refused shape is
 * also a `TypeError` at `createCache` (names.test.ts, encryption.test.ts),
 * for JavaScript callers and casts. Each `@ts-expect-error` is a negative
 * control — it must error, and it must be there; the comment after it is the
 * message a user sees (`bun check` and tsc 6 alike).
 *
 * Checked by `bun run check`, not by `bun test` (`--check` never reads a
 * `*.type-test.ts`).
 */
import type {
  CacheCipher,
  CacheEncryptOptions,
  CacheEncryptWithCipher,
  CacheEncryptWithKeys,
  CacheHashNamesHash,
  CacheHashNamesKey,
  CacheKeyRing,
  CacheNameContext,
} from "../lib/index";
import { createCache, memoryDriver } from "../lib/index";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const driver = memoryDriver();
const KEY = new Uint8Array(32);
const RING = [{ id: "2026-10", key: KEY }];
declare const cipher: CacheCipher;

/* --- valid: every shape the runtime accepts -------------------------- */

// A static ring, with the built-in named or left to the default.
void createCache({ driver, encrypt: { keys: RING } });
void createCache({
  driver,
  encrypt: { keys: RING, cipher: "aes-256-gcm", previous: [cipher] },
});
// hashNames.key alone: bytes or a string spelling.
void createCache({
  driver,
  encrypt: { keys: RING, hashNames: { key: KEY } },
});
void createCache({
  driver,
  encrypt: { keys: RING, hashNames: { key: "hex, base64 or base64url" } },
});
// hashNames.hash alone, inline: its parameters are typed from the option.
void createCache({
  driver,
  encrypt: {
    keys: RING,
    hashNames: {
      hash: (name, { kind, namespace }) => {
        type _name = Expect<Equal<typeof name, string>>;
        type _kind = Expect<Equal<typeof kind, "namespace" | "key" | "tag">>;
        type _namespace = Expect<Equal<typeof namespace, string>>;
        return `${kind}:${namespace}:${name}`;
      },
    },
  },
});
// A user cipher with hashNames, either kind.
void createCache({
  driver,
  encrypt: { cipher, hashNames: { key: KEY }, aad: "prod" },
});
void createCache({
  driver,
  encrypt: {
    cipher,
    hashNames: {
      hash: (name, context) => {
        type _context = Expect<Equal<typeof context, CacheNameContext>>;
        return `${context.kind}:${name}`;
      },
    },
  },
});
// `keys: undefined` beside a user cipher is no key (the runtime agrees).
void createCache({ driver, encrypt: { cipher, keys: undefined } });
// A keys function, sync or async, with keyRefresh and hashNames.
void createCache({
  driver,
  encrypt: {
    keys: () => RING,
    keyRefresh: 300_000,
    hashNames: { key: KEY },
  },
});
void createCache({
  driver,
  encrypt: {
    keys: async () => await Promise.resolve(RING),
    hashNames: { hash: (name) => name },
    acceptUnencrypted: true,
  },
});

// Built in variables: inferred, annotated, `satisfies`, spread.
const inferred = { keys: RING, hashNames: { key: KEY } };
void createCache({ driver, encrypt: inferred });
void createCache({
  driver,
  encrypt: { ...inferred, hashNames: { hash: (name: string) => name } },
});
const annotated: CacheEncryptOptions = { cipher, hashNames: { key: KEY } };
void createCache({ driver, encrypt: annotated });
void createCache({ driver, encrypt: { ...annotated, aad: "staging" } });
const satisfying = {
  keys: () => RING,
  hashNames: {
    hash: (name, { kind }) => {
      type _name = Expect<Equal<typeof name, string>>;
      return `${kind}:${name}`;
    },
  },
} satisfies CacheEncryptOptions;
void createCache({ driver, encrypt: satisfying });
const either: CacheEncryptOptions =
  Math.random() < 0.5 ? { keys: RING } : { cipher };
void createCache({ driver, encrypt: either });

// The option's members stay nameable through indexed access, as before.
type _keys = Expect<
  Equal<
    NonNullable<CacheEncryptOptions["keys"]>,
    CacheKeyRing | (() => CacheKeyRing | Promise<CacheKeyRing>)
  >
>;
type _cipher = Expect<
  Equal<NonNullable<CacheEncryptOptions["cipher"]>, "aes-256-gcm" | CacheCipher>
>;
type _hash = Expect<
  Equal<
    NonNullable<
      Extract<
        NonNullable<CacheEncryptOptions["hashNames"]>,
        { hash: unknown }
      >["hash"]
    >,
    (name: string, context: CacheNameContext) => string
  >
>;

/* --- refused: no cipher ---------------------------------------------- */

void createCache({
  driver,
  // @ts-expect-error -- Property 'keys' is missing in type '{ hashNames: … }' but required in type 'CacheEncryptWithKeys'
  encrypt: { hashNames: { key: KEY } },
});
void createCache({
  driver,
  // @ts-expect-error -- the built-in named is still no cipher without keys: Property 'keys' is missing
  encrypt: {
    cipher: "aes-256-gcm",
    hashNames: { hash: (name: string) => name },
  },
});
void createCache({
  driver,
  // @ts-expect-error -- Type '{}' is not assignable to type 'CacheEncryptOptions | undefined'
  encrypt: {},
});
const noCipher = { hashNames: { key: KEY } };
// @ts-expect-error -- a variable is refused as an inline literal is: Property 'keys' is missing
void createCache({ driver, encrypt: noCipher });

/* --- refused: keys or keyRefresh beside a user cipher ---------------- */

void createCache({
  driver,
  // @ts-expect-error -- Type '{ id: string; key: Uint8Array<ArrayBuffer>; }[]' is not assignable to type 'undefined'
  encrypt: { cipher, keys: RING },
});
void createCache({
  driver,
  // @ts-expect-error -- a keys function too: '() => …' is not assignable to type 'undefined'
  encrypt: { cipher, keys: () => RING, hashNames: { key: KEY } },
});
void createCache({
  driver,
  // @ts-expect-error -- Type 'number' is not assignable to type 'undefined'
  encrypt: { cipher, keyRefresh: 1_000 },
});
// @ts-expect-error -- annotated: Types of property 'keys' are incompatible
const cipherAndKeys: CacheEncryptOptions = { cipher, keys: RING };
void cipherAndKeys;

/* --- refused: hashNames with both of key and hash, or neither -------- */

void createCache({
  driver,
  encrypt: {
    keys: RING,
    // @ts-expect-error -- Type '(name: string) => string' is not assignable to type 'undefined'
    hashNames: { key: KEY, hash: (name: string) => name },
  },
});
void createCache({
  driver,
  encrypt: {
    cipher,
    // @ts-expect-error -- beside a user cipher too, reported on `key`: Type 'string' is not assignable to type 'undefined'
    hashNames: { hash: (name: string) => name, key: "a names key" },
  },
});
void createCache({
  driver,
  encrypt: {
    keys: RING,
    // Refused before the shapes were exclusive too (each branch required its
    // member); kept so a loosening to optional members fails here.
    // @ts-expect-error -- Type '{}' is not assignable to type 'CacheHashNamesKey | CacheHashNamesHash | undefined'
    hashNames: {},
  },
});
const both = {
  keys: RING,
  hashNames: { key: KEY, hash: (name: string) => name },
};
// @ts-expect-error -- a variable: Types of property 'hashNames' are incompatible
void createCache({ driver, encrypt: both });

// The shapes are exported (the user's decision, 2026-10-29), and they are
// exactly the union's members: a caller can name either one.
export type _shapes = Expect<
  Equal<CacheEncryptOptions, CacheEncryptWithCipher | CacheEncryptWithKeys>
>;
export type _hashShapes = Expect<
  Equal<
    NonNullable<CacheEncryptOptions["hashNames"]>,
    CacheHashNamesKey | CacheHashNamesHash
  >
>;
export const _withKeys: CacheEncryptWithKeys = { keys: RING };
export const _hashKey: CacheHashNamesKey = { key: KEY };
