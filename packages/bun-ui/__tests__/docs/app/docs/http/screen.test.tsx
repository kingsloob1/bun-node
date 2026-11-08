import type { SpecDocument } from "../../../../../app/docs/api/docs";
import { beforeAll, describe, expect, it } from "bun:test";
import { expectAbsent, expectUndefined } from "../../assert";
import { fireEvent, page, setupDom, waitFor, within } from "../../dom";
import type { RenderViewerOptions } from "../../renderViewer";
import { renderViewer } from "../../renderViewer";
import { openApiFixture } from "./openapiFixture";

setupDom();

const CSRF = "x-bun-jobs-csrf";
let doc: SpecDocument;

beforeAll(async () => {
  doc = await openApiFixture({ csrfHeader: CSRF });
});

/** Renders the viewer at an HTTP-reference path, serving the real document. */
async function open(path: string, options: Partial<RenderViewerOptions> = {}) {
  const result = await renderViewer({
    ...options,
    document: options.document ?? doc,
    path: `/http${path}`,
    config: { csrfHeader: CSRF, ...options.config },
  });
  await page().findByTestId("http-docs", {}, { timeout: 5_000 });
  return result;
}

/** Waits for an operation's view. */
async function operation(): Promise<HTMLElement> {
  return page().findByTestId("http-operation", {}, { timeout: 3_000 });
}

/** The try-it panel. */
function panel(): HTMLElement {
  return page().getByTestId("tryit");
}

/** Sets a try-it field by its label's parameter name. */
function fill(name: string, value: string) {
  const field = within(panel())
    .getAllByText(name, { selector: "code" })
    .map((code) => code.closest(".field"))
    .find(Boolean) as HTMLElement;
  const input = field.querySelector("input, select, textarea")!;
  fireEvent.change(input, { target: { value } });
}

/** Clicks the panel's Send button. */
function send(method: string) {
  fireEvent.click(
    within(panel()).getByRole("button", { name: `Send ${method}` }),
  );
}

/** The open dialog. */
async function dialog(): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = document.querySelector<HTMLElement>("dialog[open]");
    if (!found) {
      throw new Error("no dialog");
    }
  });
  return found!;
}

