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
