# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 4.18s | 15408 | 100us | 328 |

**Top 10:** `Response` 34.3%, `Request` 31.9%, `findRoute` 9.7%, `(anonymous)` 7.1%, `extractPath` 2.5%, `Context` 1.6%, `anonymous` 1.6%, `map` 1.3%, `extractPath` 1.2%, `static` 1.1%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 34.3% | 1.43s | 34.3% | 1.43s | `Response` | `[native code]` |
| 31.9% | 1.33s | 31.9% | 1.33s | `Request` | `[native code]` |
| 9.7% | 408.3ms | 9.7% | 408.3ms | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:85` |
| 7.1% | 297.6ms | 11.8% | 494.2ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:332` |
| 2.5% | 105.5ms | 2.5% | 105.5ms | `extractPath` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:15` |
| 1.6% | 70.3ms | 1.6% | 70.3ms | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:63` |
| 1.6% | 66.9ms | 20.5% | 857.1ms | `anonymous` | `[native code]` |
| 1.3% | 57.7ms | 1.3% | 57.9ms | `map` | `[native code]` |
| 1.2% | 50.4ms | 1.2% | 50.4ms | `extractPath` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:16` |
| 1.1% | 48.8ms | 33.1% | 1.38s | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` |
| 1.0% | 43.7ms | 1.0% | 43.7ms | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:71` |
| 0.9% | 39.4ms | 0.9% | 39.4ms | `extractPath` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:14` |
| 0.7% | 32.4ms | 0.7% | 32.4ms | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:57` |
| 0.6% | 28.7ms | 36.4% | 1.52s | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:94` |
| 0.5% | 21.8ms | 34.8% | 1.45s | `mapCompactResponse` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:85` |
| 0.4% | 17.1ms | 0.4% | 18.1ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:158` |
| 0.3% | 15.7ms | 0.3% | 15.7ms | `Decorator` | `[native code]` |
| 0.2% | 11.2ms | 0.3% | 13.9ms | `mapCompactResponse` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:84` |
| 0.1% | 7.5ms | 0.1% | 7.5ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:21` |
| 0.1% | 6.0ms | 0.1% | 6.0ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:28` |
| 0.1% | 4.7ms | 0.1% | 4.7ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/sets/index.js` |
| 0.0% | 3.9ms | 0.0% | 3.9ms | `buildRouteTable` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:36` |
| 0.0% | 3.5ms | 0.0% | 3.5ms | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:195` |
| 0.0% | 3.1ms | 0.0% | 3.1ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `buildRouteTable` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `responseTag` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:25` |
| 0.0% | 2.7ms | 47.4% | 1.98s | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:335` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs` |
| 0.0% | 1.7ms | 0.1% | 4.8ms | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1536` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `indexOf` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `#add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1060` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:18` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `freeze` | `[native code]` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/error.mjs:108` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:19` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 1.0ms | 20.5% | 858.7ms | `require` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `extractPath` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` |
| 0.0% | 966us | 0.0% | 966us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1575` |
| 0.0% | 880us | 0.0% | 880us | `expandPaths` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 843us | 0.0% | 843us | `(unknown)` | `[native code]` |
| 0.0% | 821us | 0.0% | 821us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js` |
| 0.0% | 816us | 62.2% | 2.60s | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:66` |
| 0.0% | 791us | 95.3% | 3.98s | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:20` |
| 0.0% | 702us | 0.0% | 702us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:192` |
| 0.0% | 646us | 0.0% | 646us | `resolveLocalHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 637us | 0.0% | 1.2ms | `#hookHasTypeBox` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 629us | 0.0% | 629us | `compileHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 627us | 2.9% | 121.2ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:331` |
| 0.0% | 625us | 0.0% | 625us | `importModule` | `[native code]` |
| 0.0% | 617us | 0.0% | 617us | `setupTypebox` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/compat.mjs` |
| 0.0% | 533us | 0.0% | 533us | `set` | `[native code]` |
| 0.0% | 531us | 0.0% | 531us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js` |
| 0.0% | 502us | 0.0% | 502us | `dispatchResult` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:67` |
| 0.0% | 470us | 0.0% | 470us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/kind.js` |
| 0.0% | 464us | 0.0% | 464us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js` |
| 0.0% | 455us | 0.0% | 455us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/clone/value.js` |
| 0.0% | 454us | 0.0% | 454us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/index.js` |
| 0.0% | 431us | 0.0% | 431us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 428us | 0.0% | 428us | `#add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 428us | 0.0% | 428us | `defineProperty` | `[native code]` |
| 0.0% | 411us | 0.0% | 411us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror-require.mjs:1` |
| 0.0% | 401us | 0.0% | 401us | `hasOwnProperty` | `[native code]` |
| 0.0% | 358us | 0.0% | 358us | `routeRow` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:59` |
| 0.0% | 353us | 0.0% | 353us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:154` |
| 0.0% | 350us | 0.0% | 350us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:159` |
| 0.0% | 344us | 0.0% | 344us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` |
| 0.0% | 334us | 0.0% | 2.8ms | `#assertRouteModelRefs` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1425` |
| 0.0% | 333us | 0.0% | 333us | `expandPaths` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:92` |
| 0.0% | 331us | 0.0% | 331us | `applyHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 329us | 0.0% | 329us | `#jitDispatch` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 319us | 0.0% | 319us | `createNode` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:4` |
| 0.0% | 317us | 0.0% | 317us | `mapCompactResponse` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs` |
| 0.0% | 316us | 0.0% | 316us | `isHTMLBundle` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs` |
| 0.0% | 316us | 0.0% | 316us | `hasMacroKey` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 315us | 0.3% | 16.0ms | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:55` |
| 0.0% | 314us | 0.0% | 314us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 313us | 0.0% | 313us | `#staticAliases` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 309us | 0.0% | 309us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/object/index.js` |
| 0.0% | 299us | 0.0% | 299us | `flattenChainMemoReadonly` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs` |
| 0.0% | 295us | 0.0% | 295us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1570` |
| 0.0% | 288us | 0.0% | 288us | `chainResolver` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 287us | 0.0% | 287us | `handler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 286us | 0.0% | 286us | `isHTMLBundle` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:722` |
| 0.0% | 283us | 0.0% | 283us | `createNode` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` |
| 0.0% | 283us | 0.0% | 283us | `collectHookOrigins` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 283us | 0.0% | 283us | `getHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/aot.mjs` |
| 0.0% | 278us | 0.0% | 278us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` |
| 0.0% | 271us | 0.0% | 271us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1624` |
| 0.0% | 270us | 0.0% | 270us | `buildRouteTable` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:24` |
| 0.0% | 249us | 0.0% | 249us | `buildRouteTable` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:21` |
| 0.0% | 248us | 0.0% | 248us | `group` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 248us | 0.0% | 248us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/decode.js:3` |
| 0.0% | 245us | 0.0% | 245us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:137` |
| 0.0% | 242us | 0.0% | 242us | `Uint8Array` | `[native code]` |
| 0.0% | 240us | 0.0% | 240us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/promise/promise.js:4` |
| 0.0% | 230us | 20.5% | 859.1ms | `bound require` | `[native code]` |
| 0.0% | 229us | 0.0% | 229us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/boolean/index.js` |
| 0.0% | 229us | 0.0% | 229us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js` |
| 0.0% | 229us | 0.0% | 229us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:6` |
| 0.0% | 227us | 0.0% | 227us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:21` |
| 0.0% | 224us | 0.0% | 224us | `async elysiaApp` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 223us | 0.0% | 223us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/index.js` |
| 0.0% | 221us | 0.0% | 221us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/validator/index.mjs:101` |
| 0.0% | 221us | 0.0% | 221us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js` |
| 0.0% | 218us | 0.0% | 218us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/index.js` |
| 0.0% | 216us | 0.0% | 216us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js` |
| 0.0% | 216us | 0.0% | 216us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/has.js:3` |
| 0.0% | 216us | 0.0% | 216us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js` |
| 0.0% | 215us | 0.0% | 215us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/error.js:3` |
| 0.0% | 215us | 0.0% | 215us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/tuple/index.js` |
| 0.0% | 215us | 0.0% | 215us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/kind.js:3` |
| 0.0% | 214us | 0.0% | 214us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:14` |
| 0.0% | 214us | 0.0% | 214us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unknown/index.js` |
| 0.0% | 212us | 0.0% | 212us | `Elysia` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 210us | 0.0% | 210us | `(anonymous)` | `[native code]` |
| 0.0% | 210us | 0.0% | 210us | `CryptoHasher` | `[native code]` |
| 0.0% | 210us | 0.0% | 210us | `lazyNamespace` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/index.mjs` |
| 0.0% | 210us | 0.0% | 210us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:35` |
| 0.0% | 209us | 0.0% | 209us | `guard` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 204us | 0.0% | 204us | `Number` | `[native code]` |
| 0.0% | 203us | 0.0% | 203us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/string/index.js` |
| 0.0% | 203us | 0.0% | 203us | `setupTypebox` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/compat.mjs:34` |
| 0.0% | 202us | 0.0% | 202us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/index.js` |
| 0.0% | 196us | 0.0% | 196us | `(program)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/policy.js:1` |
| 0.0% | 196us | 0.0% | 196us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js:9` |
| 0.0% | 195us | 0.0% | 195us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/validator-cache.mjs` |
| 0.0% | 195us | 0.0% | 195us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/symbols/index.js` |
| 0.0% | 195us | 0.0% | 195us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/typebox-type.mjs:1` |
| 0.0% | 195us | 0.0% | 195us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js` |
| 0.0% | 194us | 0.0% | 194us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:26` |
| 0.0% | 194us | 0.0% | 194us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/never/index.js:14` |
| 0.0% | 193us | 0.0% | 193us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js` |
| 0.0% | 192us | 0.0% | 192us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js` |
| 0.0% | 189us | 0.0% | 189us | `entries` | `[native code]` |
| 0.0% | 183us | 0.0% | 183us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/type.js` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 95.3% | 3.98s | 0.0% | 791us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:20` |
| 62.2% | 2.60s | 0.0% | 816us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:66` |
| 47.4% | 1.98s | 0.0% | 2.7ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:335` |
| 36.4% | 1.52s | 0.6% | 28.7ms | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:94` |
| 34.8% | 1.45s | 0.5% | 21.8ms | `mapCompactResponse` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:85` |
| 34.3% | 1.43s | 34.3% | 1.43s | `Response` | `[native code]` |
| 33.1% | 1.38s | 1.1% | 48.8ms | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` |
| 31.9% | 1.33s | 31.9% | 1.33s | `Request` | `[native code]` |
| 20.5% | 859.1ms | 0.0% | 230us | `bound require` | `[native code]` |
| 20.5% | 858.7ms | 0.0% | 1.0ms | `require` | `[native code]` |
| 20.5% | 857.1ms | 1.6% | 66.9ms | `anonymous` | `[native code]` |
| 11.8% | 494.2ms | 7.1% | 297.6ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:332` |
| 9.7% | 408.3ms | 9.7% | 408.3ms | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:85` |
| 2.9% | 121.2ms | 0.0% | 627us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:331` |
| 2.5% | 105.5ms | 2.5% | 105.5ms | `extractPath` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:15` |
| 2.3% | 100.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:161` |
| 2.1% | 89.7ms | 0.0% | 0us | `requireExactMirror` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror-require.mjs:4` |
| 2.1% | 89.7ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror.mjs:7` |
| 2.1% | 87.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js:29` |
| 1.9% | 81.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/index.js:19` |
| 1.9% | 80.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/index.js:18` |
| 1.6% | 70.3ms | 1.6% | 70.3ms | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:63` |
| 1.3% | 57.9ms | 1.3% | 57.7ms | `map` | `[native code]` |
| 1.2% | 52.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:7` |
| 1.2% | 51.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js:18` |
| 1.2% | 50.4ms | 1.2% | 50.4ms | `extractPath` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:16` |
| 1.2% | 50.4ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs:77` |
| 1.1% | 48.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof-from-mapped-result.js:5` |
| 1.1% | 47.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:20` |
| 1.0% | 43.7ms | 1.0% | 43.7ms | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:71` |
| 0.9% | 39.4ms | 0.9% | 39.4ms | `extractPath` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:14` |
| 0.8% | 36.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:13` |
| 0.7% | 32.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js:18` |
| 0.7% | 32.4ms | 0.7% | 32.4ms | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:57` |
| 0.7% | 32.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed-from-mapped-key.js:5` |
| 0.6% | 28.6ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:57` |
| 0.6% | 27.7ms | 0.0% | 0us | `#dispatch` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1646` |
| 0.6% | 27.7ms | 0.0% | 0us | `#buildRouter` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1455` |
| 0.4% | 18.1ms | 0.4% | 17.1ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:158` |
| 0.3% | 16.0ms | 0.0% | 315us | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:55` |
| 0.3% | 15.7ms | 0.3% | 15.7ms | `Decorator` | `[native code]` |
| 0.3% | 13.9ms | 0.2% | 11.2ms | `mapCompactResponse` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:84` |
| 0.2% | 11.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:14` |
| 0.2% | 11.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed-property-keys.js:5` |
| 0.2% | 9.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:14` |
| 0.2% | 9.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:6` |
| 0.2% | 9.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:11` |
| 0.2% | 8.8ms | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1530` |
| 0.2% | 8.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js:18` |
| 0.2% | 8.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/never/index.js:18` |
| 0.1% | 7.5ms | 0.1% | 7.5ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:21` |
| 0.1% | 7.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/check.js:11` |
| 0.1% | 6.9ms | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1625` |
| 0.1% | 6.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js:19` |
| 0.1% | 6.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:20` |
| 0.1% | 6.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/hash/index.js:18` |
| 0.1% | 6.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:13` |
| 0.1% | 6.0ms | 0.1% | 6.0ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:28` |
| 0.1% | 5.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/hash/hash.js:40` |
| 0.1% | 5.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:12` |
| 0.1% | 5.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:24` |
| 0.1% | 5.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js:6` |
| 0.1% | 5.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/index.js:18` |
| 0.1% | 5.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/index.js:18` |
| 0.1% | 5.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/sets/index.js:18` |
| 0.1% | 5.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/index.js:22` |
| 0.1% | 4.8ms | 0.0% | 1.7ms | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1536` |
| 0.1% | 4.7ms | 0.1% | 4.7ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/sets/index.js` |
| 0.1% | 4.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/unsafe.js:5` |
| 0.1% | 4.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/index.js:18` |
| 0.0% | 3.9ms | 0.0% | 3.9ms | `buildRouteTable` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:36` |
| 0.0% | 3.5ms | 0.0% | 3.5ms | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:195` |
| 0.0% | 3.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/type.js:6` |
| 0.0% | 3.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect-evaluated.js:9` |
| 0.0% | 3.1ms | 0.0% | 3.1ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs` |
| 0.0% | 3.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js:5` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `buildRouteTable` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `findRoute` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` |
| 0.0% | 2.8ms | 0.0% | 334us | `#assertRouteModelRefs` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1425` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `responseTag` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:25` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` |
| 0.0% | 2.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/index.js:18` |
| 0.0% | 2.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:13` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/optional-from-mapped-result.js:6` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js:18` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:15` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof-from-mapped-result.js:6` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `Context` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs` |
| 0.0% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:22` |
| 0.0% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:10` |
| 0.0% | 1.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/optional.js:9` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:5` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:18` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/index.js:19` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:20` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/policy.js:5` |
| 0.0% | 1.3ms | 0.0% | 0us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:150` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `indexOf` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 0us | `splitPath` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:85` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `#add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1060` |
| 0.0% | 1.3ms | 0.0% | 0us | `async elysiaApp` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:49` |
| 0.0% | 1.2ms | 0.0% | 637us | `#hookHasTypeBox` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 1.2ms | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1550` |
| 0.0% | 1.2ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:54` |
| 0.0% | 1.2ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:13` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/index.js:39` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:19` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:18` |
| 0.0% | 1.2ms | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1620` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof.js:10` |
| 0.0% | 1.1ms | 0.0% | 0us | `#jitDispatch` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1320` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `freeze` | `[native code]` |
| 0.0% | 1.1ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:17` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/error.mjs:108` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:6` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:18` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/unsafe.js:6` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:19` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:8` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/index.js:18` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:10` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/index.js:18` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:6` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js:18` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `extractPath` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:17` |
| 0.0% | 993us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/immutable.js:38` |
| 0.0% | 974us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/ref/index.js:18` |
| 0.0% | 966us | 0.0% | 966us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1575` |
| 0.0% | 922us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js:8` |
| 0.0% | 914us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/index.js:18` |
| 0.0% | 907us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/pattern.js:6` |
| 0.0% | 904us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-from-mapped-key.js:7` |
| 0.0% | 888us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/type.js:7` |
| 0.0% | 887us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:15` |
| 0.0% | 882us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:9` |
| 0.0% | 880us | 0.0% | 880us | `expandPaths` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 867us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:7` |
| 0.0% | 849us | 0.0% | 0us | `async elysiaApp` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:32` |
| 0.0% | 843us | 0.0% | 843us | `(unknown)` | `[native code]` |
| 0.0% | 821us | 0.0% | 821us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js` |
| 0.0% | 821us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:90` |
| 0.0% | 820us | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/index.mjs:37` |
| 0.0% | 809us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:21` |
| 0.0% | 702us | 0.0% | 702us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:192` |
| 0.0% | 673us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/finite.js:7` |
| 0.0% | 661us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:19` |
| 0.0% | 655us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:18` |
| 0.0% | 646us | 0.0% | 646us | `resolveLocalHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 646us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/computed.js:5` |
| 0.0% | 646us | 0.0% | 0us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:236` |
| 0.0% | 642us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:24` |
| 0.0% | 633us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unknown/index.js:18` |
| 0.0% | 629us | 0.0% | 629us | `compileHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 625us | 0.0% | 0us | `async elysiaApp` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:33` |
| 0.0% | 625us | 0.0% | 625us | `importModule` | `[native code]` |
| 0.0% | 624us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:20` |
| 0.0% | 617us | 0.0% | 617us | `setupTypebox` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/compat.mjs` |
| 0.0% | 615us | 0.0% | 0us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:241` |
| 0.0% | 615us | 0.0% | 0us | `flattenChainMemo` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:256` |
| 0.0% | 613us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:9` |
| 0.0% | 580us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/tuple/index.js:18` |
| 0.0% | 550us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/promise/index.js:18` |
| 0.0% | 541us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/object/index.js:18` |
| 0.0% | 539us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/readonly-from-mapped-result.js:6` |
| 0.0% | 533us | 0.0% | 533us | `set` | `[native code]` |
| 0.0% | 531us | 0.0% | 531us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js` |
| 0.0% | 502us | 0.0% | 502us | `dispatchResult` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:67` |
| 0.0% | 482us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/patterns/index.js:18` |
| 0.0% | 481us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/union-evaluated.js:10` |
| 0.0% | 475us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/literal/index.js:18` |
| 0.0% | 470us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/kind.js:86` |
| 0.0% | 470us | 0.0% | 470us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/kind.js` |
| 0.0% | 469us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends.js:9` |
| 0.0% | 465us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/boolean/index.js:18` |
| 0.0% | 464us | 0.0% | 464us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js` |
| 0.0% | 464us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:16` |
| 0.0% | 460us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/index.js:19` |
| 0.0% | 460us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect-evaluated.js:10` |
| 0.0% | 457us | 0.0% | 0us | `async elysiaApp` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:37` |
| 0.0% | 455us | 0.0% | 455us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/clone/value.js` |
| 0.0% | 455us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/clone/value.js:33` |
| 0.0% | 454us | 0.0% | 454us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/index.js` |
| 0.0% | 449us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:23` |
| 0.0% | 440us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/bigint/index.js:18` |
| 0.0% | 440us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/iterator/index.js:18` |
| 0.0% | 438us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js:18` |
| 0.0% | 437us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/index.js:18` |
| 0.0% | 432us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js:19` |
| 0.0% | 431us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js:18` |
| 0.0% | 431us | 0.0% | 431us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 431us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/index.js:20` |
| 0.0% | 428us | 0.0% | 0us | `async elysiaApp` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:35` |
| 0.0% | 428us | 0.0% | 428us | `#add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 428us | 0.0% | 428us | `defineProperty` | `[native code]` |
| 0.0% | 426us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:15` |
| 0.0% | 421us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/symbols/index.js:18` |
| 0.0% | 411us | 0.0% | 411us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror-require.mjs:1` |
| 0.0% | 409us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/string/index.js:18` |
| 0.0% | 407us | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs:78` |
| 0.0% | 407us | 0.0% | 0us | `mapBack` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs:2` |
| 0.0% | 401us | 0.0% | 401us | `hasOwnProperty` | `[native code]` |
| 0.0% | 387us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js:15` |
| 0.0% | 358us | 0.0% | 358us | `routeRow` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:59` |
| 0.0% | 353us | 0.0% | 353us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:154` |
| 0.0% | 350us | 0.0% | 350us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:159` |
| 0.0% | 344us | 0.0% | 344us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` |
| 0.0% | 333us | 0.0% | 333us | `expandPaths` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:92` |
| 0.0% | 331us | 0.0% | 0us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:261` |
| 0.0% | 331us | 0.0% | 331us | `applyHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 329us | 0.0% | 329us | `#jitDispatch` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 319us | 0.0% | 0us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:187` |
| 0.0% | 319us | 0.0% | 319us | `createNode` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:4` |
| 0.0% | 317us | 0.0% | 317us | `mapCompactResponse` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs` |
| 0.0% | 316us | 0.0% | 0us | `flattenChainMemoReadonly` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:249` |
| 0.0% | 316us | 0.0% | 316us | `hasMacroKey` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 316us | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1622` |
| 0.0% | 316us | 0.0% | 0us | `flattenChain` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:178` |
| 0.0% | 316us | 0.0% | 316us | `isHTMLBundle` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs` |
| 0.0% | 316us | 0.0% | 0us | `resolveChainNode` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:159` |
| 0.0% | 314us | 0.0% | 314us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 313us | 0.0% | 313us | `#staticAliases` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 313us | 0.0% | 0us | `#jitDispatch` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1329` |
| 0.0% | 309us | 0.0% | 309us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/object/index.js` |
| 0.0% | 299us | 0.0% | 299us | `flattenChainMemoReadonly` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs` |
| 0.0% | 295us | 0.0% | 295us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1570` |
| 0.0% | 288us | 0.0% | 0us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:235` |
| 0.0% | 288us | 0.0% | 288us | `chainResolver` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 287us | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1617` |
| 0.0% | 287us | 0.0% | 287us | `handler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 286us | 0.0% | 0us | `compileHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:438` |
| 0.0% | 286us | 0.0% | 286us | `isHTMLBundle` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:722` |
| 0.0% | 283us | 0.0% | 0us | `composeRouteHook` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:245` |
| 0.0% | 283us | 0.0% | 0us | `add` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:153` |
| 0.0% | 283us | 0.0% | 283us | `createNode` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` |
| 0.0% | 283us | 0.0% | 0us | `compileHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:418` |
| 0.0% | 283us | 0.0% | 283us | `getHandler` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/aot.mjs` |
| 0.0% | 283us | 0.0% | 283us | `collectHookOrigins` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 278us | 0.0% | 0us | `Memoirist` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:112` |
| 0.0% | 278us | 0.0% | 278us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` |
| 0.0% | 278us | 0.0% | 0us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1623` |
| 0.0% | 271us | 0.0% | 271us | `#buildRouterUnsafe` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1624` |
| 0.0% | 270us | 0.0% | 270us | `buildRouteTable` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:24` |
| 0.0% | 257us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/index.js:19` |
| 0.0% | 249us | 0.0% | 249us | `buildRouteTable` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:21` |
| 0.0% | 248us | 0.0% | 248us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/decode.js:3` |
| 0.0% | 248us | 0.0% | 248us | `group` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 245us | 0.0% | 245us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:137` |
| 0.0% | 242us | 0.0% | 242us | `Uint8Array` | `[native code]` |
| 0.0% | 242us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/hash/hash.js:43` |
| 0.0% | 241us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/parse.js:7` |
| 0.0% | 240us | 0.0% | 240us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/promise/promise.js:4` |
| 0.0% | 239us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js:669` |
| 0.0% | 229us | 0.0% | 229us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:6` |
| 0.0% | 229us | 0.0% | 229us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/boolean/index.js` |
| 0.0% | 229us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/boolean/index.js:15` |
| 0.0% | 229us | 0.0% | 229us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js` |
| 0.0% | 229us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:15` |
| 0.0% | 229us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js:15` |
| 0.0% | 227us | 0.0% | 227us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:21` |
| 0.0% | 227us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:23` |
| 0.0% | 225us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js:195` |
| 0.0% | 224us | 0.0% | 224us | `async elysiaApp` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 223us | 0.0% | 223us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/index.js` |
| 0.0% | 223us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/index.js:15` |
| 0.0% | 222us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/pattern.js:8` |
| 0.0% | 222us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/iterator/iterator.js:6` |
| 0.0% | 221us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/index.js:18` |
| 0.0% | 221us | 0.0% | 221us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js` |
| 0.0% | 221us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/index.js:20` |
| 0.0% | 221us | 0.0% | 221us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/validator/index.mjs:101` |
| 0.0% | 221us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js:15` |
| 0.0% | 221us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:19` |
| 0.0% | 218us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/index.js:15` |
| 0.0% | 218us | 0.0% | 218us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/index.js` |
| 0.0% | 216us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:15` |
| 0.0% | 216us | 0.0% | 216us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js` |
| 0.0% | 216us | 0.0% | 216us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js` |
| 0.0% | 216us | 0.0% | 216us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/has.js:3` |
| 0.0% | 216us | 0.0% | 0us | `__export` | `/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js:8` |
| 0.0% | 216us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js:22` |
| 0.0% | 215us | 0.0% | 215us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/error.js:3` |
| 0.0% | 215us | 0.0% | 215us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/kind.js:3` |
| 0.0% | 215us | 0.0% | 215us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/tuple/index.js` |
| 0.0% | 214us | 0.0% | 214us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unknown/index.js` |
| 0.0% | 214us | 0.0% | 214us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:14` |
| 0.0% | 214us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unknown/index.js:15` |
| 0.0% | 212us | 0.0% | 212us | `Elysia` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 212us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/ref/index.js:9` |
| 0.0% | 212us | 0.0% | 0us | `async elysiaApp` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:34` |
| 0.0% | 212us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/ref/index.js:15` |
| 0.0% | 210us | 0.0% | 210us | `(anonymous)` | `[native code]` |
| 0.0% | 210us | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/cookie/crypto.mjs:24` |
| 0.0% | 210us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/cookie/crypto.mjs:22` |
| 0.0% | 210us | 0.0% | 210us | `CryptoHasher` | `[native code]` |
| 0.0% | 210us | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/index.mjs:73` |
| 0.0% | 210us | 0.0% | 210us | `lazyNamespace` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/index.mjs` |
| 0.0% | 210us | 0.0% | 210us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:35` |
| 0.0% | 210us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/template-literal.js:5` |
| 0.0% | 209us | 0.0% | 209us | `guard` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.0% | 205us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-undefined.js:5` |
| 0.0% | 204us | 0.0% | 204us | `Number` | `[native code]` |
| 0.0% | 204us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:12` |
| 0.0% | 203us | 0.0% | 203us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/string/index.js` |
| 0.0% | 203us | 0.0% | 203us | `setupTypebox` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/compat.mjs:34` |
| 0.0% | 203us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/index.js:19` |
| 0.0% | 202us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/index.js:33` |
| 0.0% | 202us | 0.0% | 202us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/index.js` |
| 0.0% | 196us | 0.0% | 196us | `(program)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/policy.js:1` |
| 0.0% | 196us | 0.0% | 196us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js:9` |
| 0.0% | 195us | 0.0% | 195us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js` |
| 0.0% | 195us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/symbols/index.js:15` |
| 0.0% | 195us | 0.0% | 195us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/typebox-type.mjs:1` |
| 0.0% | 195us | 0.0% | 0us | `(module)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/validator-cache.mjs:146` |
| 0.0% | 195us | 0.0% | 195us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/symbols/index.js` |
| 0.0% | 195us | 0.0% | 195us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/validator-cache.mjs` |
| 0.0% | 194us | 0.0% | 194us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:26` |
| 0.0% | 194us | 0.0% | 194us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/never/index.js:14` |
| 0.0% | 193us | 0.0% | 193us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js` |
| 0.0% | 193us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js:15` |
| 0.0% | 192us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js:42` |
| 0.0% | 192us | 0.0% | 192us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js` |
| 0.0% | 191us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/check.js:10` |
| 0.0% | 189us | 0.0% | 189us | `entries` | `[native code]` |
| 0.0% | 183us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/type.js:33` |
| 0.0% | 183us | 0.0% | 183us | `(anonymous)` | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/type.js` |

