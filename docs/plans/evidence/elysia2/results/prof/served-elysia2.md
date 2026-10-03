# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 6.30s | 462 | 200us | 314 |

**Top 10:** `write` 36.7%, `Response` 19.1%, `data` 16.3%, `(anonymous)` 5.8%, `toString` 4.7%, `findRoute` 3.8%, `extractPath` 3.1%, `Context` 2.2%, `data` 1.6%, `anonymous` 1.1%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 36.7% | 2.31s | 36.7% | 2.31s | `write` | `[native code]` |
| 19.1% | 1.20s | 19.1% | 1.20s | `Response` | `[native code]` |
| 16.3% | 1.02s | 16.6% | 1.04s | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:78` |
| 5.8% | 370.3ms | 9.0% | 568.6ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:332` |
| 4.7% | 297.1ms | 4.7% | 297.1ms | `toString` | `[native code]` |
| 3.8% | 239.4ms | 3.8% | 239.4ms | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:85` |
| 3.1% | 198.3ms | 3.1% | 198.3ms | `extractPath` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:16` |
| 2.2% | 143.5ms | 2.2% | 143.5ms | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:55` |
| 1.6% | 105.0ms | 38.4% | 2.42s | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:89` |
| 1.1% | 74.8ms | 13.3% | 841.1ms | `anonymous` | `[native code]` |
| 1.1% | 73.6ms | 36.0% | 2.26s | `fetch` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:55` |
| 0.6% | 43.0ms | 0.6% | 43.0ms | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:57` |
| 0.6% | 41.2ms | 23.7% | 1.49s | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:335` |
| 0.6% | 39.2ms | 0.8% | 54.0ms | `map` | `[native code]` |
| 0.2% | 18.3ms | 0.2% | 18.3ms | `indexOf` | `[native code]` |
| 0.2% | 15.8ms | 0.2% | 15.8ms | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:83` |
| 0.1% | 9.5ms | 0.1% | 9.5ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:137` |
| 0.1% | 9.4ms | 0.1% | 9.4ms | `Request` | `[native code]` |
| 0.0% | 5.7ms | 0.0% | 5.7ms | `(anonymous)` | `[native code]` |
| 0.0% | 5.2ms | 0.0% | 5.2ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs` |
| 0.0% | 5.0ms | 0.0% | 5.0ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:28` |
| 0.0% | 4.0ms | 19.1% | 1.20s | `mapCompactResponse` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:85` |
| 0.0% | 3.0ms | 0.0% | 3.0ms | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:70` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `responseTag` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:80` |
| 0.0% | 1.8ms | 13.4% | 844.3ms | `require` | `[native code]` |
| 0.0% | 1.5ms | 2.9% | 188.5ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:331` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:158` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `resetNode` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:19` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `WeakMap` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `stub` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/typebox-type.mjs` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `update` | `[native code]` |
| 0.0% | 966us | 0.0% | 966us | `defineProperty` | `[native code]` |
| 0.0% | 908us | 0.0% | 908us | `serve` | `[native code]` |
| 0.0% | 853us | 0.0% | 853us | `startsWith` | `[native code]` |
| 0.0% | 853us | 0.0% | 853us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 826us | 0.0% | 826us | `importModule` | `[native code]` |
| 0.0% | 797us | 0.0% | 797us | `createParamNode` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` |
| 0.0% | 747us | 0.0% | 747us | `connect` | `[native code]` |
| 0.0% | 743us | 0.0% | 743us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:261` |
| 0.0% | 721us | 0.0% | 721us | `assertUncontested` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/aot.mjs` |
| 0.0% | 635us | 0.0% | 635us | `async run` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts` |
| 0.0% | 634us | 0.0% | 634us | `compileHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 611us | 0.0% | 4.7ms | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1625` |
| 0.0% | 590us | 0.0% | 590us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/index.js` |
| 0.0% | 583us | 0.0% | 583us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js` |
| 0.0% | 550us | 0.0% | 550us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js` |
| 0.0% | 523us | 0.0% | 523us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js` |
| 0.0% | 506us | 0.0% | 506us | `get` | `[native code]` |
| 0.0% | 502us | 0.0% | 502us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/index.js` |
| 0.0% | 500us | 0.0% | 500us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/index.js` |
| 0.0% | 500us | 0.0% | 500us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js` |
| 0.0% | 487us | 0.0% | 487us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/bigint/index.js` |
| 0.0% | 477us | 0.0% | 477us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:3` |
| 0.0% | 477us | 0.0% | 477us | `#publishGeneration` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1507` |
| 0.0% | 476us | 0.0% | 476us | `requireExactMirror` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror-require.mjs` |
| 0.0% | 473us | 0.0% | 473us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/validator-cache.mjs` |
| 0.0% | 470us | 0.0% | 470us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/index.js` |
| 0.0% | 468us | 0.0% | 468us | `numericString` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/elysia/numeric.mjs` |
| 0.0% | 456us | 0.0% | 456us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/async-iterator/index.js` |
| 0.0% | 449us | 0.0% | 449us | `slice` | `[native code]` |
| 0.0% | 445us | 0.0% | 445us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` |
| 0.0% | 438us | 0.0% | 438us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js` |
| 0.0% | 437us | 0.0% | 437us | `keep` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/elysia/keep-config.mjs` |
| 0.0% | 435us | 0.0% | 435us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js` |
| 0.0% | 431us | 0.0% | 431us | `#assertRouteModelRefs` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 428us | 0.0% | 428us | `hasMacroKey` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 427us | 0.0% | 427us | `handler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1248` |
| 0.0% | 427us | 0.0% | 427us | `createErrorHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/error.mjs` |
| 0.0% | 427us | 0.0% | 427us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect-evaluated.js:3` |
| 0.0% | 426us | 0.0% | 426us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js` |
| 0.0% | 425us | 0.0% | 425us | `handler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 425us | 0.0% | 425us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:168` |
| 0.0% | 421us | 0.0% | 421us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js` |
| 0.0% | 420us | 0.0% | 420us | `expandPaths` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 419us | 0.0% | 419us | `resolveLocalHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 417us | 0.0% | 417us | `collectHookOrigins` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 417us | 0.0% | 417us | `__export` | `/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js` |
| 0.0% | 412us | 0.0% | 412us | `buildRouteTable` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:36` |
| 0.0% | 412us | 0.0% | 412us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:3` |
| 0.0% | 410us | 0.0% | 410us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/index.js` |
| 0.0% | 403us | 0.0% | 403us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:150` |
| 0.0% | 401us | 0.0% | 401us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js` |
| 0.0% | 395us | 0.0% | 395us | `#publishGeneration` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1508` |
| 0.0% | 387us | 0.0% | 387us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 384us | 0.0% | 384us | `createFetchHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` |
| 0.0% | 377us | 0.0% | 377us | `from` | `[native code]` |
| 0.0% | 377us | 0.0% | 377us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js` |
| 0.0% | 376us | 0.0% | 376us | `buildRouteTable` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:29` |
| 0.0% | 376us | 0.0% | 376us | `checkSlots` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 362us | 0.0% | 362us | `push` | `[native code]` |
| 0.0% | 361us | 0.0% | 361us | `isArray` | `[native code]` |
| 0.0% | 358us | 0.0% | 358us | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` |
| 0.0% | 356us | 0.0% | 356us | `createResponseHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/utils.mjs` |
| 0.0% | 355us | 0.0% | 2.3ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:6` |
| 0.0% | 350us | 0.0% | 350us | `#hookHasTypeBox` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 344us | 0.0% | 344us | `map` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/utils.mjs` |
| 0.0% | 327us | 0.0% | 327us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:64` |
| 0.0% | 322us | 0.0% | 322us | `async run` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:95` |
| 0.0% | 321us | 0.0% | 321us | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs` |
| 0.0% | 313us | 0.0% | 313us | `#jitDispatch` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1327` |
| 0.0% | 307us | 0.0% | 307us | `#jitDispatch` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1313` |
| 0.0% | 307us | 0.0% | 307us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs` |
| 0.0% | 306us | 0.0% | 306us | `setPrototypeDirectOrThrow` | `[native code]` |
| 0.0% | 301us | 0.0% | 301us | `stub` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/bridge.mjs` |
| 0.0% | 271us | 0.1% | 9.7ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:56` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 38.4% | 2.42s | 1.6% | 105.0ms | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:89` |
| 36.7% | 2.31s | 36.7% | 2.31s | `write` | `[native code]` |
| 36.0% | 2.26s | 1.1% | 73.6ms | `fetch` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:55` |
| 35.7% | 2.25s | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:66` |
| 23.7% | 1.49s | 0.6% | 41.2ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:335` |
| 19.2% | 1.21s | 0.0% | 0us | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:94` |
| 19.1% | 1.20s | 0.0% | 4.0ms | `mapCompactResponse` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:85` |
| 19.1% | 1.20s | 19.1% | 1.20s | `Response` | `[native code]` |
| 18.5% | 1.16s | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:161` |
| 16.6% | 1.04s | 16.3% | 1.02s | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:78` |
| 13.4% | 844.7ms | 0.0% | 0us | `bound require` | `[native code]` |
| 13.4% | 844.3ms | 0.0% | 1.8ms | `require` | `[native code]` |
| 13.3% | 841.1ms | 1.1% | 74.8ms | `anonymous` | `[native code]` |
| 9.0% | 568.6ms | 5.8% | 370.3ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:332` |
| 4.7% | 297.1ms | 4.7% | 297.1ms | `toString` | `[native code]` |
| 4.7% | 297.1ms | 0.0% | 0us | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:77` |
| 3.8% | 239.4ms | 3.8% | 239.4ms | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:85` |
| 3.1% | 198.3ms | 3.1% | 198.3ms | `extractPath` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:16` |
| 2.9% | 188.5ms | 0.0% | 1.5ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:331` |
| 2.2% | 143.5ms | 2.2% | 143.5ms | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:55` |
| 1.4% | 92.5ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror.mjs:7` |
| 1.4% | 92.0ms | 0.0% | 0us | `requireExactMirror` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror-require.mjs:4` |
| 1.4% | 89.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js:29` |
| 1.3% | 81.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/index.js:19` |
| 1.2% | 80.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/index.js:18` |
| 0.8% | 54.0ms | 0.6% | 39.2ms | `map` | `[native code]` |
| 0.7% | 47.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:7` |
| 0.7% | 47.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js:18` |
| 0.7% | 44.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof-from-mapped-result.js:5` |
| 0.6% | 43.0ms | 0.6% | 43.0ms | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:57` |
| 0.6% | 42.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:20` |
| 0.6% | 38.2ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs:77` |
| 0.4% | 28.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:13` |
| 0.4% | 28.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js:18` |
| 0.4% | 26.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed-from-mapped-key.js:5` |
| 0.3% | 23.2ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:57` |
| 0.3% | 21.5ms | 0.0% | 0us | `#dispatch` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1646` |
| 0.3% | 20.7ms | 0.0% | 0us | `#buildRouter` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1455` |
| 0.2% | 18.3ms | 0.2% | 18.3ms | `indexOf` | `[native code]` |
| 0.2% | 15.8ms | 0.2% | 15.8ms | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:83` |
| 0.2% | 15.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:6` |
| 0.1% | 12.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:14` |
| 0.1% | 11.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js:18` |
| 0.1% | 11.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js:19` |
| 0.1% | 10.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/check.js:11` |
| 0.1% | 10.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:14` |
| 0.1% | 10.3ms | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1530` |
| 0.1% | 9.7ms | 0.0% | 271us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:56` |
| 0.1% | 9.5ms | 0.1% | 9.5ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:137` |
| 0.1% | 9.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed-property-keys.js:5` |
| 0.1% | 9.4ms | 0.0% | 0us | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` |
| 0.1% | 9.4ms | 0.1% | 9.4ms | `Request` | `[native code]` |
| 0.1% | 7.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/index.js:18` |
| 0.1% | 7.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:12` |
| 0.1% | 6.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js:6` |
| 0.1% | 6.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/index.js:18` |
| 0.1% | 6.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/index.js:22` |
| 0.0% | 5.8ms | 0.0% | 0us | `mapBack` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs:2` |
| 0.0% | 5.8ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs:78` |
| 0.0% | 5.7ms | 0.0% | 5.7ms | `(anonymous)` | `[native code]` |
| 0.0% | 5.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:20` |
| 0.0% | 5.2ms | 0.0% | 5.2ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs` |
| 0.0% | 5.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/index.js:18` |
| 0.0% | 5.0ms | 0.0% | 5.0ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:28` |
| 0.0% | 4.9ms | 0.0% | 0us | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:90` |
| 0.0% | 4.7ms | 0.0% | 611us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1625` |
| 0.0% | 3.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect-evaluated.js:9` |
| 0.0% | 3.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/unsafe.js:5` |
| 0.0% | 3.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js:5` |
| 0.0% | 3.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js:18` |
| 0.0% | 3.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/index.js:18` |
| 0.0% | 3.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:13` |
| 0.0% | 3.2ms | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1536` |
| 0.0% | 3.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:15` |
| 0.0% | 3.0ms | 0.0% | 3.0ms | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:70` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `responseTag` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs` |
| 0.0% | 2.7ms | 0.0% | 0us | `mapCompactResponse` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:84` |
| 0.0% | 2.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/optional-from-mapped-result.js:6` |
| 0.0% | 2.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js:5` |
| 0.0% | 2.3ms | 0.0% | 355us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:6` |
| 0.0% | 2.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/index.js:19` |
| 0.0% | 2.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/index.js:39` |
| 0.0% | 2.1ms | 0.0% | 0us | `#assertRouteModelRefs` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1425` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:13` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/type.js:6` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:80` |
| 0.0% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:10` |
| 0.0% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:15` |
| 0.0% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof-from-mapped-result.js:6` |
| 0.0% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/policy.js:5` |
| 0.0% | 1.6ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:54` |
| 0.0% | 1.6ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:54` |
| 0.0% | 1.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:22` |
| 0.0% | 1.6ms | 0.0% | 0us | `async run` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:61` |
| 0.0% | 1.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/hash/index.js:18` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js:18` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:16` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/unsafe.js:6` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js:8` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/index.js:20` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/index.js:18` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:9` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:10` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/type.js:7` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-from-mapped-key.js:7` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/optional.js:9` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:18` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:7` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/index.js:18` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:158` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:10` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:18` |
| 0.0% | 1.2ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:104` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:17` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `resetNode` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:19` |
| 0.0% | 1.2ms | 0.0% | 0us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:195` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:20` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `WeakMap` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:69` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `stub` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/typebox-type.mjs` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/typebox-type.mjs:43` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/index.js:20` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `update` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/cookie/crypto.mjs:24` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/cookie/crypto.mjs:22` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/registry/index.js:38` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:18` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:11` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/symbols/index.js:18` |
| 0.0% | 992us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:12` |
| 0.0% | 966us | 0.0% | 966us | `defineProperty` | `[native code]` |
| 0.0% | 963us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:24` |
| 0.0% | 960us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:7` |
| 0.0% | 949us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/immutable.js:38` |
| 0.0% | 945us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/array/index.js:18` |
| 0.0% | 944us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/async-iterator/index.js:18` |
| 0.0% | 941us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/index.js:18` |
| 0.0% | 925us | 0.0% | 0us | `#jitDispatch` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1320` |
| 0.0% | 918us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends.js:9` |
| 0.0% | 908us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:55` |
| 0.0% | 908us | 0.0% | 908us | `serve` | `[native code]` |
| 0.0% | 895us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:6` |
| 0.0% | 894us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:9` |
| 0.0% | 872us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:5` |
| 0.0% | 872us | 0.0% | 0us | `#buildRouter` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1467` |
| 0.0% | 869us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:8` |
| 0.0% | 861us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/iterator/index.js:18` |
| 0.0% | 860us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/pattern.js:6` |
| 0.0% | 854us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js:18` |
| 0.0% | 854us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/computed.js:5` |
| 0.0% | 853us | 0.0% | 853us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 853us | 0.0% | 853us | `startsWith` | `[native code]` |
| 0.0% | 837us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:11` |
| 0.0% | 826us | 0.0% | 0us | `async elysiaApp` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:32` |
| 0.0% | 826us | 0.0% | 826us | `importModule` | `[native code]` |
| 0.0% | 826us | 0.0% | 0us | `async elysiaApp` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:33` |
| 0.0% | 821us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:21` |
| 0.0% | 811us | 0.0% | 0us | `#dispatch` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1648` |
| 0.0% | 806us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:12` |
| 0.0% | 801us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/hash/hash.js:40` |
| 0.0% | 797us | 0.0% | 0us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:205` |
| 0.0% | 797us | 0.0% | 797us | `createParamNode` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` |
| 0.0% | 784us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof.js:10` |
| 0.0% | 776us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:19` |
| 0.0% | 764us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:20` |
| 0.0% | 747us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:19` |
| 0.0% | 747us | 0.0% | 747us | `connect` | `[native code]` |
| 0.0% | 747us | 0.0% | 0us | `async run` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:72` |
| 0.0% | 743us | 0.0% | 743us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:261` |
| 0.0% | 741us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/index.js:18` |
| 0.0% | 721us | 0.0% | 721us | `assertUncontested` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/aot.mjs` |
| 0.0% | 721us | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1561` |
| 0.0% | 635us | 0.0% | 635us | `async run` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts` |
| 0.0% | 634us | 0.0% | 634us | `compileHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 590us | 0.0% | 590us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/index.js` |
| 0.0% | 590us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/index.js:15` |
| 0.0% | 583us | 0.0% | 583us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js` |
| 0.0% | 583us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect-evaluated.js:10` |
| 0.0% | 583us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js:15` |
| 0.0% | 556us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:15` |
| 0.0% | 556us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:9` |
| 0.0% | 550us | 0.0% | 550us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js` |
| 0.0% | 526us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/sets/index.js:18` |
| 0.0% | 524us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/index.js:19` |
| 0.0% | 523us | 0.0% | 523us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js` |
| 0.0% | 523us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:15` |
| 0.0% | 518us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/array/array.js:6` |
| 0.0% | 515us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:6` |
| 0.0% | 512us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:9` |
| 0.0% | 506us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-from-mapped-result.js:6` |
| 0.0% | 506us | 0.0% | 506us | `get` | `[native code]` |
| 0.0% | 505us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof.js:11` |
| 0.0% | 502us | 0.0% | 502us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/index.js` |
| 0.0% | 502us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/index.js:15` |
| 0.0% | 500us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js:195` |
| 0.0% | 500us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/discard/index.js:18` |
| 0.0% | 500us | 0.0% | 500us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js` |
| 0.0% | 500us | 0.0% | 500us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/index.js` |
| 0.0% | 500us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/index.js:15` |
| 0.0% | 499us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect.js:6` |
| 0.0% | 487us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/bigint/index.js:18` |
| 0.0% | 487us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/bigint/index.js:15` |
| 0.0% | 487us | 0.0% | 487us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/bigint/index.js` |
| 0.0% | 478us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/boolean/index.js:18` |
| 0.0% | 477us | 0.0% | 477us | `#publishGeneration` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1507` |
| 0.0% | 477us | 0.0% | 477us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:3` |
| 0.0% | 476us | 0.0% | 476us | `requireExactMirror` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror-require.mjs` |
| 0.0% | 474us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/union-evaluated.js:10` |
| 0.0% | 473us | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/validator-cache.mjs:146` |
| 0.0% | 473us | 0.0% | 473us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/validator-cache.mjs` |
| 0.0% | 471us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/constructor/index.js:18` |
| 0.0% | 470us | 0.0% | 470us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/index.js` |
| 0.0% | 470us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/index.js:15` |
| 0.0% | 470us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/index.js:18` |
| 0.0% | 468us | 0.0% | 468us | `numericString` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/elysia/numeric.mjs` |
| 0.0% | 468us | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/elysia/numeric.mjs:57` |
| 0.0% | 464us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/string/index.js:18` |
| 0.0% | 457us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/union.js:5` |
| 0.0% | 456us | 0.0% | 456us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/async-iterator/index.js` |
| 0.0% | 456us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/async-iterator/index.js:15` |
| 0.0% | 449us | 0.0% | 0us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:187` |
| 0.0% | 449us | 0.0% | 449us | `slice` | `[native code]` |
| 0.0% | 445us | 0.0% | 445us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` |
| 0.0% | 443us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/type.js:88` |
| 0.0% | 440us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/function/index.js:18` |
| 0.0% | 438us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:15` |
| 0.0% | 438us | 0.0% | 438us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js` |
| 0.0% | 437us | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/elysia/keep-config.mjs:34` |
| 0.0% | 437us | 0.0% | 437us | `keep` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/elysia/keep-config.mjs` |
| 0.0% | 436us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unknown/index.js:18` |
| 0.0% | 435us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js:18` |
| 0.0% | 435us | 0.0% | 435us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js` |
| 0.0% | 431us | 0.0% | 431us | `#assertRouteModelRefs` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 428us | 0.0% | 0us | `resolveChainNode` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:159` |
| 0.0% | 428us | 0.0% | 0us | `flattenChainMemoReadonly` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:249` |
| 0.0% | 428us | 0.0% | 0us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:241` |
| 0.0% | 428us | 0.0% | 0us | `flattenChainMemo` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:256` |
| 0.0% | 428us | 0.0% | 428us | `hasMacroKey` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 428us | 0.0% | 0us | `flattenChain` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:178` |
| 0.0% | 427us | 0.0% | 427us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect-evaluated.js:3` |
| 0.0% | 427us | 0.0% | 427us | `createErrorHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/error.mjs` |
| 0.0% | 427us | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1624` |
| 0.0% | 427us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/literal/index.js:18` |
| 0.0% | 427us | 0.0% | 427us | `handler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1248` |
| 0.0% | 427us | 0.0% | 0us | `createFetchHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:161` |
| 0.0% | 426us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/iterator/iterator.js:5` |
| 0.0% | 426us | 0.0% | 426us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js` |
| 0.0% | 425us | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1617` |
| 0.0% | 425us | 0.0% | 425us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:168` |
| 0.0% | 425us | 0.0% | 425us | `handler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 421us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/patterns/index.js:18` |
| 0.0% | 421us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js:15` |
| 0.0% | 421us | 0.0% | 421us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js` |
| 0.0% | 420us | 0.0% | 420us | `expandPaths` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 420us | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1620` |
| 0.0% | 419us | 0.0% | 419us | `resolveLocalHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 419us | 0.0% | 0us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:236` |
| 0.0% | 418us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/finite.js:7` |
| 0.0% | 417us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js:22` |
| 0.0% | 417us | 0.0% | 417us | `__export` | `/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js` |
| 0.0% | 417us | 0.0% | 0us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:245` |
| 0.0% | 417us | 0.0% | 417us | `collectHookOrigins` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 415us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:10` |
| 0.0% | 412us | 0.0% | 412us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:3` |
| 0.0% | 412us | 0.0% | 412us | `buildRouteTable` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:36` |
| 0.0% | 410us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/has.js:3` |
| 0.0% | 410us | 0.0% | 410us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/index.js` |
| 0.0% | 407us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/never/index.js:18` |
| 0.0% | 407us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/index.js:19` |
| 0.0% | 403us | 0.0% | 403us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:150` |
| 0.0% | 403us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/ref/index.js:18` |
| 0.0% | 402us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/tuple/index.js:18` |
| 0.0% | 401us | 0.0% | 401us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js` |
| 0.0% | 395us | 0.0% | 395us | `#publishGeneration` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1508` |
| 0.0% | 393us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/readonly-from-mapped-result.js:6` |
| 0.0% | 391us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/deref/index.js:18` |
| 0.0% | 391us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/object/index.js:18` |
| 0.0% | 391us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/object/object.js:10` |
| 0.0% | 389us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:19` |
| 0.0% | 387us | 0.0% | 387us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 386us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:106` |
| 0.0% | 384us | 0.0% | 384us | `createFetchHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` |
| 0.0% | 380us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/promise/index.js:18` |
| 0.0% | 377us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:90` |
| 0.0% | 377us | 0.0% | 377us | `from` | `[native code]` |
| 0.0% | 377us | 0.0% | 377us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js` |
| 0.0% | 376us | 0.0% | 376us | `checkSlots` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 376us | 0.0% | 0us | `#assertRouteModelRefs` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1426` |
| 0.0% | 376us | 0.0% | 376us | `buildRouteTable` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:29` |
| 0.0% | 362us | 0.0% | 362us | `push` | `[native code]` |
| 0.0% | 362us | 0.0% | 0us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:204` |
| 0.0% | 361us | 0.0% | 0us | `#assertRouteModelRefs` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1428` |
| 0.0% | 361us | 0.0% | 361us | `isArray` | `[native code]` |
| 0.0% | 358us | 0.0% | 358us | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` |
| 0.0% | 356us | 0.0% | 356us | `createResponseHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/utils.mjs` |
| 0.0% | 356us | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:150` |
| 0.0% | 356us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/registry/index.js:39` |
| 0.0% | 350us | 0.0% | 350us | `#hookHasTypeBox` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 350us | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1550` |
| 0.0% | 344us | 0.0% | 344us | `map` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/utils.mjs` |
| 0.0% | 344us | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/utils.mjs:56` |
| 0.0% | 327us | 0.0% | 327us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:64` |
| 0.0% | 322us | 0.0% | 322us | `async run` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:95` |
| 0.0% | 321us | 0.0% | 321us | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs` |
| 0.0% | 313us | 0.0% | 313us | `#jitDispatch` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1327` |
| 0.0% | 307us | 0.0% | 307us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs` |
| 0.0% | 307us | 0.0% | 307us | `#jitDispatch` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1313` |
| 0.0% | 306us | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/error.mjs:92` |
| 0.0% | 306us | 0.0% | 306us | `setPrototypeDirectOrThrow` | `[native code]` |
| 0.0% | 301us | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/bridge.mjs:19` |
| 0.0% | 301us | 0.0% | 301us | `stub` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/bridge.mjs` |
| 0.0% | 291us | 0.0% | 0us | `compileHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:420` |
| 0.0% | 269us | 0.0% | 0us | `async run` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:64` |

## Function Details

### `write`
`[native code]` | Self: 36.7% (2.31s) | Total: 36.7% (2.31s) | Samples: 67

**Called by:**
- `data` (67)

### `Response`
`[native code]` | Self: 19.1% (1.20s) | Total: 19.1% (1.20s) | Samples: 46

**Called by:**
- `mapCompactResponse` (46)

### `data`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:78` | Self: 16.3% (1.02s) | Total: 16.6% (1.04s) | Samples: 18

