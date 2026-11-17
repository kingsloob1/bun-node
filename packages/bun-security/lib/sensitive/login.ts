/**
 * The login profile's account defences (layers.md L11.2 to L11.4, L11.8),
 * on routes marked `login`:
 *
 * - **Failures per attempted username**, kept per username and device for a
 *   request carrying a valid device cookie for that username, and per
 *   username otherwise, in a window from the first failure. Before the app
 *   checks the password, the engine reads the count: past `delayAfter`
 *   the answer waits (1 s, 2 s, 4 s… up to `maxDelay`, for a success as for
 *   a failure, so timing tells nothing), past `challengeAfter` a challenge
 *   (the engine's challenge flow; a `429` without one), and at `lockAfter` a soft
 *   lock for `lockFor` that refuses the username from every device without
 *   a valid cookie for it, so the owner's known device keeps working
 *   (`unlock()` lifts it).
 * - **Distinct usernames failing from one address** (credential stuffing:
 *   one source, many accounts): a challenge, then a ban of the address.
 * - **Distinct addresses failing for one username** (a spray at one
 *   account): the username's requests are tagged `step-up`, except those
 *   carrying a valid device cookie for it.
 * - **A success from an address with many failures** is tagged
 *   `risky-success` and warned of.
 *
 * Every counter is in the shared store when the engine has one (its
 * throttle store, and distinct counts through `pfAdd`), so the defences hold
 * across processes; a failing store falls back to this process's.
 */
import type { Logger, ThrottleStore } from "@kingsleyweb/bun-common";
import type { BanWrite } from "../engine/bans";
import type { RuleHit } from "../engine/decision";
import type { DistinctCounts } from "../engine/distinct";
import { all, then } from "../engine/maybe";
import type { MaybePromise } from "../engine/maybe";
import type { CompiledLogin } from "./compile";

/** The keys of one login attempt. */
export interface LoginKeys {
  /** The attempted username's key (its HMAC). */
  readonly username: string;
  /** The valid device cookie's id for that username, if any. */
  readonly device: string | undefined;
  /** The client's address key, if any. */
  readonly ip: string | undefined;
}

/** A hit and how it answers when it refuses. */
export interface LoginHit {
  /** The hit. */
  readonly hit: RuleHit;
  /** Its answer: status, code, `Retry-After` seconds. */
  readonly answer?: {
    readonly status: number;
    readonly code: string;
    readonly retryAfter?: number;
  };
}

/** What the defences say of an attempt before the password is checked. */
export interface LoginVerdict {
  /** The hits. */
  readonly hits: readonly LoginHit[];
  /** How long to hold the answer, ms; 0 for none. */
  readonly delayMs: number;
  /** Tags for the app (`step-up`). */
  readonly tags: readonly string[];
}

/** What the defences need from the engine. */
export interface LoginDeps {
  /** This process's counters. */
  readonly local: ThrottleStore;
  /** The shared store's counters, if any. */
  readonly shared: ThrottleStore | undefined;
  /** Distinct counts. */
  readonly distinct: DistinctCounts;
  /** Writes a ban (and logs it to the shared store). */
  readonly ban: (write: BanWrite, now: number) => void;
  /** Raises the `login.risky-success` warning. */
  readonly risky: (now: number) => void;
  /** Where failures are logged. */
  readonly logger: Logger;
}

/** Seconds, rounded up, at least 1. */
function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** The login defences of one engine. */
export class LoginDefences {
  /** When a store failure was last logged. */
  #lastWarn = Number.NEGATIVE_INFINITY;

  constructor(
    /** What they need from the engine. */
    private readonly deps: LoginDeps,
  ) {}

