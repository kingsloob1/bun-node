/**
 * `mountDocsUi` (embedding.md §2, §5 to §8) in the DOM: its root inside the
 * host's element, the document through the host's headers, its redirect to
 * the document's section under `onNavigate`, and teardown under the
 * {@link HandleLedger}, with its negative control.
 */
import type { MountedUi } from "../../../lib/kit/browser/mount";
import type { mountDocsUi as DeclaredDocs } from "../../../lib/docs/mount";
import { expectNone } from "../../harness/assert";
import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { HandleLedger, nativeSleep } from "../../harness/handleLedger";
import { LOADED } from "../../harness/dom";
import { act, cleanup, render, setupDom, waitFor, within } from "./dom";

setupDom();

/** Loaded after the DOM exists: react-dom decides at evaluation whether one does. */
const { mountDocsApp } = await import("../../../app/docs/mountApp");
const { mountDocsUi } = await import("../../../app/docs/mount");

beforeAll(() => {
  render(<div />);
  cleanup();
});

/** A one-operation OpenAPI 3.1 document. */
const DOCUMENT = {
  openapi: "3.1.0",
  info: { title: "Shop", version: "1" },
  paths: {
    "/orders": {
      get: {
        operationId: "listOrders",
        summary: "List the orders",
        responses: { 200: { description: "OK" } },
      },
    },
  },
};

/** Undoes what a test set up. */
const undo: (() => void)[] = [];
afterEach(() => {
  for (const step of undo.splice(0).reverse()) step();
});

/** The requests the document's server saw. */
let seen: { url: string; headers: Record<string, string> }[] = [];

/** Serves the document through the global `fetch`, optionally through `wrap`. */
function serve(
  wrap: (
    fetch: (input: string, init: RequestInit) => Promise<Response>,
  ) => (input: string, init: RequestInit) => Promise<Response> = (f) => f,
) {
  seen = [];
  const inner = async (input: string, init: RequestInit) => {
    seen.push({
      url: input,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(DOCUMENT), {
      headers: { "content-type": "application/json" },
    });
  };
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    wrap(inner) as unknown as typeof fetch,
  );
  undo.push(() => spy.mockRestore());
}

/** A host element in the page. */
function hostElement(): HTMLElement {
  const element = document.createElement("section");
  document.body.append(element);
  undo.push(() => element.remove());
  return element;
}

/** Mounts the viewer with no retries. */
function mount(
  element: HTMLElement,
  options: Record<string, unknown> = {},
): MountedUi {
  let ui: MountedUi | undefined;
  act(() => {
    ui = mountDocsApp(
      element,
      { documentUrl: "/docs/document.json", basePath: "/docs", ...options },
      { retry: false },
    );
  });
  return ui!;
}

describe("mountDocsUi", () => {
  it("renders the document in its own root, read with the host's headers", async () => {
    serve();
    const element = hostElement();
    const ui = mount(element, {
      headers: () => ({ authorization: "Bearer d" }),
    });
    const root = element.querySelector<HTMLElement>('[data-bun-ui="docs"]')!;
    await within(root).findAllByText(
      "List the orders",
      { exact: false },
      LOADED,
    );
    expect(seen[0].url).toBe("/docs/document.json");
    expect(seen[0].headers.authorization).toBe("Bearer d");
    act(() => ui.unmount());
    expectNone(element.children, "the host's children");
  });

  it("hands its redirect to the document's section to onNavigate, as a replace", async () => {
    serve();
    const calls: [string, boolean][] = [];
    const element = hostElement();
    const ui = mount(element, {
      onNavigate: (path: string, { replace }: { replace: boolean }) =>
        calls.push([path, replace]),
    });
    await waitFor(() => expect(calls).toEqual([["/docs/http", true]]), {
      timeout: 3_000,
    });
    expect(window.location.pathname).toBe("/docs");
    act(() => ui.unmount());
  });

  it("leaves nothing behind on unmount (negative control: before it, the listeners are open)", async () => {
    const ledger = new HandleLedger();
    ledger.install();
    undo.push(() => {
      ledger.disposeAll();
      ledger.uninstall();
    });
    serve((inner) => ledger.trackFetch(inner));
    const element = hostElement();
    ledger.trackListeners(element, "host");
    const ui = mount(element);
    const root = element.querySelector<HTMLElement>('[data-bun-ui="docs"]')!;
    await within(root).findAllByText(
      "List the orders",
      { exact: false },
      LOADED,
    );
    expect(() => ledger.assertNoneOpen()).toThrow("listener window");
    await act(async () => {
      ui.unmount();
      await nativeSleep(20);
    });
    ledger.assertNoneOpen();
  });
});

describe("the published declaration", () => {
  it("is the entry's own type (lib/docs/mount.ts)", () => {
    const declared: typeof DeclaredDocs = mountDocsUi;
    expect(declared).toBe(mountDocsUi);
    // Negative control: a function of another shape is refused.
    // @ts-expect-error the declaration takes (element, options) and returns MountedUi
    const wrong: typeof DeclaredDocs = (element: string) => element;
    expect(typeof wrong).toBe("function");
  });
});
