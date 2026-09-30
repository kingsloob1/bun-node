import type { ProviderCheck } from "../../provider/define";
import type { RegisteredProvider } from "../../provider/registry";
import type {
  ProviderSchemaDto,
  ProviderValidationDto,
} from "../contract/types";
import type { AnyRouteDef } from "./define";
import { providerErrorFacts } from "../../provider/errors";
import {
  redactDetail,
  redactingLogger,
  textRedactor,
} from "../../provider/redact";
import {
  configuredProvider,
  configuredProviders,
} from "../../provider/registry";
import { COMPUTE_PROVIDER_API } from "../../provider/version";
import { isCredentialKey } from "../../shared/credentialKeys";
import { ConfigError } from "../../shared/errors";
import { CODE_SHAPED } from "../../summon/controller";
import { ApiError } from "../errors";
import {
  DEFAULT_PROVIDER_VALIDATE_TIMEOUT_MS,
  ProviderListSchema,
  ProviderParams,
  ProviderSchemaSchema,
  ProviderValidateBodySchema,
  ProviderValidationSchema,
} from "../schemas/providers";
import { jsonSchemaInput, toProviderDto } from "../serialize";
import { defineRoute } from "./define";

/**
 * The compute provider routes (plugins §14.1): the providers configured in
 * the API's process (`GET /providers`), a preflight against one's platform
 * (`POST /providers/:id/validate`), and its config as a JSON Schema (`GET
 * /providers/:id/schema`).
 *
 * They read the per-process registry, not the `jobs` context: a provider is
 * configured in a process, whatever queue it serves. Everything served is
 * secret-free — the facts under the summon status's filter, every detail
 * redacted and capped, and the schema with its secret defaults dropped.
 */

/** What every provider route says about where its providers come from, once. */
const PROVIDERS_NOTE =
  "Providers are those configured in the API's process (each `provider(config)` call is one, `defineSummoner` included), whatever `jobs` context the API was given. An id is `name@version#<n>`, the nth instance of that `name@version` configured there: stable for that process's life, meaningless in another, and percent-encoded in a path. Both actions are opt-in (off unless `actions` names them) because they disclose infrastructure.";

/** The most checks one preflight answer carries; the rest are dropped. */
const MAX_CHECKS = 64;

/** How a preflight's check status is served; anything else a provider answers is `fail`. */
const CHECK_STATUSES: ReadonlySet<string> = new Set(["pass", "warn", "fail"]);

/** The JSON Schema keywords that carry values, dropped from a secret property. */
const VALUE_KEYWORDS: ReadonlySet<string> = new Set([
  "default",
  "examples",
  "const",
  "enum",
]);

/** How deep a JSON Schema is copied; anything deeper is dropped. */
const MAX_SCHEMA_DEPTH = 64;

/** The provider with this id, or 404 `PROVIDER_NOT_FOUND`. */
function providerOf(id: string): RegisteredProvider {
  const entry = configuredProvider(id);
  if (entry === undefined) {
    throw new ApiError(
      "PROVIDER_NOT_FOUND",
      404,
      `No compute provider "${id}" is configured in this process`,
    );
  }
  return entry;
}

/** Why a preflight did not answer normally, before redaction. */
interface Failure {
  /** How it classifies. */
  kind: NonNullable<ProviderValidationDto["error"]>["kind"];
  /** A short explanation. */
  detail: string;
}

/** `value` if it is a code-shaped string, else `undefined`. */
function codeShaped(value: unknown): string | undefined {
  return typeof value === "string" && CODE_SHAPED.test(value)
    ? value
    : undefined;
}

/**
 * Classifies what a preflight threw, the way the summon controller would
 * record it: a `ProviderError` by its kind, with its `platformCode` (else its
 * code) as the detail; a config that did not validate as `misconfigured`,
 * naming the invalid paths; anything else as `transient`, with its code or
 * name — never a message, which may be prose with a secret in it.
 */
