import type {
  ProviderCallContext,
  ProviderCheck,
  SummonCapabilities,
  UnitStatus,
} from "@kingsleyweb/bun-jobs/provider";
import type { AcmeConfig, ValidAcmeConfig } from "./config.js";
import { defineComputeProvider } from "@kingsleyweb/bun-jobs/provider";
import { acmeConfigSchema } from "./config.js";
import { acmeError, unreachable } from "./errors.js";

/**
 * A compute provider for **Acme Compute**, a fictional platform, as a
 * starting point for a real one. Acme starts runs in a pool: a fixed machine
 * shape and image. A run takes a client token of up to 64 characters, which
 * Acme remembers for a day and refuses to reuse with different parameters
 * (strict), and command-line arguments, which is how the summon id reaches
 * the worker (`passes: "argv"`).
 *
 * ```ts
 * import { acme } from "bun-jobs-provider-example";
 *
 * const jobs = new BunJobs({
 *   summon: { emails: { summoner: acme({ region: "eu-west", pool: "workers", apiTokenFile: "/run/secrets/acme" }) } },
 * });
 * ```
 *
 * Relative imports end in `.js`: the emitted declarations keep them as
 * written, and a `node16` consumer resolves nothing else. Bun maps them to
 * the `.ts` files.
 */

export type { AcmeConfig, ValidAcmeConfig } from "./config.js";

/** What Acme answers to `POST /runs`. */
interface RunsAnswer {
  /** The runs started, or the earlier ones when the token was seen before. */
  runs: {
    /** The run's id: the handle. */
    id: string;
  }[];
  /** Why nothing started, on a 200: Acme's way of saying it has no capacity. */
  failures?: {
    /** Acme's reason, e.g. `"InsufficientCapacity"`. */
    reason: string;
  }[];
}

/** What Acme answers to `GET /runs?ids=…`: the runs it knows, in no order. */
interface StatusAnswer {
  /** The runs. An id Acme no longer knows is absent. */
  runs: {
    /** The run's id. */
    id: string;
    /** `QUEUED`, `RUNNING`, `STOPPED` or `FAILED`. */
    state: string;
    /** The exit code, once stopped. */
    exitCode?: number;
  }[];
}

/** Acme's run states, as the controller's. */
const STATES: Readonly<Record<string, UnitStatus["state"]>> = {
  QUEUED: "pending",
  RUNNING: "running",
  STOPPED: "exited",
  FAILED: "failed",
};

/** One Acme API call, through `ctx.fetch` and `ctx.signal`, as every call must be. */
async function call(
  config: ValidAcmeConfig,
  ctx: ProviderCallContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  try {
    return await ctx.fetch(`${config.url}/v1/pools/${config.pool}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ctx.signal,
    });
  } catch (error) {
    // An abort is the controller's own timeout: let it through as it is.
    throw ctx.signal.aborted ? error : unreachable(error);
  }
}

/** The same call, throwing the mapped `ProviderError` unless Acme answered OK. */
async function ok(
  config: ValidAcmeConfig,
  ctx: ProviderCallContext,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await call(config, ctx, method, path, body);
  if (!response.ok) {
    throw await acmeError(response, ctx.now());
  }
  return response;
}

/** What Acme can do, declared truthfully: the controller reads these instead of knowing Acme. */
const capabilities: SummonCapabilities = {
  // Every call starts new runs.
  style: "launch",
  // The controller clips `request.dedupeKey` to fit.
  dedupe: {
    kind: "token",
    maxLength: 64,
    charset: "A-Za-z0-9-",
    scope: "pool",
    ttlMs: 86_400_000,
    strict: true,
  },
  passes: "argv",
  // An image pull and a boot: the attempt counts as lost after this.
  bootBudgetMs: 90_000,
  shutdown: { signal: "SIGTERM", graceMs: 30_000 },
  // Acme stops any run after a day, and takes a shorter cap per run.
  maxLifetimeMs: 86_400_000,
  enforcesLifetime: true,
  maxCountPerCall: 10,
};

/** The Acme Compute provider. Call it with an {@link AcmeConfig}. */
export const acme = defineComputeProvider<ValidAcmeConfig, AcmeConfig>({
  // The npm package's name and version, kept equal to `package.json`.
  name: "bun-jobs-provider-example",
  version: "0.1.0",
  kind: "acme",
  displayName: "Acme Compute",
  // What this code was written against: literal, never the host's constant,
  // or the registration check could never catch a mismatch.
  apiVersion: { core: "0.1", summon: "0.1" },
  config: acmeConfigSchema,
  secrets: ["apiToken"],
  describe: (config) => ({ region: config.region, pool: config.pool }),

  // A preflight that starts nothing: can the token read the pool?
  validate: async (config, ctx): Promise<ProviderCheck[]> => {
    const response = await call(config, ctx, "GET", "");
    if (response.ok) {
      return [
        { id: "credentials", status: "pass" },
        { id: "pool", status: "pass" },
      ];
    }
    const error = await acmeError(response, ctx.now());
    if (error.kind === "auth") {
      return [{ id: "credentials", status: "fail", detail: error.message }];
    }
    if (error.kind === "misconfigured") {
      return [
        { id: "credentials", status: "pass" },
        {
          id: "pool",
          status: "fail",
          detail: `${error.message}: is the pool in ${config.region}?`,
        },
      ];
    }
    throw error;
  },

  summon: (config) => ({
    capabilities,

    // Everything sent is a function of the request's id, never of `demand`
    // or `reason`: Acme refuses a token reused with different parameters.
    summon: async (request, ctx) => {
      const response = await ok(config, ctx, "POST", "/runs", {
        clientToken: request.dedupeKey,
        count: request.count,
        args: request.argv,
        env: request.env,
        maxRuntimeSeconds: Math.ceil(request.maxLifetimeMs / 1_000),
      });
      const answer = (await response.json()) as RunsAnswer;
      if (answer.failures !== undefined && answer.failures.length > 0) {
        return { status: "unavailable", reason: answer.failures[0]!.reason };
      }
      const handles = answer.runs.map((run) => run.id);
      // 201: new runs. 200: the token was seen, and these are the earlier runs.
      return response.status === 201
        ? { status: "started", handles }
        : { status: "deduped", handles };
    },

    // Asked once when an attempt is declared lost, to explain it.
    status: async (handles, ctx) => {
      const response = await ok(
        config,
        ctx,
        "GET",
        `/runs?ids=${handles.map(encodeURIComponent).join(",")}`,
      );
      const answer = (await response.json()) as StatusAnswer;
      return handles.map((handle) => {
        const run = answer.runs.find((one) => one.id === handle);
        return {
          handle,
          state:
            (run === undefined ? undefined : STATES[run.state]) ?? "unknown",
          ...(run?.exitCode === undefined ? {} : { exitCode: run.exitCode }),
        };
      });
    },

    // Stops runs still queued when an attempt is declared lost.
    cancel: async (handles, ctx) => {
      await ok(config, ctx, "POST", "/runs/stop", { ids: handles });
    },
  }),
});
