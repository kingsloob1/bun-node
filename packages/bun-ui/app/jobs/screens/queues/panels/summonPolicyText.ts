import type { SummonPolicyKey } from "../../../api/contract";
import type {
  SummonCapabilitiesDto,
  SummonPolicyDto,
  SummonStatusDto,
  SummonTriggerDto,
} from "../../../api/types";
import { displayText, formatNumber, plural } from "../../../format";
import { formatMs } from "../duration";

/**
 * A summon controller's policy in plain words: the rows of the Summon
 * panel's Policy block (`status.policy`, advertised by
 * `/meta.features.summonPolicy`), each value marked "default" where the
 * policy did not set it.
 *
 * Every value names the `SUMMON_POLICY_KEYS` paths it shows, so whether it
 * is a default is one lookup in `policy.explicit`. Values the policy cannot
 * set — the platform's shutdown and lifetime cap, from the summoner's
 * capabilities — name none and are never marked.
 */

/** What the Summon panel shows of a status's policy. */
export type SummonPolicyVisibility =
  /** The Policy block. */
  | "shown"
  /** One line: the controller runs in another process, which alone knows its policy. */
  | "elsewhere"
  /** Nothing: an API without the field, or a local status without a policy. */
  | "none";

/** The line shown in place of the Policy block for a status read from storage (`local: false`). */
export const SUMMON_POLICY_ELSEWHERE =
  "Its policy is known only where its controller runs.";

/** The Boot budget row's value while the summoner is not ready and the policy set none. */
export const PROVIDER_DEFAULT_BOOT_BUDGET = "(provider default)";

/** The Workers row's hint: which values it shows depends on readiness, and it does not say which. */
export const SUMMON_POLICY_WORKERS_HINT =
  "While the summoner is not ready, the configured values; once it is, they may be lowered to a wake pool's size.";

/** The tooltip of a value's "default" tag. */
export const SUMMON_POLICY_DEFAULT_HINT =
  "The policy does not set this: the default applies.";

/** The tooltip of a per-queue value's "override" tag. */
export const SUMMON_POLICY_OVERRIDE_HINT =
  "Set for this queue by the unit's overrides.";

/**
 * Whether the Summon panel shows the policy: only where the API says it
 * sends one (`features.summonPolicy`, compared with `true` so an older API's
 * missing flag is off). A status read from storage (`local: false`) never
 * has one, which the panel says in a line; a local status without one shows
 * nothing.
 */
export function summonPolicyVisibility(
  featureOn: boolean,
  status: Pick<SummonStatusDto, "local" | "policy">,
): SummonPolicyVisibility {
  if (!featureOn) {
    return "none";
  }
  if (!status.local) {
    return "elsewhere";
  }
  return status.policy === undefined ? "none" : "shown";
}

/** One piece of a policy row's value, with the policy keys it shows. */
export interface SummonPolicyPart {
  /** What is printed before it, after the previous piece: `""` for the first. */
  joiner: string;
  /** The piece in words; for {@link names}, what an empty list reads. */
  text: string;
  /**
   * The `SUMMON_POLICY_KEYS` paths it shows. Empty for a value no policy
   * key sets (the platform's, from the summoner's capabilities, or a
   * trigger kind this build does not know), which is never tagged.
   */
  keys: readonly SummonPolicyKey[];
  /** Whether it is shown muted: a trigger that is off. */
  muted: boolean;
  /** Names shown as code chips in place of {@link text} when there are any (the env names). */
  names?: readonly string[];
  /** Whether it carries its own "default" tag (see {@link SummonPolicyRow.tag}). */
  tag: boolean;
}

/** One row of the Policy block. */
export interface SummonPolicyRow {
  /** Stable id: the row's `data-testid` is `summon-policy-<id>`. */
  id: string;
  /** The row's label. */
  label: string;
  /** Its value, piece by piece. */
  parts: SummonPolicyPart[];
  /** A note under the value. */
  hint?: string;
  /**
   * Whether the row carries one "default" tag after its whole value: when
   * every piece shows policy keys and none of them was set. Otherwise each
   * piece none of whose keys was set carries its own ({@link SummonPolicyPart.tag}).
   */
  tag: boolean;
}

/** A piece before its tag is decided. */
type Piece = Omit<SummonPolicyPart, "tag" | "muted"> & { muted?: boolean };

/** A piece: `text` showing `keys`, after `joiner`. */
function piece(
  text: string,
  keys: readonly SummonPolicyKey[],
  joiner = "",
  muted = false,
): Piece {
  return { joiner, text, keys, muted };
}

