import type { SummonPolicy } from "./types";
import { ConfigError } from "../shared/errors";
import { assertSegment } from "../shared/keys";

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
 *
 * **The exception is a shared unit**: an entry whose policy says
 * `group: { name, unit: "shared" }` builds **one** controller for all of its
 * `queues`, every unit of which runs a worker for each queue; its
 * `overrides` then take only `jobsPerWorker` and `maxWorkers`.
 *
 * Not to be confused with `SummonGroupOptions`, the policy's `group` field:
 * this type is several queues written as one array entry, while a *summon
 * group* (`group: { name, … }`) is what controllers share — a budget, a
 * circuit, or one unit. The management API's view of a summon group is
 * `SummonGroupStatus` (`SummonGroupStatusDto`).
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
   * (any other key is a `ConfigError`). Unset by default: every queue gets
   * the policy as written. For a shared unit (`group.unit: "shared"`), only
   * `jobsPerWorker` and `maxWorkers` (at most the entry's), as
   * `SummonControllerOptions.overrides` takes them: anything else is the
   * unit's, and a `ConfigError` naming it.
   *
   * **Merged one level deep.** Where both the group and the override hold a
   * plain object — `triggers`, `backoff`, `circuit`, `budget`, `scaleDown`,
   * `env` — the override's fields go over the group's, so
   * `{ budget: { perHour: 5 } }` keeps a `perDay` the group set. Anything
   * else replaces the group's value whole: `summoner`, a function, a number,
   * `false`. So a `budget: false` override turns the budget off, and a
   * `budget` object over a group's `budget: false` turns it on with only the
   * override's values (the controller's defaults for the rest).
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
 * Summon policies keyed by queue name: the record form. An array or a `Map`
 * is never one: their own members are not policies.
 */
interface SummonPolicyMap {
  /** A queue's policy, by the queue's name. */
  readonly [queue: string]: SummonPolicy;
}

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
 * Every form expands to one `SummonController` per queue, except a shared
 * unit (`group: { name, unit: "shared" }`), which is one controller for all
 * of its queues: an array entry's `queues`, or a record's one queue.
 */
export type SummonOption =
  SummonPolicyMap | readonly (SummonGroup | SummonPolicyRecord)[];

/** Whether `value` is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is a plain object: an object literal, or `Object.create(null)`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A group's policy with one queue's override over it, one level deep: a
 * field where both hold a plain object is merged, field by field; any other
 * field of the override replaces the group's. `summoner` always replaces —
 * a `Summoner` may be a plain object, and half of one is not a summoner.
 */
function withOverride(
  /** The group's policy, without `queues` and `overrides`. */
  policy: Readonly<Record<string, unknown>>,
  /** The queue's override, if any. */
  override: Readonly<Record<string, unknown>> | undefined,
): SummonPolicy {
  const merged: Record<string, unknown> = { ...policy };
  for (const [key, value] of Object.entries(override ?? {})) {
    const base = merged[key];
    merged[key] =
      key !== "summoner" && isPlainObject(base) && isPlainObject(value)
        ? { ...base, ...value }
        : value;
  }
  return merged as unknown as SummonPolicy;
}

/** A shared unit's per-queue values: `SummonControllerOptions.overrides`. */
export type SharedUnitOverrides = Readonly<
  Record<string, Readonly<Pick<SummonPolicy, "jobsPerWorker" | "maxWorkers">>>
>;

/**
 * One controller the `summon` option asks for. Internal: `BunJobs` builds
 * one `SummonController` from each.
 */
export interface SummonEntry {
  /**
   * The queues the controller watches, in the order written: one for a
   * per-queue controller; a shared unit's every queue (one or more).
   */
  queues: readonly string[];
  /**
   * Its policy: a per-queue controller's with its override merged in; a
   * shared unit's as the entry wrote it, without `queues` and `overrides`.
   */
  policy: SummonPolicy;
  /** Whether it is a shared unit (`group.unit: "shared"`): one controller for all of `queues`. */
  shared: boolean;
  /** A shared unit's per-queue `jobsPerWorker` and `maxWorkers`, when the entry gave any. */
  overrides?: SharedUnitOverrides;
  /** Where in the option it was written, for an error to name. */
  at: string;
}

