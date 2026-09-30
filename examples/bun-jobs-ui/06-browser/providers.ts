/**
 * The **Providers** screen (`/providers`) and the Summon panel's summoner
 * block, in a real browser, against a real `createJobsApi` and real compute
 * providers configured in this process.
 *
 * ```bash
 * bun 06-browser/providers.ts
 * EXAMPLE_DRIVER=postgres EXAMPLE_POSTGRES_URL=postgres://… bun 06-browser/providers.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/providers.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/providers.ts   # skip on purpose
 * ```
 *
 * Like the other browser examples it drives headless Chrome through
 * `Bun.WebView` and **skips** (prints `skipped:` and exits 0) when there is
 * no `Bun.WebView`, no Chrome, or Chrome will not start.
 *
 * The provider is "Stratus", made up, written with `defineComputeProvider`
 * and talking over HTTP to a fake of its platform, the conformance kit's
 * `fakePlatform()`. Six instances of it are configured here, so their ids are
 * `bun-jobs-provider-stratus@1.0.0~1` to `~6`, and three queues summon with
 * three of them. Nothing is ever summoned: every trigger is off. Summoning
 * needs a backend another process can reach, so on the memory driver this
 * runs on a temporary SQLite file; `EXAMPLE_DRIVER` picks any other. For the
 * same states against real local workers, see the playground's provider,
 * https://github.com/kingsloob1/bun-node/blob/develop/playground/compute/provider.ts.
 *
 * What it shows:
 *
 * - **The screen and its nav entry are opt-in.** Both appear where the API
 *   serves the provider routes (`features.providers`) and the caller has the
 *   opt-in `providers.read`, here from `actions: [...JOBS_API_ACTIONS]`. On an
 *   API with the default actions there is no entry, `/providers` is "Page not
 *   found", and the page never asks for the list.
 * - **One card per configured provider** (`provider-<id>`): a readiness badge
 *   (`provider-readiness`: Ready, Pending or Failed, what it means in its
 *   title), the id, the package and version, and the secret-free facts
 *   `describe()` gives, which a provider whose config is not known yet has
 *   none of.
 * - **Test connection** (aria-label "Test connection: Stratus") runs the
 *   provider's preflight and says what it found in `provider-test-result`
 *   (`data-ok`), one `provider-check-<id>` per check: every check passing;
 *   a `warn` check, which is still `data-ok="true"` ("Connected, with 1
 *   warning."); a `ProviderError` of kind `auth`, read as the credentials'
 *   problem with the platform's own code; and a config its schema rejected,
 *   read as a configuration problem naming the path. It is offered only to a
 *   caller with `providers.validate` on an API that is not `readOnly`.
 * - **The config schema is read only when asked for.** "Config schema" opens
 *   `provider-schema`; until it is pressed the page has made no
 *   `GET /providers/:id/schema` request at all.
 * - **The Summon panel names its summoner's readiness** (`summon-readiness`)
 *   and offers the same Test connection when the summoner's provider has a
 *   preflight. "Ready" there is about the config, not the credentials: a
 *   summoner the platform refuses reads Ready and fails its test.
 * - **Pending, then Ready, without a reload.** A provider whose API token
 *   comes from a secret store that has not answered yet is still validating
 *   its config: its card reads Pending, and turns Ready on the list's next
 *   refetch (every 10 s) once the store answers. A queue summoning with such
 *   a provider reads Pending on its Summon panel, and Ready on the panel's
 *   next 5 s refetch: reading the summon status adopts a provider that has
 *   become ready, so this happens with **no summon check run** (the last
 *   outcome still reads "None yet").
 * - **Wait on conditions, never on time.** Every page-side helper polls the
 *   DOM until what it wants is there, with a deadline, and the one timing
 *   claim (the list's refetch cadence) is a lower bound.
 */
import type {
  ProviderListDto,
  ProviderValidationDto,
} from "@kingsleyweb/bun-jobs";
import type {
  ProviderCallContext,
  ProviderCheck,
  SummonCapabilities,
} from "@kingsleyweb/bun-jobs/provider";
import {
  BunHttpAdapter,
  createDeferred,
  noopLogger,
} from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
} from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import {
  COMPUTE_PROVIDER_API,
  defineComputeProvider,
  ProviderError,
  toStandardSchema,
} from "@kingsleyweb/bun-jobs/provider";
import { fakePlatform } from "@kingsleyweb/bun-jobs/provider/testing";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { chromeOrSkip, openView, waitForSelector } from "../shared/browser";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { poll } from "./helpers/page";

// Decide whether to skip before printing anything: run-all.ts recognises a
// skip by the output *starting* with `skipped:`.
const chromePath = chromeOrSkip();

/** The CSRF header every API here asks for on a mutation; the UI reads its name from `api.info`. */
const CSRF = "x-bun-jobs-csrf";
/** Marks a request this script makes itself, so the recorder can tell it from the page's. */
const DIRECT = "x-example-direct";

/* --- the platform: a fake Stratus control API ----------------------- */

