import type { JobsDriver, QueueRef } from "../drivers/index";
import type { SummonedExit } from "./worker";
import { listWorkerRecords } from "../drivers/index";
import { RESERVED_STATE_PREFIX, setReservedState } from "../queue/windows";
import { base32 } from "./marker";

/**
 * Claim-once: the first process to claim a summon attempt's id wins it.
 *
 * Arguments are the only channel a summon's identity travels on, and no
 * descendant inherits them — but a platform can still start two processes
 * with the same command line (a double start, a retried launch), and each
 * would otherwise write a heartbeat record carrying the same attempt id. So a
 * summoned worker claims its id before its first record says it was
 * summoned, in a reserved queue-state entry written only by compare-and-set,
 * which every driver makes atomic. A claimant that finds the entry full runs
 * as an ordinary worker, with no `summon` on its record.
 *
 * **An attempt for several workers** (`count > 1`) starts them all with the
 * same id, so "once" means "at most `count` times": the controller creates
 * the entry with that capacity before it calls the summoner. With no entry
 * there — every one-worker attempt, and any summon the controller did not
 * start — the first claimant creates it with a capacity of one.
 *
 * **A restart is not a double start.** A platform that restarts a unit (a
 * scale-style service, a container restart policy) runs the same command
 * line again, and the new process has a new worker id. Claim-once exists to
 * stop two *live* processes sharing an id, so a claimant may take a holder's
 * place once that holder is gone: its heartbeat record is not among the live
 * ones **and** its `until` has passed (so a holder that claimed a moment ago
 * and has not written its first record yet is never mistaken for a dead
 * one). The takeover is a compare-and-set on the entry, like every other
 * write to it. A displaced holder that turns out to be alive after all finds
 * out on its next report ({@link holdsSummonClaim}) and runs unsummoned.
 *
 * Internal: nothing here is exported from the package.
 */

/** The prefix of every claim entry's name. Reserved: a caller's `setQueueState` cannot write it. */
export const SUMMON_CLAIM_PREFIX = `${RESERVED_STATE_PREFIX}summon-claim:`;

/**
 * How long a claim entry is kept, in ms. Ids never repeat (the marker's epoch
 * sees to that), so this only bounds what a late duplicate could still meet:
 * a day, which is how long ECS remembers a token.
 */
export const SUMMON_CLAIM_RETENTION_MS = 86_400_000;

/** How many compare-and-set rounds a claim tries before giving up (and running unsummoned). */
const CLAIM_ATTEMPTS = 8;

/** One process holding a claim. */
export interface SummonClaimant {
  /** The claiming worker's id. */
  worker: string;
  /** Its host. */
  host: string;
  /** Its pid. */
  pid: number;
  /** When it claimed, epoch ms. */
  at: number;
  /**
   * Until when its first heartbeat record may still be on its way, epoch ms:
   * the claim time plus one record lifetime. Before it, a missing record
   * proves nothing; after it, a missing record means the holder is gone.
   */
  until: number;
  /**
   * How the holder left, once it has: written by the holder itself as it
   * closes, before its heartbeat record goes (see {@link markSummonClaimExit}).
   * Absent while it runs — and for good on a holder that died without
   * closing, which is how the controller tells a clean exit from a crash.
   */
  exit?: SummonClaimExit;
}

/**
 * A holder's exit mark: how a summoned worker that held a claim left.
 *
 * `runSummoned` writes the real reason and code before it closes the worker;
 * the worker's own `close()` then fills in `"closed"` (code `0`) only where no
 * mark is there yet, so a worker closed some other way still says it closed.
 */
export interface SummonClaimExit {
  /** When it left, epoch ms, by the holder's clock. */
  exitedAt: number;
  /**
   * Why: `runSummoned`'s {@link SummonedExit} reason, or `"closed"` from a
   * worker's own `close()`.
   */
  reason: SummonedExit["reason"];
  /** The exit code: `1` only for `"error"` (its `run()` failed), else `0`. */
  code: 0 | 1;
  /** `true` when the close was forced (a signal, a deadline, an escalation). Absent otherwise. */
  forced?: boolean;
}

