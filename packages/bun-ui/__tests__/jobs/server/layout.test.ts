/**
 * The `layout` option (#785) through the real routers, socket-free: every UI
 * (`jobsUi()`, `docsUi()`, `securityUi()`) hands the browser the checked layout, centred by
 * default, refuses a bad one with its own `ConfigError`, and serves nothing
 * else for it: no stylesheet and no change to the CSP. The list of UIs is the
 * rule's check: a new UI goes in it.
 */
import { ConfigError as CommonConfigError } from "@kingsleyweb/bun-common";
import { ConfigError as JobsConfigError } from "@kingsleyweb/bun-jobs";
import { describe, expect, it } from "bun:test";
import {
  fetchShell as fetchDocsShell,
  fixtureDocsUi,
} from "../../docs/server/helpers";
import {
  fetchSecurityShell,
  fixtureSecurityUi,
} from "../../security/server/helpers";
import { fetchShell, fixtureUi } from "./helpers";

/** The UIs under test, each over its fixture bundle, with the error it throws. */
const UIS = [
  [
    "jobsUi()",
    (options: object = {}) => fixtureUi(options),
    fetchShell,
    JobsConfigError,
  ],
  [
    "docsUi()",
    (options: object = {}) => fixtureDocsUi(options),
    fetchDocsShell,
    CommonConfigError,
  ],
  [
    "securityUi()",
    (options: object = {}) => fixtureSecurityUi(options),
    fetchSecurityShell,
    CommonConfigError,
  ],
] as const;

for (const [name, make, shellOf, ConfigError] of UIS) {
  describe(`${name} layout`, () => {
    it("is centred content at 1400px when unset", async () => {
      const ui = make();
      expect(ui.config.layout).toEqual({
        align: "center",
        scope: "content",
        maxWidth: 1400,
      });
      const { shell } = await shellOf(ui.router, "/");
      expect((shell.config as { layout: unknown }).layout).toEqual(
        ui.config.layout,
      );
    });

    it("hands the browser the checked layout, frozen", async () => {
      const ui = make({ layout: { align: "right", scope: "page" } });
      expect(ui.config.layout).toEqual({
        align: "right",
        scope: "page",
        maxWidth: 1400,
      });
      expect(Object.isFrozen(ui.config.layout)).toBe(true);
      const { shell } = await shellOf(ui.router, "/");
      expect((shell.config as { layout: unknown }).layout).toEqual({
        align: "right",
        scope: "page",
        maxWidth: 1400,
      });
    });

    it("adds no stylesheet and leaves the CSP as it is (control: no layout)", async () => {
      const plain = await shellOf(make().router, "/");
      const laid = await shellOf(
        make({ layout: { align: "left", maxWidth: 900 } }).router,
        "/",
      );
      expect(laid.shell.styles).toEqual(plain.shell.styles);
      const csp = (response: Response) =>
        response.headers
          .get("content-security-policy")!
          .replace(/'nonce-[^']+'/, "'nonce-…'");
      expect(csp(laid.response)).toBe(csp(plain.response));
      expect(csp(laid.response)).toContain("style-src 'self';");
    });

    it("refuses a bad layout with its own ConfigError", () => {
      for (const [layout, message] of [
        ["center", "layout must be an object"],
        [{ align: "middle" }, "layout.align must be"],
        [{ scope: "nav" }, "layout.scope must be"],
        [{ maxWidth: 100 }, "layout.maxWidth must be"],
        [{ width: 1200 }, 'layout: unknown key "width"'],
      ] as const) {
        expect(() => make({ layout })).toThrow(ConfigError);
        expect(() => make({ layout })).toThrow(message);
      }
    });
  });
}
