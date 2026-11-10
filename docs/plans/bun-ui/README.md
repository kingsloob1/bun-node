# bun-ui: one package for every bun-node UI

Plan for **`@kingsleyweb/bun-ui`**, one package holding every browser UI the
repository ships, each behind its own subpath: the bun-jobs management UI at
`/jobs`, the API-docs viewer at `/docs`, and later the bun-security management
UI at `/security` and other UI recipes (`/auth`, `/blog`, …). It replaces
`@kingsleyweb/bun-jobs-ui` and `@kingsleyweb/bun-api-docs-ui`. The user
decided, on 2026-11-08:

> "I was thinking of having one central bun-ui package where bun jobs ui will
> be under /jobs and browser facing exports will be under /jobs/client.
> Because having different UI package can be difficult for a user to
> remember. This will affect the bun security management ui, openapi ui and
> all other ui recipe built in the future such as auth ui, blog, etc."

and approved, through the coordinator, on the same day:

- planning it now, and **building it before 3.0.0-rc.1**;
- naming each UI's browser-safe entry **`/<ui>/browser`** (`/jobs/browser`,
  `/docs/browser`, `/security/browser`), not `/<ui>/client`, so it is never
  confused with `@kingsleyweb/bun-client`.

**Status: approved by the user on 2026-11-08, every open question (§12)
answered with its recommendation, and every name in §13 with it.** BU-1
(#666), BU-2 (#708), BU-3 (#709) and BU-5 (#710) merged and were released in
3.0.0-rc.1; BU-4, the shared kit, was built on 2026-11-10 and awaits landing
(§5.1 records what it built and where it departs from §5).

Written 2026-11-08 against `develop` at `d0d53ee1`, on Bun
1.4.4-canary.1+11c367163. **No product code was changed.** Every `file:line`
is at `d0d53ee1` and relative to `packages/` unless it says otherwise. The
spikes are in [`evidence/`](evidence/README.md); none measures speed (the
standing rule).

### Status (2026-11-08)

| Part | State |
|---|---|
| This plan | **approved** by the user on 2026-11-08: Q1–Q12 (§12) answered as recommended, the names of §13 with them |
| The two decisions above | **made by the user** (2026-11-08) |
| [bun-security](../bun-security/README.md) | approved 2026-11-07 with a separate `@kingsleyweb/bun-security-ui`; **§7's edits applied** with this plan's approval: its UI is now bun-ui's `/security` entry |
| Building | **BU-1 merged** (#666); **BU-2, BU-3 and BU-5 merged** (#708, #709, #710; the old packages' leftover names cleaned up in #713); released in **3.0.0-rc.1** (#712), the old two deprecated on npm. **BU-4** (the shared kit) **built** 2026-11-10, awaiting landing (§5.1) |

### Contents

0. [How to read this plan](#0-how-to-read-this-plan)
1. [Summary](#1-summary)
2. [What exists today](#2-what-exists-today)
3. [The package](#3-the-package)
4. [Dependencies: optional peers scoped per entry](#4-dependencies-optional-peers-scoped-per-entry)
5. [The shared kit](#5-the-shared-kit)
6. [Migration](#6-migration)
7. [Effect on the bun-security plan](#7-effect-on-the-bun-security-plan)
8. [Budgets and size](#8-budgets-and-size)
9. [Testing](#9-testing)
10. [PRs, estimates and order](#10-prs-estimates-and-order)
11. [Risks](#11-risks)
12. [Open questions](#12-open-questions)
13. [Names needing approval](#13-names-needing-approval)
14. [What this plan could not verify](#14-what-this-plan-could-not-verify)

---

## 0. How to read this plan

**A UI** is one browser app with its server: today the jobs UI (`jobsUi()`)
and the docs viewer (`docsUi()`). **An entry** is a subpath of the package
(`/jobs`, `/jobs/browser`). **The kit** is the code every UI shares (§5).
**rc.0** is the published `3.0.0-rc.0`; **rc.1** the next candidate.

| Mark | Meaning |
|---|---|
| **[S]** | Read in this repo's source at `d0d53ee1`; the `file:line` is given |
| **[M]** | Measured by a spike in [`evidence/`](evidence/README.md) that can be re-run (bytes and behaviour, never speed) |
| **[V]** | Read from a third party (the npm registry), on 2026-11-08 |
| **[I]** | Inference: a claim to test, not a finding |
| **[U]** | Unverified: nothing may rest on it |
| **[D]** | A design decision this plan proposes |

---

## 1. Summary

### 1.1 The answer

**`@kingsleyweb/bun-ui` is made by moving the two packages into one with
`git mv`, layer by layer (`lib/<ui>/`, `app/<ui>/`, `__tests__/<ui>/`), so
the packaging recipe's single `lib/` → `dts/` build still holds and history
follows every file. Each UI keeps its own React app, its own prebuilt bundle
(`dist/<ui>/`) and its own budget; what they share (the shell, CSP and nonce,
the SRI manifest and asset serving, the in-memory dev build, the
`unauthorized` redirect, the design system and the DOM-test harness) becomes
one internal kit. Domain packages are optional peers scoped per entry: `/jobs`
needs bun-jobs, `/security` will need bun-security, `/docs` needs neither,
and that is enforced at the type level by the existing `checkPeerScopes`, at
run time by a consumer check that gets one consumer per peer set, and in the
repo by an entry-isolation test. bun-common's `"self-hosted"` docs viewer
loads `@kingsleyweb/bun-ui/docs/hosted` instead of bun-api-docs-ui. The two
old packages are deprecated on npm, not shimmed.** The move is about 11
focused days in six PRs; the four that fix the public shape (BU-1, BU-2,
BU-3, BU-5, ~8 d) land before rc.1, and the kit's deduplication (BU-4) is
internal and may follow.

### 1.2 What a user writes

| Today (rc.0) | With bun-ui |
|---|---|
| `import { jobsUi } from "@kingsleyweb/bun-jobs-ui"` | `import { jobsUi } from "@kingsleyweb/bun-ui/jobs"` |
| `import type { UiConfig } from "@kingsleyweb/bun-jobs-ui/lib/shared/config"` | `import type { JobsUiConfig } from "@kingsleyweb/bun-ui/jobs/browser"` (rename: Q6) |
| `import { docsUi } from "@kingsleyweb/bun-api-docs-ui"` | `import { docsUi } from "@kingsleyweb/bun-ui/docs"` |
| `import … from "@kingsleyweb/bun-api-docs-ui/lib/shared/config"` | `import … from "@kingsleyweb/bun-ui/docs/browser"` |
| `import { HttpReference } from "@kingsleyweb/bun-api-docs-ui/embed"` | `import { HttpReference } from "@kingsleyweb/bun-ui/docs/embed"` |
| `"@kingsleyweb/bun-api-docs-ui/embed/unauthorized"` (and the other six `./embed/*`) | `"@kingsleyweb/bun-ui/docs/embed/unauthorized"` (and the same six) |
| `docsRouter({ viewer: { openapi: "self-hosted" } })` with `bun add @kingsleyweb/bun-api-docs-ui` | the same call, with `bun add @kingsleyweb/bun-ui` |
| `bun add @kingsleyweb/bun-jobs-ui @kingsleyweb/bun-jobs` | `bun add @kingsleyweb/bun-ui @kingsleyweb/bun-jobs` |
| (planned) `@kingsleyweb/bun-security-ui` | `@kingsleyweb/bun-ui/security`, `/security/browser` |

### 1.3 The decisions

| # | Decision | Why |
|---|---|---|
| D1 | **One package, `@kingsleyweb/bun-ui`, one subpath per UI** (`/jobs`, `/docs`; `/security`, `/auth`, `/blog` later), each with a browser-safe `/<ui>/browser` | the user's decision (2026-11-08); the name is free on npm [V] |
| D2 | **Layer-first source layout**: `lib/<ui>/`, `app/<ui>/`, `__tests__/<ui>/`, `dist/<ui>/`, with the shared code in `lib/kit/` and `app/kit/` | the packaging recipe has one `lib/` and `rootDir: lib` (`bun-jobs-ui/tsconfig.build.json`, `scripts/build-declarations.ts:501-515`) [S], and its two files must stay identical in every package (CLAUDE.md); a UI-first layout (`jobs/lib`, `docs/lib`) would need a different copy. §3.3 |
| D3 | **One React app per UI over a shared kit, not one app shell** | the UIs are mounted by different hosts, on different listeners (bun-security's UI on an admin listener, the docs viewer on a public one), each under its own CSP and budget; one shell would make every host pay for every UI. §3.4 |
| D4 | **Each UI keeps its own bundle** (`dist/<ui>/`, its own manifest, SRI and budget); a UI's bundle is read only when it is mounted | `resolveAssetSource` runs when `jobsUi()`/`docsUi()` is called (`bun-jobs-ui/lib/assets.ts:409-415`) [S], so an app mounting `/docs` never reads `dist/jobs`. §8 |
| D5 | **Domain packages are optional peers, scoped per entry**: bun-jobs for `/jobs` only (a **required** peer today, `bun-jobs-ui/package.json` `peerDependencies`) [S]; bun-security for `/security`; `/docs` and the root need neither | the user's ask; bun-nest's `./jobs` and `./cache` already work this way (`bun-nest/consumer-check.json:115,141`) [S]. §4 |
| D6 | **The consumer check gets one consumer per distinct peer set**, not two | it installs one consumer with no optional peer and one with **all** of them (`scripts/consumer-check.ts:629-635`) [S], so `/jobs` is checked with bun-security present and could need it unseen; bun-nest has the same gap today with bun-jobs and bun-cache. §4.3 |
| D7 | **Shared kit code never imports a domain package; each UI passes its own error class** | bun-jobs-ui's `lib/assets.ts:14` imports `ConfigError` from bun-jobs at run time, where bun-api-docs-ui's copy imports bun-common's [S]: lifted into the kit as is, `/docs` would need bun-jobs. The kit takes a factory, the pattern `lib/unauthorized.ts` already uses (`UnauthorizedConfigError`, `bun-api-docs-ui/lib/unauthorized.ts:24`) [S], so `jobsUi()` keeps throwing bun-jobs' `ConfigError` and `docsUi()` bun-common's. §5 |
| D8 | **Move with `git mv` in a pure-rename commit, then a fix-up commit**, inside one PR merged with a merge commit | rename detection then carries every file's history, and a branch written before the move rebases with its edits following the files [M, `evidence/rename-rebase.out`]. §6.1 |
| D9 | **bun-common's `"self-hosted"` viewer keeps its name** and loads `@kingsleyweb/bun-ui/docs/hosted` | the name says where the viewer is served from, not which package it is; the peer and the message change, the option does not (Q4). §6.2 |
| D10 | **The old packages are deprecated on npm, not shimmed** | both exist only as `3.0.0-rc.0` (and a `0.0.0-stage`) [V]; a shim is two more workspace members with the whole recipe for a prerelease nobody was promised (Q2). §6.7 |
| D11 | **The jobs app keeps importing the docs screens through the public embed spelling** (`@kingsleyweb/bun-ui/docs/embed`), a self-reference, not a relative path | the jobs UI is today the only in-repo consumer of `./embed`, its coverage (`bun-api-docs-ui/consumer-check.json` `$comment`) [S]; a relative import would leave the published embed untested [I]. §3.4 |
| D12 | **The DOM-test rules extend to every UI**: one harness, one `domLeak` guard over all of `__tests__/`, seeds over the whole suite | bun-api-docs-ui has `setupDom()` but no `domLeak.test.ts` [S]; in one package its tests share a serial `--randomize` process with the jobs tests. §9 |

### 1.4 Cost

| Part | PRs | Effort |
|---|---|---|
| The consumer check, one consumer per peer set | BU-1 | ~1 d |
| bun-ui from bun-jobs-ui (`/jobs`, `/jobs/browser`, the root) and every reference | BU-2 | ~3.5 d |
| bun-api-docs-ui into bun-ui (`/docs`, `/docs/browser`, `/docs/hosted`, `/docs/embed*`), bun-common's viewer | BU-3 | ~3 d |
| The kit: one shell, CSP, assets, `unauthorized`, design system and test harness | BU-4 | ~3 d |
| The jobs-shaped generic names (Q6) | BU-5 | ~0.5 d |
| Deprecating the old packages on npm (after rc.1 is published) | BU-6 | ~0.1 d |
| **Total** | | **~11 d** |

---

## 2. What exists today

### 2.1 bun-jobs-ui [S]

- **Entries** (`bun-jobs-ui/package.json` `exports`): `.`, `./lib`,
  `./lib/*.ts`, `./lib/*.js`, `./lib/*`, `./package.json`. `files`: `dist`,
  `dts`, `lib` (no `app/`: the published package cannot build in memory).
- **Dependencies**: bun-common and bun-api-docs-ui at run time; bun-jobs as a
  **required** peer; React, TanStack Query, bun-client and the test stack as
  devDependencies, bundled into `dist/`.
- **`lib/`** (1,610 lines without `build-declarations.ts`): `jobsUi.ts`
  (`jobsUi()` at `:706`), `assets.ts` (build, write, verify and load
  `dist/`; `DEFAULT_ENTRY` `app/main.tsx` at `:20`, `DEFAULT_DIST_DIR` at
  `:23`, `resolveAssetSource` at `:415`), `shell.ts` (`cspHeader` at `:73`,
  `connectSources`, `createShellRenderer`, `createNonce`), `types.ts`,
  `shared/config.ts` (`UiConfig`, `UiSections`, `UiTheme`,
  `UI_CONFIG_ELEMENT_ID = "bun-jobs-ui-config"`) and `shared/unauthorized.ts`
  (types re-exported from bun-api-docs-ui).
- **`app/`**: 236 files, 49,285 lines. **`__tests__/`**: 221 files, 67,579
  lines; 144 test files with 1,678 `it`/`test` call sites (more tests at run
  time, through `.each`); `server/`, `app/` (with `app/pkg/`, a DOM-free
  project importing the bun-jobs root), `e2e/` (headless Chrome through
  `Bun.WebView`).
- **Projects**: `tsconfig.json` (lib, scripts, server and e2e tests),
  `app/tsconfig.json` (DOM), `__tests__/app/tsconfig.json` (extends the app
  one, for `bun test --check`'s nearest-config rule), `__tests__/app/pkg/tsconfig.json`.
  `check` is `bun check && bun check -p app && bun check -p __tests__/app/pkg`.
- **Scripts**: `build.ts`, `build-declarations.ts` (the recipe copy),
  `routes-openapi.ts` (`gen:client` / `check:client`, bun-client's generator
  over the jobs API's document; typed-client pilot P1b).
- **Budget** (`__tests__/server/budget.test.ts:38-46`): entry 348 KiB
  (112 KiB gzipped), any other chunk 101 KiB (33 KiB).
- **consumer-check.json**: eight spellings (the root, `lib/index`,
  `lib/jobsUi`, `lib/types`, and `lib/shared/config` and
  `lib/shared/unauthorized` as `browser` entries); packs bun-contract,
  bun-common, bun-api-docs-ui and bun-jobs alongside.

### 2.2 bun-api-docs-ui [S]

- **Entries**: the same six as above, plus **`./embed`** and seven
  `./embed/*` (`routing`, `router`, `context`, `permissions`, `client`,
  `errors`, `unauthorized`), which point `types` and `default` at **TSX
  source in `app/`**: a bundler-only surface. `files`: `app`, `dist`, `dts`,
  `lib`.
- **Dependencies**: bun-common at run time; no peer but `@types/bun`;
  bun-jobs only as a devDependency (its tests).
- **`lib/`**: `docsUi.ts` (`docsUi()` at `:621`), `assets.ts` and
  `shell.ts` (near copies of bun-jobs-ui's: §2.4), `unauthorized.ts` (the
  server half of `unauthorized`, **shared**: bun-jobs-ui's `jobsUi.ts:32-36`
  imports it), `hosted.ts` (what bun-common's `"self-hosted"` viewer loads:
  `resolveHostedAssets`, the shell and CSP builders), `shared/config.ts`
  (`DocsUiConfig`, `DocsUiTheme`, `DOCS_UI_CONFIG_ELEMENT_ID`),
  `shared/unauthorized.ts` (the browser-safe half: `unauthorizedRedirectUrl`,
  `isUiUnauthorized`, the defaults).
- **`app/`**: 70 files, 13,669 lines, with `embed.ts` (26 exports: the
  schema renderer, the HTTP and WebSocket references, their models, the
  seams). **`__tests__/`**: 43 files, 15,305 lines; 25 test files, 269 call
  sites; `server/` and `app/`; **no e2e**, **no `domLeak` guard**.
- **Budget** (`__tests__/server/budget.test.ts:24-33`): entry 365 KiB
  (114 KiB gzipped), a split chunk 120 KiB (40 KiB).
- **consumer-check.json**: the server surface, including `lib/hosted` and
  `lib/unauthorized`; the `$comment` says `./embed` is covered in-repo by
  bun-jobs-ui consuming it.

### 2.3 How the jobs UI embeds the docs [S]

bun-jobs-ui's docs section is the docs package's screens: 11 imports in
`app/` from `@kingsleyweb/bun-api-docs-ui/embed`, `/embed/routing`,
`/embed/unauthorized` and `/lib/shared/unauthorized` (`app/screens/docs/http/index.tsx:15,22`,
`ws/index.tsx:11`, `router.tsx:4`, `providers.tsx:11`, `live/LiveProvider.tsx:5`,
`routing.ts:13`, `config.ts:2`). Its server takes the `unauthorized` option's
validation and the shell's `303` from bun-api-docs-ui's `lib/unauthorized`
(`jobsUi.ts:32-36`) and its types from `lib/shared/unauthorized`
(`lib/types.ts:8`). So bun-jobs-ui already depends on bun-api-docs-ui at run
time, and both bundles contain the docs screens.

### 2.4 What is duplicated [S]

- `lib/assets.ts`: 430 and 432 lines, differing only in the package name in
  messages and **which `ConfigError`** (bun-jobs' in bun-jobs-ui,
  bun-common's in bun-api-docs-ui). `scripts/build.ts`: identical.
- `lib/shell.ts`: the same `cspHeader`, nonce and shell renderer; they differ
  in the config type, the element id and the `connect-src` helper
  (`connectSources` for the jobs UI's API and socket, `documentOriginSource`
  for a cross-origin document).
- `app/`: **28 files byte-identical** (3,783 lines: the components, the
  tokens and base styles, the JSON views and editors), and 18 more at the
  same path that differ (2,814 lines: `main.tsx`, `App.tsx`, `config.ts`,
  `theme.ts`, `api/*`, `router.tsx`). `__tests__/app/assert.ts` is identical;
  `dom.ts` differs by the jobs UI's lazy-screen preload (39 lines).
- Two `ConfigError` classes exist: bun-common's (`bun-common/lib/errors.ts:19`,
  `extends Error`) and bun-jobs' (`bun-jobs/lib/shared/errors.ts:478`,
  `extends JobsError`, code `"CONFIG"`). Each UI throws its domain's.

### 2.5 bun-common's `"self-hosted"` viewer [S]

`docsRouter`'s `"self-hosted"` viewer (`bun-common/lib/docs/router.ts:49-60`)
serves bun-api-docs-ui's bundle from the router's own origin.
`lib/docs/selfHosted.ts` names the package (`SELF_HOSTED_PACKAGE`, `:27`),
loads `@kingsleyweb/bun-api-docs-ui/lib/hosted` lazily with `createRequire`
and no static import (`:30`, `:133-142`), so nothing of it reaches bun-common's
declarations, and turns a missing package into a `ConfigError` naming the fix.
bun-api-docs-ui is an **optional peer** of bun-common and a devDependency
(`bun-common/package.json:150,159,201`); bun-common's consumer check declares
the `lib/docs/selfHosted` entry with `peers: ["@kingsleyweb/bun-api-docs-ui"]`
and packs that package alongside (`bun-common/consumer-check.json:463-466`).
publish.ts orders packages by dependencies and required peers only, which is
how the two name each other without a cycle (`scripts/publish.ts:26-28`).

### 2.6 npm [V]

Both packages exist on the registry only as `3.0.0-rc.0` (2026-11-04) and a
`0.0.0-stage`; `latest` and `next` both point at `3.0.0-rc.0`. Unpacked:
4,338,681 bytes (106 files) and 2,422,195 (97). Each was downloaded about
310–320 times in the week to 2026-11-07, the same as bun-jobs; npm counts
mirrors and CI, so how many real users that is is unknown [U].
`@kingsleyweb/bun-ui` is free.

---

## 3. The package

### 3.1 Entries [D]

| Entry | What | Peers it needs | Environment |
|---|---|---|---|
| `.` | the domain-free shared surface only: `UiTheme`, `UiUnauthorized`, `UiUnauthorizedStatus`, `UnauthorizedOptions`, `DEFAULT_RETURN_PARAM`, `DEFAULT_UNAUTHORIZED_STATUSES`, `ASSET_CACHE_CONTROL`. No UI (Q3) | none | browser-safe |
| `./jobs` | `jobsUi()`, `JobsUi*` types, `DEFAULT_BASE_PATH`, `DEFAULT_TITLE`; today's bun-jobs-ui root | `@kingsleyweb/bun-jobs` | Bun |
| `./jobs/browser` | today's `lib/shared`: `JobsUiConfig`, `JobsUiSections`, `JOBS_UI_CONFIG_ELEMENT_ID` (names: Q6), `UiTheme`, the `unauthorized` types | none | browser-safe |
| `./docs` | `docsUi()`, `DocsUi*` types and constants; today's bun-api-docs-ui root | none | Bun |
| `./docs/browser` | today's `lib/shared`: `DocsUiConfig`, `DOCS_UI_CONFIG_ELEMENT_ID`, `DEFAULT_EXTENSION_PREFIXES`, and the browser-safe `unauthorized` helpers | none | browser-safe |
| `./docs/hosted` | today's `lib/hosted`, for bun-common's `"self-hosted"` viewer: `resolveHostedAssets`, the shell and CSP builders | none | Bun |
| `./docs/embed`, `./docs/embed/{routing,router,context,permissions,client,errors,unauthorized}` | today's `./embed` family, TSX source for a host that bundles it | none (the host brings React) | bundler |
| `./security`, `./security/browser` | bun-security's UI (§7), when it is built | `@kingsleyweb/bun-security` | Bun / browser-safe |
| `./auth`, `./blog`, … | later UI recipes, each the same pair | its domain package, if any | |

Beside them, the recipe's keys: `./lib`, one explicit `./lib/<dir>` per
directory with an `index.ts` (`./lib/jobs`, `./lib/jobs/browser`,
`./lib/docs`, …), `./lib/*.ts`, `./lib/*.js`, `./lib/*`, `./package.json`
(CLAUDE.md, "Packaging types"). Every non-embed entry is
`{ "@kingsleyweb/source": lib, "types": dts, "default": lib }`. The kit is
reachable only through the deep `./lib/*` patterns, as bun-jobs-ui's
`assets.ts` is today (Q7).

### 3.2 Why `/<ui>/browser` holds what it holds

A browser bundle must be able to import it with no Bun, Node or server code in
its graph: it is what the UI's own app imports from `lib/`, and what a host
needs to read the injected config. It stays free of runtime imports except the
kit's browser-safe helpers, which is what CLAUDE.md's `lib/shared` rule says
today, and the consumer check marks each one `"browser": true`. The React app
itself is never an entry: it ships prebuilt in `dist/<ui>/`. The docs viewer's
screens are the one exception, as `/docs/embed`, because a host app renders
them in its own shell.

### 3.3 Source layout [D]

```
packages/bun-ui/
├── package.json  consumer-check.json  tsconfig.json  tsconfig.build.json
├── README.md                      the index: install, one quick start per UI
├── guides/jobs.md  guides/docs.md today's two READMEs, moved (Q9); jobs.md keeps
│                                  the parsed "What each element needs" table
├── lib/                           → dts/ (rootDir: lib), run by Bun as is
│   ├── index.ts                   the root entry (§3.1)
│   ├── kit/                       the shared server kit (§5), never a domain import
│   │   └── browser/               its browser-safe half (unauthorized URLs, UiTheme)
│   ├── jobs/   index.ts jobsUi.ts types.ts browser/
│   ├── docs/   index.ts docsUi.ts types.ts hosted.ts browser/
│   └── security/ …                later
├── app/                           the browser; one DOM project (app/tsconfig.json)
│   ├── kit/                       design system: tokens, base styles, components,
│   │                              the unauthorized hook, theme, toast, Pager
│   ├── jobs/   main.tsx …         today's bun-jobs-ui app
│   ├── docs/   main.tsx embed.ts … today's bun-api-docs-ui app
│   └── security/ …                later
├── scripts/  build.ts (every UI, or --ui <name>)  build-declarations.ts (the copy)
│             jobs/routes-openapi.ts
├── __tests__/
│   ├── harness/                   dom.ts, register-dom.ts, handleLedger.ts, assert.ts,
│   │                              domLeak.test.ts over all of __tests__/
│   ├── kit/                       the kit's server and app tests
│   ├── jobs/   server/ app/ app/pkg/ e2e/
│   ├── docs/   server/ app/
│   ├── packaging.test.ts  entryIsolation.test.ts  budget.test.ts
└── dist/  jobs/  docs/            gitignored, built on prepack; one manifest each
```

**Why layer-first and not one folder per UI** (`jobs/{lib,app,__tests__}`).
A folder per UI would keep every relative import unchanged by the move, which
is cheaper, but the recipe has one `lib/`, `rootDir: lib` and one `dts/`
(`tsconfig.build.json`; `build-declarations.ts:498-515` checks that every
`lib` module has a declaration and that `files` has `lib`) [S], and those two
files are one file across the eight packages (CLAUDE.md;
`bun-common/__tests__/buildDeclarations.test.ts:285-310`). Layer-first costs
a scripted rewrite of relative specifiers: 450 import lines in 181 files of
bun-jobs-ui and 76 lines in 36 files of bun-api-docs-ui cross a layer
(`app` ↔ `lib`, tests → `app`/`lib`) [S, counted with `grep`], plus a handful
of `import.meta.dir` paths (`lib/assets.ts:17-23`,
`__tests__/app/dom.ts:69`, `domLeak.test.ts:19-22`,
`cleanupPairs.test.ts:27`, `queryIsolation.test.ts:6`). A codemod that
resolves each relative specifier from the file's old path and rewrites it from
the new one does all of it; the files stay well above git's 50% rename
similarity.

### 3.4 One app per UI, a shared kit [D]

Each UI is its own React app with its own entry (`app/<ui>/main.tsx`), router,
providers and config element, built into its own bundle. They share
`app/kit/`: the design tokens and base styles, the 28 components already
duplicated byte for byte (§2.4), the `unauthorized` redirect hook, the theme
and toast providers, `Pager` and `pagerState` (which bun-security's UI reuses,
`../bun-security/ui.md` §1) [S].

**Not one app shell.** A single SPA with a section per UI would put every UI
in every host's page: the docs viewer, which runs on public listeners under a
self-only CSP, would carry the jobs and security screens and their API
clients; each UI's `connect-src` differs (`connectSources` against
`documentOriginSource`, §2.4); and the budgets, which guard what one page
load pays, would merge. A host that wants several UIs mounts several routers,
each at its own `basePath`. A combined "console" with one navigation over
several mounted UIs can come later, as a UI of its own (Q5).

**The jobs app's docs section imports `@kingsleyweb/bun-ui/docs/embed`**, its
own package by name (D11). In the workspace that resolves through
`node_modules/@kingsleyweb/bun-ui`, the package's own symlink, and in a
consumer through its own `exports` [I; BU-3 confirms it under `Bun.build`].
It keeps the jobs UI the in-repo consumer of the published embed surface.

### 3.5 `files` and the tarball

`files`: `dist`, `dts`, `lib`, `app/docs`, `app/kit` (the embed's source and
what it imports), `guides`, `LICENSE`, `README.md`. `app/jobs` is not
shipped, as bun-jobs-ui's `app/` is not today; `dev: true` therefore builds in
memory only in the repo, unchanged. §8 has the sizes.

### 3.6 Adding a UI later

A new UI (`/security`, `/auth`, `/blog`) is: `lib/<ui>/` with its server
function on the kit, `lib/<ui>/browser/`, `app/<ui>/` on `app/kit/`,
`__tests__/<ui>/`, a `dist/<ui>/` budget entry, a peer (optional, with
`peerDependenciesMeta`) when it needs a domain package, two `exports` keys
plus their `./lib/*` keys, consumer-check spellings with `peers`, a
`guides/<ui>.md`, and the entry-isolation test's allowed-imports row. No new
package, no copy of the recipe, no new workspace member.

---

## 4. Dependencies: optional peers scoped per entry

### 4.1 The manifest [D]

| Kind | What |
|---|---|
| `dependencies` | `@kingsleyweb/bun-common` (every server entry builds a `BunRouter`) |
| `peerDependencies`, all optional | `@kingsleyweb/bun-jobs` (for `/jobs`), later `@kingsleyweb/bun-security` (for `/security`), `@types/bun` (as every package) |
| `devDependencies` | bun-jobs, bun-client, bun-nest and the Nest packages (the Nest test), React, react-dom, TanStack Query, happy-dom, Testing Library, the `@types/*`, bun-types, TypeScript, through the catalog as today |

React and TanStack stay bundled, never peers (bun-jobs-ui and
bun-api-docs-ui both do this today) [S]. bun-api-docs-ui disappears as a
dependency: its code is inside.

### 4.2 How scoping is enforced today [S]

- **Types, at build time**: `checkPeerScopes` in the copied
  `scripts/build-declarations.ts:273-341` walks the declaration import graph
  from every literal `exports` key and every `consumer-check.json` spelling,
  and fails when a declaration importing an optional peer is reachable from a
  root whose spellings do not list that peer in `peers`. It is per root and
  per peer, so several scoped entries already work: a `/jobs` declaration
  reaching one that imports bun-security fails unless `/jobs` lists it.
- **Types and run time, against the packed tarball**:
  `scripts/consumer-check.ts` installs a `consumer/` with none of the
  package's optional peers and, when any entry has `peers`, a
  `consumer-peers/` with **all** of them (`:600-635`). Each spelling is
  type-checked in its consumer and imported under Bun. So `/docs` and the
  root, with no `peers`, are proved to need neither bun-jobs nor bun-security,
  at the type level and at run time.

### 4.3 What changes [D]

1. **One consumer per distinct peer set** (BU-1). Today `/jobs` would be
   checked in a consumer that also has bun-security, so a `/jobs` import of
   bun-security at run time would pass. The change keys consumers by the
   sorted `peers` list (`consumer/`, `consumer-peers-<hash>/`), installing
   only that set's peers. bun-nest benefits at once: its `./jobs` and
   `./cache` are checked together today. Cost: one more `bun install` per
   peer set, outside the repo.
2. **The kit takes an error factory** (D7). `resolveAssetSource`,
   `buildAssets` and the shell builders take a
   `fail: (message, context) => Error`, as `resolveUnauthorized` already does.
   `lib/jobs/` passes bun-jobs' `ConfigError`, `lib/docs/` bun-common's.
   Nothing in `lib/kit/` imports a domain package.
3. **An entry-isolation test in the package** (`__tests__/entryIsolation.test.ts`):
   for each server and browser entry, walk its static import graph from
   `lib/` with `Bun.Transpiler.scanImports` and assert the `@kingsleyweb/*`
   packages it reaches against a table (`/docs`, `/docs/hosted`, the root
   and every `/<ui>/browser`: bun-common at most; `/jobs`: bun-common and
   bun-jobs). A negative control plants a bun-jobs import in `lib/kit/` and
   expects the test to name `/docs`. It runs in seconds on every
   `bun run test`, where the consumer check runs per PR.
4. **Bundle safety per UI**: each `dist/<ui>` bundle is checked for server
   markers as today (`__tests__/app/pkg/bundle-safety.test.ts` in
   bun-jobs-ui, `__tests__/server/bundle-safety.test.ts` in
   bun-api-docs-ui) [S], and the docs bundle additionally for any jobs or
   security screen marker.
5. **consumer-check.json**: `/jobs` and its deep spellings list
   `peers: ["@kingsleyweb/bun-jobs"]`; `workspaceDependencies` are
   bun-contract, bun-common and bun-jobs (later bun-security).

### 4.4 Behaviour that changes for `/jobs`

bun-jobs goes from a required peer to an optional one, so installing bun-ui
without bun-jobs no longer warns; importing `/jobs` without it fails at load
with Bun's "Cannot find module", as bun-nest's `./jobs` does
(CLAUDE.md, "Packaging types", measured for bun-nest) [S]. Every `jobsUi()`
user already has bun-jobs: `api` mode passes a `JobsApi`, and both modes
import bun-jobs' `ConfigError`. The guide's install line says so.

---

## 5. The shared kit

Where each shared piece lives in bun-ui, and where it comes from [D]:

| Piece | Today [S] | In bun-ui | Notes |
|---|---|---|---|
| Shell rendering (`createShellRenderer`) | `bun-jobs-ui/lib/shell.ts`, `bun-api-docs-ui/lib/shell.ts` | `lib/kit/shell.ts` | generic over the config type and element id; each UI passes its own |
| CSP and nonce (`cspHeader`, `createNonce`) | both `shell.ts` (`:73`) | `lib/kit/shell.ts` | `style-src 'self'`, `script-src 'self' 'nonce-…'` unchanged |
| `connect-src` sources | `connectSources` (jobs), `documentOriginSource` (docs) | `lib/kit/connect.ts`, both | bun-security's UI needs the jobs form (an API and a socket) |
| SRI manifest, build, write, verify, load (`buildAssets`, `writeAssets`, `resolveAssetSource`) | both `assets.ts` | `lib/kit/assets.ts` | parameterised by UI name (`dist/<ui>/`, `app/<ui>/main.tsx`) and the error factory |
| Asset serving (`/assets/:file`, `ASSET_CACHE_CONTROL`) | `jobsUi.ts`, `docsUi.ts` | `lib/kit/serve.ts` | one handler; `ASSET_CACHE_CONTROL` exported from the root |
| In-memory dev build (no `dist/`, `dev: true`, `dev: false`) | both `assets.ts` (`resolveAssetSource`) | `lib/kit/assets.ts` | once per process **per UI**; the `info` line names the UI |
| `unauthorized`, server half (validate, navigation test, `303`) | `bun-api-docs-ui/lib/unauthorized.ts` | `lib/kit/unauthorized.ts` | already takes `fail` (`:24`, `:59`) |
| `unauthorized`, browser-safe half | `bun-api-docs-ui/lib/shared/unauthorized.ts` | `lib/kit/browser/unauthorized.ts`, re-exported by the root and each `/<ui>/browser` | |
| `unauthorized`, browser hook | `bun-api-docs-ui/app/unauthorized.ts` | `app/kit/unauthorized.ts`, re-exported as `/docs/embed/unauthorized` | |
| `ConfigError` handling | each UI throws its domain's; the kit throws bun-jobs' in jobs-ui | the factory (D7); the kit throws nothing of its own | no user-visible change |
| `basePath` and header-name validation | `jobsUi.ts:57-60`, `docsUi.ts` | `lib/kit/options.ts` | |
| Design system | 28 identical `app/` files | `app/kit/` | |
| DOM test harness | `__tests__/app/{dom,register-dom,assert,handleLedger}.ts` per package | `__tests__/harness/` | `setupDom({ preload })`: each UI passes its lazy-screen module, as the jobs `dom.ts` reads `app/screens/lazy.tsx` today |

**Built in BU-4, after the moves**, so each move PR stays mechanical; until
then `lib/jobs/` and `lib/docs/` keep their own copies, inside one package.
BU-4 changes no public name and no wire format, so it may follow rc.1 if
needed (§10).

### 5.1 What BU-4 built (2026-11-10)

As the table above, with these departures, each found while building it:

- **The server kit is `lib/kit/{serve,shell,connect,assets,options}.ts`.**
  `createUiRouter` (in `serve.ts`, not a `serve` handler alone) takes the
  whole router: the shell, `/assets/:file`, a UI's extra routes (the docs
  viewer's `/document.json`), its guards and `authorize`, and problems
  under the UI's own URN (`urn:bun-jobs:error:`, `urn:bun-api-docs-ui:error:`).
  `lib/<ui>/assets.ts` and `lib/<ui>/shell.ts` stay, as bindings of the kit
  that keep every name and signature they had: the deep `./lib/*` spellings
  reach them, and `./docs/hosted` re-exports from them.
- **Four of the "28 identical" app files were not equivalent modules**:
  `ErrorView`, `ProblemBanner` and (through it) `ConfirmDialog` import their
  UI's own `isApiError` (each UI has its own `ApiError` class), and
  `ScreenErrorBoundary` its UI's `resetScreenQueries` (the jobs UI keeps
  `/meta`, the viewer resets every inactive query). One shared copy would
  have changed which errors each recognises, so the kit's versions take the
  seam as a prop and each UI binds them in `app/<ui>/components/` (a few
  lines each). `Tabs` and `useUrlTab` import the router, which both UIs
  already shared, so the router moved to `app/kit/routing.ts` and
  `app/docs/routing.ts` (the `./docs/embed/routing` entry) re-exports it.
  `inputValues` read `MAX_DATE_MS` from its UI's contract; the kit holds the
  constant (the same value). The theme's helpers take the storage key.
- **`Pager`, `pagerState`, `useClientPage` and the toasts moved to the kit**
  as §3.3 has them; the jobs UI's other own components stay in
  `app/jobs/components/`.
- **`handleLedger.ts` stays with the jobs tests**: it is built on the jobs
  live client's fake socket. It moves to the harness when a second UI with a
  live client (bun-security's) needs it.
- **The kit's tests are server tests** (`__tests__/kit/server/`, a third UI
  driving the router, the options and the assets); the component tests stay
  in `__tests__/jobs/app/`, which already covered the shared components.

Bytes, measured on Bun 1.4.4-canary.1+11c367163 (in-memory build, minified,
the same as `scripts/build.ts` without `check`), before and after:

| | before | after |
|---|---:|---:|
| jobs entry | 337,896 B (109,052 gzipped) | 337,841 B (109,103) |
| jobs largest other chunk (the docs section) | 95,920 B (31,162) | 78,200 B (25,257) |
| jobs JavaScript, all files | 808,197 B (280,283) | 791,479 B (275,293) |
| jobs CSS | 150,477 B | identical (same hashes) |
| docs entry | 347,709 B (108,663) | 348,024 B (108,782) |
| docs CSS | 32,967 B | identical content |

The jobs bundle carried two copies of the shared components (its own and
the embedded docs screens'); it now carries one. The docs entry grows 315
bytes, the bindings above.

---

## 6. Migration

### 6.1 The moves and their history [D]

Each move is one PR with two commits, merged with a merge commit as the repo
does (`git log`: "Merge pull request #663") [S]:

1. **A pure-rename commit**: only `git mv`, no content change. It does not
   build on its own; the merge commit does.
2. **A fix-up commit**: the codemod (§3.3), the manifests, the references.

Measured on a throwaway repository with three real files [M,
`evidence/rename-rebase.out`]: a branch written before the move and rebased
over it keeps its edit to a moved file, applied at the new path with no
conflict; a new file it added in a moved directory stops the rebase once
with `CONFLICT (file location)`, already placed at the new path by git, and
`git add` resolves it; `git log --follow` shows a moved file's history through
the move. A new file's own relative imports still need the codemod's rule.
`git blame` follows a whole-file rename by default.

BU-2 moves bun-jobs-ui (it becomes the package: `packages/bun-jobs-ui` →
`packages/bun-ui`, `lib/*` → `lib/jobs/*`, `lib/shared` → `lib/jobs/browser`,
`app/*` → `app/jobs/*`, `__tests__/{server,app,e2e}` →
`__tests__/jobs/{…}`, `README.md` → `guides/jobs.md`). BU-3 moves
bun-api-docs-ui's files into it (`lib/*` → `lib/docs/*`, `lib/shared` →
`lib/docs/browser`, `app/*` → `app/docs/*`, …) and deletes the emptied
directory. The kit (BU-4) is made by `git mv` of one copy and deletion of the
other, so the kept copy carries the history.

### 6.2 bun-common's `docsRouter` (BU-3) [D]

| Where [S] | Change |
|---|---|
| `lib/docs/selfHosted.ts:27` `SELF_HOSTED_PACKAGE` | `"@kingsleyweb/bun-ui"` |
| `lib/docs/selfHosted.ts:30` `HOSTED_SUBPATH` | `` `${SELF_HOSTED_PACKAGE}/docs/hosted` `` |
| `lib/docs/router.ts:49`, `lib/docs/index.ts:14`, `selfHosted.ts:1-17` (JSDoc) | name bun-ui's `/docs` |
| `package.json:150,159,201` | optional peer and devDependency `@kingsleyweb/bun-ui` |
| `consumer-check.json:463-466` | `peers: ["@kingsleyweb/bun-ui"]`, `workspaceDependencies` `packages/bun-ui` |
| `__tests__/docs/selfHosted.test.ts` | the package name in its assertions; its missing-package test unchanged |

The `"self-hosted"` option value, `SelfHostedViewerOptions` and the served
pages do not change (Q4). The optional-peer pair bun-common ↔ bun-ui is the
one bun-common ↔ bun-api-docs-ui has today, so publish order is unaffected.
bun-common's consumer check then packs bun-ui, a bigger tarball whose own
optional peer bun-jobs is not installed in that consumer [I].

### 6.3 bun-nest [S]

bun-nest's `lib/` names neither package. What changes: its `README.md:254`
and `:443-452` (the jobs UI beside `BunJobsApiModule`), and
`examples/bun-nest/06-jobs-ui/mount.ts`. The Nest matrix runs bun-jobs-ui's
`__tests__/server/nest.nest.test.ts` (`scripts/nest-matrix.ts:73,105,1180-1182`):
the column becomes `packages/bun-ui`, `__tests__/jobs/server/nest.nest.test.ts`.

### 6.4 The playground, examples and templates [S]

| Where | Change |
|---|---|
| `playground/index.ts:50,392`, `playground/sign-in.ts:3,21`, `playground/package.json`, `playground/README.md` | the new spellings |
| `examples/bun-jobs-ui/**` (25 files name the package; `04-screens/permissions.ts` parses the README's table) | `git mv` to `examples/bun-ui/jobs/` with the project files at `examples/bun-ui/` (Q10); the parser reads `packages/bun-ui/guides/jobs.md` |
| `examples/bun-jobs-ui/06-browser/unauthorized-redirect.ts:44` | `docsUi` from `/docs` |
| `examples/bun-common/13-api-docs/sections.ts:5` | the JSDoc |
| `examples/README.md:12`, root `README.md:41-44,58,209` | the package tables and tree |
| `templates/` | names neither package |

### 6.5 Repository tooling [S]

| Where | Change | PR |
|---|---|---|
| root `package.json` `workspaces.packages` (`:24-25`) | `packages/bun-ui` replaces both | BU-2, BU-3 |
| `bun.lock` | re-resolved, in its own commit (the rule) | BU-2, BU-3 |
| `lerna.json` | none: `packages/*` | — |
| `workspaces.catalog` | none | — |
| `scripts/typecheck.ts:50-52,66` | `packages/bun-ui/tsconfig.json`, `app/tsconfig.json`, `__tests__/jobs/app/pkg/tsconfig.json` | BU-2, BU-3 |
| `scripts/publish.ts` | none: it discovers workspace members (`:14-21`); its header comment's example (`:28`) | BU-3 |
| `scripts/__tests__/publish.test.ts:68-105,401-405` | fixture names (a fixture, may stay) | BU-3 |
| `scripts/consumer-check.ts:43,368` | comments; the per-peer-set consumers (D6) | BU-1 |
| `scripts/reformat.ts:50-53` `COPIED_FILE_SETS` | `bun-jobs-ui` → `bun-ui` | BU-2 |
| `bun-common/__tests__/buildDeclarations.test.ts:285-293` `PUBLISHED` | `bun-ui` replaces both (eight copies become seven) | BU-2, BU-3 |
| `bunfig.toml:357` React override | `packages/bun-ui/**`, `examples/bun-ui/**`; the docs app then gets the React rules: **1 error and 2 warnings to fix** [M, `evidence/react-lint-docs.txt`] | BU-2, BU-3 |
| `tools/vscode-bun-lint/__tests__/{config,directories,format}.test.ts` | the probe paths (`packages/bun-jobs-ui/app/…`) | BU-2 |
| `scripts/nest-matrix.ts` | §6.3 | BU-2 |
| `.claude/skills/bun-node-check/SKILL.md:28` | the package list | BU-2 |
| heavy-run history | keyed by directory (CLAUDE.md), so bun-ui's runs start with no estimate and `auto` gives them a slot until ten runs are recorded | — |

### 6.6 Documentation

- **CLAUDE.md**: the package list (`:27-36`), the parallel-test figures and
  heavy-run lists naming bun-jobs-ui (`:164`, `:185`, `:232`, `:248-256`,
  `:266-271`, `:348`), the Nest matrix (`:583`), Typechecking (`:721`,
  `:762-785`), the long **"bun-jobs-ui (phase 3 UI)"** section (`:877-981`),
  which becomes **"bun-ui"** with the layout of §3.3, a subsection per UI
  and its DOM rules stated once for all UIs, and "Packaging types"
  (`:1013`, `:1072`).
- **docs/agentic-setup.md**: the ownership rows (`:404`, `:430`), the
  playground and parsed-README rules (`:493-508`), the gates (`:682-691`,
  `:729-734`).
- **docs/releasing.md** `:100`, `:154`; **CHANGELOG.md** "Unreleased": a
  breaking change with §1.2's table.
- **Plans**: historical text in other plans is left as written; the index
  entry for this plan is added; bun-security per §7.

### 6.7 npm: deprecate, not shim [D]

**Recommendation: deprecate both old packages** once rc.1 is on the registry:

```bash
npm deprecate @kingsleyweb/bun-jobs-ui "moved into @kingsleyweb/bun-ui: import from @kingsleyweb/bun-ui/jobs"
npm deprecate @kingsleyweb/bun-api-docs-ui "moved into @kingsleyweb/bun-ui: import from @kingsleyweb/bun-ui/docs"
```

The maintainer runs these (they need the npm login and a one-time code;
`publish.ts` never deprecates). Deprecation applies to every published
version, so an install of `3.0.0-rc.0` keeps working and prints the message.
Unpublishing is not available: both are past npm's 72-hour window [V].

**Against shims** (a `3.0.0-rc.1` of each old name re-exporting bun-ui for one
major): each is a workspace member with the whole recipe (`files`, `prepack`,
a ninth and tenth `build-declarations.ts` copy, a `consumer-check.json`,
a LICENSE), released and checked every time, to soften a move between two
release candidates of a version that was never stable. The rc is where a
breaking rename belongs, and the deprecation message names the new spelling.

---

## 7. Effect on the bun-security plan

The bun-security plan was approved on 2026-11-07 with a separate
`@kingsleyweb/bun-security-ui`. **These edits were applied to it on
2026-11-08, with this plan's approval** (the user's single-UI-package
decision), and a status line there says so; each is small, and none changes a
security decision. The diff below is kept as the record of what changed. Effort moves: bun-security's PR-U1 no longer builds a package
skeleton or a third copy of the server code, so it drops from ~5 d to ~4 d,
and the optional ~2 d shared-module PR (Q14) is this plan's BU-4.

### 7.1 Decisions and answers that change

| Where | Today | Becomes |
|---|---|---|
| README §1.2 **D1** | "**Two packages**: `@kingsleyweb/bun-security` (…) and `@kingsleyweb/bun-security-ui` (bun-jobs-ui's shape)" | "**The engine package and a UI entry**: `@kingsleyweb/bun-security` (…) and the management UI as `@kingsleyweb/bun-ui/security` (with `/security/browser`), bun-security an optional peer of that entry only ([`bun-ui`](../bun-ui/README.md))". The "Why" keeps: protected services never install the UI's bundle **through bun-security**; bun-security never depends on bun-ui |
| README §16 **Q1** | "a separate `@kingsleyweb/bun-security-ui`" | "the UI as bun-ui's `/security` entry (the user's decision of 2026-11-08, [`bun-ui`](../bun-ui/README.md))"; the answer stays **Yes** |
| README §16 **Q14** | "copy again, or extract a shared internal module first → **Extract** (optional PR, ~2 d) before PR-U1" | "**Done by bun-ui's kit** (BU-4), before PR-U1" |
| ui.md **§1** | "The package, and why it is separate": its own package, reasons 1–4 | "**The `/security` entry, and why it is not in bun-security**": the four reasons argue against a `./ui` subpath of bun-security and all still hold. Reason 1 changes: the engine's package never pulls the UI; a service that serves no UI installs no UI code; a service that installs bun-ui for `/docs` carries the security bundle as inert files that nothing mounts without `securityUi()` and the bun-security peer (§11 R2 here). Reason 3 (cadence) goes: every package releases together at one version anyway (CHANGELOG.md, line 3) |

### 7.2 Line edits

```diff
 README.md (bun-security), title paragraph, line 10-11
-systems; and a management UI with a live **analytics page**,
-**`@kingsleyweb/bun-security-ui`**. The user asked, on 2026-11-07:
+systems; and a management UI with a live **analytics page**, the
+**`/security`** entry of **`@kingsleyweb/bun-ui`** (the user's decision of
+2026-11-08, [`bun-ui`](../bun-ui/README.md)). The user asked, on 2026-11-07:

 README.md, Contents, line 80
-- [`ui.md`](ui.md) — `bun-security-ui`: screens, pagination, live updates,
+- [`ui.md`](ui.md) — bun-ui's `/security`: screens, pagination, live updates,

 README.md, §1.1, line 126
-analytics; a separate UI package talks only to the control plane.** The
+analytics; a UI (bun-ui's `/security` entry) talks only to the control plane.** The

 README.md, §1.2, D1: as §7.1 above

 README.md, §1.3, line 188 (Total row)
-| **Total** | **~121 d**, plus ~3.5 d optional (a shared UI-server module, the OTel bridge once OT lands) and ~11 d of later drivers | |
+| **Total** | **~120 d**, plus ~1.5 d optional (the OTel bridge once OT lands) and ~11 d of later drivers; the shared UI-server module is bun-ui's BU-4 | |
 (and the UI row: ~28 d → ~27 d)

 README.md, §1.4, the M3 bullet
-- **M3, the UI** (~28 d, overlapping M2): every screen of ui.md, the
+- **M3, the UI** (~27 d, overlapping M2): every screen of ui.md, the

 README.md, §3.2, line 343-348
-### 3.2 `@kingsleyweb/bun-security-ui` [D]
-
-bun-jobs-ui's shape; ui.md §1 argues the split. Dependencies:
-`@kingsleyweb/bun-common` (runtime, the served router),
-`@kingsleyweb/bun-security` (peer, for `api` mode, the bun-jobs-ui pattern),
-React, TanStack and bun-client bundled.
+### 3.2 `@kingsleyweb/bun-ui/security` [D]
+
+An entry of bun-ui ([`bun-ui`](../bun-ui/README.md) §3), built on its kit;
+ui.md §1 argues why it is not in bun-security. `/security` (server:
+`securityUi()`) and `/security/browser` (the browser-safe config and types).
+`@kingsleyweb/bun-security` is an **optional peer scoped to those two
+entries** (`consumer-check.json` `peers`, checked by `checkPeerScopes` and a
+consumer of its own); bun-common is bun-ui's runtime dependency; React,
+TanStack and bun-client bundled into `dist/security/`.

 README.md, §11.6, last bullet
-  packages.
+  bun-security and bun-ui's `/security` entry (`peers: ["@kingsleyweb/bun-security"]`).
 (the bullet today reads "The Nest matrix columns for `./security`; consumer-check for both packages.")

 README.md, §14, R9 mitigation
-| R9 | **The UI's size and test cost** (…) | certain / medium | reuse its components and harness; lazy screens; a budget test from the first build |
+| R9 | **The UI's size and test cost** (…) | certain / medium | bun-ui's kit and test harness; lazy screens; a `dist/security` budget from the first build |

 README.md, §15.4
-### 15.4 Group 3: the UI (`bun-security-ui`)
+### 15.4 Group 3: the UI (bun-ui's `/security`)
-| **PR-U1** package and shell | skeleton and recipe; `securityUi()` (shell, CSP, SRI, `dist/`); providers, nav, … | PR-CP2 | ~5 d |
+| **PR-U1** entry and shell | `lib/security/`, `app/security/`, the two `exports` keys and their consumer-check spellings; `securityUi()` on bun-ui's kit (shell, CSP, SRI, `dist/security/`); providers, nav, … | PR-CP2, bun-ui BU-4 | ~4 d |
-| | **Group 3 total** | | **~28 d** |
+| | **Group 3 total** | | **~27 d** |

 README.md, §15.5, optional row
-| *optional* | a shared internal module for the UI servers' shell, CSP and assets (Q14) ~2 d; the OTel bridge once OT lands ~1.5 d | ~3.5 d |
+| *optional* | the OTel bridge once OT lands | ~1.5 d |
 (Group 4 total: "~13 d (+3.5 d)" → "~13 d (+1.5 d)")

 README.md, §15.6, M3 row
-| **M3 the UI** | U1–U6, X2, the remaining examples | ~33 d | …
+| **M3 the UI** | U1–U6, X2, the remaining examples | ~32 d | …

 README.md, §17
-| `@kingsleyweb/bun-security`, `@kingsleyweb/bun-security-ui` | packages | new |
+| `@kingsleyweb/bun-security` | package | new |
+| `@kingsleyweb/bun-ui/security`, `@kingsleyweb/bun-ui/security/browser` | subpaths | bun-ui |
-| `securityUi` | function | bun-security-ui |
+| `securityUi` | function | bun-ui `/security` |

 ui.md, title and line 3
-# bun-security-ui: the management UI and the analytics page
+# bun-ui `/security`: the management UI and the analytics page
-Sub-plan of [`README.md`](README.md). It covers the UI package, its screens
+Sub-plan of [`README.md`](README.md). It covers the UI (bun-ui's `/security`
+entry, [`bun-ui`](../bun-ui/README.md)), its screens

 ui.md, §1: as §7.1 above; also
-- `lib/` — the server, Bun only: `securityUi({ api | apiUrl, basePath, …
+- `lib/security/` — the server, Bun only, on bun-ui's kit: `securityUi({ api | apiUrl, basePath, …
-- `app/` — React 19 and TanStack Query, bundled, not peers …, prebuilt into `dist/` …
+- `app/security/` — React 19 and TanStack Query on `app/kit/`, bundled, not peers …, prebuilt into `dist/security/` …
-- `lib/shared/` — the browser-safe config contract.
+- `lib/security/browser/` — the browser-safe config contract, published as `/security/browser`.
-The cost: two packages to version and a typed contract between them …
+The cost: a typed contract between bun-security and the entry (the
+management API's OpenAPI document, which bun-client turns into types) …
 "What it reuses" table: the bun-jobs-ui `lib/` row becomes "bun-ui's kit
 (`lib/kit/`): the shell, CSP, assets, `dist/` verification, `unauthorized`";
 the `app/` row's "copied, as bun-api-docs-ui did, until a UI kit exists
 (Q14)" becomes "from `app/kit/`"; the bun-api-docs-ui row becomes "bun-ui's
 `/docs/embed`".

 ui.md, §2
-README of the package gets the same parsed "What each element needs" table
+bun-ui's `guides/security.md` gets the same parsed "What each element needs" table

 ui.md, §9 Tests
+The harness is bun-ui's (`__tests__/harness/`): one `domLeak` guard over every
+UI's tests, `setupDom({ preload })` with the security UI's lazy screens.

 docs/plans/README.md, the bun-security index entry (line 224-226)
-  and `@kingsleyweb/bun-security-ui` (approved 2026-11-07, …
+  and its UI as bun-ui's `/security` (approved 2026-11-07; the UI's package
+  changed by the user on 2026-11-08, [`bun-ui/`](bun-ui/README.md)) …
 and the ui.md line (241)
-  - [`ui.md`](bun-security/ui.md) — the UI package, pagination, live
+  - [`ui.md`](bun-security/ui.md) — bun-ui's `/security`, pagination, live
```

**Unchanged**: every engine, control-plane, storage and topology decision
(D2–D25), every other answer in §16, PR-U2 to U6, the screens of ui.md §2–§8.
The reasons in ui.md §1 for keeping the UI out of bun-security stand.

---

## 8. Budgets and size

### 8.1 Today [M, `evidence/dist-sizes.md`]

| | JS + CSS | gzipped | source maps | published rc.0 unpacked | rc.0 tarball |
|---|---:|---:|---:|---:|---:|
| jobs (`dist/` of bun-jobs-ui) | 907.1 KiB | 288.8 KiB | 3.72 MiB | 4,338,681 B | 1,132,147 B |
| docs (`dist/` of bun-api-docs-ui) | 371.6 KiB | 112.4 KiB | 1.52 MiB | 2,422,195 B | 582,103 B |
| **one bun-ui** | **1,278.7 KiB** | **401.2 KiB** | **5.24 MiB** | **≈ 6.8 MB** | **≈ 1.7 MB** |

Source maps are 71% of the unpacked bytes (4.8 MB of 6.8 MB in the rc.0
tarballs). For scale, bun-jobs' rc.0 unpacks to 9.2 MB [V].

### 8.2 What changes [D]

- **Install size** is the sum, with two small savings: one `dts/`, `lib/`
  and README instead of two, and, after BU-4, one copy of the kit in `lib/`
  and `app/kit`. The bundles do not shrink: the docs screens stay in both
  the jobs bundle (its docs section) and the docs bundle, as today.
- **Run-time cost does not grow with the number of UIs**: a UI's `dist/<ui>`
  is read only when its server function is called (D4), and an entry
  imports only its own `lib/<ui>` and the kit (the entry-isolation test).
- **Per-UI budgets stay**, in one `__tests__/budget.test.ts` with one
  `BUNDLE_BUDGET` row per UI, each built exactly as `scripts/build.ts`
  builds it: jobs 348 / 112 KiB entry and 101 / 33 KiB per chunk; docs
  365 / 114 KiB entry and 120 / 40 KiB per split chunk (today's limits,
  unchanged by the move). A new UI adds a row from its first build.
- **Each UI's bundle grows with the UI, not with the package**; the
  package's install size grows with each UI. With a security UI of the jobs
  UI's size the tarball would be about 2.8 MB, 11 MB unpacked [I, by
  proportion]. §11 R3 says when to reconsider.
- **Source maps** stay in the tarball (Q8): dropping them halves the install
  but leaves operators reading minified stack traces from a production UI.

---

## 9. Testing

### 9.1 The rules carried over [D]

Every rule of CLAUDE.md's bun-jobs-ui section applies to every UI's tests,
stated once in the bun-ui section:

- `setupDom()` at the top of every DOM test file, from
  `__tests__/harness/dom.ts`; no static `react-dom`, `@testing-library/react`
  or `app/<ui>/boot`; `setupDom({ preload })` preloads the UI's lazy screens
  (today the jobs `dom.ts` reads `app/screens/lazy.tsx`; the docs viewer has
  no lazy screens);
- **one `domLeak.test.ts` over all of `__tests__/`**: the docs tests have
  never had one [S], and they now share a serial `--randomize` process with
  the jobs tests;
- `unmountLeaks.test.tsx` per live screen (jobs today; security later);
- a `__tests__/<ui>/app/tsconfig.json` per UI extending `app/tsconfig.json`
  (the nearest-config rule of `bun test --check`), and the DOM-free
  `__tests__/jobs/app/pkg/` project in `scripts/typecheck.ts`;
- bundle safety per UI with its negative control; the budget test (§8.2); the
  entry-isolation test (§4.3);
- e2e through `Bun.WebView`, per UI, skipping visibly without Chrome: the
  jobs UI's four files move as they are; the docs viewer gets one smoke e2e
  in BU-3 (load the viewer, open an operation, no CSP violation), since it is
  now served on public listeners by `docsRouter` and has none [S].

### 9.2 Size, parallelism and the wrapper

One suite: about 1,950 `it`/`test` call sites in 169 files (1,678 + 269 in
144 + 25) [S]. `bun run test` stays
`bun test --check --parallel --timings=bun-timings.json`, one worker per core;
the jobs `bun-timings.json` is rewritten to the new paths in BU-2, the docs
one merged into it in BU-3, and both
refreshed with `bun run test:timings` once the layout settles (an untimed file
runs first, so stale timings cost only scheduling). Every bun-ui test run is
**heavy** and goes through the wrapper, as every bun-jobs-ui test does today;
the gate adds `bun test --randomize` with two seeds over the whole suite.
Targeted runs of the docs tests alone (`bun test __tests__/docs`) are
DOM-light and could run directly; the rule stays as for bun-jobs-ui (heavy)
until a measurement says otherwise [I].

### 9.3 Each PR's gate

`bun scripts/typecheck.ts`; `bun run lint` and `bun run format:check` in
`packages/bun-ui`, `examples/bun-ui`, `playground` and any touched directory;
`bun run test` and two `--randomize` seeds in bun-ui (wrapped);
`bun scripts/consumer-check.ts packages/bun-ui` and, in BU-1 and BU-3, for
bun-nest and bun-common; `bun run-all.ts` in `examples/bun-ui` and
`examples/bun-nest` (and `examples/bun-common` in BU-3); bun-common's suite
and bun-jobs' `test:seeded` when bun-common changes (BU-3); the Nest matrix's
11.2.7 column when the Nest test moves (BU-2).

---

## 10. PRs, estimates and order

Focused days. Each PR passes the gate (§9.3) alone, sends the examples
session a change report before merging, and lists its new names (§13).

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **BU-1** consumer per peer set | `scripts/consumer-check.ts`: one consumer per distinct `peers` set, installing only those peers; tests in `scripts/__tests__/consumer-check.test.ts` with a negative control (an entry that needs a peer it does not list fails); bun-nest's check re-run (`./jobs` without bun-cache, `./cache` without bun-jobs). Touches no package | — | ~1 d |
| **BU-2** bun-ui from bun-jobs-ui | the pure move and the fix-up (§6.1); `./jobs`, `./jobs/browser`, the root (§3.1); bun-jobs an optional peer scoped to `/jobs`; `dist/jobs/`; `entryIsolation.test.ts`; still depends on bun-api-docs-ui; every reference in §6.3–§6.6 for the jobs side; `examples/bun-jobs-ui` → `examples/bun-ui/jobs`; CLAUDE.md's section renamed; CHANGELOG | BU-1 | ~3.5 d |
| **BU-3** bun-api-docs-ui into bun-ui | the pure move and the fix-up; `./docs`, `./docs/browser`, `./docs/hosted`, `./docs/embed*`; the jobs app's 11 imports to `@kingsleyweb/bun-ui/docs/embed*`; bun-common's viewer (§6.2); the React lint override over the docs app (fix 1 error, 2 warnings); `domLeak` over the docs tests; the docs smoke e2e; merged timings; the docs side of §6.4–§6.6; the bun-api-docs-ui member removed | BU-2 | ~3 d |
| **BU-5** the jobs-shaped names | Q6's renames in `/jobs/browser` and the app; CHANGELOG | BU-2 | ~0.5 d |
| **BU-4** the kit | §5: one `lib/kit/` (shell, CSP, connect sources, assets with the error factory, serving, options, `unauthorized`), `app/kit/` (the design system, the hook), `__tests__/harness/`; `scripts/build.ts` builds every UI; one budget test with a row per UI. No public name or wire change | BU-3 | ~3 d |
| **BU-6** npm | after rc.1 is published: the two `npm deprecate` commands (§6.7), run by the maintainer | rc.1 | ~0.1 d |

### 10.1 Order, and landing beside other work

**The build decision (the user, 2026-11-08): BU-1 starts now; BU-2, BU-3
and BU-5 start once the follow-up tracks now landing on develop (bun-common,
bun-client, bun-cache and bun-jobs follow-ups) have landed; BU-4 may follow
rc.1.** Starting the moves after those tracks means they rebase over little
or nothing.

**BU-1 → BU-2 → BU-3 → BU-5, then rc.1; BU-4 before rc.1 if time allows,
otherwise in the next candidate** (it is internal). BU-1 can start now and
land any time.

Other work landing on develop now (bun-common, bun-client, bun-cache and
bun-jobs follow-ups) does not touch either UI package, except:

- **bun-jobs `api/contract` changes**, which update bun-jobs-ui's fixtures
  and `app/api/routes.gen.ts` (`check:client`). A branch with such a change,
  rebased over BU-2, carries its edits to the moved files [M]; a new file in
  `app/` or `__tests__/` needs `git add` and its imports fixed by hand.
  Typed-client pilot steps after P1b, if any touch `app/api/`, are in the
  same position.
- **bun-common's `lib/docs/selfHosted.ts`**, which BU-3 edits in a few lines.
- **The shared files**: root `package.json` `workspaces`, `bun.lock`,
  `scripts/typecheck.ts`, `bunfig.toml`, CLAUDE.md. A conflict in
  `bun.lock` is resolved by re-running `bun install` on the rebased tree,
  never by hand.

To keep the moves cheap: **land BU-2 and BU-3 each in a short window**, with
no other open PR touching `packages/bun-jobs-ui` or `packages/bun-api-docs-ui`
merged during it; announce the window to the other sessions; write the
codemod as a script kept in BU-2's progress notes, so it can re-run on a
rebased tree instead of being repaired by hand; keep the pure-move commit
free of edits; and **rebase BU-2 right before merging** (its fix-up is the
script re-run). BU-4 is the one PR that edits many moved files' contents, so
it waits for BU-3.

---

## 11. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | **The moves collide with UI work in flight** (bun-jobs contract follow-ups, typed-client pilot steps) | medium / medium | pure-rename commits (edits follow, [M]); short merge windows; the codemod as a re-runnable script; BU-4 after the moves |
| R2 | **The security UI's code is installed wherever bun-ui is**, including public services that only mount `/docs` | certain / low | the files are static and inert: nothing is served without `securityUi()` and its bun-security peer; the engine (bun-security) never depends on bun-ui, so a protected service that serves no UI has no UI code; stated in bun-security's ui.md §1 (§7) |
| R3 | **Install size grows with every UI** (≈1.7 MB tarball with two, ≈2.8 MB with a security UI [I]) | certain / low | per-UI budgets; maps a separate decision (Q8); a UI that outgrows the package (a blog with a large editor) can become its own package later, behind the same subpath convention (`bun-ui-<ui>`) |
| R4 | **A kit module imports a domain package** and `/docs` starts needing bun-jobs (bun-jobs-ui's `assets.ts:14` does today) [S] | medium / high | the error factory (D7); `checkPeerScopes` at build; per-peer-set consumers (D6); `entryIsolation.test.ts` on every test run, with a negative control |
| R5 | **DOM leaks across UIs** in one serial `--randomize` process | medium / medium | one harness, one `domLeak` guard over all tests, two seeds in each gate |
| R6 | **rc.0 users' imports break** | certain / low | a prerelease; the npm deprecation names the new spelling; CHANGELOG's table (§1.2) |
| R7 | **The React rules flag the docs app** | certain / low | measured: 1 error, 2 warnings [M]; fixed in BU-3 |
| R8 | **Self-reference to `@kingsleyweb/bun-ui/docs/embed`** from inside the package does not resolve under `Bun.build` or `bun test` | low / low | it resolves through the workspace symlink like any package [I]; BU-3 checks it first, and falls back to relative imports if it does not |
| R9 | **The suite's history and timings reset**: the heavy-run wrapper has no estimate for `packages/bun-ui`, and `bun-timings.json` moves | certain / low | `auto` gives an unknown job a slot; `bun run test:timings` after BU-3 |
| R10 | **rc.1 waits on the moves** | low / medium | BU-1, BU-2, BU-3, BU-5 are ~8 d of mostly mechanical work; BU-4 may follow rc.1 |

---

## 12. Open questions

Each with a recommendation; asked once, answered in this plan.

**Answered 2026-11-08: the user approved every recommendation below as
written.** The Recommendation column is therefore the decision.

| # | Question | Recommendation |
|---|---|---|
| Q1 | **Package name**: `@kingsleyweb/bun-ui`, or another (`bun-console`, `bun-admin-ui`) | **`@kingsleyweb/bun-ui`**, the user's own name, free on npm [V] |
| Q2 | **The old names on npm**: deprecate, or publish thin re-export shims for one major | **Deprecate** (§6.7): both are rc-only; a shim is two more members with the whole recipe |
| Q3 | **What the root `.` exports**: nothing, the domain-free shared surface (§3.1), or every UI | **The domain-free shared surface** (`UiTheme`, the `unauthorized` types and defaults, `ASSET_CACHE_CONTROL`), browser-safe and peer-free; never a UI, so `import "@kingsleyweb/bun-ui"` can never pull a domain |
| Q4 | **`docsRouter`'s viewer name**: keep `"self-hosted"`, or rename (`"bun-ui"`) | **Keep `"self-hosted"`**: it says where the viewer is served from; only the peer it loads and the message change |
| Q5 | **One React app shell for every UI, or one app per UI over a shared kit** | **One app per UI over a shared kit** (§3.4); a combined console later, as a UI of its own, if wanted |
| Q6 | **The jobs UI's generic names** (`UiConfig`, `UiSections`, `UI_CONFIG_ELEMENT_ID`), which read as package-wide in bun-ui | **Rename** to `JobsUiConfig`, `JobsUiSections`, `JOBS_UI_CONFIG_ELEMENT_ID` in BU-5, before rc.1, without aliases; **keep `UiTheme`** as the one shared theme type (the root and every `/<ui>/browser`), with `DocsUiTheme` an alias of it (the same union today) |
| Q7 | **Export the kit** (`./kit`) for third-party UI recipes | **Not yet**: internal, reachable only through the deep `./lib/*` patterns; export it when a UI outside the repo asks |
| Q8 | **Source maps in the tarball** (71% of the bytes) | **Keep them** for rc.1: they are what makes a production stack trace readable; revisit if the tarball passes ~5 MB |
| Q9 | **The README**: one long README, or an index plus a guide per UI | **An index `README.md` plus `guides/<ui>.md`**; the jobs guide keeps the parsed "What each element needs" table, and its parser moves with it |
| Q10 | **The examples**: `examples/bun-ui/` with a folder per UI (`jobs/`, later `docs/`, `security/`), or keep `examples/bun-jobs-ui` | **`examples/bun-ui/`, one project, a folder per UI**, mirroring the package; the examples session owns the move inside BU-2 |
| Q11 | **`/jobs`'s peer**: bun-jobs optional and scoped (§4.4), or required as today | **Optional and scoped**: required would make every `/docs` user install bun-jobs; every `/jobs` user has it already |
| Q12 | **Ownership**: bun-ui as one package owned by the UI role (today bun-jobs-ui's), with the docs viewer's former owner reviewing `/docs` | **Yes**; agentic-setup's rows updated in BU-2 |

---

## 13. Names needing approval

| Name | Kind | Where |
|---|---|---|
| `@kingsleyweb/bun-ui` | package | new (Q1) |
| `./jobs`, `./jobs/browser`, `./docs`, `./docs/browser`, `./docs/hosted`, `./docs/embed` and `./docs/embed/{routing,router,context,permissions,client,errors,unauthorized}` | subpaths | bun-ui |
| `./security`, `./security/browser` | subpaths | bun-ui, with bun-security (§7) |
| `JobsUiConfig`, `JobsUiSections`, `JOBS_UI_CONFIG_ELEMENT_ID` | renames of `UiConfig`, `UiSections`, `UI_CONFIG_ELEMENT_ID` | `/jobs/browser` (Q6) |
| `UiTheme` at the root; `DocsUiTheme` as its alias | types | root, `/docs/browser` (Q6) |
| `guides/<ui>.md` | file layout | bun-ui (Q9) |
| `examples/bun-ui/` | directory | examples (Q10) |

Every existing exported name of the two packages (`jobsUi`, `docsUi`, the
`JobsUi*` and `DocsUi*` types, the constants) keeps its name; only its
import specifier changes.

---

## 14. What this plan could not verify

- **The consumer check on a packed bun-ui**: there is no package to pack yet.
  §4.2's account of what it proves is read from `scripts/consumer-check.ts`
  [S], not run.
- **Self-reference** from the jobs app to `@kingsleyweb/bun-ui/docs/embed`
  under `Bun.build` and `bun test` [I] (R8).
- **The suite's behaviour in one process**: whether the docs and jobs DOM
  tests leak into each other under `--randomize` is unknown until BU-3 runs
  the seeds [U].
- **Who installs the rc.0 UI packages**: npm's download counts (≈310–320 a
  week each) do not separate users from mirrors and CI [U].
- **The size of a future security UI** is a proportion, not a build (§8.2)
  [I].
- **Unpublishing** is ruled out by npm's 72-hour policy as documented [V],
  not by trying it.
