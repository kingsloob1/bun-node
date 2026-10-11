# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 4.25s | 10919 | 100us | 486 |

**Top 10:** `Response` 16.3%, `Request` 12.0%, `get` 5.9%, `BunRequest` 4.6%, `BunResponse` 3.7%, `BunRequest` 3.4%, `get` 2.8%, `splitRequestUrl` 2.6%, `params` 2.5%, `BunRequest` 2.4%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 16.3% | 695.9ms | 16.3% | 695.9ms | `Response` | `[native code]` |
| 12.0% | 514.0ms | 12.0% | 514.0ms | `Request` | `[native code]` |
| 5.9% | 251.0ms | 5.9% | 251.0ms | `get` | `[native code]` |
| 4.6% | 196.5ms | 4.6% | 196.5ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1231` |
| 3.7% | 158.8ms | 4.0% | 170.3ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` |
| 3.4% | 147.4ms | 3.4% | 148.4ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` |
| 2.8% | 120.2ms | 2.8% | 120.2ms | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:281` |
| 2.6% | 114.3ms | 2.6% | 114.3ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3506` |
| 2.5% | 106.6ms | 2.5% | 106.6ms | `params` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1706` |
| 2.4% | 103.6ms | 2.4% | 103.6ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 2.3% | 100.6ms | 2.3% | 100.6ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 2.2% | 95.0ms | 2.2% | 95.0ms | `method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 2.1% | 89.4ms | 2.1% | 89.8ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4470` |
| 2.0% | 86.7ms | 2.0% | 86.7ms | `alloc` | `[native code]` |
| 2.0% | 85.6ms | 6.2% | 264.2ms | `anonymous` | `[native code]` |
| 1.8% | 78.2ms | 1.9% | 82.0ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1213` |
| 1.5% | 67.0ms | 1.5% | 67.0ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3541` |
| 1.4% | 60.9ms | 1.6% | 68.8ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1261` |
| 1.3% | 59.0ms | 7.7% | 330.5ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:437` |
| 1.3% | 58.0ms | 1.3% | 58.0ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3507` |
| 1.2% | 55.2ms | 1.2% | 55.2ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4777` |
| 1.2% | 51.9ms | 1.2% | 51.9ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3042` |
| 1.1% | 50.1ms | 3.7% | 159.0ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3040` |
| 1.1% | 49.3ms | 9.5% | 404.8ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1267` |
| 1.1% | 47.7ms | 1.1% | 47.7ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3520` |
| 0.9% | 41.9ms | 0.9% | 41.9ms | `cloneObject` | `[native code]` |
| 0.8% | 34.9ms | 17.1% | 730.7ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1214` |
| 0.8% | 34.6ms | 37.3% | 1.59s | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1432` |
| 0.6% | 28.4ms | 0.6% | 28.4ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1335` |
| 0.6% | 27.5ms | 21.1% | 898.4ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5102` |
| 0.6% | 26.6ms | 0.6% | 26.6ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5072` |
| 0.6% | 26.1ms | 0.6% | 26.1ms | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/index.js:6` |
| 0.5% | 25.3ms | 0.5% | 25.3ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1336` |
| 0.5% | 24.4ms | 0.5% | 24.4ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4471` |
| 0.5% | 24.1ms | 0.5% | 24.3ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3540` |
| 0.5% | 21.9ms | 0.5% | 21.9ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3533` |
| 0.5% | 21.3ms | 0.5% | 21.3ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3521` |
| 0.4% | 19.3ms | 0.4% | 19.3ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5006` |
| 0.4% | 19.3ms | 6.1% | 260.4ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1306` |
| 0.4% | 18.4ms | 0.4% | 18.4ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:3` |
| 0.3% | 16.5ms | 2.4% | 103.2ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1340` |
| 0.3% | 15.8ms | 1.3% | 57.8ms | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1356` |
| 0.3% | 14.1ms | 0.3% | 14.1ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3029` |
| 0.3% | 13.8ms | 7.3% | 314.8ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4984` |
| 0.3% | 12.9ms | 43.8% | 1.86s | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:404` |
| 0.2% | 12.6ms | 0.2% | 12.6ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1203` |
| 0.2% | 12.1ms | 0.2% | 12.1ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3530` |
| 0.2% | 11.8ms | 0.2% | 11.8ms | `node:zlib` | `node:zlib:2` |
| 0.2% | 11.7ms | 0.2% | 12.4ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2997` |
| 0.2% | 11.1ms | 0.2% | 11.3ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:422` |
| 0.2% | 10.1ms | 0.2% | 10.1ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:514` |
| 0.2% | 9.2ms | 0.2% | 9.4ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2991` |
| 0.2% | 9.1ms | 0.2% | 9.1ms | `node:fs` | `node:fs:298` |
| 0.2% | 8.9ms | 1.7% | 74.1ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1331` |
| 0.2% | 8.7ms | 37.6% | 1.60s | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:402` |
| 0.2% | 8.5ms | 0.2% | 8.5ms | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.1% | 8.4ms | 0.1% | 8.4ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3546` |
| 0.1% | 8.2ms | 0.1% | 8.2ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4988` |
| 0.1% | 7.6ms | 0.1% | 7.6ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3045` |
| 0.1% | 7.1ms | 0.1% | 7.1ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3044` |
| 0.1% | 6.7ms | 32.7% | 1.39s | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:455` |
| 0.1% | 6.6ms | 0.1% | 6.6ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5009` |
| 0.1% | 5.9ms | 93.7% | 3.98s | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:20` |
| 0.1% | 5.8ms | 0.1% | 5.8ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:21` |
| 0.1% | 4.8ms | 0.1% | 4.8ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:29` |
| 0.1% | 4.7ms | 0.1% | 4.7ms | `#canSkipHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.1% | 4.5ms | 0.1% | 4.5ms | `replace` | `[native code]` |
| 0.1% | 4.5ms | 0.1% | 4.5ms | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2488` |
| 0.1% | 4.4ms | 0.1% | 4.4ms | `setPrototypeDirectOrThrow` | `[native code]` |
| 0.0% | 4.1ms | 0.1% | 4.5ms | `filter` | `[native code]` |
| 0.0% | 4.1ms | 0.0% | 4.1ms | `uncurryThis` | `internal:primordials` |
| 0.0% | 3.9ms | 0.0% | 3.9ms | `@lazy` | `[native code]` |
| 0.0% | 3.8ms | 0.0% | 3.8ms | `RegExp` | `[native code]` |
| 0.0% | 3.8ms | 2.5% | 108.5ms | `require` | `[native code]` |
| 0.0% | 3.4ms | 0.0% | 3.4ms | `splitRequestPath` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 3.4ms | 0.0% | 3.4ms | `node:stream/web` | `node:stream/web:7` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:199` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:18` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 2.5ms | 0.0% | 2.5ms | `enable` | `/home/user/bun-node/node_modules/debug/src/common.js` |
| 0.0% | 2.5ms | 0.0% | 2.5ms | `emitFinish` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:797` |
| 0.0% | 2.5ms | 0.0% | 2.7ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:440` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1272` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:185` |
| 0.0% | 2.1ms | 0.0% | 3.0ms | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:15` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `isObject` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:179` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:136` |
| 0.0% | 1.7ms | 12.1% | 515.8ms | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `importModule` | `[native code]` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `internal:promisify` | `internal:promisify:2` |
| 0.0% | 1.3ms | 1.8% | 78.0ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1332` |
| 0.0% | 1.2ms | 0.0% | 1.5ms | `from` | `[native code]` |
| 0.0% | 1.2ms | 0.1% | 5.0ms | `map` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:25` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3511` |
| 0.0% | 997us | 0.0% | 4.0ms | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:169` |
| 0.0% | 997us | 0.0% | 1.4ms | `segmentKind` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:71` |
| 0.0% | 991us | 0.3% | 14.5ms | `forEach` | `[native code]` |
| 0.0% | 978us | 0.0% | 1.5ms | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:20` |
| 0.0% | 958us | 0.0% | 958us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:157` |
| 0.0% | 948us | 0.0% | 948us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5135` |
| 0.0% | 944us | 0.0% | 944us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:164` |
| 0.0% | 943us | 0.0% | 943us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 942us | 0.8% | 37.3ms | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:177` |
| 0.0% | 928us | 0.0% | 928us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:521` |
| 0.0% | 921us | 0.0% | 921us | `split` | `[native code]` |
| 0.0% | 878us | 0.0% | 878us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:19` |
| 0.0% | 823us | 0.0% | 823us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 806us | 0.0% | 806us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:156` |
| 0.0% | 792us | 2.7% | 115.1ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4774` |
| 0.0% | 784us | 0.0% | 784us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5125` |
| 0.0% | 718us | 0.0% | 718us | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1409` |
| 0.0% | 717us | 0.0% | 1.6ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1299` |
| 0.0% | 697us | 0.0% | 697us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:49` |
| 0.0% | 692us | 0.0% | 692us | `#configuredCookieSecrets` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 690us | 0.0% | 690us | `originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3699` |
| 0.0% | 671us | 0.0% | 671us | `createConvenienceMethod` | `node:zlib` |
| 0.0% | 657us | 0.0% | 657us | `internal:http` | `internal:http:34` |
| 0.0% | 638us | 0.0% | 852us | `get headersSent` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` |
| 0.0% | 637us | 0.0% | 637us | `toUpperCase` | `[native code]` |
| 0.0% | 629us | 0.0% | 629us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:167` |
| 0.0% | 628us | 0.0% | 628us | `join` | `[native code]` |
| 0.0% | 628us | 0.0% | 628us | `get originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3699` |
| 0.0% | 620us | 0.0% | 620us | `(anonymous)` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 606us | 0.0% | 606us | `add` | `[native code]` |
| 0.0% | 602us | 0.0% | 602us | `isString` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:150` |
| 0.0% | 598us | 0.0% | 598us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3046` |
| 0.0% | 595us | 0.0% | 1.5ms | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:40` |
| 0.0% | 591us | 0.0% | 591us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:6` |
| 0.0% | 590us | 0.0% | 590us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:476` |
| 0.0% | 583us | 0.0% | 1.1ms | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:14` |
| 0.0% | 561us | 0.0% | 561us | `_freeze` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 533us | 0.0% | 533us | `freeze` | `[native code]` |
| 0.0% | 508us | 0.0% | 508us | `get settledResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2045` |
| 0.0% | 464us | 0.0% | 1.7ms | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js:158` |
| 0.0% | 461us | 0.0% | 461us | `layerFinished` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 442us | 0.0% | 442us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2496` |
| 0.0% | 440us | 0.0% | 440us | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 439us | 0.0% | 439us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 439us | 0.0% | 439us | `isBoolean` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 437us | 0.0% | 437us | `set query` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 436us | 0.0% | 436us | `test` | `[native code]` |
| 0.0% | 429us | 0.0% | 429us | `WriteStream` | `internal:fs/streams` |
| 0.0% | 426us | 0.0% | 426us | `Empty` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 424us | 0.0% | 424us | `parse` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 422us | 0.0% | 422us | `isArray` | `[native code]` |
| 0.0% | 420us | 0.0% | 420us | `(anonymous)` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 418us | 0.0% | 418us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:89` |
| 0.0% | 415us | 0.0% | 415us | `get size` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:276` |
| 0.0% | 411us | 0.0% | 411us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1699` |
| 0.0% | 409us | 0.0% | 409us | `getOwnPropertyDescriptor` | `[native code]` |
| 0.0% | 409us | 0.0% | 409us | `defineProperty` | `[native code]` |
| 0.0% | 409us | 0.0% | 409us | `createSafeIterator` | `internal:primordials` |
| 0.0% | 407us | 0.0% | 1.6ms | `(anonymous)` | `[native code]` |
| 0.0% | 407us | 0.0% | 407us | `push` | `[native code]` |
| 0.0% | 406us | 0.0% | 406us | `slice` | `[native code]` |
| 0.0% | 406us | 0.0% | 914us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:555` |
| 0.0% | 400us | 0.0% | 400us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 397us | 0.0% | 397us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:177` |
| 0.0% | 395us | 0.0% | 395us | `host` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3577` |
| 0.0% | 395us | 0.0% | 395us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 394us | 0.0% | 394us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` |
| 0.0% | 394us | 0.0% | 394us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1305` |
| 0.0% | 393us | 0.0% | 393us | `indexOf` | `[native code]` |
| 0.0% | 393us | 7.2% | 310.2ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1271` |
| 0.0% | 389us | 0.0% | 389us | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 389us | 0.0% | 389us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:447` |
| 0.0% | 386us | 0.0% | 386us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 386us | 0.0% | 386us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4784` |
| 0.0% | 386us | 0.0% | 586us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:431` |
| 0.0% | 383us | 0.0% | 383us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:178` |
| 0.0% | 382us | 0.0% | 382us | `(anonymous)` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:18` |
| 0.0% | 376us | 0.0% | 376us | `#respond` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:487` |
| 0.0% | 373us | 0.0% | 373us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:198` |
| 0.0% | 371us | 0.0% | 371us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:165` |
| 0.0% | 363us | 0.0% | 575us | `get originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` |
| 0.0% | 362us | 0.1% | 4.6ms | `populateMaps` | `/home/user/bun-node/node_modules/mime-types/index.js:158` |
| 0.0% | 332us | 0.0% | 332us | `__classPrivateFieldGet` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 327us | 0.0% | 327us | `(anonymous)` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 317us | 0.0% | 317us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/types/standard.js:365` |
| 0.0% | 314us | 0.0% | 314us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 312us | 0.0% | 312us | `(anonymous)` | `internal:util/inspect:46` |
| 0.0% | 300us | 0.0% | 300us | `(anonymous)` | `/home/user/bun-node/node_modules/has-flag/index.js:7` |
| 0.0% | 300us | 0.0% | 300us | `__classPrivateFieldGet` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:3` |
| 0.0% | 300us | 0.0% | 300us | `supportsColor` | `/home/user/bun-node/node_modules/supports-color/index.js` |
| 0.0% | 299us | 0.0% | 631us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:20` |
| 0.0% | 299us | 0.0% | 299us | `Mime` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 299us | 0.0% | 299us | `node:_http_server` | `node:_http_server:292` |
| 0.0% | 290us | 0.0% | 823us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/types/other.js:718` |
| 0.0% | 288us | 0.0% | 288us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 286us | 0.0% | 286us | `keys` | `[native code]` |
| 0.0% | 278us | 0.0% | 278us | `(anonymous)` | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` |
| 0.0% | 275us | 2.5% | 107.0ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5062` |
| 0.0% | 257us | 0.0% | 257us | `internal:stream` | `internal:stream:44` |
| 0.0% | 247us | 0.0% | 247us | `internal:streams/writable` | `internal:streams/writable:2` |
| 0.0% | 245us | 0.0% | 663us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:73` |
| 0.0% | 241us | 0.0% | 2.3ms | `internal:streams/duplex` | `internal:streams/duplex:2` |
| 0.0% | 237us | 0.0% | 237us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:85` |
| 0.0% | 234us | 0.6% | 28.3ms | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:194` |
| 0.0% | 234us | 0.0% | 432us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:42` |
| 0.0% | 230us | 0.0% | 230us | `(anonymous)` | `internal:http` |
| 0.0% | 229us | 0.0% | 229us | `addRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1249` |
| 0.0% | 226us | 0.0% | 226us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:528` |
| 0.0% | 226us | 0.0% | 226us | `internal:streams/duplexpair` | `internal:streams/duplexpair:5` |
| 0.0% | 226us | 56.6% | 2.40s | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:86` |
| 0.0% | 224us | 0.0% | 224us | `get isPayloadTooLarge` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 224us | 0.0% | 224us | `Channel` | `node:diagnostics_channel:107` |
| 0.0% | 223us | 0.3% | 15.9ms | `node:_http_common` | `node:_http_common:2` |
| 0.0% | 222us | 0.0% | 222us | `LinkedList` | `[native code]` |
| 0.0% | 220us | 0.0% | 220us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:18` |
| 0.0% | 220us | 0.0% | 220us | `internal:shared` | `internal:shared:4` |
| 0.0% | 220us | 0.0% | 220us | `get instance` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 219us | 0.0% | 219us | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5313` |
| 0.0% | 219us | 0.0% | 219us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:32` |
| 0.0% | 219us | 0.0% | 434us | `node:_http_outgoing` | `node:_http_outgoing:511` |
| 0.0% | 219us | 0.0% | 219us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:460` |
| 0.0% | 218us | 0.0% | 218us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 218us | 0.0% | 218us | `node:events` | `node:events:26` |
| 0.0% | 217us | 0.0% | 217us | `get legacyCookieOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 217us | 0.0% | 217us | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 217us | 0.0% | 217us | `internal:streams/destroy` | `internal:streams/destroy:16` |
| 0.0% | 217us | 0.0% | 217us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 217us | 0.0% | 217us | `Map` | `[native code]` |
| 0.0% | 217us | 0.0% | 217us | `get #etagEnabled` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 216us | 0.0% | 216us | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 216us | 7.8% | 333.2ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` |
| 0.0% | 216us | 0.0% | 216us | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 215us | 0.0% | 215us | `defineCustomPromisifyArgs` | `internal:promisify` |
| 0.0% | 215us | 0.0% | 215us | `EventEmitter` | `node:events` |
| 0.0% | 215us | 0.0% | 215us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:176` |
| 0.0% | 214us | 0.0% | 214us | `get upgradeToWsData` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1350` |
| 0.0% | 213us | 0.0% | 213us | `shouldUseEnvProxy` | `node:_http_agent` |
| 0.0% | 212us | 0.0% | 212us | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 212us | 0.0% | 406us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1697` |
| 0.0% | 212us | 0.0% | 212us | `internal:streams/writable` | `internal:streams/writable:53` |
| 0.0% | 212us | 0.0% | 212us | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:55` |
| 0.0% | 212us | 0.0% | 212us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5220` |
| 0.0% | 212us | 1.5% | 65.5ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:443` |
| 0.0% | 211us | 0.0% | 211us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:681` |
| 0.0% | 211us | 0.8% | 35.5ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1209` |
| 0.0% | 211us | 0.0% | 211us | `internal:streams/readable` | `internal:streams/readable:811` |
| 0.0% | 210us | 0.0% | 210us | `node:_http_client` | `node:_http_client:219` |
| 0.0% | 210us | 0.0% | 210us | `setName` | `node:fs` |
| 0.0% | 210us | 0.0% | 210us | `get headersSent` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 209us | 1.0% | 45.7ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:446` |
| 0.0% | 209us | 0.0% | 209us | `resetBuffer` | `internal:streams/writable:155` |
| 0.0% | 209us | 0.0% | 209us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:50` |
| 0.0% | 209us | 0.0% | 209us | `(anonymous)` | `/home/user/bun-node/node_modules/content-type/dist/index.js` |
| 0.0% | 208us | 0.0% | 208us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3026` |
| 0.0% | 208us | 0.0% | 208us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1003` |
| 0.0% | 208us | 0.0% | 208us | `Writable` | `internal:streams/writable` |
| 0.0% | 208us | 0.0% | 700us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` |
| 0.0% | 207us | 0.0% | 207us | `create` | `[native code]` |
| 0.0% | 207us | 0.0% | 207us | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 207us | 0.0% | 207us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:159` |
| 0.0% | 206us | 0.0% | 206us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:454` |
| 0.0% | 206us | 0.0% | 206us | `emitFinish` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 205us | 0.0% | 205us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5265` |
| 0.0% | 204us | 0.0% | 204us | `hideFromStack` | `internal:shared` |
| 0.0% | 204us | 0.0% | 204us | `createDebug` | `/home/user/bun-node/node_modules/debug/src/common.js:122` |
| 0.0% | 204us | 0.0% | 204us | `deprecate` | `internal:util/deprecate` |
| 0.0% | 204us | 0.0% | 393us | `get host` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3577` |
| 0.0% | 204us | 0.0% | 204us | `(anonymous)` | `node:diagnostics_channel` |
| 0.0% | 204us | 0.0% | 204us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1011` |
| 0.0% | 203us | 0.0% | 203us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:529` |
| 0.0% | 203us | 0.0% | 203us | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1359` |
| 0.0% | 202us | 0.0% | 202us | `setResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3736` |
| 0.0% | 201us | 0.0% | 201us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:858` |
| 0.0% | 201us | 0.0% | 201us | `WriteStream` | `internal:fs/streams:238` |
| 0.0% | 201us | 0.0% | 201us | `set params` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 200us | 0.0% | 200us | `get bodyDecodingError` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 200us | 0.0% | 200us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 200us | 0.0% | 200us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3048` |
| 0.0% | 200us | 0.0% | 417us | `internal:streams/readable` | `internal:streams/readable:14` |
| 0.0% | 199us | 0.0% | 199us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2501` |
| 0.0% | 199us | 0.0% | 199us | `node:fs/promises` | `node:fs/promises:8` |
| 0.0% | 199us | 0.0% | 199us | `get buffer` | `[native code]` |
| 0.0% | 198us | 0.0% | 198us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5066` |
| 0.0% | 198us | 0.0% | 198us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1246` |
| 0.0% | 198us | 0.0% | 198us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1120` |
| 0.0% | 197us | 0.0% | 197us | `node:util` | `node:util:128` |
| 0.0% | 197us | 0.0% | 197us | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1343` |
| 0.0% | 197us | 0.0% | 197us | `use` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4229` |
| 0.0% | 197us | 0.7% | 30.1ms | `#canSkipHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:571` |
| 0.0% | 197us | 0.0% | 197us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:151` |
| 0.0% | 197us | 0.0% | 197us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:247` |
| 0.0% | 196us | 0.0% | 196us | `internal:streams/utils` | `internal:streams/utils:180` |
| 0.0% | 195us | 0.0% | 195us | `get method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 0.0% | 195us | 0.0% | 195us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js` |
| 0.0% | 195us | 0.0% | 195us | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4987` |
| 0.0% | 194us | 0.0% | 194us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1117` |
| 0.0% | 194us | 0.0% | 194us | `WritableState` | `internal:streams/writable` |
| 0.0% | 193us | 0.0% | 193us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 193us | 0.0% | 193us | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 193us | 0.0% | 193us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:44` |
| 0.0% | 193us | 0.0% | 193us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:155` |
| 0.0% | 193us | 0.0% | 193us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1019` |
| 0.0% | 191us | 0.0% | 191us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5037` |
| 0.0% | 190us | 0.0% | 190us | `internal:http` | `internal:http:257` |
| 0.0% | 189us | 0.0% | 189us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:202` |
| 0.0% | 189us | 0.0% | 189us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:198` |
| 0.0% | 189us | 0.0% | 189us | `node:diagnostics_channel` | `node:diagnostics_channel:2` |
| 0.0% | 189us | 0.0% | 189us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3502` |
| 0.0% | 189us | 0.0% | 189us | `hasOwnProperty` | `[native code]` |
| 0.0% | 189us | 0.0% | 189us | `startInterval` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 187us | 0.0% | 187us | `_addListener` | `node:events` |
| 0.0% | 187us | 0.0% | 187us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 187us | 0.0% | 187us | `deprecate` | `internal:util/deprecate:30` |
| 0.0% | 187us | 0.0% | 187us | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1433` |
| 0.0% | 186us | 0.0% | 186us | `call` | `[native code]` |
| 0.0% | 186us | 0.0% | 186us | `asyncWrap` | `node:fs/promises:249` |
| 0.0% | 186us | 0.0% | 186us | `makeSafe` | `internal:primordials` |
| 0.0% | 186us | 0.0% | 388us | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:700` |
| 0.0% | 185us | 0.0% | 185us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:24` |
| 0.0% | 185us | 0.0% | 185us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 184us | 0.0% | 184us | `(anonymous)` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:5` |
| 0.0% | 183us | 0.0% | 183us | `charCodeAt` | `[native code]` |
| 0.0% | 183us | 0.0% | 183us | `#canSkipHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:574` |
| 0.0% | 182us | 0.0% | 182us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:953` |
| 0.0% | 182us | 0.0% | 182us | `node:_http_outgoing` | `node:_http_outgoing:773` |
| 0.0% | 177us | 0.0% | 177us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1273` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 93.7% | 3.98s | 0.1% | 5.9ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:20` |
| 56.6% | 2.40s | 0.0% | 226us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:86` |
| 43.8% | 1.86s | 0.3% | 12.9ms | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:404` |
| 37.6% | 1.60s | 0.2% | 8.7ms | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:402` |
| 37.3% | 1.59s | 0.8% | 34.6ms | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1432` |
| 32.7% | 1.39s | 0.1% | 6.7ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:455` |
| 21.1% | 898.4ms | 0.6% | 27.5ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5102` |
| 17.1% | 730.7ms | 0.8% | 34.9ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1214` |
| 16.3% | 695.9ms | 16.3% | 695.9ms | `Response` | `[native code]` |
| 12.1% | 515.8ms | 0.0% | 1.7ms | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` |
| 12.0% | 514.0ms | 12.0% | 514.0ms | `Request` | `[native code]` |
| 9.5% | 404.8ms | 1.1% | 49.3ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1267` |
| 7.8% | 333.2ms | 0.0% | 216us | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` |
| 7.7% | 330.5ms | 1.3% | 59.0ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:437` |
| 7.3% | 314.8ms | 0.3% | 13.8ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4984` |
| 7.2% | 310.2ms | 0.0% | 393us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1271` |
| 6.2% | 264.2ms | 2.0% | 85.6ms | `anonymous` | `[native code]` |
| 6.1% | 260.4ms | 0.4% | 19.3ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1306` |
| 5.9% | 251.0ms | 5.9% | 251.0ms | `get` | `[native code]` |
| 4.6% | 196.5ms | 4.6% | 196.5ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1231` |
| 4.0% | 170.3ms | 3.7% | 158.8ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` |
| 3.7% | 159.0ms | 1.1% | 50.1ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3040` |
| 3.4% | 148.4ms | 3.4% | 147.4ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` |
| 2.8% | 120.8ms | 0.0% | 0us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4782` |
| 2.8% | 120.2ms | 2.8% | 120.2ms | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:281` |
| 2.7% | 115.7ms | 0.0% | 0us | `bound require` | `[native code]` |
| 2.7% | 115.1ms | 0.0% | 792us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4774` |
| 2.6% | 114.3ms | 2.6% | 114.3ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3506` |
| 2.5% | 108.5ms | 0.0% | 3.8ms | `require` | `[native code]` |
| 2.5% | 107.0ms | 0.0% | 275us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5062` |
| 2.5% | 106.6ms | 2.5% | 106.6ms | `params` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1706` |
| 2.4% | 103.6ms | 2.4% | 103.6ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 2.4% | 103.2ms | 0.3% | 16.5ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1340` |
| 2.3% | 100.6ms | 2.3% | 100.6ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 2.2% | 95.0ms | 2.2% | 95.0ms | `method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 2.1% | 89.8ms | 2.1% | 89.4ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4470` |
| 2.0% | 86.7ms | 2.0% | 86.7ms | `alloc` | `[native code]` |
| 1.9% | 82.0ms | 1.8% | 78.2ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1213` |
| 1.8% | 78.0ms | 0.0% | 1.3ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1332` |
| 1.7% | 74.1ms | 0.2% | 8.9ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1331` |
| 1.6% | 68.8ms | 1.4% | 60.9ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1261` |
| 1.5% | 67.0ms | 1.5% | 67.0ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3541` |
| 1.5% | 65.5ms | 0.0% | 212us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:443` |
| 1.3% | 58.0ms | 0.0% | 0us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1256` |
| 1.3% | 58.0ms | 1.3% | 58.0ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3507` |
| 1.3% | 57.8ms | 0.3% | 15.8ms | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1356` |
| 1.2% | 55.2ms | 1.2% | 55.2ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4777` |
| 1.2% | 51.9ms | 1.2% | 51.9ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3042` |
| 1.1% | 47.7ms | 1.1% | 47.7ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3520` |
| 1.0% | 45.7ms | 0.0% | 209us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:446` |
| 1.0% | 43.6ms | 0.0% | 0us | `originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` |
| 0.9% | 42.0ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:84` |
| 0.9% | 41.9ms | 0.9% | 41.9ms | `cloneObject` | `[native code]` |
| 0.8% | 37.9ms | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1031` |
| 0.8% | 37.3ms | 0.0% | 942us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:177` |
| 0.8% | 35.5ms | 0.0% | 211us | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1209` |
| 0.7% | 30.1ms | 0.0% | 197us | `#canSkipHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:571` |
| 0.6% | 29.0ms | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:57` |
| 0.6% | 28.4ms | 0.6% | 28.4ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1335` |
| 0.6% | 28.3ms | 0.0% | 234us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:194` |
| 0.6% | 28.1ms | 0.0% | 0us | `node:http` | `node:http:2` |
| 0.6% | 26.7ms | 0.0% | 0us | `lazyInspectModule` | `node:util:17` |
| 0.6% | 26.7ms | 0.0% | 0us | `get inspect` | `node:util:481` |
| 0.6% | 26.6ms | 0.6% | 26.6ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5072` |
| 0.6% | 26.1ms | 0.6% | 26.1ms | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/index.js:6` |
| 0.6% | 25.8ms | 0.0% | 0us | `bound serveNativeRequest` | `[native code]` |
| 0.5% | 25.3ms | 0.5% | 25.3ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1336` |
| 0.5% | 24.4ms | 0.5% | 24.4ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4471` |
| 0.5% | 24.3ms | 0.5% | 24.1ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3540` |
| 0.5% | 23.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/index.js:9` |
| 0.5% | 21.9ms | 0.5% | 21.9ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3533` |
| 0.5% | 21.3ms | 0.5% | 21.3ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3521` |
| 0.4% | 20.6ms | 0.0% | 0us | `node:_http_client` | `node:_http_client:10` |
| 0.4% | 19.3ms | 0.4% | 19.3ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5006` |
| 0.4% | 18.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/accepts/index.js:16` |
| 0.4% | 18.4ms | 0.4% | 18.4ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:3` |
| 0.3% | 15.9ms | 0.0% | 223us | `node:_http_common` | `node:_http_common:2` |
| 0.3% | 15.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:16` |
| 0.3% | 14.5ms | 0.0% | 991us | `forEach` | `[native code]` |
| 0.3% | 14.1ms | 0.3% | 14.1ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3029` |
| 0.2% | 12.6ms | 0.2% | 12.6ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1203` |
| 0.2% | 12.4ms | 0.2% | 11.7ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2997` |
| 0.2% | 12.1ms | 0.2% | 12.1ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3530` |
| 0.2% | 11.8ms | 0.2% | 11.8ms | `node:zlib` | `node:zlib:2` |
| 0.2% | 11.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-types/index.js:15` |
| 0.2% | 11.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-db/index.js:12` |
| 0.2% | 11.3ms | 0.2% | 11.1ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:422` |
| 0.2% | 10.4ms | 0.0% | 0us | `populateMaps` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:155` |
| 0.2% | 10.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:42` |
| 0.2% | 10.1ms | 0.2% | 10.1ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:514` |
| 0.2% | 9.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:32` |
| 0.2% | 9.4ms | 0.2% | 9.2ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2991` |
| 0.2% | 9.1ms | 0.2% | 9.1ms | `node:fs` | `node:fs:298` |
| 0.2% | 8.5ms | 0.2% | 8.5ms | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.1% | 8.4ms | 0.1% | 8.4ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3546` |
| 0.1% | 8.2ms | 0.1% | 8.2ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4988` |
| 0.1% | 8.1ms | 0.0% | 0us | `node:_http_incoming` | `node:_http_incoming:2` |
| 0.1% | 7.6ms | 0.1% | 7.6ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3045` |
| 0.1% | 7.1ms | 0.1% | 7.1ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3044` |
| 0.1% | 6.6ms | 0.1% | 6.6ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5009` |
| 0.1% | 6.2ms | 0.0% | 0us | `node:_http_incoming` | `node:_http_incoming:15` |
| 0.1% | 5.9ms | 0.0% | 0us | `internal:http/FakeSocket` | `internal:http/FakeSocket:2` |
| 0.1% | 5.8ms | 0.1% | 5.8ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:21` |
| 0.1% | 5.8ms | 0.0% | 0us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4793` |
| 0.1% | 5.6ms | 0.0% | 0us | `internal:streams/readable` | `internal:streams/readable:2` |
| 0.1% | 5.0ms | 0.0% | 1.2ms | `map` | `[native code]` |
| 0.1% | 4.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:5` |
| 0.1% | 4.8ms | 0.1% | 4.8ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:29` |
| 0.1% | 4.7ms | 0.1% | 4.7ms | `#canSkipHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.1% | 4.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-types/index.js:40` |
| 0.1% | 4.6ms | 0.0% | 362us | `populateMaps` | `/home/user/bun-node/node_modules/mime-types/index.js:158` |
| 0.1% | 4.6ms | 0.0% | 0us | `bound call` | `[native code]` |
| 0.1% | 4.5ms | 0.1% | 4.5ms | `replace` | `[native code]` |
| 0.1% | 4.5ms | 0.1% | 4.5ms | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2488` |
| 0.1% | 4.5ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:9` |
| 0.1% | 4.5ms | 0.0% | 4.1ms | `filter` | `[native code]` |
| 0.1% | 4.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:240` |
| 0.1% | 4.4ms | 0.1% | 4.4ms | `setPrototypeDirectOrThrow` | `[native code]` |
| 0.1% | 4.4ms | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:2953` |
| 0.1% | 4.4ms | 0.0% | 0us | `internal:stream` | `internal:stream:2` |
| 0.1% | 4.3ms | 0.0% | 0us | `createDebug` | `/home/user/bun-node/node_modules/debug/src/common.js:117` |
| 0.0% | 4.2ms | 0.0% | 0us | `internal:util/inspect` | `internal:util/inspect:46` |
| 0.0% | 4.1ms | 0.0% | 4.1ms | `uncurryThis` | `internal:primordials` |
| 0.0% | 4.1ms | 0.0% | 0us | `internal:util/inspect` | `internal:util/inspect:9` |
| 0.0% | 4.0ms | 0.0% | 0us | `use` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4238` |
| 0.0% | 4.0ms | 0.0% | 0us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:169` |
| 0.0% | 4.0ms | 0.0% | 0us | `flushPending` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4223` |
| 0.0% | 4.0ms | 0.0% | 997us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:169` |
| 0.0% | 3.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:15` |
| 0.0% | 3.9ms | 0.0% | 3.9ms | `@lazy` | `[native code]` |
| 0.0% | 3.8ms | 0.0% | 3.8ms | `RegExp` | `[native code]` |
| 0.0% | 3.8ms | 0.0% | 0us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:242` |
| 0.0% | 3.8ms | 0.0% | 0us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:224` |
| 0.0% | 3.7ms | 0.0% | 0us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:218` |
| 0.0% | 3.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:6` |
| 0.0% | 3.6ms | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:59` |
| 0.0% | 3.6ms | 0.0% | 0us | `#compileMiddlewareRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:209` |
| 0.0% | 3.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/node_modules/mime-db/index.js:12` |
| 0.0% | 3.4ms | 0.0% | 3.4ms | `splitRequestPath` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 3.4ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/src/index.js:5` |
| 0.0% | 3.4ms | 0.0% | 0us | `internal:streams/compose` | `internal:streams/compose:2` |
| 0.0% | 3.4ms | 0.0% | 3.4ms | `node:stream/web` | `node:stream/web:7` |
| 0.0% | 3.2ms | 0.0% | 0us | `node:vm` | `node:vm:12` |
| 0.0% | 3.2ms | 0.0% | 0us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:174` |
| 0.0% | 3.2ms | 0.0% | 0us | `node:fs/promises` | `node:fs/promises:2` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 3.0ms | 0.0% | 0us | `_preferredType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:189` |
| 0.0% | 3.0ms | 0.0% | 2.1ms | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:15` |
| 0.0% | 2.9ms | 0.0% | 0us | `internal:streams/pipeline` | `internal:streams/pipeline:2` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:199` |
| 0.0% | 2.8ms | 0.0% | 0us | `setup` | `/home/user/bun-node/node_modules/debug/src/common.js:287` |
| 0.0% | 2.7ms | 0.0% | 0us | `node:crypto` | `node:crypto:2` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:18` |
| 0.0% | 2.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/index.js:3` |
| 0.0% | 2.7ms | 0.0% | 2.5ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:440` |
| 0.0% | 2.7ms | 0.0% | 0us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:970` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` |
| 0.0% | 2.6ms | 0.0% | 0us | `Mime` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:13` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 2.5ms | 0.0% | 2.5ms | `enable` | `/home/user/bun-node/node_modules/debug/src/common.js` |
| 0.0% | 2.5ms | 0.0% | 2.5ms | `emitFinish` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:797` |
| 0.0% | 2.4ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:13` |
| 0.0% | 2.4ms | 0.0% | 0us | `internal:streams/add-abort-signal` | `internal:streams/add-abort-signal:2` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1272` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:185` |
| 0.0% | 2.3ms | 0.0% | 241us | `internal:streams/duplex` | `internal:streams/duplex:2` |
| 0.0% | 2.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-types/index.js:16` |
| 0.0% | 2.2ms | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:84` |
| 0.0% | 2.1ms | 0.0% | 0us | `node:events` | `node:events:10` |
| 0.0% | 1.9ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:54` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `isObject` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:179` |
| 0.0% | 1.9ms | 0.0% | 0us | `node:path` | `node:path:2` |
| 0.0% | 1.8ms | 0.0% | 0us | `node:_http_agent` | `node:_http_agent:2` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:136` |
| 0.0% | 1.7ms | 0.0% | 0us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2511` |
| 0.0% | 1.7ms | 0.0% | 0us | `internal:errors` | `internal:errors:2` |
| 0.0% | 1.7ms | 0.0% | 0us | `internal:streams/destroy` | `internal:streams/destroy:2` |
| 0.0% | 1.7ms | 0.0% | 464us | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js:158` |
| 0.0% | 1.6ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:79` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `importModule` | `[native code]` |
| 0.0% | 1.6ms | 0.0% | 0us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:185` |
| 0.0% | 1.6ms | 0.0% | 0us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:216` |
| 0.0% | 1.6ms | 0.0% | 407us | `(anonymous)` | `[native code]` |
| 0.0% | 1.6ms | 0.0% | 717us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1299` |
| 0.0% | 1.5ms | 0.0% | 0us | `node:util` | `node:util:2` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `internal:promisify` | `internal:promisify:2` |
| 0.0% | 1.5ms | 0.0% | 978us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:20` |
| 0.0% | 1.5ms | 0.0% | 1.2ms | `from` | `[native code]` |
| 0.0% | 1.5ms | 0.0% | 595us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:40` |
| 0.0% | 1.4ms | 0.0% | 997us | `segmentKind` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:71` |
| 0.0% | 1.4ms | 0.0% | 0us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:86` |
| 0.0% | 1.2ms | 0.0% | 0us | `internal:validators` | `internal:validators:2` |
| 0.0% | 1.2ms | 0.0% | 0us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5134` |
| 0.0% | 1.1ms | 0.0% | 583us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:14` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:17` |
| 0.0% | 1.1ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:25` |
| 0.0% | 1.0ms | 0.0% | 0us | `setup` | `/home/user/bun-node/node_modules/debug/src/common.js:14` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3511` |
| 0.0% | 958us | 0.0% | 958us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:157` |
| 0.0% | 948us | 0.0% | 948us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5135` |
| 0.0% | 944us | 0.0% | 944us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:164` |
| 0.0% | 943us | 0.0% | 943us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 928us | 0.0% | 928us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:521` |
| 0.0% | 921us | 0.0% | 921us | `split` | `[native code]` |
| 0.0% | 914us | 0.0% | 406us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:555` |
| 0.0% | 878us | 0.0% | 878us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:19` |
| 0.0% | 852us | 0.0% | 638us | `get headersSent` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` |
| 0.0% | 850us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:457` |
| 0.0% | 823us | 0.0% | 823us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 823us | 0.0% | 290us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/types/other.js:718` |
| 0.0% | 806us | 0.0% | 806us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:156` |
| 0.0% | 788us | 0.0% | 0us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:442` |
| 0.0% | 784us | 0.0% | 784us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5125` |
| 0.0% | 723us | 0.0% | 0us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5129` |
| 0.0% | 718us | 0.0% | 718us | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1409` |
| 0.0% | 700us | 0.0% | 208us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` |
| 0.0% | 697us | 0.0% | 697us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:49` |
| 0.0% | 692us | 0.0% | 692us | `#configuredCookieSecrets` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 690us | 0.0% | 690us | `originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3699` |
| 0.0% | 671us | 0.0% | 671us | `createConvenienceMethod` | `node:zlib` |
| 0.0% | 671us | 0.0% | 0us | `node:zlib` | `node:zlib:485` |
| 0.0% | 663us | 0.0% | 245us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:73` |
| 0.0% | 657us | 0.0% | 657us | `internal:http` | `internal:http:34` |
| 0.0% | 637us | 0.0% | 637us | `toUpperCase` | `[native code]` |
| 0.0% | 631us | 0.0% | 299us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:20` |
| 0.0% | 629us | 0.0% | 629us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:167` |
| 0.0% | 628us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:188` |
| 0.0% | 628us | 0.0% | 628us | `join` | `[native code]` |
| 0.0% | 628us | 0.0% | 0us | `bound join` | `[native code]` |
| 0.0% | 628us | 0.0% | 628us | `get originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3699` |
| 0.0% | 620us | 0.0% | 620us | `(anonymous)` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 611us | 0.0% | 0us | `WriteStream` | `internal:fs/streams:259` |
| 0.0% | 606us | 0.0% | 606us | `add` | `[native code]` |
| 0.0% | 602us | 0.0% | 602us | `isString` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:150` |
| 0.0% | 598us | 0.0% | 598us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3046` |
| 0.0% | 591us | 0.0% | 591us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:6` |
| 0.0% | 590us | 0.0% | 590us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:476` |
| 0.0% | 586us | 0.0% | 386us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:431` |
| 0.0% | 575us | 0.0% | 363us | `get originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` |
| 0.0% | 565us | 0.0% | 0us | `internal:primordials` | `internal:primordials:76` |
| 0.0% | 561us | 0.0% | 561us | `_freeze` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 533us | 0.0% | 533us | `freeze` | `[native code]` |
| 0.0% | 508us | 0.0% | 508us | `get settledResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2045` |
| 0.0% | 461us | 0.0% | 0us | `internal:stream` | `internal:stream:48` |
| 0.0% | 461us | 0.0% | 461us | `layerFinished` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 442us | 0.0% | 442us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2496` |
| 0.0% | 440us | 0.0% | 440us | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 439us | 0.0% | 439us | `isBoolean` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 439us | 0.0% | 0us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1239` |
| 0.0% | 439us | 0.0% | 439us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 437us | 0.0% | 437us | `set query` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 436us | 0.0% | 436us | `test` | `[native code]` |
| 0.0% | 434us | 0.0% | 219us | `node:_http_outgoing` | `node:_http_outgoing:511` |
| 0.0% | 432us | 0.0% | 234us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:42` |
| 0.0% | 431us | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:37` |
| 0.0% | 429us | 0.0% | 429us | `WriteStream` | `internal:fs/streams` |
| 0.0% | 426us | 0.0% | 426us | `Empty` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 426us | 0.0% | 0us | `parse` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js:42` |
| 0.0% | 424us | 0.0% | 0us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5260` |
| 0.0% | 424us | 0.0% | 424us | `parse` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 422us | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:27` |
| 0.0% | 422us | 0.0% | 422us | `isArray` | `[native code]` |
| 0.0% | 420us | 0.0% | 420us | `(anonymous)` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 418us | 0.0% | 418us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:89` |
| 0.0% | 417us | 0.0% | 200us | `internal:streams/readable` | `internal:streams/readable:14` |
| 0.0% | 415us | 0.0% | 0us | `node:zlib` | `node:zlib:449` |
| 0.0% | 415us | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1076` |
| 0.0% | 415us | 0.0% | 415us | `get size` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:276` |
| 0.0% | 411us | 0.0% | 411us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1699` |
| 0.0% | 409us | 0.0% | 409us | `createSafeIterator` | `internal:primordials` |
| 0.0% | 409us | 0.0% | 409us | `defineProperty` | `[native code]` |
| 0.0% | 409us | 0.0% | 0us | `internal:primordials` | `internal:primordials:54` |
| 0.0% | 409us | 0.0% | 409us | `getOwnPropertyDescriptor` | `[native code]` |
| 0.0% | 408us | 0.0% | 0us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1698` |
| 0.0% | 408us | 0.0% | 0us | `node:crypto` | `node:crypto:39` |
| 0.0% | 407us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/uint8array-extras/index.js:178` |
| 0.0% | 407us | 0.0% | 407us | `push` | `[native code]` |
| 0.0% | 406us | 0.0% | 212us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1697` |
| 0.0% | 406us | 0.0% | 406us | `slice` | `[native code]` |
| 0.0% | 403us | 0.0% | 0us | `Writable` | `internal:streams/writable:181` |
| 0.0% | 402us | 0.0% | 0us | `node:_http_agent` | `node:_http_agent:290` |
| 0.0% | 400us | 0.0% | 400us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 397us | 0.0% | 397us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:177` |
| 0.0% | 395us | 0.0% | 395us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 395us | 0.0% | 395us | `host` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3577` |
| 0.0% | 394us | 0.0% | 394us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` |
| 0.0% | 394us | 0.0% | 394us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1305` |
| 0.0% | 393us | 0.0% | 204us | `get host` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3577` |
| 0.0% | 393us | 0.0% | 393us | `indexOf` | `[native code]` |
| 0.0% | 389us | 0.0% | 389us | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 389us | 0.0% | 389us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:447` |
| 0.0% | 388us | 0.0% | 186us | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:700` |
| 0.0% | 386us | 0.0% | 386us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4784` |
| 0.0% | 386us | 0.0% | 386us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 384us | 0.0% | 0us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:233` |
| 0.0% | 383us | 0.0% | 383us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:178` |
| 0.0% | 382us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:17` |
| 0.0% | 382us | 0.0% | 382us | `(anonymous)` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:18` |
| 0.0% | 376us | 0.0% | 376us | `#respond` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:487` |
| 0.0% | 376us | 0.0% | 0us | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1396` |
| 0.0% | 373us | 0.0% | 373us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:198` |
| 0.0% | 371us | 0.0% | 371us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:165` |
| 0.0% | 346us | 0.0% | 0us | `node:tty` | `node:tty:7` |
| 0.0% | 332us | 0.0% | 332us | `__classPrivateFieldGet` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 327us | 0.0% | 327us | `(anonymous)` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 327us | 0.0% | 0us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:19` |
| 0.0% | 317us | 0.0% | 317us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/types/standard.js:365` |
| 0.0% | 314us | 0.0% | 314us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 312us | 0.0% | 312us | `(anonymous)` | `internal:util/inspect:46` |
| 0.0% | 311us | 0.0% | 0us | `node:zlib` | `node:zlib:456` |
| 0.0% | 300us | 0.0% | 0us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:30` |
| 0.0% | 300us | 0.0% | 300us | `__classPrivateFieldGet` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:3` |
| 0.0% | 300us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/supports-color/index.js:10` |
| 0.0% | 300us | 0.0% | 300us | `supportsColor` | `/home/user/bun-node/node_modules/supports-color/index.js` |
| 0.0% | 300us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/supports-color/index.js:133` |
| 0.0% | 300us | 0.0% | 300us | `(anonymous)` | `/home/user/bun-node/node_modules/has-flag/index.js:7` |
| 0.0% | 299us | 0.0% | 299us | `node:_http_server` | `node:_http_server:292` |
| 0.0% | 299us | 0.0% | 299us | `Mime` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 288us | 0.0% | 288us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 286us | 0.0% | 286us | `keys` | `[native code]` |
| 0.0% | 282us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/supports-color/index.js:4` |
| 0.0% | 278us | 0.0% | 278us | `(anonymous)` | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` |
| 0.0% | 274us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:124` |
| 0.0% | 262us | 0.0% | 0us | `layerFinished` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:598` |
| 0.0% | 257us | 0.0% | 257us | `internal:stream` | `internal:stream:44` |
| 0.0% | 247us | 0.0% | 247us | `internal:streams/writable` | `internal:streams/writable:2` |
| 0.0% | 237us | 0.0% | 0us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` |
| 0.0% | 237us | 0.0% | 237us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:85` |
| 0.0% | 230us | 0.0% | 230us | `(anonymous)` | `internal:http` |
| 0.0% | 230us | 0.0% | 0us | `internal:http` | `internal:http:7` |
| 0.0% | 230us | 0.0% | 0us | `internal:stream` | `internal:stream:47` |
| 0.0% | 229us | 0.0% | 229us | `addRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1249` |
| 0.0% | 226us | 0.0% | 226us | `internal:streams/duplexpair` | `internal:streams/duplexpair:5` |
| 0.0% | 226us | 0.0% | 0us | `internal:stream` | `internal:stream:46` |
| 0.0% | 226us | 0.0% | 226us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:528` |
| 0.0% | 224us | 0.0% | 224us | `get isPayloadTooLarge` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 224us | 0.0% | 224us | `Channel` | `node:diagnostics_channel:107` |
| 0.0% | 224us | 0.0% | 0us | `channel` | `node:diagnostics_channel:141` |
| 0.0% | 222us | 0.0% | 0us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:66` |
| 0.0% | 222us | 0.0% | 222us | `LinkedList` | `[native code]` |
| 0.0% | 220us | 0.0% | 220us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:18` |
| 0.0% | 220us | 0.0% | 220us | `get instance` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 220us | 0.0% | 220us | `internal:shared` | `internal:shared:4` |
| 0.0% | 219us | 0.0% | 219us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:32` |
| 0.0% | 219us | 0.0% | 219us | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5313` |
| 0.0% | 219us | 0.0% | 0us | `internal:streams/duplex` | `internal:streams/duplex:52` |
| 0.0% | 219us | 0.0% | 219us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:460` |
| 0.0% | 218us | 0.0% | 218us | `node:events` | `node:events:26` |
| 0.0% | 218us | 0.0% | 218us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 217us | 0.0% | 0us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:67` |
| 0.0% | 217us | 0.0% | 217us | `get legacyCookieOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 217us | 0.0% | 217us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 217us | 0.0% | 0us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:172` |
| 0.0% | 217us | 0.0% | 217us | `get #etagEnabled` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 217us | 0.0% | 0us | `#canSkipHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:573` |
| 0.0% | 217us | 0.0% | 0us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:84` |
| 0.0% | 217us | 0.0% | 217us | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 217us | 0.0% | 217us | `internal:streams/destroy` | `internal:streams/destroy:16` |
| 0.0% | 217us | 0.0% | 217us | `Map` | `[native code]` |
| 0.0% | 217us | 0.0% | 0us | `#configuredCookieSecrets` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1405` |
| 0.0% | 216us | 0.0% | 216us | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 216us | 0.0% | 0us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:58` |
| 0.0% | 216us | 0.0% | 216us | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 215us | 0.0% | 215us | `EventEmitter` | `node:events` |
| 0.0% | 215us | 0.0% | 0us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:173` |
| 0.0% | 215us | 0.0% | 215us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:176` |
| 0.0% | 215us | 0.0% | 0us | `Agent` | `node:_http_agent:10` |
| 0.0% | 215us | 0.0% | 0us | `node:crypto` | `node:crypto:103` |
| 0.0% | 215us | 0.0% | 215us | `defineCustomPromisifyArgs` | `internal:promisify` |
| 0.0% | 214us | 0.0% | 0us | `node:zlib` | `node:zlib:553` |
| 0.0% | 214us | 0.0% | 0us | `enable` | `/home/user/bun-node/node_modules/debug/src/common.js:171` |
| 0.0% | 214us | 0.0% | 214us | `get upgradeToWsData` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1350` |
| 0.0% | 213us | 0.0% | 0us | `node:_http_agent` | `node:_http_agent:294` |
| 0.0% | 213us | 0.0% | 213us | `shouldUseEnvProxy` | `node:_http_agent` |
| 0.0% | 212us | 0.0% | 212us | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 212us | 0.0% | 0us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4805` |
| 0.0% | 212us | 0.0% | 212us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5220` |
| 0.0% | 212us | 0.0% | 212us | `internal:streams/writable` | `internal:streams/writable:53` |
| 0.0% | 212us | 0.0% | 212us | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:55` |
| 0.0% | 211us | 0.0% | 211us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:681` |
| 0.0% | 211us | 0.0% | 211us | `internal:streams/readable` | `internal:streams/readable:811` |
| 0.0% | 210us | 0.0% | 210us | `get headersSent` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 210us | 0.0% | 210us | `setName` | `node:fs` |
| 0.0% | 210us | 0.0% | 210us | `node:_http_client` | `node:_http_client:219` |
| 0.0% | 210us | 0.0% | 0us | `node:fs` | `node:fs:702` |
| 0.0% | 209us | 0.0% | 209us | `resetBuffer` | `internal:streams/writable:155` |
| 0.0% | 209us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/content-type/dist/index.js:30` |
| 0.0% | 209us | 0.0% | 209us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:50` |
| 0.0% | 209us | 0.0% | 209us | `(anonymous)` | `/home/user/bun-node/node_modules/content-type/dist/index.js` |
| 0.0% | 209us | 0.0% | 0us | `WritableState` | `internal:streams/writable:152` |
| 0.0% | 208us | 0.0% | 208us | `Writable` | `internal:streams/writable` |
| 0.0% | 208us | 0.0% | 208us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3026` |
| 0.0% | 208us | 0.0% | 208us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1003` |
| 0.0% | 207us | 0.0% | 207us | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 207us | 0.0% | 207us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:159` |
| 0.0% | 207us | 0.0% | 207us | `create` | `[native code]` |
| 0.0% | 206us | 0.0% | 206us | `emitFinish` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 206us | 0.0% | 0us | `addRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1257` |
| 0.0% | 206us | 0.0% | 206us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:454` |
| 0.0% | 205us | 0.0% | 205us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5265` |
| 0.0% | 204us | 0.0% | 0us | `node:_http_outgoing` | `node:_http_outgoing:700` |
| 0.0% | 204us | 0.0% | 204us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1011` |
| 0.0% | 204us | 0.0% | 0us | `WeakRefMap` | `[native code]` |
| 0.0% | 204us | 0.0% | 0us | `internal:validators` | `internal:validators:67` |
| 0.0% | 204us | 0.0% | 204us | `hideFromStack` | `internal:shared` |
| 0.0% | 204us | 0.0% | 204us | `createDebug` | `/home/user/bun-node/node_modules/debug/src/common.js:122` |
| 0.0% | 204us | 0.0% | 204us | `(anonymous)` | `node:diagnostics_channel` |
| 0.0% | 204us | 0.0% | 0us | `node:diagnostics_channel` | `node:diagnostics_channel:134` |
| 0.0% | 204us | 0.0% | 204us | `deprecate` | `internal:util/deprecate` |
| 0.0% | 203us | 0.0% | 203us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:529` |
| 0.0% | 203us | 0.0% | 203us | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1359` |
| 0.0% | 202us | 0.0% | 202us | `setResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3736` |
| 0.0% | 201us | 0.0% | 201us | `WriteStream` | `internal:fs/streams:238` |
| 0.0% | 201us | 0.0% | 201us | `set params` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 201us | 0.0% | 201us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:858` |
| 0.0% | 200us | 0.0% | 0us | `node:_http_outgoing` | `node:_http_outgoing:2` |
| 0.0% | 200us | 0.0% | 200us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 200us | 0.0% | 200us | `get bodyDecodingError` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 200us | 0.0% | 200us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3048` |
| 0.0% | 199us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:12` |
| 0.0% | 199us | 0.0% | 199us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2501` |
| 0.0% | 199us | 0.0% | 0us | `put` | `/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/lib/index.js:87` |
| 0.0% | 199us | 0.0% | 0us | `signatureToArray` | `/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:6` |
| 0.0% | 199us | 0.0% | 199us | `node:fs/promises` | `node:fs/promises:8` |
| 0.0% | 199us | 0.0% | 0us | `dv` | `/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/lib/index.js:5` |
| 0.0% | 199us | 0.0% | 199us | `get buffer` | `[native code]` |
| 0.0% | 198us | 0.0% | 198us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1120` |
| 0.0% | 198us | 0.0% | 198us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5066` |
| 0.0% | 198us | 0.0% | 198us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1246` |
| 0.0% | 197us | 0.0% | 197us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:151` |
| 0.0% | 197us | 0.0% | 197us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:247` |
| 0.0% | 197us | 0.0% | 197us | `node:util` | `node:util:128` |
| 0.0% | 197us | 0.0% | 0us | `registerExpressStyle` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:170` |
| 0.0% | 197us | 0.0% | 197us | `use` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4229` |
| 0.0% | 197us | 0.0% | 197us | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1343` |
| 0.0% | 196us | 0.0% | 196us | `internal:streams/utils` | `internal:streams/utils:180` |
| 0.0% | 195us | 0.0% | 195us | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4987` |
| 0.0% | 195us | 0.0% | 195us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js` |
| 0.0% | 195us | 0.0% | 0us | `node:_http_incoming` | `node:_http_incoming:160` |
| 0.0% | 195us | 0.0% | 195us | `get method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 0.0% | 194us | 0.0% | 194us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1117` |
| 0.0% | 194us | 0.0% | 194us | `WritableState` | `internal:streams/writable` |
| 0.0% | 193us | 0.0% | 193us | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 193us | 0.0% | 193us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:44` |
| 0.0% | 193us | 0.0% | 193us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1019` |
| 0.0% | 193us | 0.0% | 193us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:155` |
| 0.0% | 193us | 0.0% | 193us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 192us | 0.0% | 0us | `node:zlib` | `node:zlib:300` |
| 0.0% | 191us | 0.0% | 191us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5037` |
| 0.0% | 190us | 0.0% | 190us | `internal:http` | `internal:http:257` |
| 0.0% | 190us | 0.0% | 0us | `makeSafe` | `internal:primordials:37` |
| 0.0% | 190us | 0.0% | 0us | `node:_http_outgoing` | `node:_http_outgoing:45` |
| 0.0% | 189us | 0.0% | 0us | `makeSafe` | `internal:primordials:53` |
| 0.0% | 189us | 0.0% | 189us | `node:diagnostics_channel` | `node:diagnostics_channel:2` |
| 0.0% | 189us | 0.0% | 0us | `copyProps` | `internal:primordials:26` |
| 0.0% | 189us | 0.0% | 189us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:198` |
| 0.0% | 189us | 0.0% | 189us | `hasOwnProperty` | `[native code]` |
| 0.0% | 189us | 0.0% | 189us | `startInterval` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 189us | 0.0% | 189us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3502` |
| 0.0% | 189us | 0.0% | 0us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:70` |
| 0.0% | 189us | 0.0% | 189us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:202` |
| 0.0% | 187us | 0.0% | 0us | `Agent` | `node:_http_agent:22` |
| 0.0% | 187us | 0.0% | 0us | `#configuredQueryOpts` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1368` |
| 0.0% | 187us | 0.0% | 0us | `node:crypto` | `node:crypto:190` |
| 0.0% | 187us | 0.0% | 187us | `deprecate` | `internal:util/deprecate:30` |
| 0.0% | 187us | 0.0% | 187us | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1433` |
| 0.0% | 187us | 0.0% | 187us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 187us | 0.0% | 187us | `_addListener` | `node:events` |
| 0.0% | 187us | 0.0% | 0us | `addListener` | `node:events:214` |
| 0.0% | 186us | 0.0% | 186us | `makeSafe` | `internal:primordials` |
| 0.0% | 186us | 0.0% | 186us | `call` | `[native code]` |
| 0.0% | 186us | 0.0% | 0us | `node:fs/promises` | `node:fs/promises:153` |
| 0.0% | 186us | 0.0% | 0us | `internal:primordials` | `internal:primordials:83` |
| 0.0% | 186us | 0.0% | 186us | `asyncWrap` | `node:fs/promises:249` |
| 0.0% | 186us | 0.0% | 0us | `makeSafe` | `internal:primordials:35` |
| 0.0% | 185us | 0.0% | 185us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:24` |
| 0.0% | 185us | 0.0% | 185us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 185us | 0.0% | 0us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:237` |
| 0.0% | 184us | 0.0% | 184us | `(anonymous)` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:5` |
| 0.0% | 183us | 0.0% | 183us | `#canSkipHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:574` |
| 0.0% | 183us | 0.0% | 0us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3512` |
| 0.0% | 183us | 0.0% | 183us | `charCodeAt` | `[native code]` |
| 0.0% | 182us | 0.0% | 182us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:953` |
| 0.0% | 182us | 0.0% | 182us | `node:_http_outgoing` | `node:_http_outgoing:773` |
| 0.0% | 177us | 0.0% | 177us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1273` |

## Function Details

### `Response`
`[native code]` | Self: 16.3% (695.9ms) | Total: 16.3% (695.9ms) | Samples: 1763

**Called by:**
- `#respondWithText` (1755)
- `#respondWithText` (8)

