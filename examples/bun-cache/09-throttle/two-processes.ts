/**
 * One limit across processes — two `bun` processes, each with its own cache,
 * its own `cacheThrottleStore` and its own `throttle()` of limit 20, over one
 * shared backend; together they send 60 requests for one client, and exactly
 * 20 get through. With bun-common's default memory store each process would
 * let 20 through: 40.
 *
 * ```bash
 * bun 09-throttle/two-processes.ts                     # SQLite, one host
 * EXAMPLE_REDIS_URL=redis://127.0.0.1:6379/13 \
 * EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost:5432/app \
 *   bun 09-throttle/two-processes.ts                   # and Redis, Postgres
 * ```
 *
 * - SQLite always runs: one database file in a temporary directory, which
 *   the example deletes at the end. Redis runs when `EXAMPLE_REDIS_URL` (or
 *   `BUN_CACHE_TEST_REDIS_URL`) is set, Postgres when `EXAMPLE_POSTGRES_URL`
 *   (or `BUN_CACHE_TEST_POSTGRES_URL`) is; each names the variable when it
 *   sits out. A URL that is set but unreachable fails.
 * - Redis keys live under `bun-cache-example:<pid>-throttle`, and the example
 *   deletes exactly the keys that prefix names (a `SCAN` of it). Postgres
 *   tables carry the prefix `bun_cache_example_<pid>_throttle_`, and the
 *   example drops exactly those.
 * - The second process is this file run again with `child` as its first
 *   argument. Both wait at a start barrier (their stdin closing) so their
 *   requests overlap, and each counts with `failMode: "closed"`, so a store
 *   failure is a 503, never a request let through.
 * - **Clocks.** On these backends the store counts by the backend's own
 *   clock (`clock: "store"`, the default): the last proof gives the two
 *   processes clocks two minutes apart, either side of an hour's edge, and
 *   still exactly 20 get through (a fixed window, which shares nothing
 *   between two windows). Its control counts by each process's own
 *   clock (`clock: "process"`): they land in two windows and 40 get
 *   through, which is why processes counting by their own clocks need NTP.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { RedisClient, SQL } from "bun";
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";
import type { CacheDriver } from "@kingsleyweb/bun-cache";
import {
  createCache,
  postgresDriver,
  redisDriver,
  sqliteDriver,
} from "@kingsleyweb/bun-cache";
import { cacheThrottleStore } from "@kingsleyweb/bun-cache/throttle";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

/** The limit each process sets. */
const LIMIT = 20;

/** Requests each process sends. */
const REQUESTS = 30;

/** One hour, the window. */
const HOUR = 3_600_000;

/** Which backend a process counts on, and where. */
interface Target {
  /** `sqlite`, `redis` or `postgres`. */
  backend: "sqlite" | "redis" | "postgres";
  /** The database file (SQLite) or the server's URL. */
  location: string;
  /** The key or table prefix this run owns. */
  prefix: string;
}

/** The driver a process builds for `target`. */
function driverFor(target: Target): CacheDriver {
  switch (target.backend) {
    case "sqlite":
      return sqliteDriver({ path: target.location });
    case "redis":
      return redisDriver({ url: target.location, prefix: target.prefix });
    case "postgres":
      return postgresDriver({ url: target.location, prefix: target.prefix });
  }
}

