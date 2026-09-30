import type {
  ComputeProvider,
  ProviderCallContext,
  ProviderErrorKind,
  SummonCapabilities,
  SummonResult,
} from "../../../lib/provider/index";
import type { FakePlatform } from "../../../lib/provider/testing/index";
import type { Summoner } from "../../../lib/summon/index";
import { Buffer } from "node:buffer";
import {
  COMPUTE_PROVIDER_API,
  defineComputeProvider,
  JobsError,
  ProviderError,
  toStandardSchema,
} from "../../../lib/provider/index";
import { fakePlatform } from "../../../lib/provider/testing/index";
import { defineSummoner } from "../../../lib/summon/index";

/**
 * The conformance kit's own subject: "Acme Compute", a small platform with a
 * strict 64-character dedupe token, and a provider for it that conforms —
 * plus one switch per defect, each breaking the provider in exactly one of
 * the kit's `must` groups (summon-compute §13.10, "What the conformance kit
 * must prove").
 */

/**
 * A look-alike of `ProviderError`: the same `code` and fields, but not the
 * class. The controller reads it by its shape; the kit wants the real
 * `ProviderError` (the `lookalike` defect).
 */
class LookalikeError extends JobsError {
  constructor(
    message: string,
    /** How the failure should be treated. */
    readonly kind: ProviderErrorKind,
    /** Its requested wait, in ms. */
    readonly retryAfterMs?: number,
  ) {
    super(message, `PROVIDER_${kind.toUpperCase()}`);
  }
}

/** The kind the `mislabeled` defect reports each kind as: always a wrong one. */
const MISLABEL: Record<ProviderErrorKind, ProviderErrorKind> = {
  transient: "throttled",
  throttled: "transient",
  quota: "throttled",
  auth: "transient",
  misconfigured: "transient",
  conflict: "throttled",
};

/** What a user configures Acme with. */
export interface AcmeConfig {
  /** The API's base URL: the fake's, in a test. */
  url: string;
  /** The region: a fact. */
  region: string;
  /** The API token: a secret. */
  apiToken: string;
}

/** One way to break the provider, each aimed at one kit group. */
export type AcmeDefect =
  | "identity" // version "latest"
  | "config" // accepts a config with no region
  | "capabilities" // scale style with no release
  | "routing" // calls the global fetch
  | "purity" // a timestamp in the body under a strict token
  | "dedupe" // a token longer than maxLength
  | "concurrency" // shared mutable state across awaits
  | "errors" // a plain Error for every platform failure
  | "timeouts" // a timer left after the abort
  | "status" // cancel() that stops nothing
  | "lifetime" // enforcesLifetime, but never sends it
  | "validate" // validate() that starts a unit
  | "secrets" // the token, base64-encoded with no scheme, in a log field
  | "redacted" // not a defect: logs the token where the redactor must mask it
  | "mislabeled" // every failure reported as a wrong ProviderError kind
  | "retry-units" // Retry-After's seconds taken for milliseconds
  | "lookalike" // a ProviderError look-alike, not the class
  | "retry-huge" // a retry-after of about 63 years
  | "prose-code" // a platformCode that is a sentence
  | "handoff"; // identity dropped under passes "argv"

/** How to build an Acme provider. */
export interface AcmeOptions {
  /** `"launch"` (default) or `"scale"`. */
  style?: "launch" | "scale";
  /** `"argv"` (default) or `"none"`. */
  passes?: "argv" | "none";
  /** The defect to build in, if any. */
  defect?: AcmeDefect;
  /** Validate the config asynchronously, so `ready` settles later. */
  asyncConfig?: boolean;
}

/** The platform's answer to a run request. */
interface RunAnswer {
  /** The units, by handle. */
  handles?: string[];
  /** Whether the token was already used. */
  deduped?: boolean;
  /** Capacity failures, on a 200. */
  failures?: { reason: string }[];
}

