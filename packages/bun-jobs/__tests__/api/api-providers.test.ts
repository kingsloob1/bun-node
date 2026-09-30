import type { JobsApiConfig } from "../../lib/api/config";
import type {
  ProviderCheck,
  SummonCapabilities,
  SummonFacet,
} from "../../lib/provider/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import {
  JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS,
  JOBS_API_OPT_IN_ACTIONS,
} from "../../lib/api/contract/constants";
import { isServableFact } from "../../lib/api/serialize";
import { BunJobs } from "../../lib/index";
import {
  COMPUTE_PROVIDER_API,
  defineComputeProvider,
  ProviderError,
  toStandardSchema,
} from "../../lib/provider/index";
import { configuredProvider } from "../../lib/provider/registry";
import { makeTmpDir, testNamespace } from "../helpers";
import { harness, openHarnesses } from "./fixtures";

/**
 * The compute provider routes (plugins §14.1): `GET /providers`, `POST
 * /providers/{id}/validate` ("Test connection") and `GET
 * /providers/{id}/schema`, their two opt-in actions, `/meta`'s
 * `features.providers`, and the provider id and readiness a queue's summon
 * status now carries.
 *
 * The registry is per process and `bun test` runs every file in one, so no
 * case asserts the whole list: each names its providers uniquely and looks
 * for them. Every secret-free case carries a negative control showing the
 * secret was really there to leak.
 */

setDefaultTimeout(30_000);

const tmp = await makeTmpDir("bun-jobs-api-providers");
afterAll(async () => {
  await tmp.cleanup();
});

/** Undo steps, run as each case ends. */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** A declared secret: 8+ characters, so it is redacted by value. */
const TOKEN = "tok_live_9f8e7d6c5b4a";
/** A connection string with userinfo, a declared secret too. */
const DSN = "postgres://svc:hunter2hunter2@db.internal:5432/jobs";
/** A credential shape no one declared. */
const BEARER = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";

const CAPABILITIES: SummonCapabilities = {
  style: "launch",
  dedupe: { kind: "none" },
  passes: "argv",
  bootBudgetMs: 20_000,
  shutdown: { signal: "SIGTERM", graceMs: 10_000 },
  maxLifetimeMs: null,
  enforcesLifetime: false,
};

/** Every provider name used here, unique per process. */
let unique = 0;

/** The config the test providers take. */
interface AcmeConfig {
  /** A region, served as a fact. */
  region: string;
  /** A declared secret. */
  apiToken: string;
  /** A declared secret with userinfo. */
  dsn: string;
}

/** A config holding every kind of secret. */
const CONFIG: AcmeConfig = { region: "eu-west-1", apiToken: TOKEN, dsn: DSN };

/**
 * A provider named uniquely, with declared secrets and facts that try to
 * leak each of them, a preflight doing what `preflight` says, and (unless
 * `jsonSchema` is `false`) a config schema implementing Standard JSON Schema.
 */
