/**
 * `mountJobsUi` (embedding.md §2, §5 to §8) in the DOM: the root it creates
 * inside the host's element, its shell, the reader's `rem`, theme and layout
 * on the root, the host's headers and credentials, `onUnauthorized`, both
 * kinds of history, a path outside `basePath`, and teardown, two mounts and
 * a remount. What leaks is `mountLeaks.test.tsx`'s.
 */
import type { MountedUi } from "../../../lib/kit/browser/mount";
import type {
  JobsMountOptions,
  mountJobsUi as DeclaredJobs,
} from "../../../lib/jobs/mount";
import type { MockHandler, MockReply } from "./mockFetch";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  expectAbsent,
  expectNone,
  expectUndefined,
} from "../../harness/assert";
import { act, LOADED, page, setupDom, waitFor, within } from "./dom";
import { mockFetch } from "./mockFetch";
import { defaultHandlers } from "./renderApp";

setupDom();

/** Loaded after the DOM exists: react-dom decides at evaluation whether one does. */
const { mountJobsApp } = await import("../../../app/jobs/mountApp");
const { mountJobsUi } = await import("../../../app/jobs/mount");

/** Everything one test mounted, unmounted after it. */
const mounted: MountedUi[] = [];
/** Restores the global `fetch` after a test that served the API. */
let restoreFetch: (() => void) | undefined;
afterEach(() => {
  for (const ui of mounted.splice(0)) act(() => ui.unmount());
  restoreFetch?.();
  restoreFetch = undefined;
});

/** A host element in the page, with an id of its own. */
function hostElement(id = "host"): HTMLElement {
  const element = document.createElement("section");
  element.id = id;
  element.className = "host-area";
  document.body.append(element);
  return element;
}

/** Serves the API from `handlers` over the default ones, through the global `fetch` the mount sends with. */
function serveApi(handlers: Record<string, MockHandler | MockReply> = {}) {
  const mock = mockFetch({ ...defaultHandlers(), ...handlers });
  const spy = spyOn(globalThis, "fetch").mockImplementation(((
    input: string,
    init: RequestInit,
  ) => mock.fetch(input, init)) as unknown as typeof fetch);
  restoreFetch = () => spy.mockRestore();
  return mock;
}

/** Mounts with the test internals (no socket, no retries). */
function mount(
  element: HTMLElement,
  options: Partial<JobsMountOptions> = {},
): MountedUi {
  let ui: MountedUi | undefined;
  act(() => {
    ui = mountJobsApp(
      element,
      { apiBase: "/jobs-api", basePath: "/jobs", ...options },
      { live: { disabled: true }, retry: false },
    );
  });
  mounted.push(ui!);
  return ui!;
}

/** The root a mount made inside `element`. */
function rootOf(element: HTMLElement): HTMLElement {
  const roots = element.querySelectorAll<HTMLElement>(
    ':scope > [data-bun-ui="jobs"]',
  );
  expect(roots).toHaveLength(1);
  return roots[0];
}

describe("the mount root", () => {
  it("is a div it creates inside the host's element, which it leaves as it was", async () => {
    serveApi();
    const element = hostElement();
    mount(element);
    const root = rootOf(element);
    expect(root.tagName).toBe("DIV");
    await within(root).findByTestId("overview", {}, LOADED);
    expect(element.getAttributeNames().sort()).toEqual(["class", "id"]);
    expect(element.className).toBe("host-area");
    expect(element.style.length).toBe(0);
  });

  it('draws shell "none" by default: no header, no nav', async () => {
    serveApi();
    const element = hostElement();
    mount(element);
    const root = rootOf(element);
    await within(root).findByTestId("overview", {}, LOADED);
    expect(within(root).getByTestId("app-ready").dataset.shell).toBe("none");
    expectNone(within(root).queryAllByRole("banner"), "headers");
    expectNone(within(root).queryAllByRole("navigation"), "navs");
  });

  it('draws the shell the host asks for ("tabs")', async () => {
    serveApi();
    const element = hostElement();
    mount(element, { shell: "tabs" });
    const tabs = await within(rootOf(element)).findByTestId(
      "section-tabs",
      {},
      LOADED,
    );
    expect(within(tabs).getAllByRole("link")[0].textContent).toBe("Overview");
  });

  it("refuses a missing element, apiBase or basePath with a TypeError", () => {
    expect(() =>
      mountJobsUi(null as unknown as HTMLElement, {
        apiBase: "/jobs-api",
        basePath: "/jobs",
      }),
    ).toThrow(TypeError);
    expect(() =>
      mountJobsUi(hostElement(), { basePath: "/jobs" } as JobsMountOptions),
    ).toThrow("mountJobsUi needs apiBase");
    expect(() =>
      mountJobsUi(hostElement(), { apiBase: "/jobs-api" } as JobsMountOptions),
    ).toThrow("mountJobsUi needs basePath");
    expectNone(document.querySelectorAll("[data-bun-ui]"), "mount roots");
  });
});

