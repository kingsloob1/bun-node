import type { SummonPolicy } from "./types";
import { ConfigError } from "../shared/errors";

/**
 * One summon policy written once for several queues: an entry of the array
 * form of `BunJobsOptions.summon`.
 *
 * ```ts
 * summon: [
 *   { queues: ["emails", "images"], summoner, jobsPerWorker: 10 },
 *   { queues: ["reports"], summoner: other },
 * ]
 * ```
 *
 * **Shorthand, not a shared controller.** A group expands into one ordinary
 * `SummonController` per queue, exactly as if each queue had its own key in
 * the record form: each queue keeps its own marker, `budget`, `maxWorkers`,
 * backoff and circuit. `budget: { perHour: 20 }` on a group of two queues
 * allows 20 attempts an hour *for each*, 40 in all.
 */
export interface SummonGroup extends SummonPolicy {
  /**
   * The queues this policy summons for: at least one, each named once across
   * the whole `summon` option. An empty list, or a queue named twice — in one
   * group, across groups, or in a group and a record — is a `ConfigError`
   * naming it.
   */
  queues: readonly string[];
  /**
   * Per-queue changes to the group's policy, keyed by a queue in `queues`
   * (any other key is a `ConfigError`). **Shallow**: an override's field
   * replaces the group's whole field, so `{ budget: { perHour: 5 } }` drops a
   * `perDay` the group set. Unset by default: every queue gets the policy
   * as written.
   */
  overrides?: Readonly<Record<string, Partial<SummonPolicy>>>;
}

/**
 * Summon policies keyed by queue name, as an entry of the array form. Never
 * has a `queues` key, which is what marks a {@link SummonGroup} — so a typo in
 * a group is reported against the group, not as an unknown queue.
 */
type SummonPolicyRecord = { readonly [queue: string]: SummonPolicy } & {
  /** Reserved: an entry with `queues` is a {@link SummonGroup}. */
  readonly queues?: never;
};

/**
 * Summon policies keyed by queue name: the record form. Never has a
 * `length`, so an array is never read as one — which keeps a typo in the
 * array form reported against the group it is in.
 */
type SummonPolicyMap = { readonly [queue: string]: SummonPolicy } & {
  /** Reserved: an array is the {@link SummonGroup} form. */
  readonly length?: never;
};

/**
 * What `BunJobsOptions.summon` takes: summon policies keyed by queue name, or
 * an array of {@link SummonGroup}s and such records, mixed as needed.
 *
 * ```ts
 * summon: { emails: policy, images: policy }               // record
 * summon: [{ queues: ["emails", "images"], ...policy }]    // the same, grouped
 * summon: [{ queues: ["emails", "images"], ...policy }, { reports: other }]
 * ```
 *
 * Every form expands to one `SummonController` per queue.
 */
export type SummonOption =
  | SummonPolicyMap
  | readonly (SummonGroup | SummonPolicyRecord)[];

/** Whether `value` is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `summon` option expanded to one policy per queue, in the order written.
 * Internal: `BunJobs` builds a controller from each entry.
 *
 * @throws {ConfigError} for an entry that is neither a group nor a record, a
 *   group with no queues (or a `queues` that is not an array of names), an
 *   override for a queue its group does not name, or a queue named twice
 *   anywhere in the option.
 */
export function expandSummonOption(
  /** The option as given; `undefined` expands to nothing. */
  option: SummonOption | undefined,
): Map<string, SummonPolicy> {
  const policies = new Map<string, SummonPolicy>();
  if (option === undefined) {
    return policies;
  }

  /** Adds one queue's policy, refusing a second policy for it. */
  const add = (queue: string, policy: SummonPolicy, where: string): void => {
    if (policies.has(queue)) {
      throw new ConfigError(
        `Queue "${queue}" is named twice in the summon option (again at ${where}): each queue takes one policy`,
        { queue, at: where },
      );
    }
    policies.set(queue, policy);
  };

  /** Adds every queue of a record entry. */
  const addRecord = (record: Record<string, unknown>, where: string): void => {
    for (const [queue, policy] of Object.entries(record)) {
      add(queue, policy as SummonPolicy, `${where}.${queue}`);
    }
  };

  if (!Array.isArray(option)) {
    if (!isRecord(option)) {
      throw new ConfigError(
        "summon must be a record of policies by queue, or an array of groups ({ queues, summoner, … })",
        { summon: typeof option },
      );
    }
    addRecord(option, "summon");
    return policies;
  }

  option.forEach((entry: unknown, index) => {
    const where = `summon[${index}]`;
    if (!isRecord(entry)) {
      throw new ConfigError(
        `${where} must be a group ({ queues, summoner, … }) or a record of policies by queue`,
        { at: where },
      );
    }
    if (!Object.hasOwn(entry, "queues")) {
      addRecord(entry, where);
      return;
    }

    const { queues, overrides, ...policy } = entry as unknown as SummonGroup;
    if (
      !Array.isArray(queues) ||
      queues.some((queue) => typeof queue !== "string")
    ) {
      throw new ConfigError(`${where}.queues must be an array of queue names`, {
        at: where,
      });
    }
    if (queues.length === 0) {
      throw new ConfigError(
        `${where}.queues is empty: a summon group names at least one queue`,
        { at: where },
      );
    }
    if (overrides !== undefined && !isRecord(overrides)) {
      throw new ConfigError(
        `${where}.overrides must be a record of policy changes by queue`,
        { at: where },
      );
    }
    for (const queue of Object.keys(overrides ?? {})) {
      if (!queues.includes(queue)) {
        throw new ConfigError(
          `${where}.overrides names queue "${queue}", which the group's queues do not: an override changes the policy of a queue in its own group`,
          { queue, at: where },
        );
      }
    }
    for (const queue of queues) {
      add(
        queue,
        { ...policy, ...overrides?.[queue] } as SummonPolicy,
        `${where}.queues`,
      );
    }
  });
  return policies;
}
