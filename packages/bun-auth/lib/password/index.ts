/**
 * `@kingsleyweb/bun-auth/password`: better-auth's password hashing on
 * `Bun.password`, opt-in, with a fallback that still verifies better-auth's
 * own scrypt hashes and an `onLegacyHash` callback to move users over
 * (`docs/plans/bun-auth/README.md` §2.6).
 *
 * ```ts
 * import { bunPassword } from "@kingsleyweb/bun-auth/password";
 *
 * betterAuth({ emailAndPassword: { enabled: true, password: bunPassword() } });
 * ```
 *
 * Bun only. Needs `better-auth` (`better-auth/crypto`) and `@better-auth/core`
 * (its endpoint context, `@better-auth/core/context`).
 */
export { bunPassword, isBunPasswordHash } from "./password";
export type {
  BunPasswordAlgorithm,
  BunPasswordHooks,
  BunPasswordOptions,
  LegacyHashEvent,
} from "./password";
