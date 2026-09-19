import type {
  SchemaChild,
  SchemaFact,
  SchemaObject,
  SchemaRoot,
} from "./resolve";
import { useState } from "react";
import { cx } from "../../../components/classNames";
import { Prose } from "./Prose";
import {
  additionalFields,
  COMPOSITION_LABELS,
  deref,
  isSchemaObject,
  MAX_SCHEMA_LEVEL,
  refName,
  refOf,
  schemaChildren,
  schemaFacts,
  typeLabel,
} from "./resolve";
import "./schema.css";

/** Props of {@link SchemaTree}. */
export interface SchemaTreeProps {
  /** The schema to render: an object, `true`/`false`, or a `{ $ref }`. */
  schema: unknown;
  /** The document the schema came from; every `$ref` resolves against it (`#/components/schemas/X`). */
  root: SchemaRoot;
  /** Levels expanded on first render; `0` starts collapsed. Defaults to `1`. */
  depth?: number;
  /**
   * Called when a `$ref`'s name is activated, e.g. to open that component in
   * a side panel. When omitted the name is plain text; the reference can
   * still be expanded in place.
   */
  onRef?: (ref: string, name: string) => void;
  /** Accessible name of the tree, e.g. "Request body schema". Defaults to `"Schema"`. */
  label?: string;
  /** Extra class names on the wrapper. */
  className?: string;
}

/**
 * A JSON Schema (2020-12, as OpenAPI 3.1 and AsyncAPI 3.0 write it) as an
 * expandable tree: each node shows its name, a required marker, its type,
 * its `$ref` name, its constraints and its description; objects expand into
 * properties (noting `additionalProperties: false` as "No other fields"),
 * arrays into their items, and `oneOf`/`anyOf`/`allOf` into labelled
 * alternatives. A `$ref` already open above a node is shown as recursive
 * and not expanded again, so a cyclic schema renders finitely.
 */
export function SchemaTree({
  schema,
  root,
  depth = 1,
  onRef,
  label = "Schema",
  className,
}: SchemaTreeProps) {
  return (
    <div
      className={cx("schema-tree", className)}
      role="group"
      aria-label={label}
    >
      <ul className="schema-list">
        <SchemaNode
          child={null}
          schema={schema}
          root={root}
          level={0}
          depth={depth}
          refChain={[]}
          onRef={onRef}
        />
      </ul>
    </div>
  );
}

/** Props of {@link SchemaNode}. */
interface SchemaNodeProps {
  /** How the parent reached this node, or `null` at the root. */
  child: SchemaChild | null;
  /** The node's schema, possibly a `$ref`. */
  schema: unknown;
  /** The document. */
  root: SchemaRoot;
  /** Nesting level, root = 0. */
  level: number;
  /** Levels expanded on first render. */
  depth: number;
  /** The `$ref`s open above this node, for the cycle check. */
  refChain: readonly string[];
  /** See {@link SchemaTreeProps.onRef}. */
  onRef: SchemaTreeProps["onRef"];
}

/** A `$ref`'s name: a button when the tree can open it, text otherwise. */
function RefName({
  refValue,
  onRef,
}: {
  /** The `$ref` string. */
  refValue: string;
  /** Opens it, when given. */
  onRef: SchemaTreeProps["onRef"];
}) {
  const name = refName(refValue);
  if (!onRef) {
    return (
      <code
        className="schema-ref"
        title={refValue}
      >
        {name}
      </code>
    );
  }
  return (
    <button
      type="button"
      className="schema-ref schema-ref-link"
      title={`Open ${refValue}`}
      onClick={() => onRef(refValue, name)}
    >
      {name}
    </button>
  );
}

/** A reference's facts: its target's, overridden by its own siblings' (a `default` beside a `$ref`). */
function mergeFacts(own: SchemaObject, target: unknown): SchemaFact[] {
  const siblings = schemaFacts({ ...own, $ref: undefined });
  const keys = new Set(siblings.map((fact) => fact.key));
  return [
    ...schemaFacts(target).filter((fact) => !keys.has(fact.key)),
    ...siblings,
  ];
}

