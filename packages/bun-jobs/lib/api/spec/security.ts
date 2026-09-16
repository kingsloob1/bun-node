import type {
  OpenApiSecurityScheme,
  ResolvedJobsApiDocsOptions,
} from "../config";
import { ConfigError } from "../../shared/errors";

/**
 * Security declarations for the documents. `authorize` stays opaque — the API
 * cannot know how a host authenticates — so these are documentation the host
 * supplies through `docs.securitySchemes` and `docs.security`.
 */

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
  docs:
    | Pick<ResolvedJobsApiDocsOptions, "securitySchemes" | "security">
    | false,
): OpenApiSecurity {
  const schemes = docs === false ? undefined : docs.securitySchemes;
  if (!schemes || Object.keys(schemes).length === 0) {
    if (docs !== false && docs.security && docs.security.length > 0) {
      throw new ConfigError(
        "docs.security names schemes, but docs.securitySchemes declares none",
      );
    }
    return {};
  }

  const security =
    (docs !== false && docs.security) ||
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
    security: structuredClone(security),
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
