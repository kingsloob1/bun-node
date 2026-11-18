/**
 * Which of `DOCS_SECTIONS` the viewer is in (embedding.md §12 item 8): the
 * one matching its document, read from the location, since the viewer's
 * `/` sends an OpenAPI document to `/http` and an AsyncAPI one to `/ws`.
 */
import type { DocsSection } from "../../../lib/docs/browser/sections";
import { DOCS_SECTIONS } from "../../../lib/docs/browser/sections";

/** The section the viewer's path is in, or `null` (the landing, before its redirect). */
export function docsSectionAt(path: string | null): DocsSection | null {
  if (path === null) return null;
  return (
    DOCS_SECTIONS.find(
      (section) => path === section.path || path.startsWith(`${section.path}/`),
    ) ?? null
  );
}
