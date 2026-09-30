import type {
  ComputeProviderDefinition,
  ProviderSetupContext,
  SummonCapabilities,
  SummonFacet,
} from "../../lib/provider/index";
import type { Summoner } from "../../lib/summon/index";
import { describe, expect, it } from "bun:test";
import { ConfigError, defineSummoner, JobsError } from "../../lib/index";
import { facetReadiness } from "../../lib/provider/configure";
import {
  COMPUTE_PROVIDER,
  COMPUTE_PROVIDER_API,
  CONFIGURED_PROVIDER,
  defineComputeProvider,
  toStandardSchema,
} from "../../lib/provider/index";
import { toSummoner } from "../../lib/summon/define";

/**
 * `defineComputeProvider` (plugins §6.1–§6.3, §10.2): the definition's
 * checks, sync and async config validation, the brand, and `defineSummoner`
 * rebuilt on it. The controller's side (`ready`, redaction, registration
 * warnings) is `ready.test.ts` and `redact.test.ts`.
 */

const CAPABILITIES: SummonCapabilities = {
  style: "launch",
  dedupe: { kind: "none" },
  passes: "argv",
  bootBudgetMs: 60_000,
  shutdown: { signal: "SIGTERM", graceMs: 10_000 },
  maxLifetimeMs: null,
  enforcesLifetime: false,
};

/** A facet that starts nothing. */
function facet(capabilities: SummonCapabilities = CAPABILITIES): SummonFacet {
  return {
    capabilities,
    summon: async () => ({ status: "started", handles: [] }),
  };
}

/** A minimal valid definition, with overrides. */
function definition(
  overrides: Partial<ComputeProviderDefinition<unknown>> = {},
): ComputeProviderDefinition<unknown> & {
  summon: (config: unknown, context: ProviderSetupContext) => SummonFacet;
} {
  return {
    name: "test-provider",
    version: "1.0.0",
    kind: "test",
    apiVersion: { core: "0.1", summon: "0.1" },
    summon: () => facet(),
    ...overrides,
  } as ComputeProviderDefinition<unknown> & {
    summon: (config: unknown, context: ProviderSetupContext) => SummonFacet;
  };
}

/** A config with a secret, validated synchronously. */
interface AcmeConfig {
  region: string;
  apiToken: string;
}

const AcmeSchema = toStandardSchema<AcmeConfig>((input) => {
  const value = input as Partial<AcmeConfig>;
  const issues = [
    ...(typeof value?.region === "string"
      ? []
      : [{ message: "region is required", path: ["region"] }]),
    ...(typeof value?.apiToken === "string" && value.apiToken.length >= 8
      ? []
      : [
          {
            message: `apiToken ${String(value?.apiToken)} is too short`,
            path: ["apiToken"],
          },
        ]),
  ];
  return issues.length > 0
    ? { issues }
    : { value: { region: value.region!, apiToken: value.apiToken! } };
});

describe("the ./provider entry", () => {
  it("re-exports the package's errors, so a plugin needs no other import", async () => {
    const entry = await import("../../lib/provider/index");
    expect(entry.ConfigError).toBe(ConfigError);
    expect(entry.JobsError).toBe(JobsError);
  });
});

