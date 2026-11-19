/**
 * bun-cache on bun-sql (PR-D0c): the options bun-cache hands every bun-sql
 * function that can refuse an argument, so a refusal is still the
 * `TypeError` bun-cache has always thrown, message for message (bun-security
 * plan §17.16, decision 3). bun-cache has no config error: a malformed
 * connection or table name is a programmer's mistake.
 *
 * One frozen object: bun-sql caches its dialects per error maker, so every
 * bun-cache driver shares one set.
 */
import type { SqlErrorOptions } from "@kingsleyweb/bun-sql";

/** bun-cache's `TypeError`, as bun-sql's error maker. */
export const CACHE_SQL: SqlErrorOptions = Object.freeze({
  configError: (message: string) => new TypeError(message),
});
