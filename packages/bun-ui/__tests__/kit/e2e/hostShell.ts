/**
 * A host application for the embedding e2e (embedding.md §9.3): a real page
 * of its own — a header, a side menu built from `JOBS_SECTIONS`,
 * `SECURITY_SECTIONS` and `DOCS_SECTIONS` through `sectionsFor()`, a
 * content area — under its own strict CSP and a deliberately aggressive
 * stylesheet, mounting each UI there with `mount*Ui()` from the module its
 * router serves (`*UiMountTags()`), against real APIs.
 *
 * Its URLs are `/<history>-<shell>/<ui>/<the UI's path>`: `history` is
 * `page` (the UI pushes the page's history itself) or `router` (a small
 * host router owns history and the UI hands it every navigation through
 * `onNavigate`); `shell` is the UI's (`none`, `tabs`, `full`). The page
 * keeps what the tests read on `window.__host`: the mounted handle, the
 * sockets and live streams the UI opened, the navigations it handed over,
 * CSP violations.
 */
import type { DocsUi } from "../../../lib/docs/types";
import type { JobsUi } from "../../../lib/jobs/types";
import type { SecurityUi } from "../../../lib/security/types";
import type { UiSection } from "../../../lib/kit/browser/sections";
import type { RouterHandler } from "@kingsleyweb/bun-common";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { DOCS_SECTIONS } from "../../../lib/docs/browser/sections";
import { DEFAULT_ENTRY as DOCS_ENTRY } from "../../../lib/docs/assets";
import { createDocsUi, docsUiMountTags } from "../../../lib/docs/docsUi";
import { JOBS_SECTIONS } from "../../../lib/jobs/browser/sections";
import { DEFAULT_ENTRY as JOBS_ENTRY } from "../../../lib/jobs/assets";
import { createJobsUi, jobsUiMountTags } from "../../../lib/jobs/jobsUi";
import { sectionsFor } from "../../../lib/kit/browser/sections";
import { escapeHtml } from "../../../lib/kit/shell";
import { SECURITY_SECTIONS } from "../../../lib/security/browser/sections";
import { DEFAULT_ENTRY as SECURITY_ENTRY } from "../../../lib/security/assets";
import {
  createSecurityUi,
  securityUiMountTags,
} from "../../../lib/security/securityUi";
import { memorySecurityApi } from "../../security/server/helpers";

/** The UIs the host mounts, by the name in its URLs. */
export const HOST_UIS = ["jobs", "security", "docs"] as const;

/** One of {@link HOST_UIS}. */
export type HostUi = (typeof HOST_UIS)[number];

/** The host's history modes and the UI's shells, the first segment of its URLs. */
export const HOST_MODES = ["page", "router"] as const;

/** A shell the host asks for. */
export const HOST_SHELLS = ["none", "tabs", "full"] as const;

/** A small OpenAPI document for the docs viewer. */
const DOCUMENT = {
  openapi: "3.1.0",
  info: { title: "Embed e2e", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        tags: ["Pets"],
        summary: "List the pets",
        responses: { "200": { description: "The pets" } },
      },
    },
  },
};

/**
 * The host's own stylesheet, deliberately aggressive (embedding.md §9.3): a
 * 62.5% root, universal and element rules, rules on the kit's class names,
 * and a `spin` of its own. Accessible itself (its text passes AA), so the
 * page-wide checks judge the UI.
 */
export const HOST_CSS = `
html { font-size: 62.5%; }
* { font: 20px/1.6 Georgia, serif; letter-spacing: 0.5px; box-sizing: content-box; margin: 0; padding: 0; color: rgb(17, 17, 17); }
body { background: rgb(250, 250, 245); }
button { background: rgb(255, 220, 0); border: 3px solid rgb(17, 17, 17); padding: 6px 10px; }
table { width: 200px; border-collapse: collapse; }
td, th { padding: 8px; border: 1px solid rgb(17, 17, 17); }
a { color: rgb(0, 60, 120); text-decoration: underline; }
ul { list-style: square; }
h1, h2, p { margin: 12px 0; }
input, select, textarea { border: 4px dashed rgb(0, 0, 0); }
.card, .btn, .screen, .table, .badge { outline: 3px solid rgb(255, 0, 255); }
@keyframes spin { from { opacity: 0.5; } to { opacity: 0.5; } }
:root[data-host-theme="dark"] body { background: rgb(18, 18, 18); }
:root[data-host-theme="dark"] .host-header, :root[data-host-theme="dark"] .host-menu, :root[data-host-theme="dark"] .host-menu * { color: rgb(240, 240, 240); }
.host-header { display: flex; align-items: center; gap: 16px; padding: 12px 16px; border-bottom: 2px solid rgb(17, 17, 17); }
.host-brand { font-weight: bold; }
.host-body { display: flex; align-items: flex-start; }
.host-menu { flex: none; width: 220px; padding: 12px 16px; }
.host-menu ul { padding-left: 20px; }
.host-menu a[aria-current="page"] { font-weight: bold; }
.host-group { font-weight: bold; margin-top: 12px; }
.host-content { flex: 1; min-width: 0; padding: 16px; }
.host-footer { padding: 12px 16px; border-top: 2px solid rgb(17, 17, 17); }
@media (max-width: 700px) {
  .host-body { flex-direction: column; align-items: stretch; }
  .host-menu { width: auto; }
}
`;

