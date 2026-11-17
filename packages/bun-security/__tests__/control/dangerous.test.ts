/**
 * Dangerous changes (control-plane.md §5.4): dry run to enforced on
 * production, an action raised, an allow entry added or widened, the
 * ladder changed; and what is not dangerous.
 */
import { describe, expect, it } from "bun:test";
import { dangerousChanges } from "../../lib/control/index";

describe("dangerousChanges", () => {
  it("finds dry run → enforce on production only", () => {
    const before = {
      limits: [{ id: "x", limit: 1, window: "1m", mode: "dryRun" }],
    };
    const after = { limits: [{ id: "x", limit: 1, window: "1m" }] };
    expect(dangerousChanges(before, after, true)).toEqual([
      "limits[id=x]: from dry run to enforced on a production service",
    ]);
    expect(dangerousChanges(before, after, false)).toEqual([]);
    expect(
      dangerousChanges({ mode: "dryRun" }, { mode: "enforce" }, true),
    ).toEqual([
      "mode: the policy goes from dry run to enforced on a production service",
    ]);
  });

  it("finds an action raised, an allow entry added or widened, the ladder changed", () => {
    expect(
      dangerousChanges(
        { requestRules: { rules: [{ id: "r", action: "log" }] } },
        { requestRules: { rules: [{ id: "r", action: "ban" }] } },
        false,
      ),
    ).toEqual(["requestRules.rules[id=r]: its action raised from log to ban"]);
    expect(
      dangerousChanges(
        {},
        { lists: [{ ip: "10.0.0.0/8", action: "allow" }] },
        false,
      ),
    ).toEqual(["lists[id=ip:10.0.0.0/8]: an allow entry added"]);
    expect(
      dangerousChanges(
        { lists: [{ id: "office", ip: "198.51.100.0/24", action: "allow" }] },
        { lists: [{ id: "office", ip: "198.51.0.0/16", action: "allow" }] },
        false,
      ),
    ).toEqual(["lists[id=office]: an allow entry widened from /24 to /16"]);
    expect(
      dangerousChanges(
        { ladder: { halfLife: "1h" } },
        { ladder: { halfLife: "2h" } },
        false,
      ),
    ).toEqual(["ladder: the escalation ladder changed"]);
  });

  it("negative control: lowering an action, narrowing an allow, an unchanged policy are not dangerous", () => {
    expect(
      dangerousChanges(
        {
          requestRules: { rules: [{ id: "r", action: "ban" }] },
          lists: [{ id: "o", ip: "198.51.0.0/16", action: "allow" }],
        },
        {
          requestRules: { rules: [{ id: "r", action: "log" }] },
          lists: [{ id: "o", ip: "198.51.100.0/24", action: "allow" }],
        },
        true,
      ),
    ).toEqual([]);
    const same = {
      limits: [{ id: "x", limit: 1, window: "1m" }],
      ladder: { halfLife: "1h" },
    };
    expect(dangerousChanges(same, structuredClone(same), true)).toEqual([]);
  });
});