## Function Details

### `Response`
`[native code]` | Self: 34.3% (1.43s) | Total: 34.3% (1.43s) | Samples: 5200

**Called by:**
- `mapCompactResponse` (5200)

### `Request`
`[native code]` | Self: 31.9% (1.33s) | Total: 31.9% (1.33s) | Samples: 5347

**Called by:**
- `static` (5347)

### `findRoute`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:85` | Self: 9.7% (408.3ms) | Total: 9.7% (408.3ms) | Samples: 1557

**Called by:**
- `(anonymous)` (1557)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:332` | Self: 7.1% (297.6ms) | Total: 11.8% (494.2ms) | Samples: 1181

**Called by:**
- `(anonymous)` (1951)

**Calls:**
- `extractPath` (368)
- `extractPath` (212)
- `extractPath` (189)
- `extractPath` (1)

### `extractPath`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:15` | Self: 2.5% (105.5ms) | Total: 2.5% (105.5ms) | Samples: 368

**Called by:**
- `(anonymous)` (368)

### `Context`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:63` | Self: 1.6% (70.3ms) | Total: 1.6% (70.3ms) | Samples: 102

**Called by:**
- `(anonymous)` (102)

### `anonymous`
`[native code]` | Self: 1.6% (66.9ms) | Total: 20.5% (857.1ms) | Samples: 230

