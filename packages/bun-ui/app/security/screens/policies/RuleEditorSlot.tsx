/**
 * The request rules' tab (layers.md L7): PR-U5's `RequestRulesEditor` over
 * the policy editor's `requestRules.rules` (the coordinator's split of
 * 2026-11-18). It reads and writes them through `usePolicyEditor()`, so the
 * rules save with the rest of the draft, and shows the rules inherited from
 * the scopes above (with their locks) and each rule's save issues. Beside
 * them, the managed probe set's settings and a link to test a request.
 */
import type { SchemaNode } from "./schema";
import { Link } from "../../router";
import { SCOPE_PARAM } from "../../scope/scope";
import { RequestRulesEditor } from "../rules/RequestRulesEditor";
import { rulesOf } from "../rules/ruleModel";
import { inheritedRules } from "../rules/rulesPolicy";
import { usePolicyEditor } from "./editorContext";
import { SchemaFields } from "./fields";

/** Props of {@link RuleEditorSlot}. */
export interface RuleEditorSlotProps {
  /** The `requestRules` node of the policy's schema. */
  node: SchemaNode;
  /** Whether the operator may test a request (`rules:test`). */
  canTest: boolean;
}

/** See the module's description. */
export function RuleEditorSlot({ node, canTest }: RuleEditorSlotProps) {
  const editor = usePolicyEditor();
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
      <RequestRulesEditor
        rules={rulesOf(editor.working)}
        onChange={(rules) =>
          editor.set(
            ["requestRules", "rules"],
            rules.length === 0 ? undefined : rules,
          )
        }
        canLock={!editor.scope.startsWith("service:")}
        disabled={!editor.canEdit}
        inherited={inheritedRules(editor.effective, editor.scope)}
        issuesAt={(index) => editor.issuesAt(["requestRules", "rules", index])}
      />
      <SchemaFields
        node={node}
        path={["requestRules"]}
        skip={["rules"]}
      />
    </div>
  );
}
