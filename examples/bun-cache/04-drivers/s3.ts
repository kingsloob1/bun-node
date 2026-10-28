/**
 * The S3 driver — a shared cache in a bucket, with stamp-mode tags, expiry
 * kept in each object's `Content-Type`, a sweeper with caps, and counters and
 * locks on S3's conditional writes (PR-C7).
 *
 * ```bash
 * eval "$(bun scripts/setup-databases.ts --print-env)"   # a local SeaweedFS
 * EXAMPLE_S3_URL="$BUN_CACHE_TEST_S3_URL" bun 04-drivers/s3.ts
 * # that is s3://test:test@127.0.0.1:8333/bun-cache-test?scheme=http
 * ```
 *
 * - It runs when `EXAMPLE_S3_URL` (or `BUN_CACHE_TEST_S3_URL`) is set and
 *   otherwise prints `skipped:` and exits 0. A URL that is set but
 *   unreachable fails.
 * - Every object is written under a prefix naming this process
 *   (`bun-cache-example/<pid>/`, and `…-cap` for the `maxEntries` part).
 *   At the end the example lists those two prefixes and deletes each object it
 *   finds, even when a check failed. The bucket and everything else in it are
 *   never touched.
 * - It shows `getOrSet`, tag invalidation (a stamp object; the tagged entry
 *   stays stored until a sweep), a counter, `touch`; the object layout and the
 *   `Content-Type` that carries `exp=` and `at=`; expiry and `sweep`;
 *   `maxEntries` evicting the oldest write; two drivers (two "processes") on
 *   one prefix counting exactly and sharing a lock; and
 *   `conditionalWrites: false`.
 *
 * Worth knowing (see the README's "The S3 driver"):
 *
 * - Counters and locks use `If-None-Match: *` and `If-Match`, which the driver
 *   signs itself (Bun's `S3Client` cannot send them yet, oven-sh/bun#17339).
 *   A store that lacks them (Backblaze B2, Google Cloud Storage's XML API)
 *   wants `conditionalWrites: false`.
 * - SeaweedFS, the repository's test server, serialises concurrent
 *   conditional writes to one object, so two processes contending for one hot
 *   object wait on each other there. The example asserts counts, never timings.
 * - A bucket lifecycle rule is the backstop for objects no sweeper reaches (no
 *   cache running, an abandoned prefix). It expires by age, so it must be
 *   longer than the longest TTL and than `tagStampTtl`, or it deletes live
 *   entries and stamps. In JSON (`aws s3api put-bucket-lifecycle-configuration
 *   --bucket <b> --lifecycle-configuration file://rule.json`); this example
 *   applies none:
 *   `{ "Rules": [{ "ID": "bun-cache-backstop", "Status": "Enabled",
 *   "Filter": { "Prefix": "bun-cache/" }, "Expiration": { "Days": 7 } }] }`
 * - Every read is a billed request. For hot small keys put an L1 in front of
 *   S3 with a bus of its own (`l1: true, bus: redisBus(url)`); S3 has no bus.
 */
import { S3Client } from "bun";
import process from "node:process";
import {
  createCache,
  s3Driver,
  UnsupportedOperationError,
} from "@kingsleyweb/bun-cache";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

const url = process.env.EXAMPLE_S3_URL ?? process.env.BUN_CACHE_TEST_S3_URL;

if (!url) {
  console.log(
    "skipped: set EXAMPLE_S3_URL (for instance s3://test:test@127.0.0.1:8333/bun-cache-test?scheme=http) to run this example",
  );
  process.exit(0);
}

title("the S3 driver: a shared cache in a bucket");

/** The key prefix of this run: it names this process, so a run owns its objects. */
const prefix = `bun-cache-example/${process.pid}`;

/** The prefix of the `maxEntries` part: the sweeper walks everything under a prefix, so the cap needs one of its own. */
const capPrefix = `bun-cache-example/${process.pid}-cap`;

/** A client of our own on the same bucket: lists the objects, reads their types and cleans up. */
const parsed = new URL(url);
const raw = new S3Client({
  accessKeyId: decodeURIComponent(parsed.username),
  secretAccessKey: decodeURIComponent(parsed.password),
  endpoint: `${parsed.searchParams.get("scheme") ?? "https"}://${parsed.host}`,
  bucket: parsed.pathname.replace(/^\//, ""),
  region: parsed.searchParams.get("region") ?? undefined,
});

/** Every object key under one of this run's prefixes (with the trailing slash, so `…/1` never matches `…/10`). */
async function keysUnder(...prefixes: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const under of prefixes) {
    let token: string | undefined;
    do {
      const page = await raw.list({
        prefix: `${under}/`,
        maxKeys: 1000,
        ...(token === undefined ? {} : { continuationToken: token }),
      });
      found.push(...(page.contents ?? []).map((object) => object.key));
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token !== undefined);
  }
  return found;
}

