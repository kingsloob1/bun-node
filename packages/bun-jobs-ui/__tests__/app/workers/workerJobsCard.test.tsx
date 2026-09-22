import type { JobDto, JobPageDto, MetaDto } from "../../../app/api/types";
import type { MockHandler, MockReply, RecordedCall } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { fireEvent, page, setupDom, visit, waitFor, within } from "../dom";
import { metaFixture, permissionsFixture } from "../fixtures";
import { jobFixture } from "../queues/fixtures";
import { renderApp } from "../renderApp";
import { workerFixture } from "./fixtures";

setupDom();

/**
 * The worker page's jobs section, against mocked HTTP: the runtime still
 * refuses the attribution filters, so every test here that reads jobs turns
 * `features.jobAttribution` on for itself.
 */

/** A day, in ms: the section's default range. */
const DAY = 86_400_000;

/** The query parameters only an attribution-aware API accepts. */
const ATTRIBUTION_PARAMS = [
  "workerKey",
  "workerId",
  "finishedFrom",
  "finishedTo",
] as const;

/** `/meta` with job attribution on or off. */
function meta(jobAttribution: boolean): MetaDto {
  const base = metaFixture();
  return metaFixture({ features: { ...base.features, jobAttribution } });
}

/** One page of jobs. */
function jobPage(items: JobDto[], hasMore = false): JobPageDto {
  return { items, page: { offset: 0, limit: 20, hasMore } };
}

/** Two completed jobs the key ran. */
const JOBS: JobDto[] = [
  jobFixture({
    id: "job-1",
    state: "completed",
    failedReason: null,
    processedBy: { id: "api.emails.a1", key: "api.emails" },
  }),
  jobFixture({
    id: "job-2",
    state: "completed",
    failedReason: null,
    processedBy: { id: "api.emails.a1", key: "api.emails" },
  }),
];

/** Options of {@link open}. */
interface OpenOptions {
  /** `features.jobAttribution`. Defaults to `true`. */
  attribution?: boolean;
  /** What `GET /queues/emails/jobs` answers. */
  jobs?: MockHandler | MockReply;
  /** Permissions over the fixture's, for both maps. */
  grant?: Parameters<typeof permissionsFixture>[0];
  /** The path under the app, query included. */
  path?: string;
}

/** Opens a worker page with its jobs section. */
function open({
  attribution = true,
  jobs = { body: jobPage(JOBS) },
  grant = {},
  path = "/workers/emails/api.emails",
}: OpenOptions = {}) {
  visit(`/jobs${path}`);
  return renderApp({
    handlers: {
      "GET /meta": { body: meta(attribution) },
      "GET /meta/permissions": { body: permissionsFixture(grant) },
      "GET /workers": { body: { items: [workerFixture()], offline: [] } },
      "GET /queues/emails/analytics/workers/api.emails": { status: 404 },
      "GET /queues/emails/jobs": jobs,
    },
  });
}

/** The jobs reads among `calls`. */
function jobReads(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.path === "/queues/emails/jobs");
}

/** Whether any call carried an attribution parameter. */
function anyAttributionParam(calls: readonly RecordedCall[]): boolean {
  return calls.some((call) =>
    ATTRIBUTION_PARAMS.some((param) => call.query.has(param)),
  );
}