/** A failed response as a `ProviderError`, or (the `errors` defect) a plain `Error`. */
async function failure(
  response: Response,
  defect: AcmeDefect | undefined,
): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  const code = body.error?.code;
  if (defect === "errors") {
    return new Error(`acme answered ${response.status}`);
  }
  const seconds = Number(response.headers.get("retry-after") ?? 1);
  // The `retry-units` defect takes Retry-After's seconds for milliseconds.
  const retryAfterMs =
    defect === "retry-units"
      ? seconds
      : defect === "retry-huge"
        ? seconds * 1_000_000_000
        : seconds * 1_000;
  const kind: ProviderErrorKind =
    response.status === 429
      ? "throttled"
      : code === "QuotaExceeded"
        ? "quota"
        : response.status === 401 || response.status === 403
          ? "auth"
          : response.status === 404
            ? "misconfigured"
            : response.status === 409
              ? "conflict"
              : "transient";
  const reported = defect === "mislabeled" ? MISLABEL[kind] : kind;
  if (defect === "lookalike") {
    return new LookalikeError(
      `acme answered ${response.status}`,
      reported,
      retryAfterMs,
    );
  }
  // The `prose-code` defect passes the platform's message as its code.
  const platformCode =
    defect === "prose-code" ? `Acme said no (${response.status}), sorry` : code;
  return new ProviderError(`acme answered ${response.status}`, reported, {
    ...(platformCode === undefined ? {} : { platformCode }),
    status: response.status,
    ...(reported === "throttled" || reported === "quota"
      ? { retryAfterMs }
      : {}),
  });
}

/** Shared by every call of the `concurrency` defect: the bug it demonstrates. */
let current: { id: string } | undefined;

