import type { QueueDemandDto } from "./contract/types";

/**
 * A small renderer for the Prometheus text exposition format, version 0.0.4
 * (<https://prometheus.io/docs/instrumenting/exposition_formats/>), and the
 * one exposition this package serves with it: the depth endpoint's demand
 * figures. A metric *source* for a scaler (KEDA's `metrics-api` with `format:
 * prometheus`, GKE's HPA through Managed Prometheus, CREMA), not a general
 * metrics exporter. No dependency: the format is lines of text.
 *
 * The rules it follows, each from the format's specification:
 *
 * - a family's lines form one group, `# HELP` and `# TYPE` first, and a
 *   family appears once;
 * - metric names match `[a-zA-Z_:][a-zA-Z0-9_:]*` and label names
 *   `[a-zA-Z_][a-zA-Z0-9_]*`, never beginning `__` (reserved) — anything else
 *   is refused here rather than emitted for a scraper to reject;
 * - in `# HELP` text, `\` and a line feed are escaped as `\\` and `\n`; in a
 *   label value, `\`, `"` and a line feed as `\\`, `\"` and `\n`;
 * - a value is a Go `ParseFloat` number, or `NaN`, `+Inf`, `-Inf`;
 * - lines end with a line feed, the last one included.
 */

/** The `Content-Type` of the text exposition this module renders. */
export const PROMETHEUS_CONTENT_TYPE =
  "text/plain; version=0.0.4; charset=utf-8";

/**
 * The media type content negotiation offers for it: `text/plain` with the
 * format's version, so an `Accept: text/plain` and a Prometheus server's
 * `text/plain;version=0.0.4` both select it.
 */
export const PROMETHEUS_MEDIA_TYPE = "text/plain; version=0.0.4";

/** One sample of a metric family. */
export interface PrometheusSample {
  /** Label names to values, rendered in this order. Values are escaped here. */
  labels: Readonly<Record<string, string>>;
  /** The value. `NaN` and the infinities render as the format spells them. */
  value: number;
}

/** A metric family: a name, its help and type, and its samples. */
export interface PrometheusFamily {
  /** The metric name, `[a-zA-Z_:][a-zA-Z0-9_:]*`. */
  name: string;
  /** The `# HELP` docstring. Escaped here. */
  help: string;
  /** The `# TYPE`. Only the ones this package emits. */
  type: "gauge" | "counter" | "untyped";
  /** The samples, each on its own line under the family's `HELP`/`TYPE`. */
  samples: readonly PrometheusSample[];
}

/** A legal metric name. */
const METRIC_NAME = /^[a-z_:][\w:]*$/i;

/** A legal label name; one beginning `__` is reserved and refused separately. */
const LABEL_NAME = /^[a-z_]\w*$/i;

/** `# HELP` text: `\` → `\\`, line feed → `\n`. */
export function escapeHelp(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** A label value: `\` → `\\`, `"` → `\"`, line feed → `\n`. */
export function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/** A sample value, as Go's `ParseFloat` reads it. */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (value === Number.POSITIVE_INFINITY) {
    return "+Inf";
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return "-Inf";
  }
  // `String` gives `1e+21` for large numbers, which ParseFloat accepts.
  return String(value);
}

/** Refuses a name the format does not allow, naming it. */
function assertName(name: string, pattern: RegExp, kind: string): void {
  if (!pattern.test(name) || (kind === "label" && name.startsWith("__"))) {
    throw new TypeError(
      `Not a valid Prometheus ${kind} name: ${JSON.stringify(name)}`,
    );
  }
}

/**
 * Renders families as the text exposition: each family's `# HELP` and `# TYPE`
 * lines, then its samples, and a line feed after every line. A family with no
 * samples still gets its two comment lines, which the format allows. Refuses
 * (with a `TypeError`) an illegal metric or label name, and a family named
 * twice.
 */
export function renderPrometheus(
  families: readonly PrometheusFamily[],
): string {
  const seen = new Set<string>();
  let out = "";
  for (const family of families) {
    assertName(family.name, METRIC_NAME, "metric");
    if (seen.has(family.name)) {
      throw new TypeError(`Prometheus family ${family.name} appears twice`);
    }
    seen.add(family.name);
    out += `# HELP ${family.name} ${escapeHelp(family.help)}\n`;
    out += `# TYPE ${family.name} ${family.type}\n`;
    for (const sample of family.samples) {
      const labels = Object.entries(sample.labels).map(([name, value]) => {
        assertName(name, LABEL_NAME, "label");
        return `${name}="${escapeLabelValue(value)}"`;
      });
      const selector = labels.length > 0 ? `{${labels.join(",")}}` : "";
      out += `${family.name}${selector} ${formatValue(sample.value)}\n`;
    }
  }
  return out;
}

