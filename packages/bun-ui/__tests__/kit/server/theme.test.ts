/**
 * Custom colour themes (#779), the kit's half: the token list and the
 * built-in palettes against the real `tokens.css`; the option's checks; the
 * stylesheet; the contrast warnings; and the loader that adds the
 * stylesheet to a bundle. Each check is paired with its control.
 */
import type {
  SelfHostedColorToken,
  SelfHostedTheme,
} from "@kingsleyweb/bun-common/lib/docs";
import type { UiAssets } from "../../../lib/kit/assets";
import type {
  UiColorToken,
  UiThemeOptions,
} from "../../../lib/kit/browser/shared";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { integrityOf } from "../../../lib/kit/assets";
import {
  cssTokenName,
  DEFAULT_PALETTES,
  resolveThemeInput,
  themeContrastProblems,
  themedAssets,
  themeStylesheet,
  UI_COLOR_TOKENS,
} from "../../../lib/kit/theme";
import { parseTokens } from "../../jobs/app/a11y/contrast";

const TOKENS_CSS = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "app",
  "kit",
  "styles",
  "tokens.css",
);
const tokens = parseTokens(await Bun.file(TOKENS_CSS).text());

/** The kit's error factory, as a UI passes it: a plain Error carrying the context. */
const fail = (message: string, context: Record<string, unknown>) =>
  Object.assign(new Error(message), { context });

/** The message `fn` throws. */
function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
}

/** Compile-time equality. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

describe("the tokens", () => {
  it("are every colour property tokens.css defines, in its order", () => {
    const colours = Object.entries(tokens.light)
      .filter(([, value]) => /^#[\da-f]{3,8}$/i.test(value))
      .map(([name]) => name);
    expect(UI_COLOR_TOKENS.map(cssTokenName)).toEqual(colours);
    expect(colours).toHaveLength(29);
  });

  it("hold the built-in palettes tokens.css defines, both schemes", () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const token of UI_COLOR_TOKENS) {
        expect([token, DEFAULT_PALETTES[scheme][token]]).toEqual([
          token,
          tokens[scheme][cssTokenName(token)],
        ]);
      }
    }
  });

  it("name their CSS properties", () => {
    expect(cssTokenName("bg")).toBe("bg");
    expect(cssTokenName("surface2")).toBe("surface-2");
    expect(cssTokenName("accentContrast")).toBe("accent-contrast");
    expect(cssTokenName("stateWaitingChildren")).toBe("state-waiting-children");
  });

  it("agree with bun-common's mirror, used by its self-hosted viewer", () => {
    const sameTokens: Equal<UiColorToken, SelfHostedColorToken> = true;
    const sameTheme: Equal<
      Required<UiThemeOptions>,
      Required<SelfHostedTheme>
    > = true;
    expect([sameTokens, sameTheme]).toEqual([true, true]);
  });
});

describe("resolveThemeInput", () => {
  it("reads a scheme, and defaults to system with no colours", () => {
    expect(resolveThemeInput(undefined, fail)).toEqual({
      mode: "system",
      colors: undefined,
    });
    expect(resolveThemeInput("dark", fail)).toEqual({
      mode: "dark",
      colors: undefined,
    });
  });

  it("reads an object: its mode and each scheme's colours, lowercased", () => {
    expect(
      resolveThemeInput(
        { mode: "light", light: { accent: "#0F766E", bg: "#fff" } },
        fail,
      ),
    ).toEqual({
      mode: "light",
      colors: { light: { accent: "#0f766e", bg: "#fff" }, dark: {} },
    });
    // Control: an object with no colours is the scheme alone.
    expect(resolveThemeInput({ dark: {} }, fail)).toEqual({
      mode: "system",
      colors: undefined,
    });
  });

  it.each([
    [
      "blue",
      'theme must be "system", "light", "dark" or { mode?, light?, dark? }',
    ],
    [
      { colours: {} },
      'theme: unknown key "colours" (known: mode, light, dark)',
    ],
    [{ mode: "dim" }, 'theme.mode must be "system", "light" or "dark"'],
    [{ light: "#fff" }, "theme.light must be an object of colour tokens"],
    [{ dark: { brand: "#fff" } }, "theme.dark.brand is not a colour token"],
    [
      { light: { accent: "teal" } },
      'theme.light.accent must be a colour as "#rgb" or "#rrggbb"',
    ],
    [
      { light: { accent: "rgb(0 0 0)" } },
      "theme.light.accent must be a colour",
    ],
    [{ light: { accent: "#0f766e80" } }, "theme.light.accent must be a colour"],
    // Nothing a host passes reaches the CSS unchecked.
    [
      { light: { accent: "#fff; } body { display: none" } },
      "theme.light.accent must be a colour",
    ],
    [{ light: { accent: 1 } }, "theme.light.accent must be a colour"],
  ])("refuses %j", (value, message) => {
    expect(thrown(() => resolveThemeInput(value, fail))).toContain(message);
  });

  it("names the option as the caller does", () => {
    expect(
      thrown(() =>
        resolveThemeInput({ mode: 1 }, fail, "the openapi viewer: theme"),
      ),
    ).toStartWith("the openapi viewer: theme.mode");
  });
});

describe("themeStylesheet", () => {
  it("puts light overrides on :root and dark ones in tokens.css's two dark blocks", () => {
    expect(
      themeStylesheet({
        light: { surface2: "#eeeeee", accent: "#0f766e" },
        dark: { accent: "#2dd4bf" },
      }),
    ).toBe(
      `/* Generated by @kingsleyweb/bun-ui from the \`theme\` option: overrides of tokens.css. */
