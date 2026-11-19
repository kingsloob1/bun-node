/**
 * What every UI's mount function shares (embedding.md §2, §5 to §8): the
 * mount root, the reader's `rem`, the theme and layout on the root, the
 * history a host may own, the host's headers and credentials on every
 * request, `onUnauthorized`, and a teardown that leaves nothing behind.
 * Each UI's `app/<ui>/mount.tsx` binds it to its app. Nothing runs at load.
 */
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type {
  MountedUi,
  MountElement,
  MountOptions,
  MountTheme,
} from "../../lib/kit/browser/mount.ts";
import type { UnauthorizedRedirect } from "./unauthorized";
import type { RouterHistory } from "./routing";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_MOUNT_SHELL,
  resolveMountLayout,
  resolveMountTheme,
} from "../../lib/kit/browser/mount.ts";
import type { UiLayout } from "../../lib/kit/browser/shared.ts";
import { DEFAULT_UI_LAYOUT } from "../../lib/kit/browser/shared.ts";
import { DEFAULT_UNAUTHORIZED_STATUSES } from "../../lib/kit/browser/unauthorized.ts";
import {
  MOUNT_REM_PROPERTY,
  MOUNT_ROOT_ATTRIBUTE,
} from "../../lib/kit/scopeCss.ts";
import { UiRootContext } from "./frame";
import { applyLayout } from "./layout";
import { normalizeBasePath } from "./routing";
import { applyTheme } from "./theme";
import { createUnauthorizedCallback } from "./unauthorized";

/** A `fetch` as the UIs' API clients take it. */
export type MountFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/** A {@link RouterHistory} a mount drives from outside React too. */
export interface MountHistory extends RouterHistory {
  /** Shows `url` (a full path): the host's `navigate()`. In the page's history it is a new entry; with `onNavigate`, the host already moved. */
  show: (url: string) => void;
  /** Drops every listener. */
  dispose: () => void;
}

/**
 * The history of a mounted UI. Without `onNavigate` it is the page's own
 * (`pushState`, `popstate`). With it, the UI keeps the URL it shows itself,
 * starting from the page's, hands every navigation to `onNavigate` (but one
 * to where it already is) and follows only {@link MountHistory.show}, so the
 * host's router owns history.
 */
