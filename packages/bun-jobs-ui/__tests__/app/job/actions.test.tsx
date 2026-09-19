import type { JobsApiAction } from "../../../app/api/contract";
import type { JobDto } from "../../../app/api/types";
import type { MockHandler, MockReply, RecordedCall } from "../mockFetch";
import { describe, expect, it, spyOn } from "bun:test";
import { JOB_STATES } from "../../../app/api/contract";
import { failConfirmation } from "../../../app/screens/job/failConfirm";
import {
  act,
  cleanup,
  fireEvent,
  page,
  setupDom,
  waitFor,
  within,
} from "../dom";
import { problem } from "../fixtures";
import {
  allPermissions,
  AWKWARD_ID,
  AWKWARD_ID_ENCODED,
  jobApiPath,
  jobFixture,
  jobMeta,
  logPage,
} from "./fixtures";
import { renderJobScreen, toastText } from "./render";

setupDom();

/** Renders a job with extra handlers, and a spy on query invalidation. */
async function renderActions(
  job: JobDto,
  handlers: Record<string, MockHandler | MockReply> = {},
  options: Parameters<typeof renderJobScreen>[1] = {},
) {
  const result = await renderJobScreen(job, {
    ...options,
    handlers: {
      [`GET ${jobApiPath()}/logs`]: { body: logPage(0, 100, "asc", 0) },
      ...handlers,
    },
  });
  const invalidate = spyOn(result.queryClient, "invalidateQueries");
  await page().findByRole("heading", { level: 1 });
  return { ...result, invalidate };
}

/** The actions group, or `null` when no action is offered. */
function actions() {
  return page().queryByRole("group", { name: "Job actions" });
}

/** Clicks a button in the actions group. */
function clickAction(name: string) {
  fireEvent.click(within(actions()!).getByRole("button", { name }));
}

/** The one call to `method` on the job's path with `suffix`. */
function callTo(calls: RecordedCall[], method: string, suffix = "") {
  return calls.find(
    (call) =>
      call.method === method && call.path === `${jobApiPath()}${suffix}`,
  );
}

/** Asserts the three invalidations every job mutation makes. */
function expectInvalidated(invalidate: {
  mock: { calls: readonly (readonly unknown[])[] };
}) {
  const keys = invalidate.mock.calls.map(
    (args) => (args[0] as { queryKey: unknown }).queryKey,
  );
  expect(keys).toContainEqual(["queue", "emails"]);
  expect(keys).toContainEqual(["queues"]);
  expect(keys).toContainEqual(["overview"]);
}

describe("retry", () => {
  it("POSTs resetAttempts from the checkbox (default true), then toasts and invalidates", async () => {
    const { calls, invalidate } = await renderActions(jobFixture("failed"), {
      [`POST ${jobApiPath()}/retry`]: { body: { retried: true } },
    });
    clickAction("Retry");
    const dialog = await page().findByRole("dialog", {
      name: "Retry this job?",
    });
    const reset = within(dialog).getByLabelText(
      "Reset attempts",
    ) as HTMLInputElement;
    expect(reset.checked).toBe(true);
    fireEvent.click(reset);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => expect(page().queryByRole("dialog")).toBeNull());
    const call = callTo(calls, "POST", "/retry")!;
    expect(call.path).toBe(`/queues/emails/jobs/${AWKWARD_ID_ENCODED}/retry`);
    expect(JSON.parse(call.body!)).toEqual({ resetAttempts: false });
    expect(call.headers["content-type"]).toBe("application/json");
    await waitFor(() => expect(toastText().polite).toContain("Job retried"));
    expectInvalidated(invalidate);
  });

  it("sends resetAttempts: true by default", async () => {
    const { calls } = await renderActions(jobFixture("dead"), {
      [`POST ${jobApiPath()}/retry`]: { body: { retried: true } },
    });
    clickAction("Retry");
    const dialog = await page().findByRole("dialog", {
      name: "Retry this job?",
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => expect(callTo(calls, "POST", "/retry")).toBeTruthy());
    expect(JSON.parse(callTo(calls, "POST", "/retry")!.body!)).toEqual({
      resetAttempts: true,
    });
  });

  it("explains a 409 JOB_STATE_CONFLICT with the job's state, and stays open", async () => {
    await renderActions(jobFixture("completed"), {
      [`POST ${jobApiPath()}/retry`]: {
        status: 409,
        body: problem(409, "JOB_STATE_CONFLICT", "Job state conflict", {
          detail: "The job cannot be retried in state waiting",
          context: { state: "waiting" },
        }),
      },
    });
    clickAction("Retry");
    const dialog = await page().findByRole("dialog", {
      name: "Retry this job?",
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    });
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(
      "The job is waiting now, so it cannot be retried.",
    );
    expect(alert.textContent).toContain("JOB_STATE_CONFLICT");
    expect(alert.textContent).toContain("state=waiting");
  });
});

