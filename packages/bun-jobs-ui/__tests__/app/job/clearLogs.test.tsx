import type { JobDto, LogPageDto } from "../../../app/api/types";
import type { MockHandler, MockReply, RecordedCall } from "../mockFetch";
import { describe, expect, it, spyOn } from "bun:test";
import { jobKeys } from "../../../app/api/jobs";
import {
  CLEAR_LOGS_ACTIVE_REASON,
  CLEAR_LOGS_EMPTY_REASON,
  clearLogsBlocker,
} from "../../../app/screens/job/clearLogs";
import { act, fireEvent, page, setupDom, waitFor, within } from "../dom";
import { problem } from "../fixtures";
import {
  allPermissions,
  AWKWARD_ID,
  jobApiPath,
  jobFixture,
  jobMeta,
  logPage,
} from "./fixtures";
import { renderJobScreen, toastText } from "./render";

setupDom();

/** The logs path of the fixture job. */
const LOGS = `${jobApiPath()}/logs`;

/** A logs handler over `total()` lines, re-read on every call. */
function logsOf(total: () => number): MockHandler {
  return (call: RecordedCall) => {
    const offset = Number(call.query.get("offset"));
    const limit = Number(call.query.get("limit"));
    const order = call.query.get("order") === "desc" ? "desc" : "asc";
    return {
      body: logPage(offset, limit, order, total()) satisfies LogPageDto,
    };
  };
}

/** Renders a job's screen with a log of `lines` lines, and a spy on invalidation. */
async function renderLogs(
  job: JobDto,
  options: {
    /** Lines in the log. */
    lines?: number;
    /** More handlers. */
    handlers?: Record<string, MockHandler | MockReply>;
    /** Permission overrides. */
    actions?: Parameters<typeof allPermissions>[0];
    /** Whether the API is read-only. */
    readOnly?: boolean;
  } = {},
) {
  const lines = options.lines ?? 250;
  const result = await renderJobScreen(job, {
    permissions: allPermissions(options.actions),
    meta: jobMeta({ readOnly: options.readOnly ?? false }),
    handlers: {
      [`GET ${LOGS}`]: logsOf(() => lines),
      ...options.handlers,
    },
  });
  const invalidate = spyOn(result.queryClient, "invalidateQueries");
  await page().findByText(/in all$/);
  return { ...result, invalidate };
}

/** The "Clear logs…" button, or `null`. */
function clearButton(): HTMLButtonElement | null {
  return page().queryByRole("button", {
    name: "Clear logs…",
  }) as HTMLButtonElement | null;
}

/** Opens the confirmation and returns it. */
async function openConfirm(): Promise<HTMLElement> {
  fireEvent.click(clearButton()!);
  return page().findByRole("alertdialog");
}

/** Confirms the open dialog. */
async function confirm(dialog: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear logs" }));
  });
}

