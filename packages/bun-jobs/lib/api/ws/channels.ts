import type { DriverEvent } from "../../shared/events";
import type { AuthorizeTarget } from "../auth";
import type { ResolvedJobsApiConfig } from "../config";
import type { AnyRouteDef, RouteMode } from "../routes/define";
import type { JobsApiWsErrorCode } from "./protocol";
import { ConfigError } from "../../shared/errors";
import { assertSegment } from "../../shared/keys";
import { decodeJobId, encodeJobId } from "../contract/constants";
import { isRouteEnabled } from "../routes/define";

/**
 * The socket's channels: which exist, how a name is parsed and checked, and
 * which channels an event reaches.
 *
 * Channel availability goes through the same pruning predicate as routes
 * (`isRouteEnabled`), under the `events.subscribe` action, so a mode, an
 * `actions` list or an `enabledWhen` removes a channel from the hub and from
 * the AsyncAPI document in exactly one place.
 */

/** A channel family. Also its AsyncAPI channel id. */
export type ChannelKind =
  | "all"
  | "queues"
  | "queue"
  | "job"
  | "workers"
  | "queueWorkers"
  | "runners"
  | "runner";

/** One channel family. */
export interface ChannelDef {
  /** The family, and its AsyncAPI channel id. */
  kind: ChannelKind;
  /** The AsyncAPI address template, e.g. `"queue/{queue}"`. */
  address: string;
  /** Which half of the API the channel belongs to. */
  mode: RouteMode;
  /** An extra condition on the configuration. */
  enabledWhen?: (config: ResolvedJobsApiConfig) => boolean;
  /** Which events it carries. */
  receives: "all" | "queue" | "runner" | "worker";
  /** Address parameters, in order. */
  parameters: readonly ("queue" | "jobId" | "runner")[];
  /**
   * A human name for the documents, used for the AsyncAPI channel's `title`
   * and in its operation's. Defaults to the kind, capitalised — which only
   * reads well while the kind is one word, so a camel-cased kind sets it.
   */
  label?: string;
  /** Human description, for the documents. */
  description: string;
}

/** Every channel family, in document order. */
export const CHANNELS: readonly ChannelDef[] = [
  {
    kind: "all",
    address: "all",
    mode: "any",
    // Only meaningful when both halves are exposed; otherwise it would be a
    // second name for `queues` or `runners`.
    enabledWhen: (config) => config.mode === "both",
    receives: "all",
    parameters: [],
    description: "Every queue and runner event in the namespace.",
  },
  {
    kind: "queues",
    address: "queues",
    mode: "jobs",
    receives: "queue",
    parameters: [],
    description: "Every queue event.",
  },
  {
    kind: "queue",
    address: "queue/{queue}",
    mode: "jobs",
    receives: "queue",
    parameters: ["queue"],
    description: "Every event of one queue.",
  },
  {
    kind: "job",
    address: "queue/{queue}/job/{jobId}",
    mode: "jobs",
    receives: "queue",
    parameters: ["queue", "jobId"],
    description:
      "Every event about one job, including a `stalled`, `retried` or `cleaned` event listing it among several. The job id is `encodeURIComponent`-escaped; a lone UTF-16 surrogate, which `encodeURIComponent` cannot encode, is written `%uXXXX`.",
  },
  {
    kind: "workers",
    address: "workers",
    mode: "jobs",
    receives: "worker",
    parameters: [],
    description:
      "Every worker event, on every queue: a controller's instruction, a worker changing state, and a worker adopting or refusing a configuration override.",
  },
  {
    kind: "queueWorkers",
    address: "queue/{queue}/workers",
    mode: "jobs",
    receives: "worker",
    parameters: ["queue"],
    label: "Queue workers",
    description:
      "Every worker event of one queue. Worker events are grouped per queue, never per worker, so a process with several workers on a queue shares one subscription and none of them see the queue's job firehose.",
  },
  {
    kind: "runners",
    address: "runners",
    mode: "runner",
    receives: "runner",
    parameters: [],
    description: "Every runner event.",
  },
  {
    kind: "runner",
    address: "runner/{runner}",
    mode: "runner",
    receives: "runner",
    parameters: ["runner"],
    description: "Every event of one runner.",
  },
];

/** The channel family of each kind. */
const BY_KIND = new Map(CHANNELS.map((def) => [def.kind, def]));

