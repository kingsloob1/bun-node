# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 6.50s | 815 | 200us | 369 |

**Top 10:** `write` 19.1%, `Response` 18.7%, `BunRequest` 6.7%, `BunResponse` 5.4%, `data` 4.7%, `splitRequestUrl` 3.7%, `BunRequest` 3.7%, `serveNativeRequest` 2.6%, `#respondWithText` 2.5%, `(anonymous)` 2.2%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 19.1% | 1.24s | 19.1% | 1.24s | `write` | `[native code]` |
| 18.7% | 1.22s | 18.7% | 1.22s | `Response` | `[native code]` |
| 6.7% | 441.6ms | 6.7% | 441.6ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1231` |
| 5.4% | 354.7ms | 7.6% | 498.4ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` |
| 4.7% | 307.9ms | 4.8% | 317.5ms | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:78` |
| 3.7% | 246.4ms | 3.7% | 246.4ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3506` |
| 3.7% | 246.4ms | 11.6% | 759.2ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1267` |
| 2.6% | 174.0ms | 28.1% | 1.83s | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:402` |
| 2.5% | 167.3ms | 3.8% | 248.5ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1213` |
| 2.2% | 143.7ms | 2.2% | 143.7ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:514` |
| 2.1% | 140.0ms | 2.1% | 140.0ms | `method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 1.8% | 123.4ms | 1.8% | 123.4ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4777` |
| 1.8% | 118.4ms | 1.8% | 118.4ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` |
| 1.7% | 113.8ms | 1.7% | 113.8ms | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:83` |
| 1.4% | 97.5ms | 1.4% | 97.5ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3520` |
| 1.4% | 97.3ms | 1.4% | 97.3ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3541` |
| 1.3% | 89.2ms | 1.3% | 89.2ms | `get` | `[native code]` |
| 1.2% | 82.0ms | 2.8% | 184.9ms | `anonymous` | `[native code]` |
| 1.2% | 81.7ms | 1.2% | 81.7ms | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:281` |
| 1.1% | 78.0ms | 18.8% | 1.22s | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1214` |
| 1.1% | 75.8ms | 1.1% | 75.8ms | `alloc` | `[native code]` |
| 1.1% | 74.4ms | 1.1% | 74.4ms | `params` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1706` |
| 1.0% | 66.2ms | 1.3% | 91.0ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1306` |
| 0.8% | 53.2ms | 0.8% | 53.2ms | `toString` | `[native code]` |
| 0.6% | 44.8ms | 0.7% | 47.7ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4470` |
| 0.5% | 38.4ms | 0.5% | 38.4ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4471` |
| 0.5% | 36.2ms | 0.5% | 36.2ms | `Promise` | `[native code]` |
| 0.5% | 35.8ms | 5.3% | 345.5ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4984` |
| 0.4% | 29.9ms | 0.4% | 29.9ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3546` |
| 0.4% | 28.2ms | 0.4% | 28.2ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4988` |
| 0.4% | 26.6ms | 0.4% | 26.6ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3521` |
| 0.3% | 25.8ms | 41.4% | 2.69s | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:404` |
| 0.3% | 24.1ms | 0.3% | 24.1ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1335` |
| 0.3% | 20.9ms | 0.3% | 22.8ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:440` |
| 0.2% | 19.0ms | 0.2% | 19.0ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.2% | 18.7ms | 8.2% | 538.6ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:437` |
| 0.2% | 17.1ms | 0.2% | 17.1ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:136` |
| 0.2% | 15.5ms | 1.2% | 81.2ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1332` |
| 0.2% | 15.3ms | 0.2% | 17.6ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1261` |
| 0.2% | 14.8ms | 0.2% | 14.8ms | `#respond` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:498` |
| 0.1% | 12.5ms | 0.1% | 12.5ms | `indexOf` | `[native code]` |
| 0.1% | 12.4ms | 0.1% | 12.4ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3540` |
| 0.1% | 12.1ms | 23.1% | 1.50s | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5102` |
| 0.1% | 11.8ms | 1.3% | 87.7ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1340` |
| 0.1% | 11.2ms | 0.1% | 11.2ms | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:80` |
| 0.1% | 9.4ms | 0.1% | 9.4ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1343` |
| 0.1% | 8.7ms | 0.1% | 8.7ms | `repeat` | `[native code]` |
| 0.1% | 7.2ms | 0.1% | 7.2ms | `@lazy` | `[native code]` |
| 0.1% | 7.0ms | 0.1% | 7.0ms | `node:zlib` | `node:zlib:2` |
| 0.1% | 6.5ms | 0.1% | 6.5ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5006` |
| 0.1% | 6.5ms | 0.1% | 6.5ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4479` |
| 0.0% | 6.0ms | 0.0% | 6.0ms | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:970` |
| 0.0% | 6.0ms | 0.2% | 18.3ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3040` |
| 0.0% | 5.5ms | 0.0% | 5.5ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3042` |
| 0.0% | 5.0ms | 1.3% | 88.4ms | `require` | `[native code]` |
| 0.0% | 4.4ms | 0.0% | 4.4ms | `RegExp` | `[native code]` |
| 0.0% | 4.2ms | 0.1% | 12.5ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1256` |
| 0.0% | 4.1ms | 0.0% | 4.1ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:181` |
| 0.0% | 3.7ms | 0.0% | 3.7ms | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1359` |
| 0.0% | 3.6ms | 0.0% | 3.6ms | `isBoolean` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 3.6ms | 0.0% | 3.6ms | `Mime` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 3.3ms | 0.0% | 3.3ms | `cloneObject` | `[native code]` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `node:fs` | `node:fs:289` |
| 0.0% | 3.1ms | 0.0% | 3.1ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 2.5ms | 0.0% | 2.5ms | `node:stream/web` | `node:stream/web:14` |
| 0.0% | 2.5ms | 0.0% | 2.5ms | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:27` |
| 0.0% | 2.1ms | 0.1% | 6.7ms | `map` | `[native code]` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `get method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `normalizeEtagOption` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:393` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `promisify2` | `internal:promisify` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `importModule` | `[native code]` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `get instance` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `median` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts` |
| 0.0% | 1.7ms | 0.0% | 4.0ms | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:169` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2511` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `get originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `end` | `[native code]` |
| 0.0% | 1.4ms | 0.1% | 11.4ms | `forEach` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:156` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `split` | `[native code]` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4775` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3507` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `get method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 987us | 0.0% | 987us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:160` |
| 0.0% | 956us | 0.0% | 956us | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1336` |
| 0.0% | 916us | 1.4% | 93.6ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4774` |
| 0.0% | 912us | 0.0% | 1.3ms | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:174` |
| 0.0% | 883us | 0.0% | 883us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:422` |
| 0.0% | 880us | 0.0% | 880us | `bound` | `node:os` |
| 0.0% | 865us | 0.0% | 865us | `create` | `[native code]` |
| 0.0% | 845us | 0.0% | 845us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:99` |
| 0.0% | 842us | 0.0% | 842us | `keys` | `[native code]` |
| 0.0% | 827us | 0.0% | 827us | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1203` |
| 0.0% | 822us | 0.0% | 822us | `charCodeAt` | `[native code]` |
| 0.0% | 818us | 0.0% | 818us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 779us | 0.0% | 1.6ms | `(anonymous)` | `[native code]` |
| 0.0% | 769us | 0.0% | 769us | `add` | `[native code]` |
| 0.0% | 766us | 0.0% | 766us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 757us | 0.0% | 757us | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 714us | 0.0% | 714us | `get isKeepAlive` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1764` |
| 0.0% | 692us | 0.0% | 1.1ms | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1011` |
| 0.0% | 676us | 0.0% | 676us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:25` |
| 0.0% | 655us | 0.0% | 655us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 632us | 0.0% | 632us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1012` |
| 0.0% | 631us | 0.0% | 631us | `_preferredType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` |
| 0.0% | 619us | 0.0% | 619us | `hasMethods` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts` |
| 0.0% | 610us | 0.0% | 610us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:950` |
| 0.0% | 608us | 0.0% | 608us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:87` |
| 0.0% | 600us | 0.0% | 600us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:170` |
| 0.0% | 592us | 0.0% | 592us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3026` |
| 0.0% | 505us | 0.0% | 505us | `hideFromStack` | `internal:shared` |
| 0.0% | 504us | 0.0% | 504us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:19` |
| 0.0% | 502us | 0.0% | 502us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:151` |
| 0.0% | 495us | 0.0% | 495us | `set` | `[native code]` |
| 0.0% | 489us | 0.0% | 489us | `Request` | `[native code]` |
| 0.0% | 488us | 0.0% | 488us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:247` |
| 0.0% | 475us | 0.0% | 475us | `internal:streams/destroy` | `internal:streams/destroy:16` |
| 0.0% | 465us | 0.0% | 465us | `supportsColor` | `/home/user/bun-node/node_modules/supports-color/index.js` |
| 0.0% | 463us | 0.0% | 463us | `replace` | `[native code]` |
| 0.0% | 460us | 0.0% | 460us | `extractWildcardNames` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:242` |
| 0.0% | 459us | 0.0% | 459us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:44` |
| 0.0% | 457us | 0.0% | 457us | `node:http` | `node:http:5` |
| 0.0% | 457us | 0.0% | 457us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:173` |
| 0.0% | 456us | 0.0% | 456us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 456us | 0.0% | 456us | `reduce` | `[native code]` |
| 0.0% | 446us | 0.0% | 446us | `isFunction` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 444us | 0.0% | 444us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:167` |
| 0.0% | 442us | 0.0% | 442us | `has` | `[native code]` |
| 0.0% | 440us | 0.0% | 440us | `setPrototypeOf` | `[native code]` |
| 0.0% | 438us | 0.0% | 438us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts:481` |
| 0.0% | 437us | 0.0% | 437us | `isString` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 435us | 0.0% | 435us | `Agent` | `node:_http_agent` |
| 0.0% | 435us | 0.0% | 435us | `Writable` | `internal:streams/writable` |
| 0.0% | 434us | 0.0% | 434us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts` |
| 0.0% | 433us | 0.0% | 433us | `node:_http_outgoing` | `node:_http_outgoing:511` |
| 0.0% | 432us | 0.0% | 432us | `node:_http_incoming` | `node:_http_incoming:175` |
| 0.0% | 430us | 0.0% | 430us | `setName` | `node:fs` |
| 0.0% | 429us | 0.0% | 429us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 428us | 0.0% | 428us | `(anonymous)` | `/home/user/bun-node/node_modules/content-type/dist/index.js` |
| 0.0% | 427us | 0.0% | 427us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 427us | 0.0% | 427us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 426us | 0.0% | 426us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1033` |
| 0.0% | 425us | 1.4% | 91.7ms | `bound require` | `[native code]` |
| 0.0% | 424us | 0.0% | 424us | `createPrivateSymbol` | `[native code]` |
| 0.0% | 424us | 0.0% | 424us | `(anonymous)` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 423us | 0.0% | 423us | `Map` | `[native code]` |
| 0.0% | 422us | 0.0% | 422us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:177` |
| 0.0% | 419us | 0.1% | 9.8ms | `node:_http_common` | `node:_http_common:2` |
| 0.0% | 419us | 0.0% | 419us | `node:crypto` | `node:crypto:99` |
| 0.0% | 419us | 0.0% | 419us | `parse` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 418us | 0.0% | 418us | `exec` | `[native code]` |
| 0.0% | 415us | 0.0% | 415us | `Uint32Array` | `[native code]` |
| 0.0% | 412us | 0.0% | 412us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:202` |
| 0.0% | 411us | 0.0% | 411us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 409us | 0.0% | 409us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 408us | 0.0% | 408us | `internal:primordials` | `internal:primordials:15` |
| 0.0% | 405us | 0.0% | 2.5ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:696` |
| 0.0% | 405us | 0.0% | 786us | `segmentKind` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:75` |
| 0.0% | 404us | 0.0% | 404us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:20` |
| 0.0% | 404us | 0.0% | 404us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 403us | 0.0% | 403us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs` |
| 0.0% | 402us | 0.0% | 402us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:30` |
| 0.0% | 400us | 0.0% | 400us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:196` |
| 0.0% | 400us | 0.0% | 400us | `symbolToStringify` | `node:os:126` |
| 0.0% | 399us | 0.0% | 399us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:157` |
| 0.0% | 399us | 0.0% | 399us | `WriteStream` | `internal:fs/streams` |
| 0.0% | 396us | 0.0% | 396us | `node:fs/promises` | `node:fs/promises:8` |
| 0.0% | 395us | 0.0% | 395us | `SafeSet` | `internal:primordials` |
| 0.0% | 395us | 0.0% | 832us | `addRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1256` |
| 0.0% | 395us | 0.0% | 395us | `filter` | `[native code]` |
| 0.0% | 391us | 0.0% | 391us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:85` |
| 0.0% | 389us | 0.0% | 389us | `startInterval` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 389us | 0.0% | 389us | `init` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 389us | 0.0% | 389us | `bind` | `[native code]` |
| 0.0% | 388us | 0.0% | 388us | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 388us | 0.0% | 388us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:176` |
| 0.0% | 386us | 0.0% | 386us | `invalidate` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 383us | 0.0% | 383us | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:58` |
| 0.0% | 382us | 0.0% | 382us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:80` |
| 0.0% | 382us | 0.0% | 382us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:189` |
| 0.0% | 381us | 0.0% | 381us | `test` | `[native code]` |
| 0.0% | 379us | 0.0% | 379us | `pick` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 376us | 0.4% | 29.1ms | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:177` |
| 0.0% | 375us | 0.0% | 375us | `getOwnPropertyNames` | `[native code]` |
| 0.0% | 374us | 0.0% | 374us | `(anonymous)` | `node:diagnostics_channel` |
| 0.0% | 372us | 0.0% | 372us | `serve` | `[native code]` |
| 0.0% | 361us | 0.0% | 361us | `isUndefined` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 359us | 0.0% | 359us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:442` |
| 0.0% | 358us | 25.4% | 1.65s | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1432` |
| 0.0% | 356us | 0.0% | 1.0ms | `from` | `[native code]` |
| 0.0% | 355us | 0.0% | 355us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:195` |
| 0.0% | 351us | 0.0% | 351us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2488` |
| 0.0% | 340us | 0.0% | 340us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 339us | 0.0% | 339us | `get headersSent` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 336us | 0.0% | 336us | `node:util` | `node:util:463` |
| 0.0% | 334us | 1.9% | 125.7ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:443` |
| 0.0% | 332us | 0.0% | 332us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:38` |
| 0.0% | 308us | 0.0% | 308us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5066` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 41.4% | 2.69s | 0.3% | 25.8ms | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:404` |
| 30.2% | 1.96s | 0.0% | 0us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:455` |
| 28.1% | 1.83s | 2.6% | 174.0ms | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:402` |
| 25.4% | 1.65s | 0.0% | 358us | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1432` |
| 23.1% | 1.50s | 0.1% | 12.1ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5102` |
| 19.1% | 1.24s | 19.1% | 1.24s | `write` | `[native code]` |
| 19.1% | 1.24s | 0.0% | 0us | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:89` |
| 18.8% | 1.22s | 1.1% | 78.0ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1214` |
| 18.7% | 1.22s | 18.7% | 1.22s | `Response` | `[native code]` |
| 11.6% | 759.2ms | 3.7% | 246.4ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1267` |
| 8.2% | 538.6ms | 0.2% | 18.7ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:437` |
| 7.8% | 511.9ms | 0.0% | 0us | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` |
| 7.6% | 498.4ms | 5.4% | 354.7ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` |
| 6.7% | 441.6ms | 6.7% | 441.6ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1231` |
| 5.3% | 345.5ms | 0.5% | 35.8ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4984` |
| 4.8% | 317.5ms | 4.7% | 307.9ms | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:78` |
| 3.8% | 248.5ms | 2.5% | 167.3ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1213` |
| 3.7% | 246.4ms | 3.7% | 246.4ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3506` |
| 3.2% | 213.9ms | 0.0% | 0us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1271` |
| 2.8% | 184.9ms | 1.2% | 82.0ms | `anonymous` | `[native code]` |
| 2.2% | 143.7ms | 2.2% | 143.7ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:514` |
| 2.1% | 140.0ms | 2.1% | 140.0ms | `method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 1.9% | 125.7ms | 0.0% | 334us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:443` |
| 1.8% | 123.4ms | 1.8% | 123.4ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4777` |
| 1.8% | 118.4ms | 1.8% | 118.4ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` |
| 1.7% | 113.8ms | 1.7% | 113.8ms | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:83` |
| 1.4% | 97.5ms | 1.4% | 97.5ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3520` |
| 1.4% | 97.3ms | 1.4% | 97.3ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3541` |
| 1.4% | 93.6ms | 0.0% | 916us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4774` |
| 1.4% | 91.7ms | 0.0% | 425us | `bound require` | `[native code]` |
| 1.3% | 91.0ms | 1.0% | 66.2ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1306` |
| 1.3% | 89.2ms | 1.3% | 89.2ms | `get` | `[native code]` |
| 1.3% | 88.4ms | 0.0% | 5.0ms | `require` | `[native code]` |
| 1.3% | 87.7ms | 0.1% | 11.8ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1340` |
| 1.2% | 82.1ms | 0.0% | 0us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4782` |
| 1.2% | 81.7ms | 1.2% | 81.7ms | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:281` |
| 1.2% | 81.2ms | 0.2% | 15.5ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1332` |
| 1.1% | 75.8ms | 1.1% | 75.8ms | `alloc` | `[native code]` |
| 1.1% | 74.4ms | 1.1% | 74.4ms | `params` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1706` |
| 1.1% | 74.4ms | 0.0% | 0us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5062` |
| 0.8% | 53.2ms | 0.8% | 53.2ms | `toString` | `[native code]` |
| 0.8% | 52.5ms | 0.0% | 0us | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:77` |
| 0.7% | 47.7ms | 0.6% | 44.8ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4470` |
| 0.6% | 45.0ms | 0.0% | 0us | `async run` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:61` |
| 0.6% | 45.0ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:106` |
| 0.5% | 38.4ms | 0.5% | 38.4ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4471` |
| 0.5% | 36.2ms | 0.0% | 0us | `async run` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:69` |
| 0.5% | 36.2ms | 0.5% | 36.2ms | `Promise` | `[native code]` |
| 0.4% | 31.7ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:84` |
| 0.4% | 29.9ms | 0.4% | 29.9ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3546` |
| 0.4% | 29.1ms | 0.0% | 376us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:177` |
| 0.4% | 28.2ms | 0.4% | 28.2ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4988` |
| 0.4% | 26.6ms | 0.4% | 26.6ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3521` |
| 0.4% | 26.4ms | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1031` |
| 0.3% | 25.4ms | 0.0% | 0us | `bound serveNativeRequest` | `[native code]` |
| 0.3% | 24.1ms | 0.3% | 24.1ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1335` |
| 0.3% | 23.9ms | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:57` |
| 0.3% | 23.6ms | 0.0% | 0us | `node:http` | `node:http:2` |
| 0.3% | 22.8ms | 0.3% | 20.9ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:440` |
| 0.3% | 22.7ms | 0.0% | 0us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:194` |
| 0.2% | 19.0ms | 0.2% | 19.0ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.2% | 18.3ms | 0.0% | 6.0ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3040` |
| 0.2% | 17.9ms | 0.0% | 0us | `#canSkipHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:571` |
| 0.2% | 17.9ms | 0.0% | 0us | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1209` |
| 0.2% | 17.6ms | 0.2% | 15.3ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1261` |
| 0.2% | 17.1ms | 0.2% | 17.1ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:136` |
| 0.2% | 15.7ms | 0.0% | 0us | `get inspect` | `node:util:481` |
| 0.2% | 15.7ms | 0.0% | 0us | `lazyInspectModule` | `node:util:17` |
| 0.2% | 15.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/index.js:9` |
| 0.2% | 14.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:16` |
| 0.2% | 14.8ms | 0.2% | 14.8ms | `#respond` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:498` |
| 0.2% | 13.2ms | 0.0% | 0us | `node:_http_client` | `node:_http_client:10` |
| 0.1% | 12.5ms | 0.1% | 12.5ms | `indexOf` | `[native code]` |
| 0.1% | 12.5ms | 0.0% | 4.2ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1256` |
| 0.1% | 12.4ms | 0.1% | 12.4ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3540` |
| 0.1% | 11.4ms | 0.0% | 1.4ms | `forEach` | `[native code]` |
| 0.1% | 11.2ms | 0.1% | 11.2ms | `data` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:80` |
| 0.1% | 10.4ms | 0.0% | 0us | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1331` |
| 0.1% | 10.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/accepts/index.js:16` |
| 0.1% | 9.8ms | 0.0% | 419us | `node:_http_common` | `node:_http_common:2` |
| 0.1% | 9.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/accepts/index.js:15` |
| 0.1% | 9.4ms | 0.1% | 9.4ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1343` |
| 0.1% | 8.7ms | 0.0% | 0us | `async run` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:64` |
| 0.1% | 8.7ms | 0.1% | 8.7ms | `repeat` | `[native code]` |
| 0.1% | 8.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:42` |
| 0.1% | 8.4ms | 0.0% | 0us | `populateMaps` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:155` |
| 0.1% | 7.2ms | 0.1% | 7.2ms | `@lazy` | `[native code]` |
| 0.1% | 7.0ms | 0.1% | 7.0ms | `node:zlib` | `node:zlib:2` |
| 0.1% | 6.7ms | 0.0% | 2.1ms | `map` | `[native code]` |
| 0.1% | 6.5ms | 0.1% | 6.5ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5006` |
| 0.1% | 6.5ms | 0.1% | 6.5ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4479` |
| 0.0% | 6.0ms | 0.0% | 6.0ms | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:970` |
| 0.0% | 5.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/index.js:3` |
| 0.0% | 5.7ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/src/index.js:5` |
| 0.0% | 5.6ms | 0.0% | 0us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4793` |
| 0.0% | 5.5ms | 0.0% | 5.5ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3042` |
| 0.0% | 5.3ms | 0.0% | 0us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:216` |
| 0.0% | 5.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:15` |
| 0.0% | 4.9ms | 0.0% | 0us | `node:_http_incoming` | `node:_http_incoming:2` |
| 0.0% | 4.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/node_modules/mime-db/index.js:12` |
| 0.0% | 4.4ms | 0.0% | 4.4ms | `RegExp` | `[native code]` |
| 0.0% | 4.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-types/index.js:15` |
| 0.0% | 4.1ms | 0.0% | 4.1ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:181` |
| 0.0% | 4.1ms | 0.0% | 0us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:185` |
| 0.0% | 4.0ms | 0.0% | 1.7ms | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:169` |
| 0.0% | 4.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-db/index.js:12` |
| 0.0% | 3.7ms | 0.0% | 3.7ms | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1359` |
| 0.0% | 3.6ms | 0.0% | 0us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1239` |
| 0.0% | 3.6ms | 0.0% | 3.6ms | `isBoolean` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 3.6ms | 0.0% | 3.6ms | `Mime` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 3.5ms | 0.0% | 0us | `node:fs/promises` | `node:fs/promises:2` |
| 0.0% | 3.5ms | 0.0% | 0us | `internal:fs/binding` | `internal:fs/binding:3` |
| 0.0% | 3.3ms | 0.0% | 3.3ms | `cloneObject` | `[native code]` |
| 0.0% | 3.3ms | 0.0% | 0us | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1356` |
| 0.0% | 3.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-types/index.js:40` |
| 0.0% | 3.3ms | 0.0% | 0us | `populateMaps` | `/home/user/bun-node/node_modules/mime-types/index.js:158` |
| 0.0% | 3.2ms | 0.0% | 0us | `node:vm` | `node:vm:12` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `node:fs` | `node:fs:289` |
| 0.0% | 3.2ms | 0.0% | 0us | `node:_http_incoming` | `node:_http_incoming:15` |
| 0.0% | 3.2ms | 0.0% | 0us | `internal:streams/readable` | `internal:streams/readable:2` |
| 0.0% | 3.1ms | 0.0% | 3.1ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 3.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:15` |
| 0.0% | 2.9ms | 0.0% | 0us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:242` |
| 0.0% | 2.9ms | 0.0% | 0us | `node:crypto` | `node:crypto:2` |
| 0.0% | 2.8ms | 0.0% | 0us | `internal:http/FakeSocket` | `internal:http/FakeSocket:2` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/index.js:41` |
| 0.0% | 2.7ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:54` |
| 0.0% | 2.5ms | 0.0% | 2.5ms | `node:stream/web` | `node:stream/web:14` |
| 0.0% | 2.5ms | 0.0% | 2.5ms | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:27` |
| 0.0% | 2.5ms | 0.0% | 405us | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:696` |
| 0.0% | 2.4ms | 0.0% | 0us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5134` |
| 0.0% | 2.4ms | 0.0% | 0us | `internal:stream` | `internal:stream:2` |
| 0.0% | 2.3ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:54` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `get method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 2.1ms | 0.0% | 0us | `Mime` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:13` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `normalizeEtagOption` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:393` |
| 0.0% | 2.0ms | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/general.ts:31` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `promisify2` | `internal:promisify` |
| 0.0% | 2.0ms | 0.0% | 0us | `internal:streams/compose` | `internal:streams/compose:2` |
| 0.0% | 2.0ms | 0.0% | 0us | `node:util` | `node:util:8` |
| 0.0% | 1.9ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:9` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `importModule` | `[native code]` |
| 0.0% | 1.9ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:79` |
| 0.0% | 1.9ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:80` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `get instance` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `median` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts` |
| 0.0% | 1.7ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:109` |
| 0.0% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-types/index.js:16` |
| 0.0% | 1.7ms | 0.0% | 0us | `_preferredType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:189` |
| 0.0% | 1.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:240` |
| 0.0% | 1.6ms | 0.0% | 0us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:169` |
| 0.0% | 1.6ms | 0.0% | 0us | `use` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4238` |
| 0.0% | 1.6ms | 0.0% | 0us | `flushPending` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4223` |
| 0.0% | 1.6ms | 0.0% | 779us | `(anonymous)` | `[native code]` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2511` |
| 0.0% | 1.5ms | 0.0% | 0us | `createDebug` | `/home/user/bun-node/node_modules/debug/src/common.js:117` |
| 0.0% | 1.4ms | 0.0% | 0us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:446` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `get originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` |
| 0.0% | 1.4ms | 0.0% | 0us | `async run` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:99` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `end` | `[native code]` |
| 0.0% | 1.4ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/ip-regex/index.js:25` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:156` |
| 0.0% | 1.3ms | 0.0% | 0us | `node:path` | `node:path:2` |
| 0.0% | 1.3ms | 0.0% | 912us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:174` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:32` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:11` |
| 0.0% | 1.2ms | 0.0% | 0us | `internal:streams/pipeline` | `internal:streams/pipeline:2` |
| 0.0% | 1.2ms | 0.0% | 0us | `internal:streams/destroy` | `internal:streams/destroy:2` |
| 0.0% | 1.2ms | 0.0% | 0us | `internal:errors` | `internal:errors:2` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `split` | `[native code]` |
| 0.0% | 1.2ms | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:84` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4775` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3507` |
| 0.0% | 1.1ms | 0.0% | 692us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1011` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:5` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 1.1ms | 0.0% | 0us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:86` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `get method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 1.0ms | 0.0% | 356us | `from` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `internal:streams/add-abort-signal` | `internal:streams/add-abort-signal:2` |
| 0.0% | 987us | 0.0% | 987us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:160` |
| 0.0% | 970us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:13` |
| 0.0% | 958us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:12` |
| 0.0% | 956us | 0.0% | 956us | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1336` |
| 0.0% | 883us | 0.0% | 883us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:422` |
| 0.0% | 880us | 0.0% | 880us | `bound` | `node:os` |
| 0.0% | 880us | 0.0% | 0us | `node:os` | `node:os:110` |
| 0.0% | 877us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:56` |
| 0.0% | 865us | 0.0% | 865us | `create` | `[native code]` |
| 0.0% | 865us | 0.0% | 0us | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2997` |
| 0.0% | 861us | 0.0% | 0us | `internal:streams/duplex` | `internal:streams/duplex:2` |
| 0.0% | 845us | 0.0% | 845us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:99` |
| 0.0% | 842us | 0.0% | 842us | `keys` | `[native code]` |
| 0.0% | 840us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:17` |
| 0.0% | 834us | 0.0% | 0us | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js:158` |
| 0.0% | 832us | 0.0% | 395us | `addRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1256` |
| 0.0% | 827us | 0.0% | 827us | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1203` |
| 0.0% | 822us | 0.0% | 0us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:39` |
| 0.0% | 822us | 0.0% | 822us | `charCodeAt` | `[native code]` |
| 0.0% | 818us | 0.0% | 818us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 809us | 0.0% | 0us | `setup` | `/home/user/bun-node/node_modules/debug/src/common.js:14` |
| 0.0% | 807us | 0.0% | 0us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:40` |
| 0.0% | 802us | 0.0% | 0us | `node:_http_agent` | `node:_http_agent:2` |
| 0.0% | 786us | 0.0% | 405us | `segmentKind` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:75` |
| 0.0% | 773us | 0.0% | 0us | `node:tty` | `node:tty:7` |
| 0.0% | 770us | 0.0% | 0us | `internal:util/inspect` | `internal:util/inspect:46` |
| 0.0% | 769us | 0.0% | 769us | `add` | `[native code]` |
| 0.0% | 766us | 0.0% | 766us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 757us | 0.0% | 757us | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 720us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` |
| 0.0% | 720us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` |
| 0.0% | 714us | 0.0% | 714us | `get isKeepAlive` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1764` |
| 0.0% | 714us | 0.0% | 0us | `get isLongLived` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1035` |
| 0.0% | 714us | 0.0% | 0us | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1396` |
| 0.0% | 714us | 0.0% | 0us | `get headersSent` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` |
| 0.0% | 676us | 0.0% | 676us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:25` |
| 0.0% | 655us | 0.0% | 655us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 632us | 0.0% | 632us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1012` |
| 0.0% | 631us | 0.0% | 631us | `_preferredType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` |
| 0.0% | 619us | 0.0% | 0us | `resolveLogger` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:1044` |
| 0.0% | 619us | 0.0% | 0us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:350` |
| 0.0% | 619us | 0.0% | 619us | `hasMethods` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts` |
| 0.0% | 619us | 0.0% | 0us | `set logger` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:931` |
| 0.0% | 610us | 0.0% | 610us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:950` |
| 0.0% | 608us | 0.0% | 608us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:87` |
| 0.0% | 600us | 0.0% | 600us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:170` |
| 0.0% | 592us | 0.0% | 592us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3026` |
| 0.0% | 581us | 0.0% | 0us | `node:zlib` | `node:zlib:456` |
| 0.0% | 505us | 0.0% | 505us | `hideFromStack` | `internal:shared` |
| 0.0% | 505us | 0.0% | 0us | `internal:validators` | `internal:validators:67` |
| 0.0% | 504us | 0.0% | 504us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:19` |
| 0.0% | 502us | 0.0% | 502us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:151` |
| 0.0% | 502us | 0.0% | 0us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:173` |
| 0.0% | 495us | 0.0% | 0us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:39` |
| 0.0% | 495us | 0.0% | 495us | `set` | `[native code]` |
| 0.0% | 489us | 0.0% | 0us | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` |
| 0.0% | 489us | 0.0% | 489us | `Request` | `[native code]` |
| 0.0% | 488us | 0.0% | 488us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:247` |
| 0.0% | 475us | 0.0% | 475us | `internal:streams/destroy` | `internal:streams/destroy:16` |
| 0.0% | 465us | 0.0% | 465us | `supportsColor` | `/home/user/bun-node/node_modules/supports-color/index.js` |
| 0.0% | 465us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/supports-color/index.js:133` |
| 0.0% | 463us | 0.0% | 463us | `replace` | `[native code]` |
| 0.0% | 463us | 0.0% | 0us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:42` |
| 0.0% | 463us | 0.0% | 0us | `node:_http_outgoing` | `node:_http_outgoing:44` |
| 0.0% | 460us | 0.0% | 460us | `extractWildcardNames` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:242` |
| 0.0% | 459us | 0.0% | 459us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:44` |
| 0.0% | 457us | 0.0% | 457us | `node:http` | `node:http:5` |
| 0.0% | 457us | 0.0% | 457us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:173` |
| 0.0% | 456us | 0.0% | 456us | `reduce` | `[native code]` |
| 0.0% | 456us | 0.0% | 456us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 456us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:126` |
| 0.0% | 446us | 0.0% | 446us | `isFunction` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 446us | 0.0% | 0us | `BunWebSocket` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts:538` |
| 0.0% | 446us | 0.0% | 0us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:352` |
| 0.0% | 446us | 0.0% | 0us | `toUpgradeHook` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/wsUpgrade.ts:63` |
| 0.0% | 444us | 0.0% | 444us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:167` |
| 0.0% | 442us | 0.0% | 442us | `has` | `[native code]` |
| 0.0% | 442us | 0.0% | 0us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:20` |
| 0.0% | 440us | 0.0% | 440us | `setPrototypeOf` | `[native code]` |
| 0.0% | 440us | 0.0% | 0us | `node:crypto` | `node:crypto:293` |
| 0.0% | 440us | 0.0% | 0us | `deprecate` | `internal:util/deprecate:25` |
| 0.0% | 438us | 0.0% | 438us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts:481` |
| 0.0% | 437us | 0.0% | 437us | `isString` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 436us | 0.0% | 0us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` |
| 0.0% | 435us | 0.0% | 0us | `node:_http_agent` | `node:_http_agent:290` |
| 0.0% | 435us | 0.0% | 0us | `WriteStream` | `internal:fs/streams:259` |
| 0.0% | 435us | 0.0% | 435us | `Writable` | `internal:streams/writable` |
| 0.0% | 435us | 0.0% | 435us | `Agent` | `node:_http_agent` |
| 0.0% | 434us | 0.0% | 434us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts` |
| 0.0% | 433us | 0.0% | 433us | `node:_http_outgoing` | `node:_http_outgoing:511` |
| 0.0% | 432us | 0.0% | 432us | `node:_http_incoming` | `node:_http_incoming:175` |
| 0.0% | 430us | 0.0% | 0us | `node:fs` | `node:fs:702` |
| 0.0% | 430us | 0.0% | 430us | `setName` | `node:fs` |
| 0.0% | 429us | 0.0% | 429us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 428us | 0.0% | 428us | `(anonymous)` | `/home/user/bun-node/node_modules/content-type/dist/index.js` |
| 0.0% | 428us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/content-type/dist/index.js:30` |
| 0.0% | 427us | 0.0% | 427us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 427us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/supports-color/index.js:4` |
| 0.0% | 427us | 0.0% | 427us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 426us | 0.0% | 426us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1033` |
| 0.0% | 425us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:194` |
| 0.0% | 424us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` |
| 0.0% | 424us | 0.0% | 424us | `createPrivateSymbol` | `[native code]` |
| 0.0% | 424us | 0.0% | 424us | `(anonymous)` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 424us | 0.0% | 0us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:14` |
| 0.0% | 423us | 0.0% | 423us | `Map` | `[native code]` |
| 0.0% | 423us | 0.0% | 0us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:67` |
| 0.0% | 423us | 0.0% | 0us | `setup` | `/home/user/bun-node/node_modules/debug/src/common.js:17` |
| 0.0% | 422us | 0.0% | 422us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:177` |
| 0.0% | 419us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:457` |
| 0.0% | 419us | 0.0% | 419us | `node:crypto` | `node:crypto:99` |
| 0.0% | 419us | 0.0% | 419us | `parse` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 418us | 0.0% | 0us | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4634` |
| 0.0% | 418us | 0.0% | 418us | `exec` | `[native code]` |
| 0.0% | 418us | 0.0% | 0us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4805` |
| 0.0% | 415us | 0.0% | 0us | `node:zlib` | `node:zlib:385` |
| 0.0% | 415us | 0.0% | 415us | `Uint32Array` | `[native code]` |
| 0.0% | 412us | 0.0% | 412us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:202` |
| 0.0% | 411us | 0.0% | 411us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 410us | 0.0% | 0us | `internal:stream` | `internal:stream:46` |
| 0.0% | 409us | 0.0% | 409us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 408us | 0.0% | 408us | `internal:primordials` | `internal:primordials:15` |
| 0.0% | 404us | 0.0% | 404us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:20` |
| 0.0% | 404us | 0.0% | 404us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 403us | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:59` |
| 0.0% | 403us | 0.0% | 0us | `#compileMiddlewareRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:209` |
| 0.0% | 403us | 0.0% | 403us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs` |
| 0.0% | 402us | 0.0% | 402us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:30` |
| 0.0% | 400us | 0.0% | 0us | `node:os` | `node:os:119` |
| 0.0% | 400us | 0.0% | 400us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:196` |
| 0.0% | 400us | 0.0% | 400us | `symbolToStringify` | `node:os:126` |
| 0.0% | 399us | 0.0% | 399us | `WriteStream` | `internal:fs/streams` |
| 0.0% | 399us | 0.0% | 399us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:157` |
| 0.0% | 397us | 0.0% | 0us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:198` |
| 0.0% | 396us | 0.0% | 396us | `node:fs/promises` | `node:fs/promises:8` |
| 0.0% | 396us | 0.0% | 0us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:88` |
| 0.0% | 395us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/index.js:44` |
| 0.0% | 395us | 0.0% | 395us | `SafeSet` | `internal:primordials` |
| 0.0% | 395us | 0.0% | 395us | `filter` | `[native code]` |
| 0.0% | 391us | 0.0% | 391us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:85` |
| 0.0% | 389us | 0.0% | 0us | `internal:primordials` | `internal:primordials:76` |
| 0.0% | 389us | 0.0% | 0us | `createDebug` | `/home/user/bun-node/node_modules/debug/src/common.js:143` |
| 0.0% | 389us | 0.0% | 389us | `startInterval` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 389us | 0.0% | 0us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:70` |
| 0.0% | 389us | 0.0% | 389us | `bind` | `[native code]` |
| 0.0% | 389us | 0.0% | 389us | `init` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 389us | 0.0% | 0us | `makeSafe` | `internal:primordials:41` |
| 0.0% | 389us | 0.0% | 0us | `internal:validators` | `internal:validators:2` |
| 0.0% | 388us | 0.0% | 388us | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 388us | 0.0% | 388us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:176` |
| 0.0% | 386us | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1079` |
| 0.0% | 386us | 0.0% | 386us | `invalidate` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 383us | 0.0% | 383us | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:58` |
| 0.0% | 383us | 0.0% | 0us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:84` |
| 0.0% | 382us | 0.0% | 382us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:80` |
| 0.0% | 382us | 0.0% | 382us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:189` |
| 0.0% | 381us | 0.0% | 381us | `test` | `[native code]` |
| 0.0% | 379us | 0.0% | 0us | `BunRouter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:889` |
| 0.0% | 379us | 0.0% | 379us | `pick` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 379us | 0.0% | 0us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:333` |
| 0.0% | 376us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:6` |
| 0.0% | 375us | 0.0% | 375us | `getOwnPropertyNames` | `[native code]` |
| 0.0% | 374us | 0.0% | 374us | `(anonymous)` | `node:diagnostics_channel` |
| 0.0% | 374us | 0.0% | 0us | `node:diagnostics_channel` | `node:diagnostics_channel:134` |
| 0.0% | 374us | 0.0% | 0us | `WeakRefMap` | `[native code]` |
| 0.0% | 372us | 0.0% | 372us | `serve` | `[native code]` |
| 0.0% | 372us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:55` |
| 0.0% | 366us | 0.0% | 0us | `promisify2` | `internal:promisify:17` |
| 0.0% | 366us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/multipart/stream.ts:4` |
| 0.0% | 366us | 0.0% | 0us | `get` | `internal:stream:69` |
| 0.0% | 363us | 0.0% | 0us | `node:crypto` | `node:crypto:39` |
| 0.0% | 361us | 0.0% | 0us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3031` |
| 0.0% | 361us | 0.0% | 361us | `isUndefined` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 359us | 0.0% | 359us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:442` |
| 0.0% | 356us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/uint8array-extras/index.js:178` |
| 0.0% | 355us | 0.0% | 355us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:195` |
| 0.0% | 351us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/types/multipart.js:5` |
| 0.0% | 351us | 0.0% | 0us | `internal:streams/readable` | `internal:streams/readable:14` |
| 0.0% | 351us | 0.0% | 351us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2488` |
| 0.0% | 340us | 0.0% | 0us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:237` |
| 0.0% | 340us | 0.0% | 340us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 339us | 0.0% | 339us | `get headersSent` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 339us | 0.0% | 0us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5260` |
| 0.0% | 336us | 0.0% | 336us | `node:util` | `node:util:463` |
| 0.0% | 332us | 0.0% | 332us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:38` |
| 0.0% | 320us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:14` |
| 0.0% | 308us | 0.0% | 308us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5066` |

