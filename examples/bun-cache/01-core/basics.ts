/**
 * Core basics — `createCache` on the memory driver: set/get/has/delete, the
 * entry metadata, TTL expiry, tags, a counter, events and stats.
 *
 * ```bash
 * bun 01-core/basics.ts
 * ```
 *
 * - Every duration is in milliseconds; `ttl: null` never expires.
 * - `getEntry` shows what `get` hides: freshness, the hard expiry, tags.
 * - Tags delete eagerly on the memory driver (`invalidateTags`).
 * - Events narrate what the cache did; `stats()` counts it.
 */
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("bun-cache basics: the core API on the memory driver");

const cache = createCache({
  driver: memoryDriver(),
  namespace: "example",
  ttl: 60_000,
});

// Events narrate; nothing here needs them, so this is just to see them.
cache.on("hit", ({ key }) => show("event: hit", key));
cache.on("miss", ({ key }) => show("event: miss", key));

/* ------------------------------------------------------------------ */
step("set, get, has, delete");

await cache.set("user:42", { name: "Ada", at: new Date(0) });
const user = await cache.get("user:42");
show("user:42", user);
check(
  "the Date came back as a Date (the structured codec)",
  (user as { at: unknown }).at instanceof Date,
);
check("has()", await cache.has("user:42"));
check("delete() answers true once", (await cache.delete("user:42")) === true);
check("…and false the second time", (await cache.delete("user:42")) === false);

/* ------------------------------------------------------------------ */
step("TTL expiry and getEntry");

await cache.set("flash", "gone soon", { ttl: 300 });
const entry = await cache.getEntry("flash");
show("entry", entry);
check("fresh entry", entry !== undefined && entry.stale === false);
check(
  "freshUntil is 300 ms out",
  entry !== undefined && entry.freshUntil === entry.createdAt + 300,
);
show("waiting 350 ms for it to expire…");
await Bun.sleep(350);
checkEqual("expired reads as a miss", await cache.get("flash"), undefined);

/* ------------------------------------------------------------------ */
step("tags");

await cache.set("post:1", { title: "one" }, { tags: ["posts", "author:7"] });
await cache.set("post:2", { title: "two" }, { tags: ["posts"] });
await cache.set("page:about", { body: "…" });
await cache.invalidateTags(["posts"]);
check("post:1 went", (await cache.get("post:1")) === undefined);
check("post:2 went", (await cache.get("post:2")) === undefined);
check(
  "the untagged entry stayed",
  (await cache.get("page:about")) !== undefined,
);

/* ------------------------------------------------------------------ */
step("counters");

checkEqual(
  "increment answers the new value",
  await cache.increment("hits:/home"),
  1,
);
checkEqual("increment by 4", await cache.increment("hits:/home", 4), 5);
checkEqual("decrement", await cache.decrement("hits:/home"), 4);
checkEqual("get on a counter key", await cache.get("hits:/home"), 4);

/* ------------------------------------------------------------------ */
step("namespaces");

const users = cache.namespace("users");
await users.set("42", { name: "Ada" });
checkEqual("the view sees its key", await users.get("42"), { name: "Ada" });
checkEqual("the parent does not", await cache.get("42"), undefined);

show("stats", cache.stats());
check(
  "stats counted the work",
  cache.stats().sets > 0 && cache.stats().hits > 0,
);

summary();
await cache.close();
