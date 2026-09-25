import { describe, expect, it } from "bun:test";
import { runnerActionGates } from "../../../../app/screens/runners/actions/gating";
import { fireEvent, page, setupDom, within } from "../../dom";
import {
  actionGroup,
  actionNames,
  clearHistoryButton,
  finishedHistory,
  historyCard,
  nonLocalRunner,
  openDialog,
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
        "runners.clearHistory": false,
      },
    });
    expect(actionGroup()).toBeNull();
  });

  it("drops kill and reset stats on a remote runner, with a hint", async () => {
    await renderActions({ runner: nonLocalRunner() });
    expect(actionNames()).toEqual(["Trigger…", "Pause", "Reschedule…"]);
    expect(page().getByTestId("runner-non-local-hint").textContent).toContain(
      "kill and reset stats are only available from the API of the process that runs it",
    );
  });

  it("shows no remote hint when the caller could not kill or reset anyway", async () => {
    await renderActions({
      runner: nonLocalRunner(),
      scoped: { "runners.kill": false, "runners.resetStats": false },
    });
    expect(page().queryByTestId("runner-non-local-hint")).toBeNull();
  });

  it("offers nothing in the header when clear history is the only write granted", async () => {
    await renderActions({
      history: finishedHistory(),
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
    expect(clearHistoryButton()).not.toBeNull();
  });
});

describe("clear history: in the History card, not the header", () => {
  it("sits in the History card's header, ahead of the Runs shown select", async () => {
    await renderActions({ history: finishedHistory() });
    const button = clearHistoryButton()!;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("");
    // In the card's header, before the size select and above the runs.
    const select = within(historyCard()).getByLabelText("Runs shown");
    expect(
      button.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const table = within(historyCard()).getByRole("table", {
      name: "Run history",
    });
    expect(
      button.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("is absent from the Runner actions group entirely", async () => {
    await renderActions({
      runner: runningRunner(),
      history: finishedHistory(),
    });
    expect(clearHistoryButton()).not.toBeNull();
    const group = actionGroup()!;
    expect(group).not.toBeNull();
    expect(
      within(group).queryByRole("button", { name: "Clear history…" }),
    ).toBeNull();
    expect(actionNames()).not.toContain("Clear history…");
    // One button on the page: the card's.
    expect(
      page().queryAllByRole("button", { name: "Clear history…" }),
    ).toHaveLength(1);
  });

  it("is offered on a remote runner, and does not bring up the remote hint", async () => {
    await renderActions({
      runner: nonLocalRunner(),
      history: finishedHistory(),
      scoped: { "runners.kill": false, "runners.resetStats": false },
    });
    expect(clearHistoryButton()).not.toBeNull();
    expect(page().queryByTestId("runner-non-local-hint")).toBeNull();
  });

  it("is offered on a remote runner beside the remote hint for kill and reset stats", async () => {
    await renderActions({
      runner: nonLocalRunner(),
      history: finishedHistory(),
    });
    expect(clearHistoryButton()).not.toBeNull();
    expect(page().getByTestId("runner-non-local-hint").textContent).not.toMatch(
      /clear|history/i,
    );
  });

  it("is dropped without runners.clearHistory", async () => {
    await renderActions({
      history: finishedHistory(),
      scoped: { "runners.clearHistory": false },
    });
    expect(clearHistoryButton()).toBeNull();
    // The rest of the card is still there.
    expect(within(historyCard()).getByLabelText("Runs shown")).not.toBeNull();
  });

  it("is dropped while the routes are not registered (absent from both maps)", async () => {
    await renderActions({
      history: finishedHistory(),
      scoped: { "runners.clearHistory": undefined },
      permissions: { "runners.clearHistory": undefined },
    });
    expect(clearHistoryButton()).toBeNull();
  });

  it("is dropped on a read-only API", async () => {
    await renderActions({
      history: finishedHistory(),
      meta: { readOnly: true },
    });
    expect(clearHistoryButton()).toBeNull();
    expect(page().queryByRole("button", { name: "Clear history…" })).toBeNull();
  });

  it("is disabled, saying so, when the history is empty", async () => {
    const { calls } = await renderActions({
      history: {
        items: [],
        page: { offset: 0, limit: 50, total: 0, hasMore: false },
      },
    });
    expect(within(historyCard()).getByText("No runs yet")).not.toBeNull();
    const button = clearHistoryButton()!;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("No runs to clear.");
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openDialog()).toBeNull();
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
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
    const gates = runnerActionGates(nonLocalRunner({ isRunning: true }), all);
    expect(gates.kill).toBe(false);
    expect(gates.resetStats).toBe(false);
    expect(gates.nonLocalOnly).toBe(true);
  });

  it("opens clear history on a remote runner, without making it remote-only", () => {
    const onlyClear = (action: string) => action === "runners.clearHistory";
    const gates = runnerActionGates(nonLocalRunner(), onlyClear);
    expect(gates.clearHistory).toBe(true);
    expect(gates.nonLocalOnly).toBe(false);
  });
});