## Function Details

### `write`
`[native code]` | Self: 19.1% (1.24s) | Total: 19.1% (1.24s) | Samples: 68

**Called by:**
- `data` (68)

### `Response`
`[native code]` | Self: 18.7% (1.22s) | Total: 18.7% (1.22s) | Samples: 112

**Called by:**
- `#respondWithText` (110)
- `#respondWithText` (2)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1231` | Self: 6.7% (441.6ms) | Total: 6.7% (441.6ms) | Samples: 33

**Called by:**
- `init` (33)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` | Self: 5.4% (354.7ms) | Total: 7.6% (498.4ms) | Samples: 27

**Called by:**
- `#routeRequest` (37)

**Calls:**
- `(anonymous)` (10)

### `data`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:78` | Self: 4.7% (307.9ms) | Total: 4.8% (317.5ms) | Samples: 9

**Calls:**
- `indexOf` (2)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3506` | Self: 3.7% (246.4ms) | Total: 3.7% (246.4ms) | Samples: 15

**Called by:**
- `parseQuery` (15)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1267` | Self: 3.7% (246.4ms) | Total: 11.6% (759.2ms) | Samples: 12

**Called by:**
- `init` (47)

**Calls:**
- `parseQuery` (34)
- `parseQuery` (1)

### `serveNativeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:402` | Self: 2.6% (174.0ms) | Total: 28.1% (1.83s) | Samples: 14

