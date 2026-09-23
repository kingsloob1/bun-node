import type { WorkerDto } from "../../../app/api/types";
import { describe, expect, it } from "bun:test";
import { groupByServer, matchesWorker } from "../../../app/api/workers";
import { fireEvent, page, setupDom, visit, waitFor, within } from "../dom";
import { permissionsFixture, problem } from "../fixtures";
import { renderApp } from "../renderApp";

setupDom();

/** A worker record, heartbeat now. */
function worker(overrides: Partial<WorkerDto>): WorkerDto {
  const now = Date.now();
  return {
    id: "w1",
    queue: "emails",
    concurrency: 3,
    active: 1,
    paused: false,
    startedAt: now - 60_000,
    heartbeatAt: now,
    expiresAt: now + 30_000,
    host: "api-1",
    pid: 100,
    ...overrides,
  };
}

const WORKERS: WorkerDto[] = [
  worker({ id: "w-reports", queue: "reports", host: "api-2", pid: 7 }),
  worker({ id: "w-emails", queue: "emails", paused: true }),
  worker({ id: "w-hooks", queue: "webhooks", active: 2, concurrency: 2 }),
];

/** Opens `/workers` with the given `GET /workers` items. */
async function open(items: WorkerDto[] = WORKERS) {
  visit("/jobs/workers");
  renderApp({ handlers: { "GET /workers": { body: { items } } } });
  return page().findByTestId("workers-list");
}

describe("groupByServer", () => {
  it("groups by host and pid, servers by host then pid, workers by queue then id", () => {
    const servers = groupByServer([
      ...WORKERS,
      worker({ id: "a", queue: "webhooks", host: "api-1", pid: 99 }),
    ]);
    expect(servers.map((server) => server.key)).toEqual([
      "api-1:99",
      "api-1:100",
      "api-2:7",
    ]);
    expect(servers[1]!.workers.map((item) => item.id)).toEqual([
      "w-emails",
      "w-hooks",
    ]);
  });

  it("puts every worker in one group when the API hides hosts", () => {
    const servers = groupByServer(
      WORKERS.map(({ host: _host, pid: _pid, ...rest }) => rest),
    );
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ key: "hidden", host: null, pid: null });
  });
});

describe("matchesWorker", () => {
  it("needs every word in the id, queue or host, ignoring case", () => {
    const item = worker({ id: "W-Emails", queue: "emails", host: "API-1" });
    expect(matchesWorker(item, "")).toBe(true);
    expect(matchesWorker(item, "api-1 EMAILS")).toBe(true);
    expect(matchesWorker(item, "api-1 reports")).toBe(false);
  });
});

