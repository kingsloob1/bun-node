import type {
  QueueSummaryDto,
  RepeatableDto,
  RunRecordDto,
  WorkerDto,
} from "../../app/api/types";
import { describe, expect, it } from "bun:test";
import { fireEvent, page, setupDom, visit, waitFor, within } from "./dom";
import { permissionsFixture } from "./fixtures";
import {
  NOW as QUEUE_NOW,
  renderQueue,
  repeatablesFixture,
} from "./queues/fixtures";
import { renderApp } from "./renderApp";
import {
  historyFixture,
  renderRunner,
  runFixture,
  runnerListFixture,
} from "./runners/fixtures";
import { workerFixture } from "./workers/fixtures";

/**
 * Paging the list tables: the Overview's queues, a server's workers, a
 * queue's workers and repeat series, a worker key's instances, the runners
 * and a runner's history.
 *
 * Every one of them is cut in the browser from rows already fetched, so each
 * table is checked the same four ways: the pager appears, a page change shows
 * the next rows, the rows-per-page select changes the window, and a table
 * that fits one page grows no pager at all.
 */

setupDom();

/** The `data-testid` of each body row of `table`, in order. */
function rowIds(table: HTMLElement): string[] {
  return Array.from(
    table.querySelectorAll<HTMLElement>("tbody tr"),
    (row) => row.dataset.testid ?? "",
  );
}

/** The pager with this accessible name, or `null` when the table has none. */
function pager(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`nav[aria-label="${label}"]`);
}

/**
 * How many pagers carry this accessible name — `0` where a table has none.
 *
 * A count, not `expect(pager(label)).toBeNull()`: that assertion passed
 * against a live happy-dom element here (the same query printed the element
 * on the line above), so a single-page table growing a pager went unnoticed
 * in two of these checks until a deliberately broken build was run past them.
 */
function pagerCount(label: string): number {
  return document.querySelectorAll(`nav[aria-label="${label}"]`).length;
}

/** The pager with this accessible name; fails when it is absent. */
function requirePager(label: string): HTMLElement {
  const found = pager(label);
  if (!found) {
    throw new Error(`no pager labelled ${label}`);
  }
  return found;
}

/** Clicks a pager's button. */
function turn(label: string, button: "Previous" | "Next"): void {
  fireEvent.click(
    within(requirePager(label)).getByRole("button", { name: button }),
  );
}

/** Chooses a page size on a pager. */
function setPageSize(label: string, size: number): void {
  fireEvent.change(
    within(requirePager(label)).getByLabelText("Rows per page"),
    {
      target: { value: String(size) },
    },
  );
}

/* ------------------------------------------------------------------ *
 * The Overview's queue table
 * ------------------------------------------------------------------ */

/** `count` queues named `q-00`, `q-01`, … so row order is readable. */
function queues(count: number): QueueSummaryDto[] {
  return Array.from({ length: count }, (_unused, index) => ({
    name: `q-${String(index).padStart(2, "0")}`,
    counts: {
      waiting: index,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      dead: 0,
      "waiting-children": 0,
    },
    total: index,
    paused: false,
  }));
}

/**
 * The Overview with `count` queues. `metrics.read` is refused so the card has
 * no throughput column: a sparkline per row would need an
 * `IntersectionObserver`, and this is a test of the table's pages.
 */
async function openOverview(count: number) {
  visit("/jobs/");
  const rendered = renderApp({
    handlers: {
      "GET /meta/permissions": {
        body: permissionsFixture({ "metrics.read": false }),
      },
      "GET /queues": { body: { items: queues(count) } },
    },
  });
  const table = await page().findByRole("table", { name: "Queues" });
  return { ...rendered, table };
}

