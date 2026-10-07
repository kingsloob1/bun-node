import type { FetchLike } from "../../../app/api/client";
import { act, fireEvent, page, visit, within } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the queue screen's Add flow dialog for
 * `pkg/addFlow.integration.test.ts`, which runs it against a REAL
 * `createJobsApi`. That test compiles without the DOM lib, so everything
 * touching the DOM lives here and the test loads it by a dynamic import. It
 * reports what the dialog shows and leaves the assertions to the test.
 */

/** How long a step may wait for the real API and React. */
const STEP_TIMEOUT_MS = 10_000;

/** The flow to add: a top job and one child in a queue of its own. */
export interface AddFlowInput {
  /** The top job's name. */
  topName: string;
  /** The child's name. */
  childName: string;
  /** The child's queue, typed as "Another queue" (it need not exist yet). */
  childQueue: string;
}

/** What the dialog showed once the API answered. */
export interface AddFlowOutcome {
  /** The result's whole text. */
  text: string;
  /** The `href` of the top job's link. */
  topHref: string;
}

/** What the test can do with the mounted queue screen. */
export interface AddFlowDriver {
  /** Opens Add flow, builds `input`, submits it and reads the result. */
  addFlow: (input: AddFlowInput) => Promise<AddFlowOutcome>;
  /** Unmounts the app. */
  unmount: () => void;
}

/** Matches a label with or without its required marker. */
function labelled(label: string): RegExp {
  return new RegExp(`^${label}(\\s*\\*)?$`);
}

/** Renders the app on `/queues/:queue` over `fetch` and returns a driver. */
export async function mountQueueForFlow(
  fetch: FetchLike,
  csrfHeader: string,
  queue: string,
): Promise<AddFlowDriver> {
  visit(`/jobs/queues/${encodeURIComponent(queue)}`);
  const rendered = renderApp({ fetch, config: { csrfHeader } });
  return {
    addFlow: async (input) => {
      const open = await page().findByRole(
        "button",
        { name: "Add flow" },
        { timeout: STEP_TIMEOUT_MS },
      );
      await act(async () => {
        fireEvent.click(open);
      });
      const dialog = await page().findByRole(
        "dialog",
        { name: `Add a flow to ${queue}` },
        { timeout: STEP_TIMEOUT_MS },
      );
      const top = within(dialog).getByRole("group", { name: "Top job" });
      fireEvent.change(within(top).getByLabelText(labelled("Name")), {
        target: { value: input.topName },
      });
      await act(async () => {
        fireEvent.click(
          within(dialog).getByRole("button", { name: "Add child to Top job" }),
        );
      });
      const child = within(dialog).getByRole("group", { name: "Child 1" });
      fireEvent.change(within(child).getByLabelText(labelled("Name")), {
        target: { value: input.childName },
      });
      const queueSelect = within(child).getByLabelText(
        labelled("Queue"),
      ) as HTMLSelectElement;
      const other = Array.from(queueSelect.options).find(
        (option) => option.textContent === "Another queue…",
      )!;
      fireEvent.change(queueSelect, { target: { value: other.value } });
      fireEvent.change(
        within(child).getByLabelText(labelled("Another queue")),
        {
          target: { value: input.childQueue },
        },
      );
      await act(async () => {
        fireEvent.click(
          within(dialog).getByRole("button", { name: "Add flow" }),
        );
      });
      const result = await within(dialog).findByTestId(
        "flow-result",
        {},
        { timeout: STEP_TIMEOUT_MS },
      );
      const link = within(result).getAllByRole("link")[0]!;
      return {
        text: result.textContent ?? "",
        topHref: link.getAttribute("href") ?? "",
      };
    },
    unmount: () => rendered.unmount(),
  };
}