  /** Runs `op` on the shared store, or this process's when there is none or it fails. */
  #store<T>(
    op: (store: ThrottleStore) => MaybePromise<T>,
    now: number,
  ): MaybePromise<T> {
    const shared = this.deps.shared;
    if (shared === undefined) return op(this.deps.local);
    const fallback = (error: unknown): MaybePromise<T> => {
      if (now - this.#lastWarn >= 10_000) {
        this.#lastWarn = now;
        this.deps.logger.warn(
          "bun-security: the shared store failed for the login defences; counting in this process",
          { error },
        );
      }
      return op(this.deps.local);
    };
    let result: MaybePromise<T>;
    try {
      result = op(shared);
    } catch (error) {
      return fallback(error);
    }
    return result instanceof Promise ? result.catch(fallback) : result;
  }

  /** The failures counter of an attempt: per username and device, or per username. */
  #failures(prefix: string, keys: LoginKeys): string {
    return keys.device === undefined
      ? `${prefix}:login:failures:${keys.username}`
      : `${prefix}:login:failures:${keys.username}|${keys.device}`;
  }

  /**
   * What an attempt meets before its password is checked (read only):
   * the lock, the challenge, the delay, and the `step-up` tag. With `dry`,
   * each refusal is a `log` with what it would have been.
   */
  check(
    login: CompiledLogin,
    keys: LoginKeys,
    prefix: string,
    dry: boolean,
    now: number,
  ): MaybePromise<LoginVerdict> {
    const reads: MaybePromise<number>[] = [
      this.#store(
        (store) => then(store.get(this.#failures(prefix, keys)), Number),
        now,
      ),
      keys.device === undefined
        ? this.#store(
            (store) =>
              then(store.get(`${prefix}:login:lock:${keys.username}`), Number),
            now,
          )
        : 0,
      // A valid device cookie for the username skips the tag: the owner on
      // a known device is not asked for a second factor while the account
      // is attacked from many addresses (plan §17.19).
      login.distinctAddresses === undefined || keys.device !== undefined
        ? 0
        : this.#store(
            (store) =>
              then(
                store.get(`${prefix}:login:step-up:${keys.username}`),
                Number,
              ),
            now,
          ),
    ];
    return then(all(reads), ([failures = 0, locked = 0, stepUp = 0]) => {
      const hits: LoginHit[] = [];
      const tags = (stepUp || 0) > 0 ? ["step-up"] : [];
      // A `challenge` goes through the engine's challenge flow (S9's
      // `Run.add`): a challenge with a flow, a pass with a clearance, and
      // this hit's own `429` without a flow. The soft lock always refuses.
      const refuse = (
        rule: string,
        reason: string,
        retryAfter: number,
        action: "block" | "challenge",
      ) => {
        hits.push(
          dry
            ? {
                hit: {
                  layer: "L11",
                  rule,
                  action: "log",
                  wouldHaveBeen: action,
                  reason: `dry run: ${reason}`,
                },
              }
            : {
                hit: { layer: "L11", rule, action, reason },
                answer: {
                  status: 429,
                  code: "rate_limited",
                  retryAfter: seconds(retryAfter),
                },
              },
        );
      };
      const count = failures || 0;
      if ((locked || 0) > 0) {
        refuse(
          "login:lock",
          "soft lock: too many failures for this username from devices it has not signed in on (a device cookie for it passes)",
          login.lockFor,
          "block",
        );
        return { hits, delayMs: 0, tags };
      }
      if (count >= login.challengeAfter) {
        refuse(
          "login:challenge",
          `${count} failures for this username`,
          login.window,
          "challenge",
        );
        return { hits, delayMs: 0, tags };
      }
      if (count >= login.delayAfter) {
        const delayMs = Math.min(
          login.maxDelay,
          1000 * 2 ** (count - login.delayAfter),
        );
        const reason = `${count} failures for this username: answer delayed ${delayMs} ms`;
        hits.push({
          hit: dry
            ? {
                layer: "L11",
                rule: "login:delay",
                action: "log",
                wouldHaveBeen: "delay",
                reason: `dry run: ${reason}`,
              }
            : { layer: "L11", rule: "login:delay", action: "delay", reason },
        });
        return { hits, delayMs: dry ? 0 : delayMs, tags };
      }
      return { hits, delayMs: 0, tags };
    });
  }

  /**
   * A failure: counted per username (and device), per address; the soft
   * lock set at `lockAfter`; the distinct counts added, banning or tagging
   * past theirs. Answers the hits.
   */
  failure(
    login: CompiledLogin,
    keys: LoginKeys,
    prefix: string,
    dry: boolean,
    now: number,
  ): MaybePromise<readonly RuleHit[]> {
    const hits: RuleHit[] = [];
    const steps: MaybePromise<void>[] = [];
    steps.push(
      then(
        this.#store(
          (store) =>
            store.increment(this.#failures(prefix, keys), 1, login.window),
          now,
        ),
        (count) => {
          if (keys.device !== undefined || Number(count) < login.lockAfter)
            return undefined;
          const reason = `${Number(count)} failures for this username: soft lock for ${seconds(login.lockFor)} s`;
          if (dry) {
            hits.push({
              layer: "L11",
              rule: "login:lock",
              action: "log",
              wouldHaveBeen: "block",
              reason: `dry run: ${reason}`,
            });
            return undefined;
          }
          hits.push({
            layer: "L11",
            rule: "login:lock",
            action: "block",
            reason,
          });
          return then(
            this.#store(
              (store) =>
                store.increment(
                  `${prefix}:login:lock:${keys.username}`,
                  1,
                  login.lockFor,
                ),
              now,
            ),
            () => undefined,
          );
        },
      ),
    );
    const ip = keys.ip;
    if (ip !== undefined && login.riskySuccessAfter !== undefined) {
      steps.push(
        then(
          this.#store(
            (store) =>
              store.increment(
                `${prefix}:login:ip-failures:${ip}`,
                1,
                login.window,
              ),
            now,
          ),
          () => undefined,
        ),
      );
    }
    const users = login.distinctUsernames;
    if (ip !== undefined && users !== undefined) {
      steps.push(
        then(
          this.deps.distinct.add(
            {
              key: `login-usernames:${prefix}:${ip}`,
              element: keys.username,
              window: users.window,
              state: "shared",
              onStoreError: "local",
            },
            now,
          ),
          (count) => {
            if (count === undefined || count < users.challengeAt) return;
            const ban = count >= users.banAt;
            const reason = `${count} distinct usernames failed from this address in ${seconds(users.window)} s`;
            const rule = "login:distinct-usernames";
            if (dry) {
              hits.push({
                layer: "L11",
                rule,
                action: "log",
                wouldHaveBeen: ban ? "ban" : "challenge",
                reason: `dry run: ${reason}`,
              });
              return;
            }
            hits.push({
              layer: "L11",
              rule,
              action: ban ? "ban" : "challenge",
              reason,
            });
            this.deps.ban(
              {
                subject: { type: "ip", value: ip },
                action: ban ? "ban" : "challenge",
                reason,
                rule,
                source: "auto",
                expiresAt: now + (ban ? users.banFor : login.window),
              },
              now,
            );
          },
        ),
      );
    }
    const addresses = login.distinctAddresses;
    if (ip !== undefined && addresses !== undefined) {
      steps.push(
        then(
          this.deps.distinct.add(
            {
              key: `login-addresses:${prefix}:${keys.username}`,
              element: ip,
              window: addresses.window,
              state: "shared",
              onStoreError: "local",
            },
            now,
          ),
          (count) => {
            if (count === undefined || count < addresses.stepUpAt)
              return undefined;
            hits.push({
              layer: "L11",
              rule: "login:distinct-addresses",
              action: "tag",
              reason: `${count} distinct addresses failed for this username: step-up`,
            });
            return then(
              this.#store(
                (store) =>
                  store.increment(
                    `${prefix}:login:step-up:${keys.username}`,
                    1,
                    addresses.window,
                  ),
                now,
              ),
              () => undefined,
            );
          },
        ),
      );
    }
    return then(all(steps), () => hits);
  }

  /**
   * A success: the attempt's failures counter cleared; a success from an
   * address with many failures tagged `risky-success` and warned of.
   */
  success(
    login: CompiledLogin,
    keys: LoginKeys,
    prefix: string,
    now: number,
  ): MaybePromise<readonly RuleHit[]> {
    const key = this.#failures(prefix, keys);
    const cleared = this.#store(
      (store) =>
        store.delete === undefined
          ? store.increment(key, 0, 1)
          : store.delete(key),
      now,
    );
    const ip = keys.ip;
    const after = login.riskySuccessAfter;
    if (ip === undefined || after === undefined) {
      return then(cleared, () => []);
    }
    return then(cleared, () =>
      then(
        this.#store(
          (store) =>
            then(store.get(`${prefix}:login:ip-failures:${ip}`), Number),
          now,
        ),
        (failures): readonly RuleHit[] => {
          if ((failures || 0) < after) return [];
          this.deps.risky(now);
          return [
            {
              layer: "L11",
              rule: "login:risky-success",
              action: "tag",
              reason: `a success from an address with ${failures} failures: risky-success`,
            },
          ];
        },
      ),
    );
  }

  /** Lifts a username's soft lock and clears its failures without a device. */
  unlock(prefix: string, username: string, now: number): MaybePromise<void> {
    return this.#store((store) => {
      const keys = [
        `${prefix}:login:lock:${username}`,
        `${prefix}:login:failures:${username}`,
      ];
      return then(
        all(
          keys.map((key) =>
            store.delete === undefined
              ? store.increment(key, 0, 1)
              : store.delete(key),
          ),
        ),
        () => undefined,
      );
    }, now);
  }
}