/* ------------------------------------------------------------------ */
// The second process: `bun two-processes.ts child <target JSON> <now> <namespace> <clock> <algorithm>`.
if (process.argv[2] === "child") {
  const target = JSON.parse(process.argv[3]) as Target;
  const now = Number(process.argv[4]);
  const cache = createCache({ driver: driverFor(target), sweepInterval: 0 });
  const store = cacheThrottleStore(cache, {
    namespace: process.argv[5],
    clock: process.argv[6] === "process" ? "process" : "store",
  });
  const router = new BunRouter({
    throttle: {
      limit: LIMIT,
      window: "1h",
      algorithm:
        process.argv[7] === "fixed-window" ? "fixed-window" : "sliding-window",
      store,
      failMode: "closed",
      key: () => "one-client",
      now: () => now,
    },
  });
  router.get("/", (_req, res) => {
    res.send("ok");
  });
  router.use(((_err, _req, res, _next) => {
    res.status(503).send("store unavailable");
  }) satisfies RouterErrorMiddlewareHandler);
  await store.get("warm-up"); // connects before the barrier
  await Bun.write(Bun.stdout, `${JSON.stringify({ ready: true })}\n`);
  await Bun.stdin.text(); // the start barrier: the parent closes our stdin
  const counts = { allowed: 0, limited: 0, failed: 0 };
  // Waves of concurrent requests, so the two processes interleave.
  for (let sent = 0; sent < REQUESTS; sent += 3) {
    const answers = await Promise.all(
      Array.from({ length: 3 }, async () => await router.fetch("/")),
    );
    for (const answer of answers) {
      if (answer.status === 200) counts.allowed++;
      else if (answer.status === 429) counts.limited++;
      else counts.failed++;
    }
  }
  await Bun.write(Bun.stdout, `${JSON.stringify(counts)}\n`);
  await cache.close();
  process.exit(0);
}

/** What a child reports. */
interface Counts {
  /** Requests answered 200. */
  allowed: number;
  /** Requests answered 429. */
  limited: number;
  /** Anything else (a 503: the store failed). */
  failed: number;
}

/** Starts one child; answers once it is connected. */
async function startChild(
  target: Target,
  now: number,
  namespace: string,
  clock: "process" | "store",
  algorithm: "fixed-window" | "sliding-window",
) {
  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      "child",
      JSON.stringify(target),
      String(now),
      namespace,
      clock,
      algorithm,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
  let buffered = "";
  const line = async (index: number): Promise<string> => {
    for (;;) {
      const lines = buffered.split("\n").filter(Boolean);
      if (lines.length > index) return lines[index];
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the child exited early");
      buffered += decoder.decode(chunk.value);
    }
  };
  await line(0);
  return {
    release: async () => {
      await child.stdin.end();
    },
    finished: async (): Promise<Counts> => {
      const counts = JSON.parse(await line(1)) as Counts;
      await child.exited;
      return counts;
    },
  };
}

/**
 * Runs two children on `target` in `namespaces`, each with its own clock
 * (`offsets` from the start of the hour), and answers their totals. Waits
 * out the last 15 s of an hour first, so a proof timed by the backend's
 * clock never straddles the hour's edge.
 */
async function race(
  target: Target,
  namespaces: readonly [string, string],
  clock: "process" | "store" = "store",
  offsets: readonly [number, number] = [1_000, 1_000],
  algorithm: "fixed-window" | "sliding-window" = "sliding-window",
): Promise<{ total: Counts; each: Counts[] }> {
  const left = HOUR - (Date.now() % HOUR);
  if (left < 15_000) await Bun.sleep(left + 250);
  const hour = Math.floor(Date.now() / HOUR) * HOUR;
  const children = await Promise.all(
    namespaces.map(async (namespace, index) =>
      startChild(target, hour + offsets[index], namespace, clock, algorithm),
    ),
  );
  await Promise.all(children.map(async (child) => child.release()));
  const each = await Promise.all(
    children.map(async (child) => child.finished()),
  );
  const total = each.reduce(
    (sum, counts) => ({
      allowed: sum.allowed + counts.allowed,
      limited: sum.limited + counts.limited,
      failed: sum.failed + counts.failed,
    }),
    { allowed: 0, limited: 0, failed: 0 },
  );
  return { total, each };
}

