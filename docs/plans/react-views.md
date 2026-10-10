# React views: rendering React components to HTML on the fly

Implementation plan for a **view engine that renders React components to
HTML per request**, for `@kingsleyweb/bun-common` (`res.render`, `BunRouter`,
`BunHttpAdapter`), and for its **adoption in `@kingsleyweb/bun-nest`**
(`@Render`, `setViewEngine`, `setBaseViewsDir`). The user asked for it in
these words:

> "I also want a plan on how to have a view engine that renders react to html
> on the fly. The plan should include how it can be adopted in bun-nest as
> well."

Written 2026-10-10 against `develop` at `bbe11201`. **No product code was
changed.** Every `file:line` is at `bbe11201` unless it says otherwise. The
evidence is in [`evidence/react-views/`](evidence/react-views/README.md), and
each measurement there can be re-run with one command.

**A change in flight that this plan builds on:** the features agent's
Express-compatibility work for bun-nest (branch `fix/bun-nest-express-compat`,
worktree `bun-node-nestcompat-e6-1010`, progress file
`~/.cache/bun-node-e6/nestcompat/progress.md`). The coordinator approved
moving `@Render` to Express's view-engine semantics: `setViewEngine`,
`setBaseViewsDir`, `res.render(view, locals)`, and Express's error when no
engine is set. **At the time of writing it has a differential harness and no
fix yet**, so the engine contract this plan targets is the one its harness
asserts (`packages/bun-nest/__tests__/expressCompat/app.ts:610-640` in that
worktree), which is Express's own. §2.4 lists exactly what this plan assumes
of it, and §17 marks each PR that depends on it.

### Status (2026-10-10)

| PR | Scope | State |
|---|---|---|
| PR-C (compat agent) | bun-common's view system on Express's contract; bun-nest `@Render` | in flight, not merged |
| PR-0 | bun-common: the `compression()` stall on streamed bodies (§8.3) | not started; **found by this plan** |
| PR-1 to PR-7 | this plan | not started |

### Contents