describe("defineComputeProvider: the definition", () => {
  it("answers a branded provider that carries its definition", () => {
    const def = definition();
    const provider = defineComputeProvider(def);
    expect(provider[COMPUTE_PROVIDER]).toBe(true);
    expect(provider.definition).toBe(def);
    expect(Symbol.keyFor(COMPUTE_PROVIDER)).toBe(
      "@kingsleyweb/bun-jobs/compute-provider",
    );
    expect(Symbol.keyFor(CONFIGURED_PROVIDER)).toBe(
      "@kingsleyweb/bun-jobs/configured-provider",
    );
    expect(COMPUTE_PROVIDER_API).toEqual({ core: "0.1", summon: "0.1" });
    expect(Object.isFrozen(COMPUTE_PROVIDER_API)).toBe(true);
  });

  it("refuses a malformed identity", () => {
    expect(() => defineComputeProvider(definition({ name: "" }))).toThrow(
      ConfigError,
    );
    expect(() => defineComputeProvider(definition({ version: "" }))).toThrow(
      ConfigError,
    );
    expect(() => defineComputeProvider(definition({ kind: "Not OK" }))).toThrow(
      /kind must be 1-24 characters/,
    );
    expect(() =>
      defineComputeProvider(definition({ kind: "x".repeat(25) })),
    ).toThrow(ConfigError);
  });

  it("refuses a different major, naming which side to upgrade", () => {
    expect(() =>
      defineComputeProvider(
        definition({ apiVersion: { core: "1.0", summon: "0.1" } }),
      ),
    ).toThrow(/core 1\.0.*speaks core 0\.1: upgrade bun-jobs/);
    expect(() =>
      defineComputeProvider(
        definition({ apiVersion: { core: "0.1", summon: "2.3" } }),
      ),
    ).toThrow(/summon 2\.3.*upgrade bun-jobs/);
    expect(() =>
      defineComputeProvider(
        definition({ apiVersion: { core: "0.1", summon: "x" } }),
      ),
    ).toThrow(/"major\.minor"/);
  });

  it("accepts a different minor of the same major", () => {
    expect(() =>
      defineComputeProvider(
        definition({ apiVersion: { core: "0.0", summon: "0.9" } }),
      ),
    ).not.toThrow();
  });

  it("refuses a facet without its version, and a version without its facet", () => {
    expect(() =>
      defineComputeProvider(definition({ apiVersion: { core: "0.1" } })),
    ).toThrow(/has a summon facet but no apiVersion\.summon/);
    const { summon: _summon, ...noFacet } = definition();
    expect(() => defineComputeProvider(noFacet)).toThrow(
      /declares apiVersion\.summon but has no summon facet/,
    );
    expect(() =>
      defineComputeProvider({ ...noFacet, apiVersion: { core: "0.1" } }),
    ).not.toThrow();
  });

  it("refuses an execute facet: this build has none", () => {
    expect(() =>
      defineComputeProvider({
        ...definition(),
        execute: () => ({}),
      } as ComputeProviderDefinition<unknown>),
    ).toThrow(/has no execute facet/);
    expect(() =>
      defineComputeProvider(
        definition({
          apiVersion: { core: "0.1", summon: "0.1", execute: "0.1" },
        } as Partial<ComputeProviderDefinition<unknown>>),
      ),
    ).toThrow(/has no execute facet/);
  });

  it("refuses a config that is not a Standard Schema, and malformed secrets", () => {
    expect(() =>
      defineComputeProvider(
        definition({
          config: {} as ComputeProviderDefinition<unknown>["config"],
        }),
      ),
    ).toThrow(/Standard Schema/);
    expect(() =>
      defineComputeProvider(
        definition({ secrets: [""] as unknown as string[] }),
      ),
    ).toThrow(/secrets/);
  });
});

