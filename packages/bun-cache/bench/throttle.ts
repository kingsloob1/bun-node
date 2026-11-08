/* eslint-disable antfu/no-top-level-await, n/no-top-level-await, no-console */
/**
 * The throttle's per-request overhead (approved by the maintainer,
 * 2026-11-08): a `BunRouter` serving one `GET` through `router.fetch()` (the
 * production pipeline, no socket, so nothing but the router and the
 * throttle is timed), with no throttle, with bun-common's
 * `throttle()` over its default memory store, and over bun-cache's
 * `cacheThrottleStore()` on Redis (the store's default `clock: "store"`, one
 * Lua script per limit), each with one limit and with three. Headers off
 * (the default), the sliding window (the default), a limit no client
 * reaches, 1,000 clients in turn: the allowed path, which is every request's.
 *
 *   cd packages/bun-cache/bench
 *   bun throttle.ts                    # print the table
 *   bun throttle.ts --compare          # fail if a cell regressed (below)
 *   bun throttle.ts --save-baseline    # record baselines/throttle.json
 *   bun throttle.ts --json             # the cells as JSON
 *
 * Each cell runs in a fresh process (`--cell <name>`): a warm-up, then five
 * trials of each of two measures, the median kept:
 *
 * - **sequential**: µs per request with one in flight, the latency a request
 *   pays;
 * - **concurrent**: requests/s with 64 in flight, what a busy server gets
 *   (Redis pipelines the concurrent scripts on its one connection).
 *
 * `--compare` fails when a cell's concurrent requests/s falls more than 35%
 * behind its baseline (the tolerance bun-jobs' guard uses), or when its
 * ratio to the unthrottled cell of the same run falls more than 20% below
 * the baseline's ratio. The second is the sharper check: a busy machine
 * slows the throttled cell and the unthrottled one alike.
 *
 * Redis is `BUN_CACHE_BENCH_REDIS_URL` (default database 12, the bench's
 * own); every key a cell writes is under its own run id, deleted by that
 * prefix when the cell ends. A Redis that does not answer is named, and its
 * cells skipped. Like every benchmark here: through the heavy-run wrapper,
 * exclusive, and only with the maintainer's yes.
 */
import { join } from "node:path";
import process from "node:process";
import { BunRouter } from "@kingsleyweb/bun-common";
import type { ThrottleOptions } from "@kingsleyweb/bun-common";
import { createCache, redisDriver } from "../lib/index";
import { cacheThrottleStore } from "../lib/throttle/index";
import { deleteRedisPrefix } from "./lib/cleanup";
import { backendUrl } from "./lib/env";

const SELF = import.meta.path;
const BASELINE = join(import.meta.dir, "baselines/throttle.json");

/** Every cell, in the order they run and print. */
const CELLS = ["none", "memory-1", "memory-3", "redis-1", "redis-3"] as const;
type CellName = (typeof CELLS)[number];

/** What one cell measured. */
interface Cell {
  /** The cell. */
  name: CellName;
  /** Median µs per request, one in flight. */
  sequentialUs: number;
  /** Median requests/s, {@link CONCURRENCY} in flight. */
  concurrentRps: number;
}

/** Requests in flight for the concurrent measure. */
const CONCURRENCY = 64;
/** Distinct clients, taken in turn. */
const CLIENTS = 1_000;
/** Trials of each measure; the median is kept. */
const TRIALS = 5;

/** The median of a sample. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The throttle's limits: one, or three of different windows. */
function limitsOf(count: 1 | 3): ThrottleOptions["limits"] {
  return count === 1
    ? { default: { limit: 1_000_000_000, window: "1m" } }
    : {
        burst: { limit: 1_000_000_000, window: "1s" },
        sustained: { limit: 1_000_000_000, window: "1m" },
        daily: { limit: 1_000_000_000, window: "1h" },
      };
}