export function createMountHistory(
  onNavigate?: MountOptions["onNavigate"],
): MountHistory {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  let current = {
    pathname: window.location.pathname,
    search: window.location.search,
  };
  /** A full path's path and query. */
  const parse = (url: string) => {
    const parsed = new URL(url, window.location.href);
    return { pathname: parsed.pathname, search: parsed.search };
  };
  if (onNavigate === undefined) {
    return {
      read: () => ({
        pathname: window.location.pathname,
        search: window.location.search,
      }),
      go: (url, replace) => {
        if (replace) window.history.replaceState(null, "", url);
        else window.history.pushState(null, "", url);
      },
      listen: (onChange) => {
        listeners.add(onChange);
        window.addEventListener("popstate", onChange);
        return () => {
          listeners.delete(onChange);
          window.removeEventListener("popstate", onChange);
        };
      },
      show: (url) => {
        window.history.pushState(null, "", url);
        notify();
      },
      dispose: () => listeners.clear(),
    };
  }
  return {
    read: () => current,
    go: (url, replace) => {
      const next = parse(url);
      // Already there (a redirect run twice under StrictMode): nothing to hand on.
      if (
        next.pathname === current.pathname &&
        next.search === current.search
      ) {
        return;
      }
      current = next;
      onNavigate(url, { replace });
    },
    listen: (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    show: (url) => {
      current = parse(url);
      notify();
    },
    dispose: () => listeners.clear(),
  };
}

/**
 * A mount option that must be a non-empty string, or a `TypeError` naming
 * the mount function and the option.
 */
export function requireString(
  options: unknown,
  key: string,
  fn: string,
): string {
  if (typeof options !== "object" || options === null) {
    throw new TypeError(`${fn} needs an options object`);
  }
  const value = (options as Record<string, unknown>)[key];
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${fn} needs ${key}, a non-empty string`);
  }
  return value;
}

/**
 * The `layout` a UI's config carries when mounted: the root's own layout is
 * the kit's (`mountUi`); the config's is what an embedded docs screen is
 * told, which takes a width, not `"none"`.
 */
export function configLayout(options: MountOptions): UiLayout {
  const layout = resolveMountLayout(options.layout);
  return {
    align: layout.align,
    scope: layout.scope,
    maxWidth:
      layout.maxWidth === "none" ? DEFAULT_UI_LAYOUT.maxWidth : layout.maxWidth,
  };
}

/** The full path of an app path under `basePath`, as the router's `href` builds it. */
export function hrefUnder(basePath: string, to: string): string {
  const base = normalizeBasePath(basePath);
  const target = to.startsWith("/") ? to : `/${to}`;
  if (base === "") return target;
  return target === "/" || target.startsWith("/?")
    ? `${base}${target.slice(1)}`
    : `${base}${target}`;
}

/**
 * The `fetch` a mounted UI's clients send through: the host's `headers()`,
 * called per request, under the client's own (which win: `Accept`, the
 * CSRF header), and the host's `credentials` when it set them. Looks the
 * global `fetch` up per call.
 */
export function mountFetch(
  options: Pick<MountOptions, "headers" | "credentials">,
): MountFetch {
  return (input, init) => {
    const headers = new Headers(options.headers?.());
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    return globalThis.fetch(input, {
      ...init,
      // A plain object, as the clients send theirs (names lower-cased).
      headers: Object.fromEntries(headers.entries()),
      ...(options.credentials === undefined
        ? {}
        : { credentials: options.credentials }),
    });
  };
}

/**
 * The reader's default font size, in CSS pixels, read from a probe at
 * `font-size: medium` inside `root`; `undefined` when the browser reports no
 * pixel size (a DOM without layout).
 */
export function readerFontSize(root: HTMLElement): number | undefined {
  const probe = root.ownerDocument.createElement("span");
  probe.style.fontSize = "medium";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  root.append(probe);
  const size = Number.parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

/** What a UI's mount function hands the kit. */
export interface MountSetup {
  /** The UI's name: the root's `data-bun-ui`. */
  ui: string;
  /** The host's element; the root is created inside it. */
  element: MountElement;
  /** The UI's `basePath`. */
  basePath: string;
  /** The kit's options, as the host passed them. */
  options: MountOptions;
  /** The statuses `onUnauthorized` is called for (the UI's `unauthorized.statuses`). Default `[401]`. */
  unauthorizedStatuses?: readonly number[];
  /** Builds the app once the root, history, `fetch` and `unauthorized` exist; `dispose` runs after React unmounts. */
  render: (context: MountRenderContext) => {
    /** The tree to render. */
    node: ReactNode;
    /** Closes what the UI opened outside React (its query cache). */
    dispose?: () => void;
  };
}

/** What a UI's app is built from, inside a mount. */
export interface MountRenderContext {
  /** The mount root, `<div data-bun-ui="<ui>">` inside the host's element. */
  root: HTMLElement;
  /** The router's history. */
  history: MountHistory;
  /** The `fetch` the UI's clients send through. */
  fetch: MountFetch;
  /** What an authorization failure does when the host passed `onUnauthorized`; `undefined` for the UI's own rule. */
  unauthorized: UnauthorizedRedirect | undefined;
  /** The shell to draw: the host's, else {@link DEFAULT_MOUNT_SHELL}. */
  shell: NonNullable<MountOptions["shell"]>;
}

/**
 * Mounts a UI (see the module's description): creates its root inside
 * `element`, applies the reader's `rem`, the theme and the layout to it,
 * renders the app, and returns the host's handle.
 *
 * @throws A `TypeError` when `element` is not an element.
 */
export function mountUi(setup: MountSetup): MountedUi {
  const { ui, element, basePath, options } = setup;
  if (!(element instanceof Element)) {
    throw new TypeError(`mounting the ${ui} UI needs an element to mount into`);
  }
  const root = element.ownerDocument.createElement("div");
  root.setAttribute(MOUNT_ROOT_ATTRIBUTE, ui);
  element.append(root);
  const rem = readerFontSize(root);
  if (rem !== undefined) {
    root.style.setProperty(MOUNT_REM_PROPERTY, `${rem}px`);
  }
  let theme: MountTheme = options.theme ?? "inherit";
  const applyMountTheme = () =>
    applyTheme(resolveMountTheme(theme, options.themeSource), root);
  applyMountTheme();
  applyLayout(resolveMountLayout(options.layout), root);

  const history = createMountHistory(options.onNavigate);
  const unauthorized =
    options.onUnauthorized === undefined
      ? undefined
      : createUnauthorizedCallback(
          setup.unauthorizedStatuses ?? DEFAULT_UNAUTHORIZED_STATUSES,
          basePath,
          options.onUnauthorized,
        );
  const { node, dispose } = setup.render({
    root,
    history,
    fetch: mountFetch(options),
    unauthorized,
    shell: options.shell ?? DEFAULT_MOUNT_SHELL,
  });
  const reactRoot: Root = createRoot(root);
  reactRoot.render(
    <StrictMode>
      <UiRootContext value={root}>{node}</UiRootContext>
    </StrictMode>,
  );

  let mounted = true;
  return {
    navigate: (path) => {
      if (mounted) history.show(hrefUnder(basePath, path));
    },
    setTheme: (next) => {
      theme = next;
      if (mounted) applyMountTheme();
    },
    unmount: () => {
      if (!mounted) return;
      mounted = false;
      for (const dialog of root.querySelectorAll("dialog")) {
        if (dialog.open) dialog.close();
      }
      reactRoot.unmount();
      dispose?.();
      history.dispose();
      root.remove();
    },
  };
}
