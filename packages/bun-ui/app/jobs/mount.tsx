/**
 * `@kingsleyweb/bun-ui/jobs/mount`: the jobs UI as a function a host page
 * calls to show it in its own layout (embedding.md §2). Bundled on its own
 * (`dist/jobs/mount/`, and the router's `/mount.js`); nothing runs at load.
 * Its types are `lib/jobs/mount.ts`'s.
 */
import type { JobsMountOptions } from "../../lib/jobs/mount.ts";
import type { MountedUi, MountElement } from "../../lib/kit/browser/mount.ts";
import { mountJobsApp } from "./mountApp";

/** See `lib/jobs/mount.ts`. */
export function mountJobsUi(
  element: MountElement,
  options: JobsMountOptions,
): MountedUi {
  return mountJobsApp(element, options);
}
