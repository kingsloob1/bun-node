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
 * Applies a layout to the document: `data-align` and `data-layout-scope` on
 * the root element, and the width cap as {@link CONTENT_MAX_WIDTH_PROPERTY}.
 * Setting a property from script is allowed under the UIs' CSP, which refuses
 * only `style` attributes in markup and inline `<style>`.
 */
export function applyLayout(
  layout: UiLayout,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.align = layout.align;
  root.dataset.layoutScope = layout.scope;
  root.style.setProperty(CONTENT_MAX_WIDTH_PROPERTY, `${layout.maxWidth}px`);
}
