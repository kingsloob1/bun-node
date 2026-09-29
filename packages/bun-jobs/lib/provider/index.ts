/**
 * The compute provider plugin API: how a package teaches bun-jobs to start
 * compute on a platform.
 *
 * `defineComputeProvider(definition)` makes a provider; calling it with a
 * config validates the config and builds its `summon` facet, and the result
 * is what `SummonPolicy.summoner` accepts. `defineSummoner` (from
 * `./summon`) is the same thing without the ceremony, for one-off code.
 *
 * A plugin imports from this entry alone: the summon request and result
 * types, the Standard Schema type and helper, the logger types and the
 * package's errors are re-exported here, so its declarations need nothing
 * else.
 *
 * The API is experimental while its versions are `0.x`
 * ({@link COMPUTE_PROVIDER_API}): any `0.x` minor may change it.
 */
export type { QueueDemand } from "../drivers/index";
export { ConfigError, JobsError } from "../shared/errors";
export type {
  SummonReason,
  SummonReleaseRequest,
  SummonRequest,
  SummonResult,
} from "../summon/types";
export { type ProviderCallContext, type ProviderSetupContext } from "./context";
export {
  COMPUTE_PROVIDER,
  type ComputeProvider,
  type ComputeProviderDefinition,
  CONFIGURED_PROVIDER,
  type ConfiguredProvider,
  defineComputeProvider,
  type ProviderApiVersions,
  type ProviderCheck,
  type ProviderIdentity,
  type SummonCapabilities,
  type SummonDedupe,
  type SummonFacet,
  type UnitStatus,
} from "./define";
export { COMPUTE_PROVIDER_API } from "./version";
export {
  type Logger,
  type LoggerLike,
  type LogLevel,
  type StandardSchemaV1,
  toStandardSchema,
} from "@kingsleyweb/bun-common";