function failureOf(error: unknown): Failure {
  const provider = providerErrorFacts(error);
  if (provider !== undefined) {
    return {
      kind: provider.kind,
      detail: codeShaped(provider.platformCode) ?? provider.code,
    };
  }
  if (error instanceof ConfigError) {
    const issues = (error.context as { issues?: unknown } | undefined)?.issues;
    const paths = Array.isArray(issues)
      ? issues
          .map((issue) =>
            typeof issue === "object" && issue !== null
              ? (issue as { path?: unknown }).path
              : undefined,
          )
          .map((path) =>
            typeof path === "string" && path.length > 0 ? path : "(root)",
          )
      : [];
    // A config that did not validate names its paths; a facet that could
    // not be built from a valid one is a `ConfigError` with none.
    return {
      kind: "misconfigured",
      detail:
        paths.length > 0
          ? `invalid config: ${[...new Set(paths)].join(", ")}`
          : (codeShaped(error.code) ?? "CONFIG"),
    };
  }
  if (error instanceof Error) {
    return {
      kind: "transient",
      detail:
        codeShaped((error as { code?: unknown }).code) ??
        codeShaped(error.name) ??
        "error",
    };
  }
  return { kind: "transient", detail: "error" };
}

/** A preflight's checks, normalised, redacted and capped. */
function toChecks(
  checks: readonly ProviderCheck[],
  secrets: readonly unknown[],
): ProviderValidationDto["checks"] {
  return checks.slice(0, MAX_CHECKS).map((check) => {
    const item = (
      typeof check === "object" && check !== null ? check : {}
    ) as Partial<Record<keyof ProviderCheck, unknown>>;
    const status = CHECK_STATUSES.has(item.status as string)
      ? (item.status as ProviderCheck["status"])
      : "fail";
    return {
      id: redactDetail(String(item.id ?? "check"), secrets),
      status,
      ...(typeof item.detail === "string" && item.detail.length > 0
        ? { detail: redactDetail(item.detail, secrets) }
        : {}),
    };
  });
}

/** What a timer resolves the race with when the preflight outlasts it. */
const TIMED_OUT: unique symbol = Symbol("timed out");

/**
 * Runs a provider's preflight, bounded by `timeoutMs`: its signal aborts at
 * the deadline, and the answer does not wait for a provider that ignores it.
 * Touches no controller: the preflight goes through `validate()` alone, which
 * waits for (or, after a failure, retries) the config's validation, as `ready`
 * would, and calls the definition's `validate`.
 */
