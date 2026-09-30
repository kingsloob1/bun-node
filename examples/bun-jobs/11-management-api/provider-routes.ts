/**
 * The compute provider routes: `GET /providers`, "Test connection"
 * (`POST /providers/:id/validate`) and a config form's JSON Schema
 * (`GET /providers/:id/schema`), from the management API.
 *
 * ```bash
 * bun 11-management-api/provider-routes.ts
 * ```
 *
 * The provider is "Cumulus", made up, written with `defineComputeProvider`
 * and talking over HTTP to a fake of its platform, the conformance kit's
 * `fakePlatform()`. A plain `defineSummoner` sits beside it, and both are
 * queue summoners on a `jobs` context. Nothing is summoned: every trigger is
 * off. Summoning needs a backend another process can reach, so on the memory
 * driver this runs on a temporary SQLite file.
 *
 * The points that are easy to get wrong:
 *
 * - **The list is the process's, not the `jobs` context's.** Every
 *   `provider(config)` call registers the instance it makes, a
 *   `defineSummoner` included, whether or not a queue uses it.
 * - **An id is `name@version~<n>`**, the nth instance of that `name@version`
 *   in this process. It means nothing in another process. `@`, `:` and `~`
 *   are URL-safe, but a scoped name's `/` is not: `encodeURIComponent` it.
 * - **`authorize` is told the id, as `provider`**, on "Test connection" and a
 *   schema read, and `GET /providers` asks it once per provider (as that
 *   provider's schema read would be asked) and leaves out the ones refused.
 * - **"Test connection" answers 200 with a verdict**, `ok` and the checks, or
 *   an `error` whose `kind` says whose fault it is: `misconfigured` or `auth`
 *   for the config, `transient` (and `throttled`, `quota`) for a platform
 *   that is failing for now.
 * - **Only an asynchronous schema can fail there.** A synchronous one rejects
 *   a bad config at `provider(config)`, which throws, so it never reaches
 *   the list at all.
 * - **Both actions are opt-in**, because they disclose infrastructure.
 *   `providers.read` is a read, so `readOnly` keeps it when `actions` names
 *   it. `providers.validate` uses the provider's credentials, so it is a
 *   mutation, and `readOnly` removes it.
 * - **Nothing served holds a secret.** Facts pass the summon status's filter,
 *   details are redacted, and the schema's secret properties lose their
 *   `enum`; no `default`, `example`, `examples`, `const` or `x-*` key is
 *   served anywhere, so a form built from the schema has nothing pre-filled.
 */
import type {
  JobsApiAction,
  JobsApiConfig,
  ProviderDto,
  ProviderListDto,
  ProviderSchemaDto,
  ProviderValidationDto,
  SummonStatusDto,
} from "@kingsleyweb/bun-jobs";
import type {
  ProviderCallContext,
  SummonCapabilities,
} from "@kingsleyweb/bun-jobs/provider";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  defineSummoner,
  JOBS_API_ACTIONS,
  JOBS_API_OPT_IN_ACTIONS,
} from "@kingsleyweb/bun-jobs";
import {
  COMPUTE_PROVIDER_API,
  defineComputeProvider,
  ProviderError,
  toStandardSchema,
} from "@kingsleyweb/bun-jobs/provider";
import { fakePlatform } from "@kingsleyweb/bun-jobs/provider/testing";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("The management API: compute provider routes");

/** The one API token the fake platform accepts. A declared secret. */
const TOKEN = "cu_live_7Hq2xVb9Lk3Rz";

/** Every trigger off: nothing here summons anything. */
const ONE_SHOT = { onAdd: false, events: false, poll: false } as const;

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

/** The regions Cumulus has. */
const REGIONS = ["eu-west-1", "us-east-1"];

/** What a user configures Cumulus with. */
interface CumulusInput {
  /** The control API's base URL: the fake's, here. */
  url: string;
  /** The region, one of {@link REGIONS}. */
  region: string;
  /** The API token, or a function reading it from a secret store. */
  apiToken: string | (() => Promise<string>);
}