**Calls:**
- `indexOf` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:332` | Self: 5.8% (370.3ms) | Total: 9.0% (568.6ms) | Samples: 12

**Called by:**
- `(anonymous)` (17)

**Calls:**
- `extractPath` (5)

### `toString`
`[native code]` | Self: 4.7% (297.1ms) | Total: 4.7% (297.1ms) | Samples: 11

**Called by:**
- `data` (11)

### `findRoute`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:85` | Self: 3.8% (239.4ms) | Total: 3.8% (239.4ms) | Samples: 7

**Called by:**
- `(anonymous)` (7)

### `extractPath`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:16` | Self: 3.1% (198.3ms) | Total: 3.1% (198.3ms) | Samples: 5

**Called by:**
- `(anonymous)` (5)

### `Context`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:55` | Self: 2.2% (143.5ms) | Total: 2.2% (143.5ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `data`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:89` | Self: 1.6% (105.0ms) | Total: 38.4% (2.42s) | Samples: 1

**Calls:**
- `write` (67)

### `anonymous`
`[native code]` | Self: 1.1% (74.8ms) | Total: 13.3% (841.1ms) | Samples: 163

**Called by:**
- `require` (1789)

**Calls:**
- `(anonymous)` (192)
- `(anonymous)` (174)
- `(anonymous)` (171)
- `(anonymous)` (100)
- `(anonymous)` (99)
- `(anonymous)` (93)
- `(anonymous)` (89)
- `(anonymous)` (60)
- `(anonymous)` (59)
- `(anonymous)` (57)
- `(anonymous)` (31)
- `(anonymous)` (26)
- `(anonymous)` (25)
- `(anonymous)` (24)
- `(anonymous)` (23)
- `(anonymous)` (22)
- `(anonymous)` (22)
- `(anonymous)` (16)
- `(anonymous)` (16)
- `(anonymous)` (15)
- `(anonymous)` (14)
- `(anonymous)` (13)
- `(anonymous)` (12)
- `(anonymous)` (11)
- `(anonymous)` (9)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `fetch`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:55` | Self: 1.1% (73.6ms) | Total: 36.0% (2.26s) | Samples: 4

**Calls:**
- `(anonymous)` (64)

### `Context`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:57` | Self: 0.6% (43.0ms) | Total: 0.6% (43.0ms) | Samples: 3

