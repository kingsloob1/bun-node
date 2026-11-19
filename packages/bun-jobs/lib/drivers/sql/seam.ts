/**
 * bun-jobs on bun-sql (PR-D0b): the options bun-jobs hands every bun-sql
 * function that can refuse an argument, so a refusal is still bun-jobs' own
 * `ConfigError` (`code: "CONFIG"`), message for message, as it was before the
 * SQL layer moved (bun-security plan §17.16, decision 3).
 *
 * One frozen object: bun-sql caches its dialects per error maker, so every
 * bun-jobs driver shares one set (and SQLite's one write lock).
 */
import type { SqlErrorOptions } from "@kingsleyweb/bun-sql";
import { ConfigError } from "../../shared/errors";

/** bun-jobs' `ConfigError`, as bun-sql's error maker. */
export const JOBS_SQL: SqlErrorOptions = Object.freeze({
  configError: (message: string, details?: Record<string, unknown>) =>
    new ConfigError(message, details),
});
