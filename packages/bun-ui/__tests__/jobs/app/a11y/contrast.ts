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
    out[name] = value.trim();
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

// The maths and the pairs live in the package (a custom theme is checked
// against them at startup); this module adds the tokens.css reader.
export {
  AA,
  contrastRatio,
  CONTRAST_PAIRS,
  parseHex,
  relativeLuminance,
} from "../../../../lib/kit/contrast";