/** The page's script: the host router, the mounts and the probes the tests read (see the module's description). */
const HOST_SCRIPT = `
const cfg = JSON.parse(document.getElementById("host-config").textContent);
const host = (window.__host = { violations: [], sockets: [], streams: [], navigations: [], current: null, kind: null, ready: false });
document.addEventListener("securitypolicyviolation", (e) => host.violations.push(e.violatedDirective + " " + e.blockedURI));
const NativeSocket = window.WebSocket;
window.WebSocket = class extends NativeSocket {
  constructor(...args) { super(...args); host.sockets.push(this); }
};
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  if (String(input).includes("/live")) host.streams.push(init.signal ?? null);
  return nativeFetch(input, init);
};
const modules = {};
const kindOf = (path) => {
  const kind = path.split("/")[2];
  return kind in cfg.uis ? kind : null;
};
const baseOf = (kind) => "/" + cfg.prefix + "/" + kind;
const markMenu = () => {
  for (const link of document.querySelectorAll(".host-menu a")) {
    const here = new URL(link.href).pathname === location.pathname;
    if (here) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
};
async function mount(kind) {
  const ui = cfg.uis[kind];
  modules[kind] ??= await import(ui.module);
  const options = {
    ...ui.options,
    basePath: baseOf(kind),
    shell: cfg.shell,
    theme: "inherit",
    themeSource: () => (document.documentElement.dataset.hostTheme === "dark" ? "dark" : "light"),
  };
  if (cfg.mode === "router") {
    options.onNavigate = (path, { replace }) => {
      host.navigations.push([path, replace]);
      history[replace ? "replaceState" : "pushState"](null, "", path);
      markMenu();
    };
  }
  host.current = modules[kind][ui.fn](document.getElementById("content"), options);
  host.kind = kind;
}
function unmount() {
  host.current?.unmount();
  host.current = null;
  host.kind = null;
}
async function show(path) {
  const kind = kindOf(path);
  if (kind !== host.kind) {
    unmount();
    if (kind !== null) await mount(kind);
  } else if (host.current !== null) {
    host.current.navigate(path.slice(baseOf(kind).length) || "/");
  }
  markMenu();
}
document.querySelector(".host-menu").addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (link === null) return;
  event.preventDefault();
  const path = new URL(link.href).pathname;
  // The page's history: the UI pushes its own entry; the host's router, or
  // another UI, the host does.
  if (cfg.mode === "router" || kindOf(path) !== host.kind) history.pushState(null, "", path);
  void show(path);
});
addEventListener("popstate", () => {
  const kind = kindOf(location.pathname);
  // The page's history: the mounted UI follows the URL itself.
  if (cfg.mode === "page" && kind === host.kind) return markMenu();
  void show(location.pathname);
});
document.getElementById("host-theme").addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.hostTheme = root.dataset.hostTheme === "dark" ? "light" : "dark";
  host.current?.setTheme("inherit");
});
host.mount = () => mount(kindOf(location.pathname));
host.unmount = unmount;
if (new URLSearchParams(location.search).has("nomount")) {
  markMenu();
  host.ready = true;
} else {
  show(location.pathname).then(() => { host.ready = true; });
}
`;

/** A running host. */
export interface HostShell {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The UIs' own servers, by name: each serves its page, its bundle and its mount module. */
  readonly uis: { jobs: JobsUi; security: SecurityUi; docs: DocsUi };
  /** Stops it. */
  readonly close: () => Promise<void>;
}