/** The keys a shared unit's per-queue override may hold. */
const SHARED_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  "jobsPerWorker",
  "maxWorkers",
]);

/**
 * The name of the summon group `policy` makes a shared unit of
 * (`group: { name, unit: "shared" }`), or `undefined` when it is not one.
 * The group itself is checked by the controller; a missing name is
 * `undefined` here and refused there.
 */
export function sharedUnitGroup(policy: unknown): string | undefined {
  if (!isRecord(policy)) {
    return undefined;
  }
  const group: unknown = policy.group;
  if (!isRecord(group) || group.unit !== "shared") {
    return undefined;
  }
  return typeof group.name === "string" ? group.name : "";
}

/**
 * A shared unit's `overrides`, checked where it was written: a record of
 * `{ jobsPerWorker?, maxWorkers? }` by a queue in `queues`. An override of
 * `undefined` is no override, as it is for a per-queue entry, and is left
 * out. `undefined` when there are none.
 *
 * @throws {ConfigError} for `overrides` that is not a record, an override
 *   for a queue not in `queues`, one that is not an object, or any key but
 *   `jobsPerWorker` and `maxWorkers`; each names `where`.
 */
function sharedOverrides(
  /** The entry's `overrides`, as given. */
  overrides: unknown,
  /** Where the entry was written, for an error to name. */
  where: string,
  /** The unit's queues. */
  queues: readonly string[],
): SharedUnitOverrides | undefined {
  if (overrides === undefined) {
    return undefined;
  }
  if (!isRecord(overrides)) {
    throw new ConfigError(
      `${where}.overrides must be a record of per-queue values by queue`,
      { at: where },
    );
  }
  const checked: Record<
    string,
    Pick<SummonPolicy, "jobsPerWorker" | "maxWorkers">
  > = {};
  for (const [queue, override] of Object.entries(overrides)) {
    if (!queues.includes(queue)) {
      throw new ConfigError(
        `${where}.overrides names queue "${queue}", which the unit's queues do not: an override changes the values of one of its own queues`,
        { queue, at: where },
      );
    }
    if (override === undefined) {
      continue;
    }
    if (!isRecord(override)) {
      throw new ConfigError(
        `${where}.overrides.${queue} must be { jobsPerWorker?, maxWorkers? } for a shared unit`,
        { queue, at: where },
      );
    }
    for (const key of Object.keys(override)) {
      if (!SHARED_OVERRIDE_KEYS.has(key)) {
        throw new ConfigError(
          `${where}.overrides.${queue}.${key}: a shared unit (group.unit "shared") takes only jobsPerWorker and maxWorkers per queue; ${key} is the unit's, so set it on the entry`,
          { queue, key, at: where },
        );
      }
    }
    // A computed key, so `__proto__` is an own property like any queue's.
    Object.defineProperty(checked, queue, {
      value: override,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.keys(checked).length === 0 ? undefined : checked;
}

/**
 * The `summon` option expanded to one entry per controller, in the order
 * written: one per queue, except that a shared unit (`group.unit:
 * "shared"`) is one entry for all of its queues. Internal: `BunJobs` builds a
 * controller from each entry.
 *
 * @throws {ConfigError} for an entry that is neither a group nor a record (a
 *   hole in the array included), a record entry that is not a policy, a group
 *   with no queues (or a `queues` that is not an array of names), an override
 *   for a queue its group does not name, a shared unit's override of anything
 *   but `jobsPerWorker` and `maxWorkers`, a queue name that is not a valid
 *   segment, a queue named twice anywhere in the option, a shared unit with
 *   no `group.name`, or one summon group's shared unit written in two
 *   places. Each names where. (What the controller refuses of a shared
 *   unit's entry — a per-queue `maxWorkers` above the unit's, a provider at
 *   summon `0.1`, … — `BunJobs` reports with the entry's place appended.)
 */
export function expandSummonOption(
  /** The option as given; `undefined` and `null` expand to nothing. */
  option: SummonOption | null | undefined,
): SummonEntry[] {
  const entries: SummonEntry[] = [];
  /** Where each queue was named, so a second naming is refused. */
  const named = new Map<string, string>();
  /** Where each shared unit's group was written, so a second is refused. */
  const units = new Map<string, string>();
  if (option === undefined || option === null) {
    return entries;
  }

  /** Checks one queue name, refusing a bad name or a second naming. */
  const name = (queue: string, where: string): void => {
    assertSegment(queue, `summon queue "${queue}" (at ${where})`);
    if (named.has(queue)) {
      throw new ConfigError(
        `Queue "${queue}" is named twice in the summon option (again at ${where}): each queue takes one policy`,
        { queue, at: where },
      );
    }
    named.set(queue, where);
  };

  /** Records a shared unit's group, refusing one written twice. */
  const unit = (group: string, where: string): void => {
    if (group === "") {
      // Before the duplicate check: two nameless units are not "one group
      // written twice", they are two units with no group to share.
      throw new ConfigError(
        `${where}.group.name is required for a shared unit (group.unit "shared"): the group's name is the key its state is stored under`,
        { at: where },
      );
    }
    const first = units.get(group);
    if (first !== undefined) {
      throw new ConfigError(
        `Summon group "${group}" is a shared unit written twice in the summon option (at ${first} and ${where}): a shared unit is one controller, so list all of its queues in one entry, { queues: [...], group: { name: "${group}", unit: "shared" }, … }`,
        { group, at: where, first },
      );
    }
    units.set(group, where);
  };

  /** Adds every queue of a record entry. */
  const addRecord = (record: Record<string, unknown>, where: string): void => {
    for (const [queue, policy] of Object.entries(record)) {
      const at = `${where}.${queue}`;
      if (!isRecord(policy)) {
        throw new ConfigError(
          `${at} must be a summon policy ({ summoner, … }) for queue "${queue}"`,
          { queue, at },
        );
      }
      name(queue, at);
      const group = sharedUnitGroup(policy);
      if (group === undefined) {
        entries.push({
          queues: [queue],
          policy: policy as unknown as SummonPolicy,
          shared: false,
          at,
        });
        continue;
      }
      // A shared unit of one queue (Q5). Its policy may carry `overrides`
      // (`SummonControllerOptions.overrides`), checked here so an error
      // names where.
      unit(group, at);
      const { overrides, ...rest } = policy;
      const checked = sharedOverrides(overrides, at, [queue]);
      entries.push({
        queues: [queue],
        policy: rest as unknown as SummonPolicy,
        shared: true,
        ...(checked === undefined ? {} : { overrides: checked }),
        at,
      });
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
    return entries;
  }

  const items: readonly unknown[] = option;
  for (let index = 0; index < items.length; index++) {
    const where = `summon[${index}]`;
    if (!(index in items)) {
      throw new ConfigError(
        `${where} is a hole in the array: each entry is a group ({ queues, summoner, … }) or a record of policies by queue`,
        { at: where },
      );
    }
    const entry = items[index];
    if (!isRecord(entry)) {
      throw new ConfigError(
        `${where} must be a group ({ queues, summoner, … }) or a record of policies by queue`,
        { at: where },
      );
    }
    if (!Object.hasOwn(entry, "queues")) {
      addRecord(entry, where);
      continue;
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
    const group = sharedUnitGroup(policy);
    if (group !== undefined) {
      // One controller for every queue of the entry (§4.2, Q1): each queue
      // may change only its own capacity.
      const checked = sharedOverrides(overrides, where, queues);
      queues.forEach((queue, position) => {
        name(queue, `${where}.queues[${position}]`);
      });
      unit(group, where);
      entries.push({
        queues: [...queues],
        policy,
        shared: true,
        ...(checked === undefined ? {} : { overrides: checked }),
        at: where,
      });
      continue;
    }
    queues.forEach((queue, position) => {
      const override =
        overrides !== undefined && Object.hasOwn(overrides, queue)
          ? overrides[queue]
          : undefined;
      const at = `${where}.queues[${position}]`;
      name(queue, at);
      const merged = withOverride(policy, override);
      if (sharedUnitGroup(merged) !== undefined) {
        throw new ConfigError(
          `${where}.overrides.${queue}.group makes "${queue}" a shared unit (group.unit "shared") inside an entry of per-queue controllers: write the shared unit as an entry of its own`,
          { queue, at: where },
        );
      }
      entries.push({
        queues: [queue],
        policy: merged,
        shared: false,
        at,
      });
    });
  }
  return entries;
}
