/**
 * The request-rules list editor (PR-U5), the adapter U4's policy editor
 * embeds in its request-rules slot: controlled (`rules` in, `onChange` out,
 * nothing saved), it adds a rule built in the rule editor, edits one in
 * place keeping its other fields, removes one, refuses an id another rule
 * has, shows the save's issues per rule and the inherited rules read-only,
 * and offers nothing when disabled.
 */
import type { RuleJson } from "../../../app/security/screens/rules/ruleModel";
import { describe, expect, it } from "bun:test";
import { useState } from "react";
import { expectAbsent } from "../../harness/assert";
import { RequestRulesEditor } from "../../../app/security/screens/rules/RequestRulesEditor";
import { fireEvent, page, render, setupDom } from "./dom";

setupDom();

/** The editor over `initial`, its every change recorded. */
function mount(
  initial: RuleJson[],
  extra: Partial<Parameters<typeof RequestRulesEditor>[0]> = {},
) {
  const changes: RuleJson[][] = [];
  function Harness() {
    const [rules, setRules] = useState<RuleJson[]>(initial);
    return (
      <RequestRulesEditor
        rules={rules}
        onChange={(next) => {
          changes.push(next);
          setRules(next);
        }}
        canLock
        {...extra}
      />
    );
  }
  render(<Harness />);
  return changes;
}

const A = {
  id: "a",
  when: { path: { glob: "/a/**" } },
  action: "block",
  mode: "enforce",
  note: "kept",
};
const B = {
  id: "b",
  when: { method: { equals: "TRACE" } },
  action: "drop",
  mode: "dryRun",
};

describe("the request-rules list editor", () => {
  it("adds a rule built in the editor", () => {
    const changes = mount([A]);
    fireEvent.click(page().getByTestId("request-rule-add"));
    fireEvent.change(page().getByTestId("rule-id"), { target: { value: "c" } });
    fireEvent.change(page().getByTestId("match-value-0"), {
      target: { value: "/c" },
    });
    fireEvent.click(page().getByTestId("request-rule-apply"));
    expect(changes).toEqual([
      [
        A,
        {
          id: "c",
          when: { path: { glob: "/c" } },
          action: "block",
          mode: "dryRun",
        },
      ],
    ]);
    expect(page().getAllByTestId("request-rule")).toHaveLength(2);
  });

  it("edits a rule in place, keeping the fields the editor does not show", () => {
    const changes = mount([A, B]);
    fireEvent.click(page().getByTestId("request-rule-edit-a"));
    fireEvent.change(page().getByTestId("rule-mode"), {
      target: { value: "dryRun" },
    });
    fireEvent.click(page().getByTestId("request-rule-apply"));
    expect(changes).toEqual([[{ ...A, mode: "dryRun" }, B]]);
  });

  it("refuses an id another rule has, and changes nothing", () => {
    const changes = mount([A, B]);
    fireEvent.click(page().getByTestId("request-rule-edit-a"));
    fireEvent.change(page().getByTestId("rule-id"), { target: { value: "b" } });
    fireEvent.click(page().getByTestId("request-rule-apply"));
    expect(page().getByTestId("request-rule-error").textContent).toBe(
      "A rule “b” exists already",
    );
    expect(changes.length).toBe(0);
  });

  it("removes a rule", () => {
    const changes = mount([A, B]);
    fireEvent.click(page().getByTestId("request-rule-remove-a"));
    expect(changes).toEqual([[B]]);
  });

  it("shows a save's issues per rule, and the inherited rules read-only", () => {
    mount([A], {
      issuesAt: (index) => (index === 0 ? ["when: an unknown target"] : []),
      inherited: [{ rule: B, origin: "global", locked: true }],
    });
    expect(page().getByTestId("request-rule-issues-a").textContent).toBe(
      "when: an unknown target",
    );
    expect(page().getByTestId("request-rules-inherited").textContent).toContain(
      "b from Global locked",
    );
  });

  it("disabled, it offers no change (the cases above, enabled, are the control)", () => {
    mount([A], { disabled: true });
    expectAbsent(page().queryByTestId("request-rule-add"), "add");
    expectAbsent(page().queryByTestId("request-rule-edit-a"), "edit");
  });
});
