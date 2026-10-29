/**
 * The Azure Blob Storage driver — a shared cache in a blob container, with
 * stamp-mode tags, expiry kept in each blob's `Content-Type`, a sweeper with
 * caps, and counters and locks on Azure's conditional writes (PR-C8).
 *
 * ```bash
 * bun scripts/setup-databases.ts --only=azure          # a local Azurite
 * eval "$(bun scripts/setup-databases.ts --print-env)"
 * EXAMPLE_AZURE_URL="$BUN_CACHE_TEST_AZURE_URL" bun 04-drivers/azure.ts
 * # that is azure://devstoreaccount1:<key, percent-encoded>@127.0.0.1:10000/devstoreaccount1/bun-cache-test?scheme=http
 * ```
 *
 * - It runs when `EXAMPLE_AZURE_URL` (or `BUN_CACHE_TEST_AZURE_URL`) is set and
 *   otherwise prints `skipped:` and exits 0. A URL that is set but
 *   unreachable fails.
 * - Every blob is written under a prefix naming this process
 *   (`bun-cache-example/<pid>/`, and `…-cap` and `…-cs` for the `maxEntries`
 *   and connection-string parts). At the end the example lists those three
 *   prefixes and deletes each blob it finds, even when a check failed. The
 *   blob container and everything else in it are never touched.
 * - The listing and the deletes are signed by this file itself (about twenty
 *   lines of `node:crypto`), so they do not lean on the driver's own signer.
 * - It shows `getOrSet`, tag invalidation (a stamp blob; the tagged entry
 *   stays stored until a sweep), a counter, `touch`; the same driver from
 *   `UseDevelopmentStorage=true` (only when the URL is the default local
 *   Azurite); the blob layout and the `Content-Type` that carries `exp=` and
 *   `at=`; expiry and `sweep`; `maxEntries` evicting the oldest write; and two
 *   drivers (two "processes") on one prefix counting exactly and sharing a
 *   lock.
 *
 * Worth knowing (see the README's "The Azure Blob Storage driver"):
 *
 * - The portal's connection string is accepted as well:
 *   `connection: { connectionString: "DefaultEndpointsProtocol=https;AccountName=<a>;AccountKey=<k>;EndpointSuffix=core.windows.net", container: "cache" }`.
 *   It names no container, so `container` is still needed. This example does
 *   not use it (it would need a real account).
 * - Locks are not Blob Leases. A lease lasts 15 to 60 seconds or for ever,
 *   and a cache lock's TTL is anything from a second up, so a dead holder
 *   would keep a one-second lock for fifteen. The driver takes the lock with
 *   `If-None-Match: *` and takes over a lapsed one with `If-Match`; the cost is
 *   that expiry compares the holders' clocks, so keep them in sync.
 * - Against Azurite the spike (`docs/plans/bun-cache/evidence/azure-spike.md`)
 *   measured the conditional writes and the Lease Blob calls answering as
 *   Azure documents, and exactly one winner among 50 concurrent writers. It
 *   did not measure real Azure, and Azurite does not enforce Azure's
 *   15-minute limit on a request's age. This example asserts counts, never
 *   timings.
 * - A lifecycle management rule is the backstop for blobs no sweeper reaches
 *   (no cache running, an abandoned prefix). It deletes by age, so it must be
 *   longer than the longest TTL and than `tagStampTtl`, or it deletes live
 *   entries and stamps. This example applies none; the README has the policy
 *   JSON (`prefixMatch` starts with the container's name, for instance
 *   `["cache/bun-cache/"]`, and `daysAfterModificationGreaterThan: 7`).
 * - Every read is a billed operation. For hot small keys put an L1 in front
 *   of the blob container with a bus of its own (`l1: true, bus:
 *   redisBus(url)`); Azure Blob Storage has none.
 */
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import process from "node:process";
import { azureBlobDriver, createCache } from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

const url =
  process.env.EXAMPLE_AZURE_URL ?? process.env.BUN_CACHE_TEST_AZURE_URL;

if (!url) {
  console.log(
    "skipped: set EXAMPLE_AZURE_URL (for instance the azure://devstoreaccount1:…@127.0.0.1:10000/devstoreaccount1/bun-cache-test?scheme=http that `bun scripts/setup-databases.ts --print-env` prints for a local Azurite) to run this example",
  );
  process.exit(0);
}

title("the Azure Blob Storage driver: a shared cache in a blob container");

/** The key prefix of this run: it names this process, so a run owns its blobs. */
const prefix = `bun-cache-example/${process.pid}`;

/** The prefix of the `maxEntries` part: the sweeper walks everything under a prefix, so the cap needs one of its own. */
const capPrefix = `bun-cache-example/${process.pid}-cap`;

/** The prefix of the connection-string part. */
const csPrefix = `bun-cache-example/${process.pid}-cs`;