function acme(
  options: {
    /** The preflight; none when omitted. */
    preflight?: (
      config: AcmeConfig,
      signal: AbortSignal,
    ) => Promise<readonly ProviderCheck[]>;
    /** The JSON Schema converter's `input`; none when `false`. */
    jsonSchema?: false | ((options: { target: string }) => unknown);
    /** Validate asynchronously, answering this. */
    asyncConfig?: () => Promise<boolean>;
    /** The version. */
    version?: string;
    /** The name, to share one across calls. */
    name?: string;
  } = {},
) {
  const name = options.name ?? `bun-jobs-provider-acme-${++unique}`;
  const base = toStandardSchema<AcmeConfig>((input) => {
    if (options.asyncConfig !== undefined) {
      return options.asyncConfig().then((valid) =>
        valid
          ? { value: input as AcmeConfig }
          : {
              issues: [
                { message: `unreachable with ${TOKEN}`, path: ["region"] },
                { message: "bad", path: [{ key: "dsn" }] },
              ],
            },
      );
    }
    return { value: input as AcmeConfig };
  });
  const converter = options.jsonSchema;
  const config =
    converter === false
      ? base
      : {
          "~standard": {
            ...base["~standard"],
            jsonSchema: {
              input:
                converter ??
                ((opts: { target: string }) => ({
                  $schema: "https://json-schema.org/draft/2020-12/schema",
                  target: opts.target,
                  type: "object",
                  required: ["region", "apiToken"],
                  properties: {
                    region: {
                      type: "string",
                      default: "eu-west-1",
                      enum: ["eu-west-1", "us-east-1"],
                      description: `e.g. ${BEARER}`,
                    },
                    apiToken: {
                      type: "string",
                      default: TOKEN,
                      examples: [TOKEN],
                    },
                    // Not credential-named: a declared secret by path.
                    dsn: {
                      anyOf: [{ type: "string", const: DSN }],
                      default: DSN,
                    },
                    tuning: {
                      type: "object",
                      properties: {
                        sessionCookie: { type: "string", default: "c-v-1" },
                        batch: { type: "integer", default: 10 },
                      },
                    },
                  },
                })),
              output: () => ({}),
            },
          },
        };
  return defineComputeProvider({
    name,
    version: options.version ?? "1.0.0",
    kind: "acme",
    displayName: "Acme Compute",
    homepage: "https://acme.example/docs",
    apiVersion: { core: "0.1", summon: "0.1" },
    config: config as typeof base,
    secrets: ["apiToken", "dsn"],
    describe: (value) => ({
      region: value.region,
      // Each of these must never be served.
      apiToken: value.apiToken,
      label: value.apiToken,
      endpoint: value.dsn,
      note: BEARER,
      hostname: "db.internal",
    }),
    ...(options.preflight === undefined
      ? {}
      : {
          validate: async (value: AcmeConfig, context) =>
            await options.preflight!(value, context.signal),
        }),
    summon: (): SummonFacet => ({
      capabilities: CAPABILITIES,
      summon: async () => ({ status: "started", handles: [] }),
    }),
  });
}

/** Every action but the opt-ins, plus the two provider actions. */
const WITH_PROVIDERS = JOBS_API_ACTIONS.filter(
  (action) =>
    !JOBS_API_OPT_IN_ACTIONS.has(action) ||
    action === "providers.read" ||
    action === "providers.validate",
);

/** A harness with the provider actions enabled (by default: every action). */
function api(overrides: Partial<JobsApiConfig> = {}) {
  return harness({ ...overrides });
}

/** A provider id, percent-encoded for a path. */
function path(id: string, tail = ""): string {
  return `/providers/${encodeURIComponent(id)}${tail}`;
}

/** The one listed provider with this id. */
async function listed(h: ReturnType<typeof api>, id: string): Promise<unknown> {
  const response = await h.call("GET", "/providers");
  expect(response.status).toBe(200);
  return (response.body.providers as { id: string }[]).find(
    (provider) => provider.id === id,
  );
}

