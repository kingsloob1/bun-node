/**
 * The error an unusable option or argument throws, and the seam that lets a
 * package built on bun-sql throw its own instead (bun-security plan §17.16,
 * decision 3; the pattern of bun-common's `envelopeCodec`).
 *
 * By default bun-sql throws bun-common's `ConfigError`. Every function that
 * can refuse an argument takes a `configError` option, so bun-jobs, which
 * moves onto bun-sql in PR-D0b, keeps throwing its own `ConfigError` (and
 * bun-cache a `TypeError`) with the same messages.
 */
import { ConfigError } from "@kingsleyweb/bun-common/lib/errors";

/** Makes the error an unusable option throws, from its message and the offending values. */
export type SqlConfigError = (
  message: string,
  details?: Record<string, unknown>,
) => Error;

/** Options every refusing function takes. */
export interface SqlErrorOptions {
  /** Makes the error an unusable argument throws. Default: bun-common's `ConfigError`. */
  readonly configError?: SqlConfigError;
}

/** bun-common's `ConfigError`, as a {@link SqlConfigError}. */
export const defaultConfigError: SqlConfigError = (message, details) =>
  new ConfigError(message, details);

/** The error maker `options` names, or the default. */
export function failWith(options: SqlErrorOptions | undefined): SqlConfigError {
  return options?.configError ?? defaultConfigError;
}
