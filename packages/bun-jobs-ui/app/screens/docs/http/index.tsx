/**
 * The HTTP API reference (OpenAPI 3.1): `/docs/http` and
 * `/docs/http/:operationId`. The viewer is the package's
 * (`@kingsleyweb/bun-api-docs-ui/embed`); this wrapper fetches the document
 * with the app's client and injects the app's seams: its client for the
 * try-it (so the CSRF header and `Content-Type` rules are the app's own), the
 * permission probe, the read-only flag, and the query invalidation after a
 * mutation.
 */
import type { JobsApiAction } from "../../../api/contract";
import type {
  ApiError as DocsApiErrorShape,
  DocsClient,
  SpecDocument,
} from "@kingsleyweb/bun-api-docs-ui/embed";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  ApiError as DocsApiError,
  DocsUiConfigContext,
  HttpReference,
} from "@kingsleyweb/bun-api-docs-ui/embed";
import { docsKeys, getOpenApiDocument } from "../../../api/docs";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorView } from "../../../components/ErrorView";
import { Spinner } from "../../../components/Spinner";
import { useApiClient, useUiConfig } from "../../../context";
import { useCanFn, useMeta } from "../../../meta/hooks";

/** The app's ApiError as the package's (same fields; the class is the package's). */
function toDocsApiError(error: DocsApiErrorShape | undefined) {
  return error === undefined
    ? undefined
    : new DocsApiError({
        kind: error.kind,
        status: error.status,
        code: error.code,
        title: error.title,
        detail: error.detail,
        type: error.type,
        issues: error.issues,
        context: error.context,
        instance: error.instance,
      });
}

/** `/docs/http[/:operationId]`: the operations, and one of them with its try-it panel. */
export function HttpDocsScreen() {
  const api = useApiClient();
  const config = useUiConfig();
  const meta = useMeta();
  const can = useCanFn();
  const queryClient = useQueryClient();
  const { docs } = meta;
  const path = docs?.openapi;
  const spec = useQuery({
    queryKey: docsKeys.openapi(path ?? ""),
    queryFn: ({ signal }) => getOpenApiDocument(api, path!, signal),
    enabled: path !== undefined,
    staleTime: Infinity,
  });

  // The try-it sends through the app's own client: same CSRF header and
  // problem parsing as every other screen, with the errors re-homed to the
  // package's class (the panel's `isApiError` is the package's own).
  const client = useMemo<DocsClient>(
    () => ({
      base: api.base,
      request: (method, requestPath, options) =>
        api.request(method, requestPath, options),
      requestRaw: async (method, requestPath, options) => {
        const raw = await api.requestRaw(method, requestPath, options);
        return { ...raw, error: toDocsApiError(raw.error) };
      },
    }),
    [api],
  );
  // The page config the package's screens read: the app's CSRF header and
  // mount; the rest is the standalone defaults.
  const pageConfig = useMemo(
    () => ({
      version: 1 as const,
      title: config.title,
      basePath: config.basePath,
      assetsPath: config.assetsPath,
      documentUrl: path ?? "",
      csrfHeader: config.csrfHeader,
      extensions: ["x-bun-common", "x-bun-jobs"],
      theme: config.theme,
    }),
    [config, path],
  );

  if (path === undefined) {
    return (
      <div className="screen">
        <EmptyState
          headingLevel={1}
          title="No HTTP documentation"
          description="This API does not serve its OpenAPI document."
        />
      </div>
    );
  }
  if (spec.isPending) {
    return (
      <div className="screen">
        <Spinner
          label="Loading the OpenAPI document"
          showLabel
        />
      </div>
    );
  }
  if (spec.isError) {
    return (
      <div className="screen">
        <ErrorView
          headingLevel={1}
          error={spec.error}
          title="Could not load the OpenAPI document"
          onRetry={() => void spec.refetch()}
        />
      </div>
    );
  }
  return (
    <DocsUiConfigContext value={pageConfig}>
      <HttpReference
        doc={spec.data as SpecDocument}
        pathBase="/docs"
        client={client}
        probe={(action) => can(action as JobsApiAction)}
        readOnly={meta.readOnly}
        onChanged={() =>
          void queryClient.invalidateQueries({
            predicate: (query) => query.queryKey[0] !== docsKeys.all[0],
          })
        }
      />
    </DocsUiConfigContext>
  );
}
