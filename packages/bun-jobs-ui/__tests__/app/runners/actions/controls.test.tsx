import { describe, expect, it } from "bun:test";
import { fireEvent, setupDom, waitFor, within } from "../../dom";
import { problem } from "../../fixtures";
import {
  actionButton,
  callTo,
  dialogButton,
  errorToasts,
  notifications,
  openAction,
  openDialog,
  renderActions,
  runFixture,
  runnerFixture,
  runningRunner,
  toastSays,
  typeConfirmation,
} from "./fixtures";

setupDom();

describe("pause", () => {
  it("pauses with a bodiless POST carrying Content-Type, toasts and invalidates", async () => {
    const { calls, invalidated } = await renderActions({
      handlers: { "POST /runners/nightly/pause": { body: { paused: true } } },
    });
    fireEvent.click(actionButton("Pause"));
    await toastSays("Paused nightly");
    const call = callTo(calls, "POST", "/runners/nightly/pause")!;
    expect(call.body).toBeUndefined();
    expect(call.headers["content-type"]).toBe("application/json");
    expect(invalidated).toEqual([["runner", "nightly"], ["runners"]]);
  });

  it("toasts a failure with the explanation", async () => {
    await renderActions({
      handlers: {
        "POST /runners/nightly/pause": {
          status: 404,
          body: problem(404, "RUNNER_NOT_FOUND", "Runner not found"),
        },
      },
    });
    fireEvent.click(actionButton("Pause"));
    await waitFor(() =>
      expect(errorToasts().textContent).toContain("Could not pause nightly"),
    );
    expect(errorToasts().textContent).toContain(
      "The runner no longer exists in this namespace",
    );
  });
});

describe("resume", () => {
  it("resumes with a bodiless POST by default", async () => {
    const { calls, invalidated } = await renderActions({
      runner: runnerFixture({ isPaused: true }),
      handlers: { "POST /runners/nightly/resume": { body: { paused: false } } },
    });
    const dialog = await openAction("Resume…");
    fireEvent.click(dialogButton(dialog, "Resume"));
    await toastSays("Resumed nightly");
    const call = callTo(calls, "POST", "/runners/nightly/resume")!;
    expect(call.body).toBeUndefined();
    expect(call.headers["content-type"]).toBe("application/json");
    expect(invalidated).toEqual([["runner", "nightly"], ["runners"]]);
    await waitFor(() => expect(openDialog()).toBeNull());
  });

  it("sends triggerNow when ticked", async () => {
    const { calls } = await renderActions({
      runner: runnerFixture({ isPaused: true }),
      handlers: { "POST /runners/nightly/resume": { body: { paused: false } } },
    });
    const dialog = await openAction("Resume…");
    fireEvent.click(within(dialog).getByLabelText("Also trigger a run now"));
    fireEvent.click(dialogButton(dialog, "Resume"));
    await toastSays("Resumed nightly and asked for a run");
    expect(
      JSON.parse(callTo(calls, "POST", "/runners/nightly/resume")!.body!),
    ).toEqual({ triggerNow: true });
  });
});

describe("reset stats", () => {
  it("confirms, sends a bodiless POST and handles the 204", async () => {
    const { calls, invalidated } = await renderActions({
      handlers: { "POST /runners/nightly/stats/reset": { status: 204 } },
    });
    const dialog = await openAction("Reset stats…");
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    fireEvent.click(dialogButton(dialog, "Reset stats"));
    await toastSays("Reset the stats of nightly");
    const call = callTo(calls, "POST", "/runners/nightly/stats/reset")!;
    expect(call.body).toBeUndefined();
    expect(call.headers["content-type"]).toBe("application/json");
    expect(invalidated).toEqual([["runner", "nightly"], ["runners"]]);
  });

  it("explains RUNNER_NOT_LOCAL (409)", async () => {
    await renderActions({
      handlers: {
        "POST /runners/nightly/stats/reset": {
          status: 409,
          body: problem(
            409,
            "RUNNER_NOT_LOCAL",
            "Runner is not registered in this process",
          ),
        },
      },
    });
    const dialog = await openAction("Reset stats…");
    fireEvent.click(dialogButton(dialog, "Reset stats"));
    await within(dialog).findByRole("alert");
    expect(dialog.textContent).toContain(
      "Only the process that registered the runner can reset its stats",
    );
    expect(dialog.textContent).toContain("RUNNER_NOT_LOCAL");
  });
});

