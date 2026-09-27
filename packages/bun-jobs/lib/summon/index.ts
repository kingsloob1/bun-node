/**
 * Summoning: starting a worker when a queue has work and none is running.
 *
 * `SummonController` watches a queue and calls a `Summoner` — made with
 * `defineSummoner({ invoke })`, or a bare function — when it needs one. A
 * summoned worker passes `summon: summonedFromArgs()` so its heartbeat record
 * releases the attempt, and runs through `runSummoned(worker)`, which starts
 * it, handles the platform's signals and stops it inside the platform's
 * grace. Everything here is also reachable from the package root.
 */
export { SUMMON_ARGS, type SummonedArgs, summonedFromArgs } from "./args";
export { SummonController } from "./controller";
export { defineSummoner, type DefineSummonerOptions } from "./define";
export type {
  PendingSummon,
  ProviderApiVersions,
  ProviderCallContext,
  ProviderIdentity,
  SummonCapabilities,
  SummonCheckResult,
  SummonControllerEvents,
  SummonControllerOptions,
  SummonDedupe,
  Summoner,
  SummonerFunction,
  SummonEventPayload,
  SummonFacet,
  SummonLastOutcome,
  SummonMarker,
  SummonOutcomeKind,
  SummonPolicy,
  SummonReason,
  SummonReleaseRequest,
  SummonRequest,
  SummonResult,
  SummonSkipReason,
  SummonStatus,
  UnitStatus,
} from "./types";
export {
  runSummoned,
  type RunSummonedOptions,
  type SummonedExit,
} from "./worker";