/** The proof on one backend, and its control. */
async function prove(target: Target): Promise<void> {
  step(`${target.backend}: two processes, limit ${LIMIT} each`);
  const shared = await race(target, ["shared", "shared"]);
  show(`per process ${JSON.stringify(shared.each)}`);
  checkEqual(
    `one namespace: exactly ${LIMIT} of ${2 * REQUESTS} allowed`,
    shared.total,
    { allowed: LIMIT, limited: 2 * REQUESTS - LIMIT, failed: 0 },
  );
  const apart = await race(target, ["apart-a", "apart-b"]);
  checkEqual(
    `two namespaces (the control): each counts alone, ${2 * LIMIT} allowed`,
    apart.total,
    { allowed: 2 * LIMIT, limited: 2 * REQUESTS - 2 * LIMIT, failed: 0 },
  );
  // Clocks a minute either side of the hour: one process in each hour. The
  // fixed window, whose windows share nothing, shows the difference whole.
  const skew = [-60_000, 60_000] as const;
  const skewed = await race(
    target,
    ["skew", "skew"],
    "store",
    skew,
    "fixed-window",
  );
  checkEqual(
    `clocks 2 minutes apart, across the hour, counted by the backend's clock: still ${LIMIT}`,
    skewed.total,
    { allowed: LIMIT, limited: 2 * REQUESTS - LIMIT, failed: 0 },
  );
  const local = await race(
    target,
    ["skew-local", "skew-local"],
    "process",
    skew,
    "fixed-window",
  );
  checkEqual(
    `the same clocks counted by each process's own (clock: "process"): two windows, ${2 * LIMIT}`,
    local.total,
    { allowed: 2 * LIMIT, limited: 2 * REQUESTS - 2 * LIMIT, failed: 0 },
  );
}

title("bun-cache throttle store: one limit across two processes");

const dir = await mkdtemp(join(tmpdir(), "bun-cache-example-"));
try {
  const target: Target = {
    backend: "sqlite",
    location: join(dir, "cache.db"),
    prefix: "",
  };
  // The schema exists before either child opens the file.
  const setup = driverFor(target);
  await setup.connect?.();
  await setup.close();
  await prove(target);
} finally {
  await rm(dir, { recursive: true, force: true });
}

const redisUrl =
  process.env.EXAMPLE_REDIS_URL ?? process.env.BUN_CACHE_TEST_REDIS_URL;
if (redisUrl) {
  const prefix = `bun-cache-example:${process.pid}-throttle`;
  const raw = new RedisClient(redisUrl);
  try {
    await raw.connect();
    await prove({ backend: "redis", location: redisUrl, prefix });
  } finally {
    // Every key this run created: a SCAN of exactly its prefix.
    let cursor = "0";
    let deleted = 0;
    do {
      const [next, keys] = (await raw.send("SCAN", [
        cursor,
        "MATCH",
        `${prefix}:*`,
        "COUNT",
        "1000",
      ])) as [string, string[]];
      cursor = next;
      if (keys.length > 0) deleted += await raw.unlink(...keys);
    } while (cursor !== "0");
    show(`deleted this run's ${deleted} Redis keys (${prefix}:*)`);
    raw.close();
  }
} else {
  step("redis");
  show("sat out: set EXAMPLE_REDIS_URL to run it");
}

const postgresUrl =
  process.env.EXAMPLE_POSTGRES_URL ?? process.env.BUN_CACHE_TEST_POSTGRES_URL;
if (postgresUrl) {
  const prefix = `bun_cache_example_${process.pid}_throttle_`;
  // The tables exist before either child connects, so the two never race
  // to create them.
  const setup = postgresDriver({ url: postgresUrl, prefix });
  await setup.connect!();
  await setup.close();
  try {
    await prove({ backend: "postgres", location: postgresUrl, prefix });
  } finally {
    const raw = new SQL(postgresUrl);
    for (const table of ["entries", "tags", "stamps", "locks", "bus"]) {
      await raw.unsafe(`DROP TABLE IF EXISTS ${prefix}${table}`);
    }
    await raw.close();
    show(`dropped this run's tables (${prefix}*)`);
  }
} else {
  step("postgres");
  show("sat out: set EXAMPLE_POSTGRES_URL to run it");
}

summary();