describe("the workers screen", () => {
  it("lists each server's workers with state, load and a link to the queue", async () => {
    const screen = await open();
    expect(
      (await within(screen).findByTestId("workers-count")).textContent,
    ).toBe("3 workers on 2 servers");
    const first = within(screen).getByTestId("worker-server-api-1:100");
    expect(first.textContent).toContain("api-1 · pid 100");
    const emails = within(first).getByTestId("worker-row-w-emails");
    expect(emails.textContent).toContain("Paused");
    const hooks = within(first).getByTestId("worker-row-w-hooks");
    expect(hooks.textContent).toContain("Running");
    expect(hooks.textContent).toContain("2 / 2");
    expect(
      within(hooks)
        .getByRole("link", { name: "webhooks" })
        .getAttribute("href"),
    ).toBe("/jobs/queues/webhooks");
  });

  it("has no Completed/Failed columns when no worker reports its counts", async () => {
    const screen = await open();
    const table = (await within(screen).findAllByRole("table"))[0]!;
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).not.toContain("Completed");
    expect(headers).not.toContain("Failed");
  });

  it("shows each incarnation's Completed/Failed, and a dash — not a zero — where a worker reports none", async () => {
    const screen = await open([
      worker({ id: "w-new", completed: 1234, failed: 0 }),
      // Predates the counters: absent is not zero.
      worker({ id: "w-old" }),
    ]);
    const row = await within(screen).findByTestId("worker-row-w-new");
    const table = row.closest("table")!;
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    const completed = headers.indexOf("Completed");
    const failed = headers.indexOf("Failed");
    expect(completed).toBeGreaterThan(-1);
    expect(failed).toBe(completed + 1);
    const cells = (id: string) =>
      Array.from(
        within(screen).getByTestId(`worker-row-${id}`).children,
        (cell) => cell.textContent,
      );
    expect(cells("w-new")[completed]).toBe("1,234");
    // A reported zero is a zero.
    expect(cells("w-new")[failed]).toBe("0");
    expect(cells("w-old")[completed]).toBe("—");
    expect(cells("w-old")[failed]).toBe("—");
  });

  it("has no Memory column when no worker reports its process memory", async () => {
    const screen = await open();
    const table = (await within(screen).findAllByRole("table"))[0]!;
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).not.toContain("Memory");
  });

  it("shows the process's memory, and a dash — not a zero — where a worker reports none", async () => {
    const screen = await open([
      worker({ id: "w-new", rssBytes: 1_610_612_736 }),
      // Predates the field: absent is not zero.
      worker({ id: "w-old" }),
    ]);
    const row = await within(screen).findByTestId("worker-row-w-new");
    const table = row.closest("table")!;
    const headers = within(table).getAllByRole("columnheader");
    const memory = headers.findIndex((cell) => cell.textContent === "Memory");
    expect(memory).toBeGreaterThan(-1);
    // The header says whose memory it is and that the rows do not add up.
    const hint = headers[memory]!.getAttribute("title") ?? "";
    expect(hint).toContain("process this worker runs in");
    expect(hint).toContain("do not add these up");
    const cells = (id: string) =>
      Array.from(
        within(screen).getByTestId(`worker-row-${id}`).children,
        (cell) => cell.textContent,
      );
    expect(cells("w-new")[memory]).toBe("1.5 GiB");
    expect(cells("w-old")[memory]).toBe("—");
  });

  it("repeats one figure for two workers of a pid, and totals nothing", async () => {
    const rssBytes = 268_435_456;
    const screen = await open([
      worker({ id: "w-a", host: "api-1", pid: 100, rssBytes }),
      worker({ id: "w-b", host: "api-1", pid: 100, rssBytes }),
    ]);
    const row = await within(screen).findByTestId("worker-row-w-a");
    const table = row.closest("table")!;
    const memory = within(table)
      .getAllByRole("columnheader")
      .findIndex((cell) => cell.textContent === "Memory");
    const cellAt = (id: string) => {
      const cells = within(screen).getByTestId(`worker-row-${id}`).children;
      return cells[memory]?.textContent;
    };
    // The same process, so the same figure on both rows — not half each.
    expect(cellAt("w-a")).toBe("256.0 MiB");
    expect(cellAt("w-b")).toBe("256.0 MiB");
    // And nowhere a sum of them: no footer, and no 512 MiB anywhere.
    expect(table.querySelector("tfoot")).toBeNull();
    expect(screen.textContent).not.toContain("512.0 MiB");
  });

  it("explains the heartbeat's round trip in the cell's tooltip, and only when reported", async () => {
    const screen = await open([
      worker({ id: "w-rtt", heartbeatRttMs: 12 }),
      worker({ id: "w-sub", heartbeatRttMs: 0.42 }),
      // A first report, or an older worker: no sample to show.
      worker({ id: "w-none" }),
    ]);
    await within(screen).findByTestId("worker-row-w-rtt");
    const heartbeatTitle = (id: string) => {
      const times = within(screen)
        .getByTestId(`worker-row-${id}`)
        .querySelectorAll("time");
      // Started, then Heartbeat.
      expect(times).toHaveLength(2);
      return times[1]!.getAttribute("title") ?? "";
    };
    expect(heartbeatTitle("w-rtt")).toContain(
      "Last write took 12 ms (the previous report's round trip to the driver, not a network ping).",
    );
    expect(heartbeatTitle("w-sub")).toContain("Last write took 0.4 ms (");
    // The instant the tooltip already carried is still there.
    expect(heartbeatTitle("w-rtt")).toContain("T");
    expect(heartbeatTitle("w-none")).not.toContain("Last write took");
  });

  it("filters by id, queue or host through ?search", async () => {
    const screen = await open();
    await within(screen).findByTestId("workers-count");
    fireEvent.change(within(screen).getByRole("searchbox"), {
      target: { value: "api-2" },
    });
    await waitFor(() =>
      expect(within(screen).getByTestId("workers-count").textContent).toBe(
        "1 worker on 1 server (of 3)",
      ),
    );
    expect(window.location.search).toBe("?search=api-2");
    fireEvent.change(within(screen).getByRole("searchbox"), {
      target: { value: "nothing-like-it" },
    });
    expect(await page().findByText("No workers match")).toBeTruthy();
  });

  it("says when no worker has reported", async () => {
    await open([]);
    expect(await page().findByText("No live workers")).toBeTruthy();
  });

  it("shows queue names as text without queues.list", async () => {
    const permissions = permissionsFixture();
    delete permissions.actions["queues.list"];
    visit("/jobs/workers");
    renderApp({
      handlers: {
        "GET /workers": { body: { items: WORKERS } },
        "GET /meta/permissions": { body: permissions },
      },
    });
    const screen = await page().findByTestId("workers-list");
    await within(screen).findByTestId("worker-row-w-hooks");
    expect(within(screen).queryByRole("link", { name: "webhooks" })).toBeNull();
  });

  it("reports a failed read with a retry", async () => {
    visit("/jobs/workers");
    renderApp({
      handlers: {
        "GET /workers": {
          status: 500,
          body: problem(500, "INTERNAL", "boom"),
        },
      },
    });
    expect(await page().findByText("Could not load workers")).toBeTruthy();
  });
});
