/**
 * Encryption at rest — `encrypt` seals every entry before the driver sees it:
 * the proof that nothing readable is stored, key rotation, a key provider (a
 * stand-in KMS), `aad`, tampered and moved entries, migrating a plain cache
 * with `acceptUnencrypted`, and a user `CacheCipher`. Memory driver, no server.
 *
 * ```bash
 * bun 01-core/encryption.ts
 * ```
 *
 * - The proof is the driver's own bytes: this file reads the stored value
 *   back with `driver.get`, searches it for the plaintext and the key, and
 *   edits or copies it with `driver.set`, as anyone with access to the store
 *   could. An entry that does not open is a miss, an `error` event of phase
 *   `"decrypt"` and never thrown, never deleted.
 * - Every key here is random bytes made when the file starts
 *   (`crypto.getRandomValues`): there is no secret in this file. A real
 *   deployment reads them from a secret store (`openssl rand -base64 32`).
 * - Names — keys, namespaces, tags — stay in clear in the store here, since
 *   this file does not set `encrypt.hashNames` (the README's "Hiding names").
 *   What is sealed is the entry: header, full key, value, and copies of its
 *   tags and hard expiry.
 */
import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type {
  CacheCipher,
  CacheCipherContext,
  CacheDecryptError,
  CacheDriver,
  CacheEncryptOptions,
  CacheKey,
} from "@kingsleyweb/bun-cache";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { fakeClock } from "@kingsleyweb/bun-cache/testing";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title(
  "bun-cache encryption: sealed entries, rotation, a key provider, ciphers",
);

/** The namespace most caches here use, so they can share one driver. */
const NS = "example";

/** The string the entries hold, easy to search for in bytes. */
const SECRET = "card ending 4242, balance 1,337.00";

/** A fresh random 32-byte key: what `openssl rand -base64 32` makes. */
function newKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** A ring entry with a fresh random key. */
function ringKey(id: string): CacheKey {
  return { id, key: newKey() };
}

/** Whether `needle` occurs in `haystack`. */
function contains(haystack: Uint8Array, needle: Uint8Array | string): boolean {
  return Buffer.from(haystack).includes(
    typeof needle === "string" ? needle : Buffer.from(needle),
  );
}

/** Reads the driver's stored value for `key`, bypassing the cache. */
async function stored(
  driver: CacheDriver,
  key: string,
  namespace = NS,
): Promise<Uint8Array> {
  const entry = await driver.get(namespace, key);
  if (entry === undefined) {
    throw new Error(`nothing stored under ${namespace}/${key}`);
  }
  return entry.value;
}

/** What an `error` event of phase `"decrypt"` reported. */
interface Decrypt {
  /** The entry's key. */
  key?: string;
  /** Why it did not open. */
  reason: CacheDecryptError["reason"];
  /** The key id the entry names, when it names one. */
  keyId: string | undefined;
}

/** Collects the `decrypt` error events of `cache` into the returned array. */
function decryptEvents(cache: ReturnType<typeof createCache>): Decrypt[] {
  const events: Decrypt[] = [];
  cache.on("error", ({ key, phase, error }) => {
    if (phase === "decrypt") {
      const failure = error as CacheDecryptError;
      events.push({ key, reason: failure.reason, keyId: failure.keyId });
    }
  });
  return events;
}

/** Collects the `keyId` of every `hit` of `cache`. */
function hitKeyIds(cache: ReturnType<typeof createCache>) {
  const ids: (string | undefined)[] = [];
  cache.on("hit", ({ keyId }) => ids.push(keyId));
  return ids;
}

/* ------------------------------------------------------------------ */
step("turning it on: the stored bytes show nothing");

const keyA = ringKey("2026-10");
const plainDriver = memoryDriver();
const plainCache = createCache({
  driver: plainDriver,
  namespace: NS,
  ttl: null,
});
const driver = memoryDriver();
const cache = createCache({
  driver,
  namespace: NS,
  ttl: null,
  encrypt: { keys: [keyA] },
});