/** Each known trigger kind's label. */
const TRIGGER_LABELS: Readonly<Record<SummonTriggerDto["kind"], string>> = {
  onAdd: "On add",
  events: "Events",
  poll: "Poll",
};

/** Each trigger kind's policy key. */
const TRIGGER_KEYS: Readonly<
  Record<SummonTriggerDto["kind"], SummonPolicyKey>
> = {
  onAdd: "triggers.onAdd",
  events: "triggers.events",
  poll: "triggers.poll",
};

/** Each `servedBy` in words. */
const SERVED_BY: Readonly<Record<SummonPolicyDto["servedBy"], string>> = {
  "any-worker": "any live worker",
  "summoned-only": "summoned workers only",
};

/** Whether `key` is an own key of `table` (so `"toString"` is not). */
function known<K extends string>(
  table: Readonly<Record<K, unknown>>,
  key: unknown,
): key is K {
  return typeof key === "string" && Object.hasOwn(table, key);
}

/** A trigger of a kind this build does not know, as raw text: `webhook (on: true, every: 5000)`. */
function unknownTrigger(trigger: SummonTriggerDto): string {
  const fields = Object.entries(trigger)
    .filter(([key]) => key !== "kind")
    .map(([key, value]) => `${key}: ${displayText(value)}`);
  const kind = displayText(trigger.kind);
  return fields.length === 0 ? kind : `${kind} (${fields.join(", ")})`;
}

/**
 * The triggers, in the order given: "On add · Events (coalesced 250ms) ·
 * Poll every 10s". One that is off reads "<label> off", muted; a kind this
 * build does not know, raw text, untagged.
 *
 * The debounce coalesces add and event triggers alike, so it is printed
 * once, after the last trigger that is on and carries it, as its own piece
 * (`triggers.debounce`); a trigger with a different debounce gets its own.
 * With neither on, it is not printed: it changes nothing.
 */
function triggerPieces(triggers: readonly SummonTriggerDto[]): Piece[] {
  const pieces: Piece[] = [];
  triggers.forEach((trigger, index) => {
    const joiner = pieces.length === 0 ? "" : " · ";
    if (!known(TRIGGER_LABELS, trigger.kind)) {
      pieces.push(
        piece(unknownTrigger(trigger), [], joiner, trigger.on === false),
      );
      return;
    }
    const label = TRIGGER_LABELS[trigger.kind];
    const key = TRIGGER_KEYS[trigger.kind];
    if (trigger.on !== true) {
      pieces.push(piece(`${label} off`, [key], joiner, true));
      return;
    }
    if (trigger.kind === "poll") {
      pieces.push(
        piece(
          typeof trigger.every === "number"
            ? `${label} every ${formatMs(trigger.every)}`
            : label,
          [key],
          joiner,
        ),
      );
      return;
    }
    pieces.push(piece(label, [key], joiner));
    const debounce = trigger.debounce;
    const repeated = triggers
      .slice(index + 1)
      .some(
        (later) =>
          later.on === true &&
          (later.kind === "onAdd" || later.kind === "events") &&
          later.debounce === debounce,
      );
    if (typeof debounce === "number" && !repeated) {
      pieces.push(
        piece(`(coalesced ${formatMs(debounce)})`, ["triggers.debounce"], " "),
      );
    }
  });
  return pieces;
}

/** `jobsPerWorker` in words: "2 jobs per worker", or `null` "one regardless of depth". */
export function jobsPerWorkerText(value: number | null): string {
  return value === null
    ? "one regardless of depth"
    : `${plural(value, "job")} per worker`;
}

/** The platform's shutdown in words: "SIGTERM, 3s grace (up to 1m)", or "no stop signal (in-invocation)". */
export function shutdownText(
  shutdown: SummonCapabilitiesDto["shutdown"],
): string {
  if (shutdown.signal === "none") {
    return "no stop signal (in-invocation)";
  }
  const upTo =
    typeof shutdown.graceMaxMs === "number"
      ? ` (up to ${formatMs(shutdown.graceMaxMs)})`
      : "";
  return `${displayText(shutdown.signal)}, ${formatMs(shutdown.graceMs)} grace${upTo}`;
}

/** A row before its tags are decided. */
interface Draft {
  /** {@link SummonPolicyRow.id}. */
  id: string;
  /** {@link SummonPolicyRow.label}. */
  label: string;
  /** Its pieces. */
  pieces: Piece[];
  /** {@link SummonPolicyRow.hint}. */
  hint?: string;
}