describe("the registry and GET /providers", () => {
  it("numbers each name@version's instances from 1, and lists them in order with the API versions", async () => {
    const make = acme();
    const name = make.definition.name;
    const first = make(CONFIG);
    const second = make(CONFIG);
    const other = acme({ name, version: "2.0.0" })(CONFIG);
    const h = api();
    const response = await h.call("GET", "/providers");
    expect(response.status).toBe(200);
    expect(response.body.api).toEqual({ ...COMPUTE_PROVIDER_API });
    const ours = (response.body.providers as { id: string }[])
      .filter((provider) => provider.id.startsWith(`${name}@`))
      .map((provider) => provider.id);
    expect(ours).toEqual([
      `${name}@1.0.0#1`,
      `${name}@1.0.0#2`,
      `${name}@2.0.0#1`,
    ]);
    // Stable: the same instance under the same id on every read.
    expect(configuredProvider(`${name}@1.0.0#2`)?.configured).toBe(second);
    expect(configuredProvider(`${name}@1.0.0#1`)?.configured).toBe(first);
    expect(configuredProvider(`${name}@2.0.0#1`)?.configured).toBe(other);
  });

  it("answers identity, readiness, secret-free facts, preflight and configSchema", async () => {
    const make = acme({ preflight: async () => [] });
    make(CONFIG);
    const bare = acme({ jsonSchema: false })(CONFIG);
    const h = api();
    const id = `${make.definition.name}@1.0.0#1`;
    const entry = await listed(h, id);
    expect(entry).toEqual({
      id,
      provider: {
        name: make.definition.name,
        version: "1.0.0",
        kind: "acme",
        displayName: "Acme Compute",
        homepage: "https://acme.example/docs",
        apiVersion: { core: "0.1", summon: "0.1" },
      },
      readiness: "ready",
      // `hostname` too: `exposeHosts` is on by default, and a hostname is
      // not a secret. Everything else describe() returned is dropped.
      facts: { region: "eu-west-1", hostname: "db.internal" },
      preflight: true,
      configSchema: true,
    });
    const bareEntry = await listed(h, `${bare.provider.name}@1.0.0#1`);
    expect(bareEntry).toMatchObject({ preflight: false, configSchema: false });
    // With `exposeHosts` off, the host goes too.
    const hidden = api({ serialize: { exposeHosts: false } });
    expect(await listed(hidden, id)).toMatchObject({
      facts: { region: "eu-west-1" },
    });
  });

  it("is secret-free: no declared secret, userinfo or credential shape in the answer", async () => {
    const make = acme();
    const configured = make(CONFIG);
    const h = api();
    const response = await h.call("GET", "/providers");
    for (const secret of [TOKEN, "hunter2", "svc:", BEARER, "Bearer"]) {
      expect({ secret, leaked: response.text.includes(secret) }).toEqual({
        secret,
        leaked: false,
      });
    }
    // Negative control: the definition's describe() really returns each of
    // them, and the filters are what dropped them — a declared secret's
    // value by the configured provider, the credential shape by the
    // serializer.
    expect(make.definition.describe!(CONFIG)).toMatchObject({
      apiToken: TOKEN,
      label: TOKEN,
      endpoint: DSN,
      note: BEARER,
    });
    const facts = configured.describe();
    expect(facts).not.toHaveProperty("label");
    expect(facts).not.toHaveProperty("endpoint");
    expect(facts).toMatchObject({ note: BEARER });
    expect(isServableFact("note", BEARER, true)).toBe(false);
    expect(isServableFact("endpoint", DSN, true)).toBe(false);
    expect(isServableFact("region", "eu-west-1", true)).toBe(true);
  });

  it("reports an asynchronous config pending, then failed, then ready", async () => {
    let answer: (valid: boolean) => void = () => {};
    const make = acme({
      asyncConfig: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    });
    const configured = make(CONFIG);
    const id = `${make.definition.name}@1.0.0#1`;
    const h = api();
    expect(await listed(h, id)).toMatchObject({
      readiness: "pending",
      facts: {},
    });
    answer(false);
    await configured.ready.catch(() => {});
    expect(await listed(h, id)).toMatchObject({ readiness: "failed" });
    // Validated again (as `ready` is at the next attempt): pending while it
    // runs, ready once it passes.
    const again = configured.validate();
    expect(await listed(h, id)).toMatchObject({ readiness: "pending" });
    answer(true);
    await again;
    expect(await listed(h, id)).toMatchObject({
      readiness: "ready",
      facts: { region: "eu-west-1" },
    });
  });
});