const record = { owner: "ada", note: SECRET };
await plainCache.set("invoice:8", record);
await cache.set("invoice:8", record);
const clear = await stored(plainDriver, "invoice:8");
const sealed = await stored(driver, "invoice:8");
show("stored bytes, plain vs sealed", {
  plain: clear.byteLength,
  sealed: sealed.byteLength,
  firstBytes: new TextDecoder().decode(sealed.subarray(0, 2)),
});
check(
  "control: the plain cache stores the string readably",
  contains(clear, SECRET),
);
check(
  "the sealed entry does not contain the string",
  !contains(sealed, SECRET),
);
check("…nor the owner", !contains(sealed, "ada"));
check(
  "…nor the full key (it is sealed with the entry)",
  !contains(sealed, "invoice:8"),
);
check("…nor the key bytes", !contains(sealed, keyA.key as Uint8Array));
checkEqual(
  "it starts with the envelope magic",
  new TextDecoder().decode(sealed.subarray(0, 2)),
  "BE",
);
// The envelope adds 49 bytes and the key id (here 7 characters), and the
// sealed body adds 11 (a version byte, the hard expiry, a tag count) for an
// untagged entry.
checkEqual(
  "the sealed entry is 67 bytes larger (49 + 7-character key id + 11)",
  sealed.byteLength - clear.byteLength,
  67,
);
checkEqual("it reads back", await cache.get("invoice:8"), record);
const idBytes = sealed.subarray(5, 12);
checkEqual(
  "the key id is the only name in the envelope, in clear",
  new TextDecoder().decode(idBytes),
  "2026-10",
);

// Two writes of the same value differ: a fresh salt and nonce each time.
await cache.set("invoice:9", record);
check(
  "two seals of one value differ",
  Buffer.compare(
    Buffer.from(await stored(driver, "invoice:8")).subarray(12),
    Buffer.from(await stored(driver, "invoice:9")).subarray(12),
  ) !== 0,
);

// A key that is not 32 bytes is refused when the cache is made, and the
// message never shows the value.
let bad: unknown;
try {
  createCache({
    driver: memoryDriver(),
    encrypt: { keys: [{ id: "weak", key: "hunter2-not-a-key" }] },
  });
} catch (error) {
  bad = error;
}
check(
  "a key that is not 32 bytes is a TypeError",
  bad instanceof TypeError,
  bad,
);
check(
  "…that names how to make one and does not echo the value",
  bad instanceof Error &&
    bad.message.includes("openssl rand -base64 32") &&
    !bad.message.includes("hunter2"),
  bad,
);

/* ------------------------------------------------------------------ */
step("rotation: new key first, then drop the old one");

const rotDriver = memoryDriver();
const keyOld = ringKey("old");
const keyNew = ringKey("new");
/** A cache on the rotation driver with `keys`. */
const rotCache = (keys: CacheKey[]) =>
  createCache({
    driver: rotDriver,
    namespace: NS,
    ttl: null,
    encrypt: { keys },
  });

// Step 0: everything is written under `old`.
await rotCache([keyOld]).set("session", { user: "ada" });

// Step 1+2: [new, old] opens old entries and seals new ones under `new`.
const rotating = rotCache([keyNew, keyOld]);
const rotHits = hitKeyIds(rotating);
checkEqual("[new, old] reads the old entry", await rotating.get("session"), {
  user: "ada",
});
await rotating.set("session", { user: "ada", rotated: true });
await rotating.get("session");
checkEqual("hit events name the key: old, then new after the write", rotHits, [
  "old",
  "new",
]);

