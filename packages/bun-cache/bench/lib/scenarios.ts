import type {
  CacheContender,
  CacheHandle,
  Measurement,
  Scenario,
  SetupContext,
  TierHandle,
} from "./types";
import process from "node:process";
import { nextTurn, sharedNow } from "./harness";
import { isValue, valueOf } from "./payload";
import { rate, summarise } from "./stats";

/**
 * The scenarios of plan §15.1, each run inside one child process for one
 * contender. Every scenario checks what it read, so a contender cannot look
 * fast by being wrong: a miss where a hit was due, a value served after its
 * tag was invalidated, or a write the second process never saw is a `failed`
 * row, never a figure.
 */

/** How large each scenario is. */
export interface ScenarioConfig {
  /** Operations per throughput scenario on a networked or file backend; ten times as many on memory. */
  ops: number;
  /** Rounds of `stampede` and `tags-invalidate`. */
  rounds: number;
  /** Writes timed across two processes in `tier-invalidate`. */
  samples: number;
  /** How a child re-invokes the entry script as the second process of `tier-invalidate`. */
  peer: { script: string; args: string[] };
}

/** Callers per `stampede` round (§15.1). */
const STAMPEDE_CALLERS = 1000;
/** The `stampede` loader's duration, in ms (§15.1). */
const STAMPEDE_LOADER_MS = 20;
/** Tagged keys per `tags-invalidate` round (§15.1). */
const INVALIDATE_KEYS = 1000;
/** How long the second process may take to see a write, in ms, before `tier-invalidate` fails. */
const PEER_DEADLINE_MS = 5000;

/** The payload size of each get/set scenario. */
const SIZE: Partial<Record<Scenario, number>> = {
  "get-hit-100b": 100,
  "get-hit-10kb": 10 * 1024,
  "get-hit-1mb": 1024 * 1024,
  "set-100b": 100,
  "set-10kb": 10 * 1024,
  "set-1mb": 1024 * 1024,
};

/** A run that produced a wrong answer. */
class WrongAnswer extends Error {}

/** Throws a {@link WrongAnswer} unless `ok`. */
function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new WrongAnswer(message);
}

/** How many operations a throughput scenario runs on this contender. */
function opsFor(
  contender: CacheContender,
  scenario: Scenario,
  config: ScenarioConfig,
): number {
  const base = contender.backend === "memory" ? config.ops * 10 : config.ops;
  if (scenario === "get-hit-1mb" || scenario === "set-1mb") {
    return Math.max(20, Math.floor(base / 40));
  }
  if (scenario === "get-many-100" || scenario === "set-many-100") {
    return Math.max(20, Math.floor(base / 20));
  }
  if (scenario === "tier-hit") return config.ops * 10;
  return base;
}

/** Timed trials per throughput scenario; the figure is the best one. */
const TRIALS = 5;
/** A trial runs at least this long, so a fast op is not timed over a few milliseconds. */
const TRIAL_MIN_MS = 100;
/** A trial stops here even short of its count, so a slow op does not hold the run for minutes. */
const TRIAL_MAX_MS = 2000;
/** The warm-up runs at least this long, so the JIT has tiered the path before anything is timed. */
const WARM_MIN_MS = 250;

/** What a throughput scenario measured. */
interface Throughput {
  /** The best trial, in operations per second. */
  opsPerSec: number;
  /** Operations timed, over every trial. */
  count: number;
  /** Milliseconds timed, over every trial. */
  elapsedMs: number;
}

/**
 * Times sequential runs of `op`: an untimed warm-up (a tenth of `count`, and
 * at least {@link WARM_MIN_MS}), then {@link TRIALS} trials of `count` ops
 * (each at least {@link TRIAL_MIN_MS}, at most {@link TRIAL_MAX_MS}), and
 * answers the **best** trial. Interference — another process on the core, a
 * database flushing for someone else, a GC — only ever slows a trial, so the
 * best is the trial it moved least; a first recording that took one trial
 * each varied by 0.75x to 1.42x between two runs of one build (10th to 90th
 * percentile), and a guard on that cries wolf.
 */