**Called by:**
- `bound serveNativeRequest` (17)

**Calls:**
- `init` (166)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1213` | Self: 2.5% (167.3ms) | Total: 3.8% (248.5ms) | Samples: 14

**Called by:**
- `#runPipeline` (18)

**Calls:**
- `Response` (2)
- `add` (2)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:514` | Self: 2.2% (143.7ms) | Total: 2.2% (143.7ms) | Samples: 10

**Called by:**
- `BunResponse` (10)

### `method`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` | Self: 2.1% (140.0ms) | Total: 2.1% (140.0ms) | Samples: 3

**Called by:**
- `#routeRequest` (2)
- `#canSkipHeaders` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4777` | Self: 1.8% (123.4ms) | Total: 1.8% (123.4ms) | Samples: 10

**Called by:**
- `dispatch` (10)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` | Self: 1.8% (118.4ms) | Total: 1.8% (118.4ms) | Samples: 20

**Called by:**
- `init` (20)

### `data`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:83` | Self: 1.7% (113.8ms) | Total: 1.7% (113.8ms) | Samples: 7

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3520` | Self: 1.4% (97.5ms) | Total: 1.4% (97.5ms) | Samples: 3

**Called by:**
- `parseQuery` (3)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3541` | Self: 1.4% (97.3ms) | Total: 1.4% (97.3ms) | Samples: 7

