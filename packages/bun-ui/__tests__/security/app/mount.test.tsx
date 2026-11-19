/**
 * `mountSecurityUi` (embedding.md §2, §5 to §8) in the DOM: its root inside
 * the host's element, shell `"none"` by default with the scope picker kept,
 * the host's headers on every call (the live stream's too), `onNavigate`,
 * and teardown under the {@link HandleLedger}, with its negative control.
 */
import type { MountedUi } from "../../../lib/kit/browser/mount";
import type { mountSecurityUi as DeclaredSecurity } from "../../../lib/security/mount";
import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { expectNone } from "../../harness/assert";
import { HandleLedger, nativeSleep } from "../../harness/handleLedger";
import { act, cleanup, LOADED, render, setupDom, within } from "./dom";
import { defaultRoutes, mockApi } from "./mockApi";

setupDom();

/** Loaded after the DOM exists: react-dom decides at evaluation whether one does. */
const { mountSecurityApp } = await import("../../../app/security/mountApp");
const { mountSecurityUi } = await import("../../../app/security/mount");

beforeAll(() => {
  render(<div />);
  cleanup();
});

/** Undoes what a test set up. */
const undo: (() => void)[] = [];
afterEach(() => {
  for (const step of undo.splice(0).reverse()) step();
});

/** A `fetch` as the clients call it. */
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Serves the fake API through the global `fetch` the mount sends with, optionally through `wrap`. */
function serveApi(wrap: (fetch: Fetch) => Fetch = (inner) => inner) {
  const api = mockApi("/security/api", defaultRoutes());
  const served = wrap((input, init) => api.fetch(input, init));
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    served as unknown as typeof fetch,
  );
  undo.push(() => spy.mockRestore());
  return api;
}

/** A host element in the page. */
function hostElement(): HTMLElement {
  const element = document.createElement("section");
  document.body.append(element);
  undo.push(() => element.remove());
  return element;
}

/** Mounts with no retries and the live stream as the options say. */
function mount(
  element: HTMLElement,
  options: Record<string, unknown> = {},
  live = false,
): MountedUi {
  let ui: MountedUi | undefined;
  act(() => {
    ui = mountSecurityApp(
      element,
      { apiBase: "/security/api", basePath: "/security", ...options },
      { retry: false, live: { disabled: !live }, storage: null },
    );
  });
  return ui!;
}

describe("mountSecurityUi", () => {
  it('renders in its own root, shell "none" keeping the scope picker', async () => {
    serveApi();
    const element = hostElement();
    const ui = mount(element);
    const root = element.querySelector<HTMLElement>(
      '[data-bun-ui="security"]',
    )!;
    await within(root).findByTestId("analytics", {}, LOADED);
    expect(within(root).getByTestId("app-bar")).toBeTruthy();
    expect(within(root).getByTestId("scope-picker")).toBeTruthy();
    expectNone(within(root).queryAllByTestId("nav"), "side navs");
    act(() => ui.unmount());
    expectNone(element.children, "the host's children");
  });

  it("sends the host's headers and credentials on every call", async () => {
    const api = serveApi();
    const element = hostElement();
    const ui = mount(element, {
      headers: () => ({ authorization: "Bearer s" }),
      credentials: "include",
    });
    const root = element.querySelector<HTMLElement>(
      '[data-bun-ui="security"]',
    )!;
    await within(root).findByTestId("analytics", {}, LOADED);
    expect(api.calls.length).toBeGreaterThan(0);
    for (const call of api.calls) {
      expect(call.headers.get("authorization")).toBe("Bearer s");
      expect(
        call.headers.get("x-bun-security-csrf") === null ||
          call.method !== "GET",
      ).toBe(true);
    }
    act(() => ui.unmount());
  });

  it("hands its navigations to onNavigate", async () => {
    serveApi();
    const calls: string[] = [];
    const element = hostElement();
    const ui = mount(element, {
      shell: "tabs",
      onNavigate: (path: string) => calls.push(path),
    });
    const root = element.querySelector<HTMLElement>(
      '[data-bun-ui="security"]',
    )!;
    const tabs = await within(root).findByTestId("section-tabs", {}, LOADED);
    act(() => within(tabs).getByRole("link", { name: "Bans" }).click());
    expect(calls).toEqual(["/security/bans"]);
    expect(window.location.pathname).toBe("/security");
    act(() => ui.unmount());
  });
});

describe("a mounted security UI leaves nothing behind", () => {
  it("live on, across its sections: every handle closes on unmount", async () => {
    const ledger = new HandleLedger();
    ledger.install();
    undo.push(() => {
      ledger.disposeAll();
      ledger.uninstall();
    });
    serveApi((inner) => ledger.trackFetch(inner));
    const element = hostElement();
    ledger.trackListeners(element, "host");
    const ui = mount(element, { shell: "full" }, true);
    const root = element.querySelector<HTMLElement>(
      '[data-bun-ui="security"]',
    )!;
    await within(root).findByTestId("analytics", {}, LOADED);
    for (const path of ["/bans", "/events", "/audit", "/"]) {
      await act(async () => {
        ui.navigate(path);
        await nativeSleep(20);
      });
    }
    expect(ledger.opened("fetch").length).toBeGreaterThan(0);
    // Negative control: still mounted, so something is open.
    expect(() => ledger.assertNoneOpen()).toThrow("outlived the unmount");
    await act(async () => {
      ui.unmount();
      await nativeSleep(20);
    });
    await act(async () => {
      await nativeSleep(20);
    });
    ledger.assertNoneOpen();
  });
});

describe("the published declaration", () => {
  it("is the entry's own type (lib/security/mount.ts)", () => {
    const declared: typeof DeclaredSecurity = mountSecurityUi;
    expect(declared).toBe(mountSecurityUi);
    // Negative control: a function of another shape is refused.
    // @ts-expect-error the declaration takes (element, options) and returns MountedUi
    const wrong: typeof DeclaredSecurity = (element: string) => element;
    expect(typeof wrong).toBe("function");
  });
});
