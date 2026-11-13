import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  AA,
  CONTRAST_PAIRS,
  contrastRatio,
  parseTokens,
  relativeLuminance,
} from "./contrast";

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
  "..",
  "app",
  "kit",
  "styles",
  "tokens.css",
);

const themes = parseTokens(await Bun.file(TOKENS_CSS).text());

/** Every pair, with the smallest ratio each must reach (shared with a custom theme's startup check). */
const PAIRS = CONTRAST_PAIRS;

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
        const ratio = contrastRatio(fg, bg);
        if (ratio < pair.min) {
          throw new Error(
            `${name}: --${pair.fg} ${fg} on --${pair.bg} ${bg} is ${ratio.toFixed(2)}:1, below ${pair.min}:1 (${pair.use})`,
          );
        }
      });
    }
  });
}
