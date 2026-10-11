# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 4.29s | 12279 | 100us | 545 |

**Top 10:** `Response` 13.2%, `Request` 6.0%, `get` 4.7%, `param-random` 4.6%, `splitPattern` 4.4%, `decodeURIComponent` 2.8%, `candidates` 2.7%, `getMatchedLayers` 2.7%, `get` 2.6%, `BunRequest` 2.4%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 13.2% | 567.8ms | 13.2% | 567.8ms | `Response` | `[native code]` |
| 6.0% | 261.5ms | 6.0% | 261.5ms | `Request` | `[native code]` |
| 4.7% | 202.6ms | 4.7% | 202.6ms | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:281` |
| 4.6% | 199.7ms | 10.7% | 461.2ms | `param-random` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:130` |
| 4.4% | 191.4ms | 4.4% | 191.4ms | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:58` |
| 2.8% | 121.3ms | 2.8% | 121.3ms | `decodeURIComponent` | `[native code]` |
| 2.7% | 118.7ms | 2.7% | 118.7ms | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:223` |
| 2.7% | 116.0ms | 9.5% | 411.2ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4805` |
| 2.6% | 113.4ms | 2.6% | 113.4ms | `get` | `[native code]` |
| 2.4% | 103.9ms | 2.4% | 106.8ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` |
| 2.3% | 102.3ms | 5.9% | 253.3ms | `anonymous` | `[native code]` |
| 2.3% | 101.8ms | 2.6% | 113.4ms | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4634` |
| 2.3% | 101.1ms | 2.3% | 101.9ms | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:298` |
| 2.2% | 98.5ms | 2.2% | 98.5ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1231` |
| 2.0% | 88.3ms | 2.0% | 88.3ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 1.5% | 66.4ms | 1.5% | 66.4ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5130` |
| 1.5% | 65.7ms | 1.5% | 65.7ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 1.4% | 62.2ms | 1.4% | 62.2ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3506` |
| 1.3% | 57.0ms | 1.3% | 57.0ms | `method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 1.3% | 56.8ms | 1.3% | 57.0ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4777` |
| 1.2% | 54.6ms | 1.2% | 54.6ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3541` |
| 1.2% | 52.8ms | 1.2% | 52.8ms | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:177` |
| 1.2% | 52.5ms | 1.2% | 54.0ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1213` |
| 1.2% | 51.6ms | 1.2% | 54.6ms | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:302` |
| 1.1% | 51.4ms | 9.4% | 406.3ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4793` |
| 1.1% | 49.6ms | 1.1% | 49.6ms | `cloneObject` | `[native code]` |
| 1.1% | 49.4ms | 1.1% | 49.4ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4470` |
| 1.0% | 44.1ms | 1.0% | 44.1ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4876` |
| 0.9% | 41.5ms | 0.9% | 41.5ms | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4672` |
| 0.9% | 41.4ms | 3.9% | 167.9ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:437` |
| 0.9% | 40.5ms | 0.9% | 40.5ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3540` |
| 0.8% | 38.0ms | 0.8% | 38.0ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3520` |
| 0.8% | 35.6ms | 1.3% | 59.4ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` |
| 0.6% | 29.5ms | 17.8% | 765.8ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5102` |
| 0.6% | 27.9ms | 5.6% | 244.5ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1267` |
| 0.6% | 25.9ms | 0.6% | 25.9ms | `alloc` | `[native code]` |
| 0.5% | 24.3ms | 0.6% | 28.1ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1261` |
| 0.5% | 22.8ms | 0.5% | 22.8ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:136` |
| 0.5% | 22.7ms | 20.8% | 896.5ms | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1432` |
| 0.5% | 22.6ms | 0.5% | 22.6ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:514` |
| 0.5% | 21.7ms | 0.5% | 21.7ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5072` |
| 0.4% | 18.8ms | 1.3% | 59.4ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3040` |
| 0.4% | 18.1ms | 2.5% | 109.1ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1306` |
| 0.4% | 17.7ms | 0.4% | 17.7ms | `indexOf` | `[native code]` |
| 0.4% | 17.2ms | 0.4% | 17.2ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3507` |
| 0.3% | 16.0ms | 0.3% | 16.0ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3045` |
| 0.3% | 15.8ms | 0.3% | 15.8ms | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.3% | 15.8ms | 0.3% | 15.8ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:21` |
| 0.3% | 15.7ms | 0.3% | 16.0ms | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:290` |
| 0.3% | 15.7ms | 0.3% | 15.7ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2997` |
| 0.3% | 14.8ms | 0.3% | 15.1ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1203` |
| 0.3% | 14.1ms | 0.3% | 14.1ms | `importModule` | `[native code]` |
| 0.3% | 13.7ms | 3.8% | 165.1ms | `require` | `[native code]` |
| 0.3% | 13.3ms | 0.3% | 13.3ms | `lazyInspectModule` | `node:util` |
| 0.3% | 13.2ms | 0.9% | 39.2ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1340` |
| 0.3% | 13.2ms | 0.3% | 13.2ms | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:226` |
| 0.2% | 12.7ms | 60.4% | 2.59s | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:404` |
| 0.2% | 12.3ms | 0.2% | 12.3ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5135` |
| 0.2% | 12.3ms | 0.2% | 12.4ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4471` |
| 0.2% | 11.9ms | 0.2% | 11.9ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1335` |
| 0.2% | 11.8ms | 0.2% | 12.0ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4839` |
| 0.2% | 11.7ms | 0.2% | 11.7ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.2% | 11.1ms | 0.2% | 11.1ms | `/^\/r999\/([^\/]+?)\/?$/` | `[native code]` |
| 0.2% | 10.7ms | 0.2% | 10.7ms | `node:stream/web` | `node:stream/web:8` |
| 0.2% | 10.5ms | 0.2% | 10.5ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3533` |
| 0.2% | 10.3ms | 0.2% | 10.3ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:440` |
| 0.2% | 10.2ms | 0.2% | 10.2ms | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.2% | 9.2ms | 54.2% | 2.32s | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:455` |
| 0.2% | 8.7ms | 0.2% | 8.7ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3521` |
| 0.2% | 8.6ms | 21.1% | 906.1ms | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:402` |
| 0.2% | 8.6ms | 0.2% | 8.6ms | `@lazy` | `[native code]` |
| 0.1% | 8.5ms | 1.4% | 61.5ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1331` |
| 0.1% | 8.1ms | 0.1% | 8.1ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3042` |
| 0.1% | 7.8ms | 33.3% | 1.43s | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4984` |
| 0.1% | 7.7ms | 0.1% | 7.7ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.1% | 7.6ms | 0.1% | 7.6ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4834` |
| 0.1% | 7.0ms | 0.1% | 7.0ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4914` |
| 0.1% | 6.5ms | 0.1% | 6.5ms | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4635` |
| 0.1% | 6.4ms | 0.1% | 6.4ms | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.1% | 6.1ms | 0.1% | 6.1ms | `isFunction` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.1% | 6.0ms | 0.1% | 6.0ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4988` |
| 0.1% | 6.0ms | 0.1% | 6.0ms | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.1% | 5.6ms | 0.1% | 5.6ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3530` |
| 0.1% | 5.4ms | 0.1% | 5.4ms | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:289` |
| 0.1% | 5.0ms | 0.1% | 5.0ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1336` |
| 0.1% | 4.9ms | 0.1% | 4.9ms | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:299` |
| 0.1% | 4.6ms | 1.2% | 54.3ms | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1356` |
| 0.1% | 4.4ms | 0.1% | 4.4ms | `keys` | `[native code]` |
| 0.0% | 4.2ms | 1.5% | 66.0ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4774` |
| 0.0% | 4.2ms | 0.0% | 4.2ms | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:231` |
| 0.0% | 4.2ms | 0.0% | 4.2ms | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/lib/language.js:16` |
| 0.0% | 4.0ms | 0.0% | 4.0ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3029` |
| 0.0% | 3.9ms | 0.0% | 3.9ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:19` |
| 0.0% | 3.9ms | 0.0% | 3.9ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:2` |
| 0.0% | 3.8ms | 0.0% | 3.8ms | `Map` | `[native code]` |
| 0.0% | 3.4ms | 0.0% | 3.4ms | `set` | `[native code]` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5265` |
| 0.0% | 3.2ms | 92.6% | 3.97s | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:20` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:55` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:42` |
| 0.0% | 3.1ms | 0.0% | 3.1ms | `defineProperty` | `[native code]` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:85` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `Set` | `[native code]` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4883` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 2.5ms | 13.3% | 572.8ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1214` |
| 0.0% | 2.5ms | 0.0% | 3.9ms | `map` | `[native code]` |
| 0.0% | 2.5ms | 0.0% | 2.5ms | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1003` |
| 0.0% | 2.4ms | 0.0% | 2.4ms | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:17` |
| 0.0% | 2.3ms | 0.0% | 2.6ms | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:970` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `Uint32Array` | `[native code]` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5006` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3044` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `(anonymous)` | `internal:freelist` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:20` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `(unknown)` | `[native code]` |
| 0.0% | 1.9ms | 1.0% | 47.0ms | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:177` |
| 0.0% | 1.8ms | 2.8% | 123.2ms | `decodeParam` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:117` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:185` |
| 0.0% | 1.7ms | 0.0% | 2.1ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2991` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 1.6ms | 0.0% | 1.8ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1299` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1062` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `RegExp` | `[native code]` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1075` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `addRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1249` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5009` |
| 0.0% | 1.4ms | 0.0% | 1.9ms | `get headersSent` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:296` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:38` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `setPrototypeDirectOrThrow` | `[native code]` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `#respond` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:487` |
| 0.0% | 1.2ms | 0.4% | 21.0ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1332` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2501` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `parse` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `defineProperties` | `[native code]` |
| 0.0% | 977us | 0.0% | 977us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:18` |
| 0.0% | 969us | 0.4% | 19.2ms | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:237` |
| 0.0% | 850us | 0.0% | 850us | `uncurryThis` | `internal:primordials` |
| 0.0% | 823us | 0.0% | 823us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 822us | 0.0% | 822us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:129` |
| 0.0% | 790us | 0.0% | 790us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:951` |
| 0.0% | 785us | 0.0% | 785us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4924` |
| 0.0% | 783us | 0.0% | 783us | `WeakSet` | `[native code]` |
| 0.0% | 783us | 0.0% | 783us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:555` |
| 0.0% | 783us | 0.0% | 783us | `delete` | `[native code]` |
| 0.0% | 771us | 4.3% | 185.6ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4930` |
| 0.0% | 765us | 0.0% | 765us | `assign` | `[native code]` |
| 0.0% | 763us | 0.0% | 763us | `populateMaps` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` |
| 0.0% | 761us | 0.0% | 761us | `get requestOpts` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 745us | 0.0% | 745us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:681` |
| 0.0% | 702us | 0.0% | 702us | `node:zlib` | `node:zlib:12` |
| 0.0% | 693us | 0.0% | 693us | `exec` | `[native code]` |
| 0.0% | 686us | 0.0% | 1.9ms | `(anonymous)` | `[native code]` |
| 0.0% | 683us | 0.0% | 683us | `_freeze` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:71` |
| 0.0% | 660us | 0.0% | 660us | `get size` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:276` |
| 0.0% | 642us | 1.2% | 54.9ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1256` |
| 0.0% | 631us | 0.0% | 631us | `add` | `[native code]` |
| 0.0% | 625us | 0.5% | 23.2ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:446` |
| 0.0% | 621us | 0.0% | 621us | `node:crypto` | `node:crypto:109` |
| 0.0% | 612us | 0.0% | 612us | `originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3699` |
| 0.0% | 598us | 0.0% | 598us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:115` |
| 0.0% | 588us | 0.0% | 588us | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 574us | 0.0% | 574us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/compression.ts:245` |
| 0.0% | 573us | 0.0% | 573us | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 569us | 0.0% | 569us | `(anonymous)` | `node:zlib` |
| 0.0% | 544us | 0.0% | 544us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4789` |
| 0.0% | 536us | 0.0% | 536us | `bound` | `node:os` |
| 0.0% | 512us | 0.0% | 512us | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1409` |
| 0.0% | 484us | 0.0% | 484us | `normalizeEtagOption` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 455us | 0.0% | 650us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1019` |
| 0.0% | 453us | 0.0% | 453us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 449us | 0.0% | 449us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/types/standard.js:365` |
| 0.0% | 449us | 0.0% | 449us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 446us | 0.0% | 446us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 444us | 0.0% | 444us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:141` |
| 0.0% | 436us | 0.0% | 436us | `__classPrivateFieldGet` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 435us | 0.0% | 435us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 430us | 0.0% | 430us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4798` |
| 0.0% | 426us | 0.0% | 426us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4857` |
| 0.0% | 425us | 0.1% | 7.2ms | `forEach` | `[native code]` |
| 0.0% | 424us | 0.0% | 424us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:422` |
| 0.0% | 422us | 0.0% | 422us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3502` |
| 0.0% | 422us | 4.0% | 172.6ms | `bound require` | `[native code]` |
| 0.0% | 421us | 0.0% | 421us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:164` |
| 0.0% | 418us | 0.0% | 418us | `internal:shared` | `internal:shared:33` |
| 0.0% | 416us | 0.0% | 416us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3546` |
| 0.0% | 411us | 0.0% | 411us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2488` |
| 0.0% | 410us | 0.0% | 410us | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 409us | 0.7% | 33.8ms | `#canSkipHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:571` |
| 0.0% | 405us | 15.1% | 649.2ms | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:86` |
| 0.0% | 404us | 0.0% | 404us | `__classPrivateFieldGet` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:4` |
| 0.0% | 402us | 0.0% | 402us | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1343` |
| 0.0% | 400us | 0.0% | 400us | `get upgradeToWsData` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 398us | 0.0% | 398us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5066` |
| 0.0% | 398us | 0.0% | 584us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4790` |
| 0.0% | 397us | 4.4% | 190.9ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` |
| 0.0% | 396us | 0.0% | 396us | `Agent` | `node:_http_agent` |
| 0.0% | 395us | 0.0% | 395us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1699` |
| 0.0% | 394us | 0.0% | 394us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3031` |
| 0.0% | 393us | 0.0% | 393us | `makeSafe` | `internal:primordials:32` |
| 0.0% | 392us | 0.0% | 392us | `normalizeEtagOption` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:393` |
| 0.0% | 392us | 0.0% | 392us | `WriteStream` | `internal:fs/streams` |
| 0.0% | 388us | 0.0% | 388us | `EventEmitter` | `node:events` |
| 0.0% | 383us | 0.0% | 383us | `param-random` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 381us | 0.0% | 381us | `node:zlib` | `node:zlib:541` |
| 0.0% | 381us | 0.0% | 381us | `routes` | `/home/user/bun-node/node_modules/@routejs/router/src/router.mjs` |
| 0.0% | 380us | 0.0% | 380us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:159` |
| 0.0% | 379us | 0.0% | 379us | `getHeader` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 376us | 0.0% | 376us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:119` |
| 0.0% | 376us | 0.0% | 376us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:202` |
| 0.0% | 372us | 0.0% | 372us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 369us | 0.0% | 369us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:30` |
| 0.0% | 367us | 0.0% | 367us | `isBoolean` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:158` |
| 0.0% | 362us | 0.0% | 770us | `from` | `[native code]` |
| 0.0% | 310us | 0.0% | 310us | `split` | `[native code]` |
| 0.0% | 306us | 0.0% | 306us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:215` |
| 0.0% | 283us | 0.0% | 283us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1697` |
| 0.0% | 267us | 0.0% | 267us | `get response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:946` |
| 0.0% | 260us | 0.0% | 260us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 257us | 0.0% | 257us | `Writable` | `internal:streams/writable` |
| 0.0% | 255us | 0.0% | 255us | `setResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3736` |
| 0.0% | 253us | 0.0% | 253us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1120` |
| 0.0% | 250us | 0.0% | 250us | `getOwnPropertyNames` | `[native code]` |
| 0.0% | 247us | 0.0% | 247us | `set params` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 239us | 0.0% | 239us | `decodeParam` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 236us | 0.0% | 236us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3549` |
| 0.0% | 234us | 0.0% | 234us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:834` |
| 0.0% | 232us | 0.0% | 232us | `normalizeCatchAllPath` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 232us | 0.0% | 418us | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:700` |
| 0.0% | 231us | 0.0% | 231us | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 231us | 0.0% | 231us | `_addListener` | `node:events` |
| 0.0% | 229us | 0.0% | 229us | `(anonymous)` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/linkedlist/index.mjs:5` |
| 0.0% | 226us | 0.0% | 226us | `extractWildcardNames` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 226us | 0.0% | 226us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/types/multipart.js:221` |
| 0.0% | 225us | 0.0% | 225us | `internal:validators` | `internal:validators:69` |
| 0.0% | 223us | 0.0% | 223us | `supportsColor` | `/home/user/bun-node/node_modules/supports-color/index.js` |
| 0.0% | 222us | 0.0% | 222us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:47` |
| 0.0% | 222us | 0.0% | 1.5ms | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:19` |
| 0.0% | 222us | 0.0% | 222us | `internal:streams/readable` | `internal:streams/readable:737` |
| 0.0% | 221us | 0.0% | 221us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 220us | 0.0% | 220us | `use` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 220us | 0.0% | 220us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/types/other.js:718` |
| 0.0% | 219us | 2.8% | 123.6ms | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4679` |
| 0.0% | 219us | 0.0% | 219us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/types/multipart.js:27` |
| 0.0% | 219us | 0.0% | 219us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3046` |
| 0.0% | 218us | 0.0% | 218us | `copyObject` | `internal:fs/streams:33` |
| 0.0% | 218us | 0.0% | 218us | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4703` |
| 0.0% | 218us | 0.0% | 218us | `copyProps` | `internal:primordials` |
| 0.0% | 218us | 0.0% | 218us | `internal:streams/destroy` | `internal:streams/destroy:16` |
| 0.0% | 217us | 0.0% | 217us | `_freeze` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 216us | 0.0% | 216us | `defineColorAlias` | `internal:util/inspect` |
| 0.0% | 215us | 0.0% | 215us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1039` |
| 0.0% | 215us | 0.0% | 215us | `Channel` | `node:diagnostics_channel` |
| 0.0% | 215us | 0.0% | 215us | `node:_http_agent` | `node:_http_agent:129` |
| 0.0% | 215us | 0.0% | 215us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:25` |
| 0.0% | 214us | 0.0% | 214us | `(anonymous)` | `/home/user/bun-node/node_modules/uint8array-extras/index.js:178` |
| 0.0% | 214us | 0.0% | 214us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:431` |
| 0.0% | 213us | 0.0% | 684us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5129` |
| 0.0% | 212us | 0.0% | 212us | `every` | `[native code]` |
| 0.0% | 212us | 0.0% | 212us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5247` |
| 0.0% | 212us | 0.0% | 1.4ms | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js:158` |
| 0.0% | 212us | 0.0% | 212us | `has` | `[native code]` |
| 0.0% | 211us | 0.0% | 400us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:352` |
| 0.0% | 211us | 0.0% | 211us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3511` |
| 0.0% | 211us | 0.0% | 211us | `get legacyQueryOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1388` |
| 0.0% | 210us | 0.0% | 210us | `SafeSet` | `internal:primordials` |
| 0.0% | 210us | 0.0% | 210us | `Symbol` | `[native code]` |
| 0.0% | 210us | 0.0% | 210us | `get host` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 210us | 0.0% | 210us | `get hasDeferredBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2838` |
| 0.0% | 209us | 0.0% | 209us | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 208us | 0.0% | 208us | `node:fs/promises` | `node:fs/promises:142` |
| 0.0% | 208us | 0.0% | 208us | `test` | `[native code]` |
| 0.0% | 208us | 0.0% | 208us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:476` |
| 0.0% | 208us | 0.0% | 208us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunValidate.ts:141` |
| 0.0% | 208us | 0.0% | 208us | `internal:url` | `internal:url:23` |
| 0.0% | 208us | 0.0% | 208us | `mergeBunRequestOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 208us | 0.0% | 208us | `node:_http_outgoing` | `node:_http_outgoing:65` |
| 0.0% | 207us | 0.0% | 818us | `internal:primordials` | `internal:primordials:76` |
| 0.0% | 207us | 0.0% | 207us | `get method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 0.0% | 206us | 0.0% | 206us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1308` |
| 0.0% | 206us | 0.0% | 206us | `node:_http_outgoing` | `node:_http_outgoing:45` |
| 0.0% | 206us | 0.0% | 206us | `(anonymous)` | `/home/user/bun-node/node_modules/has-flag/index.js` |
| 0.0% | 206us | 0.0% | 206us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3548` |
| 0.0% | 206us | 0.0% | 206us | `Stream` | `internal:streams/legacy` |
| 0.0% | 205us | 0.0% | 205us | `isArray` | `[native code]` |
| 0.0% | 205us | 0.0% | 205us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:28` |
| 0.0% | 205us | 0.1% | 6.3ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4910` |
| 0.0% | 205us | 0.0% | 205us | `(anonymous)` | `internal:http:4` |
| 0.0% | 205us | 0.0% | 205us | `StructuredLogger` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:181` |
| 0.0% | 205us | 0.0% | 205us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1246` |
| 0.0% | 204us | 0.6% | 29.8ms | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:194` |
| 0.0% | 204us | 0.0% | 204us | `setName` | `node:fs:696` |
| 0.0% | 203us | 0.0% | 203us | `node:_http_server` | `node:_http_server:1690` |
| 0.0% | 203us | 0.0% | 203us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 202us | 0.0% | 796us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:23` |
| 0.0% | 202us | 0.0% | 202us | `emitFinish` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:797` |
| 0.0% | 202us | 0.0% | 202us | `resolveLogger` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts` |
| 0.0% | 202us | 0.0% | 202us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5222` |
| 0.0% | 201us | 0.0% | 201us | `node:events` | `node:events:651` |
| 0.0% | 201us | 0.0% | 201us | `#configuredCookieSecrets` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 200us | 0.0% | 200us | `node:zlib` | `node:zlib:478` |
| 0.0% | 199us | 0.0% | 199us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3503` |
| 0.0% | 198us | 0.0% | 198us | `__classPrivateFieldGet` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:3` |
| 0.0% | 198us | 0.0% | 409us | `#configuredQueryOpts` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1368` |
| 0.0% | 197us | 0.0% | 197us | `isBoolean` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 197us | 0.0% | 197us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:169` |
| 0.0% | 196us | 0.0% | 196us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:45` |
| 0.0% | 196us | 0.0% | 196us | `promisify2` | `internal:promisify` |
| 0.0% | 196us | 0.2% | 10.6ms | `internal:streams/transform` | `internal:streams/transform:2` |
| 0.0% | 196us | 0.0% | 196us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 196us | 0.0% | 196us | `matchBaseUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 196us | 0.0% | 196us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 195us | 0.0% | 195us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:87` |
| 0.0% | 195us | 0.0% | 195us | `entries` | `[native code]` |
| 0.0% | 195us | 0.0% | 195us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 194us | 0.0% | 194us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:651` |
| 0.0% | 194us | 0.0% | 194us | `(anonymous)` | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js` |
| 0.0% | 193us | 0.0% | 193us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1254` |
| 0.0% | 193us | 0.0% | 193us | `node:stream/web` | `node:stream/web:13` |
| 0.0% | 193us | 0.0% | 193us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:241` |
| 0.0% | 192us | 0.0% | 1.2ms | `filter` | `[native code]` |
| 0.0% | 191us | 0.0% | 191us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:170` |
| 0.0% | 191us | 0.0% | 191us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:953` |
| 0.0% | 191us | 0.0% | 191us | `call` | `[native code]` |
| 0.0% | 191us | 0.0% | 191us | `flushPending` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 190us | 0.0% | 190us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:176` |
| 0.0% | 190us | 0.0% | 190us | `Router` | `/home/user/bun-node/node_modules/@routejs/router/src/router.mjs` |
| 0.0% | 190us | 0.0% | 190us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2494` |
| 0.0% | 189us | 0.0% | 189us | `slice` | `[native code]` |
| 0.0% | 189us | 0.1% | 7.2ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5134` |
| 0.0% | 189us | 0.0% | 189us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:238` |
| 0.0% | 189us | 0.0% | 189us | `BunWebSocket` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts` |
| 0.0% | 187us | 0.0% | 187us | `get requestOpts` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:733` |
| 0.0% | 187us | 0.0% | 187us | `internal:streams/duplexpair` | `internal:streams/duplexpair:4` |
| 0.0% | 186us | 0.0% | 186us | `setResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 186us | 0.0% | 186us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:593` |
| 0.0% | 185us | 0.0% | 185us | `BunRouter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 185us | 0.0% | 185us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 185us | 3.2% | 140.6ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1271` |
| 0.0% | 185us | 0.0% | 185us | `isObject` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 183us | 0.0% | 183us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:117` |
| 0.0% | 182us | 0.0% | 182us | `setUint32` | `[native code]` |
| 0.0% | 182us | 0.0% | 182us | `WritableState` | `internal:streams/writable` |
| 0.0% | 181us | 0.0% | 181us | `(anonymous)` | `/home/user/bun-node/node_modules/parse-domain/dist/sanitize.js` |
| 0.0% | 181us | 0.0% | 181us | `bound` | `node:os:107` |
| 0.0% | 181us | 0.0% | 181us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 181us | 0.7% | 34.0ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1209` |
| 0.0% | 178us | 0.8% | 37.7ms | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1031` |
| 0.0% | 177us | 0.0% | 177us | `isObject` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:179` |
| 0.0% | 174us | 0.0% | 174us | `init` | `/home/user/bun-node/node_modules/debug/src/node.js` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 92.6% | 3.97s | 0.0% | 3.2ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:20` |
| 60.4% | 2.59s | 0.2% | 12.7ms | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:404` |
| 54.2% | 2.32s | 0.2% | 9.2ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:455` |
| 33.3% | 1.43s | 0.1% | 7.8ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4984` |
| 21.1% | 906.1ms | 0.2% | 8.6ms | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:402` |
| 20.8% | 896.5ms | 0.5% | 22.7ms | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1432` |
| 17.8% | 765.8ms | 0.6% | 29.5ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5102` |
| 15.1% | 649.2ms | 0.0% | 405us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:86` |
| 13.3% | 572.8ms | 0.0% | 2.5ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1214` |
| 13.2% | 567.8ms | 13.2% | 567.8ms | `Response` | `[native code]` |
| 10.7% | 461.2ms | 4.6% | 199.7ms | `param-random` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:130` |
| 9.5% | 411.2ms | 2.7% | 116.0ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4805` |
| 9.4% | 406.3ms | 1.1% | 51.4ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4793` |
| 6.0% | 261.5ms | 6.0% | 261.5ms | `Request` | `[native code]` |
| 5.9% | 253.3ms | 2.3% | 102.3ms | `anonymous` | `[native code]` |
| 5.6% | 244.5ms | 0.6% | 27.9ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1267` |
| 4.7% | 203.0ms | 0.0% | 0us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4782` |
| 4.7% | 202.6ms | 4.7% | 202.6ms | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:281` |
| 4.5% | 195.2ms | 0.0% | 0us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:218` |
| 4.4% | 191.4ms | 4.4% | 191.4ms | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:58` |
| 4.4% | 190.9ms | 0.0% | 397us | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` |
| 4.4% | 189.4ms | 0.0% | 0us | `splitRequestPath` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:66` |
| 4.3% | 185.6ms | 0.0% | 771us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4930` |
| 4.0% | 172.6ms | 0.0% | 422us | `bound require` | `[native code]` |
| 3.9% | 167.9ms | 0.9% | 41.4ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:437` |
| 3.8% | 165.1ms | 0.3% | 13.7ms | `require` | `[native code]` |
| 3.2% | 140.6ms | 0.0% | 185us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1271` |
| 2.8% | 123.6ms | 0.0% | 219us | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4679` |
| 2.8% | 123.2ms | 0.0% | 1.8ms | `decodeParam` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:117` |
| 2.8% | 121.3ms | 2.8% | 121.3ms | `decodeURIComponent` | `[native code]` |
| 2.7% | 118.7ms | 2.7% | 118.7ms | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:223` |
| 2.6% | 113.4ms | 2.6% | 113.4ms | `get` | `[native code]` |
| 2.6% | 113.4ms | 2.3% | 101.8ms | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4634` |
| 2.5% | 109.1ms | 0.4% | 18.1ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1306` |
| 2.4% | 106.8ms | 2.4% | 103.9ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` |
| 2.3% | 101.9ms | 2.3% | 101.1ms | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:298` |
| 2.2% | 98.5ms | 2.2% | 98.5ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1231` |
| 2.0% | 88.3ms | 2.0% | 88.3ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 1.5% | 66.4ms | 1.5% | 66.4ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5130` |
| 1.5% | 66.0ms | 0.0% | 4.2ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4774` |
| 1.5% | 65.7ms | 1.5% | 65.7ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 1.4% | 62.2ms | 1.4% | 62.2ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3506` |
| 1.4% | 61.5ms | 0.1% | 8.5ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1331` |
| 1.3% | 59.4ms | 0.4% | 18.8ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3040` |
| 1.3% | 59.4ms | 0.8% | 35.6ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` |
| 1.3% | 57.0ms | 1.3% | 57.0ms | `method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 1.3% | 57.0ms | 1.3% | 56.8ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4777` |
| 1.2% | 54.9ms | 0.0% | 642us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1256` |
| 1.2% | 54.6ms | 1.2% | 51.6ms | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:302` |
| 1.2% | 54.6ms | 1.2% | 54.6ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3541` |
| 1.2% | 54.3ms | 0.1% | 4.6ms | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1356` |
| 1.2% | 54.0ms | 1.2% | 52.5ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1213` |
| 1.2% | 52.8ms | 1.2% | 52.8ms | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:177` |
| 1.2% | 52.0ms | 0.0% | 0us | `bound serveNativeRequest` | `[native code]` |
| 1.1% | 49.6ms | 1.1% | 49.6ms | `cloneObject` | `[native code]` |
| 1.1% | 49.4ms | 1.1% | 49.4ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4470` |
| 1.1% | 48.3ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:84` |
| 1.0% | 47.0ms | 0.0% | 1.9ms | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:177` |
| 1.0% | 44.1ms | 1.0% | 44.1ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4876` |
| 0.9% | 41.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/accepts/index.js:15` |
| 0.9% | 41.5ms | 0.9% | 41.5ms | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4672` |
| 0.9% | 40.5ms | 0.9% | 40.5ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3540` |
| 0.9% | 39.2ms | 0.3% | 13.2ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1340` |
| 0.8% | 38.0ms | 0.8% | 38.0ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3520` |
| 0.8% | 37.7ms | 0.0% | 178us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1031` |
| 0.7% | 34.0ms | 0.0% | 181us | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1209` |
| 0.7% | 33.8ms | 0.0% | 409us | `#canSkipHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:571` |
| 0.7% | 31.0ms | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:57` |
| 0.6% | 29.8ms | 0.0% | 204us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:194` |
| 0.6% | 28.1ms | 0.5% | 24.3ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1261` |
| 0.6% | 26.9ms | 0.0% | 0us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:442` |
| 0.6% | 26.7ms | 0.0% | 0us | `host` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3577` |
| 0.6% | 25.9ms | 0.6% | 25.9ms | `alloc` | `[native code]` |
| 0.5% | 23.8ms | 0.0% | 0us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:443` |
| 0.5% | 23.2ms | 0.0% | 625us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:446` |
| 0.5% | 22.8ms | 0.5% | 22.8ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:136` |
| 0.5% | 22.6ms | 0.5% | 22.6ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:514` |
| 0.5% | 22.0ms | 0.0% | 0us | `originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` |
| 0.5% | 21.7ms | 0.5% | 21.7ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5072` |
| 0.4% | 21.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/index.js:9` |
| 0.4% | 21.0ms | 0.0% | 1.2ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1332` |
| 0.4% | 20.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/accepts/index.js:16` |
| 0.4% | 19.2ms | 0.0% | 969us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:237` |
| 0.4% | 18.5ms | 0.0% | 0us | `node:crypto` | `node:crypto:2` |
| 0.4% | 17.7ms | 0.4% | 17.7ms | `indexOf` | `[native code]` |
| 0.4% | 17.4ms | 0.0% | 0us | `get inspect` | `node:util:481` |
| 0.4% | 17.2ms | 0.4% | 17.2ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3507` |
| 0.3% | 16.5ms | 0.0% | 0us | `node:http` | `node:http:2` |
| 0.3% | 16.0ms | 0.3% | 16.0ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3045` |
| 0.3% | 16.0ms | 0.3% | 15.7ms | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:290` |
| 0.3% | 15.8ms | 0.3% | 15.8ms | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.3% | 15.8ms | 0.3% | 15.8ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:21` |
| 0.3% | 15.7ms | 0.3% | 15.7ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2997` |
| 0.3% | 15.1ms | 0.3% | 14.8ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1203` |
| 0.3% | 14.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/index.js:3` |
| 0.3% | 14.1ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:79` |
| 0.3% | 14.1ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:54` |
| 0.3% | 14.1ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:13` |
| 0.3% | 14.1ms | 0.3% | 14.1ms | `importModule` | `[native code]` |
| 0.3% | 14.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:16` |
| 0.3% | 13.3ms | 0.3% | 13.3ms | `lazyInspectModule` | `node:util` |
| 0.3% | 13.2ms | 0.3% | 13.2ms | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:226` |
| 0.2% | 12.4ms | 0.2% | 12.3ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4471` |
| 0.2% | 12.3ms | 0.2% | 12.3ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5135` |
| 0.2% | 12.0ms | 0.2% | 11.8ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4839` |
| 0.2% | 11.9ms | 0.2% | 11.9ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1335` |
| 0.2% | 11.7ms | 0.2% | 11.7ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.2% | 11.1ms | 0.2% | 11.1ms | `/^\/r999\/([^\/]+?)\/?$/` | `[native code]` |
| 0.2% | 10.9ms | 0.0% | 0us | `internal:streams/lazy_transform` | `internal:streams/lazy_transform:2` |
| 0.2% | 10.7ms | 0.2% | 10.7ms | `node:stream/web` | `node:stream/web:8` |
| 0.2% | 10.6ms | 0.0% | 196us | `internal:streams/transform` | `internal:streams/transform:2` |
| 0.2% | 10.5ms | 0.2% | 10.5ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3533` |
| 0.2% | 10.3ms | 0.2% | 10.3ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:440` |
| 0.2% | 10.2ms | 0.0% | 0us | `internal:streams/duplex` | `internal:streams/duplex:2` |
| 0.2% | 10.2ms | 0.2% | 10.2ms | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.2% | 9.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:13` |
| 0.2% | 9.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:42` |
| 0.2% | 8.7ms | 0.2% | 8.7ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3521` |
| 0.2% | 8.7ms | 0.0% | 0us | `populateMaps` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:155` |
| 0.2% | 8.6ms | 0.2% | 8.6ms | `@lazy` | `[native code]` |
| 0.2% | 8.6ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/src/index.js:5` |
| 0.1% | 8.1ms | 0.1% | 8.1ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3042` |
| 0.1% | 7.7ms | 0.1% | 7.7ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.1% | 7.7ms | 0.0% | 0us | `Mime` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:13` |
| 0.1% | 7.6ms | 0.1% | 7.6ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4834` |
| 0.1% | 7.2ms | 0.0% | 0us | `node:_http_client` | `node:_http_client:10` |
| 0.1% | 7.2ms | 0.0% | 425us | `forEach` | `[native code]` |
| 0.1% | 7.2ms | 0.0% | 189us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5134` |
| 0.1% | 7.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-types/index.js:15` |
| 0.1% | 7.0ms | 0.1% | 7.0ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4914` |
| 0.1% | 6.5ms | 0.1% | 6.5ms | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4635` |
| 0.1% | 6.4ms | 0.1% | 6.4ms | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.1% | 6.3ms | 0.0% | 205us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4910` |
| 0.1% | 6.1ms | 0.1% | 6.1ms | `isFunction` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.1% | 6.0ms | 0.1% | 6.0ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4988` |
| 0.1% | 6.0ms | 0.1% | 6.0ms | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.1% | 5.6ms | 0.1% | 5.6ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3530` |
| 0.1% | 5.4ms | 0.1% | 5.4ms | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:289` |
| 0.1% | 5.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-types/index.js:16` |
| 0.1% | 5.3ms | 0.0% | 0us | `node:path` | `node:path:2` |
| 0.1% | 5.0ms | 0.1% | 5.0ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1336` |
| 0.1% | 5.0ms | 0.0% | 0us | `internal:fs/binding` | `internal:fs/binding:3` |
| 0.1% | 5.0ms | 0.0% | 0us | `node:fs/promises` | `node:fs/promises:2` |
| 0.1% | 4.9ms | 0.1% | 4.9ms | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:299` |
| 0.1% | 4.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:11` |
| 0.1% | 4.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:12` |
| 0.1% | 4.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:14` |
| 0.1% | 4.4ms | 0.1% | 4.4ms | `keys` | `[native code]` |
| 0.1% | 4.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:17` |
| 0.0% | 4.2ms | 0.0% | 4.2ms | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:231` |
| 0.0% | 4.2ms | 0.0% | 4.2ms | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/lib/language.js:16` |
| 0.0% | 4.1ms | 0.0% | 0us | `lazyInspectModule` | `node:util:17` |
| 0.0% | 4.0ms | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:84` |
| 0.0% | 4.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-db/index.js:12` |
| 0.0% | 4.0ms | 0.0% | 4.0ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3029` |
| 0.0% | 3.9ms | 0.0% | 3.9ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:19` |
| 0.0% | 3.9ms | 0.0% | 3.9ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:2` |
| 0.0% | 3.9ms | 0.0% | 2.5ms | `map` | `[native code]` |
| 0.0% | 3.8ms | 0.0% | 0us | `internal:streams/readable` | `internal:streams/readable:2` |
| 0.0% | 3.8ms | 0.0% | 3.8ms | `Map` | `[native code]` |
| 0.0% | 3.8ms | 0.0% | 0us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:67` |
| 0.0% | 3.7ms | 0.0% | 0us | `_preferredType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:189` |
| 0.0% | 3.7ms | 0.0% | 0us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:169` |
| 0.0% | 3.6ms | 0.0% | 0us | `node:zlib` | `node:zlib:2` |
| 0.0% | 3.4ms | 0.0% | 3.4ms | `set` | `[native code]` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5265` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:55` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:42` |
| 0.0% | 3.1ms | 0.0% | 3.1ms | `defineProperty` | `[native code]` |
| 0.0% | 3.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:15` |
| 0.0% | 2.9ms | 0.0% | 0us | `defineCustomPromisifyArgs` | `node:fs:304` |
| 0.0% | 2.9ms | 0.0% | 0us | `node:fs` | `node:fs:306` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:85` |
| 0.0% | 2.9ms | 0.0% | 0us | `populateMaps` | `/home/user/bun-node/node_modules/mime-types/index.js:158` |
| 0.0% | 2.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-types/index.js:40` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `Set` | `[native code]` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4883` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/node_modules/mime-db/index.js:12` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/index.js:41` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 2.6ms | 0.0% | 2.3ms | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:970` |
| 0.0% | 2.5ms | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:2053` |
| 0.0% | 2.5ms | 0.0% | 2.5ms | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1003` |
| 0.0% | 2.4ms | 0.0% | 2.4ms | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:17` |
| 0.0% | 2.4ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:80` |
| 0.0% | 2.3ms | 0.0% | 0us | `node:zlib` | `node:zlib:385` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `Uint32Array` | `[native code]` |
| 0.0% | 2.2ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:9` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5006` |
| 0.0% | 2.1ms | 0.0% | 1.7ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2991` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3044` |
| 0.0% | 2.0ms | 0.0% | 0us | `FreeList` | `internal:freelist:9` |
| 0.0% | 2.0ms | 0.0% | 0us | `node:_http_common` | `node:_http_common:62` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `(anonymous)` | `internal:freelist` |
| 0.0% | 2.0ms | 0.0% | 0us | `createDebug` | `/home/user/bun-node/node_modules/debug/src/common.js:117` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:20` |
| 0.0% | 2.0ms | 0.0% | 0us | `node:stream` | `node:stream:2` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `(unknown)` | `[native code]` |
| 0.0% | 1.9ms | 0.0% | 1.4ms | `get headersSent` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` |
| 0.0% | 1.9ms | 0.0% | 686us | `(anonymous)` | `[native code]` |
| 0.0% | 1.8ms | 0.0% | 1.6ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1299` |
| 0.0% | 1.8ms | 0.0% | 0us | `internal:streams/destroy` | `internal:streams/destroy:2` |
| 0.0% | 1.8ms | 0.0% | 0us | `internal:errors` | `internal:errors:2` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:185` |
| 0.0% | 1.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:32` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 1.5ms | 0.0% | 222us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:19` |
| 0.0% | 1.5ms | 0.0% | 0us | `node:util` | `node:util:8` |
| 0.0% | 1.5ms | 0.0% | 0us | `internal:util/mime` | `internal:util/mime:2` |
| 0.0% | 1.5ms | 0.0% | 0us | `internal:streams/legacy` | `internal:streams/legacy:2` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `RegExp` | `[native code]` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1062` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1075` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `addRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1249` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5009` |
| 0.0% | 1.4ms | 0.0% | 0us | `internal:validators` | `internal:validators:2` |
| 0.0% | 1.4ms | 0.0% | 212us | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js:158` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:296` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:15` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:38` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `setPrototypeDirectOrThrow` | `[native code]` |
| 0.0% | 1.2ms | 0.0% | 0us | `internal:stream` | `internal:stream:2` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `#respond` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:487` |
| 0.0% | 1.2ms | 0.0% | 192us | `filter` | `[native code]` |
| 0.0% | 1.2ms | 0.0% | 0us | `node:_http_agent` | `node:_http_agent:2` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:5` |
| 0.0% | 1.2ms | 0.0% | 0us | `node:tty` | `node:tty:7` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2501` |
| 0.0% | 1.1ms | 0.0% | 0us | `node:_http_common` | `node:_http_common:2` |
| 0.0% | 1.1ms | 0.0% | 0us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:242` |
| 0.0% | 1.1ms | 0.0% | 0us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 1.0ms | 0.0% | 0us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:169` |
| 0.0% | 1.0ms | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:457` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `parse` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `defineProperties` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `internal:streams/writable` | `internal:streams/writable:493` |
| 0.0% | 977us | 0.0% | 977us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:18` |
| 0.0% | 876us | 0.0% | 0us | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:696` |
| 0.0% | 866us | 0.0% | 0us | `use` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4238` |
| 0.0% | 850us | 0.0% | 850us | `uncurryThis` | `internal:primordials` |
| 0.0% | 827us | 0.0% | 0us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:216` |
| 0.0% | 823us | 0.0% | 0us | `node:_http_agent` | `node:_http_agent:290` |
| 0.0% | 823us | 0.0% | 823us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 822us | 0.0% | 822us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:129` |
| 0.0% | 818us | 0.0% | 207us | `internal:primordials` | `internal:primordials:76` |
| 0.0% | 812us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:17` |
| 0.0% | 796us | 0.0% | 202us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:23` |
| 0.0% | 790us | 0.0% | 790us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:951` |
| 0.0% | 785us | 0.0% | 785us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4924` |
| 0.0% | 783us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:418` |
| 0.0% | 783us | 0.0% | 783us | `delete` | `[native code]` |
| 0.0% | 783us | 0.0% | 783us | `WeakSet` | `[native code]` |
| 0.0% | 783us | 0.0% | 783us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:555` |
| 0.0% | 778us | 0.0% | 0us | `internal:streams/add-abort-signal` | `internal:streams/add-abort-signal:2` |
| 0.0% | 770us | 0.0% | 362us | `from` | `[native code]` |
| 0.0% | 765us | 0.0% | 0us | `node:crypto` | `node:crypto:350` |
| 0.0% | 765us | 0.0% | 765us | `assign` | `[native code]` |
| 0.0% | 764us | 0.0% | 0us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:333` |
| 0.0% | 763us | 0.0% | 763us | `populateMaps` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` |
| 0.0% | 761us | 0.0% | 761us | `get requestOpts` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 745us | 0.0% | 745us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:681` |
| 0.0% | 717us | 0.0% | 0us | `node:os` | `node:os:110` |
| 0.0% | 702us | 0.0% | 702us | `node:zlib` | `node:zlib:12` |
| 0.0% | 693us | 0.0% | 693us | `exec` | `[native code]` |
| 0.0% | 684us | 0.0% | 213us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5129` |
| 0.0% | 683us | 0.0% | 683us | `_freeze` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:71` |
| 0.0% | 675us | 0.0% | 0us | `flushPending` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4223` |
| 0.0% | 662us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/types/multipart.js:5` |
| 0.0% | 660us | 0.0% | 660us | `get size` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:276` |
| 0.0% | 660us | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1076` |
| 0.0% | 654us | 0.0% | 0us | `internal:util/inspect` | `internal:util/inspect:9` |
| 0.0% | 650us | 0.0% | 455us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1019` |
| 0.0% | 647us | 0.0% | 0us | `internal:util/inspect` | `internal:util/inspect:46` |
| 0.0% | 645us | 0.0% | 0us | `WriteStream` | `internal:fs/streams:259` |
| 0.0% | 643us | 0.0% | 0us | `node:zlib` | `node:zlib:451` |
| 0.0% | 631us | 0.0% | 0us | `internal:streams/compose` | `internal:streams/compose:2` |
| 0.0% | 631us | 0.0% | 631us | `add` | `[native code]` |
| 0.0% | 623us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:194` |
| 0.0% | 621us | 0.0% | 0us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:20` |
| 0.0% | 621us | 0.0% | 621us | `node:crypto` | `node:crypto:109` |
| 0.0% | 612us | 0.0% | 612us | `originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3699` |
| 0.0% | 606us | 0.0% | 0us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:185` |
| 0.0% | 598us | 0.0% | 598us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:115` |
| 0.0% | 588us | 0.0% | 588us | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 586us | 0.0% | 0us | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1396` |
| 0.0% | 584us | 0.0% | 398us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4790` |
| 0.0% | 574us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/compression.ts:240` |
| 0.0% | 574us | 0.0% | 574us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/compression.ts:245` |
| 0.0% | 573us | 0.0% | 573us | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 569us | 0.0% | 569us | `(anonymous)` | `node:zlib` |
| 0.0% | 565us | 0.0% | 0us | `bound call` | `[native code]` |
| 0.0% | 544us | 0.0% | 544us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4789` |
| 0.0% | 536us | 0.0% | 536us | `bound` | `node:os` |
| 0.0% | 512us | 0.0% | 512us | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1409` |
| 0.0% | 484us | 0.0% | 484us | `normalizeEtagOption` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 481us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/types/urlencoded.js:3` |
| 0.0% | 471us | 0.0% | 0us | `layerFinished` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:598` |
| 0.0% | 467us | 0.0% | 0us | `node:diagnostics_channel` | `node:diagnostics_channel:17` |
| 0.0% | 453us | 0.0% | 453us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 449us | 0.0% | 449us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 449us | 0.0% | 449us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/types/standard.js:365` |
| 0.0% | 446us | 0.0% | 446us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 444us | 0.0% | 444us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:141` |
| 0.0% | 436us | 0.0% | 436us | `__classPrivateFieldGet` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 435us | 0.0% | 0us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:21` |
| 0.0% | 435us | 0.0% | 435us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 431us | 0.0% | 0us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5260` |
| 0.0% | 430us | 0.0% | 0us | `node:crypto` | `node:crypto:39` |
| 0.0% | 430us | 0.0% | 430us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4798` |
| 0.0% | 426us | 0.0% | 426us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4857` |
| 0.0% | 424us | 0.0% | 424us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:422` |
| 0.0% | 423us | 0.0% | 0us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:28` |
| 0.0% | 422us | 0.0% | 0us | `node:_http_incoming` | `node:_http_incoming:15` |
| 0.0% | 422us | 0.0% | 422us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3502` |
| 0.0% | 421us | 0.0% | 0us | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5314` |
| 0.0% | 421us | 0.0% | 421us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:164` |
| 0.0% | 418us | 0.0% | 232us | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:700` |
| 0.0% | 418us | 0.0% | 418us | `internal:shared` | `internal:shared:33` |
| 0.0% | 416us | 0.0% | 416us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3546` |
| 0.0% | 411us | 0.0% | 411us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2488` |
| 0.0% | 410us | 0.0% | 410us | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 409us | 0.0% | 198us | `#configuredQueryOpts` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1368` |
| 0.0% | 404us | 0.0% | 404us | `__classPrivateFieldGet` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:4` |
| 0.0% | 402us | 0.0% | 402us | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1343` |
| 0.0% | 400us | 0.0% | 400us | `get upgradeToWsData` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 400us | 0.0% | 211us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:352` |
| 0.0% | 398us | 0.0% | 398us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5066` |
| 0.0% | 396us | 0.0% | 396us | `Agent` | `node:_http_agent` |
| 0.0% | 395us | 0.0% | 395us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1699` |
| 0.0% | 395us | 0.0% | 0us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:30` |
| 0.0% | 394us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/uint8array-extras/index.js:178` |
| 0.0% | 394us | 0.0% | 394us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3031` |
| 0.0% | 393us | 0.0% | 0us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:346` |
| 0.0% | 393us | 0.0% | 0us | `set requestOpts` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:742` |
| 0.0% | 393us | 0.0% | 393us | `makeSafe` | `internal:primordials:32` |
| 0.0% | 393us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/file-type/source/index.js:1913` |
| 0.0% | 392us | 0.0% | 392us | `normalizeEtagOption` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:393` |
| 0.0% | 392us | 0.0% | 392us | `WriteStream` | `internal:fs/streams` |
| 0.0% | 388us | 0.0% | 388us | `EventEmitter` | `node:events` |
| 0.0% | 387us | 0.0% | 0us | `BunRouter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:889` |
| 0.0% | 383us | 0.0% | 383us | `param-random` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 383us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/ip-regex/index.js:25` |
| 0.0% | 381us | 0.0% | 381us | `routes` | `/home/user/bun-node/node_modules/@routejs/router/src/router.mjs` |
| 0.0% | 381us | 0.0% | 381us | `node:zlib` | `node:zlib:541` |
| 0.0% | 380us | 0.0% | 380us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:159` |
| 0.0% | 379us | 0.0% | 379us | `getHeader` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 376us | 0.0% | 0us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:174` |
| 0.0% | 376us | 0.0% | 376us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:202` |
| 0.0% | 376us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` |
| 0.0% | 376us | 0.0% | 376us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:119` |
| 0.0% | 372us | 0.0% | 372us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 369us | 0.0% | 369us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:30` |
| 0.0% | 367us | 0.0% | 367us | `isBoolean` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:158` |
| 0.0% | 367us | 0.0% | 0us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3026` |
| 0.0% | 353us | 0.0% | 0us | `node:zlib` | `node:zlib:456` |
| 0.0% | 310us | 0.0% | 0us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:40` |
| 0.0% | 310us | 0.0% | 310us | `split` | `[native code]` |
| 0.0% | 306us | 0.0% | 306us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:215` |
| 0.0% | 283us | 0.0% | 283us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1697` |
| 0.0% | 267us | 0.0% | 267us | `get response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:946` |
| 0.0% | 260us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:124` |
| 0.0% | 260us | 0.0% | 260us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 257us | 0.0% | 257us | `Writable` | `internal:streams/writable` |
| 0.0% | 255us | 0.0% | 255us | `setResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3736` |
| 0.0% | 253us | 0.0% | 253us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1120` |
| 0.0% | 250us | 0.0% | 250us | `getOwnPropertyNames` | `[native code]` |
| 0.0% | 249us | 0.0% | 0us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5013` |
| 0.0% | 247us | 0.0% | 0us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5062` |
| 0.0% | 247us | 0.0% | 247us | `set params` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 239us | 0.0% | 239us | `decodeParam` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 236us | 0.0% | 236us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3549` |
| 0.0% | 234us | 0.0% | 234us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:834` |
| 0.0% | 232us | 0.0% | 232us | `normalizeCatchAllPath` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 232us | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1012` |
| 0.0% | 231us | 0.0% | 0us | `Agent` | `node:_http_agent:22` |
| 0.0% | 231us | 0.0% | 231us | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 231us | 0.0% | 0us | `addListener` | `node:events:214` |
| 0.0% | 231us | 0.0% | 231us | `_addListener` | `node:events` |
| 0.0% | 230us | 0.0% | 0us | `node:_http_client` | `node:_http_client:39` |
| 0.0% | 229us | 0.0% | 0us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:66` |
| 0.0% | 229us | 0.0% | 229us | `(anonymous)` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/linkedlist/index.mjs:5` |
| 0.0% | 229us | 0.0% | 0us | `LinkedList` | `[native code]` |
| 0.0% | 226us | 0.0% | 226us | `extractWildcardNames` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 226us | 0.0% | 226us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/types/multipart.js:221` |
| 0.0% | 226us | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1015` |
| 0.0% | 225us | 0.0% | 225us | `internal:validators` | `internal:validators:69` |
| 0.0% | 223us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/supports-color/index.js:133` |
| 0.0% | 223us | 0.0% | 223us | `supportsColor` | `/home/user/bun-node/node_modules/supports-color/index.js` |
| 0.0% | 222us | 0.0% | 222us | `internal:streams/readable` | `internal:streams/readable:737` |
| 0.0% | 222us | 0.0% | 222us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:47` |
| 0.0% | 221us | 0.0% | 221us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 220us | 0.0% | 220us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/types/other.js:718` |
| 0.0% | 220us | 0.0% | 220us | `use` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 219us | 0.0% | 219us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/types/multipart.js:27` |
| 0.0% | 219us | 0.0% | 219us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3046` |
| 0.0% | 218us | 0.0% | 0us | `makeSafe` | `internal:primordials:53` |
| 0.0% | 218us | 0.0% | 218us | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4703` |
| 0.0% | 218us | 0.0% | 218us | `copyObject` | `internal:fs/streams:33` |
| 0.0% | 218us | 0.0% | 0us | `WriteStream` | `internal:fs/streams:201` |
| 0.0% | 218us | 0.0% | 218us | `internal:streams/destroy` | `internal:streams/destroy:16` |
| 0.0% | 218us | 0.0% | 218us | `copyProps` | `internal:primordials` |
| 0.0% | 217us | 0.0% | 217us | `_freeze` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 217us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/supports-color/index.js:4` |
| 0.0% | 216us | 0.0% | 0us | `internal:util/inspect` | `internal:util/inspect:392` |
| 0.0% | 216us | 0.0% | 216us | `defineColorAlias` | `internal:util/inspect` |
| 0.0% | 216us | 0.0% | 0us | `node:_http_server` | `node:_http_server:16` |
| 0.0% | 216us | 0.0% | 0us | `node:zlib` | `node:zlib:449` |
| 0.0% | 215us | 0.0% | 215us | `Channel` | `node:diagnostics_channel` |
| 0.0% | 215us | 0.0% | 215us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1039` |
| 0.0% | 215us | 0.0% | 0us | `channel` | `node:diagnostics_channel:141` |
| 0.0% | 215us | 0.0% | 215us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:25` |
| 0.0% | 215us | 0.0% | 215us | `node:_http_agent` | `node:_http_agent:129` |
| 0.0% | 214us | 0.0% | 214us | `(anonymous)` | `/home/user/bun-node/node_modules/uint8array-extras/index.js:178` |
| 0.0% | 214us | 0.0% | 214us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:431` |
| 0.0% | 212us | 0.0% | 212us | `every` | `[native code]` |
| 0.0% | 212us | 0.0% | 0us | `set logger` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:931` |
| 0.0% | 212us | 0.0% | 212us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5247` |
| 0.0% | 212us | 0.0% | 0us | `resolveLogger` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:1044` |
| 0.0% | 212us | 0.0% | 212us | `has` | `[native code]` |
| 0.0% | 212us | 0.0% | 0us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:350` |
| 0.0% | 211us | 0.0% | 211us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3511` |
| 0.0% | 211us | 0.0% | 211us | `get legacyQueryOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1388` |
| 0.0% | 211us | 0.0% | 0us | `internal:stream` | `internal:stream:47` |
| 0.0% | 210us | 0.0% | 0us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5037` |
| 0.0% | 210us | 0.0% | 210us | `SafeSet` | `internal:primordials` |
| 0.0% | 210us | 0.0% | 210us | `get hasDeferredBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2838` |
| 0.0% | 210us | 0.0% | 210us | `get host` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 210us | 0.0% | 210us | `Symbol` | `[native code]` |
| 0.0% | 210us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:473` |
| 0.0% | 209us | 0.0% | 209us | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 209us | 0.0% | 0us | `node:events` | `node:events:10` |
| 0.0% | 208us | 0.0% | 0us | `segmentKind` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:71` |
| 0.0% | 208us | 0.0% | 208us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:476` |
| 0.0% | 208us | 0.0% | 208us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunValidate.ts:141` |
| 0.0% | 208us | 0.0% | 208us | `test` | `[native code]` |
| 0.0% | 208us | 0.0% | 208us | `mergeBunRequestOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 208us | 0.0% | 208us | `internal:url` | `internal:url:23` |
| 0.0% | 208us | 0.0% | 208us | `node:_http_outgoing` | `node:_http_outgoing:65` |
| 0.0% | 208us | 0.0% | 0us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:86` |
| 0.0% | 208us | 0.0% | 208us | `node:fs/promises` | `node:fs/promises:142` |
| 0.0% | 207us | 0.0% | 207us | `get method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 0.0% | 206us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/supports-color/index.js:9` |
| 0.0% | 206us | 0.0% | 206us | `(anonymous)` | `/home/user/bun-node/node_modules/has-flag/index.js` |
| 0.0% | 206us | 0.0% | 206us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3548` |
| 0.0% | 206us | 0.0% | 0us | `Writable` | `internal:streams/writable:196` |
| 0.0% | 206us | 0.0% | 206us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1308` |
| 0.0% | 206us | 0.0% | 206us | `node:_http_outgoing` | `node:_http_outgoing:45` |
| 0.0% | 206us | 0.0% | 206us | `Stream` | `internal:streams/legacy` |
| 0.0% | 205us | 0.0% | 0us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2502` |
| 0.0% | 205us | 0.0% | 205us | `(anonymous)` | `internal:http:4` |
| 0.0% | 205us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:303` |
| 0.0% | 205us | 0.0% | 0us | `internal:http` | `internal:http:7` |
| 0.0% | 205us | 0.0% | 205us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:28` |
| 0.0% | 205us | 0.0% | 205us | `isArray` | `[native code]` |
| 0.0% | 205us | 0.0% | 0us | `createLogger` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:299` |
| 0.0% | 205us | 0.0% | 0us | `node:zlib` | `node:zlib:161` |
| 0.0% | 205us | 0.0% | 205us | `StructuredLogger` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:181` |
| 0.0% | 205us | 0.0% | 205us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1246` |
| 0.0% | 204us | 0.0% | 204us | `setName` | `node:fs:696` |
| 0.0% | 204us | 0.0% | 0us | `node:fs` | `node:fs:739` |
| 0.0% | 204us | 0.0% | 0us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` |
| 0.0% | 204us | 0.0% | 0us | `headersSent` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` |
| 0.0% | 203us | 0.0% | 203us | `node:_http_server` | `node:_http_server:1690` |
| 0.0% | 203us | 0.0% | 203us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 202us | 0.0% | 202us | `emitFinish` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:797` |
| 0.0% | 202us | 0.0% | 0us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:331` |
| 0.0% | 202us | 0.0% | 0us | `promisify2` | `internal:promisify:17` |
| 0.0% | 202us | 0.0% | 202us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5222` |
| 0.0% | 202us | 0.0% | 0us | `get` | `internal:stream:69` |
| 0.0% | 202us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/multipart/stream.ts:4` |
| 0.0% | 202us | 0.0% | 202us | `resolveLogger` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts` |
| 0.0% | 201us | 0.0% | 201us | `node:events` | `node:events:651` |
| 0.0% | 201us | 0.0% | 201us | `#configuredCookieSecrets` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 200us | 0.0% | 0us | `internal:fs/streams` | `internal:fs/streams:90` |
| 0.0% | 200us | 0.0% | 200us | `node:zlib` | `node:zlib:478` |
| 0.0% | 199us | 0.0% | 199us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3503` |
| 0.0% | 198us | 0.0% | 0us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:35` |
| 0.0% | 198us | 0.0% | 198us | `__classPrivateFieldGet` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:3` |
| 0.0% | 197us | 0.0% | 197us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:169` |
| 0.0% | 197us | 0.0% | 197us | `isBoolean` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 197us | 0.0% | 0us | `RouteCandidateIndex` | `[native code]` |
| 0.0% | 197us | 0.0% | 0us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1239` |
| 0.0% | 197us | 0.0% | 0us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:800` |
| 0.0% | 196us | 0.0% | 196us | `promisify2` | `internal:promisify` |
| 0.0% | 196us | 0.0% | 196us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:45` |
| 0.0% | 196us | 0.0% | 0us | `Agent` | `node:_http_agent:10` |
| 0.0% | 196us | 0.0% | 196us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 196us | 0.0% | 196us | `matchBaseUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 196us | 0.0% | 196us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 196us | 0.0% | 0us | `internal:primordials` | `internal:primordials:54` |
| 0.0% | 196us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/general.ts:31` |
| 0.0% | 195us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/@borewit/text-codec/lib/index.js:9` |
| 0.0% | 195us | 0.0% | 195us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:87` |
| 0.0% | 195us | 0.0% | 195us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 195us | 0.0% | 195us | `entries` | `[native code]` |
| 0.0% | 194us | 0.0% | 194us | `(anonymous)` | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js` |
| 0.0% | 194us | 0.0% | 194us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:651` |
| 0.0% | 193us | 0.0% | 193us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:241` |
| 0.0% | 193us | 0.0% | 193us | `node:stream/web` | `node:stream/web:13` |
| 0.0% | 193us | 0.0% | 193us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1254` |
| 0.0% | 192us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/index.js:44` |
| 0.0% | 192us | 0.0% | 0us | `internal:primordials` | `internal:primordials:88` |
| 0.0% | 192us | 0.0% | 0us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:255` |
| 0.0% | 191us | 0.0% | 191us | `call` | `[native code]` |
| 0.0% | 191us | 0.0% | 0us | `makeSafe` | `internal:primordials:35` |
| 0.0% | 191us | 0.0% | 191us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:170` |
| 0.0% | 191us | 0.0% | 0us | `internal:primordials` | `internal:primordials:83` |
| 0.0% | 191us | 0.0% | 191us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:953` |
| 0.0% | 191us | 0.0% | 191us | `flushPending` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 190us | 0.0% | 190us | `Router` | `/home/user/bun-node/node_modules/@routejs/router/src/router.mjs` |
| 0.0% | 190us | 0.0% | 190us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2494` |
| 0.0% | 190us | 0.0% | 190us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:176` |
| 0.0% | 189us | 0.0% | 0us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:27` |
| 0.0% | 189us | 0.0% | 189us | `BunWebSocket` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts` |
| 0.0% | 189us | 0.0% | 189us | `slice` | `[native code]` |
| 0.0% | 189us | 0.0% | 189us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:238` |
| 0.0% | 187us | 0.0% | 187us | `internal:streams/duplexpair` | `internal:streams/duplexpair:4` |
| 0.0% | 187us | 0.0% | 0us | `internal:stream` | `internal:stream:48` |
| 0.0% | 187us | 0.0% | 0us | `(anonymous)` | `internal:util/inspect:46` |
| 0.0% | 187us | 0.0% | 187us | `get requestOpts` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:733` |
| 0.0% | 186us | 0.0% | 186us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:593` |
| 0.0% | 186us | 0.0% | 186us | `setResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 185us | 0.0% | 0us | `mergeBunRequestOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:321` |
| 0.0% | 185us | 0.0% | 185us | `BunRouter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 185us | 0.0% | 185us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 185us | 0.0% | 185us | `isObject` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 183us | 0.0% | 183us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:117` |
| 0.0% | 182us | 0.0% | 0us | `node:crypto` | `node:crypto:65` |
| 0.0% | 182us | 0.0% | 0us | `put` | `/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/lib/index.js:87` |
| 0.0% | 182us | 0.0% | 182us | `WritableState` | `internal:streams/writable` |
| 0.0% | 182us | 0.0% | 182us | `setUint32` | `[native code]` |
| 0.0% | 182us | 0.0% | 0us | `Writable` | `internal:streams/writable:181` |
| 0.0% | 182us | 0.0% | 0us | `signatureToArray` | `/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:6` |
| 0.0% | 182us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:11` |
| 0.0% | 181us | 0.0% | 181us | `bound` | `node:os:107` |
| 0.0% | 181us | 0.0% | 0us | `internal:streams/readable` | `internal:streams/readable:14` |
| 0.0% | 181us | 0.0% | 181us | `(anonymous)` | `/home/user/bun-node/node_modules/parse-domain/dist/sanitize.js` |
| 0.0% | 181us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/parse-domain/dist/sanitize.js:33` |
| 0.0% | 181us | 0.0% | 181us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 177us | 0.0% | 0us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2511` |
| 0.0% | 177us | 0.0% | 177us | `isObject` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:179` |
| 0.0% | 174us | 0.0% | 174us | `init` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 174us | 0.0% | 0us | `createDebug` | `/home/user/bun-node/node_modules/debug/src/common.js:143` |

## Function Details

### `Response`
`[native code]` | Self: 13.2% (567.8ms) | Total: 13.2% (567.8ms) | Samples: 1573

**Called by:**
- `#respondWithText` (1567)
- `#respondWithText` (6)

