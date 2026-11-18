/**
 * The time range an analytics view is read over, shared by every UI (moved
 * from the jobs app, PR-U2): a rolling preset ("the last hour") or a fixed
 * custom span between two instants.
 *
 * A preset is stored as its duration, not the instants it resolved to, so a
 * screen left open keeps following the clock; a custom range is stored as
 * its two instants, so it stays where it was put. Both live in the URL.
 *
 * Each UI binds a model ({@link createRangeModel}) to its own presets, labels
 * and bounds, which come from its API; the kit holds no list of its own.
 */

/** A rolling window ending now. */
export interface PresetRange<P extends number = number> {
  /** Discriminator. */
  kind: "preset";
  /** Its length in seconds. */
  seconds: P;
}

/** A fixed span between two instants. */
export interface CustomRange {
  /** Discriminator. */
  kind: "custom";
  /** Start, epoch ms, inclusive. */
  from: number;
  /** End, epoch ms, exclusive. */
  to: number;
}

/** What an analytics view is read over. */
export type TimeRange<P extends number = number> = PresetRange<P> | CustomRange;

/** What a UI binds its range model to. */
export interface RangeModelOptions<P extends number> {
  /** The rolling presets, in seconds, shortest first. */
  readonly presets: readonly P[];
  /** The preset a view opens on. */
  readonly defaultPreset: P;
  /** How each preset reads. */
  readonly labels: Readonly<Record<P, string>>;
  /** The longest span its API serves, ms. */
  readonly maxSpanMs: number;
  /** The shortest custom span, ms. */
  readonly minSpanMs: number;
}

/** A UI's range model; see the module's description. */
export interface RangeModel<P extends number = number> {
  /** The presets, shortest first. */
  readonly presets: readonly P[];
  /** The preset a view opens on. */
  readonly defaultPreset: P;
  /** How each preset reads. */
  readonly labels: Readonly<Record<P, string>>;
  /** The longest span, ms. */
  readonly maxSpanMs: number;
  /** The shortest custom span, ms. */
  readonly minSpanMs: number;
  /** The default range: the default preset, rolling. */
  readonly defaultRange: () => TimeRange<P>;
  /** Why a custom range is not usable, or `null`; `maxSpan` `null` sets no longest span. */
  readonly rangeProblem: (
    from: number,
    to: number,
    maxSpan?: number | null,
  ) => string | null;
  /** A range for the URL: `<seconds>s` for a preset, `<from>-<to>` for a custom one; `null` for the default. */
  readonly writeRange: (range: TimeRange<P>) => string | null;
  /** A range read back from the URL; anything malformed is the default. */
  readonly readRange: (raw: string | null) => TimeRange<P>;
  /** How a range reads in a heading. */
  readonly describeRange: (range: TimeRange<P>) => string;
}

/** The instants a range covers right now; a preset resolves against `now`. */
export function rangeBounds(
  range: TimeRange,
  now = Date.now(),
): { from: number; to: number } {
  return range.kind === "preset"
    ? { from: now - range.seconds * 1_000, to: now }
    : { from: range.from, to: range.to };
}

/** A range's length in ms. */
export function rangeLength(range: TimeRange, now = Date.now()): number {
  const { from, to } = rangeBounds(range, now);
  return to - from;
}

/** How a span reads in a message: "24 hours", "31 days", "90 minutes". */
export function describeSpan(ms: number): string {
  const units: [number, string][] = [
    [24 * 60 * 60 * 1_000, "day"],
    [60 * 60 * 1_000, "hour"],
    [60 * 1_000, "minute"],
    [1_000, "second"],
  ];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const count = ms / size;
      return `${count} ${name}${count === 1 ? "" : "s"}`;
    }
  }
  return `${Math.round(ms / 1_000)} seconds`;
}

/** A UI's range model; see the module's description. */
export function createRangeModel<P extends number>(
  options: RangeModelOptions<P>,
): RangeModel<P> {
  const { presets, defaultPreset, labels, maxSpanMs, minSpanMs } = options;
  const defaultRange = (): TimeRange<P> => ({
    kind: "preset",
    seconds: defaultPreset,
  });
  const rangeProblem = (
    from: number,
    to: number,
    maxSpan: number | null = maxSpanMs,
  ): string | null => {
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return "Give both a start and an end.";
    }
    if (to <= from) return "The end must be after the start.";
    if (to - from < minSpanMs) {
      const shortest =
        minSpanMs === 1_000 ? "a second" : describeSpan(minSpanMs);
      return `That range is shorter than ${shortest}.`;
    }
    if (maxSpan !== null && to - from > maxSpan) {
      return `That range is longer than ${describeSpan(maxSpan)}, which is as far back as this API keeps.`;
    }
    return null;
  };
  return Object.freeze({
    presets,
    defaultPreset,
    labels,
    maxSpanMs,
    minSpanMs,
    defaultRange,
    rangeProblem,
    writeRange: (range: TimeRange<P>) =>
      range.kind === "preset"
        ? range.seconds === defaultPreset
          ? null
          : `${range.seconds}s`
        : `${range.from}-${range.to}`,
    readRange: (raw: string | null): TimeRange<P> => {
      if (raw === null || raw === "") return defaultRange();
      const preset = /^(\d+)s$/.exec(raw);
      if (preset) {
        const seconds = Number(preset[1]);
        const known = presets.find((candidate) => candidate === seconds);
        return known === undefined
          ? defaultRange()
          : { kind: "preset", seconds: known };
      }
      const custom = /^(\d+)-(\d+)$/.exec(raw);
      if (custom) {
        const from = Number(custom[1]);
        const to = Number(custom[2]);
        return rangeProblem(from, to) === null
          ? { kind: "custom", from, to }
          : defaultRange();
      }
      return defaultRange();
    },
    describeRange: (range: TimeRange<P>): string => {
      if (range.kind === "preset") return labels[range.seconds];
      const format = (value: number) =>
        new Date(value).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        });
      return `${format(range.from)} — ${format(range.to)}`;
    },
  });
}
