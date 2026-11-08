import type { KeyboardEvent } from "react";
import type { DocSection, DocTagGroup } from "./model";
import { useRef } from "react";
import { TextInput } from "../../../components/inputs";
import { arrowTarget } from "../../../components/listKeys";
import { SEARCH_SHORTCUT } from "../../../shortcuts";
import { Link } from "../../../router";
import { MethodBadge } from "./OperationView";

/** Props of {@link Sidebar}. */
export interface SidebarProps {
  /** The groups to list, already filtered by the search. */
  groups: readonly DocTagGroup[];
  /**
   * The document's sections over those groups (`x-tagGroups`), already
   * filtered: each heads its tags, one level deeper. Default: none, and the
   * groups are listed at the top level.
   */
  sections?: readonly DocSection[];
  /** The search text (`?q=`). */
  query: string;
  /** Sets the search text. */
  onQuery: (query: string) => void;
  /** The link to an operation, keeping the search. */
  hrefOf: (operationId: string) => string;
}

/** The links of a sidebar, in order. */
function links(root: HTMLElement | null): HTMLAnchorElement[] {
  return root
    ? Array.from(root.querySelectorAll<HTMLAnchorElement>("a.http-op-link"))
    : [];
}

/** One tag's heading and its operations' links. */
function TagBlock({
  group,
  headingId,
  level,
  hrefOf,
}: {
  /** The tag and its operations. */
  group: DocTagGroup;
  /** The heading's id, unique in the sidebar (a tag can be in two sections). */
  headingId: string;
  /** The heading's level: 2 at the top, 3 inside a section. */
  level: 2 | 3;
  /** The link to an operation. */
  hrefOf: (operationId: string) => string;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section
      className="http-tag"
      aria-labelledby={headingId}
    >
      <Heading
        id={headingId}
        className="http-tag-name"
        title={group.description}
      >
        {group.name}
      </Heading>
      <ul className="http-tag-ops">
        {group.operations.map((operation) => (
          <li key={operation.id}>
            <Link
              to={hrefOf(operation.id)}
              className="http-op-link"
              activeMatch="exact"
              data-operation={operation.id}
            >
              <MethodBadge method={operation.method} />
              <span className="http-op-text">
                <span className="http-op-path">{operation.path}</span>
                {operation.summary && (
                  <span className="http-op-summary">{operation.summary}</span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The operations by tag (by section, then tag, when the document declares
 * `x-tagGroups`), with method badges, and a search over path,
 * operation id and summary. Arrow keys move between operations (Home/End to
 * the ends), and ArrowDown from the search goes to the first match.
 */
export function Sidebar({
  groups,
  sections,
  query,
  onQuery,
  hrefOf,
}: SidebarProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const count = groups.reduce((sum, group) => sum + group.operations.length, 0);

  function onListKey(event: KeyboardEvent<HTMLDivElement>) {
    const target = arrowTarget(
      event.key,
      links(listRef.current),
      document.activeElement,
    );
    if (target) {
      event.preventDefault();
      target.focus();
    }
  }

  return (
    <nav
      className="http-sidebar"
      aria-label="Operations"
    >
      <TextInput
        type="search"
        value={query}
        aria-label="Search operations"
        placeholder="Search path, id, summary"
        {...SEARCH_SHORTCUT}
        onChange={(value) => onQuery(value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            const first = links(listRef.current)[0];
            if (first) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      />
      <p
        className="http-muted http-sidebar-count"
        aria-live="polite"
      >
        {count === 1 ? "1 operation" : `${count} operations`}
      </p>
      {/* Arrow keys move between the links; each link stays a tab stop too. */}
      <div
        ref={listRef}
        className="http-sidebar-list"
        onKeyDown={onListKey}
      >
        {sections === undefined
          ? groups.map((group) => (
              <TagBlock
                key={group.name}
                group={group}
                headingId={`tag-${group.name}`}
                level={2}
                hrefOf={hrefOf}
              />
            ))
          : sections.map((section, index) => (
              <section
                // Two sections may share a name in a hand-written document.
                key={`${index}-${section.name}`}
                className="http-section"
                aria-labelledby={`section-${index}`}
              >
                <h2
                  id={`section-${index}`}
                  className="http-section-name"
                >
                  {section.name}
                </h2>
                {section.tags.map((group) => (
                  <TagBlock
                    key={group.name}
                    group={group}
                    headingId={`tag-${index}-${group.name}`}
                    level={3}
                    hrefOf={hrefOf}
                  />
                ))}
              </section>
            ))}
        {groups.length === 0 && (
          <p className="http-muted">No operation matches.</p>
        )}
      </div>
    </nav>
  );
}
