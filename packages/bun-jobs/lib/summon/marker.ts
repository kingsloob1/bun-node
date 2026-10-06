import type { QueueStateEntry } from "../drivers/index";
import type { SummonDedupe, SummonMarker, WatchedSummon } from "./types";
import { randomUUID } from "node:crypto";
import { RESERVED_STATE_PREFIX } from "../queue/windows";

/**
 * The in-flight marker: one reserved queue-state entry per queue, shared by
 * every controller on it, written only by compare-and-set.
 *
 * Internal: nothing here is exported from the package.
 */

/** The marker's queue-state name. Reserved, so a caller's `setQueueState` cannot write it. */
export const SUMMON_MARKER = `${RESERVED_STATE_PREFIX}summon`;

/** One hour, the budget's short window. */
export const HOUR_MS = 3_600_000;

/** One day, the budget's long window. */
export const DAY_MS = 86_400_000;

/** RFC 4648 base32, lowercase: safe in a Kubernetes name, a systemd unit and a token. */
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Encodes bytes as lowercase base32, unpadded. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    out += BASE32[(buffer << (5 - bits)) & 31];
  }
  return out;
}

/**
 * A fresh marker epoch: a version-4 UUID's 122 random bits, as 32 hex
 * characters.
 *
 * **From an unbuffered source**, `node:crypto`'s `randomUUID({
 * disableEntropyCache: true })`, not the global `crypto.randomUUID()` or
 * `getRandomValues`: those draw from an entropy cache that a VM snapshot
 * copies, so two processes restored from one snapshot (Lambda SnapStart, a
 * MicroVM restore) could mint the same value. That matters here because a
 * one-shot `check()` is exactly what runs in such a function: if two restored
 * copies each created the marker at different times — the second after a
 * purge — a shared epoch would hand out the very attempt ids it exists to
 * keep apart. About 3 µs, once per marker.
 */
export function newEpoch(): string {
  return randomUUID({ disableEntropyCache: true }).replaceAll("-", "");
}

/** Characters of an attempt id's hash part: 26 base32 characters, 130 bits. */
const ID_HASH_LENGTH = 26;

/**
 * An attempt's id: `sm_` + base32 of SHA-256 over the namespace, the queue,
 * the marker's `epoch` and the version the claim writes.
 *
 * Deterministic for one claim, so a retried call is byte-identical. Unique
 * across claims: the compare-and-set lets exactly one claim write a given
 * version under one epoch, and a deleted or purged marker comes back with a
 * new epoch — its version restarts at `1`, so the version alone would repeat
 * an id a platform may still remember (ECS keeps a `clientToken` for up to
 * 24 h, and answers a repeat `deduped`, starting nothing).
 */
export function attemptId(
  /** The queue's namespace. */
  namespace: string,
  /** The queue. */
  queue: string,
  /** The marker's epoch. */
  epoch: string,
  /** The version the claim writes. */
  version: number,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  // NUL-separated: no field can contain one, so no two tuples hash alike.
  hasher.update(`${namespace}\u0000${queue}\u0000${epoch}\u0000${version}`);
  const digest = new Uint8Array(hasher.digest().buffer);
  return `sm_${base32(digest).slice(0, ID_HASH_LENGTH)}`;
}

/** The dedupe key's limits when the summoner declares none. */
const DEFAULT_KEY = { maxLength: 64, charset: "A-Za-z0-9-" } as const;

/**
 * Builds the function that turns an attempt id into a dedupe key: the id with
 * every character outside the declared charset removed, then clipped to the
 * declared length. Built once per controller, so a charset that is not a
 * valid character class fails at construction.
 */
export function dedupeKeyFor(dedupe: SummonDedupe): (id: string) => string {
  const { maxLength, charset } = dedupe.kind === "none" ? DEFAULT_KEY : dedupe;
  const outside = new RegExp(`[^${charset}]`, "g");
  return (id) => id.replace(outside, "").slice(0, maxLength);
}

/** A fresh marker for `now`, with a new epoch. */
export function freshMarker(now: number): SummonMarker {
  return {
    v: 1,
    epoch: newEpoch(),
    pending: [],
    failures: 0,
    budget: {
      hourStart: Math.floor(now / HOUR_MS) * HOUR_MS,
      hour: 0,
      dayStart: Math.floor(now / DAY_MS) * DAY_MS,
      day: 0,
    },
  };
}

/** Whether `value` is a finite number. */
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Whether `value` is an optional finite number. */
function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isNumber(value);
}

/** Whether a stored value has the marker's shape, deeply enough to act on. */
export function isSummonMarker(value: unknown): value is SummonMarker {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const marker = value as Record<string, unknown>;
  const budget = marker.budget as Record<string, unknown> | undefined;
  return (
    marker.v === 1 &&
    typeof marker.epoch === "string" &&
    marker.epoch.length > 0 &&
    isNumber(marker.failures) &&
    isOptionalNumber(marker.lastAttemptAt) &&
    isOptionalNumber(marker.backoffUntil) &&
    isOptionalNumber(marker.circuitOpenUntil) &&
    typeof budget === "object" &&
    budget !== null &&
    isNumber(budget.hourStart) &&
    isNumber(budget.hour) &&
    isNumber(budget.dayStart) &&
    isNumber(budget.day) &&
    Array.isArray(marker.pending) &&
    marker.pending.every((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }
      const pending = entry as Record<string, unknown>;
      return (
        typeof pending.id === "string" &&
        isNumber(pending.at) &&
        isNumber(pending.until) &&
        isNumber(pending.count) &&
        typeof pending.kind === "string"
      );
    })
  );
}