### `Request`
`[native code]` | Self: 12.0% (514.0ms) | Total: 12.0% (514.0ms) | Samples: 1404

**Called by:**
- `static` (1404)

### `get`
`[native code]` | Self: 5.9% (251.0ms) | Total: 5.9% (251.0ms) | Samples: 761

**Called by:**
- `parseCookies` (369)
- `#finishAbsentBody` (212)
- `#finishAbsentBody` (177)
- `getMatchedLayers` (3)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1231` | Self: 4.6% (196.5ms) | Total: 4.6% (196.5ms) | Samples: 481

**Called by:**
- `init` (481)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` | Self: 3.7% (158.8ms) | Total: 4.0% (170.3ms) | Samples: 302

**Called by:**
- `#routeRequest` (334)

**Calls:**
- `(anonymous)` (29)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` | Self: 3.4% (147.4ms) | Total: 3.4% (148.4ms) | Samples: 230

**Called by:**
- `init` (235)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:281` | Self: 2.8% (120.2ms) | Total: 2.8% (120.2ms) | Samples: 291

**Called by:**
- `getMatchedLayers` (291)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3506` | Self: 2.6% (114.3ms) | Total: 2.6% (114.3ms) | Samples: 308

**Called by:**
- `parseQuery` (308)

### `params`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1706` | Self: 2.5% (106.6ms) | Total: 2.5% (106.6ms) | Samples: 306