// Step 3: [new] alone. An entry written under `old` is a miss, not deleted.
await rotCache([keyOld]).set("laggard", { user: "grace" });
const dropped = rotCache([keyNew]);
const droppedEvents = decryptEvents(dropped);
checkEqual(
  "[new] reads an entry sealed under new",
  await dropped.get("session"),
  { user: "ada", rotated: true },
);
checkEqual(
  "[new] alone misses an old-key entry",
  await dropped.get("laggard"),
  undefined,
);
checkEqual(
  "…with a decrypt error event: unknown-key, naming the key id",
  droppedEvents,
  [{ key: "laggard", reason: "unknown-key", keyId: "old" }],
);
check(
  "…and the entry is still in the store, not deleted",
  (await rotDriver.get(NS, "laggard")) !== undefined,
);
checkEqual(
  "the ring that has the key reads it again",
  await rotCache([keyNew, keyOld]).get("laggard"),
  { user: "grace" },
);

/* ------------------------------------------------------------------ */
step("a wrong key never throws and never deletes");

const strict = createCache({
  driver: rotDriver,
  namespace: NS,
  ttl: null,
  strict: true,
  encrypt: { keys: [ringKey("old")] }, // the id is right, the bytes are not
});
const strictEvents = decryptEvents(strict);
let strictThrew = false;
let strictAnswer: unknown = "unset";
try {
  strictAnswer = await strict.get("laggard");
} catch {
  strictThrew = true;
}
check("strict: true does not make a decrypt failure throw", !strictThrew);
checkEqual("…it is a miss", strictAnswer, undefined);
checkEqual("…reason auth, with the entry's key id", strictEvents, [
  { key: "laggard", reason: "auth", keyId: "old" },
]);
check(
  "…and the entry is not deleted",
  (await rotDriver.get(NS, "laggard")) !== undefined,
);

/* ------------------------------------------------------------------ */
step("a tampered entry is a miss");

const tamperDriver = memoryDriver();
const tamperKey = ringKey("t1");
const tamperCache = createCache({
  driver: tamperDriver,
  namespace: NS,
  ttl: null,
  encrypt: { keys: [tamperKey] },
});
const tamperEvents = decryptEvents(tamperCache);
await tamperCache.set("balance", { cents: 100 });
const original = await tamperDriver.get(NS, "balance");
if (original === undefined) {
  throw new Error("the entry was not stored");
}
const flipped = original.value.slice();
flipped[flipped.length - 20] ^= 1; // one bit, inside the ciphertext
await tamperDriver.set(NS, { ...original, value: flipped });
checkEqual(
  "one flipped bit: a miss",
  await tamperCache.get("balance"),
  undefined,
);
checkEqual("…reason auth", tamperEvents, [
  { key: "balance", reason: "auth", keyId: "t1" },
]);
check(
  "…and not deleted",
  (await tamperDriver.get(NS, "balance")) !== undefined,
);
// Putting the original bytes back restores the entry: nothing was lost.
await tamperDriver.set(NS, original);
checkEqual("the original bytes open again", await tamperCache.get("balance"), {
  cents: 100,
});

/* ------------------------------------------------------------------ */
step("a moved entry is a miss: the namespace and key are in the AAD");

const sharedKeys = { keys: [ringKey("shared")] };
const tenantDriver = memoryDriver();
const tenantA = createCache({
  driver: tenantDriver,
  namespace: "tenant-a",
  ttl: null,
  encrypt: sharedKeys,
});
const tenantB = createCache({
  driver: tenantDriver,
  namespace: "tenant-b",
  ttl: null,
  encrypt: sharedKeys,
});
const movedEvents = decryptEvents(tenantB);
await tenantA.set("invoice:8", { tenant: "a", total: 900 });
const fromA = await tenantDriver.get("tenant-a", "invoice:8");
if (fromA === undefined) {
  throw new Error("tenant-a's entry was not stored");
}
// Same key ring, same key: an attacker with write access copies the bytes.
await tenantDriver.set("tenant-b", fromA);
checkEqual(
  "tenant-b misses tenant-a's copied invoice",
  await tenantB.get("invoice:8"),
  undefined,
);
checkEqual("…reason auth", movedEvents, [
  { key: "invoice:8", reason: "auth", keyId: "shared" },
]);
// And under another key in the same namespace.
await tenantA.set("invoice:9", { tenant: "a", total: 1 });
const swapSource = await tenantDriver.get("tenant-a", "invoice:9");
if (swapSource === undefined) {
  throw new Error("invoice:9 was not stored");
}
await tenantDriver.set("tenant-a", { ...swapSource, key: "invoice:8" });
checkEqual(
  "a swap within one namespace is a miss too",
  await tenantA.get("invoice:8"),
  undefined,
);

