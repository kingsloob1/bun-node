/**
 * `@kingsleyweb/bun-ui/jobs/mount`'s types (embedding.md §2, §3): what a
 * host page mounting the jobs UI in its own layout imports. The function
 * itself is the prebuilt browser module `dist/jobs/mount/index.js` (React
 * bundled in), which `exports["./jobs/mount"]` points at; this file only
 * declares it, so the published types name no React or app type. The app's
 * own `app/jobs/mount.tsx` is held to this declaration by a type test.
 */
import type {
  MountedUi,
  MountElement,
  MountOptions,
} from "../kit/browser/mount";
import type { UiUnauthorized } from "../kit/browser/unauthorized";
import type { JobsUiConfig, JobsUiSections } from "./browser/config";

/**
 * What {@link mountJobsUi} takes: where the API and the UI live, and the
 * kit's {@link MountOptions}. A host serving the UI with `jobsUi()` may pass
 * its `ui.config` as it is (`{ ...ui.config, shell: "tabs" }`): the fields
 * only a page needs are accepted and ignored.
 */
export interface JobsMountOptions
  extends
    MountOptions,
    Partial<
      Pick<JobsUiConfig, "version" | "assetsPath" | "websocket" | "docs">
    > {
  /** The management API's base URL, no trailing slash needed: a same-origin path (`"/admin/jobs-api"`) or an origin-qualified URL. */
  apiBase: string;
  /** Where the host routes the UI's paths (`"/admin/jobs"`): its links and history live under it. */
  basePath: string;
  /** The header every mutation carries (the API's `csrf.header`), or `null` for none. Default: none. */
  csrfHeader?: string | null;
  /** Switch a part of the UI off. Default: both on. */
  sections?: Partial<JobsUiSections>;
  /** The brand text the `"full"` shell shows. Default: `"Jobs"`. The page's title is the host's. */
  title?: string;
  /** Where an authorization failure sends the browser when `onUnauthorized` is not given; its `statuses` are the ones `onUnauthorized` is called for. Default: none. */
  unauthorized?: UiUnauthorized | null;
}

/**
 * Mounts the jobs UI inside `element`, in a `<div data-bun-ui="jobs">` it
 * creates there, and returns the handle the host drives it with. Link
 * `@kingsleyweb/bun-ui/jobs/mount.css` (or the router's `/mount.css`) on
 * the page too.
 *
 * @throws A `TypeError` for an element that is not one, or a missing `apiBase` or `basePath`.
 */
export declare function mountJobsUi(
  element: MountElement,
  options: JobsMountOptions,
): MountedUi;

export type {
  MountedUi,
  MountElement,
  MountOptions,
} from "../kit/browser/mount";