/**
 * Whether the configuration has a socket at all: `websocket` is not `false`,
 * and both `events.connect` and `events.subscribe` survive `actions` — a
 * socket nobody may connect to, or subscribe on, is not documented or served.
 */
export function isWebSocketEnabled(
  config: Pick<ResolvedJobsApiConfig, "websocket" | "enabledActions">,
): boolean {
  return (
    config.websocket !== false &&
    config.enabledActions.has("events.connect") &&
    config.enabledActions.has("events.subscribe")
  );
}

/** Whether a channel family is served and documented under this configuration. */
export function isChannelEnabled(
  def: ChannelDef,
  config: ResolvedJobsApiConfig,
): boolean {
  if (!isWebSocketEnabled(config)) {
    return false;
  }
  // `isRouteEnabled` reads only the gating fields; a channel has no method,
  // path or handler, so it is described by exactly those.
  const gate: Pick<AnyRouteDef, "mode" | "action" | "enabledWhen"> = {
    mode: def.mode,
    action: "events.subscribe",
    enabledWhen: def.enabledWhen,
  };
  return isRouteEnabled(gate as AnyRouteDef, config);
}

/** The channel families served under this configuration. */
export function enabledChannels(config: ResolvedJobsApiConfig): ChannelDef[] {
  return CHANNELS.filter((def) => isChannelEnabled(def, config));
}

/** A channel a client named, parsed and checked. */
export interface ParsedChannel {
  /** The canonical name: segments as given, the job id re-encoded. */
  key: string;
  /** Its family. */
  def: ChannelDef;
  /** What `authorize` is told about it. */
  target: AuthorizeTarget & {
    /** The canonical channel name. */
    channel: string;
  };
}

/** Why a channel was refused. */
export interface ChannelRejection {
  /** Machine code. */
  code: JobsApiWsErrorCode;
  /** The HTTP-equivalent status. */
  status: number;
  /** Human detail. */
  detail: string;
}

/** Queue events that name several jobs in `payload.ids`, each reaching that job's channel. */
export const MULTI_JOB_EVENTS: ReadonlySet<string> = new Set([
  "stalled",
  "retried",
  "cleaned",
]);

/** Every job a queue event is about: its `id`, or each of `payload.ids` for a multi-job event. */
export function jobIdsOf(event: DriverEvent): string[] {
  if (event.kind !== "queue") {
    return [];
  }
  if (MULTI_JOB_EVENTS.has(event.type)) {
    const ids = (event.payload as { ids?: unknown }).ids;
    return Array.isArray(ids)
      ? [...new Set(ids.filter((id): id is string => typeof id === "string"))]
      : [];
  }
  return event.id === undefined ? [] : [event.id];
}

/** Job-id escaping for channel names: defined in the browser-safe contract, which a client needs to name a job channel. */
export { decodeJobId, encodeJobId } from "../contract/constants";

/** The canonical name of a job channel. Total: any job id has one. */
export function jobChannel(queue: string, jobId: string): string {
  return `queue/${queue}/job/${encodeJobId(jobId)}`;
}

/** The canonical name of one queue's worker channel. */
export function queueWorkersChannel(queue: string): string {
  return `queue/${queue}/workers`;
}

/** A rejection for a malformed name. */
function invalid(detail: string): {
  ok: false;
  rejection: ChannelRejection;
} {
  return {
    ok: false,
    rejection: { code: "INVALID_CHANNEL", status: 400, detail },
  };
}