**Called by:**
- `(anonymous)` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:335` | Self: 0.6% (41.2ms) | Total: 23.7% (1.49s) | Samples: 1

**Called by:**
- `(anonymous)` (67)

**Calls:**
- `findRoute` (56)
- `findRoute` (7)
- `findRoute` (2)
- `findRoute` (1)

### `map`
`[native code]` | Self: 0.6% (39.2ms) | Total: 0.8% (54.0ms) | Samples: 3

**Called by:**
- `mapBack` (2)
- `(anonymous)` (1)
- `#buildRouterUnsafe` (1)
- `(module)` (1)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `indexOf`
`[native code]` | Self: 0.2% (18.3ms) | Total: 0.2% (18.3ms) | Samples: 2

**Called by:**
- `data` (2)

### `data`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:83` | Self: 0.2% (15.8ms) | Total: 0.2% (15.8ms) | Samples: 2

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:137` | Self: 0.1% (9.5ms) | Total: 0.1% (9.5ms) | Samples: 1

**Called by:**
- `map` (1)

### `Request`
`[native code]` | Self: 0.1% (9.4ms) | Total: 0.1% (9.4ms) | Samples: 10

**Called by:**
- `static` (10)

### `(anonymous)`
`[native code]` | Self: 0.0% (5.7ms) | Total: 0.0% (5.7ms) | Samples: 3

**Called by:**
- `bound require` (1)
- `data` (1)
- `async run` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs` | Self: 0.0% (5.2ms) | Total: 0.0% (5.2ms) | Samples: 1

