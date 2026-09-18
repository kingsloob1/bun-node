/** The windows offered, in minutes (the API allows 1..1440). */
export const THROUGHPUT_WINDOWS = [15, 60, 360, 1440] as const;

/** One window. */
export type ThroughputWindow = (typeof THROUGHPUT_WINDOWS)[number];

/** The default window. */
export const DEFAULT_WINDOW: ThroughputWindow = 60;

/** Labels of the windows. */
export const WINDOW_LABELS: Readonly<Record<ThroughputWindow, string>> = {
  15: "Last 15 minutes",
  60: "Last hour",
  360: "Last 6 hours",
  1440: "Last 24 hours",
};

/** Height of the plot, in viewBox units. */
export const PLOT_HEIGHT = 120;

/** Gap between stacked segments, in viewBox units. */
export const SEGMENT_GAP = 2;

/** Formats a bucket's minute in the browser's time zone. */
const minuteFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

/** `"12:04"` for a bucket start. */
export function formatMinute(at: number): string {
  return minuteFormat.format(new Date(at));
}

/** Reads the window from its URL value, falling back to the default. */
export function parseWindowParam(raw: string | null): ThroughputWindow {
  const value = Number(raw);
  return (
    THROUGHPUT_WINDOWS.find((window) => window === value) ?? DEFAULT_WINDOW
  );
}
