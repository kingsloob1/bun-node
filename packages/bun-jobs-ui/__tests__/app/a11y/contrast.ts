/**
 * WCAG 2 contrast, from colour tokens: relative luminance, the contrast
 * ratio, and a reader for `app/styles/tokens.css` that returns each theme's
 * resolved custom properties. Pure: no DOM, no layout.
 */

/** A theme's custom properties, name (without `--`) to value. */
export type Tokens = Readonly<Record<string, string>>;

/** The two themes tokens.css defines. */
export interface ThemeTokens {
  /** `:root`. */
  light: Tokens;
  /** `:root` overridden by `:root[data-theme="dark"]`. */
  dark: Tokens;
  /** `:root` overridden by the `prefers-color-scheme: dark` block, which must match `dark`. */
  systemDark: Tokens;
}

/** The custom properties declared directly in one CSS block's body. */
function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+)\s*:([^;]+);/g)) {
    out[name!] = value!.trim();
  }
  return out;
}

/** The body of the first block whose selector matches `selector`, braces balanced. */
function blockBody(css: string, selector: RegExp): string {
  const match = selector.exec(css);
  if (!match) {
    throw new Error(`tokens.css: no block ${selector}`);
  }
  let depth = 0;
  const start = css.indexOf("{", match.index);
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") {
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        return css.slice(start + 1, i);
      }
    }
  }
  throw new Error(`tokens.css: unbalanced block ${selector}`);
}

/** Reads tokens.css into its themes. */
export function parseTokens(css: string): ThemeTokens {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const light = declarations(blockBody(clean, /(^|\n):root\s*\{/));
  const dark = {
    ...light,
    ...declarations(blockBody(clean, /:root\[data-theme="dark"\]\s*\{/)),
  };
  const media = blockBody(clean, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  const systemDark = { ...light, ...declarations(media) };
  return { light, dark, systemDark };
}

/** `#rgb` or `#rrggbb` as 0–255 channels. */
export function parseHex(hex: string): [number, number, number] {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(hex.trim());
  if (!match) {
    throw new Error(`not a hex colour: ${hex}`);
  }
  const digits =
    match[1]!.length === 3
      ? [...match[1]!].map((digit) => digit + digit).join("")
      : match[1]!;
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

/** WCAG AA minimums. */
export const AA = {
  /** Body text. */
  text: 4.5,
  /** Large text (24px, or 18.66px bold) and UI components / graphical objects. */
  large: 3,
  /** UI components and graphical objects (1.4.11). */
  ui: 3,
} as const;
