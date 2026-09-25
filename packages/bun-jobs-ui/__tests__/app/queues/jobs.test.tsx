import type { RecordedCall } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { fireEvent, page, setupDom, waitFor, within } from "../dom";
import { metaFixture, permissionsFixture, problem } from "../fixtures";
import {
  countsFixture,
  findDialog,
  jobFixture,
  jobPageFixture,
  notifications,
  openDialog,
  renderQueue,
} from "./fixtures";

setupDom();

/** Every `GET /queues/emails/jobs` sent. */
function jobCalls(calls: RecordedCall[]) {
  return calls.filter(
    (call) => call.method === "GET" && call.path === "/queues/emails/jobs",
  );
}

/** The last one. */
function lastJobs(calls: RecordedCall[]) {
  return jobCalls(calls).at(-1)!;
}

/** The jobs table once loaded. */
async function jobsTable() {
  return page().findByRole("table", { name: "Jobs in emails" });
}

/** A handler echoing the requested paging. */
function pagedJobs(total?: number) {
  return (call: RecordedCall) => {
    const offset = Number(call.query.get("offset") ?? 0);
    const limit = Number(call.query.get("limit") ?? 20);
    const counted = call.query.get("total") === "true";
    const size = total === undefined ? limit : Math.min(limit, total - offset);
    const ids = Array.from(
      { length: size },
      (_, index) => `j-${offset + index}`,
    );
    return {
      body: {
        items: ids.map((id) => jobFixture({ id })),
        page: {
          offset,
          limit,
          ...(counted && total !== undefined ? { total } : {}),
          hasMore: total === undefined ? true : offset + size < total,
        },
      },
    };
  };
}