async function throughput(
  count: number,
  op: (index: number) => Promise<void>,
): Promise<Throughput> {
  // The index runs on through every loop, so an op that needs a fresh key
  // per call (a miss) never repeats one an earlier loop used.
  let index = 0;
  const warm = Math.max(10, Math.floor(count / 10));
  const warmStarted = performance.now();
  while (index < warm || performance.now() - warmStarted < WARM_MIN_MS) {
    await op(index++);
  }

  let best = 0;
  let total = 0;
  let elapsed = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    let done = 0;
    const started = performance.now();
    let took: number;
    for (;;) {
      await op(index++);
      done++;
      took = performance.now() - started;
      if (took >= TRIAL_MAX_MS && done >= 5) break;
      if (done >= count && took >= TRIAL_MIN_MS) break;
    }
    best = Math.max(best, rate(done, took));
    total += done;
    elapsed += took;
  }
  return { opsPerSec: best, count: total, elapsedMs: elapsed };
}

/** A throughput measurement. */
function opsMeasurement(
  identity: Pick<Measurement, "contender" | "scenario" | "backend">,
  result: Throughput,
): Measurement {
  return {
    ...identity,
    count: result.count,
    elapsedMs: result.elapsedMs,
    opsPerSec: result.opsPerSec,
    figure: { value: result.opsPerSec, higherIsBetter: true, label: "ops/s" },
  };
}

/** The get/set scenarios at one payload size, and `get-miss`. */
async function getSet(
  cache: CacheHandle,
  scenario: Scenario,
  count: number,
): Promise<Throughput> {
  if (scenario === "get-miss") {
    return throughput(count, async (index) => {
      check(
        (await cache.get(`miss:${index}`)) === undefined,
        "a key never written was a hit",
      );
    });
  }

  const bytes = SIZE[scenario]!;
  const keys = Array.from(
    { length: bytes >= 1024 * 1024 ? 10 : 100 },
    (_, index) => `kv:${index}`,
  );

  if (scenario.startsWith("get-hit")) {
    for (const [index, key] of keys.entries()) {
      await cache.set(key, valueOf(bytes, index));
    }
    return throughput(count, async (index) => {
      const slot = index % keys.length;
      check(
        isValue(await cache.get(keys[slot]), slot),
        `a written key (${keys[slot]}) was not served back`,
      );
    });
  }

  const value = valueOf(bytes, 7);
  const result = await throughput(count, async (index) => {
    await cache.set(keys[index % keys.length], value);
  });
  check(isValue(await cache.get(keys[0]), 7), "a set was not readable after");
  return result;
}

/** `get-many-100` and `set-many-100`. */
async function many(
  cache: CacheHandle,
  scenario: Scenario,
  count: number,
): Promise<Throughput> {
  const keys = Array.from({ length: 100 }, (_, index) => `many:${index}`);
  const entries = keys.map((key, index) => [key, valueOf(100, index)] as const);

  if (scenario === "set-many-100") {
    const result = await throughput(count, async () => {
      await cache.setMany!(entries);
    });
    const read = await cache.getMany!(keys);
    check(
      read.every((value, index) => isValue(value, index)),
      "a setMany entry was not readable after",
    );
    return result;
  }

  await cache.setMany!(entries);
  return throughput(count, async () => {
    const read = await cache.getMany!(keys);
    check(
      read.length === 100 && isValue(read[0], 0) && isValue(read[99], 99),
      "getMany did not answer every written key",
    );
  });
}

/**
 * `stampede`: 1000 concurrent `getOrSet` misses on one key, a 20 ms loader.
 * The figure is the best round's p99 of the callers' latencies; the loader's
 * calls are reported beside it,
 * and more than one fails bun-cache's run (single-flight is its claim).
 */
