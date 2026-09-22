import type { UiSections } from "../../lib/shared/config.ts";
import type { JobsApiAction } from "../api/contract";
import type { MetaDto } from "../api/types";

/** Stable ids of the nav entries. */
export type NavId =
  | "overview"
  | "queues"
  | "workers"
  | "runners"
  | "events"
  | "docs"
  | "docs-http"
  | "docs-ws";

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
 * - Workers — `manage`, mode jobs/both, a worker registry (`meta.features.workers`), `workers.list`.
 * - Runners — `manage`, mode runner/both, `runners.list`.
 * - Events — `manage`, a socket (`meta.websocket`), `events.connect`.
 * - API docs — `docs`, docs routed (`meta.docs`, the runtime authority), `docs.read`.
 *   Nested under it: HTTP API always, WebSocket API when the API documents a
 *   socket (`meta.docs.asyncapi`).
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
      });
    }
    if (jobsMode && can("queues.list")) {
      items.push({
        id: "queues",
        label: "Queues",
        to: "/queues",
      });
    }
    if (jobsMode && meta.features.workers && can("workers.list")) {
      items.push({
        id: "workers",
        label: "Workers",
        to: "/workers",
      });
    }
    if (runnerMode && can("runners.list")) {
      items.push({
        id: "runners",
        label: "Runners",
        to: "/runners",
      });
    }
    if (meta.websocket && can("events.connect")) {
      items.push({
        id: "events",
        label: "Events",
        to: "/events",
      });
    }
  }
  if (sections.docs && meta.docs && can("docs.read")) {
    const children: NavItem[] = [
      { id: "docs-http", label: "HTTP API", to: "/docs/http" },
    ];
    if (meta.docs.asyncapi !== undefined) {
      children.push({ id: "docs-ws", label: "WebSocket API", to: "/docs/ws" });
    }
    items.push({ id: "docs", label: "API docs", to: "/docs", children });
  }
  return items;
}
