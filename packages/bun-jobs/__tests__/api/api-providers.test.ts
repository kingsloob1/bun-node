import type {
  JobsApiAuthorizeContext,
  JobsApiConfig,
} from "../../lib/api/config";
import type {
  ProviderCheck,
  SummonCapabilities,
  SummonFacet,
} from "../../lib/provider/index";
import { join } from "node:path";
import {
  BunRouter,
  createTestLogger,
  noopLogger,
} from "@kingsleyweb/bun-common";
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
import { createJobsApi } from "../../lib/api/createJobsApi";
import { PROVIDER_VALIDATE_REUSE_MS } from "../../lib/api/routes/providers";
import { isServableFact } from "../../lib/api/serialize";
import { BunJobs } from "../../lib/index";
import {
  COMPUTE_PROVIDER_API,
  defineComputeProvider,
  ProviderError,
  toStandardSchema,
} from "../../lib/provider/index";
import {
  configuredProvider,
  configuredProviders,
} from "../../lib/provider/registry";
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
  const provider = defineComputeProvider({
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
  // Every instance is held for the file's life: the registry holds them
  // weakly, and an instance a case dropped could be collected mid-case.
  return Object.assign((config: AcmeConfig) => held(provider(config)), {
    definition: provider.definition,
  });
}

/**
 * The definition's own factory, unwrapped: an instance it makes is not held
 * by the test, for the weak-holding case.
 */
function defineComputeProviderAgain(
  make: ReturnType<typeof acme>,
): (config: AcmeConfig) => unknown {
  return defineComputeProvider(make.definition as never) as never;
}

/** Every configured instance a case made, held so the registry keeps it. */
const HELD: unknown[] = [];

/** Holds `value` for the rest of the file, and returns it. */
function held<T>(value: T): T {
  HELD.push(value);
  return value;
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
      `${name}@1.0.0~1`,
      `${name}@1.0.0~2`,
      `${name}@2.0.0~1`,
    ]);
    // Stable: the same instance under the same id on every read.
    expect(configuredProvider(`${name}@1.0.0~2`)?.configured).toBe(second);
    expect(configuredProvider(`${name}@1.0.0~1`)?.configured).toBe(first);
    expect(configuredProvider(`${name}@2.0.0~1`)?.configured).toBe(other);
  });

  it("answers identity, readiness, secret-free facts, preflight and configSchema", async () => {
    const make = acme({ preflight: async () => [] });
    make(CONFIG);
    const bare = acme({ jsonSchema: false })(CONFIG);
    const h = api();
    const id = `${make.definition.name}@1.0.0~1`;
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
    const bareEntry = await listed(h, `${bare.provider.name}@1.0.0~1`);
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

  it("lists a provider whose describe() throws with no facts, keeps the rest, and logs no secret", async () => {
    const SECRET = "tok_live_SECRET_abcdef12345";
    const broken = defineComputeProvider({
      name: `bun-jobs-provider-throws-${++unique}`,
      version: "1.0.0",
      kind: "broken",
      apiVersion: { core: "0.1", summon: "0.1" },
      secrets: ["apiToken"],
      describe: (config: { apiToken: string }) => {
        throw new Error(`cannot describe endpoint for ${config.apiToken}`);
      },
      summon: (): SummonFacet => ({
        capabilities: CAPABILITIES,
        summon: async () => ({ status: "started", handles: [] }),
      }),
    });
    const bad = held(broken({ apiToken: SECRET }));
    const good = acme()(CONFIG);
    const h = api();
    const response = await h.call("GET", "/providers");
    expect(response.status).toBe(200);
    const byId = new Map(
      (response.body.providers as { id: string; facts: object }[]).map(
        (provider) => [provider.id, provider],
      ),
    );
    expect(byId.get(`${bad.provider.name}@1.0.0~1`)).toMatchObject({
      readiness: "ready",
      facts: {},
    });
    expect(byId.get(`${good.provider.name}@1.0.0~1`)?.facts).toMatchObject({
      region: "eu-west-1",
    });
    // Every held provider whose describe() throws is logged: this one once.
    const logged = h.events.filter(
      (event) =>
        event.message.includes("describe() threw") &&
        event.fields?.provider === `${bad.provider.name}@1.0.0~1`,
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]!.fields).toMatchObject({
      provider: `${bad.provider.name}@1.0.0~1`,
      thrown: "Error",
    });
    expect(JSON.stringify(h.events)).not.toContain(SECRET);
    // Negative control: it really throws, with the secret in the message.
    expect(() => bad.describe()).toThrow(SECRET);
  });

  it("holds its entries weakly: a dropped instance leaves the list, a held one stays", async () => {
    const make = acme();
    const name = make.definition.name;
    const kept = make(CONFIG);
    // Made and dropped in a frame of their own, so nothing on this stack
    // keeps one alive. Not held: `make` holds every instance, so these go
    // through the definition's own factory.
    (() => {
      for (let i = 0; i < 20; i++) {
        defineComputeProviderAgain(make)(CONFIG);
      }
    })();
    const ours = () =>
      configuredProviders()
        .map((entry) => entry.id)
        .filter((id) => id.startsWith(`${name}@`));
    expect(ours()).toHaveLength(21);
    for (let round = 0; round < 20 && ours().length > 1; round++) {
      Bun.gc(true);
      await Bun.sleep(10);
    }
    // Most dropped ones are gone (a conservative scan may keep a few), and
    // the held one never is. A registry holding strongly would keep all 21.
    expect(ours().length).toBeLessThan(11);
    expect(ours()).toContain(`${name}@1.0.0~1`);
    expect(configuredProvider(`${name}@1.0.0~1`)?.configured).toBe(kept);
    // Ids are never reused: the next instance is the 22nd.
    const next = make(CONFIG);
    expect(configuredProvider(`${name}@1.0.0~22`)?.configured).toBe(next);
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
    const id = `${make.definition.name}@1.0.0~1`;
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
    const id = `${make.definition.name}@1.0.0~1`;
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
    const id = `${make.definition.name}@1.0.0~1`;
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
      const id = `${make.definition.name}@1.0.0~1`;
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
    const id = `${make.definition.name}@1.0.0~1`;
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
    const codedId = `${coded.definition.name}@1.0.0~1`;
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
    const id = `${make.definition.name}@1.0.0~1`;
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
    const id = `${make.definition.name}@1.0.0~1`;
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
    const id = `${make.definition.name}@1.0.0~1`;
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
    const id = `${configured.provider.name}@1.0.0~1`;
    expect((await api().call("POST", path(id, "/validate"))).body).toEqual({
      id,
      ok: true,
      checks: [],
    });
  });

  it("is 404 PROVIDER_NOT_FOUND for an id no live provider has", async () => {
    const response = await api().call(
      "POST",
      path("bun-jobs-provider-nowhere@1.0.0~1", "/validate"),
    );
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("PROVIDER_NOT_FOUND");
  });
});

