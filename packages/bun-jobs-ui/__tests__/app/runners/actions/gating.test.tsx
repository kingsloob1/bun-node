import { describe, expect, it } from "bun:test";
import { runnerActionGates } from "../../../../app/screens/runners/actions/gating";
import { page, setupDom } from "../../dom";
import {
  actionGroup,
  actionNames,
  remoteRunner,
  renderActions,
  runnerFixture,
  runningRunner,
} from "./fixtures";

setupDom();

describe("which runner actions are offered", () => {
  it("offers every action on a local running runner, with every permission", async () => {
    await renderActions({ runner: runningRunner() });
    expect(actionNames()).toEqual([
      "Trigger…",
      "Pause",
      "Reschedule…",
      "Reset stats…",
      "Kill…",
    ]);
  });

  it("offers Resume instead of Pause on a paused runner", async () => {
    await renderActions({ runner: runnerFixture({ isPaused: true }) });
    expect(actionNames()).toContain("Resume…");
    expect(actionNames()).not.toContain("Pause");
  });

  it("hides Kill on a local runner with nothing in flight", async () => {
    await renderActions();
    expect(actionNames()).toEqual([
      "Trigger…",
      "Pause",
      "Reschedule…",
      "Reset stats…",
    ]);
  });

  it("hides each action whose runner-scoped permission is denied", async () => {
    await renderActions({
      runner: runningRunner(),
      scoped: {
        "runners.trigger": false,
        "runners.kill": false,
        "runners.reschedule": false,
      },
    });
    expect(actionNames()).toEqual(["Pause", "Reset stats…"]);
  });

  it("applies the scoped map over the untargeted one", async () => {
    await renderActions({
      permissions: { "runners.pause": false },
      scoped: { "runners.pause": true, "runners.trigger": false },
    });
    expect(actionNames()).toContain("Pause");
    expect(actionNames()).not.toContain("Trigger…");
  });

  it("treats an absent (pruned) action as denied", async () => {
    await renderActions({
      scoped: { "runners.resetStats": undefined },
      permissions: { "runners.resetStats": undefined },
    });
    expect(actionNames()).not.toContain("Reset stats…");
  });

  it("offers nothing on a read-only API, whatever the permissions say", async () => {
    await renderActions({ runner: runningRunner(), meta: { readOnly: true } });
    expect(actionGroup()).toBeNull();
  });

  it("offers nothing when every write is denied", async () => {
    await renderActions({
      scoped: {
        "runners.trigger": false,
        "runners.pause": false,
        "runners.resume": false,
        "runners.reschedule": false,
        "runners.kill": false,
        "runners.resetStats": false,
      },
    });
    expect(actionGroup()).toBeNull();
  });

  it("drops kill and reset stats on a remote runner, with a hint", async () => {
    await renderActions({ runner: remoteRunner() });
    expect(actionNames()).toEqual(["Trigger…", "Pause", "Reschedule…"]);
    expect(page().getByTestId("runner-remote-hint").textContent).toContain(
      "kill and reset stats are only available from the API of the process that runs it",
    );
  });

  it("shows no remote hint when the caller could not kill or reset anyway", async () => {
    await renderActions({
      runner: remoteRunner(),
      scoped: { "runners.kill": false, "runners.resetStats": false },
    });
    expect(page().queryByTestId("runner-remote-hint")).toBeNull();
  });
});

describe("runnerActionGates", () => {
  const all = () => true;

  it("needs the permission for each gate", () => {
    const gates = runnerActionGates(runningRunner(), () => false);
    expect(Object.values(gates).every((open) => !open)).toBe(true);
  });

  it("keeps kill closed on a started runner with nothing in flight (status running is the lifecycle)", () => {
    const runner = runnerFixture({
      local: { status: "running", activeRuns: [], nextRunAt: null },
    });
    expect(runnerActionGates(runner, all).kill).toBe(false);
  });

  it("keeps kill closed for a runner running elsewhere", () => {
    const gates = runnerActionGates(remoteRunner({ isRunning: true }), all);
    expect(gates.kill).toBe(false);
    expect(gates.resetStats).toBe(false);
    expect(gates.remoteOnly).toBe(true);
  });
});
