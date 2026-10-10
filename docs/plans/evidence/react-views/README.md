# Evidence: React views

The evidence behind [`../../react-views.md`](../../react-views.md). Gathered
on **2026-10-10**, on one shared laptop: i9-11900H with 16 threads, Linux
7.0.0-38-generic, Bun 1.4.3 (`bbdc5a519`, the canary build the repo runs),
Node v24.2.0, React and React DOM 19.3.0, Express 5.3.0, TypeScript 6.0.3.
Peer sessions ran at the same time, at a 1-minute load average between 8 and
41, so compare within a run rather than across machines.

Nothing here is part of a published package, and the repo's tooling does not
build, typecheck or lint it ([`../README.md`](../README.md) says why). This
folder is its own Bun project: `react`, `react-dom` and `express` are
installed here, in `node_modules/`, and nowhere else. Run `bun install` in
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
| `results-*.txt` | The output of each script, as run on 2026-10-10 | — |

`hydrate.tsx`, `view-loading.ts` and `express-contract.ts` take an optional
scratch directory as their first argument (default: a temporary directory)
and delete it when they finish. They write their views there, with a
`node_modules` symlink back to this folder's, so `react` resolves to this
folder's single copy.
