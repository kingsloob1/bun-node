/* eslint-disable no-console -- a benchmark's output is its product */
import type { Backend, Measurement } from "./types";

/**
 * Rendering results.
 *
 * Tables are grouped by backend and the "vs ours" column compares only inside
 * a group, because comparing a Redis figure against a Postgres one measures
 * the database rather than the library.
 */

/** One column of a rendered table. */
interface Column {
  /** Heading text. */
  title: string;
  /** Fixed character width, including the trailing gap. */
  width: number;
  /** Whether the cell is right-aligned, as numbers should be. */
  right?: boolean;
}

/** Formats an integer with thousands separators. */
export function int(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Formats a millisecond figure with a resolution that suits its size. */
export function ms(value: number): string {
  if (value >= 100) return `${value.toFixed(0)}ms`;
  if (value >= 10) return `${value.toFixed(1)}ms`;
  if (value >= 1) return `${value.toFixed(2)}ms`;
  return `${(value * 1000).toFixed(0)}µs`;
}

/** Pads a cell to its column width. */
function cell(text: string, column: Column): string {
  return column.right
    ? `${text.padStart(column.width - 2)}  `
    : text.padEnd(column.width);
}

/** Prints a heading row and its underline. */
function header(columns: Column[]): void {
  console.log(columns.map((column) => cell(column.title, column)).join(""));
  console.log(
    "─".repeat(columns.reduce((sum, column) => sum + column.width, 0)),
  );
}

/** Groups measurements by the backend their contender ran against. */
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

/** Which contender ids are ours, so the report can mark and compare against them. */
export interface ReportContext {
  /** Ids belonging to the library this repository ships. */
  ours: Set<string>;
  /** Display label for each contender id. */
  labels: Map<string, string>;
  /** Footnote for each contender id that has one. */
  notes: Map<string, string>;
}

/** Renders a throughput table: one row per contender, ranked fastest first. */
export function throughputTable(
  measurements: Measurement[],
  context: ReportContext,
  unit = "jobs/s",
): void {
  const columns: Column[] = [
    { title: "Contender", width: 30 },
    { title: unit, width: 14, right: true },
    { title: "Jobs", width: 11, right: true },
    { title: "Elapsed", width: 12, right: true },
    { title: "vs ours", width: 12, right: true },
  ];

  header(columns);

  const ranked = [...measurements].sort(
    (a, b) => (b.opsPerSec ?? -1) - (a.opsPerSec ?? -1),
  );
  const baseline = ranked.find(
    (m) => context.ours.has(m.contender) && m.opsPerSec,
  )?.opsPerSec;

  for (const m of ranked) {
    const label = context.labels.get(m.contender) ?? m.contender;
    const marked = context.ours.has(m.contender) ? `▸ ${label}` : `  ${label}`;

    if (m.skipped ?? m.failed) {
      console.log(
        cell(marked, columns[0]!) +
          (m.failed ? `FAILED: ${m.failed}` : `skipped: ${m.skipped}`),
      );
      continue;
    }

    const relative =
      baseline && m.opsPerSec
        ? m.opsPerSec === baseline
          ? "1.00x"
          : `${(m.opsPerSec / baseline).toFixed(2)}x`
        : "—";

    console.log(
      cell(marked, columns[0]!) +
        cell(int(m.opsPerSec ?? 0), columns[1]!) +
        cell(int(m.count), columns[2]!) +
        cell(ms(m.elapsedMs), columns[3]!) +
        cell(relative, columns[4]!),
    );
  }
}

/** Renders a latency table: one row per contender, ranked lowest median first. */
export function latencyTable(
  measurements: Measurement[],
  context: ReportContext,
): void {
  const columns: Column[] = [
    { title: "Contender", width: 30 },
    { title: "p50", width: 11, right: true },
    { title: "p90", width: 11, right: true },
    { title: "p99", width: 11, right: true },
    { title: "max", width: 11, right: true },
    { title: "samples", width: 10, right: true },
  ];

  header(columns);

  const ranked = [...measurements].sort(
    (a, b) => (a.latency?.p50 ?? Infinity) - (b.latency?.p50 ?? Infinity),
  );

  for (const m of ranked) {
    const label = context.labels.get(m.contender) ?? m.contender;
    const marked = context.ours.has(m.contender) ? `▸ ${label}` : `  ${label}`;

    if (m.skipped ?? m.failed) {
      console.log(
        cell(marked, columns[0]!) +
          (m.failed ? `FAILED: ${m.failed}` : `skipped: ${m.skipped}`),
      );
      continue;
    }

    const l = m.latency!;
    console.log(
      cell(marked, columns[0]!) +
        cell(ms(l.p50), columns[1]!) +
        cell(ms(l.p90), columns[2]!) +
        cell(ms(l.p99), columns[3]!) +
        cell(ms(l.max), columns[4]!) +
        cell(int(m.count), columns[5]!),
    );
  }
}

/** Renders a schedule-accuracy table: how far each fire landed from its scheduled second. */
export function driftTable(
  measurements: Measurement[],
  context: ReportContext,
): void {
  const columns: Column[] = [
    { title: "Scheduler", width: 30 },
    { title: "mean |drift|", width: 15, right: true },
    { title: "p99", width: 12, right: true },
    { title: "max", width: 12, right: true },
    { title: "fires", width: 9, right: true },
  ];

  header(columns);

  const ranked = [...measurements].sort(
    (a, b) => (a.drift?.mean ?? Infinity) - (b.drift?.mean ?? Infinity),
  );

  for (const m of ranked) {
    const label = context.labels.get(m.contender) ?? m.contender;
    const marked = context.ours.has(m.contender) ? `▸ ${label}` : `  ${label}`;

    if (m.skipped ?? m.failed) {
      console.log(
        cell(marked, columns[0]!) +
          (m.failed ? `FAILED: ${m.failed}` : `skipped: ${m.skipped}`),
      );
      continue;
    }

    const d = m.drift!;
    console.log(
      cell(marked, columns[0]!) +
        cell(ms(d.mean), columns[1]!) +
        cell(ms(d.p99), columns[2]!) +
        cell(ms(d.max), columns[3]!) +
        cell(int(d.fires), columns[4]!),
    );
  }
}

/** Prints the footnotes for whichever contenders in this group have one. */
export function footnotes(
  measurements: Measurement[],
  context: ReportContext,
): void {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const m of measurements) {
    if (seen.has(m.contender)) continue;
    seen.add(m.contender);
    const note = context.notes.get(m.contender);
    if (note) {
      lines.push(
        `  · ${context.labels.get(m.contender) ?? m.contender}: ${note}`,
      );
    }
  }

  if (lines.length > 0) {
    console.log();
    for (const line of lines) console.log(line);
  }
}

