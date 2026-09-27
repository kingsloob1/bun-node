/**
 * The scaler recipes, held to the API they configure: every URL, figure and
 * metric the package README's "Recipes: summoning workers and scaling on
 * demand" section points a platform's scaler at, read **from the README**
 * and asked of a real API, so the two cannot drift apart unnoticed.
 *
 * ```bash
 * bun 11-management-api/scaler-recipes.ts
 * ```
 *
 * No cluster runs here: KEDA, ACA, Cloud Run and GKE are configuration this
 * cannot execute. What it can hold to account is everything in those
 * recipes that is bun-jobs' side of the contract:
 *
 * - **The scaler's own API**, built from the README's own code block
 *   (`basePath`, `actions`): the routes it registers against the README's
 *   "Checked:" sentence, a missing or wrong token 403 and a mutation 404.
 * - **Every `metrics-api` trigger** — both KEDA YAMLs, the one on the
 *   Prometheus exposition and the ACA command — requested as KEDA does (its
 *   URL's path and query, a bearer token, no `Accept` header), with its
 *   `valueLocation` read out of the answer and compared with the queue's own
 *   `getDemand()`.
 * - **Every Prometheus scrape** (`prometheus.yml`, GKE's `PodMonitoring`):
 *   its path and `params`, and each metric the recipes query, alert on or
 *   name for GKE present as a gauge carrying the labels they select on.
 * - **The claims in between**: no `Accept` is JSON, a Prometheus 3 scrape's
 *   `Accept` is the exposition, an unknown queue is 404, a paused queue
 *   reads 0.
 *
 * A recipe edited so it no longer matches the API fails here, and so does
 * an API change the recipes were not updated for.
 */
import type { JobsApiAction } from "@kingsleyweb/bun-jobs";
import { readFileSync } from "node:fs";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
} from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("The scaler recipes, held to the API");

/* ------------------------------------------------------------------ */
step("Read the recipes out of the package README");

const README = readFileSync(
  new URL("../../../packages/bun-jobs/README.md", import.meta.url),
  "utf8",
);
/** The section, from its heading to the next top-level one. */
const section = (() => {
  const start = README.indexOf(
    "## Recipes: summoning workers and scaling on demand",
  );
  if (start < 0) {
    throw new Error("the README has no recipes section");
  }
  const end = README.indexOf("\n## ", start + 3);
  return README.slice(start, end < 0 ? undefined : end);
})();
/** Every fenced block in the section, with its language and the heading above it. */
const blocks = [...section.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map(
  (match) => ({
    lang: match[1]!,
    body: match[2]!,
    heading:
      [...section.slice(0, match.index).matchAll(/^#{3,4} (.+)$/gm)]
        .at(-1)?.[1]
        ?.replaceAll("`", "") ?? "the recipes",
  }),
);

/** The scaler API block: the one building `createJobsApi` at `/scaler`. */
const apiBlock = blocks.find(
  (block) => block.lang === "ts" && block.body.includes("createJobsApi("),
)?.body;
if (!apiBlock) {
  throw new Error("the recipes have no scaler API block");
}
const basePath = /basePath:\s*"([^"]+)"/.exec(apiBlock)?.[1];
const actions = [
  ...(/actions:\s*\[([^\]]*)\]/.exec(apiBlock)?.[1] ?? "").matchAll(
    /"([^"]+)"/g,
  ),
].map((match) => match[1] as JobsApiAction);
show("the scaler API, as the README builds it", {
  basePath,
  actions,
  readOnly: /readOnly:\s*true/.test(apiBlock),
});

/**
 * The routes the README says that API registers: its "Checked:" sentence,
 * `/queues`, `/demand`, and per queue `/queues/:queue` with its sub-paths.
 */