/** What the fake platform knows of each token: its account and how much of its vCPU quota is used. */
const ACCOUNTS: Record<string, { account: string; quotaUsed: number }> = {
  st_live_4Rk9Wm2Qx7Lp: { account: "acme", quotaUsed: 20 },
  st_live_8Nd3Vb6Hz1Tc: { account: "acme-batch", quotaUsed: 80 },
};
const [TOKEN, BUSY_TOKEN] = Object.keys(ACCOUNTS) as [string, string];
/** A token the platform has revoked: it answers 403 with this code. */
const REVOKED_TOKEN = "st_live_0Zz0Zz0Zz0Zz";
/** The platform's own code for a refused token. */
const DENIED = "AccessDeniedException";
/** From this share of its quota on, the preflight warns. */
const QUOTA_WARN = 75;

/** How many preflights reached the fake platform. */
let whoami = 0;

const platform = await fakePlatform({
  "GET /v1/whoami": (request) => {
    whoami += 1;
    const token = (request.headers.get("authorization") ?? "").replace(
      /^Bearer /,
      "",
    );
    const known = ACCOUNTS[token];
    return known === undefined
      ? Response.json(
          { error: { code: DENIED, message: "token revoked" } },
          { status: 403 },
        )
      : Response.json(known);
  },
});

/* --- the provider: Stratus, as its package would export it --------- */

/** The regions Stratus has. */
const REGIONS = ["eu-west-1", "us-east-1"];

/** What a user configures Stratus with. */
interface StratusInput {
  /** The control API's base URL: the fake's, here. */
  url: string;
  /** The region, one of {@link REGIONS}. */
  region: string;
  /** The API token, or a function reading it from a secret store. */
  apiToken: string | (() => Promise<string>);
}

/** The validated config: the token, resolved. */
interface StratusConfig {
  /** The control API's base URL. */
  url: string;
  /** The region. */
  region: string;
  /** The API token: a declared secret. */
  apiToken: string;
}

/**
 * Validates a config and resolves its token. Always a promise, so a bad
 * config does not throw at `provider(config)`: the provider is configured,
 * listed as Pending until this settles, and Failed if it rejects the config.
 */
async function resolveConfig(
  input: unknown,
): Promise<
  { value: StratusConfig } | { issues: { message: string; path: string[] }[] }
> {
  const given = (input ?? {}) as Partial<StratusInput>;
  if (typeof given.region !== "string" || !REGIONS.includes(given.region)) {
    return {
      issues: [
        {
          message: `region must be one of ${REGIONS.join(", ")}`,
          path: ["region"],
        },
      ],
    };
  }
  const apiToken =
    typeof given.apiToken === "function"
      ? await given.apiToken()
      : String(given.apiToken);
  return { value: { url: String(given.url), region: given.region, apiToken } };
}

/**
 * The config schema: the validator above plus a Standard JSON Schema
 * converter, which is what makes the card offer "Config schema".
 */
const base = toStandardSchema<StratusInput, StratusConfig>(resolveConfig);
const standard = {
  ...base["~standard"],
  jsonSchema: {
    input: (options: { target: string }) => ({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: `Stratus (${options.target})`,
      type: "object",
      required: ["url", "region", "apiToken"],
      properties: {
        url: { type: "string", format: "uri" },
        region: { type: "string", enum: REGIONS },
        apiToken: {
          type: "string",
          description: "An API token from the Stratus console",
        },
      },
    }),
    output: () => ({}),
  },
};
const stratusSchema: typeof base = { "~standard": standard };

/** What Stratus declares it can do; a boot budget of its own, so the panel shows the real one once adopted. */
const CAPABILITIES: SummonCapabilities = {
  style: "launch",
  dedupe: { kind: "none" },
  passes: "argv",
  bootBudgetMs: 45_000,
  shutdown: { signal: "SIGTERM", graceMs: 10_000 },
  maxLifetimeMs: null,
  enforcesLifetime: false,
};