/**
 * Renders the exclusivity table: several replicas of one scheduled job, and
 * how many times it actually ran per occurrence.
 *
 * 1.00 is the answer a distributed scheduler is supposed to give. A figure
 * equal to the replica count means every replica ran it, which is what an
 * in-process timer does and is the reason the durable entries exist.
 */
export function exclusivityTable(
  measurements: Measurement[],
  context: ReportContext,
): void {
  const columns: Column[] = [
    { title: "Runner", width: 30 },
    { title: "Replicas", width: 11, right: true },
    { title: "Occurrences", width: 14, right: true },
    { title: "Runs", width: 9, right: true },
    { title: "Runs each", width: 12, right: true },
    { title: "Verdict", width: 22 },
  ];

  header(columns);

  const ranked = [...measurements].sort(
    (a, b) =>
      Math.abs((a.exclusivity?.perOccurrence ?? 99) - 1) -
      Math.abs((b.exclusivity?.perOccurrence ?? 99) - 1),
  );

  for (const m of ranked) {
    const label = context.labels.get(m.contender) ?? m.contender;
    const marked = context.ours.has(m.contender) ? `▸ ${label}` : `  ${label}`;

    if (m.skipped ?? m.failed) {
      console.log(
        cell(marked, columns[0]!) +
          (m.failed ? `FAILED: ${m.failed}` : `skipped: ${m.skipped}`),
      );
      continue;
    }

    const e = m.exclusivity!;
    const verdict =
      e.perOccurrence <= 1.05 && e.perOccurrence >= 0.9
        ? "exactly once"
        : e.perOccurrence < 0.9
          ? "occurrences missed"
          : `${e.perOccurrence.toFixed(1)}x duplicated`;

    console.log(
      cell(marked, columns[0]!) +
        cell(int(e.instances), columns[1]!) +
        cell(int(e.occurrences), columns[2]!) +
        cell(int(e.runs), columns[3]!) +
        cell(e.perOccurrence.toFixed(2), columns[4]!) +
        cell(verdict, columns[5]!),
    );
  }
}
