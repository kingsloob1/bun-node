/**
 * The host-shell demo (`/playground/embed`, embedding.md §9.5): a page of
 * the playground's own, its header and side menu built from the UIs'
 * sections (`JOBS_SECTIONS`, `SECURITY_SECTIONS`, `DOCS_SECTIONS` through
 * `sectionsFor()`), mounting the jobs UI, the security UI and the docs
 * viewer in its content area with `mount*Ui()`, from the modules their
 * routers serve (`*UiMountTags()`). Try it by hand: the menu moves the UI
 * and back and forward follow; the shell picker remounts with
 * `"none"`, `"tabs"` or `"full"`; the theme button switches the host's
 * scheme, which the UI inherits; Unmount and Mount tear it down and bring
 * it back. The page has its own strict CSP.
 */
import type { BunHttpAdapter, RouterHandler } from "@kingsleyweb/bun-common";
import type { DocsUi } from "@kingsleyweb/bun-ui/docs";
import type { JobsUi } from "@kingsleyweb/bun-ui/jobs";
import type { SecurityUi } from "@kingsleyweb/bun-ui/security";
import type { UiSection } from "@kingsleyweb/bun-ui/jobs/browser";
import { DOCS_SECTIONS } from "@kingsleyweb/bun-ui/docs/browser";
import { docsUiMountTags } from "@kingsleyweb/bun-ui/docs";
import { JOBS_SECTIONS, sectionsFor } from "@kingsleyweb/bun-ui/jobs/browser";
import { jobsUiMountTags } from "@kingsleyweb/bun-ui/jobs";
import { SECURITY_SECTIONS } from "@kingsleyweb/bun-ui/security/browser";
import { securityUiMountTags } from "@kingsleyweb/bun-ui/security";

/** Where the demo lives. */
export const EMBED_BASE = "/playground/embed";

/** The UIs the demo mounts. */
export interface EmbedDemoUis {
  /** The jobs UI's server (`jobsUi()`). */
  readonly jobs: JobsUi;
  /** The security UI's server (`securityUi()`). */
  readonly security: SecurityUi;
  /** A docs viewer's server (`docsUi()`). */
  readonly docs: DocsUi;
}

/** HTML-escapes text for the page. */
function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The menu's links for one UI's sections. */
function group(
  ui: string,
  label: string,
  sections: readonly UiSection[],
): string {
  const links = sectionsFor(sections, () => true)
    .map(
      (section) =>
        `<li><a href="${EMBED_BASE}/${ui}${section.path === "/" ? "" : section.path}">${escape(section.label)}</a></li>`,
    )
    .join("");
  return `<p class="host-group">${escape(label)}</p><ul>${links}</ul>`;
}

/** The host's own styles: a frame of its own, nothing aimed at the UIs. */
const STYLE = `
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 Georgia, serif; background: #f7f5ef; color: #1b1b1b; }
:root[data-host-theme="dark"] body { background: #161616; color: #eeeeee; }
:root[data-host-theme="dark"] a { color: #9cc8ff; }
a { color: #0b4f8a; }
.host-header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 2px solid currentColor; }
.host-brand { font-weight: bold; margin-right: auto; }
.host-body { display: flex; align-items: flex-start; }
.host-menu { flex: none; width: 210px; padding: 8px 16px; }
.host-menu ul { margin: 0 0 8px; padding-left: 18px; }
.host-menu a[aria-current="page"] { font-weight: bold; }
.host-group { font-weight: bold; margin: 12px 0 4px; }
.host-content { flex: 1; min-width: 0; padding: 12px; }
@media (max-width: 700px) { .host-body { flex-direction: column; align-items: stretch; } .host-menu { width: auto; } }
`;

