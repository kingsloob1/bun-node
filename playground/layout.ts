/**
 * The playground's layout (#785): `PLAYGROUND_LAYOUT` gives every UI the
 * playground serves (the jobs UI at `/jobs`, both `docsUi()` viewers and
 * `docsRouter`'s self-hosted one) the same `layout` option, to see it across
 * every page on a wide screen. Unset, the default: centred content, 1400px.
 *
 * Its words, in any order, separated by spaces or commas: an alignment
 * (`left`, `center`, `right`), a scope (`content`, `page`) and a width cap
 * in pixels.
 *
 * ```bash
 * PLAYGROUND_LAYOUT=left bun playground/index.ts          # the layout before 3.3.0
 * PLAYGROUND_LAYOUT=right bun playground/index.ts
 * PLAYGROUND_LAYOUT="center page" bun playground/index.ts # the nav moves with the screen
 * PLAYGROUND_LAYOUT="right page 1100" bun playground/index.ts
 * ```
 */
import type {
  UiAlign,
  UiLayoutOptions,
  UiLayoutScope,
} from "@kingsleyweb/bun-ui";
import process from "node:process";

/** The alignments `PLAYGROUND_LAYOUT` takes. */
const ALIGNS: readonly UiAlign[] = ["left", "center", "right"];

/** The scopes `PLAYGROUND_LAYOUT` takes. */
const SCOPES: readonly UiLayoutScope[] = ["content", "page"];

/**
 * The layout `PLAYGROUND_LAYOUT` names; `undefined` (the default) when unset.
 * Throws on a word it does not know. The UIs check the values themselves
 * (a cap under 320 is their `ConfigError`).
 */
export function playgroundLayout(): UiLayoutOptions | undefined {
  const value = process.env.PLAYGROUND_LAYOUT?.trim();
  if (value === undefined || value === "") return undefined;
  const layout: UiLayoutOptions = {};
  for (const word of value.split(/[\s,]+/)) {
    if (ALIGNS.includes(word as UiAlign)) {
      layout.align = word as UiAlign;
    } else if (SCOPES.includes(word as UiLayoutScope)) {
      layout.scope = word as UiLayoutScope;
    } else if (/^\d+$/.test(word)) {
      layout.maxWidth = Number(word);
    } else {
      throw new Error(
        `PLAYGROUND_LAYOUT=${value}: "${word}" is not ${[...ALIGNS, ...SCOPES].join(", ")} or a width in pixels`,
      );
    }
  }
  return layout;
}
