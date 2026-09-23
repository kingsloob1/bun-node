import type {
  WorkerAnalyticsDto,
  WorkerConfigOverrideDto,
  WorkerDto,
} from "../../../app/api/types";
import type { MockHandler, MockReply } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { WORKER_CONFIG_KEYS } from "../../../app/api/contract";
import { fireEvent, page, setupDom, visit, waitFor, within } from "../dom";
import {
  ANALYTICS_NOW,
  metaFixture,
  permissionsFixture,
  rangeFixture,
} from "../fixtures";
import { renderApp } from "../renderApp";
import { configResult, workerFixture } from "./fixtures";

setupDom();

/** Two live instances of `api.emails`, on two hosts. */
const INSTANCES: WorkerDto[] = [
  workerFixture({ id: "api.emails.a1", host: "api-1", pid: 100 }),
  workerFixture({ id: "api.emails.b2", host: "api-2", pid: 200 }),
];

/** `GET /queues/emails/analytics/workers/api.emails`: minute throughput, coarser busyness. */
function workerAnalytics(): WorkerAnalyticsDto {
  const jobsRange = rangeFixture({ resolution: 1 });
  const busyRange = rangeFixture(
    {
      resolution: 60,
      clamped: true,
      reason: "resolution",
      requested: { from: ANALYTICS_NOW - 60_000, to: ANALYTICS_NOW },
    },
    2,
  );
  return {
    key: "api.emails",
    queue: "emails",
    jobs: {
      range: jobsRange,
      buckets: [
        { at: jobsRange.from, completed: 4, failed: 0 },
        { at: jobsRange.from + 1_000, completed: 6, failed: 1 },
        { at: jobsRange.to, completed: 2, failed: 0 },
      ],
      totals: { completed: 12, failed: 1 },
    },
    busyness: {
      range: busyRange,
      buckets: [
        {
          at: busyRange.from,
          samples: 6,
          activeMean: 1,
          activeMax: 2,
          concurrency: 3,
        },
        {
          at: busyRange.to,
          samples: 6,
          activeMean: 2,
          activeMax: 3,
          concurrency: 3,
        },
      ],
      totals: { samples: 12, activeMean: 1.5, activeMax: 3, concurrency: 3 },
    },
  };
}

/** Options of {@link open}. */
interface OpenOptions {
  /** The live instances `GET /workers?key=` answers. */
  items?: WorkerDto[];
  /** Its `offline`; omitted when `undefined`. */
  offline?: WorkerConfigOverrideDto[];
  /** Extra permissions over the fixture's, for both maps. */
  grant?: Parameters<typeof permissionsFixture>[0];
  /** More handlers. */
  handlers?: Record<string, MockHandler | MockReply>;
  /** The path under the app. Defaults to the `api.emails` page. */
  path?: string;
}

/** Opens a worker page. */
function open({
  items = INSTANCES,
  offline = [],
  grant = {},
  handlers = {},
  path = "/workers/emails/api.emails",
}: OpenOptions = {}) {
  visit(`/jobs${path}`);
  return renderApp({
    handlers: {
      "GET /meta/permissions": { body: permissionsFixture(grant) },
      "GET /workers": ({ query }) => ({
        body: {
          items: items.filter(
            (worker) =>
              (!query.has("key") ||
                query.getAll("key").includes(worker.key ?? "")) &&
              (!query.has("queue") ||
                query.getAll("queue").includes(worker.queue)),
          ),
          ...(query.get("includeOffline") === "true" ? { offline } : {}),
        },
      }),
      "GET /queues/emails/analytics/workers/api.emails": {
        body: workerAnalytics(),
      },
      ...handlers,
    },
  });
}

