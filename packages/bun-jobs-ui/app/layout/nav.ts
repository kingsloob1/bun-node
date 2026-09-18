import type { UiSections } from "../../shared/config.ts";
import type { JobsApiAction } from "../api/contract";
import type { MetaDto } from "../api/types";

/** Stable ids of the nav entries. */
export type NavId = "overview" | "queues" | "runners" | "events" | "docs";

/** One sidebar entry. */
export interface NavItem {
  /** Stable id. */
  id: NavId;
  /** Visible label. */
  label: string;
  /** App path it links to. */
  to: string;
  /** The milestone the screen arrives in, when it is still a placeholder; `null` when built. */
  comingIn: number | null;
}

/** What {@link buildNav} decides from. */
export interface NavInputs {
  /** `GET /meta`. */
  meta: MetaDto;
  /** `UiConfig.sections`. */
  sections: UiSections;
  /** Whether the caller may perform an action (absent = no). */
  can: (action: JobsApiAction) => boolean;
}

/**
 * The entries the caller can use, in display order. An entry is **absent**
 * (never disabled) when its section is switched off, the API's mode prunes
 * its routes, or the caller lacks the action it lists with:
 *
 * - Overview — `manage`, mode jobs/both, and `metrics.read` or `queues.list`.
 * - Queues — `manage`, mode jobs/both, `queues.list`.
 * - Runners — `manage`, mode runner/both, `runners.list`.
 * - Events — `manage`, a socket (`meta.websocket`), `events.connect`.
 * - API docs — `docs`, docs routed (`meta.docs`, the runtime authority), `docs.read`.
 */
export function buildNav({ meta, sections, can }: NavInputs): NavItem[] {
  const items: NavItem[] = [];
  const jobsMode = meta.mode === "jobs" || meta.mode === "both";
  const runnerMode = meta.mode === "runner" || meta.mode === "both";

  if (sections.manage) {
    if (jobsMode && (can("metrics.read") || can("queues.list"))) {
      items.push({
        id: "overview",
        label: "Overview",
        to: "/",
        comingIn: null,
      });
    }
    if (jobsMode && can("queues.list")) {
      items.push({ id: "queues", label: "Queues", to: "/queues", comingIn: 2 });
    }
    if (runnerMode && can("runners.list")) {
      items.push({
        id: "runners",
        label: "Runners",
        to: "/runners",
        comingIn: 3,
      });
    }
    if (meta.websocket && can("events.connect")) {
      items.push({ id: "events", label: "Events", to: "/events", comingIn: 4 });
    }
  }
  if (sections.docs && meta.docs && can("docs.read")) {
    items.push({ id: "docs", label: "API docs", to: "/docs", comingIn: 5 });
  }
  return items;
}