1. [Executive summary](#1-executive-summary)
2. [What exists today](#2-what-exists-today)
3. [The rendering core](#3-the-rendering-core)
4. [Loading views on the fly](#4-loading-views-on-the-fly)
5. [Data and props](#5-data-and-props)
6. [Layouts and the document shell](#6-layouts-and-the-document-shell)
7. [Client hydration (optional)](#7-client-hydration-optional)
8. [Streaming through the adapters](#8-streaming-through-the-adapters)
9. [Errors and security](#9-errors-and-security)
10. [Performance](#10-performance)
11. [Packaging](#11-packaging)
12. [bun-nest adoption](#12-bun-nest-adoption)
13. [Tests and examples](#13-tests-and-examples)
14. [Measured evidence](#14-measured-evidence)
15. [Risks](#15-risks)
16. [Open questions for the user](#16-open-questions-for-the-user)
17. [PR slicing and effort](#17-pr-slicing-and-effort)
18. [Names needing approval](#18-names-needing-approval)

### How to read the markings

| Mark | Meaning |
|---|---|
| **[S]** | Read in this repo's source at `bbe11201`, or in a pinned dependency's source in `node_modules`. The `file:line` is given |
| **[M]** | Measured here by a spike that can be re-run. The evidence file is named |
| **[D]** | A design decision this plan proposes |
| **[I]** | Inference. A claim to test, never a finding |
| **[U]** | Unverified, from documentation or memory. Nothing may rest on it |
| **[C]** | Depends on the compat agent's engine contract (§2.4) |

---

## 1. Executive summary

### 1.1 The one-paragraph answer

**A new package, `@kingsleyweb/bun-react-views`, exports `reactViews()`: an
ordinary Express view engine, `fn(path, options, callback)`.** It plugs into
the view system the compat agent is adding to bun-common, registered the way
any engine is (`adapter.engine("tsx", reactViews())`,
`app.setViewEngine("tsx")`, `app.setBaseViewsDir("views")`), and it works
unchanged on real Express running on Bun [M, §14.6]. The engine imports the
view file by path with Bun's native TSX loader (no build step, ~60 ms the
first time a view is used, then a registry hit), renders its default export
with the merged locals as props, and calls back with a whole HTML document.
**Its default mode is "buffered"**: `renderToReadableStream` and `allReady`,
then one string. Unlike `renderToString`, every React 19 server feature works
that way (Suspense data, `use()`, async components), and the status can still
become a 500 when the render fails. Two other modes are per view or per
engine: `"string"` (`renderToString`, the fastest for views that never
suspend) and `"stream"`. Streaming cannot travel through Express's string
callback, so the engine also carries an **optional stream capability** that
bun-common's `res.render` uses when there is no callback. A small hook in
the compat agent's `res.render` is the only bun-common surface this plan adds.
**Hydration is optional, per view:** a client entry per view, bundled in memory
by `Bun.build` once per process (or prebuilt), served by bun-common with
content-hashed names, SRI and a per-request CSP nonce, all borrowed from
`jobsUi()`. Props travel as XSS-safe JSON. Islands are a later, smaller step.
React Server Components and server actions are out of scope on Bun today.
**In bun-nest**, `@Render("Page")` works once the compat PR lands; this plan
adds a subpath, `@kingsleyweb/bun-nest/react`, with `ReactViewsModule` and an
optional `@RenderComponent(Page)` decorator whose handler's return type is
checked against the component's props [M, §14.8].

**This plan also found a bug in bun-common that it must fix first:**
`compression()` stalls any streamed body whose chunks are too small for zlib
to emit output. The client receives only gzip's 10-byte header (brotli's
nothing) and waits forever [M, §8.3]. React's streamed Suspense page hits it
every time.

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| D1 | **The engine is Express's contract, `fn(path, options, callback)`, and nothing more for the string path.** [C] | It is what the compat agent is building `res.render`, `@Render` and `setViewEngine` on. The same function then also works on real Express (on Bun) [M, §14.6], and in any Express-compatible host. §3.5 |
| D2 | **Default mode "buffered": `renderToReadableStream` + `allReady`, collected to a string.** `"string"` and `"stream"` are opt-in, per engine or per view. | `renderToString` sends Suspense fallbacks and drops async component data [M, §14.2]. Buffered supports every React 19 server feature and still lets an error become a 500 before anything is sent. It costs about 1.9 ms more per render on the mid-size page (3.7 ms against 1.8 ms at the median, twice the CPU) [M, §14.1]. §3.2 |
| D3 | **Streaming is an optional capability on the engine function**, used by `res.render` only when no callback is passed and the view's mode is `"stream"`. [C] | Express's callback takes a string, so streaming cannot go through it. A capability keeps the contract intact: an engine without one (EJS, Pug) behaves exactly as Express. §8.1 |
| D4 | **Views are imported by path with Bun's native TSX loader.** In development a watcher drops the changed files' modules from `require.cache` (whole graph, no leak); production caches them. No build step is required. | Query-string busting reloads only the entry module, so a layout stays stale, and it leaks memory: ~10 MB per 300 reloads [M, §14.5]. Deleting the `require.cache` entries reloads the graph with no measurable growth [M]. §4 |
| D5 | **A whole document, always rendered by React**: an engine-level `document` component (a default is provided) wraps the layouts and the view. React 19 hoists `<title>`, `<meta>` and stylesheet `<link>`s into `<head>` from anywhere in the tree [M, §14.2]. | Hoisting needs `<html>` in React's tree; in a fragment, React emits them at the top of the fragment instead [M]. No Helmet-style dependency. §6 |
| D6 | **Props = `{ ...app.locals, ...res.locals, ...locals }` minus Express's `settings`, `_locals` and `cache`**, Express's merge order. [C] | It is what the engine receives [M, §14.6]. Those three keys are Express plumbing, not props. §5.1 |
| D7 | **Hydration is opt-in per view** (`export const hydrate = true`), whole-document `hydrateRoot(document, …)`, with a client entry per view generated and bundled by `Bun.build`. Islands come later (PR-5). | Most server-rendered pages need no client JS. A per-view entry keeps each page's bundle to what it uses. §7 |
| D8 | **Reuse `jobsUi()`'s machinery**: hashed assets with SRI and `immutable` caching, a per-request nonce, `jsonForScript` for props, the in-memory build once per process with a `dist/` manifest for production, and a bundle budget test. | It is shipped and tested (`packages/bun-jobs-ui/lib/assets.ts:151`, `lib/shell.ts:16-46`, `lib/jobsUi.ts:552-620`). §7.3 |
| D9 | **The engine refuses a resolved path outside the views roots.** | Express itself renders `../Secret` and absolute view names [M, §14.6]. A view module is code, so a traversal there runs it, not just reads it. §9.3 |
| D10 | **A new package, `@kingsleyweb/bun-react-views`**, with `react` and `react-dom` as **peers** (required by it, absent from bun-common). bun-common gains no React code. | bun-common's consumers mostly never render React. A client bundler, a hydration runtime and a Chrome e2e suite do not belong in an HTTP layer. §11 |
| D11 | **bun-nest's React pieces live in a subpath, `@kingsleyweb/bun-nest/react`**, with bun-react-views as an optional peer, as `./jobs` does with bun-jobs. | The precedent already passes the consumer check's `peers` rule (CLAUDE.md, "Packaging types"). §12 |
| D12 | **`@RenderComponent(Component)` stores the component itself under Nest's `RENDER_METADATA`.** | Nest passes that metadata to `applicationRef.render(response, template, result)` after checking only that it is truthy [S, `@nestjs/core/router/router-execution-context.js:92,159-162`]. A component reference reaches the adapter unchanged, and the decorator types the handler [M, §14.8]. §12.3 |
| D13 | **The engine passes its own `onError` to React and logs through the router's logger.** | Without it, React prints every render error's stack with `console.error` [M, §14.3]. CLAUDE.md's logging rule: `logger.error("message", { error })`. §9.1 |
| D14 | **In stream mode, the engine flushes after every React chunk.** | Under `compression()`, the first byte of a Suspense page then arrives in ~7 ms instead of the ~54 ms of the buffered page, for 16% more bytes on the wire [M, §14.3]. It also sidesteps the stall until PR-0 lands. §8.3 |

### 1.3 What it costs

| Part | Effort | Owner | Depends on |
|---|---|---|---|
| PR-0: the `compression()` stall | ~1 d | bun-common agent | — |
| PR-1: bun-common hooks (the stream capability in `res.render`, shared escape helpers) | ~1.5 d | bun-common agent | PR-C |
| PR-2: the engine (load, render, modes, documents, layouts, errors) | ~4.5 d | features agent | PR-C |
| PR-3: development reload | ~1.5 d | features agent | PR-2 |
| PR-4: hydration (client entries, assets, CSP, props) | ~4.5 d | features agent | PR-2, PR-1 |
| PR-5: islands | ~2.5 d | features agent | PR-4 |
| PR-6: bun-nest `./react` | ~2.5 d | bun-nest agent (or features) | PR-2, PR-C |
| PR-7: benchmark and regression guard | ~1.5 d | features agent | PR-2 |
| **Total** | **~19.5 d** | | |
| Examples (per PR, the examples agent) | ~3 d | examples agent | each PR |

§17 has the order and what each PR proves.

---

## 2. What exists today

### 2.1 bun-common: locals and a `render` that sends a file

- `BunResponse.locals` exists: a null-prototype object created on first read,
  assignable, as Express's [S, `packages/bun-common/lib/BunResponse.ts:1381`].
- There is **no** `res.render`, no `app.locals`, no `engine()`, no `views` or
  `view engine` setting anywhere in bun-common [S, a search of `lib/` for
  `locals`, `settings`, `engine(`, `render(`].
- The adapter's `render(response, view, options)` sends the file at `view` as
  is: `Bun.file(view)`, its type and `options.status || 200`
  [S, `packages/bun-common/lib/BunHttpAdapter.ts:1342-1346`].
- `send(body)` streams a `ReadableStream`, a Node `Readable` or an async
  iterable [S, `BunResponse.ts:1739-1855`]; `res.flush()` flushes what a
  response transform holds [S, `:1316`]; `addResponseTransform` is how
  `compression()` sees the produced `Response` [S, `:1306`].
- `compression()` compresses a streamed body as it is read and flushes after
  every chunk only for `text/event-stream` [S, `lib/compression.ts:932-1007`,
  `:1017`, `:1347-1363`].
- `escapeHtml` exists twice, privately, in `BunHttpAdapter.ts:110` and
  `serveStatic.ts:125` [S].

### 2.2 bun-nest: `@Render` sends a file

`BunHttpAdapter.render(response, view, options)` sends `Bun.file(view)`, with
a positive `options.status` as the status, a bun-nest invention
[S, `packages/bun-nest/lib/BunHttpAdapter.ts:1230-1250`, `RenderOptions` at
`:116-124`]. `setViewEngine(engine)` is a no-op returning `this`
[S, `:3166-3169`]. `setBaseViewsDir`, `setLocal`, `engine` and `set` do not
exist; Nest's adapter proxy turns them into `TypeError`s (compat table rows
1, 2, 7 and 36 in the compat progress file).

How Nest reaches the adapter [S, `@nestjs/core` 11.1.27]:

- `@Render(template)` stores `template` under `RENDER_METADATA`
  (`"__renderTemplate__"`) on the method
  (`@nestjs/common/decorators/http/render.decorator.js:16-18`). Its type says
  `string`.
- The handler's result passes through every interceptor first, and the
  response is handled after (`router/router-execution-context.js:46-48`).
- If the method has render metadata, the handler is answered by
  `responseController.render(result, res, template)`
  (`:159-162`), which awaits the result and calls
  `applicationRef.render(response, template, result)`
  (`router/router-response-controller.js:27-30`). Nothing checks that
  `template` is a string.

### 2.3 bun-jobs-ui: React 19 served by bun-common

`jobsUi()` is the prior art for everything client-side here:

- `buildAssets()` bundles an entry with `Bun.build` (browser target,
  `[name]-[hash]` names, splitting, `NODE_ENV=production`)
  [S, `packages/bun-jobs-ui/lib/assets.ts:151-213`]; `buildAssetsOnce()`
  builds once per process, shares the promise, forgets a failed build and
  logs one `info` line [S, `:350-383`]; `loadDistAssets()` reads a prebuilt
  `dist/` and checks every file's integrity [S, `:287-347`];
  `resolveAssetSource()` picks between them (`dev: true | false | undefined`)
  [S, `:398-413`].
- `createNonce()`, `escapeHtml()`, `jsonForScript()` and `cspHeader()`
  [S, `lib/shell.ts:16`, `:23`, `:38`, `:73`]; `jsonForScript` escapes `<`,
  `>`, `&`, U+2028 and U+2029, so props cannot end a `<script>` element.
- The shell is served `no-store` with the CSP, `nosniff` and
  `Referrer-Policy`; assets with `public, max-age=31536000, immutable`, a
  strong ETag from the integrity digest, and a 304 path
  [S, `lib/jobsUi.ts:48`, `:552-620`].
- A bundle budget test caps the entry module and every lazy chunk
  [S, `__tests__/server/budget.test.ts:32`], and the e2e suites drive real
  Chrome through `Bun.WebView` with an owned profile directory
  [S, `__tests__/e2e/profile.ts`, `smoke.e2e.test.ts:20-140`].

### 2.4 The compat agent's contract, and what this plan assumes of it [C]

Its harness asserts Express 5.2.1 / platform-express 11.2.7 behaviour on both
adapters. What this plan needs from the bun-common view system it lands:

| # | Assumption | Express source | Used by |
|---|---|---|---|
| C1 | `engine(ext, fn)` registers `fn(path, options, callback)` for an extension; a leading dot is optional | `express/lib/application.js:294-308` | the whole plan |
| C2 | Settings `views` (a string or an array of roots) and `view engine` (the default extension); bun-nest's `setBaseViewsDir` and `setViewEngine` set them | `application.js:552-556`; harness `app.ts:624-625` | §4.3 |
| C3 | Lookup: `<root>/<name>.<ext>`, then `<root>/<name>/index.<ext>`, root by root; a name with an extension picks that extension's engine | `express/lib/view.js:52-95`, `:104-123`, `:169-187` | §4.3 |
| C4 | `options` = `{ ...app.locals, ...res.locals, ...locals }` plus `settings`, `_locals` and `cache` | `application.js:536-541`, `response.js:910-911` | §5.1 |
| C5 | `cache` is the `view cache` setting, on when `NODE_ENV=production` | `application.js:91`, `:139`, `:538-541` | §4.2 |
| C6 | `res.render(view, locals?, callback?)`: with no callback, the string is sent and an error goes to `next(err)`, so the error handlers answer it | `response.js:897-921` | §9.1 |
| C7 | An engine's callback is forced async | `view.js:133-159` | — |
| C8 | No engine for the extension: Express `require(ext).__express` | `view.js:75-88` | §16 Q4 |

**C8 matters for TSX:** with `view engine` set to `tsx` and no engine
registered, Express requires the npm package `tsx`, the TypeScript runner,
and fails with "Cannot find module 'tsx'" [M, §14.6]. bun-common need not copy
that; §16 Q4 recommends a clear error instead.

**What this plan adds to that contract** is one optional member on the engine
function (§8.1). If the compat PR lands without it, PR-1 adds it, a few lines
in `res.render`.

---

## 3. The rendering core

### 3.1 What React DOM gives Bun

React DOM 19.3.0 ships a Bun build. `react-dom/server` resolves to
`server.bun.js` under Bun, which takes `renderToReadableStream`, `resume`
and `renderToPipeableStream` from the Bun build and `renderToString` and
`renderToStaticMarkup` from the legacy browser build. `react-dom/static`
(`prerender`) has no `bun` condition and resolves to `static.node.js`
[S, `node_modules/react-dom/server.bun.js`, `package.json` exports;
M, `render-modes.ts` prints both resolutions]. Each picks its development or
production build from `process.env.NODE_ENV` **when it is first required**,
so `NODE_ENV` must be set before the first view is imported (§10.1).

### 3.2 The three ways to render, measured

The mid-size page is a 200-card catalogue, about 95 KB of HTML
(`evidence/react-views/views/catalog.js`). In process, production build,
one core [M, `render-modes.ts`, `results-render-modes-prod.txt`]:

| Mode | p50 | p90 | Renders/s at p50 |
|---|---|---|---|
| `renderToString` (the document) | 1.81 ms | 2.75 ms | 554 |
| `renderToReadableStream`, drained | 3.85 ms | 5.71 ms | 260 |
| `renderToReadableStream` + `allReady`, drained (**buffered**) | 3.69 ms | 5.61 ms | 271 |
| `prerender`, prelude drained | 3.87 ms | 6.10 ms | 259 |

1,000 iterations, each rendering once in every mode in a rotating order, so
the machine's load (24 to 29) falls on every mode alike. A first run that
timed each mode in blocks of 100 drifted with the load and was discarded.

With a Suspense section waiting 50 ms on data [M, same run]:

| Event | Median of 15 |
|---|---|
| stream: shell ready (`await renderToReadableStream`) | 2.4 ms |
| stream: first chunk read | 3.8 ms |
| stream: last chunk read | 51.4 ms |
| `prerender`: prelude ready | 53.0 ms |
| `renderToString`: returned (**with the fallback, without the data**) | 2.4 ms |

Over a socket, through bun-common's adapter [M, `http-serve.ts`,
`results-http-serve.txt`; medians of 15, load 17 to 29]:

| Route | Headers | First byte | Last byte |
|---|---|---|---|
| `renderToString`, no Suspense | 5.9 ms | 6.0 ms | 6.0 ms |
| stream, no Suspense | 7.8 ms | 7.8 ms | 7.9 ms |
| buffered (`allReady`), Suspense 50 ms | 53.8 ms | 53.9 ms | 53.9 ms |
| stream, Suspense 50 ms | 5.8 ms | 5.8 ms | 51.9 ms |

What decides the default:

- **`renderToString` cannot wait for data.** A suspended section comes out as
  its fallback with a client-render marker, and an async component the same
  way [M, §14.2]. Without hydration, that fallback is the page for good.
- **Buffered** waits for everything, then sends one document. Every React 19
  feature works, the status and headers are still free to change when
  something fails, and `Content-Length` is known. Its cost over
  `renderToString` is about 1.9 ms of CPU per render on this page (3.7 against
  1.8 ms), and nothing more on the wire.
- **Stream** sends the shell first: the first byte at ~6 ms against ~54 ms,
  for a page whose slowest data takes 50 ms. Its price is the status: once
  the shell is out, a later failure cannot become a 500 (§8.4).
- **`prerender`** (`react-dom/static`) is the buffered result by another
  route, and measures the same (3.9 ms). It exists for static generation and
  partial prerendering (`resume`), not for a response per request. Not used
  [D].

**[D] The default is buffered; `"string"` and `"stream"` are opt-in**, per
engine (`reactViews({ mode })`) or per view (`export const mode = "stream"`).
A view that never suspends halves its render time with `"string"` (1.8
against 3.7 ms); a page with slow data gains its TTFB from `"stream"`.

### 3.3 React 19 on the server, measured on Bun

[M, `react19.tsx`, `results-react19.txt`]

- **`use(promise)` inside Suspense** resolves on the server in the stream
  and buffered modes.
- **Async function components** (`async function Comp() { await …; return
  … }`) **render on the server** in `renderToReadableStream`, without React
  Server Components, and `renderToString` emits their fallback. They are
  **server-only**: in a hydrated page, the production client hydrated one
  without a word, but React's development build reports "…is an async Client
  Component. Only Server Components can be async at the moment" [M,
  `hydrate.tsx` page C, both builds]. A hydrated view must not contain one
  (§7.6).
- **Hoisting:** `<title>`, `<meta name>` and `<link rel="stylesheet"
  precedence>` written anywhere in the tree land in `<head>` when React
  renders the whole document, in both `renderToString` and the stream. In a
  fragment they come out at the start of the fragment.
- **Doctype:** the stream emits `<!DOCTYPE html>` when the root is `<html>`;
  `renderToString` never does. The engine adds it in the string mode [D].
- **Errors:** a throw in the shell rejects `renderToReadableStream` and calls
  `onError`; nothing has been sent. A throw inside a Suspense boundary
  leaves the shell intact, emits the fallback with a client-render marker
  (the `onError` return value as its digest, the message withheld in
  production), and the stream ends normally.
- **`nonce`** is put on every inline `<script>` React emits, the bootstrap
  module included; **`bootstrapModules`** accepts `{ src, integrity }` and
  emits a `modulepreload` link.
- **Abort:** `signal` ends a stalled render at its deadline (102 ms for a
  100 ms deadline) with every pending boundary as its fallback, and
  `onError` receives the reason. This is how a render timeout is enforced
  (§9.2).
- **Escaping:** text and attribute values are escaped (`</script>`, quotes,
  `&`); only `dangerouslySetInnerHTML` is not.

### 3.4 Whole document or fragment [D]

**The engine always renders a whole document through React** (§6.1): the
`document` component renders `<html>`, `<head>` and `<body>`, and the view
renders inside it. That is what makes hoisting work, gives the stream its
doctype, and gives hydration a single root (`hydrateRoot(document, …)`). A
view that wants no shell at all (an HTML fragment for htmx, an email body)
sets `export const document = false` and gets the bare markup, with no
doctype and hoisted tags at its start.

### 3.5 The engine function [D] [C]

```ts
import { reactViews } from "@kingsleyweb/bun-react-views";

const engine = reactViews({
  mode: "buffered",            // "string" | "buffered" | "stream"
  document: AppDocument,       // optional; a default is provided
  layout: MainLayout,          // optional; wraps every view
  hydrate: false,              // per-view override: export const hydrate
  logger,                      // LoggerLike; defaults to the router's
});

adapter.engine("tsx", engine);   // bun-common, after the compat PR
adapter.set("views", "./views");
adapter.set("view engine", "tsx");
res.render("users/Profile", { user });
```

Per call, the engine:

1. **Checks the path** is inside a `settings.views` root (§9.3).
2. **Loads the module** (§4): a registry hit after the first time.
3. **Resolves the component**: the default export; a module without one is an
   error naming the file (Express's behaviour is a generic error, [M]).
4. **Builds props** (§5.1) and the tree: document ⊃ layouts ⊃ view.
5. **Renders** in the view's mode, with the engine's `onError`, the nonce and
   bootstrap modules when hydrating, and an abort deadline.
6. **Calls back** with the HTML, or with the error.

---

## 4. Loading views on the fly

### 4.1 Importing a view [M]

Bun imports a `.tsx` or `.jsx` file by path with no configuration:
transpiled on first import, then held in the module registry
[M, `view-loading.ts`, `results-view-loading.txt`]:

| | Time |
|---|---|
| Cold import of a view and the layout it imports | 62 ms |
| Warm import (registry hit) | 0.08 ms |

The cold cost is paid once per view per process. **[D] `preload: true`**
imports every view under the roots at startup, so no request pays it; it is
the default when `NODE_ENV=production`.

`jsx` must be `react-jsx` (the automatic runtime) in the application's
`tsconfig.json`, which is what Bun reads; this repo's base config already
sets it (`tsconfig.base.json`, `"jsx": "react-jsx"`) [S]. With the classic
runtime, every view would need `import React`. A view and the engine must
resolve **the same copy of `react`**, or hooks fail; the evidence's scratch
views reach it through a symlink, which Bun resolves to one real path [M,
the spikes render hooks from symlinked views].

### 4.2 Development reload versus production [M] [D]

What each way of reloading picks up after editing the view **and** a layout it
imports [M, `view-loading.ts`]:

| Strategy | Picks up | RSS over 300 reloads |
|---|---|---|
| `import(path)` again | nothing | — |
| `import(path + "?v=2")` (query-string busting) | the view only; **the layout stays stale** | **+9.9 MB** (never freed) |
| `delete require.cache[file]` for each changed module, then `import(path)` | the view and the layout | **+0 MB** (−0.1) |
| `Bun.build` the view (`target: "bun"`, `packages: "external"`) to a content-hashed file, import that | the view and the layout | not measured; one file per build |

`fs.watch(dir, { recursive: true })` reports edits and new files in nested
directories on Linux [M].

**[D] Development** (`dev: true`, or `options.cache` false, which is Express's
development default under C5): a recursive watcher on every views root and on
`watch: string[]` (for components kept outside the views directory). On a
change, the engine deletes **every** `require.cache` entry under the watched
directories, not only the changed file, because it cannot see which modules
import which without a graph. The next render re-imports what it needs.
Optionally (`liveReload: true`, PR-3), an SSE endpoint tells open pages to
reload, and the client bundles (§7) are invalidated.

**[D] Production** (`options.cache` true): nothing is watched or deleted;
modules stay in the registry for the life of the process.

`Bun.build` per view gives an exact graph from its metafile (the inputs to
watch) and costs ~13 ms per rebuild [M], but it writes a file per build and
moves views into a build output. It is kept for a precompile option (§4.4),
not for development.

`bun --hot` reloads the whole module graph on any change while keeping
`globalThis` [U, Bun's documentation]. The engine needs nothing from it and
must not break under it: its caches are module-level, so `--hot` empties them
too [I]. PR-3 tests both.

**The hazard [I]:** deleting a module from `require.cache` that something
outside the views also imported (a context module, a store) gives the next
view a second instance. Watching only the views roots and the directories
named in `watch` keeps shared modules out of it; the README says so.

### 4.3 Resolution: roots, extensions and exports [C] [D]

Resolution is bun-common's View lookup (C3), not the engine's: the engine
receives a resolved absolute path. What that means for React views:

- **`setBaseViewsDir("views")` / `adapter.set("views", …)`** sets the roots; an
  array is searched in order.
- **`setViewEngine("tsx")`** makes `"users/Profile"` mean
  `views/users/Profile.tsx`, then `views/users/Profile/index.tsx`
  [M, a directory renders its `index.tsx`, §14.6].
- **`.jsx` beside `.tsx`:** register the same engine for both extensions; a
  `.jsx` view is then named with its extension (`"Legacy.jsx"`). Without the
  extension Express looks only for the default one and fails
  ("Failed to lookup view") [M]. Mixing is therefore possible but explicit.
  §16 Q5 asks whether the engine should also try the other extension itself.
- **Exports [D]:** the default export is the view. The engine also reads
  these named exports from the same module: `layout`, `document`, `mode`,
  `hydrate`, `clientProps` and `cache`. No `head` export is needed, because
  React 19 hoists (§6.2). A module with no default export is an error naming
  the file.

### 4.4 Precompiling (optional) [D]

Not needed for correctness or speed in a long-lived server (the cold import
happens once). It matters for a short-lived process (serverless) or to fail
a deploy on a type or syntax error early. `bun-react-views build` (PR-4)
writes, per view, the client bundle and manifest (§7.3) and optionally a
server bundle via `Bun.build({ target: "bun", packages: "external" })` [M,
~13-22 ms per view]. The engine prefers a server bundle when the manifest
lists one, as `jobsUi()` prefers `dist/`, and the same `dev` switch overrides
it.

---

## 5. Data and props

### 5.1 Where props come from [C] [D]

The engine receives Express's merged object (C4). Measured on Express 5.3:
for `res.render("Hello", { name })` with `app.locals.appName` and
`res.locals.user` set, the keys are `settings, appName, user, name, _locals,
cache` [M, §14.6]. Precedence, last wins: `app.locals`, `res.locals`, the
`locals` argument.

**[D] Props are that object without `settings`, `_locals` and `cache`.** The
view therefore sees app-wide and request locals as ordinary props (a
`user` set by an auth middleware, an `appName`), which is what a template
engine user expects.

### 5.2 Typing a view's props [M] [D]

What TypeScript can and cannot enforce [M, `typing/typing.type-test.tsx`,
`results-typing.txt`; TypeScript 6.0.3, `experimentalDecorators`]:

- **A component reference carries its props.** `@RenderComponent(UserPage)`
  can require the handler to return `UserPage`'s props: a missing prop and a
  wrong type are compile errors, for sync and async handlers.
- **A string view name carries nothing** unless something maps names to
  props. An augmentable registry does:

  ```ts
  declare module "@kingsleyweb/bun-react-views" {
    interface ReactViews { "users/Profile": ProfileProps }
    interface ReactViewLocals { user?: SessionUser; appName: string }
  }
  ```

  `@RenderView("users/Profile")` and a typed `res.render` then check the
  props, and a misspelt name is an error.
- **Locals are subtracted.** The handler returns `Omit<Props, keyof
  ReactViewLocals>`, so a prop supplied by `app.locals` need not be returned.
  Locals are declared once, as `@types/express` declares `Locals`.
- **The overload trap:** a typed `res.render(view, props)` beside the untyped
  Express one, `render(view: string, locals?: object)`, enforces **nothing**:
  wrong props simply match the untyped overload [M, the negative control in
  `results-typing.txt`]. The fix: the untyped overload refuses a registered
  name (`view: V extends keyof ReactViews ? never : V`). A dynamic `string`
  still takes it.
- **What it cannot enforce:** excess props (structural typing), a handler
  typed `any`, an interceptor that reshapes the result (§12.5), and a
  `ReactViews` registry that drifts from the files on disk. **[D] PR-2 adds
  `bun-react-views types`**, which writes the registry from the views
  directories (each view's default export's props), and a test that fails on
  drift, the way `generate-verb-overloads.ts --check` does for routes.

---

## 6. Layouts and the document shell

### 6.1 Three levels [D]

```
document  (one per engine: <html>, <head>, <body>, injection points)
  └ layout  (engine default; a view overrides or opts out)
      └ layout … (nested: each layout module may name its own parent)
          └ view  (the default export)
```

- **The document** is an engine option, `document: Component`, with a default
  (`DefaultDocument`: `lang="en"`, charset, viewport, `<body>` holding the
  layouts). It receives `{ children, props, assets }`.
- **Layouts**: `reactViews({ layout })` wraps every view; a view module may
  `export const layout = OtherLayout`, or `null` for none. A layout module
  may itself `export const layout = Parent`, which gives nesting without a
  file convention. The engine walks the chain and refuses a cycle.
- **Composition stays possible**: a view may simply render `<MainLayout>`
  itself and set `layout = null`. It is the most explicit form, and the one
  typed end to end.

Directory conventions (`_layout.tsx` per folder, as in Next.js) are left out
[D]: they need a file scan per lookup and add magic the explicit chain does not
need. §16 Q7.

### 6.2 The head [M]

No head API is needed: React 19 hoists `<title>`, `<meta>` and stylesheet
`<link precedence>` from anywhere in the tree into `<head>`, and dedupes
stylesheets by `href` [M, §3.3; deduplication U, React's documentation]. A
view writes `<title>Profile</title>` where it likes.

### 6.3 Asset injection points [D]

- **Scripts:** the engine passes `bootstrapModules: [{ src, integrity }]` and
  `nonce` to React, which writes the `<script type="module">` and a
  `modulepreload` link itself, both nonce'd [M, §3.3]. No component is needed
  for that.
- **Props for hydration:** `bootstrapScriptContent` (§7.4).
- **Stylesheets of a hydrated view:** CSS imported by the client entry comes
  out of `Bun.build` as files; the document renders them as `<link
  rel="stylesheet" precedence="default" href integrity>` from the `assets`
  prop.
- **`<ViewAssets />`** is exported for a custom document that wants to place
  them itself; the default document needs nothing.

---

## 7. Client hydration (optional)

### 7.1 The modes [D]

| Mode | What the browser gets | When |
|---|---|---|
| none (default) | HTML only. Streamed Suspense swaps still run, as React's small inline scripts | content pages, emails, admin lists |
| `hydrate: true` | the page's client bundle; `hydrateRoot(document, <Document><Layouts><View {...props}/>…)` | interactive pages |
| islands (PR-5) | one bundle per island component; each `<Island>` hydrates alone | mostly static pages with a few widgets |

### 7.2 The client entry [D]

For a hydrated view, the engine generates an entry (a virtual module through
a `Bun.build` plugin, or a file in a cache directory) that imports the
document, the layout chain and the view, and calls:

```ts
hydrateRoot(document, <Document {...}><Layout><View {...props} /></Layout></Document>, {
  onRecoverableError, onCaughtError, onUncaughtError,  // to the console in dev
});
```

The client tree must be the server tree, so **the document, the layouts and
the view are shared code**: anything in them must run in a browser. Measured
in headless Chrome, whole-document hydration under a nonce CSP with SRI
works: the page hydrates, a click updates state, and the page reports no
console error and no CSP violation [M, `hydrate.tsx`, page A, §14.7].

### 7.3 Build, serve, cache [D] (reuses jobsUi)

- **Build:** `Bun.build` per hydrated view (browser target, minified,
  splitting, `[name]-[hash]` names, `NODE_ENV=production`), as
  `buildAssets()` does (`assets.ts:151`). Splitting shares React DOM's client
  between pages. Measured: three entries built cold in **21 ms**; each entry
  is 0.4 to 0.6 KiB, and the shared chunk (React DOM's client and React) is
  **207 KiB, 65 KiB gzipped** [M, §14.7]. That chunk is the floor of a
  hydrated page, and why hydration is opt-in.
- **When:** in memory on a view's first hydrated render, once per process,
  the promise shared and a failure forgotten (`buildAssetsOnce`,
  `assets.ts:357`); or prebuilt by `bun-react-views build` into a `dist/` with
  a manifest that records each file's integrity (`writeAssets`,
  `loadDistAssets`). The `dev` switch chooses, as `resolveAssetSource` does
  (`assets.ts:398`).
- **Serve:** `views.assets` is a bun-common router mounted at
  `assetsPath` (default `/_views/assets`), with `immutable` caching, a strong
  ETag from the integrity digest, `nosniff`, a 304 path and HEAD
  (`jobsUi.ts:580-620`).
- **Budget:** a test caps each page's entry and chunks, as `budget.test.ts`
  does.

**Reuse, concretely [D]:** `escapeHtml`, `jsonForScript` and `createNonce`
move to bun-common's `native.ts` in PR-1 (they are dependency-free, and
bun-common already has two private `escapeHtml`s). The asset functions are
copied into bun-react-views and generalised from one entry to many; moving
bun-jobs-ui onto them is a follow-up for the bun-jobs-ui agent, not part of
this plan (§16 Q9).

### 7.4 Props on the wire [M] [D]

- **Transport [D]:** `bootstrapScriptContent: "self.__RV_PROPS=" +
  jsonForScript(props)`. React puts it in its own nonce'd inline script, and
  JSON escaped that way is also a valid script expression. Measured: it
  hydrates with no error. The alternative, a `<script type="application/json">`
  that only the server renders, **breaks hydration**: React reports
  recoverable error #418 (a mismatch) and re-renders on the client [M, page
  B]. So the props cannot be a server-only element of the tree.
- **Escaping [M]:** the props in the spike carry `</script><script>…</script>`,
  U+2028 and `<!--`; the served HTML contains no raw `</script>` from them,
  the injected script never runs, and the text round-trips exactly into the
  hydrated page [M, pages A and B].
- **What is sent [D]:** exactly the props the view received, so in hydrate
  mode **`app.locals` and `res.locals` reach the browser.** That is required
  for the client to render the same tree, and it is a leak if a local holds a
  secret. The engine therefore serialises only keys the view declares
  (`export const clientProps = ["user", "items"]`) when given, and in
  development warns about any local it is about to send. §16 Q6.
- **Types that do not survive JSON** (`Date`, `Map`, `BigInt`, class
  instances) produce a hydration mismatch. In development the engine
  compares `JSON.parse(JSON.stringify(props))` with the props and warns on
  the first difference, naming the key. No serialiser dependency [D].

### 7.5 CSP and SRI [M] [D]

- A fresh nonce per request (`createNonce`), passed to React as `nonce`;
  React puts it on every inline script, bootstrap and Suspense-swap scripts
  alike [M, §3.3].
- **[D] `csp: true`** sets a policy built like `cspHeader()` (`shell.ts:73`):
  `script-src 'nonce-…' 'strict-dynamic'`, `base-uri 'none'`,
  `object-src 'none'`, plus the application's own directives
  (`csp: { directives }`). Off by default, because an application usually
  owns its CSP; then `res.locals.cspNonce` (or a `nonce` option) is honoured.
- SRI on every bootstrap module and modulepreload via `{ src, integrity }`
  [M, §3.3]. Measured under `script-src 'nonce-…' 'strict-dynamic'`: no
  violation on any of the three pages [M, §14.7].
- A streamed page's Suspense swaps are inline scripts too, so **a streamed
  page under a strict CSP needs the nonce even without hydration** [M, §3.3].

### 7.6 Islands, RSC and what is out of scope

- **Islands (PR-5) [D]:** `<Island component={Cart} props={{ items }} />` in
  a server view renders `Cart` to HTML inside a marker element carrying its
  id; the page's bootstrap script imports each island's chunk and calls
  `hydrateRoot(marker, <Cart {...props} />)`. Each island is a separate root,
  so state is not shared between islands. The island's component is named by
  module path at build time, which a `Bun.build` plugin collects. ~2.5 d.
- **Async components in a hydrated view:** an async server component inside a
  hydrated tree hydrated without an error in the production build, its
  server text kept [M, page C], but the development build logs "…is an async
  Client Component. Only Server Components can be async at the moment" [M].
  It is unsupported, and works by accident in production. **[D]** In
  development, the engine turns that console error into a thrown error for
  a hydrated view, and the README says to keep async components out of
  hydrated views; islands are the way to put an interactive part inside an
  async page.
- **React Server Components and server actions: out of scope [U].** They need
  two module graphs (one under the `react-server` condition), a Flight
  serialiser and client-reference manifests from a bundler integration.
  React ships those integrations for webpack, Turbopack, Parcel and an
  experimental ESM one; `Bun.build` has none we could verify. What does work
  on Bun today, measured, is async components and `use()` in ordinary SSR
  (§3.3), which covers "fetch data in the component" for server-rendered
  pages. Revisit if Bun's bundler gains RSC support.

---

## 8. Streaming through the adapters

### 8.1 What the Express contract forces, and how to also stream [D] [C]

The engine callback is `(err, html: string)`, and `res.render` without a
callback sends that string (C6). A stream cannot pass through it. So:

```ts
interface ViewEngine {
  (path: string, options: object, callback: (err: Error | null, html?: string) => void): void;
  /** Optional: render to a stream. Resolves once the shell is ready. */
  renderToStream?: (path: string, options: object) => Promise<ReadableStream<Uint8Array>>;
}
```

`res.render(view, locals)` with **no callback** uses `renderToStream` when the
engine has it **and** the engine says the view streams (the engine decides,
from its `mode` option and the view's `export const mode`; a `wantsStream?:
(path, options) => boolean` member, or `renderToStream` resolving `undefined`
to decline). With a callback, the string path always runs, exactly as
Express. Every other engine (EJS in the compat harness) has no such member
and is unaffected.

In bun-common, that is a few lines in the compat PR's `res.render`, or PR-1.
**This is the only part of the plan that changes bun-common's view
semantics**, and it changes nothing for an engine without the member.

### 8.2 Through `BunResponse` and the pipeline [M] [S]

`res.type("html").send(stream)` is the whole of it: `send` builds the
`Response` around the stream [S, `BunResponse.ts:1739-1855`], and the
pipeline treats the layer as finished once a response exists (CLAUDE.md,
"Router — Express 5 semantics": a layer is finished when it sends a complete
response). Measured over a socket: the shell's first byte at 5.8 ms, the
Suspense data at 51.9 ms for a 50 ms wait [M, §3.2].

- **Status and headers** are fixed when `send` runs, after the shell
  resolved. A shell error rejects first, so it still becomes a 500 [M, §8.4].
- **HEAD:** bun-common answers HEAD with the GET handler, the render starts,
  and Bun **cancels** the body stream: 5 of 5 renders cancelled, none read to
  the end, with no `Content-Length` [M, `http-serve.ts`]. Express renders a
  HEAD fully and sends the length (compat row 6). In the buffered and string
  modes the engine behaves as Express. **[D] In stream mode, a HEAD request
  is rendered buffered**, so its headers match the GET's buffered form and
  nothing is wasted on a cancelled stream; §16 Q8.
- **The request timeout** (`handle()`'s `timeout`) bounds the wait for the
  shell, as for any handler. Beyond the shell, the engine's own deadline
  aborts the render (§9.2).

### 8.3 Compression: a stall to fix first, then flush per chunk [M]

**The bug.** With `compression()` in front, a streamed body whose chunks are
too small for zlib to emit output never finishes: the client receives
gzip's 10-byte header (brotli: nothing) and waits. It happens for a stream
enqueued from `start()` and for one chunk per `pull()`, with or without a
pause, for every size measured (100 B to 100 KB), on gzip and br; identity is
fine [M, `gz-stall.ts`, `results-gz-stall.txt`]. React's streamed page with
a Suspense section hits it every time (`/gz/stream-suspense`: STALLED 2 of 2,
10 bytes arrived) [M, `http-serve.ts`]. Not Bun: Bun.serve delivers chunks
enqueued outside `pull()`, and `node:zlib` on Bun calls back and ends
[M, `gz-stall-controls.ts`].

**The likely cause [I]:** `zlibReadable`'s `pull()` writes a source chunk to
zlib and returns having enqueued nothing when zlib buffered it
[S, `compression.ts:963-990`]. By the Streams spec, a `pull()` that enqueues
nothing is not called again unless a new read arrives while it runs, so the
source is never read to its end, `engine.end()` never runs, and the buffered
output never comes out. A big first chunk (the whole page without Suspense)
makes zlib emit during `pull()`, which is why `/gz/stream` works. The existing
test (`__tests__/compression.test.ts:819-859`) reads only until each expected
part arrives, never to the end of the body, so it cannot see a missing end.

**PR-0 (the bun-common agent):** loop in `pull()` until something is enqueued
or the source ends, and add tests that read a compressed stream **to its
end**: small chunks, a pause between them, both encodings, and a negative
control on the current code. Independent of this plan, and worth doing first:
any small-chunked streamed body under `compression()` hangs today.

**After the fix, flush anyway [M] [D].** zlib buffers until it has enough to
emit, which holds the shell back. With a flush after each React chunk, the
gzip first byte arrives at 7.1 ms, against 54.6 ms buffered, for 4,869 bytes
against 4,204 [M, `/gz/stream-suspense-flush`]. React flushes per boundary,
so the chunks are few. The engine's stream mode calls `res.flush()` after
each chunk (a `TransformStream`), which is also the workaround until PR-0.

### 8.4 Errors after the headers [M] [D]

| When | What happens | Measured |
|---|---|---|
| in the shell | `renderToReadableStream` rejects before `send`; `res.render`'s callback gets the error; the error handlers answer 500 | `/shell-error`: 500 from the error handler |
| in a Suspense boundary, after the shell | React's `onError` runs; the fallback stays with a client-render marker; the stream ends normally with **200** | `/late-boundary-error`: 200, ends with `</html>` |
| the body stream itself breaks | the connection is reset; the client sees an error, not a clean truncated page | `/hard-stream-error`: `ECONNRESET` after 1000 bytes, on Bun.serve and bun-common alike (`stream-error-after-headers.ts`) |

So, in stream mode:

- **With hydration**, a boundary error after the shell is recovered on the
  client: React re-renders that boundary in the browser (§7). That is React's
  design.
- **Without hydration**, the fallback stays on the page for good, under a 200.
  **[D] The engine therefore defaults to buffered**, and stream mode logs each
  boundary error, through `onError`, as `logger.error("react-views: a
  boundary failed after the response started", { error, view })`. A view
  choosing `"stream"` without `hydrate` gets a development warning.
- **Error boundaries** (a component with `componentDidCatch`) do not run on
  the server; Suspense boundaries are the server's unit of recovery
  [U, React's documentation].

---

## 9. Errors and security

### 9.1 Render errors become a 500 [M] [C]

In the buffered and string modes, and in the shell of the stream mode, a
render error reaches the callback; `res.render` without a callback passes it
to `next(err)` (C6), and the application's error handlers answer it, as for
any handler [M, `/shell-error`]. In bun-nest, it reaches Nest's exception
layer: the compat agent's target is Express's 500 JSON
`{ statusCode: 500, message: "Internal server error" }` (compat rows 3 and 4).

**[D] Development overlay:** with `dev: true`, a render error carries the
component stack (React 19's `onError(error, { componentStack })`) and the
view path on the error object, and bun-react-views exports an error handler,
`viewErrorPage()`, that answers it with a plain HTML page showing them under
a 500. It is registered by the application (or by `ReactViewsModule` in
development), never implicitly: the engine's callback carries a string, not
a status (§16 Q10). In production, the error goes to
the handlers untouched and the page never contains the message (React
withholds it from the digest too [M, §3.3]).

### 9.2 A render deadline [M] [D]

`renderTimeout` (default 10 s, and never past the adapter's request timeout)
aborts the render through `signal`: pending boundaries become fallbacks and
`onError` names the reason [M, §3.3]. In buffered mode, an aborted render is
an error (a 500); in stream mode, it is the late-boundary case of §8.4.

### 9.3 View names and paths [M] [D]

- **Express does not confine view names.** `res.render("../Secret")` and an
  absolute path both render a file outside the views directory [M,
  `express-contract.ts`]. For a template that is an information leak; for a
  React view it **executes** the module.
- **[D] The engine refuses a path outside every `settings.views` root** (it
  receives the resolved path and the settings [M, `settings` carries
  `views`]), with an error that names the view but not the path.
- **[D] Never render a user-controlled name.** The README says it plainly, and
  the typed forms (`@RenderComponent`, the registry) make the safe way the
  easy one.

### 9.4 Escaping [M]

React escapes text and attributes [M, §3.3]. The holes are
`dangerouslySetInnerHTML` (the README says so) and serialised props, which go
through `jsonForScript` (§7.4).

---

## 10. Performance

### 10.1 `NODE_ENV` [M]

React DOM picks its build when first required (§3.1). Measured on the
same page, development build against production (p50): `renderToString`
5.15 ms against 1.81 ms (**2.8 times slower**), buffered 6.42 ms against
3.69 ms (1.7 times) [M, `results-render-modes-dev.txt`,
`results-render-modes-prod.txt`]. Express's `view cache` also keys on it (C5).
**[D]** The engine logs one `warn` line at startup when `NODE_ENV` is not
`production` and `dev` was not set explicitly, as `jobsUi()` logs its
in-memory build (`assets.ts:363-366`).

### 10.2 Against Node and Express [M]

`oha -c 32`, interleaved rounds, the same view [M, `bench.ts`,
`results-bench.txt`]:

| Server | `/string` | `/engine` | `/stream` |
|---|---|---|---|
| bun-common on Bun | **626** req/s · p99 105 ms | **765** · 92 ms | **464** · 134 ms |
| Express 5 on Node 24.2 | 552 · 329 ms | 561 · 363 ms | 380 · 706 ms |
| Express 5 on Bun | 733 · 91 ms | 740 · 87 ms | **127** · 613 ms |

Medians of 4 interleaved rounds of 3 s, each server one process, run
exclusively under the heavy-run wrapper (load 43 falling to 8 during the
run). `/string` is `renderToString` sent by the handler; `/engine` the same
through the Express engine contract (on bun-common, an engine function called
the way `res.render` will call it); `/stream` is `renderToReadableStream`
on bun-common and `renderToPipeableStream` on Express.

What it says, and what it does not:

- **Rendering is the cost, not the HTTP layer.** One process renders this
  page in ~1.8 ms, so about 550 renders per second per core is the ceiling,
  and every string route sits near it. The differences between servers on
  `/string` and `/engine` (±15% between rounds of one server) are within the
  noise of a shared machine. The engine contract adds nothing measurable.
- **The tail is Node's**: p99 of 329 to 706 ms against 87 to 134 ms on Bun,
  at the same concurrency, on every route.
- **Streaming on bun-common** gives 464 req/s against Express on Node's 380.
  **Express on Bun with `renderToPipeableStream` is slow** (127 req/s, and
  15 to 72 in two earlier runs): Node streams piped into Bun's `node:http`.
  That is not this plan's path (bun-common sends a web stream), so it is
  noted, not chased.
- **A first run on the shared machine was discarded:** load rose from 10 to
  47 and its two rounds were up to five times apart.
- **Scale-out** (several processes, `reusePort`) multiplies all of these
  alike, and was not measured.

### 10.3 Caching rendered output [D]

Rendering this page costs 1.8 ms (string) to 3.7 ms (buffered) of one core
[M, §3.2]. Caching the HTML is the job of the cache layer planned in
[`bun-cache.md`](bun-cache.md), written at the same time; this plan only says
what views need from it:

- **Route-level caching is the right unit** (key: the URL and the `Vary`
  headers), as an HTTP cache middleware in front of `res.render`, not inside
  the engine: the engine cannot tell which locals matter, and hashing a
  200-item props object per request costs about what rendering it does [I].
- **What the engine adds:** a view may `export const cache = { ttl: 60 }`,
  which `res.render` turns into `Cache-Control` and which the cache layer
  reads. A hydrated page's HTML carries a per-request nonce, so it is
  **not cacheable as is** unless the nonce is dropped (no CSP) or replaced on
  the way out; §16 Q11.
- **Single-flight** (one render per key under a stampede) is the cache
  layer's.

### 10.4 A regression guard [D]

`packages/bun-react-views/bench/`, a separate unpublished package like
`packages/bun-jobs/bench/` (its comparators, Express and Node, stay out of
the published tree), with `--compare` and `--save-baseline` as CLAUDE.md's
"Benchmark regression guard" describes:

- scenarios: string, buffered and stream on the mid-size page; the stream
  TTFB with a 50 ms Suspense section, with and without `compression()`; the
  cold import of a view; a hydrated page's bundle size;
- the **overtaken check**: Express on Node rendering the same view with
  `renderToString` is the rival, so a busy machine slows both;
- the TTFB and stall scenarios are **assertions**, not figures: a streamed
  compressed page must finish, and its first byte must arrive before its
  slowest boundary.

---

## 11. Packaging

### 11.1 Where it lives [D]

**`packages/bun-react-views`, published as `@kingsleyweb/bun-react-views`.**
A subpath of bun-common (`@kingsleyweb/bun-common/react`) was considered:

| | New package | bun-common subpath |
|---|---|---|
| React in bun-common's tree | no | an optional peer of an HTTP layer most users never render React with |
| Client app code (`app/`-like, DOM libs) | its own project, as bun-jobs-ui's | a second tsconfig inside bun-common |
| Chrome e2e suite, bundle budget | its own gate | added to bun-common's gate and every bun-common change |
| Owner | features agent, then whoever the user names | the bun-common agent |

### 11.2 Dependencies [D]

```jsonc
{
  "dependencies": { "@kingsleyweb/bun-common": "^2.2.0" },
  "peerDependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "@types/bun": ">=1.4.2",
    "@types/react": "^19.2.0"
  },
  "peerDependenciesMeta": {
    "@types/bun": { "optional": true },
    "@types/react": { "optional": true }
  }
}
```

- **`react` and `react-dom` are required peers of this package, and never a
  dependency of anything.** The application owns its React, so views and the
  engine share one copy (§4.1). They are not optional *here*, because the
  package cannot work without them; they are absent from bun-common
  altogether.
- **`@types/react` is an optional peer** [D]: the shipped declarations name
  `ComponentType` and `ReactNode`, so a consumer type-checking against them
  needs it (CLAUDE.md: "`@types/*` backing a type a shipped declaration
  imports"), but making it required would force it on JavaScript users. §16
  Q3.
- No other runtime dependency. Bundling is `Bun.build`; hashing,
  `Bun.CryptoHasher`; watching, `node:fs`.

### 11.3 Declarations and the consumer check

The dts recipe from CLAUDE.md ("Packaging types"), unchanged:
`tsconfig.build.json` and `scripts/build-declarations.ts` copied, `dts/`
gitignored, `exports` entries in the `{ "@kingsleyweb/source", types, default
}` shape, and `__tests__/packaging.test.ts`. Entries:

| Spelling | What | `peers` in `consumer-check.json` |
|---|---|---|
| `@kingsleyweb/bun-react-views` | `reactViews`, `ReactViews`, `ReactViewLocals`, `DefaultDocument`, `ViewAssets`, `Island`, types | `react`, `react-dom`, `@types/react` |
| `@kingsleyweb/bun-react-views/client` | the hydration runtime the generated entries import | same; checked as a `browser` entry (no Bun or Node types) |
| `@kingsleyweb/bun-nest/react` (in bun-nest) | `ReactViewsModule`, `RenderComponent`, `RenderView` | `@kingsleyweb/bun-react-views`, `react`, `react-dom` |

The build's `checkPeerScopes` (CLAUDE.md) then proves bun-nest's root never
reaches `./react`, as it proves for `./jobs`.

---

## 12. bun-nest adoption

### 12.1 With the compat PR alone [C]

Once `@Render` follows Express, React views need no bun-nest code:

```ts
import { reactViews } from "@kingsleyweb/bun-react-views";

const app = await NestFactory.create(AppModule, new BunHttpAdapter());
app.engine("tsx", reactViews());     // the compat PR's engine()
app.setBaseViewsDir(join(import.meta.dir, "views"));
app.setViewEngine("tsx");

@Controller("users")
class UsersController {
  @Get(":id")
  @Render("users/Profile")
  profile(@Param("id") id: string) {
    return { user: this.users.find(id) };   // props
  }
}
```

That is the whole adoption for string views, and it is what the user asked:
"how it can be adopted in bun-nest". §12.2 to §12.4 make it nicer.

### 12.2 `ReactViewsModule` [D]

```ts
@Module({
  imports: [ReactViewsModule.forRoot({ views: "views", mode: "buffered", hydrate: false })],
})
class AppModule {}
```

On module init it gets the `HttpAdapterHost`, registers the engine for `tsx`
and `jsx`, sets the views roots and the default engine, and mounts the asset
router when any view hydrates. `forRootAsync` takes a factory for options
from config. It refuses a non-bun-nest adapter with a `ConfigError` naming
the adapter.

### 12.3 `@RenderComponent(Component)` [M] [D]

```ts
@Get(":id")
@RenderComponent(Profile)
profile(@Param("id") id: string): Promise<Omit<ProfileProps, keyof ReactViewLocals>> { … }
```

It stores the component under `RENDER_METADATA` (D12), so Nest calls
`adapter.render(res, Profile, result)`. **bun-nest's `render` accepts a
component** as well as a string: it hands the component to bun-react-views
directly, skipping the lookup (no file, no traversal check needed, no string
to mistype). The handler's return type is checked against the props [M,
§5.2]. `@RenderView("users/Profile")` is the string form, checked through the
registry. Both are thin: Nest's own `@Render` keeps working.

On Nest's Express adapter, a component in `RENDER_METADATA` would reach
`response.render(component, …)` and fail; the decorators are for bun-nest
only, and say so.

### 12.4 Errors and exception filters [D]

- A render error goes to Nest's exception layer, as any error does (§9.1).
- **An exception filter can render an error page**:

  ```ts
  @Catch(NotFoundException)
  class NotFoundPage implements ExceptionFilter {
    catch(e: NotFoundException, host: ArgumentsHost) {
      const res = host.switchToHttp().getResponse<BunResponse>();
      res.status(404).render("errors/NotFound", { path: … });
    }
  }
  ```

  That needs `res.render` on `BunResponse` (C6), which the compat PR adds. A
  render error inside a filter is caught by bun-nest's final handler, so it
  cannot loop.

### 12.5 Interceptors [S] [D]

The handler's result passes through every interceptor before it is rendered
[S, `router-execution-context.js:46-48`]. So `ClassSerializerInterceptor`
turns class instances into plain objects (respecting `@Exclude`) **before**
they become props: useful, because a hydrated page then never serialises an
excluded field. The type check of §5.2 sees the handler's return type, not the
interceptor's output, so an interceptor that reshapes the result defeats it
[I]. The README says so.

---

## 13. Tests and examples

### 13.1 What each PR proves

| PR | Tests (each with a negative control) |
|---|---|
| PR-0 | a compressed stream is read **to its end** for small chunks, a pause, gzip and br; fails on today's `zlibReadable` |
| PR-1 | `res.render` streams when the engine has the capability and no callback; uses the string path with a callback; EJS (no capability) byte-identical to today's compat harness results |
| PR-2 | the compat harness's view probes, re-run with a `.tsx` view beside the EJS one; each mode's output, doctype, hoisting; Suspense, `use()` and async components in buffered mode, fallbacks in string mode; props merge and the three stripped keys; missing default export; traversal refused (`../`, absolute, a symlink out); `onError` to the logger, not the console; the deadline; HEAD in each mode; `NODE_ENV` warning; type tests (`*.type-test.ts`) for the registry, the overload fix and locals subtraction |
| PR-3 | an edit to a view and to a layout is picked up; RSS flat over 300 reloads (the spike as a test); `--hot` does not break it; nothing watched in production |
| PR-4 | client build once per process, shared and forgotten on failure; asset router (immutable, ETag, 304, HEAD, 404); `jsonForScript` round trip with `</script>`, U+2028 and `<!--`; CSP nonce on every script; SRI; a bundle budget; **e2e in Chrome** (`Bun.WebView`, owned profile, skips visibly without Chrome): hydration with no recoverable error, a click changes state, no CSP violation, the injected script never runs; the props-type warning |
| PR-5 | two islands hydrate independently; a page with no island ships no client JS |
| PR-6 | `ReactViewsModule` registers the engine; `@Render("Page")` and `@RenderComponent(Page)` render on `BunHttpAdapter`; type tests for the decorator; an exception filter rendering a page; `ClassSerializerInterceptor` before render; consumer check with `peers` |
| PR-7 | `bench --compare` against a saved baseline; the stall and TTFB assertions |

### 13.2 Examples (the examples agent)

Self-asserting, as the repo's examples are, in a new `examples/bun-react-views/`
and in `examples/bun-nest/`:

1. `01-quick-start`: an engine, a view, `res.render`; asserts the HTML.
2. `02-layouts`: a document, a default layout, a nested layout, a view opting
   out; asserts the nesting and the hoisted `<title>`.
3. `03-data`: Suspense with `use()` and an async component in buffered mode;
   the same view in string mode shows the fallback.
4. `04-streaming`: stream mode with `compression()`; asserts the first byte
   arrives before the slow boundary (a timing assertion, so `RUN_ALONE`).
5. `05-hydration`: a counter page, in Chrome (two at a time, as
   `examples/bun-jobs-ui`'s runner does); asserts the click.
6. `06-errors`: a render error answered by an error handler; traversal refused.
7. `examples/bun-nest/…/react-views.ts`: `ReactViewsModule`, `@Render`,
   `@RenderComponent`, a filter rendering a 404 page.

The playground (`playground/`) is bun-jobs' showcase; whether a React-views
page belongs there is the bun-jobs-ui agent's call (CLAUDE.md, "Done includes
the playground"); §16 Q12.

---

## 14. Measured evidence

On 2026-10-10, on one shared laptop: i9-11900H, 16 threads, Linux
7.0.0-38-generic, Bun 1.4.3 (`bbdc5a519`), Node v24.2.0, React 19.3.0,
Express 5.3.0. Peer sessions ran throughout, at a 1-minute load between 8 and
47, so compare within a run. The heavy spikes went through the heavy-run
wrapper: `render-modes.ts` and `hydrate.tsx` (both builds) as the wrapper
chose, `bench.ts` with `HEAVY_MODE=exclusive`.

### 14.1 `render-modes.ts`

`results-render-modes-prod.txt` (`NODE_ENV=production`) and
`results-render-modes-dev.txt` (unset), each 1,000 rotating iterations:

| Mode (p50 / p90) | Production | Development |
|---|---|---|
| `renderToString`, body only | 1.79 / 2.77 ms | 5.12 / 7.84 ms |
| `renderToString`, document | 1.81 / 2.75 ms | 5.15 / 7.89 ms |
| stream, drained | 3.85 / 5.71 ms | 6.51 / 9.79 ms |
| stream + `allReady`, drained | 3.69 / 5.61 ms | 6.42 / 9.49 ms |
| `prerender` | 3.87 / 6.10 ms | 6.61 / 9.62 ms |
| Suspense 50 ms: stream first chunk / last chunk | 3.8 / 51.4 ms | 7.0 / 51.4 ms |

Also printed: under Bun, `react-dom/server` resolves to `server.bun.js` and
`react-dom/static` to `static.node.js`. The sizes it prints are in different
units: 95,066 is `renderToString`'s length in UTF-16 characters, 96,282 the
stream's length in bytes. The page is the same: the ~600 `★` glyphs take 3
bytes each in UTF-8, and the stream adds the 15-byte doctype (95,066 + 1,200
+ 15 = 96,281, and the string route sends 96,282 bytes over the wire, §14.3).

### 14.2 `react19.tsx`

Every bullet of §3.3, from `results-react19.txt`. The surprises against
common belief: async function components render in plain SSR (no RSC), and
`renderToString` keeps hoisting when it renders `<html>`.

### 14.3 `http-serve.ts`, `gz-stall.ts`, `stream-error-after-headers.ts`

`results-http-serve.txt` (load 17 to 29):

| Path | Encoding | First byte | Last byte | Bytes |
|---|---|---|---|---|
| `/string` | identity | 6.0 ms | 6.0 ms | 96,282 |
| `/stream` | identity | 7.8 ms | 7.9 ms | 96,282 |
| `/buffered-suspense` | identity | 53.9 ms | 53.9 ms | 96,374 |
| `/stream-suspense` | identity | 5.8 ms | 51.9 ms | 97,428 |
| `/stream-suspense-flush` | identity | 5.1 ms | 51.9 ms | 97,428 |
| `/gz/string` | gzip | 4.5 ms | 4.5 ms | 4,204 |
| `/gz/stream` | gzip | 5.5 ms | 5.6 ms | 4,204 |
| `/gz/buffered-suspense` | gzip | 54.6 ms | 54.7 ms | 4,260 |
| `/gz/stream-suspense` | gzip | 12.1 ms | **stalled** (10 bytes) | — |
| `/gz/stream-suspense-flush` | gzip | 7.1 ms | 52.4 ms | 4,869 |

HEAD on a streamed page: 5 renders started, 0 read to the end, 5 cancelled;
no `Content-Length`. Errors: §8.4.

`results-gz-stall.txt`: 36 cases; every gzip and br case stalls (1.5 s
deadline), every identity case finishes. `results-gz-stall-controls.txt`:
both controls pass. `results-stream-error.txt`: a reset in all four cases.

A first version of the stream-error spike reported a **clean, truncated 200**
for a piped stream; it was wrong (the stream closed before the delayed error
ran), and was caught by reading the same stream in JavaScript. The corrected
spike is the one kept.

### 14.4 `bench.ts`

`results-bench.txt`: the table and reading in §10.2, with each round's
figure. Per round, req/s:

| Server | `/string` | `/engine` | `/stream` |
|---|---|---|---|
| bun-common on Bun | 616, 557, 626, 669 | 765, 692, 654, 779 | 460, 486, 464, 304 |
| Express 5 on Node | 461, 538, 552, 596 | 571, 561, 520, 436 | 389, 351, 380, 289 |
| Express 5 on Bun | 631, 683, 733, 783 | 802, 740, 696, 576 | 127, 106, 130, 90 |

### 14.5 `view-loading.ts`

The tables in §4.1 and §4.2; 20 server-side rebuilds of a view: median
13.4 ms.

### 14.6 `express-contract.ts`

Express 5.3.0 on Bun, with `app.engine("tsx", reactEngine)` and
`app.engine("jsx", reactEngine)`:

| Call | Result |
|---|---|
| `res.render("Hello", { name })` | 200, rendered |
| options received | `settings, appName, user, name, _locals, cache`; `cache` true under `NODE_ENV=production` |
| `res.render("users")` | 200, `users/index.tsx` |
| `res.render("Legacy.jsx")` | 200 |
| `res.render("Legacy")` (view engine `tsx`) | 500, "Failed to lookup view" |
| `res.render("Named")` (no default export) | 500, the engine's error |
| `res.render("../Secret")`, and its absolute path | **200, rendered from outside the views directory** |
| `res.render(view, locals, callback)` | the callback gets the HTML |
| view engine `tsx`, no engine registered | 500, "Cannot find module 'tsx'" |

### 14.7 `hydrate.tsx`

`results-hydrate.txt` (`NODE_ENV=production`, Chrome at
`/usr/bin/google-chrome`, through `Bun.WebView`):

| | Result |
|---|---|
| `Bun.build`, 3 entries, browser, minified, splitting | 21 ms cold; entries 0.4 to 0.6 KiB; shared chunk 207.3 KiB (65.4 KiB gzip) |
| served HTML (page A) | no raw `</script>` from props; every `<script>` has the nonce; the module script and the `modulepreload` carry `integrity` |
| A: props via `bootstrapScriptContent` | hydrated; click → "count 6"; injected script did not run; the evil text round-trips; no CSP violation; no console error |
| B: props in a server-only JSON `<script>` | hydrated **after a recoverable error #418** (a mismatch), then works; otherwise as A |
| C: async server component in a hydrated tree | hydrated; server text "async server data" kept; no console error, no violation |

`results-hydrate-dev.txt` (`NODE_ENV` unset, so React's development builds
on both sides): the same results for A and B (B's mismatch now spelled out:
"Hydration failed because the server rendered HTML didn't match the
client"), and **C logs "is an async Client Component. Only Server Components
can be async at the moment."** The development bundle's shared chunk is
421.6 KiB (128.9 KiB gzip), twice the production one, built in 49 ms.

### 14.8 `typing/`

`tsc -p typing` exits 0 on TypeScript 6.0.3: every `@ts-expect-error` line
is an error (a missing prop, a wrong prop type, an unknown view name, a
missing prop by name, wrong props to the typed `res.render`), and every other
line compiles (excess props and an `any` return pass, as §5.2 says). The
negative control, the naive overload pair, fails with "Unused
'@ts-expect-error' directive" on the `res.render` line.

---

## 15. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **The compat PR lands a different contract** (no `app.locals`, a different lookup, `res.render` without the C6 error path) | low: its harness asserts Express | every [C] point is listed in §2.4; PR-2 waits for it and re-reads it |
| **Two copies of React** (the application's and one a dependency brought) | medium in monorepos | peers only; the engine checks at startup that the view's `react` is the one `react-dom/server` uses, and fails with both paths |
| **`require.cache` deletion duplicates a shared module** in development | medium | only the views roots and `watch` dirs are dropped; documented; production never drops |
| **Streamed pages keep a fallback after a late error** without hydration | certain in stream mode | buffered is the default; stream mode logs and warns (§8.4) |
| **Props leak locals to the browser** when hydrating | certain unless filtered | `clientProps`; a development warning; README (§7.4) |
| **Hydration mismatch** from non-JSON props, `Date.now()`, locale | common | the development props check; React's `onRecoverableError` to the console |
| **`NODE_ENV` unset in production** runs React's development build | common | the startup warning (§10.1) |
| **A render blocks the event loop** (~1-3 ms per mid-size page, more for big ones) | inherent to SSR | caching (§10.3); `"string"` mode for hot sync views; measured, not guessed, in the bench |
| **The `compression()` stall** reaches other streamed bodies today | certain now | PR-0 first; the engine flushes per chunk regardless |
| **RSC expectations** | medium | §7.6 says plainly what is and is not supported |
| **Bun's TSX import, `fs.watch` or `Bun.build` behaviour changes** | low | each is a test in PR-2 to PR-4 |

---

## 16. Open questions for the user

Each has a recommended answer.

1. **A new package, or a bun-common subpath?** **A new package,
   `@kingsleyweb/bun-react-views`** (§11.1).
2. **Default render mode?** **Buffered** (§3.2): every React 19 server feature,
   and a real 500 on failure, for about 1.9 ms more CPU per mid-size render
   than `renderToString`; `"string"` stays available per view.
3. **`@types/react` as an optional peer, or required?** **Optional**, as
   `@types/bun` is (§11.2).
4. **No engine registered for `tsx`:** copy Express's `require("tsx")`, or a
   clear error? **A clear error in bun-common** ("No view engine is registered
   for .tsx: call engine('tsx', fn)"). Copying Express loads an unrelated npm
   package. This is the compat agent's decision; recommend it to them.
5. **`.jsx` and `.tsx` together:** Express needs the extension for the
   non-default one. **Keep Express's behaviour**; registering both is one line.
6. **Hydrated pages send locals to the browser:** default to sending every
   prop, or nothing but declared `clientProps`? **Every prop, with a
   development warning listing the locals sent**, because the client must
   render the same tree; `clientProps` narrows it.
7. **Nested layouts by file convention (`_layout.tsx`)?** **No**: the explicit
   `export const layout` chain (§6.1).
8. **HEAD in stream mode:** render buffered (headers as GET would send in
   buffered mode), or stream and let Bun cancel? **Buffered**, matching
   Express's HEAD.
9. **Move bun-jobs-ui onto the shared asset code?** **Later**, by the
   bun-jobs-ui agent, once PR-4 has settled the shape.
10. **A development error page** (`viewErrorPage()`, an error handler showing
    the message, the component stack and the view)? **Yes, development only,
    registered explicitly**; `ReactViewsModule` registers it when `dev` is on.
11. **Caching hydrated pages with a per-request nonce:** **leave to the cache
    plan**; the default is no CSP header, so the nonce only exists when the
    application asks for one.
12. **A React-views page in the playground?** **No**: the playground is
    bun-jobs' showcase. The examples cover this.
13. **Islands in the first release?** **No**: PR-5 after hydration has been
    used.
14. **`@RenderComponent` and `@RenderView` in bun-nest's `./react`, or in
    bun-react-views?** **bun-nest's `./react`** (the `./jobs` precedent; the
    decorators depend on bun-nest's `render` accepting a component).

---

## 17. PR slicing and effort

Focused days for someone who knows the code. Each PR passes the full gate
alone (`bun scripts/typecheck.ts`, `CI=1 bunx eslint .` in each touched
package, `bun run test`, the consumer check where `exports` change, and the
affected examples). Each PR that changes something the examples read is
reported to the examples agent before merging.

| PR | Ships | Depends on | Effort | [C] |
|---|---|---|---|---|
| **PR-0** | `zlibReadable` loops until it enqueues or ends; tests read compressed streams to the end | — | ~1 d | no |
| **PR-C** | (compat agent) bun-common's `engine`, `views`, `view engine`, `view cache`, `app.locals`, `res.render`; bun-nest's `@Render`, `setViewEngine`, `setBaseViewsDir`, `setLocal`, `engine` | — | in flight | — |
| **PR-1** | the `renderToStream` capability in `res.render`; `escapeHtml`, `jsonForScript`, `createNonce` in `native.ts` (replacing bun-common's two private copies) | PR-C | ~1.5 d | yes |
| **PR-2** | `packages/bun-react-views`: the engine (§3.5), modes, document and layouts, props, `onError` and logging, deadline, path containment, `preload`, the `NODE_ENV` warning, the registry types and `bun-react-views types`; dts recipe, consumer check | PR-C (PR-1 for stream mode) | ~4.5 d | yes |
| **PR-3** | development reload: watcher, `require.cache` invalidation, `liveReload` over SSE | PR-2 | ~1.5 d | no |
| **PR-4** | hydration: client entries, `Bun.build` once per process and `bun-react-views build`, the asset router, CSP and SRI, props transport and checks, `./client`, the Chrome e2e and a bundle budget | PR-2, PR-1 | ~4.5 d | no |
| **PR-5** | islands | PR-4 | ~2.5 d | no |
| **PR-6** | bun-nest `./react`: `ReactViewsModule`, `RenderComponent`, `RenderView`, `render()` accepting a component; consumer check with `peers` | PR-2, PR-C | ~2.5 d | yes |
| **PR-7** | `bench/` with `--compare`, baselines and the stall and TTFB assertions | PR-2 | ~1.5 d | no |
| *EX* | the examples of §13.2 (examples agent) | each PR | *~3 d* | |
| | **Total (this plan)** | | **~19.5 d** | |

**Order:** PR-0 now, in parallel with everything. After PR-C merges:
PR-1 ∥ PR-2 → (PR-3 ∥ PR-4 ∥ PR-6 ∥ PR-7) → PR-5. **PR-2 can start before
PR-C merges** against PR-C's branch, since its engine function is the Express
contract and runs against Express on Bun in the meantime [M, §14.6].

---

## 18. Names needing approval

Every new public name. None is built.

| Name | Kind | Where | Why this name |
|---|---|---|---|
| `@kingsleyweb/bun-react-views` | package | `packages/bun-react-views` | the family's `bun-` prefix; says what it renders |
| `reactViews(options)` | function | root | returns the engine, as `ejs.__express` or `mustacheExpress()` do |
| `ReactViewsOptions`: `mode`, `document`, `layout`, `hydrate`, `preload`, `dev`, `watch`, `liveReload`, `renderTimeout`, `assetsPath`, `csp`, `logger` | options | root | one word each, matching `jobsUi()`'s `dev` and `logger` |
| `"string" \| "buffered" \| "stream"` | `mode` values | root | what each sends |
| view module exports `default`, `layout`, `document`, `mode`, `hydrate`, `clientProps`, `cache` | conventions | view files | read by the engine |
| `ReactViews`, `ReactViewLocals` | augmentable interfaces | root | the registry and the locals, as `@types/express`'s `Locals` |
| `DefaultDocument`, `ViewAssets`, `Island` | components | root | — |
| `viewErrorPage()` | error handler | root | the development error page (§9.1) |
| `bun-react-views build`, `bun-react-views types` | CLI | `bin` | prebuild assets; write the registry |
| `@kingsleyweb/bun-react-views/client` | subpath | browser entry | the hydration runtime |
| `renderToStream` (optional member of an engine function) | engine capability | bun-common's view types | React's own verb |
| `escapeHtml`, `jsonForScript`, `createNonce` | functions | bun-common `native.ts` | moved from bun-jobs-ui's `shell.ts`, same names |
| `@kingsleyweb/bun-nest/react` | subpath | bun-nest | as `./jobs` |
| `ReactViewsModule` (`forRoot`, `forRootAsync`) | Nest module | bun-nest `./react` | Nest's module convention |
| `RenderComponent`, `RenderView` | decorators | bun-nest `./react` | beside Nest's `Render` |

---

## Appendix: evidence

[`evidence/react-views/`](evidence/react-views/README.md) holds every script
and its raw output, and a `package.json` of its own: `react`, `react-dom` and
`express` are installed there only. Like the other evidence folders, it is
not part of any package, and the repo's tooling does not typecheck or lint it.