describe("the worker page", () => {
  it("reads one key's instances with GET /workers?queue=&key=&includeOffline", async () => {
    const { calls } = open();
    const screen = await page().findByTestId("worker-screen");
    expect(within(screen).getByRole("heading", { level: 1 }).textContent).toBe(
      "Worker api.emails",
    );
    await within(screen).findByTestId("worker-row-api.emails.a1");
    const read = calls.find(
      (call) => call.path === "/workers" && call.query.has("key"),
    )!;
    expect(read.query.toString()).toBe(
      "queue=emails&key=api.emails&includeOffline=true",
    );
    // The queue's own permissions are asked: worker actions authorize against it.
    expect(
      calls.some(
        (call) =>
          call.path === "/meta/permissions" &&
          call.query.get("queue") === "emails",
      ),
    ).toBe(true);
  });

  it("names the queue (linked) and the service, and lists every instance with its controls", async () => {
    open();
    const screen = await page().findByTestId("worker-screen");
    expect(
      within(screen).getByRole("link", { name: "emails" }).getAttribute("href"),
    ).toBe("/jobs/queues/emails");
    expect(screen.textContent).toContain("api");
    const instances = await within(screen).findByTestId("worker-instances");
    expect(instances.textContent).toContain("api-2");
    const row = within(instances).getByTestId("worker-row-api.emails.b2");
    expect(within(row).getByRole("button", { name: "Pause" })).toBeTruthy();
    // No link to the page it is on.
    expect(
      within(instances).queryByTestId("worker-key-link-api.emails.a1"),
    ).toBeNull();
  });

  it("gives the Instances table a Memory column, one figure per process, and a dash where none is reported", async () => {
    open({
      items: [
        workerFixture({ id: "api.emails.a1", host: "api-1", pid: 100 }),
        // A second worker in the SAME process: the same figure, never doubled.
        workerFixture({ id: "api.emails.a2", host: "api-1", pid: 100 }),
        // Predates the field.
        workerFixture({
          id: "api.emails.b2",
          host: "api-2",
          pid: 200,
          rssBytes: undefined,
        }),
      ],
    });
    const instances = await page().findByTestId("worker-instances");
    const row = await within(instances).findByTestId(
      "worker-row-api.emails.a1",
    );
    const table = row.closest("table")!;
    const headers = within(table).getAllByRole("columnheader");
    const memory = headers.findIndex((cell) => cell.textContent === "Memory");
    expect(memory).toBeGreaterThan(-1);
    expect(headers[memory]!.getAttribute("title")).toContain(
      "do not add these up",
    );
    const cellAt = (id: string) => {
      const cells = within(instances).getByTestId(`worker-row-${id}`).children;
      return cells[memory]?.textContent;
    };
    expect(cellAt("api.emails.a1")).toBe("256.0 MiB");
    expect(cellAt("api.emails.a2")).toBe("256.0 MiB");
    expect(cellAt("api.emails.b2")).toBe("—");
    expect(table.querySelector("tfoot")).toBeNull();
    expect(instances.textContent).not.toContain("512.0 MiB");
  });

  it("explains the heartbeat's round trip in its tooltip, and only where one is reported", async () => {
    open({
      items: [
        workerFixture({ id: "api.emails.a1" }),
        workerFixture({ id: "api.emails.b2", heartbeatRttMs: undefined }),
      ],
    });
    const instances = await page().findByTestId("worker-instances");
    await within(instances).findByTestId("worker-row-api.emails.a1");
    const heartbeatTitle = (id: string) =>
      within(instances)
        .getByTestId(`worker-row-${id}`)
        .querySelectorAll("time")[1]!
        .getAttribute("title") ?? "";
    expect(heartbeatTitle("api.emails.a1")).toContain(
      "Last write took 12 ms (the previous report's round trip to the driver, not a network ping).",
    );
    expect(heartbeatTitle("api.emails.b2")).not.toContain("Last write took");
    // The Memory column is a column; the round trip is not.
    expect(
      within(instances)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).not.toContain("Heartbeat round trip");
  });

  it("shows every setting: what it runs with, what the code asks for, and which are overridden", async () => {
    open();
    const config = await page().findByTestId("worker-config");
    for (const setting of WORKER_CONFIG_KEYS) {
      expect(
        within(config).getByTestId(`worker-setting-${setting}`),
      ).toBeTruthy();
    }
    const concurrency = within(config).getByTestId(
      "worker-setting-concurrency",
    );
    const cells = Array.from(concurrency.children, (cell) => cell.textContent);
    expect(cells).toEqual(["concurrency", "3", "2", "Overridden"]);
    const lock = Array.from(
      within(config).getByTestId("worker-setting-lockDuration").children,
      (cell) => cell.textContent,
    );
    expect(lock).toEqual(["lockDuration", "30,000 ms", "30,000 ms", "Code"]);
    expect(
      within(config).getByTestId("worker-config-summary").textContent,
    ).toContain("version 4");
  });

  it("offers no Edit settings… without workers.configure (opt-in)", async () => {
    open();
    await page().findByTestId("worker-config");
    expect(page().queryByRole("button", { name: "Edit settings…" })).toBeNull();
  });

  it("edits the key's settings through the Settings dialog", async () => {
    const writes: string[] = [];
    open({
      grant: { "workers.configure": true },
      handlers: {
        "PUT /queues/emails/worker-configs/api.emails": ({ body }) => {
          writes.push(body ?? "");
          return { body: configResult() };
        },
      },
    });
    fireEvent.click(
      await page().findByRole("button", { name: "Edit settings…" }),
    );
    const dialog = await page().findByRole("dialog");
    expect(dialog.textContent).toContain("Settings of api.emails");
    fireEvent.change(within(dialog).getByLabelText("concurrency"), {
      target: { value: "5" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save settings" }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(writes[0]!)).toEqual({ concurrency: 5, expectedSeq: 4 });
  });

  it("shows Change pending while an instance has not taken a change up", async () => {
    open({
      items: [
        INSTANCES[0]!,
        workerFixture({
          id: "api.emails.b2",
          control: { ...workerFixture().control!, pending: true },
        }),
      ],
    });
    const config = await page().findByTestId("worker-config");
    const card = config.closest("section")!;
    expect(within(card).getByText("Change pending")).toBeTruthy();
  });

  it("says when instances run with different values", async () => {
    const other = workerFixture({ id: "api.emails.b2" });
    other.config = {
      ...other.config!,
      effective: { ...other.config!.effective, concurrency: 7 },
    };
    open({ items: [INSTANCES[0]!, other] });
    expect(await page().findByTestId("worker-config-differs")).toBeTruthy();
  });

  it("with no live instance, shows the stored override and still offers Reset", async () => {
    const deletes: string[] = [];
    open({
      items: [],
      offline: [
        {
          queue: "emails",
          key: "api.emails",
          values: { concurrency: 5 },
          seq: 6,
          updatedAt: Date.now() - 60_000,
          instances: [],
        },
      ],
      grant: { "workers.configure": true },
      handlers: {
        "DELETE /queues/emails/worker-configs/api.emails": ({ path }) => {
          deletes.push(path);
          return { body: configResult({ values: {}, seq: 7, instances: [] }) };
        },
      },
    });
    const offline = await page().findByTestId("worker-config-offline");
    expect(offline.textContent).toContain("cannot be shown until one reports");
    expect(
      within(offline).getByTestId("worker-config-stored").textContent,
    ).toContain("version 6");
    expect(offline.textContent).toContain("concurrency");
    expect(page().getByText("No live instance")).toBeTruthy();
    fireEvent.click(
      within(offline).getByRole("button", { name: "Reset to code values…" }),
    );
    const dialog = await page().findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(deletes).toHaveLength(1));
  });

  it("offers no Reset without workers.configure, nor when nothing is stored", async () => {
    open({
      items: [],
      offline: [
        {
          queue: "emails",
          key: "api.emails",
          values: { concurrency: 5 },
          seq: 6,
          updatedAt: Date.now(),
          instances: [],
        },
      ],
    });
    const offline = await page().findByTestId("worker-config-offline");
    expect(
      within(offline).queryByRole("button", { name: "Reset to code values…" }),
    ).toBeNull();
  });

  it("says no override is stored when the listing has none for the key", async () => {
    open({ items: [], offline: [], grant: { "workers.configure": true } });
    const offline = await page().findByTestId("worker-config-offline");
    expect(
      within(offline).getByTestId("worker-config-none-stored"),
    ).toBeTruthy();
    expect(
      within(offline).queryByRole("button", { name: "Reset to code values…" }),
    ).toBeNull();
  });

  it("counts an entry a reset emptied as nothing stored, and offers no Reset", async () => {
    // What a real API lists after Reset with no live instance: the entry is
    // emptied, not deleted, so it keeps its seq.
    open({
      items: [],
      offline: [
        {
          queue: "emails",
          key: "api.emails",
          values: {},
          seq: 2,
          updatedAt: Date.now(),
          instances: [],
        },
      ],
      grant: { "workers.configure": true },
    });
    const offline = await page().findByTestId("worker-config-offline");
    expect(
      within(offline).getByTestId("worker-config-none-stored"),
    ).toBeTruthy();
    expect(within(offline).queryByTestId("worker-config-stored")).toBeNull();
    expect(offline.textContent).not.toContain("An override is stored");
    expect(
      within(offline).queryByRole("button", { name: "Reset to code values…" }),
    ).toBeNull();
  });

  it("charts the key's throughput and busyness, each captioned from its own range", async () => {
    const { calls } = open();
    const analytics = await page().findByTestId("worker-analytics");
    await within(analytics).findByText("Throughput");
    const jobs = within(analytics).getByTestId("worker-jobs-range-caption");
    const busy = within(analytics).getByTestId("worker-busyness-range-caption");
    expect(jobs.textContent).toContain("1-second buckets");
    expect(busy.textContent).toContain("1-minute buckets");
    expect(busy.getAttribute("data-clamp-reason")).toBe("resolution");
    expect(analytics.textContent).toContain("12");
    expect(analytics.textContent).toContain("1.5 / 3");
    const read = calls.find((call) =>
      call.path.startsWith("/queues/emails/analytics/workers/"),
    )!;
    expect(read.path).toBe("/queues/emails/analytics/workers/api.emails");
    expect(read.query.has("from")).toBe(true);
    expect(read.query.has("minutes")).toBe(false);
  });

  it("has no analytics card when the backend records no analytics", async () => {
    const { calls } = open({
      handlers: { "GET /meta": { body: metaFixture({ analytics: null }) } },
    });
    await page().findByTestId("worker-config");
    expect(page().queryByTestId("worker-analytics")).toBeNull();
    expect(calls.some((call) => call.path.includes("/analytics/"))).toBe(false);
  });

  it("says a backend without job attribution cannot list the key's jobs, and reads none", async () => {
    // The shared fixture's `features.jobAttribution` is false; workerJobsCard.test.tsx covers it on.
    const { calls } = open();
    const jobs = await page().findByTestId("worker-jobs-unrecorded");
    expect(jobs.textContent).toContain(
      "does not record which worker ran a job",
    );
    expect(calls.some((call) => call.path === "/queues/emails/jobs")).toBe(
      false,
    );
  });

  it("still shows the jobs section when the queue's answer refuses workers.list", async () => {
    // The route exists (untargeted `workers.list`), but this queue refuses it.
    visit("/jobs/workers/emails/api.emails");
    renderApp({
      handlers: {
        "GET /meta/permissions": ({ query }) => ({
          body: permissionsFixture(
            query.get("queue") === "emails" ? { "workers.list": false } : {},
          ),
        }),
      },
    });
    await page().findByText("Instances hidden");
    expect(await page().findByTestId("worker-jobs")).toBeTruthy();
    expect(page().queryByTestId("worker-instances")).toBeNull();
  });

  it("still shows the key's analytics when the queue's answer refuses workers.list", async () => {
    // Analytics are `metrics.read` and the workers-metrics gate, not
    // `workers.list`: hiding the instances must not hide the charts.
    visit("/jobs/workers/emails/api.emails");
    const { calls } = renderApp({
      handlers: {
        "GET /meta/permissions": ({ query }) => ({
          body: permissionsFixture(
            query.get("queue") === "emails" ? { "workers.list": false } : {},
          ),
        }),
        "GET /queues/emails/analytics/workers/api.emails": {
          body: workerAnalytics(),
        },
      },
    });
    await page().findByText("Instances hidden");
    expect(await page().findByTestId("worker-analytics")).toBeTruthy();
    await waitFor(() =>
      expect(
        calls.some((call) =>
          call.path.startsWith("/queues/emails/analytics/workers/"),
        ),
      ).toBe(true),
    );
  });

  it("is not routed without the Workers nav entry", async () => {
    open({ grant: { "workers.list": false } });
    expect(await page().findByText(/not found/i)).toBeTruthy();
    expect(page().queryByTestId("worker-screen")).toBeNull();
  });
});

describe("the queue panel's worker rows", () => {
  it("link each instance to its key's page", async () => {
    visit("/jobs/queues/emails?panel=workers");
    renderApp({
      handlers: {
        "GET /queues/emails/workers": { body: { items: INSTANCES } },
      },
    });
    const link = await page().findByTestId("worker-key-link-api.emails.a1");
    expect(link.getAttribute("href")).toBe("/jobs/workers/emails/api.emails");
  });
});