async function stampede(
  identity: Pick<Measurement, "contender" | "scenario" | "backend">,
  cache: CacheHandle,
  config: ScenarioConfig,
  ours: boolean,
): Promise<Measurement> {
  const latencies: number[] = [];
  const roundP99s: number[] = [];
  let worstCalls = 0;
  let elapsedMs = 0;

  // Round 0 warms the code path and the connection, and is not counted.
  for (let round = 0; round <= config.rounds; round++) {
    let calls = 0;
    const loader = async (): Promise<unknown> => {
      calls++;
      await Bun.sleep(STAMPEDE_LOADER_MS);
      return valueOf(100, round);
    };
    const key = `stampede:${round}`;
    const started = performance.now();
    const answers = await Promise.all(
      Array.from({ length: STAMPEDE_CALLERS }, async () => {
        const value = await cache.getOrSet!(key, loader);
        return { value, at: performance.now() - started };
      }),
    );
    const roundMs = performance.now() - started;
    check(
      answers.every(({ value }) => isValue(value, round)),
      "a stampede caller was not answered the loaded value",
    );
    if (round === 0) continue;
    elapsedMs += roundMs;
    worstCalls = Math.max(worstCalls, calls);
    for (const { at } of answers) latencies.push(at);
    roundP99s.push(summarise(answers.map(({ at }) => at)).p99);
  }

  check(
    !ours || worstCalls === 1,
    `the loader ran ${worstCalls} times for ${STAMPEDE_CALLERS} concurrent callers (single-flight is one)`,
  );
  const latency = summarise(latencies);
  return {
    ...identity,
    count: latencies.length,
    elapsedMs,
    latency,
    loaderCalls: worstCalls,
    // The best round's p99, for the reason throughput takes its best trial.
    figure: {
      value: Math.min(...roundP99s),
      higherIsBetter: false,
      label: "p99",
    },
  };
}

/** `tags-set`: sets carrying two tags each. */
async function tagsSet(cache: CacheHandle, count: number): Promise<Throughput> {
  const value = valueOf(100, 3);
  const result = await throughput(count, async (index) => {
    await cache.set(`tagged:${index % 1000}`, value, [
      "all",
      `group-${index % 10}`,
    ]);
  });
  check(
    isValue(await cache.get("tagged:0"), 3),
    "a tagged set was not readable after",
  );
  return result;
}

/**
 * `tags-invalidate`: 1000 keys carrying one tag, then `invalidateTags` of it.
 * The figure is the fastest round's call; after each round a spread of the
 * keys must read as misses.
 */
async function tagsInvalidate(
  identity: Pick<Measurement, "contender" | "scenario" | "backend">,
  cache: CacheHandle,
  config: ScenarioConfig,
): Promise<Measurement> {
  const durations: number[] = [];
  const value = valueOf(100, 5);

  for (let round = 0; round <= config.rounds; round++) {
    const tag = `round-${round}`;
    for (let index = 0; index < INVALIDATE_KEYS; index++) {
      await cache.set(`inv:${round}:${index}`, value, [tag]);
    }
    check(
      isValue(await cache.get(`inv:${round}:0`), 5),
      "a tagged key was not readable before its invalidation",
    );
    const started = performance.now();
    await cache.invalidateTags!([tag]);
    const took = performance.now() - started;

    let served = 0;
    for (let index = 0; index < INVALIDATE_KEYS; index += 50) {
      if ((await cache.get(`inv:${round}:${index}`)) !== undefined) served++;
    }
    check(
      served === 0,
      `${served} of ${INVALIDATE_KEYS / 50} sampled keys were still served after invalidateTags`,
    );
    if (round > 0) durations.push(took);
  }

  const latency = summarise(durations);
  return {
    ...identity,
    count: durations.length,
    elapsedMs: durations.reduce((sum, each) => sum + each, 0),
    latency,
    // The fastest round, for the reason throughput takes its best trial.
    figure: {
      value: Math.min(...durations),
      higherIsBetter: false,
      label: "best",
    },
  };
}

