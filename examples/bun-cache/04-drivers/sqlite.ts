/**
 * The SQLite driver — a durable cache in one database file, shared by several
 * processes on one host (PR-C3).
 *
 * ```bash
 * bun 04-drivers/sqlite.ts
 * ```
 *
 * - Everything lives in one file, in five tables under a prefix
 *   (`bun_cache_` by default): entries and counters, the tag index, tag
 *   stamps, lock rows and the polled bus.
 * - A "restart" is a second driver on the same file: it reads what the first
 *   wrote — entries and counters.
 * - Tags are *index* mode here, unlike the file driver's stamps: invalidation
 *   deletes the tagged rows at once, in the same transaction that records the
 *   stamp, so the rows are gone from disk, not merely unreadable.
 * - That stamp also fences a `getOrSet` whose loader was running when its tag
 *   was invalidated *elsewhere* (another process or cache instance): the
 *   result is not stored, and a `fenced` event says so. (The same instance
 *   forgets its own flight in memory and drops the write without an event.)
 * - Every write is one `BEGIN IMMEDIATE` transaction, so two processes adding
 *   to one counter lose no update; a lock is one conditional upsert, so a
 *   `getOrSet` with `lock` runs its loader once across processes.
 * - The second process is this same file run again with `child` as its first
 *   argument, started with an explicit environment. Both sides wait at a
 *   start barrier (the child's stdin closing) so their work overlaps.
 * - The directory this example creates is deleted at the end.
 */
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { BusMessage } from "@kingsleyweb/bun-cache";
import { createCache, sqliteDriver } from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

/** How many increments each process adds in the two-process step. */
const INCREMENTS = 200;

/** The namespace both processes use. */
const NAMESPACE = "example";

/** The key of the counter both processes add to. */
const SHARED_COUNTER = "visits";

/** The key `getOrSet` loads under the cross-process lock. */
const LOCKED_KEY = "report";

/** The counter the locked loader bumps each time it runs. */
const LOADS_COUNTER = "report-loads";

/** Opens a cache on the database file, as both processes do. */
function openCache(path: string) {
  return createCache({
    driver: sqliteDriver({ path }),
    namespace: NAMESPACE,
    ttl: 60_000,
  });
}

/** The cross-process `getOrSet`: the loader counts its own runs. */
async function lockedLoad(cache: ReturnType<typeof openCache>) {
  return cache.getOrSet(
    LOCKED_KEY,
    async () => {
      await cache.increment(LOADS_COUNTER);
      await Bun.sleep(300); // slow enough that the other process arrives meanwhile
      return "built";
    },
    { lock: { wait: { interval: 20, timeout: 5_000 } } },
  );
}

/* ------------------------------------------------------------------ */
// The second process: `bun sqlite.ts child <db> <counter|lock>`.
if (process.argv[2] === "child") {
  const [, , , dbPath, mode] = process.argv;
  const cache = openCache(dbPath);
  await cache.get("warm-up"); // opens the connection before the barrier
  await Bun.write(Bun.stdout, `${JSON.stringify({ ready: true })}\n`);
  await Bun.stdin.text(); // the start barrier: the parent closes our stdin
  if (mode === "counter") {
    await Promise.all(
      Array.from({ length: INCREMENTS }, async () =>
        cache.increment(SHARED_COUNTER),
      ),
    );
    await Bun.write(Bun.stdout, `${JSON.stringify({ done: true })}\n`);
  } else {
    const value = await lockedLoad(cache);
    await Bun.write(Bun.stdout, `${JSON.stringify({ value })}\n`);
  }
  await cache.close();
  process.exit(0);
}

/**
 * Starts this file as the second process, waits until it is connected, and
 * answers a function that releases it (starting its work) and one that
 * resolves with its last line of output.
 */
async function startChild(dbPath: string, mode: "counter" | "lock") {
  const child = Bun.spawn(
    [process.execPath, import.meta.path, "child", dbPath, mode],
    {
      // An explicit environment: the child inherits nothing else.
      env: { PATH: process.env.PATH ?? "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error("the child exited before it was ready");
    }
    buffered += decoder.decode(chunk.value);
  }
  return {
    release: async () => {
      await child.stdin.end();
    },
    finished: async (): Promise<unknown> => {
      for (;;) {
        const lines = buffered.split("\n").filter(Boolean);
        if (lines.length >= 2) {
          await child.exited;
          return JSON.parse(lines[1]);
        }
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error("the child exited without a result");
        }
        buffered += decoder.decode(chunk.value);
      }
    },
  };
}

title("the SQLite driver: a durable cache in one database file");

