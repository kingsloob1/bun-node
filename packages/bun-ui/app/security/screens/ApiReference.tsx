/**
 * The management API's own reference (ui.md §1: bun-ui's `/docs/embed`, as
 * the jobs UI embeds it): its OpenAPI document, read-only (no try-it: the
 * security API's calls change what protects the services).
 */
import type { SpecDocument } from "@kingsleyweb/bun-ui/docs/embed";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  DocsUiConfigContext,
  HttpReference,
} from "@kingsleyweb/bun-ui/docs/embed";
import { Spinner } from "../../kit/components/Spinner";
import { errorFromResponse } from "../api/errors";
import { queryKeys } from "../api/keys";
import { ErrorView } from "../components/ErrorView";
import { useSecurityClient, useUiConfig } from "../context";

/** See the module's description. */
export function ApiReference() {
  const api = useSecurityClient();
  const config = useUiConfig();
  const spec = useQuery({
    queryKey: queryKeys.openapi(),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }) => {
      const response = await api.fetch(config.docs.openapi, { signal });
      if (!response.ok) throw await errorFromResponse(response);
      return (await response.json()) as SpecDocument;
    },
  });
  const pageConfig = useMemo(
    () => ({
      version: 1 as const,
      title: config.title,
      basePath: config.basePath,
      assetsPath: config.assetsPath,
      documentUrl: config.docs.openapi,
      csrfHeader: config.csrfHeader,
      extensions: ["x-bun-common", "x-bun-security"],
      theme: config.theme,
      layout: config.layout,
      // The app redirects through its own `unauthorized`; the embedded screens never do.
      unauthorized: null,
    }),
    [config],
  );
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
        doc={spec.data}
        pathBase="/api"
        readOnly
      />
    </DocsUiConfigContext>
  );
}
