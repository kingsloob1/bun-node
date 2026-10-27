/**
 * The WebSocket API reference (AsyncAPI 3.0): `/ws` and `/ws/:item` under the
 * mount. The document is loaded by the viewer (`../viewer.tsx`); the pure
 * reading of it is in `model.ts`, the per-item panes in `items.tsx`, the
 * extension panels in `panels.tsx`.
 */
import type { KeyboardEvent } from "react";
import type { SpecDocument } from "../../../api/docs";
import type { LimitInfo } from "./format";
import type { WsNavGroup } from "./model";
import { useMemo, useRef } from "react";
import { EmptyState } from "../../../components/EmptyState";
import { Field } from "../../../components/Field";
import { TextInput } from "../../../components/inputs";
import { arrowTarget } from "../../../components/listKeys";
import { Link } from "../../../router";
import { useParams, useQueryParam } from "../../../routing";
import { SEARCH_SHORTCUT } from "../../../shortcuts";
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
  const navRef = useRef<HTMLElement>(null);
  const links = () =>
    Array.from(
      navRef.current?.querySelectorAll<HTMLAnchorElement>("a.ws-nav-link") ??
        [],
    );
  // Arrow keys move between the links (Home/End to the ends), and ArrowDown
  // from the search goes to the first; each link stays a Tab stop too.
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = arrowTarget(event.key, links(), document.activeElement);
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };
  return (
    <nav
      ref={navRef}
      className="ws-sidebar"
      aria-label="WebSocket reference"
    >
      <Field label="Search">
        <TextInput
          type="search"
          value={query}
          onChange={onQuery}
          onKeyDown={(event) => {
            const first = links()[0];
            if (event.key === "ArrowDown" && first) {
              event.preventDefault();
              first.focus();
            }
          }}
          placeholder="Channel, message, code…"
          {...SEARCH_SHORTCUT}
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
      <div
        className="ws-sidebar-list"
        onKeyDown={onListKey}
      >
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
      </div>
    </nav>
  );
}

/** Props of {@link WsReference}. */
export interface WsReferenceProps {
  /** The AsyncAPI document. */
  document: SpecDocument;
  /** The extension prefixes to read; defaults to the configured ones. */
  extensions?: readonly string[];
  /** The subprotocol shown when the document states none. */
  defaultSubprotocol?: string;
  /** Labels and meanings for the limits, when the embedding viewer knows them. */
  limitsInfo?: Readonly<Record<string, LimitInfo>>;
}

/** The reference for a loaded document. */
export function WsReference({
  document: spec,
  extensions,
  defaultSubprotocol,
  limitsInfo,
}: WsReferenceProps) {
  const doc = useMemo(
    () => readWsDoc(spec, { extensions, defaultSubprotocol }),
    [spec, extensions, defaultSubprotocol],
  );
  const groups = useMemo(() => navGroups(doc), [doc]);
  const { item } = useParams<{ item?: string }>();
  const [query, setQuery] = useQueryParam("q");

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
            <Link to="/ws">Back to the connection</Link>.
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
            root={spec}
            channel={selection.channel}
            limitsInfo={limitsInfo}
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
            root={spec}
            message={selection.message}
          />
        );
        break;
      case "limits":
        pane = doc.limits && (
          <LimitsPanel
            limits={doc.limits}
            extensionKey={doc.extensionKeys.limits}
            limitsInfo={limitsInfo}
          />
        );
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
    <div
      className="screen ws-docs"
      data-testid="ws-docs"
    >
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
    </div>
  );
}
