import type { QueryKey } from "@tanstack/react-query";
import type {
  RunnerConfigDto,
  RunnerHistoryDto,
} from "../../../../app/api/types";
import { describe, expect, it } from "bun:test";
import { runLogKeys } from "../../../../app/api/runnerLogs";
import { runnerKeys } from "../../../../app/api/runners";
import { clearHistoryMessage } from "../../../../app/screens/runners/actions/explain";
import { fireEvent, page, setupDom, waitFor, within } from "../../dom";
import { problem } from "../../fixtures";
import {
  historyFixture,
  renderRunner,
  runFixture as screenRunFixture,
} from "../fixtures";
import {
  callTo,
  dialogButton,
  finishedHistory,
  openClearHistory,
  openDialog,
  remoteRunner,
  renderActions,
  runnerFixture,
  toastSays,
} from "./fixtures";

setupDom();

/** Whether `key` starts with `prefix`, as TanStack's prefix match does. */
function covers(prefix: QueryKey, key: QueryKey): boolean {
  return prefix.every(
    (part, index) => JSON.stringify(part) === JSON.stringify(key[index]),
  );
}

describe("clear history: the confirmation", () => {
  it("says what goes and what stays", async () => {
    await renderActions({ history: finishedHistory() });
    const dialog = await openClearHistory();
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    const text = dialog.textContent ?? "";
    expect(text).toContain("Clear the run history of nightly?");
    expect(text).toContain("Removes every finished run and its log");
    expect(text).toContain("Runs still in progress are kept");
    expect(text).toContain(
      "The lifetime counters and the charts are untouched: Reset stats… is separate.",
    );
    expect(text).toContain("started over a day ago");
  });

  it("has no parallel-run small print for a local runner", async () => {
    await renderActions({
      runner: runnerFixture({ runMode: "parallel" }),
      history: finishedHistory(),
    });
    await openClearHistory();
    expect(page().queryByTestId("clear-history-parallel-note")).toBeNull();
  });

  it("has no parallel-run small print for a remote single-mode runner", async () => {
    await renderActions({
      runner: remoteRunner({ runMode: "single" }),
      history: finishedHistory(),
    });
    await openClearHistory();
    expect(page().queryByTestId("clear-history-parallel-note")).toBeNull();
  });

  it("warns about long parallel runs on a remote parallel runner", async () => {
    await renderActions({
      runner: remoteRunner({ runMode: "parallel" }),
      history: finishedHistory(),
    });
    await openClearHistory();
    expect(
      page().getByTestId("clear-history-parallel-note").textContent,
    ).toContain("a parallel run still going after a day");
  });

  it("reads the effective run mode from the config over the snapshot's", async () => {
    const config: RunnerConfigDto = {
      effective: {
        executionMode: "worker",
        runMode: "single",
        maxConcurrency: null,
      },
      overridden: [],
      seq: 1,
      appliedSeq: 1,
    };
    await renderActions({
      history: finishedHistory(),
      runner: remoteRunner({ runMode: "parallel", config }),
    });
    await openClearHistory();
    expect(page().queryByTestId("clear-history-parallel-note")).toBeNull();
  });
});

