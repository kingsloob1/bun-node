import { ConfigError } from "./errors";

/**
 * Saying *when* in the words people use for it.
 *
 * `every("2 days")` and `on("2nd december 2026")` are how a schedule reads
 * aloud, and a scheduling API that only takes milliseconds makes every caller
 * write the arithmetic — `2 * 24 * 60 * 60 * 1000` — which is both noise and a
 * place to be wrong by a factor of sixty.
 *
 * The two halves are split on purpose, because their costs differ. A *duration*
 * is a small, closed grammar and is parsed here, with no dependency: nothing
 * about "90 seconds" needs a library. A *date* is not — "2nd december 2026",
 * "next friday", "tomorrow at 9" is natural language, and doing it properly is
 * what `chrono-node` exists for.
 *
 * So `chrono-node` is an **optional peer**: a caller who only ever says
 * "2 days" never installs it, and one who wants "next friday" is told plainly
 * what to add. The package ships raw `.ts`, so a hard dependency would land in
 * every consumer's tree for a feature most will not use.
 */

/** Milliseconds in each unit a duration may be written in. */
const UNITS: [RegExp, number][] = [
  [/^(?:ms|milliseconds?)$/i, 1],
  [/^(?:s|secs?|seconds?)$/i, 1_000],
  [/^(?:m|mins?|minutes?)$/i, 60_000],
  [/^(?:h|hrs?|hours?)$/i, 3_600_000],
  [/^(?:d|days?)$/i, 86_400_000],
  [/^(?:w|wks?|weeks?)$/i, 604_800_000],
  // Calendar months and years vary; these are the averages a *duration* can
  // mean. Anything that has to land on a particular date is a date, and goes
  // through `parseWhen` instead.
  [/^(?:mo|mons?|months?)$/i, 2_629_800_000],
  [/^(?:y|yrs?|years?)$/i, 31_557_600_000],
];

/** One `<number><unit>` pair, with or without a space between them. */
const PART = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;

