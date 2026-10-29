/**
 * Hiding names — `encrypt.hashNames` stores keys, namespaces and tags as keyed
 * hashes, so a dump of the store shows none of them: the proof on the memory
 * and file drivers, `describeKey`, `clear()` and `invalidateTags()` under
 * hashing, counters, the options it refuses, and a hash of your own.
 *
 * ```bash
 * bun 01-core/hiding-names.ts
 * ```
 *
 * - `encryption.ts` seals values and leaves names in clear; this file turns
 *   the second half on (the README's "Hiding names"). The proof is the
 *   store's own contents: `driver.get` with the plaintext names finds
 *   nothing, and the file driver's directory is listed and every file read.
 * - Every key here is random bytes made when the file starts
 *   (`crypto.getRandomValues`): there is no secret in this file. The names key
 *   is its own, never one of the encryption keys, and never rotated.
 * - Turning hashing on, or changing its key, is a flush: the old entries sit
 *   under names nobody asks for. The second part shows it.
 */
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCache, fileDriver, memoryDriver } from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("bun-cache hiding names: hashNames over sealed entries");

/** The namespace the caches here use. */
const NS = "tenant-acme";

/** Plaintext names, easy to search for in a dump. */
const KEY = "user:ada@example.com";
/** The tag the entry carries. */
const TAG = "org:acme-corp";

/** 32 random bytes: a fresh key for every use. */
function newKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** A cache over `driver` sealing entries, hashing names with `namesKey`. */
function hashed(
  driver: ReturnType<typeof memoryDriver>,
  namesKey: Uint8Array,
  encryptKey: Uint8Array,
) {
  return createCache({
    driver,
    namespace: NS,
    ttl: null,
    encrypt: {
      keys: [{ id: "k1", key: encryptKey }],
      hashNames: { key: namesKey },
    },
  });
}

/* ------------------------------------------------------------------ */
step("the memory driver: the store holds hashes, the cache still reads");

const encryptKey = newKey();
const namesKey = newKey();
const driver = memoryDriver();
const cache = hashed(driver, namesKey, encryptKey);

await cache.set(KEY, { plan: "pro" }, { tags: [TAG] });
checkEqual("cache.get reads it back", await cache.get(KEY), { plan: "pro" });
checkEqual(
  "the plaintext names find nothing in the driver",
  await driver.get(NS, KEY),
  undefined,
);

const described = cache.describeKey(KEY, [TAG]);
show("describeKey", described);
check(
  "describeKey answers 32 hex characters for the namespace, key and tag",
  [described.namespace, described.key, ...described.tags].every((name) =>
    /^[0-9a-f]{32}$/.test(name),
  ),
  described,
);
const found = await driver.get(described.namespace, described.key);
check(
  "the driver finds the entry under the described names",
  found !== undefined,
);
check(
  "its stored tags are the hashed tag, not the plaintext one",
  JSON.stringify(found?.tags) === JSON.stringify(described.tags),
  found?.tags,
);
check(
  "the stored bytes hold neither the key nor the tag",
  !Buffer.from(found!.value).includes(KEY) &&
    !Buffer.from(found!.value).includes(TAG),
);

/* ------------------------------------------------------------------ */
step("the file driver: list the directory, read every file");

