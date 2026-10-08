import type { Summoner } from "@kingsleyweb/bun-jobs";
import type {
  ComputeProvider,
  StandardSchemaV1,
  SummonFacet,
} from "@kingsleyweb/bun-jobs/provider";
import type { ProviderFault, UnitBoard } from "./units";
import {
  defineComputeProvider,
  ProviderError,
  toStandardSchema,
} from "@kingsleyweb/bun-jobs/provider";
import { PROVIDER_FAULTS } from "./units";

/**
 * "Vault Compute": a third-party compute provider, made with
 * `defineComputeProvider` exactly as a provider package is, whose units are
 * started by the library's `localCompute()` underneath. It is what is left of
 * the playground's old made-up platform, kept for what `localCompute()`
 * itself cannot show:
 *
 * - **A declared secret.** `apiToken` is in `secrets`, so its value is
 *   redacted wherever the provider's output reaches a client: the preflight
 *   below names it in a check's detail, as a careless provider might, and
 *   Test connection shows `[REDACTED]` there. The served config schema drops
 *   the token's `default`, `examples` and `x-ui-widget`.
 * - **An asynchronous config, and so readiness.** A config may name its token
 *   in the playground's secret store, which takes `PLAYGROUND_SECRET_DELAY_MS`
 *   (default 12 s) to answer. Until it has, the provider is **pending** on the
 *   Providers screen and on the Summon panel; a name the store does not hold
 *   makes it **failed**. `localCompute()` validates synchronously, so it is
 *   always ready.
 * - **Answers a remote platform gives**: `throttled`, `quota`, `auth` and
 *   `transient` `ProviderError`s, each counted its own way by the controller.
 *   `localCompute()` never throws them; this provider does when the control
 *   page queues one for its queue, or when its token is wrong.
 *
 * Its summon facet checks the token and any queued provider fault, then hands
 * the start to the media `localCompute()` instance (through the playground's
 * instrumented facet, so unit faults and the units list work the same), whose
 * `maxUnits` it therefore shares.
 */

/** What a user configures Vault Compute with. */
export interface VaultComputeInput {
  /** The region, a fact. */
  region: string;
  /** The API token. Give it, or `apiTokenSecret`. A declared secret. */
  apiToken?: string;
  /** The name of a secret holding the token, read (slowly) from the playground's secret store. */
  apiTokenSecret?: string;
}

/** The validated config the facets receive: the token resolved. */
export interface VaultComputeConfig {
  /** The region. */
  region: string;
  /** The API token. */
  apiToken: string;
}

/* ------------------------------------------------------------------ */
/* A secret store, slow on purpose                                     */
/* ------------------------------------------------------------------ */

/** The secrets the store holds, by name. Filled by `summoning.ts`. */
const SECRETS = new Map<string, string>();

/** Puts a secret in the playground's secret store. */
export function storeSecret(name: string, value: string): void {
  SECRETS.set(name, value);
}

/** How long the secret store takes to answer, in ms (`PLAYGROUND_SECRET_DELAY_MS`, default 12 000). */
function secretDelay(): number {
  return Number(Bun.env.PLAYGROUND_SECRET_DELAY_MS ?? 12_000);
}

/** Reads a secret, after the store's delay; `undefined` when it has none by that name. */
async function readSecret(name: string): Promise<string | undefined> {
  await Bun.sleep(secretDelay());
  return SECRETS.get(name);
}

/* ------------------------------------------------------------------ */
/* The config schema                                                   */
/* ------------------------------------------------------------------ */

/** One validation issue. */
interface Issue {
  /** What is wrong: never the secret. */
  message: string;
  /** The config key it is about. */
  path: string[];
}

/** Checks everything that needs no I/O. */
function check(input: unknown): Issue[] {
  const config = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;
  const issues: Issue[] = [];
  if (typeof config.region !== "string" || config.region === "") {
    issues.push({ message: "region is required", path: ["region"] });
  }
  if (
    (config.apiToken === undefined) ===
    (config.apiTokenSecret === undefined)
  ) {
    issues.push({
      message: "give one of apiToken and apiTokenSecret",
      path: ["apiToken"],
    });
  }
  return issues;
}

/**
 * The validator: synchronous for a config with a token, so a malformed one
 * throws at once; a promise for one naming a secret, so that provider's
 * `ready` settles only once the store answers.
 */
const validator = toStandardSchema<VaultComputeInput, VaultComputeConfig>(
  (input) => {
    const issues = check(input);
    if (issues.length > 0) {
      return { issues };
    }
    const given = input as VaultComputeInput;
    const valid = (apiToken: string) => ({
      value: { region: given.region, apiToken },
    });
    if (given.apiToken !== undefined) {
      return valid(given.apiToken);
    }
    const name = given.apiTokenSecret!;
    return readSecret(name).then((token) =>
      token === undefined
        ? {
            issues: [
              {
                message: `the secret store has no secret named ${name}`,
                path: ["apiTokenSecret"],
              },
            ],
          }
        : valid(token),
    );
  },
);

