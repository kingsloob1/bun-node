/**
 * The compact frame a UI draws in place of its header and side nav when its
 * `shell` is `"tabs"` or `"none"` (embedding.md §2; the user's decision
 * 2026-11-18, §12 item 7): a single bar holding the section tabs (`"tabs"`
 * only) and the UI's working controls (its scope picker, live status, …),
 * never a brand, chips or a theme toggle. Each UI passes its own links, so
 * the kit imports no UI's router.
 */
import type { ReactNode } from "react";

/** Props of {@link FrameBar}. */
export interface FrameBarProps {
  /** The section tabs, each an `<li>` holding one link with the `app-tab` class; none for `"none"`. */
  tabs?: ReactNode;
  /** The UI's working controls, at the bar's end; none draws no controls area. */
  controls?: ReactNode;
}

/** See the module's description. Renders nothing when given neither tabs nor controls. */
export function FrameBar({ tabs, controls }: FrameBarProps) {
  if (!tabs && !controls) return null;
  return (
    <div
      className="app-bar"
      data-testid="app-bar"
    >
      {tabs ? (
        <nav
          className="app-tabs"
          aria-label="Sections"
          data-testid="section-tabs"
        >
          <ul>{tabs}</ul>
        </nav>
      ) : null}
      {controls ? <div className="app-bar-controls">{controls}</div> : null}
    </div>
  );
}
