/**
 * The docs viewer's mount (embedding.md §2): its config made from a host's
 * {@link DocsMountOptions}, the viewer rendered through the kit's `mountUi`.
 * `mount.tsx` is the entry; tests call {@link mountDocsApp} for its
 * internals.
 */
import type { DocsUiConfig } from "../../lib/docs/browser/config.ts";
import type { DocsMountOptions } from "../../lib/docs/mount.ts";
import type { MountedUi, MountElement } from "../../lib/kit/browser/mount.ts";
import { DEFAULT_EXTENSION_PREFIXES } from "../../lib/docs/browser/config.ts";
import { resolveMountTheme } from "../../lib/kit/browser/mount.ts";
import { InsideBasePath } from "../kit/InsideBasePath";
import { configLayout, mountUi, requireString } from "../kit/mount";
import { normalizeBasePath } from "../kit/routing";
import { App } from "./App";
import { createQueryClient } from "./queryClient";

/** What tests pass beside a host's options. */
export interface DocsMountInternals {
  /** Retry failed reads. Default `true`; tests pass `false`. */
  retry?: boolean;
}

/** The viewer's config for a mount. */
export function mountConfig(
  options: DocsMountOptions,
  shell: NonNullable<DocsUiConfig["shell"]>,
): DocsUiConfig {
  const basePath = normalizeBasePath(
    requireString(options, "basePath", "mountDocsUi"),
  );
  return {
    version: 1,
    title: options.title ?? "API docs",
    basePath,
    assetsPath: options.assetsPath ?? `${basePath}/assets`,
    documentUrl: requireString(options, "documentUrl", "mountDocsUi"),
    csrfHeader: options.csrfHeader ?? null,
    extensions: options.extensions ?? DEFAULT_EXTENSION_PREFIXES,
    theme: resolveMountTheme(options.theme ?? "inherit", options.themeSource),
    layout: configLayout(options),
    shell,
    unauthorized: options.unauthorized ?? null,
  };
}

/** {@link mountDocsUi} with the tests' internals. */
export function mountDocsApp(
  element: MountElement,
  options: DocsMountOptions,
  internals: DocsMountInternals = {},
): MountedUi {
  const basePath = normalizeBasePath(
    requireString(options, "basePath", "mountDocsUi"),
  );
  requireString(options, "documentUrl", "mountDocsUi");
  return mountUi({
    ui: "docs",
    element,
    basePath,
    options,
    unauthorizedStatuses: options.unauthorized?.statuses,
    render: ({ fetch, history, unauthorized, shell }) => {
      const queryClient = createQueryClient({ retry: internals.retry });
      return {
        node: (
          <App
            config={mountConfig(options, shell)}
            queryClient={queryClient}
            fetch={fetch}
            history={history}
            unauthorized={unauthorized}
            guard={InsideBasePath}
          />
        ),
        dispose: () => {
          void queryClient.cancelQueries();
          queryClient.clear();
        },
      };
    },
  });
}
