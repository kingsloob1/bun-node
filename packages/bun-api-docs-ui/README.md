# @kingsleyweb/bun-api-docs-ui

A self-hosted viewer for one **OpenAPI 3.1** or **AsyncAPI 3.0** document,
served by a `docsUi()` handler you mount beside your API. The viewer is a
bundled React app the package builds itself (React 19 and TanStack Query are
bundled into it — the host installs neither), served with hash-named immutable
assets, computed Subresource Integrity and a strict self-only
Content-Security-Policy (`default-src 'self'; script-src 'self' 'nonce-…';
style-src 'self'`). Nothing comes from a CDN, so it works offline.

Requires Bun ≥ 1.4.2.

## Usage

```ts
import { BunRouter } from "@kingsleyweb/bun-common";
import { docsUi } from "@kingsleyweb/bun-api-docs-ui";

const app = new BunRouter();

// Point at a document your API already serves…
const ui = docsUi({ document: "/jobs-api/openapi.json", basePath: "/docs" });

// …or hand it a thunk, and the router serves the document itself
// at <basePath>/document.json:
const ui = docsUi({
  document: () => buildAsyncApiDocument(),
  title: "Events API",
});

app.use(ui.basePath, ui.router);
```

Which reference the viewer shows is read from the document itself: an
`openapi` field gets the HTTP reference (operations by tag — and, when the
document declares `x-tagGroups`, the tags nested under those sections, with
any tag no section names in a trailing `Other` one; schemas as
expandable trees, a try-it panel per operation), an `asyncapi` field gets the
WebSocket reference (channels, operations, messages, limits, close codes).

The whole page is client-routed under `basePath`, so every URL under it
(`<basePath>/http/<operationId>`, `<basePath>/ws/<item>`) is a deep link the
router answers with the shell.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `document` | — (required) | Same-origin path or `http(s)` URL the viewer fetches, or a `() => document` thunk the router serves at `<basePath>/document.json`. |
| `basePath` | `"/docs"` | Mount path. Not `"/"`, no trailing slash, simple segments only. |
| `title` | `"API docs"` | Page title. |
| `theme` | `"system"` | Initial colour scheme: `"system"`, `"light"` or `"dark"`. |
| `extensions` | `["x-bun-common", "x-bun-jobs"]` | Specification-extension prefixes the viewers read, first hit winning: a `<prefix>-<name>` extension is read from the first prefix carrying it; anything under another prefix is ignored. |
| `csrfHeader` | none | Header the try-it panel adds on every mutation, or `false`. |
| `authorize` | none | Guards the shell, the bundle and a thunk's document (not the documented API itself). |
| `middleware` | none | Runs before every route. |
| `dev` | auto | `true` always builds the bundle in memory; `false` requires the prebuilt `dist/` (a `ConfigError` names the fix without it). |
| `logger` | console | Anything `resolveLogger` accepts. |

## The bundle

`prepack` builds `app/main.tsx` into `dist/` (`bun scripts/build.ts`): hashed
file names, a `manifest.json` with every file's SRI digest, type-checked
first. Without a `dist/` (a source checkout), the first request builds the
same bundle in memory, once per process, and logs one line saying so.

The WebSocket reference's "try it" links and permission markers of
`@kingsleyweb/bun-jobs-ui`'s Events console are jobs-specific and are not part
of this standalone viewer.

## Embedding the screens (`./embed`)

`docsUi()` needs nothing beyond this package: React and TanStack Query are
bundled into `dist/`. The `./embed` entries are different. They export the
viewer's screens as source, from `app/`, for a React app that renders them
inside its own UI (`@kingsleyweb/bun-jobs-ui` does), and that app's bundler
builds them with its own copies of React and TanStack Query. This package
does not declare them, so install them yourself:

```bash
bun add react@^19.2.0 @tanstack/react-query@^5.90.0
bun add -d @types/react@^19.2.0   # for TypeScript
```

| Entry | Imports |
|---|---|
| `./embed`, `./embed/router` | `react`, `@tanstack/react-query` |
| `./embed/routing`, `./embed/context` | `react` |
| `./embed/permissions`, `./embed/client`, `./embed/errors` | nothing outside this package |

The screens also import their `.css` files, which your bundler has to
handle (`Bun.build` does).

Because the entries are source, your TypeScript checks them with your
`tsconfig.json`, which needs two things (`skipLibCheck` does not cover `.ts`
files):

- `"allowImportingTsExtensions": true` (two modules import a `.ts` path;
  `bun init`'s config already sets it), and
- a declaration for the stylesheets, in any `.d.ts` your project includes,
  since TypeScript 6 checks side-effect imports:

  ```ts
  declare module "*.css";
  ```

## Development

```bash
bun run check && bun run lint && bun run format:check && bun run test
bun scripts/build.ts        # app/main.tsx → dist/
```

The golden AsyncAPI fixtures under `__tests__/app/docs/ws/fixtures/` are what
a real `@kingsleyweb/bun-jobs` API serves (a dev-only dependency, used by the
fixture test); `UPDATE_WS_FIXTURES=1 bun test __tests__/server/docs-ws.integration.test.ts`
rewrites them.