### `Request`
`[native code]` | Self: 6.0% (261.5ms) | Total: 6.0% (261.5ms) | Samples: 863

**Called by:**
- `param-random` (863)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:281` | Self: 4.7% (202.6ms) | Total: 4.7% (202.6ms) | Samples: 638

**Called by:**
- `getMatchedLayers` (638)

### `param-random`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:130` | Self: 4.6% (199.7ms) | Total: 10.7% (461.2ms) | Samples: 455

**Called by:**
- `(module)` (1318)

**Calls:**
- `Request` (863)

### `splitPattern`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:58` | Self: 4.4% (191.4ms) | Total: 4.4% (191.4ms) | Samples: 623

**Called by:**
- `splitRequestPath` (614)
- `candidates` (9)

### `decodeURIComponent`
`[native code]` | Self: 2.8% (121.3ms) | Total: 2.8% (121.3ms) | Samples: 404

**Called by:**
- `decodeParam` (404)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:223` | Self: 2.7% (118.7ms) | Total: 2.7% (118.7ms) | Samples: 379

**Called by:**
- `getMatchedLayers` (379)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4805` | Self: 2.7% (116.0ms) | Total: 9.5% (411.2ms) | Samples: 439

**Called by:**
- `dispatch` (1390)

**Calls:**
- `matchRoute` (436)
- `matchRoute` (413)
- `matchRoute` (40)
- `matchRoute` (31)
- `matchRoute` (30)
- `matchRoute` (1)