describe("promote", () => {
  it("is offered only for a delayed job, and POSTs with no body but the JSON content type", async () => {
    const { calls, invalidate } = await renderActions(jobFixture("delayed"), {
      [`POST ${jobApiPath()}/promote`]: { body: { promoted: true } },
    });
    await act(async () => clickAction("Promote"));
    await waitFor(() => expect(toastText().polite).toContain("Job promoted"));
    const call = callTo(calls, "POST", "/promote")!;
    expect(call.body).toBeUndefined();
    expect(call.headers["content-type"]).toBe("application/json");
    expectInvalidated(invalidate);
  });

  it("toasts a 409 in plain words", async () => {
    await renderActions(jobFixture("delayed"), {
      [`POST ${jobApiPath()}/promote`]: {
        status: 409,
        body: problem(409, "JOB_STATE_CONFLICT", "Job state conflict", {
          context: { state: "active" },
        }),
      },
    });
    await act(async () => clickAction("Promote"));
    await waitFor(() =>
      expect(toastText().assertive).toContain(
        "The job is active now, so it cannot be promoted.",
      ),
    );
    expect(toastText().assertive).toContain("Could not promote the job");
  });
});

describe("remove", () => {
  it("confirms, DELETEs and goes back to the queue", async () => {
    const { calls, invalidate } = await renderActions(jobFixture("completed"), {
      [`DELETE ${jobApiPath()}`]: { status: 204 },
    });
    clickAction("Remove");
    const dialog = await page().findByRole("alertdialog", {
      name: "Remove this job?",
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    });
    await waitFor(() =>
      expect(window.location.pathname).toBe("/jobs/queues/emails"),
    );
    const call = callTo(calls, "DELETE")!;
    expect(call.body).toBeUndefined();
    await waitFor(() => expect(toastText().polite).toContain("Job removed"));
    expectInvalidated(invalidate);
    // The removed job is not read again.
    const reads = calls.filter(
      (c) => c.method === "GET" && c.path === jobApiPath(),
    );
    expect(reads).toHaveLength(1);
  });

  it("explains a 409 JOB_ACTIVE: it's running", async () => {
    await renderActions(jobFixture("active"), {
      [`DELETE ${jobApiPath()}`]: {
        status: 409,
        body: problem(409, "JOB_ACTIVE", "Job is active", {
          context: { state: "active" },
        }),
      },
    });
    clickAction("Remove");
    const dialog = await page().findByRole("alertdialog", {
      name: "Remove this job?",
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    });
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("It's running");
    expect(window.location.pathname).not.toBe("/jobs/queues/emails");
  });
});

/** Opens the fail dialog, fills the reason, types the confirmation and confirms. */
async function failWith(reason: string, typed = AWKWARD_ID) {
  clickAction("Fail…");
  const dialog = await page().findByRole("alertdialog", {
    name: "Fail this job?",
  });
  fireEvent.change(within(dialog).getByLabelText(/Reason/), {
    target: { value: reason },
  });
  fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
    target: { value: typed },
  });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Fail job" }));
  });
  return dialog;
}

