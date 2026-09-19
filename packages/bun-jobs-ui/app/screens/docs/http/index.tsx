/** The HTTP API reference (OpenAPI 3.1): `/docs/http` and `/docs/http/:operationId`. */
import type { SpecDocument } from "../../../api/docs";
import type { DocInfo, DocTagGroup } from "./model";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { docsKeys, getOpenApiDocument } from "../../../api/docs";
import { Badge } from "../../../components/Badge";
import { Card } from "../../../components/Card";
import { CopyButton } from "../../../components/CopyButton";
import { Dialog } from "../../../components/Dialog";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorView } from "../../../components/ErrorView";
import { Spinner } from "../../../components/Spinner";
import { useApiClient, useUiConfig } from "../../../context";
import { useMeta } from "../../../meta/hooks";
import { Link } from "../../../router";
import { useParams, useQueryParam } from "../../../routing";
import { Prose } from "../schema/Prose";
import { refName } from "../schema/resolve";
import { SchemaTree } from "../schema/SchemaTree";
import {
  componentSchemaNames,
  filterGroups,
  groupByTag,
  listOperations,
  readInfo,
  resolveServerUrl,
} from "./model";
import { OperationView } from "./OperationView";
import { Sidebar } from "./Sidebar";
import "./http.css";

/** The app path of an operation, keeping a search. */
function operationHref(operationId: string, query: string): string {
  const search = query ? `?q=${encodeURIComponent(query)}` : "";
  return `/docs/http/${encodeURIComponent(operationId)}${search}`;
}

/** The document's title, version, description and servers. */
function InfoHeader({ info }: { /** The header. */ info: DocInfo }) {
  const config = useUiConfig();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <Card className="http-info">
      <div className="http-info-line">
        <Badge tone="accent">{`OpenAPI ${info.openapi}`}</Badge>
        {info.version && <Badge tone="neutral">{`v${info.version}`}</Badge>}
      </div>
      {info.description && (
        <div className="http-description">
          <Prose text={info.description} />
        </div>
      )}
      <dl
        className="http-servers"
        data-testid="http-servers"
      >
        {info.servers.map((server) => {
          const resolved = resolveServerUrl(server.url, config.apiBase, origin);
          return (
            <div key={server.url}>
              <dt>
                Server <code>{server.url}</code>
                {server.description ? ` (${server.description})` : ""}
              </dt>
              <dd>
                <code data-testid="http-server-url">{resolved}</code>
                <CopyButton
                  text={resolved}
                  ariaLabel="Copy the server URL"
                />
              </dd>
            </div>
          );
        })}
        <div>
          <dt>This app sends to</dt>
          <dd>
            <code>{config.apiBase}</code>
          </dd>
        </div>
      </dl>
      <p className="http-muted">Paths below are relative to the server.</p>
    </Card>
  );
}

/** The landing view: tags with their operations, and the component schemas. */
function Overview({
  doc,
  groups,
  query,
  onRef,
}: {
  /** The document. */
  doc: SpecDocument;
  /** Every tag group (unfiltered). */
  groups: readonly DocTagGroup[];
  /** The search, kept on links. */
  query: string;
  /** Opens a component schema. */
  onRef: (ref: string, name: string) => void;
}) {
  const names = componentSchemaNames(doc);
  return (
    <div className="http-overview">
      {groups.map((group) => (
        <Card
          key={group.name}
          title={group.name}
        >
          {group.description && (
            <p className="http-muted">{group.description}</p>
          )}
          <ul className="http-overview-ops">
            {group.operations.map((operation) => (
              <li key={operation.id}>
                <Link to={operationHref(operation.id, query)}>
                  <code>{operation.method}</code> {operation.path}
                </Link>
                {operation.summary && (
                  <span className="http-muted">{` ${operation.summary}`}</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ))}
      {names.length > 0 && (
        <Card title="Schemas">
          <ul
            className="http-components"
            data-testid="http-components"
          >
            {names.map((name) => (
              <li
                key={name}
                id={`schema-${name}`}
              >
                <button
                  type="button"
                  className="schema-ref schema-ref-link"
                  onClick={() => onRef(`#/components/schemas/${name}`, name)}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** The side panel showing one component schema; a `$ref` inside it replaces it. */
function SchemaPanel({
  doc,
  refValue,
  onClose,
  onRef,
}: {
  /** The document. */
  doc: SpecDocument;
  /** The component shown, or `null` when closed. */
  refValue: string | null;
  /** Closes it. */
  onClose: () => void;
  /** Shows another component. */
  onRef: (ref: string, name: string) => void;
}) {
  return (
    <Dialog
      open={refValue !== null}
      onClose={onClose}
      title={refValue === null ? "" : refName(refValue)}
      description={refValue ?? undefined}
      size="lg"
      className="http-schema-panel"
    >
      {refValue !== null && (
        <SchemaTree
          key={refValue}
          schema={{ $ref: refValue }}
          root={doc}
          depth={2}
          onRef={onRef}
          label={`Schema ${refName(refValue)}`}
        />
      )}
    </Dialog>
  );
}

/** The loaded reference: sidebar, info or operation, and the schema panel. */
function HttpReference({
  doc,
}: {
  /** The OpenAPI document. */ doc: SpecDocument;
}) {
  const { operationId } = useParams<{ operationId?: string }>();
  const [query, setQuery] = useQueryParam("q");
  const [panel, setPanel] = useState<string | null>(null);
  const info = useMemo(() => readInfo(doc), [doc]);
  const operations = useMemo(() => listOperations(doc), [doc]);
  const groups = useMemo(() => groupByTag(doc, operations), [doc, operations]);
  const visible = useMemo(() => filterGroups(groups, query), [groups, query]);
  const selected =
    operationId === undefined
      ? undefined
      : operations.find((operation) => operation.id === operationId);
  const openRef = (ref: string) => setPanel(ref);

  return (
    <div
      className="screen http-docs"
      data-testid="http-docs"
    >
      <div className="http-docs-title">
        <h1 className="screen-title">{info.title}</h1>
        <Link to="/docs">All API docs</Link>
      </div>
      <div className="http-docs-layout">
        <Sidebar
          groups={visible}
          query={query}
          onQuery={(next) => setQuery(next)}
          hrefOf={(id) => operationHref(id, query)}
        />
        <div className="http-docs-main">
          {operationId === undefined ? (
            <>
              <InfoHeader info={info} />
              <Overview
                doc={doc}
                groups={groups}
                query={query}
                onRef={openRef}
              />
            </>
          ) : selected ? (
            <OperationView
              key={selected.id}
              operation={selected}
              root={doc}
              onRef={openRef}
            />
          ) : (
            <EmptyState
              title="No such operation"
              description={`This API documents no operation "${operationId}". It may be pruned by the API's mode, read-only setting or actions.`}
              action={<Link to="/docs/http">All operations</Link>}
            />
          )}
        </div>
      </div>
      <SchemaPanel
        doc={doc}
        refValue={panel}
        onClose={() => setPanel(null)}
        onRef={openRef}
      />
    </div>
  );
}

/** `/docs/http[/:operationId]`: the operations, and one of them with its try-it panel. */
export function HttpDocsScreen() {
  const api = useApiClient();
  const { docs } = useMeta();
  const path = docs?.openapi;
  const spec = useQuery({
    queryKey: docsKeys.openapi(path ?? ""),
    queryFn: ({ signal }) => getOpenApiDocument(api, path!, signal),
    enabled: path !== undefined,
    staleTime: Infinity,
  });

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
  return <HttpReference doc={spec.data} />;
}
