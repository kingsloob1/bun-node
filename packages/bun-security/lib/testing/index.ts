/**
 * Testing with bun-security (`@kingsleyweb/bun-security/testing`):
 *
 * - the security store kit (storage.md §9): the conformance suite every
 *   driver passes, and a store that fails on demand for the engine's
 *   degraded-mode tests. It imports `bun:test`, so this entry is for test
 *   files;
 * - attack simulators (plan §11.2): request lists for an app to run against
 *   its own policy, the runner that reports their outcomes, and the fakes
 *   they need (no DNS, no network). Their module imports no test runner.
 */ export { runSecurityStoreConformance } from "./conformance";
export type {
  StoreConformanceCrossProcess,
  StoreConformanceFactory,
  StoreConformanceInstance,
  StoreConformanceOptions,
} from "./conformance";
export { faultyStore } from "./faulty";
export type { FaultyStoreOptions, StoreOperation } from "./faulty";
export {
  CRAWLER_USER_AGENTS,
  PROBE_PATHS,
  accountEnumeration,
  addressRotation,
  apiKeyAbuse,
  burst,
  crawl,
  credentialStuffing,
  crossSitePosts,
  disposableSignups,
  distributedGuessing,
  enumerationLeaks,
  fetchTarget,
  forwardedForSpoof,
  handlerTarget,
  ipv6InPrefix,
  ipv6Rotation,
  keyCardinalityFlood,
  lowAndSlow,
  nthAddress,
  paced,
  passwordSpraying,
  pathScan,
  probeAnswers,
  runAttack,
  sequence,
  spoofedCrawler,
  staticCrawlerResolver,
} from "./simulators";
export type {
  Attack,
  AttackRequest,
  AttackResult,
  AttackTarget,
  FetchableApp,
  ProbeAnswer,
  RunAttackOptions,
  ServeHandler,
  SignInAttackOptions,
} from "./simulators";