**Called by:**
- `parseQuery` (7)

### `get`
`[native code]` | Self: 1.3% (89.2ms) | Total: 1.3% (89.2ms) | Samples: 11

**Called by:**
- `parseCookies` (4)
- `#finishAbsentBody` (3)
- `#finishAbsentBody` (2)
- `getMatchedLayers` (1)
- `#build` (1)

### `anonymous`
`[native code]` | Self: 1.2% (82.0ms) | Total: 2.8% (184.9ms) | Samples: 109

**Called by:**
- `require` (162)
- `node:http` (45)
- `node:_http_client` (30)
- `node:_http_common` (21)
- `node:_http_incoming` (11)
- `lazyInspectModule` (10)
- `node:_http_incoming` (7)
- `internal:streams/readable` (7)
- `internal:http/FakeSocket` (6)
- `bound require` (5)
- `internal:stream` (5)
- `internal:streams/compose` (4)
- `internal:errors` (3)
- `node:path` (3)
- `internal:streams/destroy` (3)
- `internal:streams/pipeline` (3)
- `node:crypto` (2)
- `internal:streams/duplex` (2)
- `internal:streams/add-abort-signal` (2)
- `node:tty` (2)
- `node:_http_agent` (2)
- `node:util` (1)
- `internal:validators` (1)
- `internal:stream` (1)
- `get` (1)
- `node:fs/promises` (1)
- `internal:streams/readable` (1)

**Calls:**
- `node:_http_client` (30)
- `node:_http_common` (22)
- `(anonymous)` (19)
- `(anonymous)` (13)
- `(anonymous)` (12)
- `node:_http_incoming` (11)
- `(anonymous)` (11)
- `(anonymous)` (10)
- `internal:streams/readable` (7)
- `node:_http_incoming` (7)
- `internal:http/FakeSocket` (6)
- `(anonymous)` (6)
- `internal:stream` (5)
- `(anonymous)` (4)
- `internal:streams/compose` (4)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `internal:errors` (3)
- `(anonymous)` (3)
- `internal:streams/pipeline` (3)
- `node:path` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `internal:streams/destroy` (3)
- `(anonymous)` (3)
- `internal:util/inspect` (2)
- `node:tty` (2)
- `(anonymous)` (2)
- `node:_http_agent` (2)
- `internal:streams/duplex` (2)
- `internal:streams/add-abort-signal` (2)
- `(anonymous)` (1)
- `internal:primordials` (1)
- `node:_http_agent` (1)
- `(anonymous)` (1)
- `internal:stream` (1)
- `node:diagnostics_channel` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:_http_outgoing` (1)
- `(anonymous)` (1)
- `internal:fs/binding` (1)
- `internal:validators` (1)
- `(anonymous)` (1)
- `internal:validators` (1)
- `node:_http_incoming` (1)
- `(anonymous)` (1)
- `internal:primordials` (1)
- `node:_http_outgoing` (1)
- `internal:streams/readable` (1)
- `internal:streams/destroy` (1)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:281` | Self: 1.2% (81.7ms) | Total: 1.2% (81.7ms) | Samples: 7

**Called by:**
- `getMatchedLayers` (7)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1214` | Self: 1.1% (78.0ms) | Total: 18.8% (1.22s) | Samples: 4

**Called by:**
- `#runPipeline` (116)

**Calls:**
- `Response` (110)
- `set response` (1)
- `set response` (1)

### `alloc`
`[native code]` | Self: 1.1% (75.8ms) | Total: 1.1% (75.8ms) | Samples: 5

**Called by:**
- `#finishAbsentBody` (5)

### `params`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1706` | Self: 1.1% (74.4ms) | Total: 1.1% (74.4ms) | Samples: 6

**Called by:**
- `#runPipeline` (6)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1306` | Self: 1.0% (66.2ms) | Total: 1.3% (91.0ms) | Samples: 11

**Called by:**
- `init` (24)

**Calls:**
- `parseCookies` (6)
- `parseCookies` (4)
- `parseCookies` (2)
- `parseCookies` (1)

### `toString`
`[native code]` | Self: 0.8% (53.2ms) | Total: 0.8% (53.2ms) | Samples: 9

**Called by:**
- `data` (8)
- `(anonymous)` (1)

### `getRequestPathFromRequestURL`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4470` | Self: 0.6% (44.8ms) | Total: 0.7% (47.7ms) | Samples: 4

**Called by:**
- `getMatchedLayers` (5)

**Calls:**
- `indexOf` (1)

### `getRequestPathFromRequestURL`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4471` | Self: 0.5% (38.4ms) | Total: 0.5% (38.4ms) | Samples: 2

**Called by:**
- `getMatchedLayers` (2)

### `Promise`
`[native code]` | Self: 0.5% (36.2ms) | Total: 0.5% (36.2ms) | Samples: 1

**Called by:**
- `async run` (1)

### `dispatch`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4984` | Self: 0.5% (35.8ms) | Total: 5.3% (345.5ms) | Samples: 4

**Called by:**
- `#routeRequest` (52)

**Calls:**
- `getMatchedLayers` (13)
- `getMatchedLayers` (10)
- `getMatchedLayers` (9)
- `getMatchedLayers` (8)
- `getMatchedLayers` (6)
- `getMatchedLayers` (1)
- `getMatchedLayers` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3546` | Self: 0.4% (29.9ms) | Total: 0.4% (29.9ms) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `dispatch`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4988` | Self: 0.4% (28.2ms) | Total: 0.4% (28.2ms) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3521` | Self: 0.4% (26.6ms) | Total: 0.4% (26.6ms) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `serveNativeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:404` | Self: 0.3% (25.8ms) | Total: 41.4% (2.69s) | Samples: 2

**Called by:**
- `bound serveNativeRequest` (31)

**Calls:**
- `#routeRequest` (210)
- `#routeRequest` (47)
- `#routeRequest` (9)
- `#routeRequest` (5)
- `#routeRequest` (2)
- `#respond` (2)
- `#produceResponse` (1)
- `#routeRequest` (1)
- `#routeRequest` (1)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1335` | Self: 0.3% (24.1ms) | Total: 0.3% (24.1ms) | Samples: 6

**Called by:**
- `BunRequest` (6)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:440` | Self: 0.3% (20.9ms) | Total: 0.3% (22.8ms) | Samples: 8

**Called by:**
- `serveNativeRequest` (9)

**Calls:**
- `get instance` (1)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.2% (19.0ms) | Total: 0.2% (19.0ms) | Samples: 6

**Called by:**
- `#routeRequest` (6)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:437` | Self: 0.2% (18.7ms) | Total: 8.2% (538.6ms) | Samples: 2

**Called by:**
- `serveNativeRequest` (47)

**Calls:**
- `BunResponse` (37)
- `BunResponse` (6)
- `BunResponse` (2)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:136` | Self: 0.2% (17.1ms) | Total: 0.2% (17.1ms) | Samples: 18

**Called by:**
- `#compileRouteRegExp` (18)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1332` | Self: 0.2% (15.5ms) | Total: 1.2% (81.2ms) | Samples: 2

**Called by:**
- `BunRequest` (4)

**Calls:**
- `get` (2)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1261` | Self: 0.2% (15.3ms) | Total: 0.2% (17.6ms) | Samples: 1

**Called by:**
- `init` (4)

**Calls:**
- `normalizeParseBodyOptions` (1)
- `normalizeParseBodyOptions` (1)
- `normalizeParseBodyOptions` (1)

### `#respond`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:498` | Self: 0.2% (14.8ms) | Total: 0.2% (14.8ms) | Samples: 2

**Called by:**
- `serveNativeRequest` (2)