describe("POST /providers/{id}/validate, more", () => {
  it("reports a facet build that threw a plain Error as misconfigured, not transient", async () => {
    const make = defineComputeProvider({
      name: `bun-jobs-provider-build-throws-${++unique}`,
      version: "1.0.0",
      kind: "build",
      apiVersion: { core: "0.1", summon: "0.1" },
      config: toStandardSchema<{ apiToken: string }>(async (input) => ({
        value: input as { apiToken: string },
      })),
      secrets: ["apiToken"],
      validate: async () => [],
      summon: (config): SummonFacet => {
        throw new TypeError(`cannot read x of ${config.apiToken}`);
      },
    });
    const configured = held(make({ apiToken: TOKEN }));
    const rejected = await configured.ready.then(
      () => undefined,
      (error: unknown) => error,
    );
    const id = `${configured.provider.name}@1.0.0~1`;
    // The kept build error is the redacted copy (#250): same class, no
    // secret, and the very error `ready` rejected with.
    const kept = configuredProvider(id)!.buildError();
    expect(kept).toBeInstanceOf(TypeError);
    expect(kept).toBe(rejected);
    expect(String((kept as Error).message)).toContain("cannot read x of");
    expect(String((kept as Error).message)).not.toContain(TOKEN);
    const h = api();
    expect(await listed(h, id)).toMatchObject({ readiness: "failed" });
    const response = await h.call("POST", path(id, "/validate"));
    expect(response.body).toEqual({
      id,
      ok: false,
      checks: [],
      error: { kind: "misconfigured", detail: "TypeError" },
    });
    expect(response.text).not.toContain(TOKEN);
    // Negative control: the same TypeError thrown by the preflight itself,
    // with the facets built, is the platform's: transient.
    const control = acme({
      preflight: async () => {
        throw new TypeError("cannot read x");
      },
    });
    control(CONFIG);
    const controlId = `${control.definition.name}@1.0.0~1`;
    expect(
      (await h.call("POST", path(controlId, "/validate"))).body.error,
    ).toEqual({ kind: "transient", detail: "TypeError" });
  });

  it("shares one run between concurrent requests, and reuses its verdict for 5 s", async () => {
    let runs = 0;
    let release: () => void = () => {};
    const make = acme({
      preflight: async () => {
        runs++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [{ id: "credentials", status: "pass" }];
      },
    });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0~1`;
    const h = api();
    const first = h.call("POST", path(id, "/validate"));
    const second = h.call("POST", path(id, "/validate"));
    await Bun.sleep(30);
    expect(runs).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.body).toEqual(b.body);
    expect(a.body.ok).toBe(true);
    // Answered again from the completed run, within 5 s.
    const third = await h.call("POST", path(id, "/validate"));
    expect(third.body).toEqual(a.body);
    expect(runs).toBe(1);
    // Every request is still authorized.
    expect(
      h.calls.filter((call) => call.action === "providers.validate"),
    ).toHaveLength(3);
  });

  it("runs again once 5 s have passed", async () => {
    let runs = 0;
    const make = acme({
      preflight: async () => {
        runs++;
        return [];
      },
    });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0~1`;
    const h = api();
    const realNow = Date.now;
    try {
      await h.call("POST", path(id, "/validate"));
      expect(runs).toBe(1);
      const start = realNow();
      Date.now = () => start + PROVIDER_VALIDATE_REUSE_MS + 1;
      await h.call("POST", path(id, "/validate"));
      expect(runs).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("never shares between two instances of one name@version: a new config gets its own verdict", async () => {
    let fail = false;
    const make = acme({
      preflight: async () => [
        { id: "credentials", status: fail ? "fail" : "pass" },
      ],
    });
    make(CONFIG);
    make(CONFIG);
    const one = `${make.definition.name}@1.0.0~1`;
    const two = `${make.definition.name}@1.0.0~2`;
    const h = api();
    expect((await h.call("POST", path(one, "/validate"))).body.ok).toBe(true);
    fail = true;
    // The second instance runs its own preflight, within the first's 5 s.
    expect((await h.call("POST", path(two, "/validate"))).body.ok).toBe(false);
    // Negative control: the first is still answered from its own run.
    expect((await h.call("POST", path(one, "/validate"))).body.ok).toBe(true);
  });

  it("serves a timeout to the requests that shared the run, and never reuses it", async () => {
    let runs = 0;
    let hang = true;
    const make = acme({
      preflight: async (_config, signal) => {
        runs++;
        if (!hang) {
          return [];
        }
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      },
    });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0~1`;
    const h = api();
    const [a, b] = await Promise.all([
      h.call("POST", path(id, "/validate"), { timeoutMs: 1_000 }),
      h.call("POST", path(id, "/validate"), { timeoutMs: 60_000 }),
    ]);
    expect(runs).toBe(1);
    for (const response of [a, b]) {
      expect(response.body.error).toEqual({
        kind: "transient",
        detail: "timeout",
      });
    }
    hang = false;
    const again = await h.call("POST", path(id, "/validate"));
    expect(runs).toBe(2);
    expect(again.body).toEqual({ id, ok: true, checks: [] });
  });

  it("takes an unencoded id with @, : and ~ through a real served request", async () => {
    // `~` rather than `#`: a `#` would start a URL fragment and never reach
    // the server. A defineSummoner-style name, `custom:<kind>`, holds a `:`.
    const make = defineComputeProvider({
      name: `custom:served-${++unique}`,
      version: "0.0.0",
      kind: "served",
      apiVersion: { core: "0.1", summon: "0.1" },
      validate: async () => [{ id: "credentials", status: "pass" }],
      summon: (): SummonFacet => ({
        capabilities: CAPABILITIES,
        summon: async () => ({ status: "started", handles: [] }),
      }),
    });
    const configured = held(make({}));
    const id = `${configured.provider.name}@0.0.0~1`;
    const jobs = new BunJobs({ namespace: testNamespace("api-providers") });
    cleanups.push(async () => {
      await jobs.close();
    });
    const served = createJobsApi({
      jobs,
      basePath: "/admin/jobs",
      authorize: () => true,
      logger: noopLogger,
      actions: WITH_PROVIDERS,
    });
    const root = new BunRouter();
    root.use(served.basePath, served.router);
    const server = Bun.serve({ port: 0, fetch: (req) => root.fetch(req) });
    try {
      const url = `http://127.0.0.1:${server.port}/admin/jobs/providers/${id}/validate`;
      // Sent as written: nothing encoded.
      expect(url).toContain(`/${id}/`);
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id,
        ok: true,
        checks: [{ id: "credentials", status: "pass" }],
      });
      const schema = await fetch(
        `http://127.0.0.1:${server.port}/admin/jobs/providers/${id}/schema`,
      );
      // Routed to this provider: it has no JSON Schema, which is its own 404.
      expect(((await schema.json()) as { code: string }).code).toBe(
        "PROVIDER_SCHEMA_NOT_FOUND",
      );
    } finally {
      server.stop(true);
      await served.close();
    }
  });
});

describe("GET /providers/{id}/schema", () => {
  it("answers the draft-2020-12 input schema, secret-free", async () => {
    const make = acme();
    const configured = make(CONFIG);
    const id = `${make.definition.name}@1.0.0~1`;
    const response = await api().call("GET", path(id, "/schema"));
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(id);
    expect(response.body.target).toBe("draft-2020-12");
    const schema = response.body.schema;
    // The converter was asked for draft-2020-12 (it echoes the target).
    expect(schema.target).toBe("draft-2020-12");
    // Value keywords go everywhere, a secret or not: no default is served.
    // A non-secret keeps its allowed choices.
    expect(schema.properties.region).toEqual({
      type: "string",
      enum: ["eu-west-1", "us-east-1"],
      description: expect.any(String),
    });
    expect(schema.properties.apiToken).toEqual({ type: "string" });
    expect(schema.properties.dsn).toEqual({ anyOf: [{ type: "string" }] });
    expect(schema.properties.tuning.properties).toEqual({
      sessionCookie: { type: "string" },
      batch: { type: "integer" },
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

  it("serves no value keyword anywhere: $defs, an object-level default, allOf, example, x-*, a numeric secret", async () => {
    // A host's own secret baked into the schema, not the configured one:
    // redaction by value cannot know it, so only removing the keywords can
    // keep it out (the reviewer's five probes, plus x-*).
    const HOST = "tok_live_HOSTENV_1234567";
    const PIN = 918273;
    const document = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      default: { region: "eu", apiToken: HOST },
      "x-default-token": HOST,
      properties: {
        region: { type: "string", example: HOST },
        dsn: { $ref: "#/$defs/Token" },
        pin: { $ref: "#/$defs/Pin" },
        mode: { type: "string", enum: ["a", "b"], const: "a" },
        // A property named like a keyword is a name, and stays.
        default: { type: "string", examples: [HOST] },
      },
      allOf: [{ properties: { dsn: { type: "string", default: HOST } } }],
      $defs: {
        Token: { type: "string", default: HOST, "x-example": HOST },
        Pin: { type: "number", default: PIN, maximum: PIN },
      },
    };
    const make = acme({ jsonSchema: () => document });
    const configured = make({ ...CONFIG, pin: PIN } as AcmeConfig);
    const response = await api().call(
      "GET",
      path(`${configured.provider.name}@1.0.0~1`, "/schema"),
    );
    expect(response.status).toBe(200);
    expect(response.body.schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        region: { type: "string" },
        dsn: { $ref: "#/$defs/Token" },
        pin: { $ref: "#/$defs/Pin" },
        mode: { type: "string", enum: ["a", "b"] },
        default: { type: "string" },
      },
      allOf: [{ properties: { dsn: { type: "string" } } }],
      // A number equal to no declared secret stays: `pin` is not declared.
      $defs: {
        Token: { type: "string" },
        Pin: { type: "number", maximum: PIN },
      },
    });
    expect(response.text).not.toContain(HOST);
    // Negative control: the document held it, in every one of those places.
    expect(JSON.stringify(document).split(HOST).length - 1).toBe(7);
  });

  it("drops a number and replaces a string equal to a declared secret, wherever they are", async () => {
    // `apiToken` is short here: under the 8 characters redaction by value
    // needs, so only exact equality can catch it.
    const short = "k-42";
    const make = acme({
      jsonSchema: () => ({
        type: "object",
        properties: {
          level: { type: "integer", enum: [1, 4242, 7], maximum: 4242 },
          choice: { type: "string", enum: ["a", short] },
        },
      }),
    });
    const configured = make({ ...CONFIG, apiToken: short, dsn: "4242" });
    const response = await api().call(
      "GET",
      path(`${configured.provider.name}@1.0.0~1`, "/schema"),
    );
    expect(response.body.schema.properties).toEqual({
      level: { type: "integer", enum: [1, 7] },
      choice: { type: "string", enum: ["a", "[REDACTED]"] },
    });
    // Negative control: another instance whose secrets are other values
    // keeps both, so it is the equality that removed them.
    const other = make(CONFIG);
    const control = await api().call(
      "GET",
      path(`${other.provider.name}@1.0.0~2`, "/schema"),
    );
    expect(control.body.schema.properties).toEqual({
      level: { type: "integer", enum: [1, 4242, 7], maximum: 4242 },
      choice: { type: "string", enum: ["a", short] },
    });
  });

  /** The served schema for a provider whose converter answers `document`. */
  async function served(
    document: unknown,
    config: AcmeConfig = CONFIG,
  ): Promise<Record<string, any>> {
    const make = acme({ jsonSchema: () => document });
    const configured = make(config);
    const response = await api().call(
      "GET",
      path(`${configured.provider.name}@1.0.0~1`, "/schema"),
    );
    expect(response.status).toBe(200);
    return response.body.schema;
  }

  /** Two host values baked into an enum: neither is the configured secret's. */
  const HOST_CHOICES = ["tok_live_HOSTENV_1234567", "tok_live_OTHER_HOST_77"];

  it("drops the enum of a definition a secret property reaches through $ref (zod's .meta({ id }))", async () => {
    // Exactly what zod 4 answers for
    // `z.object({ region: z.string(), dsn: z.enum([...]).meta({ id: "Choice" }) })`.
    const schema = await served(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          region: { type: "string" },
          dsn: { $ref: "#/$defs/Choice" },
        },
        required: ["region", "dsn"],
        $defs: { Choice: { type: "string", enum: HOST_CHOICES } },
      },
      // Configured with the second value: redaction by value hides only it.
      { ...CONFIG, dsn: HOST_CHOICES[1]! },
    );
    expect(schema.$defs).toEqual({ Choice: { type: "string" } });
    expect(JSON.stringify(schema)).not.toContain(HOST_CHOICES[0]);
  });

  it("follows a chain of $refs, through definitions and #/definitions with JSON-pointer escapes", async () => {
    const schema = await served({
      type: "object",
      properties: { apiToken: { $ref: "#/$defs/Outer" } },
      $defs: {
        Outer: {
          type: "object",
          properties: { inner: { $ref: "#/$defs/a~1b~0c" } },
        },
        "a/b~c": { allOf: [{ $ref: "#/definitions/Leaf" }] },
      },
      definitions: { Leaf: { type: "string", enum: HOST_CHOICES } },
    });
    expect(schema.definitions).toEqual({ Leaf: { type: "string" } });
    expect(schema.$defs["a/b~c"]).toEqual({
      allOf: [{ $ref: "#/definitions/Leaf" }],
    });
    expect(JSON.stringify(schema)).not.toContain(HOST_CHOICES[0]);
  });

  it("follows a $ref reached through anyOf under a secret", async () => {
    const schema = await served({
      type: "object",
      properties: {
        dsn: { anyOf: [{ type: "null" }, { $ref: "#/$defs/Choice" }] },
      },
      $defs: { Choice: { type: "string", enum: HOST_CHOICES } },
    });
    expect(schema.$defs).toEqual({ Choice: { type: "string" } });
  });

  it("flags a definition a credential-named property inside another definition reaches", async () => {
    const schema = await served({
      type: "object",
      properties: { connection: { $ref: "#/$defs/Connection" } },
      $defs: {
        Connection: {
          type: "object",
          properties: {
            host: { type: "string", enum: ["db-a", "db-b"] },
            password: { $ref: "#/$defs/Choice" },
          },
        },
        Choice: { type: "string", enum: HOST_CHOICES },
      },
    });
    // The non-secret definition keeps its own choices; the one its
    // `password` reaches loses them.
    expect(schema.$defs.Connection.properties.host.enum).toEqual([
      "db-a",
      "db-b",
    ]);
    expect(schema.$defs.Choice).toEqual({ type: "string" });
  });

  it("drops an enum holding any non-scalar value, even under no secret", async () => {
    const schema = await served({
      type: "object",
      properties: {
        profile: {
          type: "object",
          enum: [{ region: "eu", apiToken: HOST_CHOICES[0] }],
        },
        mixed: { enum: ["a", ["b"]] },
        // Negative control: an all-scalar enum on a plain property stays.
        plain: { enum: ["a", 1, true, null] },
      },
    });
    expect(schema.properties).toEqual({
      profile: { type: "object" },
      mixed: {},
      plain: { enum: ["a", 1, true, null] },
    });
    expect(JSON.stringify(schema)).not.toContain(HOST_CHOICES[0]);
  });

  it("flags a whole definition a pointer into it reaches, escapes decoded", async () => {
    const schema = await served({
      type: "object",
      properties: {
        dsn: { $ref: "#/$defs/Wr~1ap/properties/inner" },
        region: { $ref: "#/definitions/Plain/properties/zone" },
      },
      $defs: {
        "Wr/ap": {
          type: "object",
          properties: {
            inner: { type: "string", enum: HOST_CHOICES },
            other: { type: "string", enum: ["x", "y"] },
          },
        },
      },
      definitions: {
        // Negative control: a pointer from a plain property flags nothing.
        Plain: {
          type: "object",
          properties: { zone: { type: "string", enum: ["a", "b"] } },
        },
      },
    });
    // The whole of Wr/ap, fail closed: the pointed-at enum and its sibling.
    expect(schema.$defs["Wr/ap"].properties).toEqual({
      inner: { type: "string" },
      other: { type: "string" },
    });
    expect(schema.definitions.Plain.properties.zone.enum).toEqual(["a", "b"]);
    expect(JSON.stringify(schema)).not.toContain(HOST_CHOICES[0]);
  });

  it("flags the whole document when a secret points at the root or at any other local path", async () => {
    for (const ref of ["#", "#/properties/region"]) {
      const schema = await served({
        type: "string",
        enum: HOST_CHOICES,
        properties: {
          region: { type: "string", enum: ["eu", "us"] },
          dsn: { $ref: ref },
        },
        $defs: { Any: { type: "string", enum: ["p", "q"] } },
      });
      expect({ ref, schema }).toEqual({
        ref,
        schema: {
          type: "string",
          properties: {
            region: { type: "string" },
            dsn: { $ref: ref },
          },
          $defs: { Any: { type: "string" } },
        },
      });
    }
    // Negative control: the same pointer from a plain property flags nothing.
    const plain = await served({
      type: "string",
      enum: ["eu", "us"],
      properties: { backup: { $ref: "#" } },
    });
    expect(plain.enum).toEqual(["eu", "us"]);
  });

  it("keeps the enum of a definition reached only from non-secret properties", async () => {
    const schema = await served({
      type: "object",
      properties: {
        region: { $ref: "#/$defs/Region" },
        backup: { anyOf: [{ $ref: "#/$defs/Region" }] },
      },
      $defs: { Region: { type: "string", enum: ["eu-west-1", "us-east-1"] } },
    });
    expect(schema.$defs).toEqual({
      Region: { type: "string", enum: ["eu-west-1", "us-east-1"] },
    });
  });

  it("fails closed: a definition reached from both a secret and a non-secret property loses its enum", async () => {
    const schema = await served({
      type: "object",
      properties: {
        region: { $ref: "#/$defs/Choice" },
        apiToken: { $ref: "#/$defs/Choice" },
      },
      $defs: { Choice: { type: "string", enum: HOST_CHOICES } },
    });
    expect(schema.$defs).toEqual({ Choice: { type: "string" } });
  });

  it("replaces a string equal to a declared secret in any of its encoded forms", async () => {
    // Short (under the 8 characters redaction by value needs), so only exact
    // equality can catch it; and URL-encoded in the schema, as a form writes it.
    const short = "k 4/2";
    const make = acme({
      jsonSchema: () => ({
        type: "object",
        properties: {
          choice: {
            type: "string",
            enum: ["a", encodeURIComponent(short), "k+4%2F2"],
          },
        },
      }),
    });
    const configured = make({ ...CONFIG, apiToken: short });
    const response = await api().call(
      "GET",
      path(`${configured.provider.name}@1.0.0~1`, "/schema"),
    );
    expect(response.body.schema.properties.choice.enum).toEqual([
      "a",
      "[REDACTED]",
      "[REDACTED]",
    ]);
    // Negative control: an instance whose secret is another value keeps them.
    const other = make(CONFIG);
    const control = await api().call(
      "GET",
      path(`${other.provider.name}@1.0.0~2`, "/schema"),
    );
    expect(control.body.schema.properties.choice.enum).toEqual([
      "a",
      "k%204%2F2",
      "k+4%2F2",
    ]);
  });

  it("drops enum under a secret property and everything nested in it, and nowhere else", async () => {
    const nested = {
      type: "object",
      properties: { tier: { type: "string", enum: ["gold", "silver"] } },
    };
    const make = acme({
      jsonSchema: () => ({
        type: "object",
        properties: {
          // A declared secret path, reached through a combinator.
          dsn: { anyOf: [nested] },
          // A credential name.
          sessionConfig: nested,
          // Neither: the negative control, the same subtree kept whole.
          plain: nested,
        },
      }),
    });
    const configured = make(CONFIG);
    const schema = (
      await api().call(
        "GET",
        path(`${configured.provider.name}@1.0.0~1`, "/schema"),
      )
    ).body.schema;
    const stripped = {
      type: "object",
      properties: { tier: { type: "string" } },
    };
    expect(schema.properties.dsn).toEqual({ anyOf: [stripped] });
    expect(schema.properties.sessionConfig).toEqual(stripped);
    expect(schema.properties.plain).toEqual(nested);
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
        path(`${configured.provider.name}@1.0.0~1`, "/schema"),
      );
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("PROVIDER_SCHEMA_NOT_FOUND");
      expect(response.text).not.toContain(TOKEN);
    }
    const unknown = await h.call("GET", path("nobody@0.0.0~9", "/schema"));
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("PROVIDER_NOT_FOUND");
  });
});

