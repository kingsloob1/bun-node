/**
 * multer 2.4's field-name limits, `limits.fieldNestingDepth` and
 * `limits.fieldArrayIndexLimit`, with platform-express 12.2's defaults.
 *
 * A bracketed field name builds structure: `a[b][c]` nests two levels, and
 * `arr[4294967294]` builds an array 4294967295 long — a memory hazard from
 * a single small form field. multer checks every text field's name against
 * both limits before `append-field` places it, and so does bun-common, before
 * its field inflator (the query-string parser) does.
 */
import { UploadError } from "./errors";

/** The two field-name limits, as multer 2.4 names them. */
export interface FieldNameLimits {
  /**
   * The deepest a field name may nest: `a[b][c]` has 2 levels. A name nesting
   * deeper is refused with `LIMIT_FIELD_NESTING`. `Infinity` turns the check
   * off.
   */
  fieldNestingDepth: number;
  /**
   * The largest array index a field name may hold: `a[3]` uses index 3. A
   * larger one is refused with `LIMIT_FIELD_ARRAY_INDEX`. `Infinity` turns
   * the check off.
   */
  fieldArrayIndexLimit: number;
}

/**
 * bun-common's defaults for the field-name limits, applied wherever one is
 * unset: platform-express 12.2's `DEFAULT_FIELD_NAME_LIMITS` (multer itself
 * leaves both at `Infinity`). `32` is the nesting depth body-parser allows in
 * urlencoded bodies; `1000` the number of parameters it parses.
 */
export const DEFAULT_FIELD_NAME_LIMITS: Readonly<FieldNameLimits> =
  Object.freeze({
    fieldNestingDepth: 32,
    fieldArrayIndexLimit: 1000,
  });

/**
 * Checks a field-name limit as multer's `validateLimits` does: a
 * non-negative integer or `Infinity`, or unset (`undefined`/`null`).
 *
 * @throws {TypeError} `Expected limits.<key> to be a non-negative integer or
 *   Infinity`, multer's own message, for anything else — a misconfiguration,
 *   so not an {@link UploadError}.
 */
export function validateFieldNameLimits(
  limits: Partial<Record<keyof FieldNameLimits, unknown>> | undefined,
): void {
  if (limits == null) {
    return;
  }
  for (const key of ["fieldNestingDepth", "fieldArrayIndexLimit"] as const) {
    const value = limits[key];
    if (value == null) {
      continue;
    }
    if (
      (typeof value === "number" && Number.isInteger(value) && value >= 0) ||
      value === Infinity
    ) {
      continue;
    }
    throw new TypeError(
      `Expected limits.${key} to be a non-negative integer or Infinity`,
    );
  }
}

/**
 * The field-name limits in force: each one given, else its
 * {@link DEFAULT_FIELD_NAME_LIMITS} entry (`null` counts as unset, as
 * platform-express's `??` does).
 *
 * @throws {TypeError} for a limit that is not a non-negative integer or
 *   `Infinity` (see {@link validateFieldNameLimits}).
 */
export function resolveFieldNameLimits(
  limits: Partial<Record<keyof FieldNameLimits, unknown>> | undefined,
): FieldNameLimits {
  validateFieldNameLimits(limits);
  return {
    fieldNestingDepth:
      (limits?.fieldNestingDepth as number | null | undefined) ??
      DEFAULT_FIELD_NAME_LIMITS.fieldNestingDepth,
    fieldArrayIndexLimit:
      (limits?.fieldArrayIndexLimit as number | null | undefined) ??
      DEFAULT_FIELD_NAME_LIMITS.fieldArrayIndexLimit,
  };
}

/**
 * The names multer's `exceedsArrayIndexLimit` considers: those `append-field`
 * parses as a bracket path (`a[b][0]`, `a[]`), not those it stores as a
 * literal key (`a[6]suffix`, `[6]`).
 */
const APPEND_FIELD_PATH = /^[^[]+(?:\[[^\]]+\])*(?:\[\])?$/;

/** A bracketed run of digits: an array index to `append-field` and to picoquery. */
const ARRAY_INDEX = /\[(\d+)\]/g;

/** How many times `char` occurs in `name`. */
function countChar(name: string, char: string): number {
  let count = 0;
  for (
    let at = name.indexOf(char);
    at !== -1;
    at = name.indexOf(char, at + 1)
  ) {
    count++;
  }
  return count;
}

/**
 * Whether any array index in `name` exceeds `limit`. `pathOnly` restricts
 * the check to the names multer checks ({@link APPEND_FIELD_PATH}).
 */
function exceedsArrayIndexLimit(
  name: string,
  limit: number,
  pathOnly: boolean,
): boolean {
  if (limit === Infinity || !name.includes("[")) {
    return false;
  }
  if (pathOnly && !APPEND_FIELD_PATH.test(name)) {
    return false;
  }
  ARRAY_INDEX.lastIndex = 0;
  for (
    let match = ARRAY_INDEX.exec(name);
    match !== null;
    match = ARRAY_INDEX.exec(name)
  ) {
    if (Number(match[1]) > limit) {
      return true;
    }
  }
  return false;
}

/**
 * Checks one field name against the field-name limits, as multer does for a
 * text field right after `fieldNameSize` and before placing it: nesting
 * first (`LIMIT_FIELD_NESTING`), then array indexes
 * (`LIMIT_FIELD_ARRAY_INDEX`). Answers the refusal, `field` naming the
 * field, or `undefined` when the name passes.
 *
 * `defaultInflator` says the name goes through bun-common's default
 * inflator, the query-string parser, which builds more from a name than
 * `append-field` does, so the checks cover what it builds: a `.` nests as a
 * `[` does (`a.b` is `{ a: { b } }`), and a bracketed index builds an array
 * wherever it sits (`a[5]suffix` too). Otherwise the checks are multer's
 * exactly: one level per `[`, and indexes only in a name `append-field`
 * reads as a path.
 */
export function checkFieldName(
  name: string,
  limits: FieldNameLimits,
  defaultInflator: boolean,
): UploadError | undefined {
  const { fieldNestingDepth, fieldArrayIndexLimit } = limits;
  if (fieldNestingDepth !== Infinity) {
    const depth =
      countChar(name, "[") + (defaultInflator ? countChar(name, ".") : 0);
    if (depth > fieldNestingDepth) {
      return new UploadError("LIMIT_FIELD_NESTING", { field: name });
    }
  }
  if (exceedsArrayIndexLimit(name, fieldArrayIndexLimit, !defaultInflator)) {
    return new UploadError("LIMIT_FIELD_ARRAY_INDEX", { field: name });
  }
  return undefined;
}