/** What a claim entry holds. */
export interface SummonClaim {
  /** How many workers may hold this id: the attempt's `count`, or `1`. */
  capacity: number;
  /** Who holds it, first come first served. */
  holders: SummonClaimant[];
  /** When the entry was created, epoch ms: what the sweep ages it by. */
  at: number;
}

/**
 * The claim entry's name for an attempt id: hashed, so an id of any length or
 * alphabet makes a short name every backend stores.
 */
export function summonClaimName(id: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(id);
  return `${SUMMON_CLAIM_PREFIX}${base32(new Uint8Array(hasher.digest().buffer)).slice(0, 32)}`;
}

/** Whether a stored value is a claim entry. */
function isClaim(value: unknown): value is SummonClaim {
  const claim = value as Partial<SummonClaim> | null;
  return (
    typeof claim === "object" &&
    claim !== null &&
    typeof claim.capacity === "number" &&
    Array.isArray(claim.holders) &&
    typeof claim.at === "number"
  );
}

/**
 * Opens an attempt's claim for `capacity` workers, before they are started.
 * Called by the controller for an attempt of more than one worker; answers
 * whether it created the entry. Never raises the capacity of an entry that
 * exists.
 */
export async function openSummonClaim(
  driver: JobsDriver,
  q: QueueRef,
  /** The attempt id. */
  id: string,
  /** How many workers may claim it. */
  capacity: number,
  /** Now, epoch ms. */
  now: number,
): Promise<boolean> {
  const entry: SummonClaim = { capacity, holders: [], at: now };
  return (
    (await setReservedState(driver, q, summonClaimName(id), entry, null)) !==
    null
  );
}

/**
 * Claims an attempt id for one worker: `true` when this worker holds it (it
 * took a place, or already had one), `false` when the places were taken
 * first — or when the entry kept changing under it, since running unsummoned
 * is the safe way to fail.
 *
 * Checking for its own place before taking one is what makes a retry safe: a
 * worker whose write landed but whose answer was lost finds itself there.
 */
