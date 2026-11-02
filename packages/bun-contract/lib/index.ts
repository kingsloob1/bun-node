/**
 * `@kingsleyweb/bun-contract`: the transport-agnostic contract core (plan
 * `docs/plans/bun-validate/` §4.1), extracted from bun-common
 * (`docs/plans/typed-client/` §10.1, PR-K) so a browser client can use the
 * server's own guards without bun-common's dependencies. bun-common depends
 * on it and re-exports this entry, unchanged, as
 * `@kingsleyweb/bun-common/contract`.
 *
 * Nothing under `lib/` imports a Bun or Node API or another package: the
 * Standard Schema types are vendored (`standardSchema.ts`) and the logger is
 * a minimal interface (`logger.ts`). `__tests__/browserSafety.test.ts` checks
 * a browser bundle of this entry, and `__tests__/packaging.test.ts` that the
 * package has no dependency.
 *
 * Only the names approved for the entry are exported here: bun-validate's
 * plan §9, the types a transport author needs to name (the user's choice of
 * 2026-10-21), and the logger and Standard Schema types an option or a
 * schema is written in. The remaining helpers stay internal, reachable only
 * by deep import (`@kingsleyweb/bun-contract/lib/<module>`).
 */
export {
  type ContractDescription,
  type ContractEntry,
  describeContract,
  mergeContracts,
} from "./describe";
export {
  ContractError,
  createReceiver,
  createSender,
  type Guard,
} from "./guard";
export { validateStandard } from "./issues";
export {
  type AnyContract,
  type Carries,
  CONTRACT,
  type Contract,
  type ContractDef,
  type ContractEncoding,
  type ContractKind,
  type ContractMeta,
  type ContractWire,
  type GuardOptions,
  type IssueContext,
  type MediaMap,
  type Policy,
  type Received,
  type Sent,
  type Side,
  type SideSpec,
  type StandardOutcome,
  type Transport,
  type TransportSpec,
  type ValidationIssue,
  type WireInput,
} from "./model";
export { documented, recordOf } from "./schemas";
export {
  channelContract,
  channelErrorFrame,
  type ChannelContract,
  type ChannelErrorCode,
  type ChannelErrorFrame,
  type ChannelMessage,
  type ChannelMessages,
  type ChannelMeta,
  type ChannelRequestSchemas,
  type ChannelSpec,
  wsTransport,
} from "./channel";
export {
  attachContract,
  defineTransport,
  forwardContract,
  getContract,
} from "./transport";
export type {
  ContractLogEvent,
  ContractLogger,
  ContractLoggerLike,
  ContractLogSink,
} from "./logger";
export type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
  StandardTypedV1,
} from "./standardSchema";
