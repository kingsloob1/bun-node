/**
 * `@kingsleyweb/bun-ui/security/mount`: the security UI as a function a
 * host page calls to show it in its own layout (embedding.md §2). Bundled
 * on its own; nothing runs at load. Its types are `lib/security/mount.ts`'s.
 */
import type { MountedUi, MountElement } from "../../lib/kit/browser/mount.ts";
import type { SecurityMountOptions } from "../../lib/security/mount.ts";
import { mountSecurityApp } from "./mountApp";

/** See `lib/security/mount.ts`. */
export function mountSecurityUi(
  element: MountElement,
  options: SecurityMountOptions,
): MountedUi {
  return mountSecurityApp(element, options);
}
