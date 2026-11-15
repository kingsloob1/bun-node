/**
 * The `layout` option (#785) in the docs viewer: the config check takes a
 * missing layout (bun-common's `docsRouter` mirrors the config, and an older
 * one has none) as the default and refuses a malformed one, and `boot()`
 * applies the config's to the root element before the first render. The CSS
 * is measured in Chrome (`__tests__/jobs/e2e/layout.e2e.test.ts`).
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { DocsUiConfigError, parseDocsUiConfig } from "../../../app/docs/config";
import { CONTENT_MAX_WIDTH_PROPERTY } from "../../../app/kit/layout";
import { DOCS_UI_CONFIG_ELEMENT_ID } from "../../../lib/docs/browser/config.ts";
import { act, setupDom } from "./dom";
import { viewerConfig } from "./renderViewer";

setupDom();

/** Loaded after the DOM exists: react-dom decides at evaluation whether one does. */
const { boot } = await import("../../../app/docs/boot");

afterEach(() => {
  const root = document.documentElement;
  delete root.dataset.align;
  delete root.dataset.layoutScope;
  root.style.removeProperty(CONTENT_MAX_WIDTH_PROPERTY);
});

describe("parseDocsUiConfig: layout", () => {
  it("takes a missing layout as the default", () => {
    const { layout: _layout, ...withoutLayout } = viewerConfig();
    expect(parseDocsUiConfig(withoutLayout).layout).toEqual({
      align: "center",
      scope: "content",
      maxWidth: 1400,
    });
  });

  it("keeps a valid one and refuses a malformed one", () => {
    const layout = { align: "right", scope: "content", maxWidth: 800 } as const;
    expect(parseDocsUiConfig(viewerConfig({ layout })).layout).toEqual(layout);
    for (const bad of [
      null,
      "left",
      { align: "left", scope: "content", maxWidth: 10 },
    ]) {
      expect(() =>
        parseDocsUiConfig({ ...viewerConfig(), layout: bad }),
      ).toThrow(DocsUiConfigError);
    }
  });
});

describe("boot", () => {
  it("applies the config's layout before the viewer renders", () => {
    // The viewer fetches its document on mount: never answered here.
    const pending = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(pending);
    const script = document.createElement("script");
    script.type = "application/json";
    script.id = DOCS_UI_CONFIG_ELEMENT_ID;
    script.textContent = JSON.stringify(
      viewerConfig({
        layout: { align: "right", scope: "content", maxWidth: 1100 },
      }),
    );
    const container = document.createElement("div");
    container.id = "root";
    document.body.append(script, container);
    const { root } = boot({ retry: false });
    try {
      const html = document.documentElement;
      expect(html.dataset.align).toBe("right");
      expect(html.dataset.layoutScope).toBe("content");
      expect(html.style.getPropertyValue(CONTENT_MAX_WIDTH_PROPERTY)).toBe(
        "1100px",
      );
    } finally {
      act(() => root.unmount());
      fetchSpy.mockRestore();
    }
  });
});
