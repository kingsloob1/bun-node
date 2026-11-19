/**
 * The jobs UI's mount (embedding.md §2): its config made from a host's
 * {@link JobsMountOptions}, its app rendered through the kit's `mountUi`.
 * `mount.tsx` is the entry that exports {@link mountJobsUi}; tests call
 * {@link mountJobsApp} for its internals (a fake socket, no retries).
 */
import type { JobsUiConfig } from "../../lib/jobs/browser/config.ts";
import type { JobsMountOptions } from "../../lib/jobs/mount.ts";
import type { MountedUi, MountElement } from "../../lib/kit/browser/mount.ts";
import type { LiveOptions } from "./live";
import { resolveMountTheme } from "../../lib/kit/browser/mount.ts";
import { InsideBasePath } from "../kit/InsideBasePath";
import { configLayout, mountUi, requireString } from "../kit/mount";
import { normalizeBasePath } from "../kit/routing";
import { createApiClient } from "./api/client";
import { App } from "./App";
import { LiveOptionsContext } from "./live";
import { AppProviders } from "./providers";
import { createQueryClient } from "./queryClient";

/** What tests pass beside a host's options. */
export interface JobsMountInternals {
  /** The live socket's options (tests pass `{ disabled: true }` or a fake). Default: the page's `WebSocket`. */
  live?: LiveOptions;
  /** Retry failed reads. Default `true`; tests pass `false`. */
  retry?: boolean;
}

/** The app's config for a mount. */
export function mountConfig(
  options: JobsMountOptions,
  shell: JobsUiConfig["shell"],
): JobsUiConfig {
  const basePath = normalizeBasePath(
    requireString(options, "basePath", "mountJobsUi"),
  );
  return {
    version: 1,
    title: options.title ?? "Jobs",
    basePath,
    assetsPath: options.assetsPath ?? `${basePath}/assets`,
    apiBase: requireString(options, "apiBase", "mountJobsUi").replace(
      /\/+$/,
      "",
    ),
    csrfHeader: options.csrfHeader ?? null,
    websocket: options.websocket ?? null,
    docs: options.docs ?? null,
    sections: { manage: true, docs: true, ...options.sections },
    theme: resolveMountTheme(options.theme ?? "inherit", options.themeSource),
    layout: configLayout(options),
    shell,
    unauthorized: options.unauthorized ?? null,
  };
}

/** {@link mountJobsUi} with the tests' internals. */
export function mountJobsApp(
  element: MountElement,
  options: JobsMountOptions,
  internals: JobsMountInternals = {},
): MountedUi {
  const basePath = normalizeBasePath(
    requireString(options, "basePath", "mountJobsUi"),
  );
  requireString(options, "apiBase", "mountJobsUi");
  return mountUi({
    ui: "jobs",
    element,
    basePath,
    options,
    unauthorizedStatuses: options.unauthorized?.statuses,
    render: ({ fetch, history, unauthorized, shell }) => {
      const config = mountConfig(options, shell);
      const client = createApiClient(config, { fetch });
      const queryClient = createQueryClient({ retry: internals.retry });
      return {
        node: (
          <LiveOptionsContext value={internals.live ?? null}>
            <AppProviders
              config={config}
              client={client}
              queryClient={queryClient}
              history={history}
              unauthorized={unauthorized}
            >
              <InsideBasePath>
                <App />
              </InsideBasePath>
            </AppProviders>
          </LiveOptionsContext>
        ),
        dispose: () => {
          void queryClient.cancelQueries();
          queryClient.clear();
        },
      };
    },
  });
}
