import type { RunnerScheduleDto, ScheduleRunnerBody } from "../../../api/types";

/**
 * The schedule editor's pure half: a form value, its prefill from the stored
 * schedule, its validation, and the `PUT /runners/:runner/schedule` body it
 * becomes. The API stays the authority (a cron expression and a time zone
 * are only fully checked by `Bun.cron` on the server, which answers 400
 * `INVALID_SCHEDULE`); this catches what can be caught before sending.
 */

/** Which kind of schedule the editor edits. */
export type ScheduleMode = "cron" | "every" | "at" | "none";

/** The unit an interval is typed in. */
export type IntervalUnit = "seconds" | "minutes" | "hours";

/** A form field that can carry an error. */
export type ScheduleField = "cron" | "tz" | "every" | "anchor" | "at";

/** Errors per field. */
export type ScheduleErrors = Partial<Record<ScheduleField, string>>;

/** The editor's state. Every mode's inputs are kept, so switching modes loses nothing. */
export interface ScheduleForm {
  /** The chosen kind. */
  mode: ScheduleMode;
  /** Cron expression (5 fields, 6 with seconds first, or a nickname such as `@daily`). */
  cron: string;
  /** IANA time zone for the cron expression; `""` for the server's zone. */
  tz: string;
  /** Interval amount in {@link everyUnit}; `undefined` when empty. */
  everyAmount: number | undefined;
  /** The interval's unit. */
  everyUnit: IntervalUnit;
  /** Anchor of the interval grid, epoch ms; `undefined` for none (measured from each start). */
  anchor: number | undefined;
  /** The one-off time, epoch ms; `undefined` when empty. */
  at: number | undefined;
}

/** Milliseconds per interval unit. */
export const INTERVAL_UNIT_MS: Readonly<Record<IntervalUnit, number>> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
};

/** The longest cron expression the API accepts (`ScheduleBodySchema`). */
export const MAX_CRON_LENGTH = 200;
/** The longest time zone the API accepts (`ScheduleBodySchema`). */
export const MAX_TZ_LENGTH = 100;

/** An empty form in `mode`. */
export function emptyScheduleForm(mode: ScheduleMode = "none"): ScheduleForm {
  return {
    mode,
    cron: "",
    tz: "",
    everyAmount: undefined,
    everyUnit: "minutes",
    anchor: undefined,
    at: undefined,
  };
}

/** Splits ms into the largest unit that holds it exactly (seconds as a fraction when nothing does). */
export function splitInterval(ms: number): {
  amount: number;
  unit: IntervalUnit;
} {
  for (const unit of ["hours", "minutes", "seconds"] as const) {
    if (ms % INTERVAL_UNIT_MS[unit] === 0) {
      return { amount: ms / INTERVAL_UNIT_MS[unit], unit };
    }
  }
  return { amount: ms / INTERVAL_UNIT_MS.seconds, unit: "seconds" };
}

/** The form for a stored schedule (`RunnerInfoDto.schedule`). */
export function formFromSchedule(schedule: RunnerScheduleDto): ScheduleForm {
  const form = emptyScheduleForm();
  if (schedule === null) {
    return form;
  }
  if ("cron" in schedule) {
    return {
      ...form,
      mode: "cron",
      cron: schedule.cron,
      tz: schedule.tz ?? "",
    };
  }
  if ("every" in schedule) {
    const { amount, unit } = splitInterval(schedule.every);
    return {
      ...form,
      mode: "every",
      everyAmount: amount,
      everyUnit: unit,
      anchor: schedule.anchor,
    };
  }
  return { ...form, mode: "at", at: schedule.at };
}

/** An interval in a unit as whole ms, or `undefined` when it is not a positive amount (or rounds to 0 ms). */
export function intervalMs(
  amount: number | undefined,
  unit: IntervalUnit,
): number | undefined {
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const ms = Math.round(amount * INTERVAL_UNIT_MS[unit]);
  return ms >= 1 ? ms : undefined;
}

/** The time zones this browser knows (`Intl.supportedValuesOf`), or `null` when it cannot list them. */
export function supportedTimeZones(): readonly string[] | null {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  if (typeof intl.supportedValuesOf !== "function") {
    return null;
  }
  try {
    return intl.supportedValuesOf("timeZone");
  } catch {
    return null;
  }
}

/**
 * Whether `tz` names an IANA time zone. It is checked against
 * `Intl.supportedValuesOf("timeZone")` when the browser has it (case
 * insensitively), then against `Intl.DateTimeFormat` — the list holds only
 * canonical names, so an alias such as `US/Eastern`, which the server's
 * `Bun.cron` accepts, would otherwise be refused. A UTC offset (`+01:00`) is
 * not a zone: `Intl` accepts it, `Bun.cron` does not.
 */