// The control: the same copy on two unencrypted caches serves tenant a's
// invoice to tenant b. That is what the AAD prevents.
const plainTenants = memoryDriver();
const plainA = createCache({
  driver: plainTenants,
  namespace: "tenant-a",
  ttl: null,
});
const plainB = createCache({
  driver: plainTenants,
  namespace: "tenant-b",
  ttl: null,
});
await plainA.set("invoice:8", { tenant: "a", total: 900 });
const plainCopy = await plainTenants.get("tenant-a", "invoice:8");
if (plainCopy === undefined) {
  throw new Error("the plain entry was not stored");
}
await plainTenants.set("tenant-b", plainCopy);
checkEqual(
  "control, unencrypted: tenant-b serves tenant-a's invoice",
  await plainB.get("invoice:8"),
  {
    tenant: "a",
    total: 900,
  },
);

/* ------------------------------------------------------------------ */
step("aad: an entry belongs to the environment that wrote it");

const aadDriver = memoryDriver();
const aadKeys = [ringKey("env")];
const prod = createCache({
  driver: aadDriver,
  namespace: NS,
  ttl: null,
  encrypt: { keys: aadKeys, aad: "prod" },
});
const staging = createCache({
  driver: aadDriver,
  namespace: NS,
  ttl: null,
  encrypt: { keys: aadKeys, aad: "staging" },
});
const noAad = createCache({
  driver: aadDriver,
  namespace: NS,
  ttl: null,
  encrypt: { keys: aadKeys },
});
const aadEvents = decryptEvents(staging);
await prod.set("flag", "on");
checkEqual("the writer's aad opens it", await prod.get("flag"), "on");
checkEqual(
  "another aad under the same key misses",
  await staging.get("flag"),
  undefined,
);
checkEqual(
  "…reason auth",
  aadEvents.map((event) => event.reason),
  ["auth"],
);
checkEqual("no aad at all misses too", await noAad.get("flag"), undefined);

/* ------------------------------------------------------------------ */
step("tags and expiry are sealed with the entry");

const clock = fakeClock();
const sealDriver = memoryDriver({ now: clock.now });
const sealCache = createCache({
  driver: sealDriver,
  namespace: NS,
  now: clock.now,
  ttl: 60_000,
  encrypt: { keys: [ringKey("seal")] },
});
await sealCache.set("tagged", "value", { tags: ["user:1"] });
const tagged = await sealDriver.get(NS, "tagged");
if (tagged === undefined) {
  throw new Error("the tagged entry was not stored");
}
// An attacker strips the tags the store keeps (the tag index) …
await sealDriver.delete(NS, ["tagged"]);
await sealDriver.set(NS, { ...tagged, tags: [] });
clock.advance(5);
await sealCache.invalidateTags(["user:1"]);
checkEqual(
  "an entry with its tags stripped in the store still misses after invalidateTags",
  await sealCache.get("tagged"),
  undefined,
);

// … or raises the expiry the store keeps.
await sealCache.set("short", "value");
const short = await sealDriver.get(NS, "short");
if (short === undefined) {
  throw new Error("the short entry was not stored");
}
await sealDriver.set(NS, { ...short, expiresAt: clock.now() + 24 * 3_600_000 });
checkEqual(
  "before the sealed expiry it reads",
  await sealCache.get("short"),
  "value",
);
clock.advance(61_000);
checkEqual(
  "a raised expiry in the store gains nothing: it expires on time",
  await sealCache.get("short"),
  undefined,
);

