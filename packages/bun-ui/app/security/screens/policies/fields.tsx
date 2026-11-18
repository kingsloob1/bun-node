/**
 * A policy field on a scope's editor (ui.md §3, the user's decisions of
 * 2026-11-18): set here, with **Reset to inherited** (or to the default);
 * inherited, read-only with "inherited from …" naming the scope (a link to
 * its editor) and **Override**; or not set anywhere, the default. A locked
 * item a scope above locked is read-only and greyed, "locked by …", with no
 * override (`LockedNote`).
 */
import type { Control, SchemaNode } from "./schema";
import type { PolicyPath } from "./paths";
import { Button } from "../../../kit/components/Button";
import { Field } from "../../../kit/components/Field";
import { Link } from "../../router";
import { SCOPE_PARAM, scopeLabel } from "../../scope/scope";
import { FieldControl } from "./controls";
import { usePolicyEditor } from "./editorContext";
import { dotted, fieldState } from "./paths";
import { controlOf, hintOf, labelOf, propertiesOf } from "./schema";

/** A link to `scope`'s policy editor. */
export function ScopeLink({ scope }: { scope: string }) {
  return (
    <Link to={`/policies?${SCOPE_PARAM}=${encodeURIComponent(scope)}`}>
      {scopeLabel(scope)}
    </Link>
  );
}

/** "Locked by …": a scope above locked the item; nothing here may change it. */
export function LockedNote({ by, testId }: { by: string; testId?: string }) {
  return (
    <span
      className="policy-locked"
      data-testid={testId}
    >
      Locked by <ScopeLink scope={by} />
    </span>
  );
}

/** Props of {@link InheritedField}. */
export interface InheritedFieldProps {
  /** The field's path in the policy. */
  path: PolicyPath;
  /** Its label. */
  label: string;
  /** Help under it. */
  hint?: string;
  /** Its control. */
  control: Control;
  /** What it shows when set nowhere (the built-in default), when known. */
  defaultValue?: unknown;
}

/** See the module's description. */
export function InheritedField({
  path,
  label,
  hint,
  control,
  defaultValue,
}: InheritedFieldProps) {
  const editor = usePolicyEditor();
  const state = fieldState(
    editor.working,
    editor.effective,
    editor.scope,
    path,
  );
  const id = dotted(path);
  const issues = editor.issuesAt(path);
  const shown =
    state.kind === "own"
      ? state.value
      : state.kind === "inherited"
        ? state.value
        : defaultValue;
  return (
    <div
      className="policy-field"
      data-testid={`field-${id}`}
      data-state={state.kind}
    >
      <Field
        label={label}
        {...(hint === undefined ? {} : { hint })}
        {...(issues.length === 0 ? {} : { error: issues.join("; ") })}
      >
        <FieldControl
          control={control}
          value={shown}
          label={control.kind === "boolean" ? "On" : label}
          disabled={!editor.canEdit || state.kind === "inherited"}
          testId={`control-${id}`}
          onChange={(value) => editor.set(path, value)}
        />
      </Field>
      <div
        className="policy-origin"
        data-testid={`origin-${id}`}
      >
        {state.kind === "own" ? (
          <>
            <span>Set here</span>
            {state.inherited === undefined ? null : (
              <span className="muted">
                {" "}
                (over {JSON.stringify(state.inherited.value)} from{" "}
                <ScopeLink scope={state.inherited.origin} />)
              </span>
            )}
            {editor.canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid={`reset-${id}`}
                onClick={() => editor.set(path, undefined)}
              >
                {state.inherited === undefined
                  ? "Reset to default"
                  : "Reset to inherited"}
              </Button>
            ) : null}
          </>
        ) : state.kind === "inherited" ? (
          <>
            <span>
              Inherited from <ScopeLink scope={state.origin} />
            </span>
            {editor.canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid={`override-${id}`}
                onClick={() => editor.set(path, state.value ?? null)}
              >
                Override
              </Button>
            ) : null}
          </>
        ) : (
          <span className="muted">Default</span>
        )}
      </div>
    </div>
  );
}

/** Props of {@link SchemaFields}. */
export interface SchemaFieldsProps {
  /** The object node whose properties are the fields. */
  node: SchemaNode;
  /** Its path in the policy. */
  path: PolicyPath;
  /** Keys to leave out (a hand-built part shows them). */
  skip?: readonly string[];
}

/**
 * The generated form for an object node: a field per property, a group per
 * nested object, a switch beside a section that can be off.
 */
export function SchemaFields({ node, path, skip = [] }: SchemaFieldsProps) {
  const editor = usePolicyEditor();
  const properties = propertiesOf(node) ?? {};
  return (
    <>
      {Object.entries(properties)
        .filter(([key]) => !skip.includes(key))
        .map(([key, child]) => {
          const at = [...path, key];
          const control = controlOf(child);
          const hint = hintOf(child);
          const label = labelOf(key);
          const inner =
            control.kind === "object"
              ? control.node
              : control.kind === "orFalse" && control.inner.kind === "object"
                ? control.inner.node
                : undefined;
          if (inner === undefined) {
            return (
              <InheritedField
                key={key}
                path={at}
                label={label}
                control={control}
                {...(hint === undefined ? {} : { hint })}
              />
            );
          }
          const state = fieldState(
            editor.working,
            editor.effective,
            editor.scope,
            at,
          );
          const off =
            (state.kind === "own" || state.kind === "inherited") &&
            state.value === false;
          return (
            <fieldset
              key={key}
              className="policy-group"
              data-testid={`group-${dotted(at)}`}
            >
              <legend>{label}</legend>
              {hint === undefined ? null : <p className="muted">{hint}</p>}
              {control.kind === "orFalse" ? (
                <InheritedField
                  path={at}
                  label={`${label}: off`}
                  control={control}
                />
              ) : null}
              {off ? null : (
                <SchemaFields
                  node={inner}
                  path={at}
                />
              )}
            </fieldset>
          );
        })}
    </>
  );
}
