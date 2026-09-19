import type { MetaDto } from "../../../app/api/types";
import type { MockHandler, MockReply } from "../mockFetch";
import { MAX_JOB_ID_LENGTH } from "@kingsleyweb/bun-jobs/api/contract";
import { describe, expect, it, mock } from "bun:test";
import { DATE_TIME_OUT_OF_RANGE } from "../../../app/components/inputValues";
import { jsonEditorState } from "../../../app/components/jsonParse";
import { AddJobDialog } from "../../../app/screens/job";
import {
  addBody,
  checkJobId,
  validateAddForm,
} from "../../../app/screens/job/addJobForm";
import { act, fireEvent, page, setupDom, waitFor, within } from "../dom";
import { problem } from "../fixtures";
import { stubRawValue } from "../rawInput";
import {
  allPermissions,
  definitionsFixture,
  jobFixture,
  jobMeta,
} from "./fixtures";
import { renderWithProviders, toastText } from "./render";

setupDom();

/** Opens the dialog for queue `emails` with `meta` and handlers. */
async function openAdd(
  options: {
    meta?: MetaDto;
    post?: MockHandler | MockReply;
    handlers?: Record<string, MockHandler | MockReply>;
    canDefinitions?: boolean;
  } = {},
) {
  const onClose = mock(() => {});
  const result = await renderWithProviders(
    <AddJobDialog
      queue="emails"
      open
      onClose={onClose}
    />,
    {
      meta: options.meta ?? jobMeta(),
      permissions: allPermissions({
        "definitions.list": options.canDefinitions ?? true,
      }),
      handlers: {
        "GET /definitions": { body: definitionsFixture },
        "POST /queues/emails/jobs": options.post ?? {
          status: 201,
          body: { added: true, job: jobFixture("waiting", { id: "42" }) },
        },
        ...options.handlers,
      },
    },
  );
  const dialog = await page().findByRole("dialog", {
    name: "Add a job to emails",
  });
  const posts = () => result.calls.filter((call) => call.method === "POST");
  return { ...result, dialog, onClose, posts };
}

/** Matches a field's label with or without its required marker ("Name *"). */
function labelled(label: string): RegExp {
  return new RegExp(
    `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*\\*)?$`,
  );
}

/** Submits the dialog. */
async function submit(dialog: HTMLElement) {
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Add job" }));
  });
}

/** The error under a labelled field. */
function errorOf(dialog: HTMLElement, label: string): string {
  const control = within(dialog).getByLabelText(labelled(label));
  return (
    control.closest(".field")?.querySelector(".field-error")?.textContent ?? ""
  );
}

/** Sets a labelled input's value. */
function type(dialog: HTMLElement, label: string, value: string) {
  fireEvent.change(within(dialog).getByLabelText(labelled(label)), {
    target: { value },
  });
}

/** The options of a labelled select. */
function optionsOf(dialog: HTMLElement, label: string): string[] {
  return Array.from(
    within(dialog).getByLabelText(labelled(label)).querySelectorAll("option"),
  ).map((option) => option.textContent ?? "");
}

