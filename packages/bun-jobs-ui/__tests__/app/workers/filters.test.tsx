import type { WorkerDto } from "../../../app/api/types";
import type { RecordedCall } from "../mockFetch";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { workerKeys } from "../../../app/api/workers";
import {
  readWorkerFilters,
  workerListQuery,
} from "../../../app/screens/workers/filters";
import { fireEvent, page, setupDom, visit, waitFor, within } from "../dom";
import { renderApp } from "../renderApp";
import { workerFixture } from "./fixtures";

setupDom();

/** Three workers over two queues, two services and two hosts. */
const WORKERS: WorkerDto[] = [
  workerFixture({
    id: "api.emails.a1",
    key: "api.emails",
    service: "api",
    queue: "emails",
    host: "api-1",
    pid: 100,
  }),
  workerFixture({
    id: "api.emails.b2",
    key: "api.emails",
    service: "api",
    queue: "emails",
    host: "api-2",
    pid: 200,
    state: "paused",
    paused: true,
  }),
  workerFixture({
    id: "cron.reports.c3",
    key: "cron.reports",
    service: "cron",
    queue: "reports",
    host: "api-1",
    pid: 101,
  }),
];

/** `WORKERS` as an API with `serialize.exposeHosts: false` sends them. */
const HIDDEN = WORKERS.map(({ host: _host, pid: _pid, ...rest }) => rest);

/**
 * Opens `/workers` (with `search`) against a `GET /workers` that filters the
 * way the API does — exact, ANDed — so the page shows what it asked for.
 */
async function open(search = "", items: WorkerDto[] = WORKERS) {
  visit(`/jobs/workers${search}`);
  const rendered = renderApp({
    handlers: {
      "GET /workers": ({ query }) => {
        if (query.has("host") && items.every((w) => w.host === undefined)) {
          return {
            status: 400,
            body: {
              type: "urn:bun-jobs:error:INVALID_ARGUMENT",
              title: "This API does not expose worker hosts",
              status: 400,
              code: "INVALID_ARGUMENT",
            },
          };
        }
        const match = (name: string, value: string | undefined) =>
          !query.has(name) || query.getAll(name).includes(value ?? "");
        return {
          body: {
            items: items.filter(
              (worker) =>
                match("queue", worker.queue) &&
                match("service", worker.service) &&
                match("host", worker.host) &&
                match("state", worker.state),
            ),
          },
        };
      },
    },
  });
  const screen = await page().findByTestId("workers-list");
  return { ...rendered, screen };
}

/** The `GET /workers` queries sent, as strings. */
function workerQueries(calls: readonly RecordedCall[]): string[] {
  return calls
    .filter((call) => call.method === "GET" && call.path === "/workers")
    .map((call) => call.query.toString());
}

/** The labelled select of one filter. */
function filterSelect(screen: HTMLElement, label: string): HTMLSelectElement {
  return within(screen).getByLabelText(label) as HTMLSelectElement;
}

describe("the Workers page's filters, read from the URL", () => {
  it("reads each filter, ignoring a state that is not one", () => {
    expect(
      readWorkerFilters(
        new URLSearchParams("queue=emails&service=api&host=h&state=paused"),
      ),
    ).toEqual({ queue: "emails", service: "api", host: "h", state: "paused" });
    expect(readWorkerFilters(new URLSearchParams("state=asleep")).state).toBe(
      "",
    );
  });

  it("sends host only when the API shows hosts", () => {
    const filters = readWorkerFilters(
      new URLSearchParams("queue=emails&host=api-1"),
    );
    expect(workerListQuery(filters, true)).toEqual({
      queue: ["emails"],
      host: ["api-1"],
    });
    expect(workerListQuery(filters, false)).toEqual({ queue: ["emails"] });
  });

  it("keys the unfiltered list as an empty query, and each filter apart", () => {
    expect(workerKeys.list()).toEqual(workerKeys.list({}));
    expect(workerKeys.list({ queue: ["emails"] })).not.toEqual(
      workerKeys.list(),
    );
    // An empty filter is not a filter.
    expect(workerKeys.list({ key: [] })).toEqual(workerKeys.list());
  });
});

