/**
 * WCAG 2 contrast over the kit's colour tokens: relative luminance, the
 * contrast ratio, and every foreground/background pair the UIs draw with
 * the minimum each must reach. Pure: no DOM, no layout.
 *
 * The built-in palette is held to these pairs by
 * `__tests__/jobs/app/a11y/contrast.test.ts`; a custom theme
 * (`theme: { light, dark }`) is checked against them at startup
 * (`./theme`'s `themeContrastProblems`), which warns rather than refuses.
 */

/** WCAG AA minimums. */
export const AA = {
  /** Body text. */
  text: 4.5,
  /** Large text (24px, or 18.66px bold) and UI components / graphical objects. */
  large: 3,
  /** UI components and graphical objects (1.4.11). */
  ui: 3,
} as const;

/** `#rgb` or `#rrggbb` as 0–255 channels. */
export function parseHex(hex: string): [number, number, number] {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(hex.trim());
  if (!match) {
    throw new Error(`not a hex colour: ${hex}`);
  }
  const digits =
    match[1].length === 3
      ? [...match[1]].map((digit) => digit + digit).join("")
      : match[1];
  return [0, 2, 4].map((at) =>
    Number.parseInt(digits.slice(at, at + 2), 16),
  ) as [number, number, number];
}

/** WCAG 2 relative luminance of a hex colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two hex colours, 1 to 21, in either order. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  ) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** One colour pair the UIs draw. */
export interface ContrastPair {
  /** Foreground token, as in `tokens.css` (without `--`). */
  readonly fg: string;
  /** Background token it sits on. */
  readonly bg: string;
  /** The minimum ratio. */
  readonly min: number;
  /** Where the UIs draw it, so a failure names the place that stopped reading. */
  readonly use: string;
}

/** Every pair, with the smallest ratio each must reach. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
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
  {
    fg: "neutral-text",
    bg: "neutral-bg",
    min: AA.text,
    use: "neutral badge, the Events console's worker kind",
  },
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