**Called by:**
- `require` (2645)

**Calls:**
- `(anonymous)` (272)
- `(anonymous)` (243)
- `(anonymous)` (241)
- `(anonymous)` (154)
- `(anonymous)` (150)
- `(anonymous)` (139)
- `(anonymous)` (134)
- `(anonymous)` (107)
- `(anonymous)` (106)
- `(anonymous)` (102)
- `(anonymous)` (48)
- `(anonymous)` (46)
- `(anonymous)` (42)
- `(anonymous)` (39)
- `(anonymous)` (35)
- `(anonymous)` (29)
- `(anonymous)` (26)
- `(anonymous)` (24)
- `(anonymous)` (24)
- `(anonymous)` (23)
- `(anonymous)` (18)
- `(anonymous)` (17)
- `(anonymous)` (14)
- `(anonymous)` (13)
- `(anonymous)` (12)
- `(anonymous)` (12)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (9)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
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
- `(anonymous)` (4)
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
- `(program)` (1)
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

### `map`
`[native code]` | Self: 1.3% (57.7ms) | Total: 1.3% (57.9ms) | Samples: 5

**Called by:**
- `#buildRouterUnsafe` (3)
- `mapBack` (1)
- `(anonymous)` (1)
- `(module)` (1)

**Calls:**
- `(anonymous)` (1)