/** The validated config: the token, resolved. */
interface CumulusConfig {
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
 * listed, and its validation fails later, where "Test connection" reports it.
 */
async function resolveConfig(
  input: unknown,
): Promise<
  { value: CumulusConfig } | { issues: { message: string; path: string[] }[] }
> {
  const given = (input ?? {}) as Partial<CumulusInput>;
  const issues: { message: string; path: string[] }[] = [];
  if (typeof given.url !== "string") {
    issues.push({ message: "url is required", path: ["url"] });
  }
  if (typeof given.region !== "string" || !REGIONS.includes(given.region)) {
    issues.push({
      message: `region must be one of ${REGIONS.join(", ")}`,
      path: ["region"],
    });
  }
  if (
    typeof given.apiToken !== "string" &&
    typeof given.apiToken !== "function"
  ) {
    issues.push({ message: "apiToken is required", path: ["apiToken"] });
  }
  if (issues.length > 0) {
    return { issues };
  }
  const apiToken =
    typeof given.apiToken === "function"
      ? await given.apiToken()
      : given.apiToken!;
  return { value: { url: given.url!, region: given.region!, apiToken } };
}

/**
 * The config schema: the validator above, plus a Standard JSON Schema
 * converter (`~standard.jsonSchema`), which is what `GET
 * /providers/:id/schema` serves for a config form. A schema library that
 * implements Standard JSON Schema gives you the converter; here it is
 * written out. The region's `default`, and the token's `default`,
 * `examples`, `enum` and `x-` extension, are there to be dropped.
 */
const base = toStandardSchema<CumulusInput, CumulusConfig>(resolveConfig);
const standard = {
  ...base["~standard"],
  jsonSchema: {
    input: (options: { target: string }) => ({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: `Cumulus (${options.target})`,
      type: "object",
      required: ["url", "region", "apiToken"],
      properties: {
        url: { type: "string", format: "uri" },
        region: { type: "string", enum: REGIONS, default: "eu-west-1" },
        apiToken: {
          type: "string",
          description: "An API token from the Cumulus console",
          default: TOKEN,
          examples: [TOKEN],
          enum: [TOKEN],
          "x-ui-widget": "password",
        },
      },
    }),
    output: () => ({}),
  },
};
const cumulusSchema: typeof base = { "~standard": standard };

/** A failed platform answer as a `ProviderError` whose kind says whose fault it is. */
async function toProviderError(response: Response): Promise<ProviderError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  const kind =
    response.status === 401 || response.status === 403
      ? "auth"
      : response.status === 404
        ? "misconfigured"
        : "transient";
  return new ProviderError(`cumulus answered ${response.status}`, kind, {
    ...(body.error?.code === undefined
      ? {}
      : { platformCode: body.error.code }),
    status: response.status,
  });
}

/** The Cumulus provider, as its package would export it. */
const cumulus = defineComputeProvider<CumulusConfig, CumulusInput>({
  name: "bun-jobs-provider-cumulus",
  version: "1.0.0",
  kind: "cumulus",
  displayName: "Cumulus",
  apiVersion: {
    core: COMPUTE_PROVIDER_API.core,
    summon: COMPUTE_PROVIDER_API.summon,
  },
  config: cumulusSchema,
  secrets: ["apiToken"],
  describe: (config) => ({
    region: config.region,
    endpoint: config.url,
    // Two facts a careless edit writes: one holds the declared secret, one a
    // credential shape. Neither is served.
    console: `${config.url}/console?session=${config.apiToken}`,
    header: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJl",
  }),
  // The preflight: can these credentials reach the platform? Starts nothing.
  validate: async (config, ctx: ProviderCallContext) => {
    const response = await ctx.fetch(`${config.url}/v1/whoami`, {
      headers: { authorization: `Bearer ${config.apiToken}` },
      signal: ctx.signal,
    });
    if (!response.ok) {
      throw await toProviderError(response);
    }
    const { account } = (await response.json()) as { account: string };
    return [
      { id: "credentials", status: "pass", detail: `account ${account}` },
      { id: "region", status: "pass", detail: config.region },
    ];
  },
  summon: () => {
    const capabilities: SummonCapabilities = {
      style: "launch",
      dedupe: { kind: "none" },
      passes: "argv",
      bootBudgetMs: 60_000,
      shutdown: { signal: "SIGTERM", graceMs: 10_000 },
      maxLifetimeMs: null,
      enforcesLifetime: false,
    };
    return {
      capabilities,
      summon: async () => ({ status: "started", handles: [] }),
    };
  },
});

/** How many preflights reached the fake platform. */
let whoami = 0;