const documentedRoutes = (() => {
  const sentence =
    // Up to the list's own full stop: whatever sentence follows it is not
    // part of the list.
    /registers (\w+) routes, all `GET`: ([\s\S]*?)\.(?=\s)/.exec(section);
  if (!sentence) {
    throw new Error("the README's 'registers … routes' sentence is gone");
  }
  const paths: string[] = [];
  let perQueue: string | undefined;
  for (const [, token] of sentence[2]!.matchAll(/`([^`]+)`/g)) {
    if (token!.startsWith("/")) {
      paths.push(token!);
      if (token!.includes(":queue")) {
        perQueue = token!;
      }
    } else if (perQueue) {
      paths.push(`${perQueue}/${token}`);
    }
  }
  const words: Record<string, number> = { six: 6, seven: 7, eight: 8, nine: 9 };
  return { count: words[sentence[1]!] ?? Number(sentence[1]), paths };
})();

/** One `metrics-api` trigger, from YAML or from the ACA command. */
interface MetricsApiTrigger {
  /** Where the recipe comes from, for the check's name. */
  from: string;
  /** The URL KEDA polls. */
  url: string;
  /** `json` (the default) or `prometheus`. */
  format: string;
  /** Where the figure is read from the answer. */
  valueLocation: string;
  /** How KEDA authenticates. */
  authMode: string | undefined;
}
/** A `key: value` field of a YAML block, quotes dropped. */
function yamlField(text: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(text);
  return match?.[1]?.trim().replace(/^'(.*)'$|^"(.*)"$/, "$1$2");
}
const triggers: MetricsApiTrigger[] = [];
for (const block of blocks) {
  if (block.lang === "yaml") {
    // One trigger per `- type: metrics-api` item, up to the next item.
    for (const part of block.body.split(/-\s+type:\s*/).slice(1)) {
      if (!part.startsWith("metrics-api")) {
        continue;
      }
      triggers.push({
        from: block.heading,
        url: yamlField(part, "url")!,
        format: yamlField(part, "format") ?? "json",
        valueLocation: yamlField(part, "valueLocation")!,
        authMode: yamlField(part, "authMode"),
      });
    }
  } else if (block.lang === "bash" && block.body.includes("metrics-api")) {
    const meta = Object.fromEntries(
      [...block.body.matchAll(/"(\w+)=([^"]+)"/g)].map((match) => [
        match[1]!,
        match[2]!,
      ]),
    );
    triggers.push({
      from: block.heading,
      url: meta.url!,
      format: meta.format ?? "json",
      valueLocation: meta.valueLocation!,
      authMode: meta.authMode,
    });
  }
}
/** Every scrape a Prometheus-side recipe configures: path and params. */
const scrapes = blocks
  .filter((block) => block.lang === "yaml" && /params:\s*\n/.test(block.body))
  .map((block) => ({
    from: block.heading,
    path:
      yamlField(block.body, "metrics_path") ?? yamlField(block.body, "path")!,
    format: /format:\s*\[(\w+)\]/.exec(block.body)?.[1],
  }));
/** Every metric the recipes query, alert on or name, with its selector. */
const referenced = [...section.matchAll(/(bunjobs_\w+)(?:\{([^}]*)\})?/g)].map(
  (match) => ({
    family: match[1]!,
    labels: Object.fromEntries(
      [...(match[2] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((label) => [
        label[1]!,
        label[2]!,
      ]),
    ),
  }),
);
show("found", {
  metricsApiTriggers: triggers.map((trigger) => trigger.from),
  scrapes,
  metrics: [...new Set(referenced.map((metric) => metric.family))],
});
checkEqual(
  "the README still holds what this checks: four metrics-api triggers, two scrapes",
  [triggers.length, scrapes.length],
  [4, 2],
);

/* ------------------------------------------------------------------ */
step("The scaler's own API, built as the README builds it");

const namespace = exampleNamespace("scaler-recipes");
const jobs = new BunJobs({ namespace, driver: exampleDriver() });
const emails = jobs.queue("emails");
for (let n = 0; n < 7; n++) {
  await emails.add("send", { n });
}
/** The token the recipes' `authMode: bearer` sends. */
const TOKEN = "scaler-token";
const scaler = createJobsApi({
  jobs,
  basePath: basePath!,
  readOnly: /readOnly:\s*true/.test(apiBlock),
  actions,
  authorize: (req) => req.getHeader("authorization") === `Bearer ${TOKEN}`,
});
const adapter = new BunHttpAdapter();
adapter.use(scaler.basePath, scaler.router);

// `counts/added` is served only where the backend keeps per-state add
// counts (`features.addedByState`), so the route list depends on it.
const probe = createJobsApi({
  jobs,
  basePath: "/probe",
  actions: [...JOBS_API_ACTIONS],
  // Only its /meta is read; it needs no socket.
  websocket: false,
  authorize: () => true,
});
const probeAdapter = new BunHttpAdapter();
probeAdapter.use(probe.basePath, probe.router);
const addedByState = (
  (await (await probeAdapter.fetch("/probe/meta")).json()) as {
    features: { addedByState: boolean };
  }
).features.addedByState;
await probe.close();

const registered = scaler.routes
  .map((route) => `${route.method} ${route.path}`)
  .sort();
checkEqual(
  `the routes it registers are the README's${addedByState ? "" : " (less counts/added, which this backend does not serve)"}, all GET`,
  registered,
  documentedRoutes.paths
    .filter((path) => addedByState || !path.endsWith("/counts/added"))
    .map((path) => `GET ${basePath}${path}`)
    .sort(),
);
checkEqual(
  "as many as the README counts, where this backend serves counts/added",
  addedByState ? registered.length : documentedRoutes.count,
  documentedRoutes.count,
);
const withReadOnly = createJobsApi({
  jobs,
  basePath: "/read-only",
  readOnly: true,
  actions: ["queues.read"],
  authorize: () => true,
});
checkEqual(
  'with actions ["queues.read"] alone, /queues and /demand go too',
  withReadOnly.routes
    .map((route) => route.path)
    .filter((path) =>
      ["/read-only/queues", "/read-only/demand"].includes(path),
    ),
  [],
);
await withReadOnly.close();

/** A GET as a scaler sends it: a bearer token, and no `Accept` unless given. */
async function scrape(
  path: string,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
) {
  const response = await adapter.fetch(path, { headers });
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
}
checkEqual(
  "a missing or wrong token is 403, and a mutation is 404",
  [
    (await scrape(`${basePath}/queues/emails/demand`, {})).status,
    (
      await scrape(`${basePath}/queues/emails/demand`, {
        authorization: "Bearer wrong",
      })
    ).status,
    (
      await adapter.fetch(`${basePath}/queues/emails/pause`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).status,
  ],
  [403, 403, 404],
);

/* ------------------------------------------------------------------ */
step("Every metrics-api trigger, asked as KEDA asks it");

/**
 * The first sample matching a PromQL-style selector, by equality on every
 * label it names, as KEDA's `metrics-api` reads the exposition.
 */
function promValue(text: string, selector: string): number | undefined {
  const family = /^(\w+)/.exec(selector)?.[1];
  const wanted = [...selector.matchAll(/(\w+)="([^"]*)"/g)];
  for (const line of text.split("\n")) {
    const sample = /^(\w+)\{([^}]*)\} (\S+)$/.exec(line);
    if (!sample || sample[1] !== family) {
      continue;
    }
    const labels = Object.fromEntries(
      [...sample[2]!.matchAll(/(\w+)="([^"]*)"/g)].map((label) => [
        label[1],
        label[2],
      ]),
    );
    if (wanted.every(([, key, value]) => labels[key!] === value)) {
      return Number(sample[3]);
    }
  }
  return undefined;
}

