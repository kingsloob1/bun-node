/**
 * The docs viewer under each `shell` (embedding.md §12 item 8): `"tabs"`
 * names the one `DOCS_SECTIONS` entry matching the document in the kit's
 * compact bar; `"full"` (as before) and `"none"` draw no frame. And the
 * config check: a missing `shell` (bun-common's mirrored config, an older
 * shell) is `"full"`, a bad one is refused.
 */
import { describe, expect, it } from "bun:test";
import { DocsUiConfigError, parseDocsUiConfig } from "../../../app/docs/config";
import { docsSectionAt } from "../../../app/docs/layout/sections";
import { DOCS_SECTIONS } from "../../../lib/docs/browser/sections";
import { expectAbsent, expectNone } from "../../harness/assert";
import { LOADED } from "../../harness/dom";
import { page, setupDom, waitFor, within } from "./dom";
import { renderViewer, viewerConfig } from "./renderViewer";

setupDom();

/** A one-operation OpenAPI 3.1 document. */
const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Shop", version: "1" },
  paths: {
    "/orders": {
      get: {
        operationId: "listOrders",
        responses: { 200: { description: "OK" } },
      },
    },
  },
};

/** A one-channel AsyncAPI 3.0 document. */
const ASYNCAPI = {
  asyncapi: "3.0.0",
  info: { title: "Shop events", version: "1" },
  channels: { orders: { address: "orders" } },
};

/** The tab labels, once the viewer shows its bar. */
async function tabLabels(): Promise<string[]> {
  const tabs = await page().findByTestId("section-tabs", {}, LOADED);
  return within(tabs)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

describe("DOCS_SECTIONS", () => {
  it("is HTTP API and WebSocket API, neither needing a permission", () => {
    expect(DOCS_SECTIONS).toEqual([
      { id: "http", label: "HTTP API", path: "/http", needs: null },
      { id: "ws", label: "WebSocket API", path: "/ws", needs: null },
    ]);
  });

  it("names the section a path is in, none at the landing", () => {
    expect(docsSectionAt("/http")?.id).toBe("http");
    expect(docsSectionAt("/http/listOrders")?.id).toBe("http");
    expect(docsSectionAt("/ws/orders")?.id).toBe("ws");
    expectAbsent(docsSectionAt("/"));
    expectAbsent(docsSectionAt("/httpx"));
    expectAbsent(docsSectionAt(null));
  });
});

describe("shell", () => {
  it('"tabs" shows only the HTTP API for an OpenAPI document', async () => {
    await renderViewer({ document: OPENAPI, config: { shell: "tabs" } });
    expect(await tabLabels()).toEqual(["HTTP API"]);
  });

  it('"tabs" shows only the WebSocket API for an AsyncAPI document', async () => {
    await renderViewer({ document: ASYNCAPI, config: { shell: "tabs" } });
    expect(await tabLabels()).toEqual(["WebSocket API"]);
  });

  it('"full" and "none" draw no bar (the viewer has no header)', async () => {
    for (const shell of ["full", "none"] as const) {
      const { unmount } = await renderViewer({
        document: OPENAPI,
        config: { shell },
      });
      // Loaded: the landing sent the OpenAPI document to its section.
      await waitFor(
        () => expect(window.location.pathname).toBe("/docs/http"),
        LOADED,
      );
      expectNone(page().queryAllByTestId("app-bar"), `bars under ${shell}`);
      unmount();
    }
  });
});

describe("parseDocsUiConfig: shell", () => {
  it("takes a missing shell as full, keeps a valid one, refuses a bad one", () => {
    const { shell: _chrome, ...without } = viewerConfig();
    expect(parseDocsUiConfig(without).shell).toBe("full");
    expect(parseDocsUiConfig(viewerConfig({ shell: "tabs" })).shell).toBe(
      "tabs",
    );
    for (const bad of [null, "header", 1]) {
      expect(() =>
        parseDocsUiConfig({ ...viewerConfig(), shell: bad }),
      ).toThrow(DocsUiConfigError);
    }
  });
});
