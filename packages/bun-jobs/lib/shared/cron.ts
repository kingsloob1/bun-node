import { ConfigError } from "./errors";

/**
 * Cron with **optional seconds**.
 *
 * `Bun.cron` is minute-granular: it takes exactly five fields and throws on
 * six. Plenty of existing schedules are six-field, seconds-first — the
 * reference implementation this package replaces ran `*\/10 * * * * *` for
 * "every ten seconds" — so this module layers a seconds field on top of Bun's
 * parser instead of reimplementing cron or degrading to `setInterval`.
 *
 * The split is deliberate: the five remaining fields always go to
 * `Bun.cron.parse`, so names (`MON`), nicknames (`@daily`), ranges, steps,
 * the day-of-month/day-of-week OR rule and time-zone handling behave
 * exactly* as they do for `Bun.cron`. Only the seconds field is parsed here.
 *
 * ```ts
 * parseCron("*\/10 * * * * *");                   // every ten seconds
 * parseCron("0 3 * * *");                        // 03:00 daily, five-field
 * parseCron("5,35 * * * * *");                   // at :05 and :35
 * parseCron("0 9 * * MON-FRI", { tz: "UTC" });   // pinned to a zone
 * ```
 */

/** Lowest and highest value a seconds field may take. */
const MIN_SECOND = 0;
const MAX_SECOND = 59;

/** Milliseconds in a minute — the granularity `Bun.cron.parse` works at. */
const MINUTE_MS = 60_000;

/** Options shared by every function here. */
export interface CronOptions {
  /**
   * IANA time zone the expression is interpreted in (`"UTC"`,
   * `"America/New_York"`). Defaults to the **system** zone, as `Bun.cron`
   * does — so pin it explicitly whenever producers and consumers might run
   * with different `TZ` values, or the same expression will fire at
   * different instants on different hosts.
   */
  tz?: string;
}

/** A cron expression split into its seconds field and the rest. */
export interface ParsedCron {
  /** The expression as given, trimmed. */
  expression: string;
  /**
   * The seconds the expression fires at, ascending, or `null` for a
   * five-field expression (which fires at second zero, like `Bun.cron`).
   */
  seconds: number[] | null;
  /** The five-field remainder, evaluated by `Bun.cron.parse`. */
  minuteExpression: string;
  /** The time zone the expression is interpreted in, when pinned. */
  tz?: string;
}

/** Expands one comma-separated part of a seconds field. */
function expandSecondsPart(part: string, expression: string): number[] {
  const [range, stepText] = part.split("/");
  const step = stepText === undefined ? 1 : Number(stepText);

  if (
    stepText !== undefined &&
    (!Number.isInteger(step) || step <= 0 || step > MAX_SECOND + 1)
  ) {
    throw new ConfigError(
      `Invalid step "${stepText}" in the seconds field of "${expression}"`,
      { expression, part },
    );
  }

  let start: number;
  let end: number;

  if (range === "*") {
    start = MIN_SECOND;
    end = MAX_SECOND;
  } else if (range.includes("-")) {
    const bounds = range.split("-");
    // Exactly two non-empty halves: without this check "-1" splits into
    // ["", "1"] and `Number("")` is 0, silently reading a negative value as
    // the range 0-1.
    if (bounds.length !== 2 || bounds[0] === "" || bounds[1] === "") {
      throw new ConfigError(
        `Invalid seconds field "${part}" in "${expression}" — expected 0-59`,
        { expression, part },
      );
    }
    start = Number(bounds[0]);
    end = Number(bounds[1]);
  } else {
    start = Number(range);
    // A bare value with a step (`5/10`) runs to the end of the field, as in
    // standard cron; without one it is a single value.
    end = stepText === undefined ? start : MAX_SECOND;
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < MIN_SECOND ||
    end > MAX_SECOND ||
    start > end
  ) {
    throw new ConfigError(
      `Invalid seconds field "${part}" in "${expression}" — expected 0-59`,
      { expression, part },
    );
  }

  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}

