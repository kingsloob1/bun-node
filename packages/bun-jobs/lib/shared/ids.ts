import nodeCrypto from "node:crypto";
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

/**
 * A token for one claim of one or more jobs — the lock a worker's heartbeat,
 * completion and failure writes must match. Same shape as {@link newToken}, so
 * {@link parseToken} still says which host, process and worker (`scope`) holds
 * the job; the random part is a v4 UUID.
 *
 * **Drawn fresh on every call, and called at claim time.** It is what tells a
 * claim from the same worker's earlier claim of the same job, whose late
 * completion must not match it (#187). Two tempting simplifications both break
 * that, so do not make them:
 *
 * - **A per-worker token plus a counter** — or anything else computed ahead
 *   of the claim. Platforms that snapshot a process after init and restore it
 *   into several VMs (SnapStart-style microVMs) restore that state
 *   identically in every copy, so every copy would hand out the same sequence
 *   and two of them could claim under matching tokens: the same collision,
 *   moved across machines.
 * - **{@link newToken}'s UUIDv7.** Its leading bits are a clock and a
 *   sub-millisecond counter; only part of it is random.
 *
 * **Why `node:crypto` with `disableEntropyCache`, not the global
 * `crypto.randomUUID()`.** Bun's global `randomUUID()` — and
 * `crypto.getRandomValues()` for up to 256 bytes — serve from one 2 KiB buffer
 * per thread, refilled 128 UUIDs at a time (`EntropyCache` in Bun's
 * `rare_data.rs`), so the next claims' tokens would sit in memory already and a
 * snapshot would copy them: the counter above, by another name. With
 * `disableEntropyCache: true`, Bun's `node:crypto` `randomUUID` skips that
 * buffer and calls BoringSSL's `RAND_bytes` for each UUID (verified on Bun
 * 1.4.3, from its source and by timing: the buffered calls slow down every
 * 128th call, this one does not). `RAND_bytes` is itself a per-thread DRBG
 * seeded from the OS, so how far it resists a clone of the process is
 * BoringSSL's to decide; this only keeps bun-jobs from adding a buffer of its
 * own on top. It costs a few microseconds per claim call, against the
 * round trip the claim makes anyway.
 */
export function newClaimToken(scope?: string): string {
  const suffix = scope ? `:${scope}` : "";
  const id = nodeCrypto.randomUUID({ disableEntropyCache: true });
  return `${HOST}:${process.pid}:${id}${suffix}`;
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
