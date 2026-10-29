/**
 * The Keyv store — `toKeyvStore(cache)` driven the way Keyv 5 calls it, with
 * no Keyv and no cache-manager installed: Keyv's raw string kept as it is,
 * the Keyv namespace as a namespace view, `clear()` sparing the cache's own
 * entries, Keyv's TTLs (relative, none, absolute), the bulk methods, errors
 * as `error` events, and `disconnect()`.
 *
 * ```bash
 * bun 07-keyv/store.ts
 * ```
 *
 * - Keyv 5 sets `store.namespace`, prefixes the key (`keyv:k`), serialises the
 *   value to a JSON string (`{"value":…,"expires":…}`) and passes a relative
 *   TTL in ms. This file does exactly that by hand.
 * - Keyv 6 reads `capabilities` and then sends absolute expiries; the last
 *   part reads it on a second store to show the switch.
 * - The proof of "nothing is serialised twice" is the driver's own bytes:
 *   they end with the string's UTF-8, under a cache whose `codec` is `json`.
 */
import { Buffer } from "node:buffer";
import {
  createCache,
  fromSimpleDriver,
  memoryDriver,
} from "@kingsleyweb/bun-cache";
import type { StoredEntry } from "@kingsleyweb/bun-cache";
import { toKeyvStore } from "@kingsleyweb/bun-cache/keyv";
import { fakeClock } from "@kingsleyweb/bun-cache/testing";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("bun-cache Keyv store: toKeyvStore over a memory cache");

/** The cache's own namespace. */
const NS = "app";

/** The cache's default ttl, which Keyv's writes must ignore, in ms. */
const DEFAULT_TTL = 60_000;

/** What Keyv 5 stores for a value: its JSON envelope as a string. */
function envelope(value: unknown, expires?: number): string {
  return JSON.stringify({ value, expires });
}

/** Whether `haystack` ends with `needle`'s bytes. */
function endsWith(haystack: Uint8Array, needle: Uint8Array): boolean {
  const offset = haystack.byteLength - needle.byteLength;
  return (
    offset >= 0 &&
    Buffer.from(haystack).subarray(offset).equals(Buffer.from(needle))
  );
}

/* ------------------------------------------------------------------ */
step("Keyv's string is stored raw — one serialisation");

const clock = fakeClock();
const driver = memoryDriver({ now: clock.now });
const cache = createCache({
  driver,
  namespace: NS,
  now: clock.now,
  ttl: DEFAULT_TTL,
  codec: "json",
});
const store = toKeyvStore(cache);
store.namespace = "keyv";

const text = envelope({ name: "Ada", tags: ["a", "b"] });
checkEqual("set answers true", await store.set("keyv:k", text, 60_000), true);
checkEqual("get hands the same string back", await store.get("keyv:k"), text);
checkEqual(
  "the cache reads it under namespace('keyv') as that string",
  await cache.namespace("keyv").get("keyv:k"),
  text,
);
const stored = await driver.get(`${NS}:keyv`, "keyv:k");
check(
  "the driver holds it under app:keyv, key as Keyv sent it",
  stored !== undefined,
);
check(
  "its bytes end with the string's UTF-8 (the cache's json codec was not applied on top)",
  stored !== undefined &&
    endsWith(stored.value, new TextEncoder().encode(text)),
  stored,
);
show("stored bytes", stored === undefined ? 0 : stored.value.byteLength);
const entry = await cache.namespace("keyv").getEntry("keyv:k");
checkEqual(
  "getEntry sees the Keyv TTL, not the cache's default",
  entry?.expiresAt,
  clock.now() + 60_000,
);

/* ------------------------------------------------------------------ */
step("a Keyv namespace is a namespace view, and can change after construction");

store.namespace = "other";
checkEqual(
  "a new namespace starts empty",
  await store.get("other:k"),
  undefined,
);
await store.set("other:k", envelope(1));
check(
  "it is stored under app:other",
  (await driver.get(`${NS}:other`, "other:k")) !== undefined,
);
store.namespace = "keyv";
checkEqual(
  "back on keyv the first entry is there",
  await store.get("keyv:k"),
  text,
);
store.namespace = "my space:odd";
await store.set("odd", envelope(2));
const hex = [...new TextEncoder().encode("my space:odd")]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");
check(
  "a namespace cache.namespace() would refuse is stored under _:<hex>",
  (await driver.get(`${NS}:_:${hex}`, "odd")) !== undefined,
);
store.namespace = "";
await store.set("bare", envelope(3));
check(
  "an empty namespace is the cache's own",
  (await driver.get(NS, "bare")) !== undefined,
);
await store.delete("bare");
store.namespace = "keyv";

