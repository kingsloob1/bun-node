import type { JobState } from "../../../app/api/types";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { JOB_STATES } from "../../../app/api/contract";
import { act, fireEvent, page, setupDom, waitFor, within } from "../dom";
import { problem } from "../fixtures";
import {
  allPermissions,
  AWKWARD_ID,
  AWKWARD_ID_ENCODED,
  failureFixture,
  jobApiPath,
  jobFixture,
  jobMeta,
  logPage,
} from "./fixtures";
import { renderJobScreen, settle } from "./render";

// Ahead of setupDom()'s hooks, which need real timers to settle.
afterEach(() => {
  jest.useRealTimers();
});

setupDom();

/** The loaded screen's heading text. */
async function heading() {
  const title = await page().findByRole("heading", { level: 1 });
  return title.textContent ?? "";
}

/** A summary row's value, by its label. */
function summaryValue(label: string): string {
  const summary = document.querySelector(".job-summary")!;
  const row = Array.from(summary.querySelectorAll(".kv-row")).find(
    (candidate) => candidate.querySelector("dt")?.textContent === label,
  );
  return row?.querySelector("dd")?.textContent ?? "";
}

/** Handlers answering the logs and children routes of the fixture job. */
function sideHandlers() {
  return {
    [`GET ${jobApiPath()}/logs`]: { body: logPage(0, 100, "asc", 2) },
  };
}