### `get`
`[native code]` | Self: 2.6% (113.4ms) | Total: 2.6% (113.4ms) | Samples: 435

**Called by:**
- `parseCookies` (175)
- `#finishAbsentBody` (168)
- `#finishAbsentBody` (90)
- `getMatchedLayers` (1)
- `define` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` | Self: 2.4% (103.9ms) | Total: 2.4% (106.8ms) | Samples: 120

**Called by:**
- `init` (127)

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `anonymous`
`[native code]` | Self: 2.3% (102.3ms) | Total: 5.9% (253.3ms) | Samples: 209

**Called by:**
- `require` (204)
- `node:http` (63)
- `node:crypto` (43)
- `internal:streams/lazy_transform` (41)
- `internal:streams/transform` (39)
- `internal:streams/duplex` (38)
- `node:_http_client` (24)
- `lazyInspectModule` (18)
- `internal:streams/readable` (18)
- `bound require` (14)
- `node:stream` (10)
- `node:zlib` (10)
- `node:path` (9)
- `internal:streams/destroy` (8)
- `internal:errors` (8)
- `internal:streams/legacy` (8)
- `internal:validators` (6)
- `internal:stream` (6)
- `node:_http_common` (6)
- `node:tty` (5)
- `node:_http_agent` (5)
- `internal:streams/add-abort-signal` (4)
- `internal:streams/compose` (3)
- `node:fs/promises` (3)
- `node:_http_incoming` (2)
- `internal:stream` (1)
- `node:_http_client` (1)
- `get` (1)
- `node:events` (1)
- `node:_http_server` (1)
- `node:util` (1)
- `internal:stream` (1)
- `node:crypto` (1)
- `internal:streams/readable` (1)

**Calls:**
- `internal:streams/lazy_transform` (41)
- `internal:streams/transform` (40)
- `internal:streams/duplex` (38)
- `node:_http_client` (25)
- `internal:streams/readable` (18)
- `(anonymous)` (15)
- `(anonymous)` (14)
- `node:stream` (10)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `node:path` (9)
- `internal:errors` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `internal:streams/legacy` (8)
- `internal:streams/destroy` (8)
- `(anonymous)` (7)
- `internal:stream` (6)
- `internal:validators` (6)
- `node:_http_common` (6)
- `(anonymous)` (6)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `node:tty` (5)
- `(anonymous)` (5)
- `node:_http_agent` (5)
- `(anonymous)` (5)
- `internal:streams/add-abort-signal` (4)
- `node:_http_agent` (4)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `internal:fs/binding` (3)
- `internal:util/inspect` (3)
- `internal:primordials` (3)
- `internal:streams/compose` (3)
- `node:_http_incoming` (2)
- `(anonymous)` (2)
- `internal:validators` (1)
- `internal:primordials` (1)
- `(anonymous)` (1)
- `node:_http_client` (1)
- `internal:url` (1)
- `internal:util/inspect` (1)
- `node:events` (1)
- `internal:stream` (1)
- `(anonymous)` (1)
- `internal:streams/duplexpair` (1)
- `(anonymous)` (1)
- `internal:primordials` (1)
- `node:_http_server` (1)
- `internal:util/mime` (1)
- `internal:streams/destroy` (1)
- `node:diagnostics_channel` (1)
- `internal:fs/streams` (1)
- `internal:streams/readable` (1)
- `node:_http_server` (1)
- `internal:streams/readable` (1)
- `node:_http_common` (1)
- `internal:shared` (1)
- `node:_http_agent` (1)
- `(anonymous)` (1)
- `node:_http_outgoing` (1)
- `internal:stream` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:_http_outgoing` (1)
- `internal:util/inspect` (1)
- `(anonymous)` (1)
- `internal:streams/writable` (1)
- `node:events` (1)
- `internal:http` (1)
- `internal:primordials` (1)
- `(anonymous)` (1)

