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
 * answers with its not-found screen. {@link jobsSectionsFor} applies both,
 * the very filter the UI's own nav uses (#881).
 */
import type { JobsUiSections } from "./config";
import type { SectionPermission, UiSection } from "../../kit/browser/sections";
import { sectionsFor } from "../../kit/browser/sections";

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

/** The permission a section of {@link JOBS_SECTIONS} names: a bun-jobs API action. */
export type JobsSectionPermission = SectionPermission<JobsSection>;

/**
 * What {@link jobsSectionsFor} reads of the API's `GET <api>/meta` body
 * (bun-jobs' `MetaDto`, which fits it as it is), spelled out so this
 * browser-safe entry imports no domain package.
 */
export interface JobsSectionsMeta {
  /** The API's mode: `"jobs"`, `"runner"` or `"both"`. */
  readonly mode: string;
  /** The optional features the API's backend serves. */
  readonly features: {
    /** A worker registry: the Workers section. */
    readonly workers: boolean;
    /** `GET /summon` is served: the Summoning section. Absent on an older API, which serves none. */
    readonly summonList?: boolean;
    /** The provider routes are served: the Providers section. */
    readonly providers: boolean;
  };
  /** The socket, or `null` (or absent) when it is off: the Events section. */
  readonly websocket?: object | null;
  /** The docs endpoints, or `null` (or absent) when they are off: the API docs section. */
  readonly docs?: object | null;
}

/**
 * The jobs UI's sections a caller may use and the API serves, in nav order:
 * exactly the list the UI's own nav shows (#881), so a host's side menu
 * beside a mounted UI links to no screen it answers with not-found. A
 * section is left out when its part of the UI is switched off (`sections`),
 * the API does not serve it, or `can` refuses every permission it names
 * ({@link sectionsFor}):
 *
 * - Overview, Queues: mode `jobs` or `both`.
 * - Workers: mode `jobs` or `both`, and `meta.features.workers`.
 * - Summoning: mode `jobs` or `both`, and `meta.features.summonList`.
 * - Providers: `meta.features.providers`.
 * - Runners: mode `runner` or `both`.
 * - Events: `meta.websocket`.
 * - API docs: `meta.docs`, and the `docs` part on.
 * - Every other one: the `manage` part on.
 *
 * @param meta The API's `GET <api>/meta` body.
 * @param can Whether the caller may perform an action, from the API's `GET <api>/meta/permissions` (`actions[action] === true`).
 * @param sections The parts of the UI switched on (the `sections` option, `JobsUiConfig.sections`). Default: both.
 */
export function jobsSectionsFor(
  meta: JobsSectionsMeta,
  can: (permission: JobsSectionPermission) => boolean,
  sections: Partial<JobsUiSections> = {},
): JobsSection[] {
  const manage = sections.manage ?? true;
  const docs = sections.docs ?? true;
  const jobsMode = meta.mode === "jobs" || meta.mode === "both";
  const runnerMode = meta.mode === "runner" || meta.mode === "both";
  const served: Readonly<Record<JobsSectionId, boolean>> = {
    overview: manage && jobsMode,
    queues: manage && jobsMode,
    workers: manage && jobsMode && meta.features.workers,
    summoning: manage && jobsMode && meta.features.summonList === true,
    providers: manage && meta.features.providers,
    runners: manage && runnerMode,
    events: manage && Boolean(meta.websocket),
    docs: docs && Boolean(meta.docs),
  };
  return sectionsFor(JOBS_SECTIONS, can).filter(
    (section) => served[section.id],
  );
}
