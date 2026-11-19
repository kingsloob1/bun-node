/**
 * The `shell` option (embedding.md §2, the kit's, like `layout`) through
 * the real routers, socket-free: every UI (`jobsUi()`, `docsUi()`,
 * `securityUi()`) draws its full frame by default, hands the browser the
 * checked value, refuses a bad one with its own `ConfigError`, and serves
 * nothing else for it (no stylesheet, the same CSP). The list of UIs is the
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
  describe(`${name} shell`, () => {
    it('is "full" when unset, in the config and the page', async () => {
      const ui = make();
      expect(ui.config.shell).toBe("full");
      const { shell } = await shellOf(ui.router, "/");
      expect((shell.config as { shell: unknown }).shell).toBe("full");
    });

    it("hands the browser the value given", async () => {
      for (const value of ["tabs", "none", "full"] as const) {
        const ui = make({ shell: value });
        expect(ui.config.shell).toBe(value);
        const { shell } = await shellOf(ui.router, "/");
        expect((shell.config as { shell: unknown }).shell).toBe(value);
      }
    });

    it("adds no stylesheet and leaves the CSP as it is (control: no shell)", async () => {
      const plain = await shellOf(make().router, "/");
      const compact = await shellOf(make({ shell: "none" }).router, "/");
      expect(compact.shell.styles).toEqual(plain.shell.styles);
      const csp = (response: Response) =>
        response.headers
          .get("content-security-policy")!
          .replace(/'nonce-[^']+'/, "'nonce-…'");
      expect(csp(compact.response)).toBe(csp(plain.response));
    });

    it("refuses a bad shell with its own ConfigError", () => {
      for (const value of ["header", null, true, "Full"]) {
        expect(() => make({ shell: value })).toThrow(ConfigError);
        expect(() => make({ shell: value })).toThrow(
          'shell must be "full", "tabs" or "none"',
        );
      }
    });
  });
}