/** Decides a row's tags against the keys the policy set. */
function tagged(draft: Draft, explicit: ReadonlySet<string>): SummonPolicyRow {
  const defaulted = (keys: readonly SummonPolicyKey[]) =>
    keys.length > 0 && keys.every((key) => !explicit.has(key));
  const whole =
    draft.pieces.length > 0 &&
    draft.pieces.every((part) => defaulted(part.keys));
  return {
    id: draft.id,
    label: draft.label,
    ...(draft.hint === undefined ? {} : { hint: draft.hint }),
    tag: whole,
    parts: draft.pieces.map((part) => ({
      ...part,
      muted: part.muted === true,
      tag: !whole && defaulted(part.keys),
    })),
  };
}

/**
 * The Policy block's rows, in the panel's order, each value marked
 * "default" where the policy did not set it (`policy.explicit`).
 *
 * - **Workers** shows `maxWorkers`, `jobsPerWorker` and `maxPending`, with a
 *   hint that they are the configured values or a wake pool's clamp
 *   depending on readiness.
 * - **Group circuit** only where `circuit.group` is present: a per-queue
 *   member of a group with a shared circuit, never a shared unit.
 * - **Boot budget** reads {@link PROVIDER_DEFAULT_BOOT_BUDGET} when absent
 *   (the summoner is not ready and the policy set none), never a number.
 * - **Longest life** adds the platform's cap and **Shutdown** is the
 *   platform's own, both from `capabilities` and untagged; without
 *   `capabilities` (not ready) there is no Shutdown row.
 * - **Scale down** only for a scale-style summoner.
 *
 * The per-queue capacities of a shared unit are {@link summonPolicyPerQueue};
 * the budget stays in the status's own Budget row ({@link summonBudgetDefaulted}).
 */
export function summonPolicyRows(
  policy: SummonPolicyDto,
  capabilities: SummonCapabilitiesDto | undefined,
): SummonPolicyRow[] {
  const explicit = new Set<string>(
    Array.isArray(policy.explicit) ? policy.explicit : [],
  );
  const group = policy.circuit.group;
  const rows: (Draft | false)[] = [
    {
      id: "triggers",
      label: "Triggers",
      pieces: triggerPieces(policy.triggers),
      hint: "What makes the controller check for work to summon for.",
    },
    {
      id: "workers",
      label: "Workers",
      pieces: [
        piece(`at most ${formatNumber(policy.maxWorkers)}`, ["maxWorkers"]),
        piece(
          jobsPerWorkerText(policy.jobsPerWorker),
          ["jobsPerWorker"],
          " · ",
        ),
        piece(
          `at most ${formatNumber(policy.maxPending)} starting`,
          ["maxPending"],
          " · ",
        ),
      ],
      hint: SUMMON_POLICY_WORKERS_HINT,
    },
    {
      id: "cooldown",
      label: "Cooldown",
      pieces: [piece(formatMs(policy.cooldown), ["cooldown"])],
      hint: "The least time between two attempts.",
    },
    {
      id: "backoff",
      label: "Backoff",
      pieces: [
        piece(formatMs(policy.backoff.initial), ["backoff.initial"]),
        piece(
          `doubling to ${formatMs(policy.backoff.max)}`,
          ["backoff.max"],
          ", ",
        ),
      ],
      hint: "The wait after a failed or lost attempt, doubling with each one in a row.",
    },
    {
      id: "circuit",
      label: "Circuit",
      pieces: [
        piece(`opens after ${plural(policy.circuit.failures, "failure")}`, [
          "circuit.failures",
        ]),
        piece(
          `for ${formatMs(policy.circuit.resetAfter)}`,
          ["circuit.resetAfter"],
          ", ",
        ),
      ],
      hint: "Failed or lost attempts in a row that stop summoning, and for how long before one trial attempt.",
    },
    group !== undefined && {
      id: "group-circuit",
      label: "Group circuit",
      pieces: [
        piece(
          `opens after ${plural(group.failures, "failure")} across the group`,
          ["group.circuit.failures"],
        ),
        piece(
          `for ${formatMs(group.resetAfter)}`,
          ["group.circuit.resetAfter"],
          ", ",
        ),
      ],
      hint: "The summon group's shared circuit: failures of this summoner's kind on any of its queues.",
    },
    {
      id: "boot-budget",
      label: "Boot budget",
      pieces: [
        typeof policy.bootBudget === "number"
          ? piece(formatMs(policy.bootBudget), ["bootBudget"])
          : // Not known until the summoner is ready, and not the policy's.
            piece(PROVIDER_DEFAULT_BOOT_BUDGET, []),
      ],
      hint: "How long an attempt counts as a worker on its way before it is lost.",
    },
    {
      id: "lifetime",
      label: "Longest life",
      pieces: [
        piece(formatMs(policy.maxLifetime), ["maxLifetime"]),
        ...(typeof capabilities?.maxLifetimeMs === "number"
          ? [
              piece(
                `platform cap ${formatMs(capabilities.maxLifetimeMs)}`,
                [],
                " · ",
              ),
            ]
          : []),
      ],
      hint: "The longest a summoned worker may live.",
    },
    capabilities !== undefined && {
      id: "shutdown",
      label: "Shutdown",
      pieces: [piece(shutdownText(capabilities.shutdown), [])],
      hint: "What the platform sends to stop a unit, and how long it waits: declared by the provider, not set by the policy.",
    },
    capabilities?.style === "scale" && {
      id: "scale-down",
      label: "Scale down",
      pieces: [
        piece(`to zero after ${formatMs(policy.scaleDown.after)} idle`, [
          "scaleDown.after",
        ]),
      ],
    },
    {
      id: "summon-timeout",
      label: "Summon timeout",
      pieces: [piece(formatMs(policy.summonTimeout), ["summonTimeout"])],
      hint: "How long one call to the summoner may take.",
    },
    {
      id: "served-by",
      label: "Served by",
      pieces: [
        piece(
          known(SERVED_BY, policy.servedBy)
            ? SERVED_BY[policy.servedBy]
            : displayText(policy.servedBy),
          ["servedBy"],
        ),
      ],
      hint: "Which live workers count as serving the queue.",
    },
    {
      id: "env",
      label: "Env",
      pieces: [
        {
          ...piece("none", ["env"]),
          names: policy.env.map((name) => displayText(name)),
        },
      ],
      hint: "The names the policy adds to every summoned worker's environment. Their values are never sent.",
    },
    {
      id: "from-summoned",
      label: "From summoned workers",
      pieces: [piece(policy.fromSummoned ? "yes" : "no", ["fromSummoned"])],
      hint: "Whether this controller may run in a summoned process or a runner child.",
    },
    {
      id: "failure-hook",
      label: "Failure hook",
      pieces: [
        piece(policy.onSummonFailed ? "set" : "not set", ["onSummonFailed"]),
      ],
      hint: "Whether an onSummonFailed hook is called on failed attempts.",
    },
  ];
  return rows
    .filter((row): row is Draft => row !== false)
    .map((row) => tagged(row, explicit));
}