describe("the job screen", () => {
  for (const state of JOB_STATES) {
    it(`renders a ${state} job`, async () => {
      const job = jobFixture(state);
      await renderJobScreen(job, { handlers: sideHandlers() });
      const title = await heading();
      expect(title).toContain("send-welcome");
      const badge = page()
        .getByRole("heading", { level: 1 })
        .querySelector(".state-badge");
      expect(badge?.className).toContain(`state-${state}`);
      expect(page().getByTestId("job-id").textContent).toBe(AWKWARD_ID);
      expect(page().getByRole("button", { name: "Copy job id" })).toBeTruthy();

      // Summary.
      expect(summaryValue("Priority")).toBe("5");
      expect(summaryValue("Attempts")).toBe(
        `${job.attemptsMade} of ${job.maxAttempts}`,
      );
      expect(summaryValue("Stalled")).toBe("0");
      expect(summaryValue("Worker")).toBe(job.workerId ?? "—");

      // Data and options are always shown; the return value only when there is one.
      const data = page().getByRole("region", { name: "Data" });
      expect(data.textContent).toContain("ada@example.com");
      expect(
        page().getByRole("region", { name: "Options" }).textContent,
      ).toContain("keepStacktraces");
      const returned = page().queryByRole("region", { name: "Return value" });
      expect(Boolean(returned)).toBe(state === "completed");
      if (returned) {
        expect(returned.textContent).toContain("messageId");
      }

      // The failure, with its cause chain, for failed and dead jobs.
      const failure = page().queryByRole("region", { name: "Failure" });
      expect(Boolean(failure)).toBe(state === "failed" || state === "dead");
      if (failure) {
        const text = failure.textContent ?? "";
        expect(text).toContain("SmtpError: connection refused");
        expect(text).toContain("code ECONNREFUSED");
        expect(text).toContain("Caused by");
        expect(text).toContain("SocketError: socket hang up");
        expect(text).toContain("ETIMEDOUT");
      }

      // Actions follow the state.
      const actions = page().getByRole("group", { name: "Job actions" });
      const finished =
        state === "completed" || state === "failed" || state === "dead";
      expect(
        Boolean(within(actions).queryByRole("button", { name: "Retry" })),
      ).toBe(finished);
      expect(
        Boolean(within(actions).queryByRole("button", { name: "Promote" })),
      ).toBe(state === "delayed");
      expect(
        within(actions).getByRole("button", { name: "Remove" }),
      ).toBeTruthy();
      expect(
        within(actions).getByRole("button", { name: "Edit" }),
      ).toBeTruthy();

      // Logs follow only while the job can still log.
      await page().findByRole("list", { name: "Log lines" });
      expect(Boolean(page().queryByTestId("logs-follow"))).toBe(
        state === "active" || state === "waiting",
      );
    });
  }

  it("shows a breadcrumb back to the queue", async () => {
    await renderJobScreen(jobFixture("waiting"), { handlers: sideHandlers() });
    const crumbs = page().getByRole("navigation", { name: "Breadcrumb" });
    const link = within(crumbs).getByRole("link", { name: "emails" });
    expect(link.getAttribute("href")).toBe("/jobs/queues/emails");
    expect(
      within(crumbs).getByRole("link", { name: "Queues" }).getAttribute("href"),
    ).toBe("/jobs/queues");
  });

  it("shows object progress as JSON", async () => {
    await renderJobScreen(
      jobFixture("active", { progress: { step: 3, of: 7 } }),
      {
        handlers: sideHandlers(),
      },
    );
    await heading();
    expect(
      page().getByRole("list", { name: "Progress" }).textContent,
    ).toContain("step");
  });

  it("shows scalar progress as text", async () => {
    await renderJobScreen(jobFixture("active", { progress: 42 }), {
      handlers: sideHandlers(),
    });
    await heading();
    expect(summaryValue("Progress")).toBe("42");
  });

  it("shows a friendly not-found panel linking back to the queue on 404 JOB_NOT_FOUND", async () => {
    await renderJobScreen({
      status: 404,
      body: problem(404, "JOB_NOT_FOUND", "Job not found", {
        detail: `No job "${AWKWARD_ID}" in queue "emails"`,
        context: { queue: "emails", id: AWKWARD_ID },
      }),
    });
    const panel = await page().findByTestId("job-not-found");
    expect(panel.textContent).toContain("Job not found");
    expect(panel.textContent).toContain(AWKWARD_ID);
    const back = within(panel).getByRole("link", { name: "Back to emails" });
    expect(back.getAttribute("href")).toBe("/jobs/queues/emails");
  });

  it("shows other failures with a retry", async () => {
    await renderJobScreen({
      status: 503,
      body: problem(503, "DRIVER_ERROR", "Driver error", { detail: "down" }),
    });
    await waitFor(() => {
      expect(page().getByText("Could not load the job")).toBeTruthy();
    });
    expect(page().getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("percent-encodes an id with a slash and a space in every request path", async () => {
    const job = jobFixture("failed", {
      flow: {
        parent: null,
        children: [{ queue: "images", id: "resize-1" }],
        pending: 0,
        values: {},
        failures: {},
        recorded: true,
      },
    });
    const { calls } = await renderJobScreen(job, {
      handlers: {
        ...sideHandlers(),
        [`GET ${jobApiPath()}/children`]: {
          body: { parent: null, pending: 0, children: [], truncated: false },
        },
        [`POST ${jobApiPath()}/retry`]: { body: { retried: true } },
      },
    });
    await page().findByRole("list", { name: "Log lines" });
    await page()
      .findByRole("table", { name: "Children" })
      .catch(() => null);
    // Open the lazy section and retry, so every kind of request is made.
    const details = page().getByTestId("job-stacktraces") as HTMLDetailsElement;
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });
    fireEvent.click(page().getByRole("button", { name: "Retry" }));
    const dialog = await page().findByRole("dialog", {
      name: "Retry this job?",
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => {
      expect(calls.some((call) => call.path.endsWith("/retry"))).toBe(true);
    });
    const jobCalls = calls.filter((call) => call.path.includes("/jobs/"));
    const kinds = new Set(
      jobCalls.map(
        (call) =>
          `${call.method} ${call.path.slice(jobApiPath().length) || "/"}`,
      ),
    );
    expect(kinds).toEqual(
      new Set(["GET /", "GET /logs", "GET /children", "POST /retry"]),
    );
    for (const call of jobCalls) {
      expect(
        call.path.startsWith(`/queues/emails/jobs/${AWKWARD_ID_ENCODED}`),
      ).toBe(true);
      expect(call.url).not.toContain("welcome/42");
      expect(call.url).not.toContain(" ");
    }
  });

  it("fetches the failure history only when its section opens, newest first", async () => {
    const { calls } = await renderJobScreen(jobFixture("failed"), {
      handlers: {
        ...sideHandlers(),
        [`GET ${jobApiPath()}`]: (call) => ({
          body:
            call.query.get("include") === "stacktrace"
              ? jobFixture("failed", {
                  stacktrace: [
                    { name: "SmtpError", message: "third try" },
                    { name: "SmtpError", message: "second try" },
                    { name: "SmtpError", message: "first try" },
                  ],
                })
              : jobFixture("failed"),
        }),
      },
    });
    await heading();
    const include = () =>
      calls
        .filter((call) => call.path === jobApiPath())
        .map((call) => call.query.getAll("include").join(","));
    expect(include()).toEqual(["data,returnValue,opts"]);

    const details = page().getByTestId("job-stacktraces") as HTMLDetailsElement;
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });
    const newest = await within(details).findByRole("group", {
      name: "Newest failure",
    });
    expect(newest.textContent).toContain("third try");
    expect(include()).toEqual(["data,returnValue,opts", "stacktrace"]);
    const order = Array.from(
      details.querySelectorAll(".job-error-message"),
    ).map((element) => element.textContent);
    expect(order).toEqual(["third try", "second try", "first try"]);
    expect(failureFixture.cause?.name).toBe("SocketError");
  });

  it("has no logs section without features.logs or without jobs.logs", async () => {
    await renderJobScreen(jobFixture("active"), {
      meta: jobMeta({ features: { ...jobMeta().features, logs: false } }),
    });
    await heading();
    expect(page().queryByRole("region", { name: "Logs" })).toBeNull();
  });

  it("polls an unfinished job every 5 s, and stops once it has finished", async () => {
    jest.useFakeTimers();
    let state: JobState = "active";
    const { calls } = await renderJobScreenWithFakeTimers(() =>
      jobFixture(state),
    );
    const reads = () =>
      calls.filter((call) => call.path === jobApiPath()).length;
    expect(reads()).toBe(1);
    await advance(5_000);
    expect(reads()).toBe(2);
    state = "completed";
    await advance(5_000);
    expect(reads()).toBe(3);
    expect(page().getByRole("heading", { level: 1 }).textContent).toContain(
      "Completed",
    );
    await advance(15_000);
    expect(reads()).toBe(3);
  });
});

