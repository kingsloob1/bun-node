/**
 * The matcher builder (ui.md §4.3, layers.md L7): a request rule's
 * condition edited as a tree — **all** or **any** of a list, **not** one,
 * and tests of one target each (its comparison chosen by the target's
 * kind) — with a `regex`'s verdict shown live as it is typed, from the
 * control plane's own check. A condition it cannot show is edited as JSON.
 * U4's policy editor embeds it for its request-rules tab.
 */
import type { ReactNode } from "react";
import type { ConditionNode, MatchNode } from "./conditionModel";
import { Button } from "../../../kit/components/Button";
import {
  ASN_OPS,
  newMatch,
  NUMBER_OPS,
  regexVerdict,
  STRING_OPS,
  TARGETS,
  targetOf,
} from "./conditionModel";

/** Props of {@link MatcherBuilder}. */
export interface MatcherBuilderProps {
  /** The condition. */
  value: ConditionNode;
  /** Called with the changed condition. */
  onChange: (value: ConditionNode) => void;
  /** Read-only. */
  disabled?: boolean;
}

/** A comparison, for people. */
const OP_LABELS: Record<string, string> = {
  equals: "equals",
  in: "is one of (one per line)",
  prefix: "starts with",
  suffix: "ends with",
  contains: "contains",
  glob: "matches the glob",
  regex: "matches the regex",
  exists: "is present",
  length: "has a length",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  cidr: "is in the ranges (one per line)",
};

/** The comparisons a target takes. */
function opsOf(target: string): readonly string[] {
  const kind = targetOf(target).kind;
  if (kind === "number") return NUMBER_OPS;
  if (kind === "asn") return ASN_OPS;
  if (kind === "cidr") return ["cidr"];
  if (kind === "cookie") return ["exists"];
  return STRING_OPS;
}

/** See the module's description. */
export function MatcherBuilder({
  value,
  onChange,
  disabled = false,
}: MatcherBuilderProps) {
  return (
    <div
      className="matcher-builder"
      data-testid="matcher-builder"
    >
      <NodeEditor
        node={value}
        path="0"
        onChange={onChange}
        onRemove={undefined}
        disabled={disabled}
      />
    </div>
  );
}

/** Props of {@link NodeEditor}. */
interface NodeEditorProps {
  /** The node. */
  node: ConditionNode;
  /** Its place in the tree (`0.1.2`), for test ids. */
  path: string;
  /** Called with the changed node. */
  onChange: (node: ConditionNode) => void;
  /** Removes it from its group; absent at the root. */
  onRemove: (() => void) | undefined;
  /** Read-only. */
  disabled: boolean;
}

/** One node of the tree. */
function NodeEditor({
  node,
  path,
  onChange,
  onRemove,
  disabled,
}: NodeEditorProps) {
  const remove =
    onRemove === undefined || disabled ? null : (
      <Button
        size="sm"
        variant="ghost"
        data-testid={`node-remove-${path}`}
        onClick={onRemove}
      >
        Remove
      </Button>
    );
  if (node.kind === "raw") {
    return (
      <fieldset className="matcher-node">
        <legend>Written as JSON (the builder cannot show it)</legend>
        <textarea
          placeholder='{ "path": { "prefix": "/admin" } }'
          className="input"
          rows={6}
          value={node.json}
          disabled={disabled}
          data-testid={`node-raw-${path}`}
          onChange={(e) => onChange({ kind: "raw", json: e.target.value })}
        />
        {remove}
      </fieldset>
    );
  }
  if (node.kind === "not") {
    return (
      <fieldset className="matcher-node">
        <legend>Not</legend>
        <NodeEditor
          node={node.child}
          path={`${path}.0`}
          onChange={(child) => onChange({ kind: "not", child })}
          onRemove={undefined}
          disabled={disabled}
        />
        {disabled ? null : (
          <Button
            size="sm"
            variant="ghost"
            data-testid={`node-unnegate-${path}`}
            onClick={() => onChange(node.child)}
          >
            Remove the “not”
          </Button>
        )}
        {remove}
      </fieldset>
    );
  }
  if (node.kind === "all" || node.kind === "any") {
    const setChild = (index: number, child: ConditionNode) =>
      onChange({
        kind: node.kind,
        children: node.children.map((item, at) =>
          at === index ? child : item,
        ),
      });
    return (
      <fieldset className="matcher-node">
        <legend>
          <select
            data-always-set
            className="input"
            value={node.kind}
            disabled={disabled}
            aria-label="Group"
            data-testid={`node-group-${path}`}
            onChange={(e) =>
              onChange({
                kind: e.target.value === "any" ? "any" : "all",
                children: node.children,
              })
            }
          >
            <option value="all">All of</option>
            <option value="any">Any of</option>
          </select>
        </legend>
        {node.children.map((child, index) => (
          <NodeEditor
            key={`${path}.${index}`}
            node={child}
            path={`${path}.${index}`}
            onChange={(next) => setChild(index, next)}
            onRemove={() =>
              onChange({
                kind: node.kind,
                children: node.children.filter((_, at) => at !== index),
              })
            }
            disabled={disabled}
          />
        ))}
        {disabled ? null : (
          <div className="matcher-actions">
            <Button
              size="sm"
              data-testid={`node-add-test-${path}`}
              onClick={() =>
                onChange({
                  kind: node.kind,
                  children: [...node.children, newMatch()],
                })
              }
            >
              Add a test
            </Button>
            <Button
              size="sm"
              data-testid={`node-add-group-${path}`}
              onClick={() =>
                onChange({
                  kind: node.kind,
                  children: [
                    ...node.children,
                    {
                      kind: node.kind === "all" ? "any" : "all",
                      children: [newMatch()],
                    },
                  ],
                })
              }
            >
              Add a group
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`node-negate-${path}`}
              onClick={() => onChange({ kind: "not", child: node })}
            >
              Negate
            </Button>
          </div>
        )}
        {remove}
      </fieldset>
    );
  }
  if (node.kind !== "match") return null;
  return (
    <MatchEditor
      node={node}
      path={path}
      onChange={onChange}
      remove={remove}
      disabled={disabled}
    />
  );
}

