import { describe, expect, it } from "bun:test";
import { DATE_TIME_OUT_OF_RANGE } from "../../../../app/components/inputValues";
import { fireEvent, setupDom, waitFor, within } from "../../dom";
import { problem } from "../../fixtures";
import { stubRawValue } from "../../rawInput";
import {
  callTo,
  dialogButton,
  errorToasts,
  notifications,
  openAction,
  openDialog,
  renderActions,
  runnerFixture,
  toastSays,
} from "./fixtures";

setupDom();

const PATH = "/runners/nightly/schedule";

/** The body sent to the schedule route. */
function sentSchedule(
  calls: Awaited<ReturnType<typeof renderActions>>["calls"],
) {
  const call = callTo(calls, "PUT", PATH);
  return call ? (JSON.parse(call.body!) as { schedule: unknown }) : undefined;
}

/** The value of a labelled input in the dialog. */
function valueOf(dialog: HTMLElement, label: string | RegExp): string {
  return (within(dialog).getByLabelText(label) as HTMLInputElement).value;
}

/** Whether a mode radio is checked. */
function checked(dialog: HTMLElement, mode: string): boolean {
  return (within(dialog).getByLabelText(mode) as HTMLInputElement).checked;
}

/** Local wall-clock text for `datetime-local` with seconds. */
function localText(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

describe("the schedule editor: prefill", () => {
  it("prefills a cron schedule and its time zone", async () => {
    await renderActions();
    const dialog = await openAction("Reschedule…");
    expect(checked(dialog, "Cron")).toBe(true);
    expect(valueOf(dialog, /^Cron expression/)).toBe("0 3 * * *");
    expect(valueOf(dialog, "Time zone")).toBe("UTC");
  });

  it("prefills an interval and its anchor", async () => {
    const anchor = new Date(2026, 8, 18, 9, 30, 15).getTime();
    await renderActions({
      runner: runnerFixture({ schedule: { every: 1_800_000, anchor } }),
    });
    const dialog = await openAction("Reschedule…");
    expect(checked(dialog, "Every")).toBe(true);
    expect(valueOf(dialog, /^Interval/)).toBe("30");
    expect(valueOf(dialog, "Unit")).toBe("minutes");
    expect(valueOf(dialog, "Anchor")).toBe(localText(anchor));
  });

  it("prefills a one-off time", async () => {
    const at = new Date(2030, 0, 2, 3, 4, 5).getTime();
    await renderActions({ runner: runnerFixture({ schedule: { at } }) });
    const dialog = await openAction("Reschedule…");
    expect(checked(dialog, "Once")).toBe(true);
    expect(valueOf(dialog, /^Run at/)).toBe(localText(at));
  });

  it("prefills none for an unscheduled runner", async () => {
    await renderActions({ runner: runnerFixture({ schedule: null }) });
    const dialog = await openAction("Reschedule…");
    expect(checked(dialog, "None")).toBe(true);
    expect(dialog.textContent).toContain("the runner runs only when triggered");
  });
});

describe("the schedule editor: saving", () => {
  it("sends { cron, tz } with PUT, shows the next run from the response, and invalidates", async () => {
    const next = Date.now() + 2 * 3_600_000;
    const { calls, invalidated } = await renderActions({
      handlers: {
        [`PUT ${PATH}`]: {
          body: {
            schedule: { cron: "0 9 * * 1", tz: "Europe/London" },
            nextRunAt: next,
          },
        },
      },
    });
    const dialog = await openAction("Reschedule…");
    fireEvent.change(within(dialog).getByLabelText(/^Cron expression/), {
      target: { value: "0 9 * * 1" },
    });
    fireEvent.change(within(dialog).getByLabelText("Time zone"), {
      target: { value: "Europe/London" },
    });
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    await toastSays("Rescheduled nightly");
    const nextRun = within(notifications()).getByTestId("schedule-next-run");
    expect(nextRun.textContent).toContain("in 2h");
    expect(nextRun.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(next).toISOString(),
    );
    const call = callTo(calls, "PUT", PATH)!;
    expect(call.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.body!)).toEqual({
      schedule: { cron: "0 9 * * 1", tz: "Europe/London" },
    });
    expect(invalidated).toEqual([["runner", "nightly"], ["runners"]]);
    await waitFor(() => expect(openDialog()).toBeNull());
  });

  it("converts an interval in hours to ms, with an anchor", async () => {
    const anchor = new Date(2026, 8, 18, 0, 0, 30).getTime();
    const { calls } = await renderActions({
      handlers: {
        [`PUT ${PATH}`]: {
          body: { schedule: { every: 3_600_000, anchor }, nextRunAt: null },
        },
      },
    });
    const dialog = await openAction("Reschedule…");
    fireEvent.click(within(dialog).getByLabelText("Every"));
    fireEvent.change(within(dialog).getByLabelText(/^Interval/), {
      target: { value: "1" },
    });
    fireEvent.change(within(dialog).getByLabelText("Unit"), {
      target: { value: "hours" },
    });
    fireEvent.change(within(dialog).getByLabelText("Anchor"), {
      target: { value: localText(anchor) },
    });
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    await toastSays("Rescheduled nightly");
    expect(sentSchedule(calls)).toEqual({
      schedule: { every: 3_600_000, anchor },
    });
  });

  it("converts seconds and minutes too", async () => {
    const { calls } = await renderActions({
      handlers: {
        [`PUT ${PATH}`]: {
          body: { schedule: { every: 45_000 }, nextRunAt: null },
        },
      },
    });
    const dialog = await openAction("Reschedule…");
    fireEvent.click(within(dialog).getByLabelText("Every"));
    fireEvent.change(within(dialog).getByLabelText(/^Interval/), {
      target: { value: "45" },
    });
    fireEvent.change(within(dialog).getByLabelText("Unit"), {
      target: { value: "seconds" },
    });
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    await toastSays("Rescheduled nightly");
    expect(sentSchedule(calls)).toEqual({ schedule: { every: 45_000 } });
  });

  it("sends a one-off time as epoch ms", async () => {
    const at = new Date(2030, 5, 1, 12, 0, 10).getTime();
    const { calls } = await renderActions({
      handlers: {
        [`PUT ${PATH}`]: { body: { schedule: { at }, nextRunAt: at } },
      },
    });
    const dialog = await openAction("Reschedule…");
    fireEvent.click(within(dialog).getByLabelText("Once"));
    fireEvent.change(within(dialog).getByLabelText(/^Run at/), {
      target: { value: localText(at) },
    });
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    await toastSays("Rescheduled nightly");
    expect(sentSchedule(calls)).toEqual({ schedule: { at } });
  });

  it("unschedules with null", async () => {
    const { calls } = await renderActions({
      handlers: {
        [`PUT ${PATH}`]: { body: { schedule: null, nextRunAt: null } },
      },
    });
    const dialog = await openAction("Reschedule…");
    fireEvent.click(within(dialog).getByLabelText("None"));
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    await toastSays("nightly is unscheduled");
    expect(notifications().textContent).toContain(
      "No run is scheduled; it runs only when triggered.",
    );
    expect(sentSchedule(calls)).toEqual({ schedule: null });
  });
});