const root = await mkdtemp(join(tmpdir(), "bun-cache-hiding-names-"));
try {
  const fileStore = fileDriver({ root });
  const fileCache = createCache({
    driver: fileStore,
    namespace: NS,
    ttl: null,
    encrypt: {
      keys: [{ id: "k1", key: encryptKey }],
      hashNames: { key: namesKey },
    },
  });
  await fileCache.set(KEY, { plan: "pro" }, { tags: [TAG] });
  await fileCache.increment("visits:ada");
  checkEqual("cache.get reads it back", await fileCache.get(KEY), {
    plan: "pro",
  });
  checkEqual(
    "the plaintext names find nothing in the driver",
    await fileStore.get(NS, KEY),
    undefined,
  );
  const fileDescribed = fileCache.describeKey(KEY, [TAG]);
  check(
    "the driver finds the entry under the described names",
    (await fileStore.get(fileDescribed.namespace, fileDescribed.key)) !==
      undefined,
  );

  const paths = (await readdir(root, { recursive: true })).map(String);
  let dump = Buffer.from(paths.join("\n"));
  let fileCount = 0;
  for (const path of paths) {
    const bytes = await readFile(join(root, path)).catch(() => undefined);
    if (bytes !== undefined) {
      fileCount++;
      dump = Buffer.concat([dump, bytes]);
    }
  }
  show("the directory", { entries: paths.length, filesRead: fileCount });
  check("there are files to search", fileCount > 0, paths);
  for (const [what, needle] of [
    ["key", KEY],
    ["namespace", NS],
    ["tag", TAG],
    ["counter key", "visits:ada"],
    ["email in the key", "ada@example.com"],
  ] as const) {
    check(`no file name or content holds the ${what}`, !dump.includes(needle));
  }
  await fileCache.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
step("clear() and invalidateTags() still work; another names key sees nothing");

const users = cache.namespace("users");
await users.set("a", 1, { tags: ["t1"] });
await users.set("b", 2, { tags: ["t2"] });
await cache.set("outside", 3);
await users.invalidateTags(["t1"]);
checkEqual(
  "invalidateTags drops the tagged entry",
  [await users.get("a"), await users.get("b")],
  [undefined, 2],
);
await users.clear();
checkEqual(
  "clear() on a namespace view empties it",
  [await users.get("b")],
  [undefined],
);
checkEqual("…and leaves the parent's entries", await cache.get("outside"), 3);

const otherKey = hashed(driver, newKey(), encryptKey);
const unhashed = createCache({
  driver,
  namespace: NS,
  ttl: null,
  encrypt: { keys: [{ id: "k1", key: encryptKey }] },
});
checkEqual(
  "a cache with a different names key sees nothing",
  await otherKey.get(KEY),
  undefined,
);
checkEqual(
  "a cache with no hashing sees nothing (turning it on is a flush)",
  await unhashed.get(KEY),
  undefined,
);
checkEqual("the original still reads it", await cache.get(KEY), {
  plan: "pro",
});

/* ------------------------------------------------------------------ */
step("counters: a plain integer under a hashed name");

const counterDriver = memoryDriver();
const counters = hashed(counterDriver, namesKey, encryptKey);
checkEqual(
  "increment counts",
  [await counters.increment("hits"), await counters.increment("hits", 4)],
  [1, 5],
);
const counterNames = counters.describeKey("hits");
checkEqual(
  "the driver holds the integer under the hashed name",
  (await counterDriver.getCounter?.(counterNames.namespace, counterNames.key))
    ?.value,
  5,
);
checkEqual(
  "…and nothing under the plaintext name",
  await counterDriver.getCounter?.(NS, "hits"),
  undefined,
);

/* ------------------------------------------------------------------ */
step("what it refuses");

// The two misuses below are compile errors too (`encrypt` needs `keys` or a
// user `cipher`; `hashNames` takes exactly one of `key` and `hash`), so a
// TypeScript caller never reaches them. The `TypeError`s are for JavaScript
// callers and casts, and the `@ts-expect-error`s say the compiler refuses
// them first.

/** The `TypeError` message `make` throws, or `undefined` when it does not throw. */
function typeErrorOf(make: () => unknown): string | undefined {
  try {
    make();
  } catch (error) {
    return error instanceof TypeError
      ? error.message
      : `not a TypeError: ${String(error)}`;
  }
  return undefined;
}

const noCipher = typeErrorOf(() =>
  createCache({
    driver: memoryDriver(),
    // @ts-expect-error -- no cipher: "Property 'keys' is missing"
    encrypt: { hashNames: { key: newKey() } },
  }),
);
show("hashNames without a cipher", noCipher);
check(
  "hashNames without a cipher is a TypeError",
  noCipher !== undefined,
  noCipher,
);

const emptyHash = typeErrorOf(() =>
  createCache({
    driver: memoryDriver(),
    namespace: NS,
    encrypt: {
      keys: [{ id: "k1", key: newKey() }],
      hashNames: { hash: () => "" },
    },
  }),
);
show("a hash answering the empty string", emptyHash);
check(
  "…is a TypeError at createCache",
  emptyHash?.includes("1–200 bytes") === true,
  emptyHash,
);

const both = typeErrorOf(() =>
  createCache({
    driver: memoryDriver(),
    encrypt: {
      keys: [{ id: "k1", key: newKey() }],
      // @ts-expect-error -- both: "'(name: string) => string' is not assignable to type 'undefined'"
      hashNames: { key: newKey(), hash: (name: string) => name },
    },
  }),
);
show("both key and hash", both);
check(
  "…is a TypeError at createCache",
  both?.includes("exactly one") === true,
  both,
);

/* ------------------------------------------------------------------ */
step("a hash of your own");

/** What the user hash was asked for, to show `kind` and `namespace`. */
const asked = new Set<string>();
const ownDriver = memoryDriver();
const own = createCache({
  driver: ownDriver,
  namespace: NS,
  ttl: null,
  encrypt: {
    keys: [{ id: "k1", key: encryptKey }],
    hashNames: {
      // Deterministic, 1-200 bytes, no NUL or newline. Real code would use
      // a keyed hash; this one is a plain digest, to show the context.
      hash: (name, { kind, namespace }) => {
        asked.add(kind);
        return `${kind[0]}-${new Bun.CryptoHasher("sha256")
          .update(`${namespace}\0${name}`)
          .digest("hex")
          .slice(0, 24)}`;
      },
    },
  },
});
await own.set(KEY, "hello", { tags: [TAG] });
checkEqual("get works", await own.get(KEY), "hello");
const ownNames = own.describeKey(KEY, [TAG]);
show("describeKey", ownNames);
check(
  "the stored names are the hash's answers",
  ownNames.key.startsWith("k-") &&
    ownNames.namespace.startsWith("n-") &&
    ownNames.tags[0]?.startsWith("t-") === true,
  ownNames,
);
check(
  "the driver finds the entry there, and not under the plaintext",
  (await ownDriver.get(ownNames.namespace, ownNames.key)) !== undefined &&
    (await ownDriver.get(NS, KEY)) === undefined,
);
await own.invalidateTags([TAG]);
checkEqual("invalidateTags works", await own.get(KEY), undefined);
checkEqual("the hash was asked for each kind", [...asked].sort(), [
  "key",
  "namespace",
  "tag",
]);

for (const closing of [cache, otherKey, unhashed, counters, own]) {
  await closing.close();
}

summary();