**Called by:**
- `map` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:28` | Self: 0.0% (5.0ms) | Total: 0.0% (5.0ms) | Samples: 1

### `mapCompactResponse`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:85` | Self: 0.0% (4.0ms) | Total: 19.1% (1.20s) | Samples: 1

**Called by:**
- `(anonymous)` (39)
- `findRoute` (8)

**Calls:**
- `Response` (46)

### `findRoute`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:70` | Self: 0.0% (3.0ms) | Total: 0.0% (3.0ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `responseTag`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs` | Self: 0.0% (2.7ms) | Total: 0.0% (2.7ms) | Samples: 1

**Called by:**
- `mapCompactResponse` (1)

### `data`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:80` | Self: 0.0% (1.8ms) | Total: 0.0% (1.8ms) | Samples: 1

### `require`
`[native code]` | Self: 0.0% (1.8ms) | Total: 13.4% (844.3ms) | Samples: 4

**Called by:**
- `bound require` (1796)

**Calls:**
- `anonymous` (1789)
- `startsWith` (2)
- `get` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:331` | Self: 0.0% (1.5ms) | Total: 2.9% (188.5ms) | Samples: 1

**Called by:**
- `(anonymous)` (7)

**Calls:**
- `Context` (3)
- `Context` (2)
- `Context` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:158` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 2

**Called by:**
- `findRoute` (2)

### `resetNode`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:19` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `add` (1)

### `WeakMap`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `stub`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/typebox-type.mjs` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `update`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `defineProperty`
`[native code]` | Self: 0.0% (966us) | Total: 0.0% (966us) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `serve`
`[native code]` | Self: 0.0% (908us) | Total: 0.0% (908us) | Samples: 2