describe("the reader's rem, the theme and the layout", () => {
  it("sets --bun-ui-rem from a probe at font-size: medium (a larger default honoured)", async () => {
    serveApi();
    const real = window.getComputedStyle.bind(window);
    const spy = spyOn(window, "getComputedStyle").mockImplementation(
      (element: Element) =>
        (element as HTMLElement).style?.fontSize === "medium"
          ? ({ fontSize: "20px" } as CSSStyleDeclaration)
          : real(element),
    );
    try {
      const element = hostElement();
      mount(element);
      const root = rootOf(element);
      expect(root.style.getPropertyValue("--bun-ui-rem")).toBe("20px");
      // The probe is gone.
      expectNone(root.querySelectorAll("span[style]"), "probes");
    } finally {
      spy.mockRestore();
    }
  });

  it("negative control: no pixel size reported, no property (the stylesheet's 16px then)", () => {
    serveApi();
    const spy = spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          fontSize: "medium",
        }) as CSSStyleDeclaration,
    );
    try {
      const element = hostElement();
      mount(element);
      expect(rootOf(element).style.getPropertyValue("--bun-ui-rem")).toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  it("puts the theme and layout on the root, never on <html>", () => {
    serveApi();
    const element = hostElement();
    const ui = mount(element, {
      theme: "dark",
      layout: { align: "center", maxWidth: 960 },
    });
    const root = rootOf(element);
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.align).toBe("center");
    expect(root.dataset.layoutScope).toBe("content");
    expect(root.style.getPropertyValue("--content-max-width")).toBe("960px");
    expectUndefined(document.documentElement.dataset.theme, "<html>'s theme");
    expectUndefined(document.documentElement.dataset.align, "<html>'s align");
    act(() => ui.setTheme("light"));
    expect(root.dataset.theme).toBe("light");
    act(() => ui.setTheme("system"));
    expectUndefined(root.dataset.theme, "the root's theme under system");
  });

  it("defaults to theme \"inherit\" (the host's, via themeSource) and the host's width", () => {
    serveApi();
    let host: "light" | "dark" = "dark";
    const element = hostElement();
    const ui = mount(element, { themeSource: () => host });
    const root = rootOf(element);
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.align).toBe("left");
    expect(root.style.getPropertyValue("--content-max-width")).toBe("none");
    host = "light";
    act(() => ui.setTheme("inherit"));
    expect(root.dataset.theme).toBe("light");
  });
});

describe("requests from the host", () => {
  it("carry the host's headers (per request) and credentials beside the client's own", async () => {
    const api = serveApi();
    let token = "t1";
    const element = hostElement();
    const ui = mount(element, {
      headers: () => ({ authorization: `Bearer ${token}` }),
      credentials: "include",
      csrfHeader: "x-jobs-csrf",
    });
    await within(rootOf(element)).findByTestId("overview", {}, LOADED);
    const meta = api.calls.find((call) => call.path === "/meta")!;
    expect(meta.headers.authorization).toBe("Bearer t1");
    expect(meta.headers.accept).toBe("application/json");
    expect(meta.credentials).toBe("include");
    token = "t2";
    // A later request asks headers() again.
    act(() => ui.navigate("/queues"));
    await within(rootOf(element)).findByTestId("queues-list", {}, LOADED);
    const queues = api.calls.findLast((call) => call.path === "/queues")!;
    expect(queues.headers.authorization).toBe("Bearer t2");
    expect(queues.credentials).toBe("include");
  });

  it("calls onUnauthorized with the status of a 401, once, instead of redirecting", async () => {
    serveApi({
      "GET /meta": {
        status: 401,
        body: {
          code: "UNAUTHORIZED",
          status: 401,
          title: "Unauthorized",
          type: "urn:x",
        },
      },
    });
    const statuses: number[] = [];
    const element = hostElement();
    mount(element, {
      onUnauthorized: (status) => statuses.push(status),
      unauthorized: {
        redirectTo: "/login",
        returnParam: "returnTo",
        statuses: [401],
      },
    });
    await waitFor(() => expect(statuses).toEqual([401]), LOADED);
    // The kit's redirect never ran: the browser is still on the UI.
    expect(window.location.pathname).toBe("/jobs");
  });
});