/** The host menu's links for one UI's sections under `prefix`. */
function menuGroup(
  prefix: string,
  ui: HostUi,
  label: string,
  sections: readonly UiSection[],
): string {
  const links = sectionsFor(sections, () => true)
    .map(
      (section) =>
        `<li><a href="/${prefix}/${ui}${section.path === "/" ? "" : section.path}">${escapeHtml(section.label)}</a></li>`,
    )
    .join("");
  return `<p class="host-group">${escapeHtml(label)}</p><ul>${links}</ul>`;
}

/** Starts the APIs, the UIs' servers at `/ui/<ui>`, and the host's pages. */
export async function startHostShell(): Promise<HostShell> {
  const jobs = new BunJobs({
    namespace: `ui-embed-e2e-${crypto.randomUUID().slice(0, 8)}`,
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  const jobsApi = createJobsApi({
    jobs,
    basePath: "/jobs-api",
    mode: "jobs",
    authorize: () => true,
    logger: noopLogger,
  });
  const securityApi = await memorySecurityApi({ basePath: "/sec-api" });
  const app = new BunHttpAdapter(0, { logger: noopLogger });
  app.use(jobsApi.basePath, jobsApi.router);
  app.use(securityApi.basePath, securityApi.router);
  const uis = {
    jobs: createJobsUi(
      { api: jobsApi, basePath: "/ui/jobs", dev: true, logger: noopLogger },
      { entry: JOBS_ENTRY },
    ),
    security: createSecurityUi(
      {
        api: securityApi,
        basePath: "/ui/security",
        dev: true,
        logger: noopLogger,
      },
      { entry: SECURITY_ENTRY },
    ),
    docs: createDocsUi(
      {
        document: () => DOCUMENT,
        basePath: "/ui/docs",
        dev: true,
        logger: noopLogger,
      },
      { entry: DOCS_ENTRY },
    ),
  };
  for (const ui of Object.values(uis)) app.use(ui.basePath, ui.router);
  const tags = {
    jobs: await jobsUiMountTags(uis.jobs),
    security: await securityUiMountTags(uis.security),
    docs: await docsUiMountTags(uis.docs),
  };
  const fns = {
    jobs: "mountJobsUi",
    security: "mountSecurityUi",
    docs: "mountDocsUi",
  } as const;

  for (const mode of HOST_MODES) {
    for (const shell of HOST_SHELLS) {
      const prefix = `${mode}-${shell}`;
      const menu = [
        menuGroup(prefix, "jobs", "Jobs", JOBS_SECTIONS),
        menuGroup(prefix, "security", "Security", SECURITY_SECTIONS),
        menuGroup(prefix, "docs", "API docs", DOCS_SECTIONS),
      ].join("");
      const page = (nonce: string) => {
        const config = {
          mode,
          shell,
          prefix,
          uis: Object.fromEntries(
            HOST_UIS.map((ui) => [
              ui,
              {
                module: tags[ui].module.href,
                fn: fns[ui],
                options: uis[ui].config,
              },
            ]),
          ),
        };
        const links = HOST_UIS.map((ui) => tags[ui].html).join("\n");
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acme admin</title>
<style nonce="${nonce}">${HOST_CSS}</style>
${links}
</head>
<body>
<header class="host-header"><span class="host-brand">Acme admin</span><button type="button" id="host-theme">Theme</button></header>
<div class="host-body">
<nav class="host-menu" aria-label="Admin">${menu}</nav>
<div id="content" class="host-content"></div>
</div>
<footer class="host-footer"><table class="host-table table"><tr><td class="host-cell">Host footer</td></tr></table></footer>
<script type="application/json" id="host-config">${JSON.stringify(config).replaceAll("<", "\\u003c")}</script>
<script type="module" nonce="${nonce}">${HOST_SCRIPT}</script>
</body>
</html>`;
      };
      const handler: RouterHandler = (_req, res) => {
        const nonce = crypto.randomUUID().replaceAll("-", "");
        res.status(200);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader(
          "Content-Security-Policy",
          `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`,
        );
        res.send(page(nonce));
      };
      app.get(`/${prefix}`, handler);
      app.get(`/${prefix}/*`, handler);
    }
  }
  jobsApi.websocket?.attach(app);
  const server = await app.listen(0);
  return {
    origin: `http://127.0.0.1:${server.port}`,
    uis,
    close: async () => {
      await app.close();
      await jobsApi.close();
      await jobs.close();
      securityApi.live.close();
      securityApi.close();
    },
  };
}
