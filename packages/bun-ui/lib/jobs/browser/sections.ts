/**
 * The jobs UI's sections, the list its own nav reads
 * (`app/jobs/layout/nav.ts`) and a host's side menu is built from
 * (embedding.md §2). Each names the bun-jobs API action it needs
 * (`JobsApiAction`, spelled out here so this browser-safe entry imports no
 * domain package; the app's nav holds each to that union). Overview needs
 * either of two (the user's decision, 2026-11-18).
 *
 * The UI's nav also drops a section the API does not serve (its mode, its
 * features, the `sections` option); `sectionsFor` filters by permission
 * only, so a host showing every permitted section may link to one the UI
 * answers with its not-found screen.
 */
import type { UiSection } from "../../kit/browser/sections";

/** The jobs UI's sections, in nav order. */
export const JOBS_SECTIONS = Object.freeze([
  {
    id: "overview",
    label: "Overview",
    path: "/",
    needs: ["metrics.read", "queues.list"],
  },
  { id: "queues", label: "Queues", path: "/queues", needs: "queues.list" },
  { id: "workers", label: "Workers", path: "/workers", needs: "workers.list" },
  {
    id: "summoning",
    label: "Summoning",
    path: "/summon",
    needs: "queues.list",
  },
  {
    id: "providers",
    label: "Providers",
    path: "/providers",
    needs: "providers.read",
  },
  { id: "runners", label: "Runners", path: "/runners", needs: "runners.list" },
  { id: "events", label: "Events", path: "/events", needs: "events.connect" },
  { id: "docs", label: "API docs", path: "/docs", needs: "docs.read" },
] as const satisfies readonly UiSection[]);

/** One of {@link JOBS_SECTIONS}. */
export type JobsSection = (typeof JOBS_SECTIONS)[number];

/** A section's id. */
export type JobsSectionId = JobsSection["id"];
