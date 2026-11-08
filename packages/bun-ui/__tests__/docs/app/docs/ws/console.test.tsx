import type { WsConsole } from "../../../../app/screens/docs/ws/items";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "bun:test";
import { createQueryClient } from "../../../../app/queryClient";
import { RouterProvider } from "../../../../app/router";
import { ParamsContext } from "../../../../app/routing";
import { WsReference } from "../../../../app/screens/docs/ws/index";
import { expectAbsent, expectUndefined } from "../../assert";
import { fireEvent, page, render, setupDom, visit, within } from "../../dom";
import { wsFixture } from "./fixtures";

setupDom();

/**
 * The seams a host app injects: the console the try-it cards open, the
 * permission probe, the address contract, and the docs section's base path.
 * Rendered here against the real recorded document.
 */

/** A fake console that links anywhere. */
const CONSOLE: WsConsole = {
  available: true,
  label: "Test console",
  channelLink: (channel, types) =>
    `/console?channel=${encodeURIComponent(channel)}${types.length > 0 ? `&types=${types.join(",")}` : ""}`,
  messageLink: (message) =>
    message.event === null ? null : `/console?watch=${message.event.type}`,
};

/** Renders the reference alone at `/docs/ws<rest>`, with the seams given. */
async function renderWs(
  rest: string,
  options: {
    console?: WsConsole;
    probe?: (action: string) => boolean | undefined;
    pathBase?: string;
  } = {},
) {
  visit(`/docs/ws${rest}`);
  // No Routes here: the item param the route would bind is given directly.
  const item = rest.split("?")[0].replace(/^\//, "") || undefined;
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <RouterProvider basePath="/docs">
        <ParamsContext value={item === undefined ? {} : { item }}>
          <WsReference
            document={wsFixture("both")}
            console={options.console}
            probe={options.probe}
            pathBase={options.pathBase ?? ""}
          />
        </ParamsContext>
      </RouterProvider>
    </QueryClientProvider>,
  );
  await page().findByTestId("ws-main", {}, { timeout: 5_000 });
}

/** The main pane. */
function main() {
  return within(page().getByTestId("ws-main"));
}

describe("the console seam", () => {
  it("a channel's try-it fills the address and links the console, filtered to the channel's types", async () => {
    await renderWs("/channel-queue", { console: CONSOLE });
    const tryIt = main().getByTestId("ws-try-channel");
    expect(tryIt.textContent).toContain("Opens the Test console");
    const input = within(tryIt).getByLabelText("queue");
    fireEvent.change(input, { target: { value: "mail" } });
    expect(main().getByTestId("ws-try-address").textContent).toBe("queue/mail");
    const link = main().getByTestId("ws-try-link");
    expect(link.textContent).toBe("Open in the Test console");
    // The console lives in the same app, so the link is app-relative: the
    // router prepends the mount ("/docs" here; "/jobs" in bun-jobs-ui).
    const href = new URL(link.getAttribute("href")!, "http://localhost");
    expect(href.pathname).toBe("/docs/console");
    expect(href.searchParams.get("channel")).toBe("queue/mail");
    expect(href.searchParams.get("types")).toContain("completed");
  });

  it("says why it cannot link yet, per parameter", async () => {
    await renderWs("/channel-job", { console: CONSOLE });
    expect(main().getByTestId("ws-try-reason").textContent).toContain(
      "queue: fill it in.",
    );
    expect(main().getByTestId("ws-try-disabled").textContent).toContain(
      "Test console",
    );
  });

  it("an event message's try-it links the console through the seam", async () => {
    await renderWs("/message-queue.completed", { console: CONSOLE });
    const link = main().getByTestId("ws-try-link");
    expect(link.textContent).toBe("Watch completed events");
    expect(link.getAttribute("href")).toBe("/docs/console?watch=completed");
  });

  it("an unavailable console says so, with the host's own reason", async () => {
    await renderWs("/channel-queue", {
      console: {
        ...CONSOLE,
        available: false,
        unavailableReason: "The test console is off today.",
      },
    });
    expect(main().getByTestId("ws-try-unavailable").textContent).toBe(
      "The test console is off today.",
    );
  });

  it("no console, no try-it (the standalone viewer's shape)", async () => {
    await renderWs("/channel-queue");
    expectAbsent(document.body.querySelector('[data-testid="ws-try-channel"]'));
  });

  it("an event message without a console has no try-it either", async () => {
    await renderWs("/message-queue.completed");
    expectAbsent(document.body.querySelector('[data-testid="ws-try-link"]'));
  });
});

describe("the permission probe", () => {
  it("marks held and lacked permissions, and unknown actions", async () => {
    await renderWs("/operation-subscribe", {
      probe: (action) => (action === "events.subscribe" ? false : undefined),
    });
    const marker = main().getByTestId("ws-permission-events.subscribe");
    expect(marker.textContent).toContain("You lack this");
    expect(marker.dataset.has).toBe("false");
  });

  it("without a probe, a permission is plain", async () => {
    await renderWs("/operation-subscribe");
    const marker = main().getByTestId("ws-permission-events.subscribe");
    expect(marker.textContent).toContain("events.subscribe");
    expectUndefined(marker.dataset.has);
  });
});

describe("the path base", () => {
  it("links items under the host's docs section", async () => {
    await renderWs("/channel-queue", { pathBase: "/docs-base" });
    const link = main()
      .getAllByRole("link")
      .find((one) => one.textContent?.includes("queue.completed"))!;
    expect(link.getAttribute("href")).toBe(
      "/docs/docs-base/ws/message-queue.completed",
    );
  });
});
