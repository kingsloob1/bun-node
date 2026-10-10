# bun-views: rendering UI components to HTML on the fly

Implementation plan for **`@kingsleyweb/bun-views`**: a view engine that
renders UI components to HTML per request, with a **framework-agnostic core
and one small adapter per framework, React first**. It plugs into
`@kingsleyweb/bun-common`'s view system (`res.render`, `engine()`, `views`)
and is **adopted in `@kingsleyweb/bun-nest`** (`@Render`, `setViewEngine`,
`setBaseViewsDir`). The user asked for it in two steps:

> "I also want a plan on how to have a view engine that renders react to html
> on the fly. The plan should include how it can be adopted in bun-nest as
> well."

and then, asked "should there be a bun-view package that handles rendering
react, vue, svelte, etc to html and can be used in both http adapters?":

> "Add the bun-view package to the plan."

This document began as the React views plan (`react-views.md`, merged in
#321) and was amended into this one on 2026-10-10. **Everything the React
plan measured and decided is kept**: it is now the core (§4) and the React
adapter (§5). What is new is the split, the adapter interface (§3), the
Vue, Svelte, Preact and Solid adapters as designed-for sections (§6 to §8),
and five spikes that run all five frameworks through one core (§12.9 to
§12.13).

Written 2026-10-10. **No product code was changed.** File references are at
`develop` `bbe11201` (the React plan's base) unless they say otherwise;
references to the engine contract are at `b7e20891`, where PR #320 merged.
The evidence is in [`evidence/bun-views/`](evidence/bun-views/README.md),
and each measurement there can be re-run with one command.

**The contract this builds on has landed.** PR #320 (the features agent's
Express-compatibility work for bun-nest) merged into `develop` at `b7e20891`:
bun-common now has `BunViews` (`packages/bun-common/lib/views.ts`) and
`BunResponse.render`, and bun-nest's adapter has `engine`, `setViewEngine`,
`setBaseViewsDir`, `setLocal` and `set` on Express's semantics. **bun-common's
own adapter and router do not have a `views` option yet**: that follow-up is
in progress on `fix/bun-common-express-parity` (not pushed at the time of
writing), and is listed below as PR-C2. §2.4 says exactly what this plan
takes from the contract.

### Status (2026-10-10)

| PR | Scope | State |
|---|---|---|
| PR-C (#320) | bun-common's `BunViews` and `res.render` on Express's contract; bun-nest `@Render`, `engine`, `setViewEngine`, `setBaseViewsDir` | **merged** (`b7e20891`) |
| PR-C2 | bun-common's adapter and router: a `views` option and `engine()` | in progress (`fix/bun-common-express-parity`), not merged |
| PR-0 | bun-common: the `compression()` stall on streamed bodies (§4.7.3) | not started; **found by the React plan** |
| PR-1 to PR-8 | this plan: the core, React, bun-nest | not started |
| PR-9v, PR-9s, PR-9p, PR-9so | Vue, Svelte, Preact, Solid adapters | **built on demand** (§15.2) |

### Contents

1. [Executive summary](#1-executive-summary)
2. [What exists today](#2-what-exists-today)
3. [One package: the core and its adapters](#3-one-package-the-core-and-its-adapters)
4. [The core](#4-the-core)
5. [The React adapter](#5-the-react-adapter)
6. [The Vue adapter (designed for, built on demand)](#6-the-vue-adapter-designed-for-built-on-demand)
7. [The Svelte adapter (designed for, built on demand)](#7-the-svelte-adapter-designed-for-built-on-demand)
8. [Preact and Solid (optional)](#8-preact-and-solid-optional)
9. [Packaging](#9-packaging)
10. [bun-nest adoption](#10-bun-nest-adoption)
11. [Tests and examples](#11-tests-and-examples)
12. [Measured evidence](#12-measured-evidence)
13. [Risks](#13-risks)
14. [Open questions for the user](#14-open-questions-for-the-user)
15. [PR slicing and effort](#15-pr-slicing-and-effort)
16. [Names needing approval](#16-names-needing-approval)

### How to read the markings

| Mark | Meaning |
|---|---|
| **[S]** | Read in this repo's source, or in a pinned dependency's source in `node_modules`. The `file:line` is given |
| **[M]** | Measured here by a spike that can be re-run. The evidence file is named |
| **[D]** | A design decision this plan proposes |
| **[I]** | Inference. A claim to test, never a finding |
| **[U]** | Unverified, from documentation or memory. Nothing may rest on it |
| **[C]** | Depends on the engine contract of PR #320 (§2.4), now merged |

---

## 1. Executive summary

### 1.1 The one-paragraph answer

**A new package, `@kingsleyweb/bun-views`, is a framework-agnostic view
engine core with one adapter per UI framework, each in its own subpath:
`@kingsleyweb/bun-views/react` first; `/vue`, `/svelte`, `/preact` and
`/solid` designed for and built when there is a real use.** Each framework is
an optional peer. The core holds everything that is not framework-specific:
it is an ordinary Express view engine, `fn(path, options, callback)`, so it
plugs into the view system PR #320 gave bun-common and bun-nest
(`app.engine("tsx", views.engine("tsx"))`, `setViewEngine`, `setBaseViewsDir`)
and works unchanged on real Express [M, §12.6, §12.9]. The core confines a
view to its roots, loads it by path (registering the adapter's compile step
with `Bun.plugin` where Bun cannot load the file itself), caches modules and
reloads them in development, merges the locals into props, wraps the
adapter's output in a document, streams through bun-common's `res.render`
with an optional `renderToStream` capability, and for hydrated views builds a
client entry per view with `Bun.build`, serves it with hashed names, SRI and
a per-request CSP nonce, and carries the props as XSS-safe JSON. **An adapter
is small**: a name, its file extensions, `render` to a string, an optional
`renderToStream`, an optional client entry, and an optional Bun plugin
(§3.2). Five adapters implement it in the evidence, through one core, and
each renders the same 200-card page, streams where the framework can,
rejects a throwing view, bundles a client entry and hydrates in Chrome
[M, §12.9, §12.12]. **React is the first adapter and is fully planned**: its
default mode is "buffered" (`renderToReadableStream` + `allReady`), because
it supports every React 19 server feature and still lets a failure become a
500; `"string"` and `"stream"` are opt-in (§5). **In bun-nest**, `@Render`
already works through PR #320; a subpath, `@kingsleyweb/bun-nest/views`,
adds a framework-agnostic `BunViewsModule` and `@RenderComponent(Component)`,
whose handler's return type is checked against the component's props for
React, Vue (`defineComponent`), Svelte and Solid, but **not** for a `.vue` or
`.svelte` file under plain `tsc`, which sees only the shim's `any` props
[M, §12.13].

**The React plan also found a bug in bun-common that must be fixed first:**
`compression()` stalls any streamed body whose chunks are too small for zlib
to emit output. The client receives only gzip's 10-byte header (brotli's
nothing) and waits forever [M, §4.7.3]. React's streamed Suspense page hits
it every time.

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| D1 | **The engine is Express's contract, `fn(path, options, callback)`, and nothing more for the string path.** [C] | It is what PR #320 built `res.render`, `@Render` and `setViewEngine` on (`packages/bun-common/lib/views.ts:35`, `ViewEngine`). The same function also works on real Express on Bun [M, §12.6, §12.9]. §4.1 |
| D2 | **React's default mode is "buffered": `renderToReadableStream` + `allReady`, collected to a string.** `"string"` and `"stream"` are opt-in, per engine or per view. | `renderToString` sends Suspense fallbacks and drops async component data [M, §12.2]. Buffered supports every React 19 server feature and still lets an error become a 500 before anything is sent. It costs about 1.9 ms more per render on the mid-size page (3.7 ms against 1.8 ms at the median) [M, §12.1]. §5.2 |
| D3 | **Streaming is an optional capability on the engine function**, used by `res.render` only when no callback is passed and the view streams. [C] | Express's callback takes a string, so streaming cannot go through it. A capability keeps the contract intact: an engine without one (EJS, Pug) behaves exactly as Express. §4.7.1 |
| D4 | **Views are imported by path.** Bun loads `.tsx`/`.jsx` natively; an adapter whose files Bun cannot load registers its compile step with `Bun.plugin`. In development a watcher drops the changed files' modules from `require.cache`; production caches them. | Query-string busting reloads only the entry module and leaks ~10 MB per 300 reloads; deleting `require.cache` entries reloads the graph with no measurable growth [M, §12.5]. §4.2 |
| D5 | **A whole document always**: React renders it itself (an engine-level `document` component, so React 19 hoists `<title>` and `<meta>`); for every other adapter the core's shell wraps the fragment and the head the adapter returns. | Hoisting needs `<html>` in React's tree [M, §12.2]. Vue, Svelte, Preact and Solid render into an element and report their head separately, or not at all [M, §12.9]. §4.5, §5.5 |
| D6 | **Props = `{ ...app.locals, ...res.locals, ...locals }` minus Express's `settings`, `_locals` and `cache`**, Express's merge order. [C] | It is what the engine receives [M, §12.6], and what `BunViews.render` builds (`views.ts:282`). Those three keys are Express plumbing, not props. §4.3 |
| D7 | **Hydration is opt-in per view** (`export const hydrate = true`), with a client entry per view generated by the adapter and bundled by the core with `Bun.build`. React hydrates the whole document; the other adapters hydrate the core's root element. Islands come later (PR-6, React first). | Most server-rendered pages need no client JS. A per-view entry keeps each page's bundle to what it uses. §4.6 |
| D8 | **Reuse `jobsUi()`'s machinery in the core**: hashed assets with SRI and `immutable` caching, a per-request nonce, `jsonForScript` for props, the in-memory build once per process with a `dist/` manifest for production, and a bundle budget test. | It is shipped and tested (`packages/bun-jobs-ui/lib/assets.ts:151`, `lib/shell.ts:16-46`, `lib/jobsUi.ts:552-620`). §4.6 |
| D9 | **The core refuses a resolved path outside the views roots.** | Express renders `../Secret` and absolute view names [M, §12.6], and PR #320's lookup copies Express (`views.ts:129-150`). A view module is code, so a traversal there runs it. §4.8.3 |
| D10 | **One package, `@kingsleyweb/bun-views`**: the core at the root, each framework at a subpath (`./react`, later `./vue`, `./svelte`, `./preact`, `./solid`), every framework an **optional** peer. bun-common gains no framework code. | The user's decision. The core is most of the work and identical for every framework (§3.1); a package per framework would copy it. Optional peers keep a Vue user from installing React. §9 |
| D11 | **bun-nest's view pieces live in a subpath, `@kingsleyweb/bun-nest/views`**, with bun-views as an optional peer, as `./jobs` does with bun-jobs. | The precedent already passes the consumer check's `peers` rule (CLAUDE.md, "Packaging types"). §10 |
| D12 | **`@RenderComponent(Component)` stores the component itself under Nest's `RENDER_METADATA`.** | Nest passes that metadata to `applicationRef.render(response, template, result)` after checking only that it is truthy [S, `@nestjs/core/router/router-execution-context.js:92,159-162`]. §10.3 |
| D13 | **The core passes its own `onError` to the adapter and logs through the router's logger.** | Without it, React prints every render error's stack with `console.error` [M, §12.3], and Vue's production build **swallows** a throwing view (below). CLAUDE.md's logging rule: `logger.error("message", { error })`. §4.8.1 |
| D14 | **In stream mode, the core flushes after every chunk.** | Under `compression()`, the first byte of a Suspense page then arrives in ~7 ms instead of ~54 ms buffered, for 16% more bytes [M, §12.3]. It also sidesteps the stall until PR-0 lands. §4.7.3 |
| D15 | **The adapter interface is small and fixed before the second adapter** (§3.2): `name`, `extensions`, `render`, and optional `renderToStream`, `clientEntry` and `plugin(side)`. `render` returns either a whole document or a fragment with its head. | It held for five frameworks through one core, with one shape change (document or fragment) forced by Vue, Svelte, Preact and Solid [M, §12.9]. §3.6 |
| D16 | **One adapter per extension per views instance**, chosen by the extension, as Express chooses an engine. React, Preact and Solid all claim `.tsx`, so an application uses one of them for `.tsx` (or names another extension). | PR #320 maps an extension to one engine (`views.ts:267`). Bun's JSX runtime is per file (a pragma) and Solid's compile step is a plugin filtered by path [M, §12.9]. §3.4 |
| D17 | **An adapter must turn every render failure into a rejection**, and leave nothing behind. The adapter tests assert it for a throwing view. | Vue 3.5's production build logs a throwing `setup()` and resolves `"<!---->"`, a 200 with an empty page, unless an `errorHandler` is set; its development build rejects [M, §12.11]. Solid's `renderToStringAsync` leaves a 30 s timer that rejects, unhandled, after a throwing view [M, §12.11]. |
| D18 | **Each adapter ships its compile step** (`plugin(side)`), written for SSR, rather than depending on a community plugin. | The only Vue plugin for Bun that is maintained compiles client render functions only, so SSR through it is 2.2 times slower; it also imports `typescript` without declaring it and registers itself on import [M, §12.10; S]. The official `bun-plugin-svelte` works but cannot pass Svelte's async option [M, S]. §6.2, §7.2 |

### 1.3 What it costs

| Part | Effort | Owner | Depends on |
|---|---|---|---|
| PR-0: the `compression()` stall | ~1 d | bun-common agent | — |
| PR-1: bun-common hooks (the stream capability in `res.render`, shared escape helpers) | ~1.5 d | bun-common agent | PR-C (merged) |
| PR-2: the core (adapter interface, engine, loading, props, shell, errors, containment, types, packaging) | ~3.5 d | features agent | PR-C |
| PR-3: the React adapter (modes, document and layouts, React's errors and types) | ~2.5 d | features agent | PR-2 |
| PR-4: development reload | ~1.5 d | features agent | PR-2 |
| PR-5: hydration (client entries, assets, CSP, props; React's entry) | ~5 d | features agent | PR-3, PR-1 |
| PR-6: islands (React) | ~2.5 d | features agent | PR-5 |
| PR-7: bun-nest `./views` | ~3 d | bun-nest agent (or features) | PR-3, PR-C |
| PR-8: benchmark and regression guard | ~1.5 d | features agent | PR-3 |
| **Total, core and React** | **~22 d** | | |
| Later, on demand: PR-9v Vue ~4 d, PR-9s Svelte ~3 d, PR-9p Preact ~1.5 d, PR-9so Solid ~3 d | ~11.5 d | features agent | PR-5 |
| Examples (per PR, the examples agent) | ~3.5 d, +1 d per later adapter | examples agent | each PR |

The React plan's ~19.5 d becomes ~22 d: the core is built for adapters
(the interface, the shell, per-adapter compile steps and client builds),
which costs about 2.5 d more than a React-only engine. §15 has the order and
what each PR proves.

---

## 2. What exists today

### 2.1 bun-common: `BunViews`, `res.render`, and an adapter that sends a file

Since PR #320 (`b7e20891`):

- **`BunViews`** [S, `packages/bun-common/lib/views.ts:202`] is Express's
  view system: `root` (the `views` setting, a string or an array, default
  `./views`), `defaultEngine` (`view engine`), `cache` (`view cache`, on
  under `NODE_ENV=production`), `engines` by extension, `locals`
  (`app.locals`), `viewOptions`, a `settings` getter, `engine(ext, fn)`
  (`:267`) and `render(name, options, callback)` (`:282`). The lookup is
  Express's `View` step for step: `<root>/<name>.<ext>`, then
  `<root>/<name>/index.<ext>`, root by root (`:71-150`).
- **A script extension with no engine is refused** instead of loaded:
  `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` and `.tsx` throw `No
  view engine registered for ".tsx": register one with engine("tsx", fn).`
  [S, `views.ts:59-68`, `:106-114`]. This settles the React plan's open
  question about Express's `require("tsx")`.
- **`BunResponse.render(view, locals?, callback?)`** renders through the
  `views` the response was constructed with, or a default `BunViews`
  [S, `packages/bun-common/lib/BunResponse.ts:2447-2480`, option at `:1040`].
  Without a callback the HTML is sent as `text/html; charset=utf-8` and an
  error goes to `next(err)`, or a 500 with no pipeline.
- `BunViews`, `ViewEngine`, `RenderCallback` and `RenderLocals` are exported
  from the root [S, `lib/index.ts:352-355`].
- **bun-common's own `BunHttpAdapter.render(response, view, options)` still
  sends the file at `view`** (`Bun.file(view)`) [S,
  `packages/bun-common/lib/BunHttpAdapter.ts:1342-1346`], and neither it nor
  `BunRouter` takes a `views` option. PR-C2 (in progress) adds one. Until it
  lands, a bun-common application constructs a `BunViews` and hands it to its
  responses, or renders through the engine function directly.
- `send(body)` streams a `ReadableStream`, a Node `Readable` or an async
  iterable [S, `BunResponse.ts:1739-1855` at `bbe11201`]; `res.flush()`
  flushes what a response transform holds; `compression()` compresses a
  streamed body as it is read and flushes after every chunk only for
  `text/event-stream` [S, `lib/compression.ts:932-1007`, `:1017`,
  `:1347-1363` at `bbe11201`].
- `escapeHtml` exists twice, privately, in `BunHttpAdapter.ts:110` and
  `serveStatic.ts:125` [S, `bbe11201`].

### 2.2 bun-nest: `@Render` on Express's semantics

Since PR #320, bun-nest's adapter has a `views: BunViews`
[S, `packages/bun-nest/lib/BunHttpAdapter.ts:197`], `render(response, view,
options)` calls `response.render(view, options)` (`:1253-1259`), and
`setViewEngine` (`:3189`), `setBaseViewsDir` (`:3199`), `engine` (`:3208`),
`setLocal` and `set` (the view settings only) set it, as
`@nestjs/platform-express` does.

How Nest reaches the adapter [S, `@nestjs/core` 11.1.27]:

- `@Render(template)` stores `template` under `RENDER_METADATA`
  (`"__renderTemplate__"`) on the method
  (`@nestjs/common/decorators/http/render.decorator.js:16-18`). Its type says
  `string`.
- The handler's result passes through every interceptor first, and the
  response is handled after (`router/router-execution-context.js:46-48`).
- If the method has render metadata, the handler is answered by
  `responseController.render(result, res, template)` (`:159-162`), which
  awaits the result and calls `applicationRef.render(response, template,
  result)` (`router/router-response-controller.js:27-30`). Nothing checks that
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

### 2.4 The engine contract, and what this plan takes from it [C]

PR #320 follows Express 5 step for step (its header comment,
`views.ts:1-20`). What this plan needs:

| # | Contract point | Where | Used by |
|---|---|---|---|
| C1 | `engine(ext, fn)` registers `fn(path, options, callback)` for an extension; a leading dot is optional | `views.ts:267-273`; Express `application.js:294-308` | the whole plan |
| C2 | `views` (a string or an array of roots) and `view engine` (the default extension); bun-nest's `setBaseViewsDir` and `setViewEngine` set them | `views.ts:208-215`; bun-nest `BunHttpAdapter.ts:3189-3203` | §4.2.3 |
| C3 | Lookup: `<root>/<name>.<ext>`, then `<root>/<name>/index.<ext>`, root by root; a name with an extension picks that extension's engine | `views.ts:71-150`; Express `view.js:52-95` | §4.2.3 |
| C4 | `options` = `{ settings, ...app.locals, ...res.locals, ...locals }`, plus `_locals` and `cache` | `views.ts:296-305`; `BunResponse.ts:2447-2465` | §4.3 |
| C5 | `cache` is the `view cache` setting, on when `NODE_ENV=production` | `views.ts:222`, `:304` | §4.2.2 |
| C6 | `res.render(view, locals?, callback?)`: with no callback the string is sent and an error goes to `next(err)`, so the error handlers answer it | `BunResponse.ts:2466-2479` | §4.8.1 |
| C7 | An engine's callback is forced async | `views.ts:154-164` | — |
| C8 | A script extension with no registered engine throws a clear error (not Express's `require(ext)`) | `views.ts:106-114` | §4.2.3 |

**What this plan adds to that contract** is one optional member on the engine
function, `renderToStream` (§4.7.1). PR #320 landed without it; PR-1 adds
it, a few lines in `BunResponse.render`.

**What it does not change:** the lookup itself. The views roots confinement
(D9) is the core's, not `BunViews`'s, because Express does not confine and
#320 matches Express for every engine; §14 Q4 asks whether bun-common should
confine for all engines instead.

---

## 3. One package: the core and its adapters

### 3.1 What is framework-agnostic, and what is not [D]

Most of the React plan never depended on React. Sorted by where it now lives:

| Concern | Core | Adapter |
|---|---|---|
| The Express engine function and the `renderToStream` capability | ✓ (§4.1, §4.7.1) | — |
| View lookup, extension to adapter, root confinement | ✓ (§4.2.3, §4.8.3) | declares its `extensions` |
| Loading a view by path, the module cache, `preload`, development reload | ✓ (§4.2) | supplies the compile step (`plugin`) when Bun cannot load the file |
| Locals merged into props; the typed view registry | ✓ (§4.3, §4.4) | a props resolver for `@RenderComponent` (§4.4.2) |
| The document shell around a fragment; the head it reports | ✓ (§4.5) | returns `{ head, body }`, or a whole document (React) |
| Render to a string | — | ✓ `render` (required) |
| Render to a stream | flush per chunk, HEAD, deadline (§4.7) | ✓ `renderToStream` (optional) |
| Errors: logging, the 500, the development error page, the deadline | ✓ (§4.8) | turns every failure into a rejection (D17) |
| XSS-safe props, the CSP nonce, SRI | ✓ (§4.6.4, §4.6.5) | passes the nonce to inline scripts the framework emits |
| Per-view client bundles with `Bun.build`, hashed assets, the asset router, `dist/` and the manifest | ✓ (§4.6.3) | ✓ `clientEntry` (the hydration call) and `plugin("client")` |
| `NODE_ENV` warning, caching hooks, the benchmark guard | ✓ (§4.9) | — |
| bun-nest: `BunViewsModule`, `@RenderComponent`, `@RenderView` | ✓ (§10) | the props resolver |
| Modes (`string`/`buffered`/`stream`), documents and layouts, React 19 hoisting, islands, RSC | — | React's (§5) |

So the adapter is three functions and a plugin, and everything a user
configures once (roots, assets, CSP, reload, logging, the deadline) is the
core's, the same for every framework.

### 3.2 The adapter interface [D] [M]

As the spikes implement it (`evidence/bun-views/core/interface.ts`), which
five adapters satisfy (§3.5):

```ts
import type { BunPlugin } from "bun";

/** Which side a compile step is for: server imports, or the client bundle. */
export type ViewSide = "server" | "client";

/** What the core hands an adapter for one render. */
export interface RenderInput<C = unknown> {
  /** The view module's default export. */
  component: C;
  /** The whole view module, for adapter-specific named exports (React's `document`, `layout`, `mode`). */
  module: Record<string, unknown>;
  /** The props: merged locals without Express's plumbing keys. */
  props: Record<string, unknown>;
  /** A per-request CSP nonce, for every inline script the framework emits. */
  nonce?: string;
  /** Aborts a render that outlives its deadline. */
  signal?: AbortSignal;
  /** Errors the framework reports without throwing (React's Suspense boundaries). */
  onError?: (error: unknown) => void;
  /**
   * For an adapter whose output is a whole document (React): the client entry
   * and the props script, which only it can place. A fragment adapter ignores
   * both; the core's shell places them.
   */
  bootstrap?: { src: string; integrity: string; propsScript: string };
}

/** A whole document the adapter built, or a fragment and its head tags for the core's shell. */
export type RenderOutput =
  | { kind: "document"; html: string }
  | { kind: "fragment"; head: string; body: string };

/** A streamed render; the promise resolves once the first part is ready. */
export type StreamOutput =
  | { kind: "document"; stream: ReadableStream<Uint8Array> }
  | { kind: "fragment"; head: string; body: ReadableStream<Uint8Array> };

/** What the core asks of a client entry. */
export interface ClientEntryInput {
  /** The view file, absolute. */
  viewPath: string;
  /** The global the core's props script assigns (`self.__BV_PROPS`). */
  propsGlobal: string;
  /** The element a fragment adapter hydrates into (`#bv-root`). */
  rootId: string;
}

/** One UI framework, as the core sees it. */
export interface ViewAdapter<C = unknown> {
  /** `"react"`, `"vue"`, …: in logs and errors. */
  readonly name: string;
  /** The view extensions it renders, with the dot. */
  readonly extensions: readonly string[];
  /**
   * The compile step for files Bun cannot load (`.vue`, `.svelte`, Solid's JSX):
   * registered with `Bun.plugin` for server imports, passed to `Bun.build` for
   * the client bundle. Absent when Bun loads the views natively (React, Preact).
   */
  plugin?: (side: ViewSide) => BunPlugin;
  /** Renders to a whole string. Required. */
  render: (input: RenderInput<C>) => Promise<RenderOutput>;
  /** Renders to a stream. Optional: Svelte has none. */
  renderToStream?: (input: RenderInput<C>) => Promise<StreamOutput>;
  /** The source of the hydration entry for one view, bundled by the core. Optional. */
  clientEntry?: (input: ClientEntryInput) => string;
}
```

Five members, three optional. What is deliberately **not** in it:

- **No head API.** React hoists `<title>` itself; Vue reports
  `<Teleport to="head">` content, Svelte reports `<svelte:head>`, Solid its
  hydration script, all through the fragment's `head`. A framework without
  head management (Preact, Solid without `@solidjs/meta`) returns `""`, and a
  view sets its title through the core's `title` local (§4.5).
- **No layouts.** Each framework composes components its own way; React's
  `export const layout` chain is React's (§5.5). The core wraps only the
  document.
- **No build configuration beyond the plugin.** A plugin may set `define` and
  `conditions` on `build.config` in its `setup()`, and `Bun.build` honours
  both [M, a probe on 1.4.3: a `define` added in `setup()` replaced its
  identifier in the output]. Vue's compile-time flags travel that way
  (`adapters/plugins/vue-sfc.ts`), so the interface needs no `define` member.
  (`bun-plugin-vue3` says in a comment that this does not work in Bun; on
  1.4.3 it does.)

### 3.3 React's implementation [M]

The whole React adapter in the evidence is 50 lines
(`evidence/bun-views/adapters/react.tsx`); the planned one adds modes per
view, layouts and React's types (§5). Its shape:

```ts
export function react({ mode = "buffered" } = {}): ViewAdapter<ComponentType<Props>> {
  return {
    name: "react",
    extensions: [".tsx", ".jsx"],
    // no plugin: Bun loads .tsx and .jsx itself
    async render(input) {
      if (mode === "string" && !input.bootstrap) {
        return { kind: "document", html: `<!DOCTYPE html>${renderToString(tree(input))}` };
      }
      const stream = await renderToReadableStream(tree(input), {
        nonce: input.nonce, signal: input.signal, onError: input.onError,
        bootstrapScriptContent: input.bootstrap?.propsScript,
        bootstrapModules: input.bootstrap && [{ src: input.bootstrap.src, integrity: input.bootstrap.integrity }],
      });
      await stream.allReady;
      return { kind: "document", html: await new Response(stream).text() };
    },
    async renderToStream(input) {
      return { kind: "document", stream: await renderToReadableStream(tree(input), options(input)) };
    },
    clientEntry: ({ viewPath, propsGlobal }) => `
      import { hydrateRoot } from "react-dom/client";
      import { DefaultDocument } from "@kingsleyweb/bun-views/react/document";
      import View from ${JSON.stringify(viewPath)};
      hydrateRoot(document, <DefaultDocument><View {...self.${propsGlobal}} /></DefaultDocument>);`,
  };
}
// tree(input) = <Document><Layouts><View {...props} /></Layouts></Document>
```

React is the one **document** adapter: it renders `<html>` itself, so it is
the one that places the bootstrap scripts (React writes them, nonce'd, with
`modulepreload` [M, §12.2]). Every other adapter returns a fragment.

### 3.4 How the core uses an adapter [D]

```ts
import { createViews } from "@kingsleyweb/bun-views";
import { react } from "@kingsleyweb/bun-views/react";

const views = createViews({
  adapters: [react({ mode: "buffered" })],
  hydrate: false,             // per-view override: export const hydrate
  assetsPath: "/_views/assets",
  logger,                     // LoggerLike; defaults to the router's
});

// bun-nest today (PR #320), and bun-common once PR-C2 lands:
app.engine("tsx", views.engine("tsx"));
app.setBaseViewsDir("views");
app.setViewEngine("tsx");
// or all of it at once, every adapter's extensions:
views.install(app);           // engine() per extension, plus the asset router
```

- **An extension belongs to one adapter** (D16), because an Express engine
  belongs to one extension (`views.ts:267`). `createViews` refuses two
  adapters claiming the same one, naming both. React, Preact and Solid all
  default to `.tsx` and `.jsx`; an application that really wants two of them
  gives one another extension (`preact({ extensions: [".ptsx"] })`) [I: Bun
  picks a loader by extension, so a new one needs the plugin to load it as
  `tsx`; untested].
- **`Bun.plugin` is process-wide** and cannot be removed: the server compile
  step of every adapter in use is registered once, at `createViews`, and
  every later import of a matching file goes through it, the application's
  own imports included. So an adapter's plugin filters by extension
  (`.vue`, `.svelte`) or, for Solid's `.tsx`, by the views roots
  (`solid({ filter })`, default: under the roots) [M, the Solid adapter's
  filter left React's `.tsx` views to Bun in the same process, §12.9].
  Registering it before the first view import is the core's job; an import
  of a `.vue` file before `createViews` fails as Bun cannot load it [I].
- **The client compile step is per build**: `Bun.build({ plugins: [entries,
  adapter.plugin("client")] })`, so it touches nothing else.

### 3.5 What five adapters proved against the interface [M]

Each spike adapter renders the same catalogue page (200 cards, ~98 KB),
through the same core (`evidence/bun-views/core/mini-core.ts`), in one
process [M, `frameworks-ssr.ts`, `frameworks-hydrate.ts`, §12.9, §12.12;
Bun 1.4.3, `NODE_ENV=production`]:

| | React 19.3 | Vue 3.5.43 | Svelte 5.57.2 | Preact 11.0.1 | Solid 1.9.17 |
|---|---|---|---|---|---|
| Compile step | none | plugin (`vue/compiler-sfc`) | plugin (`svelte/compiler`) | none (`@jsxImportSource` pragma) | plugin (Babel, `babel-preset-solid`) |
| First view, cold (compiler warm-up) | 1.3 ms | 321 ms | 51 ms | 3.1 ms | 89 ms |
| A second view, cold | 0.4 ms | 4.4 ms | 9.1 ms | 0.3 ms | 9.0 ms |
| Render p50 / p90, catalogue, string | 2.96 / 5.18 ms (buffered); 1.53 / 2.75 (string) | 1.00 / 1.73 ms | 0.64 / 1.15 ms | 2.20 / 4.09 ms | 0.76 / 1.32 ms |
| Output | document | fragment + head | fragment + head | fragment | fragment + hydration script |
| `<title>` in `<head>` | ✓ hoisted | ✓ string; ✗ stream | ✓ | ✗ (no head) | ✗ (no head) |
| 50 ms async data, string render | waits (Suspense + `use`) | waits (async `setup` in `<Suspense>`) | **fallback** (`{#await}`); waits with `experimental.async` | waits (`lazy` + Suspense) | waits (`createResource`) |
| Stream: first card / last byte, 50 ms data | 9.7 / 59 ms (shell incl. cards) | 4.6 / 51 ms, in order, no fallback | — (none) | 7.9 / 51 ms, fallback then swap | 3.6 / 51 ms, fallback then swap |
| A throwing view | rejects | rejects **only with an `errorHandler`** | rejects | rejects | rejects (timer leak worked around) |
| Client entry, minified (Counter) | 207 KiB (65 gzip) | 77 KiB (31 gzip) | 49 KiB (18 gzip) | 14 KiB (6 gzip) | 16 KiB (6 gzip) |
| Hydrates in Chrome, click works, no CSP violation | ✓ | ✓ | ✓ (with our compile step; the official plugin hydrates after "Failed to hydrate", §7.2) | ✓ | ✓ |
| Express 5 `res.render` through the core's engine | ✓ | ✓ (and a 500 for a throwing view) | ✓ | — | — |

Render times are 500 iterations rotating across the six configurations on a
shared machine (load 5 to 7) and compare within the run only. They measure
the frameworks, not the core: the core adds a string concatenation for a
fragment. React's buffered figure is its default mode's, the others' are
their string render. **No ranking of frameworks is intended**: the page is a
plain list, the shapes differ (Solid's output is 14% larger, its hydration
keys), and every framework is well under the React plan's ~550 renders per
core per second ceiling.

### 3.6 What forced a change in the interface [M] [D]

The React plan's engine needed no interface. Running four more frameworks
through one core changed the shape in these places, and in no others:

1. **Document or fragment.** React renders `<html>` and must, for hoisting
   and whole-document hydration. Vue, Svelte, Preact and Solid render into an
   element and hydrate an element (`createSSRApp().mount("#root")`,
   `hydrate(View, { target })`, Solid's `hydrate(fn, el)`). So `render`
   returns `{ kind: "document" }` or `{ kind: "fragment", head, body }`, and
   the core owns a shell for the second. This is the one real change.
2. **The head travels with the fragment**, and may only be known at the
   end. Vue's teleports are filled once `renderToString` has finished; in
   `renderToWebStream` they are not available when the body starts, so a
   streamed Vue page has no `<title>` in its `<head>` [M, §12.9]. The fragment
   stream therefore carries a `head` known up front (possibly empty), and the
   Vue adapter documents that a streamed view sets its title through the
   core's `title` local. A head emitted at the end would need the core to
   hold the body until then, which is the buffered mode.
3. **The bootstrap scripts belong to whoever writes `<body>`**: the core for
   a fragment, the adapter for a document. Hence `bootstrap` in
   `RenderInput`, used by React only.
4. **The compile step has two sides and one factory.** Vue compiles a
   template to SSR string-push functions on the server and to render
   functions on the client; Solid to `ssr` or `dom` output; Svelte to
   `generate: "server"` or `"client"`. `plugin(side)` returns one plugin per
   side. A plugin's `setup()` can also set `define` and `conditions`, so no
   other build member was needed.
5. **Errors are a contract, not a shape** (D17). Two frameworks do not
   reject on their own: Vue's production build swallows a throwing view
   unless an `errorHandler` is set, and Solid's `renderToStringAsync`
   leaves a timer behind. Each adapter fixes its own, and the adapter
   conformance test (§11.1) asserts it for every adapter.

What did **not** force a change: Svelte's `render()` being synchronous and
also awaitable (`render` is `async` anyway), Svelte having no stream
(`renderToStream` is optional, and the core renders the string), Solid's
hydration script (it is part of the fragment's head), and the CSP nonce
(Svelte takes it as `csp: { nonce }`, Solid as `nonce`, React as `nonce`;
Vue and Preact emit no inline script).

---

## 4. The core

Everything in this section is framework-agnostic: the React plan's design,
with "the engine" now meaning the core, and React's specifics moved to §5.

### 4.1 The engine function [D] [C]

`views.engine(ext)` returns an ordinary Express engine for one extension, the
adapter that claims it behind it, plus the optional `renderToStream` member
(§4.7.1). Per call, the core:

1. **Checks the path** is inside a `settings.views` root (§4.8.3).
2. **Loads the module** (§4.2): a registry hit after the first time; the
   adapter's server compile step is registered once, at `createViews`.
3. **Resolves the component**: the default export; a module without one is an
   error naming the file (Express's behaviour is a generic error, [M]).
4. **Builds props** (§4.3).
5. **Renders** through the adapter, with the core's `onError`, the nonce and
   the client entry when hydrating, and an abort deadline.
6. **Wraps a fragment** in the shell (§4.5), or takes a document as is.
7. **Calls back** with the HTML, or with the error.

Measured with five adapters on real Express 5 on Bun, an engine per
extension (`app.engine("vue", engine(vue))`, …): each view renders, the
props are the merged locals, an injected `</script>` is escaped, and a
throwing Vue view is a 500 through Express's error path [M, §12.9].

### 4.2 Loading views on the fly

#### 4.2.1 Importing a view [M]

Bun imports a `.tsx` or `.jsx` file by path with no configuration:
transpiled on first import, then held in the module registry
[M, `view-loading.ts`, `results-view-loading.txt`]:

| | Time |
|---|---|
| Cold import of a React view and the layout it imports | 62 ms |
| Warm import (registry hit) | 0.08 ms |

A file Bun cannot load goes through the adapter's compile step, registered
with `Bun.plugin`. The first such file pays for loading the compiler, the
next ones only for compiling [M, §12.9]:

| | First view (compiler warm-up) | A second view |
|---|---|---|
| Vue (`vue/compiler-sfc`) | 321 ms (190 to 320 across runs) | 4.4 ms |
| Svelte (`svelte/compiler`) | 51 ms | 9.1 ms |
| Solid (Babel) | 89 ms | 9.0 ms |
| React, Preact (Bun's own transpiler) | 1.3 ms, 3.1 ms (the framework already loaded) | 0.4 ms, 0.3 ms |

The cold cost is paid once per view per process. **[D] `preload: true`**
imports every view under the roots at startup, so no request pays it; it is
the default when `NODE_ENV=production`, and it matters most for Vue.

A view and the core must resolve **the same copy of the framework**, or
hooks and reactivity fail; the scratch views in the evidence reach it through
a symlink, which Bun resolves to one real path [M]. For React the
application's `tsconfig.json` sets `jsx: "react-jsx"`; Preact views use
`/** @jsxImportSource preact */`, which Bun honours per file [M, a probe and
§12.9].

#### 4.2.2 Development reload versus production [M] [D]

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
change, the core deletes **every** `require.cache` entry under the watched
directories, not only the changed file, because it cannot see which modules
import which without a graph. The next render re-imports what it needs, and a
compile step runs again through the same `Bun.plugin` [I: measured for `.tsx`
only; PR-4 tests a `.vue` reload, and PR-9v and PR-9s each repeat it].
Optionally (`liveReload: true`, PR-4), an SSE endpoint tells open pages to
reload, and the client bundles (§4.6) are invalidated.

**[D] Production** (`options.cache` true): nothing is watched or deleted;
modules stay in the registry for the life of the process.

`Bun.build` per view gives an exact graph from its metafile (the inputs to
watch) and costs ~13 ms per rebuild [M], but it writes a file per build and
moves views into a build output. It is kept for a precompile option (§4.2.4),
not for development.

`bun --hot` reloads the whole module graph on any change while keeping
`globalThis` [U, Bun's documentation]. The core needs nothing from it and
must not break under it: its caches are module-level, so `--hot` empties them
too [I]. PR-4 tests both.

**The hazard [I]:** deleting a module from `require.cache` that something
outside the views also imported (a context module, a store) gives the next
view a second instance. Watching only the views roots and the directories
named in `watch` keeps shared modules out of it; the README says so.

#### 4.2.3 Resolution: roots, extensions and exports [C] [D]

Resolution is `BunViews`' lookup (C3), not the core's: the core receives a
resolved absolute path.

- **`setBaseViewsDir("views")` / `set("views", …)`** sets the roots; an array
  is searched in order.
- **`setViewEngine("tsx")`** makes `"users/Profile"` mean
  `views/users/Profile.tsx`, then `views/users/Profile/index.tsx`
  [M, a directory renders its `index.tsx`, §12.6].
- **A second extension** (`.jsx` beside `.tsx`, or `.vue` beside `.tsx` with
  two adapters): register the engine for each; a view of the non-default one
  is named with its extension (`"Legacy.jsx"`, `"Card.vue"`). Without the
  extension Express looks only for the default one and fails ("Failed to
  lookup view") [M]. §14 Q5.
- **No engine registered for `.tsx`:** PR #320 throws a clear error rather
  than loading the npm package `tsx` (C8). `views.install(app)` registers
  every adapter's extensions, so it does not arise.
- **Exports [D]:** the default export is the view. The core reads these named
  exports from the same module, for every adapter: `hydrate`, `clientProps`,
  `cache`, `title`. An adapter may read more (React: `layout`, `document`,
  `mode`, §5). A module with no default export is an error naming the file.
  For a `.vue` file the named exports come from a plain `<script>` block
  beside `<script setup>`; for a `.svelte` file from `<script module>` [U,
  each framework's documentation; untested in the spikes].

#### 4.2.4 Precompiling (optional) [D]

Not needed for correctness or speed in a long-lived server (the cold import
happens once). It matters for a short-lived process (serverless), to fail a
deploy on a type or syntax error early, and to skip a compiler's warm-up
(321 ms for Vue's). `bun-views build` (PR-5) writes, per view, the client
bundle and manifest (§4.6.3) and optionally a server bundle via `Bun.build({
target: "bun", packages: "external", plugins: [adapter.plugin("server")] })`
[M for React, ~13-22 ms per view; I for the compiled frameworks]. The core
prefers a server bundle when the manifest lists one, as `jobsUi()` prefers
`dist/`, and the same `dev` switch overrides it.

### 4.3 Data and props [C] [D]

The core receives Express's merged object (C4). Measured on Express 5.3: for
`res.render("Hello", { name })` with `app.locals.appName` and
`res.locals.user` set, the keys are `settings, appName, user, name, _locals,
cache` [M, §12.6]. PR #320 builds the same (`views.ts:296-305`). Precedence,
last wins: `app.locals`, `res.locals`, the `locals` argument.

**[D] Props are that object without `settings`, `_locals` and `cache`.** The
view therefore sees app-wide and request locals as ordinary props (a `user`
set by an auth middleware, an `appName`), which is what a template engine
user expects. Every adapter passes them as the root component's props:
React's and Preact's element props, Vue's `createSSRApp(View, props)`,
Svelte's `render(View, { props })`, Solid's `createComponent(View, props)`
[M, §12.9].

### 4.4 Typing views [M] [D]

#### 4.4.1 By name: the registry

What TypeScript can and cannot enforce [M, `typing/typing.type-test.tsx`,
`results-typing.txt`; TypeScript 6.0.3, `experimentalDecorators`]:

- **A string view name carries nothing** unless something maps names to
  props. An augmentable registry does, for every framework alike:

  ```ts
  declare module "@kingsleyweb/bun-views" {
    interface Views { "users/Profile": ProfileProps }
    interface ViewLocals { user?: SessionUser; appName: string }
  }
  ```

  `@RenderView("users/Profile")` and a typed `res.render` then check the
  props, and a misspelt name is an error.
- **Locals are subtracted.** The handler returns `Omit<Props, keyof
  ViewLocals>`, so a prop supplied by `app.locals` need not be returned.
- **The overload trap:** a typed `res.render(view, props)` beside the untyped
  Express one, `render(view: string, locals?: object)`, enforces **nothing**:
  wrong props simply match the untyped overload [M, the negative control in
  `results-typing.txt`]. The fix: the untyped overload refuses a registered
  name (`view: V extends keyof Views ? never : V`). A dynamic `string` still
  takes it.
- **What it cannot enforce:** excess props (structural typing), a handler
  typed `any`, an interceptor that reshapes the result (§10.5), and a
  registry that drifts from the files on disk. **[D] PR-2 adds `bun-views
  types`**, which writes the registry from the views directories (each view's
  default export's props, through the adapter's resolver below), and a test
  that fails on drift, the way `generate-verb-overloads.ts --check` does for
  routes. For `.vue` and `.svelte` files it can only write what their
  language tools report (§4.4.3).

#### 4.4.2 By component: a props resolver per adapter

`@RenderComponent(Component)` checks the handler's return type against the
component's props. One `PropsOf<C>`, resolved through an interface each
adapter subpath augments, works across frameworks [M, `frameworks-typing/`,
§12.13; `tsc` exit 0, every negative control an error]:

```ts
// in @kingsleyweb/bun-views:
export interface ComponentPropsOf<C> {}
export type PropsOf<C> = ComponentPropsOf<C>[keyof ComponentPropsOf<C>];

// in @kingsleyweb/bun-views/react (and likewise each subpath):
declare module "@kingsleyweb/bun-views" {
  interface ComponentPropsOf<C> { react: C extends ComponentType<infer P> ? P : never }
}
// vue:    C extends new (...args: any[]) => { $props: infer P } ? P : never
// svelte: C extends Component<infer P> ? P : never        (svelte)
// solid:  C extends Component<infer P> ? P : never        (solid-js)
// preact: C extends FunctionComponent<infer P> ? P : never (preact)
```

| Component | Wrong prop type | Missing prop |
|---|---|---|
| React `ComponentType<P>` | error ✓ | error ✓ |
| Vue `defineComponent({ props })` in a `.ts` file | error ✓ | error ✓ |
| Svelte `Component<P>` | error ✓ | — |
| Solid `Component<P>` | error ✓ | — |
| Preact `FunctionComponent<P>`, with no Preact resolver | every call an error (props are `never`): React's resolver does not claim it | |
| Preact, with its resolver merged in | error ✓; React's and Solid's still checked | |
| **A `.vue` file, imported through the usual shim** | **compiles** | **compiles** |
| **A `.svelte` file, imported through the usual shim** | **compiles** | **compiles** |

#### 4.4.3 Where TypeScript cannot help: `.vue` and `.svelte` files [M]

Plain `tsc` cannot read a single-file component. An application imports
`.vue` and `.svelte` files through a shim (`declare module "*.vue" { const
c: DefineComponent<{}, {}, any> }`, `declare module "*.svelte" { const c:
Component<any> }`), and through it **every prop type is `any`**: the
spike's `renderComponent(VueCounter, { nonsense: true })` and the Svelte
equivalent compile [M, §12.13]. The real types exist only in each
framework's language tools (`vue-tsc`, `svelte-check`), which generate them
from the file.

So, honestly: **for `.vue` and `.svelte` views, a handler's props are
checked only if the application type-checks with `vue-tsc` or
`svelte-check`** [I: both read the component's props; not run in the spike],
or declares the props by name in the `Views` registry (§4.4.1), which is
checked by plain `tsc` but is a second source of truth (`bun-views types`
keeps it honest). A Vue component written with `defineComponent` in a `.ts`
file is fully checked [M]. The README says this in the Vue and Svelte
sections, with no promise beyond it.

### 4.5 The document shell [D] [M]

```
document  (React: a component of the adapter's; everyone else: the core's shell)
  └ the framework's root (React: the layouts and the view; others: the view in <div id="bv-root">)
```

- **For a document adapter (React)**, the core takes the HTML as is: React's
  document component renders `<html>`, `<head>` and `<body>` (§5.5).
- **For a fragment adapter**, the core's shell is a string template:
  `<!DOCTYPE html><html lang><head><meta charset>` + the adapter's `head` +
  `</head><body><div id="bv-root">` + the body + `</div>` + the props script
  and the client entry (when hydrating) + `</body></html>` [M, the spike's
  `shellParts`, §12.9]. It is an option, `shell: (parts) => string`, for an
  application that wants its own (`lang`, a skip link, a stylesheet).
- **The title.** A view's `export const title` (a string or a function of the
  props) and a `title` local are written into the shell's `<head>` when the
  adapter's head has no `<title>`. That covers Preact and Solid (no head
  management) and Vue's stream mode (no head at the start) [D].
- **Assets** in the shell: the stylesheets a client build emitted, as `<link
  rel="stylesheet" href integrity>`; the props script and the module script,
  nonce'd, with `integrity` (§4.6). React places its own (§5.6).

### 4.6 Client hydration (optional)

#### 4.6.1 What the core does, and what the adapter does [D]

Per hydrated view, the adapter writes a small entry module (its
`clientEntry`), which imports the view and calls the framework's hydration
function; the core bundles it, serves it, and writes the scripts that load it.
The five spike entries are three to five lines each [M,
`evidence/bun-views/adapters/*.ts`]:

| Adapter | The hydration call |
|---|---|
| React | `hydrateRoot(document, <Document><Layouts><View {...props} /></Layouts></Document>)` |
| Vue | `createSSRApp(View, props).mount("#bv-root")` |
| Svelte | `hydrate(View, { target: document.getElementById("bv-root"), props })` |
| Preact | `hydrate(h(View, props), document.getElementById("bv-root"))` |
| Solid | `hydrate(() => createComponent(View, props), document.getElementById("bv-root"))`, with `generateHydrationScript()` in the head |

The client tree must be the server tree, so **the view and everything it
imports is shared code** that must run in a browser.

#### 4.6.2 Entries as virtual modules [M]

The core generates each entry as a virtual module through a `Bun.build`
plugin (`onResolve` into its own namespace, `onLoad` returning the source),
so no file is written [M, `mini-core.ts` `buildClient`]. **Bun names an entry
output after the entrypoint specifier as written, not after the path the
plugin resolved it to**: an entrypoint `bv-entry:vue-Counter` came out as
`bv-entry:vue-Counter-<hash>.js`, with the colon, even when `onResolve`
returned a path without the prefix [M]. The core therefore uses specifiers
without a colon (`bv-entry-vue-Counter`).

#### 4.6.3 Build, serve, cache [D] (reuses jobsUi)

- **Build:** `Bun.build` per hydrated view (browser target, minified,
  splitting, `[name]-[hash]` names, `NODE_ENV=production`), with the
  adapter's client compile step, as `buildAssets()` does (`assets.ts:151`).
  Splitting shares the framework's runtime between pages. Measured for React:
  three entries built cold in **21 ms**; each entry 0.4 to 0.6 KiB, and the
  shared chunk **207 KiB, 65 KiB gzipped** [M, §12.7]. One entry per
  framework, minified [M, §12.9]: Vue 77 KiB (31 gzip), Svelte 49 (18),
  Preact 14 (6), Solid 16 (6); 3 to 48 ms to build. That runtime is the floor
  of a hydrated page, and why hydration is opt-in.
- **When:** in memory on a view's first hydrated render, once per process,
  the promise shared and a failure forgotten (`buildAssetsOnce`,
  `assets.ts:357`); or prebuilt by `bun-views build` into a `dist/` with a
  manifest that records each file's integrity (`writeAssets`,
  `loadDistAssets`). The `dev` switch chooses, as `resolveAssetSource` does
  (`assets.ts:398`).
- **Serve:** `views.assets` is a bun-common router mounted at `assetsPath`
  (default `/_views/assets`), with `immutable` caching, a strong ETag from the
  integrity digest, `nosniff`, a 304 path and HEAD (`jobsUi.ts:580-620`).
- **CSS** a compile step emits (a Vue `<style>`, a Svelte `<style>`) is a
  build output like any other, linked from the shell. The spikes' views have
  no styles, so this is [I] for every adapter; §6.2 and §7.2 say what each
  compile step must do.
- **Budget:** a test caps each page's entry and chunks, as `budget.test.ts`
  does.

**Reuse, concretely [D]:** `escapeHtml`, `jsonForScript` and `createNonce`
move to bun-common's `native.ts` in PR-1 (dependency-free; bun-common has two
private `escapeHtml`s). The asset functions are copied into bun-views and
generalised from one entry to many; moving bun-jobs-ui onto them is a
follow-up for the bun-jobs-ui agent (§14 Q9).

#### 4.6.4 Props on the wire [M] [D]

- **Transport [D]:** `self.__BV_PROPS = <jsonForScript(props)>` in a nonce'd
  inline script before the module script (the core's shell), or React's
  `bootstrapScriptContent` (React's document). JSON escaped that way is also a
  valid script expression. Measured: every adapter hydrates from it [M,
  §12.12]. The alternative for React, a `<script type="application/json">`
  that only the server renders, **breaks hydration** (recoverable error #418,
  a mismatch) [M, §12.7]: the props cannot be a server-only element of a
  hydrated tree.
- **Escaping [M]:** the props in the spikes carry
  `</script><script>…</script>`, U+2028 and `<!--`; the served HTML contains
  no raw `</script>` from them, the injected script never runs, and the text
  round-trips exactly into the hydrated page, for React [M, §12.7] and for
  every adapter [M, §12.12].
- **What is sent [D]:** exactly the props the view received, so in hydrate
  mode **`app.locals` and `res.locals` reach the browser.** That is required
  for the client to render the same tree, and it is a leak if a local holds a
  secret. The core therefore serialises only keys the view declares
  (`export const clientProps = ["user", "items"]`) when given, and in
  development warns about any local it is about to send. §14 Q6.
- **Types that do not survive JSON** (`Date`, `Map`, `BigInt`, class
  instances) produce a hydration mismatch. In development the core compares
  `JSON.parse(JSON.stringify(props))` with the props and warns on the first
  difference, naming the key. No serialiser dependency [D].

#### 4.6.5 CSP and SRI [M] [D]

- A fresh nonce per request (`createNonce`), on the core's scripts and passed
  to the adapter for the framework's own: React puts it on every inline
  script, bootstrap and Suspense swaps alike [M, §12.2]; Svelte takes
  `csp: { nonce }`; Solid's hydration script takes `nonce`. Every `<script>`
  on every adapter's page carried it [M, §12.12].
- **[D] `csp: true`** sets a policy built like `cspHeader()` (`shell.ts:73`):
  `script-src 'nonce-…' 'strict-dynamic'`, `base-uri 'none'`,
  `object-src 'none'`, plus the application's own directives
  (`csp: { directives }`). Off by default, because an application usually
  owns its CSP; then `res.locals.cspNonce` (or a `nonce` option) is honoured.
- SRI on every module script. Measured under `script-src 'nonce-…'
  'strict-dynamic'`: no violation on React's three pages [M, §12.7] or on any
  adapter's page [M, §12.12].
- A streamed page's out-of-order swaps (React, Preact, Solid) are inline
  scripts too, so **a streamed page under a strict CSP needs the nonce even
  without hydration** [M for React, §12.2; I for Preact and Solid].

### 4.7 Streaming through the adapters

#### 4.7.1 What the Express contract forces, and how to also stream [D] [C]

The engine callback is `(err, html: string)`, and `res.render` without a
callback sends that string (C6). A stream cannot pass through it. So:

```ts
interface ViewEngine {
  (path: string, options: object, callback: (err: Error | null, html?: string) => void): void;
  /** Optional: render to a stream. Resolves once the first part is ready, or undefined to decline. */
  renderToStream?: (path: string, options: object) => Promise<ReadableStream<Uint8Array> | undefined>;
}
```

`res.render(view, locals)` with **no callback** uses `renderToStream` when the
engine has it **and** the core says the view streams (from the adapter, its
options and the view's exports; `undefined` declines, and an adapter with no
`renderToStream` always declines). With a callback, the string path always
runs, exactly as Express. Every other engine (EJS in #320's harness) has no
such member and is unaffected. In bun-common that is a few lines in
`BunResponse.render` (`BunResponse.ts:2447-2480`), in PR-1. **This is the only
part of the plan that changes bun-common's view semantics**, and it changes
nothing for an engine without the member.

For a fragment adapter the core streams the shell's head first, then the
adapter's body stream, then the tail [M, `streamView`, §12.9].

#### 4.7.2 Through `BunResponse` and the pipeline [M] [S]

`res.type("html").send(stream)` is the whole of it: `send` builds the
`Response` around the stream, and the pipeline treats the layer as finished
once a response exists (CLAUDE.md, "Router — Express 5 semantics").
Measured over a socket with React: the shell's first byte at 5.8 ms, the
Suspense data at 51.9 ms for a 50 ms wait [M, §12.3].

- **Status and headers** are fixed when `send` runs, after the first part
  resolved. A failure before that still becomes a 500.
- **HEAD:** bun-common answers HEAD with the GET handler, the render starts,
  and Bun **cancels** the body stream: 5 of 5 renders cancelled, none read to
  the end, with no `Content-Length` [M, `http-serve.ts`]. Express renders a
  HEAD fully and sends the length. **[D] In stream mode, a HEAD request is
  rendered as a string**, so its headers match the GET's buffered form and
  nothing is wasted on a cancelled stream; §14 Q8.
- **The request timeout** (`handle()`'s `timeout`) bounds the wait for the
  first part, as for any handler. Beyond it, the core's deadline aborts the
  render (§4.8.2).

#### 4.7.3 Compression: a stall to fix first, then flush per chunk [M]

**The bug.** With `compression()` in front, a streamed body whose chunks are
too small for zlib to emit output never finishes: the client receives
gzip's 10-byte header (brotli: nothing) and waits. It happens for a stream
enqueued from `start()` and for one chunk per `pull()`, with or without a
pause, for every size measured (100 B to 100 KB), on gzip and br; identity is
fine [M, `gz-stall.ts`, `results-gz-stall.txt`]. React's streamed page with
a Suspense section hits it every time (`/gz/stream-suspense`: STALLED 2 of 2,
10 bytes arrived) [M, `http-serve.ts`], and so would any adapter's stream.
Not Bun: Bun.serve delivers chunks enqueued outside `pull()`, and
`node:zlib` on Bun calls back and ends [M, `gz-stall-controls.ts`].

**The likely cause [I]:** `zlibReadable`'s `pull()` writes a source chunk to
zlib and returns having enqueued nothing when zlib buffered it
[S, `compression.ts:963-990` at `bbe11201`]. By the Streams spec, a `pull()`
that enqueues nothing is not called again unless a new read arrives while it
runs, so the source is never read to its end, `engine.end()` never runs, and
the buffered output never comes out. A big first chunk makes zlib emit during
`pull()`, which is why `/gz/stream` works. The existing test
(`__tests__/compression.test.ts:819-859`) reads only until each expected part
arrives, never to the end of the body, so it cannot see a missing end.

**PR-0 (the bun-common agent):** loop in `pull()` until something is enqueued
or the source ends, and add tests that read a compressed stream **to its
end**: small chunks, a pause between them, both encodings, and a negative
control on the current code. Independent of this plan, and worth doing first.

**After the fix, flush anyway [M] [D].** zlib buffers until it has enough to
emit, which holds the first part back. With a flush after each chunk, the
gzip first byte arrives at 7.1 ms, against 54.6 ms buffered, for 4,869 bytes
against 4,204 [M, `/gz/stream-suspense-flush`]. The core's stream mode calls
`res.flush()` after each chunk (a `TransformStream`), which is also the
workaround until PR-0.

### 4.8 Errors and security

#### 4.8.1 Render errors become a 500 [M] [C]

A render error reaches the callback; `res.render` without a callback passes
it to `next(err)` (C6), and the application's error handlers answer it, as
for any handler [M, React `/shell-error`, §12.3; Vue through Express, a 500,
§12.9]. In bun-nest it reaches Nest's exception layer (Express's 500 JSON,
`{ statusCode: 500, message: "Internal server error" }`, as #320 matches).

**Every adapter must reject** (D17). Measured for a view that throws while
rendering [M, `errors-probe.ts`, §12.11]:

| Adapter | Without the adapter's care | The adapter does |
|---|---|---|
| React | rejects; React logs the stack with `console.error` unless `onError` is passed | passes the core's `onError` |
| Vue | **production: logs, resolves `"<!---->"` (a 200 with an empty page); development: rejects** | sets `app.config.errorHandler`, collects, rejects |
| Svelte | rejects | — |
| Preact | rejects | — |
| Solid | rejects, but `renderToStringAsync` has armed a 30 s timer it clears only on success; it rejects, unhandled, 30 s later (and keeps the process alive until then) | renders through `renderToStream` with its own deadline, cleared both ways |

The Solid one is a Solid behaviour, read in its source
(`solid-js/web/dist/server.js:236-248`: the timer is armed, then
`renderToStream` throws synchronously, and `clearTimeout` is only on the
success path) [S, M]; not a Bun bug.

**[D] Development error page:** with `dev: true`, a render error carries the
view path (and React's component stack) on the error object, and bun-views
exports an error handler, `viewErrorPage()`, that answers it with a plain
HTML page showing them under a 500. It is registered by the application (or
by `BunViewsModule` in development), never implicitly (§14 Q10). In
production the error goes to the handlers untouched and the page never
contains the message.

#### 4.8.2 A render deadline [M] [D]

`renderTimeout` (default 10 s, and never past the adapter's request timeout)
aborts a render through `signal`. React honours it: pending boundaries become
fallbacks and `onError` names the reason [M, §12.2]. Vue, Svelte and Preact
take no signal [I, their APIs have none]; the core races their promise
against the deadline and answers a 500, and the render runs on in the
background. Solid's adapter carries its own (above). In a buffered render an
aborted render is an error (a 500); in a stream it is the late-error case of
§5.7.

#### 4.8.3 View names and paths [M] [D]

- **Express does not confine view names**, and neither does PR #320, which
  matches it. `res.render("../Secret")` and an absolute path both render a
  file outside the views directory [M, `express-contract.ts`]. For a template
  that is an information leak; for a component view it **executes** the
  module.
- **[D] The core refuses a path outside every `settings.views` root** (it
  receives the resolved path and the settings [M, `settings` carries
  `views`]), with an error that names the view but not the path.
- **[D] Never render a user-controlled name.** The README says it plainly,
  and the typed forms (`@RenderComponent`, the registry) make the safe way the
  easy one.

#### 4.8.4 Escaping [M]

Every framework escapes text and attributes: the catalogue's
`Product 0 <Deluxe & "Pro">` came out as `&lt;Deluxe` from all five [M,
§12.9]. The holes are each framework's raw-HTML escape hatch
(`dangerouslySetInnerHTML`, `v-html`, `{@html}`, `innerHTML`; the README
names them) and serialised props, which go through `jsonForScript`
(§4.6.4).

### 4.9 Performance

#### 4.9.1 `NODE_ENV` [M]

Every framework picks a development or production build from `NODE_ENV`, and
React's production build is 2.8 times faster for `renderToString` (§5.8). Vue
differs in kind, not only speed: its production build **swallows** a throwing
view (§4.8.1). Express's `view cache` also keys on it (C5). **[D]** The core
logs one `warn` line at startup when `NODE_ENV` is not `production` and `dev`
was not set explicitly, as `jobsUi()` logs its in-memory build
(`assets.ts:363-366`).

#### 4.9.2 Caching rendered output [D]

Rendering the mid-size page costs 0.6 to 3 ms of one core, depending on the
framework and mode [M, §3.5]. Caching the HTML is the job of the cache layer
planned in `bun-cache.md` (PR #319, not merged at the time of writing); this
plan only says what views need from it:

- **Route-level caching is the right unit** (key: the URL and the `Vary`
  headers), as an HTTP cache middleware in front of `res.render`, not inside
  the core: the core cannot tell which locals matter, and hashing a 200-item
  props object per request costs about what rendering it does [I].
- **What the core adds:** a view may `export const cache = { ttl: 60 }`,
  which `res.render` turns into `Cache-Control` and which the cache layer
  reads. A hydrated page's HTML carries a per-request nonce, so it is **not
  cacheable as is** unless the nonce is dropped (no CSP) or replaced on the
  way out; §14 Q11.
- **Single-flight** (one render per key under a stampede) is the cache
  layer's.

#### 4.9.3 A regression guard [D]

`packages/bun-views/bench/`, a separate unpublished package like
`packages/bun-jobs/bench/` (its comparators, Express and Node, stay out of
the published tree), with `--compare` and `--save-baseline` as CLAUDE.md's
"Benchmark regression guard" describes:

- scenarios: React's string, buffered and stream on the mid-size page; the
  stream TTFB with a 50 ms Suspense section, with and without
  `compression()`; the cold import of a view; a hydrated page's bundle size;
  each later adapter adds its string render and its bundle;
- the **overtaken check**: Express on Node rendering the same React view with
  `renderToString` is the rival, so a busy machine slows both;
- the TTFB and stall scenarios are **assertions**, not figures: a streamed
  compressed page must finish, and its first byte must arrive before its
  slowest boundary.

---

## 5. The React adapter

`@kingsleyweb/bun-views/react`, the first adapter, fully planned. Everything
here was measured and decided in the React plan and is unchanged, apart from
where it now sits.

### 5.1 What React DOM gives Bun

React DOM 19.3.0 ships a Bun build. `react-dom/server` resolves to
`server.bun.js` under Bun, which takes `renderToReadableStream`, `resume`
and `renderToPipeableStream` from the Bun build and `renderToString` and
`renderToStaticMarkup` from the legacy browser build. `react-dom/static`
(`prerender`) has no `bun` condition and resolves to `static.node.js`
[S, `node_modules/react-dom/server.bun.js`, `package.json` exports;
M, `render-modes.ts` prints both resolutions]. Each picks its development or
production build from `process.env.NODE_ENV` **when it is first required**,
so `NODE_ENV` must be set before the first view is imported (§5.8).

### 5.2 The three ways to render, measured

The mid-size page is a 200-card catalogue, about 95 KB of HTML
(`evidence/bun-views/views/catalog.js`). In process, production build,
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
Through the bun-views core, the same comparison gave 2.96 ms buffered against
1.53 ms string at the median, on a less loaded machine [M, §12.9].

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
  way [M, §12.2]. Without hydration, that fallback is the page for good.
- **Buffered** waits for everything, then sends one document. Every React 19
  feature works, the status and headers are still free to change when
  something fails, and `Content-Length` is known. Its cost over
  `renderToString` is about 1.9 ms of CPU per render on this page, and nothing
  more on the wire.
- **Stream** sends the shell first: the first byte at ~6 ms against ~54 ms,
  for a page whose slowest data takes 50 ms. Its price is the status: once
  the shell is out, a later failure cannot become a 500 (§5.7).
- **`prerender`** (`react-dom/static`) is the buffered result by another
  route, and measures the same (3.9 ms). It exists for static generation and
  partial prerendering (`resume`), not for a response per request. Not used
  [D].

**[D] The default is buffered; `"string"` and `"stream"` are opt-in**, per
adapter (`react({ mode })`) or per view (`export const mode = "stream"`).
A view that never suspends halves its render time with `"string"`; a page
with slow data gains its TTFB from `"stream"`.

### 5.3 React 19 on the server, measured on Bun

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
  (§5.6).
- **Hoisting:** `<title>`, `<meta name>` and `<link rel="stylesheet"
  precedence>` written anywhere in the tree land in `<head>` when React
  renders the whole document, in both `renderToString` and the stream. In a
  fragment they come out at the start of the fragment.
- **Doctype:** the stream emits `<!DOCTYPE html>` when the root is `<html>`;
  `renderToString` never does. The adapter adds it in the string mode [D].
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
  `onError` receives the reason.
- **Escaping:** text and attribute values are escaped (`</script>`, quotes,
  `&`); only `dangerouslySetInnerHTML` is not.

### 5.4 Whole document, always [D]

**The React adapter always renders a whole document through React**: the
`document` component renders `<html>`, `<head>` and `<body>`, and the view
renders inside it. That is what makes hoisting work, gives the stream its
doctype, and gives hydration a single root (`hydrateRoot(document, …)`). A
view that wants no shell at all (an HTML fragment for htmx, an email body)
sets `export const document = false` and gets the bare markup, with no
doctype and hoisted tags at its start; the core then sends it as is, not in
its own shell.

### 5.5 Documents and layouts [D]

```
document  (one per adapter: <html>, <head>, <body>)
  └ layout  (adapter default; a view overrides or opts out)
      └ layout … (nested: each layout module may name its own parent)
          └ view  (the default export)
```

- **The document** is an adapter option, `react({ document: Component })`,
  with a default (`DefaultDocument`: `lang="en"`, charset, viewport, `<body>`
  holding the layouts). It receives `{ children, props, assets }`.
- **Layouts**: `react({ layout })` wraps every view; a view module may
  `export const layout = OtherLayout`, or `null` for none. A layout module
  may itself `export const layout = Parent`, which gives nesting without a
  file convention. The adapter walks the chain and refuses a cycle.
- **Composition stays possible**: a view may simply render `<MainLayout>`
  itself and set `layout = null`. It is the most explicit form, and the one
  typed end to end.
- **The head:** no head API. React 19 hoists `<title>`, `<meta>` and
  stylesheet `<link precedence>` from anywhere in the tree into `<head>`, and
  dedupes stylesheets by `href` [M, §5.3; deduplication U, React's
  documentation]. A view writes `<title>Profile</title>` where it likes
  [M, the title was hoisted in string and stream modes through the core,
  §12.9].
- **Assets:** the adapter passes `bootstrapModules: [{ src, integrity }]`,
  `bootstrapScriptContent` (the props) and `nonce` to React, which writes the
  scripts and a `modulepreload` link itself, all nonce'd [M, §5.3].
  Stylesheets of a hydrated view come from the `assets` prop; `<ViewAssets
  />` is exported for a custom document that wants to place them itself.

Directory conventions (`_layout.tsx` per folder, as in Next.js) are left out
[D]: they need a file scan per lookup and add magic the explicit chain does
not need. §14 Q7.

### 5.6 Hydration, islands, and what is out of scope

| Mode | What the browser gets | When |
|---|---|---|
| none (default) | HTML only. Streamed Suspense swaps still run, as React's small inline scripts | content pages, emails, admin lists |
| `hydrate: true` | the page's client bundle; `hydrateRoot(document, <Document><Layouts><View {...props}/>…)` | interactive pages |
| islands (PR-6) | one bundle per island component; each `<Island>` hydrates alone | mostly static pages with a few widgets |

- **Whole-document hydration works** in headless Chrome under a nonce CSP
  with SRI: the page hydrates, a click updates state, and the page reports no
  console error and no CSP violation [M, `hydrate.tsx`, page A, §12.7], and
  the same through the bun-views core [M, §12.12]. The document, the layouts
  and the view are shared code.
- **Islands (PR-6) [D]:** `<Island component={Cart} props={{ items }} />` in
  a server view renders `Cart` to HTML inside a marker element carrying its
  id; the page's bootstrap script imports each island's chunk and calls
  `hydrateRoot(marker, <Cart {...props} />)`. Each island is a separate root,
  so state is not shared between islands. The island's component is named by
  module path at build time, which a `Bun.build` plugin collects. React first;
  the shape (a marker element, a per-island entry) would carry to the other
  adapters [I].
- **Async components in a hydrated view:** an async server component inside a
  hydrated tree hydrated without an error in the production build, its
  server text kept [M, page C], but the development build logs "…is an async
  Client Component. Only Server Components can be async at the moment" [M].
  It is unsupported, and works by accident in production. **[D]** In
  development, the adapter turns that console error into a thrown error for
  a hydrated view, and the README says to keep async components out of
  hydrated views; islands are the way to put an interactive part inside an
  async page.
- **React Server Components and server actions: out of scope [U].** They need
  two module graphs (one under the `react-server` condition), a Flight
  serialiser and client-reference manifests from a bundler integration.
  React ships those integrations for webpack, Turbopack, Parcel and an
  experimental ESM one; `Bun.build` has none we could verify. What does work
  on Bun today, measured, is async components and `use()` in ordinary SSR
  (§5.3), which covers "fetch data in the component" for server-rendered
  pages. Revisit if Bun's bundler gains RSC support.

### 5.7 Errors after the headers (stream mode) [M] [D]

| When | What happens | Measured |
|---|---|---|
| in the shell | `renderToReadableStream` rejects before `send`; `res.render`'s callback gets the error; the error handlers answer 500 | `/shell-error`: 500 from the error handler |
| in a Suspense boundary, after the shell | React's `onError` runs; the fallback stays with a client-render marker; the stream ends normally with **200** | `/late-boundary-error`: 200, ends with `</html>` |
| the body stream itself breaks | the connection is reset; the client sees an error, not a clean truncated page | `/hard-stream-error`: `ECONNRESET` after 1000 bytes, on Bun.serve and bun-common alike (`stream-error-after-headers.ts`) |

So, in stream mode:

- **With hydration**, a boundary error after the shell is recovered on the
  client: React re-renders that boundary in the browser. That is React's
  design.
- **Without hydration**, the fallback stays on the page for good, under a 200.
  **[D] The adapter therefore defaults to buffered**, and stream mode logs
  each boundary error, through `onError`, as `logger.error("bun-views: a
  boundary failed after the response started", { error, view })`. A view
  choosing `"stream"` without `hydrate` gets a development warning.
- **Error boundaries** (a component with `componentDidCatch`) do not run on
  the server; Suspense boundaries are the server's unit of recovery
  [U, React's documentation].

The same holds for any adapter that streams out of order (Preact, Solid send
a fallback and swap it [M, §12.9]); Vue streams in order, so a late failure
there is a truncated body, which the core turns into a reset as above [I].

### 5.8 Performance [M]

**`NODE_ENV`:** measured on the same page, development build against
production (p50): `renderToString` 5.15 ms against 1.81 ms (**2.8 times
slower**), buffered 6.42 ms against 3.69 ms (1.7 times) [M,
`results-render-modes-dev.txt`, `results-render-modes-prod.txt`].

**Against Node and Express:** `oha -c 32`, interleaved rounds, the same view
[M, `bench.ts`, `results-bench.txt`]:

| Server | `/string` | `/engine` | `/stream` |
|---|---|---|---|
| bun-common on Bun | **626** req/s · p99 105 ms | **765** · 92 ms | **464** · 134 ms |
| Express 5 on Node 24.2 | 552 · 329 ms | 561 · 363 ms | 380 · 706 ms |
| Express 5 on Bun | 733 · 91 ms | 740 · 87 ms | **127** · 613 ms |

Medians of 4 interleaved rounds of 3 s, each server one process, run
exclusively under the heavy-run wrapper (load 43 falling to 8 during the
run). `/string` is `renderToString` sent by the handler; `/engine` the same
through the Express engine contract; `/stream` is `renderToReadableStream`
on bun-common and `renderToPipeableStream` on Express.

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

---

## 6. The Vue adapter (designed for, built on demand)

`@kingsleyweb/bun-views/vue`, with `vue` (≥ 3.5) as an optional peer. **Not
built until there is a real use** (§14 Q15). What the spike settled, so that
building it is a known quantity:

### 6.1 Rendering [M]

- **`renderToString(createSSRApp(View, props), ctx)`** renders the
  catalogue in 1.00 ms at the median (0.63 to 0.84 ms in other runs), and
  waits for an async `setup()` inside `<Suspense>` (50 ms data: in the page,
  no fallback) [M, §12.9, §12.10].
- **The head** is `<Teleport to="head">`: after `renderToString`,
  `ctx.teleports.head` holds the `<title>`, which the fragment's `head`
  carries [M]. No `@unhead/vue` dependency [D]; an application that uses
  `@unhead/vue` renders its head into the same slot [I].
- **`renderToWebStream(app, ctx)`** streams **in order**: the cards from
  4.6 ms, the async section at 51 ms, no fallback sent [M]. The teleports are
  not known when the body starts, so a streamed Vue page has no `<title>` in
  its `<head>` unless the view sets the core's `title` (§3.6, §4.5).
- **Errors: the adapter must set `app.config.errorHandler`.** Without one,
  Vue's production build logs a throwing `setup()` and `renderToString`
  resolves `"<!---->"` (a 200 with an empty page); the development build
  rejects [M, §12.11]. The adapter collects every error the handler sees and
  rejects with the first, and passes them all to the core's `onError`.
  (`app.config.throwUnhandledErrorInProduction`, Vue 3.5, is the other way
  [U, Vue's documentation]; the handler also gives the core the errors.)
- **Hydration:** `createSSRApp(View, props).mount("#bv-root")`; the client
  bundle for a counter view is 77 KiB, 31 KiB gzipped, minified [M, §12.9].
  In Chrome it hydrates, a click updates it, and the page logs nothing, in
  the production and development builds alike (the development bundle is
  104.8 KiB) [M, §12.12].

### 6.2 The compile step [M] [S]

Bun does not load `.vue`. What exists for Bun, checked on 2026-10-10 [S, npm
metadata and each package's source]:

| Package | State | SSR | Notes |
|---|---|---|---|
| `bun-plugin-vue3` 1.1.0 | one maintainer, last release 2026-03-30 | **no**: compiles templates to client render functions only | imports `typescript` without declaring it (resolves only through a hoisted copy); registers itself with `Bun.plugin` on import |
| `bun-plugin-vue` 1.0.0 | one maintainer, 2025-01 | not checked | stale |
| `unplugin-vue` 8.0.0 | maintained (antfu, sxzz) | yes | no Bun entry (`exports` lists vite, rollup, esbuild, webpack, rspack, rolldown, farm); depends on `vite` |

Measured, the same catalogue through Vue's server renderer [M, §12.10]: with
templates compiled for SSR by the spike's own plugin, **0.63 ms** at the
median; with `bun-plugin-vue3`'s client render functions, **1.38 ms** (2.2
times slower; 3.5 times in a shorter run), the same 99,466 bytes.

**[D] The adapter ships its own compile step**, `vueSfc(side)`
(`evidence/bun-views/adapters/plugins/vue-sfc.ts`, 62 lines): `parse`, then
`compileScript` with `inlineTemplate` and `templateOptions.ssr` on the server
(so `setup()` returns the SSR render function, marked `__ssrInlineRender`),
render functions on the client; `compileTemplate` for a component without
`<script setup>`; a file system for type-based props that import a type
(`defineProps<{ item: Item }>()`); and the client build's
`__VUE_OPTIONS_API__`, `__VUE_PROD_DEVTOOLS__` and
`__VUE_PROD_HYDRATION_MISMATCH_DETAILS__` flags set as `define` from the
plugin's `setup()` [M]. **Not done in the spike, and PR-9v's real work:**
`<style>` and `<style scoped>` (`compileStyle`, the scope id on the template,
the CSS as a build output on the client and collected on the server), source
maps, and `<script>` named exports (§4.2.3). `@vue/compiler-sfc` comes with
`vue` (`vue/compiler-sfc`), so the adapter adds no dependency.

### 6.3 Typing

A component written with `defineComponent({ props })` in a `.ts` file is
checked by `@RenderComponent` [M]. A `.vue` file is not, under plain `tsc`
(§4.4.3): the README points Vue users at `vue-tsc` or the `Views` registry.

---

## 7. The Svelte adapter (designed for, built on demand)

`@kingsleyweb/bun-views/svelte`, with `svelte` (≥ 5) as an optional peer.
**Not built until there is a real use.**

### 7.1 Rendering [M] [S]

- **`render(View, { props, csp: { nonce } })`** from `svelte/server` returns
  `{ head, body }` **synchronously, and is also awaitable**: its type is
  `SyncRenderOutput & PromiseLike<SyncRenderOutput>` [S,
  `svelte/types/index.d.ts:2691-2733`, Svelte 5.57.2]. The catalogue renders
  in 0.64 ms at the median [M, §12.9]; `<svelte:head>` lands in `head` [M].
- **Async data:** by default `{#await promise}` renders its pending branch on
  the server, so 50 ms data comes out as the fallback, with no wait [M,
  §12.9]. With the compiler's `experimental: { async: true }`, an `await`
  in markup is awaited: reading the render synchronously throws
  `await_invalid` ("Encountered asynchronous work while rendering
  synchronously"), and `await render(…)` resolves after 51 ms with the data
  [M, §12.10]. Inside a `<svelte:boundary>` with a `pending` snippet, the
  server renders the pending snippet and does not wait [M]. **[D]** The
  adapter always awaits `render()`, and exposes `async: boolean` (default
  off, as Svelte's is experimental) on its compile step.
- **No stream.** Svelte has no streaming server renderer; the adapter has no
  `renderToStream`, and the core renders the string for a view that asks to
  stream [M].
- **Errors:** a throwing component rejects [M, §12.11].
- **Hydration:** `hydrate(View, { target, props })` from `svelte`; a counter
  view's client bundle is 49 KiB, 18 KiB gzipped [M, §12.9]. In Chrome it hydrates with no console output in both builds [M, §12.12].

### 7.2 The compile step [M] [S]

There is an **official** plugin, `bun-plugin-svelte` (0.0.6, in Bun's own
repository, `packages/bun-plugin-svelte`, last released 2025-03-26) [S]. It
works for both sides on Bun 1.4.3 [M, §12.10, §12.12]: server-side by
default under `Bun.plugin`, client-side under `Bun.build` with a browser
target (or `forceSide`). What it cannot do [S,
`bun-plugin-svelte/src/options.ts`]:

- pass Svelte's `experimental.async`: its `compilerOptions` are limited to
  `customElement`, `runes`, `modernAst` and `namespace`;
- choose whitespace per application: it preserves the source's whitespace
  unless the build minifies, so the server output (no minify under
  `Bun.plugin`) keeps the template's newlines and indentation, 102,259 bytes
  against 97,840 for the same page with Svelte's default whitespace handling
  [M, §12.10], while a minified client build is compiled without them;
  the hydrated page then logged **"Failed to hydrate"** in Chrome, in both
  builds, and recovered by rendering again on the client (the click still
  worked) [M, §12.12]; the whitespace mismatch is the likely cause [I: our
  compile step, the same on both sides, hydrated cleanly];
- it adds HMR code to a client build unless `NODE_ENV=production` [S];
- its default export is `SveltePlugin({ development: true })` [S,
  `src/index.ts`], which, registered as a runtime plugin, breaks server
  rendering (below).

**Svelte's development mode follows an export condition, not `NODE_ENV`.**
A component compiled with `dev: true` throws on the server (`TypeError:
undefined is not an object (evaluating 'context.function[FILENAME]')`, in
`svelte/src/internal/server/dev.js`) unless Bun runs with
`--conditions=development`, because Svelte's runtime learns it is a
development build from `esm-env`, which resolves through that condition [M,
a probe: the same component renders under `bun --conditions=development` and
throws without it]. **[D]** The adapter's server compile step takes `dev`
from `esm-env`'s `DEV`, so the two always agree, and its client step adds the
`development` condition to the build when it compiles for development.

**[D] The adapter ships its own compile step** (`svelteCompile(side, {
async })`, 43 lines in the spike: `svelte/compiler`'s `compile` with
`generate: side`, the `svelte` export condition added in `setup()`, `dev`
as above, and the same whitespace handling on both sides), and documents `bun-plugin-svelte` as an
alternative an application may pass instead (`svelte({ plugin })`). §14 Q16.
**Not done in the spike:** `<style>` (the spike compiles with `css:
"injected"`; the real adapter emits CSS as a build output), `.svelte.ts`
modules (runes in plain modules, which the official plugin handles with
`compileModule`), and source maps.

### 7.3 Typing

`Component<Props>` is checked by `@RenderComponent` [M]. A `.svelte` file is
not, under plain `tsc` (§4.4.3): the README points Svelte users at
`svelte-check` or the `Views` registry.

---

## 8. Preact and Solid (optional)

Both were cheap to spike, and both fit the interface. Whether to build them
at all is §14 Q17.

### 8.1 Preact [M]

- **No compile step:** Bun honours `/** @jsxImportSource preact */` per file
  [M]. A view must carry it (or the application's `tsconfig.json` sets
  `jsxImportSource: "preact"`, which then rules out React `.tsx` views in the
  same project).
- **`renderToStringAsync`** (preact-render-to-string 6.8) waits for
  `preact/compat`'s `lazy` + `Suspense`; **`renderToReadableStream`**
  (`preact-render-to-string/stream`) sends the fallback and swaps it, the
  data at 51 ms [M, §12.9]. 2.20 ms at the median for the catalogue.
- **No head management**: the core's `title` (§4.5).
- **Hydration:** `hydrate(h(View, props), root)`; 14 KiB, 6 KiB gzipped, the
  smallest runtime of the five [M]. Hydrates in Chrome with no console output [M, §12.12].
- It claims `.tsx`, as React does (D16). Effort ~1.5 d (PR-9p).

### 8.2 Solid [M] [S]

- **A compile step is required:** Solid's JSX compiles to templates, not to
  runtime calls, so Bun's JSX cannot do it [S, `babel-preset-solid`]. The
  adapter runs Babel with `babel-preset-solid` (`generate: "ssr"` or `"dom"`,
  `hydratable: true`) and `@babel/preset-typescript`, **filtered to the views
  roots** so other `.tsx` files in the process stay Bun's [M: React's `.tsx`
  views rendered correctly in the same process]. `babel-preset-solid` peers
  on `@babel/core` 7 (Babel 8 is current on npm), so the adapter brings Babel
  7 as a dependency or a peer: the one framework that needs a third-party
  toolchain. Community Bun plugins exist (`bun-plugin-solid` 1.0.0, 2023;
  `@dschz/bun-plugin-solid` 1.0.4, 2025-06) [S, npm]; not evaluated.
- **Rendering:** through `renderToStream` with the adapter's own deadline,
  because `renderToStringAsync` leaks a 30 s timer and an unhandled rejection
  after a throwing view (§4.8.1). 0.76 ms at the median; the output is 14%
  larger (hydration keys) [M, §12.9]. The stream sends the fallback and
  swaps it.
- **The head** carries `generateHydrationScript({ nonce })`, which hydration
  needs; titles need `@solidjs/meta` or the core's `title` [M; U for meta].
- **Hydration:** `hydrate(() => createComponent(View, props), root)`; 16 KiB,
  6 KiB gzipped [M]. Hydrates in Chrome with no console output [M, §12.12].
- Effort ~3 d (PR-9so).

---

## 9. Packaging

### 9.1 One package, a subpath per framework [D]

**`packages/bun-views`, published as `@kingsleyweb/bun-views`.** Considered:

| | One package, subpaths (chosen) | A package per framework (`bun-react-views`, `bun-vue-views`, …) | A bun-common subpath |
|---|---|---|---|
| The core (most of the code) | once | copied, or a fourth package they all depend on | in bun-common |
| A framework in an unrelated user's tree | no: every framework is an **optional** peer | no | an optional peer of an HTTP layer most users never render with |
| A new framework | a subpath and its tests | a new package, its own release | — |
| Client app code, Chrome e2e, bundle budget | its own gate | one gate per package | added to every bun-common change |
| Owner | features agent, then whoever the user names | same | the bun-common agent |

The React plan chose a new package over a bun-common subpath for the reasons
in the last column; the user's decision adds the first one.

### 9.2 Dependencies [D]

```jsonc
{
  "dependencies": { "@kingsleyweb/bun-common": "^2.2.0" },
  "peerDependencies": {
    "react": "^19.2.0", "react-dom": "^19.2.0", "@types/react": "^19.2.0",
    "vue": "^3.5.0",
    "svelte": "^5.0.0",
    "preact": ">=10", "preact-render-to-string": "^6.5.0",
    "solid-js": "^1.9.0", "babel-preset-solid": "^1.9.0", "@babel/core": "^7.0.0",
    "@types/bun": ">=1.4.2"
  },
  "peerDependenciesMeta": {
    // every one optional: a subpath fails at import, naming the peer it needs
  }
}
```

- **Every framework is an optional peer.** The application owns its framework,
  so views and the core share one copy (§4.2.1). A subpath imported without
  its peers fails at import with an error naming them; the root never imports
  a framework [D]. Only the peers of subpaths that exist are listed: Vue's,
  Svelte's, Preact's and Solid's arrive with PR-9v, 9s, 9p and 9so.
- **Compilers come with their frameworks**: `vue/compiler-sfc` ships in
  `vue`, `svelte/compiler` in `svelte`. Solid's is Babel, three more peers
  (`babel-preset-solid`, `@babel/core` 7, `@babel/preset-typescript`), the one
  framework that needs a third-party toolchain [M, §8.2].
- **`@types/react` is an optional peer** [D]: the `./react` declarations name
  `ComponentType` and `ReactNode`, so a consumer type-checking against them
  needs it, but making it required would force it on JavaScript users. Vue,
  Svelte, Preact and Solid ship their own types. §14 Q3.
- No other runtime dependency. Bundling is `Bun.build`; hashing,
  `Bun.CryptoHasher`; watching, `node:fs`.

### 9.3 Declarations and the consumer check

The dts recipe from CLAUDE.md ("Packaging types"), unchanged:
`tsconfig.build.json` and `scripts/build-declarations.ts` copied, `dts/`
gitignored, `exports` entries in the `{ "@kingsleyweb/source", types, default
}` shape, and `__tests__/packaging.test.ts`. Entries, each subpath scoped to
its own peers so `checkPeerScopes` proves the root never reaches a framework:

| Spelling | What | `peers` in `consumer-check.json` |
|---|---|---|
| `@kingsleyweb/bun-views` | `createViews`, the adapter interface types, `Views`, `ViewLocals`, `ComponentPropsOf`, `PropsOf`, `viewErrorPage` | — (none) |
| `@kingsleyweb/bun-views/react` | `react`, `DefaultDocument`, `ViewAssets`, `Island` | `react`, `react-dom`, `@types/react` |
| `@kingsleyweb/bun-views/react/client` | the hydration runtime React's generated entries import | same; checked as a `browser` entry (no Bun or Node types) |
| `@kingsleyweb/bun-views/vue`, `/svelte`, `/preact`, `/solid` (later) | the adapter and its compile step | the framework (and Solid's Babel) |
| `@kingsleyweb/bun-nest/views` (in bun-nest) | `BunViewsModule`, `RenderComponent`, `RenderView` | `@kingsleyweb/bun-views` |

The root of bun-views having **no** peers is the point of the split, and the
consumer check proves it: its no-peers consumer imports the root with no
framework installed.

---

## 10. bun-nest adoption

### 10.1 With PR #320 alone [C]

`@Render` follows Express since PR #320, so bun-views needs no bun-nest code:

```ts
import { createViews } from "@kingsleyweb/bun-views";
import { react } from "@kingsleyweb/bun-views/react";

const views = createViews({ adapters: [react()] });
const app = await NestFactory.create(AppModule, new BunHttpAdapter());
app.engine("tsx", views.engine("tsx"));   // bun-nest's engine(), PR #320
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

The same works with a `.vue` or `.svelte` view once those adapters exist,
and with several adapters at once (`@Render("cards/Card.vue")` beside
`@Render("users/Profile")`). That is the whole adoption for named views, and
what the user asked: "how it can be adopted in bun-nest". §10.2 to §10.5
make it nicer.

### 10.2 `BunViewsModule` [D]

```ts
@Module({
  imports: [BunViewsModule.forRoot({
    adapters: [react({ mode: "buffered" })],
    views: "views",
    hydrate: false,
  })],
})
class AppModule {}
```

Framework-agnostic: it takes the same options as `createViews`. On module
init it gets the `HttpAdapterHost`, calls `views.install()` on the adapter
(an engine per adapter extension, the views roots, the default engine from
the first adapter's first extension), and mounts the asset router when any
view hydrates. `forRootAsync` takes a factory for options from config. It
refuses a non-bun-nest adapter with a `ConfigError` naming the adapter.

### 10.3 `@RenderComponent(Component)` and `@RenderView(name)` [M] [D]

```ts
@Get(":id")
@RenderComponent(Profile)
profile(@Param("id") id: string): Promise<Omit<PropsOf<typeof Profile>, keyof ViewLocals>> { … }
```

It stores the component under `RENDER_METADATA` (D12), so Nest calls
`adapter.render(res, Profile, result)`. **bun-nest's `render` accepts a
component** as well as a string: it hands the component to bun-views
directly, which finds the adapter that loaded it (the core records each
loaded module's adapter) and skips the lookup (no file, no traversal check,
no string to mistype). A component the core never loaded (imported by the
controller before any render) is resolved through the adapters' resolvers
in `ComponentPropsOf` at the type level and by a per-adapter `owns(component)`
check at run time [I: not spiked; a small addition to the interface, or a
registry of loaded modules]. §14 Q18.

**Per framework, what the check covers** (§4.4.2, [M, §12.13]): React
components; Vue components from `defineComponent` in a `.ts` file; Svelte and
Solid `Component<P>` values; Preact with its resolver. **Not a `.vue` or
`.svelte` file under plain `tsc`**: its props are `any` through the shim, so
`@RenderComponent(Card)` with wrong props compiles (§4.4.3). The decorator's
documentation says so, and points at `vue-tsc`, `svelte-check` or
`@RenderView` with the registry.

`@RenderView("users/Profile")` is the string form, checked through the
registry (§4.4.1), the same for every framework. Both are thin: Nest's own
`@Render` keeps working.

On Nest's Express adapter, a component in `RENDER_METADATA` would reach
`response.render(component, …)` and fail; the decorators are for bun-nest
only, and say so.

### 10.4 Errors and exception filters [D]

- A render error goes to Nest's exception layer, as any error does (§4.8.1).
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

  `res.render` exists on `BunResponse` since PR #320 (C6). A render error
  inside a filter is caught by bun-nest's final handler, so it cannot loop.

### 10.5 Interceptors [S] [D]

The handler's result passes through every interceptor before it is rendered
[S, `router-execution-context.js:46-48`]. So `ClassSerializerInterceptor`
turns class instances into plain objects (respecting `@Exclude`) **before**
they become props: useful, because a hydrated page then never serialises an
excluded field. The type check of §10.3 sees the handler's return type, not
the interceptor's output, so an interceptor that reshapes the result defeats
it [I]. The README says so.

---

## 11. Tests and examples

### 11.1 What each PR proves

| PR | Tests (each with a negative control) |
|---|---|
| PR-0 | a compressed stream is read **to its end** for small chunks, a pause, gzip and br; fails on today's `zlibReadable` |
| PR-1 | `res.render` streams when the engine has the capability and no callback; uses the string path with a callback; EJS (no capability) byte-identical to #320's harness results |
| PR-2 | **an adapter conformance kit** (`@kingsleyweb/bun-views/testing`, the shape of bun-jobs' provider kit): every adapter renders a fixture view to a whole document, escapes text, passes props, rejects for a throwing view **and leaves no timer or unhandled rejection behind** (D17; the spike's `errors-probe.ts` as a test), and, when it has them, streams and builds a client entry; run against a fake adapter in PR-2 and against each real one from PR-3 on. The core: #320's view probes re-run with a component view beside the EJS one; props merge and the three stripped keys; missing default export; traversal refused (`../`, absolute, a symlink out); two adapters claiming one extension refused; the shell (head, title fallback, scripts); `onError` to the logger, not the console; the deadline for an adapter without a signal; HEAD; `NODE_ENV` warning; type tests (`*.type-test.ts`) for the registry, the overload fix, locals subtraction and `PropsOf` |
| PR-3 | the kit against React; each mode's output, doctype, hoisting; Suspense, `use()` and async components in buffered mode, fallbacks in string mode; documents and layouts; React's `onError` |
| PR-4 | an edit to a view and to a layout is picked up; RSS flat over 300 reloads; `--hot` does not break it; nothing watched in production; a view behind a compile step reloads (a fake adapter's plugin) |
| PR-5 | client build once per process, shared and forgotten on failure; virtual entries named without a colon; asset router (immutable, ETag, 304, HEAD, 404); `jsonForScript` round trip with `</script>`, U+2028 and `<!--`; CSP nonce on every script; SRI; a bundle budget; **e2e in Chrome** (`Bun.WebView`, owned profile, skips visibly without Chrome): hydration with no recoverable error, a click changes state, no CSP violation, the injected script never runs; the props-type warning |
| PR-6 | two islands hydrate independently; a page with no island ships no client JS |
| PR-7 | `BunViewsModule` installs the engines; `@Render("Page")` and `@RenderComponent(Page)` render on `BunHttpAdapter`; type tests for the decorators per framework resolver; an exception filter rendering a page; `ClassSerializerInterceptor` before render; consumer check with `peers` |
| PR-8 | `bench --compare` against a saved baseline; the stall and TTFB assertions |
| PR-9v, 9s, 9p, 9so | the conformance kit against the adapter; its compile step on both sides (styles where the framework has them, Svelte's `dev` following the runtime condition); a development reload of its file type; its hydration e2e in Chrome; its props resolver's type test; its peers in the consumer check |

### 11.2 Examples (the examples agent)

Self-asserting, as the repo's examples are, in a new `examples/bun-views/`
and in `examples/bun-nest/`:

1. `01-quick-start`: `createViews` with React, a view, `res.render`; asserts
   the HTML.
2. `02-layouts`: a document, a default layout, a nested layout, a view opting
   out; asserts the nesting and the hoisted `<title>`.
3. `03-data`: Suspense with `use()` and an async component in buffered mode;
   the same view in string mode shows the fallback.
4. `04-streaming`: stream mode with `compression()`; asserts the first byte
   arrives before the slow boundary (a timing assertion, so `RUN_ALONE`).
5. `05-hydration`: a counter page, in Chrome (two at a time, as
   `examples/bun-jobs-ui`'s runner does); asserts the click.
6. `06-errors`: a render error answered by an error handler; traversal
   refused.
7. `examples/bun-nest/…/views.ts`: `BunViewsModule`, `@Render`,
   `@RenderComponent`, a filter rendering a 404 page.
8. One example per later adapter (`07-vue`, `08-svelte`, …), with its PR.

The playground (`playground/`) is bun-jobs' showcase; whether a views page
belongs there is the bun-jobs-ui agent's call (CLAUDE.md, "Done includes the
playground"); §14 Q12.

---

## 12. Measured evidence

On 2026-10-10, on one shared laptop: i9-11900H, 16 threads, Linux
7.0.0-38-generic, Bun 1.4.3 (`bbdc5a519`), Node v24.2.0, React 19.3.0,
Express 5.3.0, Vue 3.5.43, Svelte 5.57.2, Preact 11.0.1
(preact-render-to-string 6.8.0), Solid 1.9.17 (babel-preset-solid 1.9.16,
Babel 7.29), TypeScript 6.0.3. Peer sessions ran throughout, at a 1-minute
load between 4 and 47, so compare within a run. The heavy spikes went
through the heavy-run wrapper: `render-modes.ts`, `hydrate.tsx` and
`frameworks-hydrate.ts` (both builds) as the wrapper chose, `bench.ts` with
`HEAVY_MODE=exclusive`. §12.1 to §12.8 are the React plan's, unchanged;
§12.9 to §12.13 are new.

### 12.1 `render-modes.ts`

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
+ 15 = 96,281, and the string route sends 96,282 bytes over the wire,
§12.3). (These results files were captured when the folder was named
`react-views/`, and the paths they print say so.)

### 12.2 `react19.tsx`

Every bullet of §5.3, from `results-react19.txt`. The surprises against
common belief: async function components render in plain SSR (no RSC), and
`renderToString` keeps hoisting when it renders `<html>`.

### 12.3 `http-serve.ts`, `gz-stall.ts`, `stream-error-after-headers.ts`

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
no `Content-Length`. Errors: §5.7.

`results-gz-stall.txt`: 36 cases; every gzip and br case stalls (1.5 s
deadline), every identity case finishes. `results-gz-stall-controls.txt`:
both controls pass. `results-stream-error.txt`: a reset in all four cases.

A first version of the stream-error spike reported a **clean, truncated 200**
for a piped stream; it was wrong (the stream closed before the delayed error
ran), and was caught by reading the same stream in JavaScript. The corrected
spike is the one kept.

### 12.4 `bench.ts`

`results-bench.txt`: the table and reading in §5.8, with each round's
figure. Per round, req/s:

| Server | `/string` | `/engine` | `/stream` |
|---|---|---|---|
| bun-common on Bun | 616, 557, 626, 669 | 765, 692, 654, 779 | 460, 486, 464, 304 |
| Express 5 on Node | 461, 538, 552, 596 | 571, 561, 520, 436 | 389, 351, 380, 289 |
| Express 5 on Bun | 631, 683, 733, 783 | 802, 740, 696, 576 | 127, 106, 130, 90 |

### 12.5 `view-loading.ts`

The tables in §4.2.1 and §4.2.2; 20 server-side rebuilds of a view: median
13.4 ms.

### 12.6 `express-contract.ts`

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
| view engine `tsx`, no engine registered | 500, "Cannot find module 'tsx'" (Express; PR #320 throws a clear error instead, C8) |

### 12.7 `hydrate.tsx`

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

### 12.8 `typing/`

`tsc -p typing` exits 0 on TypeScript 6.0.3: every `@ts-expect-error` line
is an error (a missing prop, a wrong prop type, an unknown view name, a
missing prop by name, wrong props to the typed `res.render`), and every other
line compiles (excess props and an `any` return pass, as §4.4.1 says). The
negative control, the naive overload pair, fails with "Unused
'@ts-expect-error' directive" on the `res.render` line. (The spike names the
registry `ReactViews`; this plan renames it `Views`.)

### 12.9 `frameworks-ssr.ts`: five adapters through one core

`results-frameworks-ssr.txt` (`NODE_ENV=production`, load 4.6 to 7.2). The
core is `core/mini-core.ts` (176 lines, framework-agnostic), the interface
`core/interface.ts`, the adapters `adapters/*.ts` (23 to 49 lines each) and
their compile steps `adapters/plugins/*.ts`. Every framework renders the
same 200-card catalogue (`fviews/<framework>/Catalog.*`, the markup of
`views/catalog.js`) in one process.

| | React | Vue | Svelte | Preact | Solid |
|---|---|---|---|---|---|
| Cold load, first view / second view | 1.3 / 0.4 ms | 321 / 4.4 ms | 51 / 9.1 ms | 3.1 / 0.3 ms | 89 / 9.0 ms |
| Bytes, 200 cards, title in head, doctype, name escaped | 98,002 ✓ ✓ ✓ | 99,650 ✓ ✓ ✓ | 97,994 ✓ ✓ ✓ | 95,681 ✗ ✓ ✓ | 112,186 ✗ ✓ ✓ |
| String render, 50 ms data | 55.8 ms, data | 52.6 ms, data | 1.6 ms, **fallback** | 51.8 ms, data | 52.0 ms, data |
| Stream, 50 ms data: first card / last; fallback sent; title in head | 9.7 / 59.1 ms; yes; ✓ | 4.6 / 50.6 ms; no; ✗ | — | 7.9 / 50.8 ms; yes; ✗ | 3.6 / 50.7 ms; yes; ✗ |
| Throwing view | rejects | rejects (adapter's `errorHandler`); Vue alone: resolves `"<!---->"` | rejects | rejects | rejects |
| Client entry (Counter), build / size / gzip | 48 ms / 207.4 / 65.3 KiB | 24 ms / 77.2 / 30.7 KiB | 18 ms / 48.7 / 18.1 KiB | 3 ms / 13.5 / 5.8 KiB | 18 ms / 15.7 / 6.0 KiB |
| Render p50 / p90 (500 rotating iterations) | 2.96 / 5.18 ms buffered; 1.53 / 2.75 ms string | 1.00 / 1.73 ms | 0.64 / 1.15 ms | 2.20 / 4.09 ms | 0.76 / 1.32 ms |

Then real Express 5 on Bun with the core's engine for `.tsx` (React), `.vue`
and `.svelte`: each `Counter` view 200 with its props rendered and the
injected `</script><b>` escaped; a throwing `.vue` view a 500 (Express's
final handler logged its stack to stderr, the only stderr output).

### 12.10 `plugins-compare.ts`: the compile step, ours against what exists

`results-plugins-compare.txt` (`NODE_ENV=production`, 300 iterations per
case, each case its own process because `Bun.plugin` is process-wide):

| Case | Cold load | Page | Render p50 / p90 | Client build (Counter) |
|---|---|---|---|---|
| Vue, our SSR compile step | 283 ms | 200 cards, 99,466 B | **0.63** / 1.07 ms | OK, 35 ms, 18.2 KiB |
| Vue, `bun-plugin-vue3` (client render functions) | 62 ms | 200 cards, 99,466 B | **1.38** / 2.94 ms | OK, 32 ms, 18.1 KiB |
| Svelte, our compile step | 63 ms | 200 cards, 97,840 B | 0.33 / 0.65 ms | OK, 27 ms, 48.7 KiB |
| Svelte, `bun-plugin-svelte` 0.0.6 | 99 ms | 200 cards, 102,259 B (source whitespace kept) | 0.37 / 0.87 ms | OK, 30 ms, 48.7 KiB |
| Svelte, ours with `experimental.async` | 64 ms | 200 cards, 97,840 B | 0.70 / 0.90 ms | OK, 34 ms, 48.7 KiB |

(The client sizes here bundle the component alone; §12.9's bundle the
hydration entry with the framework's runtime.) With `experimental.async`, a
page whose markup awaits a 50 ms promise: reading `render()` synchronously
throws `await_invalid`; awaiting it gives the data after 51 ms, with the
`<title>` in `head`. The same await inside `<svelte:boundary>` with a
`pending` snippet renders the pending snippet at once and does not wait.

A probe beside it: a `define` added to `build.config` in a plugin's
`setup()` is applied by `Bun.build` (and `conditions` likewise), on 1.4.3.

### 12.11 `errors-probe.ts`: what a throwing view leaves behind

`results-errors-probe.txt`, one process per case:

| Case | Render | Process |
|---|---|---|
| React, Svelte, Preact (through their adapters) | rejects in 2 to 17 ms | exits at once, no unhandled rejection |
| Vue, through its adapter | rejects | exits at once |
| Vue, `renderToString` with no `errorHandler`, production | **resolves `"<!---->"`** | exits at once |
| Vue, the same, development build | rejects ("Unhandled error during execution of setup function" warned) | exits at once |
| Solid, through its adapter | rejects | exits at once |
| Solid, `renderToStringAsync` | rejects | **stays alive until 30,071 ms, then an unhandled rejection, "renderToString timed out"** |

The Solid cause, read in `solid-js/web/dist/server.js:236-248`: the timeout
promise is created first, `renderToStream` then throws synchronously for a
view that throws in its shell, and `clearTimeout` runs only on the success
path. A first version of the adapter that armed its own timer before calling
`renderToStream` had the same leak (10 s), which is how it was found.

A probe beside it: a Svelte component compiled with `dev: true` throws
`context.function[FILENAME]` on the server under plain `bun`, and renders
under `bun --conditions=development` (`esm-env` resolves `DEV` through that
condition) (§7.2).

### 12.12 `frameworks-hydrate.ts`: hydration through the core, in Chrome

`results-frameworks-hydrate.txt` (`NODE_ENV=production`) and
`results-frameworks-hydrate-dev.txt` (unset), each framework in its own
process, the `Counter` view rendered by the core and hydrated from the
adapter's entry, served by bun-common under `script-src 'nonce-…'
'strict-dynamic'` with SRI, in headless Chrome through `Bun.WebView`:

| Framework | Hydrated, click → | Injected script ran | Evil text round-trips | Every `<script>` nonced, CSP violations | Bundle prod / dev | Console (prod and dev) |
|---|---|---|---|---|---|---|
| React (whole document) | ✓ "count 6" | no | ✓ | ✓, none | 207.4 / 422.0 KiB | nothing (dev: React's DevTools notice) |
| Vue | ✓ "count 6" | no | ✓ | ✓, none | 77.2 / 104.8 KiB | nothing |
| Svelte, our compile step | ✓ "count 6" | no | ✓ | ✓, none | 48.7 / 50.1 KiB | nothing |
| Svelte, `bun-plugin-svelte` | ✓ "count 6" | no | ✓ | ✓, none | 48.7 / 50.1 KiB | **"Failed to hydrate"** (then rendered on the client) |
| Preact | ✓ "count 6" | no | ✓ | ✓, none | 13.5 / 13.6 KiB | nothing |
| Solid | ✓ "count 6" | no | ✓ | ✓, none | 15.7 / 17.3 KiB | nothing |

The page's `document.title` was set where the adapter reports a head (React,
Svelte) and empty for Vue (the counter view has no `<Teleport to="head">`),
Preact and Solid (no head management): the core's `title` fallback (§4.5) was
not in the spike. The time to hydrate (0.3 to 2.5 s from navigation) includes
starting Chrome per process and is not a measure of the frameworks. In the
development run, the Svelte client compiled with `dev: true` under our step
(which adds the `development` condition) and under the official plugin
(which does not) both hydrated.

### 12.13 `frameworks-typing/`: props per framework

`tsc -p frameworks-typing` exits 0 on TypeScript 6.0.3
(`results-frameworks-typing.txt`). One `PropsOf<C>`, from an interface with
one resolver per framework, checks React `ComponentType<P>`, Vue
`defineComponent({ props })`, Svelte `Component<P>` and Solid `Component<P>`
(each `@ts-expect-error` for a wrong or missing prop is an error); a Preact
`FunctionComponent<P>` resolves to `never` until Preact's resolver is merged
in, after which it is checked and the others are unchanged. A `.vue` and a
`.svelte` file imported through the usual shims accept `{ nonsense: true }`.

---

## 13. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **The interface is wrong for a framework not yet built** | low for the five spiked; unknown beyond | it was fixed against five frameworks (§3.6); the conformance kit (§11.1) is the contract a new adapter must pass |
| **A framework renders a failure as a 200** (Vue in production) or leaks a timer (Solid) | certain without care | D17; the conformance kit asserts a rejection and nothing left behind, per adapter |
| **`Bun.plugin` is process-wide**: an adapter's compile step sees the application's own files | medium for Solid's `.tsx` | plugins filter by extension, Solid's by the views roots (§3.4) |
| **Development and production differ per framework** (Vue's error handling, Svelte's dev condition, React's async component warning) | certain | tests run both builds; the `NODE_ENV` warning (§4.9.1); Svelte's `dev` follows the runtime condition |
| **Community compile steps go stale** | high: the Vue plugins are single-maintainer, the official Svelte one last released 2025-03 | each adapter ships its own (D18), on the framework's own compiler |
| **Two copies of a framework** | medium in monorepos | peers only; the core checks at startup that the view's framework is the one the adapter imported, and fails with both paths [D] |
| **`require.cache` deletion duplicates a shared module** in development | medium | only the views roots and `watch` dirs are dropped; documented; production never drops |
| **Streamed pages keep a fallback after a late error** without hydration | certain in stream mode | buffered is React's default; stream mode logs and warns (§5.7) |
| **Props leak locals to the browser** when hydrating | certain unless filtered | `clientProps`; a development warning; README (§4.6.4) |
| **Hydration mismatch** from non-JSON props, `Date.now()`, locale, whitespace | common | the development props check; each framework's mismatch report to the console |
| **`NODE_ENV` unset in production** runs development builds | common | the startup warning (§4.9.1) |
| **A render blocks the event loop** (~0.6-3 ms per mid-size page) | inherent to SSR | caching (§4.9.2); React's `"string"` mode for hot sync views; the bench |
| **The `compression()` stall** reaches other streamed bodies today | certain now | PR-0 first; the core flushes per chunk regardless |
| **`.vue`/`.svelte` props are unchecked under `tsc`** | certain | said plainly (§4.4.3); the registry and `bun-views types` |
| **RSC expectations** | medium | §5.6 says plainly what is and is not supported |
| **Bun's TSX import, `fs.watch`, `Bun.build` or plugin behaviour changes** | low | each is a test in PR-2 to PR-5 |

---

## 14. Open questions for the user

Each has a recommended answer. Q1 to Q14 are the React plan's, restated for
the package; Q15 to Q19 are new.

1. **One package with a subpath per framework, or a package each?** **One
   package, `@kingsleyweb/bun-views`** (§9.1): the user's decision, and the
   core is most of the code.
2. **React's default render mode?** **Buffered** (§5.2): every React 19
   server feature, and a real 500 on failure, for about 1.9 ms more CPU per
   mid-size render than `renderToString`; `"string"` stays available per
   view.
3. **`@types/react` as an optional peer, or required?** **Optional**, as
   `@types/bun` is (§9.2).
4. **Confining view names to the roots: in bun-views only, or in bun-common's
   `BunViews` for every engine?** **bun-views now** (D9), because it is the
   one rendering code; recommend to the bun-common agent an opt-in on
   `BunViews` later, since Express compatibility (#320's goal) means not
   confining by default. (The React plan's Q4, `require("tsx")`, is settled
   by #320's clear error.)
5. **Several extensions** (`.jsx` beside `.tsx`, `.vue` beside `.tsx`): Express
   needs the extension for the non-default one. **Keep Express's behaviour**;
   `views.install()` registers every adapter's extensions.
6. **Hydrated pages send locals to the browser:** default to sending every
   prop, or nothing but declared `clientProps`? **Every prop, with a
   development warning listing the locals sent**, because the client must
   render the same tree; `clientProps` narrows it.
7. **Nested layouts by file convention (`_layout.tsx`)?** **No**: React's
   explicit `export const layout` chain (§5.5).
8. **HEAD in stream mode:** render as a string, or stream and let Bun cancel?
   **As a string**, matching Express's HEAD.
9. **Move bun-jobs-ui onto the shared asset code?** **Later**, by the
   bun-jobs-ui agent, once PR-5 has settled the shape.
10. **A development error page** (`viewErrorPage()`)? **Yes, development
    only, registered explicitly**; `BunViewsModule` registers it when `dev` is
    on.
11. **Caching hydrated pages with a per-request nonce:** **leave to the cache
    plan**; the default is no CSP header, so the nonce only exists when the
    application asks for one.
12. **A views page in the playground?** **No**: the playground is bun-jobs'
    showcase. The examples cover this.
13. **Islands in the first release?** **No**: PR-6 after hydration has been
    used, React first.
14. **`@RenderComponent` and `@RenderView` in bun-nest's `./views`, or in
    bun-views?** **bun-nest's `./views`** (the `./jobs` precedent; the
    decorators depend on bun-nest's `render` accepting a component).
15. **Which frameworks after React, and when?** **None up front.** Build an
    adapter when an application or the examples need it, Vue then Svelte if
    both are asked for: the spikes make each a known ~3-4 d (§15.2), and an
    adapter built without a user would be designed against fixtures only.
    The core is built and tested against a fake second adapter (a fragment
    adapter with a compile step) in PR-2, so it does not drift React-shaped
    meanwhile.
16. **Does the compile step for `.vue`/`.svelte` ship in the adapter, or is
    it the user's?** **In the adapter**, with an option to pass another
    (`svelte({ plugin: SveltePlugin(…) })`): the existing Vue plugin cannot
    compile for SSR (2.2 times slower renders), the official Svelte one
    cannot enable async rendering, and a user-supplied plugin must match the
    adapter's server and client sides exactly, which is easy to get wrong
    (Svelte's `dev`, §7.2).
17. **Are Preact and Solid worth adapters?** **Preact: only on request** (no
    compile step, ~1.5 d, but it competes with React for `.tsx`). **Solid:
    not unless asked**: a Babel 7 toolchain as peers, a timer leak to work
    around, and the same `.tsx` contest, for ~3 d.
18. **`@RenderComponent` with a component the core never loaded** (imported
    by the controller): how does bun-views find its adapter? **Record each
    loaded module's adapter, and add an optional `owns(component)` member to
    the interface only if that proves insufficient**; the first bun-nest PR
    decides with a test (§10.3).
19. **Two JSX frameworks in one application** (React and Preact or Solid, all
    on `.tsx`)? **One per extension, no auto-detection** (D16): a second one
    takes another extension. Detecting the framework from a file's pragma or
    imports is guesswork.

---

## 15. PR slicing and effort

Focused days for someone who knows the code. Each PR passes the full gate
alone (`bun scripts/typecheck.ts`, `CI=1 bunx eslint .` in each touched
package, `bun run test`, the consumer check where `exports` change, and the
affected examples). Each PR that changes something the examples read is
reported to the examples agent before merging.

### 15.1 The core and React

| PR | Was (React plan) | Ships | Depends on | Effort | [C] |
|---|---|---|---|---|---|
| **PR-0** | PR-0 | `zlibReadable` loops until it enqueues or ends; tests read compressed streams to the end | — | ~1 d | no |
| **PR-C** | PR-C | (#320) bun-common's `BunViews`, `res.render`; bun-nest's `@Render`, `engine`, `setViewEngine`, `setBaseViewsDir`, `setLocal`, `set` | — | **merged** | — |
| **PR-C2** | — | (in progress, `fix/bun-common-express-parity`) bun-common's adapter and router: a `views` option and `engine()` | PR-C | in flight | — |
| **PR-1** | PR-1 | the `renderToStream` capability in `res.render`; `escapeHtml`, `jsonForScript`, `createNonce` in `native.ts` (replacing bun-common's two private copies) | PR-C | ~1.5 d | yes |
| **PR-2** | PR-2, core half | `packages/bun-views`: the adapter interface, `createViews`, `engine()`, `install()`, loading with `Bun.plugin` registration, props, the shell and title, errors and logging, the deadline, path containment, `preload`, the `NODE_ENV` warning, the registry types, `PropsOf`, `bun-views types`; the conformance kit (`./testing`) and a fake fragment adapter; dts recipe, consumer check | PR-C (PR-1 for streams) | ~3.5 d | yes |
| **PR-3** | PR-2, React half | `./react`: modes, document and layouts, React's `onError`, its props resolver; the kit against it | PR-2 | ~2.5 d | no |
| **PR-4** | PR-3 | development reload: watcher, `require.cache` invalidation, compile-step files, `liveReload` over SSE | PR-2 | ~1.5 d | no |
| **PR-5** | PR-4 | hydration: virtual client entries, `Bun.build` once per process and `bun-views build`, the asset router, CSP and SRI, props transport and checks, React's entry and `./react/client`, the Chrome e2e and a bundle budget | PR-3, PR-1 | ~5 d | no |
| **PR-6** | PR-5 | islands (React) | PR-5 | ~2.5 d | no |
| **PR-7** | PR-6 | bun-nest `./views`: `BunViewsModule`, `RenderComponent`, `RenderView`, `render()` accepting a component; per-framework type tests; consumer check with `peers` | PR-3, PR-C | ~3 d | yes |
| **PR-8** | PR-7 | `bench/` with `--compare`, baselines and the stall and TTFB assertions | PR-3 | ~1.5 d | no |
| *EX* | *EX* | the examples of §11.2 (examples agent) | each PR | *~3.5 d* | |
| | | **Total, core and React** | | **~22 d** | |

**Order:** PR-0 now, in parallel with everything. PR-1 ∥ PR-2 → PR-3 →
(PR-4 ∥ PR-5 ∥ PR-7 ∥ PR-8) → PR-6. PR-C has merged, so nothing waits on
it; PR-C2 is needed only for bun-common applications to call
`app.engine()` (bun-nest has it, and a bun-common application can hand
responses a `BunViews` meanwhile).

### 15.2 Later adapters, on demand

| PR | Ships | Depends on | Effort |
|---|---|---|---|
| **PR-9v** | `./vue`: the SFC compile step with styles (`compileStyle`, scoped CSS as a build output), `<script>` named exports, the `errorHandler` rejection, teleported head, `renderToWebStream`, `createSSRApp().mount` entry, props resolver; the kit, a reload test, Chrome e2e, an example | PR-5 | ~4 d |
| **PR-9s** | `./svelte`: the compile step (both sides, `dev` from the runtime condition, `experimental.async` option, CSS as a build output, `.svelte.ts` modules), `await render()`, `hydrate()` entry, props resolver; the kit, e2e, an example | PR-5 | ~3 d |
| **PR-9p** | `./preact`: `renderToStringAsync` and the stream, `hydrate()` entry, props resolver; the kit, e2e, an example | PR-5 | ~1.5 d |
| **PR-9so** | `./solid`: the Babel compile step filtered to the roots, the leak-free render, the hydration script, `hydrate()` entry, props resolver; the kit, e2e, an example | PR-5 | ~3 d |
| | **Total if all four are built** | | **~11.5 d** |

---

## 16. Names needing approval

Every new public name. None is built.

| Name | Kind | Where | Why this name |
|---|---|---|---|
| `@kingsleyweb/bun-views` | package | `packages/bun-views` | the family's `bun-` prefix; plural, as it renders views of any kind (the user said "bun-view"; §14 Q1) |
| `@kingsleyweb/bun-views/react`, `/vue`, `/svelte`, `/preact`, `/solid` | subpaths | the adapters | the framework's own name |
| `@kingsleyweb/bun-views/react/client` | subpath | React's hydration runtime (browser entry) | as `./client` in the React plan |
| `@kingsleyweb/bun-views/testing` | subpath | the adapter conformance kit | as bun-jobs' provider kit |
| `createViews(options)` | function | root | returns the views: `engine(ext)`, `install(app)`, `assets` |
| `react(options)`, `vue()`, `svelte()`, `preact()`, `solid()` | functions | each subpath | return a `ViewAdapter`, named after the framework as bun-jobs' drivers are |
| `ViewAdapter`, `RenderInput`, `RenderOutput`, `StreamOutput`, `ClientEntryInput`, `ViewSide` | types | root | the adapter interface (§3.2) |
| `CreateViewsOptions`: `adapters`, `hydrate`, `preload`, `dev`, `watch`, `liveReload`, `renderTimeout`, `assetsPath`, `csp`, `shell`, `logger` | options | root | one word each, matching `jobsUi()`'s `dev` and `logger` |
| React's options: `mode`, `document`, `layout` | options | `./react` | as in the React plan |
| `"string" \| "buffered" \| "stream"` | React `mode` values | `./react` | what each sends |
| view module exports `default`, `hydrate`, `clientProps`, `cache`, `title` (core); `layout`, `document`, `mode` (React) | conventions | view files | read by the core and the adapter |
| `Views`, `ViewLocals` | augmentable interfaces | root | the registry and the locals (were `ReactViews`, `ReactViewLocals`) |
| `ComponentPropsOf`, `PropsOf` | augmentable interface, type | root | the per-framework props resolver (§4.4.2) |
| `DefaultDocument`, `ViewAssets`, `Island` | components | `./react` | — |
| `viewErrorPage()` | error handler | root | the development error page (§4.8.1) |
| `bun-views build`, `bun-views types` | CLI | `bin` | prebuild assets; write the registry |
| `renderToStream` (optional member of an engine function) | engine capability | bun-common's view types | React's own verb, and generic enough |
| `escapeHtml`, `jsonForScript`, `createNonce` | functions | bun-common `native.ts` | moved from bun-jobs-ui's `shell.ts`, same names |
| `__BV_PROPS`, `bv-root` | a global and an element id | the shell | short, prefixed; were `__RV_PROPS` |
| `@kingsleyweb/bun-nest/views` | subpath | bun-nest | as `./jobs` (was `./react`) |
| `BunViewsModule` (`forRoot`, `forRootAsync`) | Nest module | bun-nest `./views` | Nest's module convention (was `ReactViewsModule`) |
| `RenderComponent`, `RenderView` | decorators | bun-nest `./views` | beside Nest's `Render` |

---

## Appendix: evidence

[`evidence/bun-views/`](evidence/bun-views/README.md) holds every script
and its raw output, and a `package.json` of its own: React, Express, Vue,
Svelte (and `bun-plugin-svelte`, `bun-plugin-vue3`), Preact
(and `preact-render-to-string`) and Solid (and `babel-preset-solid`, Babel
7) are installed there only, in its git-ignored `node_modules/`. Like the
other evidence folders, it is not part of any package, and the repo's
tooling does not typecheck or lint it.