async function preflight(
  entry: RegisteredProvider,
  timeoutMs: number,
  logger: Parameters<typeof redactingLogger>[0],
): Promise<ProviderValidationDto> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      abort.abort(new Error("the preflight timed out"));
      resolve(TIMED_OUT);
    }, timeoutMs);
  });
  const running = Promise.resolve().then(() =>
    entry.configured.validate({ signal: abort.signal }),
  );
  // Answered or not, a late rejection must not go unhandled.
  running.catch(() => {});
  let outcome: readonly ProviderCheck[] | typeof TIMED_OUT;
  try {
    outcome = await Promise.race([running, deadline]);
  } catch (error) {
    const failure = failureOf(error);
    const secrets = entry.secrets();
    redactingLogger(logger, secrets).warn("compute provider preflight failed", {
      provider: entry.id,
      kind: failure.kind,
      error,
    });
    return {
      id: entry.id,
      ok: false,
      checks: [],
      error: {
        kind: failure.kind,
        detail: redactDetail(failure.detail, secrets),
      },
    };
  } finally {
    clearTimeout(timer);
  }
  if (outcome === TIMED_OUT) {
    return {
      id: entry.id,
      ok: false,
      checks: [],
      error: { kind: "transient", detail: "timeout" },
    };
  }
  if (!Array.isArray(outcome)) {
    return {
      id: entry.id,
      ok: false,
      checks: [],
      error: { kind: "transient", detail: "invalid-result" },
    };
  }
  const checks = toChecks(outcome, entry.secrets());
  return {
    id: entry.id,
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

/**
 * A JSON Schema, copied secret-free: every string through `redact`, a value
 * keyword (`default`, `examples`, `const`, `enum`) dropped from a property
 * that is a declared secret or has a credential's name — and from everything
 * under it, its `anyOf` branches and nested properties included — and
 * anything that is not JSON (a function, a cycle, a class instance), or
 * deeper than {@link MAX_SCHEMA_DEPTH}, dropped.
 */
function sanitizeSchema(
  value: unknown,
  redact: (text: string) => string,
  secretPaths: ReadonlySet<string>,
): Record<string, unknown> {
  const walking = new Set<object>();
  const copy = (
    node: unknown,
    depth: number,
    path: string | undefined,
    secret: boolean,
  ): unknown => {
    if (typeof node === "string") {
      return redact(node);
    }
    if (
      node === null ||
      typeof node === "boolean" ||
      (typeof node === "number" && Number.isFinite(node))
    ) {
      return node;
    }
    if (typeof node !== "object" || depth > MAX_SCHEMA_DEPTH) {
      return undefined;
    }
    if (walking.has(node)) {
      return undefined;
    }
    walking.add(node);
    try {
      if (Array.isArray(node)) {
        return node
          .map((item) => copy(item, depth + 1, undefined, secret))
          .filter((item) => item !== undefined);
      }
      const proto = Object.getPrototypeOf(node) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        return undefined;
      }
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        if (secret && VALUE_KEYWORDS.has(key)) {
          continue;
        }
        if (
          (key === "properties" || key === "patternProperties") &&
          typeof child === "object" &&
          child !== null &&
          !Array.isArray(child)
        ) {
          const properties: Record<string, unknown> = {};
          for (const [name, schema] of Object.entries(child)) {
            const at =
              key === "properties" && path !== undefined
                ? path === ""
                  ? name
                  : `${path}.${name}`
                : undefined;
            const sub = copy(
              schema,
              depth + 2,
              at,
              secret ||
                isCredentialKey(name) ||
                (at !== undefined && secretPaths.has(at)),
            );
            if (sub !== undefined) {
              properties[redact(name)] = sub;
            }
          }
          out[key] = properties;
          continue;
        }
        const sub = copy(child, depth + 1, undefined, secret);
        if (sub !== undefined) {
          out[key] = sub;
        }
      }
      return out;
    } finally {
      walking.delete(node);
    }
  };
  return copy(value, 0, "", false) as Record<string, unknown>;
}

/** A provider's config as a JSON Schema, or 404 `PROVIDER_SCHEMA_NOT_FOUND`. */
function configSchemaOf(entry: RegisteredProvider): ProviderSchemaDto {
  const unavailable = (why: string) =>
    new ApiError("PROVIDER_SCHEMA_NOT_FOUND", 404, why);
  const input = jsonSchemaInput(entry.definition.config);
  if (typeof input !== "function") {
    throw unavailable(
      `Compute provider "${entry.id}" has no config schema that implements Standard JSON Schema: show its facts instead`,
    );
  }
  let document: unknown;
  try {
    document = (input as (options: { target: string }) => unknown).call(
      (
        entry.definition.config as unknown as {
          "~standard": { jsonSchema: unknown };
        }
      )["~standard"].jsonSchema,
      { target: "draft-2020-12" },
    );
  } catch {
    throw unavailable(
      `Compute provider "${entry.id}"'s config schema could not produce a draft-2020-12 JSON Schema`,
    );
  }
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  ) {
    throw unavailable(
      `Compute provider "${entry.id}"'s config schema produced no JSON Schema object`,
    );
  }
  const secrets = entry.secrets();
  return {
    id: entry.id,
    target: "draft-2020-12",
    schema: sanitizeSchema(
      document,
      textRedactor(secrets),
      new Set(entry.definition.secrets ?? []),
    ),
  };
}

