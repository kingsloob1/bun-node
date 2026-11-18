/**
 * The request rules' tab (layers.md L7) until PR-U5's `RuleEditor` lands
 * (the coordinator's split of 2026-11-18): U5 builds the rule editor, the
 * matcher builder and the `/rules/test` screen under
 * `app/security/screens/rules/`, and this slot is where the policy editor
 * embeds them. Swap the body for `<RuleEditor …/>` and keep the props.
 *
 * Meanwhile it is the editor's generic keyed table over
 * `requestRules.rules` (each rule's condition as JSON), the managed probe
 * set's settings, and a link to test a request.
 */
import type { SchemaNode } from "./schema";
import { Link } from "../../router";
import { SCOPE_PARAM } from "../../scope/scope";
import { usePolicyEditor } from "./editorContext";
import { SchemaFields } from "./fields";
import { KeyedItems } from "./KeyedItems";
import { propertiesOf } from "./schema";

/** Props of {@link RuleEditorSlot}. */
export interface RuleEditorSlotProps {
  /** The `requestRules` node of the policy's schema. */
  node: SchemaNode;
  /** Whether the operator may test a request (`rules:test`). */
  canTest: boolean;
}

/** A rule in a line: its action and mode. */
function ruleSummary(rule: Record<string, unknown>): string {
  const action = typeof rule.action === "string" ? rule.action : "block";
  return `${action} when ${JSON.stringify(rule.when ?? {})}`;
}

/** See the module's description. */
export function RuleEditorSlot({ node, canTest }: RuleEditorSlotProps) {
  const editor = usePolicyEditor();
  const rules = propertiesOf(node)?.rules;
  const item =
    rules !== undefined &&
    typeof rules.items === "object" &&
    rules.items !== null
      ? (rules.items as SchemaNode)
      : {};
  return (
    <div
      className="policy-tab"
      data-testid="tab-rules"
    >
      {canTest ? (
        <p>
          <Link
            to={`/rules/test?${SCOPE_PARAM}=${encodeURIComponent(editor.scope)}`}
            data-testid="test-request-link"
          >
            Test a request
          </Link>{" "}
          against this scope&apos;s draft or its published policy.
        </p>
      ) : null}
      <KeyedItems
        section="requestRules.rules"
        item={item}
        noun="rule"
        summary={ruleSummary}
      />
      <SchemaFields
        node={node}
        path={["requestRules"]}
        skip={["rules"]}
      />
    </div>
  );
}
