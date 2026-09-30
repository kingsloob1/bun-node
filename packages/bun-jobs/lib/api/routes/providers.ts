import type { BunRequest, Logger } from "@kingsleyweb/bun-common";
import type { ProviderCheck } from "../../provider/define";
import type { RegisteredProvider } from "../../provider/registry";
import type {
  ProviderSchemaDto,
  ProviderValidationDto,
} from "../contract/types";
import type { AnyRouteDef, RouteServices } from "./define";
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
import { decide } from "../auth";
import { DEFAULT_REDACT_REPLACEMENT } from "../contract/constants";
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
import { mapBounded } from "./support";

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
  "Providers are those configured in the API's process (each `provider(config)` call is one, `defineSummoner` included), whatever `jobs` context the API was given. An id is `name@version~<n>`, the nth instance of that `name@version` configured there: stable for that process's life, meaningless in another. `@`, `:` and `~` are URL-safe; percent-encode a scoped name's `/`. `authorize` is told the id as `provider`. Both actions are opt-in (off unless `actions` names them) because they disclose infrastructure.";

/**
 * How long a completed preflight's verdict is reused for the same provider
 * instance, in ms: a "Test connection" pressed twice, or by two operators,
 * reaches the platform once.
 */
export const PROVIDER_VALIDATE_REUSE_MS = 5_000;

/**
 * The route the list's per-provider `authorize` calls carry: one provider's
 * read, `GET /providers/:id/schema`, as `listQueues: "authorized"` carries
 * `GET /queues/:queue` — so a provider is listed exactly when its own read
 * would be allowed.
 */
const PROVIDER_READ_ROUTE = {
  method: "GET",
  path: "/providers/:id/schema",
} as const;

/** The most checks one preflight answer carries; the rest are dropped. */
const MAX_CHECKS = 64;

/** How a preflight's check status is served; anything else a provider answers is `fail`. */
const CHECK_STATUSES: ReadonlySet<string> = new Set(["pass", "warn", "fail"]);

/**
 * The JSON Schema keywords that carry a value, dropped everywhere in a served
 * schema (with every `x-*` key): a host's own secret baked in as a default is
 * indistinguishable from any other default.
 */
const VALUE_KEYWORDS: ReadonlySet<string> = new Set([
  "default",
  "example",
  "examples",
  "const",
]);

