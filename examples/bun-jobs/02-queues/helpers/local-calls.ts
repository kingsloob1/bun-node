/**
 * Calling a configured provider's summon facet by hand, as
 * `02-queues/local-compute.ts` and `helpers/local-host.ts` do to show what
 * `localCompute` answers without a controller in between. A controller
 * builds both of these itself; nothing here is needed to use the provider.
 */
import type {
  ProviderCallContext,
  SummonRequest,
} from "@kingsleyweb/bun-jobs/provider";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";

/** Each request's id gets the next number, so no two share a dedupe key. */
let seq = 0;

/**
 * A summon request for `count` units, as a controller would make it: the
 * identity in `argv`, a one-minute lifetime, a demand of one waiting job.
 * Each call has an id (and so a dedupe key) of its own.
 */
export function summonRequest(count = 1): SummonRequest {
  const id = `sm-local-${process.pid}-${++seq}`;
  return {
    namespace: "local-by-hand",
    queue: "work",
    id,
    dedupeKey: id,
    count,
    target: count,
    demand: {
      at: Date.now(),
      paused: false,
      waiting: 1,
      dueNow: 0,
      stalled: 0,
      active: 0,
      workers: 0,
      nextDueAt: null,
      demand: 1,
      outstanding: 1,
      capped: false,
      exact: true,
    },
    reason: "manual",
    env: {},
    argv: [`--bun-jobs-summon-id=${id}`],
    maxLifetimeMs: 60_000,
  };
}

/** A call context with nothing to abort it: what a controller passes, less its timeout. */
export function callContext(): ProviderCallContext {
  return {
    signal: new AbortController().signal,
    logger: noopLogger,
    fetch,
    now: Date.now,
  };
}
