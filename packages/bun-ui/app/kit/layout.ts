import type { MountLayout } from "../../lib/kit/browser/mount.ts";
import type { UiLayout } from "../../lib/kit/browser/shared.ts";

/**
 * A UI's layout on a wide screen (the `layout` option, #785): every UI's boot
 * applies its config's to the document before the first render, and the
 * kit's base styles (`styles/base.css`, "Layout") read it. Shared by every
 * UI, so none sets its own page width or alignment.
 */

/** The custom property the base styles cap the content's width with. */
export const CONTENT_MAX_WIDTH_PROPERTY = "--content-max-width";

/**
 * Applies a layout to the UI's root: `data-align` and `data-layout-scope` on
 * it, and the width cap as {@link CONTENT_MAX_WIDTH_PROPERTY} (`none` for a
 * mounted UI's `maxWidth: "none"`). The root is the document's element in a
 * shell page and the mount element when mounted (embedding.md §6). Setting
 * a property from script is allowed under the UIs' CSP, which refuses only
 * `style` attributes in markup and inline `<style>`.
 */
export function applyLayout(
  layout: UiLayout | MountLayout,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.align = layout.align;
  root.dataset.layoutScope = layout.scope;
  root.style.setProperty(
    CONTENT_MAX_WIDTH_PROPERTY,
    layout.maxWidth === "none" ? "none" : `${layout.maxWidth}px`,
  );
}

/**
 * Takes what {@link applyLayout} set off `root` again, leaving the rest of
 * its attributes and style alone: a mounted UI's teardown (embedding.md §8).
 */
export function clearLayout(root: HTMLElement): void {
  delete root.dataset.align;
  delete root.dataset.layoutScope;
  root.style.removeProperty(CONTENT_MAX_WIDTH_PROPERTY);
}