/**
 * The demand families, in the order they are rendered: the metric name, its
 * help, and how to read the figure from a {@link QueueDemandDto}. Names are
 * `bunjobs_queue_*`, the prefix an OpenTelemetry Prometheus exporter gives the
 * package's `bunjobs.` instruments.
 */
export const DEMAND_METRICS: readonly {
  /** The metric name. */
  name: string;
  /** Its `# HELP`. */
  help: string;
  /** The figure it reports. */
  read: (demand: QueueDemandDto) => number;
}[] = [
  {
    name: "bunjobs_queue_demand",
    help: "Jobs a worker could claim now: waiting + due + stalled. 0 while the queue is paused.",
    read: (d) => d.demand,
  },
  {
    name: "bunjobs_queue_outstanding",
    help: "Every unfinished job, each once: demand plus the active jobs a live worker holds. 0 while the queue is paused.",
    read: (d) => d.outstanding,
  },
  {
    name: "bunjobs_queue_waiting",
    help: "Jobs in waiting.",
    read: (d) => d.waiting,
  },
  {
    name: "bunjobs_queue_due",
    help: "Delayed jobs and pending retries whose time has come, not yet promoted.",
    read: (d) => d.dueNow,
  },
  {
    name: "bunjobs_queue_stalled",
    help: "Active jobs whose worker died holding them: what a stalled sweep would recover now.",
    read: (d) => d.stalled,
  },
  {
    name: "bunjobs_queue_active",
    help: "Jobs in active, stalled ones included.",
    read: (d) => d.active,
  },
  {
    name: "bunjobs_queue_workers",
    help: "Live workers on the queue, from their heartbeat records.",
    read: (d) => d.workers,
  },
  {
    name: "bunjobs_queue_paused",
    help: "1 when claiming from the queue is paused, else 0.",
    read: (d) => (d.paused ? 1 : 0),
  },
  {
    name: "bunjobs_queue_demand_capped",
    help: "1 when a figure reached the count cap, so the figures are lower bounds, else 0.",
    read: (d) => (d.capped ? 1 : 0),
  },
  {
    name: "bunjobs_queue_demand_exact",
    help: "1 when the figures are counted directly, 0 when they come from the approximate fallback of a driver without countDemand: right as a trigger, approximate as a count.",
    read: (d) => (d.exact ? 1 : 0),
  },
];

/**
 * The namespace-level family: one sample per scrape, labelled `ns` alone.
 * A queue left out of a scrape is an absent series, which many scalers read
 * as 0 — scale to zero over a backlog — so the cut is said in the scrape.
 */
export const DEMAND_TRUNCATED_METRIC = {
  /** The metric name. */
  name: "bunjobs_demand_truncated",
  /** Its `# HELP`. */
  help: "1 when more queues were visible than limits.maxQueues, so some have no series in this scrape, else 0. Always 0 on a one-queue read.",
} as const;

/**
 * The demand of `queues` in namespace `ns` as one scrape: every family of
 * {@link DEMAND_METRICS}, one sample per queue, labelled `ns` and `queue`,
 * then {@link DEMAND_TRUNCATED_METRIC}, one sample labelled `ns`. Every
 * scrape has the same families, whichever route served it.
 */
export function renderDemandExposition(
  ns: string,
  queues: readonly QueueDemandDto[],
  options: {
    /** Whether some visible queues were left out of `queues`. Defaults to `false`. */
    truncated?: boolean;
  } = {},
): string {
  return renderPrometheus([
    ...DEMAND_METRICS.map((metric) => ({
      name: metric.name,
      help: metric.help,
      type: "gauge" as const,
      samples: queues.map((demand) => ({
        labels: { ns, queue: demand.queue },
        value: metric.read(demand),
      })),
    })),
    {
      name: DEMAND_TRUNCATED_METRIC.name,
      help: DEMAND_TRUNCATED_METRIC.help,
      type: "gauge",
      samples: [{ labels: { ns }, value: options.truncated ? 1 : 0 }],
    },
  ]);
}
