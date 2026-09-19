import type { FetchLike } from "../../../../app/api/client";
import { fireEvent, page, visit, waitFor, within } from "../../dom";
import { renderApp } from "../../renderApp";

/**
 * Drives the WebSocket reference for `pkg/docs-ws.integration.test.ts`, which
 * runs it against a REAL `createJobsApi`. That test compiles without the DOM
 * lib, so everything touching the DOM lives here and it loads this module by
 * a dynamic import. It returns what the screens show and leaves the
 * assertions to the test.
 */

/** What the reference and the console it opens show. */
export interface WsDocsView {
  /** The sidebar's channel entries: slug and address hint. */
  channels: { slug: string; hint: string }[];
  /** The sidebar's event message labels (`queue.completed`, ...). */
  eventMessages: string[];
  /** The server URL the header shows. */
  serverUrl: string;
  /** The subprotocol the header shows. */
  subprotocol: string;
  /** The try-it link built for the job channel. */
  tryHref: string;
  /** The channel the Events console then watches. */
  consoleChannel: string;
  /** The console's type-filter summary. */
  consoleTypes: string;
}

/** Sets a text field by its label. */
function type(label: string, value: string): void {
  fireEvent.change(page().getByLabelText(label), { target: { value } });
}

/**
 * Renders `/docs/ws/channel-job` over `fetch`, fills the job channel's
 * parameters with `queue` and `jobId`, follows "try it" into the Events
 * console, and returns what both show.
 */
export async function tryJobChannel(
  fetch: FetchLike,
  queue: string,
  jobId: string,
): Promise<WsDocsView> {
  visit("/jobs/docs/ws/channel-job");
  const rendered = renderApp({ fetch });
  await page().findByTestId("ws-pane-channel-job", {}, { timeout: 5_000 });
  const channelsGroup = page().getByTestId("ws-group-Channels");
  const channels = Array.from(
    channelsGroup.querySelectorAll<HTMLAnchorElement>("a"),
    (link) => ({
      slug: link.dataset.testid?.replace(/^ws-nav-/, "") ?? "",
      hint: link.querySelector(".ws-nav-hint")?.textContent ?? "",
    }),
  );
  const eventMessages = Array.from(
    page()
      .getByTestId("ws-group-Event messages")
      .querySelectorAll(".ws-nav-label"),
    (label) => label.textContent ?? "",
  );
  const serverUrl = page().getByTestId("ws-server-url").textContent ?? "";
  const subprotocol = page().getByTestId("ws-subprotocol").textContent ?? "";

  const tryIt = page().getByTestId("ws-try-channel");
  type("queue", queue);
  type("jobId", jobId);
  const link = await within(tryIt).findByTestId("ws-try-link");
  const tryHref = link.getAttribute("href") ?? "";
  fireEvent.click(link);

  const screen = await page().findByTestId("events-screen");
  let consoleChannel = "";
  await waitFor(() => {
    consoleChannel =
      within(screen).getByTestId("events-channel").textContent ?? "";
    if (consoleChannel === "") {
      throw new Error("no channel yet");
    }
  });
  const consoleTypes =
    within(screen).getByTestId("events-types-summary").textContent ?? "";
  rendered.unmount();
  return {
    channels,
    eventMessages,
    serverUrl,
    subprotocol,
    tryHref,
    consoleChannel,
    consoleTypes,
  };
}