### `extractPath`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:16` | Self: 1.2% (50.4ms) | Total: 1.2% (50.4ms) | Samples: 212

**Called by:**
- `(anonymous)` (212)

### `static`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` | Self: 1.1% (48.8ms) | Total: 33.1% (1.38s) | Samples: 225

**Called by:**
- `(module)` (5572)

**Calls:**
- `Request` (5347)

### `findRoute`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:71` | Self: 1.0% (43.7ms) | Total: 1.0% (43.7ms) | Samples: 172

**Called by:**
- `(anonymous)` (172)

### `extractPath`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:14` | Self: 0.9% (39.4ms) | Total: 0.9% (39.4ms) | Samples: 189

**Called by:**
- `(anonymous)` (189)

### `Context`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:57` | Self: 0.7% (32.4ms) | Total: 0.7% (32.4ms) | Samples: 71

**Called by:**
- `(anonymous)` (71)

### `findRoute`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:94` | Self: 0.6% (28.7ms) | Total: 36.4% (1.52s) | Samples: 120

**Called by:**
- `(anonymous)` (5489)

**Calls:**
- `mapCompactResponse` (4932)
- `(anonymous)` (372)
- `(anonymous)` (41)
- `mapCompactResponse` (15)
- `#jitDispatch` (4)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `#jitDispatch` (1)
- `mapCompactResponse` (1)
- `#jitDispatch` (1)

### `mapCompactResponse`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:85` | Self: 0.5% (21.8ms) | Total: 34.8% (1.45s) | Samples: 104

**Called by:**
- `findRoute` (4932)
- `(anonymous)` (372)

**Calls:**
- `Response` (5200)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:158` | Self: 0.4% (17.1ms) | Total: 0.4% (18.1ms) | Samples: 36

**Called by:**
- `findRoute` (41)

**Calls:**
- `(anonymous)` (4)
- `(anonymous)` (1)

### `Decorator`
`[native code]` | Self: 0.3% (15.7ms) | Total: 0.3% (15.7ms) | Samples: 72

**Called by:**
- `Context` (72)

### `mapCompactResponse`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:84` | Self: 0.2% (11.2ms) | Total: 0.3% (13.9ms) | Samples: 13

**Called by:**
- `findRoute` (15)

**Calls:**
- `responseTag` (2)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:21` | Self: 0.1% (7.5ms) | Total: 0.1% (7.5ms) | Samples: 20

### `(module)`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:28` | Self: 0.1% (6.0ms) | Total: 0.1% (6.0ms) | Samples: 1

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/sets/index.js` | Self: 0.1% (4.7ms) | Total: 0.1% (4.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `buildRouteTable`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:36` | Self: 0.0% (3.9ms) | Total: 0.0% (3.9ms) | Samples: 2

**Called by:**
- `#buildRouterUnsafe` (2)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:195` | Self: 0.0% (3.5ms) | Total: 0.0% (3.5ms) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs` | Self: 0.0% (3.1ms) | Total: 0.0% (3.1ms) | Samples: 1

**Called by:**
- `findRoute` (1)

### `buildRouteTable`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs` | Self: 0.0% (2.9ms) | Total: 0.0% (2.9ms) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `findRoute`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` | Self: 0.0% (2.8ms) | Total: 0.0% (2.8ms) | Samples: 12