describe("the schedule editor: validation", () => {
  it("refuses an unknown time zone before sending", async () => {
    const { calls } = await renderActions();
    const dialog = await openAction("Reschedule…");
    fireEvent.change(within(dialog).getByLabelText("Time zone"), {
      target: { value: "Mars/Base" },
    });
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        "“Mars/Base” is not a known time zone",
      ),
    );
    expect(callTo(calls, "PUT", PATH)).toBeUndefined();
  });

  it("refuses a malformed cron and an empty interval before sending", async () => {
    const { calls } = await renderActions();
    const dialog = await openAction("Reschedule…");
    fireEvent.change(within(dialog).getByLabelText(/^Cron expression/), {
      target: { value: "0 3 *" },
    });
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    await waitFor(() => expect(dialog.textContent).toContain("3 fields"));
    fireEvent.click(within(dialog).getByLabelText("Every"));
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        "Enter an interval greater than zero.",
      ),
    );
    expect(callTo(calls, "PUT", PATH)).toBeUndefined();
  });

  it("refuses an anchor or a one-off time outside the API's range, with Save disabled", async () => {
    const { calls } = await renderActions();
    const dialog = await openAction("Reschedule…");
    const saveButton = dialogButton(
      dialog,
      "Save schedule",
    ) as HTMLButtonElement;
    const fieldError = (label: string | RegExp) => {
      const field = within(dialog).getByLabelText(label).closest(".field");
      return field?.querySelector(".field-error")?.textContent ?? "";
    };

    fireEvent.click(within(dialog).getByLabelText("Every"));
    fireEvent.change(within(dialog).getByLabelText(/^Interval/), {
      target: { value: "5" },
    });
    const anchor = within(dialog).getByLabelText("Anchor") as HTMLInputElement;
    const raw = stubRawValue(anchor, "275760-12-31T00:00:00");
    fireEvent.change(anchor);
    raw.restore();
    expect(fieldError("Anchor")).toBe(DATE_TIME_OUT_OF_RANGE);
    expect(saveButton.disabled).toBe(true);

    fireEvent.click(within(dialog).getByLabelText("Once"));
    // The anchor went with its mode.
    expect(saveButton.disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText(/^Run at/), {
      target: { value: "1969-06-01T00:00:00" },
    });
    expect(fieldError(/^Run at/)).toBe(DATE_TIME_OUT_OF_RANGE);
    expect(saveButton.disabled).toBe(true);
    fireEvent.submit(dialog.querySelector("form")!);
    expect(callTo(calls, "PUT", PATH)).toBeUndefined();
  });

  it("shows INVALID_SCHEDULE on the field its issue names", async () => {
    await renderActions({
      handlers: {
        [`PUT ${PATH}`]: {
          status: 400,
          body: problem(400, "INVALID_SCHEDULE", "Invalid schedule", {
            detail: 'Invalid cron expression "61 * * * *": bad minute',
            issues: [
              { target: "body", path: "schedule.cron", message: "bad minute" },
            ],
          }),
        },
      },
    });
    const dialog = await openAction("Reschedule…");
    fireEvent.change(within(dialog).getByLabelText(/^Cron expression/), {
      target: { value: "61 * * * *" },
    });
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    const input = within(dialog).getByLabelText(/^Cron expression/);
    await waitFor(() =>
      expect(input.getAttribute("aria-invalid")).toBe("true"),
    );
    expect(dialog.textContent).toContain("bad minute");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(openDialog()).toBeTruthy();
    expect(errorToasts().textContent).toBe("");
  });

  it("puts a schedule.tz issue on the time zone, whatever the detail says", async () => {
    await renderActions({
      handlers: {
        [`PUT ${PATH}`]: {
          status: 400,
          body: problem(400, "INVALID_SCHEDULE", "Invalid schedule", {
            detail: "Something the UI must not parse",
            issues: [
              {
                target: "body",
                path: "schedule.tz",
                message: "unknown time zone 'Etc/Nowhere'",
              },
            ],
          }),
        },
      },
    });
    const dialog = await openAction("Reschedule…");
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    const tz = within(dialog).getByLabelText("Time zone");
    await waitFor(() => expect(tz.getAttribute("aria-invalid")).toBe("true"));
    expect(dialog.textContent).toContain("unknown time zone 'Etc/Nowhere'");
    expect(
      within(dialog)
        .getByLabelText(/^Cron expression/)
        .getAttribute("aria-invalid"),
    ).not.toBe("true");
  });

  it("puts a bare schedule issue on the mode's main field", async () => {
    await renderActions({
      handlers: {
        [`PUT ${PATH}`]: {
          status: 400,
          body: problem(400, "INVALID_SCHEDULE", "Invalid schedule", {
            detail: "not a schedule",
            issues: [
              { target: "body", path: "schedule", message: "not a schedule" },
            ],
          }),
        },
      },
    });
    const dialog = await openAction("Reschedule…");
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    const input = within(dialog).getByLabelText(/^Cron expression/);
    await waitFor(() =>
      expect(input.getAttribute("aria-invalid")).toBe("true"),
    );
  });

  it("shows an issue-less INVALID_SCHEDULE (an older API) as a banner", async () => {
    await renderActions({
      handlers: {
        [`PUT ${PATH}`]: {
          status: 400,
          body: problem(400, "INVALID_SCHEDULE", "Invalid schedule", {
            detail:
              "Invalid cron expression \"0 3 * * *\": Bun.cron: unknown time zone 'Etc/Nowhere'",
          }),
        },
      },
    });
    const dialog = await openAction("Reschedule…");
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("unknown time zone 'Etc/Nowhere'");
    expect(
      within(dialog).getByLabelText("Time zone").getAttribute("aria-invalid"),
    ).not.toBe("true");
    expect(
      within(dialog)
        .getByLabelText(/^Cron expression/)
        .getAttribute("aria-invalid"),
    ).not.toBe("true");
    expect(openDialog()).toBeTruthy();
  });

  it("maps VALIDATION field errors onto the fields", async () => {
    await renderActions({
      handlers: {
        [`PUT ${PATH}`]: {
          status: 400,
          body: problem(400, "VALIDATION", "Validation failed", {
            issues: [
              { target: "body", path: "schedule.tz", message: "Too long" },
            ],
          }),
        },
      },
    });
    const dialog = await openAction("Reschedule…");
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    await waitFor(() => expect(dialog.textContent).toContain("Too long"));
    expect(
      within(dialog).getByLabelText("Time zone").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("puts a VALIDATION issue at schedule.anchor on the anchor, as INVALID_SCHEDULE's are", async () => {
    await renderActions({
      handlers: {
        [`PUT ${PATH}`]: {
          status: 400,
          body: problem(400, "VALIDATION", "Validation failed", {
            issues: [
              {
                target: "body",
                path: "schedule.anchor",
                message: "Must be at most 8640000000000000",
              },
            ],
          }),
        },
      },
    });
    const dialog = await openAction("Reschedule…");
    fireEvent.click(within(dialog).getByLabelText("Every"));
    fireEvent.change(within(dialog).getByLabelText(/^Interval/), {
      target: { value: "5" },
    });
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    await waitFor(() =>
      expect(dialog.textContent).toContain("Must be at most 8640000000000000"),
    );
    expect(
      within(dialog).getByLabelText("Anchor").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(
      within(dialog)
        .getByLabelText(/^Interval/)
        .getAttribute("aria-invalid"),
    ).not.toBe("true");
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("shows any other failure as a banner, explained", async () => {
    await renderActions({
      handlers: {
        [`PUT ${PATH}`]: {
          status: 404,
          body: problem(404, "RUNNER_NOT_FOUND", "Runner not found"),
        },
      },
    });
    const dialog = await openAction("Reschedule…");
    fireEvent.click(dialogButton(dialog, "Save schedule"));
    await within(dialog).findByRole("alert");
    expect(dialog.textContent).toContain(
      "The runner no longer exists in this namespace",
    );
  });
});