/** `tier-hit`: reads of hot keys through the memory tier, with the bus connected. */
async function tierHit(tier: TierHandle, count: number): Promise<Throughput> {
  const keys = Array.from({ length: 100 }, (_, index) => `hot:${index}`);
  for (const [index, key] of keys.entries()) {
    await tier.set(key, valueOf(100, index));
  }
  return throughput(count, async (index) => {
    const slot = index % keys.length;
    check(
      isValue(await tier.get(keys[slot]), slot),
      "a hot key was not served",
    );
  });
}

/** What the second process of `tier-invalidate` sends back. */
interface PeerMessage {
  /** `ready` once its memory tier holds the key; `saw` when it first reads a new value. */
  type: "ready" | "saw";
  /** The value's id it read. */
  id: number;
  /** When it read it, on {@link sharedNow}'s clock. */
  at: number;
}

/**
 * `tier-invalidate`: this process writes, a second process holding the key
 * in its memory tier reads it in a loop, and the figure is the median time
 * from the write starting to the second process first reading the new value
 * — the bus delivering, the copy dropped, one read of the shared tier.
 */
async function tierInvalidate(
  identity: Pick<Measurement, "contender" | "scenario" | "backend">,
  tier: TierHandle,
  config: ScenarioConfig,
): Promise<Measurement> {
  const key = "tier:shared";
  await tier.set(key, valueOf(100, 0));

  const seen = new Map<number, number>();
  let wake: (() => void) | undefined;
  const peer = Bun.spawn(
    [process.execPath, config.peer.script, ...config.peer.args],
    {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, BUN_CACHE_BENCH_CHILD: "1" },
      ipc(message: PeerMessage) {
        seen.set(message.type === "ready" ? -1 : message.id, message.at);
        wake?.();
      },
    },
  );

  /** Resolves when the peer has reported `id`, or rejects past the deadline. */
  const waitFor = async (id: number): Promise<number> => {
    const deadline = Date.now() + PEER_DEADLINE_MS;
    while (!seen.has(id)) {
      check(
        Date.now() < deadline,
        id < 0
          ? "the second process never got ready"
          : `the second process never saw write ${id} within ${PEER_DEADLINE_MS} ms: its memory tier kept the old value`,
      );
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 50);
      });
    }
    return seen.get(id)!;
  };

  try {
    await waitFor(-1);
    const samples: number[] = [];
    // Three unmeasured writes first, so a cold connection is not a sample.
    for (let id = 1; id <= config.samples + 3; id++) {
      await Bun.sleep(20);
      const started = sharedNow();
      await tier.set(key, valueOf(100, id));
      const at = await waitFor(id);
      if (id > 3) samples.push(at - started);
    }
    const latency = summarise(samples);
    return {
      ...identity,
      count: samples.length,
      elapsedMs: samples.reduce((sum, each) => sum + each, 0),
      latency,
      figure: { value: latency.p50, higherIsBetter: false, label: "p50" },
    };
  } finally {
    peer.kill();
    await peer.exited;
  }
}

/**
 * The second process of `tier-invalidate`: holds the key in its memory tier,
 * reads it on every turn of the event loop (so the bus's socket gets its
 * turn), and reports each new value the moment it first reads it.
 */
export async function runPeer(
  contender: CacheContender,
  ctx: SetupContext,
): Promise<never> {
  const tier = await contender.tier!(ctx, "reader");
  const key = "tier:shared";
  let last = -1;

  for (;;) {
    const read = (await tier.get(key)) as { id?: number } | undefined;
    const id = typeof read?.id === "number" ? read.id : -1;
    if (id !== last) {
      const at = sharedNow();
      if (last === -1 && id === 0) {
        // A second read, so the copy is in the memory tier before the first write.
        await tier.get(key);
        process.send?.({ type: "ready", id, at } satisfies PeerMessage);
      } else {
        process.send?.({ type: "saw", id, at } satisfies PeerMessage);
      }
      last = id;
    }
    await nextTurn();
  }
}

