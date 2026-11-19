/**
 * `@kingsleyweb/bun-ui/security/mount`'s types (embedding.md §2, §3): what
 * a host page mounting the security UI in its own layout imports. The
 * function is the prebuilt browser module `dist/security/mount/index.js`
 * (React bundled in), which `exports["./security/mount"]` points at; this
 * file only declares it, so the published types name no React or app type.
 */
import type {
  MountedUi,
  MountElement,
  MountOptions,
} from "../kit/browser/mount";
import type { UiUnauthorized } from "../kit/browser/unauthorized";
import type { SecurityUiConfig } from "./browser/config";

/**
 * What {@link mountSecurityUi} takes: where the API and the UI live, and the
 * kit's {@link MountOptions}. A host serving the UI with `securityUi()` may
 * pass its `ui.config` as it is: the fields only a page needs are accepted
 * and ignored.
 */
export interface SecurityMountOptions
  extends
    MountOptions,
    Partial<
      Pick<SecurityUiConfig, "version" | "assetsPath" | "docs" | "live">
    > {
  /** The control plane API's base URL (`createSecurityApi`'s `basePath`, or an origin-qualified URL). */
  apiBase: string;
  /** Where the host routes the UI's paths (`"/admin/security"`). */
  basePath: string;
  /** The header every mutation carries. Default: bun-security's, `"x-bun-security-csrf"`. */
  csrfHeader?: string;
  /** Whether the API's break-glass account is configured, so its sign-in is offered. Default: `false`. */
  breakGlass?: boolean;
  /** The brand text the `"full"` shell shows. Default: `"Security"`. */
  title?: string;
  /** Where an authorization failure sends the browser when `onUnauthorized` is not given; its `statuses` are the ones `onUnauthorized` is called for. Default: none. */
  unauthorized?: UiUnauthorized | null;
}

/**
 * Mounts the security UI inside `element`, in a `<div data-bun-ui="security">`
 * it creates there, and returns the handle the host drives it with. Link
 * `@kingsleyweb/bun-ui/security/mount.css` (or the router's `/mount.css`) too.
 *
 * @throws A `TypeError` for an element that is not one, or a missing `apiBase` or `basePath`.
 */
export declare function mountSecurityUi(
  element: MountElement,
  options: SecurityMountOptions,
): MountedUi;

export type {
  MountedUi,
  MountElement,
  MountOptions,
} from "../kit/browser/mount";
