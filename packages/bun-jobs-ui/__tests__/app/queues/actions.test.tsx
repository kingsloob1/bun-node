import type { RecordedCall } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { fireEvent, page, setupDom, waitFor, within } from "../dom";
import { metaFixture, permissionsFixture, problem } from "../fixtures";
import {
  detailFixture,
  errorToasts,
  findDialog,
  notifications,
  openDialog,
  renderQueue,
} from "./fixtures";

setupDom();

/** The queue screen once its header and actions loaded. */
async function loaded() {
  await page().findByTestId("queue-screen");
  await page().findByTestId("queue-total");
  return page().findByRole("group", { name: "Queue actions" });
}

/** The one call to a path. */
function callTo(calls: RecordedCall[], method: string, path: string) {
  return calls.find((call) => call.method === method && call.path === path);
}

/** Types the queue name into the open dialog's typed confirmation. */
function typeConfirmation(dialog: HTMLElement, text: string) {
  fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
    target: { value: text },
  });
}

/** The dialog's confirm button (the footer's last). */
function confirmButton(dialog: HTMLElement, name: string): HTMLButtonElement {
  return within(dialog).getByRole("button", { name }) as HTMLButtonElement;
}

describe("the queue header", () => {
  it("shows the name, the total from the counts, and when it updated", async () => {
    renderQueue();
    await loaded();
    const screen = page().getByTestId("queue-screen");
    expect(within(screen).getByRole("heading", { level: 1 }).textContent).toBe(
      "emails",
    );
    expect(page().getByTestId("queue-total").textContent).toBe("17 jobs");
    expect(screen.textContent).toContain("Updated");
    expect(screen.querySelector("time")).toBeTruthy();
  });

  it("shows the paused badge and Resume on a paused queue", async () => {
    renderQueue({
      handlers: {
        "GET /queues/emails": { body: detailFixture({ paused: true }) },
      },
    });
    const actions = await loaded();
    await within(actions).findByRole("button", { name: "Resume" });
    expect(within(actions).queryByRole("button", { name: "Pause" })).toBeNull();
    expect(
      page().getByTestId("queue-screen").querySelector(".badge")?.textContent,
    ).toBe("Paused");
  });

  it("explains an unknown queue", async () => {
    renderQueue({
      handlers: {
        "GET /queues/emails": {
          status: 404,
          body: problem(404, "QUEUE_NOT_FOUND", "Queue not found", {
            context: { queue: "emails" },
          }),
        },
      },
    });
    expect(
      await page().findByText("Could not load the queue emails"),
    ).toBeTruthy();
  });
});

describe("pause and resume", () => {
  it("pauses with a bodiless POST carrying Content-Type, toasts and refetches", async () => {
    const { calls } = renderQueue({
      handlers: { "POST /queues/emails/pause": { body: { paused: true } } },
    });
    const actions = await loaded();
    fireEvent.click(
      await within(actions).findByRole("button", { name: "Pause" }),
    );
    await waitFor(() =>
      expect(notifications().textContent).toContain("Paused emails"),
    );
    const call = callTo(calls, "POST", "/queues/emails/pause")!;
    expect(call.body).toBeUndefined();
    expect(call.headers["content-type"]).toBe("application/json");
    // Invalidation refetches the queue's detail.
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.path === "/queues/emails")
          .length,
      ).toBeGreaterThan(1),
    );
  });

  it("resumes", async () => {
    const { calls } = renderQueue({
      handlers: {
        "GET /queues/emails": { body: detailFixture({ paused: true }) },
        "POST /queues/emails/resume": { body: { paused: false } },
      },
    });
    const actions = await loaded();
    fireEvent.click(
      await within(actions).findByRole("button", { name: "Resume" }),
    );
    await waitFor(() =>
      expect(callTo(calls, "POST", "/queues/emails/resume")).toBeTruthy(),
    );
  });

  it("toasts a failure", async () => {
    renderQueue({
      handlers: {
        "POST /queues/emails/pause": {
          status: 503,
          body: problem(503, "DRIVER_ERROR", "Driver error", {
            detail: "Redis is down",
          }),
        },
      },
    });
    const actions = await loaded();
    fireEvent.click(
      await within(actions).findByRole("button", { name: "Pause" }),
    );
    await waitFor(() =>
      expect(errorToasts().textContent).toContain("Could not pause emails"),
    );
    expect(errorToasts().textContent).toContain("Redis is down");
  });
});

