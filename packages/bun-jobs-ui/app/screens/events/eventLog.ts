import type {
  EventName,
  EventWire,
  JobsApiGapMessage,
  JobsApiMode,
} from "../../api/types";
import {
  decodeJobId,
  EVENT_TYPES,
  QUEUE_EVENT_TYPES,
  RUNNER_EVENT_TYPES,
  WORKER_EVENT_TYPES,
} from "@kingsleyweb/bun-jobs/api/contract";
import { liveChannels } from "../../live";

/**
 * The Events console's pure half: which channel is chosen (and how it reads
 * from and writes to the URL), which event types it may filter on, and the
 * bounded log of what arrived.
 */

/** Most rows the console keeps; older ones drop off the end. */
export const MAX_ROWS = 500;

/** Most events held while the display is paused; later ones are counted as dropped. */
export const MAX_PAUSED = 500;

/** One line of the console. */
export type LogRow =
  | {
      /** A stable React key, increasing with arrival. */
      key: number;
      /** An event frame. */
      kind: "event";
      /** When the browser received it, epoch ms. */
      receivedAt: number;
      /** The event. */
      event: EventWire;
    }
  | {
      /** A stable React key, increasing with arrival. */
      key: number;
      /** The server reported that events were lost. */
      kind: "gap";
      /** When the browser received it, epoch ms. */
      receivedAt: number;
      /** The gap frame. */
      gap: JobsApiGapMessage;
    };

/**
 * `incoming` (oldest first) added ahead of `rows` (newest first), keeping at
 * most `cap` rows: the newest.
 */
export function prependRows(
  rows: readonly LogRow[],
  incoming: readonly LogRow[],
  cap: number = MAX_ROWS,
): LogRow[] {
  const next = [...incoming].reverse().concat(rows);
  return next.length > cap ? next.slice(0, cap) : next;
}

/** What the channel picker chose. */
export type ChannelChoice =
  | {
      /** `all`, `queues`, `runners` or `workers`. */
      scope: "all" | "queues" | "runners" | "workers";
    }
  | {
      /** One queue's events. */
      scope: "queue";
      /** The queue. */
      queue: string;
    }
  | {
      /** One runner's events. */
      scope: "runner";
      /** The runner id. */
      runner: string;
    }
  | {
      /** One queue's worker events. */
      scope: "queueWorkers";
      /** The queue. */
      queue: string;
    }
  | {
      /** One job's events. */
      scope: "job";
      /** The job's queue. */
      queue: string;
      /** The job id, decoded. */
      id: string;
    };

/** The picker's scopes. */
export type ChannelScope = ChannelChoice["scope"];

/**
 * The scopes a mode offers: `all` only in `both`, queue and worker scopes
 * with jobs, runner scopes with runners. Worker events travel on their own
 * channels — never on `all` or `queues` — so watching them is a scope of its
 * own rather than a filter over a queue channel.
 */
export function scopesFor(mode: JobsApiMode): ChannelScope[] {
  const queues = mode !== "runner";
  const runners = mode !== "jobs";
  return [
    ...(queues && runners ? (["all"] as const) : []),
    ...(queues
      ? (["queues", "queue", "job", "workers", "queueWorkers"] as const)
      : []),
    ...(runners ? (["runners", "runner"] as const) : []),
  ];
}

/** The channel the console opens on: `all` in `both`, else the mode's broad channel. */
export function defaultChoice(mode: JobsApiMode): ChannelChoice {
  if (mode === "both") {
    return { scope: "all" };
  }
  return { scope: mode === "jobs" ? "queues" : "runners" };
}

/** The channel name of a choice (see `liveChannels`). */
export function channelName(choice: ChannelChoice): string {
  switch (choice.scope) {
    case "all":
    case "queues":
    case "runners":
    case "workers":
      return liveChannels[choice.scope];
    case "queueWorkers":
      return liveChannels.queueWorkers(choice.queue);
    case "queue":
      return liveChannels.queue(choice.queue);
    case "runner":
      return liveChannels.runner(choice.runner);
    case "job":
      return liveChannels.job(choice.queue, choice.id);
  }
}

/**
 * A channel name read back into a choice: `null` when it is malformed, or
 * not a channel `mode` has (a runner channel in `jobs` mode, `all` outside
 * `both`).
 */
export function parseChannel(
  raw: string | null,
  mode: JobsApiMode,
): ChannelChoice | null {
  if (raw === null || raw === "") {
    return null;
  }
  const choice = readChannel(raw);
  return choice && scopesFor(mode).includes(choice.scope) ? choice : null;
}

