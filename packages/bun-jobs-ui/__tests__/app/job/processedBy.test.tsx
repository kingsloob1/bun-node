import type { MetaDto } from "../../../app/api/types";
import { describe, expect, it } from "bun:test";
import { page, setupDom, within } from "../dom";
import {
  allPermissions,
  jobApiPath,
  jobFixture,
  jobMeta,
  logPage,
} from "./fixtures";
import { renderJobScreen } from "./render";

setupDom();

/**
 * The job screen's "Processed by" line, against mocked HTTP with
 * `features.jobAttribution` turned on here (the shared meta has it off, as
 * every backend does until the runtime lands).
 */

/** `/meta` with job attribution on or off. */
function meta(jobAttribution: boolean): MetaDto {
  const base = jobMeta();
  return jobMeta({ features: { ...base.features, jobAttribution } });
}

/** Handlers answering the logs route of the fixture job. */
const handlers = {
  [`GET ${jobApiPath()}/logs`]: { body: logPage(0, 100, "asc", 2) },
};

/** The "Processed by" row's value and hint, or `null` when the row is absent. */
async function processedByRow(): Promise<HTMLElement | null> {
  await page().findByTestId("job-id");
  const summary = document.querySelector(".job-summary")!;
  const row = Array.from(summary.querySelectorAll<HTMLElement>(".kv-row")).find(
    (candidate) =>
      candidate.querySelector("dt")?.textContent === "Processed by",
  );
  return row?.querySelector("dd") ?? null;
}

describe("the job screen's Processed by line", () => {
  it("names the key (linked to its worker page), the incarnation and where it ran — the last attempt", async () => {
    await renderJobScreen(
      jobFixture("completed", {
        processedBy: {
          id: "api.emails.9f3c",
          key: "api.emails",
          host: "api-1",
          pid: 4242,
        },
      }),
      { meta: meta(true), handlers },
    );
    const value = (await processedByRow())!;
    const link = within(value).getByRole("link", { name: "api.emails" });
    expect(link.getAttribute("href")).toBe("/jobs/workers/emails/api.emails");
    const text = value.textContent ?? "";
    expect(text).toContain("api.emails.9f3c");
    expect(text).toContain("api-1");
    expect(text).toContain("pid 4242");
    expect(text).toContain("last attempt");
    // A finished job has no holder, so no "Held by" row.
    expect(page().queryByText("Held by")).toBeNull();
  });

  it("says no worker is recorded when processedBy is null", async () => {
    await renderJobScreen(jobFixture("completed"), {
      meta: meta(true),
      handlers,
    });
    const value = (await processedByRow())!;
    expect(within(value).getByTestId("job-processed-by-none").textContent).toBe(
      "No worker recorded",
    );
    expect(value.textContent).toContain("never claimed");
    expect(value.textContent).toContain("before this backend recorded");
  });

  it("shows nothing without the flag, even if a job carries processedBy", async () => {
    await renderJobScreen(
      jobFixture("completed", {
        processedBy: { id: "api.emails.9f3c", key: "api.emails" },
      }),
      { meta: meta(false), handlers },
    );
    expect(await processedByRow()).toBeNull();
    expect(page().queryByTestId("job-processed-by")).toBeNull();
  });

  it("shows the key as text when the worker pages are not routed", async () => {
    await renderJobScreen(
      jobFixture("completed", {
        processedBy: { id: "api.emails.9f3c", key: "api.emails" },
      }),
      {
        meta: meta(true),
        permissions: allPermissions({ "workers.list": false }),
        handlers,
      },
    );
    const value = (await processedByRow())!;
    expect(within(value).queryByRole("link")).toBeNull();
    expect(within(value).getByTestId("job-processed-by-key").textContent).toBe(
      "api.emails",
    );
  });

  it("shows the incarnation alone for a stamp without a key", async () => {
    await renderJobScreen(
      jobFixture("active", { processedBy: { id: "worker-1" } }),
      { meta: meta(true), handlers },
    );
    const value = (await processedByRow())!;
    expect(within(value).queryByRole("link")).toBeNull();
    expect(value.textContent).toContain("worker-1");
    // Active: the holder is shown too.
    expect(page().getByText("Held by")).toBeTruthy();
  });
});
