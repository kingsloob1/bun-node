# bun-ui: embedding a UI in a host app

A sub-plan of [bun-ui](README.md). **Status: approved by the user (2026-11-18): the names in §11 and the
five recommendations in §12. Not yet built.**

The user's requirement (2026-11-18, before publishing): each UI (jobs,
security, docs) renders either with its own shell, as today, or without it,
**inside a host app's layout that has its own side menu**. The user decided
the shape:

1. **Mount into an element**: `mountJobsUi(element, { apiUrl, basePath, … })`,
   and likewise for security and docs. No iframe; the host's routing and URL;
   styles scoped under the UI's root so neither side breaks the other; the
   host's CSP must allow the script.
2. **The host's side menu shows the sections**: each UI exports its sections
   (label, path, required permission). Without the shell the UI renders only
   the current screen; its own section nav is hidden, or kept as a compact
   tab bar.
3. **A kit-level option** every UI shares, like `theme` and `layout`
   (CLAUDE.md: an option every UI shares lives in the kit).

Written against `develop` at `22b6bad6`. `file:line` references are relative
to `packages/bun-ui/`.

---

## 1. What exists today

- **The shell** (`lib/kit/shell.ts`): a server-rendered HTML page per UI with
  a strict nonce CSP, the config in `<script type="application/json"
  id="…">` (`createUiShellRenderer`), the hashed entry module and stylesheets
  with SRI. The app reads the config from that element and renders into
  `#root` (`app/<ui>/boot.tsx`: `createRoot(document.getElementById("root"))`).
- **Theme and layout** are applied to `document.documentElement`
  (`app/kit/theme.ts:50` `applyTheme(theme, root = documentElement)`,
  `app/kit/layout.ts:19` `applyLayout(layout, root = documentElement)`): the
  root parameter already exists, which is what embedding needs.
- **Styles** are global: `app/kit/styles/tokens.css` puts the tokens on
  `:root`; `base.css` resets `*`, `html`, `body`, `a`, `code` (15 top-level
  selectors); `components.css` styles kit classes (`.btn`, `.table`, …) that a
  host may also use.
- **Routing** (`app/kit/routing.ts`): a small history router over
  `location.pathname`, scoped under the mount's `basePath`; a path outside it
  renders the 404. It already works under any `basePath`.