**Called by:**
- `#runPipeline` (306)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 2.4% (103.6ms) | Total: 2.4% (103.6ms) | Samples: 295

**Called by:**
- `init` (295)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 2.3% (100.6ms) | Total: 2.3% (100.6ms) | Samples: 278

**Called by:**
- `#routeRequest` (278)

### `method`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` | Self: 2.2% (95.0ms) | Total: 2.2% (95.0ms) | Samples: 262

**Called by:**
- `#routeRequest` (172)
- `#canSkipHeaders` (90)

### `getRequestPathFromRequestURL`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4470` | Self: 2.1% (89.4ms) | Total: 2.1% (89.8ms) | Samples: 253

**Called by:**
- `getMatchedLayers` (255)

**Calls:**
- `indexOf` (2)

### `alloc`
`[native code]` | Self: 2.0% (86.7ms) | Total: 2.0% (86.7ms) | Samples: 189

**Called by:**
- `#finishAbsentBody` (189)

### `anonymous`
`[native code]` | Self: 2.0% (85.6ms) | Total: 6.2% (264.2ms) | Samples: 156

**Called by:**
- `require` (183)
- `node:http` (117)
- `node:_http_client` (90)
- `node:_http_common` (67)
- `node:_http_incoming` (33)
- `node:_http_incoming` (29)
- `internal:http/FakeSocket` (28)
- `internal:streams/readable` (21)
- `internal:stream` (21)
- `internal:streams/compose` (16)
- `bound require` (14)
- `internal:streams/pipeline` (14)
- `lazyInspectModule` (13)
- `internal:streams/duplex` (10)
- `internal:streams/destroy` (9)
- `internal:errors` (9)
- `node:path` (8)
- `node:_http_agent` (7)
- `internal:validators` (6)
- `internal:streams/add-abort-signal` (5)
- `internal:stream` (2)
- `node:crypto` (1)
- `internal:stream` (1)
- `node:events` (1)
- `node:tty` (1)
- `internal:streams/readable` (1)
- `node:fs/promises` (1)
- `internal:stream` (1)
- `node:_http_outgoing` (1)
- `node:util` (1)