/**
 * The shape version of a marker written by a **newer** bun-jobs: an object
 * whose `v` is a whole number above the `1` this build writes. `undefined`
 * for anything else, garbage included.
 */
export function newerMarkerVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const v = (value as { v?: unknown }).v;
  return typeof v === "number" && Number.isSafeInteger(v) && v > 1
    ? v
    : undefined;
}

/** A marker read from the driver, with the version to write it back at. */
export interface MarkerRead {
  /** The marker, a private copy the caller may change. */
  marker: SummonMarker;
  /** The version it was read at, `null` when there is no entry yet. */
  version: number | null;
  /**
   * Whether an entry existed that is neither a marker nor a newer one:
   * garbage, which a fresh marker is written over.
   */
  unreadable: boolean;
  /**
   * The shape version of a marker a newer bun-jobs wrote, which this build
   * must not write over: set, and `marker` is a fresh one never to be
   * written. `undefined` otherwise.
   */
  newer?: number;
}

/**
 * The marker in a queue-state entry, as a private copy. No entry gives a
 * fresh marker to create at `null`; an entry that is not a marker gives a
 * fresh one to write over it at its version — except a marker a newer
 * bun-jobs wrote (`v` above 1), which is reported as `newer` and must be
 * left alone.
 */
export function readMarker(
  entry: QueueStateEntry | null,
  now: number,
): MarkerRead {
  if (entry === null) {
    return { marker: freshMarker(now), version: null, unreadable: false };
  }
  const newer = newerMarkerVersion(entry.value);
  if (newer !== undefined) {
    return {
      marker: freshMarker(now),
      version: entry.version,
      unreadable: false,
      newer,
    };
  }
  if (!isSummonMarker(entry.value)) {
    return {
      marker: freshMarker(now),
      version: entry.version,
      unreadable: true,
    };
  }
  const marker = structuredClone(entry.value);
  // Optional and newer than the rest: absent, or not the shape this build
  // writes, is "nothing watched" — never a reason to call the marker
  // unreadable and start a fresh one over the failures and the budget.
  const watching = watchedEntries(marker.watching);
  if (watching.length > 0) {
    marker.watching = watching;
  } else {
    delete marker.watching;
  }
  // The same for `lossStreak`: absent, or not a count, is `0`.
  const streak: unknown = marker.lossStreak;
  if (
    typeof streak !== "number" ||
    !Number.isSafeInteger(streak) ||
    streak <= 0
  ) {
    delete marker.lossStreak;
  }
  return { marker, version: entry.version, unreadable: false };
}

/** The well-formed entries of a marker's `watching`, dropping anything else. */
function watchedEntries(value: unknown): WatchedSummon[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry: unknown): entry is WatchedSummon => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const watched = entry as Record<string, unknown>;
    return (
      typeof watched.id === "string" &&
      isNumber(watched.at) &&
      isNumber(watched.until) &&
      isNumber(watched.count) &&
      typeof watched.kind === "string" &&
      isOptionalNumber(watched.extendedUntil)
    );
  });
}

/** Moves the budget's windows on to the ones `now` falls in, emptying any that changed. */
export function rollBudget(marker: SummonMarker, now: number): void {
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  if (marker.budget.hourStart !== hourStart) {
    marker.budget.hourStart = hourStart;
    marker.budget.hour = 0;
  }
  if (marker.budget.dayStart !== dayStart) {
    marker.budget.dayStart = dayStart;
    marker.budget.day = 0;
  }
}

/**
 * Gives back the one attempt an attempt claimed at `claimedAt` counted
 * against the budget, when the provider was never called for it. Only in a
 * window that is still the claim's: a window that has rolled on since
 * dropped the count with it. Never below `0`.
 */
export function refundBudget(marker: SummonMarker, claimedAt: number): void {
  const hourStart = Math.floor(claimedAt / HOUR_MS) * HOUR_MS;
  const dayStart = Math.floor(claimedAt / DAY_MS) * DAY_MS;
  if (marker.budget.hourStart === hourStart && marker.budget.hour > 0) {
    marker.budget.hour--;
  }
  if (marker.budget.dayStart === dayStart && marker.budget.day > 0) {
    marker.budget.day--;
  }
}

/**
 * When the marker's budget windows end, epoch ms: the next UTC hour and the
 * next UTC midnight after the windows it holds (rolled to `now` first).
 */
export function budgetResets(marker: SummonMarker): {
  /** The end of the hour window. */
  hourResetsAt: number;
  /** The end of the day window. */
  dayResetsAt: number;
} {
  return {
    hourResetsAt: marker.budget.hourStart + HOUR_MS,
    dayResetsAt: marker.budget.dayStart + DAY_MS,
  };
}

/** Zeroes the budget's counts in the windows `now` falls in. */
export function clearBudget(marker: SummonMarker, now: number): void {
  rollBudget(marker, now);
  marker.budget.hour = 0;
  marker.budget.day = 0;
}

/** The wait after the `failures`th consecutive failure: `initial`, doubling, at most `max`. */
export function backoffFor(
  failures: number,
  backoff: { initial: number; max: number },
): number {
  const exponent = Math.max(0, Math.min(failures - 1, 30));
  return Math.min(backoff.max, backoff.initial * 2 ** exponent);
}
