import type {
  ComputeProviderDefinition,
  SummonFacet,
} from "../../lib/provider/index";
import { describe, expect, it } from "bun:test";
import { ConfigError } from "../../lib/index";
import {
  defineComputeProvider,
  toStandardSchema,
} from "../../lib/provider/index";

/**
 * The exact `ConfigError` an invalid provider config raises: its message
 * (`path: message` per issue, `; `-joined, a root issue without a path) and
 * its context's `issues`. A config error is for the developer who wrote the
 * config, so a provider's message keeps what it says about the value, and only
 * the declared secrets are redacted. Pinned so a change to how issues are
 * flattened shows here first.
 */

/** One issue, as a provider's schema reports it. */
interface Issue {
  /** What is wrong. */
  message: string;
  /** Where, as the vendor gives it; absent for the config itself. */
  path?: (PropertyKey | { key: PropertyKey })[];
}

/** A facet that starts nothing. */
function facet(): SummonFacet {
  return {
    capabilities: {
      style: "launch",
      dedupe: { kind: "none" },
      passes: "argv",
      bootBudgetMs: 60_000,
      shutdown: { signal: "SIGTERM", graceMs: 10_000 },
      maxLifetimeMs: null,
      enforcesLifetime: false,
    },
    summon: async () => ({ status: "started", handles: [] }),
  };
}

/** A provider whose schema reports `issues(input)`, synchronously or not. */
function provider(
  issues: (input: Record<string, unknown>) => Issue[],
  options: { async?: boolean; secrets?: string[] } = {},
) {
  const check = (input: unknown) => {
    const found = issues(input as Record<string, unknown>);
    return found.length > 0 ? { issues: found } : { value: input };
  };
  const definition: ComputeProviderDefinition<unknown> = {
    name: "test-provider",
    version: "1.0.0",
    kind: "test",
    apiVersion: { core: "0.1", summon: "0.1" },
    config: toStandardSchema<unknown>((input) =>
      options.async === true
        ? Promise.resolve().then(() => check(input))
        : check(input),
    ),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    summon: () => facet(),
  };
  return defineComputeProvider(definition);
}

/** The `ConfigError` that configuring `make` with `input` throws synchronously. */
function thrown(
  make: (input: unknown) => unknown,
  input: unknown,
): ConfigError {
  try {
    make(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

/** The error's message and context, for one comparison. */
const shape = (error: ConfigError) => ({
  message: error.message,
  context: error.context,
});

const PREFIX = "Invalid config for compute provider test-provider: ";

describe("an invalid provider config's ConfigError", () => {
  it("a nested path is dotted, a { key } segment by its key", () => {
    const make = provider(() => [
      { message: "token is required", path: ["auth", { key: "token" }] },
    ]);
    expect(shape(thrown(make, { auth: {} }))).toEqual({
      message: `${PREFIX}auth.token: token is required`,
      context: {
        provider: "test-provider",
        issues: [{ path: "auth.token", message: "token is required" }],
      },
    });
  });

  it("an array index is a path segment", () => {
    const make = provider(() => [
      { message: "regions must be names", path: ["regions", 1] },
    ]);
    expect(shape(thrown(make, { regions: ["eu", 7] }))).toEqual({
      message: `${PREFIX}regions.1: regions must be names`,
      context: {
        provider: "test-provider",
        issues: [{ path: "regions.1", message: "regions must be names" }],
      },
    });
  });

  it("a root issue has no path, and keeps the keys it names", () => {
    const make = provider(() => [
      { message: "region and zone cannot both be set" },
    ]);
    expect(shape(thrown(make, { region: "eu", zone: "a" }))).toEqual({
      message: `${PREFIX}region and zone cannot both be set`,
      context: {
        provider: "test-provider",
        issues: [{ path: "", message: "region and zone cannot both be set" }],
      },
    });
  });

  it("several issues are joined in order", () => {
    const make = provider(() => [
      { message: "region is required", path: ["region"] },
      { message: "needs a token or a key file" },
    ]);
    expect(thrown(make, {}).message).toBe(
      `${PREFIX}region: region is required; needs a token or a key file`,
    );
  });

  it("a message quoting the received value keeps it", () => {
    const make = provider((input) => [
      {
        message: `region ${String(input.region)} is not a region`,
        path: ["region"],
      },
    ]);
    expect(shape(thrown(make, { region: "mars-north-1" }))).toEqual({
      message: `${PREFIX}region: region mars-north-1 is not a region`,
      context: {
        provider: "test-provider",
        issues: [
          { path: "region", message: "region mars-north-1 is not a region" },
        ],
      },
    });
  });

  it("a declared secret is redacted from a message that quotes it", () => {
    const make = provider(
      (input) => [
        { message: `bad token ${String(input.token)}`, path: ["token"] },
      ],
      { secrets: ["token"] },
    );
    expect(shape(thrown(make, { token: "hunter2-hunter2" }))).toEqual({
      message: `${PREFIX}token: bad token [REDACTED]`,
      context: {
        provider: "test-provider",
        issues: [{ path: "token", message: "bad token [REDACTED]" }],
      },
    });
  });

  it("an enum's literals stay in its message while another field holds one", () => {
    const make = provider(() => [
      { message: 'style must be "launch" or "scale"', path: ["style"] },
    ]);
    expect(
      shape(thrown(make, { style: "wake", label: "launch" })).context,
    ).toEqual({
      provider: "test-provider",
      issues: [{ path: "style", message: 'style must be "launch" or "scale"' }],
    });
  });

  it("an asynchronous schema does not throw: ready rejects with the same error", async () => {
    const make = provider(
      () => [{ message: "token is required", path: ["auth", "token"] }],
      { async: true },
    );
    const configured = make({ auth: {} }) as { ready: Promise<void> };
    const error = await configured.ready.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(shape(error as ConfigError)).toEqual({
      message: `${PREFIX}auth.token: token is required`,
      context: {
        provider: "test-provider",
        issues: [{ path: "auth.token", message: "token is required" }],
      },
    });
  });

  it("an asynchronous schema's quoted value is kept too", async () => {
    const make = provider(
      (input) => [
        {
          message: `region ${String(input.region)} is not a region`,
          path: ["region"],
        },
      ],
      { async: true },
    );
    const configured = make({ region: "mars-north-1" }) as {
      ready: Promise<void>;
    };
    const error = await configured.ready.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect((error as ConfigError).message).toBe(
      `${PREFIX}region: region mars-north-1 is not a region`,
    );
  });
});
