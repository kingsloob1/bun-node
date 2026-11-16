/**
 * `@kingsleyweb/bun-security/challenge`: challenges (layers.md L10.2).
 *
 * - {@link challenges}: the flow `createSecurity`'s `challenge` option takes
 *   — the challenge page or problem, the answer endpoint, the clearance;
 * - providers: {@link powChallenge} (proof of work, ALTCHA's v1 wire
 *   format, no third party), {@link turnstile} and {@link hcaptcha} (hosted,
 *   verified over `fetch`), or one's own {@link ChallengeProvider};
 * - {@link challengePage}, {@link challengeCsp}: the page under its strict
 *   CSP, for an app that renders its own.
 *
 * Without a flow, every `challenge` action falls back to a `block`.
 */
export {
  type CaptchaOptions,
  hcaptcha,
  turnstile,
  type VerifyFetch,
} from "./captcha";
export {
  clearanceNetwork,
  clearanceRefusal,
  type ClearanceSubject,
  mintClearance,
} from "./clearance";
export {
  type ChallengeAnswer,
  type ChallengeFlow,
  challenges,
  type ChallengesOptions,
  DEFAULT_CHALLENGE_PATH,
  DEFAULT_CLEARANCE_COOKIE,
  DEFAULT_CLEARANCE_HEADER,
} from "./flow";
export { challengeCsp, challengePage, type ChallengePageOptions } from "./page";
export {
  type PowChallengeData,
  type PowChallengeOptions,
  powChallenge,
  solvePowChallenge,
} from "./pow";
export type {
  ChallengeContext,
  ChallengeDescriptor,
  ChallengeProvider,
  ChallengeVerdict,
} from "./types";
