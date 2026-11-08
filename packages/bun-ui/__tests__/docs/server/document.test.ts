/**
 * The `document` thunk's route: the router serves the document at
 * `<basePath>/document.json`, same-origin, so the viewer's strict CSP needs
 * no exception for it.
 */
import { createTestLogger } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { DOCUMENT_SUBPATH } from "../../lib/docsUi";
import { fixtureDocsUi } from "./helpers";

/** A small OpenAPI document. */
const DOCUMENT = {
  openapi: "3.1.0",
  info: { title: "Shop", version: "1.0.0" },
  paths: {},
};

describe("the document route", () => {
  it("serves the thunk's document as JSON, no-store", async () => {
    const ui = fixtureDocsUi({ document: () => DOCUMENT });
    const response = await ui.router.fetch(DOCUMENT_SUBPATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual(DOCUMENT);
  });

  it("calls the thunk on every request, awaiting it", async () => {
    let calls = 0;
    const ui = fixtureDocsUi({
      document: async () => {
        await Bun.sleep(1);
        calls++;
        return { ...DOCUMENT, info: { ...DOCUMENT.info, title: `v${calls}` } };
      },
    });
    const first = await (await ui.router.fetch(DOCUMENT_SUBPATH)).json();
    const second = await (await ui.router.fetch(DOCUMENT_SUBPATH)).json();
    expect(first).toMatchObject({ info: { title: "v1" } });
    expect(second).toMatchObject({ info: { title: "v2" } });
  });

  it("answers HEAD with the length and no body", async () => {
    const ui = fixtureDocsUi({ document: () => DOCUMENT });
    const size = JSON.stringify(DOCUMENT).length;
    const response = await ui.router.fetch(DOCUMENT_SUBPATH, {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(size));
    expect(await response.text()).toBe("");
  });

  it("a throwing thunk is a 500 problem, logged, never the error's text", async () => {
    const { logger, events } = createTestLogger();
    const ui = fixtureDocsUi({
      logger,
      document: () => {
        throw new Error("registry is down");
      },
    });
    const response = await ui.router.fetch(DOCUMENT_SUBPATH);
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: "INTERNAL", status: 500 });
    expect(JSON.stringify(body)).not.toContain("registry is down");
    expect(events.some((event) => event.level === "error")).toBe(true);
  });

  it("a thunk returning a non-object is a 500 problem", async () => {
    const { logger } = createTestLogger();
    const ui = fixtureDocsUi({
      logger,
      document: () => [1, 2] as unknown as Record<string, unknown>,
    });
    const response = await ui.router.fetch(DOCUMENT_SUBPATH);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL" });
  });

  it("is a 404 problem, not the shell, when the document is a URL", async () => {
    const ui = fixtureDocsUi({ document: "/api/openapi.json" });
    const response = await ui.router.fetch(DOCUMENT_SUBPATH);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("is guarded by authorize, as a page is (asset: false)", async () => {
    const seen: { asset: boolean; path: string }[] = [];
    const ui = fixtureDocsUi({
      document: () => DOCUMENT,
      authorize: (_req, context) => {
        seen.push(context);
        return context.path !== DOCUMENT_SUBPATH;
      },
    });
    expect((await ui.router.fetch("/")).status).toBe(200);
    const denied = await ui.router.fetch(DOCUMENT_SUBPATH);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      type: "urn:bun-api-docs-ui:error:FORBIDDEN",
    });
    expect(seen).toEqual([
      { asset: false, path: "/" },
      { asset: false, path: DOCUMENT_SUBPATH },
    ]);
  });
});
