import type { Measurement } from "./types";
import process from "node:process";

/**
 * Checking that what was won stays won.
 *
 * Phase 1 moved most of these numbers a long way, and Phase 2 adds work to the
 * exact claim path that did it. "Faster than any third party" is a claim that
 * expires quietly: a regression does not fail a test, it just makes a number
 * smaller, and nobody reads a benchmark table carefully on a Tuesday.
 *
 * So the table becomes an assertion. A committed baseline records what each
 * scenario measured and who led it, and `--compare` fails when a figure falls
 * materially behind its baseline, or when a rival we were beating has
 * overtaken us.
 *
 * Two things it deliberately does not do. It does not fail on an improvement,
 * however large — that is the point of the exercise. And it does not compare
 * across machines: a baseline is only meaningful against the hardware that
 * produced it, which is why the file records what that was.
 */

/**
 * How far a figure may fall before it counts as a regression.
 *
 * Calibrated to measured noise, not chosen. Four consecutive runs of one
 * unchanged build gave 40,053 / 42,838 / 49,427 / 51,347 jobs/s on Redis
 * contention — a 28% spread with nothing changed, because that scenario runs
 * three consumer processes and inherits their scheduling — and 156 / 160 / 160
 * / 178µs on Redis round-trip. A tolerance under those fails on noise, and a
 * guard that cries wolf is one people learn to ignore, which is worse than not
 * having one.
 *
 * So this is deliberately blunt. It catches what it is for — every regression
 * this benchmark has actually caught was a factor, not a percentage: a claim
 * that went O(n), a wakeup lost for a whole second, a table analysed on every
 * insert. It will not catch a 20% slip, and {@link compare} leans on the
 * overtaken check for that instead.
 */
export const TOLERANCE = 0.35;

/** One recorded figure, reduced to what a comparison needs. */
export interface BaselineEntry {
  /** The scenario it was measured under. */
  scenario: string;
  /** The backend it was measured against. */
  backend: string;
  /** Our figure: operations per second, or the median latency in ms. */
  ours: number;
  /** Whether higher is better — throughput yes, latency no. */
  higherIsBetter: boolean;
  /** The best rival's figure, when the backend has rivals. */
  rival?: { contender: string; value: number };
}

/** A committed baseline, with enough context to know when it stops applying. */
export interface Baseline {
  /** When it was recorded. */
  recordedAt: string;
  /** The Bun version that produced it. */
  bun: string;
  /** The platform, because a baseline does not travel between machines. */
  platform: string;
  /** How many jobs each throughput scenario ran. */
  jobs: number;
  /** The figures, keyed `<scenario>/<backend>`. */
  entries: Record<string, BaselineEntry>;
}

/** One way the current run differs from its baseline. */
export interface Regression {
  /** Which figure moved. */
  key: string;
  /** What kind of problem it is. */
  kind: "slower" | "overtaken" | "missing";
  /** What the baseline said. */
  was: string;
  /** What this run said. */
  now: string;
}

/** The key a figure is recorded under. */
function keyOf(scenario: string, backend: string): string {
  return `${scenario}/${backend}`;
}

/**
 * Our figure for a measurement, and whether bigger is better.
 *
 * Round-trip is recorded as its median rather than its mean: a mean is moved
 * by the tail, and the tail is what an unlucky GC pause looks like. It is also
 * recorded as latency rather than as the `opsPerSec` the same measurement
 * carries, which is only the inverse of that mean.
 */
function figureOf(
  measurement: Measurement,
): { value: number; higherIsBetter: boolean } | null {
  // Latency first, and the order matters: a round-trip measurement carries
  // *both*, its `opsPerSec` being the inverse of its mean. Taking that would
  // record a number the table never prints and compare a latency scenario by
  // a derived figure — 1,061/s where the table says 567µs.
  if (measurement.latency) {
    return { value: measurement.latency.p50, higherIsBetter: false };
  }

  if (measurement.opsPerSec !== undefined) {
    return { value: measurement.opsPerSec, higherIsBetter: true };
  }

  return null;
}