describe("configuring a provider", () => {
  const acme = defineComputeProvider({
    name: "@acme/bun-jobs-provider-acme",
    version: "1.2.3",
    kind: "acme",
    displayName: "Acme Compute",
    apiVersion: { core: "0.1", summon: "0.1" },
    config: AcmeSchema,
    secrets: ["apiToken"],
    describe: (config) => ({
      region: config.region,
      echo: `token ${config.apiToken}`,
      exact: config.apiToken,
    }),
    validate: async (config, context) => [
      {
        id: "region",
        status: config.region === "eu" ? "pass" : "fail",
        detail: typeof context.signal.aborted === "boolean" ? "ok" : "no",
      },
    ],
    summon: (config, context) => ({
      ...facet({
        ...CAPABILITIES,
        bootBudgetMs: config.region === "eu" ? 1_000 : 2_000,
      }),
      // What the setup context carried, for the assertion below.
      capabilities: {
        ...CAPABILITIES,
        bootBudgetMs: context.hostVersion.length > 0 ? 1_000 : 2_000,
        maxCountPerCall: Number(context.api.summon!.split(".")[1]),
      },
    }),
  });

  it("validates a synchronous config at once, and builds the facet from the output", async () => {
    const configured = acme({ region: "eu", apiToken: "secret-token-1" });
    expect(configured[CONFIGURED_PROVIDER]).toBe(true);
    expect(configured.config).toEqual({
      region: "eu",
      apiToken: "secret-token-1",
    });
    await expect(configured.ready).resolves.toBeUndefined();
    expect(configured.summon.capabilities.bootBudgetMs).toBe(1_000);
    // The negotiated summon version, handed to the factory.
    expect(configured.summon.capabilities.maxCountPerCall).toBe(1);
    expect(configured.provider).toEqual({
      name: "@acme/bun-jobs-provider-acme",
      version: "1.2.3",
      kind: "acme",
      displayName: "Acme Compute",
      apiVersion: { core: "0.1", summon: "0.1" },
    });
  });

  it("throws a ConfigError for an invalid synchronous config, with no secret in it", () => {
    let caught: unknown;
    try {
      acme({
        region: 1,
        apiToken: "leaked-secret-value",
      } as unknown as AcmeConfig);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    // The token is long enough, so only the region fails…
    expect((caught as ConfigError).message).toContain(
      "region: region is required",
    );
    let short: unknown;
    try {
      acme({ region: "eu", apiToken: "short" });
    } catch (error) {
      short = error;
    }
    expect((short as ConfigError).context).toMatchObject({
      provider: "@acme/bun-jobs-provider-acme",
      issues: [{ path: "apiToken", message: "apiToken short is too short" }],
    });
  });

  it("redacts a declared secret from an issue message", () => {
    const strict = defineComputeProvider({
      ...definition(),
      config: toStandardSchema<AcmeConfig>((input) => ({
        issues: [
          {
            message: `bad token ${(input as AcmeConfig).apiToken}`,
            path: ["apiToken"],
          },
        ],
      })),
      secrets: ["apiToken"],
    });
    let caught: unknown;
    try {
      strict({ region: "eu", apiToken: "hunter2-hunter2" });
    } catch (error) {
      caught = error;
    }
    expect((caught as ConfigError).message).not.toContain("hunter2-hunter2");
    expect((caught as ConfigError).message).toContain("bad token [REDACTED]");
    expect(JSON.stringify((caught as ConfigError).context)).not.toContain(
      "hunter2-hunter2",
    );
  });

  it("drops a describe() fact holding a declared secret, and keeps the rest", () => {
    const configured = acme({ region: "eu", apiToken: "secret-token-1" });
    expect(configured.describe()).toEqual({ region: "eu" });
  });

  it("runs validate() with a call context, and answers [] without one", async () => {
    const configured = acme({ region: "eu", apiToken: "secret-token-1" });
    expect(await configured.validate()).toEqual([
      { id: "region", status: "pass", detail: "ok" },
    ]);
    const bare = defineComputeProvider(definition())();
    expect(await bare.validate()).toEqual([]);
  });

  it("refuses a facet that declares nothing usable", () => {
    const broken = defineComputeProvider(
      definition({
        summon: () =>
          ({
            ...facet(),
            capabilities: { ...CAPABILITIES, style: "fly" },
          }) as unknown as SummonFacet,
      }),
    );
    expect(() => broken()).toThrow(/style of "launch", "scale" or "wake"/);
    const noCall = defineComputeProvider(
      definition({
        summon: () => ({ capabilities: CAPABILITIES }) as SummonFacet,
      }),
    );
    expect(() => noCall()).toThrow(/needs a summon function/);
  });
});

describe("an asynchronous config", () => {
  /** A provider whose schema answers after `delay` ms, failing while `fail()` says so. */
  function asyncProvider(fail: () => boolean, delay = 5) {
    let calls = 0;
    const provider = defineComputeProvider({
      ...definition({ name: "async-provider" }),
      config: toStandardSchema<{ region: string }>(async (input) => {
        calls++;
        await Bun.sleep(delay);
        return fail()
          ? { issues: [{ message: "region unreachable", path: ["region"] }] }
          : { value: input as { region: string } };
      }),
      summon: (config: { region: string }) =>
        facet({
          ...CAPABILITIES,
          bootBudgetMs: config.region === "eu" ? 7_000 : 8_000,
        }),
    });
    return { provider, calls: () => calls };
  }

  it("returns at once; ready resolves once validated, and the facet is built then", async () => {
    const { provider, calls } = asyncProvider(() => false);
    const configured = provider({ region: "eu" });
    expect(calls()).toBe(1);
    expect(configured.config).toBeUndefined();
    expect(() => configured.summon.capabilities).toThrow(
      /still being validated/,
    );
    expect(facetReadiness(configured.summon).settled()).toBeUndefined();

    await configured.ready;
    expect(configured.config).toEqual({ region: "eu" });
    expect(configured.summon.capabilities.bootBudgetMs).toBe(7_000);
    expect(
      facetReadiness(configured.summon).settled()?.capabilities.bootBudgetMs,
    ).toBe(7_000);
    // The stand-in's call reaches the real facet.
    expect(await configured.summon.summon({} as never, {} as never)).toEqual({
      status: "started",
      handles: [],
    });
    expect(calls()).toBe(1);
  });

  it("rejects ready with a ConfigError when validation fails, and validates again when asked", async () => {
    let failing = true;
    const { provider, calls } = asyncProvider(() => failing);
    const configured = provider({ region: "eu" });
    await expect(configured.ready).rejects.toBeInstanceOf(ConfigError);
    // A rejection is not kept: the next settle validates again.
    failing = false;
    const readiness = facetReadiness(configured.summon);
    const real = await readiness.settle();
    expect(real.capabilities.bootBudgetMs).toBe(7_000);
    expect(calls()).toBe(2);
    await expect(configured.ready).resolves.toBeUndefined();
    // A resolution is kept.
    await readiness.settle();
    expect(calls()).toBe(2);
  });

  it("shares one validation in flight", async () => {
    const { provider, calls } = asyncProvider(() => false, 30);
    const configured = provider({ region: "eu" });
    const readiness = facetReadiness(configured.summon);
    await Promise.all([
      readiness.settle(),
      readiness.settle(),
      configured.ready,
    ]);
    expect(calls()).toBe(1);
  });

  it("is accepted by toSummoner before it is ready", () => {
    const { provider } = asyncProvider(() => false, 30);
    const configured = provider({ region: "eu" });
    expect(toSummoner(configured)).toBe(configured);
  });
});

describe("the brand", () => {
  it("is an own enumerable key of a configured provider, so a spread keeps it", () => {
    const summoner = defineSummoner({ invoke: async () => {} });
    expect(Object.getOwnPropertySymbols(summoner)).toContain(
      CONFIGURED_PROVIDER,
    );
    expect(
      Object.getOwnPropertyDescriptor(summoner, CONFIGURED_PROVIDER)
        ?.enumerable,
    ).toBe(true);
    const wrapped: Summoner = {
      ...summoner,
      summon: { ...summoner.summon, cancel: async () => {} },
    };
    expect(wrapped[CONFIGURED_PROVIDER]).toBe(true);
    expect(toSummoner(wrapped)).toBe(wrapped);
  });

  it("is missing from a hand-built literal, which toSummoner refuses with the migration", () => {
    const literal = {
      provider: {
        name: "custom:x",
        version: "0.0.0",
        kind: "x",
        apiVersion: { core: "0.1", summon: "0.1" },
      },
      summon: facet(),
      describe: () => ({}),
    };
    expect(() => toSummoner(literal as unknown as Summoner)).toThrow(
      /hand-built object.*defineSummoner\(\{ invoke \}\)/,
    );
    expect(() => toSummoner(literal as unknown as Summoner)).toThrow(
      ConfigError,
    );
  });

  it("refuses a provider passed unconfigured, and one without a summon facet", () => {
    const provider = defineComputeProvider(definition());
    expect(() => toSummoner(provider as unknown as Summoner)).toThrow(
      /was not configured/,
    );
    const { summon: _summon, ...rest } = definition();
    const noFacet = defineComputeProvider({
      ...rest,
      apiVersion: { core: "0.1" },
    });
    expect(() => toSummoner(noFacet() as unknown as Summoner)).toThrow(
      /has no summon facet/,
    );
  });
});

describe("defineSummoner, rebuilt on defineComputeProvider", () => {
  it("keeps its identity, capabilities and facts exactly", () => {
    const summoner = defineSummoner({
      kind: "my-cloud",
      describe: () => ({ region: "eu" }),
      invoke: async () => {},
    });
    expect(summoner.provider).toStrictEqual({
      name: "custom:my-cloud",
      version: "0.0.0",
      kind: "my-cloud",
      apiVersion: { core: "0.1", summon: "0.1" },
    });
    expect(summoner.summon.capabilities).toStrictEqual({
      style: "launch",
      dedupe: { kind: "none" },
      passes: "argv",
      bootBudgetMs: 180_000,
      shutdown: { signal: "SIGTERM", graceMs: 10_000 },
      maxLifetimeMs: null,
      enforcesLifetime: false,
    });
    expect(summoner.describe()).toStrictEqual({
      kind: "my-cloud",
      region: "eu",
    });
    expect(summoner.config).toBeUndefined();
    expect(summoner[CONFIGURED_PROVIDER]).toBe(true);
    expect(Object.isFrozen(summoner)).toBe(true);
  });

  it("answers started with no handles when invoke returns nothing, and validates to []", async () => {
    const summoner = defineSummoner({ invoke: async () => {} });
    await expect(summoner.ready).resolves.toBeUndefined();
    expect(await summoner.summon.summon({} as never, {} as never)).toEqual({
      status: "started",
      handles: [],
    });
    expect(await summoner.validate()).toEqual([]);
  });

  it("turns a bare function into the same anonymous provider", () => {
    const summoner = toSummoner(async () => {});
    expect(summoner.provider.name).toBe("custom:custom");
    expect(summoner[CONFIGURED_PROVIDER]).toBe(true);
  });
});