const stratus = defineComputeProvider<StratusConfig, StratusInput>({
  name: "bun-jobs-provider-stratus",
  version: "1.0.0",
  kind: "stratus",
  displayName: "Stratus",
  apiVersion: {
    core: COMPUTE_PROVIDER_API.core,
    summon: COMPUTE_PROVIDER_API.summon,
  },
  config: stratusSchema,
  secrets: ["apiToken"],
  describe: (config) => ({ region: config.region, endpoint: config.url }),
  // The preflight: can these credentials reach the platform, and is there
  // room? Starts nothing.
  validate: async (config, ctx: ProviderCallContext) => {
    const response = await ctx.fetch(`${config.url}/v1/whoami`, {
      headers: { authorization: `Bearer ${config.apiToken}` },
      signal: ctx.signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      throw new ProviderError(
        `stratus answered ${response.status}`,
        response.status === 401 || response.status === 403
          ? "auth"
          : "transient",
        {
          status: response.status,
          ...(body.error?.code === undefined
            ? {}
            : { platformCode: body.error.code }),
        },
      );
    }
    const { account, quotaUsed } = (await response.json()) as {
      account: string;
      quotaUsed: number;
    };
    const checks: ProviderCheck[] = [
      { id: "credentials", status: "pass", detail: `account ${account}` },
      { id: "region", status: "pass", detail: config.region },
      quotaUsed >= QUOTA_WARN
        ? {
            id: "quota",
            status: "warn",
            detail: `${quotaUsed}% of the vCPU quota in use`,
          }
        : { id: "quota", status: "pass", detail: `${quotaUsed}% in use` },
    ];
    return checks;
  },
  summon: () => ({
    capabilities: CAPABILITIES,
    summon: async () => ({ status: "started", handles: [] }),
  }),
});

/* --- six instances, and three queues summoning with three of them --- */

/**
 * Two secret stores that have not answered yet. Each holds one instance's
 * config validation open until the example releases it.
 */
const cardStore = createDeferred<string>();
const summonerStore = createDeferred<string>();

/** Configures one instance: `~n` in the order these calls run. */
const configure = (region: string, apiToken: StratusInput["apiToken"]) =>
  stratus({ url: platform.url, region, apiToken });

// The registry holds each instance through a WeakRef: one nothing strong
// references is collected and silently drops out of GET /providers. A
// module-level binding is not enough on its own: one the rest of the module
// never reads again may be collected too (without the last check below, ~2
// and ~4, which nothing uses after their `ready`, were gone from the list on
// postgres and redis, and never on the memory driver's quicker start). So
// every instance is held in this array, and the array is read at the very end.
const held = [
  configure("eu-west-1", TOKEN), // ~1: every check passes
  configure("us-east-1", BUSY_TOKEN), // ~2: the quota check warns
  configure("eu-west-1", REVOKED_TOKEN), // ~3: the platform refuses the token
  configure("eu-nowhere-1", TOKEN), // ~4: the schema rejects the region
  configure("eu-west-1", async () => cardStore.promise), // ~5: Pending until released
  configure("us-east-1", async () => summonerStore.promise), // ~6: Pending, and a summoner
] as const;
const [passing, warning, refused, badRegion, heldCard, heldSummoner] = held;

/** An instance's id: `name@version~n`, the nth instance of it in this process. */
const idOf = (n: number) => `bun-jobs-provider-stratus@1.0.0~${n}`;
const ID = {
  passing: idOf(1),
  warning: idOf(2),
  refused: idOf(3),
  badRegion: idOf(4),
  heldCard: idOf(5),
  heldSummoner: idOf(6),
};

// Every config that can settle, settled: the list then reads each one's
// final readiness, not "pending". The two held ones stay pending.
await Promise.allSettled(
  [passing, warning, refused, badRegion].map((provider) => provider.ready),
);

/** Every trigger off: nothing here summons anything, so no summon check ever runs. */
const NO_TRIGGERS = { onAdd: false, events: false, poll: false } as const;

const jobs = new BunJobs({
  namespace: exampleNamespace("examples-ui-providers"),
  driver: crossProcessDriver(),
  logger: noopLogger,
  summon: {
    reports: { summoner: passing, triggers: NO_TRIGGERS },
    audits: { summoner: refused, triggers: NO_TRIGGERS },
    exports: { summoner: heldSummoner, triggers: NO_TRIGGERS },
  },
});
for (const queue of ["reports", "audits", "exports"]) {
  await jobs.queue(queue).add("render", {});
}

/* --- the server: one host, three API + UI pairs --------------------- */

/** Every one of them allows everything: the gates here are `actions` and `readOnly`. */
const common = {
  jobs,
  authorize: () => true,
  csrf: { header: CSRF },
  logger: noopLogger,
} as const;

/** Every action, the opt-in provider actions included. */
const full = createJobsApi({
  ...common,
  basePath: "/jobs-api",
  actions: [...JOBS_API_ACTIONS],
});
/** The same actions, read-only: `providers.read` stays, `providers.validate` goes. */
const readOnly = createJobsApi({
  ...common,
  basePath: "/ro-api",
  actions: [...JOBS_API_ACTIONS],
  readOnly: true,
});
/** `actions` left out: every action but the opt-ins, so no provider route is served. */
const plain = createJobsApi({ ...common, basePath: "/plain-api" });
const apis = [full, readOnly, plain];

const uis = {
  full: jobsUi({ api: full, basePath: "/jobs", logger: noopLogger }),
  readOnly: jobsUi({ api: readOnly, basePath: "/ro", logger: noopLogger }),
  plain: jobsUi({ api: plain, basePath: "/plain", logger: noopLogger }),
};

/** One request the page made to an API, as the host saw it and as the API answered. */
interface Exchange {
  /** Which API: its base path. */
  api: string;
  /** The method. */
  method: string;
  /** The path under the API's base, without the query, as it arrived (percent-encoded). */
  path: string;
  /** When it arrived, `Date.now()`. */
  at: number;
  /** The status answered. */
  status: number;
}

/** Every request the page (not this script) made to an API, oldest first. */
const exchanges: Exchange[] = [];

const app = new BunHttpAdapter(0, { logger: noopLogger });
// Ahead of every API: records the page's requests as they arrived and, through
// a response transform, the status the API answered.
app.use((req, res, next) => {
  const url = new URL(req.originalUrl, "http://host");
  const api = apis.find(
    (one) =>
      url.pathname === one.basePath ||
      url.pathname.startsWith(`${one.basePath}/`),
  );
  if (api && req.getHeader(DIRECT) !== "1") {
    const at = Date.now();
    res.addResponseTransform({
      transform: (response) => {
        exchanges.push({
          api: api.basePath,
          method: req.method,
          path: url.pathname.slice(api.basePath.length),
          at,
          status: response.status,
        });
        return response;
      },
    });
  }
  next();
});
for (const api of apis) {
  app.use(api.basePath, api.router);
}
for (const ui of Object.values(uis)) {
  app.use(ui.basePath, ui.router);
}
await app.listen(0);
const origin = app.url!.replace(/\/$/, "");

/** A request this script makes itself, with the CSRF header. */
async function call<T = unknown>(
  apiBase: string,
  method: "GET" | "POST",
  path: string,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${origin}${apiBase}${path}`, {
    method,
    headers: {
      [CSRF]: "1",
      [DIRECT]: "1",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  return { status: response.status, json: (await response.json()) as T };
}

/** Every provider's readiness, by id, through the full API. */
async function readinessById(): Promise<Record<string, string>> {
  const { json } = await call<ProviderListDto>(
    full.basePath,
    "GET",
    "/providers",
  );
  return Object.fromEntries(
    json.providers.map((provider) => [provider.id, provider.readiness]),
  );
}

/** The page's requests to the full API whose path is `path`, from index `from` on. */
function pageCalls(path: string, method = "GET", from = 0): Exchange[] {
  return exchanges
    .slice(from)
    .filter(
      (one) =>
        one.api === full.basePath && one.path === path && one.method === method,
    );
}

/** Winds everything down; safe to call more than once. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  // A held validation would otherwise outlive the run.
  cardStore.resolve(TOKEN);
  summonerStore.resolve(TOKEN);
  await app.close();
  for (const api of apis) {
    await api.close();
  }
  await jobs.purge();
  await jobs.close();
  await platform.close();
}

// Build every bundle before the browser asks, so no first page load is the
// in-memory build.
for (const ui of Object.values(uis)) {
  await (await fetch(`${origin}${ui.basePath}`)).arrayBuffer();
}

/* --- the browser: skip, not fail, if Chrome will not start --------- */

/** What the page printed to its console, for a failure's diagnosis. */
const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, shutdown);

title("The Providers screen and the Summon panel's summoner, in Chrome");
show("Chrome", chromePath);
show("serving", `${origin}${uis.full.basePath}/providers`);

/* --- page-side helpers: each resolves once its condition holds ----- */

/** The Providers screen. */
const SCREEN = '[data-testid="providers-screen"]';
/** One provider's card body. */
const card = (id: string) => `[data-testid="provider-${id}"]`;
/** The Summon panel's summoner block. */
const SUMMONER = '[data-testid="summon-summoner"]';
/** The accessible name every Stratus card's Test connection button has. */
const TEST_LABEL = "Test connection: Stratus";

/** What a card, or the summoner block, shows. */
interface CardView {
  /** The readiness badge's text. */
  readiness: string;
  /** The readiness badge's tooltip. */
  hint: string | null;
  /** Each row's label → its value, without the row's hint. */
  rows: Record<string, string>;
  /** Whether a Test connection button is there. */
  testable: boolean;
  /** The config schema toggle's text, or `null` when there is none. */
  schemaToggle: string | null;
}

/**
 * Page-side: `scope`'s readiness badge (`badge`), rows and buttons as a
 * {@link CardView}, once `ready(view)` holds; `null` after `ms`.
 */
function readCard(
  scope: string,
  badge: string,
  ready = "true",
  ms = 15_000,
): string {
  return poll(
    `(() => {
      const root = document.querySelector(${JSON.stringify(scope)});
      const readiness = root?.querySelector(${JSON.stringify(`[data-testid="${badge}"]`)});
      if (!root || !readiness) return null;
      const rows = {};
      for (const row of root.querySelectorAll(".kv-row")) {
        const value = row.querySelector("dd");
        rows[row.querySelector("dt").textContent.trim()] =
          (value.firstChild ? value.firstChild.textContent : "").trim();
      }
      const buttons = [...root.querySelectorAll("button")];
      const toggle = buttons.find((button) => /config schema/i.test(button.textContent));
      const view = {
        readiness: readiness.textContent.trim(),
        hint: readiness.getAttribute("title"),
        rows,
        testable: buttons.some((button) => button.getAttribute("aria-label") === ${JSON.stringify(TEST_LABEL)}),
        schemaToggle: toggle ? toggle.textContent.trim() : null,
      };
      return (${ready}) ? view : null;
    })()`,
    ms,
  );
}

/** What Test connection found, as shown. */
interface TestView {
  /** `data-ok`. */
  ok: string | null;
  /** The one-line summary. */
  summary: string;
  /** Each check: `[id, badge, detail]`. */
  checks: [string, string, string][];
}

/**
 * Page-side: presses `scope`'s Test connection, then resolves with the result
 * it shows, once the test is done; `null` after `ms`.
 */
function testConnection(scope: string, ms = 15_000): string {
  return poll(
    `(() => {
      const root = document.querySelector(${JSON.stringify(scope)});
      if (!root) return null;
      const result = root.querySelector('[data-testid="provider-test-result"]');
      if (!result) {
        if (!window.__pressed?.has(${JSON.stringify(scope)})) {
          const button = [...root.querySelectorAll("button")].find(
            (candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(TEST_LABEL)} && !candidate.disabled);
          if (!button) return null;
          (window.__pressed ??= new Set()).add(${JSON.stringify(scope)});
          button.click();
        }
        return null;
      }
      return {
        ok: result.getAttribute("data-ok"),
        summary: result.querySelector("p").textContent.trim(),
        checks: [...result.querySelectorAll('[data-testid^="provider-check-"]')].map((item) => [
          item.getAttribute("data-testid").slice("provider-check-".length),
          item.querySelector(".badge").textContent.trim(),
          (item.querySelector(".muted")?.textContent ?? "").replace(/^\\s*—\\s*/, "").trim(),
        ]),
      };
    })()`,
    ms,
  );
}

/** Page-side: every CSP violation so far, buffered ones included. */
const COLLECT_VIOLATIONS = `new Promise((resolve) => {
  const observer = new ReportingObserver(() => {}, { types: ["csp-violation"], buffered: true });
  observer.observe();
  setTimeout(() => {
    const seen = observer.takeRecords().map((report) => String(report.body.effectiveDirective));
    observer.disconnect();
    resolve(seen);
  }, 50);
})`;

/** Page-side: the section nav's links, as `[text, href]` pairs, once the nav is drawn. */
const NAV_LINKS = poll(
  `(() => {
    const links = [...document.querySelectorAll('nav[aria-label="Sections"] a')];
    return links.length === 0 ? null : links.map((link) => [link.textContent.trim(), link.getAttribute("href")]);
  })()`,
);

/** Opens `path` under the UI mounted at `uiBase` and waits for `selector`. */
async function open(
  uiBase: string,
  path: string,
  selector: string,
): Promise<boolean> {
  await view.navigate(`${origin}${uiBase}${path}`);
  return view.evaluate<boolean>(waitForSelector(selector));
}

/** The card of `id`, once `ready(view)` holds, or a thrown error naming it. */
async function cardView(
  id: string,
  ready = "true",
  ms = 15_000,
): Promise<CardView> {
  const found = await view.evaluate<CardView | null>(
    readCard(card(id), "provider-readiness", ready, ms),
  );
  if (found === null) {
    throw new Error(`the card of ${id} never showed (${ready})`);
  }
  return found;
}

/** The readiness hints, verbatim, from the app's `providerText.ts`. */
const HINT = {
  Ready: "Its config is validated and it can summon.",
  Pending:
    "Its config is still being validated. It can't summon yet, and what it declares appears once it's ready.",
  Failed:
    "Its config was rejected, or building it threw. It can't summon until it's reconfigured; Test connection says why, where the provider has one.",
};

try {
  /* ---------------------------------------------------------------- */
  step("The Providers nav entry, and one card per configured provider");

  const listed = await call<ProviderListDto>(
    full.basePath,
    "GET",
    "/providers",
  );
  checkEqual(
    "GET /providers answers 200, listing the six instances in order: four settled, the two held ones pending",
    [
      listed.status,
      // Absent where the API serves no provider route: the body is then its 404.
      listed.json.providers?.map((provider) => [
        provider.id,
        provider.readiness,
      ]) ?? listed.json,
    ],
    [
      200,
      [
        [ID.passing, "ready"],
        [ID.warning, "ready"],
        [ID.refused, "ready"],
        [ID.badRegion, "failed"],
        [ID.heldCard, "pending"],
        [ID.heldSummoner, "pending"],
      ],
    ],
  );

  check(
    "the full API's UI: /providers shows the Providers screen",
    await open(uis.full.basePath, "/providers", SCREEN),
    pageConsole,
  );
  const nav = await view.evaluate<[string, string][] | null>(NAV_LINKS);
  check(
    'the nav has a "Providers" entry linking to /jobs/providers',
    nav?.some(
      ([text, href]) => text === "Providers" && href === "/jobs/providers",
    ) === true,
    nav,
  );
  const ids = await view.evaluate<string[] | null>(
    poll(
      `(() => {
        const found = [...document.querySelectorAll('[data-testid^="provider-"]')]
          .map((element) => element.getAttribute("data-testid"))
          .filter((testId) => /^provider-bun-jobs-provider-/.test(testId))
          .map((testId) => testId.slice("provider-".length));
        return found.length === 6 ? found : null;
      })()`,
    ),
  );
  checkEqual(
    "one card per provider, provider-<id>, in the list's order",
    ids,
    Object.values(ID),
  );
  checkEqual(
    "the API versions line",
    await view.evaluate<string | null>(
      poll(
        `document.querySelector('[data-testid="providers-api"]')?.textContent.trim() || null`,
      ),
    ),
    `Provider API ${COMPUTE_PROVIDER_API.core}, summon facet ${COMPUTE_PROVIDER_API.summon}. Ids are stable for this process's life only.`,
  );

  const ready = await cardView(ID.passing);
  checkEqual(
    "a ready card: Ready (its meaning in the title), the id, the package and version, and its facts",
    ready,
    {
      readiness: "Ready",
      hint: HINT.Ready,
      rows: {
        Readiness: "Ready",
        Id: ID.passing,
        Package: "bun-jobs-provider-stratus 1.0.0",
        region: "eu-west-1",
        endpoint: platform.url,
      },
      testable: true,
      schemaToggle: "Config schema",
    },
  );
  const failed = await cardView(ID.badRegion);
  checkEqual(
    "the rejected region: Failed, and no facts, since its config is not known",
    [failed.readiness, failed.hint, Object.keys(failed.rows)],
    ["Failed", HINT.Failed, ["Readiness", "Id", "Package"]],
  );
  const pending = await cardView(ID.heldCard);
  checkEqual(
    "a config still validating (its secret store has not answered): Pending, and no facts yet",
    [pending.readiness, pending.hint, Object.keys(pending.rows)],
    ["Pending", HINT.Pending, ["Readiness", "Id", "Package"]],
  );

  /* ---------------------------------------------------------------- */
  step(
    "Test connection on a card: passed, a warning, refused credentials, a bad config",
  );

  const before = whoami;
  const validateFrom = exchanges.length;
  const passed = await view.evaluate<TestView | null>(
    testConnection(card(ID.passing)),
  );
  checkEqual(
    "every check passing: data-ok true, the count, and one provider-check-<id> per check",
    passed,
    {
      ok: "true",
      summary: "Connected: all 3 checks passed.",
      checks: [
        ["credentials", "Pass", "account acme"],
        ["region", "Pass", "eu-west-1"],
        ["quota", "Pass", "20% in use"],
      ],
    },
  );
  const warned = await view.evaluate<TestView | null>(
    testConnection(card(ID.warning)),
  );
  checkEqual(
    'a warn check: still data-ok true, "Connected, with 1 warning.", and the quota check a Warn badge with its detail',
    warned,
    {
      ok: "true",
      summary: "Connected, with 1 warning.",
      checks: [
        ["credentials", "Pass", "account acme-batch"],
        ["region", "Pass", "us-east-1"],
        ["quota", "Warn", "80% of the vCPU quota in use"],
      ],
    },
  );
  const denied = await view.evaluate<TestView | null>(
    testConnection(card(ID.refused)),
  );
  checkEqual(
    "a ProviderError of kind auth: data-ok false, the credentials' problem, with the platform's code",
    denied,
    {
      ok: "false",
      summary: `Credentials problem: the platform refused them. (${DENIED})`,
      checks: [],
    },
  );
  const misconfigured = await view.evaluate<TestView | null>(
    testConnection(card(ID.badRegion)),
  );
  checkEqual(
    "a config the schema rejected: data-ok false, a configuration problem naming the path",
    misconfigured,
    {
      ok: "false",
      summary: "Configuration problem: invalid region.",
      checks: [],
    },
  );
  checkEqual(
    "each press was one POST /providers/:id/validate, answered 200; three reached the platform (the bad config never does)",
    [
      exchanges
        .slice(validateFrom)
        .filter((one) => one.method === "POST")
        .map((one) => `${one.status} ${decodeURIComponent(one.path)}`),
      whoami - before,
    ],
    [
      [ID.passing, ID.warning, ID.refused, ID.badRegion].map(
        (id) => `200 /providers/${id}/validate`,
      ),
      3,
    ],
  );
  const direct = await call<ProviderValidationDto>(
    full.basePath,
    "POST",
    `/providers/${encodeURIComponent(ID.warning)}/validate`,
  );
  checkEqual(
    "the API's own verdict for the warning: ok, the warn check as the preflight returned it",
    [direct.json.ok, direct.json.checks.at(-1)],
    [
      true,
      { id: "quota", status: "warn", detail: "80% of the vCPU quota in use" },
    ],
  );

  /* ---------------------------------------------------------------- */
  step("The config schema: read only when opened");

  const schemaPath = `/providers/${encodeURIComponent(ID.passing)}/schema`;
  const closed = await view.evaluate<[boolean, string | null] | null>(
    poll(
      `(() => {
        const root = document.querySelector(${JSON.stringify(card(ID.passing))});
        const toggle = root && [...root.querySelectorAll("button")].find((button) => button.textContent.trim() === "Config schema");
        return toggle ? [!!root.querySelector('[data-testid="provider-schema"]'), toggle.getAttribute("aria-expanded")] : null;
      })()`,
    ),
  );
  checkEqual(
    "closed: no provider-schema, aria-expanded false, and not one schema request from the page yet",
    [closed, exchanges.filter((one) => one.path.endsWith("/schema")).length],
    [[false, "false"], 0],
  );
  const schemaFrom = exchanges.length;
  const opened = await view.evaluate<[string, string | null, string] | null>(
    poll(
      `(() => {
        const root = document.querySelector(${JSON.stringify(card(ID.passing))});
        if (!root) return null;
        const schema = root.querySelector('[data-testid="provider-schema"]');
        const toggle = [...root.querySelectorAll("button")].find((button) => /config schema/i.test(button.textContent));
        if (!schema) {
          if (!window.__schemaPressed && toggle) { window.__schemaPressed = true; toggle.click(); }
          return null;
        }
        return [toggle.textContent.trim(), toggle.getAttribute("aria-expanded"), schema.textContent];
      })()`,
    ),
  );
  checkEqual(
    'pressed: the toggle reads "Hide config schema", aria-expanded true',
    opened?.slice(0, 2),
    ["Hide config schema", "true"],
  );
  check(
    "provider-schema shows the JSON Schema: its title, the region's enum and the token's description",
    opened !== null &&
      [
        "Stratus (draft-2020-12)",
        "eu-west-1",
        "us-east-1",
        "An API token from the Stratus console",
      ].every((text) => opened[2].includes(text)),
    opened?.[2],
  );
  checkEqual(
    "exactly one request, GET /providers/:id/schema for that card, made on the press",
    exchanges
      .slice(schemaFrom)
      .filter((one) => one.path.endsWith("/schema"))
      .map((one) => `${one.method} ${one.path} ${one.status}`),
    [`GET ${schemaPath} 200`],
  );

  /* ---------------------------------------------------------------- */
  step("The gates: a read-only API, and one without the opt-ins");

  check(
    "read-only (providers.read kept): the screen shows",
    await open(uis.readOnly.basePath, "/providers", SCREEN),
    pageConsole,
  );
  const readOnlyCard = await view.evaluate<CardView | null>(
    readCard(card(ID.passing), "provider-readiness"),
  );
  checkEqual(
    "its card: Ready, the schema toggle, and no Test connection (providers.validate is a mutation)",
    [
      readOnlyCard?.readiness,
      readOnlyCard?.schemaToggle,
      readOnlyCard?.testable,
    ],
    ["Ready", "Config schema", false],
  );

  const plainFrom = exchanges.length;
  await view.navigate(`${origin}${uis.plain.basePath}/providers`);
  checkEqual(
    'the default actions: /providers is "Page not found"',
    await view.evaluate<string | null>(
      poll(
        `document.querySelector('[data-testid="not-found"] h1')?.textContent.trim() || null`,
      ),
    ),
    "Page not found",
  );
  const plainNav = await view.evaluate<[string, string][] | null>(NAV_LINKS);
  checkEqual(
    "no Providers nav entry, and the page never asked for a provider route",
    [
      plainNav?.some(([text]) => text === "Providers"),
      exchanges
        .slice(plainFrom)
        .filter((one) => one.path.startsWith("/providers"))
        .map((one) => `${one.method} ${one.api}${one.path}`),
    ],
    [false, []],
  );
  checkEqual(
    "that API serves no provider route: GET /providers → 404",
    (await call(plain.basePath, "GET", "/providers")).status,
    404,
  );

  /* ---------------------------------------------------------------- */
  step("The Summon panel: the summoner's readiness, and Test connection");

  check(
    "reports' Summon panel shows its summoner",
    await open(uis.full.basePath, "/queues/reports?panel=summon", SUMMONER),
    pageConsole,
  );
  const reports = await view.evaluate<CardView | null>(
    readCard(SUMMONER, "summon-readiness", "view.testable"),
  );
  checkEqual(
    "summon-readiness Ready with its meaning, the provider named, the real boot budget, and Test connection offered",
    [
      reports?.readiness,
      reports?.hint,
      reports?.rows.Provider,
      reports?.rows["Boot budget"],
      reports?.testable,
    ],
    [
      "Ready",
      HINT.Ready,
      "Stratus bun-jobs-provider-stratus 1.0.0",
      "45s",
      true,
    ],
  );
  checkEqual(
    "Test connection on the panel runs the summoner's preflight",
    await view.evaluate<TestView | null>(testConnection(SUMMONER)),
    {
      ok: "true",
      summary: "Connected: all 3 checks passed.",
      checks: [
        ["credentials", "Pass", "account acme"],
        ["region", "Pass", "eu-west-1"],
        ["quota", "Pass", "20% in use"],
      ],
    },
  );

  await open(uis.full.basePath, "/queues/audits?panel=summon", SUMMONER);
  const audits = await view.evaluate<CardView | null>(
    readCard(SUMMONER, "summon-readiness", "view.testable"),
  );
  const auditsTest = await view.evaluate<TestView | null>(
    testConnection(SUMMONER),
  );
  checkEqual(
    "Ready is the config's word, not the credentials': audits' summoner reads Ready, and its test is refused",
    [audits?.readiness, auditsTest?.ok, auditsTest?.summary],
    [
      "Ready",
      "false",
      `Credentials problem: the platform refused them. (${DENIED})`,
    ],
  );

  await open(uis.readOnly.basePath, "/queues/reports?panel=summon", SUMMONER);
  const readOnlySummoner = await view.evaluate<CardView | null>(
    readCard(SUMMONER, "summon-readiness"),
  );
  checkEqual(
    "read-only: the same readiness, and no Test connection",
    [readOnlySummoner?.readiness, readOnlySummoner?.testable],
    ["Ready", false],
  );

  /* ---------------------------------------------------------------- */
  step("Pending on a card, then Ready on the list's next refetch (every 10 s)");

  const listPath = "/providers";
  const mountFrom = exchanges.length;
  check(
    "the Providers screen again",
    await open(uis.full.basePath, "/providers", SCREEN),
    pageConsole,
  );
  await cardView(ID.heldCard, 'view.readiness === "Pending"');
  // A mark on this document: still there later means no reload happened.
  await view.evaluate("window.__sameDocument = true");
  const mountRead = (): boolean =>
    pageCalls(listPath, "GET", mountFrom).some((one) => one.status === 200);
  await waitFor("the screen's first list read to be answered", mountRead);
  const releasedAt = Date.now();
  cardStore.resolve(TOKEN);
  await heldCard.ready;
  const readsBefore = pageCalls(listPath).filter((one) => one.at < releasedAt);
  const stillPending = await cardView(ID.heldCard);
  checkEqual(
    "released: the API says ready at once, while the card still reads Pending, with no new list read yet",
    [
      (await readinessById())[ID.heldCard],
      stillPending.readiness,
      pageCalls(listPath).filter((one) => one.at >= releasedAt).length,
    ],
    ["ready", "Pending", 0],
  );
  const nowReady = await cardView(
    ID.heldCard,
    'view.readiness === "Ready"',
    25_000,
  );
  const readsAfter = pageCalls(listPath).filter((one) => one.at >= releasedAt);
  show(
    "list reads by the page",
    pageCalls(listPath).map((one) => `+${one.at - releasedAt}ms`),
  );
  checkEqual(
    "then Ready, its hint and its facts, in the same document",
    [
      nowReady.readiness,
      nowReady.hint,
      nowReady.rows.region,
      await view.evaluate<boolean>("window.__sameDocument === true"),
    ],
    ["Ready", HINT.Ready, "eu-west-1", true],
  );
  const gap =
    readsAfter.length > 0 && readsBefore.length > 0
      ? readsAfter[0]!.at - readsBefore.at(-1)!.at
      : -1;
  check(
    `it came with the list's own refetch: a GET /providers after the release, at least 9 s after the one before it (${gap} ms)`,
    readsAfter.length > 0 && gap >= 9_000,
    { gap, readsBefore, readsAfter },
  );

  /* ---------------------------------------------------------------- */
  step(
    "Pending on the Summon panel, then Ready on its next 5 s refetch, with no summon check",
  );

  check(
    "exports' Summon panel shows its summoner",
    await open(uis.full.basePath, "/queues/exports?panel=summon", SUMMONER),
    pageConsole,
  );
  const exportsPending = await view.evaluate<CardView | null>(
    readCard(SUMMONER, "summon-readiness"),
  );
  checkEqual(
    "summon-readiness Pending with its meaning; no Style or Boot budget (the capabilities are unknown), no facts",
    [
      exportsPending?.readiness,
      exportsPending?.hint,
      exportsPending === null ? null : Object.keys(exportsPending.rows),
    ],
    ["Pending", HINT.Pending, ["Provider", "Readiness"]],
  );
  const lastOutcome = poll(
    `document.querySelector('[data-testid="summon-last"]')?.textContent.trim() || null`,
  );
  checkEqual(
    "no summon check has run: Last outcome None yet",
    await view.evaluate<string | null>(lastOutcome),
    "None yet",
  );
  await view.evaluate("window.__sameDocument = true");
  const summonPath = "/queues/exports/summon";
  const summonReleasedAt = Date.now();
  summonerStore.resolve(TOKEN);
  await heldSummoner.ready;
  const exportsReady = await view.evaluate<CardView | null>(
    readCard(
      SUMMONER,
      "summon-readiness",
      'view.readiness === "Ready"',
      15_000,
    ),
  );
  checkEqual(
    "then Ready, the real capabilities (Style, a 45s boot budget) and the facts, in the same document",
    [
      exportsReady?.readiness,
      exportsReady?.rows.Style,
      exportsReady?.rows["Boot budget"],
      exportsReady?.rows.region,
      await view.evaluate<boolean>("window.__sameDocument === true"),
    ],
    ["Ready", "Launch: starts new units", "45s", "us-east-1", true],
  );
  show(
    "the panel's summon status reads",
    pageCalls(summonPath).map((one) => `+${one.at - summonReleasedAt}ms`),
  );
  check(
    "brought by the panel's own status read, made after the release",
    pageCalls(summonPath).some(
      (one) => one.at >= summonReleasedAt && one.status === 200,
    ),
    pageCalls(summonPath).map((one) => `+${one.at - summonReleasedAt}ms`),
  );
  checkEqual(
    "and still no summon check: Last outcome None yet, no failures (reading the status adopted the provider)",
    [
      await view.evaluate<string | null>(lastOutcome),
      await view.evaluate<string | null>(
        `document.querySelector('[data-testid="summon-failures"]')?.textContent.trim() ?? null`,
      ),
    ],
    ["None yet", "0"],
  );

  checkEqual(
    "no CSP violation on the way",
    await view.evaluate<string[]>(COLLECT_VIOLATIONS),
    [],
  );

  // Read last, so every instance stays referenced for the whole run.
  const final = await call<ProviderListDto>(full.basePath, "GET", "/providers");
  checkEqual(
    "at the end, GET /providers still lists one provider per instance held above",
    final.json.providers?.length,
    held.length,
  );
} catch (error) {
  console.log(`page console:\n${pageConsole.join("\n")}`);
  throw error;
} finally {
  await shutdown(view);
}

summary();