/** Parses a seconds field into the ascending, de-duplicated values it matches. */
function parseSecondsField(field: string, expression: string): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    if (part.length === 0) {
      throw new ConfigError(
        `Empty entry in the seconds field of "${expression}"`,
        { expression },
      );
    }
    for (const value of expandSecondsPart(part, expression)) {
      values.add(value);
    }
  }

  return [...values].sort((a, b) => a - b);
}

/**
 * Parses a five- or six-field cron expression.
 *
 * Six fields put seconds first (`sec min hour dom mon dow`); anything else
 * goes to `Bun.cron.parse` as-is, which covers five fields and nicknames like
 * `@hourly`. Throws {@link ConfigError} naming the offending field.
 */
export function parseCron(
  expression: string,
  options?: CronOptions,
): ParsedCron {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    throw new ConfigError("A cron expression is required", { expression });
  }

  const trimmed = expression.trim();
  const fields = trimmed.split(/\s+/);

  if (fields.length > 6) {
    throw new ConfigError(
      `"${trimmed}" has ${fields.length} fields — expected 5, or 6 with seconds first`,
      { expression: trimmed },
    );
  }

  const hasSeconds = fields.length === 6;
  const seconds = hasSeconds ? parseSecondsField(fields[0], trimmed) : null;
  const minuteExpression = hasSeconds ? fields.slice(1).join(" ") : trimmed;

  try {
    // Bun validates the remaining fields (and the time zone), so names,
    // nicknames, ranges, steps and the dom/dow OR rule stay exactly Bun's.
    Bun.cron.parse(minuteExpression, undefined, options);
  } catch (error) {
    throw new ConfigError(
      `Invalid cron expression "${trimmed}": ${(error as Error).message}`,
      { expression: trimmed, tz: options?.tz },
    );
  }

  return {
    expression: trimmed,
    seconds,
    minuteExpression,
    ...(options?.tz ? { tz: options.tz } : {}),
  };
}

/** Whether {@link parseCron} accepts `expression`. */
export function validateCron(
  expression: string,
  options?: CronOptions,
): boolean {
  try {
    parseCron(expression, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * The next time `cron` fires, strictly after `from` (default: now), or `null`
 * when it never will — `Bun.cron.parse` gives up after eight years, which is
 * how an impossible expression like `"0 0 30 2 *"` reports itself.
 *
 * Five-field expressions go straight to `Bun.cron.parse`. Six-field ones use
 * it for the minute and pick the second here: the next matching second within
 * the current minute when that minute matches, otherwise the first configured
 * second of the next matching minute. So `*\/10 * * * * *` fires on the
 * ten-second mark of the wall clock rather than ten seconds after whenever it
 * started — a schedule of `{ every: 10_000 }` is the way to ask for that.
 */
export function nextCronDate(
  cron: string | ParsedCron,
  from?: Date,
  options?: CronOptions,
): Date | null {
  const parsed = typeof cron === "string" ? parseCron(cron, options) : cron;
  const tzOptions = { tz: options?.tz ?? parsed.tz };
  const fromMs = (from ?? new Date()).getTime();

  if (parsed.seconds === null) {
    return Bun.cron.parse(parsed.minuteExpression, fromMs, tzOptions);
  }

  // Minute boundaries are the same instant in every IANA zone (offsets are
  // whole minutes), so flooring in epoch terms is time-zone independent.
  const startOfMinute = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS;

  // `Bun.cron.parse` is strictly-after, so searching from one millisecond
  // before this minute returns this minute itself when it matches.
  const thisMinute = Bun.cron.parse(
    parsed.minuteExpression,
    startOfMinute - 1,
    tzOptions,
  );

  if (thisMinute?.getTime() === startOfMinute) {
    for (const second of parsed.seconds) {
      const candidate = startOfMinute + second * 1000;
      if (candidate > fromMs) {
        return new Date(candidate);
      }
    }
  }

  // Strictly-after again: searching from the start of this minute skips it.
  const nextMinute = Bun.cron.parse(
    parsed.minuteExpression,
    startOfMinute,
    tzOptions,
  );

  return nextMinute
    ? new Date(nextMinute.getTime() + parsed.seconds[0] * 1000)
    : null;
}