/* ------------------------------------------------------------------ */
step("a key provider: a function, awaited, called once");

// The stand-in KMS. A real one decrypts a data key once (see "A key from a
// KMS or Vault" in the README: an AWS `DecryptCommand` whose answer is the
// ring); this one only waits and hands out random bytes. The cache never
// talks to a KMS itself.
let kmsCalls = 0;
const kmsKey = ringKey("kms-1");
const kms = async (): Promise<CacheKey[]> => {
  kmsCalls++;
  await Bun.sleep(50);
  return [kmsKey];
};
const kmsDriver = memoryDriver();
const kmsCache = createCache({
  driver: kmsDriver,
  namespace: NS,
  ttl: null,
  encrypt: { keys: kms },
});
check("the function has not run before the first operation", kmsCalls === 0);
const startedAt = performance.now();
const concurrent = await Promise.all([
  kmsCache.set("a", 1),
  kmsCache.set("b", 2),
  kmsCache.get("a"),
]);
const waited = performance.now() - startedAt;
show("three concurrent operations", { kmsCalls, waitedMs: Math.round(waited) });
checkEqual("one call for the three concurrent operations", kmsCalls, 1);
check("the first operations waited for it", waited >= 40, waited);
checkEqual(
  "the writes were stored",
  [concurrent[0], concurrent[1]],
  [true, true],
);
checkEqual(
  "later operations do not call it again",
  [await kmsCache.get("b"), kmsCalls],
  [2, 1],
);

// A provider that fails before it has ever answered: writes resolve false,
// reads miss, nothing is stored unsealed.
const failing = createCache({
  driver: memoryDriver(),
  namespace: NS,
  encrypt: {
    keys: () => {
      throw new Error("kms unreachable");
    },
  },
});
const failEvents: { phase: string }[] = [];
failing.on("error", ({ phase }) => failEvents.push({ phase }));
checkEqual(
  "with no ring yet, a write resolves false",
  await failing.set("x", 1),
  false,
);
check(
  "…with an encrypt error event",
  failEvents.some((event) => event.phase === "encrypt"),
  failEvents,
);

/* ------------------------------------------------------------------ */
step("acceptUnencrypted: migrating a cache that was plain");

const migDriver = memoryDriver();
const migKeys = [ringKey("mig")];
const legacy = createCache({ driver: migDriver, namespace: NS, ttl: null });
await legacy.set("old-entry", { from: "before encryption" });

const strictMig = createCache({
  driver: migDriver,
  namespace: NS,
  ttl: null,
  encrypt: { keys: migKeys },
});
const strictMigEvents = decryptEvents(strictMig);
checkEqual(
  "off by default: a plain entry is a miss",
  await strictMig.get("old-entry"),
  undefined,
);
checkEqual("…reason unencrypted", strictMigEvents, [
  { key: "old-entry", reason: "unencrypted", keyId: undefined },
]);
check("…not deleted", (await migDriver.get(NS, "old-entry")) !== undefined);

const migrating = createCache({
  driver: migDriver,
  namespace: NS,
  ttl: null,
  encrypt: { keys: migKeys, acceptUnencrypted: true },
});
checkEqual(
  "with acceptUnencrypted it reads the plain entry",
  await migrating.get("old-entry"),
  {
    from: "before encryption",
  },
);
const before = await stored(migDriver, "old-entry");
check(
  "…which is still plain in the store",
  !(before[0] === 0x42 && before[1] === 0x45),
);
await migrating.set("old-entry", { from: "before encryption" });
const after = await stored(migDriver, "old-entry");
checkEqual(
  "a write always seals",
  new TextDecoder().decode(after.subarray(0, 2)),
  "BE",
);
// Leave it on only for the migration: while it is on, anyone who can write
// to the store can plant a plaintext value that this cache serves.
checkEqual(
  "once rewritten, the strict cache reads it",
  await strictMig.get("old-entry"),
  {
    from: "before encryption",
  },
);

