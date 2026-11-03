/**
 * `routeDocFor` reads a `"bun:describe"` reflect-metadata doc beside
 * `describe()`'s store (typed-client plan `nest-typed-routes.md` §3.2,
 * PR-N3): what bun-nest's `@Describe` writes, and NestJS's
 * `copyMetadataToCallback` carries onto a handler. bun-common has no
 * reflect-metadata, so this file installs a minimal stand-in for the two
 * calls (removed after), unless the polyfill is already up.
 */
import type { RouterHandler } from "../../lib/types/general";
import { afterAll, describe, expect, it } from "bun:test";
import { BunRouter } from "../../lib/BunRouter";
import { generateOpenApi } from "../../lib/docs/openapi";
import { attachRouteDoc, routeDocFor } from "../../lib/docs/routeDoc";

/** `Reflect` with the polyfill's two calls, when present. */
const reflect = Reflect as unknown as {
  getMetadata?: (key: unknown, target: object) => unknown;
  defineMetadata?: (key: unknown, value: unknown, target: object) => void;
};
const installed = reflect.getMetadata === undefined;
if (installed) {
  const store = new WeakMap<object, Map<unknown, unknown>>();
  reflect.defineMetadata = (key, value, target) => {
    let map = store.get(target);
    if (map === undefined) store.set(target, (map = new Map()));
    map.set(key, value);
  };
  reflect.getMetadata = (key, target) => store.get(target)?.get(key);
}
afterAll(() => {
  if (!installed) return;
  delete reflect.getMetadata;
  delete reflect.defineMetadata;
});

describe('routeDocFor: the "bun:describe" metadata', () => {
  it("reads a doc written as metadata on the callback", () => {
    const handler = () => undefined;
    reflect.defineMetadata?.("bun:describe", { summary: "meta" }, handler);
    expect(routeDocFor(handler)).toEqual({ summary: "meta" });
  });

  it("merges describe()'s doc over the metadata's, per top-level key", () => {
    const handler = () => undefined;
    reflect.defineMetadata?.(
      "bun:describe",
      { summary: "meta", tags: ["a"] },
      handler,
    );
    attachRouteDoc(handler, { summary: "describe()" });
    expect(routeDocFor(handler)).toEqual({
      summary: "describe()",
      tags: ["a"],
    });
  });

  it("ignores a key it does not own, and a value that is not an object (control)", () => {
    const handler = () => undefined;
    reflect.defineMetadata?.("bun:other", { summary: "x" }, handler);
    expect(routeDocFor(handler)).toBeUndefined();
    reflect.defineMetadata?.("bun:describe", "not a doc", handler);
    expect(routeDocFor(handler)).toBeUndefined();
  });

  it("reaches the OpenAPI document, hidden included", () => {
    const app = new BunRouter();
    const shown: RouterHandler = (_req, res) => {
      res.json({});
    };
    const hidden: RouterHandler = (_req, res) => {
      res.json({});
    };
    reflect.defineMetadata?.(
      "bun:describe",
      { summary: "Shown", errors: ["E"] },
      shown,
    );
    reflect.defineMetadata?.("bun:describe", { hidden: true }, hidden);
    app.get("/shown", shown);
    app.get("/hidden", hidden);
    const { document } = generateOpenApi(app, { title: "t", version: "1" });
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(Object.keys(paths)).toEqual(["/shown"]);
    expect(paths["/shown"]?.get).toMatchObject({
      summary: "Shown",
      "x-bun-errors": ["E"],
    });
  });
});