describe("POST /providers/{id}/validate", () => {
  it("answers ok with the checks, redacted and capped", async () => {
    const make = acme({
      preflight: async (config) => [
        { id: "credentials", status: "pass" },
        {
          id: "cluster",
          status: "warn",
          detail: `reached ${config.dsn} with ${config.apiToken}; ${"x".repeat(300)}`,
        },
      ],
    });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0#1`;
    const h = api();
    const response = await h.call("POST", path(id, "/validate"));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id,
      ok: true,
      checks: [
        { id: "credentials", status: "pass" },
        { id: "cluster", status: "warn" },
      ],
    });
    expect(response.body.error).toBeUndefined();
    const detail: string = response.body.checks[1].detail;
    expect(detail.length).toBe(128);
    expect(detail.endsWith("…")).toBe(true);
    expect(detail).toContain("[REDACTED]");
    for (const secret of [TOKEN, "hunter2"]) {
      expect(response.text).not.toContain(secret);
    }
  });

  it("is not ok when a check fails, and says nothing of an error", async () => {
    const make = acme({
      preflight: async () => [
        { id: "credentials", status: "pass" },
        { id: "cluster-exists", status: "fail", detail: "no cluster jobs" },
      ],
    });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0#1`;
    const response = await api().call("POST", path(id, "/validate"), {});
    expect(response.body).toEqual({
      id,
      ok: false,
      checks: [
        { id: "credentials", status: "pass" },
        { id: "cluster-exists", status: "fail", detail: "no cluster jobs" },
      ],
    });
  });

  it("classifies a ProviderError by its kind, its platformCode redacted", async () => {
    for (const [kind, platformCode, detail] of [
      ["auth", "InvalidToken", "InvalidToken"],
      ["throttled", undefined, "PROVIDER_THROTTLED"],
      // A code-shaped declared secret passes the code rule: redacted by value.
      ["misconfigured", TOKEN, "[REDACTED]"],
    ] as const) {
      const make = acme({
        preflight: async () => {
          throw new ProviderError(`denied: ${TOKEN}`, kind, {
            ...(platformCode === undefined ? {} : { platformCode }),
            status: 403,
          });
        },
      });
      make(CONFIG);
      const id = `${make.definition.name}@1.0.0#1`;
      const response = await api().call("POST", path(id, "/validate"));
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id,
        ok: false,
        checks: [],
        error: { kind, detail },
      });
      expect(response.text).not.toContain(TOKEN);
    }
  });

  it("treats any other throw as transient, by its code or name, never its message", async () => {
    const make = acme({
      preflight: async () => {
        const error = new TypeError(`fetch failed for ${DSN}`);
        throw error;
      },
    });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0#1`;
    const response = await api().call("POST", path(id, "/validate"));
    expect(response.body).toEqual({
      id,
      ok: false,
      checks: [],
      error: { kind: "transient", detail: "TypeError" },
    });
    expect(response.text).not.toContain("hunter2");

    const coded = acme({
      preflight: async () => {
        throw Object.assign(new Error("socket hang up"), {
          code: "ECONNRESET",
        });
      },
    });
    coded(CONFIG);
    const codedId = `${coded.definition.name}@1.0.0#1`;
    expect(
      (await api().call("POST", path(codedId, "/validate"))).body.error,
    ).toEqual({ kind: "transient", detail: "ECONNRESET" });
  });

  it("tells an invalid config (misconfigured, naming the paths) from an unreachable platform", async () => {
    let calls = 0;
    const make = acme({
      asyncConfig: async () => false,
      preflight: async () => {
        calls++;
        return [];
      },
    });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0#1`;
    const response = await api().call("POST", path(id, "/validate"));
    expect(response.body).toEqual({
      id,
      ok: false,
      checks: [],
      error: { kind: "misconfigured", detail: "invalid config: region, dsn" },
    });
    // The preflight never ran against a config that did not validate, and
    // the issue's message — which echoed the token — is not served.
    expect(calls).toBe(0);
    expect(response.text).not.toContain(TOKEN);
  });

  it("times out as transient with detail timeout, and aborts the preflight's signal", async () => {
    let aborted = false;
    const make = acme({
      preflight: async (_config, signal) =>
        await new Promise<never>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0#1`;
    const started = Date.now();
    const response = await api().call("POST", path(id, "/validate"), {
      timeoutMs: 1_000,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.body).toEqual({
      id,
      ok: false,
      checks: [],
      error: { kind: "transient", detail: "timeout" },
    });
    expect(aborted).toBe(true);
  });

  it("refuses a timeout outside 1 s to 60 s", async () => {
    const make = acme({ preflight: async () => [] });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0#1`;
    const h = api();
    for (const timeoutMs of [999, 60_001]) {
      const response = await h.call("POST", path(id, "/validate"), {
        timeoutMs,
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION");
    }
  });

  it("answers ok with no checks for a provider without a preflight", async () => {
    const configured = acme()(CONFIG);
    const id = `${configured.provider.name}@1.0.0#1`;
    expect((await api().call("POST", path(id, "/validate"))).body).toEqual({
      id,
      ok: true,
      checks: [],
    });
  });

  it("is 404 PROVIDER_NOT_FOUND for an id no live provider has", async () => {
    const response = await api().call(
      "POST",
      path("bun-jobs-provider-nowhere@1.0.0#1", "/validate"),
    );
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("PROVIDER_NOT_FOUND");
  });
});

describe("GET /providers/{id}/schema", () => {
  it("answers the draft-2020-12 input schema, secret-free", async () => {
    const make = acme();
    const configured = make(CONFIG);
    const id = `${make.definition.name}@1.0.0#1`;
    const response = await api().call("GET", path(id, "/schema"));
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(id);
    expect(response.body.target).toBe("draft-2020-12");
    const schema = response.body.schema;
    // The converter was asked for draft-2020-12 (it echoes the target).
    expect(schema.target).toBe("draft-2020-12");
    // Not a secret: kept whole.
    expect(schema.properties.region).toMatchObject({
      default: "eu-west-1",
      enum: ["eu-west-1", "us-east-1"],
    });
    // A credential name and a declared secret path lose their values,
    // nested branches included; a credential name deeper down too.
    expect(schema.properties.apiToken).toEqual({ type: "string" });
    expect(schema.properties.dsn).toEqual({ anyOf: [{ type: "string" }] });
    expect(schema.properties.tuning.properties).toEqual({
      sessionCookie: { type: "string" },
      batch: { type: "integer", default: 10 },
    });
    // Every string redacted: the description's bearer token.
    expect(schema.properties.region.description).toContain("[REDACTED]");
    for (const secret of [TOKEN, "hunter2", "c-v-1", "abcdefghijklmnop"]) {
      expect({ secret, leaked: response.text.includes(secret) }).toEqual({
        secret,
        leaked: false,
      });
    }
    // Negative control: the converter really produced them.
    const raw = JSON.stringify(
      (
        make.definition.config as unknown as {
          "~standard": {
            jsonSchema: { input: (o: { target: string }) => unknown };
          };
        }
      )["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
    );
    expect(raw).toContain(TOKEN);
    expect(raw).toContain("hunter2");
    expect(configured.provider.name).toBe(make.definition.name);
  });

  it("is 404 PROVIDER_SCHEMA_NOT_FOUND without Standard JSON Schema, or when the converter fails", async () => {
    const bare = acme({ jsonSchema: false })(CONFIG);
    const throwing = acme({
      jsonSchema: () => {
        throw new Error(`no draft-2020-12 for ${TOKEN}`);
      },
    })(CONFIG);
    const h = api();
    for (const configured of [bare, throwing]) {
      const response = await h.call(
        "GET",
        path(`${configured.provider.name}@1.0.0#1`, "/schema"),
      );
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("PROVIDER_SCHEMA_NOT_FOUND");
      expect(response.text).not.toContain(TOKEN);
    }
    const unknown = await h.call("GET", path("nobody@0.0.0#9", "/schema"));
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("PROVIDER_NOT_FOUND");
  });
});

describe("the providers.read and providers.validate actions", () => {
  /** One request per provider route, for an id that exists. */
  function requests(id: string): [string, string][] {
    return [
      ["GET", "/providers"],
      ["POST", path(id, "/validate")],
      ["GET", path(id, "/schema")],
    ];
  }

  it("are both opt-in; validate alone is a mutation", () => {
    expect(JOBS_API_ACTIONS).toContain("providers.read");
    expect(JOBS_API_ACTIONS).toContain("providers.validate");
    expect(JOBS_API_OPT_IN_ACTIONS.has("providers.read")).toBe(true);
    expect(JOBS_API_OPT_IN_ACTIONS.has("providers.validate")).toBe(true);
    expect(JOBS_API_MUTATIONS.has("providers.read")).toBe(false);
    expect(JOBS_API_MUTATIONS.has("providers.validate")).toBe(true);
  });

  it("are off by default, and under readOnly's default set: every route 404", async () => {
    let calls = 0;
    const make = acme({
      preflight: async () => {
        calls++;
        return [];
      },
    });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0#1`;
    for (const overrides of [
      { actions: undefined },
      { actions: undefined, readOnly: true },
    ]) {
      const h = api(overrides);
      for (const [method, url] of requests(id)) {
        const response = await h.call(method, url);
        expect({ method, url, status: response.status }).toEqual({
          method,
          url,
          status: 404,
        });
        expect(response.body.code).toBe("ROUTE_NOT_FOUND");
      }
      const operations = h.api.routes.map((route) => route.operationId);
      for (const operation of [
        "listProviders",
        "validateProvider",
        "getProviderSchema",
      ]) {
        expect(operations).not.toContain(operation);
      }
      // Negative control: `/meta/permissions` knows no provider action.
      const permissions = await h.call("GET", "/meta/permissions");
      expect(permissions.body.actions).not.toHaveProperty("providers.read");
    }
    expect(calls).toBe(0);
  });

  it("are served once named; readOnly keeps the read and removes validate", async () => {
    const make = acme({ preflight: async () => [] });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0#1`;
    const named = api({ actions: WITH_PROVIDERS });
    for (const [method, url] of requests(id)) {
      expect({ url, status: (await named.call(method, url)).status }).toEqual({
        url,
        status: 200,
      });
    }
    const permissions = await named.call("GET", "/meta/permissions");
    expect(permissions.body.actions).toMatchObject({
      "providers.read": true,
      "providers.validate": true,
    });

    const readOnly = api({ actions: WITH_PROVIDERS, readOnly: true });
    expect((await readOnly.call("GET", "/providers")).status).toBe(200);
    expect((await readOnly.call("GET", path(id, "/schema"))).status).toBe(200);
    const validate = await readOnly.call("POST", path(id, "/validate"));
    expect(validate.status).toBe(404);
    expect(validate.body.code).toBe("ROUTE_NOT_FOUND");
  });

  it("asks authorize about each, and a denial is 403 that runs nothing", async () => {
    let calls = 0;
    const make = acme({
      preflight: async () => {
        calls++;
        return [];
      },
    });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0#1`;
    for (const [method, url] of requests(id)) {
      const action = url.endsWith("/validate")
        ? "providers.validate"
        : "providers.read";
      const refused = api({
        actions: WITH_PROVIDERS,
        authorize: (_req, context) => context.action !== action,
      });
      const denied = await refused.call(method, url);
      expect({ url, status: denied.status }).toEqual({ url, status: 403 });
      expect(denied.body.code).toBe("FORBIDDEN");
      expect(denied.text).not.toContain("eu-west-1");

      const allowed = api({ actions: WITH_PROVIDERS });
      expect((await allowed.call(method, url)).status).toBe(200);
      expect(allowed.calls.at(-1)).toEqual({
        action,
        mutation: action === "providers.validate",
        transport: "http",
        route: {
          method,
          path:
            url === "/providers"
              ? "/providers"
              : url.endsWith("/validate")
                ? "/providers/:id/validate"
                : "/providers/:id/schema",
        },
      });
    }
    // Only the allowed validate ran the preflight.
    expect(calls).toBe(1);
  });

  it("are served in jobs mode and pruned in runner mode, where features.providers is false", async () => {
    const jobs = api();
    const meta = await jobs.call("GET", "/meta");
    expect(meta.body.features.providers).toBe(true);
    // A flag says whether the routes exist here, not whether the caller may
    // use them: true without the actions too.
    const unnamed = api({ actions: undefined });
    expect((await unnamed.call("GET", "/meta")).body.features.providers).toBe(
      true,
    );

    const runner = api({ mode: "runner" });
    expect((await runner.call("GET", "/meta")).body.features.providers).toBe(
      false,
    );
    const pruned = await runner.call("GET", "/providers");
    expect(pruned.status).toBe(404);
    expect(pruned.body.code).toBe("ROUTE_NOT_FOUND");
  });

  it("are documented in the OpenAPI document, under Providers, with their errors", () => {
    const document = api().api.openapi() as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      tags: { name: string }[];
    };
    expect(document.tags.map((tag) => tag.name)).toContain("Providers");
    const list = document.paths["/providers"]!.get!;
    const validate = document.paths["/providers/{id}/validate"]!.post!;
    const schema = document.paths["/providers/{id}/schema"]!.get!;
    expect(list.operationId).toBe("listProviders");
    expect(validate.operationId).toBe("validateProvider");
    expect(schema.operationId).toBe("getProviderSchema");
    expect(Object.keys(validate.responses as object)).toContain("404");
    expect(Object.keys(schema.responses as object)).toContain("404");
    // Pruned with the action: absent from a default API's document.
    const unnamed = api({ actions: undefined }).api.openapi() as unknown as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(unnamed.paths)).not.toContain("/providers");
  });
});

describe("a summon status's providerId and readiness", () => {
  /** A context on the file driver with a controller for `work` on `summoner`. */
  function summoning(summoner: object) {
    const jobs = new BunJobs({
      namespace: testNamespace("api-providers"),
      driver: {
        type: "file",
        root: join(tmp.path, testNamespace("root")),
      },
      logger: noopLogger,
      summon: {
        work: {
          summoner: summoner as never,
          triggers: { onAdd: false, events: false, poll: false },
        },
      },
    });
    cleanups.push(async () => {
      await jobs.close();
    });
    return jobs;
  }

  it("names the configured instance, which the validate route takes", async () => {
    const make = acme({
      preflight: async () => [{ id: "credentials", status: "pass" }],
    });
    const configured = make(CONFIG);
    const jobs = summoning(configured);
    const h = api({ jobs });
    const status = await h.call("GET", "/queues/work/summon");
    expect(status.status).toBe(200);
    const id = `${make.definition.name}@1.0.0#1`;
    expect(status.body.summoner).toMatchObject({
      providerId: id,
      readiness: "ready",
      capabilities: { style: "launch" },
      facts: { region: "eu-west-1" },
    });
    expect(status.text).not.toContain(TOKEN);
    const validated = await h.call(
      "POST",
      path(status.body.summoner.providerId, "/validate"),
    );
    expect(validated.body).toMatchObject({ id, ok: true });
  });

  it("traces a spread copy to its instance, and leaves a validate run's controller untouched", async () => {
    let answer: (valid: boolean) => void = () => {};
    const make = acme({
      asyncConfig: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
      preflight: async () => [],
    });
    const configured = make(CONFIG);
    const id = `${make.definition.name}@1.0.0#1`;
    const jobs = summoning({ ...configured });
    const h = api({ jobs });
    const pending = await h.call("GET", "/queues/work/summon");
    expect(pending.body.summoner).toEqual({
      provider: expect.objectContaining({ kind: "acme" }),
      providerId: id,
      readiness: "pending",
      facts: {},
    });

    answer(false);
    await configured.ready.catch(() => {});
    const failed = await h.call("GET", "/queues/work/summon");
    expect(failed.body.summoner.readiness).toBe("failed");
    expect(failed.body.summoner.capabilities).toBeUndefined();

    // A preflight validates the config again and answers; the controller's
    // shared state — failures, backoff, attempts, last — is what it was.
    const before = { ...failed.body };
    delete before.summoner;
    const validating = h.call("POST", path(id, "/validate"));
    await Bun.sleep(20);
    answer(true);
    expect((await validating).body).toEqual({ id, ok: true, checks: [] });
    const after = await h.call("GET", "/queues/work/summon");
    const { summoner, ...rest } = after.body;
    expect(rest).toEqual(before);
    // The provider's config is now known, so the controller adopts it on
    // its next look, as it would have at its next attempt.
    expect(summoner.readiness).toBe("ready");
  });
});