/** Validates a queue name or runner id segment. */
function segment(value: string, what: string): string | undefined {
  try {
    return assertSegment(value, what);
  } catch (error) {
    if (error instanceof ConfigError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Parses a channel name and checks it against the configuration:
 *
 * - a malformed name, or a bad queue/runner segment → `INVALID_CHANNEL` (400);
 * - a family this mode or `actions` does not serve → `CHANNEL_NOT_AVAILABLE` (404);
 * - a queue outside a configured `queues` list → `QUEUE_NOT_FOUND` (404);
 * - a runner outside a configured list of runners → `RUNNER_NOT_FOUND` (404).
 *
 * Otherwise any valid segment is accepted: a subscription does not need the
 * queue or runner to exist yet.
 *
 * A refusal of a name that parsed (every code but `INVALID_CHANNEL`) carries
 * its canonical `key`, beside the rejection rather than in it: a `subscribe`
 * ack's rejections do not include one.
 */
export function parseChannel(
  raw: string,
  config: ResolvedJobsApiConfig,
):
  | { ok: true; channel: ParsedChannel }
  | {
      ok: false;
      rejection: ChannelRejection;
      /** The canonical name, when the channel parsed and was refused after. */
      key?: string;
    } {
  const parts = raw.split("/");
  let kind: ChannelKind;
  let queue: string | undefined;
  let jobId: string | undefined;
  let runner: string | undefined;

  if (
    parts.length === 1 &&
    ["all", "queues", "workers", "runners"].includes(parts[0]!)
  ) {
    kind = parts[0] as ChannelKind;
  } else if (
    parts[0] === "queue" &&
    (parts.length === 2 || parts.length === 3 || parts.length === 4)
  ) {
    queue = segment(parts[1]!, "queue name");
    if (queue === undefined) {
      return invalid(`"${raw}" names an invalid queue`);
    }
    kind = "queue";
    if (parts.length === 3) {
      if (parts[2] !== "workers") {
        return invalid(`"${raw}" is not a channel`);
      }
      kind = "queueWorkers";
    }
    if (parts.length === 4) {
      if (parts[2] !== "job" || parts[3] === "") {
        return invalid(`"${raw}" is not a channel`);
      }
      try {
        jobId = decodeJobId(parts[3]!);
      } catch {
        return invalid(`"${raw}" has a malformed job id encoding`);
      }
      kind = "job";
    }
  } else if (parts[0] === "runner" && parts.length === 2) {
    runner = segment(parts[1]!, "runner id");
    if (runner === undefined) {
      return invalid(`"${raw}" names an invalid runner`);
    }
    kind = "runner";
  } else {
    return invalid(`"${raw}" is not a channel`);
  }

  const key =
    kind === "job"
      ? jobChannel(queue!, jobId!)
      : kind === "queue"
        ? `queue/${queue}`
        : kind === "queueWorkers"
          ? queueWorkersChannel(queue!)
          : kind === "runner"
            ? `runner/${runner}`
            : kind;

  const def = BY_KIND.get(kind)!;
  if (!isChannelEnabled(def, config)) {
    return {
      ok: false,
      key,
      rejection: {
        code: "CHANNEL_NOT_AVAILABLE",
        status: 404,
        detail: `Channel "${raw}" is not available in mode "${config.mode}"`,
      },
    };
  }
  if (
    queue !== undefined &&
    config.queues !== "all" &&
    !config.queues.has(queue)
  ) {
    return {
      ok: false,
      key,
      rejection: {
        code: "QUEUE_NOT_FOUND",
        status: 404,
        detail: `Queue "${queue}" was not found`,
      },
    };
  }
  if (
    runner !== undefined &&
    Array.isArray(config.runners) &&
    !config.runners.some((candidate) => candidate.id === runner)
  ) {
    return {
      ok: false,
      key,
      rejection: {
        code: "RUNNER_NOT_FOUND",
        status: 404,
        detail: `Runner "${runner}" was not found`,
      },
    };
  }

  return {
    ok: true,
    channel: {
      key,
      def,
      target: {
        channel: key,
        ...(queue === undefined ? {} : { queue }),
        ...(jobId === undefined ? {} : { jobId }),
        ...(runner === undefined ? {} : { runner }),
      },
    },
  };
}

/** Channels that carry every queue's or runner's events, rather than one named target's. */
export const BROAD_CHANNELS: ReadonlySet<string> = new Set([
  "all",
  "queues",
  "workers",
  "runners",
]);

/**
 * Every channel name an event reaches — at most four, plus one per id of a
 * `stalled`, `retried` or `cleaned` event — so dispatch costs what the
 * matching sessions cost, not what every session costs. Total: it never
 * throws, whatever the job ids hold.
 */
export function channelKeysFor(event: DriverEvent): string[] {
  if (event.kind === "runner") {
    return ["all", "runners", `runner/${event.target}`];
  }
  if (event.kind === "worker") {
    // Not on `all`: that channel is every queue's and runner's *work*, and a
    // dashboard following it should not have to filter out control traffic it
    // never asked for. The two worker channels are opt-in.
    return ["workers", queueWorkersChannel(event.target)];
  }
  const keys = ["all", "queues", `queue/${event.target}`];
  for (const id of jobIdsOf(event)) {
    keys.push(jobChannel(event.target, id));
  }
  return keys;
}