describe("/meta/permissions previews the provider actions untargeted", () => {
  /** The provider actions' entries of a permissions map. */
  function providerEntries(actions: Record<string, boolean>) {
    return {
      "providers.read": actions["providers.read"],
      "providers.validate": actions["providers.validate"],
    };
  }

  /** Every call `authorize` saw, and a harness deciding by `decide`. */
  function scoped(decide: (context: JobsApiAuthorizeContext) => boolean): {
    h: ReturnType<typeof api>;
    calls: JobsApiAuthorizeContext[];
  } {
    const calls: JobsApiAuthorizeContext[] = [];
    const h = api({
      actions: WITH_PROVIDERS,
      authorize: (_req, context) => {
        calls.push(context);
        return decide(context);
      },
    });
    return { h, calls };
  }

  it("names no queue for providers.*, so a queue-scoped authorize agrees with the real route", async () => {
    const make = acme({ preflight: async () => [] });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0~1`;
    // Refuses the provider actions whenever a queue is named, as a host that
    // scopes by queue and knows providers name none.
    const { h, calls } = scoped(
      (context) =>
        !context.action.startsWith("providers.") || context.queue === undefined,
    );
    const preview = await h.call("GET", "/meta/permissions?queue=mail");
    expect(providerEntries(preview.body.actions)).toEqual({
      "providers.read": true,
      "providers.validate": true,
    });
    const previewed = calls.filter((call) =>
      call.action.startsWith("providers."),
    );
    expect(previewed.every((call) => call.queue === undefined)).toBe(true);
    // A queue-side action still names the queue in the same preview.
    expect(calls.find((call) => call.action === "queues.read")?.queue).toBe(
      "mail",
    );
    // And the real route agrees.
    expect((await h.call("POST", path(id, "/validate"))).status).toBe(200);
  });

  it("reports providers.validate denied in the queue preview when untargeted calls are refused", async () => {
    const make = acme({ preflight: async () => [] });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0~1`;
    const { h } = scoped(
      (context) =>
        context.action !== "providers.validate" || context.queue !== undefined,
    );
    const preview = await h.call("GET", "/meta/permissions?queue=mail");
    expect(preview.body.actions["providers.validate"]).toBe(false);
    expect((await h.call("POST", path(id, "/validate"))).status).toBe(403);
  });

  it("answers the same for providers.* with and without ?queue=, and as the routes do", async () => {
    const make = acme({ preflight: async () => [] });
    make(CONFIG);
    const id = `${make.definition.name}@1.0.0~1`;
    // Per queue: everything for "mail", nothing for another queue; and,
    // untargeted, reading providers but not validating them.
    const { h } = scoped((context) => {
      if (context.queue === "mail") {
        return true;
      }
      if (context.queue !== undefined) {
        return false;
      }
      return context.action !== "providers.validate";
    });
    const untargeted = providerEntries(
      (await h.call("GET", "/meta/permissions")).body.actions,
    );
    for (const queue of ["mail", "audit"]) {
      const previewed = providerEntries(
        (await h.call("GET", `/meta/permissions?queue=${queue}`)).body.actions,
      );
      expect({ queue, previewed }).toEqual({ queue, previewed: untargeted });
    }
    expect(untargeted).toEqual({
      "providers.read": true,
      "providers.validate": false,
    });
    // What the routes do.
    expect((await h.call("GET", "/providers")).status).toBe(200);
    expect((await h.call("GET", path(id, "/schema"))).status).toBe(200);
    expect((await h.call("POST", path(id, "/validate"))).status).toBe(403);
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
    const id = `${make.definition.name}@1.0.0~1`;
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
    const id = `${make.definition.name}@1.0.0~1`;
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
    const id = `${make.definition.name}@1.0.0~1`;
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
      const pattern =
        url === "/providers"
          ? "/providers"
          : url.endsWith("/validate")
            ? "/providers/:id/validate"
            : "/providers/:id/schema";
      // The request's own call comes first: the list's names no provider,
      // the two targeted routes name theirs.
      expect(allowed.calls[0]).toEqual({
        action,
        mutation: action === "providers.validate",
        transport: "http",
        route: { method, path: pattern },
        ...(url === "/providers" ? {} : { provider: id }),
      });
    }
    // Only the allowed validate ran the preflight.
    expect(calls).toBe(1);
  });

  it("lists only the providers authorize allows, each asked with its id and its own read's route", async () => {
    const make = acme();
    const shown = make(CONFIG);
    const hidden = make(CONFIG);
    const shownId = `${make.definition.name}@1.0.0~1`;
    const hiddenId = `${make.definition.name}@1.0.0~2`;
    const calls: JobsApiAuthorizeContext[] = [];
    const h = api({
      actions: WITH_PROVIDERS,
      authorize: (_req, context) => {
        calls.push(context);
        return context.provider !== hiddenId;
      },
    });
    const response = await h.call("GET", "/providers");
    expect(response.status).toBe(200);
    const ids = (response.body.providers as { id: string }[]).map(
      (provider) => provider.id,
    );
    expect(ids).toContain(shownId);
    expect(ids).not.toContain(hiddenId);
    // One call for the request, then one per provider in the process, each
    // shaped like that provider's own read.
    expect(calls[0]).toEqual({
      action: "providers.read",
      mutation: false,
      transport: "http",
      route: { method: "GET", path: "/providers" },
    });
    const perEntry = calls.slice(1);
    expect(perEntry.find((call) => call.provider === hiddenId)).toEqual({
      action: "providers.read",
      mutation: false,
      transport: "http",
      provider: hiddenId,
      route: { method: "GET", path: "/providers/:id/schema" },
    });
    expect(perEntry.every((call) => call.provider !== undefined)).toBe(true);
    // And the same rule on the provider's own routes.
    expect((await h.call("GET", path(hiddenId, "/schema"))).status).toBe(403);
    expect((await h.call("GET", path(shownId, "/schema"))).status).toBe(200);
    // Negative control: an authorize that allows everything lists both.
    const all = await api({ actions: WITH_PROVIDERS }).call(
      "GET",
      "/providers",
    );
    const every = (all.body.providers as { id: string }[]).map((p) => p.id);
    expect(every).toContain(hiddenId);
    expect([shown, hidden]).toHaveLength(2);
  });

  it("scopes Test connection by provider: authorize sees the id and can refuse one instance", async () => {
    let runs = 0;
    const make = acme({
      preflight: async () => {
        runs++;
        return [];
      },
    });
    make(CONFIG);
    make(CONFIG);
    const mine = `${make.definition.name}@1.0.0~1`;
    const theirs = `${make.definition.name}@1.0.0~2`;
    const calls: JobsApiAuthorizeContext[] = [];
    const h = api({
      actions: WITH_PROVIDERS,
      authorize: (_req, context) => {
        calls.push(context);
        return (
          context.action !== "providers.validate" || context.provider === mine
        );
      },
    });
    expect((await h.call("POST", path(theirs, "/validate"))).status).toBe(403);
    expect(runs).toBe(0);
    expect((await h.call("POST", path(mine, "/validate"))).status).toBe(200);
    expect(runs).toBe(1);
    expect(calls.map((call) => call.provider)).toEqual([theirs, mine]);
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
    const id = `${make.definition.name}@1.0.0~1`;
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

  it("traces a spread copy to its instance, pending then failed", async () => {
    let answer: (valid: boolean) => void = () => {};
    const make = acme({
      asyncConfig: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    });
    const configured = make(CONFIG);
    const id = `${make.definition.name}@1.0.0~1`;
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
  });

  /**
   * A controller with real shared state — one attempt failed on a rejected
   * config: failures 1, `last` `{ failed, CONFIG }`, a backoff running — then
   * a preflight that validates the config again and passes, while `during`
   * (if given) runs. Answers the status before and after, less `summoner`.
   */
  async function validateAgainstFailedController(
    during?: (
      controller: ReturnType<BunJobs["summonController"]>,
    ) => Promise<void>,
  ) {
    let answer: (valid: boolean) => void = () => {};
    const make = acme({
      asyncConfig: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
      preflight: async () => [],
    });
    const configured = make(CONFIG);
    const id = `${make.definition.name}@1.0.0~1`;
    const jobs = summoning({ ...configured });
    const h = api({ jobs });
    answer(false);
    await configured.ready.catch(() => {});
    await jobs.queue("work").add("x", {});
    const controller = jobs.summonController("work");
    const checking = controller
      .check({ reason: "manual", force: true })
      .catch(() => {});
    await Bun.sleep(20);
    answer(false);
    await checking;
    const failed = await h.call("GET", "/queues/work/summon");
    const { summoner: _before, ...before } = failed.body;
    const validating = h.call("POST", path(id, "/validate"));
    await Bun.sleep(20);
    await during?.(controller);
    answer(true);
    const verdict = (await validating).body;
    const after = await h.call("GET", "/queues/work/summon");
    const { summoner, ...rest } = after.body;
    return { id, before, rest, summoner, verdict };
  }

  it("leaves a controller with real state untouched: failures, last, backoff, budget", async () => {
    const { id, before, rest, summoner, verdict } =
      await validateAgainstFailedController();
    // The baseline is real state, not an empty marker.
    expect(before).toMatchObject({
      failures: 1,
      last: { outcome: "failed", detail: "CONFIG" },
      backoffUntil: expect.any(Number),
    });
    expect(verdict).toEqual({ id, ok: true, checks: [] });
    expect(rest).toEqual(before);
    // The config is known now, so the controller adopts it on its next look.
    expect(summoner.readiness).toBe("ready");
  });

  it("negative control: the same comparison catches a controller change during the preflight", async () => {
    const { before, rest } = await validateAgainstFailedController(
      async (controller) => {
        await controller.reset();
      },
    );
    expect(before.failures).toBe(1);
    expect(rest).not.toEqual(before);
    expect(rest.failures).toBe(0);
  });

  it("serves a summon status whose summoner's describe() throws, with no facts and no secret logged", async () => {
    const SECRET = "tok_live_DESCRIBE_THROWS_42";
    const broken = defineComputeProvider({
      name: `bun-jobs-provider-broken-describe-${++unique}`,
      version: "1.0.0",
      kind: "broken",
      apiVersion: { core: "0.1", summon: "0.1" },
      secrets: ["apiToken"],
      describe: (config: { apiToken: string }) => {
        throw new Error(`cannot describe endpoint for ${config.apiToken}`);
      },
      summon: (): SummonFacet => ({
        capabilities: CAPABILITIES,
        summon: async () => ({ status: "started", handles: [] }),
      }),
    });
    const configured = held(broken({ apiToken: SECRET }));
    const { logger, events } = createTestLogger();
    const jobs = new BunJobs({
      namespace: testNamespace("api-providers"),
      driver: { type: "file", root: join(tmp.path, testNamespace("root")) },
      logger,
      summon: {
        work: {
          summoner: configured,
          triggers: { onAdd: false, events: false, poll: false },
        },
      },
    });
    cleanups.push(async () => {
      await jobs.close();
    });
    const response = await api({ jobs }).call("GET", "/queues/work/summon");
    expect(response.status).toBe(200);
    expect(response.body.summoner.facts).toEqual({});
    expect(response.body.summoner.readiness).toBe("ready");
    const logged = JSON.stringify(
      events.map((event) => ({ ...event, error: String(event.error) })),
    );
    expect(logged).toContain("describe() threw");
    expect(logged).not.toContain(SECRET);
    // Negative control: describe() really throws, with the secret in it.
    expect(() => configured.describe()).toThrow(SECRET);
  });
});
