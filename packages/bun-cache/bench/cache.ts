/* eslint-disable no-console -- a benchmark's output is its product */
/* eslint-disable n/no-top-level-await -- an entry point, imported by nothing */
import type { Baseline } from "./lib/compare";
import type { Backend, Measurement, Scenario, SetupContext } from "./lib/types";
import process from "node:process";
import { parseArgs } from "node:util";
import { cacheContenders } from "./contenders/index";
import { compare, reportComparison, toBaseline } from "./lib/compare";
import {
  backendAvailable,
  backendUrl,
  makeScratch,
  removeScratch,
  unavailableHint,
} from "./lib/env";
import { childArgs, emit, runChild } from "./lib/harness";
import { byBackend, leaders, table } from "./lib/report";
import { runPeer, runScenario } from "./lib/scenarios";
import { ALL_BACKENDS, ALL_SCENARIOS } from "./lib/types";

/**
 * Cache benchmarks (plan `docs/plans/bun-cache/` §15): `@kingsleyweb/bun-cache`
 * against cache-manager over Keyv's stores, lru-cache, BentoCache and
 * cacheable, on every backend this machine can reach.
 *
 *   bun cache.ts                          every scenario, every reachable backend
 *   bun cache.ts -s stampede -b redis     one scenario, one backend
 *   bun cache.ts --save-baseline          record baselines/cache.json
 *   bun cache.ts --compare                fail if anything regressed against it
 *
 * Results are grouped by backend and ranked only inside a group. Every
 * contender runs each scenario in its own freshly spawned process.
 */

/** What each scenario measures, for the report heading. */
const BLURB: Record<Scenario, string> = {
  "get-hit-100b":
    "get of a written key, 100 B values (ops/s, best of 5 trials)",
  "get-hit-10kb": "get of a written key, 10 KB values (ops/s)",
  "get-hit-1mb": "get of a written key, 1 MB values (ops/s)",
  "get-miss": "get of a key never written (ops/s)",
  "set-100b": "set, 100 B values (ops/s)",
  "set-10kb": "set, 10 KB values (ops/s)",
  "set-1mb": "set, 1 MB values (ops/s)",
  "get-many-100": "getMany / mget of 100 written keys (batches/s)",
  "set-many-100": "setMany / mset of 100 entries (batches/s)",
  stampede:
    "1000 concurrent getOrSet / wrap misses on one key, 20 ms loader (the best round's p99; loader calls)",
  "tags-set": "set carrying two tags (ops/s)",
  "tags-invalidate":
    "invalidateTags of one tag on 1000 keys (the fastest round), then the keys must miss",
  "tier-hit": "get through the L1 memory tier, the bus connected (ops/s)",
  "tier-invalidate":
    "a write in one process to the next read of it in a second process holding it in L1 (median)",
  "http-hit": "router.fetch() of a cached route, X-Cache: HIT (requests/s)",
  "http-304":
    "router.fetch() of a cached route with a matching If-None-Match (requests/s)",
  "http-miss":
    "router.fetch() of a cached route, a new query each time (requests/s)",
  "http-uncached":
    "router.fetch() of the same handler with no cache in front (requests/s)",
};

/** Prints the usage banner. */
function printHelp(): void {
  console.log(`
Usage: bun cache.ts [options]

Options:
  -s, --scenario <names>  Scenario(s): comma list or 'all'   (default: all)
                          ${ALL_SCENARIOS.join(" | ")}
  -c, --contenders <ids>  Contender(s): comma list or 'all'  (default: all)
  -b, --backends <names>  Backend(s): comma list or 'all'    (default: all)
                          ${ALL_BACKENDS.join(" | ")}
  -n, --ops <n>           Operations per throughput scenario on a networked or
                          file backend; ten times as many on memory (default: 2000)
      --rounds <n>        Rounds of stampede and tags-invalidate  (default: 7)
      --samples <n>       Timed writes in tier-invalidate         (default: 50)
      --budget <s>        Seconds before a child is abandoned     (default: 300)
      --verbose           Show each child's stderr
      --json              Emit raw JSON results
      --save-baseline     Record this run as baselines/cache.json
      --compare           Fail if anything regressed against baselines/cache.json
  -h, --help              Show this help
`);
}

const { values } = parseArgs({
  options: {
    scenario: { type: "string", short: "s", default: "all" },
    contenders: { type: "string", short: "c", default: "all" },
    backends: { type: "string", short: "b", default: "all" },
    ops: { type: "string", short: "n", default: "2000" },
    rounds: { type: "string", default: "7" },
    samples: { type: "string", default: "50" },
    budget: { type: "string", default: "300" },
    verbose: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "save-baseline": { type: "boolean", default: false },
    compare: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    // Internal: the driver re-invokes this file per contender and scenario,
    // and a tier-invalidate child re-invokes it as its second process.
    child: { type: "string" },
    "child-scenario": { type: "string" },
    peer: { type: "string" },
    run: { type: "string" },
  },
  allowPositionals: false,
});