const figures = await emails.getDemand();
for (const trigger of triggers) {
  const url = new URL(trigger.url);
  const answer = await scrape(`${url.pathname}${url.search}`);
  const value =
    trigger.format === "prometheus"
      ? promValue(answer.text, trigger.valueLocation)
      : (JSON.parse(answer.text) as Record<string, unknown>)[
          trigger.valueLocation
        ];
  // The figure the valueLocation names: `demand`, `outstanding`, or the
  // family a Prometheus selector names.
  const field = /outstanding/.test(trigger.valueLocation)
    ? "outstanding"
    : "demand";
  checkEqual(
    `${trigger.from}: ${url.pathname}${url.search} answers ${trigger.format}, and ${trigger.valueLocation} reads the queue's ${field}`,
    [
      answer.status,
      trigger.authMode,
      trigger.format === "prometheus"
        ? answer.type.startsWith("text/plain")
        : answer.type.startsWith("application/json"),
      value,
    ],
    [200, "bearer", true, figures[field]],
  );
}

/* ------------------------------------------------------------------ */
step("Every Prometheus scrape, and every metric the recipes name");

for (const target of scrapes) {
  const answer = await scrape(`${target.path}?format=${target.format}`);
  const gauges = new Set(
    [...answer.text.matchAll(/^# TYPE (\w+) gauge$/gm)].map(
      (match) => match[1],
    ),
  );
  const labelsOf = new Set(
    [...answer.text.matchAll(/^\w+\{([^}]*)\}/gm)].flatMap((match) =>
      [...match[1]!.matchAll(/(\w+)="/g)].map((label) => label[1]),
    ),
  );
  checkEqual(
    `${target.from}: ${target.path} with format=${target.format} is the exposition, carrying every metric the recipes name as a gauge, and every label they select on`,
    [
      answer.status,
      answer.type,
      referenced
        .filter((metric) => !gauges.has(metric.family))
        .map((metric) => metric.family),
      [
        ...new Set(referenced.flatMap((metric) => Object.keys(metric.labels))),
      ].filter((label) => !labelsOf.has(label)),
    ],
    [200, "text/plain; version=0.0.4; charset=utf-8", [], []],
  );
}

/* ------------------------------------------------------------------ */
step("The claims between the recipes");

checkEqual(
  "no Accept header gets JSON, as KEDA's metrics-api sends none",
  (await scrape(`${basePath}/queues/emails/demand`)).type.startsWith(
    "application/json",
  ),
  true,
);
const prometheus3 = await scrape(`${basePath}/demand`, {
  authorization: `Bearer ${TOKEN}`,
  // The Accept a Prometheus 3 scrape sends.
  accept:
    "application/openmetrics-text;version=1.0.0;escaping=allow-utf-8;q=0.6,application/openmetrics-text;version=0.0.1;q=0.5,text/plain;version=1.0.0;escaping=allow-utf-8;q=0.4,text/plain;version=0.0.4;q=0.3,*/*;q=0.2",
});
checkEqual(
  "a Prometheus 3 scrape's Accept selects the exposition",
  prometheus3.type,
  "text/plain; version=0.0.4; charset=utf-8",
);
checkEqual(
  "the per-queue route is 404 for an unknown queue, so a typo fails loudly",
  (await scrape(`${basePath}/queues/emial/demand`)).status,
  404,
);
await emails.pause();
const paused = JSON.parse(
  (await scrape(`${basePath}/queues/emails/demand`)).text,
) as { demand: number; outstanding: number };
check(
  "a paused queue reads 0 on both demand and outstanding",
  paused.demand === 0 && paused.outstanding === 0,
  paused,
);

/* ------------------------------------------------------------------ */
step("Clean up");

await scaler.close();
await jobs.purge();
await jobs.close();
summary();