**Called by:**
- `(module)` (2)

### `startsWith`
`[native code]` | Self: 0.0% (853us) | Total: 0.0% (853us) | Samples: 2

**Called by:**
- `require` (2)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` | Self: 0.0% (853us) | Total: 0.0% (853us) | Samples: 1

**Called by:**
- `async makeTarget` (1)

### `importModule`
`[native code]` | Self: 0.0% (826us) | Total: 0.0% (826us) | Samples: 2

**Called by:**
- `async elysiaApp` (2)

### `createParamNode`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` | Self: 0.0% (797us) | Total: 0.0% (797us) | Samples: 1

**Called by:**
- `add` (1)

### `connect`
`[native code]` | Self: 0.0% (747us) | Total: 0.0% (747us) | Samples: 2

**Called by:**
- `async run` (2)

### `composeRouteHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:261` | Self: 0.0% (743us) | Total: 0.0% (743us) | Samples: 2

**Called by:**
- `#assertRouteModelRefs` (1)
- `compileHandler` (1)

### `assertUncontested`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/aot.mjs` | Self: 0.0% (721us) | Total: 0.0% (721us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `async run`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts` | Self: 0.0% (635us) | Total: 0.0% (635us) | Samples: 2

**Called by:**
- `async run` (2)

### `compileHandler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` | Self: 0.0% (634us) | Total: 0.0% (634us) | Samples: 2

**Called by:**
- `#jitDispatch` (2)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1625` | Self: 0.0% (611us) | Total: 0.0% (4.7ms) | Samples: 1

**Called by:**
- `#buildRouter` (8)

