import type {
  ProviderCallContext,
  ProviderErrorKind,
  StandardSchemaV1,
  SummonCapabilities,
  SummonResult,
  UnitStatus,
} from "@kingsleyweb/bun-jobs/provider";
import type { StartBody } from "./platform";
import {
  defineComputeProvider,
  ProviderError,
  toStandardSchema,
} from "@kingsleyweb/bun-jobs/provider";

/**
 * The playground's compute provider for "Local Compute" (`platform.ts`), made
 * with `defineComputeProvider` exactly as a provider package for a cloud
 * platform is: an identity, a config schema that declares its secret, facts,
 * a preflight, and a summon facet that talks to the platform's API over HTTP
 * through `ctx.fetch`.
 *
 * What each piece shows in the UI:
 *
 * - **`apiToken` is a declared secret.** Its value is redacted wherever the
 *   provider's output reaches a client: the preflight below names it in a
 *   check's detail, as a careless provider might, and Test connection shows
 *   `[redacted]` there. The served config schema drops its `default`,
 *   `examples` and `x-` keys.
 * - **`apiTokenSecret` makes the config asynchronous.** Instead of a token, a
 *   config may name one in the playground's secret store, which takes
 *   `PLAYGROUND_SECRET_DELAY_MS` (default 12 s) to answer. Until it has, the
 *   provider's readiness is **pending**, on the Providers screen and on the
 *   Summon panel; a name the store does not hold makes it **failed**.
 * - **The error table** below turns every platform answer into a
 *   `ProviderError` whose kind decides how the controller counts it.
 */

/** What a user configures Local Compute with. */
export interface LocalComputeInput {
  /** The platform API's base URL, e.g. `http://localhost:4000/local-compute`. */
  url: string;
  /** The region, a fact. */
  region: string;
  /** The pool units start in, a fact. */
  pool: string;
  /** The API token. Give it, or `apiTokenSecret`. A declared secret. */
  apiToken?: string;
  /** The name of a secret holding the token, read (slowly) from the playground's secret store. */
  apiTokenSecret?: string;
}

