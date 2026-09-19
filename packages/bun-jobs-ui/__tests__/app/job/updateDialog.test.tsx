import type { MockHandler, MockReply, RecordedCall } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import {
  DATE_TIME_OUT_OF_RANGE,
  DATE_TIME_UNREADABLE,
} from "../../../app/components/inputValues";
import { jsonEditorState } from "../../../app/components/jsonParse";
import {
  updateBody,
  validateUpdateForm,
} from "../../../app/screens/job/updateJobForm";
import { act, fireEvent, page, setupDom, waitFor, within } from "../dom";
import { problem } from "../fixtures";
import { stubRawValue } from "../rawInput";
import { jobApiPath, jobFixture, jobMeta, logPage } from "./fixtures";
import { renderJobScreen, toastText } from "./render";

setupDom();

/** Opens the Edit dialog of a waiting job, with a PATCH handler. */
async function openEdit(
  patch: MockHandler | MockReply = {
    body: jobFixture("waiting", { priority: 1 }),
  },
  maxJobDataBytes = 1_048_576,
) {
  const result = await renderJobScreen(jobFixture("waiting"), {
    meta: jobMeta({ limits: { ...jobMeta().limits, maxJobDataBytes } }),
    handlers: {
      [`GET ${jobApiPath()}/logs`]: { body: logPage(0, 100, "asc", 0) },
      [`PATCH ${jobApiPath()}`]: patch,
    },
  });
  fireEvent.click(await page().findByRole("button", { name: "Edit" }));
  const dialog = await page().findByRole("dialog", { name: "Edit job" });
  const patches = () =>
    result.calls.filter((call: RecordedCall) => call.method === "PATCH");
  return { ...result, dialog, patches };
}

/** Submits the dialog's form. */
async function save(dialog: HTMLElement) {
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  });
}

/** The error text under a labelled field. */
function errorOf(dialog: HTMLElement, label: string): string {
  const control = within(dialog).getByLabelText(label);
  return (
    control.closest(".field")?.querySelector(".field-error")?.textContent ?? ""
  );
}