/** Reduces a run's measurements to the figures a baseline records. */
export function toBaseline(
  results: Measurement[],
  context: { bun: string; jobs: number; ours: ReadonlySet<string> },
): Baseline {
  const entries: Record<string, BaselineEntry> = {};

  for (const measurement of results) {
    const figure = figureOf(measurement);

    if (!figure) {
      continue;
    }

    const key = keyOf(measurement.scenario, measurement.backend);
    // Told, not guessed. This used to test the id for a `bun-jobs` prefix,
    // which is right for the queue benchmark and wrong for the runner's — its
    // contenders are `bun-runner-*`, so every one of ours was filed as a rival
    // and every figure of ours went missing.
    const ours = context.ours.has(measurement.contender);

    if (ours) {
      entries[key] = {
        scenario: measurement.scenario,
        backend: measurement.backend,
        ours: figure.value,
        higherIsBetter: figure.higherIsBetter,
        rival: entries[key]?.rival,
      };
      continue;
    }

    // The best rival is the one to stay ahead of; anything behind it is
    // already behind us too.
    const existing = entries[key];
    const better =
      existing?.rival === undefined ||
      (figure.higherIsBetter
        ? figure.value > existing.rival.value
        : figure.value < existing.rival.value);

    if (better) {
      entries[key] = {
        scenario: measurement.scenario,
        backend: measurement.backend,
        ours: existing?.ours ?? Number.NaN,
        higherIsBetter: figure.higherIsBetter,
        rival: { contender: measurement.contender, value: figure.value },
      };
    }
  }

  return {
    recordedAt: new Date().toISOString(),
    bun: context.bun,
    platform: `${process.platform}-${process.arch}`,
    jobs: context.jobs,
    // A scenario we did not run in is a rival's figure with nothing to compare
    // it to, and `NaN` does not survive JSON — it lands as `null` and reads
    // back as a number that fails every check quietly.
    entries: Object.fromEntries(
      Object.entries(entries).filter(([, entry]) => !Number.isNaN(entry.ours)),
    ),
  };
}

/** How the two figures compare, as a ratio where more is always better. */
function ratio(now: number, was: number, higherIsBetter: boolean): number {
  return higherIsBetter ? now / was : was / now;
}

/**
 * Compares a run against a baseline.
 *
 * Only figures the baseline knows about are checked, so adding a scenario does
 * not fail a build before anybody has recorded what it should do. A figure the
 * baseline has and the run does not is reported, because silently dropping a
 * scenario is exactly how a guard stops guarding.
 */
export function compare(
  baseline: Baseline,
  results: Measurement[],
  ours: ReadonlySet<string>,
): Regression[] {
  const current = toBaseline(results, {
    bun: "",
    jobs: baseline.jobs,
    ours,
  });
  const regressions: Regression[] = [];

  for (const [key, was] of Object.entries(baseline.entries)) {
    const now = current.entries[key];

    if (!now) {
      // Only complain about a figure this run actually attempted. Both halves
      // of the key have to match: `--backends redis` is an ordinary thing to
      // do, and reporting every other backend as missing would bury the one
      // regression that matters in noise.
      const attempted = results.some(
        (r) => r.scenario === was.scenario && r.backend === was.backend,
      );

      if (attempted) {
        regressions.push({
          key,
          kind: "missing",
          was: format(was.ours, was.higherIsBetter),
          now: "not measured",
        });
      }

      continue;
    }

    const moved = ratio(now.ours, was.ours, was.higherIsBetter);
    if (moved < 1 - TOLERANCE) {
      regressions.push({
        key,
        kind: "slower",
        was: format(was.ours, was.higherIsBetter),
        now: `${format(now.ours, now.higherIsBetter)} (${((1 - moved) * 100).toFixed(0)}% worse)`,
      });
    }

    // The sharper of the two checks, and the one the claim actually rests on.
    // It is also far less noisy than comparing a figure to its own past: a
    // machine that is busy slows us and the rival together, so the ordering
    // survives conditions that move both numbers by a third.
    const led =
      was.rival !== undefined &&
      ratio(was.ours, was.rival.value, was.higherIsBetter) > 1;

    if (led && now.rival) {
      const stillLeads =
        ratio(now.ours, now.rival.value, now.higherIsBetter) > 1;

      if (!stillLeads) {
        regressions.push({
          key,
          kind: "overtaken",
          was: `ahead of ${was.rival!.contender}`,
          now: `behind ${now.rival.contender} (${format(now.rival.value, now.higherIsBetter)})`,
        });
      }
    }
  }

  return regressions;
}

/** A figure as the tables show it. */
function format(value: number, higherIsBetter: boolean): string {
  if (!higherIsBetter) {
    return value < 1
      ? `${(value * 1000).toFixed(0)}µs`
      : `${value.toFixed(2)}ms`;
  }

  return `${Math.round(value).toLocaleString("en-US")}/s`;
}

/** Prints what changed, and says whether it is a failure. */
export function reportComparison(
  baseline: Baseline,
  regressions: Regression[],
): boolean {
  console.log(
    `\nCompared against a baseline recorded ${baseline.recordedAt.slice(0, 10)} ` +
      `on ${baseline.platform}, Bun ${baseline.bun}.`,
  );

  if (regressions.length === 0) {
    console.log(
      `  ok    nothing fell more than ${(TOLERANCE * 100).toFixed(0)}% behind its ` +
        `baseline, and every lead held.\n`,
    );
    return true;
  }

  for (const regression of regressions) {
    console.log(
      `  FAIL  ${regression.key.padEnd(26)} ${regression.kind.padEnd(10)} ${regression.was}  ->  ${regression.now}`,
    );
  }

  console.log(
    `\n${regressions.length} regression${regressions.length === 1 ? "" : "s"}. ` +
      `A baseline only means anything on the machine that recorded it — if this ` +
      `is different hardware, re-record rather than chase it.\n`,
  );

  return false;
}