**Calls:**
- `node:_http_client` (91)
- `node:_http_common` (68)
- `node:_http_incoming` (33)
- `node:_http_incoming` (29)
- `(anonymous)` (28)
- `internal:http/FakeSocket` (28)
- `internal:streams/readable` (21)
- `internal:stream` (21)
- `(anonymous)` (18)
- `(anonymous)` (17)
- `internal:streams/compose` (16)
- `(anonymous)` (15)
- `internal:streams/pipeline` (14)
- `(anonymous)` (11)
- `internal:streams/duplex` (11)
- `(anonymous)` (10)
- `internal:errors` (9)
- `node:path` (9)
- `internal:streams/destroy` (9)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `node:_http_agent` (7)
- `(anonymous)` (7)
- `internal:validators` (6)
- `internal:streams/add-abort-signal` (5)
- `internal:util/inspect` (3)
- `(anonymous)` (3)
- `internal:primordials` (3)
- `internal:stream` (2)
- `internal:util/inspect` (2)
- `internal:streams/readable` (2)
- `(anonymous)` (2)
- `node:_http_outgoing` (2)
- `internal:primordials` (2)
- `node:_http_agent` (2)
- `node:_http_outgoing` (1)
- `(anonymous)` (1)
- `internal:stream` (1)
- `internal:stream` (1)
- `(anonymous)` (1)
- `internal:streams/utils` (1)
- `node:diagnostics_channel` (1)
- `internal:http` (1)
- `internal:shared` (1)
- `internal:streams/writable` (1)
- `(anonymous)` (1)
- `internal:streams/duplexpair` (1)
- `internal:streams/destroy` (1)
- `node:_http_incoming` (1)
- `internal:streams/duplex` (1)
- `node:_http_outgoing` (1)
- `node:_http_server` (1)
- `node:_http_client` (1)
- `node:diagnostics_channel` (1)
- `node:_http_agent` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:streams/writable` (1)
- `internal:streams/readable` (1)
- `node:_http_outgoing` (1)
- `internal:promisify` (1)
- `internal:validators` (1)
- `(anonymous)` (1)
- `internal:http` (1)
- `internal:http` (1)
- `node:tty` (1)
- `internal:primordials` (1)
- `node:_http_outgoing` (1)
- `(anonymous)` (1)
- `internal:stream` (1)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1213` | Self: 1.8% (78.2ms) | Total: 1.9% (82.0ms) | Samples: 179

**Called by:**
- `#runPipeline` (190)

**Calls:**
- `Response` (8)
- `add` (3)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3541` | Self: 1.5% (67.0ms) | Total: 1.5% (67.0ms) | Samples: 253

**Called by:**
- `parseQuery` (252)
- `get` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1261` | Self: 1.4% (60.9ms) | Total: 1.6% (68.8ms) | Samples: 141

**Called by:**
- `init` (161)

**Calls:**
- `normalizeParseBodyOptions` (11)
- `normalizeParseBodyOptions` (5)
- `normalizeParseBodyOptions` (2)
- `normalizeParseBodyOptions` (1)
- `normalizeParseBodyOptions` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:437` | Self: 1.3% (59.0ms) | Total: 7.7% (330.5ms) | Samples: 190

**Called by:**
- `serveNativeRequest` (804)

**Calls:**
- `BunResponse` (334)
- `BunResponse` (278)
- `BunResponse` (2)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3507` | Self: 1.3% (58.0ms) | Total: 1.3% (58.0ms) | Samples: 151

**Called by:**
- `parseQuery` (151)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4777` | Self: 1.2% (55.2ms) | Total: 1.2% (55.2ms) | Samples: 161

**Called by:**
- `dispatch` (161)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3042` | Self: 1.2% (51.9ms) | Total: 1.2% (51.9ms) | Samples: 120

**Called by:**
- `BunRequest` (120)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3040` | Self: 1.1% (50.1ms) | Total: 3.7% (159.0ms) | Samples: 127

**Called by:**
- `BunRequest` (496)

**Calls:**
- `get` (369)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1267` | Self: 1.1% (49.3ms) | Total: 9.5% (404.8ms) | Samples: 140

**Called by:**
- `init` (1226)

**Calls:**
- `parseQuery` (1007)
- `parseQuery` (47)
- `parseQuery` (30)
- `push` (1)
- `parseQuery` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3520` | Self: 1.1% (47.7ms) | Total: 1.1% (47.7ms) | Samples: 146

**Called by:**
- `originalUrl` (130)
- `parseQuery` (16)

### `cloneObject`
`[native code]` | Self: 0.9% (41.9ms) | Total: 0.9% (41.9ms) | Samples: 126

**Called by:**
- `#writableOptions` (126)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1214` | Self: 0.8% (34.9ms) | Total: 17.1% (730.7ms) | Samples: 65

**Called by:**
- `#runPipeline` (1829)

**Calls:**
- `Response` (1755)
- `set response` (7)
- `set response` (1)
- `set response` (1)

### `init`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1432` | Self: 0.8% (34.6ms) | Total: 37.3% (1.59s) | Samples: 93

**Called by:**
- `serveNativeRequest` (4206)

**Calls:**
- `BunRequest` (1226)
- `BunRequest` (828)
- `BunRequest` (710)
- `BunRequest` (481)
- `BunRequest` (295)
- `BunRequest` (235)
- `BunRequest` (163)
- `BunRequest` (161)
- `BunRequest` (8)
- `BunRequest` (2)
- `BunRequest` (1)
- `BunRequest` (1)
- `BunRequest` (1)
- `BunRequest` (1)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1335` | Self: 0.6% (28.4ms) | Total: 0.6% (28.4ms) | Samples: 84

**Called by:**
- `BunRequest` (84)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5102` | Self: 0.6% (27.5ms) | Total: 21.1% (898.4ms) | Samples: 66

**Called by:**
- `#routeRequest` (2261)

**Calls:**
- `#respondWithText` (1829)
- `#respondWithText` (190)
- `#respondWithText` (96)
- `#respondWithText` (47)
- `send` (28)
- `send` (3)
- `#respondWithText` (1)
- `send` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5072` | Self: 0.6% (26.6ms) | Total: 0.6% (26.6ms) | Samples: 58

**Called by:**
- `#routeRequest` (58)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/index.js:6` | Self: 0.6% (26.1ms) | Total: 0.6% (26.1ms) | Samples: 1

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1336` | Self: 0.5% (25.3ms) | Total: 0.5% (25.3ms) | Samples: 63

**Called by:**
- `BunRequest` (63)

### `getRequestPathFromRequestURL`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4471` | Self: 0.5% (24.4ms) | Total: 0.5% (24.4ms) | Samples: 73

