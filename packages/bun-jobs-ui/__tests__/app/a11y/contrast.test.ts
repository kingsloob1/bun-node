import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { AA, contrastRatio, parseTokens, relativeLuminance } from "./contrast";

/**
 * WCAG AA contrast of every colour pair the app draws, in both themes, read
 * from the real `app/styles/tokens.css`. A pair is a foreground token, the
 * background token it sits on, the minimum, and where the app uses it — so a
 * failure names the place that stopped reading.
 */

const TOKENS_CSS = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "app",
  "styles",
  "tokens.css",
);

const themes = parseTokens(await Bun.file(TOKENS_CSS).text());

/** One pair checked. */
interface Pair {
  /** Foreground token. */
  fg: string;
  /** Background token. */
  bg: string;
  /** The minimum ratio. */
  min: number;
  /** Where the app draws it. */
  use: string;
}

/** Every pair, with the smallest ratio each must reach. */
const PAIRS: readonly Pair[] = [
  // Text.
  ...["bg", "surface", "surface-2"].map((bg) => ({
    fg: "text",
    bg,
    min: AA.text,
    use: "body text, table cells, headings",
  })),
  ...["bg", "surface", "surface-2", "neutral-bg"].map((bg) => ({
    fg: "text-muted",
    bg,
    min: AA.text,
    use: "muted text, hints, labels, tabs, zero counts",
  })),
  ...["bg", "surface", "surface-2"].map((bg) => ({
    fg: "accent",
    bg,
    min: AA.text,
    use: "links",
  })),
  ...["surface", "bg"].map((bg) => ({
    fg: "danger",
    bg,
    min: AA.text,
    use: "field errors, JSON editor errors",
  })),
  {
    fg: "accent-contrast",
    bg: "accent",
    min: AA.text,
    use: "primary buttons, accent badges",
  },
  {
    fg: "danger-contrast",
    bg: "danger",
    min: AA.text,
    use: "danger buttons",
  },
  // Badge tones, notices, banners, the current nav item.
  { fg: "neutral-text", bg: "neutral-bg", min: AA.text, use: "neutral badge" },
  { fg: "info-text", bg: "info-bg", min: AA.text, use: "info badge, nav" },
  { fg: "success-text", bg: "success-bg", min: AA.text, use: "success badge" },
  { fg: "warning-text", bg: "warning-bg", min: AA.text, use: "warning badge" },
  { fg: "danger-text", bg: "danger-bg", min: AA.text, use: "danger badge" },
  // Coloured text on plain surfaces (JSON view, copy feedback, schema).
  ...["surface", "surface-2"].flatMap((bg) =>
    ["success-text", "info-text", "warning-text", "danger-text"].map((fg) => ({
      fg,
      bg,
      min: AA.text,
      use: "JSON strings/numbers, copy feedback, schema facts",
    })),
  ),
  {
    fg: "state-delayed",
    bg: "surface-2",
    min: AA.text,
    use: "JSON booleans (--json-boolean)",
  },
  // UI components and graphics.
  ...["bg", "surface", "surface-2"].map((bg) => ({
    fg: "focus",
    bg,
    min: AA.ui,
    use: "focus ring",
  })),
  ...["surface", "surface-2"].map((bg) => ({
    fg: "border-strong",
    bg,
    min: AA.ui,
    use: "input outlines",
  })),
  { fg: "danger", bg: "danger-bg", min: AA.ui, use: "error banner border" },
  ...[
    "waiting",
    "delayed",
    "active",
    "completed",
    "failed",
    "dead",
    "waiting-children",
  ].map((state) => ({
    fg: `state-${state}`,
    bg: "surface",
    min: AA.ui,
    use: "state dots, stat borders, sparklines",
  })),
];

describe("the contrast checker", () => {
  it("computes WCAG relative luminance and ratios", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBe(1);
    expect(relativeLuminance("#fff")).toBe(1);
    expect(contrastRatio("#000", "#fff")).toBe(21);
    expect(contrastRatio("#fff", "#000")).toBe(21);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    // A known reference: #767676 on white is the lightest grey passing AA.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  it("reads both themes from tokens.css, and the two dark blocks agree", () => {
    expect(themes.light.text).toBe("#1b1f24");
    expect(themes.dark.text).not.toBe(themes.light.text);
    // Dark applies by OS preference or by data-theme: the same colours.
    expect(themes.systemDark).toEqual(themes.dark);
  });

  it("negative control: a pair below the minimum is caught", () => {
    expect(contrastRatio("#d9dde3", "#ffffff")).toBeLessThan(AA.ui);
  });
});

for (const [name, tokens] of [
  ["light", themes.light],
  ["dark", themes.dark],
] as const) {
  describe(`WCAG AA contrast, ${name} theme`, () => {
    for (const pair of PAIRS) {
      it(`${pair.fg} on ${pair.bg} ≥ ${pair.min} (${pair.use})`, () => {
        const fg = tokens[pair.fg];
        const bg = tokens[pair.bg];
        expect(fg).toBeString();
        expect(bg).toBeString();
        const ratio = contrastRatio(fg!, bg!);
        if (ratio < pair.min) {
          throw new Error(
            `${name}: --${pair.fg} ${fg} on --${pair.bg} ${bg} is ${ratio.toFixed(2)}:1, below ${pair.min}:1 (${pair.use})`,
          );
        }
      });
    }
  });
}
