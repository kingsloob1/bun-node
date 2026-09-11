/* eslint-disable antfu/no-top-level-await , no-console */
import type { Baseline } from "./lib/compare";
import type { Backend, Measurement, RunnerScenario } from "./lib/types";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { runnerContenders } from "./contenders/runner/index";
import { compare, reportComparison, toBaseline } from "./lib/compare";
import { backendAvailable, backendUrl, unavailableHint } from "./lib/env";
import { childArgs, emit, runChild } from "./lib/harness";
import {
  driftTable,
  exclusivityTable,
  footnotes,
  latencyTable,
  throughputTable,
} from "./lib/report";
import { runRunnerScenario } from "./lib/runner-scenarios";

/**
 * File-runner and scheduler benchmarks: `BunRunner` against Bree, Agenda and
 * the in-process cron timers croner, node-cron, node-schedule and
 * toad-scheduler.
 *
 *   bun runner.ts                        every scenario
 *   bun runner.ts -s exclusive           three replicas, one cron job
 *   bun runner.ts -s dispatch --runs 50
 *   bun runner.ts --json > results.json
 *
 * Unlike the queue benchmarks, these are **not** grouped by backend, because
 * the backend is barely on the path: a runner touches it once to take a lock
 * and once to record the result. What separates these entries is how the
 * handler is executed — a process, a worker thread, or the caller's own stack
 * — and whether anything outside the process is coordinated at all. The report
 * marks both, and the `exclusive` scenario is where the difference stops being
 * a matter of speed.
 */

/** Every scenario, in the order they are run. */
const ALL_SCENARIOS: RunnerScenario[] = [
  "dispatch",
  "cycle",
  "drift",
  "exclusive",
];

/** What each scenario measures, for the report heading. */
const SCENARIO_BLURB: Record<RunnerScenario, string> = {
  dispatch:
    "ask for a run, wait until the handler is executing — start-up cost",
  cycle: "ask for a run, wait until it has finished — the whole round trip",
  drift:
    "arm a one-second cron and measure how far each fire lands from the second",
  exclusive:
    "several replicas, one cron job: does it run once, or once per replica?",
};

/** Prints the usage banner. */
function printHelp(): void {
  console.log(`
Usage: bun runner.ts [options]

Options:
  -s, --scenario <names>  Scenario(s): comma list or 'all'   (default: all)
                          ${ALL_SCENARIOS.join(" | ")}
  -c, --contenders <ids>  Contender(s): comma list or 'all'  (default: all)
      --runs <n>          On-demand runs per pass            (default: 30)
      --fires <n>         Scheduled fires observed in 'drift' (default: 8)
      --instances <n>     Replicas in 'exclusive'            (default: 3)
      --observe <s>       Seconds observed in 'exclusive'    (default: 8)
      --budget <s>        Seconds before a run is abandoned  (default: 120)
      --verbose           Show each child's stderr
      --json              Emit raw JSON results
      --save-baseline     Record this run as the committed baseline
      --compare           Fail if anything regressed against the baseline
  -h, --help              Show this help

Examples:
  bun runner.ts -s exclusive --instances 4
  bun runner.ts -s dispatch,cycle --runs 50
  bun runner.ts -c bun-runner-spawn,bree -s cycle
`);
}

