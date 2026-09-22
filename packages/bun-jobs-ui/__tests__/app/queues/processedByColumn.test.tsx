import type { JobDto, MetaDto } from "../../../app/api/types";
import { describe, expect, it } from "bun:test";
import { page, setupDom, within } from "../dom";
import { metaFixture, permissionsFixture } from "../fixtures";
import { jobFixture, jobPageFixture, renderQueue } from "./fixtures";

setupDom();

/**
 * The queue jobs table's "Processed by" column (`JobDto.processedBy`), shown
 * only where `features.jobAttribution` is true — the shared meta has it off,
 * so every test here says which it wants.
 */

/** `/meta` with job attribution on or off. */
function meta(jobAttribution: boolean): MetaDto {
  const base = metaFixture();
  return metaFixture({ features: { ...base.features, jobAttribution } });
}

/** Three jobs: one with a key, one with only an id, one with nobody recorded. */
const JOBS: JobDto[] = [
  jobFixture({
    id: "keyed",
    processedBy: { id: "api.emails.9f3c", key: "api.emails" },
  }),
  jobFixture({ id: "id-only", processedBy: { id: "worker-7" } }),
  jobFixture({ id: "nobody", processedBy: null }),
];

/** Opens the `emails` queue with {@link JOBS}, attribution and `workers.list` as asked. */
async function open(attribution: boolean, workersList = true) {
  renderQueue({
    handlers: {
      "GET /meta": { body: meta(attribution) },
      "GET /meta/permissions": {
        body: permissionsFixture({ "workers.list": workersList }),
      },
      "GET /queues/emails/jobs": { body: jobPageFixture({ items: JOBS }) },
    },
  });
  const table = await page().findByRole("table", { name: "Jobs in emails" });
  await within(table).findByTestId("job-row-keyed");
  return table;
}

/** The table's column headers, as text. */
function headers(table: HTMLElement): string[] {
  return Array.from(table.querySelectorAll("thead th")).map(
    (th) => th.textContent ?? "",
  );
}

describe("the jobs table's Processed by column", () => {
  it("is absent when the backend does not record attribution", async () => {
    const table = await open(false);
    expect(headers(table)).not.toContain("Processed by");
    expect(headers(table)).toEqual([
      "",
      "Id",
      "Name",
      "State",
      "Attempts",
      "Priority",
      "Created",
      "Processed",
      "Finished",
      "Failure",
    ]);
    expect(table.querySelector(".job-processed-by-col")).toBeNull();
  });

  it("sits after Processed, with a header tooltip, when the flag is on", async () => {
    const table = await open(true);
    const names = headers(table);
    expect(names.indexOf("Processed by")).toBe(names.indexOf("Processed") + 1);
    expect(
      within(table)
        .getByTestId("jobs-processed-by-header")
        .getAttribute("title"),
    ).toBe("The worker that ran the job's last attempt");
  });

  it("links the key to its worker page on the job's queue", async () => {
    const table = await open(true);
    const row = within(table).getByTestId("job-row-keyed");
    const link = within(row).getByRole("link", { name: "api.emails" });
    expect(link.getAttribute("href")).toBe("/jobs/workers/emails/api.emails");
    expect(link.closest("td")?.getAttribute("title")).toContain(
      "api.emails.9f3c",
    );
  });

  it("shows the key as plain text when the worker pages are not routed", async () => {
    const table = await open(true, false);
    const row = within(table).getByTestId("job-row-keyed");
    const key = within(row).getByTestId("jobs-processed-by-key");
    expect(key.textContent).toBe("api.emails");
    expect(key.tagName).not.toBe("A");
    expect(within(row).queryByRole("link", { name: "api.emails" })).toBeNull();
  });

  it("shows the incarnation id as text when no key was recorded", async () => {
    const table = await open(true);
    const row = within(table).getByTestId("job-row-id-only");
    expect(within(row).getByTestId("jobs-processed-by-id").textContent).toBe(
      "worker-7",
    );
    expect(within(row).queryByRole("link", { name: "worker-7" })).toBeNull();
  });

  it("shows a dash, titled, when no worker is recorded", async () => {
    const table = await open(true);
    const row = within(table).getByTestId("job-row-nobody");
    const cell = within(row).getByTestId("jobs-processed-by-none");
    expect(cell.textContent).toBe("—");
    expect(cell.getAttribute("title")).toContain("No worker recorded");
  });
});
