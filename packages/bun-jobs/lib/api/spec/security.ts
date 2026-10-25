/**
 * Moved to bun-common in AD (a) (plan `docs/plans/api-docs-generation/` §6.1).
 * This shim keeps the import sites and tests where they are, and translates
 * the one error the moved code throws: bun-common's `ConfigError` becomes
 * bun-jobs' own (a `JobsError`, code `"CONFIG"`), same message, the details
 * carried as the context — so `instanceof ConfigError` and
 * `error.context.scheme` keep holding for callers.
 */
import { ConfigError as BunCommonConfigError } from "@kingsleyweb/bun-common";
import type { OpenApiSecurity } from "@kingsleyweb/bun-common/lib/docs/security";
import { openApiSecurity as openApiSecurityBase } from "@kingsleyweb/bun-common/lib/docs/security";
import type { ResolvedJobsApiDocsOptions } from "../config";
import { ConfigError } from "../../shared/errors";

export {
  type AsyncApiSecurityScheme,
  type MappedAsyncApiScheme,
  type OpenApiSecurity,
  type OpenApiSecurityOptions,
  toAsyncApiSecurityScheme,
} from "@kingsleyweb/bun-common/lib/docs/security";

/**
 * The OpenAPI security declarations, over bun-common's moved implementation.
 * See `@kingsleyweb/bun-common/lib/docs/security`.
 */
export function openApiSecurity(
  docs:
    Pick<ResolvedJobsApiDocsOptions, "securitySchemes" | "security"> | false,
): OpenApiSecurity {
  try {
    return openApiSecurityBase(docs);
  } catch (error) {
    if (error instanceof BunCommonConfigError) {
      throw new ConfigError(error.message, error.details);
    }
    throw error;
  }
}
