/**
 * The request rules of a policy as a list (layers.md L7): each own rule in
 * a line (its id, mode, what a hit does and its condition), **Edit** opening
 * the {@link RuleEditor} in place with **Apply** and **Cancel**, **Remove**,
 * and **Add a rule**; the inherited rules (with the scope each came from
 * and whether it is locked) read-only. It is controlled: `rules` in,
 * `onChange(rules)` out, and nothing is saved here. That makes it the
 * adapter for U4's policy editor: its request-rules slot
 * (`policies/RuleEditorSlot.tsx`) passes the editor's `requestRules.rules`
 * and writes them back with its `set`, so the rules save with the rest of
 * the draft.
 */
import { useState } from "react";
import { Badge } from "../../../kit/components/Badge";
import { Button } from "../../../kit/components/Button";
import { scopeLabel } from "../../scope/scope";
import type { RuleForm, RuleJson } from "./ruleModel";
import type { InheritedRule } from "./rulesPolicy";
import { RuleEditor } from "./RuleEditor";
import {
  newRule,
  putRule,
  removeRule,
  ruleForm,
  ruleJson,
  rulesOf,
} from "./ruleModel";

/** Props of {@link RequestRulesEditor}. */
export interface RequestRulesEditorProps {
  /** The scope's own rules. */
  rules: readonly RuleJson[];
  /** Called with the changed list. */
  onChange: (rules: RuleJson[]) => void;
  /** Whether the scope may lock a rule for the scopes below (global and groups). */
  canLock: boolean;
  /** Read-only. */
  disabled?: boolean;
  /** The rules inherited from the scopes above, read-only. */
  inherited?: readonly InheritedRule[];
  /** The issues a save named at the rule at `index`. */
  issuesAt?: (index: number) => readonly string[];
}

/** What is being edited: a rule's index, or a new one. */
type Editing = {
  readonly index: number | null;
  readonly form: RuleForm;
} | null;

/** A rule's condition in a line. */
function whenText(rule: RuleJson): string {
  const text = JSON.stringify(rule.when ?? {});
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** See the module's description. */
export function RequestRulesEditor({
  rules,
  onChange,
  canLock,
  disabled = false,
  inherited = [],
  issuesAt,
}: RequestRulesEditorProps) {
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const policy = { requestRules: { rules } };
  const apply = () => {
    if (editing === null) return;
    const base = editing.index === null ? {} : (rules[editing.index] ?? {});
    const json = ruleJson(editing.form, base);
    if ("error" in json) {
      setError(json.error);
      return;
    }
    const previous =
      editing.index === null ? null : String(rules[editing.index]?.id ?? "");
    const next = putRule(policy, previous, json.rule);
    if (!next.ok) {
      setError(next.error);
      return;
    }
    setError(null);
    setEditing(null);
    onChange(rulesOf(next.policy));
  };
  return (
    <div
      className="request-rules-editor"
      data-testid="request-rules-editor"
    >
      {rules.length === 0 ? (
        <p data-testid="request-rules-none">No rule of its own.</p>
      ) : (
        <ul className="request-rules-list">
          {rules.map((rule, index) => {
            const id = String(rule.id ?? "");
            const issues = issuesAt?.(index) ?? [];
            return (
              <li
                key={id === "" ? index : id}
                data-testid="request-rule"
              >
                <code>{id}</code>{" "}
                {rule.mode === "dryRun" ? (
                  <Badge tone="warning">Dry run</Badge>
                ) : rule.mode === "off" ? (
                  <Badge tone="neutral">Off</Badge>
                ) : null}{" "}
                {typeof rule.action === "string" ? rule.action : "block"} when{" "}
                <code>{whenText(rule)}</code>
                {rule.locked === true ? (
                  <>
                    {" "}
                    <Badge tone="info">locked below</Badge>
                  </>
                ) : null}
                {disabled || editing !== null ? null : (
                  <>
                    {" "}
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`request-rule-edit-${id}`}
                      onClick={() =>
                        setEditing({ index, form: ruleForm(rule) })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`request-rule-remove-${id}`}
                      onClick={() => onChange(rulesOf(removeRule(policy, id)))}
                    >
                      Remove
                    </Button>
                  </>
                )}
                {issues.length === 0 ? null : (
                  <ul
                    className="warning"
                    data-testid={`request-rule-issues-${id}`}
                  >
                    {issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editing === null ? (
        disabled ? null : (
          <Button
            size="sm"
            data-testid="request-rule-add"
            onClick={() => setEditing({ index: null, form: newRule() })}
          >
            Add a rule
          </Button>
        )
      ) : (
        <section
          aria-label={editing.index === null ? "New rule" : "Edit the rule"}
          data-testid="request-rule-editing"
        >
          <RuleEditor
            value={editing.form}
            onChange={(form) => setEditing({ ...editing, form })}
            canLock={canLock}
          />
          {error === null ? null : (
            <p
              role="alert"
              data-testid="request-rule-error"
            >
              {error}
            </p>
          )}
          <div className="filters-actions">
            <Button
              size="sm"
              variant="primary"
              data-testid="request-rule-apply"
              onClick={apply}
            >
              Apply
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="request-rule-cancel"
              onClick={() => {
                setEditing(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </section>
      )}
      {inherited.length === 0 ? null : (
        <>
          <h3>Inherited</h3>
          <ul
            className="request-rules-list"
            data-testid="request-rules-inherited"
          >
            {inherited.map(({ rule, origin, locked }) => (
              <li key={`${origin}-${String(rule.id)}`}>
                <code>{String(rule.id)}</code> from {scopeLabel(origin)}
                {locked ? (
                  <>
                    {" "}
                    <Badge tone="info">locked</Badge>
                  </>
                ) : null}
                : {typeof rule.action === "string" ? rule.action : "block"} when{" "}
                <code>{whenText(rule)}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