### `matchRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4634` | Self: 2.3% (101.8ms) | Total: 2.6% (113.4ms) | Samples: 382

**Called by:**
- `getMatchedLayers` (436)

**Calls:**
- `/^\/r999\/([^\/]+?)\/?$/` (52)
- `exec` (2)

### `set`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:298` | Self: 2.3% (101.1ms) | Total: 2.3% (101.9ms) | Samples: 403

**Called by:**
- `getMatchedLayers` (407)

**Calls:**
- `delete` (4)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1231` | Self: 2.2% (98.5ms) | Total: 2.2% (98.5ms) | Samples: 283

**Called by:**
- `init` (283)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 2.0% (88.3ms) | Total: 2.0% (88.3ms) | Samples: 265

**Called by:**
- `init` (265)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5130` | Self: 1.5% (66.4ms) | Total: 1.5% (66.4ms) | Samples: 217

**Called by:**
- `#routeRequest` (217)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 1.5% (65.7ms) | Total: 1.5% (65.7ms) | Samples: 174

**Called by:**
- `#routeRequest` (174)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3506` | Self: 1.4% (62.2ms) | Total: 1.4% (62.2ms) | Samples: 244

**Called by:**
- `parseQuery` (243)
- `host` (1)

### `method`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` | Self: 1.3% (57.0ms) | Total: 1.3% (57.0ms) | Samples: 222

**Called by:**
- `#canSkipHeaders` (127)
- `#routeRequest` (95)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4777` | Self: 1.3% (56.8ms) | Total: 1.3% (57.0ms) | Samples: 172

**Called by:**
- `dispatch` (173)

**Calls:**
- `getRequestPathFromRequestURL` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3541` | Self: 1.2% (54.6ms) | Total: 1.2% (54.6ms) | Samples: 157

**Called by:**
- `parseQuery` (156)
- `get` (1)

### `(anonymous)`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:177` | Self: 1.2% (52.8ms) | Total: 1.2% (52.8ms) | Samples: 125

**Called by:**
- `#runPipeline` (125)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1213` | Self: 1.2% (52.5ms) | Total: 1.2% (54.0ms) | Samples: 196

**Called by:**
- `#runPipeline` (203)

**Calls:**
- `Response` (6)
- `add` (1)

### `set`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:302` | Self: 1.2% (51.6ms) | Total: 1.2% (54.6ms) | Samples: 113

**Called by:**
- `getMatchedLayers` (117)

**Calls:**
- `set` (2)
- `matchRoute` (2)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4793` | Self: 1.1% (51.4ms) | Total: 9.4% (406.3ms) | Samples: 130

**Called by:**
- `dispatch` (1254)

**Calls:**
- `candidates` (627)
- `candidates` (379)
- `candidates` (57)
- `candidates` (39)
- `candidates` (13)
- `candidates` (4)
- `candidates` (2)
- `candidates` (1)
- `candidates` (1)
- `candidates` (1)

### `cloneObject`
`[native code]` | Self: 1.1% (49.6ms) | Total: 1.1% (49.6ms) | Samples: 77

**Called by:**
- `#writableOptions` (77)

### `getRequestPathFromRequestURL`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4470` | Self: 1.1% (49.4ms) | Total: 1.1% (49.4ms) | Samples: 210

**Called by:**
- `getMatchedLayers` (210)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4876` | Self: 1.0% (44.1ms) | Total: 1.0% (44.1ms) | Samples: 72

**Called by:**
- `dispatch` (72)

### `matchRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4672` | Self: 0.9% (41.5ms) | Total: 0.9% (41.5ms) | Samples: 40

**Called by:**
- `getMatchedLayers` (40)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:437` | Self: 0.9% (41.4ms) | Total: 3.9% (167.9ms) | Samples: 154

**Called by:**
- `serveNativeRequest` (443)

**Calls:**
- `BunResponse` (174)
- `BunResponse` (109)
- `BunResponse` (4)
- `BunResponse` (2)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3540` | Self: 0.9% (40.5ms) | Total: 0.9% (40.5ms) | Samples: 70

**Called by:**
- `parseQuery` (68)
- `host` (2)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3520` | Self: 0.8% (38.0ms) | Total: 0.8% (38.0ms) | Samples: 153

**Called by:**
- `originalUrl` (100)
- `parseQuery` (53)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` | Self: 0.8% (35.6ms) | Total: 1.3% (59.4ms) | Samples: 68

**Called by:**
- `#routeRequest` (109)

**Calls:**
- `(anonymous)` (38)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5102` | Self: 0.6% (29.5ms) | Total: 17.8% (765.8ms) | Samples: 70

**Called by:**
- `#routeRequest` (2190)

**Calls:**
- `#respondWithText` (1586)
- `#respondWithText` (203)
- `#respondWithText` (130)
- `(anonymous)` (125)
- `#respondWithText` (53)
- `send` (17)
- `send` (3)
- `send` (2)
- `#respondWithText` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1267` | Self: 0.6% (27.9ms) | Total: 5.6% (244.5ms) | Samples: 55

**Called by:**
- `init` (814)

**Calls:**
- `parseQuery` (694)
- `parseQuery` (30)
- `parseQuery` (24)
- `parseQuery` (11)

### `alloc`
`[native code]` | Self: 0.6% (25.9ms) | Total: 0.6% (25.9ms) | Samples: 86

**Called by:**
- `#finishAbsentBody` (86)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1261` | Self: 0.5% (24.3ms) | Total: 0.6% (28.1ms) | Samples: 58

**Called by:**
- `init` (73)

**Calls:**
- `normalizeParseBodyOptions` (8)
- `normalizeParseBodyOptions` (2)
- `normalizeParseBodyOptions` (2)
- `normalizeParseBodyOptions` (1)
- `normalizeParseBodyOptions` (1)
- `normalizeParseBodyOptions` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:136` | Self: 0.5% (22.8ms) | Total: 0.5% (22.8ms) | Samples: 13

**Called by:**
- `#compileRouteRegExp` (13)

### `init`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1432` | Self: 0.5% (22.7ms) | Total: 20.8% (896.5ms) | Samples: 56

**Called by:**
- `serveNativeRequest` (2582)

**Calls:**
- `BunRequest` (814)
- `BunRequest` (490)
- `BunRequest` (362)
- `BunRequest` (283)
- `BunRequest` (265)
- `BunRequest` (127)
- `BunRequest` (103)
- `BunRequest` (73)
- `BunRequest` (5)
- `BunRequest` (1)
- `BunRequest` (1)
- `BunRequest` (1)
- `BunRequest` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:514` | Self: 0.5% (22.6ms) | Total: 0.5% (22.6ms) | Samples: 38

**Called by:**
- `BunResponse` (38)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5072` | Self: 0.5% (21.7ms) | Total: 0.5% (21.7ms) | Samples: 49