describe("kill", () => {
  const twoRuns = () =>
    runningRunner([
      runFixture({ runId: "run-1" }),
      runFixture({ runId: "run-2", source: "schedule", attempt: 2 }),
    ]);

  it("needs the runner id typed, kills every run by default and toasts the 202", async () => {
    const { calls, invalidated } = await renderActions({
      runner: twoRuns(),
      handlers: {
        "POST /runners/nightly/kill": {
          status: 202,
          body: { runIds: ["run-1", "run-2"] },
        },
      },
    });
    const dialog = await openAction("Kill…");
    const kill = dialogButton(dialog, "Kill");
    expect(kill.disabled).toBe(true);
    typeConfirmation(dialog, "nightly");
    expect(kill.disabled).toBe(false);
    fireEvent.click(kill);
    await toastSays("Kill requested for 2 runs on nightly");
    expect(notifications().textContent).toContain("run-1, run-2");
    const call = callTo(calls, "POST", "/runners/nightly/kill")!;
    expect(call.body).toBeUndefined();
    expect(call.headers["content-type"]).toBe("application/json");
    expect(invalidated).toEqual([["runner", "nightly"], ["runners"]]);
  });

  it("lists the active runs, and sends runId, force and a trimmed reason", async () => {
    const { calls } = await renderActions({
      runner: twoRuns(),
      handlers: {
        "POST /runners/nightly/kill": {
          status: 202,
          body: { runIds: ["run-2"] },
        },
      },
    });
    const dialog = await openAction("Kill…");
    const select = within(dialog).getByLabelText("Run") as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.textContent)).toEqual([
      "Every active run (2)",
      "run-1 (manual, attempt 1)",
      "run-2 (schedule, attempt 2)",
    ]);
    fireEvent.change(select, { target: { value: "run-2" } });
    fireEvent.click(within(dialog).getByLabelText("Force"));
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "  stuck  " },
    });
    typeConfirmation(dialog, "nightly");
    fireEvent.click(dialogButton(dialog, "Kill"));
    await toastSays("Kill requested for 1 run on nightly");
    expect(
      JSON.parse(callTo(calls, "POST", "/runners/nightly/kill")!.body!),
    ).toEqual({ runId: "run-2", force: true, reason: "stuck" });
  });

  it("refuses a reason over 200 characters", async () => {
    await renderActions({ runner: twoRuns() });
    const dialog = await openAction("Kill…");
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "x".repeat(201) },
    });
    typeConfirmation(dialog, "nightly");
    expect(dialogButton(dialog, "Kill").disabled).toBe(true);
    expect(dialog.textContent).toContain("At most 200 characters.");
  });

  it("with wait, shows the pending state until the runs settle, then toasts the 200", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = await renderActions({
      runner: twoRuns(),
      handlers: {
        "POST /runners/nightly/kill": async () => {
          await gate;
          return { status: 200, body: { runIds: ["run-1", "run-2"] } };
        },
      },
    });
    const dialog = await openAction("Kill…");
    fireEvent.click(
      within(dialog).getByLabelText("Wait until the runs have settled"),
    );
    typeConfirmation(dialog, "nightly");
    fireEvent.click(dialogButton(dialog, "Kill"));
    expect(
      await within(dialog).findByText("Waiting for the runs to settle…"),
    ).toBeTruthy();
    expect(within(dialog).getByTestId("kill-waiting").textContent).toContain(
      "closeTimeout plus killTimeout",
    );
    expect(dialogButton(dialog, "Cancel").disabled).toBe(true);
    release();
    await toastSays("Killed 2 runs on nightly");
    expect(
      JSON.parse(callTo(calls, "POST", "/runners/nightly/kill")!.body!),
    ).toEqual({ wait: true });
    await waitFor(() => expect(openDialog()).toBeNull());
  });

  it("says so when no run was active any more", async () => {
    await renderActions({
      runner: twoRuns(),
      handlers: {
        "POST /runners/nightly/kill": { status: 202, body: { runIds: [] } },
      },
    });
    const dialog = await openAction("Kill…");
    typeConfirmation(dialog, "nightly");
    fireEvent.click(dialogButton(dialog, "Kill"));
    await toastSays("No run was active on nightly");
  });

  it("explains RUN_NOT_FOUND (404)", async () => {
    await renderActions({
      runner: twoRuns(),
      handlers: {
        "POST /runners/nightly/kill": {
          status: 404,
          body: problem(404, "RUN_NOT_FOUND", "Run not found", {
            detail: 'Run "run-2" is not active in this process',
          }),
        },
      },
    });
    const dialog = await openAction("Kill…");
    fireEvent.change(within(dialog).getByLabelText("Run"), {
      target: { value: "run-2" },
    });
    typeConfirmation(dialog, "nightly");
    fireEvent.click(dialogButton(dialog, "Kill"));
    await within(dialog).findByRole("alert");
    expect(dialog.textContent).toContain(
      "That run is no longer active in this process",
    );
  });

  it("explains RUNNER_NOT_LOCAL (409)", async () => {
    await renderActions({
      runner: twoRuns(),
      handlers: {
        "POST /runners/nightly/kill": {
          status: 409,
          body: problem(
            409,
            "RUNNER_NOT_LOCAL",
            "Runner is not registered in this process",
          ),
        },
      },
    });
    const dialog = await openAction("Kill…");
    typeConfirmation(dialog, "nightly");
    fireEvent.click(dialogButton(dialog, "Kill"));
    await within(dialog).findByRole("alert");
    expect(dialog.textContent).toContain(
      "Only the process executing a run can kill it",
    );
    expect(dialog.textContent).toContain("Use the management API");
  });
});