/**
 * Reads a duration like `"2 days"`, `"90s"` or `"1h 30m"` as milliseconds.
 *
 * Returns `null` rather than throwing when the string is not a duration at
 * all, because the callers that use this also accept cron expressions and need
 * to tell the two apart — `"0 0 * * *"` is not a failed duration, it is a
 * different thing.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim();

  if (text.length === 0) {
    return null;
  }

  let total = 0;
  let matched = false;
  let consumed = 0;

  PART.lastIndex = 0;
  for (let part = PART.exec(text); part !== null; part = PART.exec(text)) {
    const unit = UNITS.find(([pattern]) => pattern.test(part![2]!));

    if (!unit) {
      return null;
    }

    total += Number(part[1]) * unit[1];
    consumed += part[0].length;
    matched = true;
  }

  if (!matched) {
    return null;
  }

  // Everything that was not a `<number><unit>` pair has to be separators. A
  // string like "2 days after friday" parses "2 days" and leaves words behind,
  // and answering 172800000 to that would be worse than admitting it is not a
  // duration.
  const leftover = text.replace(PART, "").trim();
  void consumed;

  return leftover.length === 0 ? total : null;
}

/** Whether a string looks like a cron expression rather than a duration. */
export function looksLikeCron(input: string): boolean {
  const fields = input.trim().split(/\s+/);

  // Five fields, or six when seconds are included. Every field of a cron
  // expression contains only these characters, which no duration does.
  return (
    (fields.length === 5 || fields.length === 6) &&
    fields.every((field) => /^[\d*/,\-?LW#]+$/.test(field))
  );
}

/**
 * Reads an instant: a `Date`, epoch milliseconds, or words.
 *
 * Words go through `chrono-node`, which is an optional peer — so this says
 * what to install rather than failing obscurely, and a caller who never writes
 * one never needs it.
 *
 * A bare duration is read as "from now", because `"in 20 minutes"` and
 * `"20 minutes"` plainly mean the same thing and only one of them reads well
 * at a call site.
 */
export function parseWhen(
  when: Date | number | string,
  what: string,
  now = Date.now(),
): number {
  if (when instanceof Date) {
    const ms = when.getTime();

    if (!Number.isFinite(ms)) {
      throw new ConfigError(`${what} is not a valid date`, { when });
    }

    return ms;
  }

  if (typeof when === "number") {
    if (!Number.isFinite(when)) {
      throw new ConfigError(`${what} is not a valid timestamp`, { when });
    }

    return when;
  }

  const duration = parseDuration(when.replace(/^in\s+/i, ""));

  if (duration !== null) {
    return now + duration;
  }

  const parsed = loadChrono(what, when).parseDate(when, new Date(now), {
    forwardDate: true,
  });

  if (!parsed) {
    throw new ConfigError(`${what} could not be understood as a date`, {
      when,
    });
  }

  return parsed.getTime();
}

/** What a recurring phrase says: how often, and over what window. */
export interface Recurrence {
  /** The interval between occurrences, in milliseconds. */
  every: number;
  /** When the series begins, when the phrase named a moment. */
  startAt?: number;
  /** When the series ends, when the phrase named one. */
  endAt?: number;
}

/** One week, which is what "every monday" repeats on. */
const WEEK_MS = 604_800_000;

/** Words that join a recurring phrase together and carry no meaning of their own. */
const FILLER = new Set([
  "every",
  "each",
  "starting",
  "start",
  "starts",
  "from",
  "beginning",
  "begins",
  "commencing",
  "on",
  "until",
  "till",
  "til",
  "through",
  "thru",
  "to",
  "between",
  "and",
  "ending",
  "ends",
  "end",
  "after",
  "at",
  "the",
  "of",
  "then",
]);

/** A unit named on its own — "every day" — which means one of it. */
const UNIT_WORDS: [RegExp, number][] = [
  [/^(?:secs?|seconds?)$/i, 1_000],
  [/^(?:mins?|minutes?)$/i, 60_000],
  [/^(?:hrs?|hours?)$/i, 3_600_000],
  [/^days?$/i, 86_400_000],
  [/^(?:wks?|weeks?)$/i, WEEK_MS],
  [/^fortnights?$/i, 2 * WEEK_MS],
  [/^months?$/i, 2_629_800_000],
  [/^(?:yrs?|years?)$/i, 31_557_600_000],
];

/** Adverbs that are an interval by themselves. */
const ADVERBS: Record<string, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  nightly: 86_400_000,
  weekly: WEEK_MS,
  fortnightly: 2 * WEEK_MS,
  monthly: 2_629_800_000,
  quarterly: 7_889_400_000,
  yearly: 31_557_600_000,
  annually: 31_557_600_000,
};

/** A weekday on its own, which chrono reads as a date but means "weekly". */
const WEEKDAY =
  /^(?:on\s+)?(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?$/i;

/** A phrase split into words, ignoring commas. */
function words(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/**
 * An interval made from words alone, or `null`.
 *
 * Every meaningful word has to be part of it: "2 days", "day", "other day",
 * "weekly". Anything left over means the words are saying something else too,
 * and a guess would be worse than handing the phrase on.
 */
function intervalFromWords(phrase: string[]): number | null {
  const meaningful = phrase.filter((word) => !FILLER.has(word.toLowerCase()));

  if (meaningful.length === 0) {
    return null;
  }

  const duration = parseDuration(meaningful.join(" "));

  if (duration !== null) {
    return duration;
  }

  const [first, second] = meaningful;
  const unitOf = (word: string) =>
    UNIT_WORDS.find(([pattern]) => pattern.test(word))?.[1];

  if (meaningful.length === 1) {
    return ADVERBS[first!.toLowerCase()] ?? unitOf(first!) ?? null;
  }

  if (meaningful.length === 2 && first!.toLowerCase() === "other") {
    const unit = unitOf(second!);
    return unit === undefined ? null : unit * 2;
  }

  return null;
}

/**
 * Reads a recurring phrase: how often, and when it starts and stops.
 *
 * ```text
 * "every 2 days"                                  every 2 days
 * "every other day", "daily", "weekly"            no parser needed
 * "every 2 weeks starting 1st december 2026"      interval + start
 * "every 2 days from 1 dec 2026 until 31 dec"     interval + start + end
 * "every 30 minutes between 1 jan and 2 jan"      interval + start + end
 * "every day at 9am"                              daily, from the next 9am
 * "every monday"                                  weekly, from the next monday
 * ```
 *
 * `chrono-node` cannot read recurrence — asked for "every 2 days", it answers
 * with the date two days from now. What it *is* good at is finding the dates in
 * a sentence and saying where they are. So the dates come from chrono, and the
 * interval is whatever is left once they are taken out, read here. A phrase
 * that is only an interval never loads chrono at all.
 *
 * **An interval is a fixed number of milliseconds**, so "every day at 9am" is
 * 9am only until the clocks change — after that it is 8am or 10am. For a wall
 * clock that has to hold across daylight saving, say it in cron with a time
 * zone: `every("0 9 * * *").tz("Europe/London")`.
 *
 * Synchronous, so a phrase that cannot be read fails where it was written.
 * Dates are read against `now`, which the builder supplies again when the job
 * is actually added: "starting tomorrow" means tomorrow from then.
 */
export function readRecurrence(
  input: string,
  what: string,
  now = Date.now(),
): Recurrence {
  const body = input.trim().replace(/^(?:every|each)\s+/i, "");
  const plain = intervalFromWords(words(body));

  if (plain !== null) {
    return { every: plain };
  }

  const results = loadChrono(what, input).parse(body, new Date(now), {
    forwardDate: true,
  });

  let every: number | undefined;
  const moments: { start: number; end?: number; weekday: boolean }[] = [];

  for (const result of [...results].sort((a, b) => a.index - b.index)) {
    // chrono reads "2 days" as a date two days away; a bare duration among the
    // results is the interval, the first time one appears.
    const duration =
      every === undefined && !result.end
        ? parseDuration(result.text.replace(/^in\s+/i, ""))
        : null;

    if (duration !== null) {
      every = duration;
      continue;
    }

    moments.push({
      start: result.start.date().getTime(),
      end: result.end ? result.end.date().getTime() : undefined,
      weekday: WEEKDAY.test(result.text.trim()),
    });
  }

  // What chrono did not claim, taken out from the end so earlier positions
  // stay valid.
  let remainder = body;
  for (const result of [...results].sort((a, b) => b.index - a.index)) {
    remainder = `${remainder.slice(0, result.index)} ${remainder.slice(result.index + result.text.length)}`;
  }

  const leftover = words(remainder).filter(
    (word) => !FILLER.has(word.toLowerCase()),
  );

  if (leftover.length > 0) {
    const fromWords = every === undefined ? intervalFromWords(leftover) : null;

    if (fromWords === null) {
      throw new ConfigError(
        `${what} could not read "${input}" as an interval: "${leftover.join(" ")}" is not part of one`,
        { input },
      );
    }

    every = fromWords;
  }

  if (every === undefined && moments[0]?.weekday) {
    every = WEEK_MS;
  }

  if (every === undefined) {
    throw new ConfigError(
      `${what} could not find how often in "${input}" — say "every 2 days", "daily", or use cron`,
      { input },
    );
  }

  if (moments.length > 2) {
    throw new ConfigError(
      `${what} found more than a start and an end in "${input}"`,
      { input },
    );
  }

  const [first, second] = moments;
  const startAt = first?.start;
  const endAt = first?.end ?? second?.start;

  return {
    every,
    ...(startAt !== undefined ? { startAt } : {}),
    ...(endAt !== undefined ? { endAt } : {}),
  };
}

/** One date chrono found in a phrase, and where. */
interface ChronoResult {
  /** Where in the phrase it starts. */
  index: number;
  /** The words it was read from. */
  text: string;
  /** The instant, or the start of a range. */
  start: { date: () => Date };
  /** The end of a range, when the words described one. */
  end?: { date: () => Date } | null;
}

/** What `chrono-node` is used for. */
interface ChronoLike {
  /** Reads a single date out of a phrase, relative to a reference instant. */
  parseDate: (
    text: string,
    reference?: Date,
    options?: { forwardDate?: boolean },
  ) => Date | null;
  /** Finds every date in a phrase, with where each one is. */
  parse: (
    text: string,
    reference?: Date,
    options?: { forwardDate?: boolean },
  ) => ChronoResult[];
}

/** `chrono-node`, loaded on first use and kept. */
let chrono: ChronoLike | undefined;

/**
 * Loads `chrono-node`, or explains what to install.
 *
 * Loaded lazily, so its 2.7MB of parsing rules cost only the callers who write
 * a phrase — and synchronously through Bun's `import.meta.require`, so a
 * builder method can read a phrase and fail on the spot instead of deferring
 * every mistake to an `await` somewhere later.
 */
function loadChrono(what: string, phrase: string): ChronoLike {
  if (chrono) {
    return chrono;
  }

  try {
    chrono = import.meta.require("chrono-node") as ChronoLike;
    return chrono;
  } catch (error) {
    throw new ConfigError(
      `${what} is a phrase ("${phrase}"), which needs the optional chrono-node package: bun add chrono-node`,
      { phrase, cause: String(error) },
    );
  }
}
