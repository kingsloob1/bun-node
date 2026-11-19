/**
 * What every UI's mount function takes (`mountJobsUi`, `mountSecurityUi`,
 * `mountDocsUi`; plan `docs/plans/bun-ui/embedding.md` §2): the kit's
 * {@link MountOptions}, beside each UI's own config. Browser-safe: types,
 * frozen constants and pure functions, no domain package, nothing done at
 * load. Each UI's `/<ui>/browser` entry re-exports it.
 */
import type {
  UiAlign,
  UiLayoutOptions,
  UiLayoutScope,
  UiTheme,
} from "./shared";
import { MIN_UI_MAX_WIDTH } from "./shared";

/**
 * How much of its own frame a UI draws (the `shell` option): `"full"` its
 * header and side nav, as the shell does; `"tabs"` a compact bar of its
 * sections above the screen; `"none"` the screen alone, the host's own menu
 * being the nav.
 */
export type UiShell = "full" | "tabs" | "none";

/** Every {@link UiShell}, in order of how much they draw. */
export const UI_SHELLS: readonly UiShell[] = Object.freeze([
  "full",
  "tabs",
  "none",
]);

/** Whether a value is a {@link UiShell}: what an app checks before using its config's. */
export function isUiShell(value: unknown): value is UiShell {
  return UI_SHELLS.includes(value as UiShell);
}

/** The `shell` a shell page draws when the option is unset. */
export const DEFAULT_PAGE_SHELL: UiShell = "full";

/** The `shell` a mounted UI draws when the option is unset (embedding.md §12, decision 4). */
export const DEFAULT_MOUNT_SHELL: UiShell = "none";

/**
 * A mounted UI's colour scheme: a {@link UiTheme}, or `"inherit"`, the
 * host's (its {@link MountOptions.themeSource}, else `prefers-color-scheme`).
 */
export type MountTheme = UiTheme | "inherit";

/** The scheme a host reports through {@link MountOptions.themeSource}. */
export type HostColorScheme = "light" | "dark";

/**
 * The scheme to apply for a mounted `theme`: a named one as it is;
 * `"inherit"` is what `themeSource` reports, or `"system"` (follow
 * `prefers-color-scheme`) without one or when it reports something else.
 */
export function resolveMountTheme(
  theme: MountTheme,
  themeSource?: () => unknown,
): UiTheme {
  if (theme !== "inherit") return theme;
  const reported = themeSource?.();
  return reported === "light" || reported === "dark" ? reported : "system";
}

/**
 * A mounted UI's `layout`: the shell's {@link UiLayoutOptions}, whose
 * `maxWidth` may also be `"none"` (no cap: the host's content area decides
 * the width).
 */
export interface MountLayoutOptions extends Omit<UiLayoutOptions, "maxWidth"> {
  /** The content's width cap in CSS pixels, or `"none"` for no cap. Default: `"none"`. */
  maxWidth?: number | "none";
}

/** {@link MountLayoutOptions} once resolved: every field set. */
export interface MountLayout {
  /** Where the content sits when it is narrower than the host's area. */
  align: UiAlign;
  /** What `align` moves. */
  scope: UiLayoutScope;
  /** The content's width cap in CSS pixels, or `"none"`. */
  maxWidth: number | "none";
}

/** The layout a mounted UI has when `layout` is unset, or a field of it is (embedding.md §6). */
export const DEFAULT_MOUNT_LAYOUT: Readonly<MountLayout> = Object.freeze({
  align: "left",
  scope: "content",
  maxWidth: "none",
});

/**
 * Resolves a mounted `layout`, field by field over
 * {@link DEFAULT_MOUNT_LAYOUT}. Throws a `TypeError` naming the field for a
 * value the shell's `layout` option would refuse too.
 */
export function resolveMountLayout(options?: MountLayoutOptions): MountLayout {
  if (options === undefined) return { ...DEFAULT_MOUNT_LAYOUT };
  if (typeof options !== "object" || options === null) {
    throw new TypeError(
      "layout must be an object of { align?, scope?, maxWidth? }",
    );
  }
  const align = options.align ?? DEFAULT_MOUNT_LAYOUT.align;
  if (align !== "left" && align !== "center" && align !== "right") {
    throw new TypeError(`layout.align must be "left", "center" or "right"`);
  }
  const scope = options.scope ?? DEFAULT_MOUNT_LAYOUT.scope;
  if (scope !== "content" && scope !== "page") {
    throw new TypeError(`layout.scope must be "content" or "page"`);
  }
  const maxWidth = options.maxWidth ?? DEFAULT_MOUNT_LAYOUT.maxWidth;
  if (
    maxWidth !== "none" &&
    !(Number.isInteger(maxWidth) && maxWidth >= MIN_UI_MAX_WIDTH)
  ) {
    throw new TypeError(
      `layout.maxWidth must be "none" or an integer of at least ${MIN_UI_MAX_WIDTH}`,
    );
  }
  return { align, scope, maxWidth };
}

/**
 * The options every UI's mount function takes besides its own config
 * (embedding.md §2, §5 to §7). Every field is optional.
 */
export interface MountOptions {
  /** How much of its own frame the UI draws. Default: {@link DEFAULT_MOUNT_SHELL}, `"none"`. */
  shell?: UiShell;
  /** The colour scheme, applied to the mount element, never to `<html>`. Default: `"inherit"`. */
  theme?: MountTheme;
  /**
   * The host's scheme, read when `theme` is `"inherit"` (at mount and on
   * `setTheme("inherit")`): `"light"` or `"dark"`, anything else meaning
   * "follow `prefers-color-scheme`". Default: none.
   */
  themeSource?: () => HostColorScheme | undefined;
  /** Where the content sits, applied to the mount element. Default: {@link DEFAULT_MOUNT_LAYOUT}. */
  layout?: MountLayoutOptions;
  /** Headers added to every API request, called per request so a token can rotate. Default: none. */
  headers?: () => NonNullable<RequestInit["headers"]>;
  /** The API requests' and live streams' `credentials`. Default: `"same-origin"`. */
  credentials?: NonNullable<RequestInit["credentials"]>;
  /**
   * Called with the full path (under `basePath`) instead of `pushState`, for
   * a host whose router owns history; the host then calls the mounted UI's
   * `navigate()` when its route changes. Default: the UI pushes history
   * itself.
   */
  onNavigate?: (path: string) => void;
  /**
   * Called with the status of an API answer the UI's `unauthorized` rule
   * lists (401 by default), instead of the redirect. Default: the kit's
   * `unauthorized` behaviour.
   */
  onUnauthorized?: (status: number) => void;
}

/** What a mount function returns: the handle a host drives the UI with. */
export interface MountedUi {
  /** Shows the screen at `path` (under the UI's `basePath`, `"/queues"`) without a page load. */
  navigate: (path: string) => void;
  /** Applies a scheme to the mount element (`"inherit"` reads `themeSource` again). */
  setTheme: (theme: MountTheme) => void;
  /** Tears the UI down: no element, listener, timer or stream outlives it. A second call does nothing. */
  unmount: () => void;
}
