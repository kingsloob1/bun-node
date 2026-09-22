import type { SkipReason } from "../../../../app/screens/runners/actions/explain";
import { describe, expect, it } from "bun:test";
import { SKIP_REASONS } from "../../../../app/screens/runners/actions/explain";
import { fireEvent, setupDom, waitFor, within } from "../../dom";
import { problem } from "../../fixtures";
import {
  callTo,
  dialogButton,
  errorToasts,
  notifications,
  openAction,
  openDialog,
  remoteRunner,
  renderActions,
  toastSays,
} from "./fixtures";

setupDom();

const PATH = "/runners/nightly/trigger";

describe("trigger", () => {
  it("sends a bodiless POST by default and toasts the started run with a copy button", async () => {
    const { calls, invalidated } = await renderActions({
      handlers: {
        [`POST ${PATH}`]: {
          status: 202,
          body: { outcome: "started", runId: "run-42" },
        },
      },
    });
    const dialog = await openAction("Trigger…");
    fireEvent.click(dialogButton(dialog, "Trigger"));
    await toastSays("Run started on nightly");
    expect(notifications().textContent).toContain("run-42");
    expect(
      within(notifications()).getByRole("button", { name: "Copy run id" }),
    ).toBeTruthy();
    const call = callTo(calls, "POST", PATH)!;
    expect(call.body).toBeUndefined();
    expect(call.headers["content-type"]).toBe("application/json");
    await waitFor(() => expect(openDialog()).toBeNull());
    expect(invalidated).toEqual([["runner", "nightly"], ["runners"]]);
  });

  it("sends force when ticked, and toasts a queued run with its position", async () => {
    const { calls } = await renderActions({
      handlers: {
        [`POST ${PATH}`]: {
          status: 202,
          body: { outcome: "queued", position: 3 },
        },
      },
    });
    const dialog = await openAction("Trigger…");
    fireEvent.click(within(dialog).getByLabelText("Run even while paused"));
    fireEvent.click(dialogButton(dialog, "Trigger"));
    await toastSays("Run queued on nightly");
    expect(notifications().textContent).toContain(
      "Position 3 in the trigger queue.",
    );
    expect(JSON.parse(callTo(calls, "POST", PATH)!.body!)).toEqual({
      force: true,
    });
  });

  it("explains that force only skips the pause check", async () => {
    await renderActions();
    const dialog = await openAction("Trigger…");
    expect(dialog.textContent).toContain("Force skips only the pause check");
  });

  for (const reason of Object.keys(SKIP_REASONS) as SkipReason[]) {
    it(`toasts a skip for "${reason}" in words`, async () => {
      await renderActions({
        handlers: {
          [`POST ${PATH}`]: {
            status: 200,
            body: { outcome: "skipped", reason },
          },
        },
      });
      const dialog = await openAction("Trigger…");
      fireEvent.click(dialogButton(dialog, "Trigger"));
      await toastSays("Run skipped on nightly");
      expect(notifications().textContent).toContain(SKIP_REASONS[reason]);
      await waitFor(() => expect(openDialog()).toBeNull());
    });
  }

  it("has no args editor unless the API accepts run arguments", async () => {
    await renderActions({ meta: { runnerTriggerArgs: false } });
    const dialog = await openAction("Trigger…");
    expect(within(dialog).queryByLabelText("Arguments")).toBeNull();
  });

  it("sends args with runnerTriggerArgs, and blocks invalid JSON", async () => {
    const { calls } = await renderActions({
      meta: { runnerTriggerArgs: true },
      handlers: {
        [`POST ${PATH}`]: {
          status: 202,
          body: { outcome: "started", runId: "run-7" },
        },
      },
    });
    const dialog = await openAction("Trigger…");
    const args = within(dialog).getByLabelText("Arguments");
    fireEvent.change(args, { target: { value: "{ nope" } });
    expect(dialogButton(dialog, "Trigger").disabled).toBe(true);
    fireEvent.change(args, { target: { value: '{ "day": "2026-09-18" }' } });
    expect(dialogButton(dialog, "Trigger").disabled).toBe(false);
    fireEvent.click(dialogButton(dialog, "Trigger"));
    await toastSays("Run started on nightly");
    expect(JSON.parse(callTo(calls, "POST", PATH)!.body!)).toEqual({
      args: { day: "2026-09-18" },
    });
  });

  it("refuses args over maxJobDataBytes", async () => {
    await renderActions({
      meta: {
        runnerTriggerArgs: true,
        limits: {
          defaultPageSize: 20,
          maxPageSize: 100,
          maxBulkIds: 1000,
          maxRetryAll: 10000,
          maxRetryAllIds: 1000,
          maxClean: 10000,
          maxApplyDefaults: 1000,
          defaultClean: 1000,
          maxLogPage: 500,
          maxHistory: 200,
          maxJobDataBytes: 10,
          maxQueues: 500,
        },
      },
    });
    const dialog = await openAction("Trigger…");
    fireEvent.change(within(dialog).getByLabelText("Arguments"), {
      target: { value: '"a long string of args"' },
    });
    expect(dialogButton(dialog, "Trigger").disabled).toBe(true);
  });

  it("explains ARGS_NOT_ALLOWED inside the dialog", async () => {
    await renderActions({
      meta: { runnerTriggerArgs: true },
      handlers: {
        [`POST ${PATH}`]: {
          status: 400,
          body: problem(400, "ARGS_NOT_ALLOWED", "Arguments not allowed", {
            detail: "This API does not accept run arguments",
          }),
        },
      },
    });
    const dialog = await openAction("Trigger…");
    fireEvent.change(within(dialog).getByLabelText("Arguments"), {
      target: { value: "1" },
    });
    fireEvent.click(dialogButton(dialog, "Trigger"));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(dialog.textContent).toContain("created without runnerTriggerArgs");
    expect(dialog.textContent).toContain("ARGS_NOT_ALLOWED");
    expect(openDialog()).toBeTruthy();
    expect(errorToasts().textContent).toBe("");
  });

  it("explains RUNNER_STOPPED (409)", async () => {
    await renderActions({
      handlers: {
        [`POST ${PATH}`]: {
          status: 409,
          body: problem(409, "RUNNER_STOPPED", "Runner is stopped"),
        },
      },
    });
    const dialog = await openAction("Trigger…");
    fireEvent.click(dialogButton(dialog, "Trigger"));
    await within(dialog).findByRole("alert");
    expect(dialog.textContent).toContain("The runner has stopped");
    expect(dialog.textContent).toContain("409");
  });

  it("notes that a remote runner's trigger is queued for its owner", async () => {
    await renderActions({
      runner: remoteRunner(),
      handlers: {
        [`POST ${PATH}`]: {
          status: 202,
          body: { outcome: "queued", position: 1 },
        },
      },
    });
    const dialog = await openAction("Trigger…");
    expect(
      within(dialog).getByTestId("trigger-remote-note").textContent,
    ).toContain("its owner starts it at its next sync");
    fireEvent.click(dialogButton(dialog, "Trigger"));
    await toastSays("Run queued on nightly");
    expect(notifications().textContent).toContain(
      "The process that owns the runner starts it at its next sync.",
    );
  });
});
