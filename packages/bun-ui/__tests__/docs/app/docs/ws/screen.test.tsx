import { describe, expect, it } from "bun:test";
import { expectAbsent } from "../../assert";
import { fireEvent, page, setupDom, waitFor, within } from "../../dom";
import { renderViewer } from "../../renderViewer";
import { wsFixture } from "./fixtures";

setupDom();

/** Renders the viewer at `/docs/ws<rest>` over a recorded document, and waits for the reference. */
async function renderWs(
  rest = "",
  options: Omit<Parameters<typeof renderViewer>[0], "document"> & {
    document?: Parameters<typeof renderViewer>[0]["document"];
  } = {},
) {
  const result = await renderViewer({
    document: options.document ?? wsFixture("both"),
    path: `/ws${rest}`,
    ...(options.config ? { config: options.config } : {}),
  });
  await page().findByTestId("ws-main", {}, { timeout: 5_000 });
  return result;
}

/** The main pane. */
function main(): HTMLElement {
  return page().getByTestId("ws-main");
}

/** A recorded document with its raw `channels` loosely typed, edited by `mutate`. */
function editedFixture(
  mutate: (spec: { channels: Record<string, Record<string, unknown>> }) => void,
) {
  const spec = wsFixture("both");
  mutate(
    spec as unknown as {
      channels: Record<string, Record<string, unknown>>;
    },
  );
  return spec;
}

