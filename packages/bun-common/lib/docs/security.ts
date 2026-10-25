/**
 * Security declarations for the generated documents, moved from bun-jobs
 * (`lib/api/spec/security.ts`) in AD (a): the mapping is generic — how a host
 * authenticates stays opaque to the generator, so these are documentation the
 * host supplies through `securitySchemes` and `security`. bun-jobs' own
 * `spec/security.ts` is now a shim that translates this module's
 * {@link ConfigError} into bun-jobs' own (a `JobsError`).
 */
import { ConfigError } from "../errors";

/**
 * An OpenAPI 3.1 security scheme. Only the fields the AsyncAPI mapping reads
 * are typed; the rest pass through.
 */
export type OpenApiSecurityScheme =
  | {
      /** An API key. */
      type: "apiKey";
      /** Where the key is sent. */
      in: "header" | "query" | "cookie";
      /** The header, query parameter or cookie name. */
      name: string;
      /** Human description. */
      description?: string;
    }
  | {
      /** An HTTP authentication scheme. */
      type: "http";
      /** The scheme, e.g. `"bearer"` or `"basic"`. */
      scheme: string;
      /** A hint at the bearer token's format, e.g. `"JWT"`. */
      bearerFormat?: string;
      /** Human description. */
      description?: string;
    }
  | {
      /** OAuth 2. */
      type: "oauth2";
      /** The flows, in OpenAPI form. */
      flows: Record<string, unknown>;
      /** Human description. */
      description?: string;
    }
  | {
      /** OpenID Connect discovery. */
      type: "openIdConnect";
      /** The discovery document's URL. */
      openIdConnectUrl: string;
      /** Human description. */
      description?: string;
    };

/** The security parts of an options object {@link openApiSecurity} reads. */
export interface OpenApiSecurityOptions {
  /** `components.securitySchemes`, keyed by name. */
  securitySchemes?: Readonly<Record<string, OpenApiSecurityScheme>>;
  /** The root `security` requirement; defaults to any one of the schemes. */
  security?: readonly Record<string, readonly string[]>[];
}

/** The security parts of an OpenAPI document. */
export interface OpenApiSecurity {
  /** `components.securitySchemes`, when any are declared. */
  securitySchemes?: Record<string, OpenApiSecurityScheme>;
  /** The root `security` requirement, when any schemes are declared. */
  security?: Record<string, string[]>[];
}

/**
 * The OpenAPI security declarations. With no schemes, none. With schemes, the
 * requirement defaults to any one of them (`[{ a: [] }, { b: [] }]`); a given
 * requirement naming an undeclared scheme is refused.
 */
export function openApiSecurity(
  options: OpenApiSecurityOptions | false,
): OpenApiSecurity {
  const schemes = options === false ? undefined : options.securitySchemes;
  if (!schemes || Object.keys(schemes).length === 0) {
    if (options !== false && options.security && options.security.length > 0) {
      throw new ConfigError(
        "docs.security names schemes, but docs.securitySchemes declares none",
      );
    }
    return {};
  }

  const security =
    (options !== false && options.security) ||
    Object.keys(schemes).map((name) => ({ [name]: [] as string[] }));

  for (const requirement of security) {
    for (const name of Object.keys(requirement)) {
      if (!Object.hasOwn(schemes, name)) {
        throw new ConfigError(
          `docs.security names "${name}", which docs.securitySchemes does not declare`,
          { scheme: name },
        );
      }
    }
  }

  return {
    securitySchemes: structuredClone(schemes),
    security: structuredClone(security) as Record<string, string[]>[],
  };
}

/** An AsyncAPI 3.0 security scheme. */
export type AsyncApiSecurityScheme = Record<string, unknown> & {
  /** The AsyncAPI scheme type. */
  type: string;
};

/** An AsyncAPI scheme, and why a browser WebSocket may be unable to use it. */
export interface MappedAsyncApiScheme {
  /** The AsyncAPI 3.0 form. */
  scheme: AsyncApiSecurityScheme;
  /** Set when a browser `WebSocket` cannot carry the credential this way. */
  browserNote?: string;
}

/**
 * Maps an OpenAPI 3.1 scheme to AsyncAPI 3.0:
 * `http` → `http`, `apiKey` → `httpApiKey`, `oauth2` → `oauth2` (with each
 * flow's `scopes` renamed `availableScopes`), `openIdConnect` → `openIdConnect`.
 */
export function toAsyncApiSecurityScheme(
  scheme: OpenApiSecurityScheme,
): MappedAsyncApiScheme {
  const description =
    scheme.description === undefined ? {} : { description: scheme.description };

  switch (scheme.type) {
    case "http":
      return {
        scheme: {
          type: "http",
          scheme: scheme.scheme,
          ...(scheme.bearerFormat ? { bearerFormat: scheme.bearerFormat } : {}),
          ...description,
        },
        browserNote:
          "A browser WebSocket cannot send an Authorization header; use a cookie or a short-lived query token on the upgrade.",
      };
    case "apiKey":
      return {
        scheme: {
          type: "httpApiKey",
          in: scheme.in,
          name: scheme.name,
          ...description,
        },
        ...(scheme.in === "header"
          ? {
              browserNote: `A browser WebSocket cannot send the ${scheme.name} header.`,
            }
          : {}),
      };
    case "oauth2":
      return {
        scheme: {
          type: "oauth2",
          flows: Object.fromEntries(
            Object.entries(scheme.flows).map(([name, flow]) => {
              const { scopes, ...rest } = (flow ?? {}) as Record<
                string,
                unknown
              >;
              return [
                name,
                {
                  ...rest,
                  ...(scopes === undefined ? {} : { availableScopes: scopes }),
                },
              ];
            }),
          ),
          ...description,
        },
      };
    default:
      return {
        scheme: {
          type: "openIdConnect",
          openIdConnectUrl: scheme.openIdConnectUrl,
          ...description,
        },
      };
  }
}