### `indexOf`
`[native code]` | Self: 0.1% (12.5ms) | Total: 0.1% (12.5ms) | Samples: 3

**Called by:**
- `data` (2)
- `getRequestPathFromRequestURL` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3540` | Self: 0.1% (12.4ms) | Total: 0.1% (12.4ms) | Samples: 3

**Called by:**
- `parseQuery` (3)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5102` | Self: 0.1% (12.1ms) | Total: 23.1% (1.50s) | Samples: 1

**Called by:**
- `#routeRequest` (140)

**Calls:**
- `#respondWithText` (116)
- `#respondWithText` (18)
- `#respondWithText` (2)
- `send` (1)
- `send` (1)
- `#respondWithText` (1)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1340` | Self: 0.1% (11.8ms) | Total: 1.3% (87.7ms) | Samples: 1

**Called by:**
- `BunRequest` (6)

**Calls:**
- `alloc` (5)

### `data`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:80` | Self: 0.1% (11.2ms) | Total: 0.1% (11.2ms) | Samples: 1

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1343` | Self: 0.1% (9.4ms) | Total: 0.1% (9.4ms) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `repeat`
`[native code]` | Self: 0.1% (8.7ms) | Total: 0.1% (8.7ms) | Samples: 1

**Called by:**
- `async run` (1)

### `@lazy`
`[native code]` | Self: 0.1% (7.2ms) | Total: 0.1% (7.2ms) | Samples: 3

**Called by:**
- `node:crypto` (1)
- `node:vm` (1)
- `internal:fs/binding` (1)

### `node:zlib`
`node:zlib:2` | Self: 0.1% (7.0ms) | Total: 0.1% (7.0ms) | Samples: 1

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5006` | Self: 0.1% (6.5ms) | Total: 0.1% (6.5ms) | Samples: 7

**Called by:**
- `#routeRequest` (7)

### `getRequestPathFromRequestURL`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4479` | Self: 0.1% (6.5ms) | Total: 0.1% (6.5ms) | Samples: 1

**Called by:**
- `getMatchedLayers` (1)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:970` | Self: 0.0% (6.0ms) | Total: 0.0% (6.0ms) | Samples: 1

**Called by:**
- `#respondWithText` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3040` | Self: 0.0% (6.0ms) | Total: 0.2% (18.3ms) | Samples: 2

**Called by:**
- `BunRequest` (6)

**Calls:**
- `get` (4)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3042` | Self: 0.0% (5.5ms) | Total: 0.0% (5.5ms) | Samples: 4

**Called by:**
- `BunRequest` (4)

### `require`
`[native code]` | Self: 0.0% (5.0ms) | Total: 1.3% (88.4ms) | Samples: 2

**Called by:**
- `bound require` (164)

**Calls:**
- `anonymous` (162)

### `RegExp`
`[native code]` | Self: 0.0% (4.4ms) | Total: 0.0% (4.4ms) | Samples: 7

**Called by:**
- `pathRegex` (6)
- `(module)` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1256` | Self: 0.0% (4.2ms) | Total: 0.1% (12.5ms) | Samples: 10

**Called by:**
- `init` (13)

**Calls:**
- `#writableOptions` (1)
- `#writableOptions` (1)
- `#writableOptions` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:181` | Self: 0.0% (4.1ms) | Total: 0.0% (4.1ms) | Samples: 1

### `#writableOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1359` | Self: 0.0% (3.7ms) | Total: 0.0% (3.7ms) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `isBoolean`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` | Self: 0.0% (3.6ms) | Total: 0.0% (3.6ms) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `Mime`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js` | Self: 0.0% (3.6ms) | Total: 0.0% (3.6ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `cloneObject`
`[native code]` | Self: 0.0% (3.3ms) | Total: 0.0% (3.3ms) | Samples: 1

**Called by:**
- `#writableOptions` (1)

### `node:fs`
`node:fs:289` | Self: 0.0% (3.2ms) | Total: 0.0% (3.2ms) | Samples: 1

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (3.1ms) | Total: 0.0% (3.1ms) | Samples: 6

**Called by:**
- `dispatch` (6)

### `node:stream/web`
`node:stream/web:14` | Self: 0.0% (2.5ms) | Total: 0.0% (2.5ms) | Samples: 1

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:27` | Self: 0.0% (2.5ms) | Total: 0.0% (2.5ms) | Samples: 1

### `map`
`[native code]` | Self: 0.0% (2.1ms) | Total: 0.1% (6.7ms) | Samples: 5

**Called by:**
- `#build` (9)
- `compileRoute` (3)
- `compileRoute` (1)
- `node:zlib` (1)
- `#compileRouteRegExp` (1)

**Calls:**
- `compileRoute` (3)
- `segmentKind` (2)
- `compileRoute` (1)
- `compileRoute` (1)
- `compileRoute` (1)
- `compileRoute` (1)
- `compileRoute` (1)

### `get method`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` | Self: 0.0% (2.1ms) | Total: 0.0% (2.1ms) | Samples: 2

**Called by:**
- `#routeRequest` (2)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (2.1ms) | Total: 0.0% (2.1ms) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `normalizeEtagOption`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:393` | Self: 0.0% (2.1ms) | Total: 0.0% (2.1ms) | Samples: 1

**Called by:**
- `BunResponse` (1)

### `promisify2`
`internal:promisify` | Self: 0.0% (2.0ms) | Total: 0.0% (2.0ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `importModule`
`[native code]` | Self: 0.0% (1.9ms) | Total: 0.0% (1.9ms) | Samples: 4

**Called by:**
- `async makeTarget` (4)

### `get instance`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` | Self: 0.0% (1.8ms) | Total: 0.0% (1.8ms) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `median`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:169` | Self: 0.0% (1.7ms) | Total: 0.0% (4.0ms) | Samples: 4

**Called by:**
- `forEach` (9)

**Calls:**
- `_preferredType` (4)
- `_preferredType` (1)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2511` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `get originalUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` | Self: 0.0% (1.4ms) | Total: 0.0% (1.4ms) | Samples: 2

**Called by:**
- `#routeRequest` (2)

### `end`
`[native code]` | Self: 0.0% (1.4ms) | Total: 0.0% (1.4ms) | Samples: 1

**Called by:**
- `async run` (1)

### `forEach`
`[native code]` | Self: 0.0% (1.4ms) | Total: 0.1% (11.4ms) | Samples: 3

**Called by:**
- `populateMaps` (18)
- `populateMaps` (6)

**Calls:**
- `forEachMimeType` (9)
- `forEachMimeType` (3)
- `forEachMimeType` (3)
- `forEachMimeType` (1)
- `forEachMimeType` (1)
- `forEachMimeType` (1)
- `forEachMimeType` (1)
- `forEachMimeType` (1)
- `forEachMimeType` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:156` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 3

**Called by:**
- `forEach` (3)

### `split`
`[native code]` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 3

**Called by:**
- `mimeScore` (2)
- `node:_http_outgoing` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4775` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `dispatch` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3507` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 3

**Called by:**
- `parseQuery` (3)

### `send`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `#writableOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `get method`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `#canSkipHeaders` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:160` | Self: 0.0% (987us) | Total: 0.0% (987us) | Samples: 1

**Called by:**
- `forEach` (1)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1336` | Self: 0.0% (956us) | Total: 0.0% (956us) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4774` | Self: 0.0% (916us) | Total: 1.4% (93.6ms) | Samples: 1

**Called by:**
- `dispatch` (9)

