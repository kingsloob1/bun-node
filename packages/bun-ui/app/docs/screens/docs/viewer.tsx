/**
 * The viewer: loads the one document the mount is configured with
 * (`config.documentUrl`), reads from it whether it is an OpenAPI 3.1 or an
 * AsyncAPI 3.0 document, and routes to the matching reference — `/http[…]`
 * or `/ws[…]`, with `/` redirecting to it.
 */
import type { DocumentKind, SpecDocument } from "../../api/docs";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { createContext, use, useMemo } from "react";
import { createDocsClient } from "../../api/client";
import { documentKind, docsKeys, getDocument } from "../../api/docs";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { Spinner } from "../../components/Spinner";
import { useDocsFetch, useDocsUiConfig } from "../../context";
import { Navigate, Link, Routes } from "../../router";
import type { RouteDef } from "../../routing";
import { HttpReference } from "./http";
import { WsReference } from "./ws";

/** What the loaded document is. */
export interface LoadedDocument {
  /** The document. */
  doc: SpecDocument;
  /** Its kind. */
  kind: DocumentKind;
}

/** Carries the loaded document. */
const DocumentContext = createContext<LoadedDocument | null>(null);

/** The loaded document, or a clear error outside {@link DocsViewer}. */
export function useDocument(): LoadedDocument {
  const loaded = use(DocumentContext);
  if (!loaded) {
    throw new Error("useDocument must be used inside <DocsViewer>");
  }
  return loaded;
}

/** `/http[…]` for an OpenAPI document; anything else is told there is none. */
function HttpRoute() {
  const { doc, kind } = useDocument();
  if (kind !== "openapi") {
    return (
      <div className="screen">
        <EmptyState
          headingLevel={1}
          title="No HTTP documentation"
          description="This document is not an OpenAPI document."
        />
      </div>
    );
  }
  return <HttpReference doc={doc} />;
}

/** `/ws[…]` for an AsyncAPI document; anything else is told there is none. */
function WsRoute() {
  const { doc, kind } = useDocument();
  if (kind !== "asyncapi") {
    return (
      <div className="screen">
        <EmptyState
          headingLevel={1}
          title="No WebSocket documentation"
          description="This document is not an AsyncAPI document."
        />
      </div>
    );
  }
  return <WsReference document={doc} />;
}

/** `/`: straight to the one reference this viewer has. */
function Home() {
  const { kind } = useDocument();
  return <Navigate to={kind === "asyncapi" ? "/ws" : "/http"} />;
}

/** The route table: the reference's own pages under the mount. */
const ROUTES: readonly RouteDef[] = [
  { path: "/", element: <Home /> },
  { path: "/http", element: <HttpRoute /> },
  { path: "/http/:operationId", element: <HttpRoute /> },
  { path: "/ws", element: <WsRoute /> },
  { path: "/ws/:item", element: <WsRoute /> },
];

/** The viewer, once the document has loaded. */
export function DocsViewer({ children }: { children?: ReactNode }) {
  const config = useDocsUiConfig();
  const fetcher = useDocsFetch();
  // The document URL is absolute or same-origin; the client sends it as it is.
  const client = useMemo(
    () =>
      createDocsClient({
        base: "",
        csrfHeader: config.csrfHeader,
        fetch: fetcher,
      }),
    [config.csrfHeader, fetcher],
  );
  const spec = useQuery({
    queryKey: docsKeys.document(config.documentUrl),
    queryFn: ({ signal }) => getDocument(client, config.documentUrl, signal),
    staleTime: Infinity,
  });

  if (spec.isPending) {
    return (
      <div className="screen">
        <Spinner
          label="Loading the API document"
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
          title="Could not load the API document"
          onRetry={() => void spec.refetch()}
        />
      </div>
    );
  }
  const kind = documentKind(spec.data);
  if (kind === null) {
    return (
      <div className="screen">
        <EmptyState
          headingLevel={1}
          title="Not a document this viewer can show"
          description="The document carries neither an `openapi` nor an `asyncapi` field. This viewer shows an OpenAPI 3.1 or an AsyncAPI 3.0 document."
        />
      </div>
    );
  }
  return (
    <DocumentContext value={{ doc: spec.data, kind }}>
      {children ?? (
        <Routes
          routes={ROUTES}
          notFound={<DocsNotFound />}
        />
      )}
    </DocumentContext>
  );
}

/** The 404 for a client route the viewer does not have. */
export function DocsNotFound() {
  return (
    <div className="screen">
      <Card>
        <EmptyState
          headingLevel={1}
          title="Page not found"
          description="This page is not part of the API documentation."
          action={<Link to="/">Back to the documentation</Link>}
        />
      </Card>
    </div>
  );
}
