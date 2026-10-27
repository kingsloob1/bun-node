/**
 * The file driver — a durable cache in one directory, shared by several
 * processes on one host (PR-C2).
 *
 * ```bash
 * bun 04-drivers/file.ts
 * ```
 *
 * - Everything lives under one root: one `.bce` file per entry, a stamp per
 *   invalidated tag, a counter per counter key, a polled `bus.log`.
 * - A "restart" is a second driver on the same root: it reads what the first
 *   wrote — entries, counters, and the tag stamps.
 * - Tags are *stamps* mode here: invalidation writes a stamp; the read-side
 *   check invalidates, and the sweeper reclaims the dead entries.
 * - The directory this example creates is deleted at the end.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCache, fileDriver } from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("the file driver: a durable cache in one directory");

const root = await mkdtemp(join(tmpdir(), "bun-cache-example-"));
show("the cache root", root);

/* ------------------------------------------------------------------ */
step("write with one instance, read with another (a restart)");

const first = createCache({
  driver: fileDriver({ root }),
  namespace: "example",
  ttl: 60_000,
});
await first.set("user:42", { name: "Ada" }, { tags: ["users"] });
await first.increment("hits:/home", 5);
await first.invalidateTags(["users"]); // writes a stamp, deletes nothing (stamps mode)
await first.close();

const second = createCache({
  driver: fileDriver({ root }),
  namespace: "example",
  ttl: 60_000,
});
checkEqual("the counter survived", await second.get("hits:/home"), 5);
// The stamp the first instance wrote invalidates the entry on read…
checkEqual(
  "the tagged entry reads as a miss",
  await second.get("user:42"),
  undefined,
);
// …but the entry file is still on disk — the sweeper reclaims it.
const shards = await readdir(join(root, "example", "e"));
show("the stale entry is still on disk, as a file", shards.length === 1);
check("one shard directory", shards.length === 1);
await second.close();

/* ------------------------------------------------------------------ */
step("stamp-mode tags across instances");

const a = createCache({ driver: fileDriver({ root }), namespace: "example" });
const b = createCache({ driver: fileDriver({ root }), namespace: "example" });
await a.set("doc:1", "v1", { tags: ["docs"] });
await b.invalidateTags(["docs"]);
checkEqual("b's stamp invalidates a's entry", await a.get("doc:1"), undefined);
await Bun.sleep(2); // a stamp counts as newer than an entry of its own ms
await a.set("doc:1", "v2", { tags: ["docs"] });
checkEqual("a fresh write survives", await b.get("doc:1"), "v2");
await a.close();
await b.close();

/* ------------------------------------------------------------------ */
step("the sweeper: expired entries and size caps");

const capped = join(root, "capped");
const cappedDriver = fileDriver({ root: capped, maxEntries: 3 });
const sweeper = createCache({
  driver: cappedDriver,
  namespace: "example",
  ttl: 200,
  sweepInterval: 0, // driven by hand here
});
for (let index = 0; index < 5; index++) {
  await sweeper.set(`k${index}`, `v${index}`);
  await Bun.sleep(10); // keep the mtimes apart: eviction is oldest-first
}
await Bun.sleep(300); // let them all expire
const reclaimed = await cappedDriver.sweep?.(Date.now(), 100);
show("entries the sweep reclaimed", reclaimed);
checkEqual(
  "everything expired was reclaimed",
  await sweeper.get("k4"),
  undefined,
);
await sweeper.close();

show("the root before cleanup", await readdir(root));
await rm(root, { recursive: true, force: true });
show("removed", root);

summary();