/** The URL's parts, read here for the signed requests of our own (the driver's `url` option takes the same string). */
const parsed = new URL(url);
const account = decodeURIComponent(parsed.username);
const accountKey = decodeURIComponent(parsed.password);
const pathParts = parsed.pathname.split("/").filter((part) => part !== "");
const container = pathParts.pop() ?? "";
const endpoint = `${parsed.searchParams.get("scheme") ?? "https"}://${parsed.host}${pathParts.map((part) => `/${part}`).join("")}`;

/** Whether the URL is the default local Azurite, which `UseDevelopmentStorage=true` also means. */
const isDefaultAzurite =
  endpoint === "http://127.0.0.1:10000/devstoreaccount1" &&
  account === "devstoreaccount1";

/** One blob as the listing reports it. */
interface Listed {
  /** The blob's name. */
  name: string;
  /** Its `Content-Type`. */
  type: string;
}

/** Sends one Shared Key signed request to the blob container (`blob` empty for the container itself). */
async function signed(
  method: "GET" | "DELETE",
  blob: string,
  query: Record<string, string> = {},
): Promise<Response> {
  const target = new URL(
    `${endpoint}/${container}${blob === "" ? "" : `/${blob.split("/").map(encodeURIComponent).join("/")}`}`,
  );
  for (const [name, value] of Object.entries(query)) {
    target.searchParams.append(name, value);
  }
  const headers = {
    "x-ms-date": new Date().toUTCString(),
    "x-ms-version": "2025-01-05",
  };
  // The string to sign: the verb, the eleven standard headers, all empty (no body, no
  // conditions), the x-ms-* headers, then /<account><path> and each query
  // parameter, name lower-cased and sorted. A path-style endpoint repeats the
  // account, since the path holds it too.
  const resource = [
    `/${account}${target.pathname}`,
    ...[...target.searchParams.keys()]
      .map((name) => name.toLowerCase())
      .toSorted()
      .map((name) => `${name}:${target.searchParams.get(name) ?? ""}`),
  ].join("\n");
  const toSign = `${method}\n${"\n".repeat(11)}x-ms-date:${headers["x-ms-date"]}\nx-ms-version:${headers["x-ms-version"]}\n${resource}`;
  const signature = createHmac("sha256", Buffer.from(accountKey, "base64"))
    .update(toSign)
    .digest("base64");
  return await fetch(target, {
    method,
    headers: { ...headers, authorization: `SharedKey ${account}:${signature}` },
  });
}

/** Every blob under one of this run's prefixes (with the trailing slash, so `…/1` never matches `…/10`). */
async function blobsUnder(...prefixes: string[]): Promise<Listed[]> {
  const found: Listed[] = [];
  for (const under of prefixes) {
    let marker = "";
    do {
      const response = await signed("GET", "", {
        restype: "container",
        comp: "list",
        prefix: `${under}/`,
        ...(marker === "" ? {} : { marker }),
      });
      if (!response.ok) {
        throw new Error(`listing answered ${response.status}`);
      }
      const xml = await response.text();
      for (const [, body] of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
        found.push({
          name: /<Name>([^<]*)<\/Name>/.exec(body)?.[1] ?? "",
          type: /<Content-Type>([^<]*)<\/Content-Type>/.exec(body)?.[1] ?? "",
        });
      }
      marker = /<NextMarker>([^<]*)<\/NextMarker>/.exec(xml)?.[1] ?? "";
    } while (marker !== "");
  }
  return found;
}

/** The names only, for the checks that count or match blobs. */
async function namesUnder(...prefixes: string[]): Promise<string[]> {
  return (await blobsUnder(...prefixes)).map((blob) => blob.name);
}

try {
  await blobsUnder(prefix);
} catch (error) {
  throw new Error("EXAMPLE_AZURE_URL is set but unreachable", { cause: error });
}

