/**
 * `bunPassword`: better-auth's password hashing on `Bun.password`
 * (`docs/plans/bun-auth/README.md` §2.6, Q6: opt-in, never the default).
 *
 * ```ts
 * betterAuth({
 *   emailAndPassword: {
 *     enabled: true,
 *     password: bunPassword({ onLegacyHash: async ({ rehash }) => void (await rehash()) }),
 *   },
 * });
 * ```
 *
 * - **New hashes** are `Bun.password`'s: argon2id by default, or the
 *   `algorithm` given (an argon2 variant or bcrypt, with their costs).
 * - **Verifying** reads the hash's own format: a `$argon2…$` or `$2a$`/`$2b$`/
 *   `$2y$` hash goes to `Bun.password.verify`; anything else, which for an
 *   existing better-auth user base is its default `salt:hash` scrypt form, goes
 *   to better-auth's own `verifyPassword` (`better-auth/crypto`).
 *   `Bun.password.verify` throws on the scrypt form (measured, evidence E8),
 *   so without the fallback every existing user would be locked out.
 * - **`onLegacyHash`** is called after a password checks out against a
 *   legacy (non-`Bun.password`) hash: once per successful check, never for a
 *   wrong password. It names the account and offers `rehash()`, which stores
 *   the password again as a `Bun.password` hash, so a user base moves over one
 *   sign-in at a time.
 *
 * better-auth hands the `verify` hook only `{ hash, password }`. The account is
 * found through better-auth's endpoint context (`@better-auth/core/context`,
 * an `AsyncLocalStorage` better-auth keeps on `globalThis`), by the credential
 * account whose stored hash this is. Called outside an endpoint, the event
 * has no account and `rehash()` does nothing.
 */
import type { AuthEndpointContext } from "@better-auth/core/context";
import type { Password } from "bun";
import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import { password as bunPasswords } from "bun";
import { verifyPassword } from "better-auth/crypto";

/** The algorithm and costs `Bun.password.hash` takes: a name, or argon2 or bcrypt with their costs. */
export type BunPasswordAlgorithm =
  Password.AlgorithmLabel | Password.Argon2Algorithm | Password.BCryptAlgorithm;

/** What {@link BunPasswordOptions.onLegacyHash} is told. */
export interface LegacyHashEvent {
  /** The user whose password checked out against a legacy hash, or `null` outside a better-auth endpoint. */
  readonly userId: string | null;
  /** Their credential account's id, or `null` where the user is. */
  readonly accountId: string | null;
  /** The legacy hash that matched, as stored. */
  readonly hash: string;
  /**
   * Stores the password again as a `Bun.password` hash (better-auth's
   * `internalAdapter.updatePassword`). Resolves `true` once stored, `false`
   * when there is no account to store it on.
   */
  readonly rehash: () => Promise<boolean>;
}

/** Options for {@link bunPassword}. */
export interface BunPasswordOptions {
  /** The algorithm new hashes use, with its costs. Default `Bun.password`'s: argon2id. */
  algorithm?: BunPasswordAlgorithm;
  /**
   * Called when a password checks out against a legacy hash, before the
   * request goes on. An error it throws is logged through better-auth's
   * logger and does not fail the request. Default: none.
   */
  onLegacyHash?: (event: LegacyHashEvent) => void | Promise<void>;
}

/** better-auth's `emailAndPassword.password`: how passwords are hashed and checked. */
export interface BunPasswordHooks {
  /** Hashes a password with `Bun.password`. */
  hash: (password: string) => Promise<string>;
  /** Checks a password against a hash of either kind. */
  verify: (data: { hash: string; password: string }) => Promise<boolean>;
}

/** Whether a hash is one `Bun.password.verify` reads: argon2 (any variant) or bcrypt. */
export function isBunPasswordHash(hash: string): boolean {
  return /^\$argon2(?:id|i|d)\$/.test(hash) || /^\$2[aby]\$/.test(hash);
}

/** The credential account whose stored hash is `hash`, through better-auth's adapter. */
async function accountFor(
  context: AuthEndpointContext,
  hash: string,
): Promise<{ id: string; userId: string } | null> {
  return context.context.adapter.findOne<{ id: string; userId: string }>({
    model: "account",
    where: [
      { field: "password", value: hash },
      { field: "providerId", value: "credential" },
    ],
  });
}

/**
 * better-auth's password hooks on `Bun.password`, for
 * `emailAndPassword.password`. See the module comment.
 */
export function bunPassword(
  options: BunPasswordOptions = {},
): BunPasswordHooks {
  const hash = async (password: string): Promise<string> =>
    options.algorithm === undefined
      ? bunPasswords.hash(password)
      : bunPasswords.hash(password, options.algorithm);

  const report = async (legacy: string, password: string): Promise<void> => {
    const onLegacyHash = options.onLegacyHash;
    if (!onLegacyHash) {
      return;
    }
    const context = tryGetCurrentAuthEndpointContext();
    try {
      const account = context ? await accountFor(context, legacy) : null;
      await onLegacyHash({
        userId: account?.userId ?? null,
        accountId: account?.id ?? null,
        hash: legacy,
        rehash: async () => {
          if (!context || !account) {
            return false;
          }
          await context.context.internalAdapter.updatePassword(
            account.userId,
            await hash(password),
          );
          return true;
        },
      });
    } catch (error) {
      if (!context) {
        throw error;
      }
      context.context.logger.error(
        "bunPassword: onLegacyHash failed; the request goes on",
        error,
      );
    }
  };

  return {
    hash,
    verify: async ({ hash: stored, password }) => {
      if (isBunPasswordHash(stored)) {
        return bunPasswords.verify(password, stored);
      }
      const valid = await verifyPassword({ hash: stored, password });
      if (valid) {
        await report(stored, password);
      }
      return valid;
    },
  };
}