/** One queue of a shared unit's per-queue capacities. */
export interface SummonPolicyQueueRow {
  /** The queue, made safe as text. */
  queue: string;
  /** Its jobs per worker in words ({@link jobsPerWorkerText}). */
  jobsPerWorker: string;
  /** Its most workers. */
  maxWorkers: string;
  /** Whether the unit's overrides set its `jobsPerWorker`. */
  jobsPerWorkerOverride: boolean;
  /** Whether the unit's overrides set its `maxWorkers`. */
  maxWorkersOverride: boolean;
}

/**
 * A shared unit's per-queue capacities (`policy.perQueue`), in the order the
 * API sends them, each value marked where the unit's overrides set it.
 * `undefined` for a controller of one queue, which has none.
 */
export function summonPolicyPerQueue(
  policy: Pick<SummonPolicyDto, "perQueue">,
): SummonPolicyQueueRow[] | undefined {
  if (policy.perQueue === undefined) {
    return undefined;
  }
  return Object.entries(policy.perQueue).map(([queue, capacity]) => {
    const set = Array.isArray(capacity.explicit) ? capacity.explicit : [];
    return {
      queue: displayText(queue),
      jobsPerWorker: jobsPerWorkerText(capacity.jobsPerWorker),
      maxWorkers: formatNumber(capacity.maxWorkers),
      jobsPerWorkerOverride: set.includes("jobsPerWorker"),
      maxWorkersOverride: set.includes("maxWorkers"),
    };
  });
}

/**
 * Whether the status's existing Budget row is marked "default": the policy
 * gave no `budget` at all (`budget` is listed whenever it gave one, `false`
 * included). Only where the policy is shown; without one, nothing is known.
 */
export function summonBudgetDefaulted(
  policy: Pick<SummonPolicyDto, "explicit"> | undefined,
): boolean {
  return (
    policy !== undefined &&
    Array.isArray(policy.explicit) &&
    !policy.explicit.includes("budget")
  );
}
