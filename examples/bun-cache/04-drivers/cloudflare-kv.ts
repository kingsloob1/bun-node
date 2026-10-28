/**
 * The Cloudflare KV driver — a cache in a Workers KV namespace, reached over
 * HTTP through the bun-cache Worker (PR-C10).
 *
 * ```bash
 * bun 04-drivers/cloudflare-kv.ts
 * ```
 *
 * - No Cloudflare account is needed. The example starts the Worker the package
 *   ships (`@kingsleyweb/bun-cache/cloudflare-worker`) in workerd through
 *   miniflare (`../shared/cloudflare-local.ts`), on a port the OS picks, with
 *   an in-memory KV namespace bound as `CACHE_KV`, and points the driver at it
 *   with `endpoint`. That is what you do with a deployed Worker, with its
 *   `https://bun-cache.<you>.workers.dev` URL and its
 *   `BUN_CACHE_PROXY_TOKEN` secret. With miniflare not installed, the example
 *   prints `skipped:` and exits 0. It never touches the network.
 * - With an `endpoint`, `namespaceId` is the **binding's name** in the
 *   Worker's `wrangler.toml`; with the REST API (`accountId` + `apiToken`, no
 *   `endpoint`) it is the namespace's id.
 * - Tags are *stamps* mode: `invalidateTags` writes a stamp and every read
 *   checks it. Local KV is a single store, so the invalidation is seen at
 *   once here. On Cloudflare's KV a write, a delete or a stamp may take a
 *   minute or more to show at another location (and through the REST API a
 *   deleted key was measured served for 52 s): use KV where a value a minute
 *   stale is acceptable. This example cannot show that, and does not claim to.
 * - KV refuses an `expiration_ttl` under 60 s. The driver sends at least 60 s
 *   and keeps the exact expiry in the entry's header, which every read
 *   checks, so a shorter TTL still expires on time; KV reclaims the key later.
 * - KV has no atomic increment and no conditional write, so `increment`
 *   throws `UnsupportedOperationError`. The D1 driver has counters and locks
 *   (`cloudflare-d1.ts`).
 * - Everything the example writes goes under a prefix of its own
 *   (`bun-cache-example-<pid>`); the Worker and its namespace are discarded
 *   when the example ends.
 */
import process from "node:process";
import {
  cloudflareKvDriver,
  createCache,
  UnsupportedOperationError,
} from "@kingsleyweb/bun-cache";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { KV_BINDING, startLocalWorker } from "../shared/cloudflare-local";
import { show, step, title, waitFor } from "../shared/console";

title("the Cloudflare KV driver: a cache in a KV namespace, over HTTP");

const worker = await startLocalWorker();

if (!worker) {
  process.exit(0);
}

try {
  show("the local Worker", worker.endpoint);

  /** The key prefix of this run: it names this process. */
  const prefix = `bun-cache-example-${process.pid}`;

  const driver = cloudflareKvDriver({
    endpoint: worker.endpoint,
    apiToken: worker.token,
    namespaceId: KV_BINDING,
    prefix,
  });
  const cache = createCache({
    driver,
    namespace: "example",
    ttl: 300_000,
    sweepInterval: 0, // KV expires keys itself; there is no sweeper to run
  });

  /** The keys of this run's entries, listed through the Worker's KV path. */
  async function storedKeys(): Promise<string[]> {
    const response = await fetch(
      `${worker!.endpoint}/storage/kv/namespaces/${KV_BINDING}/keys?prefix=${encodeURIComponent(`${prefix}/`)}&limit=1000`,
      { headers: { authorization: `Bearer ${worker!.token}` } },
    );
    const body = (await response.json()) as { result: { name: string }[] };
    return body.result.map((key) => key.name);
  }

  /* ---------------------------------------------------------------- */
  step("set, get, getMany and setMany");

  show("capabilities", {
    ttl: driver.capabilities.ttl,
    tags: driver.capabilities.tags,
    bus: driver.capabilities.bus,
    multiProcess: driver.capabilities.multiProcess,
  });
  checkEqual("native TTL", driver.capabilities.ttl, "native");
  checkEqual("tags are stamps", driver.capabilities.tags, "stamps");
  checkEqual("no bus", driver.capabilities.bus, "none");

  await cache.set("user:42", { name: "Ada" });
  checkEqual("a value reads back", await cache.get("user:42"), { name: "Ada" });
  checkEqual("a missing key is a miss", await cache.get("user:0"), undefined);

  checkEqual(
    "setMany answers how many it stored",
    await cache.setMany([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]),
    3,
  );
  checkEqual(
    "getMany answers in order, a miss as undefined",
    await cache.getMany(["a", "b", "nope", "c"]),
    [1, 2, undefined, 3],
  );

  // Another cache on the same driver options is another "process": it reads
  // what the first wrote, through the Worker.
  const other = createCache({
    driver: cloudflareKvDriver({
      endpoint: worker.endpoint,
      apiToken: worker.token,
      namespaceId: KV_BINDING,
      prefix,
    }),
    namespace: "example",
    sweepInterval: 0,
  });
  checkEqual("a second cache reads it", await other.get("user:42"), {
    name: "Ada",
  });
  await other.close();

  /* ---------------------------------------------------------------- */
  step("tags: a stamp, checked on every read");

  await cache.set("post:1", "first", { tags: ["posts"] });
  await cache.set("post:2", "second", { tags: ["posts"] });
  await cache.set("page:home", "home", { tags: ["pages"] });
  await cache.invalidateTags(["posts"]);
  checkEqual("a tagged entry is a miss", await cache.get("post:1"), undefined);
  checkEqual(
    "the other tagged entry too",
    await cache.get("post:2"),
    undefined,
  );
  checkEqual(
    "an entry of another tag stays",
    await cache.get("page:home"),
    "home",
  );
  // Stamps mode: the entries' keys are still stored in KV, unreadable. They
  // are reclaimed by their own expiry; KV has no sweeper to run.
  check(
    "the invalidated entries are still stored (only unreadable)",
    (await storedKeys()).length >= 6,
    await storedKeys(),
  );

  /* ---------------------------------------------------------------- */
  step("a TTL under KV's 60 s floor is still exact");

  await cache.set("short", "gone soon", { ttl: 300 });
  checkEqual("it reads while fresh", await cache.get("short"), "gone soon");
  const before = (await storedKeys()).length;
  await waitFor("the entry to expire", async () => {
    return (await cache.get("short")) === undefined;
  });
  checkEqual("it is a miss after 300 ms", await cache.get("short"), undefined);
  // The driver sent KV an expiration_ttl of 60 s (its minimum); the expiry that
  // ended the read above is the one in the entry's header.
  checkEqual(
    "KV still holds the key (it was told 60 s)",
    (await storedKeys()).length,
    before,
  );

  /* ---------------------------------------------------------------- */
  step("no counters: increment is unsupported");

  checkEqual(
    "counters are not advertised",
    driver.capabilities.atomicIncrement,
    false,
  );
  await checkRejects("increment throws", () => cache.increment("hits"), {
    name: UnsupportedOperationError.name,
  });

  /* ---------------------------------------------------------------- */
  step("delete and clear");

  checkEqual(
    "delete answers whether it removed",
    await cache.delete("a"),
    true,
  );
  checkEqual("it is gone", await cache.get("a"), undefined);
  await cache.clear();
  checkEqual("clear removed the entries", await cache.get("b"), undefined);

  await cache.close();
} finally {
  await worker.stop();
}

summary();