try {
  await raw.list({ prefix: `${prefix}/`, maxKeys: 1 });
} catch (error) {
  throw new Error("EXAMPLE_S3_URL is set but unreachable", { cause: error });
}

try {
  /* ------------------------------------------------------------------ */
  step("getOrSet, tags, a counter and touch");

  const cache = createCache({
    driver: s3Driver({ url, prefix }),
    namespace: "example",
    ttl: 60_000,
    sweepInterval: 0, // sweeps are driven by hand below
  });
  let loads = 0;
  const load = () => {
    loads++;
    return Promise.resolve({ name: "Ada", bytes: new Uint8Array([1, 2, 3]) });
  };
  checkEqual("set stores a value", await cache.set("raw", [4, 5]), true);
  checkEqual("get reads it back", await cache.get("raw"), [4, 5]);
  const first = await cache.getOrSet("user:42", load, { tags: ["users"] });
  checkEqual("getOrSet loads the value", first, {
    name: "Ada",
    bytes: new Uint8Array([1, 2, 3]),
  });
  await cache.getOrSet("user:42", load, { tags: ["users"] });
  checkEqual("the loader ran once", loads, 1);

  const before = await keysUnder(prefix);
  await cache.invalidateTags(["users"]);
  checkEqual(
    "invalidateTags makes the entry a miss",
    await cache.get("user:42"),
    undefined,
  );
  const after = await keysUnder(prefix);
  // Stamps mode: one stamp object per tag; the tagged entry's own object stays
  // until a sweep reclaims it.
  const stamps = after.filter((key) => key.includes("/s/"));
  checkEqual("one stamp object was written", stamps.length, 1);
  check(
    "the invalidated entry's object is still stored",
    before.every((key) => after.includes(key)),
    { before, after },
  );
  await cache.getOrSet("user:42", load, { tags: ["users"] });
  checkEqual("it loads again after the invalidation", loads, 2);

  checkEqual("a counter counts up", await cache.increment("hits", 2), 2);
  checkEqual(
    "a counter goes below zero",
    await cache.increment("hits", -5),
    -3,
  );
  checkEqual("get reads the counter as a number", await cache.get("hits"), -3);

  await cache.set("held", "v", { ttl: 1_000 });
  await cache.touch("held", 60_000);
  const held = await cache.getEntry("held");
  check(
    "touch moved the expiry out to about a minute",
    held !== undefined &&
      held.expiresAt !== null &&
      held.expiresAt !== undefined &&
      Number(held.expiresAt) - Date.now() > 30_000,
    held,
  );

  /* ------------------------------------------------------------------ */
  step("the layout: one object per entry, with its expiry in the type");

  const keys = await keysUnder(prefix);
  show(
    "objects under the prefix",
    keys.map((key) => key.slice(prefix.length)),
  );
  const entries = keys.filter((key) => key.includes("/e/"));
  // raw, user:42 (reloaded), hits (a counter object) and held.
  checkEqual(
    "four objects under e/ (the counter is one of them)",
    entries.length,
    4,
  );
  check(
    "every entry sits under <ns>/e/<hh>/<sha256>",
    entries.every((key) =>
      new RegExp(`^${prefix}/example/e/[0-9a-f]{2}/[0-9a-f]{64}$`).test(key),
    ),
    entries,
  );
  const types = await Promise.all(
    entries.map(async (key) => (await raw.stat(key)).type),
  );
  show("Content-Types", types);
  check(
    "entries carry exp= and at= in their Content-Type",
    types.some(
      (type) =>
        type.startsWith("application/x-bun-cache;") &&
        /exp=\d+/.test(type) &&
        /at=\d+/.test(type),
    ),
    types,
  );
  check(
    "the counter says so in its Content-Type",
    types.some((type) => type.startsWith("application/x-bun-cache-counter")),
    types,
  );
  await cache.close();

  /* ------------------------------------------------------------------ */
  step("expiry: a miss at once, the sweeper reclaims the objects");

  const expiringDriver = s3Driver({ url, prefix });
  const expiring = createCache({
    driver: expiringDriver,
    namespace: "expiring",
    sweepInterval: 0,
  });
  await expiring.set("read", "gone soon", { ttl: 200 });
  await expiring.set("unread", "gone soon too", { ttl: 200 });
  checkEqual("it reads while fresh", await expiring.get("read"), "gone soon");
  await waitFor("the entry to expire", async () => {
    return (await expiring.get("read")) === undefined;
  });
  checkEqual(
    "it is a miss after its TTL",
    await expiring.get("read"),
    undefined,
  );
  // The read above is a miss because the entry's header says so; deleting the
  // object is housekeeping (done in the background on a read, or by a sweep).
  const swept = await expiringDriver.sweep!(Date.now(), 1_000);
  show("entries and counters the sweep removed", swept);
  await waitFor(
    "the expired objects to be gone",
    async () =>
      (await keysUnder(prefix)).filter((key) => key.includes("/expiring/"))
        .length === 0,
    { timeout: 5_000 },
  );
  checkEqual(
    "no object of the expired namespace is left",
    (await keysUnder(prefix)).filter((key) => key.includes("/expiring/")),
    [],
  );
  await expiring.close();

  /* ------------------------------------------------------------------ */
  step("maxEntries evicts the oldest write on a sweep");

  // The cap counts every entry under the prefix, so it gets a prefix of its own.
  const capDriver = s3Driver({ url, prefix: capPrefix, maxEntries: 2 });
  const capped = createCache({
    driver: capDriver,
    namespace: "cap",
    ttl: 60_000,
    sweepInterval: 0,
  });
  for (const key of ["oldest", "middle", "newest"]) {
    await capped.set(key, key);
    await Bun.sleep(25); // writes are ordered by their `at` (ms)
  }
  checkEqual(
    "three entries before the sweep",
    (await keysUnder(capPrefix)).filter((key) => key.includes("/e/")).length,
    3,
  );
  await capDriver.sweep!(Date.now(), 1_000);
  checkEqual(
    "the sweep left exactly 2 entries",
    (await keysUnder(capPrefix)).filter((key) => key.includes("/e/")).length,
    2,
  );
  checkEqual("the oldest write went", await capped.get("oldest"), undefined);
  checkEqual("the middle one stayed", await capped.get("middle"), "middle");
  checkEqual("the newest stayed", await capped.get("newest"), "newest");
  await capped.close();

  /* ------------------------------------------------------------------ */
  step("two drivers on one prefix: exact counts and a shared lock");

  // Two drivers stand for two processes: each has its own in-process batching,
  // so every contested write goes to the store as a conditional write.
  const left = createCache({
    driver: s3Driver({ url, prefix }),
    namespace: "shared",
    sweepInterval: 0,
  });
  const right = createCache({
    driver: s3Driver({ url, prefix }),
    namespace: "shared",
    sweepInterval: 0,
  });
  await Promise.all([
    ...Array.from({ length: 25 }, () => left.increment("visits")),
    ...Array.from({ length: 25 }, () => right.increment("visits")),
  ]);
  checkEqual("50 increments total exactly 50", await left.get("visits"), 50);
  checkEqual("the other driver reads the same", await right.get("visits"), 50);

  const lockA = s3Driver({ url, prefix });
  const lockB = s3Driver({ url, prefix });
  checkEqual(
    "the first driver takes the lock",
    await lockA.acquireLock!("shared", "job", "owner-a", 30_000),
    true,
  );
  checkEqual(
    "the second is refused while it is held",
    await lockB.acquireLock!("shared", "job", "owner-b", 30_000),
    false,
  );
  checkEqual(
    "a release by a non-owner does nothing",
    await lockB.releaseLock!("shared", "job", "owner-b"),
    false,
  );
  checkEqual(
    "the owner releases it",
    await lockA.releaseLock!("shared", "job", "owner-a"),
    true,
  );
  checkEqual(
    "then the second driver takes it",
    await lockB.acquireLock!("shared", "job", "owner-b", 30_000),
    true,
  );
  await lockB.releaseLock!("shared", "job", "owner-b");
  await Promise.all([
    left.close(),
    right.close(),
    lockA.close(),
    lockB.close(),
  ]);

  /* ------------------------------------------------------------------ */
  step("conditionalWrites: false turns counters and locks off");

  const plain = s3Driver({ url, prefix, conditionalWrites: false });
  checkEqual(
    "atomicIncrement is false",
    plain.capabilities.atomicIncrement,
    false,
  );
  checkEqual("lock is false", plain.capabilities.lock, false);
  const plainCache = createCache({
    driver: plain,
    namespace: "plain",
    sweepInterval: 0,
  });
  await plainCache.set("k", "v");
  checkEqual(
    "plain reads and writes still work",
    await plainCache.get("k"),
    "v",
  );
  await checkRejects(
    "increment is unsupported",
    () => plainCache.increment("n"),
    {
      name: UnsupportedOperationError.name,
    },
  );
  await plainCache.close();
} finally {
  // Delete exactly the objects this run wrote — never the bucket.
  const mine = await keysUnder(prefix, capPrefix);
  for (const key of mine) {
    await raw.delete(key);
  }
  const left = await keysUnder(prefix, capPrefix);
  show("deleted this run's objects", {
    deleted: mine.length,
    left: left.length,
  });
  if (left.length > 0) {
    process.exitCode = 1;
  }
}

summary();