/** A fake Cumulus: `GET /v1/whoami` answers for {@link TOKEN} alone. */
const platform = await fakePlatform({
  "GET /v1/whoami": (request) => {
    whoami += 1;
    return request.headers.get("authorization") === `Bearer ${TOKEN}`
      ? Response.json({ account: "cumulus-test" })
      : Response.json(
          { error: { code: "InvalidToken", message: "no such token" } },
          { status: 401 },
        );
  },
});

/** A second fake, closed at once: a platform that is down. */
const gone = await fakePlatform({});
const goneUrl = gone.url;
await gone.close();

/* ------------------------------------------------------------------ */
step("Five providers configured in this process, and two queues using them");

// A secret store that takes a moment: the config validates asynchronously.
const readToken = async () => {
  await Bun.sleep(5);
  return TOKEN;
};
const good = cumulus({
  url: platform.url,
  region: "eu-west-1",
  apiToken: readToken,
});
// A region Cumulus does not have: the schema rejects it, later.
const badRegion = cumulus({
  url: platform.url,
  region: "eu-nowhere-1",
  apiToken: readToken,
});
// A token the platform refuses: a valid config, but the wrong credentials.
const wrongToken = cumulus({
  url: platform.url,
  region: "us-east-1",
  apiToken: "cu_live_revoked000000",
});
// The right credentials, for a platform that cannot be reached.
const unreachable = cumulus({
  url: goneUrl,
  region: "eu-west-1",
  apiToken: readToken,
});
// And a plain summoner, whose provider is anonymous.
const recording = defineSummoner({
  kind: "example-record",
  invoke: async () => ({ status: "started", handles: [] }),
  describe: () => ({ cluster: "local", apiToken: "tok-never-served" }),
});

// The registry holds each instance through a WeakRef: one nothing strong
// references is collected and silently drops out of GET /providers. These
// five are held here to the end, where the last check reads them.
const held = [good, badRegion, wrongToken, unreachable, recording];

// Each config validates asynchronously; wait for all of them to settle, so
// the list below reads each one's final readiness, not "pending".
await Promise.allSettled(
  [good, badRegion, wrongToken, unreachable].map((provider) => provider.ready),
);

const { logger } = createTestLogger();
const jobs = new BunJobs({
  namespace: exampleNamespace("provider-api"),
  driver: crossProcessDriver(),
  logger,
  summon: {
    reports: { summoner: good, triggers: ONE_SHOT },
    exports: { summoner: badRegion, triggers: ONE_SHOT },
    alerts: { summoner: recording, triggers: ONE_SHOT },
  },
});
await jobs.queue("reports").add("render", {});

/** The default actions plus the two provider actions. */
const PROVIDER_ACTIONS: JobsApiAction[] = JOBS_API_ACTIONS.filter(
  (action) =>
    !JOBS_API_OPT_IN_ACTIONS.has(action) ||
    action === "providers.read" ||
    action === "providers.validate",
);

/** Every API mounted here, closed at the end. */
const apis: { close: () => Promise<void> }[] = [];