if (values.help) {
  printHelp();
  process.exit(0);
}

/** Parses an integer option, falling back when it is absent or malformed. */
function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** How many times `--compare` re-measures a row that moved before it believes it. */
const RECHECKS = 2;

/**
 * Merges a re-measurement in: per contender and row, the better figure. A
 * wrong answer is kept, never replaced by a later pass: it is not noise.
 */
function keepBest(was: Measurement[], again: Measurement[]): Measurement[] {
  const merged = [...was];
  for (const measurement of again) {
    const at = merged.findIndex(
      (m) =>
        m.contender === measurement.contender &&
        m.scenario === measurement.scenario &&
        m.backend === measurement.backend,
    );
    const old = merged[at];
    const better =
      old?.figure !== undefined &&
      measurement.figure !== undefined &&
      (measurement.figure.higherIsBetter
        ? measurement.figure.value > old.figure.value
        : measurement.figure.value < old.figure.value);
    if (at === -1) merged.push(measurement);
    else if (better) merged[at] = measurement;
  }
  return merged;
}

/** Where the committed baseline lives. */
const BASELINE = new URL("baselines/cache.json", import.meta.url).pathname;

const config = {
  ops: Math.max(10, toInt(values.ops, 2000)),
  rounds: Math.max(1, toInt(values.rounds, 7)),
  samples: Math.max(1, toInt(values.samples, 50)),
  budget: Math.max(10, toInt(values.budget, 300)),
};

const registry = cacheContenders();

/** The ids of our own contenders, from the registry rather than guessed from an id. */
const OURS: ReadonlySet<string> = new Set(
  registry.filter((each) => each.ours).map((each) => each.id),
);

/** Splits a comma list, or returns every value when it reads "all". */
function select<T extends string>(
  raw: string | undefined,
  all: readonly T[],
): T[] {
  if (!raw || raw === "all") return [...all];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean) as T[];
}

/* ------------------------------------------------------------------ *
 * Child mode: one contender, one scenario, one JSON line
 * ------------------------------------------------------------------ */

