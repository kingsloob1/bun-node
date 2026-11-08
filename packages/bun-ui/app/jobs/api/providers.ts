import type { ApiClient } from "./client";
import type {
  ProviderListDto,
  ProviderSchemaDto,
  ProviderValidationDto,
} from "./types";
import { assertShape } from "./shape";

/**
 * The compute providers configured in the API's process: `GET /providers`
 * (`providers.read`), "Test connection" (`POST /providers/:id/validate`,
 * `providers.validate`) and a provider's config schema (`GET
 * /providers/:id/schema`, `providers.read`).
 *
 * Both actions are opt-in, and a disabled one is not routed at all (404
 * `ROUTE_NOT_FOUND`), the way `queues.summon` is. So the UI gates on the
 * permission first and reads nothing without it. A provider id is
 * `name@version~n`, which needs percent-encoding in a path.
 */

/** `/providers/:id…`, relative to the API base. */
function providerPath(id: string, suffix = ""): string {
  return `/providers/${encodeURIComponent(id)}${suffix}`;
}

/** Query keys of the provider reads. */
export const providerKeys = {
  /** `GET /providers`. */
  list: ["providers"] as const,
  /** `GET /providers/:id/schema`. */
  schema: (id: string) => ["providers", "schema", id] as const,
};

/** `GET /providers`. */
export async function listProviders(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<ProviderListDto> {
  const path = "/providers";
  const body = await api.request<unknown>("GET", path, { signal });
  return assertShape<ProviderListDto>(
    body,
    (fields) =>
      Array.isArray(fields.providers) &&
      fields.providers.every(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as { id?: unknown }).id === "string" &&
          typeof (item as { readiness?: unknown }).readiness === "string",
      ),
    "the providers",
    path,
  );
}

/**
 * `POST /providers/:id/validate`: the provider's preflight ("Test
 * connection"). A preflight that fails still answers 200, with `ok: false`
 * and the checks or an `error`, so only a refused or broken request throws.
 */
export async function validateProvider(
  api: ApiClient,
  id: string,
): Promise<ProviderValidationDto> {
  const path = providerPath(id, "/validate");
  const body = await api.request<unknown>("POST", path, { body: {} });
  return assertShape<ProviderValidationDto>(
    body,
    (fields) => typeof fields.ok === "boolean" && Array.isArray(fields.checks),
    "a provider validation",
    path,
  );
}

/** `GET /providers/:id/schema`: the provider's config schema, secret-free. */
export async function getProviderSchema(
  api: ApiClient,
  id: string,
  signal?: AbortSignal,
): Promise<ProviderSchemaDto> {
  const path = providerPath(id, "/schema");
  const body = await api.request<unknown>("GET", path, { signal });
  return assertShape<ProviderSchemaDto>(
    body,
    (fields) => typeof fields.schema === "object" && fields.schema !== null,
    "a provider's config schema",
    path,
  );
}
