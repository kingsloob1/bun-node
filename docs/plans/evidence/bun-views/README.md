# Evidence: bun-views

The evidence behind [`../../bun-views.md`](../../bun-views.md) (which began
as the React views plan; this folder was `react-views/`, and the
`results-*.txt` files captured then still print that path). Gathered on
**2026-10-10**, on one shared laptop: i9-11900H with 16 threads, Linux
7.0.0-38-generic, Bun 1.4.3 (`bbdc5a519`, the canary build the repo runs),
Node v24.2.0, React and React DOM 19.3.0, Express 5.3.0, Vue 3.5.43, Svelte
5.57.2 (and `bun-plugin-svelte` 0.0.6), `bun-plugin-vue3` 1.1.0, Preact
11.0.1 (and `preact-render-to-string` 6.8.0), Solid 1.9.17 (and
`babel-preset-solid` 1.9.16, Babel 7.29), TypeScript 6.0.3. Peer sessions
ran at the same time, at a 1-minute load average between 4 and 47, so
compare within a run rather than across machines.

Nothing here is part of a published package, and the repo's tooling does not
build, typecheck or lint it ([`../README.md`](../README.md) says why). This
folder is its own Bun project: `react`, `react-dom` and `express` are
installed here, in `node_modules/` (git-ignored), and nowhere else, as are
the Vue, Svelte, Preact and Solid packages. Run `bun install` in
this folder first. The bun-common scripts import the package source by
relative path, so they also need `bun install` at the repo root.

