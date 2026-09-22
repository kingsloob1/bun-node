import type { SpecDocument } from "../../../../app/api/docs";
import type { MetaDto, Permissions } from "../../../../app/api/types";
import type { WsFixtureName } from "./fixtures";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { liveChannels } from "../../../../app/live";
import {
  act,
  fireEvent,
  page,
  setupDom,
  visit,
  waitFor,
  within,
} from "../../dom";
import { metaFixture, permissionsFixture } from "../../fixtures";
import { renderApp } from "../../renderApp";
import { wsFixture } from "./fixtures";

setupDom();

/** Options of {@link renderWs}. */
interface RenderWsOptions {
  /** The recorded document served. Defaults to `both`. */
  fixture?: WsFixtureName;
  /** `/meta` overrides. */
  meta?: Partial<MetaDto>;
  /** Permission overrides. */
  actions?: Permissions["actions"];
  /** A document served instead of the recorded `fixture` (its mode still sets `/meta`'s). */
  document?: SpecDocument;
}

/** Renders `/docs/ws<rest>` over a real recorded document, and waits for the reference. */
async function renderWs(rest = "", options: RenderWsOptions = {}) {
  visit(`/jobs/docs/ws${rest}`);
  const mode =
    options.fixture === "runner"
      ? "runner"
      : options.fixture === "jobs-secured"
        ? "jobs"
        : "both";
  const result = renderApp({
    handlers: {
      "GET /meta": { body: metaFixture({ mode, ...options.meta }) },
      "GET /meta/permissions": {
        body: permissionsFixture(options.actions),
      },
      "GET /asyncapi.json": {
        body: options.document ?? wsFixture(options.fixture ?? "both"),
      },
    },
  });
  await page().findByTestId("ws-main", {}, { timeout: 5_000 });
  return result;
}

/** The main pane. */
function main(): HTMLElement {
  return page().getByTestId("ws-main");
}

/** A recorded document with its raw `servers` / `channels` loosely typed, edited by `mutate`. */
function editedFixture(
  mutate: (document: {
    servers: Record<string, Record<string, unknown>>;
    channels: Record<string, Record<string, unknown>>;
  }) => void,
): SpecDocument {
  const document = wsFixture("both");
  mutate(
    document as unknown as {
      servers: Record<string, Record<string, unknown>>;
      channels: Record<string, Record<string, unknown>>;
    },
  );
  return document;
}

/** Sets a text field (inside `scope`) by its label. */
function type(label: string, value: string, scope = page()): void {
  fireEvent.change(scope.getByLabelText(label), { target: { value } });
}

