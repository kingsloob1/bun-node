import { describe, expect, it } from "bun:test";
import { page, setupDom, within } from "../dom";
import { childrenFixture, jobApiPath, jobFixture, logPage } from "./fixtures";
import { renderJobScreen } from "./render";

setupDom();

/** A flow parent with three children. */
const parentJob = jobFixture("waiting-children", {
  flow: {
    parent: { queue: "orders", id: "order 9/1" },
    children: [
      { queue: "images", id: "resize-1" },
      { queue: "archive", id: "gone-7" },
      { queue: "images", id: "resize-2" },
    ],
    pending: 1,
    values: { "images:resize-1": { width: 640 } },
    failures: {},
    recorded: false,
  },
});

/** Handlers for the logs and children of the fixture job. */
function handlers(children = childrenFixture()) {
  return {
    [`GET ${jobApiPath()}/logs`]: { body: logPage(0, 100, "asc", 0) },
    [`GET ${jobApiPath()}/children`]: { body: children },
  };
}

describe("the job's flow", () => {
  it("links the parent and lists each child's state and outcome, unreachable ones included", async () => {
    const { calls } = await renderJobScreen(parentJob, {
      handlers: handlers(),
    });
    const flow = await page().findByRole("region", { name: "Flow" });
    const parent = within(flow).getByRole("link", { name: /orders/ });
    expect(parent.getAttribute("href")).toBe(
      "/jobs/queues/orders/jobs/order%209%2F1",
    );
    expect(flow.textContent).toContain("Pending children1");

    await within(flow).findByRole("table", { name: "Children" });
    const completed = within(flow).getByTestId("flow-child-images:resize-1");
    expect(completed.querySelector(".state-badge")?.textContent).toBe(
      "Completed",
    );
    expect(completed.textContent).toContain("width");
    expect(within(completed).getByRole("link").getAttribute("href")).toBe(
      "/jobs/queues/images/jobs/resize-1",
    );

    const gone = within(flow).getByTestId("flow-child-archive:gone-7");
    expect(gone.textContent).toContain("unreachable");
    expect(gone.querySelector(".state-badge")).toBeNull();

    const failed = within(flow).getByTestId("flow-child-images:resize-2");
    expect(failed.textContent).toContain("ResizeError: bad format");

    // Children are read with no include (the route's default).
    const request = calls.find(
      (call) => call.path === `${jobApiPath()}/children`,
    )!;
    expect([...request.query.keys()]).toEqual([]);
    expect(page().queryByTestId("flow-truncated")).toBeNull();
  });

  it("says when the children list is truncated", async () => {
    await renderJobScreen(parentJob, {
      handlers: handlers(childrenFixture({ truncated: true })),
    });
    const note = await page().findByTestId("flow-truncated");
    expect(note.textContent).toContain("first 3 children");
  });

  it("marks a root and a childless job without reading children", async () => {
    const { calls } = await renderJobScreen(
      jobFixture("completed", {
        flow: {
          parent: null,
          children: [],
          pending: 0,
          values: {},
          failures: {},
          recorded: true,
        },
      }),
      { handlers: handlers() },
    );
    const flow = await page().findByRole("region", { name: "Flow" });
    expect(flow.textContent).toContain("None: this is the root");
    expect(flow.textContent).toContain("This job has no children.");
    expect(calls.some((call) => call.path.endsWith("/children"))).toBe(false);
  });

  it("has no flow section when the job is not in a flow", async () => {
    const { calls } = await renderJobScreen(jobFixture("completed"), {
      handlers: handlers(),
    });
    await page().findByRole("region", { name: "Data" });
    expect(page().queryByRole("region", { name: "Flow" })).toBeNull();
    expect(calls.some((call) => call.path.endsWith("/children"))).toBe(false);
  });
});