describe("the Overview's queue table", () => {
  it("pages at 20, and Next shows the rows after the first page", async () => {
    const { table } = await openOverview(25);
    expect(rowIds(table)).toHaveLength(20);
    expect(rowIds(table)[0]).toBe("queue-row-q-00");
    expect(requirePager("Queue pages").textContent).toContain("1–20 of 25");

    turn("Queue pages", "Next");
    await waitFor(() => expect(rowIds(table)).toHaveLength(5));
    expect(rowIds(table)[0]).toBe("queue-row-q-20");
    expect(requirePager("Queue pages").textContent).toContain("21–25 of 25");

    turn("Queue pages", "Previous");
    await waitFor(() => expect(rowIds(table)[0]).toBe("queue-row-q-00"));
  });

  it("changes the window with the rows-per-page select", async () => {
    const { table } = await openOverview(25);
    setPageSize("Queue pages", 10);
    await waitFor(() => expect(rowIds(table)).toHaveLength(10));
    expect(rowIds(table).at(-1)).toBe("queue-row-q-09");
  });

  it("has no pager when the queues fit one page", async () => {
    const { table } = await openOverview(20);
    expect(rowIds(table)).toHaveLength(20);
    expect(pagerCount("Queue pages")).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The Workers page: one pager per server section
 * ------------------------------------------------------------------ */

/** `count` live workers, all on one server, so they land in one section. */
function serverWorkers(count: number): WorkerDto[] {
  const at = (index: number): WorkerDto =>
    workerFixture({
      id: `api.emails.${String(index).padStart(2, "0")}`,
      key: `api.emails.${index}`,
      host: "api-1",
      pid: 100,
    });
  return Array.from({ length: count }, (_unused, index) => at(index));
}

/** `/workers` with `count` workers on one server. */
async function openWorkers(count: number) {
  visit("/jobs/workers");
  const rendered = renderApp({
    handlers: { "GET /workers": { body: { items: serverWorkers(count) } } },
  });
  await page().findByTestId("workers-list");
  const section = await page().findByTestId("worker-server-api-1:100");
  return { ...rendered, section };
}

/** The pager of the one server section on the Workers page. */
const SERVER_PAGER = "Pages of Workers on api-1 · pid 100";

describe("the Workers page", () => {
  it("pages each server's table at 25, inside its service card", async () => {
    const { section } = await openWorkers(30);
    const table = within(section).getByRole("table");
    expect(rowIds(table)).toHaveLength(25);
    expect(rowIds(table)[0]).toBe("worker-row-api.emails.00");
    // The pager belongs to the server's table, inside its service card.
    expect(section.contains(requirePager(SERVER_PAGER))).toBe(true);
    // The heading still counts every worker on the server, not the page.
    expect(section.textContent).toContain("30 workers");

    turn(SERVER_PAGER, "Next");
    await waitFor(() => expect(rowIds(table)).toHaveLength(5));
    expect(rowIds(table)[0]).toBe("worker-row-api.emails.25");
  });

  it("changes the window with the rows-per-page select", async () => {
    const { section } = await openWorkers(30);
    setPageSize(SERVER_PAGER, 10);
    const table = within(section).getByRole("table");
    await waitFor(() => expect(rowIds(table)).toHaveLength(10));
  });

  it("has no pager when a server's workers fit one page", async () => {
    const { section } = await openWorkers(25);
    expect(rowIds(within(section).getByRole("table"))).toHaveLength(25);
    expect(pagerCount(SERVER_PAGER)).toBe(0);
  });

  it("keeps a column decided over every worker, not the page", async () => {
    // Only the last worker reports memory: the column must still be there on
    // the first page, where no row does.
    const items = serverWorkers(30).map((worker, index) =>
      index === 29 ? worker : { ...worker, rssBytes: undefined },
    );
    visit("/jobs/workers");
    renderApp({ handlers: { "GET /workers": { body: { items } } } });
    const section = await page().findByTestId("worker-server-api-1:100");
    const table = within(section).getByRole("table");
    expect(rowIds(table)).toHaveLength(25);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toContain("Memory");
  });
});

/* ------------------------------------------------------------------ *
 * A queue's Workers panel and a worker page's Instances card
 * ------------------------------------------------------------------ */

describe("a queue's Workers panel", () => {
  const LABEL = "Pages of Workers of emails";

  /** The `emails` queue's Workers panel with `count` workers. */
  async function open(count: number) {
    const at = (index: number): WorkerDto =>
      workerFixture({
        id: `w-${String(index).padStart(2, "0")}`,
        key: `k-${index}`,
        queue: "emails",
      });
    const items = Array.from({ length: count }, (_unused, index) => at(index));
    renderQueue({
      path: "/queues/emails?panel=workers",
      handlers: { "GET /queues/emails/workers": { body: { items } } },
    });
    return page().findByRole("table", { name: "Workers of emails" });
  }

  it("pages at 25 and turns to the rest", async () => {
    const table = await open(30);
    expect(rowIds(table)).toHaveLength(25);
    turn(LABEL, "Next");
    await waitFor(() => expect(rowIds(table)).toHaveLength(5));
    expect(rowIds(table)[0]).toBe("worker-row-w-25");
  });

  it("changes the window with the rows-per-page select", async () => {
    const table = await open(30);
    setPageSize(LABEL, 10);
    await waitFor(() => expect(rowIds(table)).toHaveLength(10));
  });

  it("has no pager with a page of workers or fewer", async () => {
    const table = await open(3);
    expect(rowIds(table)).toHaveLength(3);
    expect(pagerCount(LABEL)).toBe(0);
  });
});

describe("a worker page's Instances card", () => {
  const LABEL = "Pages of Instances of api.emails";

  /** The `api.emails` worker page with `count` live instances. */
  async function open(count: number) {
    const at = (index: number): WorkerDto =>
      workerFixture({ id: `api.emails.${String(index).padStart(2, "0")}` });
    const items = Array.from({ length: count }, (_unused, index) => at(index));
    visit("/jobs/workers/emails/api.emails");
    renderApp({
      handlers: {
        "GET /workers": { body: { items } },
        "GET /queues/emails/analytics/workers/api.emails": { status: 404 },
      },
    });
    const card = await page().findByTestId("worker-instances");
    return within(card).findByRole("table");
  }

  it("pages one key's instances at 10", async () => {
    const table = await open(12);
    expect(rowIds(table)).toHaveLength(10);
    turn(LABEL, "Next");
    await waitFor(() => expect(rowIds(table)).toHaveLength(2));
    expect(rowIds(table)[0]).toBe("worker-row-api.emails.10");
  });

  it("changes the window with the rows-per-page select", async () => {
    const table = await open(12);
    setPageSize(LABEL, 20);
    await waitFor(() => expect(rowIds(table)).toHaveLength(12));
    expect(pagerCount(LABEL)).toBe(0);
  });

  it("has no pager for the usual one or two instances", async () => {
    const table = await open(2);
    expect(rowIds(table)).toHaveLength(2);
    expect(pagerCount(LABEL)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * A queue's repeatables panel
 * ------------------------------------------------------------------ */

describe("the repeatables panel", () => {
  const LABEL = "Repeatable pages";

  /** The `emails` queue's repeatables panel with `count` series. */
  async function open(count: number) {
    const one = repeatablesFixture.items[0]!;
    const items: RepeatableDto[] = Array.from(
      { length: count },
      (_unused, index) => ({
        ...one,
        key: `series-${String(index).padStart(2, "0")}`,
        name: `series-${index}`,
        nextRunAt: QUEUE_NOW + index * 1_000,
      }),
    );
    renderQueue({
      path: "/queues/emails?panel=repeatables",
      handlers: { "GET /queues/emails/repeatables": { body: { items } } },
    });
    return page().findByRole("table", { name: "Repeatables of emails" });
  }

  it("pages at 20 and turns to the rest", async () => {
    const table = await open(25);
    expect(rowIds(table)).toHaveLength(20);
    expect(rowIds(table)[0]).toBe("repeatable-row-series-00");
    turn(LABEL, "Next");
    await waitFor(() => expect(rowIds(table)).toHaveLength(5));
    expect(rowIds(table)[0]).toBe("repeatable-row-series-20");
  });

  it("changes the window with the rows-per-page select", async () => {
    const table = await open(25);
    setPageSize(LABEL, 10);
    await waitFor(() => expect(rowIds(table)).toHaveLength(10));
  });

  it("has no pager on a queue with a handful of series", async () => {
    const table = await open(2);
    expect(rowIds(table)).toHaveLength(2);
    expect(pagerCount(LABEL)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The runners list: its window is in the URL
 * ------------------------------------------------------------------ */

/** `/runners` with `count` remote runners named `r-00`, `r-01`, …. */
async function openRunners(count: number, query = "") {
  const items = Array.from({ length: count }, (_unused, index) => ({
    id: `r-${String(index).padStart(2, "0")}`,
    local: false,
    isLocal: false,
    isPaused: false,
    isRunning: false,
  }));
  renderRunner({
    path: `/runners${query}`,
    handlers: { "GET /runners": { body: { ...runnerListFixture(), items } } },
  });
  return page().findByRole("table", { name: "Runners" });
}

describe("the runners list", () => {
  it("pages at 25, keeping the window in the URL", async () => {
    const table = await openRunners(30);
    expect(rowIds(table)).toHaveLength(25);
    expect(window.location.search).toBe("");

    turn("Runner pages", "Next");
    await waitFor(() => expect(rowIds(table)).toHaveLength(5));
    expect(rowIds(table)[0]).toBe("runner-row-r-25");
    expect(window.location.search).toBe("?offset=25");
  });

  it("starts from the window in the URL, and the size select writes it", async () => {
    const table = await openRunners(30, "?offset=25");
    expect(rowIds(table)).toHaveLength(5);

    setPageSize("Runner pages", 10);
    await waitFor(() => expect(rowIds(table)).toHaveLength(10));
    expect(rowIds(table)[0]).toBe("runner-row-r-20");
    expect(new URLSearchParams(window.location.search).get("limit")).toBe("10");
  });

  it("restarts paging when the filter changes", async () => {
    const table = await openRunners(30);
    turn("Runner pages", "Next");
    await waitFor(() => expect(window.location.search).toBe("?offset=25"));
    fireEvent.change(page().getByLabelText("Filter runners by id or name"), {
      target: { value: "r-0" },
    });
    await waitFor(() => expect(rowIds(table)).toHaveLength(10));
    expect(new URLSearchParams(window.location.search).has("offset")).toBe(
      false,
    );
  });

  it("has no pager with a page of runners or fewer", async () => {
    const table = await openRunners(25);
    expect(rowIds(table)).toHaveLength(25);
    expect(pagerCount("Runner pages")).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * A runner's history: paged within the runs fetched
 * ------------------------------------------------------------------ */

/** `count` finished runs, newest first, named `run-00`, `run-01`, …. */
function runs(count: number): RunRecordDto[] {
  const at = (index: number): RunRecordDto =>
    runFixture({
      runId: `run-${String(index).padStart(2, "0")}`,
      startedAt: Date.now() - index * 60_000,
      logLines: 3,
    });
  return Array.from({ length: count }, (_unused, index) => at(index));
}

/** The `nightly` runner screen with `count` runs in its history. */
async function openHistory(count: number, query = "") {
  renderRunner({
    path: `/runners/nightly${query}`,
    handlers: {
      "GET /runners/nightly/history": {
        body: historyFixture({ items: runs(count) }),
      },
      "GET /runners/nightly/runs/run-27/logs": {
        body: { runId: "run-27", lines: [], nextCursor: null, dropped: 0 },
      },
    },
  });
  return page().findByRole("table", { name: "Run history" });
}

describe("a runner's history", () => {
  it("pages the runs fetched at 25, and says that is what it pages", async () => {
    const table = await openHistory(30);
    expect(rowIds(table)).toHaveLength(25);
    expect(rowIds(table)[0]).toBe("history-row-run-00");
    expect(page().getByTestId("history-paging-note").textContent).toContain(
      "Runs shown",
    );

    turn("History pages", "Next");
    await waitFor(() => expect(rowIds(table)).toHaveLength(5));
    expect(rowIds(table)[0]).toBe("history-row-run-25");
  });

  it("changes the window with the rows-per-page select", async () => {
    const table = await openHistory(30);
    setPageSize("History pages", 10);
    await waitFor(() => expect(rowIds(table)).toHaveLength(10));
    expect(rowIds(table).at(-1)).toBe("history-row-run-09");
  });

  it("opens the page holding the run whose log the URL names", async () => {
    // `run-27` is on the second page, so a ?logs= link would otherwise open
    // nothing at all.
    const table = await openHistory(30, "?logs=run-27");
    await waitFor(() =>
      expect(
        table.querySelector('[data-testid="history-row-run-27"]'),
      ).toBeTruthy(),
    );
    expect(requirePager("History pages").textContent).toContain("26–30 of 30");
  });

  it("has no pager when the runs fetched fit one page", async () => {
    const table = await openHistory(25);
    expect(rowIds(table)).toHaveLength(25);
    expect(pagerCount("History pages")).toBe(0);
    expect(
      document.querySelectorAll('[data-testid="history-paging-note"]').length,
    ).toBe(0);
  });

  it("reads nothing more to turn a page", async () => {
    const { calls } = renderRunner({
      path: "/runners/nightly",
      handlers: {
        "GET /runners/nightly/history": {
          body: historyFixture({ items: runs(30) }),
        },
      },
    });
    const table = await page().findByRole("table", { name: "Run history" });
    const reads = () =>
      calls.filter((call) => call.path === "/runners/nightly/history").length;
    const before = reads();
    turn("History pages", "Next");
    await waitFor(() => expect(rowIds(table)[0]).toBe("history-row-run-25"));
    expect(reads()).toBe(before);
  });
});
