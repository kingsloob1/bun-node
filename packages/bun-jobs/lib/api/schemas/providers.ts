import { s } from "../schema/builder";
import {
  ProviderReadinessSchema,
  SERVABLE_FACTS_NOTE,
  SummonProviderSchema,
} from "./queues";

/**
 * The compute provider routes' schemas: `GET /providers`, `POST
 * /providers/{id}/validate` and `GET /providers/{id}/schema` (plugins §14.1).
 */

/** The shortest preflight wait a request may ask for, in ms. */
export const MIN_PROVIDER_VALIDATE_TIMEOUT_MS = 1_000;

/** The longest preflight wait a request may ask for, in ms. */
export const MAX_PROVIDER_VALIDATE_TIMEOUT_MS = 60_000;

/** How long a preflight is waited for when the request does not say, in ms. */
export const DEFAULT_PROVIDER_VALIDATE_TIMEOUT_MS = 15_000;

/** The kinds a preflight failure classifies as: `ProviderErrorKind`'s. */
export const PROVIDER_ERROR_KINDS = [
  "transient",
  "throttled",
  "quota",
  "auth",
  "misconfigured",
  "conflict",
] as const;

/** A provider's id, the `:id` path parameter. */
export const ProviderParams = s.query(
  s.object({
    id: s.string({
      minLength: 1,
      maxLength: 512,
      description:
        "The configured provider's id, `name@version~<n>`: from `GET /providers` or a summon status's `summoner.providerId`. `@`, `:` and `~` are URL-safe; percent-encode a scoped name's `/`.",
    }),
  }),
);

/** One configured provider. Mirrors `ProviderDto`. */
const ProviderSchema = s.object({
  id: s.string({
    description:
      "The instance's id, `name@version~<n>`: the nth instance of that `name@version` configured in the API's process. Stable for that process's life, meaningless in another.",
  }),
  provider: SummonProviderSchema,
  readiness: ProviderReadinessSchema(
    "How far its config has got: `ready` (validated, facets built), `pending` (an asynchronous schema is still validating it), `failed` (the latest validation rejected, or building its facets threw). About the config alone: a controller refusing a ready provider for its policy shows on that queue's summon status, not here.",
  ),
  facts: s.record(s.string(), {
    description: `Secret-free facts from its \`describe()\`, \`{}\` until its config is known or when \`describe()\` throws. ${SERVABLE_FACTS_NOTE}`,
  }),
  preflight: s.boolean({
    description:
      "Whether it defines a preflight, so `POST /providers/{id}/validate` checks the platform and not the config alone.",
  }),
  configSchema: s.boolean({
    description:
      "Whether its config schema implements Standard JSON Schema, so `GET /providers/{id}/schema` answers one.",
  }),
});

/** `GET /providers`. Mirrors `ProviderListDto`. */
export const ProviderListSchema = s.named(
  "ProviderList",
  s.object(
    {
      api: s.object({
        core: s.string({
          description: "The core plugin API version, `major.minor`.",
        }),
        summon: s.string({
          description: "The summon facet version, `major.minor`.",
        }),
      }),
      providers: s.array(ProviderSchema, {
        description:
          "The compute providers configured in the API's process, oldest first; empty when none is.",
      }),
    },
    {
      description:
        "The compute providers configured in the API's process, and the plugin API versions it speaks.",
    },
  ),
);

/** `POST /providers/:id/validate` body. Mirrors `ProviderValidateBody`. */
export const ProviderValidateBodySchema = s.object({
  timeoutMs: s.optional(
    s.integer({
      minimum: MIN_PROVIDER_VALIDATE_TIMEOUT_MS,
      maximum: MAX_PROVIDER_VALIDATE_TIMEOUT_MS,
      default: DEFAULT_PROVIDER_VALIDATE_TIMEOUT_MS,
      description:
        "How long to wait for the preflight, in ms. Past it the answer is `ok: false` with an `error` of kind `transient` and detail `\"timeout\"`, and the preflight's signal aborts. A request that joins a run already in flight shares that run's timeout.",
    }),
  ),
});

/** What a preflight found. Mirrors `ProviderValidationDto`. */
export const ProviderValidationSchema = s.named(
  "ProviderValidation",
  s.object(
    {
      id: s.string({ description: "The provider's id, as asked." }),
      ok: s.boolean({
        description:
          "Whether the preflight passed: it answered, and no check is `fail`.",
      }),
      checks: s.array(
        s.object({
          id: s.string({
            description: "A stable id for the check, e.g. `credentials`.",
          }),
          status: s.enum(["pass", "warn", "fail"], {
            description:
              "Whether it passed; `warn` works but something is off.",
          }),
          detail: s.optional(
            s.string({
              description:
                "A short explanation, redacted and cut to 128 characters.",
            }),
          ),
        }),
        {
          description:
            "What the preflight answered; empty when it threw, timed out, or the provider has none.",
        },
      ),
      error: s.optional(
        s.object(
          {
            kind: s.enum(PROVIDER_ERROR_KINDS, {
              description:
                "How the failure classifies, as a `ProviderError`'s kind: `auth` and `misconfigured` are the config's or the credentials' fault; `transient`, `throttled` and `quota` the platform's for now; `conflict` a provider bug. A throw that is not a `ProviderError`, and a timeout, are `transient`.",
            }),
            detail: s.string({
              description:
                "A short, secret-free explanation: the `ProviderError`'s `platformCode` (else its code), another error's code or name, `timeout`, or `invalid config: <paths>`. Redacted and cut to 128 characters.",
            }),
          },
          {
            description:
              "Why there are no checks: the config did not validate or its facets could not be built (`misconfigured`), or the preflight threw or timed out.",
          },
        ),
      ),
    },
    {
      description:
        "A preflight's verdict, answered with 200 whatever the platform said.",
    },
  ),
);

/** A provider's config as a JSON Schema. Mirrors `ProviderSchemaDto`. */
export const ProviderSchemaSchema = s.named(
  "ProviderConfigSchema",
  s.object(
    {
      id: s.string({ description: "The provider's id, as asked." }),
      target: s.literal("draft-2020-12", {
        description: "The JSON Schema dialect.",
      }),
      schema: s.record(s.unknown(), {
        description:
          "The config's input JSON Schema, from `~standard.jsonSchema.input({ target })`, made secret-free. `default`, `example`, `examples`, `const` and every `x-*` key are removed everywhere (root, nested, `$defs`, combinators): a form built from it has no pre-filled values. `enum` is kept, except under a property that is a declared secret or has a credential's name, and in every definition such a property reaches through `$ref`, transitively (one reached from both a secret and a non-secret property counts as secret; a pointer into a definition counts as all of it, and one anywhere else in the document, `#` included, drops every enum). Enums with non-scalar values are dropped wherever they are. Every other string is redacted as a detail is; a string equal to a declared secret is replaced, a number equal to one dropped.",
      }),
    },
    {
      description:
        "A provider's config as a JSON Schema, for a config form. Only for a config schema that implements Standard JSON Schema.",
    },
  ),
);