describe("the HTTP reference", () => {
  it("redirects / to it and lists operations by tag in the document's order, with method badges", async () => {
    await renderViewer({ document: doc, path: "" });
    const nav = await page().findByRole(
      "navigation",
      { name: "Operations" },
      { timeout: 5_000 },
    );
    expect(window.location.pathname).toBe("/docs/http");
    const tags = within(nav)
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(tags).toEqual([
      "Meta",
      "Docs",
      "Queues",
      "Workers",
      "Jobs",
      "Runners",
      "Analytics",
    ]);
    const pause = nav.querySelector('a[data-operation="pauseQueue"]')!;
    expect(pause.querySelector(".http-method")!.textContent).toBe("POST");
    expect(pause.textContent).toContain("/queues/{queue}/pause");
    expect(pause.getAttribute("href")).toBe("/docs/http/pauseQueue");
  });

  it("shows the info header with the relative server resolved", async () => {
    await open("");
    expect(page().getByRole("heading", { level: 1 }).textContent).toBe(
      "bun-jobs management API (shop)",
    );
    expect(page().getByTestId("http-server-url").textContent).toBe(
      `${window.location.origin}/jobs-api`,
    );
    expect(page().getByTestId("http-request-base").textContent).toBe(
      `${window.location.origin}/jobs-api`,
    );
    expect(page().getByTestId("http-components").textContent).toContain(
      "Problem",
    );
  });

  it("searches from ?q= and writes the search back to the URL", async () => {
    await open("?q=post%20pause");
    const nav = page().getByRole("navigation", { name: "Operations" });
    const links = () =>
      Array.from(nav.querySelectorAll<HTMLAnchorElement>("a.http-op-link"));
    // The search reads the summary too: resumeWorker's says "paused".
    await waitFor(() => {
      expect(links().map((link) => link.dataset.operation)).toEqual([
        "pauseQueue",
        "pauseWorker",
        "resumeWorker",
        "startWorker",
        "pauseRunner",
      ]);
    });
    const search = within(nav).getByLabelText("Search operations");
    fireEvent.change(search, { target: { value: "listqueues" } });
    await waitFor(() => {
      expect(window.location.search).toContain("q=listqueues");
      expect(links().map((link) => link.dataset.operation)).toEqual([
        "listQueues",
      ]);
    });
  });

  it("shows an operation: path, markers, CSRF note, parameters and responses with codes", async () => {
    await open("/pauseQueue");
    const view = await operation();
    expect(within(view).getByTestId("op-path").textContent).toBe(
      "/queues/{queue}/pause",
    );
    // The permission is named, without a have/lack marker (a standalone
    // viewer knows no permissions).
    expect(within(view).getByTestId("op-permission").textContent).toContain(
      "queues.pause",
    );
    expect(within(view).getByTestId("op-mutation").textContent).toBe(
      "Mutation",
    );
    expect(within(view).getByTestId("op-csrf").textContent).toContain(CSRF);
    expect(within(view).getByTestId("op-csrf").textContent).toContain(
      "The app sends it.",
    );
    const parameters = within(view).getByTestId("op-parameters");
    expect(parameters.textContent).toContain("queue");
    const responses = within(view).getByTestId("op-responses");
    expect(responses.textContent).toContain("QUEUE_NOT_FOUND");
    expect(responses.textContent).toContain("CSRF_REJECTED");
  });

  it("shows the driver requirements an operation declares", async () => {
    await open("/getJobLogs");
    const view = await operation();
    expect(within(view).getByTestId("op-requires").textContent).toContain(
      "getJobLogs",
    );
  });

  it("an operation without the extensions under a known prefix shows no markers from them", async () => {
    // Rename every extension to a prefix the viewer does not read: nothing
    // shows, and nothing crashes.
    const renamed = structuredClone(doc) as Record<string, never>;
    for (const item of Object.values(renamed.paths ?? {}) as Record<
      string,
      Record<string, unknown>
    >[]) {
      for (const operation of Object.values(item)) {
        if (operation === null || typeof operation !== "object") {
          continue;
        }
        for (const key of Object.keys(operation)) {
          if (key.startsWith("x-bun-jobs-")) {
            operation[`x-acme-${key.slice("x-bun-jobs-".length)}`] =
              operation[key];
            delete operation[key];
          }
        }
      }
    }
    await open("/pauseQueue", { document: renamed });
    const view = await operation();
    expectAbsent(within(view).queryByTestId("op-permission"));
    expectAbsent(within(view).queryByTestId("op-csrf"));
    // Not known as a mutation anymore: no Mutation badge, no confirm dialog.
    expect(within(view).getByTestId("op-mutation").textContent).toBe("Read");
  });

  it("reads the same extensions under x-bun-common when configured first", async () => {
    const moved = structuredClone(doc) as Record<string, never>;
    for (const item of Object.values(moved.paths ?? {}) as Record<
      string,
      Record<string, unknown>
    >[]) {
      for (const operation of Object.values(item)) {
        if (operation === null || typeof operation !== "object") {
          continue;
        }
        for (const key of Object.keys(operation)) {
          if (key.startsWith("x-bun-jobs-")) {
            operation[`x-bun-common-${key.slice("x-bun-jobs-".length)}`] =
              operation[key];
            delete operation[key];
          }
        }
      }
    }
    await open("/pauseQueue", { document: moved });
    const view = await operation();
    expect(within(view).getByTestId("op-permission").textContent).toContain(
      "queues.pause",
    );
    expect(within(view).getByTestId("op-mutation").textContent).toBe(
      "Mutation",
    );
  });

  it("links a component schema into the side panel", async () => {
    await open("");
    fireEvent.click(
      within(page().getByTestId("http-components")).getByRole("button", {
        name: "Job",
      }),
    );
    const panelDialog = await dialog();
    // The Job schema's fields, drawn as a tree.
    expect(panelDialog.textContent).toContain("queue");
    expect(panelDialog.textContent).toContain("state");
  });

  it("explains an unknown operation", async () => {
    await open("/noSuchOperation");
    await page().findByText("No such operation", {}, { timeout: 3_000 });
    expect(
      page().getByRole("link", { name: "All operations" }).getAttribute("href"),
    ).toBe("/docs/http");
  });

  it("sends a read through the viewer's client and shows the body, status and timing", async () => {
    const { calls } = await open("/listQueues", {
      canned: { status: 200, body: { queues: ["mail"] } },
    });
    await operation();
    send("GET");
    await page().findByTestId("tryit-result", {}, { timeout: 3_000 });
    expect(page().getByTestId("tryit-status").textContent).toBe("200");
    expect(page().getByTestId("tryit-result").textContent).toContain("mail");
    expect(page().getByTestId("tryit-timing").textContent).toContain("ms");
    const sent = calls.find(
      (call) => call.method === "GET" && call.url !== "/docs/document.json",
    )!;
    expect(sent.url).toBe(`${window.location.origin}/jobs-api/queues`);
    expect(sent.headers.accept).toBe("application/json");
  });

  it("builds query arrays as repeated keys, and percent-encodes path params", async () => {
    const { calls } = await open("/getJob");
    await operation();
    fill("queue", "my queue");
    fill("id", "a/b");
    send("GET");
    await page().findByTestId("tryit-result", {}, { timeout: 3_000 });
    const sent = calls.find((call) => call.url.includes("/jobs/"))!;
    expect(sent.url).toBe(
      `${window.location.origin}/jobs-api/queues/my%20queue/jobs/a%2Fb`,
    );
  });

  it("confirms a mutation, then sends it bodiless with Content-Type and the CSRF header", async () => {
    const { calls } = await open("/pauseQueue");
    await operation();
    fill("queue", "mail");
    send("POST");
    const confirm = await dialog();
    fireEvent.click(within(confirm).getByRole("button", { name: "Send POST" }));
    await page().findByTestId("tryit-result", {}, { timeout: 3_000 });
    const sent = calls.find((call) => call.method === "POST")!;
    expect(sent.url).toBe(
      `${window.location.origin}/jobs-api/queues/mail/pause`,
    );
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(sent.headers[CSRF]).toBe("1");
    expectUndefined(sent.body);
  });

  it("needs the operation id typed before a destructive send", async () => {
    const { calls } = await open("/removeJob");
    await operation();
    fill("queue", "mail");
    fill("id", "42");
    send("DELETE");
    const confirm = await dialog();
    const button = within(confirm).getByRole("button", { name: "Send DELETE" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(confirm).getByRole("textbox"), {
      target: { value: "removeJob" },
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await page().findByTestId("tryit-result", {}, { timeout: 3_000 });
    const sent = calls.find((call) => call.method === "DELETE")!;
    expect(sent.url).toBe(
      `${window.location.origin}/jobs-api/queues/mail/jobs/42`,
    );
  });

  it("renders a problem answer with the problem banner", async () => {
    await open("/getQueue", {
      canned: {
        status: 404,
        body: {
          type: "urn:test:error:QUEUE_NOT_FOUND",
          title: "Queue not found",
          status: 404,
          code: "QUEUE_NOT_FOUND",
          detail: "No queue named mail.",
        },
      },
    });
    await operation();
    fill("queue", "mail");
    send("GET");
    await page().findByTestId("tryit-result", {}, { timeout: 3_000 });
    expect(page().getByTestId("tryit-status").textContent).toBe("404");
    expect(page().getByText("No queue named mail.")).toBeTruthy();
    expect(page().getByTestId("tryit-result").textContent).toContain(
      "QUEUE_NOT_FOUND",
    );
  });

  it("refuses to send with a missing path parameter, and says why", async () => {
    const { calls } = await open("/getQueue");
    await operation();
    send("GET");
    await page().findByText("queue is required", {}, { timeout: 3_000 });
    expect(calls.some((call) => call.url.includes("/queues/"))).toBe(false);
  });

  it("shows curl and fetch() snippets matching the request", async () => {
    await open("/pauseQueue");
    await operation();
    fill("queue", "mail");
    await page().findByTestId("snippet-curl", {}, { timeout: 3_000 });
    const curl = page().getByTestId("snippet-curl").textContent!;
    expect(curl).toContain(
      `curl -X POST '${window.location.origin}/jobs-api/queues/mail/pause'`,
    );
    expect(curl).toContain(`-H '${CSRF}: 1'`);
    fireEvent.click(within(panel()).getByRole("tab", { name: "fetch()" }));
    const fetched = page().getByTestId("snippet-fetch").textContent!;
    expect(fetched).toContain('method: "POST"');
    expect(fetched).toContain(`"${CSRF}": "1"`);
  });
});

describe("sections (x-tagGroups)", () => {
  /** The real document, with two sections over some of its tags. */
  function sectioned(): SpecDocument {
    return {
      ...doc,
      "x-tagGroups": [
        { name: "Operate", tags: ["Queues", "Workers", "Jobs"] },
        { name: "Schedule", tags: ["Runners"] },
      ],
    };
  }

  /** The sidebar's headings at a level, in order. */
  function headings(nav: HTMLElement, level: 2 | 3): (string | null)[] {
    return within(nav)
      .queryAllByRole("heading", { level })
      .map((heading) => heading.textContent);
  }

  /** The section names, each with its nested tag names. */
  function tree(nav: HTMLElement): [string | null, (string | null)[]][] {
    return Array.from(nav.querySelectorAll<HTMLElement>(".http-section")).map(
      (section) => [
        section.querySelector("h2")!.textContent,
        Array.from(section.querySelectorAll("h3")).map(
          (heading) => heading.textContent,
        ),
      ],
    );
  }

  it("lists the sections as top-level headings with their tags nested, the rest under Other", async () => {
    await open("", { document: sectioned() });
    const nav = page().getByRole("navigation", { name: "Operations" });
    expect(headings(nav, 2)).toEqual(["Operate", "Schedule", "Other"]);
    expect(tree(nav)).toEqual([
      ["Operate", ["Queues", "Workers", "Jobs"]],
      ["Schedule", ["Runners"]],
      ["Other", ["Meta", "Docs", "Analytics"]],
    ]);
    // A link sits under its tag inside its section.
    const pause = nav.querySelector('a[data-operation="pauseQueue"]')!;
    expect(
      pause.closest(".http-section")!.querySelector("h2")!.textContent,
    ).toBe("Operate");
    expect(pause.closest(".http-tag")!.querySelector("h3")!.textContent).toBe(
      "Queues",
    );
    // The landing view: one card per section, its tags inside.
    const landing = document.querySelector<HTMLElement>(".http-overview")!;
    expect(
      within(landing)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Operate", "Schedule", "Other", "Schemas"]);
    const overview = within(landing).getAllByRole("region", {
      name: "Operate",
    });
    expect(overview.length).toBe(1);
    expect(
      within(overview[0])
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Queues", "Workers", "Jobs"]);
  });

  it("without x-tagGroups, lists the tags at the top level with no section (the control)", async () => {
    await open("");
    const nav = page().getByRole("navigation", { name: "Operations" });
    expect(headings(nav, 3)).toEqual([]);
    expect(nav.querySelectorAll(".http-section").length).toBe(0);
    expect(headings(nav, 2)).toEqual([
      "Meta",
      "Docs",
      "Queues",
      "Workers",
      "Jobs",
      "Runners",
      "Analytics",
    ]);
  });

  it("drops the sections a search leaves empty", async () => {
    await open("?q=killrunner", { document: sectioned() });
    const nav = page().getByRole("navigation", { name: "Operations" });
    await waitFor(() => {
      expect(tree(nav)).toEqual([["Schedule", ["Runners"]]]);
    });
    expect(
      Array.from(nav.querySelectorAll<HTMLAnchorElement>("a.http-op-link")).map(
        (link) => link.dataset.operation,
      ),
    ).toEqual(["killRunner"]);
  });
});
