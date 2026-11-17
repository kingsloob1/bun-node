/**
 * `locked` on limits, counted rules and request rules (control-plane.md
 * §2.2, PR-CP2): accepted as a boolean on each, anything else refused.
 */
import { describe, expect, it } from "bun:test";
import { validatePolicy } from "../../lib/policy/schema";

describe("locked", () => {
  it("is accepted on a limit, a counted rule and a request rule, and compiles", () => {
    expect(
      validatePolicy({
        limits: [{ id: "l", limit: 1, window: "1m", locked: true }],
        countedRules: [
          {
            id: "c",
            event: "request",
            threshold: 1,
            window: "1m",
            duration: "1h",
            locked: false,
          },
        ],
        requestRules: {
          rules: [{ id: "r", when: { path: { prefix: "/x" } }, locked: true }],
        },
      }),
    ).toEqual([]);
  });

  it("refuses anything but a boolean, on each", () => {
    const issues = validatePolicy({
      limits: [{ id: "l", limit: 1, window: "1m", locked: "yes" }],
      countedRules: [
        {
          id: "c",
          event: "request",
          threshold: 1,
          window: "1m",
          duration: "1h",
          locked: 1,
        },
      ],
      requestRules: {
        rules: [{ id: "r", when: { path: { prefix: "/x" } }, locked: null }],
      },
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      ["limits", 0, "locked"],
      ["countedRules", 0, "locked"],
      ["requestRules", "rules", 0, "locked"],
    ]);
  });
});