/** Runs one cell in this process and prints its JSON. */
async function runCell(name: CellName): Promise<void> {
  const [kind, count] = name.split("-") as [string, "1" | "3" | undefined];
  const prefix = `bench-throttle-${process.pid}-${Date.now()}`;
  const url = backendUrl("redis");
  const cache =
    kind === "redis"
      ? createCache({ driver: redisDriver({ url, prefix }), sweepInterval: 0 })
      : undefined;
  let client = 0;
  const router = new BunRouter(
    kind === "none"
      ? {}
      : {
          throttle: {
            limits: limitsOf(Number(count) as 1 | 3),
            key: () => `client-${client++ % CLIENTS}`,
            ...(cache === undefined
              ? {}
              : { store: cacheThrottleStore(cache) }),
          },
        },
  );
  router.get("/", (_req, res) => {
    res.send("ok");
  });
  const one = async (): Promise<void> => {
    const answer = await router.fetch("/");
    if (answer.status !== 200) {
      throw new Error(`${name}: answered ${answer.status}`);
    }
    await answer.arrayBuffer();
  };
  if (cache !== undefined) {
    // A cell stopped from outside (the wrapper's timeout) still deletes its keys.
    process.once("SIGTERM", () => {
      void deleteRedisPrefix(url, prefix).finally(() => process.exit(143));
    });
  }
  const fast = kind !== "redis";
  const sequentialCount = fast ? 10_000 : 2_000;
  const concurrentCount = fast ? 20_000 : 10_000;
  try {
    for (let i = 0; i < 1_000; i++) await one();
    const sequential: number[] = [];
    const concurrent: number[] = [];
    for (let trial = 0; trial < TRIALS; trial++) {
      let start = performance.now();
      for (let i = 0; i < sequentialCount; i++) await one();
      sequential.push(((performance.now() - start) * 1000) / sequentialCount);
      start = performance.now();
      let issued = 0;
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          while (issued < concurrentCount) {
            issued++;
            await one();
          }
        }),
      );
      concurrent.push((concurrentCount * 1000) / (performance.now() - start));
    }
    const cell: Cell = {
      name,
      sequentialUs: Math.round(median(sequential) * 100) / 100,
      concurrentRps: Math.round(median(concurrent)),
    };
    console.log(JSON.stringify(cell));
  } finally {
    if (cache !== undefined) {
      await cache.close();
      await deleteRedisPrefix(url, prefix);
    }
  }
}

/** Whether the bench's Redis answers; the error when it does not. */
async function redisError(): Promise<string | undefined> {
  const { RedisClient } = await import("bun");
  const client = new RedisClient(backendUrl("redis"), {
    connectionTimeout: 2_000,
    autoReconnect: false,
  });
  try {
    await client.send("PING", []);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    client.close();
  }
}

/** Runs a cell in a fresh process. */
async function cell(name: CellName): Promise<Cell> {
  const child = Bun.spawn(["bun", SELF, "--cell", name], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`${name}: the cell exited ${code}`);
  return JSON.parse(out.trim().split("\n").at(-1)!) as Cell;
}

/** The table, the baseline or the comparison. */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const down = await redisError();
  if (down !== undefined && !json) {
    console.log(
      `redis (${backendUrl("redis")}) does not answer: ${down}; its cells are skipped`,
    );
  }
  const cells: Cell[] = [];
  for (const name of CELLS) {
    if (name.startsWith("redis") && down !== undefined) continue;
    const measured = await cell(name);
    cells.push(measured);
    if (!json) {
      const none = cells.find((c) => c.name === "none");
      const overhead =
        none === undefined || name === "none"
          ? ""
          : `  +${(measured.sequentialUs - none.sequentialUs).toFixed(2)} µs/req, ${(measured.concurrentRps / none.concurrentRps).toFixed(2)}× of none`;
      console.log(
        `${name.padEnd(9)} ${measured.sequentialUs.toFixed(2).padStart(8)} µs/req sequential ${String(measured.concurrentRps).padStart(9)} req/s at ${CONCURRENCY}${overhead}`,
      );
    }
  }
  if (json) console.log(JSON.stringify(cells, null, 2));
  if (args.includes("--save-baseline")) {
    const { loadavg } = await import("node:os");
    await Bun.write(
      BASELINE,
      `${JSON.stringify(
        {
          bun: Bun.revision,
          platform: `${process.platform}-${process.arch}`,
          date: new Date().toISOString(),
          load: loadavg()[0],
          cells,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`baseline written: ${BASELINE}`);
    return 0;
  }
  if (!args.includes("--compare")) return 0;
  const file = Bun.file(BASELINE);
  if (!(await file.exists())) {
    console.log("no baseline recorded (baselines/throttle.json)");
    return 1;
  }
  const baseline = (await file.json()) as { cells: Cell[] };
  const noneNow = cells.find((c) => c.name === "none");
  const noneThen = baseline.cells.find((c) => c.name === "none");
  const failures: string[] = [];
  for (const now of cells) {
    const then = baseline.cells.find((c) => c.name === now.name);
    if (then === undefined) continue;
    if (now.concurrentRps < then.concurrentRps * 0.65) {
      failures.push(
        `${now.name}: ${now.concurrentRps} req/s, more than 35% behind its baseline ${then.concurrentRps}`,
      );
    }
    if (
      now.name !== "none" &&
      noneNow !== undefined &&
      noneThen !== undefined
    ) {
      const ratioNow = now.concurrentRps / noneNow.concurrentRps;
      const ratioThen = then.concurrentRps / noneThen.concurrentRps;
      if (ratioNow < ratioThen * 0.8) {
        failures.push(
          `${now.name}: ${ratioNow.toFixed(2)}× of the unthrottled cell, against ${ratioThen.toFixed(2)}× in the baseline`,
        );
      }
    }
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  if (failures.length === 0) console.log("throttle: no regression");
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[2] === "--cell") {
  await runCell(process.argv[3] as CellName);
  process.exit(0);
} else {
  process.exit(await main());
}
