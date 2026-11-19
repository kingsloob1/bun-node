/**
 * `@kingsleyweb/bun-ui/docs/mount`: the docs viewer as a function a host
 * page calls to show it in its own layout (embedding.md §2). Bundled on its
 * own; nothing runs at load. Its types are `lib/docs/mount.ts`'s.
 */
import type { DocsMountOptions } from "../../lib/docs/mount.ts";
import type { MountedUi, MountElement } from "../../lib/kit/browser/mount.ts";
import { mountDocsApp } from "./mountApp";

/** See `lib/docs/mount.ts`. */
export function mountDocsUi(
  element: MountElement,
  options: DocsMountOptions,
): MountedUi {
  return mountDocsApp(element, options);
}