:root {
  --surface-2: #eeeeee;
  --accent: #0f766e;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --accent: #2dd4bf;
  }
}
:root[data-theme="dark"] {
  --accent: #2dd4bf;
}
`,
    );
  });

  it("writes only the schemes it was given (control: a light-only theme has no dark block)", () => {
    const light = themeStylesheet({ light: { accent: "#0f766e" }, dark: {} });
    expect(light).toContain(":root {");
    expect(light).not.toContain("data-theme");
    const dark = themeStylesheet({ light: {}, dark: { accent: "#2dd4bf" } });
    expect(dark).not.toContain(":root {\n");
    expect(dark).toContain(':root[data-theme="dark"] {');
  });
});

describe("themeContrastProblems", () => {
  it("names each pair an override pushes below WCAG AA, per scheme", () => {
    const problems = themeContrastProblems({
      light: { accent: "#8ab4f8" },
      dark: { surface: "#7ea2ff" },
    });
    expect(problems.filter((line) => line.startsWith("theme.light"))).toEqual([
      "theme.light: accent #8ab4f8 on bg #f6f7f9 is 1.97:1, below 4.5:1 (links)",
      "theme.light: accent #8ab4f8 on surface #ffffff is 2.11:1, below 4.5:1 (links)",
      "theme.light: accent #8ab4f8 on surface2 #f0f2f5 is 1.88:1, below 4.5:1 (links)",
      "theme.light: accentContrast #ffffff on accent #8ab4f8 is 2.11:1, below 4.5:1 (primary buttons, accent badges)",
    ]);
    // Every dark problem involves the overridden surface; the built-in pairs
    // that do not (text on bg, say) are never reported.
    const dark = problems.filter((line) => line.startsWith("theme.dark"));
    expect(dark.length).toBeGreaterThan(0);
    expect(dark.every((line) => line.includes(" on surface #7ea2ff"))).toBe(
      true,
    );
  });

  it("reports nothing for overrides that read (control: the built-in palettes)", () => {
    expect(
      themeContrastProblems({
        light: { accent: "#0f766e", focus: "#0f766e" },
        dark: { accent: "#2dd4bf", accentContrast: "#04201c" },
      }),
    ).toEqual([]);
    expect(
      themeContrastProblems({
        light: { ...DEFAULT_PALETTES.light },
        dark: { ...DEFAULT_PALETTES.dark },
      }),
    ).toEqual([]);
  });
});

describe("themedAssets", () => {
  /** A stand-in bundle: one module and one stylesheet. */
  const bundle = (): UiAssets => {
    const body = new TextEncoder().encode("x") as Uint8Array<ArrayBuffer>;
    const file = (name: string, type: string) => ({
      name,
      body,
      type,
      size: 1,
      integrity: integrityOf(body),
      etag: '"x"',
    });
    return {
      entry: { js: "main-1.js", css: ["main-1.css"] },
      files: new Map([
        ["main-1.js", file("main-1.js", "text/javascript; charset=utf-8")],
        ["main-1.css", file("main-1.css", "text/css; charset=utf-8")],
      ]),
      source: "memory",
    };
  };

  it("adds the theme's stylesheet last, hashed and with its own SRI, once per bundle; warns once, now", async () => {
    const base = bundle();
    const warnings: string[] = [];
    const theme = resolveThemeInput(
      { light: { accent: "#8ab4f8" }, dark: { accent: "#2dd4bf" } },
      fail,
    );
    const load = themedAssets(
      theme,
      async () => base,
      (message) => {
        warnings.push(message);
      },
    );
    expect(warnings).toEqual(themeContrastProblems(theme.colors!));
    expect(warnings).toHaveLength(4);
    const first = await load();
    const name = first.entry.css.at(-1)!;
    expect(name).toMatch(/^theme-[\da-f]{12}\.css$/);
    expect(first.entry.css).toEqual(["main-1.css", name]);
    const file = first.files.get(name)!;
    const css = themeStylesheet(theme.colors!);
    expect(new TextDecoder().decode(file.body)).toBe(css);
    expect(file.type).toBe("text/css; charset=utf-8");
    expect(file.integrity).toBe(integrityOf(file.body));
    // The bundle itself is left alone, and a second load is the same object.
    expect(base.entry.css).toEqual(["main-1.css"]);
    expect(base.files.has(name)).toBe(false);
    expect(await load()).toBe(first);
    expect(warnings).toHaveLength(4);
  });

  it("is the loader itself without colours (control)", () => {
    const loader = async () => bundle();
    expect(
      themedAssets(resolveThemeInput("dark", fail), loader, () => {}),
    ).toBe(loader);
  });

  it("names the file after its content: the same theme, the same name", async () => {
    const name = async (accent: string) =>
      (
        await themedAssets(
          resolveThemeInput({ light: { accent } }, fail),
          async () => bundle(),
          () => {},
        )()
      ).entry.css.at(-1);
    expect(await name("#0f766e")).toBe(await name("#0F766E"));
    expect(await name("#0f766e")).not.toBe(await name("#115e59"));
  });
});