describe("drain", () => {
  it("needs the queue name typed, sends delayed, and toasts the count", async () => {
    const { calls } = renderQueue({
      handlers: { "POST /queues/emails/drain": { body: { count: 4 } } },
    });
    const actions = await loaded();
    fireEvent.click(within(actions).getByRole("button", { name: "Drain…" }));
    const dialog = await findDialog();
    const confirm = confirmButton(dialog, "Drain");
    expect(confirm.disabled).toBe(true);
    typeConfirmation(dialog, "email");
    expect(confirm.disabled).toBe(true);
    typeConfirmation(dialog, "emails");
    expect(confirm.disabled).toBe(false);
    fireEvent.click(within(dialog).getByLabelText("Also remove delayed jobs"));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Drained 4 jobs from emails",
      ),
    );
    const call = callTo(calls, "POST", "/queues/emails/drain")!;
    expect(JSON.parse(call.body!)).toEqual({ delayed: true });
    expect(call.headers["content-type"]).toBe("application/json");
    await waitFor(() => expect(openDialog()).toBeNull());
  });

  it("shows a failure inside the dialog and stays open", async () => {
    renderQueue({
      handlers: {
        "POST /queues/emails/drain": {
          status: 404,
          body: problem(404, "QUEUE_NOT_FOUND", "Queue not found", {
            detail: "No queue emails",
          }),
        },
      },
    });
    const actions = await loaded();
    fireEvent.click(within(actions).getByRole("button", { name: "Drain…" }));
    const dialog = await findDialog();
    typeConfirmation(dialog, "emails");
    fireEvent.click(confirmButton(dialog, "Drain"));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(dialog.textContent).toContain("No queue emails");
    expect(openDialog()).toBeTruthy();
    expect(errorToasts().textContent).toBe("");
  });

  it("returns focus to the Drain button when cancelled", async () => {
    renderQueue();
    const actions = await loaded();
    const drain = within(actions).getByRole("button", { name: "Drain…" });
    drain.focus();
    fireEvent.click(drain);
    const dialog = await findDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(openDialog()).toBeNull());
    expect(document.activeElement === drain).toBe(true);
  });
});

describe("clean", () => {
  it("sends state, olderThan in ms and limit, and toasts count and ids", async () => {
    const { calls } = renderQueue({
      handlers: {
        "POST /queues/emails/clean": { body: { count: 2, ids: ["c1", "c2"] } },
      },
    });
    const actions = await loaded();
    fireEvent.click(within(actions).getByRole("button", { name: "Clean…" }));
    const dialog = await findDialog();
    fireEvent.change(within(dialog).getByLabelText("State"), {
      target: { value: "failed" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Older than/), {
      target: { value: "2" },
    });
    fireEvent.change(within(dialog).getByLabelText("Unit"), {
      target: { value: "hours" },
    });
    fireEvent.change(within(dialog).getByLabelText("Limit"), {
      target: { value: "50" },
    });
    typeConfirmation(dialog, "emails");
    fireEvent.click(confirmButton(dialog, "Clean"));
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Cleaned 2 jobs from emails",
      ),
    );
    expect(notifications().textContent).toContain("c1, c2");
    expect(
      JSON.parse(callTo(calls, "POST", "/queues/emails/clean")!.body!),
    ).toEqual({
      state: "failed",
      olderThan: 7_200_000,
      limit: 50,
    });
  });

  it("defaults the limit to min(1000, maxClean) and refuses more than maxClean", async () => {
    renderQueue({
      handlers: {
        "GET /meta": {
          body: metaFixture({
            limits: { ...metaFixture().limits, maxClean: 300 },
          }),
        },
      },
    });
    const actions = await loaded();
    fireEvent.click(within(actions).getByRole("button", { name: "Clean…" }));
    const dialog = await findDialog();
    const limit = within(dialog).getByLabelText("Limit") as HTMLInputElement;
    expect(limit.value).toBe("300");
    fireEvent.change(limit, { target: { value: "301" } });
    typeConfirmation(dialog, "emails");
    expect(confirmButton(dialog, "Clean").disabled).toBe(true);
    expect(dialog.textContent).toContain("Between 1 and 300.");
  });
});

