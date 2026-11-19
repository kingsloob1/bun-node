/**
 * The security UI's mount (embedding.md §2): its config made from a host's
 * {@link SecurityMountOptions}, its app rendered through the kit's
 * `mountUi`. `mount.tsx` is the entry; tests call {@link mountSecurityApp}
 * for its internals.
 */
import type { SecurityUiConfig } from "../../lib/security/browser/config.ts";
import type { SecurityMountOptions } from "../../lib/security/mount.ts";
import type { MountedUi, MountElement } from "../../lib/kit/browser/mount.ts";
import type { LiveOptions } from "./live/context";
import { DEFAULT_SECURITY_CSRF_HEADER } from "@kingsleyweb/bun-security/control/contract";
import { resolveMountTheme } from "../../lib/kit/browser/mount.ts";
import { InsideBasePath } from "../kit/InsideBasePath";
import { configLayout, mountUi, requireString } from "../kit/mount";
import { normalizeBasePath } from "../kit/routing";
import { createSecurityClient } from "./api/client";
import { App } from "./App";
import { LiveOptionsContext } from "./live/context";
import { AppProviders } from "./providers";
import { createQueryClient } from "./queryClient";
import { breakGlassStore } from "./session/breakGlass";

/** What tests pass beside a host's options. */
export interface SecurityMountInternals {
  /** The live stream's options. Default: the app's. */
  live?: LiveOptions;
  /** Retry failed reads. Default `true`; tests pass `false`. */
  retry?: boolean;
  /** Where the break-glass session is kept. Default `sessionStorage`. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/** The session storage, when the browser lets the page have it. */
function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The app's config for a mount. */
export function mountConfig(
  options: SecurityMountOptions,
  shell: SecurityUiConfig["shell"],
): SecurityUiConfig {
  const basePath = normalizeBasePath(
    requireString(options, "basePath", "mountSecurityUi"),
  );
  const apiBase = requireString(options, "apiBase", "mountSecurityUi").replace(
    /\/+$/,
    "",
  );
  return {
    version: 1,
    title: options.title ?? "Security",
    basePath,
    assetsPath: options.assetsPath ?? `${basePath}/assets`,
    apiBase,
    csrfHeader: (
      options.csrfHeader ?? DEFAULT_SECURITY_CSRF_HEADER
    ).toLowerCase(),
    breakGlass: options.breakGlass === true,
    docs: options.docs ?? {
      openapi: `${apiBase}/openapi.json`,
      asyncapi: `${apiBase}/asyncapi.json`,
    },
    live: options.live ?? { path: `${apiBase}/live` },
    theme: resolveMountTheme(options.theme ?? "inherit", options.themeSource),
    layout: configLayout(options),
    shell,
    unauthorized: options.unauthorized ?? null,
  };
}

/** {@link mountSecurityUi} with the tests' internals. */
export function mountSecurityApp(
  element: MountElement,
  options: SecurityMountOptions,
  internals: SecurityMountInternals = {},
): MountedUi {
  const basePath = normalizeBasePath(
    requireString(options, "basePath", "mountSecurityUi"),
  );
  requireString(options, "apiBase", "mountSecurityUi");
  return mountUi({
    ui: "security",
    element,
    basePath,
    options,
    unauthorizedStatuses: options.unauthorized?.statuses,
    render: ({ fetch, history, unauthorized, shell }) => {
      const config = mountConfig(options, shell);
      const client = createSecurityClient(
        config,
        breakGlassStore(
          internals.storage === undefined ? sessionStore() : internals.storage,
        ),
        { fetch },
      );
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