describe("fail", () => {
  it("needs a reason and the typed id, then POSTs the reason, toasts and invalidates", async () => {
    const { calls, invalidate } = await renderActions(jobFixture("waiting"), {
      [`POST ${jobApiPath()}/fail`]: { body: { failed: true } },
    });
    clickAction("Fail…");
    const dialog = await page().findByRole("alertdialog", {
      name: "Fail this job?",
    });
    const confirm = within(dialog).getByRole("button", { name: "Fail job" });
    const reason = within(dialog).getByLabelText(/Reason/) as HTMLInputElement;
    expect(reason.required).toBe(true);
    expect(within(dialog).getByText(/At most 4,096 characters/)).toBeTruthy();
    // No running-code note for a job that is not active.
    expect(within(dialog).queryByTestId("fail-active-note")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
      target: { value: AWKWARD_ID },
    });
    // The id alone is not enough: a reason is required.
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    // Whitespace alone is refused in place: the API requires a \S.
    for (const blank of ["   ", " \t "]) {
      fireEvent.change(reason, { target: { value: blank } });
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      expect(dialog.textContent).toContain(
        "Spaces alone are not a reason: type some text.",
      );
    }
    fireEvent.change(reason, { target: { value: "  customer cancelled " } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    expect(dialog.textContent).not.toContain("Spaces alone");
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(page().queryByRole("alertdialog")).toBeNull());
    const call = callTo(calls, "POST", "/fail")!;
    expect(call.path).toBe(`/queues/emails/jobs/${AWKWARD_ID_ENCODED}/fail`);
    // Sent as typed: the API records the reason exactly as sent.
    expect(JSON.parse(call.body!)).toEqual({ reason: "  customer cancelled " });
    await waitFor(() => expect(toastText().polite).toContain("Job failed"));
    expectInvalidated(invalidate);
  });

  it("keeps confirm disabled while the typed id is wrong", async () => {
    await renderActions(jobFixture("delayed"));
    clickAction("Fail…");
    const dialog = await page().findByRole("alertdialog", {
      name: "Fail this job?",
    });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "no" },
    });
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
      target: { value: "welcome/42" },
    });
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Fail job",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("counts leading and trailing spaces toward the 4096 characters, as the API does", async () => {
    const { calls } = await renderActions(jobFixture("waiting"), {
      [`POST ${jobApiPath()}/fail`]: { body: { failed: true } },
    });
    clickAction("Fail…");
    const dialog = await page().findByRole("alertdialog", {
      name: "Fail this job?",
    });
    const confirm = within(dialog).getByRole("button", {
      name: "Fail job",
    }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
      target: { value: AWKWARD_ID },
    });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: ` ${"x".repeat(4095)} ` },
    });
    expect(confirm.disabled).toBe(true);
    expect(dialog.textContent).toContain("At most 4,096 characters.");
    const exact = ` ${"x".repeat(4094)} `;
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: exact },
    });
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(callTo(calls, "POST", "/fail")).toBeTruthy());
    expect(JSON.parse(callTo(calls, "POST", "/fail")!.body!)).toEqual({
      reason: exact,
    });
  });

  it("refuses a reason over 4096 characters in place", async () => {
    await renderActions(jobFixture("waiting"));
    clickAction("Fail…");
    const dialog = await page().findByRole("alertdialog", {
      name: "Fail this job?",
    });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "x".repeat(4097) },
    });
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
      target: { value: AWKWARD_ID },
    });
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Fail job",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(dialog.textContent).toContain("At most 4,096 characters.");
  });

  it("warns that failing an active job does not stop its code", async () => {
    await renderActions(jobFixture("active"));
    clickAction("Fail…");
    const dialog = await page().findByRole("alertdialog", {
      name: "Fail this job?",
    });
    expect(
      within(dialog).getByTestId("fail-active-note").textContent,
    ).toContain("does not stop its code");
  });

  it("explains a 409 JOB_STATE_CONFLICT with the job's state, and stays open", async () => {
    await renderActions(jobFixture("waiting"), {
      [`POST ${jobApiPath()}/fail`]: {
        status: 409,
        body: problem(409, "JOB_STATE_CONFLICT", "Job state conflict", {
          context: { state: "completed" },
        }),
      },
    });
    const dialog = await failWith("stop");
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(
      "The job is completed now, so it cannot be failed. Only a job that has not completed or died can be failed.",
    );
  });

  it("explains a 409 for an active job whose lock changed", async () => {
    await renderActions(jobFixture("active"), {
      [`POST ${jobApiPath()}/fail`]: {
        status: 409,
        body: problem(409, "JOB_STATE_CONFLICT", "Job state conflict", {
          context: { state: "active" },
        }),
      },
    });
    const dialog = await failWith("stop");
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(
      "A worker claimed the job again while it was being failed",
    );
  });

  it("explains a 404 JOB_NOT_FOUND", async () => {
    await renderActions(jobFixture("waiting"), {
      [`POST ${jobApiPath()}/fail`]: {
        status: 404,
        body: problem(404, "JOB_NOT_FOUND", "Job not found"),
      },
    });
    const dialog = await failWith("stop");
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("The job no longer exists");
  });

  it("asks for a long id's last characters instead of the whole id", async () => {
    const id = `order/${"x".repeat(60)}-tail1234`;
    expect(failConfirmation(id)).toEqual({ text: "tail1234", whole: false });
    expect(failConfirmation(AWKWARD_ID)).toEqual({
      text: AWKWARD_ID,
      whole: true,
    });
    // Code points, not UTF-16 units: a surrogate pair is never split.
    expect(failConfirmation(`${"a".repeat(41)}🙂bcdefgh`).text).toBe(
      "🙂bcdefgh",
    );
    const path = jobApiPath(id);
    const { calls } = await renderActions(
      jobFixture("waiting", { id }),
      {
        [`GET ${path}`]: { body: jobFixture("waiting", { id }) },
        [`GET ${path}/logs`]: { body: logPage(0, 100, "asc", 0) },
        [`POST ${path}/fail`]: { body: { failed: true } },
      },
      { id },
    );
    clickAction("Fail…");
    const dialog = await page().findByRole("alertdialog", {
      name: "Fail this job?",
    });
    expect(dialog.textContent).toContain(
      "Type the id's last 8 characters, tail1234, to confirm",
    );
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "stop" },
    });
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
      target: { value: "tail1234" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Fail job" }));
    });
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === "POST" && call.path === `${path}/fail`,
        ),
      ).toBe(true),
    );
  });
});