describe("clear logs: gating", () => {
  it("is offered on a finished job with jobs.clearLogs", async () => {
    await renderLogs(jobFixture("completed"));
    expect(clearButton()!.disabled).toBe(false);
    expect(page().queryByTestId("clear-logs-reason")).toBeNull();
  });

  it("is absent without jobs.clearLogs", async () => {
    await renderLogs(jobFixture("completed"), {
      actions: { "jobs.clearLogs": false },
    });
    expect(clearButton()).toBeNull();
  });

  it("is absent while the route is not registered (the action missing from the map)", async () => {
    await renderLogs(jobFixture("completed"), {
      actions: { "jobs.clearLogs": undefined },
    });
    expect(clearButton()).toBeNull();
  });

  it("is absent on a read-only API, whatever the permissions say", async () => {
    await renderLogs(jobFixture("completed"), { readOnly: true });
    expect(clearButton()).toBeNull();
  });

  it("is disabled on an active job, with the reason shown and wired to it", async () => {
    await renderLogs(jobFixture("active"));
    const button = clearButton()!;
    expect(button.disabled).toBe(true);
    const reason = page().getByTestId("clear-logs-reason");
    expect(reason.textContent).toBe(
      "Clear logs once the job finishes — a running job is still writing to them.",
    );
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("is disabled on an empty log, saying there is nothing to clear", async () => {
    await renderLogs(jobFixture("completed"), { lines: 0 });
    expect(clearButton()!.disabled).toBe(true);
    expect(page().getByTestId("clear-logs-reason").textContent).toBe(
      "No lines to clear.",
    );
  });

  it("is offered on every state but active", async () => {
    for (const state of ["waiting", "delayed", "failed", "dead"] as const) {
      expect(clearLogsBlocker(state, 3)).toBeNull();
    }
    expect(clearLogsBlocker("active", 3)).toBe(CLEAR_LOGS_ACTIVE_REASON);
    // Active wins over empty: the reason that will still hold after lines arrive.
    expect(clearLogsBlocker("active", 0)).toBe(CLEAR_LOGS_ACTIVE_REASON);
    expect(clearLogsBlocker("completed", 0)).toBe(CLEAR_LOGS_EMPTY_REASON);
  });
});

describe("clear logs: the request", () => {
  it("confirms with the line count and the job id", async () => {
    await renderLogs(jobFixture("completed"));
    const dialog = await openConfirm();
    expect(dialog.textContent).toContain(
      "Clear the 250 log lines of this job?",
    );
    expect(within(dialog).getByText(AWKWARD_ID).tagName).toBe("CODE");
    expect(dialog.textContent).toContain("This cannot be undone.");
  });

  it("sends a bodiless DELETE to the job's logs, toasts the count and re-reads the logs", async () => {
    let lines = 250;
    const { calls, invalidate } = await renderLogs(jobFixture("completed"), {
      handlers: {
        [`GET ${LOGS}`]: logsOf(() => lines),
        [`DELETE ${LOGS}`]: () => {
          lines = 0;
          return { body: { removed: 250 } };
        },
      },
    });
    const reads = () =>
      calls.filter((call) => call.method === "GET" && call.path === LOGS)
        .length;
    const before = reads();
    const dialog = await openConfirm();
    await confirm(dialog);
    await waitFor(() =>
      expect(toastText().polite).toContain("Cleared 250 lines"),
    );
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.path).toBe(LOGS);
    expect(deletes[0]!.body).toBeUndefined();
    const keys = invalidate.mock.calls.map(
      (args) => (args[0] as { queryKey: unknown }).queryKey,
    );
    expect(keys).toContainEqual(jobKeys.logsAll("emails", AWKWARD_ID));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await page().findByText("No log lines yet.");
    expect(clearButton()!.disabled).toBe(true);
  });

  it("goes back to the first page after clearing", async () => {
    let lines = 250;
    const { calls } = await renderLogs(jobFixture("completed"), {
      handlers: {
        [`GET ${LOGS}`]: logsOf(() => lines),
        [`DELETE ${LOGS}`]: () => {
          lines = 0;
          return { body: { removed: 250 } };
        },
      },
    });
    const pager = page().getByRole("navigation", { name: "Log pages" });
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.path === LOGS && call.query.get("offset") === "100",
        ),
      ).toBe(true),
    );
    await confirm(await openConfirm());
    await page().findByText("No log lines yet.");
    const last = calls
      .filter((call) => call.method === "GET" && call.path === LOGS)
      .at(-1)!;
    expect(last.query.get("offset")).toBe("0");
  });

  it("says one line in the singular", async () => {
    await renderLogs(jobFixture("completed"), {
      lines: 1,
      handlers: { [`DELETE ${LOGS}`]: { body: { removed: 1 } } },
    });
    const dialog = await openConfirm();
    expect(dialog.textContent).toContain("Clear the 1 log line of this job?");
    await confirm(dialog);
    await waitFor(() => expect(toastText().polite).toContain("Cleared 1 line"));
  });

  it("explains a 409 JOB_ACTIVE (the job became active meanwhile), and re-reads the job", async () => {
    const { calls } = await renderLogs(jobFixture("completed"), {
      handlers: {
        [`DELETE ${LOGS}`]: {
          status: 409,
          body: problem(409, "JOB_ACTIVE", "Job is active", {
            context: { state: "active" },
          }),
        },
      },
    });
    const jobReads = () =>
      calls.filter(
        (call) => call.method === "GET" && call.path === jobApiPath(),
      ).length;
    const before = jobReads();
    const dialog = await openConfirm();
    await confirm(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(
      "a worker picked this job up and is still writing its log",
    );
    expect(alert.textContent).toContain("Clear it once the job finishes");
    await waitFor(() => expect(jobReads()).toBeGreaterThan(before));
  });

  it("explains a 404 JOB_NOT_FOUND", async () => {
    await renderLogs(jobFixture("completed"), {
      handlers: {
        [`DELETE ${LOGS}`]: {
          status: 404,
          body: problem(404, "JOB_NOT_FOUND", "Job not found"),
        },
      },
    });
    const dialog = await openConfirm();
    await confirm(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("The job no longer exists");
  });
});