/** One node: its row, description and notes, and its children once expanded. */
function SchemaNode({
  child,
  schema,
  root,
  level,
  depth,
  refChain,
  onRef,
}: SchemaNodeProps) {
  const ref = refOf(schema);
  const resolved = deref(schema, root);
  const target = resolved.schema;
  const recursive =
    resolved.cycle || resolved.refs.some((item) => refChain.includes(item));
  const unresolved = ref !== undefined && target === undefined && !recursive;
  const children =
    recursive || level >= MAX_SCHEMA_LEVEL ? [] : schemaChildren(target);
  const [expanded, setExpanded] = useState(level < depth);

  // A `$ref`'s siblings annotate it; they win over the target's.
  const own = isSchemaObject(schema) ? schema : {};
  const description =
    typeof own.description === "string"
      ? own.description
      : isSchemaObject(target) && typeof target.description === "string"
        ? target.description
        : undefined;
  const facts =
    ref === undefined ? schemaFacts(schema) : mergeFacts(own, target);
  // A reference shows its target's type beside its name, once it resolves.
  const type =
    ref === undefined
      ? typeLabel(schema, root)
      : recursive || unresolved
        ? null
        : typeLabel(target, root);
  const extra = additionalFields(target);
  const name = child?.label ?? null;
  const nextChain = [...refChain, ...resolved.refs];

  return (
    <li
      className="schema-node"
      data-kind={child?.kind ?? "root"}
    >
      <div className="schema-row">
        {children.length > 0 ? (
          <button
            type="button"
            className="schema-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${name ?? "schema"}`}
            onClick={() => setExpanded((open) => !open)}
          >
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
        ) : (
          <span
            className="schema-toggle-spacer"
            aria-hidden="true"
          />
        )}
        {name !== null && <span className="schema-name">{name}</span>}
        {child?.required && (
          <span
            className="schema-required"
            title="Required"
          >
            required
          </span>
        )}
        {type !== null && <span className="schema-type">{type}</span>}
        {ref !== undefined && (
          <RefName
            refValue={ref}
            onRef={onRef}
          />
        )}
        {recursive && (
          <span
            className="schema-note-inline"
            title="This schema contains itself; it is expanded above."
          >
            recursive
          </span>
        )}
        {unresolved && (
          <span className="schema-note-inline schema-unresolved">
            unresolved $ref
          </span>
        )}
        {facts.map((fact) => (
          <span
            key={fact.key}
            className="schema-fact"
            data-fact={fact.key}
          >
            <span className="schema-fact-label">{fact.label}</span>{" "}
            <code>{fact.value}</code>
          </span>
        ))}
      </div>
      {description !== undefined && (
        <div className="schema-description">
          <Prose text={description} />
        </div>
      )}
      {extra === "closed" && (
        <p
          className="schema-closed"
          data-testid="schema-closed"
        >
          No other fields: any field not listed is refused.
        </p>
      )}
      {extra === "any" && (
        <p className="schema-open">Other fields: any value.</p>
      )}
      {expanded && children.length > 0 && (
        <ul className="schema-list">
          {children.map((item, index) => {
            const previous = children[index - 1];
            const composition =
              (item.kind === "oneOf" ||
                item.kind === "anyOf" ||
                item.kind === "allOf") &&
              previous?.kind !== item.kind;
            return (
              <SchemaChildItem
                key={item.key}
                item={item}
                heading={
                  composition
                    ? COMPOSITION_LABELS[
                        item.kind as "oneOf" | "anyOf" | "allOf"
                      ]
                    : undefined
                }
                root={root}
                level={level + 1}
                depth={depth}
                refChain={nextChain}
                onRef={onRef}
              />
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** A child node, preceded by its composition's heading when it opens one. */
function SchemaChildItem({
  item,
  heading,
  ...rest
}: Omit<SchemaNodeProps, "child" | "schema"> & {
  /** The child. */
  item: SchemaChild;
  /** "Any of" etc., before the first alternative of a composition. */
  heading: string | undefined;
}) {
  return (
    <>
      {heading !== undefined && (
        <li className="schema-composition">{heading}</li>
      )}
      <SchemaNode
        {...rest}
        child={item}
        schema={item.schema}
      />
    </>
  );
}
