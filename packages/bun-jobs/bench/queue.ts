/* eslint-disable antfu/no-top-level-await , no-console */
import type { Baseline } from "./lib/compare";
import type { Backend, Measurement, QueueScenario } from "./lib/types";
import process from "node:process";
import { parseArgs } from "node:util";
import { queueContenders } from "./contenders/queue/index";
import { compare, reportComparison, toBaseline } from "./lib/compare";
import { backendAvailable, backendUrl, unavailableHint } from "./lib/env";
import { childArgs, emit, runChild } from "./lib/harness";
import { runQueueScenario } from "./lib/queue-scenarios";
import {
  byBackend,
  footnotes,
  latencyTable,
  throughputTable,
} from "./lib/report";

/**
 * Job-queue benchmarks: `@kingsleyweb/bun-jobs` against BullMQ, bee-queue,
 * node-resque, pg-boss, graphile-worker and Agenda.
 *
 *   bun queue.ts --verify                 prove every contender is correct
 *   bun queue.ts                          every scenario, every reachable backend
 *   bun queue.ts -s throughput -b redis   one scenario, one backend
 *   bun queue.ts --json > results.json    machine-readable output
 *
 * Results are grouped by backend and only compared inside a group. A Redis
 * figure next to a Postgres figure would be a measurement of the database, not
 * of the library, and the ranking would say nothing useful.
 *
 * Every contender runs in its own freshly spawned process. These libraries
 * hold connection pools, poll timers and reconnect loops, and several keep
 * them running after `close()`; measured side by side, whoever ran first taxes
 * whoever runs next.
 */

/** Every scenario, in the order they are run. */
const ALL_SCENARIOS: QueueScenario[] = [
  "enqueue",
  "enqueue-bulk",
  "throughput",
  "roundtrip",
  "payload",
  "contention",
];

/** What each scenario measures, for the report heading. */
const SCENARIO_BLURB: Record<QueueScenario, string> = {
  enqueue: "producer only — one job at a time, no consumer running",
  "enqueue-bulk": "producer only — batched, using each library's own batch API",
  throughput: "drain a pre-seeded backlog: worker start to last completion",
  roundtrip:
    "add one job, wait for it, repeat — dispatch latency on an idle queue",
  payload: "drain a backlog of padded jobs, isolating serialization",
  contention:
    "several independent consumers on one queue, checked for exactly-once",
};

/** Prints the usage banner. */
function printHelp(): void {
  console.log(`
Usage: bun queue.ts [options]

Options:
  -s, --scenario <names>  Scenario(s): comma list or 'all'   (default: all)
                          ${ALL_SCENARIOS.join(" | ")}
  -c, --contenders <ids>  Contender(s): comma list or 'all'  (default: all)
  -b, --backends <names>  Backend(s): comma list or 'all'    (default: all)
                          memory | file | sqlite | redis | postgres | mongodb
  -n, --jobs <n>          Jobs per throughput run            (default: 5000)
      --concurrency <n>   Jobs a worker processes at once    (default: 16)
      --consumers <n>     Consumer instances in 'contention' (default: 3)
      --samples <n>       Round-trip samples                 (default: 200)
      --payload-bytes <n> Filler per job in 'payload'        (default: 4096)
      --poll <ms>         Poll interval for polling libraries (default: 50)
      --budget <s>        Seconds before a run is abandoned  (default: 120)
      --verify            Assert every contender delivers every job exactly
                          once, then exit without timing anything
      --verbose           Show each child's stderr
      --json              Emit raw JSON results
      --save-baseline     Record this run as the committed baseline
      --compare           Fail if anything regressed against the baseline
  -h, --help              Show this help

Examples:
  bun queue.ts --verify
  bun queue.ts -b redis                        # BullMQ / bee-queue / node-resque
  bun queue.ts -s roundtrip --samples 500
  bun queue.ts -c bun-jobs-redis,bullmq -s throughput -n 20000
`);
}