/** Keywords whose object maps names to schemas (besides `properties`): their keys are names. */
const NAME_MAPS: ReadonlySet<string> = new Set([
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

/** Keywords whose schemas describe the same value as their parent: the path and flag carry over. */
const COMBINATORS: ReadonlySet<string> = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
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
 * record it: what building the facets threw (kept for good) as
 * `misconfigured`; a `ProviderError` by its kind, with its `platformCode`
 * (else its code) as the detail; a config that did not validate as
 * `misconfigured`, naming the invalid paths; anything else as `transient`,
 * with its code or name — never a message, which may be prose with a secret
 * in it.
 */
function failureOf(error: unknown, entry: RegisteredProvider): Failure {
  // What building the facets threw, kept for good: the config (or the
  // provider's code for it) is at fault, whatever the error's class.
  const buildError = entry.buildError();
  if (buildError !== undefined && error === buildError) {
    return {
      kind: "misconfigured",
      detail:
        (error instanceof Error
          ? (codeShaped((error as { code?: unknown }).code) ??
            codeShaped(error.name))
          : undefined) ?? "error",
    };
  }
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
  logger: Logger,
): Promise<{
  /** The verdict. */
  result: ProviderValidationDto;
  /** Whether it may be reused: not a timed-out (aborted) run. */
  reusable: boolean;
}> {
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
    const failure = failureOf(error, entry);
    const secrets = entry.secrets();
    redactingLogger(logger, secrets).warn("compute provider preflight failed", {
      provider: entry.id,
      kind: failure.kind,
      error,
    });
    return {
      result: {
        id: entry.id,
        ok: false,
        checks: [],
        error: {
          kind: failure.kind,
          detail: redactDetail(failure.detail, secrets),
        },
      },
      reusable: true,
    };
  } finally {
    clearTimeout(timer);
  }
  if (outcome === TIMED_OUT) {
    return {
      result: {
        id: entry.id,
        ok: false,
        checks: [],
        error: { kind: "transient", detail: "timeout" },
      },
      reusable: false,
    };
  }
  if (!Array.isArray(outcome)) {
    return {
      result: {
        id: entry.id,
        ok: false,
        checks: [],
        error: { kind: "transient", detail: "invalid-result" },
      },
      reusable: true,
    };
  }
  const checks = toChecks(outcome, entry.secrets());
  return {
    result: {
      id: entry.id,
      ok: checks.every((check) => check.status !== "fail"),
      checks,
    },
    reusable: true,
  };
}

/** Preflights running now, by provider id: a concurrent request joins one. */
const IN_FLIGHT = new Map<string, Promise<ProviderValidationDto>>();

/** Completed verdicts, by provider id, reused for {@link PROVIDER_VALIDATE_REUSE_MS}. */
const RECENT = new Map<
  string,
  {
    /** When it completed, epoch ms. */
    at: number;
    /** The verdict. */
    result: ProviderValidationDto;
  }
>();

/**
 * {@link preflight}, shared per provider instance (its registry id, so a
 * provider configured again is a new instance and never gets the old
 * config's verdict): a request while one runs joins it — with that run's
 * timeout, whatever its own — and a completed verdict is reused for
 * {@link PROVIDER_VALIDATE_REUSE_MS}. A timed-out run's verdict is served to
 * the requests that shared it, and never reused.
 */
async function sharedPreflight(
  entry: RegisteredProvider,
  timeoutMs: number,
  logger: Logger,
): Promise<ProviderValidationDto> {
  const recent = RECENT.get(entry.id);
  if (recent !== undefined) {
    if (Date.now() - recent.at < PROVIDER_VALIDATE_REUSE_MS) {
      return recent.result;
    }
    RECENT.delete(entry.id);
  }
  const running = IN_FLIGHT.get(entry.id);
  if (running !== undefined) {
    return await running;
  }
  const run = preflight(entry, timeoutMs, logger)
    .then(({ result, reusable }) => {
      if (reusable) {
        const kept = { at: Date.now(), result };
        RECENT.set(entry.id, kept);
        setTimeout(() => {
          if (RECENT.get(entry.id) === kept) {
            RECENT.delete(entry.id);
          }
        }, PROVIDER_VALIDATE_REUSE_MS).unref?.();
      }
      return result;
    })
    .finally(() => {
      IN_FLIGHT.delete(entry.id);
    });
  IN_FLIGHT.set(entry.id, run);
  return await run;
}

/**
 * A provider's `describe()` facts, or `{}` when it throws: one broken
 * provider must not take the whole list down. The failure is logged through
 * the provider's redacting logger with its name and code only, never its
 * message, which may hold a secret.
 */
function safeFacts(
  entry: RegisteredProvider,
  logger: Logger,
): Readonly<Record<string, string>> {
  try {
    return entry.configured.describe();
  } catch (error) {
    redactingLogger(logger, entry.secrets()).error(
      "compute provider describe() threw; its facts are left out",
      {
        provider: entry.id,
        thrown: error instanceof Error ? error.name : typeof error,
        ...(error instanceof Error &&
        codeShaped((error as { code?: unknown }).code) !== undefined
          ? { code: (error as { code?: unknown }).code }
          : {}),
      },
    );
    return {};
  }
}

/**
 * The providers a caller is shown: each one `authorize` allows
 * `providers.read` on, asked with its id as `provider` and the context its
 * own read carries ({@link PROVIDER_READ_ROUTE}),
 * at most `FAN_OUT` at a time. Order is kept. A throwing `authorize` rejects,
 * and the request fails as any route's does.
 */
async function visibleProviders(
  services: RouteServices,
  req: BunRequest,
): Promise<RegisteredProvider[]> {
  const entries = configuredProviders();
  const allowed = await mapBounded(
    entries,
    async (entry) =>
      (
        await decide(services.config, req, {
          action: "providers.read",
          transport: "http",
          provider: entry.id,
          route: PROVIDER_READ_ROUTE,
        })
      ).allow,
  );
  return entries.filter((_, index) => allowed[index]);
}

/**
 * Whether a value in a schema is a declared secret's value: a string equal to
 * one (of any length), or a number whose text is one's (`918273` for a secret
 * of `918273` or `"918273"`).
 */
function secretEquals(
  secrets: readonly unknown[],
): (value: string | number) => boolean {
  const texts = new Set(
    secrets
      .filter(
        (secret): secret is string | number | bigint =>
          (typeof secret === "string" && secret.length > 0) ||
          (typeof secret === "number" && Number.isFinite(secret)) ||
          typeof secret === "bigint",
      )
      .map((secret) => String(secret)),
  );
  return (value) => texts.has(String(value));
}

/**
 * A JSON Schema, copied secret-free. A host bakes its own values into a
 * schema — `z.string().default(process.env.TOKEN)`, an OpenAPI `example`,
 * an `x-` extension — wherever its library puts them: under `$defs` behind a
 * `$ref`, inside `allOf`, as an object-level `default` holding the whole
 * config. So the value keywords are removed **everywhere**, whatever
 * property they sit on:
 *
 * - `default`, `example`, `examples`, `const` and every `x-*` key are
 *   dropped at every level (root, nested, `$defs`/`definitions`,
 *   combinators); a config form built from the answer gets no pre-filled
 *   values;
 * - `enum` (the allowed choices) is kept, except under a property that is a
 *   declared secret or has a credential's name (and everything under it,
 *   combinators included), where it is dropped too;
 * - every other string is redacted as a detail is (declared secrets by value,
 *   credential shapes), a string equal to a declared secret is replaced
 *   whatever its length, and a number equal to one is dropped;
 * - anything that is not JSON (a function, a cycle, a class instance), or
 *   deeper than {@link MAX_SCHEMA_DEPTH}, is dropped.
 *
 * Keys naming properties or definitions (`properties`, `patternProperties`,
 * `$defs`, `definitions`, `dependentSchemas`) are names, not keywords: a
 * property called `default` is kept.
 */
function sanitizeSchema(
  value: unknown,
  secrets: readonly unknown[],
  secretPaths: ReadonlySet<string>,
): Record<string, unknown> {
  const redact = textRedactor(secrets);
  const isSecret = secretEquals(secrets);
  const walking = new Set<object>();
  /** A scalar, redacted; `undefined` when it must be dropped. */
  const scalar = (node: unknown): unknown => {
    if (typeof node === "string") {
      return isSecret(node) ? DEFAULT_REDACT_REPLACEMENT : redact(node);
    }
    if (typeof node === "number") {
      return Number.isFinite(node) && !isSecret(node) ? node : undefined;
    }
    return node === null || typeof node === "boolean" ? node : undefined;
  };
  /** Copies a map of names to schemas, each under `pathOf(name)`. */
  function names(
    node: object,
    depth: number,
    secret: boolean,
    pathOf: (name: string) => string | undefined,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(node)) {
      const at = pathOf(name);
      const sub = copy(
        schema,
        depth + 1,
        at,
        secret ||
          isCredentialKey(name) ||
          (at !== undefined && secretPaths.has(at)),
      );
      if (sub !== undefined) {
        out[redact(name)] = sub;
      }
    }
    return out;
  }
  /** Copies one schema node (see above). */
  function copy(
    node: unknown,
    depth: number,
    path: string | undefined,
    secret: boolean,
  ): unknown {
    if (typeof node !== "object" || node === null) {
      return scalar(node);
    }
    if (depth > MAX_SCHEMA_DEPTH || walking.has(node)) {
      return undefined;
    }
    walking.add(node);
    try {
      if (Array.isArray(node)) {
        return node
          .map((item) => copy(item, depth + 1, path, secret))
          .filter((item) => item !== undefined);
      }
      const proto = Object.getPrototypeOf(node) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        return undefined;
      }
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        if (
          VALUE_KEYWORDS.has(key) ||
          key.startsWith("x-") ||
          (secret && key === "enum")
        ) {
          continue;
        }
        const isMap =
          typeof child === "object" && child !== null && !Array.isArray(child);
        let sub: unknown;
        if (isMap && key === "properties") {
          const parent = path;
          sub = names(child, depth + 1, secret, (name) => {
            if (parent === undefined) {
              return undefined;
            }
            return parent === "" ? name : `${parent}.${name}`;
          });
        } else if (isMap && NAME_MAPS.has(key)) {
          sub = names(child, depth + 1, secret, () => undefined);
        } else if (COMBINATORS.has(key)) {
          // A branch describes the same value: it keeps the path and flag.
          sub = copy(child, depth + 1, path, secret);
        } else {
          // `items`, `additionalProperties` and the like describe values
          // under this one: no config path, the flag kept.
          sub = copy(child, depth + 1, undefined, secret);
        }
        if (sub !== undefined) {
          out[redact(key)] = sub;
        }
      }
      return out;
    } finally {
      walking.delete(node);
    }
  }
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
      secrets,
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
      description: `Every compute provider configured in the API's process that the caller may read, oldest first — its id, identity, readiness, secret-free facts, and whether it has a preflight and a JSON Schema for its config — and the plugin API versions this bun-jobs speaks. Never a config value. An empty list when none is configured.\n\n**Filtered per provider.** After the request's own call (\`providers.read\`, no \`provider\`), \`authorize\` is asked once per configured provider, with its id as \`provider\` and the \`route\` its own read carries, \`GET /providers/:id/schema\` (as \`listQueues: "authorized"\` asks with \`GET /queues/:queue\`), at most 16 at a time; a provider it denies is left out. An \`authorize\` that throws fails the request.\n\n\`readiness\` is about the provider's config alone: \`ready\` once it validated and the facets were built. A summon controller that refuses a ready provider for its policy (a scale style without \`release\`, a lifetime over the platform's cap) shows that as \`failed\` on that queue's summon status, not here. A provider whose \`describe()\` throws is listed with \`facts: {}\`, and the failure logged by name and code.\n\n${PROVIDERS_NOTE}`,
      tags: ["Providers"],
      responses: { 200: ProviderListSchema },
      handler: async ({ req, services }) => ({
        body: {
          api: {
            core: COMPUTE_PROVIDER_API.core,
            summon: COMPUTE_PROVIDER_API.summon,
          },
          providers: (await visibleProviders(services, req)).map((entry) =>
            toProviderDto(
              entry,
              safeFacts(entry, services.config.logger),
              services.config.serialize,
            ),
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
      description: `Runs the provider's preflight, \`ConfiguredProvider.validate()\`: waits for its config (an asynchronous schema validates it again after a failure, as \`ready\` would), then asks the platform whether it is reachable — credentials, cluster, function — without starting compute. Bounded by \`timeoutMs\`; changes no summon controller's state.\n\n**Shared per provider instance.** A request while a preflight of the same provider runs joins it (and its timeout, whatever its own \`timeoutMs\`), and a completed verdict is reused for 5 s, so a button pressed twice reaches the platform once. A timed-out run's verdict is answered to the requests that shared it and never reused. The key is the id: a provider configured again is a new instance, and never gets the old config's verdict. \`authorize\` is still asked for every request, with the id as \`provider\`.\n\nAnswers 200 with the verdict: \`ok\` and the checks, or an \`error\` whose \`kind\` tells a bad config (\`misconfigured\`) or credentials (\`auth\`) from a platform that is failing for now (\`transient\`, \`throttled\`, \`quota\`). A config whose facets could not be built is \`misconfigured\`; any other throw that is not a \`ProviderError\` is \`transient\`; a timeout is \`transient\` with detail \`timeout\`. Every detail is redacted and cut to 128 characters.\n\n\`providers.validate\` is opt-in and a mutation: \`readOnly\` removes it, since it uses the provider's credentials.\n\n${PROVIDERS_NOTE}`,
      tags: ["Providers"],
      params: ProviderParams,
      body: ProviderValidateBodySchema,
      bodyOptional: true,
      responses: { 200: ProviderValidationSchema },
      errors: ["PROVIDER_NOT_FOUND"],
      target: ({ params }) => ({ provider: params.id }),
      handler: async ({ params, body, services }) => ({
        body: await sharedPreflight(
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
      description: `The provider's config schema as a draft-2020-12 JSON Schema, from its Standard JSON Schema converter (\`~standard.jsonSchema.input({ target: "draft-2020-12" })\`), made secret-free. \`default\`, \`example\`, \`examples\`, \`const\` and every \`x-*\` key are removed **everywhere** — root, nested, \`$defs\`/\`definitions\` and combinators — since a host's own secret baked in as a default looks like any other: a config form gets no pre-filled values. \`enum\` is kept, except under a property that is a declared secret or has a credential's name. Every other string is redacted; a string equal to a declared secret is replaced and a number equal to one dropped. 404 \`PROVIDER_SCHEMA_NOT_FOUND\` when the schema has no such converter (show the provider's facts instead) or it fails; \`GET /providers\`' \`configSchema\` says which beforehand.\n\n${PROVIDERS_NOTE}`,
      tags: ["Providers"],
      params: ProviderParams,
      responses: { 200: ProviderSchemaSchema },
      errors: ["PROVIDER_NOT_FOUND", "PROVIDER_SCHEMA_NOT_FOUND"],
      target: ({ params }) => ({ provider: params.id }),
      handler: ({ params }) => ({
        body: configSchemaOf(providerOf(params.id)),
      }),
    }),
  ];
}