if (values.child || values.peer) {
  const id = values.child ?? values.peer;
  const contender = registry.find((entry) => entry.id === id);
  if (!contender) {
    console.error(`Unknown contender: ${id}`);
    process.exit(1);
  }

  const run = String(values.run);
  const url = backendUrl(contender.backend);

  if (values.peer) {
    // The second process of tier-invalidate: it runs until the first kills
    // it, so it makes no scratch directory it would leave behind (the tier
    // backends, Redis and Postgres, need none).
    await runPeer(contender, { url, run, scratch: "" });
  }

  const scratch = makeScratch();
  const ctx: SetupContext = { url, run, scratch };
  const scenario = String(values["child-scenario"]) as Scenario;
  try {
    const measurement = await runScenario(contender, scenario, ctx, {
      ...config,
      peer: {
        script: import.meta.path,
        args: childArgs({ peer: contender.id, run }),
      },
    });
    emit([measurement]);
  } finally {
    removeScratch(scratch);
  }
  // Several of these libraries leave a reconnect timer or a pool behind that
  // would keep the process alive long after the figure is in hand.
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * Driver mode
 * ------------------------------------------------------------------ */

const scenarios = select<Scenario>(values.scenario, ALL_SCENARIOS);
const backends = select<Backend>(values.backends, ALL_BACKENDS);
for (const scenario of scenarios) {
  if (!ALL_SCENARIOS.includes(scenario)) {
    console.error(`Unknown scenario: "${scenario}"`);
    process.exit(1);
  }
}
for (const backend of backends) {
  if (!ALL_BACKENDS.includes(backend)) {
    console.error(`Unknown backend: "${backend}"`);
    process.exit(1);
  }
}
const wanted = select(
  values.contenders,
  registry.map((entry) => entry.id),
);
const chosen = registry.filter(
  (entry) => wanted.includes(entry.id) && backends.includes(entry.backend),
);
if (chosen.length === 0) {
  console.error("No contender matched the selection.");
  process.exit(1);
}

console.log(
  `\nBun ${Bun.version} (${Bun.revision.slice(0, 9)}) — cache benchmarks\n`,
);
console.log("Backends");
const reachable = new Set<Backend>();
for (const backend of [...new Set(chosen.map((entry) => entry.backend))]) {
  if (await backendAvailable(backend)) {
    reachable.add(backend);
    console.log(
      `  ok    ${backend.padEnd(9)} ${backendUrl(backend) || "(in this process)"}`,
    );
  } else {
    console.log(`  --    ${unavailableHint(backend)}`);
  }
}
const runnable = chosen.filter((entry) => reachable.has(entry.backend));
if (runnable.length === 0) {
  console.error("\nNo backend is reachable.");
  process.exit(1);
}

const context = {
  ours: OURS,
  labels: new Map(registry.map((entry) => [entry.id, entry.label])),
  notes: new Map(
    runnable.flatMap((entry) =>
      entry.note ? [[entry.id, entry.note] as const] : [],
    ),
  ),
};

/** A base for each child's run id: lowercase alphanumerics, unique to this invocation. */
const runBase = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let childIndex = 0;

/** Runs one contender in one scenario, in a child process of its own. */
async function measure(
  contender: (typeof runnable)[number],
  scenario: Scenario,
): Promise<Measurement[]> {
  const run = `${runBase}${(childIndex++).toString(36)}`;
  return await runChild(
    {
      script: import.meta.path,
      args: childArgs({
        child: contender.id,
        "child-scenario": scenario,
        run,
        ops: String(config.ops),
        rounds: String(config.rounds),
        samples: String(config.samples),
        budget: String(config.budget),
      }),
      timeoutMs: config.budget * 1000,
      verbose: !!values.verbose,
    },
    { contender: contender.id, scenario, backend: contender.backend },
  );
}

let all: Measurement[] = [];
for (const scenario of scenarios) {
  const takingPart = runnable.filter((entry) =>
    entry.scenarios.includes(scenario),
  );
  if (takingPart.length === 0) continue;
  if (!values.json) console.log(`\n\n══ ${scenario} ══  ${BLURB[scenario]}`);

  const results: Measurement[] = [];
  for (const contender of takingPart) {
    if (!values.json) process.stdout.write(".");
    results.push(...(await measure(contender, scenario)));
  }
  all.push(...results);

  if (values.json) continue;
  process.stdout.write("\n");
  for (const [backend, group] of byBackend(results)) {
    console.log(`\n  ── ${backend} ──`);
    table(group, context);
  }
}

const recorded = toBaseline(all, {
  bun: `${Bun.version}+${Bun.revision.slice(0, 9)}`,
  ops: config.ops,
  ours: OURS,
});

if (values.json) {
  console.log(
    JSON.stringify({ bun: recorded.bun, config, results: all }, null, 2),
  );
} else {
  leaders(recorded.entries, context.labels);
}

const failed = all.filter((m) => m.failed && OURS.has(m.contender));

if (values["save-baseline"]) {
  // A failed run of ours is a finding, not a figure: it is recorded as such,
  // and said out loud, so the baseline's hole is in plain sight.
  if (failed.length > 0) {
    recorded.failed = Object.fromEntries(
      failed.map((m) => [`${m.scenario}/${m.backend}`, m.failed!]),
    );
    console.log(
      `\n${failed.length} of bun-cache's runs failed; recorded under "failed", not guarded:`,
    );
    for (const m of failed) {
      console.log(
        `  FAIL  ${`${m.scenario}/${m.backend}`.padEnd(30)} ${m.failed}`,
      );
    }
  }
  await Bun.write(BASELINE, `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(
    `\nRecorded ${Object.keys(recorded.entries).length} figures to ${BASELINE}.\n`,
  );
  process.exit(0);
}

if (values.compare) {
  const file = Bun.file(BASELINE);
  if (!(await file.exists())) {
    console.log(
      `\nNo baseline at ${BASELINE}. Record one with --save-baseline.\n`,
    );
    process.exit(1);
  }
  const baseline = (await file.json()) as Baseline;
  let regressions = compare(baseline, all, OURS);
  // A figure that moved is measured again, every contender of its row in a
  // fresh process, up to RECHECKS times, keeping each contender's best. A
  // child that lands beside a busy hyperthread runs at half speed for its
  // whole life, which best-of-five inside it cannot undo (measured: one such
  // row in 205, between two runs of one tree); a real regression is slow
  // in every process, and stays.
  for (
    let recheck = 1;
    recheck <= RECHECKS && regressions.some((r) => r.kind !== "missing");
    recheck++
  ) {
    // A missing figure is a run that failed or answered wrongly: that is
    // not noise, and is never re-measured away.
    const rows = new Set(
      regressions.filter((r) => r.kind !== "missing").map((r) => r.key),
    );
    console.log(
      `\nRe-measuring ${rows.size} row${rows.size === 1 ? "" : "s"} (${recheck} of ${RECHECKS}): ${[...rows].join(", ")}`,
    );
    const again: Measurement[] = [];
    for (const contender of runnable) {
      for (const scenario of contender.scenarios) {
        if (
          scenarios.includes(scenario) &&
          rows.has(`${scenario}/${contender.backend}`)
        ) {
          again.push(...(await measure(contender, scenario)));
        }
      }
    }
    all = keepBest(all, again);
    regressions = compare(baseline, all, OURS);
  }
  const held = reportComparison(baseline, regressions);
  process.exit(held ? 0 : 1);
}

process.exit(0);