**Called by:**
- `#routeRequest` (49)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3040` | Self: 0.4% (18.8ms) | Total: 1.3% (59.4ms) | Samples: 67

**Called by:**
- `BunRequest` (244)

**Calls:**
- `get` (175)
- `getHeader` (2)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1306` | Self: 0.4% (18.1ms) | Total: 2.5% (109.1ms) | Samples: 19

**Called by:**
- `init` (362)

**Calls:**
- `parseCookies` (244)
- `parseCookies` (38)
- `parseCookies` (26)
- `parseCookies` (20)
- `parseCookies` (10)
- `parseCookies` (2)
- `parseCookies` (1)
- `parseCookies` (1)
- `parseCookies` (1)

### `indexOf`
`[native code]` | Self: 0.4% (17.7ms) | Total: 0.4% (17.7ms) | Samples: 2

**Called by:**
- `getRequestPathFromRequestURL` (1)
- `require` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3507` | Self: 0.4% (17.2ms) | Total: 0.4% (17.2ms) | Samples: 70

**Called by:**
- `parseQuery` (70)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3045` | Self: 0.3% (16.0ms) | Total: 0.3% (16.0ms) | Samples: 26

**Called by:**
- `BunRequest` (26)

### `isDisjoint`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.3% (15.8ms) | Total: 0.3% (15.8ms) | Samples: 44

**Called by:**
- `candidates` (44)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:21` | Self: 0.3% (15.8ms) | Total: 0.3% (15.8ms) | Samples: 38

### `set`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:290` | Self: 0.3% (15.7ms) | Total: 0.3% (16.0ms) | Samples: 71

**Called by:**
- `getMatchedLayers` (72)

**Calls:**
- `has` (1)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2997` | Self: 0.3% (15.7ms) | Total: 0.3% (15.7ms) | Samples: 24

**Called by:**
- `BunRequest` (24)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1203` | Self: 0.3% (14.8ms) | Total: 0.3% (15.1ms) | Samples: 52

**Called by:**
- `#runPipeline` (53)

**Calls:**
- `setResponse` (1)

### `importModule`
`[native code]` | Self: 0.3% (14.1ms) | Total: 0.3% (14.1ms) | Samples: 1

**Called by:**
- `async makeTarget` (1)

### `require`
`[native code]` | Self: 0.3% (13.7ms) | Total: 3.8% (165.1ms) | Samples: 3

**Called by:**
- `bound require` (208)

**Calls:**
- `anonymous` (204)
- `indexOf` (1)

### `lazyInspectModule`
`node:util` | Self: 0.3% (13.3ms) | Total: 0.3% (13.3ms) | Samples: 1

**Called by:**
- `get inspect` (1)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1340` | Self: 0.3% (13.2ms) | Total: 0.9% (39.2ms) | Samples: 41

**Called by:**
- `BunRequest` (127)

**Calls:**
- `alloc` (86)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:226` | Self: 0.3% (13.2ms) | Total: 0.3% (13.2ms) | Samples: 39

**Called by:**
- `getMatchedLayers` (39)

### `serveNativeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:404` | Self: 0.2% (12.7ms) | Total: 60.4% (2.59s) | Samples: 29

**Called by:**
- `(module)` (6027)
- `(anonymous)` (1739)
- `bound serveNativeRequest` (84)

**Calls:**
- `#routeRequest` (7138)
- `#routeRequest` (443)
- `#routeRequest` (106)
- `#routeRequest` (96)
- `#routeRequest` (19)
- `#respond` (6)
- `#produceResponse` (4)
- `#routeRequest` (4)
- `#routeRequest` (2)
- `#produceResponse` (1)
- `#routeRequest` (1)
- `#routeRequest` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5135` | Self: 0.2% (12.3ms) | Total: 0.2% (12.3ms) | Samples: 3

**Called by:**
- `#routeRequest` (3)

### `getRequestPathFromRequestURL`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4471` | Self: 0.2% (12.3ms) | Total: 0.2% (12.4ms) | Samples: 30

**Called by:**
- `getMatchedLayers` (30)
- `getMatchedLayers` (1)

**Calls:**
- `indexOf` (1)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1335` | Self: 0.2% (11.9ms) | Total: 0.2% (11.9ms) | Samples: 52

**Called by:**
- `BunRequest` (52)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4839` | Self: 0.2% (11.8ms) | Total: 0.2% (12.0ms) | Samples: 33

**Called by:**
- `dispatch` (34)

**Calls:**
- `matchBaseUrl` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.2% (11.7ms) | Total: 0.2% (11.7ms) | Samples: 15

**Called by:**
- `dispatch` (15)

### `/^\/r999\/([^\/]+?)\/?$/`
`[native code]` | Self: 0.2% (11.1ms) | Total: 0.2% (11.1ms) | Samples: 52

**Called by:**
- `matchRoute` (52)

### `node:stream/web`
`node:stream/web:8` | Self: 0.2% (10.7ms) | Total: 0.2% (10.7ms) | Samples: 1

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3533` | Self: 0.2% (10.5ms) | Total: 0.2% (10.5ms) | Samples: 36

**Called by:**
- `parseQuery` (36)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:440` | Self: 0.2% (10.3ms) | Total: 0.2% (10.3ms) | Samples: 19

**Called by:**
- `serveNativeRequest` (19)

### `matchRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.2% (10.2ms) | Total: 0.2% (10.2ms) | Samples: 30

**Called by:**
- `getMatchedLayers` (30)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:455` | Self: 0.2% (9.2ms) | Total: 54.2% (2.32s) | Samples: 17

**Called by:**
- `serveNativeRequest` (7138)

**Calls:**
- `dispatch` (4592)
- `#runPipeline` (2190)
- `#runPipeline` (217)
- `#runPipeline` (49)
- `dispatch` (29)
- `#runPipeline` (11)
- `#runPipeline` (10)
- `#runPipeline` (7)
- `#runPipeline` (3)
- `#runPipeline` (3)
- `#runPipeline` (2)
- `#finishPipeline` (2)
- `#runPipeline` (2)
- `#runPipeline` (1)
- `#runPipeline` (1)
- `#runPipeline` (1)
- `#finishPipeline` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3521` | Self: 0.2% (8.7ms) | Total: 0.2% (8.7ms) | Samples: 29

**Called by:**
- `parseQuery` (29)

### `serveNativeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:402` | Self: 0.2% (8.6ms) | Total: 21.1% (906.1ms) | Samples: 20

**Called by:**
- `(module)` (2088)
- `(anonymous)` (478)
- `bound serveNativeRequest` (40)

**Calls:**
- `init` (2582)
- `get requestOpts` (3)
- `get requestOpts` (1)

### `@lazy`
`[native code]` | Self: 0.2% (8.6ms) | Total: 0.2% (8.6ms) | Samples: 7

**Called by:**
- `internal:fs/binding` (3)
- `node:crypto` (2)
- `internal:util/mime` (1)
- `node:zlib` (1)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1331` | Self: 0.1% (8.5ms) | Total: 1.4% (61.5ms) | Samples: 17

**Called by:**
- `BunRequest` (186)

**Calls:**
- `get` (168)
- `get` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3042` | Self: 0.1% (8.1ms) | Total: 0.1% (8.1ms) | Samples: 38

**Called by:**
- `BunRequest` (38)

### `dispatch`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4984` | Self: 0.1% (7.8ms) | Total: 33.3% (1.43s) | Samples: 38

**Called by:**
- `#routeRequest` (4592)

**Calls:**
- `getMatchedLayers` (1390)
- `getMatchedLayers` (1254)
- `getMatchedLayers` (640)
- `getMatchedLayers` (636)
- `getMatchedLayers` (244)
- `getMatchedLayers` (173)
- `getMatchedLayers` (72)
- `getMatchedLayers` (38)
- `getMatchedLayers` (34)
- `getMatchedLayers` (33)
- `getMatchedLayers` (15)
- `getMatchedLayers` (10)
- `getMatchedLayers` (4)
- `getMatchedLayers` (3)
- `getMatchedLayers` (3)
- `getMatchedLayers` (3)
- `getMatchedLayers` (1)
- `getMatchedLayers` (1)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.1% (7.7ms) | Total: 0.1% (7.7ms) | Samples: 30

**Called by:**
- `BunRequest` (30)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4834` | Self: 0.1% (7.6ms) | Total: 0.1% (7.6ms) | Samples: 38

**Called by:**
- `dispatch` (38)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4914` | Self: 0.1% (7.0ms) | Total: 0.1% (7.0ms) | Samples: 33

**Called by:**
- `dispatch` (33)

### `matchRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4635` | Self: 0.1% (6.5ms) | Total: 0.1% (6.5ms) | Samples: 31

**Called by:**
- `getMatchedLayers` (31)

### `serveNativeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` | Self: 0.1% (6.4ms) | Total: 0.1% (6.4ms) | Samples: 3

**Called by:**
- `bound serveNativeRequest` (3)

### `isFunction`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` | Self: 0.1% (6.1ms) | Total: 0.1% (6.1ms) | Samples: 2

**Called by:**
- `getMatchedLayers` (2)

### `dispatch`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4988` | Self: 0.1% (6.0ms) | Total: 0.1% (6.0ms) | Samples: 29

**Called by:**
- `#routeRequest` (29)

### `send`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.1% (6.0ms) | Total: 0.1% (6.0ms) | Samples: 17

**Called by:**
- `#runPipeline` (17)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3530` | Self: 0.1% (5.6ms) | Total: 0.1% (5.6ms) | Samples: 28

**Called by:**
- `parseQuery` (28)

### `set`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:289` | Self: 0.1% (5.4ms) | Total: 0.1% (5.4ms) | Samples: 4

**Called by:**
- `getMatchedLayers` (4)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1336` | Self: 0.1% (5.0ms) | Total: 0.1% (5.0ms) | Samples: 24

**Called by:**
- `BunRequest` (24)

### `set`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:299` | Self: 0.1% (4.9ms) | Total: 0.1% (4.9ms) | Samples: 24

**Called by:**
- `getMatchedLayers` (24)

### `#writableOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1356` | Self: 0.1% (4.6ms) | Total: 1.2% (54.3ms) | Samples: 23

**Called by:**
- `BunRequest` (100)

**Calls:**
- `cloneObject` (77)

### `keys`
`[native code]` | Self: 0.1% (4.4ms) | Total: 0.1% (4.4ms) | Samples: 3

**Called by:**
- `populateMaps` (2)
- `populateMaps` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4774` | Self: 0.0% (4.2ms) | Total: 1.5% (66.0ms) | Samples: 4

**Called by:**
- `dispatch` (244)

**Calls:**
- `getRequestPathFromRequestURL` (210)
- `getRequestPathFromRequestURL` (30)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:231` | Self: 0.0% (4.2ms) | Total: 0.0% (4.2ms) | Samples: 2

**Called by:**
- `getMatchedLayers` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/lib/language.js:16` | Self: 0.0% (4.2ms) | Total: 0.0% (4.2ms) | Samples: 1

**Called by:**
- `anonymous` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3029` | Self: 0.0% (4.0ms) | Total: 0.0% (4.0ms) | Samples: 20

**Called by:**
- `BunRequest` (20)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:19` | Self: 0.0% (3.9ms) | Total: 0.0% (3.9ms) | Samples: 7

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:2` | Self: 0.0% (3.9ms) | Total: 0.0% (3.9ms) | Samples: 2

**Called by:**
- `#compileRouteRegExp` (2)

### `Map`
`[native code]` | Self: 0.0% (3.8ms) | Total: 0.0% (3.8ms) | Samples: 1

**Called by:**
- `Cache` (1)

### `set`
`[native code]` | Self: 0.0% (3.4ms) | Total: 0.0% (3.4ms) | Samples: 6

**Called by:**
- `define` (2)
- `set` (2)
- `define` (2)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5265` | Self: 0.0% (3.2ms) | Total: 0.0% (3.2ms) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:20` | Self: 0.0% (3.2ms) | Total: 92.6% (3.97s) | Samples: 14

**Calls:**
- `serveNativeRequest` (6027)
- `(anonymous)` (2218)
- `serveNativeRequest` (2088)
- `param-random` (1318)
- `bound serveNativeRequest` (127)
- `param-random` (2)
- `(anonymous)` (2)

### `splitPattern`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:55` | Self: 0.0% (3.2ms) | Total: 0.0% (3.2ms) | Samples: 3

**Called by:**
- `candidates` (3)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:42` | Self: 0.0% (3.2ms) | Total: 0.0% (3.2ms) | Samples: 1

**Called by:**
- `_preferredType` (1)

### `defineProperty`
`[native code]` | Self: 0.0% (3.1ms) | Total: 0.0% (3.1ms) | Samples: 2

**Called by:**
- `defineCustomPromisifyArgs` (1)
- `internal:fs/streams` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:85` | Self: 0.0% (2.9ms) | Total: 0.0% (2.9ms) | Samples: 9

### `Set`
`[native code]` | Self: 0.0% (2.9ms) | Total: 0.0% (2.9ms) | Samples: 2

**Called by:**
- `(module)` (1)
- `(module)` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4883` | Self: 0.0% (2.9ms) | Total: 0.0% (2.9ms) | Samples: 10

**Called by:**
- `dispatch` (10)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (2.9ms) | Total: 0.0% (2.9ms) | Samples: 4

**Called by:**
- `#runPipeline` (4)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (2.7ms) | Total: 0.0% (2.7ms) | Samples: 13

**Called by:**
- `getMatchedLayers` (13)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1214` | Self: 0.0% (2.5ms) | Total: 13.3% (572.8ms) | Samples: 10

**Called by:**
- `#runPipeline` (1586)

**Calls:**
- `Response` (1567)
- `set response` (4)
- `set response` (3)
- `set response` (1)
- `set response` (1)

### `map`
`[native code]` | Self: 0.0% (2.5ms) | Total: 0.0% (3.9ms) | Samples: 3

**Called by:**
- `#build` (3)
- `#compileRouteRegExp` (2)
- `node:zlib` (1)
- `define` (1)
- `compileRoute` (1)
- `node:zlib` (1)

**Calls:**
- `(anonymous)` (2)
- `compileRoute` (1)
- `compileRoute` (1)
- `segmentKind` (1)
- `compileRoute` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1003` | Self: 0.0% (2.5ms) | Total: 0.0% (2.5ms) | Samples: 2

**Called by:**
- `registerExpressStyle` (2)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:17` | Self: 0.0% (2.4ms) | Total: 0.0% (2.4ms) | Samples: 2

**Called by:**
- `Mime` (2)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:970` | Self: 0.0% (2.3ms) | Total: 0.0% (2.6ms) | Samples: 2

**Called by:**
- `#respondWithText` (3)

**Calls:**
- `emitFinish` (1)

### `Uint32Array`
`[native code]` | Self: 0.0% (2.3ms) | Total: 0.0% (2.3ms) | Samples: 1

**Called by:**
- `node:zlib` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5006` | Self: 0.0% (2.1ms) | Total: 0.0% (2.1ms) | Samples: 11

**Called by:**
- `#routeRequest` (11)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3044` | Self: 0.0% (2.1ms) | Total: 0.0% (2.1ms) | Samples: 10

**Called by:**
- `BunRequest` (10)

### `(anonymous)`
`internal:freelist` | Self: 0.0% (2.0ms) | Total: 0.0% (2.0ms) | Samples: 1

**Called by:**
- `FreeList` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:20` | Self: 0.0% (2.0ms) | Total: 0.0% (2.0ms) | Samples: 2

**Called by:**
- `setRoute` (2)

### `(unknown)`
`[native code]` | Self: 0.0% (2.0ms) | Total: 0.0% (2.0ms) | Samples: 9

### `registerExpressStyle`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:177` | Self: 0.0% (1.9ms) | Total: 1.0% (47.0ms) | Samples: 1

**Called by:**
- `async makeTarget` (42)

**Calls:**
- `setRoute` (29)
- `setRoute` (2)
- `get` (2)
- `addRoute` (2)
- `setRoute` (2)
- `setRoute` (1)
- `setRoute` (1)
- `setRoute` (1)
- `get` (1)

### `decodeParam`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:117` | Self: 0.0% (1.8ms) | Total: 2.8% (123.2ms) | Samples: 9

**Called by:**
- `matchRoute` (413)

**Calls:**
- `decodeURIComponent` (404)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:185` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 2

**Called by:**
- `forEach` (2)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2991` | Self: 0.0% (1.7ms) | Total: 0.0% (2.1ms) | Samples: 9

**Called by:**
- `BunRequest` (11)

**Calls:**
- `#configuredQueryOpts` (2)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (1.6ms) | Total: 0.0% (1.6ms) | Samples: 8

**Called by:**
- `BunRequest` (8)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1299` | Self: 0.0% (1.6ms) | Total: 0.0% (1.8ms) | Samples: 4

**Called by:**
- `init` (5)

**Calls:**
- `#configuredCookieSecrets` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1062` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 1

**Called by:**
- `registerExpressStyle` (1)

### `RegExp`
`[native code]` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 6

**Called by:**
- `pathRegex` (4)
- `(module)` (2)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1075` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `addRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1249` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 2

**Called by:**
- `registerExpressStyle` (2)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5009` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 7

**Called by:**
- `#routeRequest` (7)

### `get headersSent`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` | Self: 0.0% (1.4ms) | Total: 0.0% (1.9ms) | Samples: 7

**Called by:**
- `send` (3)
- `#finishPipeline` (2)
- `#settleLayer` (2)
- `layerFinished` (1)
- `#runPipeline` (1)

**Calls:**
- `get response` (1)
- `get upgradeToWsData` (1)

### `set`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:296` | Self: 0.0% (1.4ms) | Total: 0.0% (1.4ms) | Samples: 6

**Called by:**
- `getMatchedLayers` (6)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:38` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `setPrototypeDirectOrThrow`
`[native code]` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 3

**Called by:**
- `internal:primordials` (1)
- `node:zlib` (1)
- `node:diagnostics_channel` (1)

### `#respond`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:487` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 6

**Called by:**
- `serveNativeRequest` (6)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1332` | Self: 0.0% (1.2ms) | Total: 0.4% (21.0ms) | Samples: 6

**Called by:**
- `BunRequest` (96)

**Calls:**
- `get` (90)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2501` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `parse`
`/home/user/bun-node/node_modules/picoquery/lib/parse.js` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 3

**Called by:**
- `(module)` (3)

### `defineProperties`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `internal:streams/writable` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:18` | Self: 0.0% (977us) | Total: 0.0% (977us) | Samples: 5

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:237` | Self: 0.0% (969us) | Total: 0.4% (19.2ms) | Samples: 4

**Called by:**
- `getMatchedLayers` (57)

**Calls:**
- `isDisjoint` (44)
- `isDisjoint` (4)
- `isDisjoint` (2)
- `isDisjoint` (1)
- `isDisjoint` (1)
- `isDisjoint` (1)

### `uncurryThis`
`internal:primordials` | Self: 0.0% (850us) | Total: 0.0% (850us) | Samples: 2

**Called by:**
- `internal:primordials` (1)
- `internal:util/inspect` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (823us) | Total: 0.0% (823us) | Samples: 3

**Called by:**
- `BunRequest` (3)

### `isDisjoint`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:129` | Self: 0.0% (822us) | Total: 0.0% (822us) | Samples: 4

**Called by:**
- `candidates` (4)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:951` | Self: 0.0% (790us) | Total: 0.0% (790us) | Samples: 4

**Called by:**
- `#respondWithText` (4)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4924` | Self: 0.0% (785us) | Total: 0.0% (785us) | Samples: 4