**Called by:**
- `getMatchedLayers` (73)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3540` | Self: 0.5% (24.1ms) | Total: 0.5% (24.3ms) | Samples: 84

**Called by:**
- `parseQuery` (85)

**Calls:**
- `slice` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3533` | Self: 0.5% (21.9ms) | Total: 0.5% (21.9ms) | Samples: 76

**Called by:**
- `parseQuery` (76)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3521` | Self: 0.5% (21.3ms) | Total: 0.5% (21.3ms) | Samples: 61

**Called by:**
- `parseQuery` (61)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5006` | Self: 0.4% (19.3ms) | Total: 0.4% (19.3ms) | Samples: 29

**Called by:**
- `#routeRequest` (29)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1306` | Self: 0.4% (19.3ms) | Total: 6.1% (260.4ms) | Samples: 24

**Called by:**
- `init` (710)

**Calls:**
- `parseCookies` (496)
- `parseCookies` (120)
- `parseCookies` (26)
- `parseCookies` (21)
- `parseCookies` (17)
- `parseCookies` (3)
- `parseCookies` (1)
- `parseCookies` (1)
- `parseCookies` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:3` | Self: 0.4% (18.4ms) | Total: 0.4% (18.4ms) | Samples: 25

**Called by:**
- `#compileRouteRegExp` (25)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1340` | Self: 0.3% (16.5ms) | Total: 2.4% (103.2ms) | Samples: 59

**Called by:**
- `BunRequest` (248)

**Calls:**
- `alloc` (189)

### `#writableOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1356` | Self: 0.3% (15.8ms) | Total: 1.3% (57.8ms) | Samples: 36

**Called by:**
- `BunRequest` (162)

**Calls:**
- `cloneObject` (126)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3029` | Self: 0.3% (14.1ms) | Total: 0.3% (14.1ms) | Samples: 21

**Called by:**
- `BunRequest` (21)

### `dispatch`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4984` | Self: 0.3% (13.8ms) | Total: 7.3% (314.8ms) | Samples: 36

**Called by:**
- `#routeRequest` (845)

**Calls:**
- `getMatchedLayers` (332)
- `getMatchedLayers` (294)
- `getMatchedLayers` (161)
- `getMatchedLayers` (11)
- `getMatchedLayers` (8)
- `getMatchedLayers` (2)
- `getMatchedLayers` (1)

### `serveNativeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:404` | Self: 0.3% (12.9ms) | Total: 43.8% (1.86s) | Samples: 49

**Called by:**
- `(anonymous)` (3161)
- `(module)` (1575)
- `bound serveNativeRequest` (54)

**Calls:**
- `#routeRequest` (3577)
- `#routeRequest` (804)
- `#routeRequest` (174)
- `#routeRequest` (139)
- `#routeRequest` (17)
- `#routeRequest` (8)
- `#produceResponse` (4)
- `#routeRequest` (4)
- `#routeRequest` (3)
- `#routeRequest` (3)
- `#routeRequest` (2)
- `#respond` (2)
- `#routeRequest` (1)
- `#routeRequest` (1)
- `#routeRequest` (1)
- `#produceResponse` (1)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1203` | Self: 0.2% (12.6ms) | Total: 0.2% (12.6ms) | Samples: 47

**Called by:**
- `#runPipeline` (47)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3530` | Self: 0.2% (12.1ms) | Total: 0.2% (12.1ms) | Samples: 35

**Called by:**
- `parseQuery` (35)

### `node:zlib`
`node:zlib:2` | Self: 0.2% (11.8ms) | Total: 0.2% (11.8ms) | Samples: 2

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2997` | Self: 0.2% (11.7ms) | Total: 0.2% (12.4ms) | Samples: 44

**Called by:**
- `BunRequest` (47)

**Calls:**
- `set query` (2)
- `create` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:422` | Self: 0.2% (11.1ms) | Total: 0.2% (11.3ms) | Samples: 16

**Called by:**
- `serveNativeRequest` (17)

**Calls:**
- `get isPayloadTooLarge` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:514` | Self: 0.2% (10.1ms) | Total: 0.2% (10.1ms) | Samples: 29

**Called by:**
- `BunResponse` (29)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2991` | Self: 0.2% (9.2ms) | Total: 0.2% (9.4ms) | Samples: 29

**Called by:**
- `BunRequest` (30)

**Calls:**
- `#configuredQueryOpts` (1)

### `node:fs`
`node:fs:298` | Self: 0.2% (9.1ms) | Total: 0.2% (9.1ms) | Samples: 1

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1331` | Self: 0.2% (8.9ms) | Total: 1.7% (74.1ms) | Samples: 32

**Called by:**
- `BunRequest` (245)

**Calls:**
- `get` (212)
- `get` (1)

### `serveNativeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:402` | Self: 0.2% (8.7ms) | Total: 37.6% (1.60s) | Samples: 19

**Called by:**
- `(anonymous)` (2758)
- `(module)` (1441)
- `bound serveNativeRequest` (28)

**Calls:**
- `init` (4206)
- `init` (1)
- `init` (1)

### `send`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.2% (8.5ms) | Total: 0.2% (8.5ms) | Samples: 28

**Called by:**
- `#runPipeline` (28)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3546` | Self: 0.1% (8.4ms) | Total: 0.1% (8.4ms) | Samples: 19

**Called by:**
- `parseQuery` (19)

### `dispatch`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4988` | Self: 0.1% (8.2ms) | Total: 0.1% (8.2ms) | Samples: 20

**Called by:**
- `#routeRequest` (20)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3045` | Self: 0.1% (7.6ms) | Total: 0.1% (7.6ms) | Samples: 26

**Called by:**
- `BunRequest` (26)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3044` | Self: 0.1% (7.1ms) | Total: 0.1% (7.1ms) | Samples: 17

**Called by:**
- `BunRequest` (17)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:455` | Self: 0.1% (6.7ms) | Total: 32.7% (1.39s) | Samples: 11

**Called by:**
- `serveNativeRequest` (3577)

**Calls:**
- `#runPipeline` (2261)
- `dispatch` (845)
- `#runPipeline` (308)
- `#runPipeline` (58)
- `#runPipeline` (29)
- `#runPipeline` (25)
- `dispatch` (20)
- `#runPipeline` (6)
- `#runPipeline` (4)
- `#runPipeline` (3)
- `#runPipeline` (1)
- `#runPipeline` (1)
- `#runPipeline` (1)
- `#finishPipeline` (1)
- `#runPipeline` (1)
- `dispatch` (1)
- `#finishPipeline` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5009` | Self: 0.1% (6.6ms) | Total: 0.1% (6.6ms) | Samples: 25

**Called by:**
- `#routeRequest` (25)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:20` | Self: 0.1% (5.9ms) | Total: 93.7% (3.98s) | Samples: 10

**Calls:**
- `(anonymous)` (5920)
- `serveNativeRequest` (1575)
- `serveNativeRequest` (1441)
- `static` (1411)
- `bound serveNativeRequest` (82)
- `(anonymous)` (2)
- `static` (2)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:21` | Self: 0.1% (5.8ms) | Total: 0.1% (5.8ms) | Samples: 26

### `(module)`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:29` | Self: 0.1% (4.8ms) | Total: 0.1% (4.8ms) | Samples: 1

### `#canSkipHeaders`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.1% (4.7ms) | Total: 0.1% (4.7ms) | Samples: 2

**Called by:**
- `#respondWithText` (2)

### `replace`
`[native code]` | Self: 0.1% (4.5ms) | Total: 0.1% (4.5ms) | Samples: 6

**Called by:**
- `pathRegex` (2)
- `pathRegex` (2)
- `mimeScore` (1)
- `enable` (1)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2488` | Self: 0.1% (4.5ms) | Total: 0.1% (4.5ms) | Samples: 11

**Called by:**
- `BunRequest` (11)

### `setPrototypeDirectOrThrow`
`[native code]` | Self: 0.1% (4.4ms) | Total: 0.1% (4.4ms) | Samples: 1

**Called by:**
- `(module)` (1)

### `filter`
`[native code]` | Self: 0.0% (4.1ms) | Total: 0.1% (4.5ms) | Samples: 3

**Called by:**
- `bound call` (3)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `uncurryThis`
`internal:primordials` | Self: 0.0% (4.1ms) | Total: 0.0% (4.1ms) | Samples: 2

**Called by:**
- `internal:util/inspect` (2)

### `@lazy`
`[native code]` | Self: 0.0% (3.9ms) | Total: 0.0% (3.9ms) | Samples: 4

**Called by:**
- `node:crypto` (2)
- `node:path` (1)
- `node:vm` (1)

### `RegExp`
`[native code]` | Self: 0.0% (3.8ms) | Total: 0.0% (3.8ms) | Samples: 19

**Called by:**
- `pathRegex` (19)

### `require`
`[native code]` | Self: 0.0% (3.8ms) | Total: 2.5% (108.5ms) | Samples: 2

**Called by:**
- `bound require` (185)

**Calls:**
- `anonymous` (183)

### `splitRequestPath`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (3.4ms) | Total: 0.0% (3.4ms) | Samples: 1

**Called by:**
- `candidates` (1)

### `node:stream/web`
`node:stream/web:7` | Self: 0.0% (3.4ms) | Total: 0.0% (3.4ms) | Samples: 3

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (3.2ms) | Total: 0.0% (3.2ms) | Samples: 11

**Called by:**
- `dispatch` (11)

### `_preferredTypeLegacy`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:199` | Self: 0.0% (2.8ms) | Total: 0.0% (2.8ms) | Samples: 3

**Called by:**
- `forEachMimeType` (3)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:18` | Self: 0.0% (2.7ms) | Total: 0.0% (2.7ms) | Samples: 2

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` | Self: 0.0% (2.6ms) | Total: 0.0% (2.6ms) | Samples: 2

### `useColors`
`/home/user/bun-node/node_modules/debug/src/node.js` | Self: 0.0% (2.6ms) | Total: 0.0% (2.6ms) | Samples: 1

**Called by:**
- `createDebug` (1)

### `enable`
`/home/user/bun-node/node_modules/debug/src/common.js` | Self: 0.0% (2.5ms) | Total: 0.0% (2.5ms) | Samples: 1

**Called by:**
- `setup` (1)

### `emitFinish`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:797` | Self: 0.0% (2.5ms) | Total: 0.0% (2.5ms) | Samples: 6

**Called by:**
- `set response` (6)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:440` | Self: 0.0% (2.5ms) | Total: 0.0% (2.7ms) | Samples: 7

**Called by:**
- `serveNativeRequest` (8)

**Calls:**
- `get instance` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1272` | Self: 0.0% (2.3ms) | Total: 0.0% (2.3ms) | Samples: 1

**Called by:**
- `init` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:185` | Self: 0.0% (2.3ms) | Total: 0.0% (2.3ms) | Samples: 7

**Called by:**
- `forEach` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:15` | Self: 0.0% (2.1ms) | Total: 0.0% (3.0ms) | Samples: 1

**Calls:**
- `bound require` (4)

### `isObject`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:179` | Self: 0.0% (1.9ms) | Total: 0.0% (1.9ms) | Samples: 2

**Called by:**
- `normalizeParseBodyOptions` (1)
- `#configuredQueryOpts` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:136` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 8

**Called by:**
- `#compileRouteRegExp` (8)

### `static`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` | Self: 0.0% (1.7ms) | Total: 12.1% (515.8ms) | Samples: 7

**Called by:**
- `(module)` (1411)

**Calls:**
- `Request` (1404)

### `importModule`
`[native code]` | Self: 0.0% (1.6ms) | Total: 0.0% (1.6ms) | Samples: 6

**Called by:**
- `async makeTarget` (6)

### `internal:promisify`
`internal:promisify:2` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 1

**Called by:**
- `anonymous` (1)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1332` | Self: 0.0% (1.3ms) | Total: 1.8% (78.0ms) | Samples: 6

**Called by:**
- `BunRequest` (183)

**Calls:**
- `get` (177)

### `from`
`[native code]` | Self: 0.0% (1.2ms) | Total: 0.0% (1.5ms) | Samples: 3

**Called by:**
- `(module)` (2)
- `(module)` (2)

**Calls:**
- `(anonymous)` (1)

### `map`
`[native code]` | Self: 0.0% (1.2ms) | Total: 0.1% (5.0ms) | Samples: 5

**Called by:**
- `#build` (4)
- `compileRoute` (3)
- `Route` (2)
- `#compileRouteRegExp` (2)
- `node:zlib` (2)
- `node:zlib` (1)
- `define` (1)

**Calls:**
- `compileRoute` (3)
- `segmentKind` (3)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `compileRoute` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:25` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `Mime` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3511` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:169` | Self: 0.0% (997us) | Total: 0.0% (4.0ms) | Samples: 1

**Called by:**
- `forEach` (13)

**Calls:**
- `_preferredType` (12)

### `segmentKind`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:71` | Self: 0.0% (997us) | Total: 0.0% (1.4ms) | Samples: 1

**Called by:**
- `map` (3)

**Calls:**
- `test` (2)

### `forEach`
`[native code]` | Self: 0.0% (991us) | Total: 0.3% (14.5ms) | Samples: 4

**Called by:**
- `populateMaps` (27)
- `populateMaps` (16)

**Calls:**
- `forEachMimeType` (13)
- `forEachMimeType` (7)
- `forEachMimeType` (5)
- `forEachMimeType` (4)
- `forEachMimeType` (3)
- `forEachMimeType` (3)
- `forEachMimeType` (2)
- `forEachMimeType` (1)
- `forEachMimeType` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:20` | Self: 0.0% (978us) | Total: 0.0% (1.5ms) | Samples: 5

**Called by:**
- `setRoute` (8)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:157` | Self: 0.0% (958us) | Total: 0.0% (958us) | Samples: 1

**Called by:**
- `forEach` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5135` | Self: 0.0% (948us) | Total: 0.0% (948us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:164` | Self: 0.0% (944us) | Total: 0.0% (944us) | Samples: 3

**Called by:**
- `forEach` (3)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (943us) | Total: 0.0% (943us) | Samples: 5

**Called by:**
- `BunRequest` (5)

### `registerExpressStyle`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:177` | Self: 0.0% (942us) | Total: 0.8% (37.3ms) | Samples: 5

**Called by:**
- `async makeTarget` (116)

**Calls:**
- `setRoute` (98)
- `get` (2)
- `get` (2)
- `get` (2)
- `setRoute` (2)
- `setRoute` (1)
- `addRoute` (1)
- `setRoute` (1)
- `addRoute` (1)
- `setRoute` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:521` | Self: 0.0% (928us) | Total: 0.0% (928us) | Samples: 1

**Called by:**
- `BunResponse` (1)

### `split`
`[native code]` | Self: 0.0% (921us) | Total: 0.0% (921us) | Samples: 4

**Called by:**
- `mimeScore` (4)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:19` | Self: 0.0% (878us) | Total: 0.0% (878us) | Samples: 4

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` | Self: 0.0% (823us) | Total: 0.0% (823us) | Samples: 2

**Called by:**
- `(module)` (1)
- `async makeTarget` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:156` | Self: 0.0% (806us) | Total: 0.0% (806us) | Samples: 4

**Called by:**
- `forEach` (4)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4774` | Self: 0.0% (792us) | Total: 2.7% (115.1ms) | Samples: 4

**Called by:**
- `dispatch` (332)

**Calls:**
- `getRequestPathFromRequestURL` (255)
- `getRequestPathFromRequestURL` (73)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5125` | Self: 0.0% (784us) | Total: 0.0% (784us) | Samples: 4

**Called by:**
- `#routeRequest` (4)

### `send`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1409` | Self: 0.0% (718us) | Total: 0.0% (718us) | Samples: 3

**Called by:**
- `#runPipeline` (3)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1299` | Self: 0.0% (717us) | Total: 0.0% (1.6ms) | Samples: 4

**Called by:**
- `init` (8)

**Calls:**
- `#configuredCookieSecrets` (3)
- `#configuredCookieSecrets` (1)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:49` | Self: 0.0% (697us) | Total: 0.0% (697us) | Samples: 1

**Called by:**
- `_preferredType` (1)

### `#configuredCookieSecrets`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (692us) | Total: 0.0% (692us) | Samples: 3

**Called by:**
- `BunRequest` (3)

### `originalUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3699` | Self: 0.0% (690us) | Total: 0.0% (690us) | Samples: 3

**Called by:**
- `#routeRequest` (3)

### `createConvenienceMethod`
`node:zlib` | Self: 0.0% (671us) | Total: 0.0% (671us) | Samples: 1

**Called by:**
- `node:zlib` (1)

