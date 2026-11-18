import type { JobsUiSections } from "../../../lib/jobs/browser/config.ts";
import type { JobsSectionId } from "../../../lib/jobs/browser/sections.ts";
import type { JobsApiAction } from "../api/contract";
import type { MetaDto } from "../api/types";
import { sectionsFor } from "../../../lib/kit/browser/sections.ts";
import { JOBS_SECTIONS } from "../../../lib/jobs/browser/sections.ts";

/** Stable ids of the nav entries: the sections' (`JOBS_SECTIONS`), and the API docs' two children. */
export type NavId = JobsSectionId | "docs-http" | "docs-ws";

/** One sidebar entry. */
export interface NavItem {
  /** Stable id. */
  id: NavId;
  /** Visible label. */
  label: string;
  /** App path it links to. */
  to: string;
  /** Entries nested under this one (API docs → HTTP API, WebSocket API); absent for a leaf. */
  children?: NavItem[];
}

/** What {@link buildNav} decides from. */
export interface NavInputs {
  /** `GET /meta`. */
  meta: MetaDto;
  /** `JobsUiConfig.sections`. */
  sections: JobsUiSections;
  /** Whether the caller may perform an action (absent = no). */
  can: (action: JobsApiAction) => boolean;
}

/**
 * The entries the caller can use, in display order: `JOBS_SECTIONS` (the
 * browser contract's list, which a host's side menu reads too; embedding.md
 * §2), filtered by permission with the kit's `sectionsFor`, then by what the
 * API serves. An entry is **absent**
 * (never disabled) when its section is switched off, the API's mode prunes
 * its routes, or the caller lacks the action it lists with:
 *
 * - Overview — `manage`, mode jobs/both, and `metrics.read` or `queues.list`.
 * - Queues — `manage`, mode jobs/both, `queues.list`.
 * - Workers — `manage`, mode jobs/both, a worker registry (`meta.features.workers`), `workers.list`.
 * - Summoning — `manage`, mode jobs/both, `GET /summon` served
 *   (`meta.features.summonList`: off in runner mode, absent on an older API),
 *   `queues.list` (the route's action; each row is then filtered by
 *   `queues.read` on its queue, server-side).
 * - Providers — `manage`, the provider routes served (`meta.features.providers`,
 *   off in runner mode), and the opt-in `providers.read`.
 * - Runners — `manage`, mode runner/both, `runners.list`.
 * - Events — `manage`, a socket (`meta.websocket`), `events.connect`.
 * - API docs — `docs`, docs routed (`meta.docs`, the runtime authority), `docs.read`.
 *   Nested under it: HTTP API always, WebSocket API when the API documents a
 *   socket (`meta.docs.asyncapi`).
 */
export function buildNav({ meta, sections, can }: NavInputs): NavItem[] {
  const jobsMode = meta.mode === "jobs" || meta.mode === "both";
  const runnerMode = meta.mode === "runner" || meta.mode === "both";
  /** Whether the API serves a section (its mode, features, the `sections` option); its permission is `sectionsFor`'s. */
  const served: Readonly<Record<JobsSectionId, boolean>> = {
    overview: sections.manage && jobsMode,
    queues: sections.manage && jobsMode,
    workers: sections.manage && jobsMode && meta.features.workers,
    summoning: sections.manage && jobsMode && meta.features.summonList === true,
    providers: sections.manage && meta.features.providers,
    runners: sections.manage && runnerMode,
    events: sections.manage && Boolean(meta.websocket),
    docs: sections.docs && Boolean(meta.docs),
  };
  return sectionsFor(JOBS_SECTIONS, can)
    .filter((section) => served[section.id])
    .map((section): NavItem => {
      if (section.id !== "docs") {
        return { id: section.id, label: section.label, to: section.path };
      }
      const children: NavItem[] = [
        { id: "docs-http", label: "HTTP API", to: "/docs/http" },
      ];
      if (meta.docs?.asyncapi !== undefined) {
        children.push({
          id: "docs-ws",
          label: "WebSocket API",
          to: "/docs/ws",
        });
      }
      return { id: "docs", label: section.label, to: section.path, children };
    });
}
