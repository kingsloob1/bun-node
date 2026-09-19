import type { FetchLike } from "../../../../app/api/client";
import { fireEvent, page, visit, waitFor, within } from "../../dom";
import { renderApp } from "../../renderApp";

/**
 * Drives the HTTP reference for `pkg/docs-http.integration.test.ts`, which
 * runs it against a REAL `createJobsApi`. That test compiles without the DOM
 * lib, so everything touching the DOM lives here and the test loads it by a
 * dynamic import. It returns what the screen shows and leaves the
 * assertions about the API's state to the test.
 */

/** What one try-it send showed. */
export interface TryItOutcome {
  /** The status badge's text. */
  status: string;
  /** The result section's whole text (body included). */
  text: string;
}

/** What the test can do with the rendered reference. */
export interface HttpDocsDriver {
  /** The operation ids the sidebar lists, in order. */
  operations: () => string[];
  /** Opens an operation by clicking its sidebar link and waits for its view. */
  openOperation: (operationId: string) => Promise<void>;
  /** Fills a try-it field by parameter name. */
  fill: (name: string, value: string) => void;
  /** Sends, confirming a mutation (and typing the id for a destructive one), and resolves the outcome. */
  send: () => Promise<TryItOutcome>;
}

/** The try-it panel. */
function panel(): HTMLElement {
  return page().getByTestId("tryit");
}

/** Renders the app at `/docs/http` over `fetch` and returns a driver. */
export async function mountHttpDocs(
  fetch: FetchLike,
  csrfHeader: string,
): Promise<HttpDocsDriver> {
  visit("/jobs/docs/http");
  renderApp({ config: { csrfHeader }, fetch });
  await page().findByRole(
    "navigation",
    { name: "Operations" },
    { timeout: 5_000 },
  );
  // Looked up per use: moving between `/docs/http` and an operation
  // changes route, which renders a new sidebar.
  const nav = () => page().getByRole("navigation", { name: "Operations" });
  return {
    operations: () =>
      Array.from(
        nav().querySelectorAll<HTMLAnchorElement>("a.http-op-link"),
        (link) => link.dataset.operation ?? "",
      ),
    openOperation: async (operationId) => {
      fireEvent.click(
        nav().querySelector<HTMLAnchorElement>(
          `a[data-operation="${operationId}"]`,
        )!,
      );
      await waitFor(() => {
        const title = page().queryByTestId("http-operation");
        if (!title?.textContent?.includes(operationId)) {
          throw new Error(`${operationId} not shown`);
        }
      });
    },
    fill: (name, value) => {
      const field = within(panel())
        .getAllByText(name, { selector: "code" })
        .map((code) => code.closest(".field"))
        .find(Boolean) as HTMLElement;
      fireEvent.change(field.querySelector("input, select, textarea")!, {
        target: { value },
      });
    },
    send: async () => {
      const button = within(panel()).getByRole("button", { name: /^Send / });
      const label = button.textContent ?? "";
      fireEvent.click(button);
      // A mutation opens its confirmation; a read goes straight out.
      await waitFor(() => {
        if (
          !document.querySelector("dialog[open]") &&
          !page().queryByTestId("tryit-result")
        ) {
          throw new Error("neither a confirmation nor a result yet");
        }
      });
      const dialog = document.querySelector<HTMLElement>("dialog[open]");
      if (dialog) {
        const typed = within(dialog).queryByLabelText(/to confirm/);
        if (typed) {
          const view = page().getByTestId("http-operation");
          const id = view.querySelector(".http-operation-id code")!.textContent;
          fireEvent.change(typed, { target: { value: id ?? "" } });
        }
        fireEvent.click(within(dialog).getByRole("button", { name: label }));
      }
      const result = await page().findByTestId(
        "tryit-result",
        {},
        { timeout: 5_000 },
      );
      return {
        status: within(result).getByTestId("tryit-status").textContent ?? "",
        text: result.textContent ?? "",
      };
    },
  };
}