describe("the Workers page's filters", () => {
  it("sends the URL's filters to GET /workers, and offers what the live list has", async () => {
    const { screen, calls } = await open("?queue=emails&state=paused");
    await within(screen).findByTestId("worker-row-api.emails.b2");
    expect(within(screen).queryByTestId("worker-row-api.emails.a1")).toBeNull();
    const queries = workerQueries(calls);
    expect(queries).toContain("queue=emails&state=paused");
    // The unfiltered read, for the choices.
    expect(queries).toContain("");
    expect(filterSelect(screen, "Queue").value).toBe("emails");
    expect(filterSelect(screen, "State").value).toBe("paused");
    await waitFor(() =>
      expect(
        Array.from(filterSelect(screen, "Service").options, (o) => o.value),
      ).toEqual(["", "api", "cron"]),
    );
    expect(
      Array.from(filterSelect(screen, "Host").options, (o) => o.value),
    ).toEqual(["", "api-1", "api-2"]);
    expect(within(screen).getByTestId("workers-count").textContent).toBe(
      "1 worker on 1 server (of 3)",
    );
  });

  it("writes a chosen filter to the URL and re-reads with it", async () => {
    const { screen, calls } = await open();
    await within(screen).findByTestId("worker-row-cron.reports.c3");
    await waitFor(() =>
      expect(
        Array.from(filterSelect(screen, "Service").options, (o) => o.value),
      ).toContain("cron"),
    );
    fireEvent.change(filterSelect(screen, "Service"), {
      target: { value: "cron" },
    });
    await waitFor(() => expect(window.location.search).toBe("?service=cron"));
    await waitFor(() => expect(workerQueries(calls)).toContain("service=cron"));
    await waitFor(() =>
      expect(
        within(screen).queryByTestId("worker-row-api.emails.a1"),
      ).toBeNull(),
    );
    fireEvent.change(filterSelect(screen, "Host"), {
      target: { value: "api-1" },
    });
    await waitFor(() =>
      expect(window.location.search).toBe("?service=cron&host=api-1"),
    );
    await waitFor(() =>
      expect(workerQueries(calls)).toContain("service=cron&host=api-1"),
    );
    // Clearing puts every filter back to "any", and keeps the search.
    fireEvent.click(
      within(screen).getByRole("button", { name: "Clear filters" }),
    );
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("offers no host filter when the API hides hosts, and ignores one in the link", async () => {
    const { screen, calls } = await open("?host=api-1&queue=emails", HIDDEN);
    await within(screen).findByTestId("worker-row-api.emails.a1");
    expect(within(screen).queryByLabelText("Host")).toBeNull();
    expect(
      within(screen).getByTestId("workers-host-ignored").textContent,
    ).toContain("api-1");
    // No request ever carried the host the API would refuse.
    for (const query of workerQueries(calls)) {
      expect(new URLSearchParams(query).has("host")).toBe(false);
    }
    expect(workerQueries(calls)).toContain("queue=emails");
  });

  it("says when nothing matches the filters, with a way out", async () => {
    const { screen } = await open("?queue=reports&state=paused");
    expect(
      await within(screen).findByText("No workers match these filters"),
    ).toBeTruthy();
    fireEvent.click(
      within(screen).getAllByRole("button", { name: "Clear filters" })[0]!,
    );
    await within(screen).findByTestId("worker-row-api.emails.a1");
  });

  it("keeps the in-browser search beside the server-side filters", async () => {
    const { screen, calls } = await open("?queue=emails");
    await within(screen).findByTestId("worker-row-api.emails.a1");
    fireEvent.change(within(screen).getByRole("searchbox"), {
      target: { value: "api-2" },
    });
    await waitFor(() =>
      expect(within(screen).getByTestId("workers-count").textContent).toBe(
        "1 worker on 1 server (of 3)",
      ),
    );
    expect(window.location.search).toBe("?queue=emails&search=api-2");
    // The search is the browser's: it sent nothing new.
    expect(workerQueries(calls).some((q) => q.includes("search"))).toBe(false);
  });

  it("links each row to its key's page, and a row with no key nowhere", async () => {
    const { screen } = await open("", [
      ...WORKERS,
      workerFixture({ id: "old-one", key: undefined, queue: "emails" }),
    ]);
    const a1 = await within(screen).findByTestId(
      "worker-key-link-api.emails.a1",
    );
    const b2 = within(screen).getByTestId("worker-key-link-api.emails.b2");
    expect(a1.getAttribute("href")).toBe("/jobs/workers/emails/api.emails");
    // Every instance of a key leads to the same page.
    expect(b2.getAttribute("href")).toBe(a1.getAttribute("href"));
    await within(screen).findByTestId("worker-row-old-one");
    expect(within(screen).queryByTestId("worker-key-link-old-one")).toBeNull();
  });
});

describe("the filter row's layout", () => {
  it("puts the search inside the filter row, never straight in the column-flex .screen", async () => {
    const { screen } = await open();
    const search = within(screen).getByRole("searchbox").closest(".search")!;
    expect(search.parentElement?.classList.contains("worker-filters")).toBe(
      true,
    );
    expect(search.parentElement?.classList.contains("screen")).toBe(false);
  });

  it("lays the filter row out as a row", async () => {
    const css = await Bun.file(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "app",
        "screens",
        "workers",
        "workers.css",
      ),
    ).text();
    const rule = /\.worker-filters\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    // In a column, `.search`'s `flex: 0 1 260px` would be a height again.
    expect(rule).toMatch(/display:\s*flex;/);
    expect(rule).toMatch(/flex-direction:\s*row;/);
  });
});
