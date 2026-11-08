# @kingsleyweb/bun-ui

Every bun-node browser UI in one package, each behind its own subpath. A UI is
a React app prebuilt into `dist/<ui>/` and served by a bun-common router you
mount on any bun-common `BunHttpAdapter`, `BunRouter` or bun-nest's
`BunHttpAdapter`: hash-named immutable assets, computed Subresource Integrity
and a strict Content-Security-Policy. React and TanStack Query are bundled, so
the host installs neither and has no build step.

| Subpath | What | Needs |
|---|---|---|
| `@kingsleyweb/bun-ui/jobs` | `jobsUi()`: the management UI for the `@kingsleyweb/bun-jobs` management API. [Guide](guides/jobs.md) | `@kingsleyweb/bun-jobs` |
| `@kingsleyweb/bun-ui/jobs/browser` | the jobs UI's browser-safe config contract (`UiConfig`, `UI_CONFIG_ELEMENT_ID`, …) | nothing |
| `@kingsleyweb/bun-ui` | what every UI shares, browser-safe: `UiTheme`, the `unauthorized` option's types and defaults, `ASSET_CACHE_CONTROL` | nothing |

Each UI's domain package is an **optional** peer that only its own subpath
needs: install `@kingsleyweb/bun-jobs` to use `/jobs`. An app that mounts one
UI never loads another's code or bundle.

## Install

```bash
bun add @kingsleyweb/bun-ui @kingsleyweb/bun-jobs   # for /jobs
```

Requires Bun >= 1.4.2. Bun runs the shipped TypeScript source in `lib/`; your
type checker reads the built declarations in `dts/`, which describe `lib/`
only, so no React or TanStack type reaches your project.

## Quick start: the jobs UI

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { createJobsApi } from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-ui/jobs";

const api = createJobsApi({ jobs, basePath: "/admin/jobs-api", authorize });
const ui = jobsUi({ api, basePath: "/admin/jobs" });

const app = new BunHttpAdapter();
app.use(api.basePath, api.router);
app.use(ui.basePath, ui.router);
await app.listen(3000);
```

[guides/jobs.md](guides/jobs.md) has every option, the screens, the
permissions each element needs and the security notes.

## Layout

The package is layered: `lib/<ui>/` is a UI's server (and `lib/<ui>/browser/`
its browser-safe half), `app/<ui>/` its React app, `__tests__/<ui>/` its tests
and `dist/<ui>/` its prebuilt bundle. `lib/kit/` holds what the UIs share; it
never imports a domain package.

## Building

`bun scripts/build.ts` writes each UI's bundle into `dist/<ui>/` and
`bun run build:types` the declarations into `dts/`; `prepack` runs both, so a
pack publishes both. Both directories are gitignored. In the repo, a UI with
no `dist/<ui>/` builds in memory on its first request.