**Calls:**
- `getRequestPathFromRequestURL` (5)
- `getRequestPathFromRequestURL` (2)
- `getRequestPathFromRequestURL` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:174` | Self: 0.0% (912us) | Total: 0.0% (1.3ms) | Samples: 2

**Called by:**
- `forEach` (3)

**Calls:**
- `_preferredTypeLegacy` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:422` | Self: 0.0% (883us) | Total: 0.0% (883us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `bound`
`node:os` | Self: 0.0% (880us) | Total: 0.0% (880us) | Samples: 1

**Called by:**
- `node:os` (1)

### `create`
`[native code]` | Self: 0.0% (865us) | Total: 0.0% (865us) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:99` | Self: 0.0% (845us) | Total: 0.0% (845us) | Samples: 1

**Called by:**
- `map` (1)

### `keys`
`[native code]` | Self: 0.0% (842us) | Total: 0.0% (842us) | Samples: 2

**Called by:**
- `setup` (1)
- `populateMaps` (1)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1203` | Self: 0.0% (827us) | Total: 0.0% (827us) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `charCodeAt`
`[native code]` | Self: 0.0% (822us) | Total: 0.0% (822us) | Samples: 1

**Called by:**
- `pathRegex` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` | Self: 0.0% (818us) | Total: 0.0% (818us) | Samples: 2

**Called by:**
- `(module)` (1)
- `async makeTarget` (1)

### `(anonymous)`
`[native code]` | Self: 0.0% (779us) | Total: 0.0% (1.6ms) | Samples: 2

**Called by:**
- `bound require` (2)
- `useColors` (2)

**Calls:**
- `WriteStream` (1)
- `WriteStream` (1)

### `add`
`[native code]` | Self: 0.0% (769us) | Total: 0.0% (769us) | Samples: 2

**Called by:**
- `#respondWithText` (2)

### `#compileRouteRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` | Self: 0.0% (766us) | Total: 0.0% (766us) | Samples: 2

**Called by:**
- `Route` (2)

### `useColors`
`/home/user/bun-node/node_modules/debug/src/node.js` | Self: 0.0% (757us) | Total: 0.0% (757us) | Samples: 1

**Called by:**
- `createDebug` (1)

### `get isKeepAlive`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1764` | Self: 0.0% (714us) | Total: 0.0% (714us) | Samples: 1

**Called by:**
- `get isLongLived` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1011` | Self: 0.0% (692us) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `registerExpressStyle` (2)

**Calls:**
- `extractWildcardNames` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:25` | Self: 0.0% (676us) | Total: 0.0% (676us) | Samples: 2

**Called by:**
- `Mime` (2)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (655us) | Total: 0.0% (655us) | Samples: 1

**Called by:**
- `registerExpressStyle` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1012` | Self: 0.0% (632us) | Total: 0.0% (632us) | Samples: 1

**Called by:**
- `registerExpressStyle` (1)

### `_preferredType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` | Self: 0.0% (631us) | Total: 0.0% (631us) | Samples: 1

**Called by:**
- `forEachMimeType` (1)

### `hasMethods`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts` | Self: 0.0% (619us) | Total: 0.0% (619us) | Samples: 1

**Called by:**
- `resolveLogger` (1)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:950` | Self: 0.0% (610us) | Total: 0.0% (610us) | Samples: 1

**Called by:**
- `#respondWithText` (1)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:87` | Self: 0.0% (608us) | Total: 0.0% (608us) | Samples: 1

**Called by:**
- `map` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:170` | Self: 0.0% (600us) | Total: 0.0% (600us) | Samples: 1

**Called by:**
- `forEach` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3026` | Self: 0.0% (592us) | Total: 0.0% (592us) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `hideFromStack`
`internal:shared` | Self: 0.0% (505us) | Total: 0.0% (505us) | Samples: 1

**Called by:**
- `internal:validators` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:19` | Self: 0.0% (504us) | Total: 0.0% (504us) | Samples: 1

**Called by:**
- `Mime` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:151` | Self: 0.0% (502us) | Total: 0.0% (502us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `set`
`[native code]` | Self: 0.0% (495us) | Total: 0.0% (495us) | Samples: 1

**Called by:**
- `define` (1)

### `Request`
`[native code]` | Self: 0.0% (489us) | Total: 0.0% (489us) | Samples: 1

**Called by:**
- `static` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:247` | Self: 0.0% (488us) | Total: 0.0% (488us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `internal:streams/destroy`
`internal:streams/destroy:16` | Self: 0.0% (475us) | Total: 0.0% (475us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `supportsColor`
`/home/user/bun-node/node_modules/supports-color/index.js` | Self: 0.0% (465us) | Total: 0.0% (465us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `replace`
`[native code]` | Self: 0.0% (463us) | Total: 0.0% (463us) | Samples: 1

**Called by:**
- `mimeScore` (1)

### `extractWildcardNames`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:242` | Self: 0.0% (460us) | Total: 0.0% (460us) | Samples: 1

**Called by:**
- `setRoute` (1)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:44` | Self: 0.0% (459us) | Total: 0.0% (459us) | Samples: 1

**Called by:**
- `_preferredType` (1)

### `node:http`
`node:http:5` | Self: 0.0% (457us) | Total: 0.0% (457us) | Samples: 1

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:173` | Self: 0.0% (457us) | Total: 0.0% (457us) | Samples: 1

**Called by:**
- `forEach` (1)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` | Self: 0.0% (456us) | Total: 0.0% (456us) | Samples: 1

**Called by:**
- `async makeTarget` (1)

### `reduce`
`[native code]` | Self: 0.0% (456us) | Total: 0.0% (456us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `isFunction`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` | Self: 0.0% (446us) | Total: 0.0% (446us) | Samples: 1

**Called by:**
- `toUpgradeHook` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:167` | Self: 0.0% (444us) | Total: 0.0% (444us) | Samples: 1

**Called by:**
- `forEach` (1)

### `has`
`[native code]` | Self: 0.0% (442us) | Total: 0.0% (442us) | Samples: 1

**Called by:**
- `define` (1)

### `setPrototypeOf`
`[native code]` | Self: 0.0% (440us) | Total: 0.0% (440us) | Samples: 1

**Called by:**
- `deprecate` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts:481` | Self: 0.0% (438us) | Total: 0.0% (438us) | Samples: 1

### `isString`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` | Self: 0.0% (437us) | Total: 0.0% (437us) | Samples: 1

**Called by:**
- `addRoute` (1)

### `Agent`
`node:_http_agent` | Self: 0.0% (435us) | Total: 0.0% (435us) | Samples: 1

**Called by:**
- `node:_http_agent` (1)

### `Writable`
`internal:streams/writable` | Self: 0.0% (435us) | Total: 0.0% (435us) | Samples: 1

**Called by:**
- `WriteStream` (1)

### `registerExpressStyle`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts` | Self: 0.0% (434us) | Total: 0.0% (434us) | Samples: 1

**Called by:**
- `async makeTarget` (1)

### `node:_http_outgoing`
`node:_http_outgoing:511` | Self: 0.0% (433us) | Total: 0.0% (433us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `node:_http_incoming`
`node:_http_incoming:175` | Self: 0.0% (432us) | Total: 0.0% (432us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `setName`
`node:fs` | Self: 0.0% (430us) | Total: 0.0% (430us) | Samples: 1

**Called by:**
- `node:fs` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (429us) | Total: 0.0% (429us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/content-type/dist/index.js` | Self: 0.0% (428us) | Total: 0.0% (428us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `#produceResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` | Self: 0.0% (427us) | Total: 0.0% (427us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (427us) | Total: 0.0% (427us) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1033` | Self: 0.0% (426us) | Total: 0.0% (426us) | Samples: 1

**Called by:**
- `registerExpressStyle` (1)

### `bound require`
`[native code]` | Self: 0.0% (425us) | Total: 1.4% (91.7ms) | Samples: 1

**Called by:**
- `(anonymous)` (33)
- `(anonymous)` (25)
- `(anonymous)` (16)
- `(anonymous)` (13)
- `(anonymous)` (13)
- `(anonymous)` (12)
- `(anonymous)` (11)
- `(anonymous)` (10)
- `(anonymous)` (5)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `setup` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(module)` (1)
- `(anonymous)` (1)

**Calls:**
- `require` (164)
- `anonymous` (5)
- `(anonymous)` (2)

### `createPrivateSymbol`
`[native code]` | Self: 0.0% (424us) | Total: 0.0% (424us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` | Self: 0.0% (424us) | Total: 0.0% (424us) | Samples: 1

**Called by:**
- `Cache` (1)

### `Map`
`[native code]` | Self: 0.0% (423us) | Total: 0.0% (423us) | Samples: 1

**Called by:**
- `Cache` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:177` | Self: 0.0% (422us) | Total: 0.0% (422us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `node:_http_common`
`node:_http_common:2` | Self: 0.0% (419us) | Total: 0.1% (9.8ms) | Samples: 1

**Called by:**
- `anonymous` (22)

**Calls:**
- `anonymous` (21)

### `node:crypto`
`node:crypto:99` | Self: 0.0% (419us) | Total: 0.0% (419us) | Samples: 1

### `parse`
`/home/user/bun-node/node_modules/picoquery/lib/parse.js` | Self: 0.0% (419us) | Total: 0.0% (419us) | Samples: 1

**Called by:**
- `(module)` (1)

### `exec`
`[native code]` | Self: 0.0% (418us) | Total: 0.0% (418us) | Samples: 1

**Called by:**
- `matchRoute` (1)

### `Uint32Array`
`[native code]` | Self: 0.0% (415us) | Total: 0.0% (415us) | Samples: 1

**Called by:**
- `node:zlib` (1)

### `_preferredTypeLegacy`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:202` | Self: 0.0% (412us) | Total: 0.0% (412us) | Samples: 1

**Called by:**
- `forEachMimeType` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (411us) | Total: 0.0% (411us) | Samples: 1

**Called by:**
- `flushPending` (1)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (409us) | Total: 0.0% (409us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `internal:primordials`
`internal:primordials:15` | Self: 0.0% (408us) | Total: 0.0% (408us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:696` | Self: 0.0% (405us) | Total: 0.0% (2.5ms) | Samples: 1

**Called by:**
- `#routeRequest` (2)

**Calls:**
- `normalizeEtagOption` (1)

### `segmentKind`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:75` | Self: 0.0% (405us) | Total: 0.0% (786us) | Samples: 1

**Called by:**
- `map` (2)

**Calls:**
- `test` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:20` | Self: 0.0% (404us) | Total: 0.0% (404us) | Samples: 1

**Called by:**
- `setRoute` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` | Self: 0.0% (404us) | Total: 0.0% (404us) | Samples: 1

**Called by:**
- `setRoute` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs` | Self: 0.0% (403us) | Total: 0.0% (403us) | Samples: 1

**Called by:**
- `#compileMiddlewareRegExp` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:30` | Self: 0.0% (402us) | Total: 0.0% (402us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `#build`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:196` | Self: 0.0% (400us) | Total: 0.0% (400us) | Samples: 1

**Called by:**
- `candidates` (1)

### `symbolToStringify`
`node:os:126` | Self: 0.0% (400us) | Total: 0.0% (400us) | Samples: 1

**Called by:**
- `node:os` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:157` | Self: 0.0% (399us) | Total: 0.0% (399us) | Samples: 1

**Called by:**
- `forEach` (1)

### `WriteStream`
`internal:fs/streams` | Self: 0.0% (399us) | Total: 0.0% (399us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `node:fs/promises`
`node:fs/promises:8` | Self: 0.0% (396us) | Total: 0.0% (396us) | Samples: 1

### `SafeSet`
`internal:primordials` | Self: 0.0% (395us) | Total: 0.0% (395us) | Samples: 1

**Called by:**
- `internal:util/inspect` (1)

### `addRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1256` | Self: 0.0% (395us) | Total: 0.0% (832us) | Samples: 1

**Called by:**
- `registerExpressStyle` (2)

**Calls:**
- `isString` (1)

### `filter`
`[native code]` | Self: 0.0% (395us) | Total: 0.0% (395us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:85` | Self: 0.0% (391us) | Total: 0.0% (391us) | Samples: 1

### `startInterval`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` | Self: 0.0% (389us) | Total: 0.0% (389us) | Samples: 1

**Called by:**
- `Cache` (1)

### `init`
`/home/user/bun-node/node_modules/debug/src/node.js` | Self: 0.0% (389us) | Total: 0.0% (389us) | Samples: 1

**Called by:**
- `createDebug` (1)

### `bind`
`[native code]` | Self: 0.0% (389us) | Total: 0.0% (389us) | Samples: 1

**Called by:**
- `makeSafe` (1)

### `static`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` | Self: 0.0% (388us) | Total: 0.0% (388us) | Samples: 1

**Called by:**
- `(module)` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:176` | Self: 0.0% (388us) | Total: 0.0% (388us) | Samples: 1

**Called by:**
- `forEach` (1)

### `invalidate`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (386us) | Total: 0.0% (386us) | Samples: 1

**Called by:**
- `setRoute` (1)

### `splitPattern`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:58` | Self: 0.0% (383us) | Total: 0.0% (383us) | Samples: 1

**Called by:**
- `compileRoute` (1)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:80` | Self: 0.0% (382us) | Total: 0.0% (382us) | Samples: 1

**Called by:**
- `map` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:189` | Self: 0.0% (382us) | Total: 0.0% (382us) | Samples: 1

### `test`
`[native code]` | Self: 0.0% (381us) | Total: 0.0% (381us) | Samples: 1

**Called by:**
- `segmentKind` (1)

### `pick`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` | Self: 0.0% (379us) | Total: 0.0% (379us) | Samples: 1

**Called by:**
- `BunRouter` (1)

### `registerExpressStyle`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:177` | Self: 0.0% (376us) | Total: 0.4% (29.1ms) | Samples: 1

**Called by:**
- `async makeTarget` (43)

**Calls:**
- `setRoute` (34)
- `setRoute` (2)
- `addRoute` (2)
- `setRoute` (1)
- `setRoute` (1)
- `setRoute` (1)
- `get` (1)

### `getOwnPropertyNames`
`[native code]` | Self: 0.0% (375us) | Total: 0.0% (375us) | Samples: 1

**Called by:**
- `internal:util/inspect` (1)

### `(anonymous)`
`node:diagnostics_channel` | Self: 0.0% (374us) | Total: 0.0% (374us) | Samples: 1

**Called by:**
- `WeakRefMap` (1)

### `serve`
`[native code]` | Self: 0.0% (372us) | Total: 0.0% (372us) | Samples: 1

**Called by:**
- `(module)` (1)

### `isUndefined`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` | Self: 0.0% (361us) | Total: 0.0% (361us) | Samples: 1

**Called by:**
- `parseCookies` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:442` | Self: 0.0% (359us) | Total: 0.0% (359us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `init`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1432` | Self: 0.0% (358us) | Total: 25.4% (1.65s) | Samples: 1

**Called by:**
- `serveNativeRequest` (166)

**Calls:**
- `BunRequest` (47)
- `BunRequest` (33)
- `BunRequest` (24)
- `BunRequest` (22)
- `BunRequest` (20)
- `BunRequest` (13)
- `BunRequest` (4)
- `BunRequest` (2)

### `from`
`[native code]` | Self: 0.0% (356us) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(module)` (1)
- `(module)` (1)

**Calls:**
- `(anonymous)` (1)

### `#build`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:195` | Self: 0.0% (355us) | Total: 0.0% (355us) | Samples: 1

**Called by:**
- `candidates` (1)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2488` | Self: 0.0% (351us) | Total: 0.0% (351us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `isDisjoint`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (340us) | Total: 0.0% (340us) | Samples: 1

**Called by:**
- `candidates` (1)

### `get headersSent`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (339us) | Total: 0.0% (339us) | Samples: 1

**Called by:**
- `#settleLayer` (1)

### `node:util`
`node:util:463` | Self: 0.0% (336us) | Total: 0.0% (336us) | Samples: 1

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:443` | Self: 0.0% (334us) | Total: 1.9% (125.7ms) | Samples: 1

**Called by:**
- `serveNativeRequest` (5)

**Calls:**
- `get method` (2)
- `method` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:38` | Self: 0.0% (332us) | Total: 0.0% (332us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5066` | Self: 0.0% (308us) | Total: 0.0% (308us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:88` | Self: 0.0% (0us) | Total: 0.0% (396us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `map` (1)

### `node:http`
`node:http:2` | Self: 0.0% (0us) | Total: 0.3% (23.6ms) | Samples: 0

**Calls:**
- `anonymous` (45)

### `node:os`
`node:os:119` | Self: 0.0% (0us) | Total: 0.0% (400us) | Samples: 0

**Calls:**
- `symbolToStringify` (1)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` | Self: 0.0% (0us) | Total: 7.8% (511.9ms) | Samples: 0

**Called by:**
- `BunRequest` (34)

**Calls:**
- `splitRequestUrl` (15)
- `splitRequestUrl` (7)
- `splitRequestUrl` (3)
- `splitRequestUrl` (3)
- `splitRequestUrl` (3)
- `splitRequestUrl` (1)
- `splitRequestUrl` (1)
- `splitRequestUrl` (1)

### `populateMaps`
`/home/user/bun-node/node_modules/mime-types/index.js:158` | Self: 0.0% (0us) | Total: 0.0% (3.3ms) | Samples: 0

**Called by:**
- `(anonymous)` (6)

**Calls:**
- `forEach` (6)

### `use`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4238` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `registerExpressStyle` (4)

**Calls:**
- `flushPending` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-types/index.js:16` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `data`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:89` | Self: 0.0% (0us) | Total: 19.1% (1.24s) | Samples: 0

**Calls:**
- `write` (68)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:40` | Self: 0.0% (0us) | Total: 0.0% (807us) | Samples: 0

**Called by:**
- `_preferredType` (2)

**Calls:**
- `split` (2)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:237` | Self: 0.0% (0us) | Total: 0.0% (340us) | Samples: 0

**Called by:**
- `getMatchedLayers` (1)

**Calls:**
- `isDisjoint` (1)

### `registerExpressStyle`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:173` | Self: 0.0% (0us) | Total: 0.0% (502us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `setRoute` (1)

### `node:fs`
`node:fs:702` | Self: 0.0% (0us) | Total: 0.0% (430us) | Samples: 0

**Calls:**
- `setName` (1)

### `node:os`
`node:os:110` | Self: 0.0% (0us) | Total: 0.0% (880us) | Samples: 0

**Calls:**
- `bound` (1)

### `internal:streams/readable`
`internal:streams/readable:2` | Self: 0.0% (0us) | Total: 0.0% (3.2ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `anonymous` (7)

### `async run`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:69` | Self: 0.0% (0us) | Total: 0.5% (36.2ms) | Samples: 0

**Called by:**
- `async run` (1)

**Calls:**
- `Promise` (1)

### `get headersSent`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` | Self: 0.0% (0us) | Total: 0.0% (714us) | Samples: 0

**Called by:**
- `send` (1)

**Calls:**
- `get isLongLived` (1)

### `BunRouter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:889` | Self: 0.0% (0us) | Total: 0.0% (379us) | Samples: 0

**Called by:**
- `BunHttpAdapter` (1)

**Calls:**
- `pick` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:14` | Self: 0.0% (0us) | Total: 0.0% (424us) | Samples: 0

**Called by:**
- `Route` (1)

**Calls:**
- `(anonymous)` (1)

### `node:crypto`
`node:crypto:2` | Self: 0.0% (0us) | Total: 0.0% (2.9ms) | Samples: 0

**Calls:**
- `anonymous` (2)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3031` | Self: 0.0% (0us) | Total: 0.0% (361us) | Samples: 0

**Called by:**
- `BunRequest` (1)

**Calls:**
- `isUndefined` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/node_modules/mime-db/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (4.6ms) | Samples: 0

**Called by:**
- `anonymous` (10)

**Calls:**
- `bound require` (10)

### `node:zlib`
`node:zlib:456` | Self: 0.0% (0us) | Total: 0.0% (581us) | Samples: 0

**Calls:**
- `map` (1)

### `node:_http_outgoing`
`node:_http_outgoing:44` | Self: 0.0% (0us) | Total: 0.0% (463us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `split` (1)

### `internal:streams/compose`
`internal:streams/compose:2` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `anonymous` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/index.js:3` | Self: 0.0% (0us) | Total: 0.0% (5.9ms) | Samples: 0

**Calls:**
- `bound require` (1)

### `node:crypto`
`node:crypto:293` | Self: 0.0% (0us) | Total: 0.0% (440us) | Samples: 0

**Calls:**
- `deprecate` (1)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:350` | Self: 0.0% (0us) | Total: 0.0% (619us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `set logger` (1)

### `internal:errors`
`internal:errors:2` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/index.js:9` | Self: 0.0% (0us) | Total: 0.2% (15.7ms) | Samples: 0

**Calls:**
- `bound require` (13)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:39` | Self: 0.0% (0us) | Total: 0.0% (495us) | Samples: 0

**Called by:**
- `Mime` (1)

**Calls:**
- `set` (1)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5260` | Self: 0.0% (0us) | Total: 0.0% (339us) | Samples: 0

**Called by:**
- `#runPipeline` (1)

**Calls:**
- `get headersSent` (1)

### `node:path`
`node:path:2` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:14` | Self: 0.0% (0us) | Total: 0.0% (320us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `node:fs/promises`
`node:fs/promises:2` | Self: 0.0% (0us) | Total: 0.0% (3.5ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `WeakRefMap`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (374us) | Samples: 0

**Called by:**
- `node:diagnostics_channel` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:32` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `#canSkipHeaders`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:571` | Self: 0.0% (0us) | Total: 0.2% (17.9ms) | Samples: 0

**Called by:**
- `#respondWithText` (2)

**Calls:**
- `method` (1)
- `get method` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/accepts/index.js:16` | Self: 0.0% (0us) | Total: 0.1% (10.1ms) | Samples: 0

**Calls:**
- `bound require` (25)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:242` | Self: 0.0% (0us) | Total: 0.0% (2.9ms) | Samples: 0

**Called by:**
- `#compileRouteRegExp` (6)

**Calls:**
- `RegExp` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:240` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `setup` (2)
- `bound require` (1)
- `setup` (1)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1209` | Self: 0.0% (0us) | Total: 0.2% (17.9ms) | Samples: 0

**Called by:**
- `#runPipeline` (2)

**Calls:**
- `#canSkipHeaders` (2)

### `WriteStream`
`internal:fs/streams:259` | Self: 0.0% (0us) | Total: 0.0% (435us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `Writable` (1)

### `internal:validators`
`internal:validators:2` | Self: 0.0% (0us) | Total: 0.0% (389us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:42` | Self: 0.0% (0us) | Total: 0.1% (8.4ms) | Samples: 0

**Called by:**
- `anonymous` (19)

**Calls:**
- `populateMaps` (19)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:20` | Self: 0.0% (0us) | Total: 0.0% (442us) | Samples: 0

**Called by:**
- `Mime` (1)

**Calls:**
- `has` (1)

### `node:_http_agent`
`node:_http_agent:290` | Self: 0.0% (0us) | Total: 0.0% (435us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `Agent` (1)

### `node:_http_incoming`
`node:_http_incoming:15` | Self: 0.0% (0us) | Total: 0.0% (3.2ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `anonymous` (7)

### `node:_http_agent`
`node:_http_agent:2` | Self: 0.0% (0us) | Total: 0.0% (802us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (2)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:70` | Self: 0.0% (0us) | Total: 0.0% (389us) | Samples: 0

**Called by:**
- `Route` (1)

**Calls:**
- `startInterval` (1)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:86` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `map` (3)

**Calls:**
- `map` (3)

### `internal:util/inspect`
`internal:util/inspect:46` | Self: 0.0% (0us) | Total: 0.0% (770us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `SafeSet` (1)
- `getOwnPropertyNames` (1)

### `matchRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4634` | Self: 0.0% (0us) | Total: 0.0% (418us) | Samples: 0

**Called by:**
- `getMatchedLayers` (1)

**Calls:**
- `exec` (1)

### `internal:streams/duplex`
`internal:streams/duplex:2` | Self: 0.0% (0us) | Total: 0.0% (861us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (2)

### `resolveLogger`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:1044` | Self: 0.0% (0us) | Total: 0.0% (619us) | Samples: 0

**Called by:**
- `set logger` (1)

**Calls:**
- `hasMethods` (1)

### `node:zlib`
`node:zlib:385` | Self: 0.0% (0us) | Total: 0.0% (415us) | Samples: 0

**Calls:**
- `Uint32Array` (1)

### `#build`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:198` | Self: 0.0% (0us) | Total: 0.0% (397us) | Samples: 0

**Called by:**
- `candidates` (1)

**Calls:**
- `get` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (5.0ms) | Samples: 0

**Called by:**
- `anonymous` (11)

**Calls:**
- `bound require` (11)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:457` | Self: 0.0% (0us) | Total: 0.0% (419us) | Samples: 0

**Calls:**
- `parse` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-types/index.js:40` | Self: 0.0% (0us) | Total: 0.0% (3.3ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `populateMaps` (6)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` | Self: 0.0% (0us) | Total: 0.0% (424us) | Samples: 0

**Calls:**
- `createPrivateSymbol` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:17` | Self: 0.0% (0us) | Total: 0.0% (840us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `node:util`
`node:util:8` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `get isLongLived`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1035` | Self: 0.0% (0us) | Total: 0.0% (714us) | Samples: 0

**Called by:**
- `get headersSent` (1)

**Calls:**
- `get isKeepAlive` (1)

### `send`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1396` | Self: 0.0% (0us) | Total: 0.0% (714us) | Samples: 0

**Called by:**
- `#runPipeline` (1)

**Calls:**
- `get headersSent` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:67` | Self: 0.0% (0us) | Total: 0.0% (423us) | Samples: 0

**Called by:**
- `Route` (1)

**Calls:**
- `Map` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5134` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Called by:**
- `#routeRequest` (2)

**Calls:**
- `#settleLayer` (1)
- `#settleLayer` (1)

### `node:crypto`
`node:crypto:39` | Self: 0.0% (0us) | Total: 0.0% (363us) | Samples: 0

**Calls:**
- `@lazy` (1)

### `async run`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:99` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Calls:**
- `end` (1)

### `Mime`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:13` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Called by:**
- `(module)` (5)

**Calls:**
- `define` (2)
- `define` (1)
- `define` (1)
- `define` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:194` | Self: 0.0% (0us) | Total: 0.0% (425us) | Samples: 0

**Calls:**
- `bound require` (1)

### `node:_http_client`
`node:_http_client:10` | Self: 0.0% (0us) | Total: 0.2% (13.2ms) | Samples: 0

**Called by:**
- `anonymous` (30)

**Calls:**
- `anonymous` (30)

### `(module)`
`/home/user/bun-node/node_modules/uint8array-extras/index.js:178` | Self: 0.0% (0us) | Total: 0.0% (356us) | Samples: 0

**Calls:**
- `from` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:455` | Self: 0.0% (0us) | Total: 30.2% (1.96s) | Samples: 0

**Called by:**
- `serveNativeRequest` (210)

**Calls:**
- `#runPipeline` (140)
- `dispatch` (52)
- `#runPipeline` (7)
- `#runPipeline` (6)
- `#runPipeline` (2)
- `dispatch` (1)
- `#runPipeline` (1)
- `#runPipeline` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:54` | Self: 0.0% (0us) | Total: 0.0% (2.3ms) | Samples: 0

**Called by:**
- `(module)` (5)

**Calls:**
- `async makeTarget` (4)
- `async makeTarget` (1)

### `useColors`
`/home/user/bun-node/node_modules/debug/src/node.js:158` | Self: 0.0% (0us) | Total: 0.0% (834us) | Samples: 0

**Called by:**
- `createDebug` (2)

**Calls:**
- `(anonymous)` (2)

### `get inspect`
`node:util:481` | Self: 0.0% (0us) | Total: 0.2% (15.7ms) | Samples: 0

**Calls:**
- `lazyInspectModule` (10)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:333` | Self: 0.0% (0us) | Total: 0.0% (379us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `BunRouter` (1)

### `internal:primordials`
`internal:primordials:76` | Self: 0.0% (0us) | Total: 0.0% (389us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `makeSafe` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (958us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `static`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` | Self: 0.0% (0us) | Total: 0.0% (489us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `Request` (1)

### `createDebug`
`/home/user/bun-node/node_modules/debug/src/common.js:117` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `(module)` (3)

**Calls:**
- `useColors` (2)
- `useColors` (1)

### `internal:streams/readable`
`internal:streams/readable:14` | Self: 0.0% (0us) | Total: 0.0% (351us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:13` | Self: 0.0% (0us) | Total: 0.0% (970us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `populateMaps`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:155` | Self: 0.0% (0us) | Total: 0.1% (8.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (19)

**Calls:**
- `forEach` (18)
- `keys` (1)

### `_preferredType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:189` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `forEachMimeType` (4)

**Calls:**
- `mimeScore` (2)
- `mimeScore` (1)
- `mimeScore` (1)

### `node:diagnostics_channel`
`node:diagnostics_channel:134` | Self: 0.0% (0us) | Total: 0.0% (374us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `WeakRefMap` (1)

### `data`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:77` | Self: 0.0% (0us) | Total: 0.8% (52.5ms) | Samples: 0

**Calls:**
- `toString` (8)

### `BunWebSocket`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts:538` | Self: 0.0% (0us) | Total: 0.0% (446us) | Samples: 0

**Called by:**
- `BunHttpAdapter` (1)

**Calls:**
- `toUpgradeHook` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:56` | Self: 0.0% (0us) | Total: 0.0% (877us) | Samples: 0

**Calls:**
- `static` (1)
- `static` (1)

### `deprecate`
`internal:util/deprecate:25` | Self: 0.0% (0us) | Total: 0.0% (440us) | Samples: 0

**Called by:**
- `node:crypto` (1)

**Calls:**
- `setPrototypeOf` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4782` | Self: 0.0% (0us) | Total: 1.2% (82.1ms) | Samples: 0

**Called by:**
- `dispatch` (8)

**Calls:**
- `get` (7)
- `get` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:84` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `setRoute` (3)

**Calls:**
- `Cache` (1)
- `Cache` (1)
- `Cache` (1)

### `async run`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:64` | Self: 0.0% (0us) | Total: 0.1% (8.7ms) | Samples: 0

**Called by:**
- `async run` (1)

**Calls:**
- `repeat` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:11` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `#compileRouteRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` | Self: 0.0% (0us) | Total: 0.0% (436us) | Samples: 0

**Called by:**
- `Route` (1)

**Calls:**
- `map` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5062` | Self: 0.0% (0us) | Total: 1.1% (74.4ms) | Samples: 0

**Called by:**
- `#routeRequest` (6)

**Calls:**
- `params` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:16` | Self: 0.0% (0us) | Total: 0.2% (14.8ms) | Samples: 0

**Calls:**
- `bound require` (33)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:126` | Self: 0.0% (0us) | Total: 0.0% (456us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `reduce` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:106` | Self: 0.0% (0us) | Total: 0.6% (45.0ms) | Samples: 0

**Calls:**
- `async run` (2)

### `(module)`
`/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Calls:**
- `createDebug` (3)
- `createDebug` (1)

### `async run`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:61` | Self: 0.0% (0us) | Total: 0.6% (45.0ms) | Samples: 0

**Called by:**
- `(module)` (2)

**Calls:**
- `async run` (1)
- `async run` (1)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1331` | Self: 0.0% (0us) | Total: 0.1% (10.4ms) | Samples: 0

**Called by:**
- `BunRequest` (3)

**Calls:**
- `get` (3)

### `#writableOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1356` | Self: 0.0% (0us) | Total: 0.0% (3.3ms) | Samples: 0

**Called by:**
- `BunRequest` (1)

**Calls:**
- `cloneObject` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/multipart/stream.ts:4` | Self: 0.0% (0us) | Total: 0.0% (366us) | Samples: 0

**Calls:**
- `promisify2` (1)

### `registerExpressStyle`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:169` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `async makeTarget` (4)

**Calls:**
- `use` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/supports-color/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (427us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:84` | Self: 0.0% (0us) | Total: 0.0% (383us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `splitPattern` (1)

### `(module)`
`/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` | Self: 0.0% (0us) | Total: 0.0% (720us) | Samples: 0

**Calls:**
- `from` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1271` | Self: 0.0% (0us) | Total: 3.2% (213.9ms) | Samples: 0

**Called by:**
- `init` (22)

**Calls:**
- `#finishAbsentBody` (6)
- `#finishAbsentBody` (6)
- `#finishAbsentBody` (4)
- `#finishAbsentBody` (3)
- `#finishAbsentBody` (2)
- `#finishAbsentBody` (1)

### `(module)`
`/home/user/bun-node/node_modules/ip-regex/index.js:25` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Calls:**
- `RegExp` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:446` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `serveNativeRequest` (2)

**Calls:**
- `get originalUrl` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/index.js:41` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/index.js:44` | Self: 0.0% (0us) | Total: 0.0% (395us) | Samples: 0

**Calls:**
- `filter` (1)

### `promisify2`
`internal:promisify:17` | Self: 0.0% (0us) | Total: 0.0% (366us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `get` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:57` | Self: 0.0% (0us) | Total: 0.3% (23.9ms) | Samples: 0

**Called by:**
- `setRoute` (32)

**Calls:**
- `#compileRouteRegExp` (29)
- `#compileRouteRegExp` (2)
- `#compileRouteRegExp` (1)

### `toUpgradeHook`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/wsUpgrade.ts:63` | Self: 0.0% (0us) | Total: 0.0% (446us) | Samples: 0

**Called by:**
- `BunWebSocket` (1)

**Calls:**
- `isFunction` (1)

### `setup`
`/home/user/bun-node/node_modules/debug/src/common.js:14` | Self: 0.0% (0us) | Total: 0.0% (809us) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `bound require` (2)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:80` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Calls:**
- `BunHttpAdapter` (1)
- `BunHttpAdapter` (1)
- `BunHttpAdapter` (1)
- `BunHttpAdapter` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:84` | Self: 0.0% (0us) | Total: 0.4% (31.7ms) | Samples: 0

**Calls:**
- `registerExpressStyle` (43)
- `registerExpressStyle` (4)
- `registerExpressStyle` (1)
- `registerExpressStyle` (1)

### `internal:streams/pipeline`
`internal:streams/pipeline:2` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `node:tty`
`node:tty:7` | Self: 0.0% (0us) | Total: 0.0% (773us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` | Self: 0.0% (0us) | Total: 0.0% (720us) | Samples: 0

**Called by:**
- `from` (1)

**Calls:**
- `toString` (1)

### `(module)`
`/home/user/bun-node/node_modules/mime/dist/src/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (5.7ms) | Samples: 0

**Calls:**
- `Mime` (5)
- `Mime` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:6` | Self: 0.0% (0us) | Total: 0.0% (376us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `internal:http/FakeSocket`
`internal:http/FakeSocket:2` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `anonymous` (6)

### `bound serveNativeRequest`
`[native code]` | Self: 0.0% (0us) | Total: 0.3% (25.4ms) | Samples: 0

**Calls:**
- `serveNativeRequest` (31)
- `serveNativeRequest` (17)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:216` | Self: 0.0% (0us) | Total: 0.0% (5.3ms) | Samples: 0

**Called by:**
- `getMatchedLayers` (12)

**Calls:**
- `#build` (9)
- `#build` (1)
- `#build` (1)
- `#build` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:54` | Self: 0.0% (0us) | Total: 0.0% (2.7ms) | Samples: 0

**Calls:**
- `async makeTarget` (5)
- `async makeTarget` (1)

### `internal:stream`
`internal:stream:46` | Self: 0.0% (0us) | Total: 0.0% (410us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/types/multipart.js:5` | Self: 0.0% (0us) | Total: 0.0% (351us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:39` | Self: 0.0% (0us) | Total: 0.0% (822us) | Samples: 0

**Called by:**
- `#compileRouteRegExp` (1)

**Calls:**
- `charCodeAt` (1)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:352` | Self: 0.0% (0us) | Total: 0.0% (446us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `BunWebSocket` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `internal:streams/destroy`
`internal:streams/destroy:2` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `internal:streams/add-abort-signal`
`internal:streams/add-abort-signal:2` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (2)

### `node:vm`
`node:vm:12` | Self: 0.0% (0us) | Total: 0.0% (3.2ms) | Samples: 0

**Calls:**
- `@lazy` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:59` | Self: 0.0% (0us) | Total: 0.0% (403us) | Samples: 0

**Called by:**
- `setRoute` (1)

**Calls:**
- `#compileMiddlewareRegExp` (1)

### `#compileRouteRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:194` | Self: 0.0% (0us) | Total: 0.3% (22.7ms) | Samples: 0

**Called by:**
- `Route` (29)

**Calls:**
- `pathRegex` (18)
- `pathRegex` (6)
- `pathRegex` (1)
- `pathRegex` (1)
- `pathRegex` (1)
- `pathRegex` (1)
- `pathRegex` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1079` | Self: 0.0% (0us) | Total: 0.0% (386us) | Samples: 0

**Called by:**
- `registerExpressStyle` (1)

**Calls:**
- `invalidate` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4805` | Self: 0.0% (0us) | Total: 0.0% (418us) | Samples: 0

**Called by:**
- `dispatch` (1)

**Calls:**
- `matchRoute` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (3.1ms) | Samples: 0

**Calls:**
- `bound require` (3)

### `createDebug`
`/home/user/bun-node/node_modules/debug/src/common.js:143` | Self: 0.0% (0us) | Total: 0.0% (389us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `init` (1)

### `makeSafe`
`internal:primordials:41` | Self: 0.0% (0us) | Total: 0.0% (389us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `bind` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/supports-color/index.js:133` | Self: 0.0% (0us) | Total: 0.0% (465us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `supportsColor` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/accepts/index.js:15` | Self: 0.0% (0us) | Total: 0.1% (9.6ms) | Samples: 0

**Calls:**
- `bound require` (16)

### `get`
`internal:stream:69` | Self: 0.0% (0us) | Total: 0.0% (366us) | Samples: 0

**Called by:**
- `promisify2` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/content-type/dist/index.js:30` | Self: 0.0% (0us) | Total: 0.0% (428us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-db/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (4.0ms) | Samples: 0

**Called by:**
- `anonymous` (12)

**Calls:**
- `bound require` (12)

### `internal:stream`
`internal:stream:2` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `anonymous` (5)

### `set logger`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:931` | Self: 0.0% (0us) | Total: 0.0% (619us) | Samples: 0

**Called by:**
- `BunHttpAdapter` (1)

**Calls:**
- `resolveLogger` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:55` | Self: 0.0% (0us) | Total: 0.0% (372us) | Samples: 0

**Calls:**
- `serve` (1)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:42` | Self: 0.0% (0us) | Total: 0.0% (463us) | Samples: 0

**Called by:**
- `_preferredType` (1)

**Calls:**
- `replace` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1239` | Self: 0.0% (0us) | Total: 0.0% (3.6ms) | Samples: 0

**Called by:**
- `init` (2)

**Calls:**
- `isBoolean` (2)

### `node:_http_incoming`
`node:_http_incoming:2` | Self: 0.0% (0us) | Total: 0.0% (4.9ms) | Samples: 0

**Called by:**
- `anonymous` (11)

**Calls:**
- `anonymous` (11)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4793` | Self: 0.0% (0us) | Total: 0.0% (5.6ms) | Samples: 0

**Called by:**
- `dispatch` (13)

**Calls:**
- `candidates` (12)
- `candidates` (1)

### `#compileMiddlewareRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:209` | Self: 0.0% (0us) | Total: 0.0% (403us) | Samples: 0

**Called by:**
- `Route` (1)

**Calls:**
- `pathRegex` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1031` | Self: 0.0% (0us) | Total: 0.4% (26.4ms) | Samples: 0

**Called by:**
- `registerExpressStyle` (34)
- `flushPending` (3)
- `registerExpressStyle` (1)

**Calls:**
- `Route` (32)
- `Route` (3)
- `Route` (1)
- `Route` (1)
- `Route` (1)

### `internal:validators`
`internal:validators:67` | Self: 0.0% (0us) | Total: 0.0% (505us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `hideFromStack` (1)

### `flushPending`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4223` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `use` (4)

**Calls:**
- `setRoute` (3)
- `setRoute` (1)

### `internal:fs/binding`
`internal:fs/binding:3` | Self: 0.0% (0us) | Total: 0.0% (3.5ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `@lazy` (1)

### `#build`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:185` | Self: 0.0% (0us) | Total: 0.0% (4.1ms) | Samples: 0

**Called by:**
- `candidates` (9)

**Calls:**
- `map` (9)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/served.ts:109` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Calls:**
- `median` (1)

### `setup`
`/home/user/bun-node/node_modules/debug/src/common.js:17` | Self: 0.0% (0us) | Total: 0.0% (423us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `keys` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-types/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (4.3ms) | Samples: 0

**Called by:**
- `anonymous` (13)

**Calls:**
- `bound require` (13)

### `lazyInspectModule`
`node:util:17` | Self: 0.0% (0us) | Total: 0.2% (15.7ms) | Samples: 0

**Called by:**
- `get inspect` (10)

**Calls:**
- `anonymous` (10)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:79` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `async makeTarget` (4)

**Calls:**
- `importModule` (4)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/general.ts:31` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Calls:**
- `promisify2` (1)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2997` | Self: 0.0% (0us) | Total: 0.0% (865us) | Samples: 0

**Called by:**
- `BunRequest` (1)

**Calls:**
- `create` (1)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 44.0% | 2.86s | `[native code]` |
| 26.2% | 1.70s | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 11.8% | 774.2ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 6.6% | 434.7ms | `/home/user/bun-node/docs/plans/evidence/elysia2/served.ts` |
| 4.7% | 308.3ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 3.9% | 258.7ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 1.3% | 85.8ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.2% | 19.4ms | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs` |
| 0.1% | 7.0ms | `node:zlib` |
| 0.0% | 5.8ms | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` |
| 0.0% | 5.3ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 4.9ms | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts` |
| 0.0% | 4.8ms | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 3.7ms | `node:fs` |
| 0.0% | 2.5ms | `node:stream/web` |
| 0.0% | 2.5ms | `/home/user/bun-node/node_modules/type-is/index.js` |
| 0.0% | 2.4ms | `/home/user/bun-node/node_modules/mime-types/index.js` |
| 0.0% | 2.0ms | `internal:promisify` |
| 0.0% | 1.5ms | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 1.5ms | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 1.2ms | `node:os` |
| 0.0% | 1.1ms | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 813us | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 803us | `internal:primordials` |
| 0.0% | 619us | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts` |
| 0.0% | 505us | `internal:shared` |
| 0.0% | 475us | `internal:streams/destroy` |
| 0.0% | 465us | `/home/user/bun-node/node_modules/supports-color/index.js` |
| 0.0% | 459us | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js` |
| 0.0% | 457us | `node:http` |
| 0.0% | 438us | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts` |
| 0.0% | 435us | `internal:streams/writable` |
| 0.0% | 435us | `node:_http_agent` |
| 0.0% | 433us | `node:_http_outgoing` |
| 0.0% | 432us | `node:_http_incoming` |
| 0.0% | 428us | `/home/user/bun-node/node_modules/content-type/dist/index.js` |
| 0.0% | 419us | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 419us | `node:_http_common` |
| 0.0% | 419us | `node:crypto` |
| 0.0% | 399us | `internal:fs/streams` |
| 0.0% | 396us | `node:fs/promises` |
| 0.0% | 374us | `node:diagnostics_channel` |
| 0.0% | 336us | `node:util` |
| 0.0% | 332us | `/home/user/bun-node/node_modules/negotiator/index.js` |