describe("WsDocsScreen", () => {
  it("shows an empty state when the API has no socket", async () => {
    visit("/jobs/docs/ws");
    const { calls } = renderApp({
      handlers: {
        "GET /meta": {
          body: metaFixture({
            websocket: null,
            docs: { openapi: "/jobs-api/openapi.json" },
          }),
        },
      },
    });
    await page().findByText("This API has no live-events socket");
    expect(calls.some((call) => call.path === "/asyncapi.json")).toBe(false);
  });

  it("loads the document from meta.docs.asyncapi and shows the header, server and subprotocol", async () => {
    const { calls } = await renderWs();
    expect(calls.filter((call) => call.path === "/asyncapi.json")).toHaveLength(
      1,
    );
    expect(page().getByRole("heading", { level: 1 }).textContent).toContain(
      "bun-jobs management API (ui-docs-ws-fixture-both)",
    );
    expect(page().getByText("v0.0.0-fixture")).toBeTruthy();
    expect(page().getByTestId("ws-server-url").textContent).toBe(
      "ws://localhost/jobs-api/ws",
    );
    expect(
      page().getByText(/Taken from the request that fetched this document/),
    ).toBeTruthy();
    expect(page().getByTestId("ws-subprotocol").textContent).toBe(
      "bun-jobs.v1",
    );
    expect(page().getByTestId("ws-security").textContent).toContain(
      "No security schemes are declared",
    );
    // No item: the connection channel.
    expect(main().dataset.selected).toBe("channel-connection");
  });

  it("names where the subprotocol was read from", async () => {
    const source = () =>
      page().getByTestId("ws-subprotocol-source").textContent;
    const cases: [string, SpecDocument][] = [
      ["from servers.api (x-bun-jobs-subprotocol)", wsFixture("both")],
      [
        "from the connection channel (x-bun-jobs-subprotocol)",
        editedFixture((document) => {
          delete document.servers.api!["x-bun-jobs-subprotocol"];
        }),
      ],
      [
        "from the connection channel's description",
        editedFixture((document) => {
          delete document.servers.api!["x-bun-jobs-subprotocol"];
          delete document.channels.connection!["x-bun-jobs-subprotocol"];
        }),
      ],
      [
        "not stated; the client default",
        editedFixture((document) => {
          delete document.servers.api!["x-bun-jobs-subprotocol"];
          delete document.channels.connection!["x-bun-jobs-subprotocol"];
          document.channels.connection!.description = "The socket.";
        }),
      ],
    ];
    for (const [expected, document] of cases) {
      const { unmount } = await renderWs("", { document });
      expect(source()).toBe(expected);
      expect(page().getByTestId("ws-subprotocol").textContent).toBe(
        "bun-jobs.v1",
      );
      unmount();
    }
  });

  it("an error loading the document offers a retry", async () => {
    visit("/jobs/docs/ws");
    renderApp({
      handlers: {
        "GET /asyncapi.json": {
          status: 403,
          body: {
            type: "about:blank",
            title: "Forbidden",
            status: 403,
            code: "FORBIDDEN",
            detail: "no",
          },
        },
      },
    });
    await page().findByText("Could not load the AsyncAPI document");
    expect(page().getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("groups the sidebar and selects an item by its slug", async () => {
    await renderWs();
    const nav = page().getByRole("navigation", {
      name: "WebSocket reference",
    });
    const titles = Array.from(
      within(nav).getAllByRole("heading", { level: 2 }),
      (heading) => heading.textContent,
    );
    expect(titles).toEqual([
      "Connection",
      "Channels",
      "Operations",
      "Control messages",
      "Event messages",
    ]);
    const channels = within(page().getByTestId("ws-group-Channels"))
      .getAllByRole("link")
      .map((link) => link.querySelector(".ws-nav-hint")?.textContent);
    expect(channels).toEqual([
      "/jobs-api/ws",
      "all",
      "queues",
      "queue/{queue}",
      "queue/{queue}/job/{jobId}",
      "workers",
      "queue/{queue}/workers",
      "runners",
      "runner/{runner}",
    ]);
    // No item: the connection is shown and marked selected.
    expect(
      page().getByTestId("ws-nav-channel-connection").dataset.selected,
    ).toBe("true");

    fireEvent.click(page().getByTestId("ws-nav-message-queue.completed"));
    await page().findByTestId("ws-pane-message-queue.completed");
    expect(window.location.pathname).toBe(
      "/jobs/docs/ws/message-queue.completed",
    );
    const selected = page().getByTestId("ws-nav-message-queue.completed");
    expect(selected.getAttribute("aria-current")).toBe("page");
    expect(selected.dataset.selected).toBe("true");
    expect(
      page().getByTestId("ws-nav-channel-connection").dataset.selected,
    ).toBeUndefined();
  });

  it("a channel shows its address, parameters, operations, messages and permission", async () => {
    await renderWs("/channel-job");
    const pane = page().getByTestId("ws-pane-channel-job");
    expect(within(pane).getByTestId("ws-channel-address").textContent).toBe(
      "queue/{queue}/job/{jobId}",
    );
    const parameters = within(pane).getByRole("table", { name: "Parameters" });
    expect(parameters.textContent).toContain("{queue}");
    expect(parameters.textContent).toContain("{jobId}");
    expect(
      within(pane).getByRole("link", { name: "receive receiveJobEvents" }),
    ).toBeTruthy();
    expect(
      within(pane).getByRole("link", { name: "queue.completed" }),
    ).toBeTruthy();
    expect(
      within(pane).queryByRole("link", { name: "queue.paused" }),
    ).toBeNull();
    const marker = within(pane).getByTestId("ws-permission-events.subscribe");
    expect(marker.dataset.has).toBe("true");
    expect(marker.textContent).toContain("You have this");
  });

  it("a worker channel shows its address, its operation and only the worker messages", async () => {
    await renderWs("/channel-queueWorkers");
    const pane = page().getByTestId("ws-pane-channel-queueWorkers");
    expect(within(pane).getByTestId("ws-channel-address").textContent).toBe(
      "queue/{queue}/workers",
    );
    expect(
      within(pane).getByRole("table", { name: "Parameters" }).textContent,
    ).toContain("{queue}");
    expect(
      within(pane).getByRole("link", {
        name: "receive receiveQueueWorkersEvents",
      }),
    ).toBeTruthy();
    for (const name of ["worker.control", "worker.state", "worker.config"]) {
      expect(within(pane).getByRole("link", { name })).toBeTruthy();
    }
    // Worker events travel on their own channels, and queue events do not.
    expect(
      within(pane).queryByRole("link", { name: "queue.completed" }),
    ).toBeNull();
  });

  it("a channel parameter's x-bun-jobs-schema is drawn by the schema tree, beside its description", async () => {
    await renderWs("/channel-job");
    const pane = page().getByTestId("ws-pane-channel-job");
    const queue = within(pane).getByTestId("ws-parameter-schema-queue");
    const tree = within(queue).getByRole("group", {
      name: "Schema of {queue}",
    });
    expect(tree.textContent).toContain("string");
    expect(tree.textContent).toContain("^(?!\\.\\.?$)[\\w.-]+$");
    expect(tree.textContent).toContain("200");
    // The row still has the description.
    expect(queue.closest("tr")!.textContent).toContain("A queue name");
    // A job id has no schema: any string, escaped.
    const jobId = within(pane).getByTestId("ws-parameter-schema-jobId");
    expect(within(jobId).queryByRole("group")).toBeNull();
    expect(jobId.textContent).toBe("Any string");
    expect(jobId.closest("tr")!.textContent).toContain("%uXXXX");
  });

  it("marks a permission the caller lacks", async () => {
    await renderWs("/operation-subscribe", {
      actions: { "events.subscribe": false },
    });
    const pane = page().getByTestId("ws-pane-operation-subscribe");
    const marker = within(pane).getByTestId("ws-permission-events.subscribe");
    expect(marker.dataset.has).toBe("false");
    expect(marker.textContent).toContain("You lack this");
    expect(
      within(pane).getByTestId("ws-operation-action").textContent,
    ).toContain("send");
    const reply = within(pane).getByTestId("ws-operation-reply");
    expect(within(reply).getByRole("link", { name: "ack" })).toBeTruthy();
    expect(within(reply).getByRole("link", { name: "error" })).toBeTruthy();
  });

  it("an event message shows its payload highlighted and its full envelope", async () => {
    await renderWs("/message-queue.completed");
    const pane = page().getByTestId("ws-pane-message-queue.completed");
    expect(within(pane).getByTestId("ws-message-name").textContent).toBe(
      "queue.completed",
    );
    expect(pane.textContent).toContain("A job completed.");
    const payload = within(pane).getByTestId("ws-event-payload");
    expect(payload.closest(".ws-highlight")).not.toBeNull();
    expect(
      within(payload).getByRole("group", {
        name: "Payload of queue.completed",
      }),
    ).toBeTruthy();
    expect(payload.textContent).toContain("returnValue");
    const envelope = within(pane).getByTestId("ws-message-payload");
    expect(
      within(envelope).getByRole("group", {
        name: "Schema of queue.completed",
      }),
    ).toBeTruthy();
    expect(envelope.textContent).toContain("subscriptions");
  });

  it("a control message shows its payload, not an event payload or try-it", async () => {
    await renderWs("/message-subscribe");
    const pane = page().getByTestId("ws-pane-message-subscribe");
    expect(within(pane).queryByTestId("ws-event-payload")).toBeNull();
    expect(
      within(pane).getByTestId("ws-message-payload").textContent,
    ).toContain("channels");
    expect(within(pane).queryByTestId("ws-try-link")).toBeNull();
  });

  it("an event message's example shows event.payload first, highlighted, then the whole frame", async () => {
    await renderWs("/message-queue.completed");
    const pane = page().getByTestId("ws-pane-message-queue.completed");
    const examples = within(pane).getAllByTestId("ws-example");
    expect(examples).toHaveLength(1);
    const example = examples[0]!;
    expect(within(example).getByTestId("ws-example-name").textContent).toBe(
      "queue.completed",
    );
    expect(within(example).getByTestId("ws-example-summary").textContent).toBe(
      "A job completed.",
    );
    const highlighted = within(example).getByTestId("ws-example-event-payload");
    expect(highlighted.classList.contains("ws-highlight")).toBe(true);
    expect(
      within(highlighted).getByRole("list", {
        name: "event.payload of queue.completed",
      }),
    ).toBeTruthy();
    expect(highlighted.textContent).toContain("<0192f1c4@mail.example.com>");
    // event.payload comes before the frame.
    const frame = within(example).getByTestId("ws-example-frame");
    expect(
      highlighted.compareDocumentPosition(frame) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(frame).getByRole("list", { name: "Example queue.completed" }),
    ).toBeTruthy();
    expect(frame.textContent).toContain("subscriptions");
  });

  it("a control message's example is the frame, with no event.payload", async () => {
    await renderWs("/message-subscribe");
    const pane = page().getByTestId("ws-pane-message-subscribe");
    const example = within(pane).getByTestId("ws-example");
    expect(within(example).getByTestId("ws-example-name").textContent).toBe(
      "subscribe",
    );
    expect(
      within(example).queryByTestId("ws-example-event-payload"),
    ).toBeNull();
    expect(
      within(example).getByTestId("ws-example-frame").textContent,
    ).toContain("sub-1");
  });

  describe("copying an example", () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    afterEach(() => {
      if (original) {
        Object.defineProperty(navigator, "clipboard", original);
      } else {
        delete (navigator as { clipboard?: unknown }).clipboard;
      }
    });

    it("copies the whole frame as JSON", async () => {
      const writeText = mock(async (_text: string) => {});
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
      await renderWs("/message-queue.completed");
      const document = wsFixture("both");
      const expected = (
        document.components as Record<
          string,
          Record<string, { examples: { payload: unknown }[] }>
        >
      ).messages!["queue.completed"]!.examples[0]!.payload;
      const button = within(main()).getByRole("button", {
        name: "Copy example queue.completed as JSON",
      });
      await act(async () => {
        fireEvent.click(button);
      });
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual(expected);
      expect(button.textContent).toBe("Copied");
    });
  });

  it("names an unnamed example by its position, and shows no card without examples", async () => {
    const document = wsFixture("both");
    const messages = (
      document.components as Record<
        string,
        Record<string, Record<string, unknown>>
      >
    ).messages!;
    messages.hello!.examples = [
      { summary: "On open", payload: { type: "hello", protocol: 1 } },
    ];
    delete messages.ping!.examples;
    visit("/jobs/docs/ws/message-hello");
    renderApp({ handlers: { "GET /asyncapi.json": { body: document } } });
    const pane = await page().findByTestId("ws-pane-message-hello");
    expect(within(pane).getByTestId("ws-example-name").textContent).toBe(
      "Example 1",
    );
    expect(within(pane).getByText("On open")).toBeTruthy();
    expect(
      within(pane).getByRole("list", { name: "Example Example 1" }),
    ).toBeTruthy();

    fireEvent.click(page().getByTestId("ws-nav-message-ping"));
    const ping = await page().findByTestId("ws-pane-message-ping");
    expect(within(ping).queryByTestId("ws-example")).toBeNull();
    expect(within(ping).queryByText("Example")).toBeNull();
  });

  it("the limits panel lists every limit in its unit, and replay", async () => {
    await renderWs("/limits");
    const table = within(main()).getByRole("table", { name: "Limits" });
    const cell = (name: string) => {
      const row = within(table).getByTestId(`ws-limit-${name}`);
      return row.querySelector(".ws-value")?.textContent;
    };
    expect(cell("maxMessageBytes")).toBe("16,384 bytes (16 KiB)");
    expect(cell("messagesPerSecond")).toBe("20 / s");
    expect(cell("rateLimitBurst")).toBe("40");
    expect(cell("rateLimitBreachWindowMs")).toBe("10,000 ms (10 s)");
    expect(cell("maxSubscriptions")).toBe("50");
    expect(cell("maxChannelsPerFrame")).toBe("256");
    expect(cell("maxConnections")).toBe("1,000");
    expect(cell("heartbeatMs")).toBe("25,000 ms (25 s)");
    expect(cell("maxBufferedBytes")).toBe("1,048,576 bytes (1 MiB)");
    expect(cell("slowConsumerTimeoutMs")).toBe("30,000 ms (30 s)");
    expect(cell("coalesceProgressMs")).toBe("250 ms");
    expect(cell("replay")).toBe("size 1,000, maxAgeMs 300,000 ms (5 min)");
  });

  it("replay off reads as off", async () => {
    await renderWs("/limits", { fixture: "jobs-secured" });
    const row = within(main()).getByTestId("ws-limit-replay");
    expect(row.querySelector(".ws-value")?.textContent).toBe("off");
    expect(row.textContent).toContain("always reports a gap");
  });

  it("the close-code panel lists code, name and description", async () => {
    await renderWs("/close-codes");
    const table = within(main()).getByRole("table", { name: "Close codes" });
    expect(within(table).getAllByRole("row")).toHaveLength(7);
    const policy = within(table).getByTestId("ws-close-1008");
    expect(policy.textContent).toContain("POLICY");
    expect(policy.textContent).toContain(
      "rate limit was breached a second time",
    );
    expect(within(table).getByTestId("ws-close-4008").textContent).toContain(
      "SLOW_CONSUMER",
    );
  });

  it("the refusal panel lists status, code, headers and explains 1006", async () => {
    await renderWs("/upgrade-refusals");
    const table = within(main()).getByRole("table", {
      name: "Upgrade refusals",
    });
    const limit = within(table).getByTestId("ws-refusal-CONNECTION_LIMIT");
    expect(limit.textContent).toContain("429");
    expect(limit.textContent).toContain("Retry-After: 1");
    expect(limit.textContent).toContain("application/problem+json");
    expect(
      within(table).getByTestId("ws-refusal-UNSUPPORTED_SUBPROTOCOL")
        .textContent,
    ).toContain("bun-jobs.v1");
    expect(within(main()).getByTestId("ws-refusal-1006").textContent).toContain(
      "1006",
    );
  });

  it("the connection channel carries all three panels", async () => {
    await renderWs("/channel-connection");
    for (const name of ["Limits", "Close codes", "Upgrade refusals"]) {
      expect(within(main()).getByRole("table", { name })).toBeTruthy();
    }
  });

  it("an unknown slug says so", async () => {
    await renderWs("/channel-nope");
    expect(within(main()).getByText("No such item")).toBeTruthy();
    expect(main().dataset.selected).toBe("");
  });

  it("a pruned item is unknown in that mode", async () => {
    await renderWs("/channel-queue", { fixture: "runner" });
    expect(within(main()).getByText("No such item")).toBeTruthy();
    expect(
      page().queryByTestId("ws-group-Event messages")?.textContent,
    ).not.toContain("queue.");
  });

  it("searches from ?q= and writes the search back to the URL", async () => {
    await renderWs("?q=heartbeat");
    const nav = page().getByRole("navigation", { name: "WebSocket reference" });
    const slugs = () =>
      within(nav)
        .queryAllByRole("link")
        .map((link) => link.dataset.testid);
    // The limits (heartbeatMs), the control receive ("heartbeats") and the message.
    expect(slugs()).toEqual([
      "ws-nav-limits",
      "ws-nav-operation-receiveControl",
      "ws-nav-message-heartbeat",
    ]);
    // Links keep the search.
    expect(page().getByTestId("ws-nav-limits").getAttribute("href")).toBe(
      "/jobs/docs/ws/limits?q=heartbeat",
    );

    type("Search", "1009", within(nav));
    await waitFor(() => expect(slugs()).toEqual(["ws-nav-close-codes"]));
    expect(new URLSearchParams(window.location.search).get("q")).toBe("1009");

    type("Search", "no-such-thing", within(nav));
    await page().findByTestId("ws-search-empty");
  });

  it("security: every requirement, the AND note, and what a browser cannot send", async () => {
    await renderWs("", { fixture: "jobs-secured" });
    const security = page().getByTestId("ws-security");
    const requirements = within(security).getByRole("list", {
      name: "Security requirements",
    });
    expect(
      within(requirements)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["session", "bearer and apiKey"]);
    expect(security.textContent).toContain("any one of");
    expect(
      within(security).getByTestId("ws-security-conjunctive"),
    ).toBeTruthy();
    expect(
      within(security).getByTestId("ws-scheme-bearer").textContent,
    ).toContain("cannot send an Authorization header");
    expect(
      within(security).getByTestId("ws-scheme-apiKey").textContent,
    ).toContain("cannot send the X-Api-Key header");
    expect(
      within(security).getByTestId("ws-scheme-session").textContent,
    ).toContain("Can be sent.");
  });
});

describe("WsDocsScreen try it", () => {
  it("fills a queue channel and opens the Events console on it", async () => {
    await renderWs("/channel-queue");
    const tryIt = page().getByTestId("ws-try-channel");
    expect(within(tryIt).queryByTestId("ws-try-link")).toBeNull();
    type("queue", "has space", within(tryIt));
    expect(tryIt.textContent).toContain("Letters, digits");
    expect(within(tryIt).queryByTestId("ws-try-link")).toBeNull();

    type("queue", "mail", within(tryIt));
    const link = within(tryIt).getByTestId("ws-try-link");
    // Every queue type: no filter needed.
    expect(link.getAttribute("href")).toBe("/jobs/events?channel=queue%2Fmail");
    expect(within(tryIt).getByTestId("ws-try-address").textContent).toBe(
      "queue/mail",
    );
  });

  it("says why the console cannot be opened, from the document's schema", async () => {
    await renderWs("/channel-queue");
    const tryIt = page().getByTestId("ws-try-channel");
    expect(within(tryIt).getByTestId("ws-try-reason").textContent).toBe(
      "queue: fill it in.",
    );
    const disabled = within(tryIt).getByTestId("ws-try-disabled");
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.getAttribute("aria-describedby")).toBe(
      within(tryIt).getByTestId("ws-try-reason").id,
    );
    type("queue", "x".repeat(201), within(tryIt));
    expect(within(tryIt).getByTestId("ws-try-reason").textContent).toBe(
      "queue: At most 200 characters (this is 201).",
    );
    expect(within(tryIt).queryByTestId("ws-try-link")).toBeNull();
    type("queue", "x".repeat(200), within(tryIt));
    expect(within(tryIt).queryByTestId("ws-try-reason")).toBeNull();
    expect(within(tryIt).getByTestId("ws-try-link")).toBeTruthy();
  });

  it("holds try-it to a document's tighter schema over the contract's rule", async () => {
    const document = wsFixture("both");
    const channels = document.channels as Record<
      string,
      { parameters: Record<string, Record<string, unknown>> }
    >;
    channels.queue!.parameters.queue!["x-bun-jobs-schema"] = {
      type: "string",
      pattern: "^[a-z]+$",
      maxLength: 10,
    };
    visit("/jobs/docs/ws/channel-queue");
    renderApp({ handlers: { "GET /asyncapi.json": { body: document } } });
    const tryIt = await page().findByTestId("ws-try-channel");
    // "mail.v2" satisfies the contract's rule but not this document's.
    type("queue", "mail.v2", within(tryIt));
    expect(within(tryIt).getByTestId("ws-try-reason").textContent).toBe(
      "queue: Must match ^[a-z]+$.",
    );
    expect(within(tryIt).queryByTestId("ws-try-link")).toBeNull();
    type("queue", "mail", within(tryIt));
    expect(within(tryIt).getByTestId("ws-try-link")).toBeTruthy();
  });

  it("encodes a job id exactly as liveChannels.job, and filters to the job channel's types", async () => {
    await renderWs("/channel-job");
    const tryIt = page().getByTestId("ws-try-channel");
    const id = "order/42 ü%";
    type("queue", "mail", within(tryIt));
    type("jobId", id, within(tryIt));
    expect(within(tryIt).getByTestId("ws-try-address").textContent).toBe(
      liveChannels.job("mail", id),
    );
    const href = new URL(
      within(tryIt).getByTestId("ws-try-link").getAttribute("href")!,
      "http://localhost",
    );
    expect(href.searchParams.get("channel")).toBe(liveChannels.job("mail", id));
    const types = href.searchParams.get("types")!.split(",");
    expect(types).toContain("completed");
    expect(types).not.toContain("drained");
  });

  it("an event message opens the console filtered to its type", async () => {
    await renderWs("/message-runner.killed");
    const link = within(main()).getByTestId("ws-try-link");
    expect(link.getAttribute("href")).toBe(
      "/jobs/events?channel=runners&types=killed",
    );
  });

  it("the connection channel has no try-it at all: nothing to subscribe to", async () => {
    await renderWs("/channel-connection");
    expect(within(main()).queryByText("Try it")).toBeNull();
    for (const id of [
      "ws-try-channel",
      "ws-try-link",
      "ws-try-disabled",
      "ws-try-reason",
      "ws-try-unavailable",
    ]) {
      expect(within(main()).queryByTestId(id)).toBeNull();
    }
  });

  it("nor does a connection under another key, or a socket path", async () => {
    const document = editedFixture((raw) => {
      // The connection, keyed otherwise: known by its upgrade binding.
      raw.channels.socket = raw.channels.connection!;
      delete raw.channels.connection;
      // A second socket path is not a channel name either.
      raw.channels.legacy = { address: "/jobs-api/ws-legacy", messages: {} };
    });
    for (const slug of ["channel-socket", "channel-legacy"]) {
      const { unmount } = await renderWs(`/${slug}`, { document });
      expect(main().dataset.selected).toBe(slug);
      expect(within(main()).queryByText("Try it")).toBeNull();
      expect(within(main()).queryByTestId("ws-try-disabled")).toBeNull();
      unmount();
    }
  });

  it("names the channel and mode when the console has no such channel", async () => {
    const document = editedFixture((raw) => {
      raw.channels.system = { address: "system", messages: {} };
    });
    await renderWs("/channel-system", { document });
    const tryIt = within(main()).getByTestId("ws-try-channel");
    expect(within(tryIt).getByTestId("ws-try-disabled")).toBeTruthy();
    expect(within(tryIt).getByTestId("ws-try-reason").textContent).toBe(
      "The Events console has no channel system in mode both.",
    );
  });

  it("is not offered when the Events console is not available", async () => {
    await renderWs("/channel-queues", { actions: { "events.connect": false } });
    expect(within(main()).getByTestId("ws-try-unavailable")).toBeTruthy();
    expect(within(main()).queryByTestId("ws-try-link")).toBeNull();
  });

  it("is not offered without the manage screens", async () => {
    visit("/jobs/docs/ws/message-queue.failed");
    renderApp({
      config: { sections: { manage: false, docs: true } },
      handlers: { "GET /asyncapi.json": { body: wsFixture("both") } },
    });
    await page().findByTestId("ws-pane-message-queue.failed");
    expect(within(main()).getByTestId("ws-try-unavailable")).toBeTruthy();
  });
});