describe("the WebSocket reference screen", () => {
  it("redirects / to it, fetches the document once, and shows the header, server and subprotocol", async () => {
    const { calls } = await renderViewer({
      document: wsFixture("both"),
      path: "",
    });
    await page().findByTestId("ws-docs", {}, { timeout: 5_000 });
    expect(
      calls.filter((call) => call.url === "/docs/document.json"),
    ).toHaveLength(1);
    expect(page().getByRole("heading", { level: 1 }).textContent).toContain(
      "bun-jobs management API (ui-docs-ws-fixture-both)",
    );
    expect(page().getByText("v0.0.0-fixture")).toBeTruthy();
    expect(page().getByTestId("ws-server-url").textContent).toBe(
      "ws://localhost/jobs-api/ws",
    );
    expect(page().getByTestId("ws-subprotocol").textContent).toBe(
      "bun-jobs.v1",
    );
    expect(page().getByTestId("ws-subprotocol-source").textContent).toBe(
      "from servers.api (x-bun-jobs-subprotocol)",
    );
    expect(window.location.pathname).toBe("/docs/ws");
  });

  it("groups the sidebar and selects an item by its slug", async () => {
    await renderWs("/channel-job");
    const nav = page().getByRole("navigation", {
      name: "WebSocket reference",
    });
    const groups = within(nav)
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(groups).toEqual([
      "Connection",
      "Channels",
      "Operations",
      "Control messages",
      "Event messages",
    ]);
    expect(main().dataset.selected).toBe("channel-job");
  });

  it("a channel shows its address, parameters, operations, messages and permission", async () => {
    await renderWs("/channel-job");
    expect(within(main()).getByTestId("ws-channel-address").textContent).toBe(
      "queue/{queue}/job/{jobId}",
    );
    expect(main().textContent).toContain("events.subscribe");
    expect(within(main()).getByText("Operations")).toBeTruthy();
    expect(within(main()).getByText(/Messages \(/)).toBeTruthy();
    // The parameter schemas are drawn by the schema tree.
    expect(
      within(main()).getByTestId("ws-parameter-schema-queue").textContent,
    ).toContain("max length");
    expect(
      within(main()).getByTestId("ws-parameter-schema-jobId").textContent,
    ).toContain("Any string");
  });

  it("an event message shows its payload highlighted and its full envelope", async () => {
    await renderWs("/message-queue.completed");
    expect(within(main()).getByTestId("ws-message-name").textContent).toBe(
      "queue.completed",
    );
    expect(within(main()).getByTestId("ws-event-payload")).toBeTruthy();
    expect(within(main()).getByTestId("ws-message-payload")).toBeTruthy();
    // The example shows event.payload first, then the whole frame.
    expect(within(main()).getByTestId("ws-example-event-payload")).toBeTruthy();
    expect(within(main()).getByTestId("ws-example-frame")).toBeTruthy();
  });

  it("a control message shows its payload, not an event payload", async () => {
    await renderWs("/message-subscribe");
    expect(within(main()).getByTestId("ws-message-payload")).toBeTruthy();
    expectAbsent(main().querySelector('[data-testid="ws-event-payload"]'));
  });

  it("the connection carries the limits, close codes and refusal panels", async () => {
    await renderWs("/channel-connection");
    // No limits vocabulary is configured: the name is the label, and the
    // value's unit comes from the name's suffix.
    expect(
      within(main()).getByTestId("ws-limit-maxMessageBytes").textContent,
    ).toContain("maxMessageBytes");
    expect(
      within(main()).getByTestId("ws-limit-heartbeatMs").textContent,
    ).toContain("25,000 ms (25 s)");
    expect(
      within(main()).getByTestId("ws-limit-maxMessageBytes").textContent,
    ).toContain("16,384 bytes (16 KiB)");
    expect(within(main()).getByTestId("ws-limit-replay").textContent).toContain(
      "size 1,000",
    );
    expect(within(main()).getByTestId("ws-close-1009").textContent).toContain(
      "TOO_BIG",
    );
    expect(
      within(main()).getByTestId("ws-refusal-CONNECTION_LIMIT").textContent,
    ).toContain("Retry-After: 1");
  });

  it("replay off reads as off", async () => {
    await renderViewer({
      document: wsFixture("jobs-secured"),
      path: "/ws/channel-connection",
    });
    await page().findByTestId("ws-limit-replay", {}, { timeout: 5_000 });
    expect(page().getByTestId("ws-limit-replay").textContent).toContain("off");
  });

  it("security: every requirement, the AND note, and what a browser cannot send", async () => {
    await renderViewer({
      document: wsFixture("jobs-secured"),
      path: "/ws",
    });
    await page().findByTestId("ws-security", {}, { timeout: 5_000 });
    const security = page().getByTestId("ws-security");
    expect(security.textContent).toContain("any one of");
    expect(
      within(security).getByTestId("ws-security-conjunctive").textContent,
    ).toContain("x-bun-jobs-security");
    expect(
      within(security).getByTestId("ws-scheme-bearer").textContent,
    ).toContain("bearer, JWT");
    expect(
      within(security).getByTestId("ws-scheme-apiKey").textContent,
    ).toContain("header X-Api-Key");
  });

  it("an unknown slug says so", async () => {
    await renderWs("/channel-nope");
    expect(main().textContent).toContain("No such item");
  });

  it("a pruned item is unknown in that mode", async () => {
    await renderViewer({
      document: wsFixture("runner"),
      path: "/ws/channel-queue",
    });
    await page().findByTestId("ws-main", {}, { timeout: 5_000 });
    expect(page().getByTestId("ws-main").textContent).toContain("No such item");
  });

  it("searches from ?q= and writes the search back to the URL", async () => {
    await renderWs("?q=completed");
    const links = page()
      .getAllByRole("link")
      .map((link) => link.textContent ?? "");
    expect(links.some((text) => text.includes("queue.completed"))).toBe(true);
    expect(links.some((text) => text.includes("runner.succeeded"))).toBe(false);
    const search = page().getByLabelText("Search");
    fireEvent.change(search, { target: { value: "heartbeat" } });
    await waitFor(() => {
      expect(window.location.search).toContain("q=heartbeat");
    });
  });

  it("an unknown x-* extension renders nothing and crashes nothing", async () => {
    const spec = editedFixture(({ channels }) => {
      delete channels.connection["x-bun-jobs-limits"];
      delete channels.connection["x-bun-jobs-close-codes"];
      delete channels.connection["x-bun-jobs-upgrade-refusals"];
      channels.connection["x-acme-limits"] = { maxWidgets: 3 };
      channels.connection["x-acme-unknown"] = { anything: ["goes"] };
    });
    await renderWs("/channel-connection", { document: spec });
    expectAbsent(
      document.body.querySelector('[data-testid="ws-limit-maxWidgets"]'),
    );
    // No Connection group in the sidebar, and the pane still renders.
    expectAbsent(
      document.body.querySelector('[data-testid="ws-group-Connection"]'),
    );
    expect(within(main()).getByTestId("ws-channel-address").textContent).toBe(
      "/jobs-api/ws",
    );
  });

  it("reads the x-bun-common vocabulary when the document uses it", async () => {
    const spec = editedFixture(({ channels }) => {
      channels.connection["x-bun-common-limits"] = {
        maxMessageBytes: 65536,
        replay: false,
      };
      delete channels.connection["x-bun-jobs-limits"];
    });
    await renderWs("/channel-connection", { document: spec });
    const limit = await page().findByTestId("ws-limit-maxMessageBytes");
    expect(limit.textContent).toContain("65,536 bytes (64 KiB)");
    expect(page().getByTestId("ws-limit-replay").textContent).toContain("off");
  });

  it("an error loading the document offers a retry", async () => {
    const { calls } = await renderViewer({
      document: wsFixture("both"),
      path: "/ws",
      documentError: { status: 503 },
    });
    await page().findByText(
      "Could not load the API document",
      {},
      { timeout: 5_000 },
    );
    const fetches = () =>
      calls.filter((call) => call.url === "/docs/document.json").length;
    expect(fetches()).toBe(1);
    fireEvent.click(page().getByRole("button", { name: /^retry$/i }));
    await page().findByTestId("ws-main", {}, { timeout: 5_000 });
    expect(fetches()).toBe(2);
  });
});
