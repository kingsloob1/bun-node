/**
 * Custom colour themes (#779) through the real routers, socket-free:
 * `jobsUi()` and `docsUi()` link the theme's stylesheet after the bundle's
 * with SRI, serve it with the bundle's caching under the same strict CSP,
 * hand the browser only the starting scheme, log contrast problems, and
 * refuse a bad theme with their own `ConfigError`. Each is paired with its
 * control: without colours, nothing is added.
 */
import {
  ConfigError as CommonConfigError,
  createTestLogger,
} from "@kingsleyweb/bun-common";
import { ConfigError as JobsConfigError } from "@kingsleyweb/bun-jobs";
import { describe, expect, it } from "bun:test";
import { integrityOf } from "../../../lib/kit/assets";
import {
  fetchShell as fetchDocsShell,
  fixtureDocsUi,
} from "../../docs/server/helpers";
import { fetchShell, fixtureUi, parseShell } from "./helpers";

/** A theme every check below uses: readable in both schemes. */
const THEME = {
  mode: "light",
  light: { accent: "#0f766e", focus: "#0f766e" },
  dark: { accent: "#2dd4bf", accentContrast: "#04201c" },
} as const;

/** The UIs under test, each over its fixture bundle. */
const UIS = [
  [
    "jobsUi()",
    (options: object = {}) => fixtureUi(options),
    "/jobs",
    fetchShell,
  ],
  [
    "docsUi()",
    (options: object = {}) => fixtureDocsUi(options),
    "/docs",
    fetchDocsShell,
  ],
] as const;

for (const [name, make, basePath, shellOf] of UIS) {
  describe(`${name} with a theme`, () => {
    it("links the theme's stylesheet last, with its SRI, and serves it like the bundle (control: no theme, no link)", async () => {
      const plain = await shellOf(make().router, "/");
      const { response, shell } = await shellOf(
        make({ theme: THEME }).router,
        "/",
      );
      expect(shell.styles.slice(0, -1)).toEqual(plain.shell.styles);
      const link = shell.styles.at(-1)!;
      expect(link.href).toMatch(
        new RegExp(`^${basePath}/assets/theme-[\\da-f]{12}\\.css$`),
      );
      expect(plain.html).not.toContain("theme-");

      // The same strict CSP: the theme is a file from this origin.
      expect(response.headers.get("content-security-policy")).toBe(
        plain.response.headers
          .get("content-security-policy")!
          .replace(
            /'nonce-[^']+'/,
            /'nonce-[^']+'/.exec(
              response.headers.get("content-security-policy")!,
            )![0],
          ),
      );

      const ui = make({ theme: THEME });
      const css = await ui.router.fetch(link.href.slice(basePath.length));
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(css.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      const bytes = new Uint8Array(await css.arrayBuffer());
      expect(link.integrity).toBe(integrityOf(bytes));
      const text = new TextDecoder().decode(bytes);
      expect(text).toContain(
        ":root {\n  --accent: #0f766e;\n  --focus: #0f766e;\n}",
      );
      expect(text).toContain(
        ':root[data-theme="dark"] {\n  --accent: #2dd4bf;\n  --accent-contrast: #04201c;\n}',
      );
    });

    it("hands the browser only the starting scheme", async () => {
      const { shell } = await shellOf(make({ theme: THEME }).router, "/");
      expect(shell.config.theme).toBe("light");
      expect(JSON.stringify(shell.config)).not.toContain("#0f766e");
      // Control: the string form, as before.
      const dark = await shellOf(make({ theme: "dark" }).router, "/");
      expect(dark.shell.config.theme).toBe("dark");
    });

    it("logs each contrast problem once, at startup (control: a readable theme logs none)", () => {
      const quiet = createTestLogger();
      make({ theme: THEME, logger: quiet.logger });
      expect(quiet.events.filter((event) => event.level === "warn")).toEqual(
        [],
      );
      const { logger, events } = createTestLogger();
      make({ theme: { light: { accent: "#8ab4f8" } }, logger });
      const warned = events
        .filter((event) => event.level === "warn")
        .map((event) => event.message);
      expect(warned).toHaveLength(4);
      expect(warned).toContain(
        "theme.light: accentContrast #ffffff on accent #8ab4f8 is 2.11:1, below 4.5:1 (primary buttons, accent badges)",
      );
    });

    it("refuses a bad theme with the UI's own ConfigError", () => {
      const expected =
        name === "jobsUi()" ? JobsConfigError : CommonConfigError;
      let caught: unknown;
      try {
        make({ theme: { light: { accent: "teal" } } });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(expected);
      expect((caught as Error).message).toBe(
        'theme.light.accent must be a colour as "#rgb" or "#rrggbb"',
      );
    });
  });
}

describe("parseShell (control for the link order above)", () => {
  it("reads stylesheets in document order", () => {
    const shell = parseShell(
      `<link rel="stylesheet" href="/a.css" integrity="x"><link rel="stylesheet" href="/b.css" integrity="y"><script type="application/json" id="bun-jobs-ui-config">{}</script>`,
    );
    expect(shell.styles.map((style) => style.href)).toEqual([
      "/a.css",
      "/b.css",
    ]);
  });
});
