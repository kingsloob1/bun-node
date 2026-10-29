/* eslint-disable no-console -- a benchmark's output is its product */
import type { BaselineEntry } from "./compare";
import type { Backend, Measurement } from "./types";
import { format } from "./compare";

/**
 * Rendering results: one table per scenario and backend, ranked best first,
 * with a "vs ours" column that compares only inside the group. Comparing a
 * Redis figure with a Postgres one measures the database, not the library.
 */

/** Which contender ids are ours, and how to name and annotate each. */
export interface ReportContext {
  /** Ids belonging to the library this repository ships. */
  ours: ReadonlySet<string>;
  /** Display label for each contender id. */
  labels: ReadonlyMap<string, string>;
  /** Footnote for each contender id that has one. */
  notes: ReadonlyMap<string, string>;
}

/** Groups measurements by backend, in first-seen order. */
export function byBackend(
  measurements: Measurement[],
): Map<Backend, Measurement[]> {
  const groups = new Map<Backend, Measurement[]>();
  for (const measurement of measurements) {
    const bucket = groups.get(measurement.backend) ?? [];
    bucket.push(measurement);
    groups.set(measurement.backend, bucket);
  }
  return groups;
}

/** How much better `a` is than `b`, as a ratio where more is better. */
function better(a: number, b: number, higherIsBetter: boolean): number {
  return higherIsBetter ? a / b : b / a;
}

/** Prints one group's table: ranked best first, failures and skips last. */
export function table(group: Measurement[], context: ReportContext): void {
  const measured = group.filter((m) => m.figure);
  const ranked = measured.sort((a, b) =>
    a.figure!.higherIsBetter
      ? b.figure!.value - a.figure!.value
      : a.figure!.value - b.figure!.value,
  );
  const ours = ranked.find((m) => context.ours.has(m.contender))?.figure;

  console.log(
    `${"Contender".padEnd(40)}${"Figure".padStart(16)}${"Count".padStart(10)}${"vs ours".padStart(10)}  Detail`,
  );
  console.log("─".repeat(96));

  for (const m of ranked) {
    const label = context.labels.get(m.contender) ?? m.contender;
    const marked = context.ours.has(m.contender) ? `▸ ${label}` : `  ${label}`;
    const figure = m.figure!;
    const vs = ours
      ? `${better(figure.value, ours.value, figure.higherIsBetter).toFixed(2)}x`
      : "—";
    const details: string[] = [];
    if (m.latency) {
      details.push(
        `p50 ${format(m.latency.p50, false, "").trim()}, p99 ${format(m.latency.p99, false, "").trim()}`,
      );
    }
    if (m.loaderCalls !== undefined)
      details.push(`loader ran ${m.loaderCalls}x`);
    console.log(
      `${marked.padEnd(40)}${format(figure.value, figure.higherIsBetter, figure.label).padStart(16)}${String(m.count).padStart(10)}${vs.padStart(10)}  ${details.join("; ")}`,
    );
  }

  for (const m of group.filter((each) => !each.figure)) {
    const label = context.labels.get(m.contender) ?? m.contender;
    const marked = context.ours.has(m.contender) ? `▸ ${label}` : `  ${label}`;
    console.log(
      `${marked.padEnd(40)}${m.failed ? `FAILED: ${m.failed}` : `skipped: ${m.skipped}`}`,
    );
  }

  for (const id of new Set(group.map((m) => m.contender))) {
    const note = context.notes.get(id);
    if (note) console.log(`  * ${context.labels.get(id) ?? id}: ${note}`);
  }
}

/** Prints who led each figure, as a baseline records it. */
export function leaders(
  entries: Record<string, BaselineEntry>,
  labels: ReadonlyMap<string, string>,
): void {
  console.log(
    "\n\n══ Leaders ══  per scenario and backend; a tie is within 10%\n",
  );
  console.log(
    `${"Figure".padEnd(34)}${"bun-cache".padStart(16)}${"Best rival".padStart(16)}  Leader`,
  );
  console.log("─".repeat(96));
  for (const [key, entry] of Object.entries(entries)) {
    const rival = entry.rival
      ? `${format(entry.rival.value, entry.higherIsBetter, entry.label)}`
      : "—";
    const who =
      entry.leader === "ours"
        ? "bun-cache"
        : entry.leader === "tie"
          ? `tie with ${labels.get(entry.rival!.contender) ?? entry.rival!.contender}`
          : (labels.get(entry.leader) ?? entry.leader);
    console.log(
      `${key.padEnd(34)}${format(entry.ours, entry.higherIsBetter, entry.label).padStart(16)}${rival.padStart(16)}  ${entry.rival ? who : "(no rival)"}`,
    );
  }
}