### `internal:http`
`internal:http:34` | Self: 0.0% (657us) | Total: 0.0% (657us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `get headersSent`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` | Self: 0.0% (638us) | Total: 0.0% (852us) | Samples: 2

**Called by:**
- `layerFinished` (1)
- `#settleLayer` (1)
- `send` (1)

**Calls:**
- `get upgradeToWsData` (1)

### `toUpperCase`
`[native code]` | Self: 0.0% (637us) | Total: 0.0% (637us) | Samples: 2

**Called by:**
- `addRoute` (1)
- `Route` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:167` | Self: 0.0% (629us) | Total: 0.0% (629us) | Samples: 3

**Called by:**
- `forEach` (3)

### `join`
`[native code]` | Self: 0.0% (628us) | Total: 0.0% (628us) | Samples: 1

**Called by:**
- `bound join` (1)

### `get originalUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3699` | Self: 0.0% (628us) | Total: 0.0% (628us) | Samples: 2

**Called by:**
- `#routeRequest` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` | Self: 0.0% (620us) | Total: 0.0% (620us) | Samples: 3

**Called by:**
- `map` (2)
- `Route` (1)

### `add`
`[native code]` | Self: 0.0% (606us) | Total: 0.0% (606us) | Samples: 3

**Called by:**
- `#respondWithText` (3)

### `isString`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:150` | Self: 0.0% (602us) | Total: 0.0% (602us) | Samples: 3

**Called by:**
- `get` (2)
- `get` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3046` | Self: 0.0% (598us) | Total: 0.0% (598us) | Samples: 3

**Called by:**
- `BunRequest` (3)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:40` | Self: 0.0% (595us) | Total: 0.0% (1.5ms) | Samples: 3

**Called by:**
- `_preferredType` (7)

**Calls:**
- `split` (4)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:6` | Self: 0.0% (591us) | Total: 0.0% (591us) | Samples: 3

**Called by:**
- `#compileRouteRegExp` (3)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:476` | Self: 0.0% (590us) | Total: 0.0% (590us) | Samples: 3

**Called by:**
- `serveNativeRequest` (3)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:14` | Self: 0.0% (583us) | Total: 0.0% (1.1ms) | Samples: 3

**Called by:**
- `Route` (6)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)

### `_freeze`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js` | Self: 0.0% (561us) | Total: 0.0% (561us) | Samples: 1

**Called by:**
- `(module)` (1)

### `freeze`
`[native code]` | Self: 0.0% (533us) | Total: 0.0% (533us) | Samples: 1

**Called by:**
- `(module)` (1)

### `get settledResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2045` | Self: 0.0% (508us) | Total: 0.0% (508us) | Samples: 2

**Called by:**
- `#produceResponse` (2)

### `useColors`
`/home/user/bun-node/node_modules/debug/src/node.js:158` | Self: 0.0% (464us) | Total: 0.0% (1.7ms) | Samples: 2

**Called by:**
- `createDebug` (8)

**Calls:**
- `(anonymous)` (6)

### `layerFinished`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (461us) | Total: 0.0% (461us) | Samples: 2

**Called by:**
- `#runPipeline` (2)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2496` | Self: 0.0% (442us) | Total: 0.0% (442us) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (440us) | Total: 0.0% (440us) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (439us) | Total: 0.0% (439us) | Samples: 2

**Called by:**
- `get originalUrl` (1)
- `parseQuery` (1)

### `isBoolean`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` | Self: 0.0% (439us) | Total: 0.0% (439us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `set query`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (437us) | Total: 0.0% (437us) | Samples: 2

**Called by:**
- `parseQuery` (2)

### `test`
`[native code]` | Self: 0.0% (436us) | Total: 0.0% (436us) | Samples: 2

**Called by:**
- `segmentKind` (2)

### `WriteStream`
`internal:fs/streams` | Self: 0.0% (429us) | Total: 0.0% (429us) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `Empty`
`/home/user/bun-node/node_modules/picoquery/lib/parse.js` | Self: 0.0% (426us) | Total: 0.0% (426us) | Samples: 1

**Called by:**
- `parse` (1)

### `parse`
`/home/user/bun-node/node_modules/picoquery/lib/parse.js` | Self: 0.0% (424us) | Total: 0.0% (424us) | Samples: 2

**Called by:**
- `(module)` (2)

### `isArray`
`[native code]` | Self: 0.0% (422us) | Total: 0.0% (422us) | Samples: 2

**Called by:**
- `Route` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` | Self: 0.0% (420us) | Total: 0.0% (420us) | Samples: 2

**Called by:**
- `Cache` (2)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:89` | Self: 0.0% (418us) | Total: 0.0% (418us) | Samples: 2

**Called by:**
- `#compileRouteRegExp` (2)

### `get size`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:276` | Self: 0.0% (415us) | Total: 0.0% (415us) | Samples: 2

**Called by:**
- `setRoute` (2)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1699` | Self: 0.0% (411us) | Total: 0.0% (411us) | Samples: 2

**Called by:**
- `registerExpressStyle` (2)

### `getOwnPropertyDescriptor`
`[native code]` | Self: 0.0% (409us) | Total: 0.0% (409us) | Samples: 2

**Called by:**
- `makeSafe` (1)
- `internal:streams/duplex` (1)

### `defineProperty`
`[native code]` | Self: 0.0% (409us) | Total: 0.0% (409us) | Samples: 2

**Called by:**
- `node:_http_incoming` (1)
- `node:zlib` (1)

### `createSafeIterator`
`internal:primordials` | Self: 0.0% (409us) | Total: 0.0% (409us) | Samples: 2

**Called by:**
- `internal:primordials` (2)

### `(anonymous)`
`[native code]` | Self: 0.0% (407us) | Total: 0.0% (1.6ms) | Samples: 2

**Called by:**
- `useColors` (6)
- `node:zlib` (1)
- `node:_http_outgoing` (1)

**Calls:**
- `WriteStream` (3)
- `WriteStream` (2)
- `WriteStream` (1)

### `push`
`[native code]` | Self: 0.0% (407us) | Total: 0.0% (407us) | Samples: 2

**Called by:**
- `pathRegex` (1)
- `BunRequest` (1)

### `slice`
`[native code]` | Self: 0.0% (406us) | Total: 0.0% (406us) | Samples: 2

**Called by:**
- `splitRequestUrl` (1)
- `node:_http_outgoing` (1)

### `#produceResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:555` | Self: 0.0% (406us) | Total: 0.0% (914us) | Samples: 2

**Called by:**
- `serveNativeRequest` (4)

**Calls:**
- `get settledResponse` (2)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (400us) | Total: 0.0% (400us) | Samples: 2

**Called by:**
- `#runPipeline` (2)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:177` | Self: 0.0% (397us) | Total: 0.0% (397us) | Samples: 2

**Called by:**
- `#compileRouteRegExp` (2)

### `host`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3577` | Self: 0.0% (395us) | Total: 0.0% (395us) | Samples: 2

**Called by:**
- `#routeRequest` (2)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (395us) | Total: 0.0% (395us) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` | Self: 0.0% (394us) | Total: 0.0% (394us) | Samples: 1

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1305` | Self: 0.0% (394us) | Total: 0.0% (394us) | Samples: 2

**Called by:**
- `init` (2)

### `indexOf`
`[native code]` | Self: 0.0% (393us) | Total: 0.0% (393us) | Samples: 2

**Called by:**
- `getRequestPathFromRequestURL` (2)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1271` | Self: 0.0% (393us) | Total: 7.2% (310.2ms) | Samples: 2

**Called by:**
- `init` (828)

**Calls:**
- `#finishAbsentBody` (248)
- `#finishAbsentBody` (245)
- `#finishAbsentBody` (183)
- `#finishAbsentBody` (84)
- `#finishAbsentBody` (63)
- `#finishAbsentBody` (2)
- `#finishAbsentBody` (1)

### `static`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` | Self: 0.0% (389us) | Total: 0.0% (389us) | Samples: 2

**Called by:**
- `(module)` (2)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:447` | Self: 0.0% (389us) | Total: 0.0% (389us) | Samples: 2

**Called by:**
- `serveNativeRequest` (2)

### `(anonymous)`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` | Self: 0.0% (386us) | Total: 0.0% (386us) | Samples: 2

**Called by:**
- `(module)` (2)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4784` | Self: 0.0% (386us) | Total: 0.0% (386us) | Samples: 2

**Called by:**
- `dispatch` (2)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:431` | Self: 0.0% (386us) | Total: 0.0% (586us) | Samples: 2

**Called by:**
- `serveNativeRequest` (3)

**Calls:**
- `get bodyDecodingError` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:178` | Self: 0.0% (383us) | Total: 0.0% (383us) | Samples: 2

**Called by:**
- `forEach` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:18` | Self: 0.0% (382us) | Total: 0.0% (382us) | Samples: 2

**Called by:**
- `Route` (2)

### `#respond`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:487` | Self: 0.0% (376us) | Total: 0.0% (376us) | Samples: 2

**Called by:**
- `serveNativeRequest` (2)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:198` | Self: 0.0% (373us) | Total: 0.0% (373us) | Samples: 2

**Called by:**
- `#compileRouteRegExp` (2)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:165` | Self: 0.0% (371us) | Total: 0.0% (371us) | Samples: 2

**Called by:**
- `#compileRouteRegExp` (2)

### `get originalUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` | Self: 0.0% (363us) | Total: 0.0% (575us) | Samples: 2

**Called by:**
- `#routeRequest` (3)

**Calls:**
- `splitRequestUrl` (1)

### `populateMaps`
`/home/user/bun-node/node_modules/mime-types/index.js:158` | Self: 0.0% (362us) | Total: 0.1% (4.6ms) | Samples: 2

**Called by:**
- `(anonymous)` (18)

**Calls:**
- `forEach` (16)

### `__classPrivateFieldGet`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js` | Self: 0.0% (332us) | Total: 0.0% (332us) | Samples: 1

**Called by:**
- `define` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js` | Self: 0.0% (327us) | Total: 0.0% (327us) | Samples: 1

**Called by:**
- `map` (1)

### `(module)`
`/home/user/bun-node/node_modules/mime/dist/types/standard.js:365` | Self: 0.0% (317us) | Total: 0.0% (317us) | Samples: 1

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (314us) | Total: 0.0% (314us) | Samples: 1

**Called by:**
- `getMatchedLayers` (1)

### `(anonymous)`
`internal:util/inspect:46` | Self: 0.0% (312us) | Total: 0.0% (312us) | Samples: 1

**Called by:**
- `filter` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/has-flag/index.js:7` | Self: 0.0% (300us) | Total: 0.0% (300us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `__classPrivateFieldGet`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:3` | Self: 0.0% (300us) | Total: 0.0% (300us) | Samples: 1

**Called by:**
- `define` (1)

### `supportsColor`
`/home/user/bun-node/node_modules/supports-color/index.js` | Self: 0.0% (300us) | Total: 0.0% (300us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:20` | Self: 0.0% (299us) | Total: 0.0% (631us) | Samples: 1

**Called by:**
- `Mime` (2)

**Calls:**
- `__classPrivateFieldGet` (1)

### `Mime`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js` | Self: 0.0% (299us) | Total: 0.0% (299us) | Samples: 1

**Called by:**
- `(module)` (1)

### `node:_http_server`
`node:_http_server:292` | Self: 0.0% (299us) | Total: 0.0% (299us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(module)`
`/home/user/bun-node/node_modules/mime/dist/types/other.js:718` | Self: 0.0% (290us) | Total: 0.0% (823us) | Samples: 1

**Calls:**
- `freeze` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js` | Self: 0.0% (288us) | Total: 0.0% (288us) | Samples: 1

**Called by:**
- `Mime` (1)

### `keys`
`[native code]` | Self: 0.0% (286us) | Total: 0.0% (286us) | Samples: 1

**Called by:**
- `populateMaps` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` | Self: 0.0% (278us) | Total: 0.0% (278us) | Samples: 1

**Called by:**
- `from` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5062` | Self: 0.0% (275us) | Total: 2.5% (107.0ms) | Samples: 1

**Called by:**
- `#routeRequest` (308)

**Calls:**
- `params` (306)
- `set params` (1)

### `internal:stream`
`internal:stream:44` | Self: 0.0% (257us) | Total: 0.0% (257us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `internal:streams/writable`
`internal:streams/writable:2` | Self: 0.0% (247us) | Total: 0.0% (247us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:73` | Self: 0.0% (245us) | Total: 0.0% (663us) | Samples: 1

**Called by:**
- `setRoute` (3)

**Calls:**
- `map` (2)

### `internal:streams/duplex`
`internal:streams/duplex:2` | Self: 0.0% (241us) | Total: 0.0% (2.3ms) | Samples: 1

**Called by:**
- `anonymous` (11)

**Calls:**
- `anonymous` (10)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:85` | Self: 0.0% (237us) | Total: 0.0% (237us) | Samples: 1

### `#compileRouteRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:194` | Self: 0.0% (234us) | Total: 0.6% (28.3ms) | Samples: 1

**Called by:**
- `Route` (73)

**Calls:**
- `pathRegex` (25)
- `pathRegex` (19)
- `pathRegex` (8)
- `pathRegex` (3)
- `pathRegex` (2)
- `pathRegex` (2)
- `pathRegex` (2)
- `pathRegex` (2)
- `pathRegex` (2)
- `pathRegex` (1)
- `pathRegex` (1)
- `pathRegex` (1)
- `pathRegex` (1)
- `pathRegex` (1)
- `pathRegex` (1)
- `pathRegex` (1)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:42` | Self: 0.0% (234us) | Total: 0.0% (432us) | Samples: 1

**Called by:**
- `_preferredType` (2)

**Calls:**
- `replace` (1)

### `(anonymous)`
`internal:http` | Self: 0.0% (230us) | Total: 0.0% (230us) | Samples: 1

**Called by:**
- `internal:http` (1)

### `addRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1249` | Self: 0.0% (229us) | Total: 0.0% (229us) | Samples: 1

**Called by:**
- `registerExpressStyle` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:528` | Self: 0.0% (226us) | Total: 0.0% (226us) | Samples: 1

**Called by:**
- `BunResponse` (1)

### `internal:streams/duplexpair`
`internal:streams/duplexpair:5` | Self: 0.0% (226us) | Total: 0.0% (226us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:86` | Self: 0.0% (226us) | Total: 56.6% (2.40s) | Samples: 1

**Called by:**
- `(module)` (5920)

**Calls:**
- `serveNativeRequest` (3161)
- `serveNativeRequest` (2758)

### `get isPayloadTooLarge`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (224us) | Total: 0.0% (224us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `Channel`
`node:diagnostics_channel:107` | Self: 0.0% (224us) | Total: 0.0% (224us) | Samples: 1

**Called by:**
- `channel` (1)

### `node:_http_common`
`node:_http_common:2` | Self: 0.0% (223us) | Total: 0.3% (15.9ms) | Samples: 1

**Called by:**
- `anonymous` (68)

**Calls:**
- `anonymous` (67)

### `LinkedList`
`[native code]` | Self: 0.0% (222us) | Total: 0.0% (222us) | Samples: 1

**Called by:**
- `Cache` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:18` | Self: 0.0% (220us) | Total: 0.0% (220us) | Samples: 1

**Called by:**
- `Route` (1)

### `internal:shared`
`internal:shared:4` | Self: 0.0% (220us) | Total: 0.0% (220us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `get instance`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` | Self: 0.0% (220us) | Total: 0.0% (220us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `#finishPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5313` | Self: 0.0% (219us) | Total: 0.0% (219us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:32` | Self: 0.0% (219us) | Total: 0.0% (219us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `node:_http_outgoing`
`node:_http_outgoing:511` | Self: 0.0% (219us) | Total: 0.0% (434us) | Samples: 1

**Called by:**
- `anonymous` (2)

**Calls:**
- `(anonymous)` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:460` | Self: 0.0% (219us) | Total: 0.0% (219us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `node:events`
`node:events:26` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

### `get legacyCookieOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

**Called by:**
- `#configuredCookieSecrets` (1)

### `splitPattern`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

**Called by:**
- `compileRoute` (1)

### `internal:streams/destroy`
`internal:streams/destroy:16` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

**Called by:**
- `registerExpressStyle` (1)

### `Map`
`[native code]` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

**Called by:**
- `Cache` (1)

### `get #etagEnabled`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

**Called by:**
- `#canSkipHeaders` (1)

### `init`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` | Self: 0.0% (216us) | Total: 7.8% (333.2ms) | Samples: 1

**Called by:**
- `BunRequest` (1007)

**Calls:**
- `splitRequestUrl` (308)
- `splitRequestUrl` (252)
- `splitRequestUrl` (151)
- `splitRequestUrl` (85)
- `splitRequestUrl` (76)
- `splitRequestUrl` (61)
- `splitRequestUrl` (35)
- `splitRequestUrl` (19)
- `splitRequestUrl` (16)
- `splitRequestUrl` (1)
- `splitRequestUrl` (1)
- `splitRequestUrl` (1)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `defineCustomPromisifyArgs`
`internal:promisify` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `node:crypto` (1)

### `EventEmitter`
`node:events` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `Agent` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:176` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `get upgradeToWsData`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1350` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `get headersSent` (1)

### `shouldUseEnvProxy`
`node:_http_agent` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `node:_http_agent` (1)

### `matchRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `getMatchedLayers` (1)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1697` | Self: 0.0% (212us) | Total: 0.0% (406us) | Samples: 1

**Called by:**
- `registerExpressStyle` (2)

**Calls:**
- `isString` (1)

### `internal:streams/writable`
`internal:streams/writable:53` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `splitPattern`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:55` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `candidates` (1)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5220` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:443` | Self: 0.0% (212us) | Total: 1.5% (65.5ms) | Samples: 1

**Called by:**
- `serveNativeRequest` (174)

**Calls:**
- `method` (172)
- `get method` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:681` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `BunResponse` (1)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1209` | Self: 0.0% (211us) | Total: 0.8% (35.5ms) | Samples: 1

**Called by:**
- `#runPipeline` (96)

**Calls:**
- `#canSkipHeaders` (91)
- `#canSkipHeaders` (2)
- `#canSkipHeaders` (1)
- `#canSkipHeaders` (1)

### `internal:streams/readable`
`internal:streams/readable:811` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `node:_http_client`
`node:_http_client:219` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `setName`
`node:fs` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `node:fs` (1)

### `get headersSent`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `#settleLayer` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:446` | Self: 0.0% (209us) | Total: 1.0% (45.7ms) | Samples: 1

**Called by:**
- `serveNativeRequest` (139)

**Calls:**
- `originalUrl` (130)
- `get originalUrl` (3)
- `originalUrl` (3)
- `get originalUrl` (2)

### `resetBuffer`
`internal:streams/writable:155` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `WritableState` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:50` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/content-type/dist/index.js` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3026` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1003` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `registerExpressStyle` (1)

### `Writable`
`internal:streams/writable` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `WriteStream` (1)

### `#compileRouteRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` | Self: 0.0% (208us) | Total: 0.0% (700us) | Samples: 1

**Called by:**
- `Route` (3)

**Calls:**
- `map` (2)

### `create`
`[native code]` | Self: 0.0% (207us) | Total: 0.0% (207us) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `#finishPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (207us) | Total: 0.0% (207us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:159` | Self: 0.0% (207us) | Total: 0.0% (207us) | Samples: 1

**Called by:**
- `forEach` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:454` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `emitFinish`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `set response` (1)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5265` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `hideFromStack`
`internal:shared` | Self: 0.0% (204us) | Total: 0.0% (204us) | Samples: 1

**Called by:**
- `internal:validators` (1)

### `createDebug`
`/home/user/bun-node/node_modules/debug/src/common.js:122` | Self: 0.0% (204us) | Total: 0.0% (204us) | Samples: 1

**Called by:**
- `(module)` (1)

### `deprecate`
`internal:util/deprecate` | Self: 0.0% (204us) | Total: 0.0% (204us) | Samples: 1

**Called by:**
- `node:_http_outgoing` (1)

### `get host`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3577` | Self: 0.0% (204us) | Total: 0.0% (393us) | Samples: 1

**Called by:**
- `#routeRequest` (2)

**Calls:**
- `splitRequestUrl` (1)

### `(anonymous)`
`node:diagnostics_channel` | Self: 0.0% (204us) | Total: 0.0% (204us) | Samples: 1

**Called by:**
- `WeakRefMap` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1011` | Self: 0.0% (204us) | Total: 0.0% (204us) | Samples: 1

**Called by:**
- `registerExpressStyle` (1)

### `#produceResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:529` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `#writableOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1359` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `setResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3736` | Self: 0.0% (202us) | Total: 0.0% (202us) | Samples: 1

**Called by:**
- `BunResponse` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:858` | Self: 0.0% (201us) | Total: 0.0% (201us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `WriteStream`
`internal:fs/streams:238` | Self: 0.0% (201us) | Total: 0.0% (201us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `set params`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (201us) | Total: 0.0% (201us) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `get bodyDecodingError`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3048` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `internal:streams/readable`
`internal:streams/readable:14` | Self: 0.0% (200us) | Total: 0.0% (417us) | Samples: 1

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (1)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2501` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `node:fs/promises`
`node:fs/promises:8` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

### `get buffer`
`[native code]` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

**Called by:**
- `dv` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5066` | Self: 0.0% (198us) | Total: 0.0% (198us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1246` | Self: 0.0% (198us) | Total: 0.0% (198us) | Samples: 1

**Called by:**
- `init` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1120` | Self: 0.0% (198us) | Total: 0.0% (198us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `node:util`
`node:util:128` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1343` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `use`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4229` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

**Called by:**
- `registerExpressStyle` (1)

### `#canSkipHeaders`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:571` | Self: 0.0% (197us) | Total: 0.7% (30.1ms) | Samples: 1

**Called by:**
- `#respondWithText` (91)

**Calls:**
- `method` (90)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:151` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:247` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `internal:streams/utils`
`internal:streams/utils:180` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `get method`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `_preferredType` (1)

### `dispatch`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4987` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1117` | Self: 0.0% (194us) | Total: 0.0% (194us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `WritableState`
`internal:streams/writable` | Self: 0.0% (194us) | Total: 0.0% (194us) | Samples: 1

**Called by:**
- `Writable` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:44` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `_preferredType` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:155` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1019` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `registerExpressStyle` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5037` | Self: 0.0% (191us) | Total: 0.0% (191us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `internal:http`
`internal:http:257` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `_preferredTypeLegacy`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:202` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `forEachMimeType` (1)

### `_preferredTypeLegacy`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:198` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `forEachMimeType` (1)

### `node:diagnostics_channel`
`node:diagnostics_channel:2` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3502` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `get host` (1)

### `hasOwnProperty`
`[native code]` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `bound call` (1)

### `startInterval`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `Cache` (1)

### `_addListener`
`node:events` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `addListener` (1)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `#respondWithText` (1)

### `deprecate`
`internal:util/deprecate:30` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `node:crypto` (1)

### `init`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1433` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `call`
`[native code]` | Self: 0.0% (186us) | Total: 0.0% (186us) | Samples: 1

**Called by:**
- `bound call` (1)

### `asyncWrap`
`node:fs/promises:249` | Self: 0.0% (186us) | Total: 0.0% (186us) | Samples: 1

**Called by:**
- `node:fs/promises` (1)

### `makeSafe`
`internal:primordials` | Self: 0.0% (186us) | Total: 0.0% (186us) | Samples: 1

**Called by:**
- `internal:primordials` (1)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:700` | Self: 0.0% (186us) | Total: 0.0% (388us) | Samples: 1

**Called by:**
- `#routeRequest` (2)

**Calls:**
- `setResponse` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:24` | Self: 0.0% (185us) | Total: 0.0% (185us) | Samples: 1

**Called by:**
- `Route` (1)

### `isDisjoint`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (185us) | Total: 0.0% (185us) | Samples: 1

**Called by:**
- `candidates` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:5` | Self: 0.0% (184us) | Total: 0.0% (184us) | Samples: 1

**Called by:**
- `Cache` (1)

### `charCodeAt`
`[native code]` | Self: 0.0% (183us) | Total: 0.0% (183us) | Samples: 1

**Called by:**
- `splitRequestUrl` (1)

### `#canSkipHeaders`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:574` | Self: 0.0% (183us) | Total: 0.0% (183us) | Samples: 1

**Called by:**
- `#respondWithText` (1)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:953` | Self: 0.0% (182us) | Total: 0.0% (182us) | Samples: 1

**Called by:**
- `#respondWithText` (1)

### `node:_http_outgoing`
`node:_http_outgoing:773` | Self: 0.0% (182us) | Total: 0.0% (182us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1273` | Self: 0.0% (177us) | Total: 0.0% (177us) | Samples: 1

**Called by:**
- `init` (1)

### `makeSafe`
`internal:primordials:35` | Self: 0.0% (0us) | Total: 0.0% (186us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `bound call` (1)

### `copyProps`
`internal:primordials:26` | Self: 0.0% (0us) | Total: 0.0% (189us) | Samples: 0

**Called by:**
- `makeSafe` (1)

**Calls:**
- `bound call` (1)

### `node:_http_agent`
`node:_http_agent:2` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `anonymous` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:16` | Self: 0.0% (0us) | Total: 0.3% (15.5ms) | Samples: 0

**Calls:**
- `bound require` (50)

### `internal:stream`
`internal:stream:46` | Self: 0.0% (0us) | Total: 0.0% (226us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `bound serveNativeRequest`
`[native code]` | Self: 0.0% (0us) | Total: 0.6% (25.8ms) | Samples: 0

**Called by:**
- `(module)` (82)

**Calls:**
- `serveNativeRequest` (54)
- `serveNativeRequest` (28)

### `#canSkipHeaders`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:573` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `#respondWithText` (1)

**Calls:**
- `get #etagEnabled` (1)

### `node:zlib`
`node:zlib:553` | Self: 0.0% (0us) | Total: 0.0% (214us) | Samples: 0

**Calls:**
- `defineProperty` (1)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:970` | Self: 0.0% (0us) | Total: 0.0% (2.7ms) | Samples: 0

**Called by:**
- `#respondWithText` (7)

**Calls:**
- `emitFinish` (6)
- `emitFinish` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:30` | Self: 0.0% (0us) | Total: 0.0% (300us) | Samples: 0

**Called by:**
- `Mime` (1)

**Calls:**
- `__classPrivateFieldGet` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:17` | Self: 0.0% (0us) | Total: 0.0% (382us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `channel`
`node:diagnostics_channel:141` | Self: 0.0% (0us) | Total: 0.0% (224us) | Samples: 0

**Called by:**
- `node:_http_client` (1)

**Calls:**
- `Channel` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:224` | Self: 0.0% (0us) | Total: 0.0% (3.8ms) | Samples: 0

**Called by:**
- `#compileRouteRegExp` (1)
- `#compileMiddlewareRegExp` (1)

**Calls:**
- `replace` (2)

### `#compileMiddlewareRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:209` | Self: 0.0% (0us) | Total: 0.0% (3.6ms) | Samples: 0

**Called by:**
- `Route` (1)

**Calls:**
- `pathRegex` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:242` | Self: 0.0% (0us) | Total: 0.0% (3.8ms) | Samples: 0

**Called by:**
- `#compileRouteRegExp` (19)

**Calls:**
- `RegExp` (19)

### `#configuredQueryOpts`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1368` | Self: 0.0% (0us) | Total: 0.0% (187us) | Samples: 0

**Called by:**
- `parseQuery` (1)

**Calls:**
- `isObject` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:57` | Self: 0.0% (0us) | Total: 0.6% (29.0ms) | Samples: 0

**Called by:**
- `setRoute` (76)

**Calls:**
- `#compileRouteRegExp` (73)
- `#compileRouteRegExp` (3)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5260` | Self: 0.0% (0us) | Total: 0.0% (424us) | Samples: 0

**Called by:**
- `#runPipeline` (2)

**Calls:**
- `get headersSent` (1)
- `get headersSent` (1)

### `node:crypto`
`node:crypto:2` | Self: 0.0% (0us) | Total: 0.0% (2.7ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:6` | Self: 0.0% (0us) | Total: 0.0% (3.6ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:5` | Self: 0.0% (0us) | Total: 0.1% (4.8ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `node:tty`
`node:tty:7` | Self: 0.0% (0us) | Total: 0.0% (346us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (3.9ms) | Samples: 0

**Called by:**
- `anonymous` (17)

**Calls:**
- `bound require` (17)

### `#build`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:185` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `candidates` (4)

**Calls:**
- `map` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-types/index.js:15` | Self: 0.0% (0us) | Total: 0.2% (11.6ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `#configuredCookieSecrets`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1405` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `BunRequest` (1)

**Calls:**
- `get legacyCookieOptions` (1)

### `(module)`
`/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:12` | Self: 0.0% (0us) | Total: 0.0% (199us) | Samples: 0

**Calls:**
- `signatureToArray` (1)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:216` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `getMatchedLayers` (4)

**Calls:**
- `#build` (4)

### `originalUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` | Self: 0.0% (0us) | Total: 1.0% (43.6ms) | Samples: 0

**Called by:**
- `#routeRequest` (130)

**Calls:**
- `splitRequestUrl` (130)

### `node:zlib`
`node:zlib:456` | Self: 0.0% (0us) | Total: 0.0% (311us) | Samples: 0

**Calls:**
- `map` (1)

### `node:path`
`node:path:2` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `anonymous` (8)
- `@lazy` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/node_modules/mime-db/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (3.5ms) | Samples: 0

**Called by:**
- `anonymous` (15)

**Calls:**
- `bound require` (15)

### `node:_http_outgoing`
`node:_http_outgoing:2` | Self: 0.0% (0us) | Total: 0.0% (200us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `node:_http_incoming`
`node:_http_incoming:160` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `defineProperty` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:27` | Self: 0.0% (0us) | Total: 0.0% (422us) | Samples: 0

**Called by:**
- `setRoute` (2)

**Calls:**
- `isArray` (2)

### `(module)`
`/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Calls:**
- `from` (2)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:457` | Self: 0.0% (0us) | Total: 0.0% (850us) | Samples: 0

**Calls:**
- `parse` (2)
- `parse` (1)

### `node:util`
`node:util:2` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `internal:validators`
`internal:validators:67` | Self: 0.0% (0us) | Total: 0.0% (204us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `hideFromStack` (1)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:218` | Self: 0.0% (0us) | Total: 0.0% (3.7ms) | Samples: 0

**Called by:**
- `getMatchedLayers` (2)

**Calls:**
- `splitPattern` (1)
- `splitRequestPath` (1)

### `internal:stream`
`internal:stream:2` | Self: 0.0% (0us) | Total: 0.1% (4.4ms) | Samples: 0

**Called by:**
- `anonymous` (21)

**Calls:**
- `anonymous` (21)

### `WeakRefMap`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (204us) | Samples: 0

**Called by:**
- `node:diagnostics_channel` (1)

**Calls:**
- `(anonymous)` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:188` | Self: 0.0% (0us) | Total: 0.0% (628us) | Samples: 0

**Calls:**
- `bound join` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/content-type/dist/index.js:30` | Self: 0.0% (0us) | Total: 0.0% (209us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `makeSafe`
`internal:primordials:37` | Self: 0.0% (0us) | Total: 0.0% (190us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `getOwnPropertyDescriptor` (1)

### `node:_http_agent`
`node:_http_agent:294` | Self: 0.0% (0us) | Total: 0.0% (213us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `shouldUseEnvProxy` (1)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:237` | Self: 0.0% (0us) | Total: 0.0% (185us) | Samples: 0

**Called by:**
- `getMatchedLayers` (1)

**Calls:**
- `isDisjoint` (1)

### `lazyInspectModule`
`node:util:17` | Self: 0.0% (0us) | Total: 0.6% (26.7ms) | Samples: 0

**Called by:**
- `get inspect` (13)

**Calls:**
- `anonymous` (13)

### `internal:primordials`
`internal:primordials:54` | Self: 0.0% (0us) | Total: 0.0% (409us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `createSafeIterator` (2)

### `node:_http_incoming`
`node:_http_incoming:15` | Self: 0.0% (0us) | Total: 0.1% (6.2ms) | Samples: 0

**Called by:**
- `anonymous` (29)

**Calls:**
- `anonymous` (29)

### `node:vm`
`node:vm:12` | Self: 0.0% (0us) | Total: 0.0% (3.2ms) | Samples: 0

**Calls:**
- `@lazy` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:66` | Self: 0.0% (0us) | Total: 0.0% (222us) | Samples: 0

**Called by:**
- `Route` (1)

**Calls:**
- `LinkedList` (1)

### `node:_http_agent`
`node:_http_agent:290` | Self: 0.0% (0us) | Total: 0.0% (402us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `Agent` (1)
- `Agent` (1)

### `node:fs/promises`
`node:fs/promises:153` | Self: 0.0% (0us) | Total: 0.0% (186us) | Samples: 0

**Calls:**
- `asyncWrap` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:79` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `async makeTarget` (6)

**Calls:**
- `importModule` (6)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:13` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Calls:**
- `async makeTarget` (7)
- `async makeTarget` (1)

### `internal:validators`
`internal:validators:2` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `anonymous` (6)

### `dv`
`/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/lib/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (199us) | Samples: 0

**Called by:**
- `put` (1)

**Calls:**
- `get buffer` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/index.js:3` | Self: 0.0% (0us) | Total: 0.0% (2.7ms) | Samples: 0

**Calls:**
- `bound require` (2)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:58` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Called by:**
- `#compileRouteRegExp` (1)

**Calls:**
- `push` (1)

### `enable`
`/home/user/bun-node/node_modules/debug/src/common.js:171` | Self: 0.0% (0us) | Total: 0.0% (214us) | Samples: 0

**Called by:**
- `setup` (1)

**Calls:**
- `replace` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/accepts/index.js:16` | Self: 0.0% (0us) | Total: 0.4% (18.6ms) | Samples: 0

**Calls:**
- `bound require` (36)

### `flushPending`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4223` | Self: 0.0% (0us) | Total: 0.0% (4.0ms) | Samples: 0

**Called by:**
- `use` (3)

**Calls:**
- `setRoute` (3)

### `internal:errors`
`internal:errors:2` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `anonymous` (9)

### `addRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1257` | Self: 0.0% (0us) | Total: 0.0% (206us) | Samples: 0

**Called by:**
- `registerExpressStyle` (1)

**Calls:**
- `toUpperCase` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:32` | Self: 0.0% (0us) | Total: 0.2% (9.5ms) | Samples: 0

**Called by:**
- `anonymous` (10)

**Calls:**
- `bound require` (10)

### `(module)`
`/home/user/bun-node/node_modules/mime/dist/src/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Calls:**
- `Mime` (6)
- `_freeze` (1)
- `Mime` (1)

### `node:crypto`
`node:crypto:190` | Self: 0.0% (0us) | Total: 0.0% (187us) | Samples: 0

**Calls:**
- `deprecate` (1)

### `node:crypto`
`node:crypto:103` | Self: 0.0% (0us) | Total: 0.0% (215us) | Samples: 0

**Calls:**
- `defineCustomPromisifyArgs` (1)

### `node:fs/promises`
`node:fs/promises:2` | Self: 0.0% (0us) | Total: 0.0% (3.2ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1256` | Self: 0.0% (0us) | Total: 1.3% (58.0ms) | Samples: 0

**Called by:**
- `init` (163)

**Calls:**
- `#writableOptions` (162)
- `#writableOptions` (1)

### `internal:util/inspect`
`internal:util/inspect:9` | Self: 0.0% (0us) | Total: 0.0% (4.1ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `uncurryThis` (2)

### `signatureToArray`
`/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:6` | Self: 0.0% (0us) | Total: 0.0% (199us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `put` (1)

### `Mime`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:13` | Self: 0.0% (0us) | Total: 0.0% (2.6ms) | Samples: 0

**Called by:**
- `(module)` (6)

**Calls:**
- `define` (2)
- `define` (1)
- `define` (1)
- `define` (1)
- `define` (1)

### `Agent`
`node:_http_agent:10` | Self: 0.0% (0us) | Total: 0.0% (215us) | Samples: 0

**Called by:**
- `node:_http_agent` (1)

**Calls:**
- `EventEmitter` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4793` | Self: 0.0% (0us) | Total: 0.1% (5.8ms) | Samples: 0

**Called by:**
- `dispatch` (8)

**Calls:**
- `candidates` (4)
- `candidates` (2)
- `candidates` (1)
- `candidates` (1)

### `internal:primordials`
`internal:primordials:83` | Self: 0.0% (0us) | Total: 0.0% (186us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `makeSafe` (1)

### `put`
`/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/lib/index.js:87` | Self: 0.0% (0us) | Total: 0.0% (199us) | Samples: 0

**Called by:**
- `signatureToArray` (1)

**Calls:**
- `dv` (1)

### `bound call`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (4.6ms) | Samples: 0

**Called by:**
- `internal:util/inspect` (3)
- `copyProps` (1)
- `makeSafe` (1)

**Calls:**
- `filter` (3)
- `call` (1)
- `hasOwnProperty` (1)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:86` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `map` (3)

**Calls:**
- `map` (3)

### `get inspect`
`node:util:481` | Self: 0.0% (0us) | Total: 0.6% (26.7ms) | Samples: 0

**Calls:**
- `lazyInspectModule` (13)

### `internal:http/FakeSocket`
`internal:http/FakeSocket:2` | Self: 0.0% (0us) | Total: 0.1% (5.9ms) | Samples: 0

**Called by:**
- `anonymous` (28)

**Calls:**
- `anonymous` (28)

### `node:_http_client`
`node:_http_client:10` | Self: 0.0% (0us) | Total: 0.4% (20.6ms) | Samples: 0

**Called by:**
- `anonymous` (91)

**Calls:**
- `anonymous` (90)
- `channel` (1)

### `send`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1396` | Self: 0.0% (0us) | Total: 0.0% (376us) | Samples: 0

**Called by:**
- `#runPipeline` (1)

**Calls:**
- `get headersSent` (1)

### `bound require`
`[native code]` | Self: 0.0% (0us) | Total: 2.7% (115.7ms) | Samples: 0

**Called by:**
- `(anonymous)` (50)
- `(anonymous)` (36)
- `(anonymous)` (24)
- `(anonymous)` (17)
- `(anonymous)` (15)
- `(anonymous)` (11)
- `(anonymous)` (10)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (4)
- `(anonymous)` (4)
- `(anonymous)` (3)
- `setup` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `require` (185)
- `anonymous` (14)

### `(anonymous)`
`/home/user/bun-node/node_modules/supports-color/index.js:10` | Self: 0.0% (0us) | Total: 0.0% (300us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:67` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `Route` (1)

**Calls:**
- `Map` (1)

### `internal:streams/pipeline`
`internal:streams/pipeline:2` | Self: 0.0% (0us) | Total: 0.0% (2.9ms) | Samples: 0

**Called by:**
- `anonymous` (14)

**Calls:**
- `anonymous` (14)

### `internal:streams/destroy`
`internal:streams/destroy:2` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `anonymous` (9)

### `registerExpressStyle`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:170` | Self: 0.0% (0us) | Total: 0.0% (197us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `use` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-types/index.js:40` | Self: 0.0% (0us) | Total: 0.1% (4.6ms) | Samples: 0

**Called by:**
- `anonymous` (18)

**Calls:**
- `populateMaps` (18)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:37` | Self: 0.0% (0us) | Total: 0.0% (431us) | Samples: 0

**Called by:**
- `setRoute` (1)

**Calls:**
- `toUpperCase` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:174` | Self: 0.0% (0us) | Total: 0.0% (3.2ms) | Samples: 0

**Called by:**
- `forEach` (5)

**Calls:**
- `_preferredTypeLegacy` (3)
- `_preferredTypeLegacy` (1)
- `_preferredTypeLegacy` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:70` | Self: 0.0% (0us) | Total: 0.0% (189us) | Samples: 0

**Called by:**
- `Route` (1)

**Calls:**
- `startInterval` (1)

### `internal:util/inspect`
`internal:util/inspect:46` | Self: 0.0% (0us) | Total: 0.0% (4.2ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound call` (3)

### `parse`
`/home/user/bun-node/node_modules/picoquery/lib/parse.js:42` | Self: 0.0% (0us) | Total: 0.0% (426us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `Empty` (1)

### `node:http`
`node:http:2` | Self: 0.0% (0us) | Total: 0.6% (28.1ms) | Samples: 0

**Calls:**
- `anonymous` (117)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:42` | Self: 0.0% (0us) | Total: 0.2% (10.4ms) | Samples: 0

**Called by:**
- `anonymous` (28)

**Calls:**
- `populateMaps` (28)

### `registerExpressStyle`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:172` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `get` (1)

### `node:crypto`
`node:crypto:39` | Self: 0.0% (0us) | Total: 0.0% (408us) | Samples: 0

**Calls:**
- `@lazy` (2)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5134` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `#routeRequest` (6)

**Calls:**
- `#settleLayer` (2)
- `#settleLayer` (2)
- `#settleLayer` (1)
- `#settleLayer` (1)

### `internal:stream`
`internal:stream:48` | Self: 0.0% (0us) | Total: 0.0% (461us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (2)

### `node:zlib`
`node:zlib:485` | Self: 0.0% (0us) | Total: 0.0% (671us) | Samples: 0

**Calls:**
- `createConvenienceMethod` (1)

### `node:zlib`
`node:zlib:449` | Self: 0.0% (0us) | Total: 0.0% (415us) | Samples: 0

**Calls:**
- `map` (2)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3512` | Self: 0.0% (0us) | Total: 0.0% (183us) | Samples: 0

**Called by:**
- `parseQuery` (1)

**Calls:**
- `charCodeAt` (1)

### `_preferredType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:189` | Self: 0.0% (0us) | Total: 0.0% (3.0ms) | Samples: 0

**Called by:**
- `forEachMimeType` (12)

**Calls:**
- `mimeScore` (7)
- `mimeScore` (2)
- `mimeScore` (1)
- `mimeScore` (1)
- `mimeScore` (1)

### `WritableState`
`internal:streams/writable:152` | Self: 0.0% (0us) | Total: 0.0% (209us) | Samples: 0

**Called by:**
- `Writable` (1)

**Calls:**
- `resetBuffer` (1)

### `internal:streams/readable`
`internal:streams/readable:2` | Self: 0.0% (0us) | Total: 0.1% (5.6ms) | Samples: 0

**Called by:**
- `anonymous` (21)

**Calls:**
- `anonymous` (21)

### `layerFinished`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:598` | Self: 0.0% (0us) | Total: 0.0% (262us) | Samples: 0

**Called by:**
- `#runPipeline` (1)

**Calls:**
- `get headersSent` (1)

### `WriteStream`
`internal:fs/streams:259` | Self: 0.0% (0us) | Total: 0.0% (611us) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `Writable` (2)
- `Writable` (1)

### `internal:stream`
`internal:stream:47` | Self: 0.0% (0us) | Total: 0.0% (230us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `node:diagnostics_channel`
`node:diagnostics_channel:134` | Self: 0.0% (0us) | Total: 0.0% (204us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `WeakRefMap` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:84` | Self: 0.0% (0us) | Total: 0.0% (2.2ms) | Samples: 0

**Called by:**
- `setRoute` (11)

**Calls:**
- `Cache` (6)
- `Cache` (1)
- `Cache` (1)
- `Cache` (1)
- `Cache` (1)
- `Cache` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:240` | Self: 0.0% (0us) | Total: 0.1% (4.4ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `setup` (3)
- `bound require` (2)
- `setup` (2)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4782` | Self: 0.0% (0us) | Total: 2.8% (120.8ms) | Samples: 0

**Called by:**
- `dispatch` (294)

**Calls:**
- `get` (291)
- `get` (3)

### `node:fs`
`node:fs:702` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Calls:**
- `setName` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1031` | Self: 0.0% (0us) | Total: 0.8% (37.9ms) | Samples: 0

**Called by:**
- `registerExpressStyle` (98)
- `flushPending` (3)
- `registerExpressStyle` (1)

**Calls:**
- `Route` (76)
- `Route` (11)
- `Route` (8)
- `Route` (3)
- `Route` (2)
- `Route` (1)
- `Route` (1)

### `populateMaps`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:155` | Self: 0.0% (0us) | Total: 0.2% (10.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (28)

**Calls:**
- `forEach` (27)
- `keys` (1)

### `(module)`
`/home/user/bun-node/node_modules/uint8array-extras/index.js:178` | Self: 0.0% (0us) | Total: 0.0% (407us) | Samples: 0

**Calls:**
- `from` (2)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:54` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `(module)` (7)

**Calls:**
- `async makeTarget` (6)
- `async makeTarget` (1)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:84` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `splitPattern` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/index.js:9` | Self: 0.0% (0us) | Total: 0.5% (23.3ms) | Samples: 0

**Calls:**
- `bound require` (24)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:233` | Self: 0.0% (0us) | Total: 0.0% (384us) | Samples: 0

**Called by:**
- `#compileRouteRegExp` (2)

**Calls:**
- `replace` (2)

### `node:zlib`
`node:zlib:300` | Self: 0.0% (0us) | Total: 0.0% (192us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `createDebug`
`/home/user/bun-node/node_modules/debug/src/common.js:117` | Self: 0.0% (0us) | Total: 0.1% (4.3ms) | Samples: 0

**Called by:**
- `(module)` (9)

**Calls:**
- `useColors` (8)
- `useColors` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1076` | Self: 0.0% (0us) | Total: 0.0% (415us) | Samples: 0

**Called by:**
- `registerExpressStyle` (2)

**Calls:**
- `get size` (2)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:19` | Self: 0.0% (0us) | Total: 0.0% (327us) | Samples: 0

**Called by:**
- `Mime` (1)

**Calls:**
- `map` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5129` | Self: 0.0% (0us) | Total: 0.0% (723us) | Samples: 0

**Called by:**
- `#routeRequest` (3)

**Calls:**
- `layerFinished` (2)
- `layerFinished` (1)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` | Self: 0.0% (0us) | Total: 0.0% (237us) | Samples: 0

**Called by:**
- `#finishAbsentBody` (1)

**Calls:**
- `splitRequestUrl` (1)

### `internal:streams/add-abort-signal`
`internal:streams/add-abort-signal:2` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `anonymous` (5)

### `internal:streams/duplex`
`internal:streams/duplex:52` | Self: 0.0% (0us) | Total: 0.0% (219us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `getOwnPropertyDescriptor` (1)

### `internal:http`
`internal:http:7` | Self: 0.0% (0us) | Total: 0.0% (230us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2511` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `BunRequest` (1)

**Calls:**
- `isObject` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4805` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Called by:**
- `dispatch` (1)

**Calls:**
- `matchRoute` (1)

### `bound join`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (628us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `join` (1)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1698` | Self: 0.0% (0us) | Total: 0.0% (408us) | Samples: 0

**Called by:**
- `registerExpressStyle` (2)

**Calls:**
- `isString` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-db/index.js:12` | Self: 0.0% (0us) | Total: 0.2% (11.6ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1239` | Self: 0.0% (0us) | Total: 0.0% (439us) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `isBoolean` (1)

### `node:_http_incoming`
`node:_http_incoming:2` | Self: 0.0% (0us) | Total: 0.1% (8.1ms) | Samples: 0

**Called by:**
- `anonymous` (33)

**Calls:**
- `anonymous` (33)

### `node:_http_outgoing`
`node:_http_outgoing:700` | Self: 0.0% (0us) | Total: 0.0% (204us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `deprecate` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:2953` | Self: 0.0% (0us) | Total: 0.1% (4.4ms) | Samples: 0

**Calls:**
- `setPrototypeDirectOrThrow` (1)

### `internal:primordials`
`internal:primordials:76` | Self: 0.0% (0us) | Total: 0.0% (565us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `makeSafe` (1)
- `makeSafe` (1)
- `makeSafe` (1)

### `makeSafe`
`internal:primordials:53` | Self: 0.0% (0us) | Total: 0.0% (189us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `copyProps` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:124` | Self: 0.0% (0us) | Total: 0.0% (274us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `filter` (1)

### `setup`
`/home/user/bun-node/node_modules/debug/src/common.js:14` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `bound require` (3)

### `Agent`
`node:_http_agent:22` | Self: 0.0% (0us) | Total: 0.0% (187us) | Samples: 0

**Called by:**
- `node:_http_agent` (1)

**Calls:**
- `addListener` (1)

### `Writable`
`internal:streams/writable:181` | Self: 0.0% (0us) | Total: 0.0% (403us) | Samples: 0

**Called by:**
- `WriteStream` (2)

**Calls:**
- `WritableState` (1)
- `WritableState` (1)

### `node:_http_outgoing`
`node:_http_outgoing:45` | Self: 0.0% (0us) | Total: 0.0% (190us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `slice` (1)

### `internal:streams/compose`
`internal:streams/compose:2` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Called by:**
- `anonymous` (16)

**Calls:**
- `anonymous` (16)

### `(module)`
`/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:9` | Self: 0.0% (0us) | Total: 0.1% (4.5ms) | Samples: 0

**Calls:**
- `createDebug` (9)
- `createDebug` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:59` | Self: 0.0% (0us) | Total: 0.0% (3.6ms) | Samples: 0

**Called by:**
- `setRoute` (1)

**Calls:**
- `#compileMiddlewareRegExp` (1)

### `registerExpressStyle`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:173` | Self: 0.0% (0us) | Total: 0.0% (215us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `setRoute` (1)

### `setup`
`/home/user/bun-node/node_modules/debug/src/common.js:287` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `enable` (1)
- `enable` (1)

### `use`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4238` | Self: 0.0% (0us) | Total: 0.0% (4.0ms) | Samples: 0

**Called by:**
- `registerExpressStyle` (3)

**Calls:**
- `flushPending` (3)

### `registerExpressStyle`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:169` | Self: 0.0% (0us) | Total: 0.0% (4.0ms) | Samples: 0

**Called by:**
- `async makeTarget` (3)

**Calls:**
- `use` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/supports-color/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (282us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `node:events`
`node:events:10` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:442` | Self: 0.0% (0us) | Total: 0.0% (788us) | Samples: 0

**Called by:**
- `serveNativeRequest` (4)

**Calls:**
- `get host` (2)
- `host` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/supports-color/index.js:133` | Self: 0.0% (0us) | Total: 0.0% (300us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `supportsColor` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-types/index.js:16` | Self: 0.0% (0us) | Total: 0.0% (2.3ms) | Samples: 0

**Called by:**
- `anonymous` (11)

**Calls:**
- `bound require` (11)

### `addListener`
`node:events:214` | Self: 0.0% (0us) | Total: 0.0% (187us) | Samples: 0

**Called by:**
- `Agent` (1)

**Calls:**
- `_addListener` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:17` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Calls:**
- `bound require` (4)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:84` | Self: 0.0% (0us) | Total: 0.9% (42.0ms) | Samples: 0

**Calls:**
- `registerExpressStyle` (116)
- `registerExpressStyle` (3)
- `registerExpressStyle` (1)
- `registerExpressStyle` (1)
- `registerExpressStyle` (1)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 40.2% | 1.71s | `[native code]` |
| 34.2% | 1.45s | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 9.8% | 419.4ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 6.6% | 282.4ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 2.9% | 126.0ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 2.4% | 104.8ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.6% | 26.1ms | `/home/user/bun-node/node_modules/debug/src/index.js` |
| 0.5% | 23.4ms | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs` |
| 0.3% | 15.4ms | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts` |
| 0.2% | 12.5ms | `node:zlib` |
| 0.2% | 9.3ms | `node:fs` |
| 0.1% | 7.1ms | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` |
| 0.1% | 5.8ms | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts` |
| 0.1% | 4.7ms | `internal:primordials` |
| 0.0% | 3.9ms | `/home/user/bun-node/node_modules/mime-types/index.js` |
| 0.0% | 3.8ms | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 3.4ms | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 3.4ms | `node:stream/web` |
| 0.0% | 3.0ms | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 3.0ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 2.7ms | `/home/user/bun-node/node_modules/debug/src/common.js` |
| 0.0% | 2.6ms | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 2.1ms | `/home/user/bun-node/node_modules/type-is/index.js` |
| 0.0% | 1.9ms | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js` |
| 0.0% | 1.7ms | `internal:promisify` |
| 0.0% | 1.7ms | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 1.0ms | `internal:http` |
| 0.0% | 1.0ms | `internal:streams/writable` |
| 0.0% | 850us | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 630us | `internal:fs/streams` |
| 0.0% | 620us | `node:events` |
| 0.0% | 617us | `node:diagnostics_channel` |
| 0.0% | 424us | `internal:shared` |
| 0.0% | 411us | `internal:streams/readable` |
| 0.0% | 401us | `node:_http_outgoing` |
| 0.0% | 391us | `internal:util/deprecate` |
| 0.0% | 385us | `node:fs/promises` |
| 0.0% | 317us | `/home/user/bun-node/node_modules/mime/dist/types/standard.js` |
| 0.0% | 312us | `internal:util/inspect` |
| 0.0% | 300us | `/home/user/bun-node/node_modules/has-flag/index.js` |
| 0.0% | 300us | `/home/user/bun-node/node_modules/supports-color/index.js` |
| 0.0% | 299us | `node:_http_server` |
| 0.0% | 290us | `/home/user/bun-node/node_modules/mime/dist/types/other.js` |
| 0.0% | 278us | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js` |
| 0.0% | 257us | `internal:stream` |
| 0.0% | 241us | `internal:streams/duplex` |
| 0.0% | 226us | `internal:streams/duplexpair` |
| 0.0% | 223us | `node:_http_common` |
| 0.0% | 217us | `internal:streams/destroy` |
| 0.0% | 213us | `node:_http_agent` |
| 0.0% | 210us | `node:_http_client` |
| 0.0% | 209us | `/home/user/bun-node/node_modules/content-type/dist/index.js` |
| 0.0% | 197us | `node:util` |
| 0.0% | 196us | `internal:streams/utils` |