describe("the jobs table", () => {
  it("shows a job whose name is not text as (invalid), instead of crashing", async () => {
    renderQueue({
      handlers: {
        "GET /queues/emails/jobs": {
          body: jobPageFixture({
            items: [jobFixture({ name: { first: "x" } as never })],
          }),
        },
      },
    });
    const row = within(await jobsTable()).getByTestId("job-row-job-1");
    expect(row.textContent).toContain("(invalid)");
    expect(page().queryByTestId("screen-error")).toBeNull();
  });

  it("shows the queue's error state when its detail answers the wrong shape", async () => {
    renderQueue({ handlers: { "GET /queues/emails": { body: [] } } });
    expect(
      await page().findByRole("heading", {
        level: 1,
        name: "Could not load the queue emails",
      }),
    ).toBeTruthy();
    expect(page().getByRole("alert").textContent).toContain(
      "UNEXPECTED_RESPONSE",
    );
  });

  it("renders the columns, with percent-encoded job links and a copy button", async () => {
    const { calls } = renderQueue();
    const table = await jobsTable();
    const row = within(table).getByTestId("job-row-job-1");
    expect(row.textContent).toContain("send");
    expect(row.textContent).toContain("3/3");
    expect(row.textContent).toContain("SMTP refused the connection");
    expect(
      within(row).getByRole("button", { name: "Copy job id job-1" }),
    ).toBeTruthy();
    expect(
      within(table).getByRole("link", { name: "a/b c" }).getAttribute("href"),
    ).toBe("/jobs/queues/emails/jobs/a%2Fb%20c");
    const request = lastJobs(calls);
    expect(request.query.get("limit")).toBe("20");
    expect(request.query.has("include")).toBe(false);
    expect(request.query.has("state")).toBe(false);
    expect(request.query.has("total")).toBe(false);
  });

  it("truncates a long failure message and keeps the whole one as its title", async () => {
    const message = "x".repeat(300);
    renderQueue({
      handlers: {
        "GET /queues/emails/jobs": {
          body: jobPageFixture({
            items: [jobFixture({ failedReason: { name: "Error", message } })],
          }),
        },
      },
    });
    const table = await jobsTable();
    const cell = table.querySelector<HTMLElement>(".job-failure")!;
    expect(cell.textContent!.length).toBe(80);
    expect(cell.getAttribute("title")).toBe(message);
  });

  it("shows state tabs with counts from /counts", async () => {
    renderQueue();
    await jobsTable();
    const tabs = page().getByRole("tablist", { name: "Job states" });
    await waitFor(() =>
      expect(
        within(tabs).getByRole("tab", { name: /Retrying/ }).textContent,
      ).toContain("2"),
    );
    // The `failed` state reads "Retrying", with a tooltip for anyone looking
    // for failed jobs: which it is, and where the ones that gave up went.
    const retrying = within(tabs).getByRole("tab", { name: /Retrying/ });
    expect(retrying.getAttribute("title")).toContain(
      "Failed an attempt, waiting to retry",
    );
    expect(retrying.getAttribute("title")).toContain("Dead");
    expect(within(tabs).queryByRole("tab", { name: /Failed/ })).toBeNull();
    // Only the state that needs one carries a tooltip.
    expect(
      within(tabs).getByRole("tab", { name: /Dead/ }).hasAttribute("title"),
    ).toBe(false);
    expect(
      within(tabs).getByRole("tab", { name: /All/ }).textContent,
    ).toContain("17");
    expect(
      within(tabs)
        .getByRole("tab", { name: /All/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("a tab changes the request's state and resets the offset", async () => {
    const { calls } = renderQueue({
      path: "/queues/emails?offset=40",
      handlers: { "GET /queues/emails/jobs": pagedJobs() },
    });
    await jobsTable();
    expect(lastJobs(calls).query.get("offset")).toBe("40");
    // The label is "Retrying"; the value sent and kept in the URL is still `failed`.
    fireEvent.click(page().getByRole("tab", { name: /Retrying/ }));
    await waitFor(() =>
      expect(lastJobs(calls).query.getAll("state")).toEqual(["failed"]),
    );
    expect(lastJobs(calls).query.get("offset")).toBeNull();
    const url = new URLSearchParams(window.location.search);
    expect(url.get("state")).toBe("failed");
    expect(url.has("offset")).toBe(false);
  });

  it("pages without a total: the range has no total and Next follows hasMore", async () => {
    const { calls } = renderQueue({
      handlers: { "GET /queues/emails/jobs": pagedJobs() },
    });
    await jobsTable();
    const pager = page().getByRole("navigation", { name: "Job pages" });
    expect(within(pager).getByText("1–20")).toBeTruthy();
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastJobs(calls).query.get("offset")).toBe("20"));
    expect(await within(pager).findByText("21–40")).toBeTruthy();
    expect(lastJobs(calls).query.has("total")).toBe(false);
  });

  it("pages with the total toggle: total=true is sent and the range counts", async () => {
    const { calls } = renderQueue({
      handlers: { "GET /queues/emails/jobs": pagedJobs(45) },
    });
    await jobsTable();
    fireEvent.click(page().getByLabelText("Count total"));
    await waitFor(() =>
      expect(lastJobs(calls).query.get("total")).toBe("true"),
    );
    const pager = page().getByRole("navigation", { name: "Job pages" });
    expect(await within(pager).findByText("1–20 of 45")).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("total")).toBe("1");
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    expect(await within(pager).findByText("21–40 of 45")).toBeTruthy();
    // Paging is disabled while the next page replaces the previous one.
    await page().findByLabelText("Select job j-20");
    await waitFor(() =>
      expect(
        (
          within(pager).getByRole("button", {
            name: "Next",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    expect(await within(pager).findByText("41–45 of 45")).toBeTruthy();
    expect(
      (within(pager).getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("the page size is capped at maxPageSize and defaults to defaultPageSize", async () => {
    const limits = {
      ...metaFixture().limits,
      defaultPageSize: 7,
      maxPageSize: 30,
    };
    const { calls } = renderQueue({
      path: "/queues/emails?limit=500",
      handlers: {
        "GET /meta": { body: metaFixture({ limits }) },
        "GET /queues/emails/jobs": pagedJobs(),
      },
    });
    await jobsTable();
    expect(lastJobs(calls).query.get("limit")).toBe("30");
  });

  it("serialises the name filter to repeated keys, plus search and order, and resets the offset", async () => {
    const { calls } = renderQueue({
      path: "/queues/emails?offset=20",
      handlers: { "GET /queues/emails/jobs": pagedJobs() },
    });
    await jobsTable();
    fireEvent.change(page().getByLabelText("Names"), {
      target: { value: "send, digest,,send" },
    });
    fireEvent.change(page().getByLabelText("Search"), {
      target: { value: "job-4" },
    });
    fireEvent.click(page().getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(lastJobs(calls).query.getAll("name")).toEqual(["send", "digest"]),
    );
    const request = lastJobs(calls);
    expect(request.url).toContain("name=send&name=digest");
    expect(request.query.get("search")).toBe("job-4");
    expect(request.query.get("offset")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("name")).toBe(
      "send,digest",
    );

    fireEvent.change(page().getByLabelText("Order"), {
      target: { value: "desc" },
    });
    await waitFor(() =>
      expect(lastJobs(calls).query.get("order")).toBe("desc"),
    );
  });

  it("reads filters from the URL on load", async () => {
    const { calls } = renderQueue({
      path: "/queues/emails?state=dead&name=a,b&search=x&order=desc&total=1&offset=10&limit=10",
    });
    await jobsTable();
    const query = lastJobs(calls).query;
    expect(query.getAll("state")).toEqual(["dead"]);
    expect(query.getAll("name")).toEqual(["a", "b"]);
    expect(query.get("search")).toBe("x");
    expect(query.get("order")).toBe("desc");
    expect(query.get("total")).toBe("true");
    expect(query.get("offset")).toBe("10");
    expect(query.get("limit")).toBe("10");
    expect((page().getByLabelText("Names") as HTMLInputElement).value).toBe(
      "a, b",
    );
  });

  it("shows an empty state and a load error", async () => {
    renderQueue({
      handlers: {
        "GET /queues/emails/jobs": {
          body: { items: [], page: { offset: 0, limit: 20, hasMore: false } },
        },
      },
    });
    expect(await page().findByText("No jobs")).toBeTruthy();
  });

  it("shows a load error", async () => {
    renderQueue({
      handlers: {
        "GET /queues/emails/jobs": {
          status: 400,
          body: problem(400, "VALIDATION", "Invalid request"),
        },
      },
    });
    expect(await page().findByText("Could not load jobs")).toBeTruthy();
  });
});

describe("bulk actions", () => {
  it("select-all takes the page, capped at maxBulkIds, and disables the rest", async () => {
    renderQueue({
      handlers: {
        "GET /meta": {
          body: metaFixture({
            limits: { ...metaFixture().limits, maxBulkIds: 2 },
          }),
        },
      },
    });
    const table = await jobsTable();
    fireEvent.click(
      within(table).getByLabelText("Select all jobs on this page"),
    );
    expect(page().getByTestId("bulk-count").textContent).toContain(
      "2 jobs selected",
    );
    expect(page().getByTestId("bulk-count").textContent).toContain("2");
    const third = within(table).getByLabelText(
      "Select job a/b c",
    ) as HTMLInputElement;
    expect(third.checked).toBe(false);
    expect(third.disabled).toBe(true);
    fireEvent.click(within(table).getByLabelText("Select job job-1"));
    expect(third.disabled).toBe(false);
    expect(page().getByTestId("bulk-count").textContent).toContain(
      "1 job selected",
    );
  });

  it("retries the selection and toasts retried/skipped with the skipped ids", async () => {
    const { calls } = renderQueue({
      handlers: {
        "POST /queues/emails/jobs/retry": {
          body: { retried: ["job-1"], skipped: ["job-2"] },
        },
      },
    });
    const table = await jobsTable();
    fireEvent.click(within(table).getByLabelText("Select job job-1"));
    fireEvent.click(within(table).getByLabelText("Select job job-2"));
    fireEvent.click(page().getByLabelText("Reset attempts"));
    fireEvent.click(page().getByRole("button", { name: "Retry selected" }));
    await waitFor(() =>
      expect(notifications().textContent).toContain("Retried 1, skipped 1"),
    );
    expect(notifications().textContent).toContain("Skipped: job-2");
    const call = calls.find((c) => c.path === "/queues/emails/jobs/retry")!;
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.body!)).toEqual({
      ids: ["job-1", "job-2"],
      resetAttempts: false,
    });
    // The selection clears after a success.
    await waitFor(() =>
      expect(page().getByTestId("bulk-count").textContent).toContain(
        "0 jobs selected",
      ),
    );
  });

  it("promotes, and removes after a confirmation", async () => {
    const { calls } = renderQueue({
      handlers: {
        "POST /queues/emails/jobs/promote": {
          body: { promoted: ["a/b c"], skipped: [] },
        },
        "POST /queues/emails/jobs/remove": {
          body: { removed: ["job-1"], skipped: [] },
        },
      },
    });
    const table = await jobsTable();
    fireEvent.click(within(table).getByLabelText("Select job a/b c"));
    fireEvent.click(page().getByRole("button", { name: "Promote selected" }));
    await waitFor(() =>
      expect(notifications().textContent).toContain("Promoted 1, skipped 0"),
    );
    expect(
      JSON.parse(
        calls.find((c) => c.path === "/queues/emails/jobs/promote")!.body!,
      ),
    ).toEqual({ ids: ["a/b c"] });

    fireEvent.click(within(table).getByLabelText("Select job job-1"));
    const removeButton = page().getByRole("button", {
      name: "Remove selected…",
    });
    removeButton.focus();
    fireEvent.click(removeButton);
    const dialog = await findDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(notifications().textContent).toContain("Removed 1, skipped 0"),
    );
    expect(
      JSON.parse(
        calls.find((c) => c.path === "/queues/emails/jobs/remove")!.body!,
      ),
    ).toEqual({ ids: ["job-1"] });
    await waitFor(() => expect(openDialog()).toBeNull());
    // The emptied selection disabled the opener, so focus stays in the bulk
    // bar. Compared by identity: `toBe` on happy-dom nodes is very slow.
    const bar = page().getByRole("group", { name: "Bulk actions" });
    await waitFor(() => expect(document.activeElement === bar).toBe(true));
  });

  it("caps the ids listed in the toast", async () => {
    const skipped = Array.from({ length: 15 }, (_, index) => `s-${index}`);
    renderQueue({
      handlers: {
        "POST /queues/emails/jobs/retry": { body: { retried: [], skipped } },
      },
    });
    const table = await jobsTable();
    fireEvent.click(
      within(table).getByLabelText("Select all jobs on this page"),
    );
    fireEvent.click(page().getByRole("button", { name: "Retry selected" }));
    await waitFor(() =>
      expect(notifications().textContent).toContain("and 5 more"),
    );
    expect(notifications().textContent).not.toContain("s-10");
  });

  it("keeps the selection across pages and clears it on a filter change", async () => {
    renderQueue({ handlers: { "GET /queues/emails/jobs": pagedJobs() } });
    const table = await jobsTable();
    fireEvent.click(within(table).getByLabelText("Select job j-0"));
    fireEvent.click(page().getByRole("button", { name: "Next" }));
    await page().findByLabelText("Select job j-20");
    expect(page().getByTestId("bulk-count").textContent).toContain(
      "1 job selected",
    );
    fireEvent.click(page().getByRole("tab", { name: /Dead/ }));
    await waitFor(() =>
      expect(page().getByTestId("bulk-count").textContent).toContain(
        "0 jobs selected",
      ),
    );
  });

  it("offers no checkboxes or bulk bar without retry/remove/promote", async () => {
    renderQueue({
      handlers: {
        "GET /meta/permissions": {
          body: permissionsFixture({
            "jobs.retry": false,
            "jobs.remove": false,
            "jobs.promote": false,
          }),
        },
      },
    });
    const table = await jobsTable();
    expect(within(table).queryByRole("checkbox")).toBeNull();
    expect(page().queryByRole("group", { name: "Bulk actions" })).toBeNull();
  });

  it("offers only the permitted bulk actions", async () => {
    renderQueue({
      handlers: {
        "GET /meta/permissions": {
          body: permissionsFixture({ "jobs.remove": false }),
        },
      },
    });
    await jobsTable();
    expect(page().getByRole("button", { name: "Retry selected" })).toBeTruthy();
    expect(
      page().getByRole("button", { name: "Promote selected" }),
    ).toBeTruthy();
    expect(
      page().queryByRole("button", { name: "Remove selected…" }),
    ).toBeNull();
  });

  it("uses the counts fixture", () => {
    expect(countsFixture().failed).toBe(2);
  });
});

/**
 * A backend that pages by cursor: every page mints the cursor continuing the
 * walk, **including an offset page**, so a reader can jump to page N and then
 * walk on from it. A walked page reports no `page.offset` — the SQL and
 * MongoDB case, where counting the jobs before the key would cost what the
 * offset cost. `state=active` on its own mints none, as the API refuses to
 * walk a list whose order every lock renewal rewrites.
 */
function walkedJobs(total = 60) {
  const ids = (start: number, size: number) =>
    Array.from({ length: size }, (_unused, index) => `j-${start + index}`);
  return (call: RecordedCall) => {
    const cursor = call.query.get("cursor");
    const limit = Number(call.query.get("limit") ?? 20);
    const walkable = call.query.getAll("state").join() !== "active";
    if (cursor !== null && !walkable) {
      throw new Error("a cursor reached a walk the API refuses");
    }
    const start =
      cursor === null
        ? Number(call.query.get("offset") ?? 0)
        : Number(cursor.replace("after-", "")) + 1;
    const size = Math.max(0, Math.min(limit, total - start));
    const hasMore = start + size < total;
    return {
      body: {
        items: ids(start, size).map((id) => jobFixture({ id })),
        page: {
          // Only an offset page knows where it sits here.
          ...(cursor === null ? { offset: start } : {}),
          limit,
          hasMore,
          ...(walkable
            ? { next: hasMore && size > 0 ? `after-${start + size - 1}` : null }
            : {}),
        },
      },
    };
  };
}

/** The jobs pager. */
function jobPager() {
  return page().getByRole("navigation", { name: "Job pages" });
}

/**
 * Presses one of the pager's buttons and waits for `firstRow` to be the page
 * shown. Waiting on the rows rather than on a request is deliberate: walking
 * back re-asks for a page this screen has already read, which the query cache
 * answers without going to the API at all.
 */
async function turn(name: "Next" | "Previous", firstRow: string) {
  fireEvent.click(within(jobPager()).getByRole("button", { name }));
  await atFirstRow(firstRow);
}

/** The id of the table's first row, or `""` when it has none. */
function firstRowId(): string {
  const row = document.querySelector<HTMLElement>('[data-testid^="job-row-"]');
  return (row?.dataset.testid ?? "").replace("job-row-", "");
}

/** Waits until the table's first row is `id`, whatever is in flight. */
async function atFirstRow(id: string) {
  await waitFor(() => expect(firstRowId()).toBe(id));
}

/** The `cursor` of every jobs request sent, `null` where none was. */
function cursors(calls: RecordedCall[]): (string | null)[] {
  return jobCalls(calls).map((call) => call.query.get("cursor"));
}

describe("the jobs table, walking by cursor", () => {
  it("walks on with the page's cursor, and never with an offset beside it", async () => {
    const { calls } = renderQueue({
      handlers: { "GET /queues/emails/jobs": walkedJobs() },
    });
    await jobsTable();
    // The first page is an offset page: it carries no cursor and knows where
    // it sits, so it is numbered as it always was.
    expect(lastJobs(calls).query.has("cursor")).toBe(false);
    expect(within(jobPager()).getByText("1–20")).toBeTruthy();

    await turn("Next", "j-20");
    expect(lastJobs(calls).query.get("cursor")).toBe("after-19");
    // The offset would decide nothing, and the API ignores it: not sent.
    expect(lastJobs(calls).query.has("offset")).toBe(false);
    expect(await within(jobPager()).findByText("20 rows")).toBeTruthy();

    await turn("Next", "j-40");
    expect(lastJobs(calls).query.get("cursor")).toBe("after-39");

    // Back through the trail, page by page, to the offset page it began on —
    // which is the only page here that can say where it sits.
    await turn("Previous", "j-20");
    await turn("Previous", "j-0");
    expect(await within(jobPager()).findByText("1–20")).toBeTruthy();

    // Every cursor sent was one the API minted for this walk, and no request
    // ever carried a cursor and an offset at once.
    expect(cursors(calls)).toEqual([null, "after-19", "after-39"]);
    for (const call of jobCalls(calls)) {
      expect(call.query.has("cursor") && call.query.has("offset")).toBe(false);
    }
  });

  it("counts the rows of a walked page instead of numbering them, and offers no page number", async () => {
    renderQueue({
      handlers: { "GET /queues/emails/jobs": walkedJobs() },
    });
    await jobsTable();
    await turn("Next", "j-20");
    const pager = jobPager();
    // "21–40" would be a guess: nothing counted what precedes this page, and
    // jobs may have left the list since the walk started.
    expect(pager.textContent).not.toContain("21–40");
    expect(pager.textContent).toContain("20 rows");
    expect(pager.textContent).not.toContain("Page");
    // And the walk's honesty note is on the button that walks.
    expect(within(pager).getByRole("button", { name: "Next" }).title).toContain(
      "behind",
    );
  });

  it("jumps by offset and then walks on from where the jump landed", async () => {
    const { calls } = renderQueue({
      path: "/queues/emails?offset=40",
      handlers: { "GET /queues/emails/jobs": walkedJobs(200) },
    });
    await jobsTable();
    expect(lastJobs(calls).query.get("offset")).toBe("40");
    await page().findByTestId("job-row-j-40");
    await turn("Next", "j-60");
    // The jumped-to page minted a cursor of its own, so the walk continues
    // from where the jump landed rather than from the top of the list.
    expect(lastJobs(calls).query.get("cursor")).toBe("after-59");
    expect(lastJobs(calls).query.has("offset")).toBe(false);
  });

  it("drops the walk when a filter changes, so no stale cursor is sent", async () => {
    const { calls } = renderQueue({
      handlers: { "GET /queues/emails/jobs": walkedJobs() },
    });
    await jobsTable();
    await turn("Next", "j-20");
    expect(lastJobs(calls).query.get("cursor")).toBe("after-19");

    // A cursor belongs to one walk — the queue, the states, the sort and the
    // order — and the filters restart paging besides. Applying one must
    // therefore start again, not send a cursor minted for what came before.
    fireEvent.change(page().getByLabelText("Search"), {
      target: { value: "j-4" },
    });
    fireEvent.click(page().getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(lastJobs(calls).query.get("search")).toBe("j-4"),
    );
    expect(lastJobs(calls).query.has("cursor")).toBe(false);
    await atFirstRow("j-0");
    expect(within(jobPager()).getByText("1–20")).toBeTruthy();

    // So does the order, and so does the state tab.
    await turn("Next", "j-20");
    expect(lastJobs(calls).query.get("cursor")).toBe("after-19");
    fireEvent.change(page().getByLabelText("Order"), {
      target: { value: "asc" },
    });
    await waitFor(() => expect(lastJobs(calls).query.has("order")).toBe(false));
    expect(lastJobs(calls).query.has("cursor")).toBe(false);
    await atFirstRow("j-0");

    await turn("Next", "j-20");
    expect(lastJobs(calls).query.get("cursor")).toBe("after-19");
    fireEvent.click(page().getByRole("tab", { name: /Retrying/ }));
    await waitFor(() =>
      expect(lastJobs(calls).query.getAll("state")).toEqual(["failed"]),
    );
    expect(lastJobs(calls).query.has("cursor")).toBe(false);
  });

  it("drops the walk when Count total changes, since that changes the sort", async () => {
    const { calls } = renderQueue({
      handlers: {
        "GET /meta": {
          body: metaFixture({
            features: { ...metaFixture().features, addedByState: true },
          }),
        },
        "GET /queues/emails/jobs": walkedJobs(),
      },
    });
    await jobsTable();
    await turn("Next", "j-20");
    expect(lastJobs(calls).query.get("sort")).toBe("createdAt");
    expect(lastJobs(calls).query.get("cursor")).toBe("after-19");
    // Counting drops `sort=createdAt` for the tab's natural order, and a
    // cursor is bound to the sort it was minted under.
    fireEvent.click(page().getByLabelText("Count total"));
    await waitFor(() =>
      expect(lastJobs(calls).query.get("total")).toBe("true"),
    );
    expect(lastJobs(calls).query.has("sort")).toBe(false);
    expect(lastJobs(calls).query.has("cursor")).toBe(false);
  });

  it("keeps the walk's place when only the page size changes", async () => {
    const { calls } = renderQueue({
      handlers: { "GET /queues/emails/jobs": walkedJobs() },
    });
    await jobsTable();
    await turn("Next", "j-20");
    fireEvent.change(page().getByLabelText("Rows per page"), {
      target: { value: "50" },
    });
    await waitFor(() => expect(lastJobs(calls).query.get("limit")).toBe("50"));
    // The same cursor with a new size: the page still starts at the row it
    // started at, which is what the size control means everywhere else.
    expect(lastJobs(calls).query.get("cursor")).toBe("after-19");
    await page().findByTestId("job-row-j-20");
  });

  it("names promotion in the walk's hint on the tab a promoted job arrives on", async () => {
    const { calls } = renderQueue({
      path: "/queues/emails?state=waiting",
      handlers: { "GET /queues/emails/jobs": walkedJobs() },
    });
    await jobsTable();
    // Waiting is where the queue screen's own Promote selected puts a job,
    // and a job that joins the list behind the walk is the one thing the
    // cursor costs that the offset did not. So the button that walks says so.
    const waiting = within(jobPager()).getByRole("button", {
      name: "Next",
    }).title;
    expect(waiting).toContain("promoted");
    expect(waiting).toContain("behind this point");

    // Elsewhere the same fact is stated without naming a tab's own action.
    fireEvent.click(page().getByRole("tab", { name: /Completed/ }));
    await waitFor(() =>
      expect(lastJobs(calls).query.getAll("state")).toEqual(["completed"]),
    );
    await waitFor(() =>
      expect(
        within(jobPager()).getByRole("button", { name: "Next" }).title,
      ).not.toContain("promoted"),
    );
  });

  it("leaves the Active tab on the offset pager, since its cursor is refused", async () => {
    const { calls } = renderQueue({
      path: "/queues/emails?state=active",
      handlers: { "GET /queues/emails/jobs": walkedJobs() },
    });
    await jobsTable();
    expect(lastJobs(calls).query.getAll("state")).toEqual(["active"]);
    // The API mints no cursor for it, so the pager has nothing to walk with
    // and moves the offset — as it always did on every tab.
    await turn("Next", "j-20");
    expect(lastJobs(calls).query.has("cursor")).toBe(false);
    expect(lastJobs(calls).query.get("offset")).toBe("20");
    expect(await within(jobPager()).findByText("21–40")).toBeTruthy();
    expect(within(jobPager()).getByRole("button", { name: "Next" }).title).toBe(
      "",
    );
  });
});