/** An API over `jobs` at `/admin/jobs`, with a request helper. */
function mount(config: Partial<JobsApiConfig> = {}) {
  const api = createJobsApi({
    jobs,
    basePath: "/admin/jobs",
    authorize: () => true,
    ...config,
  });
  apis.push(api);
  const adapter = new BunHttpAdapter(0);
  adapter.use(api.basePath, api.router);

  /** One request, answered as status and parsed body. A POST is sent as JSON. */
  async function call(method: "GET" | "POST", path: string, body?: object) {
    const response = await adapter.fetch(`${api.basePath}${path}`, {
      method,
      ...(method === "GET"
        ? {}
        : { headers: { "content-type": "application/json" } }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  }

  /** The provider routes this API registered, by operation id. */
  const providerRoutes = () =>
    api.routes
      .filter((route) => route.path.includes("/providers"))
      .map(
        (route) => `${route.operationId}${route.mutation ? " (mutation)" : ""}`,
      )
      .sort();

  return { api, call, providerRoutes };
}

/** A provider's id, percent-encoded for a path. */
const at = (id: string, tail: string) =>
  `/providers/${encodeURIComponent(id)}${tail}`;

/** Every body a provider route answered, to search for the token at the end. */
const served: unknown[] = [];

/* ------------------------------------------------------------------ */
step("1. Both actions are opt-in; readOnly keeps providers.read alone");

const plainApi = mount();
const ID = "bun-jobs-provider-cumulus@1.0.0~1";
checkEqual(
  "the default API registers none of the three, and each answers 404 ROUTE_NOT_FOUND",
  [
    plainApi.providerRoutes(),
    ...(await Promise.all(
      [
        ["GET", "/providers"],
        ["POST", at(ID, "/validate")],
        ["GET", at(ID, "/schema")],
      ].map(async ([method, path]) => {
        const { status, body } = await plainApi.call(
          method as "GET" | "POST",
          path!,
        );
        return `${status} ${body.code}`;
      }),
    )),
  ],
  [[], "404 ROUTE_NOT_FOUND", "404 ROUTE_NOT_FOUND", "404 ROUTE_NOT_FOUND"],
);

const readOnlyApi = mount({ actions: PROVIDER_ACTIONS, readOnly: true });
checkEqual(
  "readOnly, with both named: the list and the schema stay, the preflight goes, and it never ran",
  [
    readOnlyApi.providerRoutes(),
    (await readOnlyApi.call("GET", "/providers")).status,
    (await readOnlyApi.call("GET", at(ID, "/schema"))).status,
    (await readOnlyApi.call("POST", at(ID, "/validate"))).status,
    whoami,
  ],
  [["getProviderSchema", "listProviders"], 200, 200, 404, 0],
);

const panel = mount({ actions: PROVIDER_ACTIONS });
checkEqual(
  "opted in: all three, the preflight a mutation",
  panel.providerRoutes(),
  ["getProviderSchema", "listProviders", "validateProvider (mutation)"],
);

/* ------------------------------------------------------------------ */
step("2. GET /providers: every provider in the process, secret-free");

const listed = await panel.call("GET", "/providers");
const list: ProviderListDto = listed.body;
served.push(list);
show("GET /providers", list);
checkEqual(
  "200, with the plugin API versions this bun-jobs speaks",
  [listed.status, list.api],
  [
    200,
    { core: COMPUTE_PROVIDER_API.core, summon: COMPUTE_PROVIDER_API.summon },
  ],
);
checkEqual(
  "all five, oldest first, numbered per name@version: the two no queue uses included",
  list.providers.map((provider) => provider.id),
  [
    "bun-jobs-provider-cumulus@1.0.0~1",
    "bun-jobs-provider-cumulus@1.0.0~2",
    "bun-jobs-provider-cumulus@1.0.0~3",
    "bun-jobs-provider-cumulus@1.0.0~4",
    "custom:example-record@0.0.0~1",
  ],
);

/** A listed provider by id. */
const byId = (id: string): ProviderDto | undefined =>
  list.providers.find((provider) => provider.id === id);
checkEqual(
  "Cumulus ~1: its identity, ready, a preflight and a schema, and its facts less the two that hold credentials",
  byId("bun-jobs-provider-cumulus@1.0.0~1"),
  {
    id: "bun-jobs-provider-cumulus@1.0.0~1",
    provider: {
      name: "bun-jobs-provider-cumulus",
      version: "1.0.0",
      kind: "cumulus",
      displayName: "Cumulus",
      apiVersion: {
        core: COMPUTE_PROVIDER_API.core,
        summon: COMPUTE_PROVIDER_API.summon,
      },
    },
    readiness: "ready",
    facts: { region: "eu-west-1", endpoint: platform.url },
    preflight: true,
    configSchema: true,
  },
);
checkEqual(
  "the bad region: failed, and no facts, since its config is not known",
  [
    byId("bun-jobs-provider-cumulus@1.0.0~2")?.readiness,
    byId("bun-jobs-provider-cumulus@1.0.0~2")?.facts,
  ],
  ["failed", {}],
);
checkEqual(
  "the plain summoner: the anonymous custom:<kind> provider, ready, no preflight, no schema, its token fact dropped",
  (({ provider, readiness, facts, preflight, configSchema }) => ({
    name: provider.name,
    readiness,
    facts,
    preflight,
    configSchema,
  }))(byId("custom:example-record@0.0.0~1")!),
  {
    name: "custom:example-record",
    readiness: "ready",
    facts: { kind: "example-record", cluster: "local" },
    preflight: false,
    configSchema: false,
  },
);

// The list asks authorize once more per provider, with its id as `provider`
// and the route its own schema read has, and leaves out every one refused.
const listAsks: string[] = [];
const scoped = mount({
  actions: PROVIDER_ACTIONS,
  authorize: (_req, { action, provider, route }) => {
    if (provider !== undefined) {
      listAsks.push(`${action} ${provider} ${route?.method} ${route?.path}`);
    }
    return provider !== "bun-jobs-provider-cumulus@1.0.0~4";
  },
});
const scopedList = (
  (await scoped.call("GET", "/providers")).body as ProviderListDto
).providers.map((provider) => provider.id);
// One provider's own schema read, for comparison: the list asked the same.
await scoped.call("GET", at(ID, "/schema"));
checkEqual(
  "authorize refusing providers.read on one provider leaves it out of the list, asked once per provider as its own schema read is",
  [scopedList, listAsks],
  [
    [
      "bun-jobs-provider-cumulus@1.0.0~1",
      "bun-jobs-provider-cumulus@1.0.0~2",
      "bun-jobs-provider-cumulus@1.0.0~3",
      "custom:example-record@0.0.0~1",
    ],
    [
      ...list.providers.map(
        (provider) => `providers.read ${provider.id} GET /providers/:id/schema`,
      ),
      `providers.read ${ID} GET /providers/:id/schema`,
    ],
  ],
);

// A queue's summon status names its summoner's id, so a UI goes from a
// queue to "Test connection".
const reports: SummonStatusDto = (
  await panel.call("GET", "/queues/reports/summon")
).body;
const exportsStatus: SummonStatusDto = (
  await panel.call("GET", "/queues/exports/summon")
).body;
checkEqual(
  "the summon status points at the list: providerId and readiness, capabilities only once ready",
  [
    [
      reports.summoner?.providerId,
      reports.summoner?.readiness,
      reports.summoner?.capabilities?.style,
    ],
    [
      exportsStatus.summoner?.providerId,
      exportsStatus.summoner?.readiness,
      exportsStatus.summoner?.capabilities ?? "(absent)",
    ],
  ],
  [
    ["bun-jobs-provider-cumulus@1.0.0~1", "ready", "launch"],
    ["bun-jobs-provider-cumulus@1.0.0~2", "failed", "(absent)"],
  ],
);

/* ------------------------------------------------------------------ */
step("3. POST /providers/:id/validate: Test connection");

/** Runs one preflight through the API. */
async function testConnection(id: string, body?: object) {
  const { status, body: verdict } = await panel.call(
    "POST",
    at(id, "/validate"),
    body,
  );
  served.push(verdict);
  return { status, verdict: verdict as ProviderValidationDto };
}

const ok = await testConnection(ID);
show("a working config", ok.verdict);
checkEqual(
  "a working config: 200, ok, the preflight's checks, and it reached the platform",
  [ok.status, ok.verdict, whoami],
  [
    200,
    {
      id: ID,
      ok: true,
      checks: [
        { id: "credentials", status: "pass", detail: "account cumulus-test" },
        { id: "region", status: "pass", detail: "eu-west-1" },
      ],
    },
    1,
  ],
);

const invalid = await testConnection("bun-jobs-provider-cumulus@1.0.0~2");
show("a config that does not validate", invalid.verdict);
checkEqual(
  "config invalid: still 200, not ok, misconfigured, naming the path; the platform was never asked",
  [invalid.status, invalid.verdict, whoami],
  [
    200,
    {
      id: "bun-jobs-provider-cumulus@1.0.0~2",
      ok: false,
      checks: [],
      error: { kind: "misconfigured", detail: "invalid config: region" },
    },
    1,
  ],
);

const refused = await testConnection("bun-jobs-provider-cumulus@1.0.0~3");
show("credentials the platform refuses", refused.verdict);
checkEqual(
  "the wrong token: auth, the config's fault too, with the platform's code as the detail",
  [refused.verdict.ok, refused.verdict.error, whoami],
  [false, { kind: "auth", detail: "InvalidToken" }, 2],
);

const down = await testConnection("bun-jobs-provider-cumulus@1.0.0~4");
show("a platform that is down", down.verdict);
check(
  "platform unreachable: transient, the platform's fault for now, detail the error's code, never its message",
  down.status === 200 &&
    down.verdict.ok === false &&
    down.verdict.checks.length === 0 &&
    down.verdict.error?.kind === "transient" &&
    /^[\w.:-]{1,64}$/.test(down.verdict.error.detail) &&
    !down.verdict.error.detail.includes(" "),
  down.verdict,
);

const bare = await testConnection("custom:example-record@0.0.0~1");
checkEqual(
  "a provider with no preflight checks its config alone: ok, no checks",
  [bare.status, bare.verdict],
  [200, { id: "custom:example-record@0.0.0~1", ok: true, checks: [] }],
);

checkEqual(
  "an unknown id is 404 PROVIDER_NOT_FOUND; a timeoutMs under a second is 400",
  [
    await panel
      .call("POST", at("bun-jobs-provider-cumulus@1.0.0~9", "/validate"))
      .then(({ status, body }) => `${status} ${body.code}`),
    await panel
      .call("POST", at(ID, "/validate"), { timeoutMs: 500 })
      .then(({ status }) => status),
  ],
  ["404 PROVIDER_NOT_FOUND", 400],
);

// A refusal from authorize is 403, as on every route; the preflight is
// never run for it.
// authorize is told which provider, so a host can scope "Test connection":
// here Cumulus ~1 may not be tested, the plain summoner may.
const guarded = mount({
  actions: PROVIDER_ACTIONS,
  authorize: (_req, { action, provider }) =>
    !(action === "providers.validate" && provider === ID),
});
const before = whoami;
checkEqual(
  "authorize refusing providers.validate on one provider: 403 FORBIDDEN there, and the platform was not asked; another is tested",
  [
    await guarded
      .call("POST", at(ID, "/validate"))
      .then(({ status, body }) => `${status} ${body.code}`),
    whoami - before,
    await guarded
      .call("POST", at("custom:example-record@0.0.0~1", "/validate"))
      .then(({ status, body }) => `${status} ${body.ok}`),
  ],
  ["403 FORBIDDEN", 0, "200 true"],
);

/* ------------------------------------------------------------------ */
step("4. GET /providers/:id/schema: the config as a JSON Schema");

const schemaAnswer = await panel.call("GET", at(ID, "/schema"));
const schema: ProviderSchemaDto = schemaAnswer.body;
served.push(schema);
show("GET /providers/…/schema", schema);
const properties = schema.schema.properties as Record<
  string,
  Record<string, unknown>
>;
checkEqual(
  "200, draft-2020-12, the schema's own fields; the region keeps its enum, not its default",
  [
    schemaAnswer.status,
    schema.id,
    schema.target,
    schema.schema.required,
    properties.region,
  ],
  [
    200,
    ID,
    "draft-2020-12",
    ["url", "region", "apiToken"],
    { type: "string", enum: REGIONS },
  ],
);
checkEqual(
  "the token, a declared secret, keeps neither default, examples, enum nor its x- key; and no default is served anywhere",
  [
    properties.apiToken,
    /"(?:default|examples?|const|x-[^"]*)":/.test(
      JSON.stringify(schema.schema),
    ),
  ],
  [
    { type: "string", description: "An API token from the Cumulus console" },
    false,
  ],
);
checkEqual(
  "a provider whose schema has no JSON Schema converter is 404 PROVIDER_SCHEMA_NOT_FOUND; an unknown id, 404 PROVIDER_NOT_FOUND",
  await Promise.all(
    ["custom:example-record@0.0.0~1", "bun-jobs-provider-cumulus@1.0.0~9"].map(
      (id) =>
        panel
          .call("GET", at(id, "/schema"))
          .then(({ status, body }) => `${status} ${body.code}`),
    ),
  ),
  ["404 PROVIDER_SCHEMA_NOT_FOUND", "404 PROVIDER_NOT_FOUND"],
);

check(
  "and no answer above held the token",
  !JSON.stringify(served).includes(TOKEN),
);

// Held to here, all five are still listed, whatever the collector did.
checkEqual(
  "at the end, the list is still the five instances held above, in order",
  (
    (await panel.call("GET", "/providers")).body as ProviderListDto
  ).providers.map((provider) => provider.provider.name),
  held.map((instance) => instance.provider.name),
);

/* ------------------------------------------------------------------ */
step("Clean up");

for (const api of apis) {
  await api.close();
}
await platform.close();
await jobs.purge();
await jobs.close();
summary();
