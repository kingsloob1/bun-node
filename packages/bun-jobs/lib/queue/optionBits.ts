import type { EditableJobOptionKey } from "../drivers/driver";
import type { JobOptions } from "./types";

/**
 * The explicit-options bitmask, on its own.
 *
 * It lives apart from `jobDefaults.ts` (which re-exports it) because the add
 * path needs {@link explicitMaskOf} and nothing else from there, and
 * `options.ts` is imported by a spawned run's child: pulling `jobDefaults.ts`
 * in drags the API contract's constants and `windows.ts` into every child's
 * module graph, measured at a few milliseconds per spawn. So this module has
 * **no runtime imports** — keep it that way (`fix-runner-child.test.ts`
 * counts the child's modules).
 *
 * The key list is written out here rather than read from `JOB_DEFAULT_KEYS`,
 * for the same reason; a test asserts the two name the same keys.
 */

/**
 * Each editable option's bit in `opts.explicit`. Internal to the storage
 * format — the API serialises the mask as a list of keys (`explicitKeys` in
 * `jobDefaults.ts`), never the number.
 *
 * **Never renumber a bit**: stored jobs carry these values.
 */
export const JOB_OPTION_BITS: Readonly<Record<EditableJobOptionKey, number>> =
  Object.freeze({
    attempts: 1,
    backoff: 2,
    timeout: 4,
    priority: 8,
    removeOnComplete: 16,
    removeOnFail: 32,
    keepLogs: 64,
    keepStacktraces: 128,
  });

/** Every bit of {@link JOB_OPTION_BITS} set: a job whose every editable option was explicit. */
export const ALL_JOB_OPTION_BITS = 255;

/** The keys of {@link JOB_OPTION_BITS}, in bit order. */
const OPTION_KEYS = Object.keys(JOB_OPTION_BITS) as EditableJobOptionKey[];

/**
 * The mask of the editable options a call passed itself: a bit for every key
 * whose value in `options` is not `undefined`. Only the call's **own**
 * options — never the queue's `defaultJobOptions` or a `define()`
 * definition's, which are defaults a stored override may replace.
 */
export function explicitMaskOf(options: JobOptions | undefined): number {
  let mask = 0;

  if (!options) {
    return mask;
  }

  for (const key of OPTION_KEYS) {
    if (options[key] !== undefined) {
      mask |= JOB_OPTION_BITS[key];
    }
  }

  return mask;
}