**Called by:**
- `(anonymous)` (12)

### `responseTag`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs:25` | Self: 0.0% (2.7ms) | Total: 0.0% (2.7ms) | Samples: 2

**Called by:**
- `mapCompactResponse` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:335` | Self: 0.0% (2.7ms) | Total: 47.4% (1.98s) | Samples: 9

**Called by:**
- `(anonymous)` (7240)

**Calls:**
- `findRoute` (5489)
- `findRoute` (1557)
- `findRoute` (172)
- `findRoute` (12)
- `dispatchResult` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` | Self: 0.0% (2.6ms) | Total: 0.0% (2.6ms) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (2.1ms) | Total: 0.0% (2.1ms) | Samples: 1

**Called by:**
- `#buildRouter` (1)

### `Context`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 9

**Called by:**
- `(anonymous)` (9)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1536` | Self: 0.0% (1.7ms) | Total: 0.1% (4.8ms) | Samples: 1

**Called by:**
- `#buildRouter` (10)

**Calls:**
- `#assertRouteModelRefs` (8)
- `routeRow` (1)

### `indexOf`
`[native code]` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `splitPath` (1)

### `#add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1060` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `async elysiaApp` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:18` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 6

### `freeze`
`[native code]` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/error.mjs:108` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:19` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 3

### `(anonymous)`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 5

**Called by:**
- `(anonymous)` (4)
- `(module)` (1)

### `require`
`[native code]` | Self: 0.0% (1.0ms) | Total: 20.5% (858.7ms) | Samples: 5

**Called by:**
- `bound require` (2651)

**Calls:**
- `anonymous` (2645)
- `set` (1)

### `extractPath`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1575` | Self: 0.0% (966us) | Total: 0.0% (966us) | Samples: 1

**Called by:**
- `#buildRouter` (1)

### `expandPaths`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (880us) | Total: 0.0% (880us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `(unknown)`
`[native code]` | Self: 0.0% (843us) | Total: 0.0% (843us) | Samples: 2

**Called by:**
- `#hookHasTypeBox` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js` | Self: 0.0% (821us) | Total: 0.0% (821us) | Samples: 3

**Called by:**
- `(anonymous)` (3)

### `(anonymous)`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:66` | Self: 0.0% (816us) | Total: 62.2% (2.60s) | Samples: 4

**Called by:**
- `(module)` (9455)

