/**
 * The element a UI draws into and themes (embedding.md §6): the document's
 * element in a shell page, the mount element when a host mounts the UI. The
 * theme toggle and anything else that sets the UI's root attributes reads it
 * here, so a mounted UI never touches the host's `<html>`.
 */
import { createContext, use } from "react";

/** The UI's root, provided by a mount; absent in a shell page, where it is the document's element. */
export const UiRootContext = createContext<HTMLElement | null>(null);

/** The UI's root: the mount element, or the document's element in a shell page. */
export function useUiRoot(): HTMLElement {
  return use(UiRootContext) ?? document.documentElement;
}

/** The mount element when a host mounted the UI, `null` in a shell page (the whole page is the UI's). */
export function useMountRoot(): HTMLElement | null {
  return use(UiRootContext);
}

/**
 * Whether a key press is the UI's to handle: always in a shell page; when
 * mounted, only when it happened inside the mount element, so a host's own
 * typing never triggers the UI's shortcuts, and two mounted UIs never both
 * react.
 */
export function isUiEvent(root: HTMLElement | null, event: Event): boolean {
  return (
    root === null ||
    (event.target instanceof Node && root.contains(event.target))
  );
}