/** {@link parseChannel} without the mode check. */
function readChannel(raw: string): ChannelChoice | null {
  if (
    raw === "all" ||
    raw === "queues" ||
    raw === "runners" ||
    raw === "workers"
  ) {
    return { scope: raw };
  }
  // Before the one-queue pattern: `queue/<queue>/workers` is its own channel.
  const queueWorkers = /^queue\/([^/]+)\/workers$/.exec(raw);
  if (queueWorkers) {
    return { scope: "queueWorkers", queue: queueWorkers[1]! };
  }
  const job = /^queue\/([^/]+)\/job\/(.+)$/.exec(raw);
  if (job) {
    try {
      return { scope: "job", queue: job[1]!, id: decodeJobId(job[2]!) };
    } catch {
      return null;
    }
  }
  const queue = /^queue\/([^/]+)$/.exec(raw);
  if (queue) {
    return { scope: "queue", queue: queue[1]! };
  }
  const runner = /^runner\/([^/]+)$/.exec(raw);
  if (runner) {
    return { scope: "runner", runner: runner[1]! };
  }
  return null;
}

/** The event types a choice can carry: queue events on queue channels, runner events on runner channels, every type on `all`. */
export function typesFor(choice: ChannelChoice): readonly EventName[] {
  switch (choice.scope) {
    case "all":
      return EVENT_TYPES;
    case "queues":
    case "queue":
    case "job":
      return QUEUE_EVENT_TYPES;
    case "workers":
    case "queueWorkers":
      return WORKER_EVENT_TYPES;
    case "runners":
    case "runner":
      return RUNNER_EVENT_TYPES;
  }
}

/** A name in the `types` URL parameter that the filter ignores, and why. */
export interface IgnoredType {
  /** The name as written in the URL. */
  name: string;
  /** `unknown`: no such event type; `channel`: a type the channel does not carry. */
  reason: "unknown" | "channel";
}

/** The `types` URL parameter, read (see {@link readTypes}). */
export interface TypesParam {
  /** The filter: the listed types the channel carries, in `allowed`'s order. Empty means every type. */
  types: EventName[];
  /** Listed names left out of the filter, in the order written. */
  ignored: IgnoredType[];
  /**
   * The parameter with every name the filter uses written bare
   * (`queue.completed` → `completed`, de-duplicated, in `allowed`'s order),
   * then the ignored names as written, so the note about them survives a
   * reload; `null` for no names.
   */
  normalized: string | null;
}

/** The event names of each family, for `queue.` / `runner.` / `worker.` prefixes. */
const FAMILY_TYPES: Readonly<
  Record<"queue" | "runner" | "worker", readonly string[]>
> = {
  queue: QUEUE_EVENT_TYPES,
  runner: RUNNER_EVENT_TYPES,
  worker: WORKER_EVENT_TYPES,
};

/**
 * Reads the `types` URL parameter against the types a channel carries
 * (`allowed`, from {@link typesFor}). A name is bare (`completed`) or
 * prefixed with its family (`queue.completed`, `runner.failed`); a prefixed
 * one counts only on a channel that carries that family. Unknown names and
 * names the channel does not carry are reported in `ignored`, not dropped
 * silently: the console shows them, rather than quietly showing every type.
 */
export function readTypes(
  raw: string | null,
  allowed: readonly EventName[],
): TypesParam {
  const allowedSet: ReadonlySet<string> = new Set(allowed);
  const known: ReadonlySet<string> = new Set(EVENT_TYPES);
  const listed = new Set<string>();
  const ignored: IgnoredType[] = [];
  const names = [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  for (const name of names) {
    const prefixed = /^(queue|runner)\.(.+)$/.exec(name);
    if (prefixed) {
      const family = FAMILY_TYPES[prefixed[1] as "queue" | "runner"];
      const bare = prefixed[2]!;
      if (!family.includes(bare)) {
        ignored.push({ name, reason: "unknown" });
      } else if (family.every((type) => allowedSet.has(type))) {
        listed.add(bare);
      } else {
        ignored.push({ name, reason: "channel" });
      }
    } else if (!known.has(name)) {
      ignored.push({ name, reason: "unknown" });
    } else if (allowedSet.has(name)) {
      listed.add(name);
    } else {
      ignored.push({ name, reason: "channel" });
    }
  }
  const types = allowed.filter((type) => listed.has(type));
  const written = [...types, ...ignored.map((entry) => entry.name)];
  return {
    types,
    ignored,
    normalized: written.length > 0 ? written.join(",") : null,
  };
}

/** The `types` URL parameter read as a filter: {@link readTypes}'s `types`. Empty means every type. */
export function parseTypes(
  raw: string | null,
  allowed: readonly EventName[],
): EventName[] {
  return readTypes(raw, allowed).types;
}

/** Whether an event passes the type filter (empty: every type). */
export function matchesTypes(
  event: EventWire,
  types: readonly EventName[],
): boolean {
  return types.length === 0 || types.includes(event.type);
}
