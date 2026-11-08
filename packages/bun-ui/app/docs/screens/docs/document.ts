/**
 * The loaded document, shared by the viewer's routes: its context and hook,
 * kept apart from `viewer.tsx` so that file exports components only (fast
 * refresh, `react/only-export-components`).
 */
import type { DocumentKind, SpecDocument } from "../../api/docs";
import { createContext, use } from "react";

/** What the loaded document is. */
export interface LoadedDocument {
  /** The document. */
  doc: SpecDocument;
  /** Its kind. */
  kind: DocumentKind;
}

/** Carries the loaded document. */
export const DocumentContext = createContext<LoadedDocument | null>(null);

/** The loaded document, or a clear error outside `<DocsViewer>`. */
export function useDocument(): LoadedDocument {
  const loaded = use(DocumentContext);
  if (!loaded) {
    throw new Error("useDocument must be used inside <DocsViewer>");
  }
  return loaded;
}