/** Builds an Acme provider. */
export function acmeProvider(
  options: AcmeOptions = {},
): ComputeProvider<AcmeConfig, AcmeConfig, true> {
  const style = options.style ?? "launch";
  const passes = options.passes ?? "argv";
  const defect = options.defect;
  const check = (
    input: unknown,
  ):
    | { value: AcmeConfig }
    | { issues: { message: string; path: string[] }[] } => {
    const config = input as Partial<AcmeConfig>;
    if (typeof config?.url !== "string") {
      return { issues: [{ message: "url is required", path: ["url"] }] };
    }
    if (typeof config.region !== "string" && defect !== "config") {
      return {
        issues: [{ message: "region is required", path: ["region"] }],
      };
    }
    if (typeof config.apiToken !== "string") {
      return {
        issues: [{ message: "apiToken is required", path: ["apiToken"] }],
      };
    }
    return { value: config as AcmeConfig };
  };
  return defineComputeProvider<AcmeConfig>({
    name: "@acme/bun-jobs-provider-acme",
    version: defect === "identity" ? "latest" : "1.0.0",
    kind: "acme",
    apiVersion: {
      core: COMPUTE_PROVIDER_API.core,
      summon: COMPUTE_PROVIDER_API.summon,
    },
    config: toStandardSchema<AcmeConfig, AcmeConfig>((input) =>
      options.asyncConfig === true
        ? Bun.sleep(5).then(() => check(input))
        : check(input),
    ),
    secrets: ["apiToken"],
    describe: (config) => ({ region: config.region }),
    validate: async (config, ctx) => {
      const fetcher = defect === "routing" ? globalThis.fetch : ctx.fetch;
      const response = await fetcher(`${config.url}/v1/whoami`, {
        headers: { authorization: `Bearer ${config.apiToken}` },
        signal: ctx.signal,
      });
      if (!response.ok) {
        throw await failure(response, defect);
      }
      if (defect === "validate") {
        await fetcher(`${config.url}/v1/runs`, {
          method: "POST",
          headers: { authorization: `Bearer ${config.apiToken}` },
          body: JSON.stringify({ token: "validate", args: [], count: 1 }),
          signal: ctx.signal,
        });
      }
      return [{ id: "credentials", status: "pass" }];
    },
    summon: (config) => {
      const capabilities: SummonCapabilities = {
        style: defect === "capabilities" ? "scale" : style,
        dedupe: {
          kind: "token",
          maxLength: 64,
          charset: "A-Za-z0-9-",
          scope: "region",
          strict: true,
        },
        passes,
        bootBudgetMs: 60_000,
        shutdown: { signal: "SIGTERM", graceMs: 10_000 },
        maxLifetimeMs: 86_400_000,
        enforcesLifetime: true,
      };
      const call = async (
        ctx: ProviderCallContext,
        method: string,
        path: string,
        body?: unknown,
      ): Promise<Response> => {
        const fetcher = defect === "routing" ? globalThis.fetch : ctx.fetch;
        const headers = { authorization: `Bearer ${config.apiToken}` };
        if (defect === "secrets") {
          // The token, base64-encoded with no scheme in front: no redactor
          // recognises it (a `Basic` credential it now does), and the kit's
          // scan decodes it.
          ctx.logger.debug("acme call", {
            method,
            path,
            trace: Buffer.from(`acme:${config.apiToken}`).toString("base64"),
          });
        }
        if (defect === "redacted") {
          // What the redactor must mask: the token in a URL's userinfo, a
          // Headers and a Map (fixed on feat/provider-core after a91243a).
          ctx.logger.debug("acme call", {
            method,
            endpoint: new URL(
              `https://acme:${config.apiToken}@api.acme.test${path}`,
            ),
            sent: new Headers(headers),
            meta: new Map([["authorization", `Bearer ${config.apiToken}`]]),
          });
        }
        return await fetcher(`${config.url}${path}`, {
          method,
          headers:
            body === undefined
              ? headers
              : { ...headers, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: ctx.signal,
        });
      };
      const result = async (response: Response): Promise<SummonResult> => {
        if (!response.ok) {
          throw await failure(response, defect);
        }
        const answer = (await response.json()) as RunAnswer;
        if (answer.failures !== undefined && answer.failures.length > 0) {
          return {
            status: "unavailable",
            reason: answer.failures[0]!.reason,
          };
        }
        return answer.deduped === true
          ? { status: "deduped", handles: answer.handles ?? [] }
          : { status: "started", handles: answer.handles ?? [] };
      };

      return {
        capabilities,
        summon: async (request, ctx) => {
          if (defect === "timeouts") {
            ctx.signal.addEventListener("abort", () => {
              // A retry nobody cancels.
              setTimeout(() => {}, 5_000);
            });
          }
          if (defect === "concurrency") {
            current = { id: request.id };
            await Bun.sleep(Math.random() * 20);
          }
          const args =
            passes === "none" || defect === "handoff"
              ? []
              : defect === "concurrency"
                ? request.argv.map((arg) =>
                    arg.startsWith("--bun-jobs-summon-id=")
                      ? `--bun-jobs-summon-id=${current!.id}`
                      : arg,
                  )
                : [...request.argv];
          const token =
            defect === "dedupe"
              ? `acme-${request.dedupeKey}`
              : request.dedupeKey;
          const body = {
            token,
            args,
            count: request.count,
            ...(defect === "lifetime"
              ? {}
              : { lifetimeSeconds: Math.floor(request.maxLifetimeMs / 1_000) }),
            ...(defect === "purity"
              ? { sentAt: Date.now() + Math.random() }
              : {}),
          };
          if (capabilities.style === "scale") {
            return await result(
              await call(ctx, "PUT", "/v1/service", {
                ...body,
                count: request.target,
              }),
            );
          }
          return await result(await call(ctx, "POST", "/v1/runs", body));
        },
        ...(capabilities.style === "scale" && defect !== "capabilities"
          ? {
              release: async (request, ctx) => {
                const response = await call(ctx, "PUT", "/v1/service", {
                  count: request.target,
                  args: [],
                });
                if (!response.ok) {
                  throw await failure(response, defect);
                }
              },
            }
          : {}),
        status: async (handles, ctx) => {
          const response = await call(
            ctx,
            "GET",
            `/v1/runs?handles=${handles.map(encodeURIComponent).join(",")}`,
          );
          if (!response.ok) {
            throw await failure(response, defect);
          }
          return (
            (await response.json()) as {
              units: {
                handle: string;
                state: "pending" | "running" | "exited" | "unknown";
              }[];
            }
          ).units;
        },
        cancel: async (handles, ctx) => {
          if (defect === "status") {
            return;
          }
          const response = await call(ctx, "POST", "/v1/runs/cancel", {
            handles,
          });
          if (!response.ok) {
            throw await failure(response, defect);
          }
        },
      };
    },
  });
}

/** Whether a request carries a bearer token (any: the kit seeds a canary). */
function authorised(request: Request): boolean {
  return /^Bearer \S+$/.test(request.headers.get("authorization") ?? "");
}

/** An unauthorised answer, Acme's way. */
function unauthorised(): Response {
  return Response.json(
    { error: { code: "Unauthorized", message: "no token" } },
    { status: 401 },
  );
}

/** The fake Acme platform. */
export async function acmeFake(): Promise<FakePlatform> {
  return await fakePlatform(
    {
      "GET /v1/whoami": (request) =>
        authorised(request)
          ? Response.json({ account: "acme-test" })
          : unauthorised(),
      "POST /v1/runs": async (request, state) => {
        if (!authorised(request)) {
          return unauthorised();
        }
        const body = (await request.json()) as {
          token: string;
          args: string[];
          count: number;
        };
        const earlier = state.recall(body.token);
        if (earlier !== undefined) {
          return Response.json({
            deduped: true,
            handles: earlier.map((unit) => unit.handle),
          });
        }
        const handles = Array.from(
          { length: body.count },
          () => state.start({ argv: body.args, token: body.token }).handle,
        );
        return Response.json({ handles }, { status: 201 });
      },
      "PUT /v1/service": async (request, state) => {
        if (!authorised(request)) {
          return unauthorised();
        }
        const body = (await request.json()) as {
          count: number;
          args: string[];
          token?: string;
        };
        if (
          body.token !== undefined &&
          state.recall(body.token) !== undefined
        ) {
          return Response.json({
            deduped: true,
            handles: state.units
              .filter((unit) => unit.state !== "exited")
              .map((unit) => unit.handle),
          });
        }
        const live = state.scale(body.count, {
          argv: body.args,
          ...(body.token === undefined ? {} : { token: body.token }),
        });
        return Response.json({ handles: live.map((unit) => unit.handle) });
      },
      "GET /v1/runs": (request, state) => {
        const handles = (new URL(request.url).searchParams.get("handles") ?? "")
          .split(",")
          .filter((handle) => handle !== "");
        return Response.json({
          units: handles.map((handle) => ({
            handle,
            state: state.unit(handle)?.state ?? "unknown",
          })),
        });
      },
      "POST /v1/runs/cancel": async (request, state) => {
        const body = (await request.json()) as { handles: string[] };
        for (const handle of body.handles) {
          state.stop(handle);
        }
        return Response.json({ cancelled: body.handles.length });
      },
    },
    {
      limits: { tokenMaxLength: 64, maxDurationMs: 86_400_000 },
      faults: {
        "capacity-200": () =>
          Response.json({ handles: [], failures: [{ reason: "no capacity" }] }),
      },
    },
  );
}

/** A config for the fake. */
export function acmeConfig(platform: FakePlatform): AcmeConfig {
  return {
    url: platform.url,
    region: "eu-test-1",
    apiToken: "acme-test-token-0123456789",
  };
}

/**
 * The same platform through `defineSummoner`: the escape hatch a user writes
 * for one-off code, which the kit accepts as it is (plugins §7.4).
 */
export function acmeSummoner(
  platform: FakePlatform,
  options: {
    /** Facts to describe, beside the kind. */
    describe?: () => Record<string, string>;
  } = {},
): Summoner {
  return defineSummoner({
    kind: "acme",
    dedupe: {
      kind: "token",
      maxLength: 64,
      charset: "A-Za-z0-9-",
      scope: "region",
      strict: true,
    },
    ...(options.describe === undefined ? {} : { describe: options.describe }),
    invoke: async (request, ctx) => {
      const response = await ctx.fetch(`${platform.url}/v1/runs`, {
        method: "POST",
        headers: {
          authorization: "Bearer acme-summoner-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          token: request.dedupeKey,
          args: request.argv,
          count: request.count,
        }),
        signal: ctx.signal,
      });
      if (!response.ok) {
        throw await failure(response, undefined);
      }
      const answer = (await response.json()) as RunAnswer;
      if (answer.failures !== undefined && answer.failures.length > 0) {
        return { status: "unavailable", reason: answer.failures[0]!.reason };
      }
      return answer.deduped === true
        ? { status: "deduped", handles: answer.handles ?? [] }
        : { status: "started", handles: answer.handles ?? [] };
    },
  });
}