| Path | What it is | Re-run (from this folder) |
|---|---|---|
| `views/catalog.js` | The mid-size page every spike renders: 200 product cards, a nav and a footer, about 95 KB of HTML, written with `createElement` so Node runs the same file. An optional Suspense section reads a promise with `use()` | — |
| `render-modes.ts` | `renderToString`, `renderToReadableStream` (drained, with and without `allReady`) and `prerender`, in process, 1,000 iterations each rendering once per mode in a rotating order: ms per render and renders per second on one core; then a page whose Suspense section waits 50 ms: shell, first chunk, last chunk | `NODE_ENV=production bun render-modes.ts`, and again without `NODE_ENV` |
| `react19.tsx` | React 19 behaviour the design rests on: doctype, `<title>`/`<meta>`/`<link>` hoisting, async components, `use()`, errors in and after the shell, `nonce`, bootstrap modules, abort, escaping | `NODE_ENV=production bun react19.tsx` |
| `http-serve.ts` | The same page through bun-common's `BunHttpAdapter` over a socket, server in a child process: TTFB (headers, first byte, last byte) for string, stream and buffered-Suspense routes, with and without `compression()`; HEAD on a streamed page; a shell error, a boundary error after the shell, a body stream that breaks after the headers | `NODE_ENV=production bun http-serve.ts` |
| `gz-stall.ts` | The `compression()` stall without React: a streamed body (enqueued from `start()` or one chunk per `pull()`, with and without a pause) through gzip, br and identity | `bun gz-stall.ts` |
| `gz-stall-controls.ts` | The two controls that place the stall in bun-common, not Bun: Bun.serve delivers chunks enqueued outside `pull()`; `node:zlib` on Bun calls back and ends | `bun gz-stall-controls.ts` |
| `stream-error-after-headers.ts` | A body stream that errors after 1000 bytes, directly and through `pipeThrough`, on plain `Bun.serve` and on bun-common: the client sees a reset, not a clean truncated 200 | `bun stream-error-after-headers.ts` |
| `node-express.mjs` | The comparator: the same view on Express 5, with `/string`, `/engine` (the Express engine contract through `res.render`) and `/stream` (`renderToPipeableStream`) | `NODE_ENV=production node node-express.mjs` (or `bun`) |
| `bench.ts` | Throughput and latency with `oha` (`-c 32`), 4 interleaved rounds, medians: bun-common on Bun, Express 5 on Node, Express 5 on Bun, each on `/string`, `/engine` and `/stream`. **Heavy**: run it through the heavy-run wrapper with `HEAVY_MODE=exclusive`; on a shared machine its rounds were five times apart | `NODE_ENV=production bun bench.ts` |
| `view-loading.ts` | Loading `.tsx` views by path: cold and warm import, what query-string busting and `require.cache` deletion each reload (the view and a layout it imports), RSS over 300 reloads, a server-side `Bun.build` per view with its metafile inputs, `fs.watch` on the tree | `NODE_ENV=production bun view-loading.ts` |
| `express-contract.ts` | A React engine on the Express contract, driven by real Express 5 on Bun: what `options` holds, directory index, `.jsx` beside `.tsx`, a view with no default export, view names climbing out of the views directory, `res.render`'s callback form, a view engine with no engine registered | `NODE_ENV=production bun express-contract.ts` |
| `hydrate.tsx` | Hydration in headless Chrome (`Bun.WebView`): per-view client entries built in memory by `Bun.build`, served by bun-common under a nonce CSP with SRI, props carried two ways, and an async server component in a hydrated tree. **Heavy** (Chrome): run it through the wrapper | `NODE_ENV=production bun hydrate.tsx`, and again without `NODE_ENV` (`results-hydrate-dev.txt`) |
| `typing/` | A type-level spike: `@RenderComponent(Component)` and `@RenderView("Name")` constraining a handler's return type under `experimentalDecorators`, a typed `res.render` and the overload trap beside it. Each `@ts-expect-error` is a negative control | `../../../../node_modules/.bin/tsc -p typing` |
| `core/interface.ts` | The adapter interface the plan proposes (§3.2): `ViewAdapter`, `RenderInput`, `RenderOutput`, `StreamOutput`, `ClientEntryInput` | — |
| `core/mini-core.ts` | A minimal framework-agnostic core over that interface: load a view by path (registering the adapter's compile step with `Bun.plugin`), render, wrap a fragment in a shell, stream, build per-view client entries as virtual modules with `Bun.build`, and an Express engine with the optional `renderToStream` | — |
| `adapters/` | Five adapters (`react.tsx`, `vue.ts`, `svelte.ts`, `preact.ts`, `solid.ts`) and the compile steps in `adapters/plugins/` (`vue-sfc.ts`, `svelte-compile.ts`, `solid-babel.ts`) | — |
| `fviews/` | The catalogue page, a counter and a throwing view per framework (`fviews/<framework>/`), plus Svelte's async pages; `fviews/data.ts` is the shared catalogue data | — |
| `frameworks-ssr.ts` | All five adapters through the core in one process: cold and warm loads, the catalogue as a string (bytes, title in head, escaping), 50 ms async data as a string and a stream, a throwing view, a client bundle per framework, real Express 5 rendering `.tsx`, `.vue` and `.svelte` through the core's engine, then render time per framework in a rotating order | `NODE_ENV=production bun frameworks-ssr.ts` |
| `plugins-compare.ts` | The compile step, ours against what exists, each case in its own process: Vue through our SSR compile step against `bun-plugin-vue3`; Svelte through ours against the official `bun-plugin-svelte`; Svelte's `experimental.async` | `NODE_ENV=production bun plugins-compare.ts` |
| `errors-probe.ts` | What a throwing view leaves behind, per framework and per raw API: Vue without an `errorHandler` (production and development), Solid's `renderToStringAsync` timer | `NODE_ENV=production bun errors-probe.ts <react\|vue\|vue-bare\|svelte\|preact\|solid\|solid-bare>` (and `bun errors-probe.ts vue-bare` for Vue's development build) |
| `frameworks-hydrate.ts` | Hydration of every adapter's counter view through the core, in headless Chrome (`Bun.WebView`), under a nonce CSP with SRI, each framework in its own process (`svelte-official` uses `bun-plugin-svelte`). **Heavy** (Chrome): run it through the wrapper. `HYDRATE_NO_CHROME=1` serves the pages without Chrome | `NODE_ENV=production bun frameworks-hydrate.ts`, and again without `NODE_ENV` (`results-frameworks-hydrate-dev.txt`) |
| `frameworks-typing/` | A type-level spike: one `PropsOf<C>` with a resolver per framework, checked against React, Vue, Svelte, Solid and Preact components, and the shim hole for `.vue` and `.svelte` files. Each `@ts-expect-error` is a negative control | `../../../../node_modules/.bin/tsc -p frameworks-typing` |
| `results-*.txt` | The output of each script, as run on 2026-10-10 | — |

`hydrate.tsx`, `view-loading.ts` and `express-contract.ts` take an optional
scratch directory as their first argument (default: a temporary directory)
and delete it when they finish. They write their views there, with a
`node_modules` symlink back to this folder's, so `react` resolves to this
folder's single copy.