const { values } = parseArgs({
  options: {
    scenario: { type: "string", short: "s", default: "all" },
    contenders: { type: "string", short: "c", default: "all" },
    runs: { type: "string", default: "30" },
    fires: { type: "string", default: "8" },
    instances: { type: "string", default: "3" },
    observe: { type: "string", default: "8" },
    budget: { type: "string", default: "120" },
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
const BASELINE = new URL("baselines/runner.json", import.meta.url).pathname;

const config = {
  runs: Math.max(1, toInt(values.runs, 30)),
  fires: Math.max(2, toInt(values.fires, 8)),
  instances: Math.max(2, toInt(values.instances, 3)),
  observe: Math.max(2, toInt(values.observe, 8)),
  budget: Math.max(5, toInt(values.budget, 120)),
  verbose: !!values.verbose,
  json: !!values.json,
  saveBaseline: !!values["save-baseline"],
  compare: !!values.compare,
};

const registry = runnerContenders();

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

/** The handler every file-executing contender runs. */
const HANDLER = join(import.meta.dir, "fixtures", "handler.ts");
/** Bree resolves a job by name inside a directory, so it gets its own file. */
const BREE_HANDLER = join(import.meta.dir, "fixtures", "bree-job.js");

/** Splits a comma list, or returns every value when it reads "all". */
function select<T extends string>(raw: string | undefined, all: T[]): T[] {
  if (!raw || raw === "all") return all;
  return String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean) as T[];
}

/* ------------------------------------------------------------------ *
 * Child mode
 * ------------------------------------------------------------------ */

if (values.child) {
  const contender = registry.find((entry) => entry.id === values.child);

  if (!contender) {
    console.error(`Unknown contender: ${values.child}`);
    process.exit(1);
  }

  const scenario = String(values["child-scenario"]) as RunnerScenario;

  const measurement = await runRunnerScenario(contender, scenario, {
    runs: config.runs,
    fires: config.fires,
    instances: config.instances,
    observeSeconds: config.observe,
    budgetSeconds: config.budget,
    name: String(values["child-name"] ?? "bench"),
    url: backendUrl(contender.backend),
    file: contender.id === "bree" ? BREE_HANDLER : HANDLER,
  });

  emit([measurement]);
  // Several of these libraries leave a poll timer or a pool behind that would
  // keep the process alive long after the figure is in hand.
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * Driver mode
 * ------------------------------------------------------------------ */

const scenarios = select<RunnerScenario>(values.scenario, ALL_SCENARIOS);
for (const scenario of scenarios) {
  if (!ALL_SCENARIOS.includes(scenario)) {
    console.error(`Unknown scenario: "${scenario}"`);
    process.exit(1);
  }
}

const wantedIds = select(
  values.contenders,
  registry.map((entry) => entry.id),
);
const chosen = registry.filter((entry) => wantedIds.includes(entry.id));

if (chosen.length === 0) {
  console.error("No contender matched the selection.");
  process.exit(1);
}

console.log(`\nBun ${Bun.version} — file-runner and scheduler benchmarks\n`);
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
  console.error(
    "\nNo backend is reachable. Start one with scripts/setup-databases.ts --docker.",
  );
  process.exit(1);
}

/**
 * Contenders are grouped by what they actually guarantee rather than by
 * backend, because that is the axis the numbers vary along.
 */
type Family = "isolated" | "durable" | "timer";

/** Which family a contender belongs to. */
function family(id: string): Family {
  const entry = registry.find((candidate) => candidate.id === id)!;
  if (entry.durable) return "durable";
  return entry.execution === "in-process" ? "timer" : "isolated";
}

/** The heading each family is printed under. */
const FAMILY_TITLE: Record<Family, string> = {
  isolated:
    "isolated — the handler is a file, run in its own process or thread",
  durable: "durable — the run is coordinated across processes",
  timer: "in-process timers — no isolation, no persistence, no coordination",
};

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

/** A fresh name per run, so nothing a previous run left behind is seen. */
const runId = Date.now().toString(36);
const all: Measurement[] = [];

for (const scenario of scenarios) {
  console.log(`\n\n══ ${scenario} ══  ${SCENARIO_BLURB[scenario]}`);

  const results: Measurement[] = [];

  for (const contender of runnable) {
    process.stdout.write(".");
    results.push(
      ...(await runChild(
        {
          script: import.meta.path,
          args: childArgs({
            child: contender.id,
            "child-scenario": scenario,
            "child-name": `r-${runId}-${scenario}-${contender.id}`,
            runs: String(config.runs),
            fires: String(config.fires),
            instances: String(config.instances),
            observe: String(config.observe),
            budget: String(config.budget),
          }),
          timeoutMs: (config.budget + 60) * 1000,
          verbose: config.verbose,
        },
        { contender: contender.id, scenario, backend: contender.backend },
      )),
    );
  }

  process.stdout.write("\n");
  all.push(...results);

  if (config.json) continue;

  const families: Family[] = ["isolated", "durable", "timer"];
  for (const group of families) {
    const rows = results.filter((m) => family(m.contender) === group);
    if (rows.length === 0) continue;

    console.log(`\n  ── ${FAMILY_TITLE[group]} ──`);
    if (scenario === "drift") driftTable(rows, context);
    else if (scenario === "exclusive") exclusivityTable(rows, context);
    else if (scenario === "dispatch") latencyTable(rows, context);
    else throughputTable(rows, context, "runs/s");
    footnotes(rows, context);
  }
}

if (config.saveBaseline) {
  const baseline = toBaseline(all, {
    bun: Bun.version,
    jobs: config.runs,
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
    `\n\nEvery run executed the same trivial handler, so these figures are the ` +
      `runner's own cost. ` +
      `dispatch and cycle used ${config.runs} runs; ` +
      `exclusive ran ${config.instances} replicas for ${config.observe}s.\n`,
  );
}

process.exit(0);
