/**
 * The request-rule editor (ui.md §4.3, layers.md L7): a rule's id, what a
 * hit does, its mode, weight, refusal, a ban's length, crawlers, whether
 * the scopes below may override it, and its condition in the matcher
 * builder. It is controlled (`value`, `onChange`, the form as typed;
 * `ruleJson` turns it into the policy's JSON), so each caller adapts it:
 * {@link RuleEditorForm} saves one rule into the scope's draft (the rules
 * screen), and `RequestRulesEditor` edits the whole list for U4's policy
 * editor, through its `set`.
 */
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import type { RuleForm, RuleJson } from "./ruleModel";
import { MatcherBuilder } from "./MatcherBuilder";
import {
  newRule,
  RULE_ACTIONS,
  RULE_MODES,
  ruleForm,
  ruleJson,
} from "./ruleModel";

/** What each action does, for people. */
const ACTION_LABELS: Record<RuleForm["action"], string> = {
  block: "Block (refuse)",
  challenge: "Challenge",
  ban: "Ban the client address",
  drop: "Drop the connection",
  log: "Log only",
};

/** What each mode means, for people. */
const MODE_LABELS: Record<RuleForm["mode"], string> = {
  enforce: "Enforced",
  dryRun: "Dry run (recorded as what it would do)",
  off: "Off",
};

/** Props of {@link RuleEditor}. */
export interface RuleEditorProps {
  /** The rule as typed. */
  value: RuleForm;
  /** Called with the changed form. */
  onChange: (value: RuleForm) => void;
  /** Whether the scope may lock it for the scopes below (global and groups). */
  canLock: boolean;
  /** Read-only. */
  disabled?: boolean;
}

/** See the module's description. */
export function RuleEditor({
  value: form,
  onChange,
  canLock,
  disabled = false,
}: RuleEditorProps) {
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) =>
    onChange({ ...form, [key]: value });
  return (
    <div
      className="rule-editor"
      data-testid="rule-editor"
    >
      <div className="filters">
        <label>
          Id{" "}
          <input
            className="input"
            value={form.id}
            disabled={disabled}
            required
            data-testid="rule-id"
            onChange={(e) => set("id", e.target.value)}
          />
        </label>
        <label>
          A hit{" "}
          <select
            className="input"
            value={form.action}
            disabled={disabled}
            data-testid="rule-action"
            onChange={(e) =>
              set("action", e.target.value as RuleForm["action"])
            }
          >
            {RULE_ACTIONS.map((action) => (
              <option
                key={action}
                value={action}
              >
                {ACTION_LABELS[action]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Mode{" "}
          <select
            className="input"
            value={form.mode}
            disabled={disabled}
            data-testid="rule-mode"
            onChange={(e) => set("mode", e.target.value as RuleForm["mode"])}
          >
            {RULE_MODES.map((mode) => (
              <option
                key={mode}
                value={mode}
              >
                {MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Weight (0–100){" "}
          <input
            className="input"
            inputMode="decimal"
            value={form.weight}
            disabled={disabled}
            placeholder={form.action === "log" ? "0" : "1"}
            data-testid="rule-weight"
            onChange={(e) => set("weight", e.target.value)}
          />
        </label>
        {form.action === "log" ? null : (
          <>
            <label>
              Status{" "}
              <input
                className="input"
                inputMode="numeric"
                value={form.status}
                disabled={disabled}
                placeholder="403"
                data-testid="rule-status"
                onChange={(e) => set("status", e.target.value)}
              />
            </label>
            <label>
              Problem code{" "}
              <input
                className="input"
                value={form.code}
                disabled={disabled}
                placeholder={form.action === "ban" ? "banned" : "blocked"}
                data-testid="rule-code"
                onChange={(e) => set("code", e.target.value)}
              />
            </label>
          </>
        )}
        {form.action === "ban" ? (
          <>
            <label>
              Ban for{" "}
              <input
                className="input"
                value={form.duration === "lifted" ? "" : form.duration}
                disabled={disabled || form.duration === "lifted"}
                placeholder="the ladder's length"
                data-testid="rule-duration"
                onChange={(e) => set("duration", e.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.duration === "lifted"}
                disabled={disabled}
                data-testid="rule-until-lifted"
                onChange={(e) =>
                  set("duration", e.target.checked ? "lifted" : "")
                }
              />{" "}
              until lifted
            </label>
          </>
        ) : null}
        <label>
          Verified crawlers{" "}
          <select
            className="input"
            value={form.crawlers}
            disabled={disabled}
            data-testid="rule-crawlers"
            onChange={(e) =>
              set("crawlers", e.target.value as RuleForm["crawlers"])
            }
          >
            <option value="">Held to it (the default)</option>
            <option value="apply">Held to it</option>
            <option value="skip">Skipped (logged as a crawler probe)</option>
          </select>
        </label>
        {canLock ? (
          <label>
            <input
              type="checkbox"
              checked={form.locked}
              disabled={disabled}
              data-testid="rule-locked"
              onChange={(e) => set("locked", e.target.checked)}
            />{" "}
            Locked: the scopes below cannot override it
          </label>
        ) : null}
      </div>
      <h2>When</h2>
      <MatcherBuilder
        value={form.when}
        disabled={disabled}
        onChange={(when) => set("when", when)}
      />
    </div>
  );
}

/** Props of {@link RuleEditorForm}. */
export interface RuleEditorFormProps {
  /** The rule read, or `null` for a new one. */
  rule: RuleJson | null;
  /** Whether the scope may lock it for the scopes below (global and groups). */
  canLock: boolean;
  /** Read-only. */
  disabled?: boolean;
  /** Saves the rule's JSON; a thrown error's message is shown. */
  onSave: (rule: Record<string, unknown>) => Promise<void>;
  /** Leaves the editor. */
  onCancel: () => void;
}

/** The editor over one rule with **Save** and **Cancel**: the rules screen's adapter. */
export function RuleEditorForm({
  rule,
  canLock,
  disabled = false,
  onSave,
  onCancel,
}: RuleEditorFormProps) {
  const [form, setForm] = useState<RuleForm>(() =>
    rule === null ? newRule() : ruleForm(rule),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(null);
    const json = ruleJson(form, rule ?? {});
    if ("error" in json) {
      setError(json.error);
      return;
    }
    setBusy(true);
    try {
      await onSave(json.rule);
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message !== ""
          ? failure.message
          : "The rule was not saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      aria-label="Request rule"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <RuleEditor
        value={form}
        onChange={setForm}
        canLock={canLock}
        disabled={disabled}
      />
      {error === null ? null : (
        <p
          role="alert"
          data-testid="rule-error"
        >
          {error}
        </p>
      )}
      {disabled ? null : (
        <div className="filters-actions">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={busy}
            data-testid="rule-save"
          >
            {busy ? "Saving…" : "Save to the draft"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="rule-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      )}
    </form>
  );
}
