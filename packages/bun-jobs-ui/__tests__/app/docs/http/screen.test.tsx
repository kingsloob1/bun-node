import type { SpecDocument } from "../../../../app/api/docs";
import type { RenderAppOptions } from "../../renderApp";
import { beforeAll, describe, expect, it } from "bun:test";
import { fireEvent, page, setupDom, visit, waitFor, within } from "../../dom";
import { metaFixture, permissionsFixture, problem } from "../../fixtures";
import { renderApp } from "../../renderApp";
import { openApiFixture } from "./openapiFixture";

setupDom();

const CSRF = "x-bun-jobs-csrf";
let doc: SpecDocument;

beforeAll(async () => {
  doc = await openApiFixture({ csrfHeader: CSRF });
});

/** Renders the app at an HTTP-reference path, serving the real document. */
function open(path: string, options: RenderAppOptions = {}) {
  visit(`/jobs/docs/http${path}`);
  return renderApp({
    ...options,
    config: { csrfHeader: CSRF, ...options.config },
    handlers: { "GET /openapi.json": { body: doc }, ...options.handlers },
  });
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
  it("lists operations by tag in the document's order, with method badges", async () => {
    open("");
    const nav = await page().findByRole("navigation", { name: "Operations" });
    const tags = within(nav)
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(tags).toEqual(["Meta", "Docs", "Queues", "Jobs", "Runners"]);
    const pause = nav.querySelector('a[data-operation="pauseQueue"]')!;
    expect(pause.querySelector(".http-method")!.textContent).toBe("POST");
    expect(pause.textContent).toContain("/queues/{queue}/pause");
    expect(pause.getAttribute("href")).toBe("/jobs/docs/http/pauseQueue");
  });

  it("shows the info header with the relative server resolved", async () => {
    open("");
    await page().findByTestId("http-servers");
    expect(page().getByRole("heading", { level: 1 }).textContent).toBe(
      "bun-jobs management API (shop)",
    );
    expect(page().getByTestId("http-server-url").textContent).toBe(
      `${window.location.origin}/jobs-api`,
    );
    expect(page().getByTestId("http-components").textContent).toContain(
      "Problem",
    );
  });

  it("searches from ?q=, keeps the search on links, and moves by keyboard", async () => {
    open("?q=post%20pause");
    const nav = await page().findByRole("navigation", { name: "Operations" });
    const links = () =>
      Array.from(nav.querySelectorAll<HTMLAnchorElement>("a.http-op-link"));
    await waitFor(() =>
      expect(links().map((link) => link.dataset.operation)).toEqual([
        "pauseQueue",
        "pauseRunner",
      ]),
    );
    expect(links()[0]!.getAttribute("href")).toBe(
      "/jobs/docs/http/pauseQueue?q=post%20pause",
    );
    const search = within(nav).getByRole("searchbox", {
      name: "Search operations",
    });
    expect((search as HTMLInputElement).value).toBe("post pause");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(links()[0]!);
    fireEvent.keyDown(links()[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(links()[1]!);
    fireEvent.keyDown(links()[1]!, { key: "Home" });
    expect(document.activeElement).toBe(links()[0]!);

    fireEvent.change(search, { target: { value: "killrunner" } });
    await waitFor(() => expect(window.location.search).toBe("?q=killrunner"));
    await waitFor(() =>
      expect(links().map((link) => link.dataset.operation)).toEqual([
        "killRunner",
      ]),
    );
  });

  it("shows an operation: path, markers, CSRF note, parameters and responses with codes", async () => {
    open("/pauseQueue");
    const view = await operation();
    expect(within(view).getByTestId("op-path").textContent).toBe(
      "/queues/{queue}/pause",
    );
    expect(within(view).getByRole("heading", { level: 2 }).textContent).toBe(
      "Stop every worker in every process claiming from the queue",
    );
    const permission = within(view).getByTestId("op-permission");
    expect(permission.dataset.allowed).toBe("true");
    expect(permission.textContent).toBe("You have queues.pause");
    expect(within(view).getByTestId("op-mutation").textContent).toBe(
      "Mutation",
    );
    const csrf = within(view).getByTestId("op-csrf").textContent;
    expect(csrf).toContain(CSRF);
    expect(csrf).toContain("The app sends it.");
    expect(csrf).toContain("Content-Type: application/json");

    const params = within(view).getByTestId("op-parameters");
    expect(params.querySelector('[data-param="queue"]')!.textContent).toContain(
      "required",
    );
    expect(
      params.querySelector(`[data-param="${CSRF}"]`)!.textContent,
    ).toContain("header");

    const responses = within(view).getByTestId("op-responses");
    const forbidden = responses.querySelector('[data-status="403"]')!;
    expect(forbidden.textContent).toContain("CSRF_REJECTED");
    expect(forbidden.textContent).toContain("FORBIDDEN");
    expect(
      responses.querySelector('[data-status="200"]')!.textContent,
    ).toContain("paused");
  });

  it("marks a permission the caller lacks, and turns the panel off with the reason", async () => {
    open("/drainQueue", {
      handlers: {
        "GET /meta/permissions": {
          body: permissionsFixture({ "queues.drain": false }),
        },
      },
    });
    const view = await operation();
    const permission = within(view).getByTestId("op-permission");
    expect(permission.dataset.allowed).toBe("false");
    expect(permission.textContent).toBe("You lack queues.drain");
    expect(within(view).getByTestId("tryit-disabled").textContent).toBe(
      "You do not have the queues.drain permission.",
    );
    expect(
      (
        within(panel()).getByRole("button", {
          name: "Send POST",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("turns a mutation's panel off on a read-only API", async () => {
    const readOnly = { "GET /meta": { body: metaFixture({ readOnly: true }) } };
    open("/pauseQueue", { handlers: readOnly });
    await operation();
    expect(page().getByTestId("tryit-disabled").textContent).toBe(
      "This API is read-only: it refuses every change.",
    );
  });

  it("links a component schema into the side panel", async () => {
    open("/getMeta");
    const view = await operation();
    const responses = within(view).getByTestId("op-responses");
    fireEvent.click(
      within(
        responses.querySelector('[data-status="200"]') as HTMLElement,
      ).getByRole("button", { name: "Meta" }),
    );
    const panelDialog = await dialog();
    expect(
      within(panelDialog).getByRole("heading", { name: "Meta" }),
    ).toBeTruthy();
    expect(panelDialog.textContent).toContain("namespace");
  });

  it("explains an unknown operation", async () => {
    open("/nope");
    expect((await page().findByText("No such operation")).textContent).toBe(
      "No such operation",
    );
  });
});

describe("try it", () => {
  it("sends a read through the app's client and shows the body, status and timing", async () => {
    const { calls } = open("/getMeta");
    await operation();
    send("GET");
    const result = await page().findByTestId("tryit-result");
    await waitFor(() => expect(result.textContent).toContain("namespace"));
    expect(within(result).getByTestId("tryit-status").textContent).toBe("200");
    expect(within(result).getByTestId("tryit-timing").textContent).toMatch(
      /^\d+ ms$/,
    );
    const call = calls.filter((item) => item.path === "/meta").at(-1)!;
    expect(call.headers[CSRF]).toBeUndefined();
    expect(call.headers["content-type"]).toBeUndefined();
  });

  it("builds query arrays as repeated keys, and percent-encodes path params", async () => {
    const { calls } = open("/listJobs", {
      handlers: {
        "GET /queues/a/b/jobs": { body: {} },
      },
    });
    await operation();
    fill("queue", "a/b");
    fireEvent.click(within(panel()).getByLabelText("dead"));
    fireEvent.click(within(panel()).getByLabelText("failed"));
    fill("name", "send,build");
    send("GET");
    await page().findByTestId("tryit-result");
    const call = calls.find((item) =>
      item.path.startsWith("/queues/a%2Fb/jobs"),
    )!;
    expect(call.url).toBe(
      "/jobs-api/queues/a%2Fb/jobs?state=dead&state=failed&name=send&name=build",
    );
  });

  it("confirms a mutation, then sends it bodiless with Content-Type and the CSRF header", async () => {
    const { calls } = open("/pauseQueue", {
      handlers: { "POST /queues/emails/pause": { body: { paused: true } } },
    });
    await operation();
    fill("queue", "emails");
    send("POST");
    const confirm = await dialog();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    fireEvent.click(within(confirm).getByRole("button", { name: "Send POST" }));
    const result = await page().findByTestId("tryit-result");
    await waitFor(() => expect(result.textContent).toContain("paused"));
    const call = calls.find((item) => item.method === "POST")!;
    expect(call.path).toBe("/queues/emails/pause");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers[CSRF]).toBe("1");
    expect(call.body).toBeUndefined();
  });

  it("needs the operation id typed before a destructive send", async () => {
    const { calls } = open("/drainQueue", {
      handlers: { "POST /queues/emails/drain": { body: { drained: 0 } } },
    });
    await operation();
    fill("queue", "emails");
    send("POST");
    const confirm = await dialog();
    const button = within(confirm).getByRole("button", {
      name: "Send POST",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(within(confirm).getByLabelText(/to confirm/), {
      target: { value: "drainQueue" },
    });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await page().findByTestId("tryit-result");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("prefills and sends a JSON body", async () => {
    const { calls } = open("/cleanQueue", {
      handlers: { "POST /queues/q/clean": { body: { removed: 0 } } },
    });
    await operation();
    const editor = within(panel()).getByRole("textbox", {
      name: /Body/,
    }) as HTMLTextAreaElement;
    expect(JSON.parse(editor.value)).toEqual({
      state: "completed",
      olderThan: 0,
    });
    fill("queue", "q");
    send("POST");
    fireEvent.change(within(await dialog()).getByLabelText(/to confirm/), {
      target: { value: "cleanQueue" },
    });
    fireEvent.click(
      within(await dialog()).getByRole("button", { name: "Send POST" }),
    );
    await page().findByTestId("tryit-result");
    const call = calls.find((item) => item.method === "POST")!;
    expect(JSON.parse(call.body!)).toEqual({
      state: "completed",
      olderThan: 0,
    });
  });

  it("renders a problem answer with the problem banner", async () => {
    open("/getQueue", {
      handlers: {
        "GET /queues/missing": {
          status: 404,
          body: problem(404, "QUEUE_NOT_FOUND", "Queue not found", {
            detail: "No queue missing",
          }),
        },
      },
    });
    await operation();
    fill("queue", "missing");
    send("GET");
    const result = await page().findByTestId("tryit-result");
    await waitFor(() =>
      expect(within(result).getByTestId("tryit-status").textContent).toBe(
        "404",
      ),
    );
    expect(result.textContent).toContain("QUEUE_NOT_FOUND");
    expect(
      result.querySelector(".problem-banner, [role='alert']"),
    ).toBeTruthy();
    expect(result.textContent).toContain("No queue missing");
  });

  it("refuses to send with a missing path parameter, and says why", async () => {
    const { calls } = open("/getQueue");
    await operation();
    const before = calls.length;
    send("GET");
    expect(await within(panel()).findByText("queue is required")).toBeTruthy();
    expect(calls.length).toBe(before);
  });

  it("shows curl and fetch() snippets matching the request", async () => {
    open("/pauseQueue");
    await operation();
    expect(panel().textContent).toContain("Fill in the required fields");
    fill("queue", "emails");
    const curl = await within(panel()).findByTestId("snippet-curl");
    expect(curl.textContent).toContain(
      `curl -X POST '${window.location.origin}/jobs-api/queues/emails/pause'`,
    );
    expect(curl.textContent).toContain(`-H '${CSRF}: 1'`);
    expect(curl.textContent).toContain("-H 'Content-Type: application/json'");
    fireEvent.click(within(panel()).getByRole("tab", { name: "fetch()" }));
    const fetchText = (await within(panel()).findByTestId("snippet-fetch"))
      .textContent;
    expect(fetchText).toContain('fetch("/jobs-api/queues/emails/pause"');
    expect(fetchText).toContain(`"${CSRF}": "1"`);
  });
});
