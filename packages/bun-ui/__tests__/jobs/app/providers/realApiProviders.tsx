import type { FetchLike } from "../../../app/api/client";
import { fireEvent, page, visit, waitFor, within } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the Providers screen for `pkg/providers.integration.test.ts`, which
 * runs it against a REAL `createJobsApi` and real configured providers. That
 * test compiles without the DOM lib, so everything touching the DOM lives
 * here and the test loads it by a dynamic import. It reports what the page
 * shows and leaves the assertions to the test.
 */

/** What the screen shows of one provider. */
export interface ProviderCardView {
  /** Its readiness badge's text. */
  readiness: string;
  /** Whether it offers Test connection. */
  testable: boolean;
  /** The card's whole text. */
  text: string;
}

/** What the test can do with the mounted screen. */
export interface ProvidersDriver {
  /** Reads provider `id`'s card once it is there. */
  card: (id: string) => Promise<ProviderCardView>;
  /** Runs Test connection on provider `id`, and resolves its result's text and `data-ok`. */
  test: (id: string) => Promise<{ text: string; ok: string | undefined }>;
  /** Unmounts the app. */
  unmount: () => void;
}

/** Renders the app on `/providers` over `fetch` and returns a driver. */
export async function mountProviders(
  fetch: FetchLike,
  csrfHeader: string,
): Promise<ProvidersDriver> {
  visit("/jobs/providers");
  const rendered = renderApp({ fetch, config: { csrfHeader } });
  await page().findByTestId("providers-screen", {}, { timeout: 10_000 });
  const find = (id: string) =>
    page().findByTestId(`provider-${id}`, {}, { timeout: 10_000 });
  return {
    card: async (id) => {
      const card = await find(id);
      let view: ProviderCardView | null = null;
      await waitFor(() => {
        const badge = within(card).getByTestId("provider-readiness");
        view = {
          readiness: badge.textContent ?? "",
          testable:
            within(card).queryByRole("button", { name: /Test connection/ }) !==
            null,
          text: card.textContent ?? "",
        };
      });
      return view!;
    },
    test: async (id) => {
      const card = await find(id);
      fireEvent.click(
        within(card).getByRole("button", { name: /Test connection/ }),
      );
      const result = await within(card).findByTestId(
        "provider-test-result",
        {},
        { timeout: 10_000 },
      );
      return { text: result.textContent ?? "", ok: result.dataset.ok };
    },
    unmount: () => rendered.unmount(),
  };
}