describe("the worker page's jobs section", () => {
  it("reads nothing and sends no attribution filter when the flag is false", async () => {
    const { calls } = open({
      attribution: false,
      // A link that asks for every filter the section has.
      path: "/workers/emails/api.emails?jobState=completed&finished=3600s&jobName=a&jobOffset=20",
    });
    const card = await page().findByTestId("worker-jobs");
    await within(card).findByTestId("worker-jobs-unrecorded");
    // Let the rest of the page settle, then look at every request it made.
    await page().findByTestId("worker-config");
    expect(jobReads(calls)).toHaveLength(0);
    expect(anyAttributionParam(calls)).toBe(false);
    expect(card.textContent).not.toContain("Could not load");
  });

  it("lists the key's jobs over the last 24 hours, newest first, with no total", async () => {
    const before = Date.now();
    const { calls } = open();
    const card = await page().findByTestId("worker-jobs");
    await within(card).findByTestId("job-row-job-1");
    const after = Date.now();
    const [read] = jobReads(calls);
    expect([...read!.query.keys()]).toEqual([
      "limit",
      "order",
      "workerKey",
      "finishedFrom",
    ]);
    expect(read!.query.get("order")).toBe("desc");
    expect(read!.query.getAll("workerKey")).toEqual(["api.emails"]);
    const from = Number(read!.query.get("finishedFrom"));
    expect(from).toBeGreaterThanOrEqual(before - DAY);
    expect(from).toBeLessThanOrEqual(after - DAY);
    expect(read!.query.has("total")).toBe(false);
    expect(read!.query.has("finishedTo")).toBe(false);

    // Honest about what is recorded, and rows lead to the job screen.
    expect(
      page().getByRole("heading", {
        name: "Jobs whose last attempt this key ran",
      }),
    ).toBeTruthy();
    expect(
      within(card).getByTestId("worker-jobs-last-attempt").textContent,
    ).toContain("last attempt");
    expect(
      within(card).getByRole("link", { name: "job-1" }).getAttribute("href"),
    ).toBe("/jobs/queues/emails/jobs/job-1");
    expect(within(card).getByTestId("worker-jobs-range").textContent).toContain(
      "Last 24 hours",
    );
    // No count is offered: the range is what keeps the read fast.
    expect(within(card).queryByLabelText("Count total")).toBeNull();
  });

  it("has no Processed by column: every row there is this key", async () => {
    open();
    const card = await page().findByTestId("worker-jobs");
    const row = await within(card).findByTestId("job-row-job-1");
    const table = row.closest("table")!;
    const headers = Array.from(table.querySelectorAll("thead th")).map(
      (th) => th.textContent ?? "",
    );
    expect(headers).toContain("Processed");
    expect(headers).not.toContain("Processed by");
    expect(table.querySelector(".job-processed-by-col")).toBeNull();
    expect(within(card).queryByTestId("jobs-processed-by-key")).toBeNull();
  });

  it("titles the Retrying tab: failed an attempt, waiting to retry", async () => {
    open();
    const card = await page().findByTestId("worker-jobs");
    await within(card).findByTestId("job-row-job-1");
    const tab = within(card).getByRole("tab", { name: "Retrying" });
    expect(tab.getAttribute("title")).toContain("waiting to retry");
    expect(within(card).queryByRole("tab", { name: "Failed" })).toBeNull();
  });

  it("drops the range for running jobs, and says why", async () => {
    const { calls } = open({
      path: "/workers/emails/api.emails?finished=3600s",
    });
    const card = await page().findByTestId("worker-jobs");
    await within(card).findByTestId("job-row-job-1");
    fireEvent.click(within(card).getByRole("tab", { name: /Active/ }));
    await waitFor(() =>
      expect(
        jobReads(calls).some((call) => call.query.get("state") === "active"),
      ).toBe(true),
    );
    const active = jobReads(calls).find(
      (call) => call.query.get("state") === "active",
    )!;
    expect(active.query.getAll("workerKey")).toEqual(["api.emails"]);
    expect(active.query.has("finishedFrom")).toBe(false);
    expect(active.query.has("finishedTo")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("jobState")).toBe(
      "active",
    );
    const note = await within(card).findByTestId("worker-jobs-no-range");
    expect(note.textContent).toContain("Active jobs have not finished");
    expect(within(card).queryByTestId("worker-jobs-range")).toBeNull();
  });

  it("sends a custom span from the link as both ends", async () => {
    const { calls } = open({
      path: "/workers/emails/api.emails?jobState=dead&finished=1000-2000",
    });
    await page().findByTestId("job-row-job-1");
    const [read] = jobReads(calls);
    expect(read!.query.get("state")).toBe("dead");
    expect(read!.query.get("finishedFrom")).toBe("1000");
    expect(read!.query.get("finishedTo")).toBe("2000");
  });

  it("pages with the pager, without a total", async () => {
    const { calls } = open({ jobs: { body: jobPage(JOBS, true) } });
    const card = await page().findByTestId("worker-jobs");
    await within(card).findByTestId("job-row-job-1");
    const pager = within(card).getByRole("navigation", {
      name: "Pages of this key's jobs",
    });
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(
        jobReads(calls).some((call) => call.query.get("offset") === "20"),
      ).toBe(true),
    );
    expect(new URLSearchParams(window.location.search).get("jobOffset")).toBe(
      "20",
    );
    expect(jobReads(calls).every((call) => !call.query.has("total"))).toBe(
      true,
    );
  });

  it("says retention decides what is listed when nothing matches", async () => {
    open({ jobs: { body: jobPage([]) } });
    const empty = await page().findByTestId("worker-jobs-empty");
    expect(empty.textContent).toContain("removed on completion");
  });

  it("refuses to filter to a key holding a comma rather than send a wrong filter", async () => {
    const { calls } = open({ path: "/workers/emails/a%2Cb" });
    await page().findByTestId("worker-jobs-unfilterable");
    await page().findByTestId("worker-config");
    expect(jobReads(calls)).toHaveLength(0);
  });

  it("is hidden without jobs.list, and reads nothing", async () => {
    const { calls } = open({ grant: { "jobs.list": false } });
    await page().findByTestId("worker-jobs-hidden");
    await page().findByTestId("worker-config");
    expect(jobReads(calls)).toHaveLength(0);
  });

  it("shows ids as text when the job screen is not routed", async () => {
    open({ grant: { "queues.list": false } });
    const row = await page().findByTestId("job-row-job-1");
    expect(within(row).queryByRole("link", { name: "job-1" })).toBeNull();
    expect(row.textContent).toContain("job-1");
  });
});
