/**
 * The offence ladder (layers.md §0.2), hand-built: its switch and settings
 * with their origins, and its steps as a table (score, a challenge or a
 * ban, a ban's length). The steps are one value: a scope that changes them
 * replaces the inherited ones whole (**Override** copies them here,
 * **Reset to inherited** drops the copy).
 */
import type { SchemaNode } from "./schema";
import { Button } from "../../../kit/components/Button";
import { NumberInput, Select, TextInput } from "../../../kit/components/inputs";
import { usePolicyEditor } from "./editorContext";
import { InheritedField, SchemaFields, ScopeLink } from "./fields";
import { fieldState, isObject } from "./paths";
import { controlOf } from "./schema";

/** One step. */
interface Step {
  /** The score that reaches it. */
  score?: number;
  /** What it does. */
  action?: "challenge" | "ban";
  /** A ban's length. */
  duration?: string;
}

/** The ladder's steps editor; see the module's description. */
function Steps() {
  const editor = usePolicyEditor();
  const path = ["ladder", "steps"];
  const state = fieldState(
    editor.working,
    editor.effective,
    editor.scope,
    path,
  );
  const steps: Step[] =
    state.kind === "default" || !Array.isArray(state.value)
      ? []
      : (state.value as unknown[]).filter(isObject).map((s) => s as Step);
  const editable = editor.canEdit && state.kind !== "inherited";
  const put = (next: Step[]) =>
    editor.set(path, next.length === 0 ? undefined : next);
  const change = (index: number, patch: Partial<Step>) =>
    put(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  return (
    <fieldset
      className="policy-group"
      data-testid="ladder-steps"
    >
      <legend>Steps</legend>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Score</th>
            <th scope="col">Action</th>
            <th scope="col">Ban length</th>
            {editable ? (
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {steps.map((step, index) => (
            <tr
              // eslint-disable-next-line react/no-array-index-key -- steps have no id: their place is their identity
              key={index}
              data-testid="ladder-step"
            >
              <td>
                <NumberInput
                  aria-label={`Step ${index + 1} score`}
                  disabled={!editable}
                  value={step.score}
                  min={0}
                  step="any"
                  onChange={(score) => change(index, { score })}
                />
              </td>
              <td>
                <Select
                  aria-label={`Step ${index + 1} action`}
                  disabled={!editable}
                  options={[
                    { value: "challenge", label: "Challenge" },
                    { value: "ban", label: "Ban" },
                  ]}
                  value={step.action ?? "challenge"}
                  onChange={(action) => change(index, { action })}
                />
              </td>
              <td>
                <TextInput
                  aria-label={`Step ${index + 1} ban length`}
                  disabled={!editable || step.action !== "ban"}
                  placeholder="1h"
                  value={step.duration ?? ""}
                  onChange={(duration) =>
                    change(
                      index,
                      duration === "" ? { duration: undefined } : { duration },
                    )
                  }
                />
              </td>
              {editable ? (
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => put(steps.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      <div
        className="policy-origin"
        data-testid="origin-ladder.steps"
      >
        {state.kind === "inherited" ? (
          <>
            <span>
              Inherited from <ScopeLink scope={state.origin} />
            </span>
            {editor.canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="override-ladder.steps"
                onClick={() => editor.set(path, state.value)}
              >
                Override
              </Button>
            ) : null}
          </>
        ) : state.kind === "own" ? (
          <>
            <span>Set here</span>
            {editor.canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="reset-ladder.steps"
                onClick={() => editor.set(path, undefined)}
              >
                {state.inherited === undefined
                  ? "Reset to default"
                  : "Reset to inherited"}
              </Button>
            ) : null}
          </>
        ) : (
          <span className="muted">Default steps</span>
        )}
        {editable ? (
          <Button
            size="sm"
            data-testid="ladder-step-add"
            onClick={() => put([...steps, { score: 10, action: "challenge" }])}
          >
            Add a step
          </Button>
        ) : null}
      </div>
    </fieldset>
  );
}

/** Props of {@link LadderTab}. */
export interface LadderTabProps {
  /** The `ladder` node of the policy's schema. */
  node: SchemaNode;
}

/** See the module's description. */
export function LadderTab({ node }: LadderTabProps) {
  const editor = usePolicyEditor();
  const control = controlOf(node);
  const inner =
    control.kind === "orFalse" && control.inner.kind === "object"
      ? control.inner.node
      : node;
  const state = fieldState(editor.working, editor.effective, editor.scope, [
    "ladder",
  ]);
  const off = state.kind !== "default" && state.value === false;
  return (
    <fieldset
      className="policy-group"
      data-testid="group-ladder"
    >
      <legend>Offence ladder</legend>
      <InheritedField
        path={["ladder"]}
        label="Ladder: off"
        control={control}
      />
      {off ? null : (
        <>
          <SchemaFields
            node={inner}
            path={["ladder"]}
            skip={["steps"]}
          />
          <Steps />
        </>
      )}
    </fieldset>
  );
}