describe("retry-all", () => {
  it("sends the body, shows a pending state, and toasts count and truncation", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = renderQueue({
      handlers: {
        "POST /queues/emails/jobs/retry-all": async () => {
          await gate;
          return { body: { count: 1500, ids: ["r1", "r2"], truncated: true } };
        },
      },
    });
    const actions = await loaded();
    fireEvent.click(
      within(actions).getByRole("button", { name: "Retry all…" }),
    );
    const dialog = await findDialog();
    fireEvent.change(within(dialog).getByLabelText("State"), {
      target: { value: "dead" },
    });
    fireEvent.change(within(dialog).getByLabelText("Job name"), {
      target: { value: "send" },
    });
    fireEvent.change(within(dialog).getByLabelText("Failure reason contains"), {
      target: { value: "SMTP" },
    });
    fireEvent.change(within(dialog).getByLabelText("Limit"), {
      target: { value: "2000" },
    });
    fireEvent.click(within(dialog).getByLabelText("Reset attempts"));
    typeConfirmation(dialog, "emails");
    fireEvent.click(confirmButton(dialog, "Retry all"));
    expect(
      await within(dialog).findByText("Retrying… this can take a while"),
    ).toBeTruthy();
    release();
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Retried 1,500 jobs in emails",
      ),
    );
    expect(notifications().textContent).toContain("truncated");
    expect(
      JSON.parse(callTo(calls, "POST", "/queues/emails/jobs/retry-all")!.body!),
    ).toEqual({
      state: "dead",
      name: "send",
      reason: "SMTP",
      limit: 2000,
      resetAttempts: false,
    });
  });

  it("omits empty name/reason and defaults the limit to maxRetryAll", async () => {
    const { calls } = renderQueue({
      handlers: {
        "POST /queues/emails/jobs/retry-all": {
          body: { count: 0, ids: [], truncated: false },
        },
      },
    });
    const actions = await loaded();
    fireEvent.click(
      within(actions).getByRole("button", { name: "Retry all…" }),
    );
    const dialog = await findDialog();
    typeConfirmation(dialog, "emails");
    fireEvent.click(confirmButton(dialog, "Retry all"));
    await waitFor(() =>
      expect(
        callTo(calls, "POST", "/queues/emails/jobs/retry-all"),
      ).toBeTruthy(),
    );
    expect(
      JSON.parse(callTo(calls, "POST", "/queues/emails/jobs/retry-all")!.body!),
    ).toEqual({
      state: "failed",
      limit: metaFixture().limits.maxRetryAll,
      resetAttempts: true,
    });
  });

  it("explains a 409 OPERATION_IN_PROGRESS", async () => {
    renderQueue({
      handlers: {
        "POST /queues/emails/jobs/retry-all": {
          status: 409,
          body: problem(409, "OPERATION_IN_PROGRESS", "Operation in progress", {
            detail: "retry-all is running",
          }),
        },
      },
    });
    const actions = await loaded();
    fireEvent.click(
      within(actions).getByRole("button", { name: "Retry all…" }),
    );
    const dialog = await findDialog();
    typeConfirmation(dialog, "emails");
    fireEvent.click(confirmButton(dialog, "Retry all"));
    const note = await within(dialog).findByTestId("retry-all-in-progress");
    expect(note.textContent).toContain("already running");
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "OPERATION_IN_PROGRESS",
    );
  });
});

describe("permissions", () => {
  const cases = [
    ["queues.pause", "Pause"],
    ["queues.drain", "Drain…"],
    ["queues.clean", "Clean…"],
    ["jobs.retryAll", "Retry all…"],
  ] as const;
  for (const [action, label] of cases) {
    it(`hides ${label} without ${action}`, async () => {
      renderQueue({
        handlers: {
          "GET /meta/permissions": {
            body: permissionsFixture({ [action]: false }),
          },
        },
      });
      const actions = await loaded();
      expect(within(actions).queryByRole("button", { name: label })).toBeNull();
      expect(within(actions).getAllByRole("button").length).toBeGreaterThan(0);
    });
  }

  it("hides Resume without queues.resume", async () => {
    renderQueue({
      handlers: {
        "GET /queues/emails": { body: detailFixture({ paused: true }) },
        "GET /meta/permissions": {
          body: permissionsFixture({ "queues.resume": false }),
        },
      },
    });
    const actions = await loaded();
    expect(
      within(actions).queryByRole("button", { name: "Resume" }),
    ).toBeNull();
  });

  it("offers no mutation at all when the API is read-only", async () => {
    renderQueue({
      handlers: {
        "GET /meta": {
          body: metaFixture({ readOnly: true, addableNames: null }),
        },
      },
    });
    await page().findByTestId("queue-total");
    await page().findByRole("table", { name: "Jobs in emails" });
    expect(page().queryByRole("group", { name: "Queue actions" })).toBeNull();
    expect(page().queryByRole("group", { name: "Bulk actions" })).toBeNull();
    expect(page().queryByRole("button", { name: "Add job" })).toBeNull();
    expect(page().queryByRole("checkbox", { name: /Select/ })).toBeNull();
    // The limits panel is a summary, not an editor; repeatables have no remove.
    expect(page().queryByRole("button", { name: "Save limits" })).toBeNull();
    fireEvent.click(page().getByRole("tab", { name: "Repeatables" }));
    await page().findByTestId("repeatable-row-digest:cron");
    expect(
      page().queryByRole("button", { name: /Remove repeatable/ }),
    ).toBeNull();
  });
});

describe("the Add job button", () => {
  it("is absent by default (jobs.add is opt-in)", async () => {
    renderQueue();
    await loaded();
    expect(page().queryByRole("button", { name: "Add job" })).toBeNull();
  });

  it("is present with jobs.add and some addable name, or any name (null)", async () => {
    for (const addableNames of [["send"], null]) {
      const { unmount } = renderQueue({
        handlers: {
          "GET /meta": { body: metaFixture({ addableNames }) },
          "GET /meta/permissions": {
            body: permissionsFixture({ "jobs.add": true }),
          },
        },
      });
      await loaded();
      const button = page().getByRole("button", { name: "Add job" });
      fireEvent.click(button);
      unmount();
    }
  });

  it("is absent with jobs.add but no addable name", async () => {
    renderQueue({
      handlers: {
        "GET /meta": { body: metaFixture({ addableNames: [] }) },
        "GET /meta/permissions": {
          body: permissionsFixture({ "jobs.add": true }),
        },
      },
    });
    await loaded();
    expect(page().queryByRole("button", { name: "Add job" })).toBeNull();
  });
});