/**
 * The config schema: the validator plus a Standard JSON Schema converter
 * (`~standard.jsonSchema`), which `GET /providers/:id/schema` serves for a
 * config form. The token's `default`, `examples` and `x-ui-widget` are here
 * to show that the served schema drops them.
 */
const configSchema: StandardSchemaV1<VaultComputeInput, VaultComputeConfig> = {
  "~standard": {
    ...validator["~standard"],
    jsonSchema: {
      input: () => ({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "Vault Compute",
        type: "object",
        required: ["region"],
        oneOf: [{ required: ["apiToken"] }, { required: ["apiTokenSecret"] }],
        properties: {
          region: {
            type: "string",
            enum: ["vault-1", "vault-2"],
            default: "vault-1",
          },
          apiToken: {
            type: "string",
            description: "An API token from the Vault Compute console",
            default: "vc_live_example_token",
            examples: ["vc_live_example_token"],
            "x-ui-widget": "password",
          },
          apiTokenSecret: {
            type: "string",
            description: "The name of a secret holding the token",
          },
        },
      }),
      output: () => ({}),
    },
  } as StandardSchemaV1<VaultComputeInput, VaultComputeConfig>["~standard"],
};

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

/** A provider fault as the `ProviderError` a remote platform's answer would be. */
function faultError(fault: ProviderFault): ProviderError {
  switch (fault) {
    case "throttled":
      return new ProviderError("vault compute is rate limiting", "throttled", {
        platformCode: "RateLimited",
        retryAfterMs: 8_000,
      });
    case "quota":
      return new ProviderError("vault compute quota exceeded", "quota", {
        platformCode: "QuotaExceeded",
        retryAfterMs: 20_000,
      });
    case "auth":
      return new ProviderError("vault compute revoked the token", "auth", {
        platformCode: "TokenRevoked",
      });
    case "transient":
      return new ProviderError("vault compute is unavailable", "transient", {
        platformCode: "ServiceUnavailable",
      });
    default: {
      // Unreachable while `ProviderFault` lists only the four above; a fifth
      // added there without a case here fails the typecheck on `never`, and
      // anything else that reaches here at run time is a clear error rather
      // than a `throw undefined`.
      const unknown: never = fault;
      throw new Error(`vault compute: no answer for fault ${String(unknown)}`);
    }
  }
}

/** What {@link defineVaultCompute} needs. */
export interface VaultComputeOptions {
  /** The token the vault accepts. */
  token: string;
  /** The instrumented `localCompute()` instance that starts the units. */
  units: Summoner;
  /** Where provider faults are queued, per queue. */
  board: UnitBoard;
}

/**
 * The provider, as a package would export it, bound to the `localCompute()`
 * instance it starts units with. Call the result with a config to get a
 * configured provider, usable as a queue's `summoner`.
 */
export function defineVaultCompute(
  options: VaultComputeOptions,
): ComputeProvider<VaultComputeInput, VaultComputeConfig, true> {
  const { token, units, board } = options;
  /** A token the vault does not know, as the `auth` error a platform answers. */
  const rejected = (): ProviderError =>
    new ProviderError("vault compute rejected the token", "auth", {
      platformCode: "InvalidToken",
    });
  return defineComputeProvider<VaultComputeConfig, VaultComputeInput>({
    name: "bun-node-playground-vault-compute",
    version: "0.1.0",
    kind: "vault",
    displayName: "Vault Compute",
    homepage: "https://github.com/kingsloob1/bun-node/tree/develop/playground",
    // Literals, never COMPUTE_PROVIDER_API's value: they say what this was
    // written against.
    apiVersion: { core: "0.1", summon: "0.1" },
    config: configSchema,
    secrets: ["apiToken"],
    describe: (config) => ({
      region: config.region,
      units: "localCompute() on this host (the media instance)",
      runtime: `bun ${Bun.version}`,
    }),
    validate: async (config, ctx) => {
      if (config.apiToken !== token) {
        throw rejected();
      }
      return [
        {
          id: "credentials",
          status: "pass",
          // The token, named in a detail: the API redacts it, since
          // `apiToken` is a declared secret.
          detail: `token ${config.apiToken} accepted`,
        },
        // What the localCompute() instance underneath checks: cwd, entry,
        // bun, capacity, isolation.
        ...(await units.validate({ signal: ctx.signal })),
      ];
    },
    summon: (config) => {
      const facet: SummonFacet = units.summon;
      return {
        get capabilities() {
          return facet.capabilities;
        },
        summon: async (request, ctx) => {
          if (config.apiToken !== token) {
            throw rejected();
          }
          const fault = board.take(request.queue, PROVIDER_FAULTS);
          if (fault !== undefined) {
            throw faultError(fault);
          }
          return await facet.summon(request, ctx);
        },
        status: async (handles, ctx) =>
          (await facet.status?.(handles, ctx)) ?? [],
        cancel: async (handles, ctx) => {
          await facet.cancel?.(handles, ctx);
        },
      };
    },
  });
}