/** The HTTP scenarios, through `router.fetch()` in this process. */
async function http(
  contender: CacheContender,
  scenario: Scenario,
  ctx: SetupContext,
  count: number,
): Promise<Throughput> {
  const handle = await contender.http!(ctx);
  try {
    if (scenario === "http-uncached") {
      return await throughput(count, async () => {
        const response = await handle.fetch("/uncached");
        check(response.status === 200, `/uncached answered ${response.status}`);
        await response.arrayBuffer();
      });
    }

    if (scenario === "http-miss") {
      return await throughput(count, async (index) => {
        const response = await handle.fetch(`/cached?page=${index}`);
        check(
          response.headers.get("x-cache") === "MISS",
          `a new query answered X-Cache ${response.headers.get("x-cache")}`,
        );
        await response.arrayBuffer();
      });
    }

    // Prime the entry: the miss answers before its write lands, so ask until a hit.
    let etag: string | null = null;
    const deadline = Date.now() + 5000;
    for (;;) {
      const response = await handle.fetch("/cached");
      await response.arrayBuffer();
      if (response.headers.get("x-cache") === "HIT") {
        etag = response.headers.get("etag");
        break;
      }
      check(Date.now() < deadline, "/cached never became a hit");
      await Bun.sleep(5);
    }

    if (scenario === "http-304") {
      check(etag !== null, "a cached response carried no ETag");
      const headers = { "if-none-match": etag };
      return await throughput(count, async () => {
        const response = await handle.fetch("/cached", { headers });
        check(
          response.status === 304,
          `a matching ETag answered ${response.status}`,
        );
        await response.arrayBuffer();
      });
    }

    return await throughput(count, async () => {
      const response = await handle.fetch("/cached");
      check(
        response.headers.get("x-cache") === "HIT",
        `a cached route answered X-Cache ${response.headers.get("x-cache")}`,
      );
      await response.arrayBuffer();
    });
  } finally {
    await handle.close();
  }
}

/** Runs one scenario for one contender, in this process. */
export async function runScenario(
  contender: CacheContender,
  scenario: Scenario,
  ctx: SetupContext,
  config: ScenarioConfig,
): Promise<Measurement> {
  const identity = {
    contender: contender.id,
    scenario,
    backend: contender.backend,
  };
  const count = opsFor(contender, scenario, config);

  try {
    if (scenario.startsWith("http-")) {
      return opsMeasurement(
        identity,
        await http(contender, scenario, ctx, count),
      );
    }

    if (scenario.startsWith("tier-")) {
      const tier = await contender.tier!(ctx, "writer");
      try {
        return scenario === "tier-hit"
          ? opsMeasurement(identity, await tierHit(tier, count))
          : await tierInvalidate(identity, tier, config);
      } finally {
        await tier.close();
      }
    }

    const cache = await contender.setup!(ctx);
    try {
      switch (scenario) {
        case "stampede":
          return await stampede(
            identity,
            cache,
            config,
            contender.ours === true,
          );
        case "tags-invalidate":
          return await tagsInvalidate(identity, cache, config);
        case "tags-set":
          return opsMeasurement(identity, await tagsSet(cache, count));
        case "get-many-100":
        case "set-many-100":
          return opsMeasurement(identity, await many(cache, scenario, count));
        default:
          return opsMeasurement(identity, await getSet(cache, scenario, count));
      }
    } finally {
      await cache.close();
    }
  } catch (error) {
    return {
      ...identity,
      count: 0,
      elapsedMs: 0,
      failed:
        error instanceof WrongAnswer
          ? `wrong answer: ${error.message}`
          : `threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