const { values } = parseArgs({
  options: {
    scenario: { type: "string", short: "s", default: "all" },
    contenders: { type: "string", short: "c", default: "all" },
    backends: { type: "string", short: "b", default: "all" },
    jobs: { type: "string", short: "n", default: "5000" },
    concurrency: { type: "string", default: "16" },
    consumers: { type: "string", default: "3" },
    samples: { type: "string", default: "200" },
    "payload-bytes": { type: "string", default: "4096" },
    poll: { type: "string", default: "50" },
    budget: { type: "string", default: "120" },
    verify: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "save-baseline": { type: "boolean", default: false },
    compare: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    // Internal: the driver re-invokes this file per contender.
    child: { type: "string" },
    "child-scenario": { type: "string" },
    "child-name": { type: "string" },
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

/** Where the committed baseline for this benchmark lives. */
const BASELINE = new URL("baselines/queue.json", import.meta.url).pathname;

const config = {
  jobs: Math.max(1, toInt(values.jobs, 5000)),
  concurrency: Math.max(1, toInt(values.concurrency, 16)),
  consumers: Math.max(1, toInt(values.consumers, 3)),
  samples: Math.max(1, toInt(values.samples, 200)),
  payloadBytes: Math.max(0, toInt(values["payload-bytes"], 4096)),
  poll: Math.max(1, toInt(values.poll, 50)),
  budget: Math.max(5, toInt(values.budget, 120)),
  verify: !!values.verify,
  verbose: !!values.verbose,
  json: !!values.json,
  saveBaseline: !!values["save-baseline"],
  compare: !!values.compare,
};

const registry = queueContenders(config.poll);

/**
 * The ids of our own contenders.
 *
 * Taken from the registry rather than inferred from the id, because the two
 * benchmarks name theirs differently — `bun-jobs-*` in one, `bun-runner-*` in
 * the other — and a prefix test that is right for one files every contender of
 * the other as a rival.
 */
const OURS: ReadonlySet<string> = new Set(
  registry
    .filter((contender) => contender.ours)
    .map((contender) => contender.id),
);

/** Splits a comma list, or returns every value when it reads "all". */
function select<T extends string>(raw: string | undefined, all: T[]): T[] {
  if (!raw || raw === "all") return all;
  return String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean) as T[];
}

/* ------------------------------------------------------------------ *
 * Child mode: one contender, one scenario, one JSON line
 * ------------------------------------------------------------------ */

if (values.child) {
  const contender = registry.find((entry) => entry.id === values.child);

  if (!contender) {
    console.error(`Unknown contender: ${values.child}`);
    process.exit(1);
  }

  const scenario = String(values["child-scenario"]) as QueueScenario;

  const measurement = await runQueueScenario(contender, scenario, {
    jobs: config.jobs,
    concurrency: config.concurrency,
    payloadBytes: config.payloadBytes,
    consumers: config.consumers,
    samples: config.samples,
    budgetSeconds: config.budget,
    name: String(values["child-name"] ?? "bench"),
    url: backendUrl(contender.backend),
  });

  emit([measurement]);
  // Several of these libraries leave a reconnect timer or a pool behind that
  // would keep the process alive long after the figure is in hand.
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * Driver mode
 * ------------------------------------------------------------------ */

const scenarios = select<QueueScenario>(values.scenario, ALL_SCENARIOS);
for (const scenario of scenarios) {
  if (!ALL_SCENARIOS.includes(scenario)) {
    console.error(`Unknown scenario: "${scenario}"`);
    process.exit(1);
  }
}

const ALL_BACKENDS: Backend[] = [
  "memory",
  "file",
  "sqlite",
  "redis",
  "postgres",
  "mongodb",
];
const backends = select<Backend>(values.backends, ALL_BACKENDS);
const wantedIds = select(
  values.contenders,
  registry.map((entry) => entry.id),
);

const chosen = registry.filter(
  (entry) => wantedIds.includes(entry.id) && backends.includes(entry.backend),
);

if (chosen.length === 0) {
  console.error("No contender matched the selection.");
  process.exit(1);
}

/* Which backends are actually reachable. A missing one is announced, never
 * silently dropped, so a short table is never mistaken for a complete one. */
const reachable = new Set<Backend>();
const neededBackends = [...new Set(chosen.map((entry) => entry.backend))];

console.log(`\nBun ${Bun.version} — job-queue benchmarks\n`);
console.log("Backends");
for (const backend of neededBackends) {
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
  console.error(
    "\nNo backend is reachable. Start one with scripts/setup-databases.ts --docker.",
  );
  process.exit(1);
}

const context = {
  ours: new Set(
    runnable.filter((entry) => entry.ours).map((entry) => entry.id),
  ),
  labels: new Map(runnable.map((entry) => [entry.id, entry.label])),
  notes: new Map(
    runnable.flatMap((entry) =>
      entry.note ? [[entry.id, entry.note] as const] : [],
    ),
  ),
};

/** A fresh queue name per run, so nothing a previous run left behind is seen. */
const runId = Date.now().toString(36);

/* ------------------------------------------------------------------ *
 * Verify: correctness before any timing
 * ------------------------------------------------------------------ */

if (config.verify) {
  console.log(
    `\nVerifying — each contender must deliver 200 jobs exactly once, ` +
      `across ${config.consumers} consumers\n`,
  );

  let failures = 0;
  let skipped = 0;

  for (const contender of runnable) {
    const [measurement] = await runChild(
      {
        script: import.meta.path,
        args: childArgs({
          child: contender.id,
          "child-scenario": "contention",
          "child-name": `v-${runId}-${contender.id}`,
          jobs: "200",
          concurrency: "4",
          consumers: String(config.consumers),
          poll: String(config.poll),
          budget: String(config.budget),
        }),
        timeoutMs: (config.budget + 30) * 1000,
        verbose: config.verbose,
      },
      {
        contender: contender.id,
        scenario: "contention",
        backend: contender.backend,
      },
    );

    const bad = measurement?.failed;
    const skip = measurement?.skipped;

    if (bad) failures++;
    else if (skip) skipped++;

    const status = bad ? "FAIL" : skip ? "skip" : "ok";
    const detail =
      bad ??
      skip ??
      `200 jobs, exactly once, ${(measurement?.elapsedMs ?? 0).toFixed(0)}ms`;

    console.log(`  ${status.padEnd(6)}${contender.label.padEnd(26)}${detail}`);
  }

  const checked = runnable.length - skipped;
  console.log(
    failures === 0
      ? `\n${checked} of ${runnable.length} contenders deliver every job exactly once${
          skipped > 0 ? `; ${skipped} could not be checked.\n` : ".\n"
        }`
      : `\n${failures} of ${runnable.length} contenders failed verification.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/* ------------------------------------------------------------------ *
 * Measure
 * ------------------------------------------------------------------ */

const all: Measurement[] = [];

for (const scenario of scenarios) {
  console.log(`\n\n══ ${scenario} ══  ${SCENARIO_BLURB[scenario]}`);

  const scenarioResults: Measurement[] = [];

  for (const contender of runnable) {
    process.stdout.write(".");
    const measurements = await runChild(
      {
        script: import.meta.path,
        args: childArgs({
          child: contender.id,
          "child-scenario": scenario,
          "child-name": `b-${runId}-${scenario}-${contender.id}`,
          jobs: String(config.jobs),
          concurrency: String(config.concurrency),
          consumers: String(config.consumers),
          samples: String(config.samples),
          "payload-bytes": String(config.payloadBytes),
          poll: String(config.poll),
          budget: String(config.budget),
        }),
        timeoutMs: (config.budget + 60) * 1000,
        verbose: config.verbose,
      },
      { contender: contender.id, scenario, backend: contender.backend },
    );

    scenarioResults.push(...measurements);
  }

  process.stdout.write("\n");
  all.push(...scenarioResults);

  if (config.json) continue;

  for (const [backend, group] of byBackend(scenarioResults)) {
    console.log(`\n  ── ${backend} ──`);
    if (scenario === "roundtrip") latencyTable(group, context);
    else throughputTable(group, context);
    footnotes(group, context);
  }
}

if (config.saveBaseline) {
  const baseline = toBaseline(all, {
    bun: Bun.version,
    jobs: config.jobs,
    ours: OURS,
  });
  await Bun.write(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    `\nRecorded ${Object.keys(baseline.entries).length} figures to ${BASELINE}.\n`,
  );
  process.exit(0);
}

if (config.compare) {
  const file = Bun.file(BASELINE);

  if (!(await file.exists())) {
    console.log(
      `\nNo baseline at ${BASELINE}. Record one with --save-baseline.\n`,
    );
    process.exit(1);
  }

  const baseline = (await file.json()) as Baseline;
  const held = reportComparison(baseline, compare(baseline, all, OURS));
  process.exit(held ? 0 : 1);
}

if (config.json) {
  console.log(
    JSON.stringify({ bun: Bun.version, config, results: all }, null, 2),
  );
} else {
  console.log(
    `\n\nRanking is within a backend only. ` +
      `Throughput scenarios ran ${config.jobs} jobs at concurrency ${config.concurrency}; ` +
      `round-trip used ${config.samples} samples on an idle queue.\n`,
  );
}

process.exit(0);