describe("gating", () => {
  /** The action buttons offered for a failed job with `actions` overridden. */
  async function offered(
    overrides: Partial<Record<JobsApiAction, boolean>>,
    options: {
      readOnly?: boolean;
      update?: boolean;
      state?: JobDto["state"];
    } = {},
  ) {
    await renderActions(
      jobFixture(options.state ?? "failed"),
      {},
      {
        permissions: allPermissions(overrides),
        meta: jobMeta({
          readOnly: options.readOnly ?? false,
          features: { ...jobMeta().features, update: options.update ?? true },
        }),
      },
    );
    const group = actions();
    return group
      ? within(group)
          .getAllByRole("button")
          .map((button) => button.textContent)
      : [];
  }

  it("offers every allowed action", async () => {
    expect(await offered({})).toEqual(["Retry", "Edit", "Fail…", "Remove"]);
  });

  it("drops retry without jobs.retry", async () => {
    expect(await offered({ "jobs.retry": false })).toEqual([
      "Edit",
      "Fail…",
      "Remove",
    ]);
  });

  it("drops promote without jobs.promote", async () => {
    expect(
      await offered({ "jobs.promote": false }, { state: "delayed" }),
    ).toEqual(["Edit", "Fail…", "Remove"]);
  });

  it("drops remove without jobs.remove", async () => {
    expect(await offered({ "jobs.remove": false })).toEqual([
      "Retry",
      "Edit",
      "Fail…",
    ]);
  });

  it("drops edit without jobs.update, or without features.update", async () => {
    expect(await offered({ "jobs.update": false })).toEqual([
      "Retry",
      "Fail…",
      "Remove",
    ]);
  });

  it("drops edit without features.update", async () => {
    expect(await offered({}, { update: false })).toEqual([
      "Retry",
      "Fail…",
      "Remove",
    ]);
  });

  it("drops fail without jobs.fail", async () => {
    expect(await offered({ "jobs.fail": false })).toEqual([
      "Retry",
      "Edit",
      "Remove",
    ]);
  });

  it("offers fail in every state but completed and dead", async () => {
    for (const state of JOB_STATES) {
      const names = await offered({}, { state });
      expect({ state, fail: names.includes("Fail…") }).toEqual({
        state,
        fail: state !== "completed" && state !== "dead",
      });
      cleanup();
    }
  });

  it("offers nothing when the API is read-only", async () => {
    expect(await offered({}, { readOnly: true })).toEqual([]);
  });
});