/** The validated config the facets receive: the token resolved. */
export interface LocalComputeConfig {
  /** The platform API's base URL, without a trailing slash. */
  url: string;
  /** The region. */
  region: string;
  /** The pool. */
  pool: string;
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
  for (const key of ["url", "region", "pool"] as const) {
    if (typeof config[key] !== "string" || config[key] === "") {
      issues.push({ message: `${key} is required`, path: [key] });
    }
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
 * throws from `localCompute(config)` at once; a promise for one naming a
 * secret, so that provider's `ready` settles only once the store answers.
 */
const validator = toStandardSchema<LocalComputeInput, LocalComputeConfig>(
  (input) => {
    const issues = check(input);
    if (issues.length > 0) {
      return { issues };
    }
    const given = input as LocalComputeInput;
    const valid = (apiToken: string) => ({
      value: {
        url: given.url.replace(/\/+$/, ""),
        region: given.region,
        pool: given.pool,
        apiToken,
      },
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
 * config form. A schema library that implements Standard JSON Schema (zod 4,
 * valibot, arktype) provides one; with no library it is written out. The
 * token's `default`, `examples` and `x-ui-widget` are here to show that the
 * served schema drops them.
 */
const configSchema: StandardSchemaV1<LocalComputeInput, LocalComputeConfig> = {
  "~standard": {
    ...validator["~standard"],
    jsonSchema: {
      input: () => ({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "Local Compute",
        type: "object",
        required: ["url", "region", "pool"],
        oneOf: [{ required: ["apiToken"] }, { required: ["apiTokenSecret"] }],
        properties: {
          url: {
            type: "string",
            format: "uri",
            description: "The platform API's base URL",
          },
          region: {
            type: "string",
            enum: ["local-1", "local-2"],
            default: "local-1",
          },
          pool: {
            type: "string",
            description: "The pool units start in",
          },
          apiToken: {
            type: "string",
            description: "An API token from the Local Compute console",
            default: "lc_live_example_token",
            examples: ["lc_live_example_token"],
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
  } as StandardSchemaV1<LocalComputeInput, LocalComputeConfig>["~standard"],
};

/* ------------------------------------------------------------------ */
/* The platform's answers, as ProviderErrors                           */
/* ------------------------------------------------------------------ */

/** A failed platform answer as a `ProviderError` whose kind says how it counts. */
async function toProviderError(response: Response): Promise<ProviderError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  const kind: ProviderErrorKind =
    response.status === 429
      ? "throttled"
      : response.status === 402
        ? "quota"
        : response.status === 401 || response.status === 403
          ? "auth"
          : response.status === 404
            ? "misconfigured"
            : response.status === 409
              ? "conflict"
              : "transient";
  const retryAfter = response.headers.get("retry-after");
  return new ProviderError(`local compute answered ${response.status}`, kind, {
    ...(body.error?.code === undefined
      ? {}
      : { platformCode: body.error.code }),
    status: response.status,
    // Retry-After is in seconds.
    ...(retryAfter !== null && (kind === "throttled" || kind === "quota")
      ? { retryAfterMs: Number(retryAfter) * 1_000 }
      : {}),
  });
}

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

/**
 * The provider, as a package would export it. Call it with a config to get a
 * configured provider, usable as a queue's `summoner`.
 */
export const localCompute = defineComputeProvider<
  LocalComputeConfig,
  LocalComputeInput
>({
  name: "bun-node-playground-local-compute",
  version: "0.1.0",
  kind: "local",
  displayName: "Local Compute",
  homepage: "https://github.com/kingsloob1/bun-node/tree/develop/playground",
  // Literals, never COMPUTE_PROVIDER_API's value: they say what this was
  // written against.
  apiVersion: { core: "0.1", summon: "0.1" },
  config: configSchema,
  secrets: ["apiToken"],
  describe: (config) => ({
    region: config.region,
    pool: config.pool,
    endpoint: config.url,
    runs: "Bun.spawn on this machine",
    runtime: `bun ${Bun.version}`,
  }),
  validate: async (config, ctx) => {
    const response = await ctx.fetch(`${config.url}/v1/whoami`, {
      headers: { authorization: `Bearer ${config.apiToken}` },
      signal: ctx.signal,
    });
    if (!response.ok) {
      throw await toProviderError(response);
    }
    const who = (await response.json()) as {
      account: string;
      maxUnits: number;
      running: number;
    };
    return [
      {
        id: "credentials",
        status: "pass",
        // The token, named in a detail: the API redacts it, since
        // `apiToken` is a declared secret.
        detail: `token ${config.apiToken} accepted for account ${who.account}`,
      },
      {
        id: "isolation",
        status: "warn",
        detail:
          "units are processes on this machine, not isolated sandboxes: fine for a playground, not for untrusted jobs",
      },
      {
        id: "capacity",
        status: who.running < who.maxUnits ? "pass" : "warn",
        detail: `${who.running} of ${who.maxUnits} units running`,
      },
    ];
  },
  summon: (config) => {
    const capabilities: SummonCapabilities = {
      style: "launch",
      // The platform remembers a start's token and answers the same handles
      // again, so the body sent is a pure function of the attempt's id.
      dedupe: {
        kind: "token",
        maxLength: 64,
        charset: "A-Za-z0-9-",
        scope: "account",
        strict: true,
      },
      passes: "argv",
      bootBudgetMs: 20_000,
      shutdown: { signal: "SIGTERM", graceMs: 10_000 },
      maxLifetimeMs: 3_600_000,
      enforcesLifetime: true,
      maxCountPerCall: 4,
    };

    /** One platform call. */
    const call = async (
      ctx: ProviderCallContext,
      method: "GET" | "POST",
      path: string,
      body?: unknown,
    ): Promise<Response> => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${config.apiToken}`,
      };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
      }
      return await ctx.fetch(`${config.url}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ctx.signal,
      });
    };

    return {
      capabilities,
      summon: async (request, ctx): Promise<SummonResult> => {
        // The arguments carry the attempt's identity; the environment is the
        // policy's static `env` (here: how to reach the backend).
        const body: StartBody = {
          token: request.dedupeKey,
          args: [...request.argv],
          env: { ...request.env },
          count: request.count,
          lifetimeSeconds: Math.floor(request.maxLifetimeMs / 1_000),
        };
        const response = await call(ctx, "POST", "/v1/units", body);
        if (!response.ok) {
          throw await toProviderError(response);
        }
        const answer = (await response.json()) as {
          handles?: string[];
          deduped?: boolean;
          failures?: { reason: string }[];
        };
        // A 200 with no capacity is an answer, not an error.
        if (answer.failures !== undefined && answer.failures.length > 0) {
          return {
            status: "unavailable",
            reason: answer.failures[0]!.reason,
          };
        }
        return answer.deduped === true
          ? { status: "deduped", handles: answer.handles ?? [] }
          : { status: "started", handles: answer.handles ?? [] };
      },
      status: async (handles, ctx): Promise<UnitStatus[]> => {
        const response = await call(
          ctx,
          "GET",
          `/v1/units?handles=${handles.map(encodeURIComponent).join(",")}`,
        );
        if (!response.ok) {
          throw await toProviderError(response);
        }
        return ((await response.json()) as { units: UnitStatus[] }).units;
      },
      cancel: async (handles, ctx) => {
        const response = await call(ctx, "POST", "/v1/units/cancel", {
          handles,
        });
        if (!response.ok) {
          throw await toProviderError(response);
        }
      },
    };
  },
});