/** One test. */
function MatchEditor({
  node,
  path,
  onChange,
  remove,
  disabled,
}: {
  node: MatchNode;
  path: string;
  onChange: (node: ConditionNode) => void;
  remove: ReactNode;
  disabled: boolean;
}) {
  const target = targetOf(node.target);
  const ops = opsOf(node.target);
  const set = (change: Partial<MatchNode>) => onChange({ ...node, ...change });
  const list = node.op === "in" || node.op === "cidr";
  const verdict = regexVerdict(node);
  const boolean = node.op === "exists";
  return (
    <fieldset
      className="matcher-node matcher-test"
      data-testid={`node-match-${path}`}
    >
      <select
        data-always-set
        className="input"
        value={node.target}
        disabled={disabled}
        aria-label="Target"
        data-testid={`match-target-${path}`}
        onChange={(e) => {
          const next = e.target.value;
          const nextOps = opsOf(next);
          set({
            target: next,
            op: (nextOps.includes(node.op)
              ? node.op
              : nextOps[0]) as MatchNode["op"],
          });
        }}
      >
        {TARGETS.map((item) => (
          <option
            key={item.id}
            value={item.id}
          >
            {item.label}
            {item.routeStage === true ? " (once routed)" : ""}
          </option>
        ))}
      </select>
      {target.kind === "named" || target.kind === "cookie" ? (
        <input
          className="input"
          value={node.name}
          disabled={disabled}
          placeholder={target.kind === "cookie" ? "cookie name" : "name"}
          aria-label={`${target.label} name`}
          data-testid={`match-name-${path}`}
          onChange={(e) => set({ name: e.target.value })}
        />
      ) : null}
      <select
        data-always-set
        className="input"
        value={node.op}
        disabled={disabled || ops.length === 1}
        aria-label="Comparison"
        data-testid={`match-op-${path}`}
        onChange={(e) => set({ op: e.target.value as MatchNode["op"] })}
      >
        {ops.map((op) => (
          <option
            key={op}
            value={op}
          >
            {OP_LABELS[op] ?? op}
          </option>
        ))}
      </select>
      {node.op === "length" ? (
        <select
          data-always-set
          className="input"
          value={node.lengthOp}
          disabled={disabled}
          aria-label="Length comparison"
          data-testid={`match-length-op-${path}`}
          onChange={(e) =>
            set({ lengthOp: e.target.value as MatchNode["lengthOp"] })
          }
        >
          {NUMBER_OPS.map((op) => (
            <option
              key={op}
              value={op}
            >
              {OP_LABELS[op]}
            </option>
          ))}
        </select>
      ) : null}
      {boolean ? (
        <select
          data-always-set
          className="input"
          value={node.value === "false" ? "false" : "true"}
          disabled={disabled}
          aria-label="Present"
          data-testid={`match-value-${path}`}
          onChange={(e) => set({ value: e.target.value })}
        >
          <option value="true">yes</option>
          <option value="false">no</option>
        </select>
      ) : list ? (
        <textarea
          placeholder="e.g. PUT (one per line)"
          className="input"
          rows={3}
          value={node.value}
          disabled={disabled}
          aria-label="Values"
          data-testid={`match-value-${path}`}
          onChange={(e) => set({ value: e.target.value })}
        />
      ) : (
        <input
          placeholder="e.g. /wp-login.php*"
          className="input"
          value={node.value}
          disabled={disabled}
          aria-label="Value"
          data-testid={`match-value-${path}`}
          onChange={(e) => set({ value: e.target.value })}
        />
      )}
      {target.kind === "string" || target.kind === "named" ? (
        <label>
          <input
            type="checkbox"
            checked={
              node.ignoreCase ??
              (node.target === "path" || node.target === "rawPath")
            }
            disabled={disabled}
            data-testid={`match-ignore-case-${path}`}
            onChange={(e) => set({ ignoreCase: e.target.checked })}
          />{" "}
          ignore case
        </label>
      ) : null}
      {disabled ? null : (
        <span className="matcher-actions">
          <Button
            size="sm"
            variant="ghost"
            data-testid={`node-group-it-${path}`}
            onClick={() =>
              onChange({ kind: "all", children: [node, newMatch()] })
            }
          >
            And another test
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid={`node-negate-${path}`}
            onClick={() => onChange({ kind: "not", child: node })}
          >
            Negate
          </Button>
        </span>
      )}
      {node.op === "regex" ? (
        <p
          className={verdict === undefined ? "muted" : "warning"}
          role={verdict === undefined ? "status" : "alert"}
          data-testid={`match-regex-verdict-${path}`}
        >
          {verdict === undefined
            ? "The pattern is accepted."
            : `Refused: ${verdict}`}
        </p>
      ) : null}
      {remove}
    </fieldset>
  );
}
