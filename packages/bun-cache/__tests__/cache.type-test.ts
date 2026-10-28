/**
 * Type-level assertions for the typed cache (plan §3.13) and V10's
 * `CacheSchemaFrom`. The runtime half lives in the other suites; this half is
 * what a user feels: keys belong to the schema, values come back typed, and
 * `increment` knows which keys are counters. Each `@ts-expect-error` is a
 * negative control — it must error, and it must be there.
 *
 * Checked by `bun run check`, not by `bun test` (`--check` never reads a
 * `*.type-test.ts`).
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { z } from "zod";
import type {
  CacheEntry,
  CacheEventMap,
  CacheFencedReason,
  CacheSchemaFrom,
  CreateCacheOptions,
} from "../lib/index";
import { createCache, memoryDriver } from "../lib/index";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

interface User {
  id: number;
  name: string;
}

interface Report {
  title: string;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- a type alias, not an interface: an interface has no implicit index signature, so it would not satisfy `CacheSchema`'s constraint
type Schema = {
  [k: `user:${number}`]: User;
  [k: `report:${string}`]: Report;
  config: { dark: boolean };
  [k: `hits:${string}`]: number;
};

const cache = createCache<Schema>({ driver: memoryDriver() });

// A key's value type comes from the schema, template patterns included.
type Get<K extends keyof Schema & string> = Awaited<
  ReturnType<typeof cache.get<K>>
>;
type _user = Expect<Equal<Get<`user:${number}`>, User | undefined>>;
type _report = Expect<Equal<Get<"report:q3">, Report | undefined>>;

export async function reads(): Promise<void> {
  await cache.set("user:42", { id: 42, name: "Ada" });
  // @ts-expect-error a Report is not a User
  await cache.set("user:42", { title: "q3" });
  // @ts-expect-error no such key pattern
  await cache.get("usr:42");
  // The loader returns the key's value type.
  await cache.getOrSet("user:42", () => ({ id: 42, name: "Ada" }));
  await cache.getOrSet("user:42", async () => ({ id: 42, name: "Ada" }));
  // @ts-expect-error the loader must return a User
  await cache.getOrSet("user:42", () => 42);
}

export async function countersAndWrap(): Promise<void> {
  // Counters: only number-valued keys.
  await cache.increment("hits:/home");
  await cache.increment("hits:/home", 2, { ttl: 1_000 });
  // @ts-expect-error a User key is not a counter
  await cache.increment("user:42");
  // @ts-expect-error a literal non-number key is not a counter
  await cache.increment("config");

  // wrap: the key builder receives fn's parameters.
  const fetchUser = cache.wrap(
    async (id: number, locale: string) => ({ id, name: locale }),
    {
      key: (id, _locale) => `user:${id}` as const,
    },
  );
  type _fetchUser = Expect<
    Equal<
      typeof fetchUser,
      (id: number, locale: string) => Promise<User | undefined>
    >
  >;
  await fetchUser(1, "en");
  // @ts-expect-error fn's parameters are enforced
  await fetchUser("1", "en");

  // A namespace view keeps the schema.
  type _same = Expect<Equal<ReturnType<typeof cache.namespace>, typeof cache>>;

  // getEntry's metadata.
  type EntryOf<K extends keyof Schema & string> = Awaited<
    ReturnType<typeof cache.getEntry<K>>
  >;
  type _entry = Expect<Equal<EntryOf<"user:42">, CacheEntry<User> | undefined>>;
}

/* --- V10: CacheSchemaFrom ------------------------------------------- */

const UserSchema = z.object({ id: z.number(), name: z.string() });

// The map of patterns to schemas becomes the cache's schema.
type FromValidate = CacheSchemaFrom<{
  "user:*": typeof UserSchema;
  config: StandardSchemaV1<unknown, { dark: boolean }>;
}>;
type _fromValidate = Expect<
  Equal<
    FromValidate,
    {
      [k: `user:${string}`]: { id: number; name: string };
      config: { dark: boolean };
    }
  >
>;

// `createCache({ validate })` with no explicit schema infers it from the map.
const validated = createCache({
  driver: memoryDriver(),
  validate: { "user:*": UserSchema },
});
type _validated = Expect<
  Equal<
    Awaited<ReturnType<typeof validated.get>>,
    { id: number; name: string } | undefined
  >
>;

export async function validateReads(): Promise<void> {
  await validated.set("user:1", { id: 1, name: "Ada" });
  // @ts-expect-error the inferred schema refuses a wrong value
  await validated.set("user:1", { id: "1" });
}

/* --- the untyped cache, and the json codec's Jsonify view ----------- */

const untyped = createCache({ driver: memoryDriver() });
type _untyped = Expect<Equal<Awaited<ReturnType<typeof untyped.get>>, unknown>>;
type _untypedOptions = Expect<
  Equal<CreateCacheOptions["driver"], import("../lib/index").CacheDriver>
>;
void untyped;

// With `codec: "json"`, a Date field reads back as a string: the type applies
// Jsonify, so it stays truthful (§3.13).
interface WithDate {
  at: Date;
}
const json = createCache<{ [k: `snap:${string}`]: WithDate }>({
  driver: memoryDriver(),
  codec: "json",
});
type _json = Expect<
  Equal<Awaited<ReturnType<typeof json.get>>, { at: string } | undefined>
>;
void json;
void validated;

/* --- the `fenced` event says which mechanism dropped the write ------- */

type _fencedReason = Expect<
  Equal<CacheEventMap["fenced"]["reason"], CacheFencedReason>
>;
type _fencedReasons = Expect<Equal<CacheFencedReason, "fence" | "local">>;
untyped.on("fenced", ({ reason }) => {
  // @ts-expect-error -- a closed union: a reason outside it is a compile error
  void (reason === "remote");
});