- **The API client** sends `credentials: "same-origin"` and the CSRF header
  (`app/jobs/api/client.ts:224-241`, the same in security's).
- **`/docs/embed`** (`package.json` `exports["./docs/embed"]` →
  `app/docs/embed.ts`, TSX source, plus `/docs/embed/routing`, `…/router`,
  `…/context`, `…/permissions`): the docs viewer's screens as **source**, for a
  host that bundles them (the jobs app does, by that name). It needs the
  host's bundler, React and a TSX toolchain; it is not a mountable entry.
- **Side effects**: `sideEffects: ["**/*.css", "./app/*/main.tsx"]`; each
  `main.tsx` imports the stylesheets and calls `boot()`.
- **Teardown**: nothing unmounts today (the page owns the app for its life).
  The jobs UI's tests already prove no handle leaks across screens with a
  `HandleLedger` (`__tests__/jobs/app/handleLedger.ts:183`,
  `unmountLeaks.test.tsx`).

---

## 2. The API

One function per UI, from a new browser entry per UI, plus the sections:

```ts
import { mountJobsUi, JOBS_SECTIONS } from "@kingsleyweb/bun-ui/jobs/mount";

const ui = mountJobsUi(document.getElementById("jobs")!, {
  apiUrl: "/admin/jobs-api",      // or the full config a shell would inject
  basePath: "/admin/jobs",        // where the host routes the UI's paths
  shell: "none",                 // "full" (its own header and nav), "tabs", "none"
  theme: "inherit",               // the kit's theme, or "inherit" from the host
  layout: { align: "left", scope: "content", maxWidth: "none" },
  csrfHeader: "x-jobs-csrf",
  headers: () => ({ authorization: `Bearer ${token()}` }),
  credentials: "include",
  onNavigate: (path) => hostRouter.push(path), // optional: the host owns history
});
// later
ui.navigate("/queues/emails");
ui.unmount();
```

- **`mountJobsUi(element, options) → MountedUi`**, `mountSecurityUi`,
  `mountDocsUi`, each from `/<ui>/mount`. `MountedUi` is `{ navigate(path),
  setTheme(theme), unmount() }`.
- **`options`** is the UI's config (what the shell injects today:
  `apiBase`/`apiUrl`, `basePath`, `csrfHeader`, the UI's own fields) plus the
  kit's **`MountOptions`**: `shell`, `theme` (`"inherit"` added), `layout`,
  `headers`, `credentials`, `onNavigate`, `onUnauthorized`.
- **`shell`** is the kit-level option the user asked for: `"full"` renders
  the UI's header and nav inside the element (a self-contained widget);
  `"tabs"` renders the current section's screen with a compact tab bar of the
  sections; `"none"` renders the current screen only, the host's side menu
  being the nav. The shell keeps `"full"`; its server option
  (`jobsUi({ shell })`) exists for symmetry but defaults to `"full"`.
- **Sections**: `JOBS_SECTIONS`, `SECURITY_SECTIONS`, `DOCS_SECTIONS` from
  `/<ui>/browser` (the browser-safe contract entry, no runtime import beyond
  constants): each `{ id, label, path, needs }` (`needs`: the permission, or
  `null`), the same list the UI's own nav reads (today
  `app/security/layout/nav.ts`'s `SECTIONS`, moved to the contract entry so the
  host and the UI share one list). A host filters them by the permissions it
  reads (`GET /meta/permissions`) or shows them all and lets the UI show "No
  access". A helper, `sectionsFor(permissions)`, does the filtering the same
  way the UI does.

## 3. Shipping a mountable entry

- **Two builds per UI.** Today `dist/<ui>/` holds the shell's entry
  (`main.tsx`: stylesheets + `boot()`). Add **`app/<ui>/mount.tsx`**, a second
  entry exporting `mountXxxUi` and calling nothing at load, built by
  `scripts/build.ts` into `dist/<ui>/mount/` (an ES module and its CSS), and by
  the in-memory build (`lib/kit/assets.ts`) on request when `dist/` is absent.
- **Two ways to load it**, both covered:
  1. **A bundling host** imports `@kingsleyweb/bun-ui/jobs/mount`
     (`exports["./jobs/mount"]`: `types` → `dts/` of a small typed facade in
     `lib/jobs/mount.ts`, `default` → `dist/jobs/mount/index.js`, the
     prebuilt module, so a host needs no TSX toolchain) and its stylesheet
     `@kingsleyweb/bun-ui/jobs/mount.css`.
  2. **A non-bundling host** loads the module from the UI's router:
     `jobsUi()` serves `/mount.js` and `/mount.css` under its `basePath`
     (hashed, SRI, `Cache-Control: immutable`), and a `jobsUiMountTags()`
     helper prints the `<script type="module">` and `<link>` the host page
     includes.
- **`sideEffects`** gains nothing: `mount.tsx` has no effect at load (its CSS
  is a separate file the host links or imports, already covered by
  `**/*.css`). The tree-shaking rule holds: named exports, no top-level work;
  `__tests__/treeShaking.test.ts` gets a row per mount entry (a host importing
  `JOBS_SECTIONS` alone pulls no React; importing `mountJobsUi` pulls the app
  but not the other UIs), with its negative control.
- **Budgets**: `__tests__/budget.test.ts` gets a row per mount entry. The
  mount build bundles React (a host on another React version keeps its own; a
  shared-React variant is a later option, §10).
- **Entry isolation**: `entryIsolation.test.ts` gets the rows (no `node:*`,
  no `bun`, no domain package beyond the contract entries the app already
  uses).
