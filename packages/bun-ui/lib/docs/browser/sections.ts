/**
 * The docs viewer's sections (embedding.md §2; the user's decision,
 * 2026-11-18): its HTTP and WebSocket references, neither needing a
 * permission of its own (reaching the viewer is the gate). The viewer serves
 * one document, so it shows only the section matching that document's kind
 * (`app/docs/layout/sections.ts`); a host that knows the kind does the same.
 */
import type { UiSection } from "../../kit/browser/sections";

/** The docs viewer's sections, in order. */
export const DOCS_SECTIONS = Object.freeze([
  { id: "http", label: "HTTP API", path: "/http", needs: null },
  { id: "ws", label: "WebSocket API", path: "/ws", needs: null },
] as const satisfies readonly UiSection[]);

/** One of {@link DOCS_SECTIONS}. */
export type DocsSection = (typeof DOCS_SECTIONS)[number];
