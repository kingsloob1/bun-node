/**
 * `BunHttpAdapter.getRouteMatchingOptions()`: what it reports is how the
 * router really matches, and the core asks for it only where it reads it
 * (Nest 12.2.0). What the core then does with it, on both adapters, is the
 * routing differential's `mw-exclude-matching` groups
 * (`routingCompat/probes.ts`).
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { BunRouterOptions } from "@kingsleyweb/bun-common";
import { NestFactory } from "@nestjs/core";
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter.js";
import { describe, expect, it, spyOn } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { MwExcludeMatchingModule } from "./routingCompat/app";
import { CORE_READS_ROUTE_MATCHING_OPTIONS } from "./routingCompat/harness";
import "reflect-metadata";

/** Whether the adapter's own router serves `path` with a `/users/login` route. */
async function serves(adapter: BunHttpAdapter, path: string) {
  const res = await adapter.getInstance().fetch(path);
  return res.status === 200;
}

describe("BunHttpAdapter.getRouteMatchingOptions()", () => {
  const cases: [string, BunRouterOptions | undefined, boolean][] = [
    ["the default router", undefined, true],
    ["router.caseSensitive: false", { caseSensitive: false }, false],
    ["router.caseSensitive: true", { caseSensitive: true }, true],
    // Given but unset, the router falls back to its own default, `false`.
    ["router.caseSensitive: undefined", { caseSensitive: undefined }, false],
  ];

  for (const [name, router, caseSensitive] of cases) {
    it(`reports how ${name} matches, and the router matches so`, async () => {
      const adapter = new BunHttpAdapter(0, router ? { router } : undefined);
      expect(adapter.getRouteMatchingOptions()).toEqual({
        caseSensitive,
        ignoreTrailingSlash: true,
      });

      adapter.getInstance().get("/users/login", (_req, res) => res.send("ok"));
      expect(await serves(adapter, "/users/login")).toBe(true);
      // `ignoreTrailingSlash`: the route serves its path with one slash more.
      expect(await serves(adapter, "/users/login/")).toBe(true);
      // `caseSensitive`: another case is served only by a lenient router.
      expect(await serves(adapter, "/USERS/login")).toBe(!caseSensitive);
      expect(await serves(adapter, "/Users/Login/")).toBe(!caseSensitive);
    });
  }

  it("is no member of Nest's base class, so it is declared without `override`", () => {
    expect("getRouteMatchingOptions" in AbstractHttpAdapter.prototype).toBe(
      false,
    );
  });

  it(`is ${CORE_READS_ROUTE_MATCHING_OPTIONS ? "asked by the core (12.2.0)" : "never asked by this core (before 12.2.0)"} while the middleware is registered`, async () => {
    const adapter = new BunHttpAdapter(0);
    const asked = spyOn(adapter, "getRouteMatchingOptions");
    const app = await NestFactory.create(MwExcludeMatchingModule, adapter, {
      logger: false,
    });
    try {
      app.setGlobalPrefix("api");
      await app.init();
      if (CORE_READS_ROUTE_MATCHING_OPTIONS) {
        expect(asked).toHaveBeenCalled();
      } else {
        // Nest 11 and 12.0-12.1: nothing changes, the core never calls it.
        expect(asked).not.toHaveBeenCalled();
      }
    } finally {
      await app.close();
    }
  });
});