describe("the update dialog", () => {
  it("requires at least one of data, priority or run time, without a request", async () => {
    const { dialog, patches } = await openEdit();
    await save(dialog);
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "Change at least one of data, priority or run time.",
    );
    expect(patches()).toHaveLength(0);
  });

  it("PATCHes only the priority when only the priority is given, then closes and toasts", async () => {
    const { dialog, patches } = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("Priority"), {
      target: { value: "1" },
    });
    await save(dialog);
    await waitFor(() => expect(page().queryByRole("dialog")).toBeNull());
    expect(patches()).toHaveLength(1);
    const call = patches()[0]!;
    expect(call.path).toBe(jobApiPath());
    expect(JSON.parse(call.body!)).toEqual({ priority: 1 });
    expect(call.headers["content-type"]).toBe("application/json");
    await waitFor(() => expect(toastText().polite).toContain("Job updated"));
  });

  it("sends new data, a run time and the onlyIn states", async () => {
    const { dialog, patches } = await openEdit();
    fireEvent.click(within(dialog).getByLabelText("Replace the data"));
    const editor = within(dialog).getByLabelText("Data");
    expect((editor as HTMLTextAreaElement).value).toContain("ada@example.com");
    fireEvent.change(editor, { target: { value: '{"to":"bob@example.com"}' } });
    fireEvent.change(within(dialog).getByLabelText("Run at"), {
      target: { value: "2026-10-01T09:30" },
    });
    fireEvent.click(
      within(dialog).getByLabelText(
        "Only if the job is still in one of these states",
      ),
    );
    // The job's own state is ticked to start with; add delayed.
    const states = within(dialog).getByRole("group", { name: "Only in" });
    expect(
      (within(states).getByLabelText("Waiting") as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(within(states).getByLabelText("Delayed"));
    await save(dialog);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(patches()[0]!.body!)).toEqual({
      data: { to: "bob@example.com" },
      runAt: new Date("2026-10-01T09:30").getTime(),
      onlyIn: ["waiting", "delayed"],
    });
  });

  it("refuses a run time past MAX_DATE_MS in place, with Save disabled, until it is fixed", async () => {
    const { dialog, patches } = await openEdit();
    const saveButton = within(dialog).getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    const input = within(dialog).getByLabelText("Run at") as HTMLInputElement;
    // Before, this read as empty ("keep the run time") and was dropped.
    const raw = stubRawValue(input, "275760-12-31T00:00");
    fireEvent.change(input);
    raw.restore();
    expect(errorOf(dialog, "Run at")).toBe(DATE_TIME_OUT_OF_RANGE);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(saveButton.disabled).toBe(true);
    // Enter still submits a form whose button is disabled: nothing is sent.
    await act(async () => {
      fireEvent.submit(dialog.querySelector("form")!);
    });
    expect(patches()).toHaveLength(0);
    fireEvent.change(input, { target: { value: "2026-10-01T09:30" } });
    expect(errorOf(dialog, "Run at")).toBe("");
    expect(saveButton.disabled).toBe(false);
    await save(dialog);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(patches()[0]!.body!)).toEqual({
      runAt: new Date("2026-10-01T09:30").getTime(),
    });
  });

  it("refuses a run time the browser could not read", async () => {
    const { dialog } = await openEdit();
    const input = within(dialog).getByLabelText("Run at") as HTMLInputElement;
    const raw = stubRawValue(input, "", true);
    fireEvent.blur(input);
    raw.restore();
    expect(errorOf(dialog, "Run at")).toBe(DATE_TIME_UNREADABLE);
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Save",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("accepts null as the new data", async () => {
    const { dialog, patches } = await openEdit();
    fireEvent.click(within(dialog).getByLabelText("Replace the data"));
    fireEvent.change(within(dialog).getByLabelText("Data"), {
      target: { value: "null" },
    });
    await save(dialog);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(patches()[0]!.body!)).toEqual({ data: null });
  });

  it("refuses invalid JSON, an empty state list, and data over maxJobDataBytes", async () => {
    const { dialog, patches } = await openEdit(undefined, 40);
    fireEvent.click(within(dialog).getByLabelText("Replace the data"));
    const editor = within(dialog).getByLabelText("Data");
    fireEvent.change(editor, { target: { value: "{nope" } });
    fireEvent.click(
      within(dialog).getByLabelText(
        "Only if the job is still in one of these states",
      ),
    );
    fireEvent.click(within(dialog).getByLabelText("Waiting"));
    await save(dialog);
    expect(errorOf(dialog, "Data")).toBe("The data is not valid JSON.");
    expect(
      within(dialog).getByRole("group", { name: "Only in" }).textContent,
    ).toContain("Pick at least one state");

    fireEvent.change(editor, {
      target: { value: JSON.stringify({ text: "x".repeat(60) }) },
    });
    expect(dialog.textContent).toContain("over the limit");
    expect(errorOf(dialog, "Data")).toBe(
      "The data is larger than the API accepts.",
    );
    expect(patches()).toHaveLength(0);
  });

  it("shows VALIDATION issues beside their fields", async () => {
    const { dialog } = await openEdit({
      status: 400,
      body: problem(400, "VALIDATION", "Validation failed", {
        issues: [
          {
            target: "body",
            path: "priority",
            message: "Expected a finite number",
          },
          { target: "body", path: "runAt", message: "Expected a date-time" },
        ],
      }),
    });
    fireEvent.change(within(dialog).getByLabelText("Priority"), {
      target: { value: "3" },
    });
    await save(dialog);
    await waitFor(() =>
      expect(errorOf(dialog, "Priority")).toBe("Expected a finite number"),
    );
    expect(errorOf(dialog, "Run at")).toBe("Expected a date-time");
    expect(page().getByRole("dialog", { name: "Edit job" })).toBeTruthy();
  });

  it("explains a 409 JOB_STATE_CONFLICT inline", async () => {
    const { dialog } = await openEdit({
      status: 409,
      body: problem(409, "JOB_STATE_CONFLICT", "Job state conflict", {
        context: { state: "active" },
      }),
    });
    fireEvent.change(within(dialog).getByLabelText("Run at"), {
      target: { value: "2026-10-01T09:30" },
    });
    await save(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(
      "The job is active now, so it cannot be updated.",
    );
  });
});

describe("validateUpdateForm / updateBody", () => {
  const base = {
    changeData: false,
    data: jsonEditorState("{}"),
    priority: undefined,
    runAt: undefined,
    conditional: false,
    onlyIn: [],
  };

  it("needs one change, and a finite priority", () => {
    expect(validateUpdateForm(base).form).toBeDefined();
    expect(validateUpdateForm({ ...base, priority: Number.NaN }).priority).toBe(
      "Enter a number.",
    );
    expect(validateUpdateForm({ ...base, priority: 0 })).toEqual({});
  });

  it("leaves out what was not changed, and onlyIn when unconditional", () => {
    expect(updateBody({ ...base, priority: 0, onlyIn: ["waiting"] })).toEqual({
      priority: 0,
    });
    expect(
      updateBody({ ...base, runAt: 5, conditional: true, onlyIn: ["delayed"] }),
    ).toEqual({ runAt: 5, onlyIn: ["delayed"] });
  });
});