describe("the add-job dialog: names", () => {
  it("with addableNames null, lists the definitions and allows another name as free text", async () => {
    const { dialog, posts } = await openAdd();
    await waitFor(() =>
      expect(optionsOf(dialog, "Name")).toEqual([
        "Pick a name…",
        "send-welcome",
        "send-digest",
        "Another name…",
      ]),
    );
    const select = within(dialog).getByLabelText(
      labelled("Name"),
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: select.options[3]!.value } });
    type(dialog, "Another name", "one-off");
    await submit(dialog);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0]!.body!).name).toBe("one-off");
  });

  it("with addableNames null and a defined name picked, sends it", async () => {
    const { dialog, posts } = await openAdd();
    await waitFor(() =>
      expect(optionsOf(dialog, "Name")).toContain("send-digest"),
    );
    type(dialog, "Name", "send-digest");
    await submit(dialog);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0]!.body!)).toEqual({
      name: "send-digest",
      data: {},
    });
  });

  it("with addableNames null and no definitions to read, takes free text", async () => {
    const { dialog, calls } = await openAdd({ canDefinitions: false });
    expect(within(dialog).getByLabelText(labelled("Name")).tagName).toBe(
      "INPUT",
    );
    expect(calls.some((call) => call.path === "/definitions")).toBe(false);
  });

  it("with a list of addable names, offers exactly those", async () => {
    const { dialog, calls, posts } = await openAdd({
      meta: jobMeta({ addableNames: ["send-welcome", "send-receipt"] }),
    });
    expect(optionsOf(dialog, "Name")).toEqual([
      "Pick a name…",
      "send-welcome",
      "send-receipt",
    ]);
    expect(calls.some((call) => call.path === "/definitions")).toBe(false);
    await submit(dialog);
    expect(errorOf(dialog, "Name")).toBe("Pick or enter a job name.");
    type(dialog, "Name", "send-receipt");
    await submit(dialog);
    await waitFor(() => expect(posts()).toHaveLength(1));
  });

  it("preselects the only addable name", async () => {
    const { dialog } = await openAdd({
      meta: jobMeta({ addableNames: ["only"] }),
    });
    expect(
      (within(dialog).getByLabelText(labelled("Name")) as HTMLSelectElement)
        .value,
    ).toBe("only");
  });

  it("explains an empty list, and cannot submit", async () => {
    const { dialog } = await openAdd({ meta: jobMeta({ addableNames: [] }) });
    expect(dialog.textContent).toContain("No job can be added here");
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Add job",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("the add-job dialog: data and options", () => {
  it("POSTs name, data and the options given, with the JSON content type", async () => {
    const { dialog, posts, onClose } = await openAdd({
      meta: jobMeta({ addableNames: ["send-welcome"] }),
    });
    type(dialog, "Data", '{"to":"ada@example.com"}');
    type(dialog, "Job id", "welcome/ada 1");
    type(dialog, "Priority", "2");
    type(dialog, "Attempts", "5");
    type(dialog, "Backoff (ms)", "1000");
    type(dialog, "Timeout (ms)", "0");
    await submit(dialog);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const call = posts()[0]!;
    expect(call.path).toBe("/queues/emails/jobs");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.body!)).toEqual({
      name: "send-welcome",
      data: { to: "ada@example.com" },
      opts: {
        jobId: "welcome/ada 1",
        priority: 2,
        attempts: 5,
        backoff: 1000,
        timeout: 0,
      },
    });
  });

  it("allows null data, and requires some", async () => {
    const { dialog, posts } = await openAdd({
      meta: jobMeta({ addableNames: ["a"] }),
    });
    type(dialog, "Data", "");
    await submit(dialog);
    expect(errorOf(dialog, "Data")).toBe("The data is not valid JSON.");
    type(dialog, "Data", "null");
    await submit(dialog);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0]!.body!)).toEqual({ name: "a", data: null });
  });

  it("limits the job id to MAX_JOB_ID_LENGTH characters", async () => {
    const { dialog, posts } = await openAdd({
      meta: jobMeta({ addableNames: ["a"] }),
    });
    const input = within(dialog).getByLabelText(
      labelled("Job id"),
    ) as HTMLInputElement;
    expect(input.maxLength).toBe(MAX_JOB_ID_LENGTH);
    type(dialog, "Job id", "x".repeat(MAX_JOB_ID_LENGTH + 1));
    await submit(dialog);
    expect(errorOf(dialog, "Job id")).toBe(
      `At most ${MAX_JOB_ID_LENGTH} characters (this one has ${MAX_JOB_ID_LENGTH + 1}).`,
    );
    expect(posts()).toHaveLength(0);
    type(dialog, "Job id", "x".repeat(MAX_JOB_ID_LENGTH));
    await submit(dialog);
    await waitFor(() => expect(posts()).toHaveLength(1));
  });

  it("sends a delay or a run time, never both", async () => {
    const { dialog, posts } = await openAdd({
      meta: jobMeta({ addableNames: ["a"] }),
    });
    type(dialog, "Run", "delay");
    type(dialog, "Delay (ms)", "500");
    type(dialog, "Run", "runAt");
    expect(within(dialog).queryByLabelText(labelled("Delay (ms)"))).toBeNull();
    type(dialog, "Run at", "2026-10-01T09:30");
    await submit(dialog);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0]!.body!).opts).toEqual({
      runAt: new Date("2026-10-01T09:30").getTime(),
    });
  });

  it("refuses a run time before 1970 or past MAX_DATE_MS in place, with Add job disabled", async () => {
    const { dialog, posts } = await openAdd({
      meta: jobMeta({ addableNames: ["a"] }),
    });
    const addButton = within(dialog).getByRole("button", {
      name: "Add job",
    }) as HTMLButtonElement;
    type(dialog, "Run", "runAt");
    type(dialog, "Run at", "1969-06-01T00:00");
    expect(errorOf(dialog, "Run at")).toBe(DATE_TIME_OUT_OF_RANGE);
    expect(addButton.disabled).toBe(true);
    const input = within(dialog).getByLabelText(
      labelled("Run at"),
    ) as HTMLInputElement;
    const raw = stubRawValue(input, "275760-09-14T00:00");
    fireEvent.change(input);
    raw.restore();
    expect(errorOf(dialog, "Run at")).toBe(DATE_TIME_OUT_OF_RANGE);
    await submit(dialog);
    expect(posts()).toHaveLength(0);
    // The field goes with its timing, and takes its problem with it.
    type(dialog, "Run", "now");
    expect(addButton.disabled).toBe(false);
    await submit(dialog);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0]!.body!).opts).toBeUndefined();
  });

  it("sends only the delay when a delay is chosen", async () => {
    const { dialog, posts } = await openAdd({
      meta: jobMeta({ addableNames: ["a"] }),
    });
    type(dialog, "Run", "runAt");
    type(dialog, "Run at", "2026-10-01T09:30");
    type(dialog, "Run", "delay");
    await submit(dialog);
    expect(errorOf(dialog, "Delay (ms)")).toBe(
      "Enter the delay in milliseconds.",
    );
    type(dialog, "Delay (ms)", "500");
    await submit(dialog);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0]!.body!).opts).toEqual({ delay: 500 });
  });

  it("checks attempts ≥ 1 and backoff/timeout ≥ 0 before sending", async () => {
    const { dialog, posts } = await openAdd({
      meta: jobMeta({ addableNames: ["a"] }),
    });
    type(dialog, "Attempts", "0");
    type(dialog, "Backoff (ms)", "-1");
    type(dialog, "Timeout (ms)", "1.5");
    await submit(dialog);
    expect(errorOf(dialog, "Attempts")).toBe("Enter 1 or more.");
    expect(errorOf(dialog, "Backoff (ms)")).toBe("Enter 0 or more.");
    expect(errorOf(dialog, "Timeout (ms)")).toBe("Enter a whole number.");
    expect(posts()).toHaveLength(0);
  });

  it("meters the data against maxJobDataBytes and refuses more", async () => {
    const { dialog, posts } = await openAdd({
      meta: jobMeta({
        addableNames: ["a"],
        limits: { ...jobMeta().limits, maxJobDataBytes: 16 },
      }),
    });
    expect(dialog.textContent).toContain("2 B of 16 B");
    type(dialog, "Data", JSON.stringify({ text: "far too long" }));
    expect(dialog.textContent).toContain("over the limit");
    await submit(dialog);
    expect(errorOf(dialog, "Data")).toBe(
      "The data is larger than the API accepts.",
    );
    expect(posts()).toHaveLength(0);
  });
});