describe("clear history: the request", () => {
  it("sends a bodiless DELETE, toasts the count and invalidates the runner", async () => {
    const { calls, invalidated } = await renderActions({
      history: finishedHistory(),
      handlers: {
        "DELETE /runners/nightly/history": { body: { removed: 12, kept: [] } },
      },
    });
    const dialog = await openClearHistory();
    fireEvent.click(dialogButton(dialog, "Clear history"));
    await toastSays("Cleared 12 runs");
    const call = callTo(calls, "DELETE", "/runners/nightly/history")!;
    expect(call.body).toBeUndefined();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(invalidated).toEqual([["runner", "nightly"], ["runners"]]);
    // The runner prefix reaches its history, its run logs and its detail.
    const prefix = invalidated[0]!;
    expect(covers(prefix, runnerKeys.historyAll("nightly"))).toBe(true);
    expect(covers(prefix, runnerKeys.detail("nightly"))).toBe(true);
    expect(covers(prefix, runLogKeys.run("nightly", "run-1"))).toBe(true);
    await waitFor(() => expect(openDialog()).toBeNull());
  });

  it("says how many runs in progress were kept, and names them", async () => {
    await renderActions({
      history: finishedHistory(),
      handlers: {
        "DELETE /runners/nightly/history": {
          body: { removed: 3, kept: ["run-9"] },
        },
      },
    });
    const dialog = await openClearHistory();
    fireEvent.click(dialogButton(dialog, "Clear history"));
    await toastSays("Cleared 3 runs, kept 1 in progress");
    await toastSays("Kept: run-9");
  });

  it("is offered on a remote runner and sends the same DELETE", async () => {
    const { calls } = await renderActions({
      history: finishedHistory(),
      runner: remoteRunner(),
      handlers: {
        "DELETE /runners/nightly/history": { body: { removed: 1, kept: [] } },
      },
    });
    const dialog = await openClearHistory();
    fireEvent.click(dialogButton(dialog, "Clear history"));
    await toastSays("Cleared 1 run");
    expect(callTo(calls, "DELETE", "/runners/nightly/history")).toBeDefined();
  });

  it("explains RUNNER_NOT_FOUND (404) in the dialog", async () => {
    await renderActions({
      history: finishedHistory(),
      handlers: {
        "DELETE /runners/nightly/history": {
          status: 404,
          body: problem(404, "RUNNER_NOT_FOUND", "Runner not found"),
        },
      },
    });
    const dialog = await openClearHistory();
    fireEvent.click(dialogButton(dialog, "Clear history"));
    await within(dialog).findByRole("alert");
    expect(dialog.textContent).toContain("so it has no history left to clear");
    expect(dialog.textContent).toContain("RUNNER_NOT_FOUND");
    expect(openDialog()).not.toBeNull();
  });
});

describe("clearHistoryMessage", () => {
  it("counts removed runs, and kept ones only when there are any", () => {
    expect(clearHistoryMessage(0, [])).toBe("Cleared 0 runs");
    expect(clearHistoryMessage(1, [])).toBe("Cleared 1 run");
    expect(clearHistoryMessage(5, ["a", "b"])).toBe(
      "Cleared 5 runs, kept 2 in progress",
    );
  });
});

describe("clear history on the runner screen", () => {
  it("re-reads the history after the clear", async () => {
    let cleared = false;
    const after: RunnerHistoryDto = {
      items: [screenRunFixture({ runId: "run-live", status: "running" })],
    };
    const { calls } = renderRunner({
      handlers: {
        "GET /runners/nightly/history": () => ({
          body: cleared ? after : historyFixture(),
        }),
        "DELETE /runners/nightly/history": () => {
          cleared = true;
          return { body: { removed: 2, kept: ["run-live"] } };
        },
      },
    });
    // In the History card, above the runs it clears.
    const card = await page().findByRole("region", { name: "History" });
    const button = await within(card).findByRole("button", {
      name: "Clear history…",
    });
    expect(
      page()
        .queryAllByRole("group", { name: "Runner actions" })
        .every(
          (group) =>
            within(group).queryByRole("button", { name: "Clear history…" }) ===
            null,
        ),
    ).toBe(true);
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "GET" && call.path === "/runners/nightly/history",
        ),
      ).toBe(true),
    );
    const before = calls.filter(
      (call) =>
        call.method === "GET" && call.path === "/runners/nightly/history",
    ).length;
    fireEvent.click(button);
    const dialog = await page().findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clear history" }),
    );
    await waitFor(() =>
      expect(
        calls.filter(
          (call) =>
            call.method === "GET" && call.path === "/runners/nightly/history",
        ).length,
      ).toBeGreaterThan(before),
    );
    await page().findByText(/Cleared 2 runs, kept 1 in progress/);
  });
});