/* ------------------------------------------------------------------ */
step("clear() clears the Keyv namespace and spares everything else");

await cache.set("own", "mine");
checkEqual("clear answers nothing", await store.clear(), undefined);
checkEqual("the namespace is empty", await store.get("keyv:k"), undefined);
checkEqual("the cache's own entry survives", await cache.get("own"), "mine");
store.namespace = "other";
checkEqual("another Keyv namespace survives", await store.has("other:k"), true);
store.namespace = "keyv";

/* ------------------------------------------------------------------ */
step("TTLs are Keyv's");

await store.set("keyv:rel", envelope("r"), 1_000);
await store.set("keyv:none", envelope("n"));
await store.set("keyv:zero", envelope("z"), 0);
checkEqual(
  "a relative TTL is held before it",
  await store.has("keyv:rel"),
  true,
);
clock.advance(1_001);
checkEqual("a relative TTL expires", await store.has("keyv:rel"), false);
clock.advance(10 * DEFAULT_TTL);
checkEqual(
  "no TTL never expires, though the cache's default ttl is 60 s",
  await store.get("keyv:none"),
  envelope("n"),
);
checkEqual("a TTL of 0 is no TTL", await store.has("keyv:zero"), true);

// Keyv 6 reads `capabilities`; from then on the third argument is absolute.
const abs = toKeyvStore(cache, { namespace: "abs" });
check("capabilities declares expires", abs.capabilities.expires === true);
const future = clock.now() + 5_000;
await abs.set("k", envelope("a", future), future);
checkEqual(
  "an absolute expiry is the entry's expiry",
  (await cache.namespace("abs").getEntry("k"))?.expiresAt,
  future,
);
await abs.set("gone", envelope("g"));
checkEqual("it is stored", await abs.has("gone"), true);
await abs.set("gone", envelope("g"), Date.now() - 1_000);
checkEqual(
  "an absolute expiry in the past deletes",
  await abs.has("gone"),
  false,
);
// The overloads type the first answer (`boolean`, Keyv 5's); Keyv 6 gets `boolean[]`.
checkEqual<unknown>(
  "Keyv 6's deleteMany answers one boolean per key",
  await abs.deleteMany(["k", "missing"]),
  [true, false],
);

/* ------------------------------------------------------------------ */
step("getMany, setMany, deleteMany and has");

await store.setMany([
  { key: "keyv:a", value: envelope("A"), ttl: 60_000 },
  { key: "keyv:b", value: envelope("B") },
  { key: "keyv:c", value: envelope("C"), ttl: 500 },
]);
checkEqual(
  "getMany answers in order, undefined per miss",
  await store.getMany(["keyv:b", "keyv:nope", "keyv:a"]),
  [envelope("B"), undefined, envelope("A")],
);
checkEqual("has", await store.has("keyv:a"), true);
checkEqual("hasMany", await store.hasMany(["keyv:a", "keyv:nope"]), [
  true,
  false,
]);
clock.advance(600);
checkEqual(
  "setMany applied each entry's own TTL",
  await store.has("keyv:c"),
  false,
);
checkEqual(
  "Keyv 5's deleteMany answers whether every key was there (one is not)",
  await store.deleteMany(["keyv:a", "keyv:nope"]),
  false,
);
checkEqual("…and true when all were", await store.deleteMany(["keyv:b"]), true);

/* ------------------------------------------------------------------ */
step("errors arrive as error events, not throws");

const failing = fromSimpleDriver({
  get: () => Promise.reject(new Error("backend down")),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(false),
});
const brokenStore = toKeyvStore(createCache({ driver: failing }));
brokenStore.namespace = "keyv";
const errors: unknown[] = [];
brokenStore.on("error", (error) => {
  errors.push(error);
});
let threw = false;
let answer: unknown = "unset";
try {
  answer = await brokenStore.get("keyv:k");
} catch {
  threw = true;
}
check("get did not throw", !threw);
checkEqual("it answered a miss", answer, undefined);
check(
  "one error event reached the listener, once",
  errors.length === 1 && errors[0] instanceof Error,
  errors,
);
show("error", errors[0] instanceof Error ? errors[0].message : errors[0]);

/* ------------------------------------------------------------------ */
step("disconnect() closes the cache");

let closed = 0;
const closing = fromSimpleDriver({
  get: () => Promise.resolve(undefined as StoredEntry | undefined),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(false),
  close: () => {
    closed++;
    return Promise.resolve();
  },
});
const closingStore = toKeyvStore(createCache({ driver: closing }));
closingStore.on("error", () => undefined);
await closingStore.disconnect();
checkEqual("the driver was closed", closed, 1);
await cache.close();

summary();