**Calls:**
- `add` (1)
- `add` (1)
- `add` (1)
- `add` (1)
- `add` (1)
- `add` (1)
- `add` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/index.js` | Self: 0.0% (590us) | Total: 0.0% (590us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js` | Self: 0.0% (583us) | Total: 0.0% (583us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js` | Self: 0.0% (550us) | Total: 0.0% (550us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js` | Self: 0.0% (523us) | Total: 0.0% (523us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `get`
`[native code]` | Self: 0.0% (506us) | Total: 0.0% (506us) | Samples: 1

**Called by:**
- `require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/index.js` | Self: 0.0% (502us) | Total: 0.0% (502us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/index.js` | Self: 0.0% (500us) | Total: 0.0% (500us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js` | Self: 0.0% (500us) | Total: 0.0% (500us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/bigint/index.js` | Self: 0.0% (487us) | Total: 0.0% (487us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:3` | Self: 0.0% (477us) | Total: 0.0% (477us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `#publishGeneration`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1507` | Self: 0.0% (477us) | Total: 0.0% (477us) | Samples: 1

**Called by:**
- `#buildRouter` (1)

### `requireExactMirror`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror-require.mjs` | Self: 0.0% (476us) | Total: 0.0% (476us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/validator-cache.mjs` | Self: 0.0% (473us) | Total: 0.0% (473us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/index.js` | Self: 0.0% (470us) | Total: 0.0% (470us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `numericString`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/elysia/numeric.mjs` | Self: 0.0% (468us) | Total: 0.0% (468us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/async-iterator/index.js` | Self: 0.0% (456us) | Total: 0.0% (456us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `slice`
`[native code]` | Self: 0.0% (449us) | Total: 0.0% (449us) | Samples: 1

**Called by:**
- `add` (1)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` | Self: 0.0% (445us) | Total: 0.0% (445us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js` | Self: 0.0% (438us) | Total: 0.0% (438us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `keep`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/elysia/keep-config.mjs` | Self: 0.0% (437us) | Total: 0.0% (437us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js` | Self: 0.0% (435us) | Total: 0.0% (435us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `#assertRouteModelRefs`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (431us) | Total: 0.0% (431us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `hasMacroKey`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` | Self: 0.0% (428us) | Total: 0.0% (428us) | Samples: 1

**Called by:**
- `resolveChainNode` (1)

### `handler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1248` | Self: 0.0% (427us) | Total: 0.0% (427us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `createErrorHandler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/error.mjs` | Self: 0.0% (427us) | Total: 0.0% (427us) | Samples: 1

**Called by:**
- `createFetchHandler` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect-evaluated.js:3` | Self: 0.0% (427us) | Total: 0.0% (427us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js` | Self: 0.0% (426us) | Total: 0.0% (426us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `handler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (425us) | Total: 0.0% (425us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:168` | Self: 0.0% (425us) | Total: 0.0% (425us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js` | Self: 0.0% (421us) | Total: 0.0% (421us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `expandPaths`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (420us) | Total: 0.0% (420us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `resolveLocalHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` | Self: 0.0% (419us) | Total: 0.0% (419us) | Samples: 1

**Called by:**
- `composeRouteHook` (1)

### `collectHookOrigins`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` | Self: 0.0% (417us) | Total: 0.0% (417us) | Samples: 1

**Called by:**
- `composeRouteHook` (1)

### `__export`
`/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js` | Self: 0.0% (417us) | Total: 0.0% (417us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `buildRouteTable`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:36` | Self: 0.0% (412us) | Total: 0.0% (412us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:3` | Self: 0.0% (412us) | Total: 0.0% (412us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/index.js` | Self: 0.0% (410us) | Total: 0.0% (410us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:150` | Self: 0.0% (403us) | Total: 0.0% (403us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js` | Self: 0.0% (401us) | Total: 0.0% (401us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `#publishGeneration`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1508` | Self: 0.0% (395us) | Total: 0.0% (395us) | Samples: 1

**Called by:**
- `#buildRouter` (1)

### `composeRouteHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` | Self: 0.0% (387us) | Total: 0.0% (387us) | Samples: 1

**Called by:**
- `#assertRouteModelRefs` (1)

### `createFetchHandler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` | Self: 0.0% (384us) | Total: 0.0% (384us) | Samples: 1

**Called by:**
- `#dispatch` (1)

### `from`
`[native code]` | Self: 0.0% (377us) | Total: 0.0% (377us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js` | Self: 0.0% (377us) | Total: 0.0% (377us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `buildRouteTable`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:29` | Self: 0.0% (376us) | Total: 0.0% (376us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `checkSlots`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (376us) | Total: 0.0% (376us) | Samples: 1

**Called by:**
- `#assertRouteModelRefs` (1)

### `push`
`[native code]` | Self: 0.0% (362us) | Total: 0.0% (362us) | Samples: 1

**Called by:**
- `add` (1)

### `isArray`
`[native code]` | Self: 0.0% (361us) | Total: 0.0% (361us) | Samples: 1

**Called by:**
- `#assertRouteModelRefs` (1)

### `findRoute`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` | Self: 0.0% (358us) | Total: 0.0% (358us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `createResponseHandler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/utils.mjs` | Self: 0.0% (356us) | Total: 0.0% (356us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:6` | Self: 0.0% (355us) | Total: 0.0% (2.3ms) | Samples: 1

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (2)

### `#hookHasTypeBox`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (350us) | Total: 0.0% (350us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `map`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/utils.mjs` | Self: 0.0% (344us) | Total: 0.0% (344us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:64` | Self: 0.0% (327us) | Total: 0.0% (327us) | Samples: 1

### `async run`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:95` | Self: 0.0% (322us) | Total: 0.0% (322us) | Samples: 1

### `Context`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs` | Self: 0.0% (321us) | Total: 0.0% (321us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `#jitDispatch`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1327` | Self: 0.0% (313us) | Total: 0.0% (313us) | Samples: 1

**Called by:**
- `findRoute` (1)

### `#jitDispatch`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1313` | Self: 0.0% (307us) | Total: 0.0% (307us) | Samples: 1

**Called by:**
- `findRoute` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs` | Self: 0.0% (307us) | Total: 0.0% (307us) | Samples: 1

**Called by:**
- `findRoute` (1)

### `setPrototypeDirectOrThrow`
`[native code]` | Self: 0.0% (306us) | Total: 0.0% (306us) | Samples: 1

**Called by:**
- `(module)` (1)

### `stub`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/bridge.mjs` | Self: 0.0% (301us) | Total: 0.0% (301us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:56` | Self: 0.0% (271us) | Total: 0.1% (9.7ms) | Samples: 1

**Calls:**
- `static` (10)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:11` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (590us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect-evaluated.js:10` | Self: 0.0% (0us) | Total: 0.0% (583us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/index.js:18` | Self: 0.0% (0us) | Total: 1.2% (80.6ms) | Samples: 0

**Called by:**
- `anonymous` (171)

**Calls:**
- `bound require` (171)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (2.2ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (435us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/has.js:3` | Self: 0.0% (0us) | Total: 0.0% (410us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `defineProperty` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/index.js:20` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:21` | Self: 0.0% (0us) | Total: 0.0% (821us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror.mjs:7` | Self: 0.0% (0us) | Total: 1.4% (92.5ms) | Samples: 0

**Calls:**
- `requireExactMirror` (198)
- `requireExactMirror` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/discard/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (500us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/unsafe.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:14` | Self: 0.0% (0us) | Total: 0.1% (10.4ms) | Samples: 0

**Called by:**
- `anonymous` (24)

**Calls:**
- `bound require` (24)

### `async elysiaApp`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:32` | Self: 0.0% (0us) | Total: 0.0% (826us) | Samples: 0

**Called by:**
- `async makeTarget` (2)

**Calls:**
- `async elysiaApp` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/ref/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (403us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/immutable.js:38` | Self: 0.0% (0us) | Total: 0.0% (949us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/iterator/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (861us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `#dispatch`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1648` | Self: 0.0% (0us) | Total: 0.0% (811us) | Samples: 0

**Called by:**
- `async makeTarget` (2)

**Calls:**
- `createFetchHandler` (1)
- `createFetchHandler` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (523us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/cookie/crypto.mjs:24` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js:18` | Self: 0.0% (0us) | Total: 0.7% (47.0ms) | Samples: 0

**Called by:**
- `anonymous` (99)

**Calls:**
- `bound require` (98)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:5` | Self: 0.0% (0us) | Total: 0.0% (872us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:9` | Self: 0.0% (0us) | Total: 0.0% (512us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/policy.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed-from-mapped-key.js:5` | Self: 0.0% (0us) | Total: 0.4% (26.9ms) | Samples: 0

**Called by:**
- `anonymous` (57)

**Calls:**
- `bound require` (57)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:150` | Self: 0.0% (0us) | Total: 0.0% (356us) | Samples: 0

**Calls:**
- `createResponseHandler` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/never/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (407us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `#assertRouteModelRefs`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1428` | Self: 0.0% (0us) | Total: 0.0% (361us) | Samples: 0

**Called by:**
- `#buildRouterUnsafe` (1)

**Calls:**
- `isArray` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (854us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `(anonymous)` (1)
- `bound require` (1)

### `requireExactMirror`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror-require.mjs:4` | Self: 0.0% (0us) | Total: 1.4% (92.0ms) | Samples: 0

**Called by:**
- `(module)` (198)

**Calls:**
- `bound require` (198)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/object/object.js:10` | Self: 0.0% (0us) | Total: 0.0% (391us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `mapBack`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs:2` | Self: 0.0% (0us) | Total: 0.0% (5.8ms) | Samples: 0

**Called by:**
- `(module)` (2)

**Calls:**
- `map` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:7` | Self: 0.0% (0us) | Total: 0.0% (960us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/error.mjs:92` | Self: 0.0% (0us) | Total: 0.0% (306us) | Samples: 0

**Calls:**
- `setPrototypeDirectOrThrow` (1)

### `composeRouteHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:236` | Self: 0.0% (0us) | Total: 0.0% (419us) | Samples: 0

**Called by:**
- `#assertRouteModelRefs` (1)

**Calls:**
- `resolveLocalHook` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (2)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:24` | Self: 0.0% (0us) | Total: 0.0% (963us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof-from-mapped-result.js:5` | Self: 0.0% (0us) | Total: 0.7% (44.4ms) | Samples: 0

**Called by:**
- `anonymous` (93)

**Calls:**
- `bound require` (93)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/symbols/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js:29` | Self: 0.0% (0us) | Total: 1.4% (89.7ms) | Samples: 0

**Called by:**
- `anonymous` (192)

**Calls:**
- `bound require` (192)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/optional-from-mapped-result.js:6` | Self: 0.0% (0us) | Total: 0.0% (2.3ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/boolean/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (478us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `flattenChainMemoReadonly`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:249` | Self: 0.0% (0us) | Total: 0.0% (428us) | Samples: 0

**Called by:**
- `flattenChainMemo` (1)

**Calls:**
- `flattenChain` (1)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1550` | Self: 0.0% (0us) | Total: 0.0% (350us) | Samples: 0

**Called by:**
- `#buildRouter` (1)

**Calls:**
- `#hookHasTypeBox` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/bigint/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (487us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (421us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/pattern.js:6` | Self: 0.0% (0us) | Total: 0.0% (860us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (470us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `compileHandler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:420` | Self: 0.0% (0us) | Total: 0.0% (291us) | Samples: 0

**Called by:**
- `#jitDispatch` (1)

**Calls:**
- `composeRouteHook` (1)

### `(anonymous)`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:66` | Self: 0.0% (0us) | Total: 35.7% (2.25s) | Samples: 0

**Called by:**
- `fetch` (64)

**Calls:**
- `(anonymous)` (67)
- `(anonymous)` (17)
- `(anonymous)` (7)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:15` | Self: 0.0% (0us) | Total: 0.0% (3.0ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/bigint/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (487us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/sets/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (526us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs:78` | Self: 0.0% (0us) | Total: 0.0% (5.8ms) | Samples: 0

**Calls:**
- `mapBack` (2)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/elysia/numeric.mjs:57` | Self: 0.0% (0us) | Total: 0.0% (468us) | Samples: 0

**Calls:**
- `numericString` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:7` | Self: 0.0% (0us) | Total: 0.7% (47.5ms) | Samples: 0

**Called by:**
- `anonymous` (100)

**Calls:**
- `bound require` (100)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/registry/index.js:38` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async elysiaApp`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:33` | Self: 0.0% (0us) | Total: 0.0% (826us) | Samples: 0

**Called by:**
- `async elysiaApp` (2)

**Calls:**
- `importModule` (2)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1536` | Self: 0.0% (0us) | Total: 0.0% (3.2ms) | Samples: 0

**Called by:**
- `#buildRouter` (8)

**Calls:**
- `#assertRouteModelRefs` (5)
- `#assertRouteModelRefs` (1)
- `#assertRouteModelRefs` (1)
- `#assertRouteModelRefs` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:12` | Self: 0.0% (0us) | Total: 0.1% (7.7ms) | Samples: 0

**Called by:**
- `anonymous` (16)

**Calls:**
- `bound require` (16)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/cookie/crypto.mjs:22` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `update` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/readonly-from-mapped-result.js:6` | Self: 0.0% (0us) | Total: 0.0% (393us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:6` | Self: 0.0% (0us) | Total: 0.2% (15.0ms) | Samples: 0

**Called by:**
- `anonymous` (31)

**Calls:**
- `bound require` (31)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js:22` | Self: 0.0% (0us) | Total: 0.0% (417us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `__export` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:104` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Calls:**
- `async run` (4)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/array/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (945us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:20` | Self: 0.0% (0us) | Total: 0.0% (764us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed-property-keys.js:5` | Self: 0.0% (0us) | Total: 0.1% (9.5ms) | Samples: 0

**Called by:**
- `anonymous` (22)

**Calls:**
- `bound require` (22)

### `createFetchHandler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:161` | Self: 0.0% (0us) | Total: 0.0% (427us) | Samples: 0

**Called by:**
- `#dispatch` (1)

**Calls:**
- `createErrorHandler` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js:6` | Self: 0.0% (0us) | Total: 0.1% (6.8ms) | Samples: 0

**Called by:**
- `anonymous` (14)

**Calls:**
- `bound require` (14)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js:19` | Self: 0.0% (0us) | Total: 0.1% (11.1ms) | Samples: 0

**Called by:**
- `anonymous` (23)

**Calls:**
- `bound require` (23)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1530` | Self: 0.0% (0us) | Total: 0.1% (10.3ms) | Samples: 0

**Called by:**
- `#buildRouter` (3)

**Calls:**
- `map` (1)
- `buildRouteTable` (1)
- `buildRouteTable` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/function/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (440us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (583us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/deref/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (391us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect.js:6` | Self: 0.0% (0us) | Total: 0.0% (499us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/index.js:20` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/promise/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (380us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/index.js:18` | Self: 0.0% (0us) | Total: 0.1% (6.3ms) | Samples: 0

**Called by:**
- `anonymous` (13)

**Calls:**
- `bound require` (12)
- `(anonymous)` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:57` | Self: 0.0% (0us) | Total: 0.3% (23.2ms) | Samples: 0

**Called by:**
- `async makeTarget` (2)

**Calls:**
- `#dispatch` (26)
- `async elysiaApp` (2)
- `#dispatch` (2)

### `mapCompactResponse`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:84` | Self: 0.0% (0us) | Total: 0.0% (2.7ms) | Samples: 0

**Called by:**
- `findRoute` (1)

**Calls:**
- `responseTag` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:13` | Self: 0.0% (0us) | Total: 0.4% (28.9ms) | Samples: 0

**Called by:**
- `anonymous` (60)

**Calls:**
- `bound require` (60)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/index.js:19` | Self: 0.0% (0us) | Total: 1.3% (81.9ms) | Samples: 0

**Called by:**
- `anonymous` (174)

**Calls:**
- `bound require` (174)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:195` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `#buildRouterUnsafe` (1)

**Calls:**
- `resetNode` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/computed.js:5` | Self: 0.0% (0us) | Total: 0.0% (854us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unknown/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (436us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:14` | Self: 0.0% (0us) | Total: 0.1% (12.2ms) | Samples: 0

**Called by:**
- `anonymous` (26)

**Calls:**
- `bound require` (26)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js:8` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `#dispatch`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1646` | Self: 0.0% (0us) | Total: 0.3% (21.5ms) | Samples: 0

**Called by:**
- `async makeTarget` (26)

**Calls:**
- `#buildRouter` (24)
- `#buildRouter` (2)

### `#assertRouteModelRefs`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1426` | Self: 0.0% (0us) | Total: 0.0% (376us) | Samples: 0

**Called by:**
- `#buildRouterUnsafe` (1)

**Calls:**
- `checkSlots` (1)

### `#buildRouter`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1455` | Self: 0.0% (0us) | Total: 0.3% (20.7ms) | Samples: 0

**Called by:**
- `#dispatch` (24)

**Calls:**
- `#buildRouterUnsafe` (8)
- `#buildRouterUnsafe` (8)
- `#buildRouterUnsafe` (3)
- `#buildRouterUnsafe` (1)
- `#buildRouterUnsafe` (1)
- `#buildRouterUnsafe` (1)
- `#buildRouterUnsafe` (1)
- `#buildRouterUnsafe` (1)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1624` | Self: 0.0% (0us) | Total: 0.0% (427us) | Samples: 0

**Called by:**
- `#buildRouter` (1)

**Calls:**
- `handler` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js:195` | Self: 0.0% (0us) | Total: 0.0% (500us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/elysia/keep-config.mjs:34` | Self: 0.0% (0us) | Total: 0.0% (437us) | Samples: 0

**Calls:**
- `keep` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:10` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `bound require`
`[native code]` | Self: 0.0% (0us) | Total: 13.4% (844.7ms) | Samples: 0

**Called by:**
- `requireExactMirror` (198)
- `(anonymous)` (192)
- `(anonymous)` (174)
- `(anonymous)` (171)
- `(anonymous)` (100)
- `(anonymous)` (98)
- `(anonymous)` (93)
- `(anonymous)` (89)
- `(anonymous)` (60)
- `(anonymous)` (58)
- `(anonymous)` (57)
- `(anonymous)` (31)
- `(anonymous)` (26)
- `(anonymous)` (24)
- `(anonymous)` (24)
- `(anonymous)` (23)
- `(anonymous)` (22)
- `(anonymous)` (22)
- `(anonymous)` (16)
- `(anonymous)` (16)
- `(anonymous)` (14)
- `(anonymous)` (14)
- `(anonymous)` (12)
- `(anonymous)` (12)
- `(anonymous)` (11)
- `(anonymous)` (9)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `require` (1796)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:9` | Self: 0.0% (0us) | Total: 0.0% (894us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js:5` | Self: 0.0% (0us) | Total: 0.0% (3.6ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (2)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/type.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (500us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof.js:11` | Self: 0.0% (0us) | Total: 0.0% (505us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:10` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `flattenChain`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:178` | Self: 0.0% (0us) | Total: 0.0% (428us) | Samples: 0

**Called by:**
- `flattenChainMemoReadonly` (1)

**Calls:**
- `resolveChainNode` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/string/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (464us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `static`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` | Self: 0.0% (0us) | Total: 0.1% (9.4ms) | Samples: 0

**Called by:**
- `(module)` (10)

**Calls:**
- `Request` (10)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:17` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (556us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:205` | Self: 0.0% (0us) | Total: 0.0% (797us) | Samples: 0

**Called by:**
- `#buildRouterUnsafe` (1)

**Calls:**
- `createParamNode` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:22` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/finite.js:7` | Self: 0.0% (0us) | Total: 0.0% (418us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:13` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:54` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Calls:**
- `async makeTarget` (3)

### `data`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:90` | Self: 0.0% (0us) | Total: 0.0% (4.9ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/type.js:88` | Self: 0.0% (0us) | Total: 0.0% (443us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (6)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/unsafe.js:5` | Self: 0.0% (0us) | Total: 0.0% (3.8ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (438us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `#jitDispatch`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1320` | Self: 0.0% (0us) | Total: 0.0% (925us) | Samples: 0

**Called by:**
- `findRoute` (3)

**Calls:**
- `compileHandler` (2)
- `compileHandler` (1)

### `#assertRouteModelRefs`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1425` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Called by:**
- `#buildRouterUnsafe` (5)

**Calls:**
- `composeRouteHook` (1)
- `composeRouteHook` (1)
- `composeRouteHook` (1)
- `composeRouteHook` (1)
- `composeRouteHook` (1)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1561` | Self: 0.0% (0us) | Total: 0.0% (721us) | Samples: 0

**Called by:**
- `#buildRouter` (1)

**Calls:**
- `assertUncontested` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:69` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `WeakMap` (1)

### `findRoute`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:94` | Self: 0.0% (0us) | Total: 19.2% (1.21s) | Samples: 0

**Called by:**
- `(anonymous)` (56)

**Calls:**
- `(anonymous)` (39)
- `mapCompactResponse` (8)
- `#jitDispatch` (3)
- `(anonymous)` (2)
- `#jitDispatch` (1)
- `(anonymous)` (1)
- `#jitDispatch` (1)
- `mapCompactResponse` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends.js:9` | Self: 0.0% (0us) | Total: 0.0% (918us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:7` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs:77` | Self: 0.0% (0us) | Total: 0.6% (38.2ms) | Samples: 0

**Calls:**
- `map` (1)

### `#buildRouter`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1467` | Self: 0.0% (0us) | Total: 0.0% (872us) | Samples: 0

**Called by:**
- `#dispatch` (2)

**Calls:**
- `#publishGeneration` (1)
- `#publishGeneration` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/object/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (391us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async run`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:61` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `(module)` (4)
- `(module)` (1)

**Calls:**
- `async run` (2)
- `async run` (2)
- `async run` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:19` | Self: 0.0% (0us) | Total: 0.0% (776us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:13` | Self: 0.0% (0us) | Total: 0.0% (3.2ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/optional.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:10` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (941us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:10` | Self: 0.0% (0us) | Total: 0.0% (415us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/hash/hash.js:40` | Self: 0.0% (0us) | Total: 0.0% (801us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `map` (1)
- `from` (1)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1617` | Self: 0.0% (0us) | Total: 0.0% (425us) | Samples: 0

**Called by:**
- `#buildRouter` (1)

**Calls:**
- `handler` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/check.js:11` | Self: 0.0% (0us) | Total: 0.1% (10.6ms) | Samples: 0

**Called by:**
- `anonymous` (22)

**Calls:**
- `bound require` (22)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-from-mapped-key.js:7` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:204` | Self: 0.0% (0us) | Total: 0.0% (362us) | Samples: 0

**Called by:**
- `#buildRouterUnsafe` (1)

**Calls:**
- `push` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/union.js:5` | Self: 0.0% (0us) | Total: 0.0% (457us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/constructor/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (471us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/hash/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/literal/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (427us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js:18` | Self: 0.0% (0us) | Total: 0.4% (28.3ms) | Samples: 0

**Called by:**
- `anonymous` (59)

**Calls:**
- `bound require` (58)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js:5` | Self: 0.0% (0us) | Total: 0.0% (2.3ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect-evaluated.js:9` | Self: 0.0% (0us) | Total: 0.0% (3.8ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:161` | Self: 0.0% (0us) | Total: 18.5% (1.16s) | Samples: 0

**Called by:**
- `findRoute` (39)

**Calls:**
- `mapCompactResponse` (39)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/typebox-type.mjs:43` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `stub` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (389us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/array/array.js:6` | Self: 0.0% (0us) | Total: 0.0% (518us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof-from-mapped-result.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `async run`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:72` | Self: 0.0% (0us) | Total: 0.0% (747us) | Samples: 0

**Called by:**
- `async run` (2)

**Calls:**
- `connect` (2)

### `composeRouteHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:241` | Self: 0.0% (0us) | Total: 0.0% (428us) | Samples: 0

**Called by:**
- `#assertRouteModelRefs` (1)

**Calls:**
- `flattenChainMemo` (1)

### `data`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:77` | Self: 0.0% (0us) | Total: 4.7% (297.1ms) | Samples: 0

**Calls:**
- `toString` (11)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js:18` | Self: 0.0% (0us) | Total: 0.1% (11.8ms) | Samples: 0

**Called by:**
- `anonymous` (25)

**Calls:**
- `bound require` (24)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:20` | Self: 0.0% (0us) | Total: 0.6% (42.4ms) | Samples: 0

**Called by:**
- `anonymous` (89)

**Calls:**
- `bound require` (89)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:20` | Self: 0.0% (0us) | Total: 0.0% (5.3ms) | Samples: 0

**Called by:**
- `anonymous` (12)

**Calls:**
- `bound require` (12)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/async-iterator/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (944us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (1)
- `(anonymous)` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:106` | Self: 0.0% (0us) | Total: 0.0% (386us) | Samples: 0

**Calls:**
- `async run` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/validator-cache.mjs:146` | Self: 0.0% (0us) | Total: 0.0% (473us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `composeRouteHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:245` | Self: 0.0% (0us) | Total: 0.0% (417us) | Samples: 0

**Called by:**
- `#assertRouteModelRefs` (1)

**Calls:**
- `collectHookOrigins` (1)

### `async run`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:64` | Self: 0.0% (0us) | Total: 0.0% (269us) | Samples: 0

**Called by:**
- `async run` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/union-evaluated.js:10` | Self: 0.0% (0us) | Total: 0.0% (474us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/index.js:18` | Self: 0.0% (0us) | Total: 0.1% (7.9ms) | Samples: 0

**Called by:**
- `anonymous` (16)

**Calls:**
- `bound require` (16)

### `flattenChainMemo`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:256` | Self: 0.0% (0us) | Total: 0.0% (428us) | Samples: 0

**Called by:**
- `composeRouteHook` (1)

**Calls:**
- `flattenChainMemoReadonly` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/registry/index.js:39` | Self: 0.0% (0us) | Total: 0.0% (356us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (502us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:16` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `resolveChainNode`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:159` | Self: 0.0% (0us) | Total: 0.0% (428us) | Samples: 0

**Called by:**
- `flattenChain` (1)

**Calls:**
- `hasMacroKey` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/utils.mjs:56` | Self: 0.0% (0us) | Total: 0.0% (344us) | Samples: 0

**Calls:**
- `map` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:11` | Self: 0.0% (0us) | Total: 0.0% (837us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:55` | Self: 0.0% (0us) | Total: 0.0% (908us) | Samples: 0

**Calls:**
- `serve` (2)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:187` | Self: 0.0% (0us) | Total: 0.0% (449us) | Samples: 0

**Called by:**
- `#buildRouterUnsafe` (1)

**Calls:**
- `slice` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/type.js:7` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:20` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (741us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:9` | Self: 0.0% (0us) | Total: 0.0% (556us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `defineProperty` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (407us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (6)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:6` | Self: 0.0% (0us) | Total: 0.0% (895us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:6` | Self: 0.0% (0us) | Total: 0.0% (515us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/index.js:39` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:90` | Self: 0.0% (0us) | Total: 0.0% (377us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (524us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/index.js:22` | Self: 0.0% (0us) | Total: 0.1% (6.3ms) | Samples: 0

**Called by:**
- `anonymous` (15)

**Calls:**
- `bound require` (14)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/tuple/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (402us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1620` | Self: 0.0% (0us) | Total: 0.0% (420us) | Samples: 0

**Called by:**
- `#buildRouter` (1)

**Calls:**
- `expandPaths` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-from-mapped-result.js:6` | Self: 0.0% (0us) | Total: 0.0% (506us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (5.2ms) | Samples: 0

**Called by:**
- `anonymous` (11)

**Calls:**
- `bound require` (11)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/bridge.mjs:19` | Self: 0.0% (0us) | Total: 0.0% (301us) | Samples: 0

**Calls:**
- `stub` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:12` | Self: 0.0% (0us) | Total: 0.0% (806us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/async-iterator/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (456us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:8` | Self: 0.0% (0us) | Total: 0.0% (869us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:15` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (747us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/iterator/iterator.js:5` | Self: 0.0% (0us) | Total: 0.0% (426us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:12` | Self: 0.0% (0us) | Total: 0.0% (992us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (470us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/patterns/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (421us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:54` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `(module)` (3)

**Calls:**
- `async makeTarget` (2)
- `async makeTarget` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof.js:10` | Self: 0.0% (0us) | Total: 0.0% (784us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 63.0% | 3.97s | `[native code]` |
| 19.4% | 1.22s | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts` |
| 13.5% | 854.7ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` |
| 2.9% | 186.9ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs` |
| 0.2% | 14.1ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.1% | 6.8ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs` |
| 0.0% | 5.2ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs` |
| 0.0% | 5.0ms | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts` |
| 0.0% | 3.2ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` |
| 0.0% | 3.0ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 1.6ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs` |
| 0.0% | 1.5ms | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js` |
| 0.0% | 1.1ms | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 1.0ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/typebox-type.mjs` |
| 0.0% | 788us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs` |
| 0.0% | 767us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js` |
| 0.0% | 721us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/aot.mjs` |
| 0.0% | 590us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/index.js` |
| 0.0% | 583us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js` |
| 0.0% | 550us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js` |
| 0.0% | 523us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js` |
| 0.0% | 502us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/index.js` |
| 0.0% | 500us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js` |
| 0.0% | 500us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/index.js` |
| 0.0% | 487us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/bigint/index.js` |
| 0.0% | 477us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js` |
| 0.0% | 476us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror-require.mjs` |
| 0.0% | 473us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/validator-cache.mjs` |
| 0.0% | 470us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/index.js` |
| 0.0% | 468us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/elysia/numeric.mjs` |
| 0.0% | 456us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/async-iterator/index.js` |
| 0.0% | 438us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js` |
| 0.0% | 437us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/elysia/keep-config.mjs` |
| 0.0% | 435us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js` |
| 0.0% | 427us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/error.mjs` |
| 0.0% | 427us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect-evaluated.js` |
| 0.0% | 426us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js` |
| 0.0% | 421us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js` |
| 0.0% | 417us | `/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js` |
| 0.0% | 410us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/index.js` |
| 0.0% | 401us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js` |
| 0.0% | 377us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js` |
| 0.0% | 356us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/utils.mjs` |
| 0.0% | 344us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/utils.mjs` |
| 0.0% | 301us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/bridge.mjs` |
