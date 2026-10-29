/* eslint-disable no-console -- a benchmark's output is its product */
import type { Measurement } from "./types";
import process from "node:process";

/**
 * Checking that what was won stays won — bun-jobs' `bench/lib/compare.ts`
 * design (plan §15.2), copied rather than imported: the two benches are
 * separate packages, and each owns its calibration.
 *
 * A regression does not fail a test; it makes a number smaller, and nobody
 * reads a benchmark table carefully on a Tuesday. So the table is an
 * assertion. A committed baseline records each figure **and who led it**, and
 * `--compare` fails when a figure falls materially behind its own baseline, or
 * when a rival we were beating has overtaken us.
 *
 * It does not fail on an improvement, however large, and it does not compare
 * across machines: a baseline is only meaningful against the hardware that
 * produced it, which is why the file records what that was.
 */

/**
 * How far a figure may fall behind its own baseline before it counts as a
 * regression.
 *
 * bun-jobs' figure, calibrated to its own run-to-run spread (28% on an
 * unchanged build), kept until bun-cache's spread has been measured (§15.2).
 * It is blunt on purpose: every regression bun-jobs' guard has caught was a
 * factor, not a percentage, and a guard that cries wolf is one people learn
 * to ignore. It will not catch a 20% slip; the overtaken check is for that.
 */
export const TOLERANCE = 0.35;

/**
 * How far a rival must now be ahead of us before a lead counts as lost.
 *
 * bun-jobs' check fails on any reversal, which suits it: its leads are
 * factors. Several of these scenarios are near-ties by construction — a
 * `stampede` p99 is mostly its 20 ms loader, whoever runs it — and a strict
 * reversal there flips on noise. So a lead is lost only when the rival is now
 * ahead by more than this; within it, the two are reported as tied and the
 * figure is still held to its own baseline.
 */
export const OVERTAKE_MARGIN = 0.1;

/** One recorded figure, reduced to what a comparison needs. */
export interface BaselineEntry {
  /** The scenario it was measured under. */
  scenario: string;
  /** The backend it was measured against. */
  backend: string;
  /** Our figure: operations per second, or a latency percentile in ms. */
  ours: number;
  /** Whether higher is better: throughput yes, latency no. */
  higherIsBetter: boolean;
  /** What the figure is (`ops/s`, `p99`, `p50`). */
  label: string;
  /** The best rival's figure, when the backend has rivals in the scenario. */
  rival?: { contender: string; value: number };
  /** Who led: `ours`, the rival's id, or `tie` when within {@link OVERTAKE_MARGIN}. */
  leader: string;
}