export function isValidTimeZone(
  tz: string,
  zones: readonly string[] | null = supportedTimeZones(),
): boolean {
  const name = tz.trim();
  if (name === "" || /^[+-]\d/.test(name)) {
    return false;
  }
  const lower = name.toLowerCase();
  if (zones?.some((zone) => zone.toLowerCase() === lower)) {
    return true;
  }
  try {
    const format = Intl.DateTimeFormat("en", { timeZone: name });
    return format.resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}

/**
 * The shape check the server's parser applies before `Bun.cron` sees the
 * expression: 5 fields, 6 with seconds first, or a single `@nickname`.
 * Returns the problem, or `null` when it looks right.
 */
export function cronShapeError(expression: string): string | null {
  const trimmed = expression.trim();
  if (trimmed === "") {
    return "Enter a cron expression.";
  }
  if (trimmed.length > MAX_CRON_LENGTH) {
    return `At most ${MAX_CRON_LENGTH} characters.`;
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length === 1 && trimmed.startsWith("@")) {
    return null;
  }
  if (fields.length !== 5 && fields.length !== 6) {
    return `${fields.length} field${fields.length === 1 ? "" : "s"}: expected 5, 6 with seconds first, or a nickname such as @daily.`;
  }
  return null;
}

/** Validates the form for its mode. `zones` is what {@link isValidTimeZone} checks against. */
export function validateScheduleForm(
  form: ScheduleForm,
  zones: readonly string[] | null = supportedTimeZones(),
): ScheduleErrors {
  const errors: ScheduleErrors = {};
  switch (form.mode) {
    case "cron": {
      const cron = cronShapeError(form.cron);
      if (cron) {
        errors.cron = cron;
      }
      const tz = form.tz.trim();
      if (tz.length > MAX_TZ_LENGTH) {
        errors.tz = `At most ${MAX_TZ_LENGTH} characters.`;
      } else if (tz !== "" && !isValidTimeZone(tz, zones)) {
        errors.tz = `“${tz}” is not a known time zone. Use an IANA name such as Europe/London or UTC.`;
      }
      break;
    }
    case "every":
      if (intervalMs(form.everyAmount, form.everyUnit) === undefined) {
        errors.every = "Enter an interval greater than zero.";
      }
      break;
    case "at":
      if (form.at === undefined) {
        errors.at = "Pick a date and time.";
      }
      break;
    case "none":
      break;
  }
  return errors;
}

/** The request body's `schedule` for a valid form; `null` unschedules. */
export function scheduleBody(
  form: ScheduleForm,
): ScheduleRunnerBody["schedule"] {
  switch (form.mode) {
    case "cron": {
      const tz = form.tz.trim();
      return { cron: form.cron.trim(), ...(tz ? { tz } : {}) };
    }
    case "every":
      return {
        every: intervalMs(form.everyAmount, form.everyUnit) ?? 0,
        ...(form.anchor === undefined ? {} : { anchor: form.anchor }),
      };
    case "at":
      return { at: form.at ?? 0 };
    case "none":
      return null;
  }
}

/** The field a mode's main value lives in (where a whole-schedule error goes). */
export function mainField(mode: ScheduleMode): ScheduleField | null {
  switch (mode) {
    case "cron":
      return "cron";
    case "every":
      return "every";
    case "at":
      return "at";
    case "none":
      return null;
  }
}

/**
 * The field a 400 `INVALID_SCHEDULE` belongs to. Its detail is the server's
 * `ConfigError` message: for a cron schedule one naming a time zone is the
 * zone's (`Bun.cron: unknown time zone 'Mars/Base'`), anything else the
 * expression's; for the other modes it is the mode's value.
 */
export function invalidScheduleField(
  mode: ScheduleMode,
  detail: string | undefined,
): ScheduleField | null {
  if (mode === "cron" && /time ?zone/i.test(detail ?? "")) {
    return "tz";
  }
  if (mode === "every" && /anchor/i.test(detail ?? "")) {
    return "anchor";
  }
  return mainField(mode);
}

/**
 * `VALIDATION` field errors (keys are paths within the body, e.g.
 * `schedule.tz`) mapped onto the editor's fields. A path the editor has no
 * input for (`schedule` itself, a union mismatch) goes to the mode's main
 * field; with no field to show it on (mode none), it is returned as `other`.
 */
export function scheduleFieldErrors(
  fieldErrors: Readonly<Record<string, string>>,
  mode: ScheduleMode,
): { fields: ScheduleErrors; other: string | undefined } {
  const fields: ScheduleErrors = {};
  let other: string | undefined;
  for (const [path, message] of Object.entries(fieldErrors)) {
    const leaf = /^schedule\.(cron|tz|every|anchor|at)\b/.exec(path)?.[1] as
      | ScheduleField
      | undefined;
    const field = leaf ?? mainField(mode);
    if (field) {
      fields[field] ??= message;
    } else {
      other ??= message;
    }
  }
  return { fields, other };
}