// The other way round: a process that is missing `encrypt` (a config not
// yet rolled out) meets sealed entries. It cannot open them, so each read is
// a miss with a decrypt error ("cipher") — and, as for a wrong key, it never
// deletes them, so the peers that have the keys keep their entries.
const forgotEncrypt = createCache({
  driver: migDriver,
  namespace: NS,
  ttl: null,
});
const forgotEvents = decryptEvents(forgotEncrypt);
const sealedBefore = await stored(migDriver, "old-entry");
checkEqual(
  "a cache without encrypt reads a sealed entry as a miss",
  await forgotEncrypt.get("old-entry"),
  undefined,
);
checkEqual("…reason cipher, naming the key id", forgotEvents, [
  { key: "old-entry", reason: "cipher", keyId: "mig" },
]);
await Bun.sleep(5); // room for a background delete, which must not come
check(
  "…and never deletes it",
  Buffer.from(await stored(migDriver, "old-entry")).equals(
    Buffer.from(sealedBefore),
  ),
);
checkEqual(
  "…so the encrypted cache still reads it",
  await strictMig.get("old-entry"),
  { from: "before encryption" },
);

/* ------------------------------------------------------------------ */
step("counters stay plain integers");

// A counter is incremented by the backend (a Redis INCR, a SQL UPDATE), which
// cannot add to a ciphertext. An encrypted cache's counters are therefore
// stored as plain numbers, whatever the backend: do not count anything
// secret in one.
const counterDriver = memoryDriver();
const counterCache = createCache({
  driver: counterDriver,
  namespace: NS,
  encrypt: { keys: [ringKey("c")] },
});
checkEqual(
  "increment counts",
  [
    await counterCache.increment("visits"),
    await counterCache.increment("visits"),
  ],
  [1, 2],
);
checkEqual(
  "…the driver holds the integer itself, not an envelope",
  (await counterDriver.getCounter?.(NS, "visits"))?.value,
  2,
);

/* ------------------------------------------------------------------ */
step("a user cipher");

// Bun's node:crypto has no ChaCha20-Poly1305 (createCipheriv throws "Unknown
// cipher"), so this one is AES-256-CTR with HMAC-SHA-256 over everything
// (encrypt-then-MAC), keyed from one made-up key. It authenticates
// `context.aad`, which is the point: that is what binds an entry to its
// namespace and key. Its output is `iv | ciphertext | mac`. A real one would
// call a KMS or HSM; its key management is its own.
const macKey = newKey();
const encKey = newKey();
const mac = (iv: Uint8Array, body: Uint8Array, context: CacheCipherContext) =>
  createHmac("sha256", macKey)
    .update(context.aad)
    .update(iv)
    .update(body)
    .digest();
const ctrCipher: CacheCipher = {
  id: 200,
  seal(plaintext, context) {
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const cipher = createCipheriv("aes-256-ctr", encKey, iv);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, body, mac(iv, body, context)]);
  },
  open(sealed, context) {
    if (sealed.byteLength < 16 + 32) {
      throw new Error("sealed entry too short");
    }
    const iv = sealed.subarray(0, 16);
    const body = sealed.subarray(16, sealed.byteLength - 32);
    const tag = sealed.subarray(sealed.byteLength - 32);
    if (!timingSafeEqual(tag, mac(iv, body, context))) {
      throw new Error("authentication failed");
    }
    const decipher = createDecipheriv("aes-256-ctr", encKey, iv);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  },
};
const cipherDriver = memoryDriver();
const cipherOptions: CacheEncryptOptions = { cipher: ctrCipher };
const custom = createCache({
  driver: cipherDriver,
  namespace: NS,
  ttl: null,
  encrypt: cipherOptions,
});
const customEvents = decryptEvents(custom);
const customHits = hitKeyIds(custom);
await custom.set("invoice:8", record);
const customBytes = await stored(cipherDriver, "invoice:8");
checkEqual(
  "the envelope names cipher id 200",
  [customBytes[0], customBytes[1], customBytes[3]],
  [0x42, 0x45, 200],
);
check("the string is not in the stored bytes", !contains(customBytes, SECRET));
checkEqual("it reads back", await custom.get("invoice:8"), record);
checkEqual("a user cipher has no ring, so no keyId on the hit", customHits, [
  undefined,
]);

