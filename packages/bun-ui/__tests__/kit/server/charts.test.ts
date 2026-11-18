/**
 * The kit's analytics primitives (PR-U2), DOM-free: the range model any UI
 * binds (presets, URL form, bounds, refusals), the heat strip's steps, and
 * the chart colour aliases, each held to 3:1 against the surface (WCAG
 * 1.4.11) in both schemes. Each with its negative control.
 */
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { CHART_TONES, heatStep } from "../../../app/kit/charts/chart";
import { createRangeModel, rangeBounds } from "../../../app/kit/range";
import { contrastRatio, parseTokens } from "../../jobs/app/a11y/contrast";

const tokens = parseTokens(
  await Bun.file(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "app",
      "kit",
      "styles",
      "tokens.css",
    ),
  ).text(),
);

const MODEL = createRangeModel({
  presets: [900, 3_600] as const,
  defaultPreset: 3_600,
  labels: { 900: "Last 15 minutes", 3_600: "Last hour" },
  maxSpanMs: 2 * 86_400_000,
  minSpanMs: 60_000,
});

describe("the kit's range model", () => {
  it("round-trips presets and custom spans through the URL, the default left out", () => {
    expect(MODEL.writeRange(MODEL.defaultRange())).toBeNull();
    expect(MODEL.writeRange({ kind: "preset", seconds: 900 })).toBe("900s");
    expect(MODEL.readRange("900s")).toEqual({ kind: "preset", seconds: 900 });
    expect(MODEL.readRange("1000-200000")).toEqual({
      kind: "custom",
      from: 1000,
      to: 200000,
    });
    // The controls: an unknown preset, a span too short or too long, nonsense: the default.
    expect(MODEL.readRange("60s")).toEqual(MODEL.defaultRange());
    expect(MODEL.readRange("0-1000")).toEqual(MODEL.defaultRange());
    expect(MODEL.readRange(`0-${3 * 86_400_000}`)).toEqual(
      MODEL.defaultRange(),
    );
    expect(MODEL.readRange("x")).toEqual(MODEL.defaultRange());
  });

  it("says why a custom span is refused, and resolves a preset against now", () => {
    expect(MODEL.rangeProblem(10, 5)).toBe("The end must be after the start.");
    expect(MODEL.rangeProblem(0, 1_000)).toBe(
      "That range is shorter than 1 minute.",
    );
    expect(MODEL.rangeProblem(0, 3 * 86_400_000)).toContain(
      "longer than 2 days",
    );
    expect(MODEL.rangeProblem(0, 3 * 86_400_000, null)).toBeNull();
    expect(rangeBounds({ kind: "preset", seconds: 900 }, 1_000_000)).toEqual({
      from: 100_000,
      to: 1_000_000,
    });
    expect(MODEL.describeRange({ kind: "preset", seconds: 900 })).toBe(
      "Last 15 minutes",
    );
  });
});

describe("the heat strip's steps", () => {
  it("nothing is step 0; the rest step 1 to 4 against the largest", () => {
    expect(
      [0, 1, 25, 50, 75, 100].map((value) => heatStep(value, 100)),
    ).toEqual([0, 1, 1, 2, 3, 4]);
    expect(heatStep(5, 0)).toBe(0);
  });
});

describe("the chart colours", () => {
  /** A token's value, following one `var(--x)` alias. */
  const resolve = (scheme: Record<string, string>, name: string): string => {
    const value = scheme[name] ?? "";
    const alias = /^var\(--([\w-]+)\)$/.exec(value.trim());
    return alias === null ? value : (scheme[alias[1]!] ?? "");
  };

  it("every tone has an alias, at least 3:1 against the surface, light and dark", () => {
    for (const scheme of ["light", "dark", "systemDark"] as const) {
      const palette = { ...tokens.light, ...tokens[scheme] };
      for (const tone of CHART_TONES) {
        const colour = resolve(palette, `chart-${tone}`);
        expect([scheme, tone, /^#[\da-f]{6}$/i.test(colour)]).toEqual([
          scheme,
          tone,
          true,
        ]);
        expect([
          scheme,
          tone,
          contrastRatio(colour, palette.surface!) >= 3,
        ]).toEqual([scheme, tone, true]);
      }
    }
  });

  it("negative control: a colour close to the surface fails the same check", () => {
    expect(contrastRatio("#f0f0f0", tokens.light.surface!) >= 3).toBe(false);
  });
});
