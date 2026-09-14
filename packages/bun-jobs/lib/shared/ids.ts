import { hostname } from "node:os";
import process from "node:process";

/**
 * Identifiers for runs, jobs and lock ownership.
 *
 * Ids are UUIDv7 so they sort by creation time — which makes them usable as
 * a tie-break for FIFO ordering, and readable in a driver's key space.
 */

/** This host's name, resolved once. Part of every lock token. */
export const HOST = hostname();

/** A fresh, time-sortable id. */
export function newId(): string {
  return Bun.randomUUIDv7();
}

/**
 * A lock-ownership token. It embeds the host, pid and a fresh id, so a held
 * lock says *who* holds it — which is what `RunnerInfo.runningOn` reports and
 * what makes a stale lock diagnosable rather than mysterious.
 */
export function newToken(scope?: string): string {
  const suffix = scope ? `:${scope}` : "";
  return `${HOST}:${process.pid}:${newId()}${suffix}`;
}

/** Splits a token back into its parts; `null` when it is not one of ours. */
export function parseToken(
  token: string,
): { host: string; pid: number; id: string; scope?: string } | null {
  const parts = token.split(":");
  if (parts.length < 3) {
    return null;
  }

  const [host, pid, id, ...rest] = parts;
  const parsedPid = Number(pid);
  if (!host || !id || !Number.isFinite(parsedPid)) {
    return null;
  }

  return {
    host,
    pid: parsedPid,
    id,
    ...(rest.length > 0 ? { scope: rest.join(":") } : {}),
  };
}
