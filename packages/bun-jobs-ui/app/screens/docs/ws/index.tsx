/**
 * The WebSocket API reference (AsyncAPI 3.0): `/docs/ws` and `/docs/ws/:item`.
 * The document comes from `meta.docs.asyncapi`; the pure reading of it is in
 * `model.ts`, the per-item panes in `items.tsx`, the extension panels in
 * `panels.tsx`.
 */
import type { SpecDocument } from "../../../api/docs";
import type { WsNavGroup } from "./model";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { docsKeys, getAsyncApiDocument } from "../../../api/docs";
import { Card } from "../../../components/Card";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorView } from "../../../components/ErrorView";
import { Field } from "../../../components/Field";
import { TextInput } from "../../../components/inputs";
import { Spinner } from "../../../components/Spinner";
import { useApiClient } from "../../../context";
import { useNav } from "../../../layout/useNav";
import { useMeta } from "../../../meta/hooks";
import { Link } from "../../../router";
import { useParams, useQueryParam } from "../../../routing";
import { ChannelPane, MessagePane, OperationPane } from "./items";
import {
  filterGroups,
  itemPath,
  navGroups,
  readWsDoc,
  selectItem,
} from "./model";
import {
  CloseCodesPanel,
  DocHeader,
  LimitsPanel,
  RefusalsPanel,
  SecurityPanel,
  ServerPanel,
} from "./panels";
import "./ws.css";

/** Props of {@link WsSidebar}. */
interface WsSidebarProps {
  /** The groups, before searching. */
  groups: readonly WsNavGroup[];
  /** The selected slug. */
  selected: string;
  /** The search (`?q=`). */
  query: string;
  /** Sets the search. */
  onQuery: (query: string) => void;
}

/** The sidebar: a search box, then the connection's panels, channels, operations and messages. */
function WsSidebar({ groups, selected, query, onQuery }: WsSidebarProps) {
  const shown = filterGroups(groups, query);
  return (
    <nav
      className="ws-sidebar"
      aria-label="WebSocket reference"
    >
      <Field label="Search">
        <TextInput
          type="search"
          value={query}
          onChange={onQuery}
          placeholder="Channel, message, code…"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      {shown.length === 0 && (
        <p
          className="muted"
          data-testid="ws-search-empty"
        >
          Nothing matches “{query}”.
        </p>
      )}
      {shown.map((group) => (
        <section
          key={group.title}
          className="ws-group"
          data-testid={`ws-group-${group.title}`}
        >
          <h2 className="ws-group-title">{group.title}</h2>
          <ul>
            {group.items.map((item) => (
              <li key={item.slug}>
                <Link
                  to={itemPath(item.slug, query)}
                  className="ws-nav-link"
                  activeMatch="exact"
                  data-selected={item.slug === selected ? "true" : undefined}
                  data-testid={`ws-nav-${item.slug}`}
                >
                  <span className="ws-nav-label">{item.label}</span>
                  {item.hint && (
                    <span className="ws-nav-hint">{item.hint}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

/** Props of {@link WsReference}. */
export interface WsReferenceProps {
  /** The AsyncAPI document. */
  document: SpecDocument;
}

/** The reference for a loaded document. */
export function WsReference({ document }: WsReferenceProps) {
  const doc = useMemo(() => readWsDoc(document), [document]);
  const groups = useMemo(() => navGroups(doc), [doc]);
  const { item } = useParams<{ item?: string }>();
  const [query, setQuery] = useQueryParam("q");
  const consoleAvailable = useNav().some((entry) => entry.id === "events");

  const connection = doc.channels.find((channel) => channel.isConnection);
  const slug = item ?? connection?.slug ?? doc.channels[0]?.slug ?? "";
  const selection = selectItem(doc, slug);

  let pane;
  if (selection === null) {
    pane = (
      <EmptyState
        title="No such item"
        description={
          <>
            This document has nothing called <code>{slug}</code>.{" "}
            <Link to="/docs/ws">Back to the connection</Link>.
          </>
        }
      />
    );
  } else {
    switch (selection.kind) {
      case "channel":
        pane = (
          <ChannelPane
            doc={doc}
            root={document}
            channel={selection.channel}
            consoleAvailable={consoleAvailable}
          />
        );
        break;
      case "operation":
        pane = (
          <OperationPane
            doc={doc}
            operation={selection.operation}
          />
        );
        break;
      case "message":
        pane = (
          <MessagePane
            doc={doc}
            root={document}
            message={selection.message}
            consoleAvailable={consoleAvailable}
          />
        );
        break;
      case "limits":
        pane = doc.limits && <LimitsPanel limits={doc.limits} />;
        break;
      case "close-codes":
        pane = <CloseCodesPanel doc={doc} />;
        break;
      case "upgrade-refusals":
        pane = <RefusalsPanel doc={doc} />;
        break;
    }
  }

  return (
    <>
      <DocHeader doc={doc} />
      <div className="ws-overview">
        <ServerPanel doc={doc} />
        <SecurityPanel doc={doc} />
      </div>
      <div className="ws-layout">
        <WsSidebar
          groups={groups}
          selected={selection ? slug : ""}
          query={query}
          onQuery={setQuery}
        />
        <section
          className="ws-main"
          aria-label="Selected item"
          data-testid="ws-main"
          data-selected={selection ? slug : ""}
        >
          {pane}
        </section>
      </div>
    </>
  );
}

/** `/docs/ws[/:item]`: the channels, operations and messages of the live-events socket. */
export function WsDocsScreen() {
  const api = useApiClient();
  const { docs } = useMeta();
  const path = docs?.asyncapi;
  const document = useQuery({
    queryKey: docsKeys.asyncapi(path ?? ""),
    queryFn: ({ signal }) => getAsyncApiDocument(api, path!, signal),
    enabled: path !== undefined,
    staleTime: Infinity,
  });

  let body;
  if (path === undefined) {
    body = (
      <>
        <h1 className="screen-title">WebSocket API</h1>
        <EmptyState
          title="This API has no live-events socket"
          description="There is no AsyncAPI document to show: the API was created without its WebSocket, so the screens refresh by polling over HTTP."
          action={<Link to="/docs">Back to the API docs</Link>}
        />
      </>
    );
  } else if (document.data) {
    body = <WsReference document={document.data} />;
  } else if (document.error) {
    body = (
      <>
        <h1 className="screen-title">WebSocket API</h1>
        <ErrorView
          error={document.error}
          title="Could not load the AsyncAPI document"
          onRetry={() => void document.refetch()}
        />
      </>
    );
  } else {
    body = (
      <>
        <h1 className="screen-title">WebSocket API</h1>
        <Card>
          <Spinner
            label="Loading the AsyncAPI document"
            showLabel
          />
        </Card>
      </>
    );
  }
  return (
    <div
      className="screen ws-docs"
      data-testid="ws-docs"
    >
      {body}
    </div>
  );
}