try {
  /* ------------------------------------------------------------------ */
  step("getOrSet, tags, a counter and touch");

  const cache = createCache({
    driver: azureBlobDriver({ url, prefix }),
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

  const before = await namesUnder(prefix);
  await cache.invalidateTags(["users"]);
  checkEqual(
    "invalidateTags makes the entry a miss",
    await cache.get("user:42"),
    undefined,
  );
  const after = await namesUnder(prefix);
  // Stamps mode: one stamp blob per tag; the tagged entry's own blob stays
  // until a sweep reclaims it.
  const stamps = after.filter((name) => name.includes("/s/"));
  checkEqual("one stamp blob was written", stamps.length, 1);
  check(
    "the invalidated entry's blob is still stored",
    before.every((name) => after.includes(name)),
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
  step("the layout: one blob per entry, with its expiry in the type");

  const listed = await blobsUnder(prefix);
  show(
    "blobs under the prefix",
    listed.map((blob) => blob.name.slice(prefix.length)),
  );
  const entries = listed.filter((blob) => blob.name.includes("/e/"));
  // raw, user:42 (reloaded), hits (a counter blob) and held.
  checkEqual(
    "four blobs under e/ (the counter is one of them)",
    entries.length,
    4,
  );
  check(
    "every entry sits under <ns>/e/<hh>/<sha256>",
    entries.every((blob) =>
      new RegExp(`^${prefix}/example/e/[0-9a-f]{2}/[0-9a-f]{64}$`).test(
        blob.name,
      ),
    ),
    entries,
  );
  const types = entries.map((blob) => blob.type);
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
  step("the same driver from a connection string");

  if (isDefaultAzurite) {
    // `UseDevelopmentStorage=true` is what Azure tools use for the local
    // Azurite: its well-known development account on 127.0.0.1:10000.
    const viaString = createCache({
      driver: azureBlobDriver({
        prefix: csPrefix,
        connection: {
          connectionString: "UseDevelopmentStorage=true",
          container,
        },
      }),
      namespace: "cs",
      sweepInterval: 0,
    });
    await viaString.set("k", "from a connection string");
    checkEqual(
      "a connection-string driver reads what it wrote",
      await viaString.get("k"),
      "from a connection string",
    );
    checkEqual(
      "its blob is in our container, under its prefix",
      (await namesUnder(csPrefix)).length,
      1,
    );
    await viaString.close();
  } else {
    console.log(
      "skipped: the URL is not the default local Azurite, so UseDevelopmentStorage=true does not reach it",
    );
  }

  /* ------------------------------------------------------------------ */
  step("expiry: a miss at once, the sweeper reclaims the blobs");

  const expiringDriver = azureBlobDriver({ url, prefix });
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
  // blob is housekeeping (done in the background on a read, or by a sweep).
  // The sweeper learns each blob's expiry from the listing alone.
  const swept = await expiringDriver.sweep!(Date.now(), 1_000);
  show("entries and counters the sweep removed", swept);
  await waitFor(
    "the expired blobs to be gone",
    async () =>
      (await namesUnder(prefix)).filter((name) => name.includes("/expiring/"))
        .length === 0,
    // The default deadline: the deletes run in the background, and a pooled
    // run shares Azurite with the other examples (a 5 s bound flaked there).
  );
  checkEqual(
    "no blob of the expired namespace is left",
    (await namesUnder(prefix)).filter((name) => name.includes("/expiring/")),
    [],
  );
  await expiring.close();

  /* ------------------------------------------------------------------ */
  step("maxEntries evicts the oldest write on a sweep");

  // The cap counts every entry under the prefix, so it gets a prefix of its own.
  const capDriver = azureBlobDriver({ url, prefix: capPrefix, maxEntries: 2 });
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
    (await namesUnder(capPrefix)).filter((name) => name.includes("/e/")).length,
    3,
  );
  await capDriver.sweep!(Date.now(), 1_000);
  checkEqual(
    "the sweep left exactly 2 entries",
    (await namesUnder(capPrefix)).filter((name) => name.includes("/e/")).length,
    2,
  );
  checkEqual("the oldest write went", await capped.get("oldest"), undefined);
  checkEqual("the middle one stayed", await capped.get("middle"), "middle");
  checkEqual("the newest stayed", await capped.get("newest"), "newest");
  await capped.close();

  /* ------------------------------------------------------------------ */
  step("two drivers on one prefix: exact counts and a shared lock");

  // Two drivers stand for two processes: each has its own in-process batching,
  // so every contested write goes to the service as a conditional write.
  const left = createCache({
    driver: azureBlobDriver({ url, prefix }),
    namespace: "shared",
    sweepInterval: 0,
  });
  const right = createCache({
    driver: azureBlobDriver({ url, prefix }),
    namespace: "shared",
    sweepInterval: 0,
  });
  await Promise.all([
    ...Array.from({ length: 25 }, () => left.increment("visits")),
    ...Array.from({ length: 25 }, () => right.increment("visits")),
  ]);
  checkEqual("50 increments total exactly 50", await left.get("visits"), 50);
  checkEqual("the other driver reads the same", await right.get("visits"), 50);

  const lockA = azureBlobDriver({ url, prefix });
  const lockB = azureBlobDriver({ url, prefix });
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
} finally {
  // Delete exactly the blobs this run wrote — never the container.
  const mine = await namesUnder(prefix, capPrefix, csPrefix);
  for (const name of mine) {
    await signed("DELETE", name);
  }
  const remaining = await namesUnder(prefix, capPrefix, csPrefix);
  show("deleted this run's blobs", {
    deleted: mine.length,
    left: remaining.length,
  });
  if (remaining.length > 0) {
    process.exitCode = 1;
  }
}

summary();
