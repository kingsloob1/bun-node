/**
 * The transport-agnostic contract core (plan `docs/plans/bun-validate/` §4.1),
 * also published as the browser-safe subpath `@kingsleyweb/bun-common/contract`.
 *
 * Nothing under `lib/contract/` imports a Bun or Node API; its only imports
 * are the vendored Standard Schema types and bun-common's dependency-free
 * logger (`__tests__/contract/browserSafety.test.ts` checks a browser bundle
 * of this entry).
 *
 * Only the names approved for the package's entries are exported here: plan
 * §9's, and the types a transport author needs to name (the user's choice of
 * 2026-10-21). The remaining helpers stay internal, reachable only by deep
 * import.
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
  attachContract,
  defineTransport,
  forwardContract,
  getContract,
} from "./transport";