- **`/docs/embed` stays** as the source-level entry for a host that wants the
  docs screens inside its own React tree (the jobs app does). `mountDocsUi`
  is the prebuilt, framework-free alternative; both read the same screens.

## 4. Style scoping

- **Every rule under the UI's root.** The mount stylesheet is the page's own
  built entry stylesheet (which holds every rule, lazy screens' included)
  rewritten by the kit (`lib/kit/scopeCss.ts`, internal): each selector
  prefixed by `[data-bun-ui="jobs"]`; `:root`, `html` and `body` become the
  root itself; `*` becomes the root and `[data-bun-ui="jobs"] *`. Made from
  the very file the page links, so the two cannot drift, and the page's
  build is untouched (EM-2).
- **A guard, not a cascade layer** (decision 3, revised): the stylesheet
  opens with `[data-bun-ui="<ui>"]{all:initial;display:block}` (the root
  inherits nothing from the host) and `[data-bun-ui="<ui>"]
  *:where(:not(svg,svg *))` with `::before`/`::after` `{all:revert}` (every
  element inside back to the browser's styles), then the UI's rules,
  unlayered. A host's universal and element rules do not reach in; a host
  rule more specific than the guard (`.card p` around the root) still does.
  A host overrides on purpose with a selector at least as specific as ours
  (`[data-bun-ui="jobs"] .btn`) linked after the mount stylesheet, or with
  the theme's custom properties on the root. SVG is left out of the guard,
  which would drop its presentation attributes.
- **Keyframes are renamed** `bun-ui-<ui>-<name>`, with the `animation` and
  `animation-name` declarations using them: a keyframes name is global, the
  last stylesheet defining it winning, so a host's `spin` would replace the
  UI's.
- **`rem` is the reader's size** (decision 12): every `Nrem` in a declaration
  becomes `calc(N*var(--bun-ui-rem,16px))`, so a host's `<html>` font size
  (`62.5%`) does not scale the UI; EM-3's mount sets `--bun-ui-rem` on the
  root from a probe at `font-size: medium`. Media queries keep `rem`.
- **The root is the UI's own element** (decision 13): the mount functions
  create `<div data-bun-ui="<ui>">` inside the host's element and render into
  it, so the root guard's `all: initial` never touches an element the host
  styles.
- **No portals today**: the kit's dialogs are the native `<dialog>`
  (`showModal()`, `app/kit/components/Dialog.tsx:62`, the top layer, but in
  the root's DOM, so the scoped styles reach them) and nothing calls
  `createPortal`. The rule for later: anything rendered outside the tree goes
  into a container inside the root (`<div data-bun-ui-portal>`), never into
  `document.body`, so it is styled and removed with the UI.
- **Not Shadow DOM**: it would isolate both ways, but breaks the host's
  theming of the UI and the docs viewer's anchors; rejected (open question
  Q3).

## 5. Routing under a host `basePath`

- The kit router already scopes under `basePath`; mounted, it reads the
  host's `location` too. **Default**: the UI pushes history entries itself, as
  today, and listens to `popstate`; a host router that also listens sees the
  same URL.
- **`onNavigate`**: a host whose router must own history (Next, React
  Router) passes it; the UI then calls `onNavigate(fullPath)` instead of
  `pushState`, and the host calls `ui.navigate(path)` when its route changes.
- Links render real `href`s under `basePath`, so the host's side menu, a new
  tab and a reload all work.
- A path outside `basePath` renders nothing (not the UI's 404), since the
  host owns that page.

## 6. Theme and layout

- `theme: "inherit"` (new, mount only): the UI reads the host's colour scheme
  from `prefers-color-scheme` and a host attribute it names
  (`themeSource: () => "dark" | "light"`), and applies it to the UI's root,
  not `document.documentElement` (`applyTheme(theme, element)`, the
  parameter already there). A named theme works as in the shell.
- **Tokens**: the kit's tokens are custom properties on the UI's root, so a
  host restyles the UI by setting them on the element (`--accent`, …),
  documented as the theming surface.
- **Layout**: `applyLayout(layout, element)`. Mounted, the default is
  `{ align: "left", scope: "content", maxWidth: "none" }`: the host's content
  area decides the width.

## 7. Auth and CSRF from the host

- `credentials` (default `"same-origin"`) and `headers()` (called per request,
  so a token can rotate) go to the API client; `csrfHeader` as in the shell's
  config.
- A `401` calls `onUnauthorized()` when given (the host signs in), else the
  kit's `unauthorized` behaviour (a redirect).
- The security UI's **step-up** popup and **break-glass** session work as in
  the shell (the popup's message is checked against the UI's own origin, the
  page's; the break-glass token in `sessionStorage`).
- The live streams (SSE) use the same `credentials`; a host whose auth is a
  header uses the fetch-based SSE reader the security UI already has
  (bun-client's `sse()`), which takes the headers.
- **CSP**: the host's policy must allow the module (`script-src` its origin
  or the package's hashed file), the stylesheet (`style-src`), and the API
  (`connect-src`). The guide says so, with the exact sources per load method.

## 8. Teardown

- `unmount()` unmounts the React root, closes every live stream and socket,
  cancels the query client's queries and timers, closes an open `<dialog>`,
  removes the root's attributes, and stops listening to `popstate`. A second
  `unmount()` is a no-op.
- **Proof** (the jobs UI's way): the `HandleLedger` harness, generalised into
  `__tests__/harness/` for every UI, records every timer, frame, listener,
  socket, observer and fetch; a test mounts each UI, visits each section,
  unmounts and asserts none is open, with a negative control per kind.

## 9. Tests

1. **Unit / DOM** (happy-dom, under the existing harness rules): each
   `mountXxxUi` renders the current screen for `shell: "none"`, the tab bar
   for `"tabs"`, the full frame for `"full"`; `XXX_SECTIONS` equals what the
   UI's nav renders (one list); `sectionsFor()` filters as the UI does; a
   `401` calls `onUnauthorized`; `onNavigate` replaces `pushState`.
2. **Unmount clean**: the generalised `HandleLedger` case per UI (§8).
3. **Chrome e2e in a host shell** (`__tests__/<ui>/e2e/embed.e2e.test.ts`,
   `Bun.WebView`): a host page with its own side menu built from
   `XXX_SECTIONS`, its own stylesheet (a deliberately aggressive one:
   `* { font: 20px serif }`, `button { background: red }`, `table { width:
   200px }`), its own CSP, mounting each UI in its content area:
   - the side menu navigates the UI; back and reload land on the same screen;
   - **no leak into the UI**: the UI's computed styles inside its root equal
     the shell's for the same screen (a list of probes: font, button, table,
     a token);
   - **no leak out**: the host's elements' computed styles are unchanged
     after mounting (the same probes outside the root);
   - no CSP violation, no console error; unmount leaves no element, listener
     or open stream (the page's `performance` resource list and the ledger).
4. **Budgets, tree shaking and entry isolation**: the rows of §3, each with
   its negative control.
5. **The playground**: a host page at `/playground/embed` with a side menu
   mounting all three UIs, for trying it by hand (the user's rule: every
   feature reaches the playground).

## 10. Order and estimate

| PR | What | Estimate |
|---|---|---|
| EM-1 | kit: `MountOptions`, `shell`, root-scoped theme and layout, the generalised `HandleLedger`; sections moved to the contract entries with `sectionsFor` | ~2 d |
| EM-2 | the `chrome` → `shell` rename (decision 9); the mount stylesheet: the kit's scoping (prefix, guard, keyframes), emitted beside the page's in `dist/` and in memory, `exports["./<ui>/mount.css"]`, the escape checker and the Chrome measurement | ~2 d |
| EM-3 | `mountJobsUi`, `mountSecurityUi`, `mountDocsUi`; the mount entries' builds (prebuilt and in-memory), `exports["./<ui>/mount"]`, the routers' `/mount.js` and `/mount.css`, `xxxUiMountTags()`; budget, tree-shaking and isolation rows; DOM and unmount tests | ~2 d |
| EM-4 | the Chrome host-shell e2e per UI, the guide sections, the playground page | ~1.5 d |

Later: a shared-React variant of the mount entries (the host's React as a
peer), if a host asks.

## 11. Names (approved by the user, 2026-11-18)

| Name | Where |
|---|---|
| `mountJobsUi`, `mountSecurityUi`, `mountDocsUi` → `MountedUi` (`navigate`, `setTheme`, `unmount`) | `/jobs/mount`, `/security/mount`, `/docs/mount` |
| `MountOptions` (`shell`, `theme`, `layout`, `headers`, `credentials`, `onNavigate`, `onUnauthorized`, `themeSource`); `shell: "full" \| "tabs" \| "none"`; `theme: "inherit"` | the kit (`lib/kit/browser/mount.ts`) |
| `JOBS_SECTIONS`, `SECURITY_SECTIONS`, `DOCS_SECTIONS` (`{ id, label, path, needs }`), `UiSection`, `sectionsFor(sections, can)` | `/<ui>/browser`, the kit |
| the stylesheets `/<ui>/mount.css`; the routers' `/mount.js`, `/mount.css`; `jobsUiMountTags()` (and per UI) | `/<ui>/mount`, each `xxxUi()` router |
| the root attribute `data-bun-ui="<ui>"` (on an element the UI creates inside the host's, decision 13), the portal container `data-bun-ui-portal` (for later) | the DOM |
| Added in EM-1 (approved by the user, 2026-11-18): `UI_SHELLS`, `DEFAULT_PAGE_SHELL`, `DEFAULT_MOUNT_SHELL`, `DEFAULT_MOUNT_LAYOUT`; `UiShell`, `MountTheme`, `MountLayout`, `MountLayoutOptions`, `SectionPermission`; `isUiShell`, `resolveMountTheme`, `resolveMountLayout` | the kit (`lib/kit/browser/`), each `/<ui>/browser` |
| Added in EM-1 (approved by the user, 2026-11-18): `resolveShell` (server), `FrameBar`, `clearLayout(root)`, `useUiRoot()` (app) | `lib/kit/options.ts`, `app/kit/` |

The option was built in EM-1 as `chrome` (`UiChrome`, `UI_CHROMES`,
`isUiChrome`, `resolveChrome`, `DEFAULT_SHELL_CHROME`, `DEFAULT_MOUNT_CHROME`,
`data-chrome`) and renamed before any release (decision 9 below). The layer
name `bun-ui.<ui>` was dropped with decision 3's revision: the CSS spec ranks
a host's unlayered rules above every layer, measured in Chrome.

## 12. Decisions (the five recommendations, accepted by the user, 2026-11-18)

1. **One entry per UI (`/<ui>/mount`) or one for all (`/mount`)?**
   Recommended: per UI, so a host pays for the UIs it mounts, as the other
   entries are scoped.
2. **Bundle React in the mount build, or take the host's?** Recommended:
   bundle it first (no version coupling, works for a non-React host); a
   shared-React variant later on request.
3. **Scoped CSS with a prefix and a guard, not a layer, and not Shadow DOM**
   (the user's decision, 2026-11-18, replacing the accepted "prefix and
   layer"). Measured in headless Chrome against a host with `*{font:20px
   serif} button{background:red}`: in `@layer bun-ui.<ui>` the UI lost every
   property to the host (the spec ranks unlayered rules above every layer,
   whatever their specificity); unlayered with the prefix alone, its own
   rules won but inherited ones leaked; unlayered after an `all: revert`
   guard, nothing leaked. So the rules are unlayered, prefixed, after the
   guard (§4). A host overrides on purpose with a selector at least as
   specific as the UI's, or the theme's custom properties on the root; a
   host rule more specific than the guard around the root still reaches in.
   Shadow DOM stays rejected (the host could not theme it; the docs'
   anchors).
4. **The default `shell` when mounted**: recommended `"none"` (the user's
   picture: the host's side menu is the nav), with `"tabs"` one option away.
5. **History**: recommended the UI pushes history by default and `onNavigate`
   hands it to the host when given.

### Decided while building EM-1 (the user's decisions, 2026-11-18)

6. **A section needing either of two permissions.** `UiSection.needs` is a
   permission, a list of permissions of which any one is enough, or `null`.
   Only the jobs UI's Overview uses a list (`metrics.read` or
   `queues.list`), so its behaviour is unchanged; `sectionsFor` treats a list
   as "any of".
7. **What `"tabs"` and `"none"` keep of the header.**
   - `"tabs"`: a compact bar with the section tabs and the UI's working
     controls (security: the scope picker, the break-glass badge and live
     status; jobs: live status). No brand, chips or theme toggle: the host
     themes the UI through `setTheme`.
   - `"none"`: no nav and no header. The security UI keeps a thin bar with
     the scope picker and the break-glass badge, so the operator can change
     scope and always sees an elevated session; the jobs UI shows the screen
     alone.
   - The keyboard shortcuts stay in every mode.
8. **`DOCS_SECTIONS`** is HTTP API (`/http`) and WebSocket API (`/ws`), each
   `needs: null`. The viewer shows only the one matching its document;
   `"full"` stays as it is today (the viewer has no header).

9. **The option is `shell`, not `chrome`** (the user's decision,
   2026-11-18): "chrome" reads as Google Chrome, and "shell" is the user's own
   word for a UI's frame. Renamed in EM-2 throughout (`UiShell`, `UI_SHELLS`,
   `isUiShell`, `resolveShell`, `DEFAULT_PAGE_SHELL`, `DEFAULT_MOUNT_SHELL`,
   each UI's config field, `.app[data-shell]`). It was never published, so
   there is no alias for the old name. `FrameBar` keeps its name.

### Decided while building EM-2

10. **The scope moved** (the coordinator's decision, 2026-11-18): EM-2 ships
    the mount stylesheet, EM-3 the JavaScript (the mount functions, their
    builds, `exports["./<ui>/mount"]`, the routers' `/mount.js` and
    `/mount.css`, the tags helpers), so nothing ships as a stub (§10).
11. **Keyframes are prefixed** `bun-ui-<ui>-<name>` in the mount stylesheet,
    `animation` and `animation-name` rewritten with them (the
    coordinator's decision, 2026-11-18; §4).

12. **`rem` follows the reader** (the user's decision, 2026-11-18, option
    (iii) of three). Measured in Chrome: under a host with `* { font: 20px
    serif }`, 15px text became 18.75px, since the kit sizes in `rem`. Keeping
    `rem` (the UI scales with the host's root) and rewriting it to a fixed
    16px (immune, but deaf to the reader's default size) were the other two.
    The mount stylesheet rewrites `Nrem` to `calc(N*var(--bun-ui-rem,16px))`;
    EM-3's mount sets `--bun-ui-rem` once from a probe at `font-size: medium`,
    so a reader's larger default size is honoured.
13. **The mount functions create the root** (the user's decision,
    2026-11-18): `<div data-bun-ui="<ui>">` inside the host's element, which
    stays exactly as the host styled it; `unmount()` removes the div. The
    root starts from `all: initial` (as a block), and the page's `body` rules
    then set its font, colour and background, so nothing it would inherit
    from the host reaches the UI (measured: the host's `* { letter-spacing }`
    did, before).

EM-1 also makes `shell` a kit option like `layout`: `resolveShell` in
`lib/kit/options.ts`, taken by every `xxxUi()` (default `"full"`) and carried
in each UI's config. The `:root` selectors in the kit's CSS stay until EM-2's
scoped stylesheet build.