/** The compute provider routes. */
export function providerRoutes(): AnyRouteDef[] {
  return [
    defineRoute({
      method: "GET",
      path: "/providers",
      operationId: "listProviders",
      action: "providers.read",
      mode: "jobs",
      summary: "The compute providers configured in this process",
      description: `Every compute provider configured in the API's process, oldest first — its id, identity, readiness, secret-free facts, and whether it has a preflight and a JSON Schema for its config — and the plugin API versions this bun-jobs speaks. Never a config value. An empty list when none is configured.\n\n${PROVIDERS_NOTE}`,
      tags: ["Providers"],
      responses: { 200: ProviderListSchema },
      handler: ({ services }) => ({
        body: {
          api: {
            core: COMPUTE_PROVIDER_API.core,
            summon: COMPUTE_PROVIDER_API.summon,
          },
          providers: configuredProviders().map((entry) =>
            toProviderDto(entry, services.config.serialize),
          ),
        },
      }),
    }),
    defineRoute({
      method: "POST",
      path: "/providers/:id/validate",
      operationId: "validateProvider",
      action: "providers.validate",
      mode: "jobs",
      summary: "Test connection: run a provider's preflight",
      description: `Runs the provider's preflight, \`ConfiguredProvider.validate()\`: waits for its config (an asynchronous schema validates it again after a failure, as \`ready\` would), then asks the platform whether it is reachable — credentials, cluster, function — without starting compute. Bounded by \`timeoutMs\`; changes no summon controller's state.\n\nAnswers 200 with the verdict: \`ok\` and the checks, or an \`error\` whose \`kind\` tells a bad config (\`misconfigured\`) or credentials (\`auth\`) from a platform that is failing for now (\`transient\`, \`throttled\`, \`quota\`). A throw that is not a \`ProviderError\` is \`transient\`; a timeout is \`transient\` with detail \`timeout\`. Every detail is redacted and cut to 128 characters.\n\n\`providers.validate\` is opt-in and a mutation: \`readOnly\` removes it, since it uses the provider's credentials.\n\n${PROVIDERS_NOTE}`,
      tags: ["Providers"],
      params: ProviderParams,
      body: ProviderValidateBodySchema,
      bodyOptional: true,
      responses: { 200: ProviderValidationSchema },
      errors: ["PROVIDER_NOT_FOUND"],
      handler: async ({ params, body, services }) => ({
        body: await preflight(
          providerOf(params.id),
          body.timeoutMs ?? DEFAULT_PROVIDER_VALIDATE_TIMEOUT_MS,
          services.config.logger,
        ),
      }),
    }),
    defineRoute({
      method: "GET",
      path: "/providers/:id/schema",
      operationId: "getProviderSchema",
      action: "providers.read",
      mode: "jobs",
      summary: "A provider's config as a JSON Schema, for a config form",
      description: `The provider's config schema as a draft-2020-12 JSON Schema, from its Standard JSON Schema converter (\`~standard.jsonSchema.input({ target: "draft-2020-12" })\`), made secret-free: every string redacted, and \`default\`, \`examples\`, \`const\` and \`enum\` dropped from a property that is a declared secret or has a credential's name. 404 \`PROVIDER_SCHEMA_NOT_FOUND\` when the schema has no such converter (show the provider's facts instead) or it fails; \`GET /providers\`' \`configSchema\` says which beforehand.\n\n${PROVIDERS_NOTE}`,
      tags: ["Providers"],
      params: ProviderParams,
      responses: { 200: ProviderSchemaSchema },
      errors: ["PROVIDER_NOT_FOUND", "PROVIDER_SCHEMA_NOT_FOUND"],
      handler: ({ params }) => ({
        body: configSchemaOf(providerOf(params.id)),
      }),
    }),
  ];
}