const dir = await mkdtemp(join(tmpdir(), "bun-cache-example-"));
const path = join(dir, "cache.db");
show("the database file", path);

/* ------------------------------------------------------------------ */
step("write with one instance, read with another (a restart)");

const first = openCache(path);
await first.set("user:42", { name: "Ada" }, { tags: ["users"] });
await first.increment("hits:/home", 5);
await first.close();

const second = openCache(path);
checkEqual("the entry survived", await second.get("user:42"), { name: "Ada" });
// A counter's value is a plain number, not an encoded entry.
const hits = await second.get("hits:/home");
checkEqual("the counter survived", hits, 5);
check("a counter reads as a number", typeof hits === "number", hits);

/* ------------------------------------------------------------------ */
step("tags delete eagerly (index mode)");

/** Counts the rows of one table, reading the file the way any tool could. */
function countRows(table: string): number {
  const raw = new Database(path, { readonly: true });
  try {
    const row = raw
      .query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
      .get();
    return row?.n ?? -1;
  } finally {
    raw.close();
  }
}

const entriesBefore = countRows("bun_cache_entries");
const tagRowsBefore = countRows("bun_cache_tags");
show("rows before", { entries: entriesBefore, tagRows: tagRowsBefore });
await second.invalidateTags(["users"]);
// The file driver in stamps mode would leave the entry on disk for the
// sweeper; here the entry row and its tag-index row are deleted in the same
// transaction that writes the stamp.
checkEqual("the entry row is gone", countRows("bun_cache_entries"), 1); // the counter remains
checkEqual("the tag-index row is gone", countRows("bun_cache_tags"), 0);
checkEqual("it reads as a miss", await second.get("user:42"), undefined);
check("the tag was stamped", countRows("bun_cache_stamps") === 1);

/* ------------------------------------------------------------------ */
step("the fence: invalidating a tag while a loader runs");

// An invalidation from the *same* cache instance forgets the flight in
// memory, so its write is dropped silently, with no event. The driver's fence
// is what catches an invalidation made elsewhere — another process, or here
// another cache on the same file — and that is what emits `fenced`.
const elsewhere = openCache(path);
const fenced: unknown[] = [];
second.on("fenced", (event) => fenced.push(event));
const loading = second.getOrSet(
  "slow",
  async () => {
    await Bun.sleep(100);
    return "computed before the invalidation";
  },
  { tags: ["slow-tag"] },
);
await Bun.sleep(20); // the loader is running
await elsewhere.invalidateTags(["slow-tag"]);
checkEqual(
  "the caller still gets its value",
  await loading,
  "computed before the invalidation",
);
checkEqual("a fenced event was emitted", fenced.length, 1);
checkEqual("the value was not stored", await second.get("slow"), undefined);
await elsewhere.close();

/* ------------------------------------------------------------------ */
step("the bus: a message published by one driver reaches another");

const publisher = sqliteDriver({ path });
const listener = sqliteDriver({ path, busPollInterval: 25 });
await publisher.connect?.();
await listener.connect?.();
const received: BusMessage[] = [];
const unsubscribe = await listener.subscribe!(
  (message) => received.push(message),
  () => undefined,
);
await publisher.publish!({
  type: "invalidate-tags",
  namespace: NAMESPACE,
  tags: ["users"],
  at: Date.now(),
});
const deadline = Date.now() + 5_000;
while (received.length === 0 && Date.now() < deadline) {
  await Bun.sleep(10); // the table is polled, every 25 ms here
}
checkEqual("the listener received it", received[0]?.tags, ["users"]);
await unsubscribe();
await publisher.close();
await listener.close();

/* ------------------------------------------------------------------ */
step("two processes add to one counter");

const counterChild = await startChild(path, "counter");
show("the child is connected; releasing both sides together");
await counterChild.release();
await Promise.all(
  Array.from({ length: INCREMENTS }, async () =>
    second.increment(SHARED_COUNTER),
  ),
);
await counterChild.finished();
checkEqual(
  "no increment was lost",
  await second.get(SHARED_COUNTER),
  2 * INCREMENTS,
);

/* ------------------------------------------------------------------ */
step("a cross-process lock runs the loader once");

const lockChild = await startChild(path, "lock");
await lockChild.release();
const mine = await lockedLoad(second);
const theirs = await lockChild.finished();
checkEqual("this process got the value", mine, "built");
checkEqual("the other process got it too", theirs, { value: "built" });
checkEqual(
  "the loader ran exactly once across both",
  await second.get(LOADS_COUNTER),
  1,
);

await second.close();
await rm(dir, { recursive: true, force: true });
show("removed", dir);

summary();