**Called by:**
- `dispatch` (4)

### `WeakSet`
`[native code]` | Self: 0.0% (783us) | Total: 0.0% (783us) | Samples: 1

**Called by:**
- `(module)` (1)

### `#produceResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:555` | Self: 0.0% (783us) | Total: 0.0% (783us) | Samples: 4

**Called by:**
- `serveNativeRequest` (4)

### `delete`
`[native code]` | Self: 0.0% (783us) | Total: 0.0% (783us) | Samples: 4

**Called by:**
- `set` (4)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4930` | Self: 0.0% (771us) | Total: 4.3% (185.6ms) | Samples: 4

**Called by:**
- `dispatch` (636)

**Calls:**
- `set` (407)
- `set` (117)
- `set` (72)
- `set` (24)
- `set` (6)
- `set` (4)
- `set` (2)

### `assign`
`[native code]` | Self: 0.0% (765us) | Total: 0.0% (765us) | Samples: 1

**Called by:**
- `node:crypto` (1)

### `populateMaps`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` | Self: 0.0% (763us) | Total: 0.0% (763us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `get requestOpts`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` | Self: 0.0% (761us) | Total: 0.0% (761us) | Samples: 3

**Called by:**
- `serveNativeRequest` (3)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:681` | Self: 0.0% (745us) | Total: 0.0% (745us) | Samples: 1

**Called by:**
- `BunResponse` (1)

### `node:zlib`
`node:zlib:12` | Self: 0.0% (702us) | Total: 0.0% (702us) | Samples: 1

### `exec`
`[native code]` | Self: 0.0% (693us) | Total: 0.0% (693us) | Samples: 3

**Called by:**
- `matchRoute` (2)
- `bound call` (1)

### `(anonymous)`
`[native code]` | Self: 0.0% (686us) | Total: 0.0% (1.9ms) | Samples: 2

**Called by:**
- `useColors` (6)
- `node:zlib` (1)
- `bound require` (1)

**Calls:**
- `WriteStream` (3)
- `WriteStream` (2)
- `WriteStream` (1)

### `_freeze`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:71` | Self: 0.0% (683us) | Total: 0.0% (683us) | Samples: 1

**Called by:**
- `(module)` (1)

### `get size`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:276` | Self: 0.0% (660us) | Total: 0.0% (660us) | Samples: 1

**Called by:**
- `setRoute` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1256` | Self: 0.0% (642us) | Total: 1.2% (54.9ms) | Samples: 3

**Called by:**
- `init` (103)

**Calls:**
- `#writableOptions` (100)

### `add`
`[native code]` | Self: 0.0% (631us) | Total: 0.0% (631us) | Samples: 2

**Called by:**
- `define` (1)
- `#respondWithText` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:446` | Self: 0.0% (625us) | Total: 0.5% (23.2ms) | Samples: 3

**Called by:**
- `serveNativeRequest` (106)

**Calls:**
- `originalUrl` (100)
- `originalUrl` (3)

### `node:crypto`
`node:crypto:109` | Self: 0.0% (621us) | Total: 0.0% (621us) | Samples: 3

### `originalUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3699` | Self: 0.0% (612us) | Total: 0.0% (612us) | Samples: 3

**Called by:**
- `#routeRequest` (3)

### `isDisjoint`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:115` | Self: 0.0% (598us) | Total: 0.0% (598us) | Samples: 1

**Called by:**
- `candidates` (1)

### `useColors`
`/home/user/bun-node/node_modules/debug/src/node.js` | Self: 0.0% (588us) | Total: 0.0% (588us) | Samples: 1

**Called by:**
- `createDebug` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/compression.ts:245` | Self: 0.0% (574us) | Total: 0.0% (574us) | Samples: 1

**Called by:**
- `filter` (1)

### `splitPattern`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (573us) | Total: 0.0% (573us) | Samples: 1

**Called by:**
- `candidates` (1)

### `(anonymous)`
`node:zlib` | Self: 0.0% (569us) | Total: 0.0% (569us) | Samples: 2

**Called by:**
- `map` (2)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4789` | Self: 0.0% (544us) | Total: 0.0% (544us) | Samples: 3

**Called by:**
- `dispatch` (3)

### `bound`
`node:os` | Self: 0.0% (536us) | Total: 0.0% (536us) | Samples: 1

**Called by:**
- `node:os` (1)

### `send`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1409` | Self: 0.0% (512us) | Total: 0.0% (512us) | Samples: 2

**Called by:**
- `#runPipeline` (2)

### `normalizeEtagOption`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (484us) | Total: 0.0% (484us) | Samples: 2

**Called by:**
- `BunResponse` (2)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1019` | Self: 0.0% (455us) | Total: 0.0% (650us) | Samples: 1

**Called by:**
- `registerExpressStyle` (2)

**Calls:**
- `routes` (1)

### `(anonymous)`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` | Self: 0.0% (453us) | Total: 0.0% (453us) | Samples: 2

**Called by:**
- `(module)` (2)

### `(module)`
`/home/user/bun-node/node_modules/mime/dist/types/standard.js:365` | Self: 0.0% (449us) | Total: 0.0% (449us) | Samples: 1

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` | Self: 0.0% (449us) | Total: 0.0% (449us) | Samples: 2

**Called by:**
- `setRoute` (2)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` | Self: 0.0% (446us) | Total: 0.0% (446us) | Samples: 1

**Called by:**
- `async makeTarget` (1)

### `isDisjoint`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:141` | Self: 0.0% (444us) | Total: 0.0% (444us) | Samples: 1

**Called by:**
- `candidates` (1)

### `__classPrivateFieldGet`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js` | Self: 0.0% (436us) | Total: 0.0% (436us) | Samples: 2

**Called by:**
- `define` (1)
- `define` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js` | Self: 0.0% (435us) | Total: 0.0% (435us) | Samples: 1

**Called by:**
- `Mime` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4798` | Self: 0.0% (430us) | Total: 0.0% (430us) | Samples: 1

**Called by:**
- `dispatch` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4857` | Self: 0.0% (426us) | Total: 0.0% (426us) | Samples: 1

**Called by:**
- `dispatch` (1)

### `forEach`
`[native code]` | Self: 0.0% (425us) | Total: 0.1% (7.2ms) | Samples: 2

**Called by:**
- `populateMaps` (7)
- `populateMaps` (6)

**Calls:**
- `forEachMimeType` (3)
- `forEachMimeType` (2)
- `forEachMimeType` (2)
- `forEachMimeType` (2)
- `forEachMimeType` (1)
- `forEachMimeType` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:422` | Self: 0.0% (424us) | Total: 0.0% (424us) | Samples: 2

**Called by:**
- `serveNativeRequest` (2)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3502` | Self: 0.0% (422us) | Total: 0.0% (422us) | Samples: 2

**Called by:**
- `parseQuery` (2)

### `bound require`
`[native code]` | Self: 0.0% (422us) | Total: 4.0% (172.6ms) | Samples: 1

**Called by:**
- `(anonymous)` (32)
- `(anonymous)` (30)
- `(anonymous)` (27)
- `(anonymous)` (18)
- `(anonymous)` (15)
- `(anonymous)` (14)
- `(anonymous)` (12)
- `(anonymous)` (9)
- `(anonymous)` (8)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(module)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `require` (208)
- `anonymous` (14)
- `(anonymous)` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:164` | Self: 0.0% (421us) | Total: 0.0% (421us) | Samples: 2

**Called by:**
- `forEach` (2)

### `internal:shared`
`internal:shared:33` | Self: 0.0% (418us) | Total: 0.0% (418us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3546` | Self: 0.0% (416us) | Total: 0.0% (416us) | Samples: 2

**Called by:**
- `parseQuery` (2)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2488` | Self: 0.0% (411us) | Total: 0.0% (411us) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `set`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (410us) | Total: 0.0% (410us) | Samples: 2

**Called by:**
- `getMatchedLayers` (2)

### `#canSkipHeaders`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:571` | Self: 0.0% (409us) | Total: 0.7% (33.8ms) | Samples: 2

**Called by:**
- `#respondWithText` (129)

**Calls:**
- `method` (127)

### `(anonymous)`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:86` | Self: 0.0% (405us) | Total: 15.1% (649.2ms) | Samples: 1

**Called by:**
- `(module)` (2218)

**Calls:**
- `serveNativeRequest` (1739)
- `serveNativeRequest` (478)

### `__classPrivateFieldGet`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:4` | Self: 0.0% (404us) | Total: 0.0% (404us) | Samples: 2

**Called by:**
- `define` (2)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1343` | Self: 0.0% (402us) | Total: 0.0% (402us) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `get upgradeToWsData`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (400us) | Total: 0.0% (400us) | Samples: 2

**Called by:**
- `get headersSent` (1)
- `headersSent` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5066` | Self: 0.0% (398us) | Total: 0.0% (398us) | Samples: 2

**Called by:**
- `#routeRequest` (2)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4790` | Self: 0.0% (398us) | Total: 0.0% (584us) | Samples: 2

**Called by:**
- `dispatch` (3)

**Calls:**
- `routes` (1)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` | Self: 0.0% (397us) | Total: 4.4% (190.9ms) | Samples: 2

**Called by:**
- `BunRequest` (694)

**Calls:**
- `splitRequestUrl` (243)
- `splitRequestUrl` (156)
- `splitRequestUrl` (70)
- `splitRequestUrl` (68)
- `splitRequestUrl` (53)
- `splitRequestUrl` (36)
- `splitRequestUrl` (29)
- `splitRequestUrl` (28)
- `splitRequestUrl` (2)
- `splitRequestUrl` (2)
- `splitRequestUrl` (1)
- `splitRequestUrl` (1)
- `splitRequestUrl` (1)
- `splitRequestUrl` (1)
- `splitRequestUrl` (1)

### `Agent`
`node:_http_agent` | Self: 0.0% (396us) | Total: 0.0% (396us) | Samples: 2

**Called by:**
- `node:_http_agent` (2)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1699` | Self: 0.0% (395us) | Total: 0.0% (395us) | Samples: 2

**Called by:**
- `registerExpressStyle` (2)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3031` | Self: 0.0% (394us) | Total: 0.0% (394us) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `makeSafe`
`internal:primordials:32` | Self: 0.0% (393us) | Total: 0.0% (393us) | Samples: 1

**Called by:**
- `internal:primordials` (1)

### `normalizeEtagOption`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:393` | Self: 0.0% (392us) | Total: 0.0% (392us) | Samples: 2

**Called by:**
- `BunResponse` (2)

### `WriteStream`
`internal:fs/streams` | Self: 0.0% (392us) | Total: 0.0% (392us) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `EventEmitter`
`node:events` | Self: 0.0% (388us) | Total: 0.0% (388us) | Samples: 2

**Called by:**
- `Agent` (1)
- `(anonymous)` (1)

### `param-random`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` | Self: 0.0% (383us) | Total: 0.0% (383us) | Samples: 2

**Called by:**
- `(module)` (2)

### `node:zlib`
`node:zlib:541` | Self: 0.0% (381us) | Total: 0.0% (381us) | Samples: 2

### `routes`
`/home/user/bun-node/node_modules/@routejs/router/src/router.mjs` | Self: 0.0% (381us) | Total: 0.0% (381us) | Samples: 2

**Called by:**
- `getMatchedLayers` (1)
- `setRoute` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:159` | Self: 0.0% (380us) | Total: 0.0% (380us) | Samples: 2

**Called by:**
- `forEach` (2)

### `getHeader`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (379us) | Total: 0.0% (379us) | Samples: 2

**Called by:**
- `parseCookies` (2)

### `isDisjoint`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:119` | Self: 0.0% (376us) | Total: 0.0% (376us) | Samples: 2

**Called by:**
- `candidates` (2)

### `_preferredTypeLegacy`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:202` | Self: 0.0% (376us) | Total: 0.0% (376us) | Samples: 1

**Called by:**
- `forEachMimeType` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (372us) | Total: 0.0% (372us) | Samples: 2

**Called by:**
- `#routeRequest` (2)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:30` | Self: 0.0% (369us) | Total: 0.0% (369us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `isBoolean`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:158` | Self: 0.0% (367us) | Total: 0.0% (367us) | Samples: 1

**Called by:**
- `parseCookies` (1)

### `from`
`[native code]` | Self: 0.0% (362us) | Total: 0.0% (770us) | Samples: 2

**Called by:**
- `(module)` (2)
- `(module)` (2)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `split`
`[native code]` | Self: 0.0% (310us) | Total: 0.0% (310us) | Samples: 1

**Called by:**
- `mimeScore` (1)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:215` | Self: 0.0% (306us) | Total: 0.0% (306us) | Samples: 1

**Called by:**
- `getMatchedLayers` (1)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1697` | Self: 0.0% (283us) | Total: 0.0% (283us) | Samples: 1

**Called by:**
- `registerExpressStyle` (1)

### `get response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:946` | Self: 0.0% (267us) | Total: 0.0% (267us) | Samples: 1

**Called by:**
- `get headersSent` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js` | Self: 0.0% (260us) | Total: 0.0% (260us) | Samples: 1

**Called by:**
- `filter` (1)

### `Writable`
`internal:streams/writable` | Self: 0.0% (257us) | Total: 0.0% (257us) | Samples: 1

**Called by:**
- `WriteStream` (1)

### `setResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3736` | Self: 0.0% (255us) | Total: 0.0% (255us) | Samples: 1

**Called by:**
- `#respondWithText` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1120` | Self: 0.0% (253us) | Total: 0.0% (253us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `getOwnPropertyNames`
`[native code]` | Self: 0.0% (250us) | Total: 0.0% (250us) | Samples: 1

**Called by:**
- `internal:util/inspect` (1)

### `set params`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (247us) | Total: 0.0% (247us) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `decodeParam`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (239us) | Total: 0.0% (239us) | Samples: 1

**Called by:**
- `matchRoute` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3549` | Self: 0.0% (236us) | Total: 0.0% (236us) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:834` | Self: 0.0% (234us) | Total: 0.0% (234us) | Samples: 1

### `normalizeCatchAllPath`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (232us) | Total: 0.0% (232us) | Samples: 1

**Called by:**
- `setRoute` (1)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:700` | Self: 0.0% (232us) | Total: 0.0% (418us) | Samples: 1

**Called by:**
- `#routeRequest` (2)

**Calls:**
- `setResponse` (1)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (231us) | Total: 0.0% (231us) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `_addListener`
`node:events` | Self: 0.0% (231us) | Total: 0.0% (231us) | Samples: 1

**Called by:**
- `addListener` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/linkedlist/index.mjs:5` | Self: 0.0% (229us) | Total: 0.0% (229us) | Samples: 1

**Called by:**
- `LinkedList` (1)

### `extractWildcardNames`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (226us) | Total: 0.0% (226us) | Samples: 1

**Called by:**
- `setRoute` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/types/multipart.js:221` | Self: 0.0% (226us) | Total: 0.0% (226us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `internal:validators`
`internal:validators:69` | Self: 0.0% (225us) | Total: 0.0% (225us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `supportsColor`
`/home/user/bun-node/node_modules/supports-color/index.js` | Self: 0.0% (223us) | Total: 0.0% (223us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:47` | Self: 0.0% (222us) | Total: 0.0% (222us) | Samples: 1

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:19` | Self: 0.0% (222us) | Total: 0.0% (1.5ms) | Samples: 1

**Called by:**
- `Mime` (2)

**Calls:**
- `map` (1)

### `internal:streams/readable`
`internal:streams/readable:737` | Self: 0.0% (222us) | Total: 0.0% (222us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `#build`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (221us) | Total: 0.0% (221us) | Samples: 1

**Called by:**
- `candidates` (1)

### `use`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (220us) | Total: 0.0% (220us) | Samples: 1

**Called by:**
- `registerExpressStyle` (1)

### `(module)`
`/home/user/bun-node/node_modules/mime/dist/types/other.js:718` | Self: 0.0% (220us) | Total: 0.0% (220us) | Samples: 1

### `matchRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4679` | Self: 0.0% (219us) | Total: 2.8% (123.6ms) | Samples: 1

**Called by:**
- `getMatchedLayers` (413)
- `set` (2)

**Calls:**
- `decodeParam` (413)
- `decodeParam` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/types/multipart.js:27` | Self: 0.0% (219us) | Total: 0.0% (219us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3046` | Self: 0.0% (219us) | Total: 0.0% (219us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `copyObject`
`internal:fs/streams:33` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

**Called by:**
- `WriteStream` (1)

### `matchRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4703` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

**Called by:**
- `getMatchedLayers` (1)

### `copyProps`
`internal:primordials` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

**Called by:**
- `makeSafe` (1)

### `internal:streams/destroy`
`internal:streams/destroy:16` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `_freeze`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

**Called by:**
- `(module)` (1)

### `defineColorAlias`
`internal:util/inspect` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

**Called by:**
- `internal:util/inspect` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1039` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `Channel`
`node:diagnostics_channel` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `channel` (1)

### `node:_http_agent`
`node:_http_agent:129` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:25` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `Mime` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/uint8array-extras/index.js:178` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `from` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:431` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5129` | Self: 0.0% (213us) | Total: 0.0% (684us) | Samples: 1

**Called by:**
- `#routeRequest` (3)

**Calls:**
- `layerFinished` (2)

### `every`
`[native code]` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `resolveLogger` (1)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5247` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `useColors`
`/home/user/bun-node/node_modules/debug/src/node.js:158` | Self: 0.0% (212us) | Total: 0.0% (1.4ms) | Samples: 1

**Called by:**
- `createDebug` (7)

**Calls:**
- `(anonymous)` (6)

### `has`
`[native code]` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `set` (1)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:352` | Self: 0.0% (211us) | Total: 0.0% (400us) | Samples: 1

**Called by:**
- `async makeTarget` (2)

**Calls:**
- `BunWebSocket` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3511` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `get legacyQueryOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1388` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `#configuredQueryOpts` (1)

### `SafeSet`
`internal:primordials` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `internal:util/inspect` (1)

### `Symbol`
`[native code]` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `(module)` (1)

### `get host`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `get hasDeferredBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2838` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `#finishPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `node:fs/promises`
`node:fs/promises:142` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

### `test`
`[native code]` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `segmentKind` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:476` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunValidate.ts:141` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

### `internal:url`
`internal:url:23` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `mergeBunRequestOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `set requestOpts` (1)

### `node:_http_outgoing`
`node:_http_outgoing:65` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `internal:primordials`
`internal:primordials:76` | Self: 0.0% (207us) | Total: 0.0% (818us) | Samples: 1

**Called by:**
- `anonymous` (3)

**Calls:**
- `makeSafe` (1)
- `makeSafe` (1)

### `get method`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` | Self: 0.0% (207us) | Total: 0.0% (207us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1308` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `init` (1)

### `node:_http_outgoing`
`node:_http_outgoing:45` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/has-flag/index.js` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3548` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `Stream`
`internal:streams/legacy` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `Writable` (1)

### `isArray`
`[native code]` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `normalizeParseBodyOptions` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:28` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4910` | Self: 0.0% (205us) | Total: 0.1% (6.3ms) | Samples: 1

**Called by:**
- `dispatch` (3)

**Calls:**
- `isFunction` (2)

### `(anonymous)`
`internal:http:4` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `internal:http` (1)

### `StructuredLogger`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:181` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `createLogger` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1246` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `init` (1)

### `#compileRouteRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:194` | Self: 0.0% (204us) | Total: 0.6% (29.8ms) | Samples: 1

**Called by:**
- `Route` (22)

**Calls:**
- `pathRegex` (13)
- `pathRegex` (4)
- `pathRegex` (2)
- `pathRegex` (1)
- `pathRegex` (1)

### `setName`
`node:fs:696` | Self: 0.0% (204us) | Total: 0.0% (204us) | Samples: 1

**Called by:**
- `node:fs` (1)

### `node:_http_server`
`node:_http_server:1690` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `map` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:23` | Self: 0.0% (202us) | Total: 0.0% (796us) | Samples: 1

**Called by:**
- `Mime` (3)

**Calls:**
- `get` (1)
- `__classPrivateFieldGet` (1)

### `emitFinish`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:797` | Self: 0.0% (202us) | Total: 0.0% (202us) | Samples: 1

**Called by:**
- `set response` (1)

### `resolveLogger`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts` | Self: 0.0% (202us) | Total: 0.0% (202us) | Samples: 1

**Called by:**
- `BunHttpAdapter` (1)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5222` | Self: 0.0% (202us) | Total: 0.0% (202us) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `node:events`
`node:events:651` | Self: 0.0% (201us) | Total: 0.0% (201us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `#configuredCookieSecrets`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (201us) | Total: 0.0% (201us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `node:zlib`
`node:zlib:478` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3503` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `__classPrivateFieldGet`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:3` | Self: 0.0% (198us) | Total: 0.0% (198us) | Samples: 1

**Called by:**
- `define` (1)

### `#configuredQueryOpts`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1368` | Self: 0.0% (198us) | Total: 0.0% (409us) | Samples: 1

**Called by:**
- `parseQuery` (2)

**Calls:**
- `get legacyQueryOptions` (1)

### `isBoolean`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:169` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

**Called by:**
- `RouteCandidateIndex` (1)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:45` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `_preferredType` (1)

### `promisify2`
`internal:promisify` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `(module)` (1)

### `internal:streams/transform`
`internal:streams/transform:2` | Self: 0.0% (196us) | Total: 0.2% (10.6ms) | Samples: 1

**Called by:**
- `anonymous` (40)

**Calls:**
- `anonymous` (39)

### `#produceResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `matchBaseUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `getMatchedLayers` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:87` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `map` (1)

### `entries`
`[native code]` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `(module)` (1)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `#respondWithText` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:651` | Self: 0.0% (194us) | Total: 0.0% (194us) | Samples: 1

**Called by:**
- `BunResponse` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/picoquery/lib/string-util.js` | Self: 0.0% (194us) | Total: 0.0% (194us) | Samples: 1

**Called by:**
- `from` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1254` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `init` (1)

### `node:stream/web`
`node:stream/web:13` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:241` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `getMatchedLayers` (1)

### `filter`
`[native code]` | Self: 0.0% (192us) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)
- `(module)` (1)
- `(anonymous)` (1)
- `bound call` (1)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:170` | Self: 0.0% (191us) | Total: 0.0% (191us) | Samples: 1

**Called by:**
- `forEach` (1)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:953` | Self: 0.0% (191us) | Total: 0.0% (191us) | Samples: 1

**Called by:**
- `#respondWithText` (1)

### `call`
`[native code]` | Self: 0.0% (191us) | Total: 0.0% (191us) | Samples: 1

**Called by:**
- `bound call` (1)

### `flushPending`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (191us) | Total: 0.0% (191us) | Samples: 1

**Called by:**
- `use` (1)

### `registerExpressStyle`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:176` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `async makeTarget` (1)

### `Router`
`/home/user/bun-node/node_modules/@routejs/router/src/router.mjs` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `BunRouter` (1)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2494` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `slice`
`[native code]` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `define` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5134` | Self: 0.0% (189us) | Total: 0.1% (7.2ms) | Samples: 1

**Called by:**
- `#routeRequest` (10)

**Calls:**
- `#settleLayer` (4)
- `#settleLayer` (2)
- `#settleLayer` (1)
- `#settleLayer` (1)
- `#settleLayer` (1)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:238` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `getMatchedLayers` (1)

### `BunWebSocket`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `BunHttpAdapter` (1)

### `get requestOpts`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:733` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `internal:streams/duplexpair`
`internal:streams/duplexpair:4` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `setResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (186us) | Total: 0.0% (186us) | Samples: 1

**Called by:**
- `BunResponse` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:593` | Self: 0.0% (186us) | Total: 0.0% (186us) | Samples: 1

**Called by:**
- `BunResponse` (1)

### `BunRouter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (185us) | Total: 0.0% (185us) | Samples: 1

**Called by:**
- `BunHttpAdapter` (1)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (185us) | Total: 0.0% (185us) | Samples: 1

**Called by:**
- `getMatchedLayers` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1271` | Self: 0.0% (185us) | Total: 3.2% (140.6ms) | Samples: 1

**Called by:**
- `init` (490)

**Calls:**
- `#finishAbsentBody` (186)
- `#finishAbsentBody` (127)
- `#finishAbsentBody` (96)
- `#finishAbsentBody` (52)
- `#finishAbsentBody` (24)
- `#finishAbsentBody` (2)
- `#finishAbsentBody` (2)

### `isObject`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` | Self: 0.0% (185us) | Total: 0.0% (185us) | Samples: 1

**Called by:**
- `mergeBunRequestOptions` (1)

### `isDisjoint`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:117` | Self: 0.0% (183us) | Total: 0.0% (183us) | Samples: 1

**Called by:**
- `candidates` (1)

### `setUint32`
`[native code]` | Self: 0.0% (182us) | Total: 0.0% (182us) | Samples: 1

**Called by:**
- `put` (1)

### `WritableState`
`internal:streams/writable` | Self: 0.0% (182us) | Total: 0.0% (182us) | Samples: 1

**Called by:**
- `Writable` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/parse-domain/dist/sanitize.js` | Self: 0.0% (181us) | Total: 0.0% (181us) | Samples: 1

**Called by:**
- `(module)` (1)

### `bound`
`node:os:107` | Self: 0.0% (181us) | Total: 0.0% (181us) | Samples: 1

**Called by:**
- `node:os` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (181us) | Total: 0.0% (181us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1209` | Self: 0.0% (181us) | Total: 0.7% (34.0ms) | Samples: 1

**Called by:**
- `#runPipeline` (130)

**Calls:**
- `#canSkipHeaders` (129)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1031` | Self: 0.0% (178us) | Total: 0.8% (37.7ms) | Samples: 1

**Called by:**
- `registerExpressStyle` (29)
- `flushPending` (2)

**Calls:**
- `Route` (24)
- `Route` (2)
- `Route` (2)
- `Route` (2)

### `isObject`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:179` | Self: 0.0% (177us) | Total: 0.0% (177us) | Samples: 1

**Called by:**
- `normalizeParseBodyOptions` (1)

### `init`
`/home/user/bun-node/node_modules/debug/src/node.js` | Self: 0.0% (174us) | Total: 0.0% (174us) | Samples: 1

**Called by:**
- `createDebug` (1)

### `channel`
`node:diagnostics_channel:141` | Self: 0.0% (0us) | Total: 0.0% (215us) | Samples: 0

**Called by:**
- `node:_http_client` (1)

**Calls:**
- `Channel` (1)

### `internal:validators`
`internal:validators:2` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `anonymous` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-db/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (4.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `set requestOpts`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:742` | Self: 0.0% (0us) | Total: 0.0% (393us) | Samples: 0

**Called by:**
- `BunHttpAdapter` (2)

**Calls:**
- `mergeBunRequestOptions` (1)
- `mergeBunRequestOptions` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/accepts/index.js:16` | Self: 0.0% (0us) | Total: 0.4% (20.1ms) | Samples: 0

**Calls:**
- `bound require` (27)

### `internal:http`
`internal:http:7` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:255` | Self: 0.0% (0us) | Total: 0.0% (192us) | Samples: 0

**Called by:**
- `BunHttpAdapter` (1)

**Calls:**
- `EventEmitter` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:13` | Self: 0.0% (0us) | Total: 0.3% (14.1ms) | Samples: 0

**Calls:**
- `async makeTarget` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:169` | Self: 0.0% (0us) | Total: 0.0% (3.7ms) | Samples: 0

**Called by:**
- `forEach` (3)

**Calls:**
- `_preferredType` (3)

### `node:crypto`
`node:crypto:65` | Self: 0.0% (0us) | Total: 0.0% (182us) | Samples: 0

**Calls:**
- `anonymous` (1)

### `WriteStream`
`internal:fs/streams:201` | Self: 0.0% (0us) | Total: 0.0% (218us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `copyObject` (1)

### `node:_http_agent`
`node:_http_agent:290` | Self: 0.0% (0us) | Total: 0.0% (823us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `Agent` (2)
- `Agent` (1)
- `Agent` (1)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2502` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Called by:**
- `BunRequest` (1)

**Calls:**
- `isArray` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:35` | Self: 0.0% (0us) | Total: 0.0% (198us) | Samples: 0

**Called by:**
- `Mime` (1)

**Calls:**
- `__classPrivateFieldGet` (1)

### `internal:errors`
`internal:errors:2` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `anonymous` (8)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:457` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `parse` (3)

### `internal:util/mime`
`internal:util/mime:2` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `@lazy` (1)

### `internal:primordials`
`internal:primordials:54` | Self: 0.0% (0us) | Total: 0.0% (196us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `uncurryThis` (1)

### `node:zlib`
`node:zlib:385` | Self: 0.0% (0us) | Total: 0.0% (2.3ms) | Samples: 0

**Calls:**
- `Uint32Array` (1)

### `segmentKind`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:71` | Self: 0.0% (0us) | Total: 0.0% (208us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `test` (1)

### `resolveLogger`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:1044` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Called by:**
- `set logger` (1)

**Calls:**
- `every` (1)

### `internal:streams/duplex`
`internal:streams/duplex:2` | Self: 0.0% (0us) | Total: 0.2% (10.2ms) | Samples: 0

**Called by:**
- `anonymous` (38)

**Calls:**
- `anonymous` (38)

### `node:_http_server`
`node:_http_server:16` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5260` | Self: 0.0% (0us) | Total: 0.0% (431us) | Samples: 0

**Called by:**
- `#runPipeline` (2)

**Calls:**
- `get headersSent` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/index.js:3` | Self: 0.0% (0us) | Total: 0.3% (14.9ms) | Samples: 0

**Calls:**
- `bound require` (6)

### `BunRouter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:889` | Self: 0.0% (0us) | Total: 0.0% (387us) | Samples: 0

**Called by:**
- `BunHttpAdapter` (2)

**Calls:**
- `Router` (1)
- `(anonymous)` (1)

### `node:util`
`node:util:8` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `originalUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` | Self: 0.0% (0us) | Total: 0.5% (22.0ms) | Samples: 0

**Called by:**
- `#routeRequest` (100)

**Calls:**
- `splitRequestUrl` (100)

### `(module)`
`/home/user/bun-node/node_modules/file-type/source/index.js:1913` | Self: 0.0% (0us) | Total: 0.0% (393us) | Samples: 0

**Calls:**
- `Set` (1)

### `node:_http_agent`
`node:_http_agent:2` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `anonymous` (5)

### `node:zlib`
`node:zlib:456` | Self: 0.0% (0us) | Total: 0.0% (353us) | Samples: 0

**Calls:**
- `map` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/node_modules/mime-db/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `anonymous` (14)

**Calls:**
- `bound require` (14)

### `defineCustomPromisifyArgs`
`node:fs:304` | Self: 0.0% (0us) | Total: 0.0% (2.9ms) | Samples: 0

**Called by:**
- `node:fs` (1)

**Calls:**
- `defineProperty` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/supports-color/index.js:9` | Self: 0.0% (0us) | Total: 0.0% (206us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:218` | Self: 0.0% (0us) | Total: 4.5% (195.2ms) | Samples: 0

**Called by:**
- `getMatchedLayers` (627)

**Calls:**
- `splitRequestPath` (614)
- `splitPattern` (9)
- `splitPattern` (3)
- `splitPattern` (1)

### `host`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3577` | Self: 0.0% (0us) | Total: 0.6% (26.7ms) | Samples: 0

**Called by:**
- `#routeRequest` (3)

**Calls:**
- `splitRequestUrl` (2)
- `splitRequestUrl` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:242` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `#compileRouteRegExp` (4)

**Calls:**
- `RegExp` (4)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/general.ts:31` | Self: 0.0% (0us) | Total: 0.0% (196us) | Samples: 0

**Calls:**
- `promisify2` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1239` | Self: 0.0% (0us) | Total: 0.0% (197us) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `isBoolean` (1)

### `(module)`
`/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:11` | Self: 0.0% (0us) | Total: 0.0% (182us) | Samples: 0

**Calls:**
- `signatureToArray` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:17` | Self: 0.0% (0us) | Total: 0.0% (812us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/accepts/index.js:15` | Self: 0.0% (0us) | Total: 0.9% (41.7ms) | Samples: 0

**Calls:**
- `bound require` (32)

### `node:_http_incoming`
`node:_http_incoming:15` | Self: 0.0% (0us) | Total: 0.0% (422us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (2)

### `internal:fs/binding`
`internal:fs/binding:3` | Self: 0.0% (0us) | Total: 0.1% (5.0ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `@lazy` (3)

### `#build`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:185` | Self: 0.0% (0us) | Total: 0.0% (606us) | Samples: 0

**Called by:**
- `candidates` (3)

**Calls:**
- `map` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:32` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `#finishPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5314` | Self: 0.0% (0us) | Total: 0.0% (421us) | Samples: 0

**Called by:**
- `#routeRequest` (2)

**Calls:**
- `get headersSent` (2)

### `internal:streams/writable`
`internal:streams/writable:493` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `defineProperties` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-types/index.js:15` | Self: 0.0% (0us) | Total: 0.1% (7.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `set logger`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:931` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Called by:**
- `BunHttpAdapter` (1)

**Calls:**
- `resolveLogger` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `node:tty`
`node:tty:7` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `anonymous` (5)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:20` | Self: 0.0% (0us) | Total: 0.0% (621us) | Samples: 0

**Called by:**
- `Mime` (3)

**Calls:**
- `__classPrivateFieldGet` (2)
- `__classPrivateFieldGet` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:14` | Self: 0.0% (0us) | Total: 0.1% (4.4ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`internal:util/inspect:46` | Self: 0.0% (0us) | Total: 0.0% (187us) | Samples: 0

**Called by:**
- `filter` (1)

**Calls:**
- `bound call` (1)

### `createLogger`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:299` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `StructuredLogger` (1)

### `node:path`
`node:path:2` | Self: 0.0% (0us) | Total: 0.1% (5.3ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `anonymous` (9)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (3.1ms) | Samples: 0

**Called by:**
- `anonymous` (15)

**Calls:**
- `bound require` (15)

### `node:crypto`
`node:crypto:2` | Self: 0.0% (0us) | Total: 0.4% (18.5ms) | Samples: 0

**Calls:**
- `anonymous` (43)

### `bound serveNativeRequest`
`[native code]` | Self: 0.0% (0us) | Total: 1.2% (52.0ms) | Samples: 0

**Called by:**
- `(module)` (127)

**Calls:**
- `serveNativeRequest` (84)
- `serveNativeRequest` (40)
- `serveNativeRequest` (3)

### `get inspect`
`node:util:481` | Self: 0.0% (0us) | Total: 0.4% (17.4ms) | Samples: 0

**Calls:**
- `lazyInspectModule` (18)
- `lazyInspectModule` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:67` | Self: 0.0% (0us) | Total: 0.0% (3.8ms) | Samples: 0

**Called by:**
- `Route` (1)

**Calls:**
- `Map` (1)

### `send`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1396` | Self: 0.0% (0us) | Total: 0.0% (586us) | Samples: 0

**Called by:**
- `#runPipeline` (3)

**Calls:**
- `get headersSent` (3)

### `node:fs`
`node:fs:306` | Self: 0.0% (0us) | Total: 0.0% (2.9ms) | Samples: 0

**Calls:**
- `defineCustomPromisifyArgs` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-types/index.js:40` | Self: 0.0% (0us) | Total: 0.0% (2.9ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `populateMaps` (8)

### `node:zlib`
`node:zlib:449` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Calls:**
- `map` (1)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:40` | Self: 0.0% (0us) | Total: 0.0% (310us) | Samples: 0

**Called by:**
- `_preferredType` (1)

**Calls:**
- `split` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:28` | Self: 0.0% (0us) | Total: 0.0% (423us) | Samples: 0

**Called by:**
- `Mime` (1)

**Calls:**
- `add` (1)

### `populateMaps`
`/home/user/bun-node/node_modules/mime-types/index.js:158` | Self: 0.0% (0us) | Total: 0.0% (2.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (8)

**Calls:**
- `forEach` (7)
- `keys` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5037` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `#routeRequest` (1)

**Calls:**
- `get hasDeferredBody` (1)

### `internal:streams/compose`
`internal:streams/compose:2` | Self: 0.0% (0us) | Total: 0.0% (631us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `FreeList`
`internal:freelist:9` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `node:_http_common` (1)

**Calls:**
- `(anonymous)` (1)

### `use`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4238` | Self: 0.0% (0us) | Total: 0.0% (866us) | Samples: 0

**Called by:**
- `registerExpressStyle` (4)

**Calls:**
- `flushPending` (3)
- `flushPending` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-types/index.js:16` | Self: 0.0% (0us) | Total: 0.1% (5.3ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/types/urlencoded.js:3` | Self: 0.0% (0us) | Total: 0.0% (481us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `Writable`
`internal:streams/writable:196` | Self: 0.0% (0us) | Total: 0.0% (206us) | Samples: 0

**Called by:**
- `WriteStream` (1)

**Calls:**
- `Stream` (1)

### `createDebug`
`/home/user/bun-node/node_modules/debug/src/common.js:143` | Self: 0.0% (0us) | Total: 0.0% (174us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `init` (1)

### `node:zlib`
`node:zlib:2` | Self: 0.0% (0us) | Total: 0.0% (3.6ms) | Samples: 0

**Calls:**
- `anonymous` (10)
- `@lazy` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:303` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Calls:**
- `createLogger` (1)

### `bound call`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (565us) | Samples: 0

**Called by:**
- `makeSafe` (1)
- `internal:util/inspect` (1)
- `(anonymous)` (1)

**Calls:**
- `call` (1)
- `filter` (1)
- `exec` (1)

### `internal:primordials`
`internal:primordials:83` | Self: 0.0% (0us) | Total: 0.0% (191us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `makeSafe` (1)

### `Mime`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:13` | Self: 0.0% (0us) | Total: 0.1% (7.7ms) | Samples: 0

**Called by:**
- `(module)` (19)

**Calls:**
- `define` (3)
- `define` (3)
- `define` (2)
- `define` (2)
- `define` (2)
- `define` (2)
- `define` (1)
- `define` (1)
- `define` (1)
- `define` (1)
- `define` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:194` | Self: 0.0% (0us) | Total: 0.0% (623us) | Samples: 0

**Calls:**
- `bound require` (2)

### `node:fs/promises`
`node:fs/promises:2` | Self: 0.0% (0us) | Total: 0.1% (5.0ms) | Samples: 0

**Calls:**
- `anonymous` (3)

### `internal:streams/lazy_transform`
`internal:streams/lazy_transform:2` | Self: 0.0% (0us) | Total: 0.2% (10.9ms) | Samples: 0

**Called by:**
- `anonymous` (41)

**Calls:**
- `anonymous` (41)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:86` | Self: 0.0% (0us) | Total: 0.0% (208us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `map` (1)

### `WriteStream`
`internal:fs/streams:259` | Self: 0.0% (0us) | Total: 0.0% (645us) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `Writable` (1)
- `Writable` (1)
- `Writable` (1)

### `internal:stream`
`internal:stream:48` | Self: 0.0% (0us) | Total: 0.0% (187us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `node:http`
`node:http:2` | Self: 0.0% (0us) | Total: 0.3% (16.5ms) | Samples: 0

**Calls:**
- `anonymous` (63)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:174` | Self: 0.0% (0us) | Total: 0.0% (376us) | Samples: 0

**Called by:**
- `forEach` (1)

**Calls:**
- `_preferredTypeLegacy` (1)

### `node:_http_common`
`node:_http_common:2` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `anonymous` (6)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:800` | Self: 0.0% (0us) | Total: 0.0% (197us) | Samples: 0

**Called by:**
- `BunRouter` (1)

**Calls:**
- `RouteCandidateIndex` (1)

### `headersSent`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` | Self: 0.0% (0us) | Total: 0.0% (204us) | Samples: 0

**Called by:**
- `layerFinished` (1)

**Calls:**
- `get upgradeToWsData` (1)

### `#compileRouteRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `Route` (2)

**Calls:**
- `map` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/index.js:44` | Self: 0.0% (0us) | Total: 0.0% (192us) | Samples: 0

**Calls:**
- `filter` (1)

### `flushPending`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4223` | Self: 0.0% (0us) | Total: 0.0% (675us) | Samples: 0

**Called by:**
- `use` (3)

**Calls:**
- `setRoute` (2)
- `setRoute` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5013` | Self: 0.0% (0us) | Total: 0.0% (249us) | Samples: 0

**Called by:**
- `#routeRequest` (1)

**Calls:**
- `get headersSent` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/index.js:41` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Calls:**
- `bound require` (12)

### `internal:stream`
`internal:stream:2` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `anonymous` (6)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:331` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `resolveLogger` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1015` | Self: 0.0% (0us) | Total: 0.0% (226us) | Samples: 0

**Called by:**
- `flushPending` (1)

**Calls:**
- `extractWildcardNames` (1)

### `(module)`
`/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` | Self: 0.0% (0us) | Total: 0.0% (376us) | Samples: 0

**Calls:**
- `from` (2)

### `lazyInspectModule`
`node:util:17` | Self: 0.0% (0us) | Total: 0.0% (4.1ms) | Samples: 0

**Called by:**
- `get inspect` (18)

**Calls:**
- `anonymous` (18)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:11` | Self: 0.0% (0us) | Total: 0.1% (4.8ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `splitRequestPath`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:66` | Self: 0.0% (0us) | Total: 4.4% (189.4ms) | Samples: 0

**Called by:**
- `candidates` (614)

**Calls:**
- `splitPattern` (614)

### `mergeBunRequestOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:321` | Self: 0.0% (0us) | Total: 0.0% (185us) | Samples: 0

**Called by:**
- `set requestOpts` (1)

**Calls:**
- `isObject` (1)

### `internal:streams/legacy`
`internal:streams/legacy:2` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `anonymous` (8)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:57` | Self: 0.0% (0us) | Total: 0.7% (31.0ms) | Samples: 0

**Called by:**
- `setRoute` (24)

**Calls:**
- `#compileRouteRegExp` (22)
- `#compileRouteRegExp` (2)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:696` | Self: 0.0% (0us) | Total: 0.0% (876us) | Samples: 0

**Called by:**
- `#routeRequest` (4)

**Calls:**
- `normalizeEtagOption` (2)
- `normalizeEtagOption` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:12` | Self: 0.0% (0us) | Total: 0.1% (4.6ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `makeSafe`
`internal:primordials:35` | Self: 0.0% (0us) | Total: 0.0% (191us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `bound call` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:79` | Self: 0.0% (0us) | Total: 0.3% (14.1ms) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `importModule` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:30` | Self: 0.0% (0us) | Total: 0.0% (395us) | Samples: 0

**Called by:**
- `Mime` (2)

**Calls:**
- `set` (2)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:66` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `Route` (1)

**Calls:**
- `LinkedList` (1)

### `(module)`
`/home/user/bun-node/node_modules/ip-regex/index.js:25` | Self: 0.0% (0us) | Total: 0.0% (383us) | Samples: 0

**Calls:**
- `RegExp` (2)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2511` | Self: 0.0% (0us) | Total: 0.0% (177us) | Samples: 0

**Called by:**
- `BunRequest` (1)

**Calls:**
- `isObject` (1)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:216` | Self: 0.0% (0us) | Total: 0.0% (827us) | Samples: 0

**Called by:**
- `getMatchedLayers` (4)

**Calls:**
- `#build` (3)
- `#build` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/types/multipart.js:5` | Self: 0.0% (0us) | Total: 0.0% (662us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/multipart/stream.ts:4` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Calls:**
- `promisify2` (1)

### `RouteCandidateIndex`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (197us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `internal:streams/add-abort-signal`
`internal:streams/add-abort-signal:2` | Self: 0.0% (0us) | Total: 0.0% (778us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `anonymous` (4)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:346` | Self: 0.0% (0us) | Total: 0.0% (393us) | Samples: 0

**Called by:**
- `async makeTarget` (2)

**Calls:**
- `set requestOpts` (2)

### `node:crypto`
`node:crypto:350` | Self: 0.0% (0us) | Total: 0.0% (765us) | Samples: 0

**Calls:**
- `assign` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:16` | Self: 0.0% (0us) | Total: 0.3% (14.0ms) | Samples: 0

**Calls:**
- `bound require` (30)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` | Self: 0.0% (0us) | Total: 0.0% (204us) | Samples: 0

**Called by:**
- `#finishAbsentBody` (1)

**Calls:**
- `splitRequestUrl` (1)

### `Writable`
`internal:streams/writable:181` | Self: 0.0% (0us) | Total: 0.0% (182us) | Samples: 0

**Called by:**
- `WriteStream` (1)

**Calls:**
- `WritableState` (1)

### `makeSafe`
`internal:primordials:53` | Self: 0.0% (0us) | Total: 0.0% (218us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `copyProps` (1)

### `registerExpressStyle`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:169` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `async makeTarget` (5)

**Calls:**
- `use` (4)
- `use` (1)

### `(module)`
`/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:9` | Self: 0.0% (0us) | Total: 0.0% (2.2ms) | Samples: 0

**Calls:**
- `createDebug` (8)
- `createDebug` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:418` | Self: 0.0% (0us) | Total: 0.0% (783us) | Samples: 0

**Calls:**
- `WeakSet` (1)

### `node:zlib`
`node:zlib:161` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `internal:util/inspect`
`internal:util/inspect:392` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `defineColorAlias` (1)

### `promisify2`
`internal:promisify:17` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `get` (1)

### `Agent`
`node:_http_agent:22` | Self: 0.0% (0us) | Total: 0.0% (231us) | Samples: 0

**Called by:**
- `node:_http_agent` (1)

**Calls:**
- `addListener` (1)

### `(module)`
`/home/user/bun-node/node_modules/@borewit/text-codec/lib/index.js:9` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Calls:**
- `entries` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/supports-color/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5062` | Self: 0.0% (0us) | Total: 0.0% (247us) | Samples: 0

**Called by:**
- `#routeRequest` (1)

**Calls:**
- `set params` (1)

### `node:stream`
`node:stream:2` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (10)

**Calls:**
- `anonymous` (10)

### `(module)`
`/home/user/bun-node/node_modules/parse-domain/dist/sanitize.js:33` | Self: 0.0% (0us) | Total: 0.0% (181us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `node:_http_common`
`node:_http_common:62` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `FreeList` (1)

### `internal:streams/readable`
`internal:streams/readable:14` | Self: 0.0% (0us) | Total: 0.0% (181us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:124` | Self: 0.0% (0us) | Total: 0.0% (260us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `filter` (1)

### `signatureToArray`
`/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:6` | Self: 0.0% (0us) | Total: 0.0% (182us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `put` (1)

### `node:diagnostics_channel`
`node:diagnostics_channel:17` | Self: 0.0% (0us) | Total: 0.0% (467us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `setPrototypeDirectOrThrow` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/compression.ts:240` | Self: 0.0% (0us) | Total: 0.0% (574us) | Samples: 0

**Calls:**
- `filter` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Calls:**
- `bound require` (5)

### `node:events`
`node:events:10` | Self: 0.0% (0us) | Total: 0.0% (209us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:442` | Self: 0.0% (0us) | Total: 0.6% (26.9ms) | Samples: 0

**Called by:**
- `serveNativeRequest` (4)

**Calls:**
- `host` (3)
- `get host` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:80` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Calls:**
- `BunHttpAdapter` (4)
- `BunHttpAdapter` (2)
- `BunHttpAdapter` (2)
- `BunHttpAdapter` (1)
- `BunHttpAdapter` (1)
- `BunHttpAdapter` (1)

### `addListener`
`node:events:214` | Self: 0.0% (0us) | Total: 0.0% (231us) | Samples: 0

**Called by:**
- `Agent` (1)

**Calls:**
- `_addListener` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:17` | Self: 0.0% (0us) | Total: 0.1% (4.3ms) | Samples: 0

**Calls:**
- `bound require` (3)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:84` | Self: 0.0% (0us) | Total: 1.1% (48.3ms) | Samples: 0

**Calls:**
- `registerExpressStyle` (42)
- `registerExpressStyle` (5)
- `registerExpressStyle` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/supports-color/index.js:133` | Self: 0.0% (0us) | Total: 0.0% (223us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `supportsColor` (1)

### `populateMaps`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:155` | Self: 0.0% (0us) | Total: 0.2% (8.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (8)

**Calls:**
- `forEach` (6)
- `keys` (2)

### `(module)`
`/home/user/bun-node/node_modules/uint8array-extras/index.js:178` | Self: 0.0% (0us) | Total: 0.0% (394us) | Samples: 0

**Calls:**
- `from` (2)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:54` | Self: 0.0% (0us) | Total: 0.3% (14.1ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `async makeTarget` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/index.js:9` | Self: 0.0% (0us) | Total: 0.4% (21.3ms) | Samples: 0

**Calls:**
- `bound require` (18)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:333` | Self: 0.0% (0us) | Total: 0.0% (764us) | Samples: 0

**Called by:**
- `async makeTarget` (4)

**Calls:**
- `BunRouter` (2)
- `(anonymous)` (1)
- `BunRouter` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1076` | Self: 0.0% (0us) | Total: 0.0% (660us) | Samples: 0

**Called by:**
- `registerExpressStyle` (1)

**Calls:**
- `get size` (1)

### `node:crypto`
`node:crypto:39` | Self: 0.0% (0us) | Total: 0.0% (430us) | Samples: 0

**Calls:**
- `@lazy` (2)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:84` | Self: 0.0% (0us) | Total: 0.0% (4.0ms) | Samples: 0

**Called by:**
- `setRoute` (2)

**Calls:**
- `Cache` (1)
- `Cache` (1)

### `internal:stream`
`internal:stream:47` | Self: 0.0% (0us) | Total: 0.0% (211us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `layerFinished`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:598` | Self: 0.0% (0us) | Total: 0.0% (471us) | Samples: 0

**Called by:**
- `#runPipeline` (2)

**Calls:**
- `get headersSent` (1)
- `headersSent` (1)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:350` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `set logger` (1)

### `internal:streams/readable`
`internal:streams/readable:2` | Self: 0.0% (0us) | Total: 0.0% (3.8ms) | Samples: 0

**Called by:**
- `anonymous` (18)

**Calls:**
- `anonymous` (18)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4782` | Self: 0.0% (0us) | Total: 4.7% (203.0ms) | Samples: 0

**Called by:**
- `dispatch` (640)

**Calls:**
- `get` (638)
- `get` (1)
- `get` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3026` | Self: 0.0% (0us) | Total: 0.0% (367us) | Samples: 0

**Called by:**
- `BunRequest` (1)

**Calls:**
- `isBoolean` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1012` | Self: 0.0% (0us) | Total: 0.0% (232us) | Samples: 0

**Called by:**
- `registerExpressStyle` (1)

**Calls:**
- `normalizeCatchAllPath` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:27` | Self: 0.0% (0us) | Total: 0.0% (189us) | Samples: 0

**Called by:**
- `Mime` (1)

**Calls:**
- `slice` (1)

### `node:fs`
`node:fs:739` | Self: 0.0% (0us) | Total: 0.0% (204us) | Samples: 0

**Calls:**
- `setName` (1)

### `node:_http_client`
`node:_http_client:39` | Self: 0.0% (0us) | Total: 0.0% (230us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:42` | Self: 0.0% (0us) | Total: 0.2% (9.4ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `populateMaps` (8)
- `populateMaps` (1)

### `_preferredType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:189` | Self: 0.0% (0us) | Total: 0.0% (3.7ms) | Samples: 0

**Called by:**
- `forEachMimeType` (3)

**Calls:**
- `mimeScore` (1)
- `mimeScore` (1)
- `mimeScore` (1)

### `internal:util/inspect`
`internal:util/inspect:46` | Self: 0.0% (0us) | Total: 0.0% (647us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `SafeSet` (1)
- `getOwnPropertyNames` (1)
- `bound call` (1)

### `node:os`
`node:os:110` | Self: 0.0% (0us) | Total: 0.0% (717us) | Samples: 0

**Calls:**
- `bound` (1)
- `bound` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:13` | Self: 0.0% (0us) | Total: 0.2% (9.9ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `createDebug`
`/home/user/bun-node/node_modules/debug/src/common.js:117` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `(module)` (8)

**Calls:**
- `useColors` (7)
- `useColors` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:21` | Self: 0.0% (0us) | Total: 0.0% (435us) | Samples: 0

**Called by:**
- `Mime` (2)

**Calls:**
- `set` (2)

### `LinkedList`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `Cache` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:473` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Calls:**
- `Symbol` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:2053` | Self: 0.0% (0us) | Total: 0.0% (2.5ms) | Samples: 0

**Calls:**
- `Set` (1)

### `internal:util/inspect`
`internal:util/inspect:9` | Self: 0.0% (0us) | Total: 0.0% (654us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `uncurryThis` (1)

### `node:zlib`
`node:zlib:451` | Self: 0.0% (0us) | Total: 0.0% (643us) | Samples: 0

**Calls:**
- `setPrototypeDirectOrThrow` (1)

### `internal:primordials`
`internal:primordials:88` | Self: 0.0% (0us) | Total: 0.0% (192us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `setPrototypeDirectOrThrow` (1)

### `(module)`
`/home/user/bun-node/node_modules/mime/dist/src/index.js:5` | Self: 0.0% (0us) | Total: 0.2% (8.6ms) | Samples: 0

**Calls:**
- `Mime` (19)
- `_freeze` (1)
- `_freeze` (1)

### `Agent`
`node:_http_agent:10` | Self: 0.0% (0us) | Total: 0.0% (196us) | Samples: 0

**Called by:**
- `node:_http_agent` (1)

**Calls:**
- `EventEmitter` (1)

### `get`
`internal:stream:69` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `promisify2` (1)

**Calls:**
- `anonymous` (1)

### `put`
`/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/lib/index.js:87` | Self: 0.0% (0us) | Total: 0.0% (182us) | Samples: 0

**Called by:**
- `signatureToArray` (1)

**Calls:**
- `setUint32` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:443` | Self: 0.0% (0us) | Total: 0.5% (23.8ms) | Samples: 0

**Called by:**
- `serveNativeRequest` (96)

**Calls:**
- `method` (95)
- `get method` (1)

### `internal:streams/destroy`
`internal:streams/destroy:2` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `anonymous` (8)

### `internal:fs/streams`
`internal:fs/streams:90` | Self: 0.0% (0us) | Total: 0.0% (200us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `defineProperty` (1)

### `node:_http_client`
`node:_http_client:10` | Self: 0.0% (0us) | Total: 0.1% (7.2ms) | Samples: 0

**Called by:**
- `anonymous` (25)

**Calls:**
- `anonymous` (24)
- `channel` (1)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 31.3% | 1.34s | `[native code]` |
| 18.9% | 815.0ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 17.2% | 739.3ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 16.4% | 705.9ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 4.8% | 209.4ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 4.7% | 203.9ms | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 2.1% | 94.1ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 1.2% | 55.0ms | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts` |
| 0.6% | 28.4ms | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs` |
| 0.5% | 23.9ms | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts` |
| 0.3% | 13.3ms | `node:util` |
| 0.2% | 10.9ms | `node:stream/web` |
| 0.1% | 7.0ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.1% | 5.4ms | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 4.2ms | `/home/user/bun-node/node_modules/negotiator/lib/language.js` |
| 0.0% | 3.4ms | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js` |
| 0.0% | 2.6ms | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 2.3ms | `/home/user/bun-node/node_modules/mime-types/index.js` |
| 0.0% | 2.0ms | `internal:freelist` |
| 0.0% | 1.8ms | `internal:primordials` |
| 0.0% | 1.8ms | `node:zlib` |
| 0.0% | 1.5ms | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` |
| 0.0% | 1.2ms | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 1.0ms | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 820us | `node:events` |
| 0.0% | 717us | `node:os` |
| 0.0% | 629us | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts` |
| 0.0% | 621us | `node:crypto` |
| 0.0% | 611us | `node:_http_agent` |
| 0.0% | 610us | `internal:fs/streams` |
| 0.0% | 574us | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/compression.ts` |
| 0.0% | 571us | `/home/user/bun-node/node_modules/@routejs/router/src/router.mjs` |
| 0.0% | 449us | `/home/user/bun-node/node_modules/mime/dist/types/standard.js` |
| 0.0% | 445us | `/home/user/bun-node/node_modules/busboy/lib/types/multipart.js` |
| 0.0% | 439us | `internal:streams/writable` |
| 0.0% | 418us | `internal:shared` |
| 0.0% | 414us | `node:_http_outgoing` |
| 0.0% | 229us | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/linkedlist/index.mjs` |
| 0.0% | 225us | `internal:validators` |
| 0.0% | 223us | `/home/user/bun-node/node_modules/supports-color/index.js` |
| 0.0% | 222us | `internal:streams/readable` |
| 0.0% | 220us | `/home/user/bun-node/node_modules/mime/dist/types/other.js` |
| 0.0% | 218us | `internal:streams/destroy` |
| 0.0% | 216us | `internal:util/inspect` |
| 0.0% | 215us | `node:diagnostics_channel` |
| 0.0% | 214us | `/home/user/bun-node/node_modules/uint8array-extras/index.js` |
| 0.0% | 208us | `internal:url` |
| 0.0% | 208us | `node:fs/promises` |
| 0.0% | 208us | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunValidate.ts` |
| 0.0% | 206us | `internal:streams/legacy` |
| 0.0% | 206us | `/home/user/bun-node/node_modules/has-flag/index.js` |
| 0.0% | 205us | `internal:http` |
| 0.0% | 205us | `/home/user/bun-node/node_modules/type-is/index.js` |
| 0.0% | 204us | `node:fs` |
| 0.0% | 203us | `node:_http_server` |
| 0.0% | 196us | `internal:streams/transform` |
| 0.0% | 196us | `internal:promisify` |
| 0.0% | 194us | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js` |
| 0.0% | 189us | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts` |
| 0.0% | 187us | `internal:streams/duplexpair` |
| 0.0% | 181us | `/home/user/bun-node/node_modules/parse-domain/dist/sanitize.js` |