/** `/meta/permissions` without `jobs.read` at all, as when its route is pruned. */
function withoutJobsRead() {
  const permissions = allPermissions();
  delete permissions.actions["jobs.read"];
  return permissions;
}

/** A 401/403 problem on `GET` of the job, as a per-job `authorize` answers it. */
function denied(status: 401 | 403, detail: string) {
  return {
    status,
    body: problem(
      status,
      status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
      status === 401 ? "Unauthorized" : "Forbidden",
      { detail, context: { queue: "emails", id: AWKWARD_ID } },
    ),
  };
}

describe("the job screen's access gate", () => {
  it("hides the job, and never requests it, without jobs.read", async () => {
    const { calls } = await renderJobScreen(jobFixture("active"), {
      permissions: withoutJobsRead(),
      handlers: sideHandlers(),
      wait: false,
    });
    const panel = await page().findByTestId("job-hidden");
    expect(panel.textContent).toContain("Job hidden");
    expect(panel.textContent).toContain("may not read the jobs of queue");
    expect(
      within(panel)
        .getByRole("link", { name: "Back to emails" })
        .getAttribute("href"),
    ).toBe("/jobs/queues/emails");
    // The scoped answer has arrived too, and it still made no job request.
    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.path === "/meta/permissions" &&
            call.query.get("queue") === "emails",
        ),
      ).toBe(true);
    });
    await settle(50);
    expect(calls.filter((call) => call.path.includes("/jobs/"))).toEqual([]);
    expect(page().queryByTestId("job-screen")).toBeNull();
  });

  it("switches to the hidden panel, and stops polling, when the queue's scoped permissions deny jobs.read", async () => {
    jest.useFakeTimers();
    let answerScoped: (() => void) | undefined;
    const scopedArrived = new Promise<void>((resolve) => {
      answerScoped = resolve;
    });
    const { calls } = await renderJobScreen(jobFixture("active"), {
      handlers: {
        ...sideHandlers(),
        // Untargeted: granted. Scoped to `emails`: refused, answered on demand.
        "GET /meta/permissions": async (call) => {
          if (call.query.get("queue") !== "emails") {
            return { body: allPermissions() };
          }
          await scopedArrived;
          return { body: allPermissions({ "jobs.read": false }) };
        },
      },
      wait: false,
    });
    await advance(100, 10);
    // The untargeted grant applies while the scoped answer is pending.
    expect(page().getByTestId("job-screen")).toBeTruthy();
    const reads = () =>
      calls.filter((call) => call.path === jobApiPath()).length;
    await advance(5_000);
    expect(reads()).toBe(2);

    answerScoped?.();
    await advance(100, 10);
    expect(page().getByTestId("job-hidden").textContent).toContain(
      "Job hidden",
    );
    expect(page().queryByTestId("job-screen")).toBeNull();
    const after = reads();
    await advance(15_000);
    expect(reads()).toBe(after);
  });

  it("shows the hidden panel with the API's detail when GET job answers 403", async () => {
    const { calls } = await renderJobScreen(
      denied(403, "Not allowed to read jobs of this tenant"),
      { handlers: sideHandlers(), wait: false },
    );
    const panel = await page().findByTestId("job-hidden");
    expect(panel.textContent).toContain("Job hidden");
    expect(panel.textContent).toContain(
      "Not allowed to read jobs of this tenant",
    );
    expect(
      within(panel).getByRole("link", { name: "Back to emails" }),
    ).toBeTruthy();
    expect(page().queryByText("Could not load the job")).toBeNull();
    expect(page().queryByRole("button", { name: "Retry" })).toBeNull();
    // Not polled after the refusal.
    await settle(50);
    expect(calls.filter((call) => call.path === jobApiPath())).toHaveLength(1);
  });

  it("treats a 401 on GET job the same way", async () => {
    await renderJobScreen(denied(401, "Sign in again"), {
      handlers: sideHandlers(),
      wait: false,
    });
    const panel = await page().findByTestId("job-hidden");
    expect(panel.textContent).toContain("Sign in again");
  });

  it("keeps the not-found panel, not the hidden one, for a 404", async () => {
    await renderJobScreen({
      status: 404,
      body: problem(404, "JOB_NOT_FOUND", "Job not found", {
        detail: `No job "${AWKWARD_ID}" in queue "emails"`,
      }),
    });
    expect(await page().findByTestId("job-not-found")).toBeTruthy();
    expect(page().queryByTestId("job-hidden")).toBeNull();
  });
});

/** Advances fake time in steps, letting fetches and React settle between them. */
export async function advance(ms: number, step = 250): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await act(async () => {
      jest.advanceTimersByTime(Math.min(step, ms - elapsed));
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });
  }
  // Let responses resolve and TanStack's batched notifications land.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      for (let j = 0; j < 10; j++) {
        await Promise.resolve();
      }
      jest.advanceTimersByTime(10);
    });
  }
}

/** Renders the screen while fake timers run, advancing until the job has loaded. */
async function renderJobScreenWithFakeTimers(
  job: () => ReturnType<typeof jobFixture>,
) {
  const result = await renderJobScreen(
    (): { body: unknown } => ({ body: job() }),
    { handlers: sideHandlers(), wait: false },
  );
  await advance(100, 10);
  expect(page().getByTestId("job-screen")).toBeTruthy();
  return result;
}
