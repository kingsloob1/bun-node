/**
 * The `layout` option (#785) in the jobs app: the kit's `applyLayout` puts it
 * on the root element, the config check takes a missing layout as the
 * default and refuses a malformed one, and `boot()` applies the config's
 * before the first render. The CSS that reads it is measured in Chrome
 * (`__tests__/jobs/e2e/layout.e2e.test.ts`): happy-dom has no layout.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { parseUiConfig, UiConfigError } from "../../../app/jobs/config";
import {
  applyLayout,
  CONTENT_MAX_WIDTH_PROPERTY,
} from "../../../app/kit/layout";
import { JOBS_UI_CONFIG_ELEMENT_ID } from "../../../lib/jobs/browser/config.ts";
import { act, LOADED, page, setupDom } from "./dom";
import { uiConfig } from "./fixtures";
import { mockFetch } from "./mockFetch";
import { defaultHandlers } from "./renderApp";

setupDom();

/** Loaded after the DOM exists: see `bootstrap.test.tsx`. */
const { boot } = await import("../../../app/jobs/boot");

/** Clears what {@link applyLayout} sets, so each case starts bare. */
function resetRoot(): void {
  const root = document.documentElement;
  delete root.dataset.align;
  delete root.dataset.layoutScope;
  root.style.removeProperty(CONTENT_MAX_WIDTH_PROPERTY);
}

afterEach(resetRoot);

describe("applyLayout", () => {
  it("sets data-align, data-layout-scope and the width cap on the root", () => {
    const root = document.documentElement;
    applyLayout({ align: "right", scope: "page", maxWidth: 1200 }, root);
    expect(root.dataset.align).toBe("right");
    expect(root.dataset.layoutScope).toBe("page");
    expect(root.getAttribute("data-layout-scope")).toBe("page");
    expect(root.style.getPropertyValue(CONTENT_MAX_WIDTH_PROPERTY)).toBe(
      "1200px",
    );

    applyLayout({ align: "center", scope: "content", maxWidth: 1400 }, root);
    expect(root.dataset.align).toBe("center");
    expect(root.dataset.layoutScope).toBe("content");
    expect(root.style.getPropertyValue(CONTENT_MAX_WIDTH_PROPERTY)).toBe(
      "1400px",
    );
  });
});

describe("parseUiConfig: layout", () => {
  it("takes a missing layout as the default (a host mirroring an older config)", () => {
    const { layout: _layout, ...withoutLayout } = uiConfig();
    expect(parseUiConfig(withoutLayout).layout).toEqual({
      align: "center",
      scope: "content",
      maxWidth: 1400,
    });
  });

  it("keeps a valid one and refuses a malformed one", () => {
    const layout = { align: "left", scope: "page", maxWidth: 900 } as const;
    expect(parseUiConfig(uiConfig({ layout })).layout).toEqual(layout);
    for (const bad of [
      null,
      "center",
      { align: "middle", scope: "content", maxWidth: 1400 },
      { align: "center", scope: "content" },
    ]) {
      expect(() => parseUiConfig({ ...uiConfig(), layout: bad })).toThrow(
        UiConfigError,
      );
      expect(() => parseUiConfig({ ...uiConfig(), layout: bad })).toThrow(
        '"layout"',
      );
    }
  });
});

describe("boot", () => {
  it("applies the config's layout before the app renders", async () => {
    const script = document.createElement("script");
    script.type = "application/json";
    script.id = JOBS_UI_CONFIG_ELEMENT_ID;
    script.textContent = JSON.stringify(
      uiConfig({ layout: { align: "left", scope: "page", maxWidth: 1000 } }),
    );
    const container = document.createElement("div");
    container.id = "root";
    document.body.append(script, container);

    const api = mockFetch(defaultHandlers());
    const { root } = boot({
      client: { fetch: api.fetch },
      retry: false,
      live: { disabled: true },
    });
    try {
      // Synchronous: applied before React's first commit.
      const html = document.documentElement;
      expect(html.dataset.align).toBe("left");
      expect(html.dataset.layoutScope).toBe("page");
      expect(html.style.getPropertyValue(CONTENT_MAX_WIDTH_PROPERTY)).toBe(
        "1000px",
      );
      await page().findByTestId("app-ready", {}, LOADED);
    } finally {
      act(() => root.unmount());
    }
  });
});