export async function claimSummonAttempt(
  driver: JobsDriver,
  q: QueueRef,
  /** The attempt id, `summon.id`. */
  id: string,
  /** Who is claiming. */
  claimant: SummonClaimant,
): Promise<boolean> {
  const name = summonClaimName(id);
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const current = await driver.getQueueState!(q, name);
    if (current === null) {
      const created: SummonClaim = {
        capacity: 1,
        holders: [claimant],
        at: claimant.at,
      };
      if ((await setReservedState(driver, q, name, created, null)) !== null) {
        return true;
      }
      continue;
    }
    if (!isClaim(current.value)) {
      return false;
    }
    const claim = current.value;
    if (claim.holders.some((holder) => holder.worker === claimant.worker)) {
      return true;
    }
    let holders: SummonClaimant[];
    if (claim.holders.length < claim.capacity) {
      holders = [...claim.holders, claimant];
    } else {
      // Full: take the place of a holder that is gone, if one is.
      const live = new Set(
        (await listWorkerRecords(driver, q, claimant.at)).map(
          (worker) => worker.id,
        ),
      );
      const gone = claim.holders.findIndex(
        (holder) =>
          !live.has(holder.worker) &&
          (typeof holder.until === "number" ? holder.until : holder.at) <=
            claimant.at,
      );
      if (gone === -1) {
        return false;
      }
      holders = claim.holders.map((holder, index) =>
        index === gone ? claimant : holder,
      );
    }
    const next: SummonClaim = { ...claim, holders };
    if (
      (await setReservedState(driver, q, name, next, current.version)) !== null
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `worker` still holds a place in an attempt's claim: `false` once
 * another process took the place over (see the restart rule above) or the
 * entry is gone. A worker that won its claim asks this on every later
 * report, and runs unsummoned from the first `false`.
 */
export async function holdsSummonClaim(
  driver: JobsDriver,
  q: QueueRef,
  /** The attempt id, `summon.id`. */
  id: string,
  /** The worker's id. */
  worker: string,
): Promise<boolean> {
  const current = await driver.getQueueState!(q, summonClaimName(id));
  return (
    current !== null &&
    isClaim(current.value) &&
    current.value.holders.some((holder) => holder.worker === worker)
  );
}

/**
 * Reads the claim entries of several attempts: the controller's registration
 * evidence that outlives a worker's record. A summoned worker claims its id
 * in its first report and removes its record when it closes, so one that
 * starts, drains the backlog and exits between two checks leaves no record
 * to be seen — but its place in the claim stays, for
 * {@link SUMMON_CLAIM_RETENTION_MS}, and the sweep never removes a younger
 * entry.
 *
 * One read per id, in parallel. An id with no entry (nothing has claimed it
 * yet, or a platform that passes no identity) or with a value that is not a
 * claim maps to `undefined`. A failed read rejects: the check then fails and
 * runs again, rather than counting a worker that did start as missing.
 */
export async function readSummonClaims(
  driver: JobsDriver,
  q: QueueRef,
  /** The attempt ids to look up. */
  ids: readonly string[],
): Promise<Map<string, SummonClaim | undefined>> {
  const claims = await Promise.all(
    ids.map(async (id) => {
      const current = await driver.getQueueState!(q, summonClaimName(id));
      return current !== null && isClaim(current.value)
        ? current.value
        : undefined;
    }),
  );
  return new Map(ids.map((id, index) => [id, claims[index]]));
}

/** What an attempt's claim says about the workers it started. */
export interface SummonClaimTally {
  /**
   * Holders that ran: live (their record is listed) with no failing mark, or
   * gone with a clean exit mark (code `0`).
   */
  succeeded: number;
  /** Holders that left with a failing exit mark (code `1`). */
  exitedWithError: number;
  /**
   * Holders that are gone with no exit mark, past their grace: started, then
   * died without closing (a crash, an OOM kill, a SIGKILL).
   */
  died: number;
  /** Holders gone with no mark but still inside their grace: undecided yet. */
  starting: number;
}

/**
 * Sorts an attempt's claim holders into how each one fared, as of `now`.
 *
 * A holder's mark decides first — code `0` succeeded, code `1` failed, even
 * while its record is still listed (it is on its way out). With no mark, a
 * listed record means it is running; no record means it is gone **once its
 * grace has passed**: its `until` (the claim time plus one record lifetime,
 * the very test claim-once uses to let a restart take a gone holder's place)
 * plus `slack` for the two processes' clocks, since `until` is the holder's
 * and `now` the caller's. Before that its first record may simply not have
 * been written yet.
 */
export function tallySummonClaim(
  /** The claim, or `undefined` when there is none. */
  claim: SummonClaim | undefined,
  /** The ids of the workers whose records are live. */
  live: ReadonlySet<string>,
  /** Now, epoch ms, by the caller's clock. */
  now: number,
  /** The clock-skew allowance added to each holder's grace, in ms. */
  slack: number,
): SummonClaimTally {
  const tally: SummonClaimTally = {
    succeeded: 0,
    exitedWithError: 0,
    died: 0,
    starting: 0,
  };
  for (const holder of claim?.holders ?? []) {
    if (holder.exit !== undefined) {
      if (holder.exit.code === 0) {
        tally.succeeded++;
      } else {
        tally.exitedWithError++;
      }
    } else if (live.has(holder.worker)) {
      tally.succeeded++;
    } else if (
      (typeof holder.until === "number" ? holder.until : holder.at) + slack <=
      now
    ) {
      tally.died++;
    } else {
      tally.starting++;
    }
  }
  return tally;
}

/**
 * Writes `worker`'s exit mark onto an attempt's claim, by compare-and-set,
 * in the rounds a claim gets ({@link claimSummonAttempt}). Answers
 * `"written"`, `"kept"` (a mark was there and stays), `"not-held"` (no entry,
 * or `worker` holds no place in it) or `"contended"` (the entry kept changing
 * under it).
 *
 * With `replace: false` — a worker's own `close()` — it only fills an empty
 * mark, so the reason `runSummoned` wrote first survives. With
 * `replace: true` — `runSummoned` — it writes over a mark already there,
 * **except** that a failing mark (code `1`) is never replaced by a clean one:
 * a failure, once said, stays said.
 */
export async function markSummonClaimExit(
  driver: JobsDriver,
  q: QueueRef,
  /** The attempt id, `summon.id`. */
  id: string,
  /** The holder's worker id. */
  worker: string,
  /** The mark. */
  exit: SummonClaimExit,
  /** Whether to write over a mark already there (never code `1` with code `0`). */
  replace: boolean,
): Promise<"written" | "kept" | "not-held" | "contended"> {
  const name = summonClaimName(id);
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const current = await driver.getQueueState!(q, name);
    if (current === null || !isClaim(current.value)) {
      return "not-held";
    }
    const claim = current.value;
    const index = claim.holders.findIndex((holder) => holder.worker === worker);
    if (index === -1) {
      return "not-held";
    }
    const existing = claim.holders[index]!.exit;
    if (
      existing !== undefined &&
      (!replace || (existing.code === 1 && exit.code === 0))
    ) {
      return "kept";
    }
    const next: SummonClaim = {
      ...claim,
      holders: claim.holders.map((holder, at) =>
        at === index ? { ...holder, exit } : holder,
      ),
    };
    if (
      (await setReservedState(driver, q, name, next, current.version)) !== null
    ) {
      return "written";
    }
  }
  return "contended";
}

/**
 * Removes claim entries older than `olderThan` (epoch ms), each by
 * compare-and-set on the version read, looking at no more than `maxScan`
 * entries — **except one any of whose holders is still live** (its worker
 * record is listed at `now`): deleting that would make the holder's next
 * report find its place gone and demote a working summoned worker. Names are
 * hashes, so age says nothing about order: the listing is paged through
 * rather than cut at its first page. Best effort: a driver without
 * `listQueueState` keeps them. Answers how many went.
 */
export async function sweepSummonClaims(
  driver: JobsDriver,
  q: QueueRef,
  /** Remove entries created before this, epoch ms. */
  olderThan: number,
  /** Now, epoch ms: which worker records count as live. */
  now: number,
  /** The most entries to look at in one sweep. */
  maxScan = 2_000,
): Promise<number> {
  if (typeof driver.listQueueState !== "function") {
    return 0;
  }
  let live: Set<string> | undefined;
  const page = 200;
  let removed = 0;
  let scanned = 0;
  let after: string | undefined;
  while (scanned < maxScan) {
    const names = await driver.listQueueState(q, {
      prefix: SUMMON_CLAIM_PREFIX,
      limit: page,
      ...(after === undefined ? {} : { after }),
    });
    for (const name of names) {
      const entry = await driver.getQueueState!(q, name);
      if (entry === null) {
        continue;
      }
      const claim = isClaim(entry.value) ? entry.value : undefined;
      if (claim !== undefined && claim.at >= olderThan) {
        continue;
      }
      if (claim !== undefined && claim.holders.length > 0) {
        // Listed once per sweep, and only when an old entry has holders.
        live ??= new Set(
          (await listWorkerRecords(driver, q, now)).map((worker) => worker.id),
        );
        if (claim.holders.some((holder) => live!.has(holder.worker))) {
          continue;
        }
      }
      if (
        (await setReservedState(driver, q, name, null, entry.version)) !== null
      ) {
        removed++;
      }
    }
    scanned += names.length;
    if (names.length < page) {
      break;
    }
    after = names.at(-1);
  }
  return removed;
}
