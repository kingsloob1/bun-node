import type { ReactNode } from "react";
import { useState } from "react";
import { cx } from "./classNames";
import { safeStringify } from "./copy";
import { CopyButton } from "./CopyButton";

/** Limits of a {@link JsonView}. */
interface ViewLimits {
  /** Levels expanded on first render. */
  expandDepth: number;
  /** Characters of a string shown before "show more". */
  maxStringLength: number;
  /** Children rendered per expand (and per "show more"). */
  maxChildren: number;
}

/** Props of {@link JsonView}. */
export interface JsonViewProps {
  /** Any value: JSON, `undefined`, a `Date`, a `bigint`, even a circular object. */
  value: unknown;
  /** Accessible name of the tree, e.g. "Job data". Defaults to `"JSON"`. */
  label?: string;
  /** Levels expanded on first render; `0` starts collapsed. Defaults to `1`. */
  expandDepth?: number;
  /** Characters of a string shown before a "show more" control. Defaults to `200`. */
  maxStringLength?: number;
  /** Array items / object keys rendered per expand; "show more" renders the next batch. Defaults to `100`. */
  maxChildren?: number;
  /** Show a Copy button for the whole value (serialised on click, circular-safe). Defaults to `true`. */
  copyable?: boolean;
  /** Extra class names. */
  className?: string;
}

/** What a value looks like to the viewer. */
type Kind =
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "other";

/** Classifies a value for rendering. */
function kindOf(value: unknown): Kind {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "object":
      return value instanceof Date ? "other" : "object";
    case "string":
      return "string";
    case "number":
    case "bigint":
      return "number";
    case "boolean":
      return "boolean";
    case "undefined":
      return "undefined";
    default:
      return "other";
  }
}

/** A primitive's (or opaque value's) text. */
function scalarText(value: unknown): string {
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return value.toString();
  }
  return String(value);
}