/** The page's script: mounts the UI the URL names, follows the menu, the shell picker, the theme and the buttons. */
const SCRIPT = `
const cfg = JSON.parse(document.getElementById("embed-config").textContent);
const shellSelect = document.getElementById("embed-shell");
shellSelect.value = sessionStorage.getItem("embed-shell") ?? "none";
let current = null;
let kind = null;
const modules = {};
const kindOf = (path) => {
  const name = path.slice(cfg.base.length + 1).split("/")[0];
  return name in cfg.uis ? name : null;
};
const markMenu = () => {
  for (const link of document.querySelectorAll(".host-menu a")) {
    if (new URL(link.href).pathname === location.pathname) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
};
async function mount(name) {
  const ui = cfg.uis[name];
  modules[name] ??= await import(ui.module);
  current = modules[name][ui.fn](document.getElementById("content"), {
    ...ui.options,
    basePath: cfg.base + "/" + name,
    shell: shellSelect.value,
    theme: "inherit",
    themeSource: () => (document.documentElement.dataset.hostTheme === "dark" ? "dark" : "light"),
  });
  kind = name;
}
function unmount() {
  current?.unmount();
  current = null;
  kind = null;
}
async function show(path) {
  const name = kindOf(path);
  if (name !== kind) {
    unmount();
    if (name !== null) await mount(name);
  } else if (current !== null) {
    current.navigate(path.slice((cfg.base + "/" + name).length) || "/");
  }
  markMenu();
}
document.querySelector(".host-menu").addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (link === null) return;
  event.preventDefault();
  const path = new URL(link.href).pathname;
  if (kindOf(path) !== kind) history.pushState(null, "", path);
  void show(path);
});
addEventListener("popstate", () => {
  if (kindOf(location.pathname) === kind) return markMenu();
  void show(location.pathname);
});
shellSelect.addEventListener("change", () => {
  sessionStorage.setItem("embed-shell", shellSelect.value);
  const name = kind;
  unmount();
  if (name !== null) void mount(name);
});
document.getElementById("embed-theme").addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.hostTheme = root.dataset.hostTheme === "dark" ? "light" : "dark";
  current?.setTheme("inherit");
});
document.getElementById("embed-unmount").addEventListener("click", unmount);
document.getElementById("embed-mount").addEventListener("click", () => {
  if (current === null) void show(location.pathname);
});
if (kindOf(location.pathname) === null) history.replaceState(null, "", cfg.base + "/jobs");
void show(location.pathname);
`;

/** Serves the demo at {@link EMBED_BASE} and under it. */
export function mountEmbedDemo(app: BunHttpAdapter, uis: EmbedDemoUis): void {
  const menu = [
    group("jobs", "Jobs", JOBS_SECTIONS),
    group("security", "Security", SECURITY_SECTIONS),
    group("docs", "API docs", DOCS_SECTIONS),
  ].join("");
  const handler: RouterHandler = async (_req, res) => {
    const tags = {
      jobs: await jobsUiMountTags(uis.jobs),
      security: await securityUiMountTags(uis.security),
      docs: await docsUiMountTags(uis.docs),
    };
    const config = {
      base: EMBED_BASE,
      uis: {
        jobs: {
          module: tags.jobs.module.href,
          fn: "mountJobsUi",
          options: uis.jobs.config,
        },
        security: {
          module: tags.security.module.href,
          fn: "mountSecurityUi",
          options: uis.security.config,
        },
        docs: {
          module: tags.docs.module.href,
          fn: "mountDocsUi",
          options: uis.docs.config,
        },
      },
    };
    const nonce = crypto.randomUUID().replaceAll("-", "");
    res.status(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; object-src 'none'`,
    );
    res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Host shell · bun-node playground</title>
<style nonce="${nonce}">${STYLE}</style>
${tags.jobs.html}
${tags.security.html}
${tags.docs.html}
</head>
<body>
<header class="host-header">
<span class="host-brand">Your app (the host page)</span>
<label>Shell <select id="embed-shell" data-always-set><option value="none">none</option><option value="tabs">tabs</option><option value="full">full</option></select></label>
<button type="button" id="embed-theme">Theme</button>
<button type="button" id="embed-unmount">Unmount</button>
<button type="button" id="embed-mount">Mount</button>
</header>
<div class="host-body">
<nav class="host-menu" aria-label="Your app">${menu}</nav>
<div id="content" class="host-content"></div>
</div>
<script type="application/json" id="embed-config">${JSON.stringify(config).replaceAll("<", "\\u003c")}</script>
<script type="module" nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`);
  };
  app.get(EMBED_BASE, handler).describe({ hidden: true });
  app.get(`${EMBED_BASE}/*`, handler).describe({ hidden: true });
}
