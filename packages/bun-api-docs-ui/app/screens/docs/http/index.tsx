/** The HTTP API reference (OpenAPI 3.1): `/http` and `/http/:operationId` under the mount. */
import type { DocsClient } from "../../../api/client";
import type { SpecDocument } from "../../../api/docs";
import type { PermissionProbe } from "../permissions";
import type { DocInfo, DocTagGroup } from "./model";
import { useMemo, useState } from "react";
import { createDocsClient } from "../../../api/client";
import { Badge } from "../../../components/Badge";
import { Card } from "../../../components/Card";
import { CopyButton } from "../../../components/CopyButton";
import { Dialog } from "../../../components/Dialog";
import { EmptyState } from "../../../components/EmptyState";
import {
  DocsClientContext,
  useDocsFetch,
  useDocsUiConfig,
} from "../../../context";
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

/** The app path of an operation, keeping a search; `base` is the docs section's path within the host app ("" for a standalone viewer). */
function operationHref(operationId: string, query: string, base = ""): string {
  const search = query ? `?q=${encodeURIComponent(query)}` : "";
  return `${base}/http/${encodeURIComponent(operationId)}${search}`;
}

/** The document's title, version, description and servers. */
function InfoHeader({
  info,
  serverBase,
}: {
  /** The header. */
  info: DocInfo;
  /** The resolved URL requests are sent to. */
  serverBase: string;
}) {
  const config = useDocsUiConfig();
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
          const resolved = resolveServerUrl(
            server.url,
            config.documentUrl,
            origin,
          );
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
          <dt>Requests are sent to</dt>
          <dd>
            <code data-testid="http-request-base">{serverBase}</code>
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
  pathBase,
}: {
  /** The document. */
  doc: SpecDocument;
  /** Every tag group (unfiltered). */
  groups: readonly DocTagGroup[];
  /** The search, kept on links. */
  query: string;
  /** Opens a component schema. */
  onRef: (ref: string, name: string) => void;
  /** The docs section's path within the host app. */
  pathBase: string;
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
                <Link to={operationHref(operation.id, query, pathBase)}>
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

/** Props of {@link HttpReference}. */
export interface HttpReferenceProps {
  /** The OpenAPI document. */
  doc: SpecDocument;
  /** The extension prefixes to read; defaults to the configured ones. */
  extensions?: readonly string[];
  /** The client the try-it panel sends with. Default: built on the document's resolved first server. */
  client?: DocsClient;
  /** Answers "does the caller hold this permission" (the have/lack badge and the try-it gate). */
  probe?: PermissionProbe;
  /** Whether the API is read-only. Defaults to `false`. */
  readOnly?: boolean;
  /** After a successful mutation (the host refreshes what it shows). */
  onChanged?: () => void;
  /** The docs section's path within the host app ("" for a standalone viewer). */
  pathBase?: string;
}

/** The loaded reference: sidebar, info or operation, and the schema panel. */
export function HttpReference({
  doc,
  extensions,
  client: clientOverride,
  probe,
  readOnly = false,
  onChanged,
  pathBase = "",
}: HttpReferenceProps) {
  const config = useDocsUiConfig();
  const prefixes = extensions ?? config.extensions;
  const { operationId } = useParams<{ operationId?: string }>();
  const [query, setQuery] = useQueryParam("q");
  const [panel, setPanel] = useState<string | null>(null);
  const info = useMemo(() => readInfo(doc), [doc]);
  const operations = useMemo(
    () => listOperations(doc, { extensions: prefixes }),
    [doc, prefixes],
  );
  const groups = useMemo(() => groupByTag(doc, operations), [doc, operations]);
  const visible = useMemo(() => filterGroups(groups, query), [groups, query]);
  const selected =
    operationId === undefined
      ? undefined
      : operations.find((operation) => operation.id === operationId);
  const openRef = (ref: string) => setPanel(ref);

  // The try-it panel and the snippets send to the document's first server,
  // resolved against the origin the document was fetched from.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const serverBase = resolveServerUrl(
    info.servers[0]?.url ?? "/",
    config.documentUrl,
    origin,
  );
  const fetcher = useDocsFetch();
  const client = useMemo(
    () =>
      clientOverride ??
      createDocsClient({
        base: serverBase,
        csrfHeader: config.csrfHeader,
        fetch: fetcher,
      }),
    [clientOverride, serverBase, config.csrfHeader, fetcher],
  );

  return (
    <div
      className="screen http-docs"
      data-testid="http-docs"
    >
      <div className="http-docs-title">
        <h1 className="screen-title">{info.title}</h1>
      </div>
      <div className="http-docs-layout">
        <Sidebar
          groups={visible}
          query={query}
          onQuery={(next) => setQuery(next)}
          hrefOf={(id) => operationHref(id, query, pathBase)}
        />
        <div className="http-docs-main">
          {operationId === undefined ? (
            <>
              <InfoHeader
                info={info}
                serverBase={serverBase}
              />
              <Overview
                doc={doc}
                groups={groups}
                query={query}
                onRef={openRef}
                pathBase={pathBase}
              />
            </>
          ) : selected ? (
            <DocsClientContext value={client}>
              <OperationView
                key={selected.id}
                operation={selected}
                root={doc}
                onRef={openRef}
                probe={probe}
                readOnly={readOnly}
                onChanged={onChanged}
              />
            </DocsClientContext>
          ) : (
            <EmptyState
              title="No such operation"
              description={`This document has no operation "${operationId}".`}
              action={<Link to={`${pathBase}/http`}>All operations</Link>}
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