/** The first `limit` entries of a container, arrays keyed by index; never touches the rest. */
function entriesOf(value: object, limit: number): [string, unknown][] {
  if (Array.isArray(value)) {
    return value
      .slice(0, limit)
      .map((item: unknown, index) => [String(index), item]);
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .slice(0, limit)
    .map((key) => [key, record[key]]);
}

/**
 * A read-only, collapsible tree of any value. Built for job payloads of any
 * size: levels past `expandDepth` start collapsed, each expand renders at
 * most `maxChildren` children (with "show more"), long strings are cut at
 * `maxStringLength`, and a reference back to an ancestor renders as
 * `[Circular]` instead of recursing.
 */
export function JsonView({
  value,
  label = "JSON",
  expandDepth = 1,
  maxStringLength = 200,
  maxChildren = 100,
  copyable = true,
  className,
}: JsonViewProps) {
  const limits: ViewLimits = { expandDepth, maxStringLength, maxChildren };
  return (
    <div className={cx("json-view", className)}>
      {copyable && (
        <div className="json-view-toolbar">
          <CopyButton
            text={() => safeStringify(value, 2)}
            ariaLabel={`Copy ${label}`}
          />
        </div>
      )}
      <ul
        className="json-tree"
        aria-label={label}
      >
        <JsonNode
          name={null}
          value={value}
          depth={0}
          ancestors={[]}
          limits={limits}
        />
      </ul>
    </div>
  );
}

/** Props of {@link JsonNode}. */
interface JsonNodeProps {
  /** The key or index, or `null` at the root. */
  name: string | null;
  /** The value at this node. */
  value: unknown;
  /** Nesting level, root = 0. */
  depth: number;
  /** The containers above this node, for the circular check. */
  ancestors: readonly object[];
  /** Rendering limits. */
  limits: ViewLimits;
}

/** One key/value row, expandable when the value is a non-empty container. */
function JsonNode({ name, value, depth, ancestors, limits }: JsonNodeProps) {
  const kind = kindOf(value);
  const key = name === null ? null : <span className="json-key">{name}: </span>;

  if (kind !== "object" && kind !== "array") {
    return (
      <li className="json-row">
        {key}
        <JsonScalar
          value={value}
          kind={kind}
          maxLength={limits.maxStringLength}
        />
      </li>
    );
  }

  const container = value as object;
  if (ancestors.includes(container)) {
    return (
      <li className="json-row">
        {key}
        <span className="json-circular">[Circular]</span>
      </li>
    );
  }
  return (
    <JsonContainer
      nameNode={key}
      value={container}
      isArray={kind === "array"}
      depth={depth}
      ancestors={ancestors}
      limits={limits}
    />
  );
}

/** Props of {@link JsonContainer}. */
interface JsonContainerProps {
  /** The rendered key, or `null` at the root. */
  nameNode: ReactNode;
  /** The object or array. */
  value: object;
  /** Whether it is an array. */
  isArray: boolean;
  /** Nesting level. */
  depth: number;
  /** The containers above it. */
  ancestors: readonly object[];
  /** Rendering limits. */
  limits: ViewLimits;
}

/** An object or array: a disclosure button, and its children once expanded. */
function JsonContainer({
  nameNode,
  value,
  isArray,
  depth,
  ancestors,
  limits,
}: JsonContainerProps) {
  const [expanded, setExpanded] = useState(depth < limits.expandDepth);
  const [shown, setShown] = useState(limits.maxChildren);
  // Object.keys is O(n) but cheap next to rendering; children are only
  // materialised while expanded.
  const size = isArray
    ? (value as unknown[]).length
    : Object.keys(value).length;
  const open = isArray ? "[" : "{";
  const close = isArray ? "]" : "}";
  const summary = isArray
    ? `${size} ${size === 1 ? "item" : "items"}`
    : `${size} ${size === 1 ? "key" : "keys"}`;

  if (size === 0) {
    return (
      <li className="json-row">
        {nameNode}
        <span className="json-punct">
          {open}
          {close}
        </span>
      </li>
    );
  }

  const children = expanded ? entriesOf(value, shown) : [];
  const nextAncestors = expanded ? [...ancestors, value] : ancestors;
  return (
    <li className="json-row json-container">
      <button
        type="button"
        className="json-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span
          className="json-caret"
          aria-hidden="true"
        />
        {nameNode}
        <span className="json-punct">{open}</span>
        {!expanded && (
          <>
            <span className="json-summary">{summary}</span>
            <span className="json-punct">{close}</span>
          </>
        )}
      </button>
      {expanded && (
        <>
          <ul className="json-children">
            {children.map(([key, item]) => (
              <JsonNode
                key={key}
                name={key}
                value={item}
                depth={depth + 1}
                ancestors={nextAncestors}
                limits={limits}
              />
            ))}
            {size > shown && (
              <li className="json-row">
                <button
                  type="button"
                  className="json-more"
                  onClick={() =>
                    setShown((current) => current + limits.maxChildren)
                  }
                >
                  Show {Math.min(limits.maxChildren, size - shown)} more (
                  {size - shown} hidden)
                </button>
              </li>
            )}
          </ul>
          <span className="json-punct">{close}</span>
        </>
      )}
    </li>
  );
}

/** Props of {@link JsonScalar}. */
interface JsonScalarProps {
  /** The value. */
  value: unknown;
  /** Its kind. */
  kind: Kind;
  /** String length before truncation. */
  maxLength: number;
}

/** A leaf value, colour-coded; long strings truncate with "show more". */
function JsonScalar({ value, kind, maxLength }: JsonScalarProps) {
  const [full, setFull] = useState(false);
  if (kind === "string") {
    const text = value as string;
    const cut = !full && text.length > maxLength;
    return (
      <>
        <span className="json-string">
          &quot;{cut ? text.slice(0, maxLength) : text}
          {cut ? "…" : ""}&quot;
        </span>
        {text.length > maxLength && (
          <button
            type="button"
            className="json-more"
            aria-expanded={full}
            onClick={() => setFull((current) => !current)}
          >
            {full ? "Show less" : `Show more (${text.length} chars)`}
          </button>
        )}
      </>
    );
  }
  return <span className={`json-${kind}`}>{scalarText(value)}</span>;
}