/** A committed baseline, with enough context to know when it stops applying. */
export interface Baseline {
  /** When it was recorded. */
  recordedAt: string;
  /** The Bun version and revision that produced it. */
  bun: string;
  /** The platform, because a baseline does not travel between machines. */
  platform: string;
  /** The `--ops` the throughput scenarios ran with. */
  ops: number;
  /** The figures, keyed `<scenario>/<backend>`. */
  entries: Record<string, BaselineEntry>;
  /**
   * bun-cache's runs that failed when the baseline was recorded, keyed like
   * `entries`, with why: a wrong answer is a finding, not a figure, so it is
   * recorded here — in the committed file, where it cannot be missed — rather
   * than silently left out. Such a figure is not guarded until it passes and
   * is re-recorded.
   */
  failed?: Record<string, string>;
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

/** How the two figures compare, as a ratio where more is always better. */
function ratio(now: number, was: number, higherIsBetter: boolean): number {
  return higherIsBetter ? now / was : was / now;
}

/** Who leads, given our figure and the best rival's. */
function leaderOf(entry: Omit<BaselineEntry, "leader">): string {
  if (!entry.rival) return "ours";
  const ahead = ratio(entry.ours, entry.rival.value, entry.higherIsBetter);
  if (ahead > 1 + OVERTAKE_MARGIN) return "ours";
  if (ahead < 1 / (1 + OVERTAKE_MARGIN)) return entry.rival.contender;
  return "tie";
}

/** Reduces a run's measurements to the figures a baseline records. */
export function toBaseline(
  results: Measurement[],
  context: { bun: string; ops: number; ours: ReadonlySet<string> },
): Baseline {
  const ours = new Map<string, Measurement>();
  const best = new Map<string, Measurement>();

  for (const measurement of results) {
    const figure = measurement.figure;
    if (!figure || measurement.failed || measurement.skipped) continue;
    const key = keyOf(measurement.scenario, measurement.backend);

    // Told, not guessed from the id: the registry says which contenders are ours.
    if (context.ours.has(measurement.contender)) {
      ours.set(key, measurement);
      continue;
    }
    // The best rival is the one to stay ahead of; anything behind it is behind us too.
    const current = best.get(key)?.figure;
    const better =
      current === undefined ||
      (figure.higherIsBetter
        ? figure.value > current.value
        : figure.value < current.value);
    if (better) best.set(key, measurement);
  }

  const entries: Record<string, BaselineEntry> = {};
  // A scenario we did not run in is a rival's figure with nothing to compare it to.
  for (const [key, measurement] of ours) {
    const figure = measurement.figure!;
    const rival = best.get(key);
    const entry: Omit<BaselineEntry, "leader"> = {
      scenario: measurement.scenario,
      backend: measurement.backend,
      ours: figure.value,
      higherIsBetter: figure.higherIsBetter,
      label: figure.label,
      rival: rival
        ? { contender: rival.contender, value: rival.figure!.value }
        : undefined,
    };
    entries[key] = { ...entry, leader: leaderOf(entry) };
  }

  return {
    recordedAt: new Date().toISOString(),
    bun: context.bun,
    platform: `${process.platform}-${process.arch}`,
    ops: context.ops,
    entries,
  };
}

/**
 * Compares a run against a baseline.
 *
 * Only figures the baseline knows are checked, so adding a scenario does not
 * fail a build before anybody has recorded what it should do. A figure the
 * baseline has and the run attempted but did not produce (a failed or wrong
 * run) is reported: silently dropping a scenario is exactly how a guard stops
 * guarding.
 */
export function compare(
  baseline: Baseline,
  results: Measurement[],
  ours: ReadonlySet<string>,
): Regression[] {
  const current = toBaseline(results, { bun: "", ops: baseline.ops, ours });
  const regressions: Regression[] = [];

  for (const [key, was] of Object.entries(baseline.entries)) {
    const now = current.entries[key];

    if (!now) {
      // Only a figure this run attempted: `-b redis` is an ordinary thing to
      // ask for, and every other backend reported missing would bury the one
      // regression that matters.
      const attempted = results.some(
        (r) =>
          r.scenario === was.scenario &&
          r.backend === was.backend &&
          ours.has(r.contender),
      );
      if (attempted) {
        regressions.push({
          key,
          kind: "missing",
          was: format(was.ours, was.higherIsBetter, was.label),
          now: "not measured (the run failed or answered wrongly)",
        });
      }
      continue;
    }

    const moved = ratio(now.ours, was.ours, was.higherIsBetter);
    if (moved < 1 - TOLERANCE) {
      regressions.push({
        key,
        kind: "slower",
        was: format(was.ours, was.higherIsBetter, was.label),
        now: `${format(now.ours, now.higherIsBetter, now.label)} (${((1 - moved) * 100).toFixed(0)}% worse)`,
      });
    }

    // The sharper of the two checks, and the one a claim rests on. A busy
    // machine slows us and the rival together, so the ordering survives
    // conditions that move both numbers by a third.
    if (was.leader === "ours" && now.rival) {
      const behind = ratio(now.rival.value, now.ours, now.higherIsBetter);
      if (behind > 1 + OVERTAKE_MARGIN) {
        regressions.push({
          key,
          kind: "overtaken",
          was: `ahead of ${was.rival?.contender ?? "every rival"}`,
          now: `behind ${now.rival.contender} (${format(now.rival.value, now.higherIsBetter, now.label)} against ${format(now.ours, now.higherIsBetter, now.label)})`,
        });
      }
    }
  }

  return regressions;
}

/** A figure as the tables show it. */
export function format(
  value: number,
  higherIsBetter: boolean,
  label: string,
): string {
  if (!higherIsBetter) {
    const shown =
      value < 1 ? `${(value * 1000).toFixed(0)}µs` : `${value.toFixed(2)}ms`;
    return `${shown} ${label}`;
  }
  return `${Math.round(value).toLocaleString("en-US")}/s`;
}

/** Prints what changed, and says whether it held. */
export function reportComparison(
  baseline: Baseline,
  regressions: Regression[],
): boolean {
  console.log(
    `\nCompared against a baseline recorded ${baseline.recordedAt.slice(0, 10)} ` +
      `on ${baseline.platform}, Bun ${baseline.bun}.`,
  );

  const known = Object.entries(baseline.failed ?? {});
  if (known.length > 0) {
    console.log(
      `  note  ${known.length} figure${known.length === 1 ? "" : "s"} failed when the baseline was recorded, so ${known.length === 1 ? "it is" : "they are"} not guarded:`,
    );
    for (const [key, why] of known) {
      console.log(`          ${key}: ${why}`);
    }
  }

  if (regressions.length === 0) {
    console.log(
      `  ok    nothing fell more than ${(TOLERANCE * 100).toFixed(0)}% behind its ` +
        `baseline, and every lead held.\n`,
    );
    return true;
  }

  for (const regression of regressions) {
    console.log(
      `  FAIL  ${regression.key.padEnd(30)} ${regression.kind.padEnd(10)} ${regression.was}  ->  ${regression.now}`,
    );
  }

  console.log(
    `\n${regressions.length} regression${regressions.length === 1 ? "" : "s"}. ` +
      `A baseline only means anything on the machine that recorded it — if this ` +
      `is different hardware, re-record rather than chase it.\n`,
  );
  return false;
}
