/**
 * Fitting a name this package derived into a store that bounds it.
 *
 * Every backend bounds something: MySQL and MariaDB a `VARCHAR(191)` column
 * (characters), the file driver a file name (bytes, after its encoding). A name
 * the caller chose is *checked* against those limits and refused when it does
 * not fit, so they find out at the call that supplied it. A name this package
 * built — a dead-letter id, a repeat occurrence, a window pointer, a stored
 * series key — is *fitted* instead, because refusing it would throw somewhere
 * the caller never chose.
 */

/** What a fitted name must stay within. */
export interface FitLimits {
  /** The most UTF-16 code units the name may have. */
  maxLength: number;
  /**
   * A second bound in some other unit, with the function that measures it —
   * the file driver's encoded byte length, for instance. Checked alongside
   * {@link FitLimits.maxLength}; both must hold.
   */
  measured?: {
    /** The most the measure may report. */
    max: number;
    /** Measures a candidate name. Must be additive over concatenation. */
    measure: (value: string) => number;
  };
}

/** Whether `value` is inside every bound in `limits`. */
export function fitsWithin(value: string, limits: FitLimits): boolean {
  return (
    value.length <= limits.maxLength &&
    (limits.measured === undefined ||
      limits.measured.measure(value) <= limits.measured.max)
  );
}

/**
 * `value` itself when it fits, and otherwise as much of its head as fits
 * followed by `~` and a hash of the *whole* value.
 *
 * **A pure function of its input and limits.** Two processes deriving one name
 * independently — two workers scheduling one repeat occurrence, two producers
 * opening one debounce window — must reach the same string, or an add that
 * should have been idempotent writes twice.
 *
 * **Distinct inputs stay distinct**, with a 64-bit hash's odds: the hash is of
 * the whole value, so two names that share a long head and differ only past
 * the cut — exactly what plain truncation merges — end differently.
 *
 * **Idempotent:** a fitted name fits, so fitting it again returns it
 * unchanged. A driver can therefore be handed either spelling.
 *
 * The head is cut on a code-point boundary, never inside a surrogate pair, so
 * the result is well formed whenever the input was. Throws a `RangeError` only
 * when the limits cannot hold even the hash suffix.
 */
export function fitName(value: string, limits: FitLimits): string {
  if (fitsWithin(value, limits)) {
    return value;
  }

  // `Bun.hash` in base 36, as `arrivals.ts` does for channel names.
  const suffix = `~${Bun.hash(value).toString(36)}`;

  if (!fitsWithin(suffix, limits)) {
    throw new RangeError(
      `a name cannot be fitted into ${limits.maxLength} characters`,
    );
  }

  const measure = limits.measured?.measure;
  const lengthRoom = limits.maxLength - suffix.length;
  const measuredRoom =
    limits.measured === undefined
      ? Number.POSITIVE_INFINITY
      : limits.measured.max - limits.measured.measure(suffix);

  let length = 0;
  let measured = 0;

  for (const char of value) {
    const nextLength = length + char.length;
    const nextMeasured = measure ? measured + measure(char) : 0;

    if (nextLength > lengthRoom || nextMeasured > measuredRoom) {
      break;
    }

    length = nextLength;
    measured = nextMeasured;
  }

  return `${value.slice(0, length)}${suffix}`;
}