describe("the add-job dialog: results and errors", () => {
  it("toasts a 201 with a link to the new job, and closes", async () => {
    const { dialog, onClose } = await openAdd({
      meta: jobMeta({ addableNames: ["a"] }),
      post: {
        status: 201,
        body: { added: true, job: jobFixture("waiting", { id: "new/1" }) },
      },
    });
    await submit(dialog);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toastText().polite).toContain("Job added to emails"),
    );
    const toast = document.querySelector(".toast-viewport .toast-success")!;
    await act(async () => {
      fireEvent.click(
        within(toast as HTMLElement).getByRole("button", { name: "View job" }),
      );
    });
    expect(window.location.pathname).toBe("/jobs/queues/emails/jobs/new%2F1");
  });

  it("toasts a 200 as 'a job with this id already exists', with a link", async () => {
    const { dialog, onClose } = await openAdd({
      meta: jobMeta({ addableNames: ["a"] }),
      post: {
        status: 200,
        body: { added: false, job: jobFixture("completed", { id: "dup" }) },
      },
    });
    type(dialog, "Job id", "dup");
    await submit(dialog);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toastText().polite).toContain("A job with this id already exists"),
    );
    const toast = document.querySelector(".toast-viewport .toast-info")!;
    expect(
      within(toast as HTMLElement).getByRole("button", { name: "View job" }),
    ).toBeTruthy();
  });

  it("shows 403 NAME_NOT_ADDABLE under the name", async () => {
    const { dialog, onClose } = await openAdd({
      meta: jobMeta({ addableNames: ["a"] }),
      post: {
        status: 403,
        body: problem(403, "NAME_NOT_ADDABLE", "Name not addable", {
          context: { name: "a" },
        }),
      },
    });
    await submit(dialog);
    await waitFor(() =>
      expect(errorOf(dialog, "Name")).toContain(
        "Jobs named “a” may not be added",
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(toastText().assertive).toBe("");
  });

  it("shows VALIDATION issues under their fields", async () => {
    const { dialog } = await openAdd({
      meta: jobMeta({ addableNames: ["a"] }),
      post: {
        status: 400,
        body: problem(400, "VALIDATION", "Validation failed", {
          issues: [
            { target: "body", path: "opts.attempts", message: "Must be ≥ 1" },
            { target: "body", path: "name", message: "Too long" },
          ],
        }),
      },
    });
    await submit(dialog);
    await waitFor(() =>
      expect(errorOf(dialog, "Attempts")).toBe("Must be ≥ 1"),
    );
    expect(errorOf(dialog, "Name")).toBe("Too long");
  });

  it("shows SERIALIZATION under the data", async () => {
    const { dialog } = await openAdd({
      meta: jobMeta({ addableNames: ["a"] }),
      post: {
        status: 400,
        body: problem(400, "SERIALIZATION", "Serialization failed"),
      },
    });
    await submit(dialog);
    await waitFor(() =>
      expect(errorOf(dialog, "Data")).toContain("The data cannot be stored"),
    );
  });

  it("shows other problems in a banner", async () => {
    const { dialog } = await openAdd({
      meta: jobMeta({ addableNames: ["a"] }),
      post: {
        status: 400,
        body: problem(400, "INVALID_ARGUMENT", "Invalid argument", {
          detail: "jobId has a control character",
        }),
      },
    });
    await submit(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("jobId has a control character");
  });
});

describe("validateAddForm / addBody / checkJobId", () => {
  const base = {
    name: "a",
    data: jsonEditorState("{}"),
    jobId: "",
    priority: undefined,
    timing: "now" as const,
    delay: undefined,
    runAt: undefined,
    attempts: undefined,
    backoff: undefined,
    timeout: undefined,
  };

  it("accepts the minimum and leaves opts out", () => {
    expect(validateAddForm(base)).toEqual({});
    expect(addBody(base)).toEqual({ name: "a", data: {} });
  });

  it("refuses a leading dot and control characters in a job id", () => {
    expect(checkJobId(".hidden")).toBe("An id cannot start with a dot.");
    expect(checkJobId("ab")).toBe("An id cannot contain control characters.");
    expect(checkJobId("ok id/1")).toBeUndefined();
  });

  it("ignores a delay while the timing is runAt", () => {
    expect(
      addBody({ ...base, timing: "runAt", runAt: 7, delay: 3 }).opts,
    ).toEqual({
      runAt: 7,
    });
  });
});