**Calls:**
- `(anonymous)` (7240)
- `(anonymous)` (1951)
- `(anonymous)` (258)
- `(anonymous)` (2)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:20` | Self: 0.0% (791us) | Total: 95.3% (3.98s) | Samples: 4

**Calls:**
- `(anonymous)` (9455)
- `static` (5572)
- `(anonymous)` (1)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:192` | Self: 0.0% (702us) | Total: 0.0% (702us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `resolveLocalHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` | Self: 0.0% (646us) | Total: 0.0% (646us) | Samples: 1

**Called by:**
- `composeRouteHook` (1)

### `#hookHasTypeBox`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (637us) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (2)

**Calls:**
- `(unknown)` (1)

### `compileHandler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` | Self: 0.0% (629us) | Total: 0.0% (629us) | Samples: 2

**Called by:**
- `#jitDispatch` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:331` | Self: 0.0% (627us) | Total: 2.9% (121.2ms) | Samples: 3

**Called by:**
- `(anonymous)` (258)

**Calls:**
- `Context` (102)
- `Context` (73)
- `Context` (71)
- `Context` (9)

### `importModule`
`[native code]` | Self: 0.0% (625us) | Total: 0.0% (625us) | Samples: 3

**Called by:**
- `async elysiaApp` (3)

### `setupTypebox`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/compat.mjs` | Self: 0.0% (617us) | Total: 0.0% (617us) | Samples: 1

**Called by:**
- `(module)` (1)

### `set`
`[native code]` | Self: 0.0% (533us) | Total: 0.0% (533us) | Samples: 1

**Called by:**
- `require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js` | Self: 0.0% (531us) | Total: 0.0% (531us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `dispatchResult`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs:67` | Self: 0.0% (502us) | Total: 0.0% (502us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/kind.js` | Self: 0.0% (470us) | Total: 0.0% (470us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js` | Self: 0.0% (464us) | Total: 0.0% (464us) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/clone/value.js` | Self: 0.0% (455us) | Total: 0.0% (455us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/index.js` | Self: 0.0% (454us) | Total: 0.0% (454us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` | Self: 0.0% (431us) | Total: 0.0% (431us) | Samples: 2

**Called by:**
- `async makeTarget` (2)

### `#add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (428us) | Total: 0.0% (428us) | Samples: 2

**Called by:**
- `async elysiaApp` (2)

### `defineProperty`
`[native code]` | Self: 0.0% (428us) | Total: 0.0% (428us) | Samples: 2

**Called by:**
- `__export` (1)
- `(anonymous)` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror-require.mjs:1` | Self: 0.0% (411us) | Total: 0.0% (411us) | Samples: 1

### `hasOwnProperty`
`[native code]` | Self: 0.0% (401us) | Total: 0.0% (401us) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `routeRow`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:59` | Self: 0.0% (358us) | Total: 0.0% (358us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:154` | Self: 0.0% (353us) | Total: 0.0% (353us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:159` | Self: 0.0% (350us) | Total: 0.0% (350us) | Samples: 1

**Called by:**
- `findRoute` (1)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` | Self: 0.0% (344us) | Total: 0.0% (344us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `#assertRouteModelRefs`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1425` | Self: 0.0% (334us) | Total: 0.0% (2.8ms) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (8)

**Calls:**
- `composeRouteHook` (2)
- `composeRouteHook` (1)
- `composeRouteHook` (1)
- `composeRouteHook` (1)
- `composeRouteHook` (1)
- `composeRouteHook` (1)

### `expandPaths`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:92` | Self: 0.0% (333us) | Total: 0.0% (333us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `applyHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` | Self: 0.0% (331us) | Total: 0.0% (331us) | Samples: 1

**Called by:**
- `composeRouteHook` (1)

### `#jitDispatch`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (329us) | Total: 0.0% (329us) | Samples: 1

**Called by:**
- `findRoute` (1)

### `createNode`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:4` | Self: 0.0% (319us) | Total: 0.0% (319us) | Samples: 1

**Called by:**
- `add` (1)

### `mapCompactResponse`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs` | Self: 0.0% (317us) | Total: 0.0% (317us) | Samples: 1

**Called by:**
- `findRoute` (1)

### `isHTMLBundle`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs` | Self: 0.0% (316us) | Total: 0.0% (316us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `hasMacroKey`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` | Self: 0.0% (316us) | Total: 0.0% (316us) | Samples: 1

**Called by:**
- `resolveChainNode` (1)

### `Context`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs:55` | Self: 0.0% (315us) | Total: 0.3% (16.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (73)

**Calls:**
- `Decorator` (72)

### `composeRouteHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` | Self: 0.0% (314us) | Total: 0.0% (314us) | Samples: 1

**Called by:**
- `#assertRouteModelRefs` (1)

### `#staticAliases`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (313us) | Total: 0.0% (313us) | Samples: 1

**Called by:**
- `#jitDispatch` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/object/index.js` | Self: 0.0% (309us) | Total: 0.0% (309us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `flattenChainMemoReadonly`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs` | Self: 0.0% (299us) | Total: 0.0% (299us) | Samples: 1

**Called by:**
- `flattenChainMemo` (1)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1570` | Self: 0.0% (295us) | Total: 0.0% (295us) | Samples: 1

**Called by:**
- `#buildRouter` (1)

### `chainResolver`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` | Self: 0.0% (288us) | Total: 0.0% (288us) | Samples: 1

**Called by:**
- `composeRouteHook` (1)

### `handler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (287us) | Total: 0.0% (287us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `isHTMLBundle`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:722` | Self: 0.0% (286us) | Total: 0.0% (286us) | Samples: 1

**Called by:**
- `compileHandler` (1)

### `createNode`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` | Self: 0.0% (283us) | Total: 0.0% (283us) | Samples: 1

**Called by:**
- `add` (1)

### `collectHookOrigins`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` | Self: 0.0% (283us) | Total: 0.0% (283us) | Samples: 1

**Called by:**
- `composeRouteHook` (1)

### `getHandler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/aot.mjs` | Self: 0.0% (283us) | Total: 0.0% (283us) | Samples: 1

**Called by:**
- `compileHandler` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` | Self: 0.0% (278us) | Total: 0.0% (278us) | Samples: 1

**Called by:**
- `Memoirist` (1)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1624` | Self: 0.0% (271us) | Total: 0.0% (271us) | Samples: 1

**Called by:**
- `#buildRouter` (1)

### `buildRouteTable`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:24` | Self: 0.0% (270us) | Total: 0.0% (270us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `buildRouteTable`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs:21` | Self: 0.0% (249us) | Total: 0.0% (249us) | Samples: 1

**Called by:**
- `#buildRouterUnsafe` (1)

### `group`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (248us) | Total: 0.0% (248us) | Samples: 1

**Called by:**
- `async elysiaApp` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/decode.js:3` | Self: 0.0% (248us) | Total: 0.0% (248us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:137` | Self: 0.0% (245us) | Total: 0.0% (245us) | Samples: 1

**Called by:**
- `map` (1)

### `Uint8Array`
`[native code]` | Self: 0.0% (242us) | Total: 0.0% (242us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/promise/promise.js:4` | Self: 0.0% (240us) | Total: 0.0% (240us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `bound require`
`[native code]` | Self: 0.0% (230us) | Total: 20.5% (859.1ms) | Samples: 1

**Called by:**
- `requireExactMirror` (281)
- `(anonymous)` (272)
- `(anonymous)` (243)
- `(anonymous)` (240)
- `(anonymous)` (154)
- `(anonymous)` (149)
- `(anonymous)` (139)
- `(anonymous)` (133)
- `(anonymous)` (107)
- `(anonymous)` (105)
- `(anonymous)` (102)
- `(anonymous)` (48)
- `(anonymous)` (46)
- `(anonymous)` (42)
- `(anonymous)` (38)
- `(anonymous)` (35)
- `(anonymous)` (29)
- `(anonymous)` (26)
- `(anonymous)` (24)
- `(anonymous)` (24)
- `(anonymous)` (23)
- `(anonymous)` (18)
- `(anonymous)` (17)
- `(anonymous)` (14)
- `(anonymous)` (13)
- `(anonymous)` (12)
- `(anonymous)` (12)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (9)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
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

**Calls:**
- `require` (2651)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/boolean/index.js` | Self: 0.0% (229us) | Total: 0.0% (229us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js` | Self: 0.0% (229us) | Total: 0.0% (229us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:6` | Self: 0.0% (229us) | Total: 0.0% (229us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:21` | Self: 0.0% (227us) | Total: 0.0% (227us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async elysiaApp`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` | Self: 0.0% (224us) | Total: 0.0% (224us) | Samples: 1

**Called by:**
- `async elysiaApp` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/index.js` | Self: 0.0% (223us) | Total: 0.0% (223us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/validator/index.mjs:101` | Self: 0.0% (221us) | Total: 0.0% (221us) | Samples: 1

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js` | Self: 0.0% (221us) | Total: 0.0% (221us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/index.js` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/has.js:3` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/error.js:3` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/tuple/index.js` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/kind.js:3` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:14` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unknown/index.js` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `Elysia`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `async elysiaApp` (1)

### `(anonymous)`
`[native code]` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `bound require` (1)

### `CryptoHasher`
`[native code]` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `lazyNamespace`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/index.mjs` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:35` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `guard`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `async elysiaApp` (1)

### `Number`
`[native code]` | Self: 0.0% (204us) | Total: 0.0% (204us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/string/index.js` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `setupTypebox`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/compat.mjs:34` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/index.js` | Self: 0.0% (202us) | Total: 0.0% (202us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(program)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/policy.js:1` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js:9` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/validator-cache.mjs` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/symbols/index.js` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/typebox-type.mjs:1` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:26` | Self: 0.0% (194us) | Total: 0.0% (194us) | Samples: 1

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/never/index.js:14` | Self: 0.0% (194us) | Total: 0.0% (194us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js` | Self: 0.0% (192us) | Total: 0.0% (192us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `entries`
`[native code]` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `mapBack` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/type.js` | Self: 0.0% (183us) | Total: 0.0% (183us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/unsafe.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (218us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js:18` | Self: 0.0% (0us) | Total: 1.2% (51.7ms) | Samples: 0

**Called by:**
- `anonymous` (150)

**Calls:**
- `bound require` (149)
- `(anonymous)` (1)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1622` | Self: 0.0% (0us) | Total: 0.0% (316us) | Samples: 0

**Called by:**
- `#buildRouter` (1)

**Calls:**
- `isHTMLBundle` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror.mjs:7` | Self: 0.0% (0us) | Total: 2.1% (89.7ms) | Samples: 0

**Calls:**
- `requireExactMirror` (281)

### `async elysiaApp`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:32` | Self: 0.0% (0us) | Total: 0.0% (849us) | Samples: 0

**Called by:**
- `async makeTarget` (4)

**Calls:**
- `async elysiaApp` (3)
- `async elysiaApp` (1)

### `requireExactMirror`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror-require.mjs:4` | Self: 0.0% (0us) | Total: 2.1% (89.7ms) | Samples: 0

**Called by:**
- `(module)` (281)

**Calls:**
- `bound require` (281)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1530` | Self: 0.0% (0us) | Total: 0.2% (8.8ms) | Samples: 0

**Called by:**
- `#buildRouter` (8)

**Calls:**
- `map` (3)
- `buildRouteTable` (2)
- `buildRouteTable` (1)
- `buildRouteTable` (1)
- `buildRouteTable` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:23` | Self: 0.0% (0us) | Total: 0.0% (449us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/index.js:18` | Self: 0.0% (0us) | Total: 1.9% (80.7ms) | Samples: 0

**Called by:**
- `anonymous` (241)

**Calls:**
- `bound require` (240)
- `(anonymous)` (1)

### `#jitDispatch`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1329` | Self: 0.0% (0us) | Total: 0.0% (313us) | Samples: 0

**Called by:**
- `findRoute` (1)

**Calls:**
- `#staticAliases` (1)

### `compileHandler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:438` | Self: 0.0% (0us) | Total: 0.0% (286us) | Samples: 0

**Called by:**
- `#jitDispatch` (1)

**Calls:**
- `isHTMLBundle` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (438us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `(anonymous)` (1)
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:13` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Calls:**
- `async makeTarget` (6)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (914us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `composeRouteHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:236` | Self: 0.0% (0us) | Total: 0.0% (646us) | Samples: 0

**Called by:**
- `#assertRouteModelRefs` (1)

**Calls:**
- `resolveLocalHook` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/boolean/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof-from-mapped-result.js:5` | Self: 0.0% (0us) | Total: 1.1% (48.9ms) | Samples: 0

**Called by:**
- `anonymous` (139)

**Calls:**
- `bound require` (139)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/immutable.js:38` | Self: 0.0% (0us) | Total: 0.0% (993us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/index.js:20` | Self: 0.0% (0us) | Total: 0.0% (221us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect-evaluated.js:10` | Self: 0.0% (0us) | Total: 0.0% (460us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:14` | Self: 0.0% (0us) | Total: 0.2% (11.7ms) | Samples: 0

**Called by:**
- `anonymous` (48)

**Calls:**
- `bound require` (48)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:150` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `#buildRouterUnsafe` (1)

**Calls:**
- `splitPath` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:21` | Self: 0.0% (0us) | Total: 0.0% (809us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/boolean/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (465us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js:669` | Self: 0.0% (0us) | Total: 0.0% (239us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js:29` | Self: 0.0% (0us) | Total: 2.1% (87.8ms) | Samples: 0

**Called by:**
- `anonymous` (272)

**Calls:**
- `bound require` (272)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:57` | Self: 0.0% (0us) | Total: 0.6% (28.6ms) | Samples: 0

**Called by:**
- `async makeTarget` (4)

**Calls:**
- `#dispatch` (36)
- `async elysiaApp` (4)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:15` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:7` | Self: 0.0% (0us) | Total: 1.2% (52.6ms) | Samples: 0

**Called by:**
- `anonymous` (154)

**Calls:**
- `bound require` (154)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:12` | Self: 0.0% (0us) | Total: 0.1% (5.7ms) | Samples: 0

**Called by:**
- `anonymous` (24)

**Calls:**
- `bound require` (24)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/symbols/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/optional-from-mapped-result.js:6` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `flattenChainMemoReadonly`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:249` | Self: 0.0% (0us) | Total: 0.0% (316us) | Samples: 0

**Called by:**
- `flattenChainMemo` (1)

**Calls:**
- `flattenChain` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/index.js:18` | Self: 0.0% (0us) | Total: 0.1% (5.6ms) | Samples: 0

**Called by:**
- `anonymous` (12)

**Calls:**
- `bound require` (12)

### `async elysiaApp`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:33` | Self: 0.0% (0us) | Total: 0.0% (625us) | Samples: 0

**Called by:**
- `async elysiaApp` (3)

**Calls:**
- `importModule` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/sets/index.js:18` | Self: 0.0% (0us) | Total: 0.1% (5.4ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (2)
- `(anonymous)` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/index.mjs:73` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Calls:**
- `lazyNamespace` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (221us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `composeRouteHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:235` | Self: 0.0% (0us) | Total: 0.0% (288us) | Samples: 0

**Called by:**
- `#assertRouteModelRefs` (1)

**Calls:**
- `chainResolver` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:24` | Self: 0.0% (0us) | Total: 0.0% (642us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1550` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `#buildRouter` (2)

**Calls:**
- `#hookHasTypeBox` (2)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs:78` | Self: 0.0% (0us) | Total: 0.0% (407us) | Samples: 0

**Calls:**
- `mapBack` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/template-literal.js:5` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js:22` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `__export` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/ref/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (974us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (3)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/iterator/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (440us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js:6` | Self: 0.0% (0us) | Total: 0.1% (5.6ms) | Samples: 0

**Called by:**
- `anonymous` (12)

**Calls:**
- `bound require` (12)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/cookie/crypto.mjs:22` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `CryptoHasher` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/readonly-from-mapped-result.js:6` | Self: 0.0% (0us) | Total: 0.0% (539us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:6` | Self: 0.0% (0us) | Total: 0.2% (9.3ms) | Samples: 0

**Called by:**
- `anonymous` (29)

**Calls:**
- `bound require` (29)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:12` | Self: 0.0% (0us) | Total: 0.0% (204us) | Samples: 0

**Calls:**
- `Number` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/index.js:20` | Self: 0.0% (0us) | Total: 0.0% (431us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/promise/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (550us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async elysiaApp`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:34` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Calls:**
- `Elysia` (1)

### `Memoirist`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:112` | Self: 0.0% (0us) | Total: 0.0% (278us) | Samples: 0

**Called by:**
- `#buildRouterUnsafe` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:20` | Self: 0.0% (0us) | Total: 0.0% (624us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed-property-keys.js:5` | Self: 0.0% (0us) | Total: 0.2% (11.3ms) | Samples: 0

**Called by:**
- `anonymous` (46)

**Calls:**
- `bound require` (46)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/bigint/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (440us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/pattern.js:6` | Self: 0.0% (0us) | Total: 0.0% (907us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/ref/index.js:9` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `defineProperty` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js:19` | Self: 0.0% (0us) | Total: 0.1% (6.7ms) | Samples: 0

**Called by:**
- `anonymous` (17)

**Calls:**
- `bound require` (17)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/pattern.js:8` | Self: 0.0% (0us) | Total: 0.0% (222us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (193us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:10` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/kind.js:86` | Self: 0.0% (0us) | Total: 0.0% (470us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `#buildRouter`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1455` | Self: 0.0% (0us) | Total: 0.6% (27.7ms) | Samples: 0

**Called by:**
- `#dispatch` (36)

**Calls:**
- `#buildRouterUnsafe` (10)
- `#buildRouterUnsafe` (8)
- `#buildRouterUnsafe` (7)
- `#buildRouterUnsafe` (2)
- `#buildRouterUnsafe` (2)
- `#buildRouterUnsafe` (1)
- `#buildRouterUnsafe` (1)
- `#buildRouterUnsafe` (1)
- `#buildRouterUnsafe` (1)
- `#buildRouterUnsafe` (1)
- `#buildRouterUnsafe` (1)
- `#buildRouterUnsafe` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (432us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js:195` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/hash/hash.js:43` | Self: 0.0% (0us) | Total: 0.0% (242us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `Uint8Array` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:10` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `splitPath`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:85` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `add` (1)

**Calls:**
- `indexOf` (1)

### `async elysiaApp`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:35` | Self: 0.0% (0us) | Total: 0.0% (428us) | Samples: 0

**Calls:**
- `#add` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:9` | Self: 0.0% (0us) | Total: 0.0% (882us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `__export`
`/home/user/bun-node/benchmarks/node_modules/exact-mirror/dist/cjs/index.js:8` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `defineProperty` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:13` | Self: 0.0% (0us) | Total: 0.8% (36.5ms) | Samples: 0

**Called by:**
- `anonymous` (107)

**Calls:**
- `bound require` (107)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (203us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (6)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/type.js:6` | Self: 0.0% (0us) | Total: 0.0% (3.5ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/type.js:33` | Self: 0.0% (0us) | Total: 0.0% (183us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/string/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (409us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `(anonymous)` (1)
- `bound require` (1)

### `flattenChain`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:178` | Self: 0.0% (0us) | Total: 0.0% (316us) | Samples: 0

**Called by:**
- `flattenChainMemoReadonly` (1)

**Calls:**
- `resolveChainNode` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (221us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (223us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/parse.js:7` | Self: 0.0% (0us) | Total: 0.0% (241us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:17` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1625` | Self: 0.0% (0us) | Total: 0.1% (6.9ms) | Samples: 0

**Called by:**
- `#buildRouter` (7)

**Calls:**
- `add` (1)
- `add` (1)
- `add` (1)
- `add` (1)
- `add` (1)
- `add` (1)
- `add` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (426us) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)
- `hasOwnProperty` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/ref/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:22` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/finite.js:7` | Self: 0.0% (0us) | Total: 0.0% (673us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:13` | Self: 0.0% (0us) | Total: 0.1% (6.1ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unknown/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (214us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (387us) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `hasOwnProperty` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js:42` | Self: 0.0% (0us) | Total: 0.0% (192us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unsafe/unsafe.js:5` | Self: 0.0% (0us) | Total: 0.1% (4.4ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (431us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/check.js:10` | Self: 0.0% (0us) | Total: 0.0% (191us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `#jitDispatch`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1320` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `findRoute` (4)

**Calls:**
- `compileHandler` (2)
- `compileHandler` (1)
- `compileHandler` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends.js:9` | Self: 0.0% (0us) | Total: 0.0% (469us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:7` | Self: 0.0% (0us) | Total: 0.0% (867us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs:77` | Self: 0.0% (0us) | Total: 1.2% (50.4ms) | Samples: 0

**Calls:**
- `map` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/object/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (541us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `(anonymous)` (1)
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:19` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/optional.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:13` | Self: 0.0% (0us) | Total: 0.0% (2.2ms) | Samples: 0

**Called by:**
- `anonymous` (10)

**Calls:**
- `bound require` (10)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (437us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/hash/hash.js:40` | Self: 0.0% (0us) | Total: 0.1% (5.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `map` (1)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1617` | Self: 0.0% (0us) | Total: 0.0% (287us) | Samples: 0

**Called by:**
- `#buildRouter` (1)

**Calls:**
- `handler` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/create/type.js:7` | Self: 0.0% (0us) | Total: 0.0% (888us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/check.js:11` | Self: 0.0% (0us) | Total: 0.1% (7.4ms) | Samples: 0

**Called by:**
- `anonymous` (35)

**Calls:**
- `bound require` (35)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-from-mapped-key.js:7` | Self: 0.0% (0us) | Total: 0.0% (904us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (257us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js:5` | Self: 0.0% (0us) | Total: 0.0% (3.0ms) | Samples: 0

**Called by:**
- `anonymous` (14)

**Calls:**
- `bound require` (14)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (221us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/hash/index.js:18` | Self: 0.0% (0us) | Total: 0.1% (6.1ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/index.js:19` | Self: 0.0% (0us) | Total: 1.9% (81.2ms) | Samples: 0

**Called by:**
- `anonymous` (243)

**Calls:**
- `bound require` (243)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:17` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Calls:**
- `freeze` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/computed.js:5` | Self: 0.0% (0us) | Total: 0.0% (646us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unknown/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (633us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (2)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:14` | Self: 0.0% (0us) | Total: 0.2% (9.4ms) | Samples: 0

**Called by:**
- `anonymous` (42)

**Calls:**
- `bound require` (42)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js:8` | Self: 0.0% (0us) | Total: 0.0% (922us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `#dispatch`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1646` | Self: 0.0% (0us) | Total: 0.6% (27.7ms) | Samples: 0

**Called by:**
- `async makeTarget` (36)

**Calls:**
- `#buildRouter` (36)

### `resolveChainNode`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:159` | Self: 0.0% (0us) | Total: 0.0% (316us) | Samples: 0

**Called by:**
- `flattenChain` (1)

**Calls:**
- `hasMacroKey` (1)

### `composeRouteHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:241` | Self: 0.0% (0us) | Total: 0.0% (615us) | Samples: 0

**Called by:**
- `#assertRouteModelRefs` (2)

**Calls:**
- `flattenChainMemo` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js:18` | Self: 0.0% (0us) | Total: 0.2% (8.7ms) | Samples: 0

**Called by:**
- `anonymous` (39)

**Calls:**
- `bound require` (38)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (10)

**Calls:**
- `bound require` (10)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:20` | Self: 0.0% (0us) | Total: 1.1% (47.8ms) | Samples: 0

**Called by:**
- `anonymous` (134)

**Calls:**
- `bound require` (133)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js:20` | Self: 0.0% (0us) | Total: 0.1% (6.5ms) | Samples: 0

**Called by:**
- `anonymous` (24)

**Calls:**
- `bound require` (24)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/literal/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (475us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/index.js:33` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/validator-cache.mjs:146` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-undefined.js:5` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/union/union-evaluated.js:10` | Self: 0.0% (0us) | Total: 0.0% (481us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/index.js:18` | Self: 0.0% (0us) | Total: 0.1% (5.4ms) | Samples: 0

**Called by:**
- `anonymous` (26)

**Calls:**
- `bound require` (26)

### `async elysiaApp`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:37` | Self: 0.0% (0us) | Total: 0.0% (457us) | Samples: 0

**Calls:**
- `guard` (1)
- `group` (1)

### `flattenChainMemo`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs:256` | Self: 0.0% (0us) | Total: 0.0% (615us) | Samples: 0

**Called by:**
- `composeRouteHook` (2)

**Calls:**
- `flattenChainMemoReadonly` (1)
- `flattenChainMemoReadonly` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:16` | Self: 0.0% (0us) | Total: 0.0% (464us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (655us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (2)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof-from-mapped-result.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed.js:11` | Self: 0.0% (0us) | Total: 0.2% (9.1ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:24` | Self: 0.0% (0us) | Total: 0.1% (5.6ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `mapBack`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/constants.mjs:2` | Self: 0.0% (0us) | Total: 0.0% (407us) | Samples: 0

**Called by:**
- `(module)` (2)

**Calls:**
- `map` (1)
- `entries` (1)

### `async elysiaApp`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:49` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Calls:**
- `#add` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:9` | Self: 0.0% (0us) | Total: 0.0% (613us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/policy.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/indexed-from-mapped-key.js:5` | Self: 0.0% (0us) | Total: 0.7% (32.0ms) | Samples: 0

**Called by:**
- `anonymous` (102)

**Calls:**
- `bound require` (102)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/never/index.js:18` | Self: 0.0% (0us) | Total: 0.2% (8.7ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (3)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (3)
- `(anonymous)` (2)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/cookie/crypto.mjs:24` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/clone/value.js:33` | Self: 0.0% (0us) | Total: 0.0% (455us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (4)
- `(anonymous)` (1)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1623` | Self: 0.0% (0us) | Total: 0.0% (278us) | Samples: 0

**Called by:**
- `#buildRouter` (1)

**Calls:**
- `Memoirist` (1)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:187` | Self: 0.0% (0us) | Total: 0.0% (319us) | Samples: 0

**Called by:**
- `#buildRouterUnsafe` (1)

**Calls:**
- `createNode` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:20` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (4)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (3)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/index.js:39` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/optional/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Called by:**
- `anonymous` (10)

**Calls:**
- `bound require` (10)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/index.js:22` | Self: 0.0% (0us) | Total: 0.1% (5.2ms) | Samples: 0

**Called by:**
- `anonymous` (23)

**Calls:**
- `bound require` (23)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js:90` | Self: 0.0% (0us) | Total: 0.0% (821us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `(anonymous)` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (460us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/tuple/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (580us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (1)
- `(anonymous)` (1)

### `(module)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/index.mjs:37` | Self: 0.0% (0us) | Total: 0.0% (820us) | Samples: 0

**Calls:**
- `setupTypebox` (1)
- `setupTypebox` (1)

### `add`
`/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs:153` | Self: 0.0% (0us) | Total: 0.0% (283us) | Samples: 0

**Called by:**
- `#buildRouterUnsafe` (1)

**Calls:**
- `createNode` (1)

### `#buildRouterUnsafe`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs:1620` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `#buildRouter` (2)

**Calls:**
- `expandPaths` (1)
- `expandPaths` (1)

### `composeRouteHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:261` | Self: 0.0% (0us) | Total: 0.0% (331us) | Samples: 0

**Called by:**
- `#assertRouteModelRefs` (1)

**Calls:**
- `applyHook` (1)

### `compileHandler`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:418` | Self: 0.0% (0us) | Total: 0.0% (283us) | Samples: 0

**Called by:**
- `#jitDispatch` (1)

**Calls:**
- `getHandler` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/index.js:18` | Self: 0.0% (0us) | Total: 0.1% (4.4ms) | Samples: 0

**Called by:**
- `anonymous` (18)

**Calls:**
- `bound require` (18)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/syntax.js:8` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/mapped.js:15` | Self: 0.0% (0us) | Total: 0.0% (887us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (661us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/patterns/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (482us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js:23` | Self: 0.0% (0us) | Total: 0.0% (227us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:54` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `(module)` (6)

**Calls:**
- `async makeTarget` (4)
- `async makeTarget` (2)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/iterator/iterator.js:6` | Self: 0.0% (0us) | Total: 0.0% (222us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/keyof.js:10` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js:18` | Self: 0.0% (0us) | Total: 0.7% (32.9ms) | Samples: 0

**Called by:**
- `anonymous` (106)

**Calls:**
- `bound require` (105)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs:161` | Self: 0.0% (0us) | Total: 2.3% (100.2ms) | Samples: 0

**Called by:**
- `findRoute` (372)

**Calls:**
- `mapCompactResponse` (372)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/intersect/intersect-evaluated.js:9` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Called by:**
- `anonymous` (13)

**Calls:**
- `bound require` (13)

### `composeRouteHook`
`/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs:245` | Self: 0.0% (0us) | Total: 0.0% (283us) | Samples: 0

**Called by:**
- `#assertRouteModelRefs` (1)

**Calls:**
- `collectHookOrigins` (1)

### `(anonymous)`
`/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/symbols/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (421us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `(anonymous)` (1)
- `bound require` (1)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 69.8% | 2.91s | `[native code]` |
| 23.5% | 984.5ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/handler/fetch.mjs` |
| 2.5% | 104.8ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/context.mjs` |
| 1.2% | 51.8ms | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.8% | 36.1ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/adapter/web-standard/handler.mjs` |
| 0.4% | 20.6ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs` |
| 0.2% | 11.1ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/base.mjs` |
| 0.2% | 10.8ms | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts` |
| 0.1% | 7.7ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/route-table.mjs` |
| 0.1% | 6.0ms | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts` |
| 0.1% | 5.8ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/node_modules/memoirist/dist/index.mjs` |
| 0.1% | 4.7ms | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/sets/index.js` |
| 0.0% | 2.8ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/handler/index.mjs` |
| 0.0% | 1.1ms | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/error.mjs` |
| 0.0% | 901us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/utils.mjs` |
| 0.0% | 821us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/errors.js` |
| 0.0% | 820us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/compat.mjs` |
| 0.0% | 685us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/kind.js` |
| 0.0% | 531us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/keyof/index.js` |
| 0.0% | 464us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/compiler/compiler.js` |
| 0.0% | 455us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/clone/value.js` |
| 0.0% | 454us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/errors/index.js` |
| 0.0% | 411us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/exact-mirror-require.mjs` |
| 0.0% | 309us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/object/index.js` |
| 0.0% | 283us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/compile/aot.mjs` |
| 0.0% | 248us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/decode.js` |
| 0.0% | 240us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/promise/promise.js` |
| 0.0% | 229us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/boolean/index.js` |
| 0.0% | 229us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/number/index.js` |
| 0.0% | 229us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/index.js` |
| 0.0% | 227us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/extends/extends-check.js` |
| 0.0% | 223us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/readonly/index.js` |
| 0.0% | 221us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/validator/index.mjs` |
| 0.0% | 221us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/any/index.js` |
| 0.0% | 218us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/computed/index.js` |
| 0.0% | 216us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/template-literal/index.js` |
| 0.0% | 216us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/mapped/index.js` |
| 0.0% | 216us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/transform/has.js` |
| 0.0% | 215us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/error/error.js` |
| 0.0% | 215us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/tuple/index.js` |
| 0.0% | 214us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/unknown/index.js` |
| 0.0% | 210us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/index.mjs` |
| 0.0% | 203us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/string/index.js` |
| 0.0% | 202us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/index.js` |
| 0.0% | 196us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/guard/index.js` |
| 0.0% | 196us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/policy.js` |
| 0.0% | 195us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/symbols/index.js` |
| 0.0% | 195us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/value/check/index.js` |
| 0.0% | 195us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/typebox-type.mjs` |
| 0.0% | 195us | `/home/user/bun-node/benchmarks/node_modules/elysia2/dist/type/validator/validator-cache.mjs` |
| 0.0% | 194us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/never/index.js` |
| 0.0% | 193us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/indexed/index.js` |
| 0.0% | 192us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/system/system.js` |
| 0.0% | 183us | `/home/user/bun-node/benchmarks/node_modules/@sinclair/typebox/build/cjs/type/guard/type.js` |
