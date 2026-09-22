import type { MetaDto } from "../../../app/api/types";
import type { RecordedCall } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { fireEvent, page, setupDom, visit, waitFor, within } from "../dom";
import { metaFixture, permissionsFixture } from "../fixtures";
import { renderApp } from "../renderApp";
import { workerFixture } from "../workers/fixtures";
import { jobFixture, jobPageFixture, renderQueue } from "./fixtures";

setupDom();

/**
 * Job lists sorted by creation time, newest first, where the backend can
 * (`features.addedByState`): `sort=createdAt` beside the existing `order`.
 * The runtime does not serve it yet and the shared meta has the flag off, so
 * these tests turn it on themselves; with it off, no `sort` may be sent, since
 * an API without the feature answers `sort=createdAt` with 400.
 */

/** `/meta` with `features.addedByState` (and, for the worker page, attribution) as given. */
function meta(addedByState: boolean, jobAttribution = false): MetaDto {
  const base = metaFixture();
  return metaFixture({
    features: { ...base.features, addedByState, jobAttribution },
  });
}

/** Every `GET /queues/emails/jobs` among `calls`. */
function jobReads(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (call) => call.method === "GET" && call.path === "/queues/emails/jobs",
  );
}

describe("the queue's jobs table", () => {
  it("sends no sort without the flag, on any tab, counted or not", async () => {
    const { calls } = renderQueue({
      path: "/queues/emails?state=completed",
      handlers: { "GET /meta": { body: meta(false) } },
    });
    await page().findByRole("table", { name: "Jobs in emails" });
    fireEvent.click(page().getByLabelText("Count total"));
    await waitFor(() =>
      expect(jobReads(calls).at(-1)!.query.get("total")).toBe("true"),
    );
    expect(jobReads(calls).length).toBeGreaterThan(1);
    expect(jobReads(calls).some((call) => call.query.has("sort"))).toBe(false);
    // Nothing about creation order is said where it is not offered.
    expect(page().queryByText(/creation order/)).toBeNull();
  });

  it("sorts by creation time, newest first, on a one-state tab with the flag", async () => {
    const { calls } = renderQueue({
      path: "/queues/emails?state=completed",
      handlers: { "GET /meta": { body: meta(true) } },
    });
    await page().findByRole("table", { name: "Jobs in emails" });
    const read = jobReads(calls).at(-1)!;
    expect(read.query.get("state")).toBe("completed");
    expect(read.query.get("sort")).toBe("createdAt");
    expect(read.query.get("order")).toBe("desc");
    // The choice is not a user's, so it stays out of the URL.
    expect(window.location.search).not.toContain("sort");
  });

  it("keeps the natural order for a counted page, and says so", async () => {
    const { calls } = renderQueue({
      path: "/queues/emails?state=dead",
      handlers: { "GET /meta": { body: meta(true) } },
    });
    await page().findByRole("table", { name: "Jobs in emails" });
    expect(jobReads(calls).at(-1)!.query.get("sort")).toBe("createdAt");
    fireEvent.click(page().getByLabelText("Count total"));
    await waitFor(() =>
      expect(jobReads(calls).at(-1)!.query.get("total")).toBe("true"),
    );
    expect(jobReads(calls).at(-1)!.query.has("sort")).toBe(false);
    expect(
      (await page().findByText(/keeps its own order, not creation order/))
        .textContent,
    ).toContain("While counting");
  });
});

describe("the worker page's jobs section", () => {
  /** Opens the worker page with attribution on and `addedByState` as given. */
  function open(addedByState: boolean) {
    visit("/jobs/workers/emails/api.emails?jobState=delayed");
    return renderApp({
      handlers: {
        "GET /meta": { body: meta(addedByState, true) },
        "GET /meta/permissions": { body: permissionsFixture() },
        "GET /workers": { body: { items: [workerFixture()], offline: [] } },
        "GET /queues/emails/analytics/workers/api.emails": { status: 404 },
        "GET /queues/emails/jobs": {
          body: jobPageFixture({
            items: [
              jobFixture({
                id: "job-1",
                state: "delayed",
                failedReason: null,
                processedBy: { id: "api.emails.a1", key: "api.emails" },
              }),
            ],
          }),
        },
      },
    });
  }

  it("sends no sort without the flag", async () => {
    const { calls } = open(false);
    const card = await page().findByTestId("worker-jobs");
    await within(card).findByTestId("job-row-job-1");
    expect(jobReads(calls).length).toBeGreaterThan(0);
    expect(jobReads(calls).some((call) => call.query.has("sort"))).toBe(false);
  });

  it("sorts by creation time with the flag", async () => {
    const { calls } = open(true);
    const card = await page().findByTestId("worker-jobs");
    await within(card).findByTestId("job-row-job-1");
    const read = jobReads(calls).at(-1)!;
    expect(read.query.get("state")).toBe("delayed");
    expect(read.query.get("sort")).toBe("createdAt");
    expect(read.query.get("order")).toBe("desc");
    expect(read.query.getAll("workerKey")).toEqual(["api.emails"]);
  });
});