// Moving it fails because the cipher authenticates the AAD.
const movedCustom = createCache({
  driver: cipherDriver,
  namespace: "elsewhere",
  ttl: null,
  encrypt: cipherOptions,
});
const movedCustomEvents = decryptEvents(movedCustom);
const customEntry = await cipherDriver.get(NS, "invoice:8");
if (customEntry === undefined) {
  throw new Error("the custom entry was not stored");
}
await cipherDriver.set("elsewhere", customEntry);
checkEqual(
  "a copy in another namespace misses",
  await movedCustom.get("invoice:8"),
  undefined,
);
checkEqual(
  "…as a cipher failure (the cipher threw)",
  movedCustomEvents.map((event) => event.reason),
  ["cipher"],
);
checkEqual(
  "…and the original is untouched",
  await custom.get("invoice:8"),
  record,
);
checkEqual("no events on the writer", customEvents, []);

// A cipher is only as good as its use of the AAD. `runCacheCipherConformance`
// from `@kingsleyweb/bun-cache/testing` is the check: put
// `runCacheCipherConformance("ctr-hmac", ctrCipher)` in a bun:test file. It
// round-trips 0 B to 1 MiB, looks for plaintext in the output, and fails a
// cipher that ignores a changed byte, `aad`, namespace or key. It is a
// bun:test suite, so this file does not run it.

// The built-in cipher reads this cipher's entries only with it configured.
const builtIn = createCache({
  driver: cipherDriver,
  namespace: NS,
  ttl: null,
  encrypt: { keys: [ringKey("b")] },
});
const builtInEvents = decryptEvents(builtIn);
checkEqual(
  "the built-in cipher alone misses a user cipher's entry",
  await builtIn.get("invoice:8"),
  undefined,
);
checkEqual(
  "…reason cipher",
  builtInEvents.map((event) => event.reason),
  ["cipher"],
);
const migratingCipher = createCache({
  driver: cipherDriver,
  namespace: NS,
  ttl: null,
  encrypt: { keys: [ringKey("b")], previous: [ctrCipher] },
});
checkEqual(
  "with it in `previous`, the built-in cache reads it",
  await migratingCipher.get("invoice:8"),
  record,
);

/* ------------------------------------------------------------------ */
step("what is not hidden");

// Replay: a writer can put an older ciphertext of the same key back. It is
// served, but its freshness and expiry are sealed with it, so it is never
// fresher or longer-lived than when it was written.
const replayClock = fakeClock();
const replayDriver = memoryDriver({ now: replayClock.now });
const replay = createCache({
  driver: replayDriver,
  namespace: NS,
  now: replayClock.now,
  ttl: 60_000,
  encrypt: { keys: [ringKey("r")] },
});
await replay.set("price", 10);
const oldCopy = await replayDriver.get(NS, "price");
if (oldCopy === undefined) {
  throw new Error("the price was not stored");
}
replayClock.advance(30_000);
await replay.set("price", 20);
await replayDriver.set(NS, oldCopy);
checkEqual(
  "an older ciphertext of the same key is served (replay)",
  await replay.get("price"),
  10,
);
replayClock.advance(31_000);
checkEqual(
  "…but it expires when it was always going to",
  await replay.get("price"),
  undefined,
);

for (const closing of [
  forgotEncrypt,
  plainCache,
  cache,
  tenantA,
  tenantB,
  plainA,
  plainB,
  prod,
  kmsCache,
  custom,
  replay,
]) {
  await closing.close();
}

summary();
