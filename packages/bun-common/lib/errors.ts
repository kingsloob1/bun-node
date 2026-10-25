/**
 * The package's error types that several modules share.
 *
 * bun-common's errors mostly live beside what throws them
 * (`PayloadTooLargeError` in `BunRequest.ts`, `ContractError` in
 * `contract/`, `PathSyntaxError` in `utils/expressPath.ts`); this module is
 * for the ones with no single home — today only {@link ConfigError}, thrown
 * by the docs generator (`lib/docs/`) and anything else checking a caller's
 * configuration.
 */

/**
 * An option is missing, malformed or contradictory: a configuration mistake,
 * never a runtime failure — the fix is to the configuration, not a retry.
 * bun-jobs keeps its own `ConfigError` (a `JobsError`); the modules of
 * bun-jobs' that moved here throw this one, and bun-jobs' shims translate it
 * back (`packages/bun-jobs/lib/api/spec/security.ts`).
 */
export class ConfigError extends Error {
  /** The offending values, safe to log. */
  readonly details?: Record<string, unknown>;

  constructor(
    /** What is wrong, and ideally how to fix it. */
    message: string,
    /** The offending values, safe to log. */
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConfigError";
    if (details !== undefined) {
      this.details = details;
    }
  }
}