describe("history", () => {
  it("by default pushes the page's history, and navigate() shows a screen", async () => {
    serveApi();
    const element = hostElement();
    const ui = mount(element);
    const root = rootOf(element);
    await within(root).findByTestId("overview", {}, LOADED);
    act(() => ui.navigate("/queues"));
    expect(window.location.pathname).toBe("/jobs/queues");
    await within(root).findByTestId("queues-list", {}, LOADED);
    act(() => {
      window.history.pushState(null, "", "/jobs");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await within(root).findByTestId("overview", {}, LOADED);
  });

  it("with onNavigate hands navigations to the host and leaves the page's URL alone", async () => {
    serveApi();
    const calls: [string, boolean][] = [];
    const element = hostElement();
    const ui = mount(element, {
      shell: "tabs",
      onNavigate: (path, { replace }) => calls.push([path, replace]),
    });
    const root = rootOf(element);
    const tabs = await within(root).findByTestId("section-tabs", {}, LOADED);
    act(() => {
      within(tabs).getByRole("link", { name: "Queues" }).click();
    });
    expect(calls).toEqual([["/jobs/queues", false]]);
    expect(window.location.pathname).toBe("/jobs");
    // The UI shows the screen at once.
    await within(root).findByTestId("queues-list", {}, LOADED);
    // The host's own navigation back.
    act(() => ui.navigate("/"));
    await within(root).findByTestId("overview", {}, LOADED);
    expect(calls).toHaveLength(1);
  });

  it("renders nothing for a URL outside its basePath (the host's page)", async () => {
    serveApi();
    window.history.replaceState(null, "", "/elsewhere");
    const element = hostElement();
    mount(element);
    const root = rootOf(element);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expectAbsent(within(root).queryByTestId("app-ready"));
    expectAbsent(within(root).queryByText(/not found/i));
  });
});

describe("teardown and more than one mount", () => {
  it("unmount() removes the root; a second call does nothing", async () => {
    serveApi();
    const element = hostElement();
    const ui = mount(element);
    await within(rootOf(element)).findByTestId("overview", {}, LOADED);
    act(() => ui.unmount());
    expectNone(element.children, "the host's children");
    act(() => ui.unmount());
    act(() => ui.navigate("/queues"));
    expectNone(element.children, "the host's children");
  });

  it("two mounts on one page each render in their own root", async () => {
    serveApi();
    const first = hostElement("first");
    const second = hostElement("second");
    mount(first);
    mount(second, { shell: "tabs" });
    await within(rootOf(first)).findByTestId("overview", {}, LOADED);
    await within(rootOf(second)).findByTestId("section-tabs", {}, LOADED);
    expectNone(
      within(rootOf(first)).queryAllByTestId("section-tabs"),
      "tabs in the first",
    );
    expect(page().getAllByTestId("app-ready")).toHaveLength(2);
  });

  it("mounts again into the same element after an unmount", async () => {
    serveApi();
    const element = hostElement();
    const ui = mount(element);
    await within(rootOf(element)).findByTestId("overview", {}, LOADED);
    act(() => ui.unmount());
    mount(element);
    await within(rootOf(element)).findByTestId("overview", {}, LOADED);
  });
});

describe("the published declaration", () => {
  it("is the entry's own type (lib/jobs/mount.ts)", () => {
    const declared: typeof DeclaredJobs = mountJobsUi;
    expect(declared).toBe(mountJobsUi);
    // Negative control: a function of another shape is refused.
    // @ts-expect-error the declaration takes (element, options) and returns MountedUi
    const wrong: typeof DeclaredJobs = (element: string) => element;
    expect(typeof wrong).toBe("function");
  });
});
