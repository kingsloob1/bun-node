# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 4.90s | 12539 | 100us | 2103 |

**Top 10:** `Response` 8.1%, `anonymous` 7.3%, `Request` 5.3%, `async middlewareHandler` 3.1%, `get` 2.6%, `(anonymous)` 2.2%, `BunRequest` 2.1%, `#routeRequest` 1.6%, `#runPipeline` 1.6%, `asyncFunctionDrive` 1.6%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 8.1% | 401.1ms | 8.1% | 401.1ms | `Response` | `[native code]` |
| 7.3% | 358.7ms | 32.7% | 1.60s | `anonymous` | `[native code]` |
| 5.3% | 264.3ms | 5.3% | 264.3ms | `Request` | `[native code]` |
| 3.1% | 153.6ms | 10.4% | 509.7ms | `async middlewareHandler` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:823` |
| 2.6% | 128.0ms | 2.6% | 128.0ms | `get` | `[native code]` |
| 2.2% | 108.6ms | 2.2% | 108.6ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:696` |
| 2.1% | 105.3ms | 2.1% | 105.3ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1231` |
| 1.6% | 82.6ms | 20.8% | 1.02s | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:428` |
| 1.6% | 82.0ms | 1.6% | 82.0ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5006` |
| 1.6% | 81.7ms | 1.6% | 81.7ms | `asyncFunctionDrive` | `[native code]` |
| 1.5% | 73.6ms | 1.5% | 77.5ms | `async transformToResult` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:32` |
| 1.4% | 70.9ms | 1.4% | 70.9ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3541` |
| 1.4% | 69.9ms | 9.0% | 445.4ms | `Promise` | `[native code]` |
| 1.3% | 68.4ms | 1.3% | 68.4ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 1.3% | 67.3ms | 1.3% | 67.3ms | `onceResponded` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2024` |
| 1.3% | 65.4ms | 7.0% | 346.2ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js:7` |
| 1.3% | 63.7ms | 1.3% | 64.3ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` |
| 1.2% | 61.9ms | 1.2% | 61.9ms | `createNullArray` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:27` |
| 1.2% | 59.9ms | 1.2% | 59.9ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1213` |
| 1.1% | 57.7ms | 1.1% | 57.7ms | `#watchLateRejection` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5197` |
| 1.0% | 53.7ms | 1.0% | 53.7ms | `method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 1.0% | 53.5ms | 1.0% | 53.5ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:623` |
| 1.0% | 50.7ms | 1.0% | 50.7ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3506` |
| 1.0% | 50.6ms | 1.0% | 50.6ms | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:281` |
| 1.0% | 49.7ms | 1.0% | 49.7ms | `alloc` | `[native code]` |
| 1.0% | 49.5ms | 6.5% | 322.5ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3349` |
| 0.9% | 48.2ms | 2.4% | 117.8ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:410` |
| 0.9% | 46.6ms | 0.9% | 46.6ms | `async #parseBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3118` |
| 0.9% | 46.0ms | 0.9% | 47.5ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:177` |
| 0.9% | 45.7ms | 2.0% | 101.0ms | `async #parseBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3112` |
| 0.9% | 44.8ms | 0.9% | 46.4ms | `(anonymous)` | `[native code]` |
| 0.8% | 43.1ms | 0.8% | 43.1ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.8% | 42.9ms | 0.8% | 43.5ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4470` |
| 0.8% | 42.1ms | 0.8% | 42.1ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2029` |
| 0.7% | 38.3ms | 0.7% | 38.3ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.7% | 35.2ms | 0.7% | 35.2ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:676` |
| 0.6% | 33.3ms | 0.6% | 33.3ms | `isStreamOpen` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1624` |
| 0.6% | 33.0ms | 0.6% | 33.0ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3520` |
| 0.6% | 32.6ms | 0.6% | 32.6ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4777` |
| 0.6% | 32.2ms | 0.6% | 32.2ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5154` |
| 0.6% | 31.2ms | 0.6% | 31.2ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3507` |
| 0.6% | 30.6ms | 0.6% | 30.6ms | `async intercept` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js:10` |
| 0.6% | 30.2ms | 0.6% | 30.2ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3416` |
| 0.6% | 29.5ms | 0.6% | 29.5ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.5% | 29.0ms | 0.5% | 29.0ms | `async intercept` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js` |
| 0.5% | 28.8ms | 0.5% | 28.8ms | `#waitLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5151` |
| 0.5% | 28.5ms | 2.6% | 130.8ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:181` |
| 0.5% | 28.4ms | 0.5% | 28.4ms | `setPrototypeDirectOrThrow` | `[native code]` |
| 0.5% | 26.5ms | 2.1% | 106.8ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1306` |
| 0.5% | 26.2ms | 0.6% | 30.1ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` |
| 0.5% | 24.7ms | 7.1% | 351.2ms | `waitForLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:673` |
| 0.4% | 23.2ms | 0.4% | 23.2ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:38` |
| 0.4% | 22.5ms | 1.1% | 55.5ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:36` |
| 0.4% | 22.3ms | 0.4% | 22.5ms | `applyCallbackToRouter` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:73` |
| 0.4% | 22.3ms | 5.4% | 268.9ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:40` |
| 0.4% | 22.1ms | 0.4% | 22.1ms | `cloneObject` | `[native code]` |
| 0.4% | 21.8ms | 0.4% | 21.8ms | `async intercept` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js:11` |
| 0.4% | 20.6ms | 2.8% | 139.1ms | `awaitPipelineOrStream` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:620` |
| 0.4% | 20.4ms | 0.4% | 21.6ms | `parseContentCodings` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:3668` |
| 0.4% | 20.4ms | 0.4% | 20.4ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5009` |
| 0.4% | 20.3ms | 3.9% | 194.7ms | `async #awaitPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:441` |
| 0.4% | 19.6ms | 0.4% | 19.6ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3351` |
| 0.3% | 19.3ms | 0.3% | 19.3ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3511` |
| 0.3% | 18.2ms | 0.3% | 18.2ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3042` |
| 0.3% | 17.0ms | 0.3% | 17.0ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1335` |
| 0.3% | 16.7ms | 1.0% | 53.3ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3040` |
| 0.3% | 16.6ms | 0.3% | 16.6ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3353` |
| 0.3% | 16.3ms | 0.3% | 16.3ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` |
| 0.3% | 15.6ms | 0.3% | 15.6ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3540` |
| 0.3% | 15.6ms | 0.6% | 30.5ms | `reduce` | `[native code]` |
| 0.3% | 14.8ms | 0.3% | 14.8ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4471` |
| 0.2% | 12.9ms | 0.2% | 12.9ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:713` |
| 0.2% | 12.6ms | 1.1% | 57.6ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3392` |
| 0.2% | 12.5ms | 0.2% | 12.5ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5072` |
| 0.2% | 12.4ms | 0.2% | 12.4ms | `getMetadataKey` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:20` |
| 0.2% | 12.3ms | 0.2% | 12.3ms | `DateTimeFormat` | `[native code]` |
| 0.2% | 12.2ms | 0.2% | 12.2ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4988` |
| 0.2% | 12.0ms | 3.3% | 164.7ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4984` |
| 0.2% | 11.1ms | 1.4% | 73.1ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:41` |
| 0.2% | 11.1ms | 3.2% | 159.1ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:46` |
| 0.2% | 11.1ms | 0.2% | 11.9ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1261` |
| 0.2% | 10.5ms | 28.7% | 1.40s | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:377` |
| 0.2% | 10.4ms | 1.8% | 89.2ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:182` |
| 0.2% | 10.3ms | 0.2% | 10.3ms | `handler` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:36` |
| 0.2% | 10.2ms | 0.2% | 10.2ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:621` |
| 0.1% | 9.5ms | 1.6% | 82.8ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:712` |
| 0.1% | 9.5ms | 0.1% | 9.5ms | `RegExp` | `[native code]` |
| 0.1% | 9.5ms | 0.1% | 9.5ms | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5220` |
| 0.1% | 9.4ms | 0.1% | 9.4ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:181` |
| 0.1% | 9.1ms | 5.6% | 278.3ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js:9` |
| 0.1% | 8.8ms | 1.1% | 56.2ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:694` |
| 0.1% | 8.8ms | 0.2% | 10.6ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1299` |
| 0.1% | 8.6ms | 0.1% | 8.6ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:11` |
| 0.1% | 8.6ms | 7.1% | 352.7ms | `async (anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:824` |
| 0.1% | 8.5ms | 0.1% | 8.5ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3521` |
| 0.1% | 8.4ms | 15.8% | 777.3ms | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1432` |
| 0.1% | 8.0ms | 0.1% | 8.0ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:395` |
| 0.1% | 7.9ms | 0.1% | 7.9ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3533` |
| 0.1% | 7.9ms | 7.3% | 360.0ms | `#waitLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5152` |
| 0.1% | 7.8ms | 0.1% | 9.4ms | `async apply` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:14` |
| 0.1% | 7.8ms | 0.1% | 7.8ms | `parseContentCodings` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:3669` |
| 0.1% | 7.7ms | 9.5% | 466.8ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1214` |
| 0.1% | 7.6ms | 0.1% | 7.6ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1336` |
| 0.1% | 7.6ms | 0.1% | 9.7ms | `reflectInjectables` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:161` |
| 0.1% | 7.5ms | 0.1% | 7.5ms | `OrdinaryGetMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.1% | 7.5ms | 0.1% | 8.2ms | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:33` |
| 0.1% | 7.5ms | 0.1% | 7.5ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:677` |
| 0.1% | 7.5ms | 0.1% | 7.5ms | `onceResponded` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2019` |
| 0.1% | 7.3ms | 0.1% | 7.3ms | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5314` |
| 0.1% | 7.3ms | 1.1% | 57.0ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1340` |
| 0.1% | 7.1ms | 0.8% | 41.7ms | `response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:963` |
| 0.1% | 6.4ms | 0.1% | 6.4ms | `next` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5079` |
| 0.1% | 6.2ms | 0.1% | 6.2ms | `@lazy` | `[native code]` |
| 0.1% | 6.2ms | 0.1% | 6.2ms | `GetMethod` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.1% | 5.7ms | 0.1% | 5.7ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3045` |
| 0.1% | 5.6ms | 0.1% | 5.6ms | `async #parseBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3132` |
| 0.1% | 5.5ms | 0.1% | 5.8ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2997` |
| 0.1% | 5.4ms | 0.1% | 5.4ms | `(unknown)` | `[native code]` |
| 0.1% | 5.4ms | 0.1% | 5.4ms | `async #awaitPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.1% | 5.4ms | 0.1% | 5.4ms | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:99` |
| 0.1% | 5.3ms | 0.5% | 24.9ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:720` |
| 0.1% | 5.2ms | 1.0% | 53.0ms | `map` | `[native code]` |
| 0.1% | 5.2ms | 0.1% | 5.2ms | `(anonymous)` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.1% | 5.0ms | 0.1% | 5.0ms | `get` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:49` |
| 0.0% | 4.8ms | 0.0% | 4.8ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 4.8ms | 2.9% | 144.0ms | `async #awaitPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:454` |
| 0.0% | 4.5ms | 0.0% | 4.5ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:28` |
| 0.0% | 4.4ms | 4.9% | 243.4ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1267` |
| 0.0% | 4.4ms | 0.0% | 4.6ms | `getProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:950` |
| 0.0% | 4.3ms | 0.0% | 4.3ms | `node:fs` | `node:fs:8` |
| 0.0% | 4.3ms | 0.0% | 4.3ms | `set` | `[native code]` |
| 0.0% | 4.3ms | 0.0% | 4.3ms | `indexOf` | `[native code]` |
| 0.0% | 4.2ms | 0.0% | 4.2ms | `create` | `[native code]` |
| 0.0% | 4.2ms | 30.3% | 1.48s | `require` | `[native code]` |
| 0.0% | 4.2ms | 0.0% | 4.2ms | `#initWithoutHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:581` |
| 0.0% | 4.2ms | 0.0% | 4.2ms | `node:zlib` | `node:zlib:2` |
| 0.0% | 4.2ms | 0.5% | 27.1ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1331` |
| 0.0% | 3.8ms | 0.5% | 25.6ms | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1356` |
| 0.0% | 3.7ms | 0.0% | 3.7ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:645` |
| 0.0% | 3.7ms | 0.0% | 3.7ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:625` |
| 0.0% | 3.7ms | 0.0% | 3.7ms | `isEmpty` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js` |
| 0.0% | 3.6ms | 0.0% | 3.6ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:514` |
| 0.0% | 3.6ms | 0.0% | 3.6ms | `isNil` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:46` |
| 0.0% | 3.6ms | 0.0% | 3.6ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:691` |
| 0.0% | 3.5ms | 0.0% | 3.5ms | `assign` | `[native code]` |
| 0.0% | 3.5ms | 4.6% | 226.5ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` |
| 0.0% | 3.4ms | 0.0% | 3.4ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3530` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `onceResponded` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `isObservable` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/isObservable.js:7` |
| 0.0% | 3.1ms | 0.0% | 3.1ms | `get query` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 3.0ms | 0.0% | 3.0ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:413` |
| 0.0% | 3.0ms | 0.0% | 3.2ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2991` |
| 0.0% | 3.0ms | 1.3% | 65.9ms | `async (anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:833` |
| 0.0% | 3.0ms | 0.0% | 3.0ms | `addController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:697` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `InstanceWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:18` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `async #parseBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3546` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `finish` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:678` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `reply` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 2.4ms | 0.0% | 4.6ms | `OrdinaryGetMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:595` |
| 0.0% | 2.4ms | 0.0% | 2.4ms | `hasProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `getProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 2.2ms | 0.0% | 2.2ms | `split` | `[native code]` |
| 0.0% | 2.2ms | 0.0% | 2.2ms | `push` | `[native code]` |
| 0.0% | 2.2ms | 0.0% | 2.2ms | `node:stream/web` | `node:stream/web:6` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `applySettlementSignal` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `fromContainer` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js` |
| 0.0% | 2.1ms | 0.3% | 14.8ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:628` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `defineProperty` | `[native code]` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `getStatusByMethod` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:39` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `#respond` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:482` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3029` |
| 0.0% | 1.9ms | 17.7% | 868.5ms | `forEach` | `[native code]` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `RouteController` | `[native code]` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1203` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `importModule` | `[native code]` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `ExternalExceptionFilterContext` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter-context.js` |
| 0.0% | 1.6ms | 11.3% | 558.4ms | `async apply` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:15` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `OrdinaryMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:26` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:19` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3044` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `getMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `async middlewareHandler` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 1.4ms | 0.2% | 13.7ms | `node:http` | `node:http:2` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `getOwnPropertyDescriptor` | `[native code]` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1396` |
| 0.0% | 1.4ms | 0.2% | 11.7ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5178` |
| 0.0% | 1.4ms | 2.0% | 102.7ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3420` |
| 0.0% | 1.4ms | 0.0% | 2.6ms | `createContext` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:14` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `normalizePath` | `/home/user/bun-node/node_modules/@nestjs/core/adapters/http-adapter.js` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `get` | `/home/user/bun-node/node_modules/tslib/tslib.js:210` |
| 0.0% | 1.3ms | 0.1% | 6.8ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:71` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `getMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:369` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:951` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `async loadController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:98` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:52` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `createPrototype` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:228` |
| 0.0% | 1.1ms | 0.2% | 13.8ms | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:121` |
| 0.0% | 1.1ms | 0.0% | 2.6ms | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:179` |
| 0.0% | 1.1ms | 0.1% | 8.5ms | `async callback` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:70` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `has` | `[native code]` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `OrdinaryOwnMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:247` |
| 0.0% | 1.1ms | 0.2% | 10.3ms | `from` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `async setModule` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:105` |
| 0.0% | 1.0ms | 0.0% | 1.4ms | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:43` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `async transformToResult` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:31` |
| 0.0% | 1.0ms | 30.9% | 1.51s | `bound require` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js:26` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `isDependencyTreeStatic` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:178` |
| 0.0% | 1.0ms | 0.0% | 3.5ms | `__exportStar` | `/home/user/bun-node/node_modules/tslib/tslib.js:203` |
| 0.0% | 1.0ms | 0.5% | 27.7ms | `getMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:370` |
| 0.0% | 1.0ms | 0.4% | 20.6ms | `async loadController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:97` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:159` |
| 0.0% | 1.0ms | 0.0% | 1.9ms | `getClassDependencies` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:186` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `async resolveComponentHost` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:136` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `#configuredCookieSecrets` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1407` |
| 0.0% | 1.0ms | 0.0% | 1.3ms | `replace` | `[native code]` |
| 0.0% | 993us | 0.0% | 993us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:104` |
| 0.0% | 963us | 0.0% | 963us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:171` |
| 0.0% | 961us | 0.1% | 7.0ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:73` |
| 0.0% | 955us | 0.0% | 955us | `IteratorWithOperators` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js` |
| 0.0% | 953us | 0.0% | 953us | `SettlementSignal` | `/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js` |
| 0.0% | 943us | 0.0% | 943us | `substring` | `[native code]` |
| 0.0% | 907us | 0.0% | 907us | `createResolutionContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 906us | 0.0% | 906us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 900us | 0.0% | 900us | `getPrototypeOf` | `[native code]` |
| 0.0% | 900us | 0.0% | 900us | `next` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 899us | 0.1% | 5.6ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:644` |
| 0.0% | 890us | 0.0% | 1.3ms | `OrdinaryHasOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1058` |
| 0.0% | 888us | 0.0% | 888us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:962` |
| 0.0% | 886us | 0.0% | 1.3ms | `createHandleResponseFn` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:159` |
| 0.0% | 879us | 0.0% | 879us | `get originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` |
| 0.0% | 878us | 0.0% | 878us | `getDeprecationWarningEmitter` | `internal:util/deprecate:3` |
| 0.0% | 871us | 0.0% | 871us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5013` |
| 0.0% | 868us | 0.0% | 868us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:37` |
| 0.0% | 863us | 0.0% | 2.5ms | `getProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:955` |
| 0.0% | 851us | 0.0% | 851us | `isProviderFor` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 845us | 0.0% | 845us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs` |
| 0.0% | 845us | 0.0% | 845us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js:13` |
| 0.0% | 843us | 0.0% | 843us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:155` |
| 0.0% | 835us | 0.0% | 835us | `hasOnModuleInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:13` |
| 0.0% | 807us | 0.0% | 807us | `isDependencyTreeStatic` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:186` |
| 0.0% | 803us | 0.0% | 803us | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 800us | 0.0% | 800us | `RequestMapping` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/request-mapping.decorator.js` |
| 0.0% | 797us | 0.0% | 797us | `arrayIteratorNextHelper` | `[native code]` |
| 0.0% | 795us | 0.0% | 4.8ms | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:169` |
| 0.0% | 794us | 0.0% | 794us | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 792us | 0.0% | 792us | `async resolveProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 792us | 0.0% | 792us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js:19` |
| 0.0% | 789us | 0.0% | 789us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:176` |
| 0.0% | 788us | 0.0% | 788us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js` |
| 0.0% | 788us | 0.0% | 1.1ms | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:122` |
| 0.0% | 788us | 0.0% | 3.8ms | `reflectInjectables` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:159` |
| 0.0% | 784us | 0.0% | 994us | `async loadEnhancersPerContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:456` |
| 0.0% | 782us | 0.0% | 782us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:177` |
| 0.0% | 766us | 0.0% | 4.3ms | `initialize` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:341` |
| 0.0% | 750us | 0.0% | 750us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 744us | 0.0% | 744us | `registerNotFoundHandler` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:73` |
| 0.0% | 743us | 0.0% | 743us | `(anonymous)` | `/home/user/bun-node/node_modules/tslib/tslib.js` |
| 0.0% | 735us | 0.0% | 735us | `OrdinaryGetPrototypeOf` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:847` |
| 0.0% | 732us | 0.0% | 732us | `Number` | `[native code]` |
| 0.0% | 731us | 0.0% | 731us | `get isTransient` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:43` |
| 0.0% | 719us | 0.0% | 719us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:433` |
| 0.0% | 713us | 0.0% | 713us | `performIteration` | `[native code]` |
| 0.0% | 711us | 0.0% | 711us | `dirname` | `[native code]` |
| 0.0% | 687us | 0.0% | 687us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5066` |
| 0.0% | 687us | 0.0% | 687us | `getInstanceByContextId` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.0% | 685us | 0.0% | 685us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 683us | 0.0% | 683us | `getStatusByMethod` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:42` |
| 0.0% | 666us | 0.0% | 666us | `generateUuid` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` |
| 0.0% | 662us | 0.0% | 662us | `get` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:64` |
| 0.0% | 661us | 0.0% | 661us | `GetOrCreateMetadataMap` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 648us | 0.3% | 17.4ms | `OrdinaryGetMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:597` |
| 0.0% | 645us | 0.0% | 645us | `copyDataProperties` | `[native code]` |
| 0.0% | 642us | 0.2% | 10.2ms | `OrdinaryHasOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:584` |
| 0.0% | 639us | 0.0% | 639us | `keys` | `[native code]` |
| 0.0% | 636us | 0.0% | 636us | `OrdinaryGetPrototypeOf` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:846` |
| 0.0% | 636us | 0.0% | 636us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:185` |
| 0.0% | 636us | 0.0% | 636us | `getHashes` | `[native code]` |
| 0.0% | 632us | 0.2% | 10.4ms | `copyMetadataToCallback` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:229` |
| 0.0% | 631us | 0.0% | 631us | `exchangeKeysForValues` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:101` |
| 0.0% | 627us | 0.0% | 627us | `getProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:947` |
| 0.0% | 624us | 0.0% | 624us | `::bunternal::` | `internal:validators` |
| 0.0% | 619us | 0.0% | 4.3ms | `next` | `/home/user/bun-node/node_modules/iterare/lib/filter.js:12` |
| 0.0% | 618us | 17.5% | 859.6ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5102` |
| 0.0% | 616us | 0.0% | 616us | `OrdinaryGetPrototypeOf` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:858` |
| 0.0% | 615us | 0.0% | 615us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:970` |
| 0.0% | 613us | 0.0% | 613us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 0.0% | 612us | 0.0% | 612us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:167` |
| 0.0% | 610us | 0.0% | 610us | `getProviderNoCache` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 609us | 0.0% | 609us | `stripEndSlash` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:36` |
| 0.0% | 606us | 0.0% | 1.0ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:112` |
| 0.0% | 605us | 0.0% | 605us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:44` |
| 0.0% | 603us | 15.8% | 778.7ms | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:375` |
| 0.0% | 603us | 0.0% | 1.6ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:39` |
| 0.0% | 603us | 0.0% | 603us | `get` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:17` |
| 0.0% | 601us | 0.0% | 601us | `reflectKeyMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 0.0% | 597us | 0.0% | 597us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js` |
| 0.0% | 596us | 0.0% | 596us | `Barrier` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/barrier.js:9` |
| 0.0% | 595us | 0.0% | 595us | `reply` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1150` |
| 0.0% | 594us | 0.0% | 594us | `exploreMethodMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js` |
| 0.0% | 593us | 0.0% | 593us | `internal:streams/destroy` | `internal:streams/destroy:16` |
| 0.0% | 592us | 0.0% | 774us | `complete` | `/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js:22` |
| 0.0% | 591us | 0.4% | 21.2ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:67` |
| 0.0% | 589us | 0.0% | 589us | `bind` | `[native code]` |
| 0.0% | 581us | 0.0% | 581us | `async resolveProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:345` |
| 0.0% | 580us | 0.0% | 1.7ms | `addLeadingSlash` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:25` |
| 0.0% | 579us | 0.1% | 5.3ms | `async resolveProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:344` |
| 0.0% | 576us | 0.1% | 7.1ms | `addController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:321` |
| 0.0% | 576us | 0.2% | 10.2ms | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:418` |
| 0.0% | 562us | 1.1% | 56.1ms | `async intercept` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js:12` |
| 0.0% | 554us | 0.0% | 554us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/ReplaySubject.js` |
| 0.0% | 551us | 0.0% | 551us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 549us | 0.0% | 549us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/QueueAction.js` |
| 0.0% | 549us | 0.0% | 549us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:72` |
| 0.0% | 547us | 0.0% | 738us | `reflectParamInjectables` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:175` |
| 0.0% | 546us | 0.0% | 546us | `WriteStream` | `internal:fs/streams` |
| 0.0% | 544us | 0.0% | 1.0ms | `get instance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:33` |
| 0.0% | 543us | 0.0% | 543us | `startsWith` | `[native code]` |
| 0.0% | 537us | 0.0% | 537us | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts` |
| 0.0% | 531us | 0.0% | 531us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:8` |
| 0.0% | 530us | 0.0% | 530us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:524` |
| 0.0% | 522us | 0.0% | 2.0ms | `reflectDynamicMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:147` |
| 0.0% | 520us | 0.0% | 520us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:128` |
| 0.0% | 513us | 0.0% | 513us | `hasOwnProperty` | `[native code]` |
| 0.0% | 511us | 0.4% | 22.4ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:419` |
| 0.0% | 510us | 0.0% | 724us | `get name` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:45` |
| 0.0% | 505us | 0.0% | 505us | `(module)` | `/home/user/bun-node/node_modules/token-types/lib/index.js:360` |
| 0.0% | 496us | 0.0% | 496us | `Map` | `[native code]` |
| 0.0% | 484us | 0.0% | 484us | `(anonymous)` | `/home/user/bun-node/node_modules/tslib/tslib.js:209` |
| 0.0% | 482us | 0.0% | 482us | `defineMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 482us | 0.0% | 4.0ms | `isObject` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:6` |
| 0.0% | 480us | 0.0% | 480us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/types/other.js:718` |
| 0.0% | 476us | 0.0% | 476us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2488` |
| 0.0% | 474us | 0.0% | 474us | `next` | `/home/user/bun-node/node_modules/iterare/lib/filter.js` |
| 0.0% | 472us | 0.0% | 472us | `supportsColor` | `/home/user/bun-node/node_modules/supports-color/index.js` |
| 0.0% | 468us | 0.0% | 877us | `reflectOptionalParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:226` |
| 0.0% | 465us | 0.0% | 465us | `freeze` | `[native code]` |
| 0.0% | 456us | 0.0% | 456us | `#configuredCookieSecrets` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1405` |
| 0.0% | 455us | 0.0% | 455us | `parse` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 452us | 0.4% | 21.6ms | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:42` |
| 0.0% | 452us | 0.0% | 452us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js` |
| 0.0% | 451us | 0.0% | 451us | `(anonymous)` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:18` |
| 0.0% | 451us | 0.0% | 451us | `applyPathsToRouterProxy` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 448us | 0.0% | 448us | `appendToAllIfDefined` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js` |
| 0.0% | 447us | 0.0% | 447us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js` |
| 0.0% | 446us | 0.0% | 446us | `getClassScope` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/get-class-scope.js` |
| 0.0% | 444us | 0.0% | 967us | `OrdinaryHasOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1061` |
| 0.0% | 441us | 0.0% | 441us | `getMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:366` |
| 0.0% | 433us | 0.0% | 433us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js` |
| 0.0% | 431us | 0.0% | 431us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js:20` |
| 0.0% | 431us | 0.0% | 431us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js:52` |
| 0.0% | 431us | 0.0% | 431us | `(anonymous)` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:74` |
| 0.0% | 429us | 0.0% | 429us | `applySettlementSignal` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:118` |
| 0.0% | 429us | 0.0% | 635us | `setProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:974` |
| 0.0% | 429us | 0.0% | 429us | `reflectCallbackMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:16` |
| 0.0% | 428us | 0.0% | 428us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:202` |
| 0.0% | 424us | 0.1% | 5.7ms | `createContext` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:12` |
| 0.0% | 424us | 0.0% | 424us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapScheduler.js` |
| 0.0% | 423us | 0.0% | 423us | `all` | `[native code]` |
| 0.0% | 423us | 0.0% | 423us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:165` |
| 0.0% | 422us | 0.0% | 422us | `exploreMethodMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:25` |
| 0.0% | 421us | 0.0% | 421us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:156` |
| 0.0% | 421us | 0.0% | 421us | `get` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js` |
| 0.0% | 421us | 0.0% | 421us | `ExceptionsHandler` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/exceptions-handler.js:10` |
| 0.0% | 420us | 0.0% | 420us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:49` |
| 0.0% | 420us | 0.0% | 420us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 419us | 0.0% | 419us | `createPrototype` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:224` |
| 0.0% | 419us | 0.0% | 419us | `next` | `/home/user/bun-node/node_modules/iterare/lib/flatten.js:23` |
| 0.0% | 419us | 0.0% | 419us | `get` | `/home/user/bun-node/node_modules/@nestjs/core/inspector/uuid-factory.js:16` |
| 0.0% | 418us | 0.0% | 418us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 418us | 0.0% | 418us | `async registerMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 416us | 0.0% | 416us | `applyHostFilter` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:137` |
| 0.0% | 415us | 0.0% | 415us | `async #parseBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3137` |
| 0.0% | 414us | 0.0% | 414us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:27` |
| 0.0% | 414us | 0.0% | 414us | `originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3699` |
| 0.0% | 413us | 0.0% | 413us | `iterate` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js` |
| 0.0% | 413us | 0.4% | 24.0ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1209` |
| 0.0% | 412us | 0.1% | 6.8ms | `OrdinaryOwnMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1085` |
| 0.0% | 411us | 0.0% | 3.7ms | `next` | `/home/user/bun-node/node_modules/iterare/lib/map.js:13` |
| 0.0% | 411us | 0.0% | 411us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 410us | 0.0% | 2.4ms | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:430` |
| 0.0% | 410us | 0.0% | 410us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:198` |
| 0.0% | 407us | 0.0% | 407us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js` |
| 0.0% | 406us | 0.0% | 406us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js:19` |
| 0.0% | 405us | 0.0% | 1.4ms | `createContext` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:13` |
| 0.0% | 405us | 0.0% | 405us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:16` |
| 0.0% | 405us | 0.0% | 405us | `isArray` | `[native code]` |
| 0.0% | 403us | 0.0% | 403us | `(anonymous)` | `/home/user/bun-node/node_modules/tslib/tslib.js:207` |
| 0.0% | 403us | 0.0% | 403us | `async createInstances` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js` |
| 0.0% | 403us | 0.0% | 403us | `(anonymous)` | `node:zlib` |
| 0.0% | 403us | 0.0% | 840us | `SettlementSignal` | `/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js:13` |
| 0.0% | 402us | 0.0% | 608us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:67` |
| 0.0% | 401us | 0.0% | 401us | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 401us | 0.0% | 401us | `get method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 0.0% | 401us | 0.0% | 401us | `isObject` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:179` |
| 0.0% | 401us | 0.0% | 401us | `FilterIterator` | `/home/user/bun-node/node_modules/iterare/lib/filter.js:5` |
| 0.0% | 401us | 0.0% | 401us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 399us | 0.0% | 399us | `#respond` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:493` |
| 0.0% | 398us | 0.0% | 398us | `test` | `[native code]` |
| 0.0% | 397us | 0.1% | 8.4ms | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:963` |
| 0.0% | 396us | 0.0% | 396us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter-context.js:14` |
| 0.0% | 395us | 0.0% | 2.6ms | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:40` |
| 0.0% | 394us | 0.0% | 394us | `initialize` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:342` |
| 0.0% | 393us | 0.0% | 393us | `getCtorMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.0% | 393us | 0.0% | 393us | `ownKeys` | `[native code]` |
| 0.0% | 393us | 0.0% | 393us | `startInterval` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 392us | 0.0% | 392us | `async callModuleInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js` |
| 0.0% | 387us | 0.0% | 387us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:198` |
| 0.0% | 386us | 0.0% | 386us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3503` |
| 0.0% | 386us | 0.0% | 386us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/invalid-class.exception.js:11` |
| 0.0% | 385us | 0.0% | 385us | `reflectConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 384us | 0.2% | 13.1ms | `OrdinaryGetMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:592` |
| 0.0% | 383us | 0.0% | 383us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:164` |
| 0.0% | 382us | 0.0% | 612us | `some` | `[native code]` |
| 0.0% | 381us | 0.0% | 381us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 381us | 0.0% | 381us | `performProxyObjectGet` | `[native code]` |
| 0.0% | 381us | 0.0% | 381us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:6` |
| 0.0% | 378us | 0.0% | 764us | `host` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3577` |
| 0.0% | 377us | 0.0% | 4.4ms | `reflectConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:219` |
| 0.0% | 377us | 0.0% | 377us | `/\s*\/\/.*$/gm` | `[native code]` |
| 0.0% | 375us | 0.0% | 375us | `getStaticTransientInstances` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.0% | 371us | 0.0% | 1.0ms | `filter` | `[native code]` |
| 0.0% | 371us | 0.0% | 371us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:953` |
| 0.0% | 369us | 0.0% | 369us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js` |
| 0.0% | 366us | 0.0% | 366us | `getPropertiesMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:121` |
| 0.0% | 361us | 0.0% | 361us | `getContextInquirerId` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 359us | 0.0% | 359us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1246` |
| 0.0% | 358us | 0.0% | 358us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/unknown-export.exception.js:3` |
| 0.0% | 354us | 0.0% | 354us | `endsWith` | `[native code]` |
| 0.0% | 351us | 0.0% | 351us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:375` |
| 0.0% | 342us | 0.0% | 342us | `GetMetadataProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1166` |
| 0.0% | 338us | 2.6% | 130.2ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1271` |
| 0.0% | 336us | 0.0% | 336us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:681` |
| 0.0% | 333us | 0.0% | 333us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/skip.js` |
| 0.0% | 329us | 0.0% | 329us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/types/urlencoded.js:48` |
| 0.0% | 324us | 0.0% | 324us | `#configuredCookieSecrets` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 318us | 0.0% | 318us | `InstanceWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:23` |
| 0.0% | 316us | 0.0% | 495us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:421` |
| 0.0% | 315us | 0.0% | 315us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:420` |
| 0.0% | 313us | 0.0% | 313us | `extendStatics` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/AsyncSubject.js` |
| 0.0% | 306us | 0.4% | 23.8ms | `bound get` | `[native code]` |
| 0.0% | 306us | 0.0% | 698us | `OrdinaryGetOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:606` |
| 0.0% | 303us | 0.0% | 3.0ms | `reflectMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:324` |
| 0.0% | 294us | 0.0% | 294us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/undefined-dependency.exception.js:6` |
| 0.0% | 294us | 0.0% | 294us | `Stream` | `internal:streams/legacy` |
| 0.0% | 293us | 0.0% | 293us | `defineCustomPromisify` | `internal:promisify` |
| 0.0% | 292us | 0.0% | 292us | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3398` |
| 0.0% | 292us | 0.0% | 292us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/serializer/class-serializer.interceptor.js:76` |
| 0.0% | 291us | 0.0% | 291us | `exploreMethodMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:31` |
| 0.0% | 289us | 0.0% | 289us | `filter` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js` |
| 0.0% | 289us | 0.0% | 289us | `async reflectImports` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 0.0% | 288us | 0.0% | 288us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/enums/request-method.enum.js` |
| 0.0% | 288us | 0.0% | 288us | `insertProvider` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 0.0% | 287us | 0.0% | 287us | `async addDynamicModules` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js` |
| 0.0% | 286us | 0.0% | 286us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapAction.js` |
| 0.0% | 282us | 0.0% | 282us | `resolveAdapterOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunWebSocketAdapter.ts` |
| 0.0% | 282us | 0.0% | 282us | `layerFinished` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:598` |
| 0.0% | 281us | 0.0% | 281us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:194` |
| 0.0% | 281us | 0.0% | 281us | `Empty` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 281us | 0.0% | 281us | `_freeze` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:71` |
| 0.0% | 279us | 5.3% | 264.6ms | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` |
| 0.0% | 279us | 0.0% | 279us | `getModules` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js` |
| 0.0% | 277us | 0.0% | 277us | `CreateMetadataRegistry` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 277us | 0.0% | 277us | `createForStatic` | `/home/user/bun-node/node_modules/@nestjs/core/injector/opaque-key-factory/by-reference-module-opaque-key-factory.js` |
| 0.0% | 276us | 0.0% | 276us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncAction.js` |
| 0.0% | 276us | 0.0% | 276us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/redirect.decorator.js:2` |
| 0.0% | 276us | 0.0% | 276us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/SequenceError.js` |
| 0.0% | 275us | 0.0% | 275us | `(anonymous)` | `/home/user/bun-node/node_modules/uint8array-extras/index.js:178` |
| 0.0% | 274us | 0.0% | 274us | `RouteCandidateIndex` | `[native code]` |
| 0.0% | 274us | 0.2% | 14.3ms | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:77` |
| 0.0% | 272us | 0.0% | 272us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts` |
| 0.0% | 270us | 0.0% | 270us | `getEffectiveResolutionContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 270us | 0.0% | 270us | `getMetaKeyByInstanceWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discoverable-meta-host-collection.js` |
| 0.0% | 270us | 0.0% | 270us | `put` | `/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/lib/index.js` |
| 0.0% | 268us | 0.0% | 268us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/sockets-container.js:5` |
| 0.0% | 266us | 0.0% | 266us | `extendStatics` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/VirtualTimeScheduler.js` |
| 0.0% | 266us | 0.0% | 266us | `(anonymous)` | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js` |
| 0.0% | 265us | 0.0% | 265us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/timeInterval.js:19` |
| 0.0% | 265us | 0.0% | 265us | `useFactory` | `/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module-factory.js` |
| 0.0% | 264us | 0.0% | 264us | `async createInstancesOfInjectables` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js` |
| 0.0% | 264us | 0.0% | 264us | `resolveWebSocketOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 264us | 0.0% | 264us | `mergeBunRequestOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 264us | 0.0% | 474us | `IsArray` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:770` |
| 0.0% | 262us | 0.0% | 262us | `writer` | `[native code]` |
| 0.0% | 260us | 0.0% | 260us | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1409` |
| 0.0% | 260us | 0.0% | 260us | `getInspectOptions` | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js` |
| 0.0% | 259us | 0.0% | 259us | `(module)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:181` |
| 0.0% | 259us | 0.0% | 1.6ms | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js:158` |
| 0.0% | 258us | 0.0% | 258us | `(anonymous)` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:79` |
| 0.0% | 256us | 0.0% | 475us | `async loadProvider` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:107` |
| 0.0% | 256us | 0.0% | 256us | `thresholdValue` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts` |
| 0.0% | 255us | 0.0% | 255us | `getVersion` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:49` |
| 0.0% | 254us | 0.0% | 254us | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 254us | 0.0% | 254us | `WritableState` | `internal:streams/writable` |
| 0.0% | 252us | 0.0% | 252us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:3` |
| 0.0% | 252us | 0.0% | 252us | `(program)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/silent-logger.js:1` |
| 0.0% | 251us | 0.0% | 251us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:18` |
| 0.0% | 251us | 0.0% | 251us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 250us | 0.0% | 250us | `isBoolean` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:158` |
| 0.0% | 250us | 0.0% | 250us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/last.js:2` |
| 0.0% | 249us | 0.0% | 249us | `toString` | `[native code]` |
| 0.0% | 248us | 0.0% | 248us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:2` |
| 0.0% | 248us | 0.0% | 248us | `setPrototypeDirect` | `[native code]` |
| 0.0% | 247us | 0.0% | 247us | `__exportStar` | `/home/user/bun-node/node_modules/tslib/tslib.js` |
| 0.0% | 246us | 0.0% | 246us | `getInstanceByContextId` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:49` |
| 0.0% | 246us | 0.0% | 246us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/NotFoundError.js` |
| 0.0% | 246us | 0.0% | 246us | `Mime` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 245us | 0.0% | 245us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 244us | 0.0% | 244us | `NestApplication` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:38` |
| 0.0% | 244us | 0.0% | 244us | `pick` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 244us | 0.0% | 244us | `MiddlewareModule` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 244us | 0.0% | 244us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js:14` |
| 0.0% | 243us | 0.0% | 243us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/types/standard.js:365` |
| 0.0% | 243us | 0.0% | 243us | `BunRouter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 243us | 0.5% | 27.1ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/index.js:4` |
| 0.0% | 241us | 0.0% | 241us | `async registerMiddlewareConfig` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 241us | 0.0% | 241us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` |
| 0.0% | 239us | 0.0% | 239us | `addLeadingSlash` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:26` |
| 0.0% | 238us | 0.0% | 238us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:264` |
| 0.0% | 237us | 0.0% | 237us | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:55` |
| 0.0% | 237us | 0.0% | 237us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/opaque-key-factory/deep-hashed-module-opaque-key-factory.js:11` |
| 0.0% | 236us | 0.0% | 2.6ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:125` |
| 0.0% | 236us | 0.0% | 2.7ms | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:21` |
| 0.0% | 235us | 0.0% | 235us | `NestApplicationContext` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:36` |
| 0.0% | 235us | 0.0% | 235us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1048` |
| 0.0% | 235us | 0.0% | 235us | `concat` | `[native code]` |
| 0.0% | 235us | 0.0% | 235us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js:57` |
| 0.0% | 235us | 0.0% | 235us | `(program)` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter.js:1` |
| 0.0% | 233us | 0.0% | 2.6ms | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:19` |
| 0.0% | 232us | 0.0% | 232us | `async registerRouter` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` |
| 0.0% | 232us | 0.0% | 232us | `(module)` | `/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/node_modules/@borewit/text-codec/lib/index.js:12` |
| 0.0% | 232us | 0.0% | 232us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:550` |
| 0.0% | 231us | 0.0% | 231us | `setModuleContext` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js` |
| 0.0% | 231us | 0.0% | 231us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/sse-stream.js:3` |
| 0.0% | 230us | 0.0% | 230us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Notification.js` |
| 0.0% | 230us | 0.0% | 230us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 230us | 0.0% | 230us | `createPipesFn` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 230us | 0.0% | 230us | `AsyncScheduler` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js:26` |
| 0.0% | 230us | 0.0% | 230us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js` |
| 0.0% | 229us | 0.0% | 229us | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 229us | 0.0% | 229us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 228us | 0.1% | 6.3ms | `next` | `/home/user/bun-node/node_modules/iterare/lib/map.js:12` |
| 0.0% | 228us | 0.0% | 228us | `extractWildcardNames` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:242` |
| 0.0% | 228us | 0.0% | 228us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/runtime.exception.js:4` |
| 0.0% | 228us | 0.0% | 228us | `(program)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/compiler.js:1` |
| 0.0% | 228us | 0.0% | 228us | `node:events` | `node:events:645` |
| 0.0% | 227us | 0.0% | 227us | `callOperator` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js` |
| 0.0% | 227us | 0.0% | 227us | `validateKey` | `/home/user/bun-node/node_modules/@nestjs/common/utils/validate-module-keys.util.js` |
| 0.0% | 227us | 0.0% | 227us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/parse-float.pipe.js:2` |
| 0.0% | 227us | 0.0% | 227us | `isIterator` | `/home/user/bun-node/node_modules/iterare/lib/utils.js:4` |
| 0.0% | 226us | 0.0% | 226us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:76` |
| 0.0% | 226us | 0.0% | 226us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:29` |
| 0.0% | 226us | 0.0% | 226us | `getProviderNoCache` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:919` |
| 0.0% | 226us | 0.0% | 226us | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 226us | 0.0% | 226us | `internal:streams/readable` | `internal:streams/readable:642` |
| 0.0% | 226us | 0.0% | 226us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discoverable-meta-host-collection.js:4` |
| 0.0% | 225us | 0.0% | 225us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:45` |
| 0.0% | 225us | 0.0% | 1.1ms | `InstanceWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:24` |
| 0.0% | 225us | 0.0% | 225us | `AnimationFrameScheduler` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AnimationFrameScheduler.js:23` |
| 0.0% | 225us | 0.0% | 225us | `addListener` | `node:events` |
| 0.0% | 225us | 0.0% | 225us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:38` |
| 0.0% | 224us | 0.0% | 224us | `extractNonWildcardPathsFrom` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js` |
| 0.0% | 224us | 0.0% | 2.0ms | `async init` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:105` |
| 0.0% | 224us | 0.0% | 847us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js:25` |
| 0.0% | 224us | 0.0% | 224us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter-context.js` |
| 0.0% | 223us | 0.0% | 411us | `async callModuleInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:37` |
| 0.0% | 223us | 0.0% | 223us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js:53` |
| 0.0% | 223us | 0.0% | 223us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js` |
| 0.0% | 223us | 0.4% | 22.9ms | `reflectDynamicMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:145` |
| 0.0% | 223us | 0.0% | 223us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js` |
| 0.0% | 223us | 0.0% | 223us | `FinalizationRegistry` | `[native code]` |
| 0.0% | 223us | 0.0% | 223us | `makeSafe` | `internal:primordials` |
| 0.0% | 222us | 0.0% | 222us | `Agent` | `node:_http_agent` |
| 0.0% | 222us | 0.0% | 222us | `mapToClass` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/utils.js` |
| 0.0% | 222us | 0.0% | 222us | `async callBootstrapHook` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` |
| 0.0% | 221us | 0.0% | 422us | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:67` |
| 0.0% | 221us | 0.0% | 221us | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 220us | 0.0% | 220us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js` |
| 0.0% | 220us | 0.0% | 220us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js:20` |
| 0.0% | 220us | 0.0% | 220us | `log` | `[native code]` |
| 0.0% | 220us | 0.0% | 412us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:43` |
| 0.0% | 219us | 0.0% | 219us | `createPipesFn` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:156` |
| 0.0% | 219us | 0.0% | 219us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:428` |
| 0.0% | 219us | 0.0% | 219us | `createConvenienceMethod` | `node:zlib` |
| 0.0% | 219us | 0.0% | 219us | `shouldSkipProviderLoading` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 219us | 0.0% | 219us | `get isStreamOpen` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1624` |
| 0.0% | 219us | 0.0% | 625us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/optional.decorator.js:22` |
| 0.0% | 218us | 0.0% | 218us | `__decorate` | `/home/user/bun-node/node_modules/tslib/tslib.js` |
| 0.0% | 218us | 0.0% | 218us | `GatewayMetadataExplorer` | `/home/user/bun-node/node_modules/@nestjs/websockets/gateway-metadata-explorer.js` |
| 0.0% | 218us | 0.1% | 6.4ms | `GetIterator` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:814` |
| 0.0% | 218us | 0.0% | 218us | `createGuardsFn` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 218us | 0.0% | 218us | `OrdinaryGetPrototypeOf` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 218us | 0.0% | 218us | `printIntrospectedAsRequestScoped` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.0% | 217us | 0.0% | 217us | `async transformToResult` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js` |
| 0.0% | 217us | 0.0% | 217us | `async bindHandler` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 217us | 0.0% | 217us | `createAdapterProxy` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js` |
| 0.0% | 217us | 0.0% | 2.9ms | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:70` |
| 0.0% | 217us | 0.0% | 217us | `colorIfAllowed` | `/home/user/bun-node/node_modules/@nestjs/common/utils/cli-colors.util.js` |
| 0.0% | 217us | 0.0% | 217us | `get id` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.0% | 217us | 0.0% | 217us | `set` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:12` |
| 0.0% | 216us | 0.0% | 216us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js` |
| 0.0% | 216us | 0.0% | 216us | `async loadConfiguration` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:49` |
| 0.0% | 216us | 0.0% | 216us | `extractVersionPathFrom` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js` |
| 0.0% | 216us | 0.0% | 1.9ms | `async registerModules` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:81` |
| 0.0% | 216us | 0.0% | 520us | `getInstanceByContextId` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:46` |
| 0.0% | 215us | 0.0% | 430us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/EmptyError.js:5` |
| 0.0% | 215us | 0.0% | 215us | `applyHostFilter` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 215us | 0.0% | 215us | `getModulesToTriggerHooksOn` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` |
| 0.0% | 215us | 0.0% | 215us | `async callModuleBootstrapHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js` |
| 0.0% | 215us | 0.0% | 215us | `async init` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` |
| 0.0% | 214us | 0.0% | 1.6ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:131` |
| 0.0% | 214us | 0.0% | 214us | `RouterExplorer` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 214us | 0.0% | 214us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduleIterable.js:3` |
| 0.0% | 214us | 0.0% | 214us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4765` |
| 0.0% | 214us | 0.0% | 214us | `exchangeKeysForValues` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 214us | 0.0% | 214us | `get metatype` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` |
| 0.0% | 214us | 0.0% | 414us | `(anonymous)` | `internal:util/inspect:46` |
| 0.0% | 214us | 0.0% | 214us | `NestApplicationContext` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` |
| 0.0% | 214us | 0.0% | 214us | `FreeList` | `internal:freelist` |
| 0.0% | 214us | 0.0% | 214us | `Observable` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js` |
| 0.0% | 214us | 0.0% | 214us | `get size` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:276` |
| 0.0% | 213us | 0.0% | 213us | `Scheduler` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Scheduler.js` |
| 0.0% | 213us | 0.0% | 213us | `Buffer` | `[native code]` |
| 0.0% | 213us | 0.0% | 213us | `applyCallbackToRouter` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 213us | 0.0% | 213us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-id-factory.js:3` |
| 0.0% | 213us | 0.0% | 213us | `async resolveMiddlewareInstance` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js` |
| 0.0% | 213us | 0.0% | 594us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:69` |
| 0.0% | 213us | 0.0% | 213us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/UnsubscriptionError.js` |
| 0.0% | 213us | 0.0% | 213us | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 213us | 0.0% | 213us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:21` |
| 0.0% | 213us | 0.0% | 213us | `startInterval` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:193` |
| 0.0% | 212us | 0.0% | 212us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1003` |
| 0.0% | 212us | 0.0% | 212us | `internal:shared` | `internal:shared:173` |
| 0.0% | 212us | 0.0% | 423us | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:58` |
| 0.0% | 212us | 0.0% | 212us | `node:_http_agent` | `node:_http_agent:68` |
| 0.0% | 212us | 1.1% | 58.7ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4774` |
| 0.0% | 212us | 0.0% | 212us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:157` |
| 0.0% | 212us | 0.0% | 212us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/modules/injection-token.interface.js:2` |
| 0.0% | 211us | 0.0% | 211us | `node:_http_client` | `node:_http_client:220` |
| 0.0% | 211us | 0.0% | 211us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 211us | 0.0% | 421us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:39` |
| 0.0% | 211us | 0.0% | 616us | `reflectInjectables` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:170` |
| 0.0% | 211us | 0.0% | 211us | `slice` | `[native code]` |
| 0.0% | 211us | 2.8% | 140.8ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:42` |
| 0.0% | 211us | 0.0% | 211us | `typedArrayViewIsTypedArrayView` | `[native code]` |
| 0.0% | 211us | 0.0% | 3.9ms | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:20` |
| 0.0% | 211us | 0.0% | 211us | `(anonymous)` | `internal:http` |
| 0.0% | 211us | 0.0% | 211us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:3` |
| 0.0% | 211us | 0.0% | 211us | `async resolveInstances` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js` |
| 0.0% | 211us | 0.0% | 211us | `async register` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 210us | 0.0% | 210us | `charCodeAt` | `[native code]` |
| 0.0% | 210us | 0.0% | 210us | `async loadEnhancersPerContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:457` |
| 0.0% | 210us | 0.4% | 23.5ms | `registerVerb` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1544` |
| 0.0% | 210us | 0.0% | 210us | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:65` |
| 0.0% | 210us | 0.0% | 210us | `async loadMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 209us | 0.0% | 209us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1270` |
| 0.0% | 209us | 0.0% | 209us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:2` |
| 0.0% | 209us | 0.0% | 209us | `flat` | `[native code]` |
| 0.0% | 209us | 0.0% | 2.1ms | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:32` |
| 0.0% | 209us | 0.0% | 209us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:54` |
| 0.0% | 209us | 0.0% | 209us | `async registerHandler` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 209us | 0.0% | 209us | `getOwnPropertyNames` | `[native code]` |
| 0.0% | 209us | 0.0% | 3.1ms | `createContext` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:8` |
| 0.0% | 209us | 0.0% | 209us | `addLeadingSlash` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js` |
| 0.0% | 209us | 0.0% | 209us | `async (anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 209us | 0.0% | 209us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js:71` |
| 0.0% | 209us | 0.0% | 209us | `createExceptionLayerProxy` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js` |
| 0.0% | 208us | 0.0% | 208us | `__` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:13` |
| 0.0% | 208us | 0.0% | 208us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:14` |
| 0.0% | 208us | 0.0% | 208us | `getHttpAdapterRef` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:53` |
| 0.0% | 208us | 0.0% | 208us | `getVersion` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js` |
| 0.0% | 208us | 11.5% | 568.1ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:184` |
| 0.0% | 208us | 0.0% | 403us | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:56` |
| 0.0% | 208us | 0.0% | 208us | `#respond` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 208us | 0.0% | 208us | `async loadEnhancersPerContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 208us | 0.1% | 8.5ms | `reflectKeyMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:195` |
| 0.0% | 208us | 0.0% | 208us | `Param` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:238` |
| 0.0% | 207us | 0.0% | 207us | `FilterIterator` | `/home/user/bun-node/node_modules/iterare/lib/filter.js` |
| 0.0% | 207us | 0.0% | 207us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:201` |
| 0.0% | 207us | 0.0% | 394us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` |
| 0.0% | 207us | 0.0% | 207us | `node:async_hooks` | `node:async_hooks:311` |
| 0.0% | 207us | 0.0% | 670us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:13` |
| 0.0% | 207us | 0.0% | 207us | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:63` |
| 0.0% | 207us | 0.0% | 207us | `async lookupComponent` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 206us | 0.0% | 206us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:20` |
| 0.0% | 206us | 0.0% | 206us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1699` |
| 0.0% | 206us | 0.0% | 1.0ms | `setProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:984` |
| 0.0% | 206us | 0.0% | 206us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:13` |
| 0.0% | 206us | 0.0% | 206us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/BehaviorSubject.js` |
| 0.0% | 205us | 0.0% | 205us | `charAt` | `[native code]` |
| 0.0% | 205us | 0.0% | 205us | `status` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1182` |
| 0.0% | 205us | 0.0% | 3.1ms | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:84` |
| 0.0% | 205us | 0.0% | 2.8ms | `async resolveProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:352` |
| 0.0% | 205us | 0.0% | 404us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:30` |
| 0.0% | 205us | 0.0% | 205us | `mapIterationEntryKey` | `[native code]` |
| 0.0% | 205us | 0.0% | 205us | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3389` |
| 0.0% | 205us | 0.0% | 205us | `createCallbackProxy` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 205us | 0.0% | 1.1ms | `node:_http_common` | `node:_http_common:2` |
| 0.0% | 205us | 0.0% | 205us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:191` |
| 0.0% | 205us | 0.0% | 205us | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:696` |
| 0.0% | 205us | 0.0% | 205us | `next` | `/home/user/bun-node/node_modules/iterare/lib/map.js` |
| 0.0% | 204us | 0.0% | 204us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:133` |
| 0.0% | 204us | 0.0% | 204us | `OrdinaryGetOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1069` |
| 0.0% | 204us | 0.0% | 204us | `getGetter` | `internal:primordials` |
| 0.0% | 204us | 0.0% | 204us | `enable` | `/home/user/bun-node/node_modules/debug/src/common.js` |
| 0.0% | 204us | 0.0% | 204us | `extractPathsFrom` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js` |
| 0.0% | 203us | 0.0% | 203us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:205` |
| 0.0% | 203us | 0.0% | 203us | `node:diagnostics_channel` | `node:diagnostics_channel:2` |
| 0.0% | 203us | 0.0% | 203us | `createContext` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:6` |
| 0.0% | 203us | 0.0% | 203us | `set` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js` |
| 0.0% | 203us | 0.0% | 203us | `reflectRenderTemplate` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 203us | 0.0% | 203us | `isDependencyTreeStatic` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.0% | 203us | 0.0% | 203us | `asyncWrap` | `node:fs/promises` |
| 0.0% | 202us | 0.0% | 202us | `internal:util/inspect` | `internal:util/inspect:9` |
| 0.0% | 202us | 0.0% | 202us | `getNowTimestamp` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:641` |
| 0.0% | 202us | 0.0% | 202us | `AsyncScheduler` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js` |
| 0.0% | 202us | 0.0% | 202us | `startInterval` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:191` |
| 0.0% | 202us | 0.0% | 1.0ms | `reflectKeyMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:191` |
| 0.0% | 201us | 0.0% | 201us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/publish.js:2` |
| 0.0% | 201us | 0.0% | 201us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:82` |
| 0.0% | 201us | 0.0% | 201us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:6` |
| 0.0% | 201us | 0.0% | 201us | `get headersSent` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` |
| 0.0% | 201us | 0.0% | 201us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:129` |
| 0.0% | 201us | 0.0% | 201us | `ToPropertyKey` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 200us | 0.0% | 200us | `normalizeCatchAllPath` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:217` |
| 0.0% | 200us | 0.0% | 200us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:237` |
| 0.0% | 200us | 0.1% | 5.5ms | `loadPrototype` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:33` |
| 0.0% | 200us | 0.0% | 200us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 200us | 0.0% | 200us | `call` | `[native code]` |
| 0.0% | 200us | 0.0% | 200us | `NestFactoryStatic` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:28` |
| 0.0% | 200us | 0.0% | 200us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:40` |
| 0.0% | 200us | 0.0% | 200us | `setProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:982` |
| 0.0% | 200us | 0.0% | 200us | `getStaticTransientResolutionContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 200us | 0.0% | 200us | `useMethod` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 200us | 0.0% | 200us | `async callInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` |
| 0.0% | 199us | 0.0% | 199us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-shutdown.hook.js:3` |
| 0.0% | 199us | 0.0% | 199us | `BenchController` | `[native code]` |
| 0.0% | 199us | 0.0% | 199us | `reflectMethodMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:22` |
| 0.0% | 199us | 0.0% | 199us | `mapFactoryProviderInjectArray` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 198us | 0.0% | 198us | `async resolveComponentWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 198us | 0.0% | 198us | `status` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 198us | 0.0% | 198us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:420` |
| 0.0% | 198us | 0.0% | 198us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:224` |
| 0.0% | 198us | 0.0% | 198us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:87` |
| 0.0% | 198us | 0.0% | 198us | `node:http` | `node:http:5` |
| 0.0% | 197us | 0.0% | 197us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5037` |
| 0.0% | 197us | 0.0% | 197us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:80` |
| 0.0% | 197us | 0.0% | 2.4ms | `scanForPaths` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:15` |
| 0.0% | 197us | 0.0% | 197us | `loadPrototype` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:28` |
| 0.0% | 197us | 0.0% | 197us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/unknown-dependencies.exception.js:6` |
| 0.0% | 196us | 0.0% | 196us | `async resolveMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 196us | 0.0% | 196us | `IsPropertyKey` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 196us | 0.0% | 196us | `RouterExecutionContext` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 196us | 0.4% | 24.0ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:117` |
| 0.0% | 196us | 0.0% | 196us | `addScopedEnhancersMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 0.0% | 196us | 0.0% | 196us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/max.js:9` |
| 0.0% | 196us | 0.0% | 1.0ms | `getArgumentsLength` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:23` |
| 0.0% | 196us | 0.0% | 196us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:164` |
| 0.0% | 196us | 0.0% | 196us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:19` |
| 0.0% | 196us | 0.0% | 196us | `getArgumentsLength` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js` |
| 0.0% | 196us | 0.0% | 196us | `internal:fs/streams` | `internal:fs/streams:156` |
| 0.0% | 195us | 0.0% | 195us | `applyApplicationProviders` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 0.0% | 195us | 0.0% | 195us | `Controller` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/controller.decorator.js` |
| 0.0% | 195us | 0.0% | 195us | `Body` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:189` |
| 0.0% | 195us | 0.0% | 195us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:427` |
| 0.0% | 195us | 0.0% | 195us | `node:crypto` | `node:crypto:279` |
| 0.0% | 195us | 0.0% | 195us | `ConsoleLogger` | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js` |
| 0.0% | 195us | 0.0% | 195us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delay.js:2` |
| 0.0% | 194us | 0.0% | 194us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1051` |
| 0.0% | 194us | 0.0% | 194us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:11` |
| 0.0% | 194us | 0.0% | 194us | `PipesContextCreator` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:11` |
| 0.0% | 194us | 0.0% | 194us | `addCtorMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:102` |
| 0.0% | 194us | 0.0% | 615us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:18` |
| 0.0% | 194us | 0.0% | 194us | `Module` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/modules/module.decorator.js` |
| 0.0% | 193us | 0.0% | 193us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4784` |
| 0.0% | 193us | 0.0% | 193us | `OrdinaryDefineOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1075` |
| 0.0% | 193us | 0.0% | 193us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/request/index.js:3` |
| 0.0% | 193us | 0.0% | 193us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:107` |
| 0.0% | 193us | 0.0% | 193us | `MapIterator` | `/home/user/bun-node/node_modules/iterare/lib/map.js` |
| 0.0% | 193us | 0.0% | 1.2ms | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:174` |
| 0.0% | 193us | 0.0% | 193us | `appendToAllIfDefined` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:64` |
| 0.0% | 193us | 0.0% | 193us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:119` |
| 0.0% | 192us | 0.0% | 192us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 192us | 0.0% | 1.1ms | `exploreMethodMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:32` |
| 0.0% | 192us | 0.0% | 192us | `isMiddlewareClass` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/utils.js:82` |
| 0.0% | 192us | 0.0% | 192us | `getGlobalFilters` | `/home/user/bun-node/node_modules/@nestjs/core/application-config.js` |
| 0.0% | 192us | 0.0% | 406us | `node:crypto` | `node:crypto:2` |
| 0.0% | 192us | 0.0% | 384us | `get` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:202` |
| 0.0% | 192us | 0.0% | 192us | `createExceptionZone` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js` |
| 0.0% | 192us | 0.0% | 192us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:38` |
| 0.0% | 192us | 0.1% | 8.1ms | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:31` |
| 0.0% | 192us | 0.0% | 192us | `OrdinaryDefineOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 192us | 0.0% | 192us | `getRequestMethodStr` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 191us | 0.0% | 191us | `run` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions-zone.js` |
| 0.0% | 191us | 0.0% | 191us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:37` |
| 0.0% | 190us | 0.0% | 190us | `reflectConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:218` |
| 0.0% | 190us | 0.0% | 190us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5182` |
| 0.0% | 190us | 0.0% | 190us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2496` |
| 0.0% | 190us | 0.0% | 190us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 190us | 0.0% | 190us | `reply` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1178` |
| 0.0% | 190us | 0.0% | 190us | `set` | `node:diagnostics_channel` |
| 0.0% | 190us | 0.0% | 190us | `assignMetadata` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js` |
| 0.0% | 190us | 0.0% | 190us | `#compileMiddlewareRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 190us | 0.0% | 190us | `defineCustomPromisifyArgs` | `node:fs:304` |
| 0.0% | 190us | 0.0% | 190us | `getProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:949` |
| 0.0% | 190us | 0.0% | 190us | `reflectSelfParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 190us | 0.0% | 190us | `use` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 190us | 0.0% | 190us | `uid` | `/home/user/bun-node/node_modules/uid/dist/index.js:12` |
| 0.0% | 190us | 0.0% | 190us | `addRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1249` |
| 0.0% | 190us | 0.0% | 190us | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1359` |
| 0.0% | 189us | 0.0% | 189us | `NestApplication` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` |
| 0.0% | 189us | 0.0% | 189us | `forRoutes` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js` |
| 0.0% | 189us | 0.0% | 189us | `id` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:27` |
| 0.0% | 189us | 0.0% | 189us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:45` |
| 0.0% | 189us | 0.0% | 189us | `addController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:323` |
| 0.0% | 188us | 0.0% | 188us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js:12` |
| 0.0% | 188us | 0.0% | 188us | `reflectProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:403` |
| 0.0% | 188us | 0.0% | 188us | `copyMetadataToCallback` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 188us | 0.0% | 674us | `inspectInstanceWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discoverable-meta-host-collection.js:53` |
| 0.0% | 188us | 0.0% | 188us | `OrdinaryGetOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 188us | 0.0% | 188us | `exec` | `[native code]` |
| 0.0% | 188us | 0.4% | 20.8ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:68` |
| 0.0% | 188us | 0.0% | 1.3ms | `iterate` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js:209` |
| 0.0% | 188us | 0.0% | 188us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js` |
| 0.0% | 188us | 0.0% | 188us | `async registerRouteMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 188us | 0.0% | 188us | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 188us | 0.0% | 188us | `internal:streams/utils` | `internal:streams/utils:185` |
| 0.0% | 187us | 0.0% | 3.2ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2998` |
| 0.0% | 187us | 0.0% | 187us | `(anonymous)` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` |
| 0.0% | 187us | 0.0% | 187us | `OrdinaryHasOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 187us | 0.0% | 4.2ms | `async createInstances` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:39` |
| 0.0% | 187us | 0.0% | 187us | `node:url` | `node:url:2` |
| 0.0% | 187us | 0.0% | 187us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:23` |
| 0.0% | 187us | 0.3% | 15.3ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:104` |
| 0.0% | 187us | 0.0% | 187us | `waitForLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 187us | 0.0% | 187us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 187us | 0.0% | 1.7ms | `isInContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:501` |
| 0.0% | 187us | 0.0% | 1.6ms | `isStatic` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:250` |
| 0.0% | 186us | 0.0% | 186us | `registerParserMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:113` |
| 0.0% | 186us | 50.0% | 2.45s | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:20` |
| 0.0% | 186us | 0.0% | 186us | `ie` | `bun:wrap` |
| 0.0% | 185us | 0.0% | 185us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:67` |
| 0.0% | 185us | 0.0% | 185us | `log` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:54` |
| 0.0% | 185us | 0.0% | 185us | `segmentKind` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:75` |
| 0.0% | 185us | 0.0% | 185us | `node:util` | `node:util:254` |
| 0.0% | 185us | 0.0% | 431us | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:44` |
| 0.0% | 184us | 0.0% | 184us | `parseContentCodings` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:3670` |
| 0.0% | 184us | 0.0% | 184us | `isFunction` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:38` |
| 0.0% | 184us | 0.0% | 184us | `createHandleResponseFn` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 184us | 0.2% | 13.6ms | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:52` |
| 0.0% | 184us | 0.0% | 184us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:49` |
| 0.0% | 184us | 0.0% | 184us | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:376` |
| 0.0% | 183us | 0.0% | 183us | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4479` |
| 0.0% | 183us | 0.0% | 183us | `isString` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 183us | 0.0% | 183us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 183us | 0.0% | 634us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:20` |
| 0.0% | 182us | 0.0% | 182us | `#watchLateRejection` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 182us | 0.0% | 182us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/optional.decorator.js` |
| 0.0% | 181us | 0.0% | 1.3ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:183` |
| 0.0% | 181us | 0.0% | 181us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 181us | 0.0% | 603us | `OrdinaryMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:621` |
| 0.0% | 181us | 0.0% | 383us | `reflectResponseHeaders` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:96` |
| 0.0% | 180us | 0.0% | 180us | `GetOrCreateMetadataMap` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1036` |
| 0.0% | 179us | 0.0% | 179us | `getInstanceByContextId` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:53` |
| 0.0% | 179us | 0.0% | 179us | `async registerRouterHooks` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` |
| 0.0% | 179us | 0.8% | 42.2ms | `finish` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:685` |
| 0.0% | 178us | 0.0% | 178us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:88` |
| 0.0% | 178us | 0.0% | 178us | `segmentKind` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 178us | 0.0% | 178us | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3423` |
| 0.0% | 177us | 0.0% | 177us | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5313` |
| 0.0% | 175us | 0.0% | 175us | `async resolveProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:353` |
| 0.0% | 171us | 0.0% | 171us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:191` |
| 0.0% | 142us | 0.0% | 142us | `node:path` | `node:path:21` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 50.0% | 2.45s | 0.0% | 186us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:20` |
| 40.1% | 1.96s | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:94` |
| 32.7% | 1.60s | 7.3% | 358.7ms | `anonymous` | `[native code]` |
| 30.9% | 1.51s | 0.0% | 1.0ms | `bound require` | `[native code]` |
| 30.3% | 1.48s | 0.0% | 4.2ms | `require` | `[native code]` |
| 28.7% | 1.40s | 0.2% | 10.5ms | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:377` |
| 20.8% | 1.02s | 1.6% | 82.6ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:428` |
| 17.7% | 868.5ms | 0.0% | 1.9ms | `forEach` | `[native code]` |
| 17.5% | 859.6ms | 0.0% | 618us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5102` |
| 15.8% | 778.7ms | 0.0% | 603us | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:375` |
| 15.8% | 777.3ms | 0.1% | 8.4ms | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1432` |
| 11.5% | 568.1ms | 0.0% | 208us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:184` |
| 11.3% | 558.4ms | 0.0% | 1.6ms | `async apply` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:15` |
| 10.4% | 509.7ms | 3.1% | 153.6ms | `async middlewareHandler` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:823` |
| 9.5% | 466.8ms | 0.1% | 7.7ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1214` |
| 9.0% | 445.4ms | 1.4% | 69.9ms | `Promise` | `[native code]` |
| 8.1% | 401.1ms | 8.1% | 401.1ms | `Response` | `[native code]` |
| 7.3% | 360.0ms | 0.1% | 7.9ms | `#waitLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5152` |
| 7.1% | 352.7ms | 0.1% | 8.6ms | `async (anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:824` |
| 7.1% | 351.2ms | 0.5% | 24.7ms | `waitForLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:673` |
| 7.0% | 346.2ms | 1.3% | 65.4ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js:7` |
| 7.0% | 345.3ms | 0.0% | 0us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5122` |
| 6.5% | 322.5ms | 1.0% | 49.5ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3349` |
| 5.6% | 278.3ms | 0.1% | 9.1ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js:9` |
| 5.4% | 268.9ms | 0.4% | 22.3ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:40` |
| 5.3% | 264.6ms | 0.0% | 279us | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` |
| 5.3% | 264.3ms | 5.3% | 264.3ms | `Request` | `[native code]` |
| 4.9% | 243.4ms | 0.0% | 4.4ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1267` |
| 4.6% | 226.5ms | 0.0% | 3.5ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` |
| 3.9% | 194.7ms | 0.4% | 20.3ms | `async #awaitPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:441` |
| 3.5% | 171.9ms | 0.0% | 0us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:434` |
| 3.3% | 164.7ms | 0.2% | 12.0ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4984` |
| 3.2% | 159.1ms | 0.2% | 11.1ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:46` |
| 2.9% | 145.1ms | 0.0% | 0us | `async registerRouter` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:121` |
| 2.9% | 145.1ms | 0.0% | 0us | `resolve` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:30` |
| 2.9% | 144.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:32` |
| 2.9% | 144.9ms | 0.0% | 0us | `registerRouters` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:36` |
| 2.9% | 144.0ms | 0.0% | 4.8ms | `async #awaitPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:454` |
| 2.8% | 140.8ms | 0.0% | 211us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:42` |
| 2.8% | 139.1ms | 0.4% | 20.6ms | `awaitPipelineOrStream` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:620` |
| 2.8% | 138.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:68` |
| 2.8% | 138.3ms | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:48` |
| 2.6% | 130.8ms | 0.5% | 28.5ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:181` |
| 2.6% | 130.5ms | 0.0% | 0us | `explore` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:49` |
| 2.6% | 130.2ms | 0.0% | 338us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1271` |
| 2.6% | 130.1ms | 0.0% | 0us | `applyPathsToRouterProxy` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:62` |
| 2.6% | 130.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:65` |
| 2.6% | 128.0ms | 2.6% | 128.0ms | `get` | `[native code]` |
| 2.4% | 117.8ms | 0.9% | 48.2ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:410` |
| 2.3% | 113.0ms | 0.0% | 0us | `async scanModulesForDependencies` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:108` |
| 2.3% | 113.0ms | 0.0% | 0us | `reflectControllers` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:136` |
| 2.2% | 108.6ms | 2.2% | 108.6ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:696` |
| 2.1% | 106.8ms | 0.5% | 26.5ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1306` |
| 2.1% | 105.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/index.js:21` |
| 2.1% | 105.3ms | 2.1% | 105.3ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1231` |
| 2.1% | 104.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/serializer/index.js:4` |
| 2.0% | 102.7ms | 0.0% | 1.4ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3420` |
| 2.0% | 102.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/serializer/class-serializer.interceptor.js:5` |
| 2.0% | 101.0ms | 0.9% | 45.7ms | `async #parseBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3112` |
| 2.0% | 100.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:138` |
| 1.8% | 89.2ms | 0.2% | 10.4ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:182` |
| 1.6% | 82.8ms | 0.1% | 9.5ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:712` |
| 1.6% | 82.0ms | 1.6% | 82.0ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5006` |
| 1.6% | 81.7ms | 1.6% | 81.7ms | `asyncFunctionDrive` | `[native code]` |
| 1.5% | 77.5ms | 1.5% | 73.6ms | `async transformToResult` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:32` |
| 1.4% | 73.1ms | 0.2% | 11.1ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:41` |
| 1.4% | 70.9ms | 1.4% | 70.9ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3541` |
| 1.3% | 68.4ms | 1.3% | 68.4ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 1.3% | 67.3ms | 1.3% | 67.3ms | `onceResponded` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2024` |
| 1.3% | 65.9ms | 0.0% | 3.0ms | `async (anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:833` |
| 1.3% | 64.3ms | 1.3% | 63.7ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` |
| 1.2% | 61.9ms | 1.2% | 61.9ms | `createNullArray` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:27` |
| 1.2% | 59.9ms | 1.2% | 59.9ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1213` |
| 1.2% | 59.4ms | 0.0% | 0us | `reflectDynamicMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:149` |
| 1.1% | 58.7ms | 0.0% | 212us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4774` |
| 1.1% | 58.7ms | 0.0% | 0us | `reflectParamInjectables` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:176` |
| 1.1% | 57.9ms | 0.0% | 0us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5175` |
| 1.1% | 57.7ms | 1.1% | 57.7ms | `#watchLateRejection` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5197` |
| 1.1% | 57.6ms | 0.2% | 12.6ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3392` |
| 1.1% | 57.0ms | 0.1% | 7.3ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1340` |
| 1.1% | 56.9ms | 0.0% | 0us | `applyCallbackToRouter` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:82` |
| 1.1% | 56.2ms | 0.1% | 8.8ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:694` |
| 1.1% | 56.1ms | 0.0% | 562us | `async intercept` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js:12` |
| 1.1% | 55.5ms | 0.4% | 22.5ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:36` |
| 1.1% | 55.5ms | 0.0% | 0us | `next` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5084` |
| 1.0% | 53.7ms | 1.0% | 53.7ms | `method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 1.0% | 53.5ms | 1.0% | 53.5ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:623` |
| 1.0% | 53.3ms | 0.3% | 16.7ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3040` |
| 1.0% | 53.0ms | 0.1% | 5.2ms | `map` | `[native code]` |
| 1.0% | 50.7ms | 1.0% | 50.7ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3506` |
| 1.0% | 50.6ms | 1.0% | 50.6ms | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:281` |
| 1.0% | 50.6ms | 0.0% | 0us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4782` |
| 1.0% | 49.7ms | 1.0% | 49.7ms | `alloc` | `[native code]` |
| 1.0% | 49.6ms | 0.0% | 0us | `applyCallbackToRouter` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:77` |
| 0.9% | 47.5ms | 0.9% | 46.0ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:177` |
| 0.9% | 46.6ms | 0.9% | 46.6ms | `async #parseBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3118` |
| 0.9% | 46.4ms | 0.9% | 44.8ms | `(anonymous)` | `[native code]` |
| 0.9% | 46.3ms | 0.0% | 0us | `createCallbackProxy` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:187` |
| 0.8% | 43.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/index.js:15` |
| 0.8% | 43.5ms | 0.8% | 42.9ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4470` |
| 0.8% | 43.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/file-stream/index.js:4` |
| 0.8% | 43.1ms | 0.8% | 43.1ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.8% | 42.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:90` |
| 0.8% | 42.2ms | 0.0% | 179us | `finish` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:685` |
| 0.8% | 42.1ms | 0.8% | 42.1ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2029` |
| 0.8% | 41.7ms | 0.1% | 7.1ms | `response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:963` |
| 0.7% | 38.3ms | 0.7% | 38.3ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.7% | 35.2ms | 0.7% | 35.2ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:676` |
| 0.6% | 33.5ms | 0.0% | 0us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:704` |
| 0.6% | 33.3ms | 0.6% | 33.3ms | `isStreamOpen` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1624` |
| 0.6% | 33.0ms | 0.6% | 33.0ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3520` |
| 0.6% | 32.6ms | 0.6% | 32.6ms | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4777` |
| 0.6% | 32.2ms | 0.6% | 32.2ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5154` |
| 0.6% | 31.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:26` |
| 0.6% | 31.2ms | 0.6% | 31.2ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3507` |
| 0.6% | 30.6ms | 0.0% | 0us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:29` |
| 0.6% | 30.6ms | 0.6% | 30.6ms | `async intercept` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js:10` |
| 0.6% | 30.5ms | 0.3% | 15.6ms | `reduce` | `[native code]` |
| 0.6% | 30.5ms | 0.0% | 0us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:416` |
| 0.6% | 30.2ms | 0.6% | 30.2ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3416` |
| 0.6% | 30.2ms | 0.0% | 0us | `finish` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:687` |
| 0.6% | 30.1ms | 0.5% | 26.2ms | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` |
| 0.6% | 29.6ms | 0.0% | 0us | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3391` |
| 0.6% | 29.5ms | 0.6% | 29.5ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.5% | 29.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/index.js:4` |
| 0.5% | 29.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:22` |
| 0.5% | 29.0ms | 0.5% | 29.0ms | `async intercept` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js` |
| 0.5% | 28.8ms | 0.5% | 28.8ms | `#waitLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5151` |
| 0.5% | 28.4ms | 0.0% | 0us | `bound serveNativeRequest` | `[native code]` |
| 0.5% | 28.4ms | 0.5% | 28.4ms | `setPrototypeDirectOrThrow` | `[native code]` |
| 0.5% | 27.9ms | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:2995` |
| 0.5% | 27.7ms | 0.0% | 1.0ms | `getMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:370` |
| 0.5% | 27.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:19` |
| 0.5% | 27.1ms | 0.0% | 4.2ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1331` |
| 0.5% | 27.1ms | 0.0% | 243us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/index.js:4` |
| 0.5% | 26.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/file-stream/streamable-file.js:7` |
| 0.5% | 25.8ms | 0.0% | 0us | `reflectInjectables` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:162` |
| 0.5% | 25.8ms | 0.0% | 0us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1256` |
| 0.5% | 25.6ms | 0.0% | 3.8ms | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1356` |
| 0.5% | 25.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discovery-module.js:7` |
| 0.5% | 24.9ms | 0.1% | 5.3ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:720` |
| 0.4% | 24.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discovery-service.js:7` |
| 0.4% | 24.0ms | 0.0% | 196us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:117` |
| 0.4% | 24.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/modules-container.js:4` |
| 0.4% | 24.0ms | 0.0% | 413us | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1209` |
| 0.4% | 23.8ms | 0.0% | 306us | `bound get` | `[native code]` |
| 0.4% | 23.5ms | 0.0% | 0us | `#canSkipHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:571` |
| 0.4% | 23.5ms | 0.0% | 210us | `registerVerb` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1544` |
| 0.4% | 23.5ms | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1031` |
| 0.4% | 23.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:21` |
| 0.4% | 23.2ms | 0.4% | 23.2ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:38` |
| 0.4% | 22.9ms | 0.0% | 223us | `reflectDynamicMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:145` |
| 0.4% | 22.5ms | 0.4% | 22.3ms | `applyCallbackToRouter` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:73` |
| 0.4% | 22.4ms | 0.0% | 511us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:419` |
| 0.4% | 22.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/index.js:5` |
| 0.4% | 22.1ms | 0.4% | 22.1ms | `cloneObject` | `[native code]` |
| 0.4% | 21.8ms | 0.4% | 21.8ms | `async intercept` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js:11` |
| 0.4% | 21.7ms | 0.0% | 0us | `async createInstancesOfControllers` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:64` |
| 0.4% | 21.7ms | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:42` |
| 0.4% | 21.6ms | 0.4% | 20.4ms | `parseContentCodings` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:3668` |
| 0.4% | 21.6ms | 0.0% | 452us | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:42` |
| 0.4% | 21.4ms | 0.0% | 0us | `async createInstancesOfControllers` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:67` |
| 0.4% | 21.2ms | 0.0% | 591us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:67` |
| 0.4% | 20.9ms | 0.0% | 0us | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1332` |
| 0.4% | 20.8ms | 0.0% | 188us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:68` |
| 0.4% | 20.6ms | 0.0% | 0us | `originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` |
| 0.4% | 20.6ms | 0.0% | 1.0ms | `async loadController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:97` |
| 0.4% | 20.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/index.js:4` |
| 0.4% | 20.4ms | 0.4% | 20.4ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5009` |
| 0.4% | 19.6ms | 0.4% | 19.6ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3351` |
| 0.4% | 19.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/index.js:20` |
| 0.3% | 19.3ms | 0.3% | 19.3ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3511` |
| 0.3% | 18.7ms | 0.0% | 0us | `async loadController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:99` |
| 0.3% | 18.2ms | 0.3% | 18.2ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3042` |
| 0.3% | 17.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/index.js:9` |
| 0.3% | 17.4ms | 0.0% | 648us | `OrdinaryGetMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:597` |
| 0.3% | 17.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/index.js:12` |
| 0.3% | 17.3ms | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:57` |
| 0.3% | 17.2ms | 0.0% | 0us | `async addModule` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:72` |
| 0.3% | 17.2ms | 0.0% | 0us | `async setModule` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:97` |
| 0.3% | 17.0ms | 0.3% | 17.0ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1335` |
| 0.3% | 16.9ms | 0.0% | 0us | `async setModule` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:98` |
| 0.3% | 16.6ms | 0.3% | 16.6ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3353` |
| 0.3% | 16.3ms | 0.3% | 16.3ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` |
| 0.3% | 16.3ms | 0.0% | 0us | `Module` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:32` |
| 0.3% | 16.3ms | 0.0% | 0us | `addCoreProviders` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:98` |
| 0.3% | 16.3ms | 0.0% | 0us | `addModuleRef` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:108` |
| 0.3% | 16.2ms | 0.0% | 0us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:194` |
| 0.3% | 15.9ms | 0.0% | 0us | `get inspect` | `node:util:481` |
| 0.3% | 15.9ms | 0.0% | 0us | `lazyInspectModule` | `node:util:17` |
| 0.3% | 15.8ms | 0.0% | 0us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1712` |
| 0.3% | 15.6ms | 0.3% | 15.6ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3540` |
| 0.3% | 15.3ms | 0.0% | 187us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:104` |
| 0.3% | 14.8ms | 0.0% | 2.1ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:628` |
| 0.3% | 14.8ms | 0.3% | 14.8ms | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4471` |
| 0.2% | 14.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:8` |
| 0.2% | 14.3ms | 0.0% | 274us | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:77` |
| 0.2% | 13.8ms | 0.0% | 1.1ms | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:121` |
| 0.2% | 13.7ms | 0.0% | 1.4ms | `node:http` | `node:http:2` |
| 0.2% | 13.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/file-stream/streamable-file.js:4` |
| 0.2% | 13.6ms | 0.0% | 0us | `node:stream` | `node:stream:2` |
| 0.2% | 13.6ms | 0.0% | 184us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:52` |
| 0.2% | 13.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:16` |
| 0.2% | 13.5ms | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:113` |
| 0.2% | 13.5ms | 0.0% | 0us | `async createInstancesOfDependencies` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:19` |
| 0.2% | 13.1ms | 0.0% | 0us | `reflectDynamicMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:148` |
| 0.2% | 13.1ms | 0.0% | 384us | `OrdinaryGetMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:592` |
| 0.2% | 12.9ms | 0.2% | 12.9ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:713` |
| 0.2% | 12.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:137` |
| 0.2% | 12.8ms | 0.0% | 0us | `insertController` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:300` |
| 0.2% | 12.6ms | 0.0% | 0us | `internal:stream` | `internal:stream:2` |
| 0.2% | 12.5ms | 0.2% | 12.5ms | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5072` |
| 0.2% | 12.4ms | 0.0% | 0us | `addController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:189` |
| 0.2% | 12.4ms | 0.2% | 12.4ms | `getMetadataKey` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:20` |
| 0.2% | 12.4ms | 0.0% | 0us | `get` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:16` |
| 0.2% | 12.3ms | 0.2% | 12.3ms | `DateTimeFormat` | `[native code]` |
| 0.2% | 12.2ms | 0.2% | 12.2ms | `dispatch` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4988` |
| 0.2% | 12.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:20` |
| 0.2% | 12.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/inspector/serialized-graph.js:8` |
| 0.2% | 11.9ms | 0.2% | 11.1ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1261` |
| 0.2% | 11.7ms | 0.0% | 1.4ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5178` |
| 0.2% | 11.4ms | 0.0% | 0us | `optionalRequire` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/optional-require.js:6` |
| 0.2% | 11.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:22` |
| 0.2% | 11.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:226` |
| 0.2% | 11.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/combineAll.js:4` |
| 0.2% | 11.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:15` |
| 0.2% | 11.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:19` |
| 0.2% | 10.7ms | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:72` |
| 0.2% | 10.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/index.js:16` |
| 0.2% | 10.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/index.js:4` |
| 0.2% | 10.6ms | 0.1% | 8.8ms | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1299` |
| 0.2% | 10.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:6` |
| 0.2% | 10.4ms | 0.0% | 632us | `copyMetadataToCallback` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:229` |
| 0.2% | 10.3ms | 0.0% | 1.1ms | `from` | `[native code]` |
| 0.2% | 10.3ms | 0.2% | 10.3ms | `handler` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:36` |
| 0.2% | 10.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/index.js:14` |
| 0.2% | 10.2ms | 0.2% | 10.2ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:621` |
| 0.2% | 10.2ms | 0.0% | 0us | `getMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:453` |
| 0.2% | 10.2ms | 0.0% | 576us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:418` |
| 0.2% | 10.2ms | 0.0% | 642us | `OrdinaryHasOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:584` |
| 0.2% | 10.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/lazy-module-loader/lazy-module-loader.js:5` |
| 0.2% | 10.1ms | 0.0% | 0us | `GetMetadataProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1158` |
| 0.2% | 10.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:163` |
| 0.1% | 9.7ms | 0.0% | 0us | `internal:streams/compose` | `internal:streams/compose:2` |
| 0.1% | 9.7ms | 0.1% | 7.6ms | `reflectInjectables` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:161` |
| 0.1% | 9.5ms | 0.1% | 9.5ms | `RegExp` | `[native code]` |
| 0.1% | 9.5ms | 0.1% | 9.5ms | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5220` |
| 0.1% | 9.4ms | 0.1% | 7.8ms | `async apply` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:14` |
| 0.1% | 9.4ms | 0.1% | 9.4ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:181` |
| 0.1% | 9.3ms | 0.0% | 0us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:242` |
| 0.1% | 9.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/accepts/index.js:15` |
| 0.1% | 9.1ms | 0.0% | 0us | `internal:streams/pipeline` | `internal:streams/pipeline:2` |
| 0.1% | 8.8ms | 0.0% | 0us | `createPrototypesOfControllers` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:62` |
| 0.1% | 8.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:35` |
| 0.1% | 8.8ms | 0.0% | 0us | `createPrototypes` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:32` |
| 0.1% | 8.8ms | 0.0% | 0us | `async createInstancesOfDependencies` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:20` |
| 0.1% | 8.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:89` |
| 0.1% | 8.7ms | 0.0% | 0us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4793` |
| 0.1% | 8.6ms | 0.1% | 8.6ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:11` |
| 0.1% | 8.5ms | 0.0% | 0us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:180` |
| 0.1% | 8.5ms | 0.0% | 1.1ms | `async callback` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:70` |
| 0.1% | 8.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:42` |
| 0.1% | 8.5ms | 0.0% | 0us | `populateMaps` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:155` |
| 0.1% | 8.5ms | 0.0% | 208us | `reflectKeyMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:195` |
| 0.1% | 8.5ms | 0.1% | 8.5ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3521` |
| 0.1% | 8.4ms | 0.0% | 0us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:216` |
| 0.1% | 8.4ms | 0.0% | 397us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:963` |
| 0.1% | 8.4ms | 0.0% | 0us | `OrdinaryMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:617` |
| 0.1% | 8.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:5` |
| 0.1% | 8.2ms | 0.1% | 7.5ms | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:33` |
| 0.1% | 8.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/audit.js:5` |
| 0.1% | 8.1ms | 0.0% | 192us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:31` |
| 0.1% | 8.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/combineLatestAll.js:4` |
| 0.1% | 8.0ms | 0.1% | 8.0ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:395` |
| 0.1% | 7.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/accepts/index.js:16` |
| 0.1% | 7.9ms | 0.1% | 7.9ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3533` |
| 0.1% | 7.8ms | 0.1% | 7.8ms | `parseContentCodings` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:3669` |
| 0.1% | 7.7ms | 0.0% | 0us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:185` |
| 0.1% | 7.6ms | 0.1% | 7.6ms | `#finishAbsentBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1336` |
| 0.1% | 7.5ms | 0.0% | 0us | `OrdinaryOwnMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:653` |
| 0.1% | 7.5ms | 0.1% | 7.5ms | `OrdinaryGetMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.1% | 7.5ms | 0.1% | 7.5ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:677` |
| 0.1% | 7.5ms | 0.1% | 7.5ms | `onceResponded` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2019` |
| 0.1% | 7.3ms | 0.1% | 7.3ms | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5314` |
| 0.1% | 7.2ms | 0.0% | 0us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:131` |
| 0.1% | 7.1ms | 0.0% | 576us | `addController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:321` |
| 0.1% | 7.1ms | 0.0% | 0us | `explore` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:48` |
| 0.1% | 7.0ms | 0.0% | 961us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:73` |
| 0.1% | 7.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:28` |
| 0.1% | 6.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module-ref.js:9` |
| 0.1% | 6.8ms | 0.0% | 1.3ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:71` |
| 0.1% | 6.8ms | 0.0% | 412us | `OrdinaryOwnMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1085` |
| 0.1% | 6.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:6` |
| 0.1% | 6.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/innerFrom.js:60` |
| 0.1% | 6.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/parse-array.pipe.js:10` |
| 0.1% | 6.4ms | 0.0% | 218us | `GetIterator` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:814` |
| 0.1% | 6.4ms | 0.1% | 6.4ms | `next` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5079` |
| 0.1% | 6.3ms | 0.0% | 228us | `next` | `/home/user/bun-node/node_modules/iterare/lib/map.js:12` |
| 0.1% | 6.2ms | 0.1% | 6.2ms | `@lazy` | `[native code]` |
| 0.1% | 6.2ms | 0.1% | 6.2ms | `GetMethod` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.1% | 6.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:30` |
| 0.1% | 5.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/iterare/lib/index.js:3` |
| 0.1% | 5.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/validation.pipe.js:5` |
| 0.1% | 5.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/file/index.js:4` |
| 0.1% | 5.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/combineLatest.js:6` |
| 0.1% | 5.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/index.js:4` |
| 0.1% | 5.8ms | 0.0% | 0us | `internal:streams/duplex` | `internal:streams/duplex:2` |
| 0.1% | 5.8ms | 0.1% | 5.5ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2997` |
| 0.1% | 5.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:8` |
| 0.1% | 5.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1414` |
| 0.1% | 5.7ms | 0.0% | 424us | `createContext` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:12` |
| 0.1% | 5.7ms | 0.1% | 5.7ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3045` |
| 0.1% | 5.6ms | 0.0% | 899us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:644` |
| 0.1% | 5.6ms | 0.1% | 5.6ms | `async #parseBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3132` |
| 0.1% | 5.5ms | 0.0% | 200us | `loadPrototype` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:33` |
| 0.1% | 5.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:13` |
| 0.1% | 5.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:9` |
| 0.1% | 5.4ms | 0.1% | 5.4ms | `(unknown)` | `[native code]` |
| 0.1% | 5.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/from.js:4` |
| 0.1% | 5.4ms | 0.1% | 5.4ms | `async #awaitPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.1% | 5.4ms | 0.1% | 5.4ms | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:99` |
| 0.1% | 5.3ms | 0.0% | 0us | `node:_http_client` | `node:_http_client:10` |
| 0.1% | 5.3ms | 0.0% | 0us | `getClassDependencies` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:185` |
| 0.1% | 5.3ms | 0.0% | 579us | `async resolveProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:344` |
| 0.1% | 5.3ms | 0.0% | 0us | `async callInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:252` |
| 0.1% | 5.3ms | 0.0% | 0us | `InstanceWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:22` |
| 0.1% | 5.2ms | 0.1% | 5.2ms | `(anonymous)` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.1% | 5.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:12` |
| 0.1% | 5.1ms | 0.0% | 0us | `async callModuleInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:31` |
| 0.1% | 5.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:18` |
| 0.1% | 5.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/index.js:6` |
| 0.1% | 5.0ms | 0.1% | 5.0ms | `get` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:49` |
| 0.1% | 4.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/auditTime.js:4` |
| 0.0% | 4.8ms | 0.0% | 4.8ms | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 4.8ms | 0.0% | 795us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:169` |
| 0.0% | 4.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js:4` |
| 0.0% | 4.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/index.js:5` |
| 0.0% | 4.6ms | 0.0% | 2.4ms | `OrdinaryGetMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:595` |
| 0.0% | 4.6ms | 0.0% | 0us | `async createInstancesOfDependencies` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:22` |
| 0.0% | 4.6ms | 0.0% | 4.4ms | `getProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:950` |
| 0.0% | 4.6ms | 0.0% | 0us | `OrdinaryDefineOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:611` |
| 0.0% | 4.6ms | 0.0% | 0us | `async registerModules` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:80` |
| 0.0% | 4.6ms | 0.0% | 0us | `async init` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:103` |
| 0.0% | 4.5ms | 0.0% | 0us | `copyMetadataToCallback` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:230` |
| 0.0% | 4.5ms | 0.0% | 4.5ms | `(module)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:28` |
| 0.0% | 4.4ms | 0.0% | 0us | `async createInstances` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:38` |
| 0.0% | 4.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:6` |
| 0.0% | 4.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:8` |
| 0.0% | 4.4ms | 0.0% | 377us | `reflectConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:219` |
| 0.0% | 4.4ms | 0.0% | 0us | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:57` |
| 0.0% | 4.3ms | 0.0% | 4.3ms | `node:fs` | `node:fs:8` |
| 0.0% | 4.3ms | 0.0% | 4.3ms | `set` | `[native code]` |
| 0.0% | 4.3ms | 0.0% | 619us | `next` | `/home/user/bun-node/node_modules/iterare/lib/filter.js:12` |
| 0.0% | 4.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:17` |
| 0.0% | 4.3ms | 0.0% | 4.3ms | `indexOf` | `[native code]` |
| 0.0% | 4.3ms | 0.0% | 766us | `initialize` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:341` |
| 0.0% | 4.2ms | 0.0% | 187us | `async createInstances` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:39` |
| 0.0% | 4.2ms | 0.0% | 4.2ms | `create` | `[native code]` |
| 0.0% | 4.2ms | 0.0% | 4.2ms | `#initWithoutHeaders` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:581` |
| 0.0% | 4.2ms | 0.0% | 4.2ms | `node:zlib` | `node:zlib:2` |
| 0.0% | 4.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js:4` |
| 0.0% | 4.1ms | 0.0% | 0us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:435` |
| 0.0% | 4.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:17` |
| 0.0% | 4.1ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/src/index.js:5` |
| 0.0% | 4.0ms | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:39` |
| 0.0% | 4.0ms | 0.0% | 0us | `applyProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:411` |
| 0.0% | 4.0ms | 0.0% | 482us | `isObject` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:6` |
| 0.0% | 4.0ms | 0.0% | 0us | `defineMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:244` |
| 0.0% | 4.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:22` |
| 0.0% | 3.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/repl.js:9` |
| 0.0% | 3.9ms | 0.0% | 211us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:20` |
| 0.0% | 3.9ms | 0.0% | 0us | `GetMetadataProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1163` |
| 0.0% | 3.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/guards/index.js:6` |
| 0.0% | 3.8ms | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:40` |
| 0.0% | 3.8ms | 0.0% | 0us | `async createInstancesOfProviders` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:52` |
| 0.0% | 3.8ms | 0.0% | 0us | `async createInstancesOfProviders` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:55` |
| 0.0% | 3.8ms | 0.0% | 0us | `_preferredType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:189` |
| 0.0% | 3.8ms | 0.0% | 788us | `reflectInjectables` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:159` |
| 0.0% | 3.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:15` |
| 0.0% | 3.7ms | 0.0% | 3.7ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:645` |
| 0.0% | 3.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:11` |
| 0.0% | 3.7ms | 0.0% | 411us | `next` | `/home/user/bun-node/node_modules/iterare/lib/map.js:13` |
| 0.0% | 3.7ms | 0.0% | 3.7ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:625` |
| 0.0% | 3.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:13` |
| 0.0% | 3.7ms | 0.0% | 3.7ms | `isEmpty` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js` |
| 0.0% | 3.6ms | 0.0% | 3.6ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:514` |
| 0.0% | 3.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:15` |
| 0.0% | 3.6ms | 0.0% | 3.6ms | `isNil` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:46` |
| 0.0% | 3.6ms | 0.0% | 3.6ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:691` |
| 0.0% | 3.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/index.js:4` |
| 0.0% | 3.5ms | 0.0% | 0us | `Mime` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:13` |
| 0.0% | 3.5ms | 0.0% | 3.5ms | `assign` | `[native code]` |
| 0.0% | 3.5ms | 0.0% | 1.0ms | `__exportStar` | `/home/user/bun-node/node_modules/tslib/tslib.js:203` |
| 0.0% | 3.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/async.js:4` |
| 0.0% | 3.4ms | 0.0% | 3.4ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3530` |
| 0.0% | 3.4ms | 0.0% | 0us | `__decorate` | `/home/user/bun-node/node_modules/tslib/tslib.js:106` |
| 0.0% | 3.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:10` |
| 0.0% | 3.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/repl-context.js:8` |
| 0.0% | 3.4ms | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:55` |
| 0.0% | 3.4ms | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:56` |
| 0.0% | 3.4ms | 0.0% | 0us | `async loadProvider` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:106` |
| 0.0% | 3.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/node_modules/mime-db/index.js:12` |
| 0.0% | 3.3ms | 0.0% | 0us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:59` |
| 0.0% | 3.2ms | 0.0% | 187us | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2998` |
| 0.0% | 3.2ms | 0.0% | 3.0ms | `parseQuery` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2991` |
| 0.0% | 3.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-types/index.js:15` |
| 0.0% | 3.2ms | 0.0% | 0us | `async loadProvider` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:111` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `onceResponded` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `isObservable` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/isObservable.js:7` |
| 0.0% | 3.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncAction.js:20` |
| 0.0% | 3.1ms | 0.0% | 209us | `createContext` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:8` |
| 0.0% | 3.1ms | 0.0% | 0us | `node:vm` | `node:vm:12` |
| 0.0% | 3.1ms | 0.0% | 205us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:84` |
| 0.0% | 3.1ms | 0.0% | 3.1ms | `get query` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 3.0ms | 0.0% | 0us | `loadPrototype` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:35` |
| 0.0% | 3.0ms | 0.0% | 0us | `createCallbackProxy` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:188` |
| 0.0% | 3.0ms | 0.0% | 3.0ms | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:413` |
| 0.0% | 3.0ms | 0.0% | 0us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:62` |
| 0.0% | 3.0ms | 0.0% | 303us | `reflectMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:324` |
| 0.0% | 3.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-db/index.js:12` |
| 0.0% | 3.0ms | 0.0% | 3.0ms | `addController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` |
| 0.0% | 2.9ms | 0.0% | 217us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:70` |
| 0.0% | 2.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:13` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:697` |
| 0.0% | 2.9ms | 0.0% | 0us | `async init` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:102` |
| 0.0% | 2.9ms | 0.0% | 0us | `async callModuleInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:42` |
| 0.0% | 2.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/file/file-type.validator.js:4` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `InstanceWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:18` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:15` |
| 0.0% | 2.8ms | 0.0% | 0us | `populateMaps` | `/home/user/bun-node/node_modules/mime-types/index.js:158` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-types/index.js:40` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js:5` |
| 0.0% | 2.8ms | 0.0% | 205us | `async resolveProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:352` |
| 0.0% | 2.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:33` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `async #parseBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 2.8ms | 0.0% | 0us | `next` | `/home/user/bun-node/node_modules/iterare/lib/filter.js:13` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3546` |
| 0.0% | 2.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/index.js:3` |
| 0.0% | 2.7ms | 0.0% | 2.7ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js` |
| 0.0% | 2.7ms | 0.0% | 0us | `node:fs/promises` | `node:fs/promises:2` |
| 0.0% | 2.7ms | 0.0% | 0us | `internal:fs/binding` | `internal:fs/binding:3` |
| 0.0% | 2.7ms | 0.0% | 0us | `registerParserMiddleware` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1282` |
| 0.0% | 2.7ms | 0.0% | 0us | `registerParserMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:115` |
| 0.0% | 2.7ms | 0.0% | 236us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:21` |
| 0.0% | 2.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter-context.js:9` |
| 0.0% | 2.6ms | 0.0% | 0us | `async registerModules` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:86` |
| 0.0% | 2.6ms | 0.0% | 0us | `async register` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:26` |
| 0.0% | 2.6ms | 0.0% | 233us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:19` |
| 0.0% | 2.6ms | 0.0% | 395us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:40` |
| 0.0% | 2.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:121` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `finish` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:678` |
| 0.0% | 2.6ms | 0.0% | 1.1ms | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:179` |
| 0.0% | 2.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/combineLatestAll.js:5` |
| 0.0% | 2.6ms | 0.0% | 1.4ms | `createContext` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:14` |
| 0.0% | 2.6ms | 0.0% | 236us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:125` |
| 0.0% | 2.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/index.js:41` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `reply` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 2.5ms | 0.0% | 0us | `use` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1617` |
| 0.0% | 2.5ms | 0.0% | 0us | `registerBodyParser` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:840` |
| 0.0% | 2.5ms | 0.0% | 0us | `reflectDynamicMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:146` |
| 0.0% | 2.5ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:54` |
| 0.0% | 2.5ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:13` |
| 0.0% | 2.5ms | 0.0% | 863us | `getProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:955` |
| 0.0% | 2.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:50` |
| 0.0% | 2.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:18` |
| 0.0% | 2.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/index.js:4` |
| 0.0% | 2.4ms | 0.0% | 0us | `next` | `/home/user/bun-node/node_modules/iterare/lib/flatten.js:20` |
| 0.0% | 2.4ms | 0.0% | 0us | `async callModuleInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:44` |
| 0.0% | 2.4ms | 0.0% | 0us | `reflectProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:402` |
| 0.0% | 2.4ms | 0.0% | 0us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:33` |
| 0.0% | 2.4ms | 0.0% | 410us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:430` |
| 0.0% | 2.4ms | 0.0% | 2.4ms | `hasProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 2.4ms | 0.0% | 0us | `setProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:971` |
| 0.0% | 2.4ms | 0.0% | 197us | `scanForPaths` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:15` |
| 0.0% | 2.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:17` |
| 0.0% | 2.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:6` |
| 0.0% | 2.3ms | 0.0% | 0us | `async init` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:104` |
| 0.0% | 2.3ms | 0.0% | 0us | `flushPending` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4223` |
| 0.0% | 2.3ms | 0.0% | 0us | `use` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4238` |
| 0.0% | 2.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:166` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `getProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 2.3ms | 0.0% | 2.3ms | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 2.3ms | 0.0% | 0us | `OrdinaryHasOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:587` |
| 0.0% | 2.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/opaque-key-factory/by-reference-module-opaque-key-factory.js:5` |
| 0.0% | 2.2ms | 0.0% | 0us | `async register` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:38` |
| 0.0% | 2.2ms | 0.0% | 0us | `async resolveMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:40` |
| 0.0% | 2.2ms | 0.0% | 2.2ms | `split` | `[native code]` |
| 0.0% | 2.2ms | 0.0% | 2.2ms | `push` | `[native code]` |
| 0.0% | 2.2ms | 0.0% | 2.2ms | `node:stream/web` | `node:stream/web:6` |
| 0.0% | 2.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:40` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `applySettlementSignal` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `fromContainer` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js` |
| 0.0% | 2.1ms | 0.0% | 0us | `async registerMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:323` |
| 0.0% | 2.1ms | 0.0% | 0us | `async registerRouter` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:117` |
| 0.0% | 2.1ms | 0.0% | 0us | `async registerRouter` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:118` |
| 0.0% | 2.1ms | 0.0% | 0us | `async registerMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:324` |
| 0.0% | 2.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:42` |
| 0.0% | 2.1ms | 0.0% | 209us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:32` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `defineProperty` | `[native code]` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `getStatusByMethod` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:39` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:19` |
| 0.0% | 2.0ms | 0.0% | 522us | `reflectDynamicMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:147` |
| 0.0% | 2.0ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:91` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `#respond` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:482` |
| 0.0% | 2.0ms | 0.0% | 0us | `async resolveMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:46` |
| 0.0% | 2.0ms | 0.0% | 0us | `async loadMiddlewareConfiguration` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:42` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delay.js:5` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/file/index.js:8` |
| 0.0% | 2.0ms | 0.0% | 224us | `async init` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:105` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/file-stream/streamable-file.js:5` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/index.js:13` |
| 0.0% | 2.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:22` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 1.9ms | 0.0% | 0us | `internal:streams/operators` | `internal:streams/operators:2` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:118` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:24` |
| 0.0% | 1.9ms | 0.0% | 0us | `async registerMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:71` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3029` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:18` |
| 0.0% | 1.9ms | 0.0% | 216us | `async registerModules` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:81` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:62` |
| 0.0% | 1.9ms | 0.0% | 1.0ms | `getClassDependencies` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:186` |
| 0.0% | 1.9ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:39` |
| 0.0% | 1.8ms | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:43` |
| 0.0% | 1.8ms | 0.0% | 0us | `async loadConfiguration` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:48` |
| 0.0% | 1.8ms | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:9` |
| 0.0% | 1.8ms | 0.0% | 0us | `createDebug` | `/home/user/bun-node/node_modules/debug/src/common.js:117` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:54` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:196` |
| 0.0% | 1.8ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/context/exception-filters-context.js:7` |
| 0.0% | 1.8ms | 0.0% | 0us | `internal:streams/destroy` | `internal:streams/destroy:2` |
| 0.0% | 1.8ms | 0.0% | 0us | `internal:errors` | `internal:errors:2` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `RouteController` | `[native code]` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 1.8ms | 0.0% | 0us | `async callInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:249` |
| 0.0% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/asap.js:4` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1203` |
| 0.0% | 1.7ms | 0.0% | 187us | `isInContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:501` |
| 0.0% | 1.7ms | 0.0% | 0us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:422` |
| 0.0% | 1.7ms | 0.0% | 0us | `applySettlementSignal` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:115` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `importModule` | `[native code]` |
| 0.0% | 1.7ms | 0.0% | 0us | `async create` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:44` |
| 0.0% | 1.7ms | 0.0% | 0us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:56` |
| 0.0% | 1.7ms | 0.0% | 0us | `async registerAllConfigs` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:73` |
| 0.0% | 1.7ms | 0.0% | 0us | `async registerMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:95` |
| 0.0% | 1.7ms | 0.0% | 0us | `DecorateConstructor` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:549` |
| 0.0% | 1.7ms | 0.0% | 0us | `decorate` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:143` |
| 0.0% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:14` |
| 0.0% | 1.7ms | 0.0% | 580us | `addLeadingSlash` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:25` |
| 0.0% | 1.7ms | 0.0% | 0us | `registerWsModule` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:92` |
| 0.0% | 1.7ms | 0.0% | 0us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:65` |
| 0.0% | 1.7ms | 0.0% | 0us | `fromContainer` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:38` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `ExternalExceptionFilterContext` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter-context.js` |
| 0.0% | 1.7ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:32` |
| 0.0% | 1.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:11` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `OrdinaryMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 1.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:240` |
| 0.0% | 1.6ms | 0.0% | 0us | `configure` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:71` |
| 0.0% | 1.6ms | 0.0% | 0us | `async loadConfiguration` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:55` |
| 0.0% | 1.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:5` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:26` |
| 0.0% | 1.6ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/enums/index.js:6` |
| 0.0% | 1.6ms | 0.0% | 0us | `async callModuleBootstrapHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js:31` |
| 0.0% | 1.6ms | 0.0% | 0us | `async callBootstrapHook` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:274` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:19` |
| 0.0% | 1.6ms | 0.0% | 0us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:30` |
| 0.0% | 1.6ms | 0.0% | 259us | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js:158` |
| 0.0% | 1.6ms | 0.0% | 214us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:131` |
| 0.0% | 1.6ms | 0.0% | 187us | `isStatic` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:250` |
| 0.0% | 1.6ms | 0.0% | 603us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:39` |
| 0.0% | 1.5ms | 0.0% | 0us | `DecorateProperty` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:561` |
| 0.0% | 1.5ms | 0.0% | 0us | `decorate` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:136` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3044` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/connect.js:4` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:20` |
| 0.0% | 1.5ms | 0.0% | 0us | `internal:streams/legacy` | `internal:streams/legacy:2` |
| 0.0% | 1.5ms | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:90` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `getMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 1.5ms | 0.0% | 0us | `async scan` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:33` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:20` |
| 0.0% | 1.5ms | 0.0% | 0us | `decorator` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:195` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `async middlewareHandler` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/zip.js:25` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:23` |
| 0.0% | 1.5ms | 0.0% | 0us | `async registerMiddlewareConfig` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:98` |
| 0.0% | 1.5ms | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:75` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:12` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:16` |
| 0.0% | 1.5ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:374` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:14` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `getOwnPropertyDescriptor` | `[native code]` |
| 0.0% | 1.4ms | 0.0% | 1.4ms | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1396` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/single.js:5` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exceptions-handler.js:6` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:23` |
| 0.0% | 1.4ms | 0.0% | 0us | `async callModuleInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:43` |
| 0.0% | 1.4ms | 0.0% | 1.0ms | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:43` |
| 0.0% | 1.4ms | 0.0% | 0us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:43` |
| 0.0% | 1.4ms | 0.0% | 405us | `createContext` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:13` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/dematerialize.js:4` |
| 0.0% | 1.4ms | 0.0% | 0us | `addController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:327` |
| 0.0% | 1.4ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/index.js:6` |
| 0.0% | 1.4ms | 0.0% | 0us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1305` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/lazy-module-loader/lazy-module-loader.js:4` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/joinAllInternals.js:7` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `normalizePath` | `/home/user/bun-node/node_modules/@nestjs/core/adapters/http-adapter.js` |
| 0.0% | 1.3ms | 0.0% | 1.0ms | `replace` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:106` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/index.js:4` |
| 0.0% | 1.3ms | 0.0% | 188us | `iterate` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js:209` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:5` |
| 0.0% | 1.3ms | 0.0% | 181us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:183` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/index.js:5` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `get` | `/home/user/bun-node/node_modules/tslib/tslib.js:210` |
| 0.0% | 1.3ms | 0.0% | 890us | `OrdinaryHasOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1058` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:20` |
| 0.0% | 1.3ms | 0.0% | 0us | `getClassScope` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/get-class-scope.js:6` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:31` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `getMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:369` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:951` |
| 0.0% | 1.3ms | 0.0% | 0us | `register` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:31` |
| 0.0% | 1.3ms | 0.0% | 0us | `async init` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:106` |
| 0.0% | 1.3ms | 0.0% | 886us | `createHandleResponseFn` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:159` |
| 0.0% | 1.3ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:9` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:6` |
| 0.0% | 1.2ms | 0.0% | 0us | `async registerRouteMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:104` |
| 0.0% | 1.2ms | 0.0% | 0us | `async registerMiddlewareConfig` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:101` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/async.js:5` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/multicast.js:4` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:43` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:25` |
| 0.0% | 1.2ms | 0.0% | 0us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:58` |
| 0.0% | 1.2ms | 0.0% | 0us | `node:tty` | `node:tty:7` |
| 0.0% | 1.2ms | 0.0% | 193us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:174` |
| 0.0% | 1.2ms | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:60` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `async loadController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:98` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/exceptions/ws-exceptions-handler.js:7` |
| 0.0% | 1.2ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:138` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:52` |
| 0.0% | 1.2ms | 0.0% | 0us | `async registerHandler` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:189` |
| 0.0% | 1.1ms | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:44` |
| 0.0% | 1.1ms | 0.0% | 0us | `async resolveInstances` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js:9` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `createPrototype` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:228` |
| 0.0% | 1.1ms | 0.0% | 0us | `node:_http_agent` | `node:_http_agent:2` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:13` |
| 0.0% | 1.1ms | 0.0% | 0us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:32` |
| 0.0% | 1.1ms | 0.0% | 192us | `exploreMethodMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:32` |
| 0.0% | 1.1ms | 0.0% | 0us | `exploreMethodMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:34` |
| 0.0% | 1.1ms | 0.0% | 788us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:122` |
| 0.0% | 1.1ms | 0.0% | 205us | `node:_http_common` | `node:_http_common:2` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:134` |
| 0.0% | 1.1ms | 0.0% | 0us | `addScopedEnhancersMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:339` |
| 0.0% | 1.1ms | 0.0% | 225us | `InstanceWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:24` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:26` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `has` | `[native code]` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:4` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:30` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `OrdinaryOwnMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:13` |
| 0.0% | 1.1ms | 0.0% | 0us | `forEach` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js:157` |
| 0.0% | 1.1ms | 0.0% | 0us | `connectAllGateways` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:36` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:122` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:4` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:247` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:6` |
| 0.0% | 1.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:8` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:17` |
| 0.0% | 1.0ms | 0.0% | 0us | `async bindHandler` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:134` |
| 0.0% | 1.0ms | 0.0% | 0us | `async registerRouteMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:131` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:136` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `async setModule` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:105` |
| 0.0% | 1.0ms | 0.0% | 0us | `forEach` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js:153` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:16` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/combineLatest.js:8` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `async transformToResult` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:31` |
| 0.0% | 1.0ms | 0.0% | 544us | `get instance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:33` |
| 0.0% | 1.0ms | 0.0% | 202us | `reflectKeyMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:191` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/joinAllInternals.js:8` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/routes-mapper.js:9` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:105` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/inspector/serialized-graph.js:12` |
| 0.0% | 1.0ms | 0.0% | 206us | `setProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:984` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/animationFrame.js:5` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:68` |
| 0.0% | 1.0ms | 0.0% | 196us | `getArgumentsLength` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:23` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js:26` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:10` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `isDependencyTreeStatic` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:178` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:4` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/index.js:5` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:9` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/index.js:4` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/tslib/tslib.js:112` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:159` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/index.js:4` |
| 0.0% | 1.0ms | 0.0% | 0us | `async callModuleBootstrapHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js:42` |
| 0.0% | 1.0ms | 0.0% | 606us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:112` |
| 0.0% | 1.0ms | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:158` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `async resolveComponentHost` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:136` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/guards/index.js:5` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/catch.decorator.js:4` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:5` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:3236` |
| 0.0% | 1.0ms | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:105` |
| 0.0% | 1.0ms | 0.0% | 371us | `filter` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 0us | `async resolveParam` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:134` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `#configuredCookieSecrets` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1407` |
| 0.0% | 999us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:168` |
| 0.0% | 999us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:14` |
| 0.0% | 994us | 0.0% | 0us | `async loadController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:100` |
| 0.0% | 994us | 0.0% | 784us | `async loadEnhancersPerContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:456` |
| 0.0% | 993us | 0.0% | 993us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:104` |
| 0.0% | 992us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/inspector/index.js:4` |
| 0.0% | 988us | 0.0% | 0us | `OrdinaryDefineOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:612` |
| 0.0% | 985us | 0.0% | 0us | `async resolveInstance` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js:11` |
| 0.0% | 985us | 0.0% | 0us | `async resolveInstances` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js:12` |
| 0.0% | 985us | 0.0% | 0us | `async resolveMiddlewareInstance` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js:14` |
| 0.0% | 968us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:23` |
| 0.0% | 967us | 0.0% | 444us | `OrdinaryHasOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1061` |
| 0.0% | 963us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:132` |
| 0.0% | 963us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/publishBehavior.js:4` |
| 0.0% | 963us | 0.0% | 963us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:171` |
| 0.0% | 955us | 0.0% | 955us | `IteratorWithOperators` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js` |
| 0.0% | 953us | 0.0% | 953us | `SettlementSignal` | `/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js` |
| 0.0% | 950us | 0.0% | 0us | `createErrorClass` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/createErrorClass.js:9` |
| 0.0% | 943us | 0.0% | 943us | `substring` | `[native code]` |
| 0.0% | 939us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js:5` |
| 0.0% | 932us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:12` |
| 0.0% | 920us | 0.0% | 0us | `async registerRouterHooks` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:124` |
| 0.0% | 913us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:170` |
| 0.0% | 912us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:63` |
| 0.0% | 912us | 0.0% | 0us | `internal:validators` | `internal:validators:2` |
| 0.0% | 909us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/dom/animationFrames.js:6` |
| 0.0% | 907us | 0.0% | 907us | `createResolutionContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 906us | 0.0% | 906us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 906us | 0.0% | 0us | `explore` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:47` |
| 0.0% | 905us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:7` |
| 0.0% | 904us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:220` |
| 0.0% | 904us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:11` |
| 0.0% | 900us | 0.0% | 0us | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:78` |
| 0.0% | 900us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:127` |
| 0.0% | 900us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:10` |
| 0.0% | 900us | 0.0% | 0us | `async scanModulesForDependencies` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:107` |
| 0.0% | 900us | 0.0% | 0us | `reflectProviders` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:126` |
| 0.0% | 900us | 0.0% | 900us | `next` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 900us | 0.0% | 900us | `getPrototypeOf` | `[native code]` |
| 0.0% | 897us | 0.0% | 0us | `applyProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:415` |
| 0.0% | 891us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:101` |
| 0.0% | 891us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:92` |
| 0.0% | 888us | 0.0% | 888us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:962` |
| 0.0% | 881us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:91` |
| 0.0% | 879us | 0.0% | 879us | `get originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` |
| 0.0% | 879us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/utils/index.js:4` |
| 0.0% | 878us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:12` |
| 0.0% | 878us | 0.0% | 878us | `getDeprecationWarningEmitter` | `internal:util/deprecate:3` |
| 0.0% | 878us | 0.0% | 0us | `node:_http_outgoing` | `node:_http_outgoing:700` |
| 0.0% | 878us | 0.0% | 0us | `deprecate` | `internal:util/deprecate:17` |
| 0.0% | 877us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:19` |
| 0.0% | 877us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delayWhen.js:5` |
| 0.0% | 877us | 0.0% | 468us | `reflectOptionalParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:226` |
| 0.0% | 873us | 0.0% | 0us | `applyProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:416` |
| 0.0% | 873us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:10` |
| 0.0% | 871us | 0.0% | 871us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5013` |
| 0.0% | 870us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:10` |
| 0.0% | 870us | 0.0% | 0us | `async bindHandler` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:141` |
| 0.0% | 868us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:16` |
| 0.0% | 868us | 0.0% | 868us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:37` |
| 0.0% | 864us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapAction.js:20` |
| 0.0% | 862us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter-context.js:8` |
| 0.0% | 858us | 0.0% | 0us | `async callBootstrapHook` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:271` |
| 0.0% | 858us | 0.0% | 0us | `async init` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:107` |
| 0.0% | 856us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:38` |
| 0.0% | 856us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/publishReplay.js:4` |
| 0.0% | 854us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:12` |
| 0.0% | 853us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/index.js:23` |
| 0.0% | 853us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:4` |
| 0.0% | 852us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/toArray.js:4` |
| 0.0% | 851us | 0.0% | 0us | `getProviderNoCache` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:920` |
| 0.0% | 851us | 0.0% | 851us | `isProviderFor` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 847us | 0.0% | 224us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js:25` |
| 0.0% | 847us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/tslib/tslib.js:212` |
| 0.0% | 845us | 0.0% | 0us | `#compileMiddlewareRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:209` |
| 0.0% | 845us | 0.0% | 845us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js:13` |
| 0.0% | 845us | 0.0% | 845us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs` |
| 0.0% | 844us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:234` |
| 0.0% | 843us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/audit.js:4` |
| 0.0% | 843us | 0.0% | 843us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:155` |
| 0.0% | 842us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/index.js:4` |
| 0.0% | 840us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/context/ws-context-creator.js:11` |
| 0.0% | 840us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/modules/index.js:5` |
| 0.0% | 840us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:192` |
| 0.0% | 840us | 0.0% | 403us | `SettlementSignal` | `/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js:13` |
| 0.0% | 837us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:144` |
| 0.0% | 835us | 0.0% | 835us | `hasOnModuleInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:13` |
| 0.0% | 834us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module-ref.js:7` |
| 0.0% | 831us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/auditTime.js:6` |
| 0.0% | 826us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:83` |
| 0.0% | 826us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/bindCallback.js:4` |
| 0.0% | 823us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/queue.js:4` |
| 0.0% | 823us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:15` |
| 0.0% | 823us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/exhaust.js:4` |
| 0.0% | 823us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/guards/guards-consumer.js:6` |
| 0.0% | 823us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:8` |
| 0.0% | 816us | 0.0% | 0us | `createContext` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:10` |
| 0.0% | 813us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:174` |
| 0.0% | 812us | 0.0% | 0us | `useMethod` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4294` |
| 0.0% | 808us | 0.0% | 0us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:70` |
| 0.0% | 807us | 0.0% | 807us | `isDependencyTreeStatic` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:186` |
| 0.0% | 805us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:4` |
| 0.0% | 803us | 0.0% | 803us | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 802us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:15` |
| 0.0% | 800us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:224` |
| 0.0% | 800us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:25` |
| 0.0% | 800us | 0.0% | 800us | `RequestMapping` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/request-mapping.decorator.js` |
| 0.0% | 799us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:11` |
| 0.0% | 797us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:176` |
| 0.0% | 797us | 0.0% | 797us | `arrayIteratorNextHelper` | `[native code]` |
| 0.0% | 796us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:10` |
| 0.0% | 794us | 0.0% | 794us | `init` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 793us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:29` |
| 0.0% | 793us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:53` |
| 0.0% | 792us | 0.0% | 792us | `async resolveProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 792us | 0.0% | 792us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js:19` |
| 0.0% | 790us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/serializer/index.js:5` |
| 0.0% | 790us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/index.js:4` |
| 0.0% | 790us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:230` |
| 0.0% | 789us | 0.0% | 789us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:176` |
| 0.0% | 788us | 0.0% | 788us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js` |
| 0.0% | 785us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/race.js:26` |
| 0.0% | 782us | 0.0% | 782us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:177` |
| 0.0% | 781us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:17` |
| 0.0% | 774us | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:75` |
| 0.0% | 774us | 0.0% | 592us | `complete` | `/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js:22` |
| 0.0% | 772us | 0.0% | 0us | `async resolveMiddlewareInstance` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js:15` |
| 0.0% | 772us | 0.0% | 0us | `async loadMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:88` |
| 0.0% | 767us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/index.js:5` |
| 0.0% | 764us | 0.0% | 378us | `host` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3577` |
| 0.0% | 764us | 0.0% | 0us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:415` |
| 0.0% | 761us | 0.0% | 0us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:266` |
| 0.0% | 758us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/index.js:8` |
| 0.0% | 754us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:172` |
| 0.0% | 750us | 0.0% | 750us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 747us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/mime-types/index.js:16` |
| 0.0% | 744us | 0.0% | 744us | `registerNotFoundHandler` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:73` |
| 0.0% | 743us | 0.0% | 743us | `(anonymous)` | `/home/user/bun-node/node_modules/tslib/tslib.js` |
| 0.0% | 740us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module-ref.js:6` |
| 0.0% | 738us | 0.0% | 547us | `reflectParamInjectables` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:175` |
| 0.0% | 736us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:457` |
| 0.0% | 736us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/publishLast.js:4` |
| 0.0% | 736us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/elementAt.js:6` |
| 0.0% | 735us | 0.0% | 735us | `OrdinaryGetPrototypeOf` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:847` |
| 0.0% | 732us | 0.0% | 732us | `Number` | `[native code]` |
| 0.0% | 732us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Notification.js:5` |
| 0.0% | 732us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:12` |
| 0.0% | 731us | 0.0% | 731us | `get isTransient` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:43` |
| 0.0% | 724us | 0.0% | 510us | `get name` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:45` |
| 0.0% | 719us | 0.0% | 719us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:433` |
| 0.0% | 718us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/index.js:4` |
| 0.0% | 717us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:126` |
| 0.0% | 714us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:45` |
| 0.0% | 713us | 0.0% | 713us | `performIteration` | `[native code]` |
| 0.0% | 711us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:189` |
| 0.0% | 711us | 0.0% | 711us | `dirname` | `[native code]` |
| 0.0% | 711us | 0.0% | 0us | `bound dirname` | `[native code]` |
| 0.0% | 709us | 0.0% | 0us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:83` |
| 0.0% | 709us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:16` |
| 0.0% | 708us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:8` |
| 0.0% | 705us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscription.js:37` |
| 0.0% | 700us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/bad-gateway.exception.js:5` |
| 0.0% | 698us | 0.0% | 0us | `OrdinaryGetMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:594` |
| 0.0% | 698us | 0.0% | 306us | `OrdinaryGetOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:606` |
| 0.0% | 697us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:15` |
| 0.0% | 691us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:198` |
| 0.0% | 690us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/mergeMap.js:7` |
| 0.0% | 690us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discovery-module.js:6` |
| 0.0% | 687us | 0.0% | 0us | `instance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:33` |
| 0.0% | 687us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/web-sockets-controller.js:10` |
| 0.0% | 687us | 0.0% | 687us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5066` |
| 0.0% | 687us | 0.0% | 687us | `getInstanceByContextId` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.0% | 685us | 0.0% | 685us | `#settleLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 683us | 0.0% | 683us | `getStatusByMethod` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:42` |
| 0.0% | 674us | 0.0% | 188us | `inspectInstanceWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discoverable-meta-host-collection.js:53` |
| 0.0% | 672us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/repl.js:10` |
| 0.0% | 670us | 0.0% | 0us | `async createProxy` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:164` |
| 0.0% | 670us | 0.0% | 207us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:13` |
| 0.0% | 669us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/index.js:7` |
| 0.0% | 666us | 0.0% | 0us | `Module` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:33` |
| 0.0% | 666us | 0.0% | 666us | `generateUuid` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` |
| 0.0% | 666us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:7` |
| 0.0% | 664us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:23` |
| 0.0% | 664us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/concat.js:26` |
| 0.0% | 662us | 0.0% | 662us | `get` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:64` |
| 0.0% | 661us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:97` |
| 0.0% | 661us | 0.0% | 661us | `GetOrCreateMetadataMap` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 661us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/ConnectableObservable.js:21` |
| 0.0% | 660us | 0.0% | 0us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:84` |
| 0.0% | 660us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:12` |
| 0.0% | 655us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:7` |
| 0.0% | 652us | 0.0% | 0us | `setup` | `/home/user/bun-node/node_modules/debug/src/common.js:14` |
| 0.0% | 652us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/queue.js:5` |
| 0.0% | 652us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:48` |
| 0.0% | 649us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/asap.js:5` |
| 0.0% | 648us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:14` |
| 0.0% | 648us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/onErrorResumeNextWith.js:26` |
| 0.0% | 647us | 0.0% | 0us | `exploreMethodMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:27` |
| 0.0% | 647us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/animationFrame.js:4` |
| 0.0% | 645us | 0.0% | 0us | `initialize` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:340` |
| 0.0% | 645us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:214` |
| 0.0% | 645us | 0.0% | 645us | `copyDataProperties` | `[native code]` |
| 0.0% | 644us | 0.0% | 0us | `async registerHandler` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:168` |
| 0.0% | 644us | 0.0% | 0us | `async registerHandler` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:170` |
| 0.0% | 643us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/negotiator/index.js:13` |
| 0.0% | 643us | 0.0% | 0us | `addController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:331` |
| 0.0% | 642us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:44` |
| 0.0% | 641us | 0.0% | 0us | `forRoutes` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js:55` |
| 0.0% | 641us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/types/multipart.js:5` |
| 0.0% | 641us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:150` |
| 0.0% | 640us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/index.js:5` |
| 0.0% | 639us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/invalid-exception-filter.exception.js:5` |
| 0.0% | 639us | 0.0% | 639us | `keys` | `[native code]` |
| 0.0% | 636us | 0.0% | 636us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:185` |
| 0.0% | 636us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/sockets-container.js:4` |
| 0.0% | 636us | 0.0% | 636us | `getHashes` | `[native code]` |
| 0.0% | 636us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js:19` |
| 0.0% | 636us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/object-hash/index.js:57` |
| 0.0% | 636us | 0.0% | 636us | `OrdinaryGetPrototypeOf` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:846` |
| 0.0% | 635us | 0.0% | 429us | `setProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:974` |
| 0.0% | 634us | 0.0% | 183us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:20` |
| 0.0% | 633us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:8` |
| 0.0% | 633us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/opaque-key-factory/deep-hashed-module-opaque-key-factory.js:8` |
| 0.0% | 632us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:12` |
| 0.0% | 632us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/invalid-exception-filter.exception.js:4` |
| 0.0% | 631us | 0.0% | 0us | `internal:streams/end-of-stream` | `internal:streams/end-of-stream:17` |
| 0.0% | 631us | 0.0% | 631us | `exchangeKeysForValues` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:101` |
| 0.0% | 631us | 0.0% | 0us | `applyCallbackToRouter` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:81` |
| 0.0% | 629us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/dom/animationFrames.js:5` |
| 0.0% | 629us | 0.0% | 0us | `connectGatewayToServer` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:39` |
| 0.0% | 627us | 0.0% | 627us | `getProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:947` |
| 0.0% | 627us | 0.0% | 0us | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:69` |
| 0.0% | 627us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:24` |
| 0.0% | 626us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/single.js:6` |
| 0.0% | 625us | 0.0% | 219us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/optional.decorator.js:22` |
| 0.0% | 624us | 0.0% | 0us | `node:crypto` | `node:crypto:190` |
| 0.0% | 624us | 0.0% | 624us | `::bunternal::` | `internal:validators` |
| 0.0% | 624us | 0.0% | 0us | `deprecate` | `internal:util/deprecate:16` |
| 0.0% | 623us | 0.0% | 0us | `internal:util/inspect` | `internal:util/inspect:46` |
| 0.0% | 623us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:9` |
| 0.0% | 622us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:38` |
| 0.0% | 620us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:156` |
| 0.0% | 618us | 0.0% | 0us | `NestApplication` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:46` |
| 0.0% | 616us | 0.0% | 211us | `reflectInjectables` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:170` |
| 0.0% | 616us | 0.0% | 616us | `OrdinaryGetPrototypeOf` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:858` |
| 0.0% | 616us | 0.0% | 0us | `concatPaths` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:67` |
| 0.0% | 616us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:9` |
| 0.0% | 615us | 0.0% | 194us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:18` |
| 0.0% | 615us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/routes-mapper.js:8` |
| 0.0% | 615us | 0.0% | 615us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:970` |
| 0.0% | 614us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:16` |
| 0.0% | 614us | 0.0% | 0us | `bound call` | `[native code]` |
| 0.0% | 613us | 0.0% | 0us | `createContext` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:9` |
| 0.0% | 613us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:12` |
| 0.0% | 613us | 0.0% | 613us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 0.0% | 612us | 0.0% | 612us | `forEachMimeType` | `/home/user/bun-node/node_modules/mime-types/index.js:167` |
| 0.0% | 612us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:164` |
| 0.0% | 612us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions-zone.js:5` |
| 0.0% | 612us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter-context.js:7` |
| 0.0% | 612us | 0.0% | 382us | `some` | `[native code]` |
| 0.0% | 611us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:9` |
| 0.0% | 610us | 0.0% | 610us | `getProviderNoCache` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 609us | 0.0% | 609us | `stripEndSlash` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:36` |
| 0.0% | 609us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js:7` |
| 0.0% | 608us | 0.0% | 402us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:67` |
| 0.0% | 608us | 0.0% | 0us | `filter` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js:37` |
| 0.0% | 607us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:160` |
| 0.0% | 606us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js:6` |
| 0.0% | 605us | 0.0% | 605us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:44` |
| 0.0% | 603us | 0.0% | 0us | `OrdinaryDefineOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1074` |
| 0.0% | 603us | 0.0% | 603us | `get` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:17` |
| 0.0% | 603us | 0.0% | 181us | `OrdinaryMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:621` |
| 0.0% | 602us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/injectable.decorator.js:5` |
| 0.0% | 601us | 0.0% | 601us | `reflectKeyMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 0.0% | 599us | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:150` |
| 0.0% | 599us | 0.0% | 0us | `async resolveSingleParam` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:237` |
| 0.0% | 599us | 0.0% | 0us | `forRoutes` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js:52` |
| 0.0% | 597us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:7` |
| 0.0% | 597us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:7` |
| 0.0% | 597us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:86` |
| 0.0% | 597us | 0.0% | 597us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js` |
| 0.0% | 596us | 0.0% | 0us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:132` |
| 0.0% | 596us | 0.0% | 596us | `Barrier` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/barrier.js:9` |
| 0.0% | 595us | 0.0% | 595us | `reply` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1150` |
| 0.0% | 595us | 0.0% | 0us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:63` |
| 0.0% | 594us | 0.0% | 213us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:69` |
| 0.0% | 594us | 0.0% | 594us | `exploreMethodMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js` |
| 0.0% | 593us | 0.0% | 593us | `internal:streams/destroy` | `internal:streams/destroy:16` |
| 0.0% | 593us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/modules/module.decorator.js:4` |
| 0.0% | 591us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:4` |
| 0.0% | 589us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/supports-color/index.js:4` |
| 0.0% | 589us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:6` |
| 0.0% | 589us | 0.0% | 589us | `bind` | `[native code]` |
| 0.0% | 583us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:31` |
| 0.0% | 581us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:85` |
| 0.0% | 581us | 0.0% | 581us | `async resolveProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:345` |
| 0.0% | 579us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:5` |
| 0.0% | 579us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/switchAll.js:4` |
| 0.0% | 579us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:180` |
| 0.0% | 577us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:25` |
| 0.0% | 570us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/controller.decorator.js:5` |
| 0.0% | 569us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:206` |
| 0.0% | 569us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js:7` |
| 0.0% | 568us | 0.0% | 0us | `async scanModulesForDependencies` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:104` |
| 0.0% | 568us | 0.0% | 0us | `async scan` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:32` |
| 0.0% | 566us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/startWith.js:5` |
| 0.0% | 564us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:12` |
| 0.0% | 562us | 0.0% | 0us | `async loadMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:95` |
| 0.0% | 561us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/request-mapping.decorator.js:5` |
| 0.0% | 559us | 0.0% | 0us | `ie` | `bun:wrap:1` |
| 0.0% | 557us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:216` |
| 0.0% | 556us | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:157` |
| 0.0% | 554us | 0.0% | 0us | `BunNestWebsocketAdapter` | `[native code]` |
| 0.0% | 554us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/ReplaySubject.js:22` |
| 0.0% | 554us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/ReplaySubject.js:72` |
| 0.0% | 554us | 0.0% | 0us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:280` |
| 0.0% | 554us | 0.0% | 554us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/ReplaySubject.js` |
| 0.0% | 551us | 0.0% | 551us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 549us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/QueueAction.js:49` |
| 0.0% | 549us | 0.0% | 549us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/QueueAction.js` |
| 0.0% | 549us | 0.0% | 549us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:72` |
| 0.0% | 549us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/QueueAction.js:21` |
| 0.0% | 548us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:13` |
| 0.0% | 548us | 0.0% | 0us | `WriteStream` | `internal:fs/streams:259` |
| 0.0% | 546us | 0.0% | 546us | `WriteStream` | `internal:fs/streams` |
| 0.0% | 545us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:16` |
| 0.0% | 545us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/throwIfEmpty.js:4` |
| 0.0% | 543us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:22` |
| 0.0% | 543us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:7` |
| 0.0% | 543us | 0.0% | 543us | `startsWith` | `[native code]` |
| 0.0% | 541us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:7` |
| 0.0% | 537us | 0.0% | 537us | `static` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts` |
| 0.0% | 536us | 0.0% | 0us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:86` |
| 0.0% | 533us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:218` |
| 0.0% | 533us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:204` |
| 0.0% | 532us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:10` |
| 0.0% | 531us | 0.0% | 531us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:8` |
| 0.0% | 531us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:103` |
| 0.0% | 531us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/tslib/tslib.js:68` |
| 0.0% | 530us | 0.0% | 530us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:524` |
| 0.0% | 525us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/uint8array-extras/index.js:178` |
| 0.0% | 522us | 0.0% | 0us | `Module` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/modules/module.decorator.js:21` |
| 0.0% | 522us | 0.0% | 0us | `validateModuleKeys` | `/home/user/bun-node/node_modules/@nestjs/common/utils/validate-module-keys.util.js:21` |
| 0.0% | 521us | 0.0% | 0us | `generateUuid` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:369` |
| 0.0% | 520us | 0.0% | 520us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:128` |
| 0.0% | 520us | 0.0% | 216us | `getInstanceByContextId` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:46` |
| 0.0% | 520us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/exception-filters.decorator.js:7` |
| 0.0% | 518us | 0.0% | 0us | `BunRouter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:889` |
| 0.0% | 515us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` |
| 0.0% | 515us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:200` |
| 0.0% | 513us | 0.0% | 513us | `hasOwnProperty` | `[native code]` |
| 0.0% | 510us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/iterare/lib/flatten.js:3` |
| 0.0% | 507us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/skipUntil.js:4` |
| 0.0% | 507us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:184` |
| 0.0% | 507us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:21` |
| 0.0% | 505us | 0.0% | 505us | `(module)` | `/home/user/bun-node/node_modules/token-types/lib/index.js:360` |
| 0.0% | 504us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:6` |
| 0.0% | 502us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/serializer/class-serializer.interceptor.js:10` |
| 0.0% | 502us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/index.js:5` |
| 0.0% | 501us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/inspector/graph-inspector.js:6` |
| 0.0% | 501us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/combineLatest.js:27` |
| 0.0% | 500us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/inspector/serialized-graph.js:7` |
| 0.0% | 498us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:12` |
| 0.0% | 496us | 0.0% | 496us | `Map` | `[native code]` |
| 0.0% | 495us | 0.0% | 316us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:421` |
| 0.0% | 493us | 0.0% | 0us | `connectGatewayToServer` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:40` |
| 0.0% | 491us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module-ref.js:10` |
| 0.0% | 486us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:80` |
| 0.0% | 484us | 0.0% | 484us | `(anonymous)` | `/home/user/bun-node/node_modules/tslib/tslib.js:209` |
| 0.0% | 483us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:7` |
| 0.0% | 482us | 0.0% | 482us | `defineMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 480us | 0.0% | 480us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/types/other.js:718` |
| 0.0% | 478us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:107` |
| 0.0% | 476us | 0.0% | 476us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2488` |
| 0.0% | 476us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:10` |
| 0.0% | 475us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:46` |
| 0.0% | 475us | 0.0% | 256us | `async loadProvider` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:107` |
| 0.0% | 474us | 0.0% | 474us | `next` | `/home/user/bun-node/node_modules/iterare/lib/filter.js` |
| 0.0% | 474us | 0.0% | 264us | `IsArray` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:770` |
| 0.0% | 472us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/supports-color/index.js:133` |
| 0.0% | 472us | 0.0% | 472us | `supportsColor` | `/home/user/bun-node/node_modules/supports-color/index.js` |
| 0.0% | 470us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/http.exception.js:5` |
| 0.0% | 469us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:146` |
| 0.0% | 465us | 0.0% | 465us | `freeze` | `[native code]` |
| 0.0% | 463us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/connectable.js:6` |
| 0.0% | 462us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/bufferTime.js:20` |
| 0.0% | 457us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/http/index.js:5` |
| 0.0% | 456us | 0.0% | 456us | `#configuredCookieSecrets` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1405` |
| 0.0% | 456us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:20` |
| 0.0% | 456us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:18` |
| 0.0% | 455us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:10` |
| 0.0% | 455us | 0.0% | 455us | `parse` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 455us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/takeUntil.js:5` |
| 0.0% | 455us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:18` |
| 0.0% | 454us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:15` |
| 0.0% | 453us | 0.0% | 0us | `assignControllerUniqueId` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:334` |
| 0.0% | 453us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exceptions-handler.js:7` |
| 0.0% | 452us | 0.0% | 452us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js` |
| 0.0% | 452us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discovery-service.js:8` |
| 0.0% | 451us | 0.0% | 451us | `applyPathsToRouterProxy` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 451us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/file/parse-file.pipe.js:7` |
| 0.0% | 451us | 0.0% | 451us | `(anonymous)` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:18` |
| 0.0% | 451us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/index.js:6` |
| 0.0% | 450us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:6` |
| 0.0% | 449us | 0.0% | 0us | `NestApplication` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:26` |
| 0.0% | 449us | 0.0% | 0us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:35` |
| 0.0% | 448us | 0.0% | 448us | `appendToAllIfDefined` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js` |
| 0.0% | 448us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/partition.js:4` |
| 0.0% | 447us | 0.0% | 447us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js` |
| 0.0% | 447us | 0.0% | 0us | `node:_http_agent` | `node:_http_agent:290` |
| 0.0% | 447us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:84` |
| 0.0% | 446us | 0.0% | 446us | `getClassScope` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/get-class-scope.js` |
| 0.0% | 444us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/exceptions/base-ws-exception-filter.js:7` |
| 0.0% | 444us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:15` |
| 0.0% | 443us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module.js:7` |
| 0.0% | 442us | 0.0% | 0us | `async loadConfiguration` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:69` |
| 0.0% | 441us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delayWhen.js:4` |
| 0.0% | 441us | 0.0% | 441us | `getMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:366` |
| 0.0% | 441us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/topology-tree/topology-tree.js:4` |
| 0.0% | 440us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:10` |
| 0.0% | 440us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:74` |
| 0.0% | 440us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:20` |
| 0.0% | 439us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:28` |
| 0.0% | 438us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:8` |
| 0.0% | 438us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:17` |
| 0.0% | 438us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:42` |
| 0.0% | 437us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:114` |
| 0.0% | 436us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/index.js:5` |
| 0.0% | 435us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/factories/ws-params-factory.js:5` |
| 0.0% | 434us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/validation.pipe.js:11` |
| 0.0% | 433us | 0.0% | 433us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js` |
| 0.0% | 433us | 0.0% | 0us | `internal:primordials` | `internal:primordials:76` |
| 0.0% | 433us | 0.0% | 0us | `internal:streams/readable` | `internal:streams/readable:14` |
| 0.0% | 432us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:14` |
| 0.0% | 432us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:98` |
| 0.0% | 431us | 0.0% | 0us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:24` |
| 0.0% | 431us | 0.0% | 431us | `(anonymous)` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:74` |
| 0.0% | 431us | 0.0% | 431us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js:52` |
| 0.0% | 431us | 0.0% | 431us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js:20` |
| 0.0% | 431us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/last.js:6` |
| 0.0% | 431us | 0.0% | 185us | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:44` |
| 0.0% | 430us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/take.js:4` |
| 0.0% | 430us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:131` |
| 0.0% | 430us | 0.0% | 215us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/EmptyError.js:5` |
| 0.0% | 429us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js:6` |
| 0.0% | 429us | 0.0% | 429us | `reflectCallbackMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:16` |
| 0.0% | 429us | 0.0% | 429us | `applySettlementSignal` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:118` |
| 0.0% | 429us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/index.js:6` |
| 0.0% | 428us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:8` |
| 0.0% | 428us | 0.0% | 428us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:202` |
| 0.0% | 427us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:14` |
| 0.0% | 426us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-server-provider.js:5` |
| 0.0% | 426us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:100` |
| 0.0% | 425us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js:7` |
| 0.0% | 424us | 0.0% | 424us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapScheduler.js` |
| 0.0% | 424us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:34` |
| 0.0% | 424us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js:6` |
| 0.0% | 424us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapScheduler.js:45` |
| 0.0% | 424us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapScheduler.js:21` |
| 0.0% | 424us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:67` |
| 0.0% | 423us | 0.0% | 212us | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:58` |
| 0.0% | 423us | 0.0% | 423us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:165` |
| 0.0% | 423us | 0.0% | 423us | `all` | `[native code]` |
| 0.0% | 423us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter.js:8` |
| 0.0% | 423us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:111` |
| 0.0% | 423us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:102` |
| 0.0% | 423us | 0.0% | 0us | `GetOrCreateMetadataMap` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1045` |
| 0.0% | 422us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:90` |
| 0.0% | 422us | 0.0% | 422us | `exploreMethodMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:25` |
| 0.0% | 422us | 0.0% | 221us | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:67` |
| 0.0% | 422us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/index.js:8` |
| 0.0% | 422us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/modules/index.js:6` |
| 0.0% | 421us | 0.0% | 421us | `get` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js` |
| 0.0% | 421us | 0.0% | 421us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:156` |
| 0.0% | 421us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discovery-module.js:15` |
| 0.0% | 421us | 0.0% | 421us | `ExceptionsHandler` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/exceptions-handler.js:10` |
| 0.0% | 421us | 0.0% | 211us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:39` |
| 0.0% | 420us | 0.0% | 420us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:49` |
| 0.0% | 420us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/exhaustAll.js:4` |
| 0.0% | 420us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:56` |
| 0.0% | 420us | 0.0% | 420us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 419us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:12` |
| 0.0% | 419us | 0.0% | 419us | `get` | `/home/user/bun-node/node_modules/@nestjs/core/inspector/uuid-factory.js:16` |
| 0.0% | 419us | 0.0% | 419us | `next` | `/home/user/bun-node/node_modules/iterare/lib/flatten.js:23` |
| 0.0% | 419us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:148` |
| 0.0% | 419us | 0.0% | 419us | `createPrototype` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:224` |
| 0.0% | 418us | 0.0% | 418us | `async registerMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 418us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/reduce.js:4` |
| 0.0% | 418us | 0.0% | 0us | `extractRouterPath` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:52` |
| 0.0% | 418us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:158` |
| 0.0% | 418us | 0.0% | 418us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 417us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exceptions-handler.js:4` |
| 0.0% | 417us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduleObservable.js:6` |
| 0.0% | 416us | 0.0% | 416us | `applyHostFilter` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:137` |
| 0.0% | 415us | 0.0% | 415us | `async #parseBody` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3137` |
| 0.0% | 415us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:14` |
| 0.0% | 414us | 0.0% | 214us | `(anonymous)` | `internal:util/inspect:46` |
| 0.0% | 414us | 0.0% | 414us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:27` |
| 0.0% | 414us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:112` |
| 0.0% | 414us | 0.0% | 414us | `originalUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3699` |
| 0.0% | 413us | 0.0% | 413us | `iterate` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js` |
| 0.0% | 413us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:10` |
| 0.0% | 412us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/inspector/uuid-factory.js:5` |
| 0.0% | 412us | 0.0% | 220us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:43` |
| 0.0% | 411us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/elementAt.js:4` |
| 0.0% | 411us | 0.0% | 223us | `async callModuleInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:37` |
| 0.0% | 411us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/mapOneOrManyArgs.js:25` |
| 0.0% | 411us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:128` |
| 0.0% | 411us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:110` |
| 0.0% | 411us | 0.0% | 411us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 410us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:17` |
| 0.0% | 410us | 0.0% | 0us | `RoutesResolver` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:26` |
| 0.0% | 410us | 0.0% | 410us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:198` |
| 0.0% | 407us | 0.0% | 407us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js` |
| 0.0% | 407us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:26` |
| 0.0% | 407us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:160` |
| 0.0% | 406us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:95` |
| 0.0% | 406us | 0.0% | 406us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js:19` |
| 0.0% | 406us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:204` |
| 0.0% | 406us | 0.0% | 192us | `node:crypto` | `node:crypto:2` |
| 0.0% | 406us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:149` |
| 0.0% | 406us | 0.0% | 0us | `async initNest` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:76` |
| 0.0% | 405us | 0.0% | 0us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:42` |
| 0.0% | 405us | 0.0% | 0us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:31` |
| 0.0% | 405us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:32` |
| 0.0% | 405us | 0.0% | 405us | `isArray` | `[native code]` |
| 0.0% | 405us | 0.0% | 405us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:16` |
| 0.0% | 404us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/index.js:9` |
| 0.0% | 404us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/immediateProvider.js:25` |
| 0.0% | 404us | 0.0% | 0us | `addController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:191` |
| 0.0% | 404us | 0.0% | 205us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:30` |
| 0.0% | 403us | 0.0% | 0us | `setStatus` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:49` |
| 0.0% | 403us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/enums/index.js:7` |
| 0.0% | 403us | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:43` |
| 0.0% | 403us | 0.0% | 403us | `async createInstances` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js` |
| 0.0% | 403us | 0.0% | 403us | `(anonymous)` | `/home/user/bun-node/node_modules/tslib/tslib.js:207` |
| 0.0% | 403us | 0.0% | 208us | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:56` |
| 0.0% | 403us | 0.0% | 403us | `(anonymous)` | `node:zlib` |
| 0.0% | 402us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:130` |
| 0.0% | 402us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:154` |
| 0.0% | 402us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:13` |
| 0.0% | 401us | 0.0% | 401us | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 401us | 0.0% | 401us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 401us | 0.0% | 401us | `get method` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` |
| 0.0% | 401us | 0.0% | 401us | `FilterIterator` | `/home/user/bun-node/node_modules/iterare/lib/filter.js:5` |
| 0.0% | 401us | 0.0% | 0us | `async resolveComponentWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:250` |
| 0.0% | 401us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:64` |
| 0.0% | 401us | 0.0% | 401us | `isObject` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:179` |
| 0.0% | 401us | 0.0% | 0us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4805` |
| 0.0% | 399us | 0.0% | 399us | `#respond` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:493` |
| 0.0% | 399us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:49` |
| 0.0% | 398us | 0.0% | 0us | `node:path` | `node:path:2` |
| 0.0% | 398us | 0.0% | 398us | `test` | `[native code]` |
| 0.0% | 397us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:174` |
| 0.0% | 396us | 0.0% | 396us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter-context.js:14` |
| 0.0% | 394us | 0.0% | 207us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` |
| 0.0% | 394us | 0.0% | 394us | `initialize` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:342` |
| 0.0% | 393us | 0.0% | 393us | `ownKeys` | `[native code]` |
| 0.0% | 393us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:162` |
| 0.0% | 393us | 0.0% | 393us | `getCtorMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.0% | 393us | 0.0% | 393us | `startInterval` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 392us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/web-sockets-controller.js:11` |
| 0.0% | 392us | 0.0% | 392us | `async callModuleInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js` |
| 0.0% | 388us | 0.0% | 0us | `extractRouterPath` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:59` |
| 0.0% | 388us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:66` |
| 0.0% | 387us | 0.0% | 387us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:198` |
| 0.0% | 387us | 0.0% | 0us | `node:_http_incoming` | `node:_http_incoming:15` |
| 0.0% | 386us | 0.0% | 386us | `splitRequestUrl` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3503` |
| 0.0% | 386us | 0.0% | 386us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/invalid-class.exception.js:11` |
| 0.0% | 385us | 0.0% | 385us | `reflectConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 385us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:58` |
| 0.0% | 384us | 0.0% | 192us | `get` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:202` |
| 0.0% | 383us | 0.0% | 181us | `reflectResponseHeaders` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:96` |
| 0.0% | 383us | 0.0% | 0us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:71` |
| 0.0% | 383us | 0.0% | 383us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:164` |
| 0.0% | 382us | 0.0% | 0us | `isResponseHandled` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:189` |
| 0.0% | 381us | 0.0% | 381us | `performProxyObjectGet` | `[native code]` |
| 0.0% | 381us | 0.0% | 381us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:6` |
| 0.0% | 381us | 0.0% | 381us | `#compileRouteRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 380us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/window.js:4` |
| 0.0% | 377us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/ip-regex/index.js:22` |
| 0.0% | 377us | 0.0% | 377us | `/\s*\/\/.*$/gm` | `[native code]` |
| 0.0% | 375us | 0.0% | 375us | `getStaticTransientInstances` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.0% | 374us | 0.0% | 0us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:87` |
| 0.0% | 371us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:194` |
| 0.0% | 371us | 0.0% | 371us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:953` |
| 0.0% | 369us | 0.0% | 369us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js` |
| 0.0% | 366us | 0.0% | 366us | `getPropertiesMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:121` |
| 0.0% | 366us | 0.0% | 0us | `async resolveProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:348` |
| 0.0% | 361us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/pipe.js:4` |
| 0.0% | 361us | 0.0% | 361us | `getContextInquirerId` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 359us | 0.0% | 359us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1246` |
| 0.0% | 359us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/serializer/index.js:6` |
| 0.0% | 358us | 0.0% | 358us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/unknown-export.exception.js:3` |
| 0.0% | 355us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/use-pipes.decorator.js:5` |
| 0.0% | 354us | 0.0% | 354us | `endsWith` | `[native code]` |
| 0.0% | 351us | 0.0% | 351us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:375` |
| 0.0% | 349us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:9` |
| 0.0% | 348us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/combineLatest.js:10` |
| 0.0% | 342us | 0.0% | 0us | `isTransientProvider` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:426` |
| 0.0% | 342us | 0.0% | 0us | `addProvider` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:165` |
| 0.0% | 342us | 0.0% | 0us | `addProvider` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:164` |
| 0.0% | 342us | 0.0% | 342us | `GetMetadataProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1166` |
| 0.0% | 340us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/isObservable.js:5` |
| 0.0% | 339us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:9` |
| 0.0% | 337us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/repl-logger.js:8` |
| 0.0% | 336us | 0.0% | 336us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:681` |
| 0.0% | 336us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:15` |
| 0.0% | 333us | 0.0% | 333us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/skip.js` |
| 0.0% | 329us | 0.0% | 329us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/types/urlencoded.js:48` |
| 0.0% | 327us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:208` |
| 0.0% | 324us | 0.0% | 324us | `#configuredCookieSecrets` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 323us | 0.0% | 0us | `async createInstancesOfControllers` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:66` |
| 0.0% | 322us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:210` |
| 0.0% | 321us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/skipWhile.js:4` |
| 0.0% | 320us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/header.decorator.js:5` |
| 0.0% | 318us | 0.0% | 318us | `InstanceWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:23` |
| 0.0% | 317us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/windowToggle.js:15` |
| 0.0% | 315us | 0.0% | 315us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:420` |
| 0.0% | 314us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:12` |
| 0.0% | 313us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/AsyncSubject.js:12` |
| 0.0% | 313us | 0.0% | 313us | `extendStatics` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/AsyncSubject.js` |
| 0.0% | 313us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/AsyncSubject.js:53` |
| 0.0% | 313us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/AsyncSubject.js:21` |
| 0.0% | 311us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/modules/index.js:8` |
| 0.0% | 310us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/switchMapTo.js:4` |
| 0.0% | 310us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:16` |
| 0.0% | 304us | 0.0% | 0us | `get` | `/home/user/bun-node/node_modules/@nestjs/common/index.js:17` |
| 0.0% | 302us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:733` |
| 0.0% | 299us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/serializer/decorators/index.js:4` |
| 0.0% | 295us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module.js:26` |
| 0.0% | 294us | 0.0% | 294us | `Stream` | `internal:streams/legacy` |
| 0.0% | 294us | 0.0% | 0us | `Writable` | `internal:streams/writable:196` |
| 0.0% | 294us | 0.0% | 294us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/undefined-dependency.exception.js:6` |
| 0.0% | 293us | 0.0% | 0us | `promisify2` | `internal:promisify:45` |
| 0.0% | 293us | 0.0% | 293us | `defineCustomPromisify` | `internal:promisify` |
| 0.0% | 293us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/general.ts:31` |
| 0.0% | 292us | 0.0% | 292us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/serializer/class-serializer.interceptor.js:76` |
| 0.0% | 292us | 0.0% | 292us | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3398` |
| 0.0% | 291us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/controller.decorator.js:4` |
| 0.0% | 291us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:121` |
| 0.0% | 291us | 0.0% | 291us | `exploreMethodMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:31` |
| 0.0% | 290us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delayWhen.js:7` |
| 0.0% | 290us | 0.0% | 0us | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:59` |
| 0.0% | 290us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module-factory.js:4` |
| 0.0% | 289us | 0.0% | 0us | `async reflectImports` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:112` |
| 0.0% | 289us | 0.0% | 0us | `async scanModulesForDependencies` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:106` |
| 0.0% | 289us | 0.0% | 0us | `set` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:13` |
| 0.0% | 289us | 0.0% | 289us | `filter` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js` |
| 0.0% | 289us | 0.0% | 289us | `async reflectImports` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 0.0% | 288us | 0.0% | 288us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/enums/request-method.enum.js` |
| 0.0% | 288us | 0.0% | 288us | `insertProvider` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 0.0% | 288us | 0.0% | 0us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:30` |
| 0.0% | 288us | 0.0% | 0us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:35` |
| 0.0% | 288us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:8` |
| 0.0% | 288us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/enums/request-method.enum.js:21` |
| 0.0% | 288us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:26` |
| 0.0% | 287us | 0.0% | 0us | `async addDynamicMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:113` |
| 0.0% | 287us | 0.0% | 0us | `async addDynamicModules` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:121` |
| 0.0% | 287us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:8` |
| 0.0% | 287us | 0.0% | 287us | `async addDynamicModules` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js` |
| 0.0% | 287us | 0.0% | 0us | `async addDynamicMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:119` |
| 0.0% | 287us | 0.0% | 0us | `async setModule` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:103` |
| 0.0% | 286us | 0.0% | 0us | `getEffectiveResolutionContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:557` |
| 0.0% | 286us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapAction.js:52` |
| 0.0% | 286us | 0.0% | 0us | `getEffectiveInquirer` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:526` |
| 0.0% | 286us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapAction.js:22` |
| 0.0% | 286us | 0.0% | 286us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapAction.js` |
| 0.0% | 282us | 0.0% | 0us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5119` |
| 0.0% | 282us | 0.0% | 282us | `layerFinished` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:598` |
| 0.0% | 282us | 0.0% | 0us | `BunWebSocketAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunWebSocketAdapter.ts:529` |
| 0.0% | 282us | 0.0% | 282us | `resolveAdapterOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunWebSocketAdapter.ts` |
| 0.0% | 281us | 0.0% | 0us | `parse` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js:42` |
| 0.0% | 281us | 0.0% | 281us | `Empty` | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 281us | 0.0% | 281us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:194` |
| 0.0% | 281us | 0.0% | 281us | `_freeze` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js:71` |
| 0.0% | 280us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/forbidden.exception.js:4` |
| 0.0% | 280us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:60` |
| 0.0% | 279us | 0.0% | 279us | `getModules` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js` |
| 0.0% | 277us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:13` |
| 0.0% | 277us | 0.0% | 0us | `GetOrCreateMetadataRegistry` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:998` |
| 0.0% | 277us | 0.0% | 0us | `async compile` | `/home/user/bun-node/node_modules/@nestjs/core/injector/compiler.js:16` |
| 0.0% | 277us | 0.0% | 277us | `CreateMetadataRegistry` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 277us | 0.0% | 277us | `createForStatic` | `/home/user/bun-node/node_modules/@nestjs/core/injector/opaque-key-factory/by-reference-module-opaque-key-factory.js` |
| 0.0% | 277us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:84` |
| 0.0% | 276us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/SequenceError.js:5` |
| 0.0% | 276us | 0.0% | 276us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/redirect.decorator.js:2` |
| 0.0% | 276us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncAction.js:23` |
| 0.0% | 276us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:10` |
| 0.0% | 276us | 0.0% | 276us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/SequenceError.js` |
| 0.0% | 276us | 0.0% | 276us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncAction.js` |
| 0.0% | 276us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncAction.js:104` |
| 0.0% | 275us | 0.0% | 275us | `(anonymous)` | `/home/user/bun-node/node_modules/uint8array-extras/index.js:178` |
| 0.0% | 275us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:20` |
| 0.0% | 274us | 0.0% | 0us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:800` |
| 0.0% | 274us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:19` |
| 0.0% | 274us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:18` |
| 0.0% | 274us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:17` |
| 0.0% | 274us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:23` |
| 0.0% | 274us | 0.0% | 274us | `RouteCandidateIndex` | `[native code]` |
| 0.0% | 273us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:16` |
| 0.0% | 273us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:22` |
| 0.0% | 272us | 0.0% | 0us | `BunWebSocketAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunWebSocketAdapter.ts:530` |
| 0.0% | 272us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:15` |
| 0.0% | 272us | 0.0% | 0us | `BunWebSocket` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts:481` |
| 0.0% | 272us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:13` |
| 0.0% | 272us | 0.0% | 272us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts` |
| 0.0% | 271us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:14` |
| 0.0% | 270us | 0.0% | 270us | `put` | `/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/lib/index.js` |
| 0.0% | 270us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:11` |
| 0.0% | 270us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:11` |
| 0.0% | 270us | 0.0% | 0us | `addProvider` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:167` |
| 0.0% | 270us | 0.0% | 270us | `getEffectiveResolutionContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 270us | 0.0% | 270us | `getMetaKeyByInstanceWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discoverable-meta-host-collection.js` |
| 0.0% | 270us | 0.0% | 0us | `signatureToArray` | `/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:6` |
| 0.0% | 268us | 0.0% | 268us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/sockets-container.js:5` |
| 0.0% | 267us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:6` |
| 0.0% | 267us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:13` |
| 0.0% | 266us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/VirtualTimeScheduler.js:52` |
| 0.0% | 266us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/VirtualTimeScheduler.js:23` |
| 0.0% | 266us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js:4` |
| 0.0% | 266us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:17` |
| 0.0% | 266us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/VirtualTimeScheduler.js:12` |
| 0.0% | 266us | 0.0% | 266us | `extendStatics` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/VirtualTimeScheduler.js` |
| 0.0% | 266us | 0.0% | 266us | `(anonymous)` | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js` |
| 0.0% | 265us | 0.0% | 265us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/timeInterval.js:19` |
| 0.0% | 265us | 0.0% | 265us | `useFactory` | `/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module-factory.js` |
| 0.0% | 264us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/multicast.js:6` |
| 0.0% | 264us | 0.0% | 0us | `decorate` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:127` |
| 0.0% | 264us | 0.0% | 0us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:273` |
| 0.0% | 264us | 0.0% | 0us | `set requestOpts` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:623` |
| 0.0% | 264us | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:41` |
| 0.0% | 264us | 0.0% | 264us | `async createInstancesOfInjectables` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js` |
| 0.0% | 264us | 0.0% | 0us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:283` |
| 0.0% | 264us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter.js:68` |
| 0.0% | 264us | 0.0% | 264us | `resolveWebSocketOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 264us | 0.0% | 264us | `mergeBunRequestOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 0.0% | 262us | 0.0% | 262us | `writer` | `[native code]` |
| 0.0% | 262us | 0.0% | 0us | `WriteStream` | `internal:fs/streams:251` |
| 0.0% | 261us | 0.0% | 0us | `(module)` | `/home/user/bun-node/node_modules/ip-regex/index.js:27` |
| 0.0% | 260us | 0.0% | 260us | `send` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1409` |
| 0.0% | 260us | 0.0% | 0us | `ConsoleLogger` | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:44` |
| 0.0% | 260us | 0.0% | 260us | `getInspectOptions` | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js` |
| 0.0% | 260us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:222` |
| 0.0% | 259us | 0.0% | 259us | `(module)` | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:181` |
| 0.0% | 258us | 0.0% | 258us | `(anonymous)` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:79` |
| 0.0% | 257us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:15` |
| 0.0% | 256us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/tslib/tslib.js:54` |
| 0.0% | 256us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:303` |
| 0.0% | 256us | 0.0% | 256us | `thresholdValue` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts` |
| 0.0% | 256us | 0.0% | 0us | `createLogger` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:299` |
| 0.0% | 256us | 0.0% | 0us | `StructuredLogger` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:183` |
| 0.0% | 255us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/compression.ts:216` |
| 0.0% | 255us | 0.0% | 255us | `getVersion` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:49` |
| 0.0% | 255us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/exception-filters.decorator.js:5` |
| 0.0% | 254us | 0.0% | 0us | `Writable` | `internal:streams/writable:181` |
| 0.0% | 254us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/throttleTime.js:4` |
| 0.0% | 254us | 0.0% | 254us | `useColors` | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 254us | 0.0% | 254us | `WritableState` | `internal:streams/writable` |
| 0.0% | 253us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/use-guards.decorator.js:7` |
| 0.0% | 253us | 0.0% | 0us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:64` |
| 0.0% | 252us | 0.0% | 252us | `(program)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/silent-logger.js:1` |
| 0.0% | 252us | 0.0% | 252us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:3` |
| 0.0% | 251us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/exceptions/misdirected.exception.js:4` |
| 0.0% | 251us | 0.0% | 251us | `define` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 251us | 0.0% | 251us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:18` |
| 0.0% | 250us | 0.0% | 250us | `isBoolean` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:158` |
| 0.0% | 250us | 0.0% | 0us | `parseCookies` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3026` |
| 0.0% | 250us | 0.0% | 250us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/last.js:2` |
| 0.0% | 250us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/modules/index.js:4` |
| 0.0% | 249us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` |
| 0.0% | 249us | 0.0% | 249us | `toString` | `[native code]` |
| 0.0% | 248us | 0.0% | 248us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:2` |
| 0.0% | 248us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:9` |
| 0.0% | 248us | 0.0% | 0us | `internal:util/inspect` | `internal:util/inspect:321` |
| 0.0% | 248us | 0.0% | 248us | `setPrototypeDirect` | `[native code]` |
| 0.0% | 247us | 0.0% | 247us | `__exportStar` | `/home/user/bun-node/node_modules/tslib/tslib.js` |
| 0.0% | 246us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/utils/index.js:4` |
| 0.0% | 246us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:11` |
| 0.0% | 246us | 0.0% | 246us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/NotFoundError.js` |
| 0.0% | 246us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:14` |
| 0.0% | 246us | 0.0% | 246us | `getInstanceByContextId` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:49` |
| 0.0% | 246us | 0.0% | 246us | `Mime` | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 246us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/NotFoundError.js:5` |
| 0.0% | 245us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/create-route-param-metadata.decorator.js:6` |
| 0.0% | 245us | 0.0% | 245us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 245us | 0.0% | 0us | `BunHttpAdapter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:267` |
| 0.0% | 244us | 0.0% | 0us | `NestApplication` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:45` |
| 0.0% | 244us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/innerFrom.js:61` |
| 0.0% | 244us | 0.0% | 244us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js:14` |
| 0.0% | 244us | 0.0% | 244us | `NestApplication` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:38` |
| 0.0% | 244us | 0.0% | 244us | `MiddlewareModule` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 244us | 0.0% | 244us | `pick` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 244us | 0.0% | 0us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:197` |
| 0.0% | 243us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:6` |
| 0.0% | 243us | 0.0% | 243us | `BunRouter` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 243us | 0.0% | 243us | `(module)` | `/home/user/bun-node/node_modules/mime/dist/types/standard.js:365` |
| 0.0% | 241us | 0.0% | 241us | `async registerMiddlewareConfig` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 241us | 0.0% | 241us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` |
| 0.0% | 241us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:5` |
| 0.0% | 241us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/request/request-providers.js:4` |
| 0.0% | 241us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/context/ws-context-creator.js:12` |
| 0.0% | 239us | 0.0% | 239us | `addLeadingSlash` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:26` |
| 0.0% | 238us | 0.0% | 238us | `(module)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:264` |
| 0.0% | 238us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:18` |
| 0.0% | 238us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:19` |
| 0.0% | 237us | 0.0% | 237us | `splitPattern` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:55` |
| 0.0% | 237us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/silent-logger.js:4` |
| 0.0% | 237us | 0.0% | 237us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/opaque-key-factory/deep-hashed-module-opaque-key-factory.js:11` |
| 0.0% | 236us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/hooks/index.js:7` |
| 0.0% | 235us | 0.0% | 235us | `(program)` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter.js:1` |
| 0.0% | 235us | 0.0% | 0us | `log` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:55` |
| 0.0% | 235us | 0.0% | 235us | `concat` | `[native code]` |
| 0.0% | 235us | 0.0% | 235us | `NestApplicationContext` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:36` |
| 0.0% | 235us | 0.0% | 235us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1048` |
| 0.0% | 235us | 0.0% | 235us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js:57` |
| 0.0% | 234us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/defer.js:5` |
| 0.0% | 234us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:228` |
| 0.0% | 234us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:5` |
| 0.0% | 233us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/utils/load-package.util.js:4` |
| 0.0% | 233us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:8` |
| 0.0% | 232us | 0.0% | 232us | `(module)` | `/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/node_modules/@borewit/text-codec/lib/index.js:12` |
| 0.0% | 232us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/elementAt.js:5` |
| 0.0% | 232us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/index.js:6` |
| 0.0% | 232us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/validation.pipe.js:6` |
| 0.0% | 232us | 0.0% | 232us | `async registerRouter` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` |
| 0.0% | 232us | 0.0% | 232us | `#produceResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:550` |
| 0.0% | 232us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/guards/index.js:4` |
| 0.0% | 231us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module.js:9` |
| 0.0% | 231us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:25` |
| 0.0% | 231us | 0.0% | 231us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/sse-stream.js:3` |
| 0.0% | 231us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/utils/filter-log-levels.util.js:5` |
| 0.0% | 231us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/expand.js:4` |
| 0.0% | 231us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delayWhen.js:6` |
| 0.0% | 231us | 0.0% | 0us | `exchangeKeysForValues` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:102` |
| 0.0% | 231us | 0.0% | 231us | `setModuleContext` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js` |
| 0.0% | 230us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js:50` |
| 0.0% | 230us | 0.0% | 0us | `QueueScheduler` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/QueueScheduler.js:23` |
| 0.0% | 230us | 0.0% | 0us | `async registerHandler` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:186` |
| 0.0% | 230us | 0.0% | 230us | `createPipesFn` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 230us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/queue.js:6` |
| 0.0% | 230us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Notification.js:12` |
| 0.0% | 230us | 0.0% | 230us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Notification.js` |
| 0.0% | 230us | 0.0% | 230us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 230us | 0.0% | 230us | `AsyncScheduler` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js:26` |
| 0.0% | 230us | 0.0% | 230us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js` |
| 0.0% | 229us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/inspector/uuid-factory.js:4` |
| 0.0% | 229us | 0.0% | 0us | `removeOverlappedRoutes` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js:73` |
| 0.0% | 229us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/refCount.js:4` |
| 0.0% | 229us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/innerFrom.js:58` |
| 0.0% | 229us | 0.0% | 0us | `candidates` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:237` |
| 0.0% | 229us | 0.0% | 229us | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 229us | 0.0% | 229us | `isDisjoint` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 229us | 0.0% | 0us | `forRoutes` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js:53` |
| 0.0% | 229us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/mergeInternals.js:5` |
| 0.0% | 229us | 0.0% | 0us | `applyCallbackToRouter` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:74` |
| 0.0% | 229us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:116` |
| 0.0% | 228us | 0.0% | 228us | `extractWildcardNames` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:242` |
| 0.0% | 228us | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1011` |
| 0.0% | 228us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/modules/index.js:4` |
| 0.0% | 228us | 0.0% | 228us | `node:events` | `node:events:645` |
| 0.0% | 228us | 0.0% | 228us | `(program)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/compiler.js:1` |
| 0.0% | 228us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:21` |
| 0.0% | 228us | 0.0% | 228us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/runtime.exception.js:4` |
| 0.0% | 228us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscription.js:38` |
| 0.0% | 228us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/animationFrameProvider.js:25` |
| 0.0% | 228us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Scheduler.js:4` |
| 0.0% | 227us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/zip.js:25` |
| 0.0% | 227us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:11` |
| 0.0% | 227us | 0.0% | 0us | `filterMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/utils.js:43` |
| 0.0% | 227us | 0.0% | 227us | `callOperator` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js` |
| 0.0% | 227us | 0.0% | 227us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/parse-float.pipe.js:2` |
| 0.0% | 227us | 0.0% | 227us | `validateKey` | `/home/user/bun-node/node_modules/@nestjs/common/utils/validate-module-keys.util.js` |
| 0.0% | 227us | 0.0% | 227us | `isIterator` | `/home/user/bun-node/node_modules/iterare/lib/utils.js:4` |
| 0.0% | 227us | 0.0% | 0us | `toIterator` | `/home/user/bun-node/node_modules/iterare/lib/utils.js:12` |
| 0.0% | 227us | 0.0% | 0us | `createHandleResponseFn` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:170` |
| 0.0% | 226us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/concat.js:4` |
| 0.0% | 226us | 0.0% | 226us | `#respondWithText` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 226us | 0.0% | 226us | `internal:streams/readable` | `internal:streams/readable:642` |
| 0.0% | 226us | 0.0% | 226us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:76` |
| 0.0% | 226us | 0.0% | 226us | `getProviderNoCache` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:919` |
| 0.0% | 226us | 0.0% | 226us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:29` |
| 0.0% | 226us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/concatAll.js:4` |
| 0.0% | 226us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/serializer/index.js:3` |
| 0.0% | 226us | 0.0% | 226us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discoverable-meta-host-collection.js:4` |
| 0.0% | 226us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-id-factory.js:6` |
| 0.0% | 225us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/connect.js:7` |
| 0.0% | 225us | 0.0% | 225us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:38` |
| 0.0% | 225us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/container.js:38` |
| 0.0% | 225us | 0.0% | 0us | `insertConfig` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/container.js:37` |
| 0.0% | 225us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/animationFrame.js:6` |
| 0.0% | 225us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:124` |
| 0.0% | 225us | 0.0% | 0us | `insertMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/container.js:29` |
| 0.0% | 225us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/adapters/index.js:4` |
| 0.0% | 225us | 0.0% | 225us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:45` |
| 0.0% | 225us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/debug/src/node.js:125` |
| 0.0% | 225us | 0.0% | 225us | `addListener` | `node:events` |
| 0.0% | 225us | 0.0% | 225us | `AnimationFrameScheduler` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AnimationFrameScheduler.js:23` |
| 0.0% | 225us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:11` |
| 0.0% | 225us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:124` |
| 0.0% | 225us | 0.0% | 0us | `Agent` | `node:_http_agent:22` |
| 0.0% | 224us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AnimationFrameScheduler.js:19` |
| 0.0% | 224us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:16` |
| 0.0% | 224us | 0.0% | 224us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter-context.js` |
| 0.0% | 224us | 0.0% | 224us | `extractNonWildcardPathsFrom` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js` |
| 0.0% | 224us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/repl.js:11` |
| 0.0% | 224us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:22` |
| 0.0% | 223us | 0.0% | 223us | `makeSafe` | `internal:primordials` |
| 0.0% | 223us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:13` |
| 0.0% | 223us | 0.0% | 0us | `WeakRefMap` | `[native code]` |
| 0.0% | 223us | 0.0% | 223us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js:53` |
| 0.0% | 223us | 0.0% | 0us | `(anonymous)` | `node:diagnostics_channel:18` |
| 0.0% | 223us | 0.0% | 0us | `node:diagnostics_channel` | `node:diagnostics_channel:134` |
| 0.0% | 223us | 0.0% | 223us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js` |
| 0.0% | 223us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/middleware/index.js:5` |
| 0.0% | 223us | 0.0% | 223us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js` |
| 0.0% | 223us | 0.0% | 223us | `FinalizationRegistry` | `[native code]` |
| 0.0% | 222us | 0.0% | 222us | `mapToClass` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/utils.js` |
| 0.0% | 222us | 0.0% | 222us | `Agent` | `node:_http_agent` |
| 0.0% | 222us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/serializer/class-serializer.interceptor.js:4` |
| 0.0% | 222us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/inject.decorator.js:44` |
| 0.0% | 222us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:18` |
| 0.0% | 222us | 0.0% | 222us | `async callBootstrapHook` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` |
| 0.0% | 222us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/http/index.js:8` |
| 0.0% | 222us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:30` |
| 0.0% | 222us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-module.js:76` |
| 0.0% | 221us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/hooks/index.js:5` |
| 0.0% | 221us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:29` |
| 0.0% | 221us | 0.0% | 221us | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 221us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter-context.js:7` |
| 0.0% | 221us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/utils/filter-log-levels.util.js:4` |
| 0.0% | 220us | 0.0% | 220us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js` |
| 0.0% | 220us | 0.0% | 220us | `createConcreteContext` | `/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js:20` |
| 0.0% | 220us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:25` |
| 0.0% | 220us | 0.0% | 0us | `internal:stream` | `internal:stream:48` |
| 0.0% | 220us | 0.0% | 220us | `log` | `[native code]` |
| 0.0% | 220us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:2` |
| 0.0% | 219us | 0.0% | 219us | `createPipesFn` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:156` |
| 0.0% | 219us | 0.0% | 0us | `node:zlib` | `node:zlib:485` |
| 0.0% | 219us | 0.0% | 219us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:428` |
| 0.0% | 219us | 0.0% | 219us | `createConvenienceMethod` | `node:zlib` |
| 0.0% | 219us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/parse-array.pipe.js:144` |
| 0.0% | 219us | 0.0% | 219us | `shouldSkipProviderLoading` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 219us | 0.0% | 219us | `get isStreamOpen` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1624` |
| 0.0% | 218us | 0.0% | 218us | `OrdinaryGetPrototypeOf` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 218us | 0.0% | 0us | `WebSocketsController` | `/home/user/bun-node/node_modules/@nestjs/websockets/web-sockets-controller.js:22` |
| 0.0% | 218us | 0.0% | 0us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:34` |
| 0.0% | 218us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/index.js:5` |
| 0.0% | 218us | 0.0% | 0us | `node:perf_hooks` | `node:perf_hooks:97` |
| 0.0% | 218us | 0.0% | 218us | `GatewayMetadataExplorer` | `/home/user/bun-node/node_modules/@nestjs/websockets/gateway-metadata-explorer.js` |
| 0.0% | 218us | 0.0% | 0us | `isDependencyTreeStatic` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:183` |
| 0.0% | 218us | 0.0% | 218us | `__decorate` | `/home/user/bun-node/node_modules/tslib/tslib.js` |
| 0.0% | 218us | 0.0% | 218us | `createGuardsFn` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 218us | 0.0% | 218us | `printIntrospectedAsRequestScoped` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.0% | 218us | 0.0% | 0us | `register` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:29` |
| 0.0% | 217us | 0.0% | 217us | `colorIfAllowed` | `/home/user/bun-node/node_modules/@nestjs/common/utils/cli-colors.util.js` |
| 0.0% | 217us | 0.0% | 217us | `async transformToResult` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js` |
| 0.0% | 217us | 0.0% | 217us | `async bindHandler` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 217us | 0.0% | 217us | `set` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:12` |
| 0.0% | 217us | 0.0% | 217us | `get id` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.0% | 217us | 0.0% | 0us | `insertConfig` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/container.js:24` |
| 0.0% | 217us | 0.0% | 0us | `getMiddlewareCollection` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/container.js:14` |
| 0.0% | 217us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/parse-enum.pipe.js:6` |
| 0.0% | 217us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:98` |
| 0.0% | 217us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/help-repl-fn.js:6` |
| 0.0% | 217us | 0.0% | 217us | `createAdapterProxy` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js` |
| 0.0% | 217us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:232` |
| 0.0% | 217us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/utils/cli-colors.util.js:8` |
| 0.0% | 216us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/middleware/index.js:7` |
| 0.0% | 216us | 0.0% | 0us | `getMetaKeyByInstanceWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discoverable-meta-host-collection.js:80` |
| 0.0% | 216us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:177` |
| 0.0% | 216us | 0.0% | 0us | `extractPathsFrom` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js:18` |
| 0.0% | 216us | 0.0% | 216us | `extractVersionPathFrom` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js` |
| 0.0% | 216us | 0.0% | 216us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js` |
| 0.0% | 216us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:119` |
| 0.0% | 216us | 0.0% | 216us | `async loadConfiguration` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:49` |
| 0.0% | 216us | 0.0% | 0us | `async callModuleBootstrapHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js:44` |
| 0.0% | 215us | 0.0% | 215us | `async init` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` |
| 0.0% | 215us | 0.0% | 215us | `getModulesToTriggerHooksOn` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` |
| 0.0% | 215us | 0.0% | 0us | `async callInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:250` |
| 0.0% | 215us | 0.0% | 0us | `async init` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:95` |
| 0.0% | 215us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js:9` |
| 0.0% | 215us | 0.0% | 215us | `applyHostFilter` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 215us | 0.0% | 0us | `run` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions-zone.js:10` |
| 0.0% | 215us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:141` |
| 0.0% | 215us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:26` |
| 0.0% | 215us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:150` |
| 0.0% | 215us | 0.0% | 215us | `async callModuleBootstrapHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js` |
| 0.0% | 214us | 0.0% | 214us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduleIterable.js:3` |
| 0.0% | 214us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/UnsubscriptionError.js:4` |
| 0.0% | 214us | 0.0% | 214us | `Observable` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js` |
| 0.0% | 214us | 0.0% | 0us | `node:_http_common` | `node:_http_common:62` |
| 0.0% | 214us | 0.0% | 214us | `RouterExplorer` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 214us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/sampleTime.js:6` |
| 0.0% | 214us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/bufferTime.js:21` |
| 0.0% | 214us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:106` |
| 0.0% | 214us | 0.0% | 214us | `get metatype` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` |
| 0.0% | 214us | 0.0% | 214us | `NestApplicationContext` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` |
| 0.0% | 214us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/index.js:27` |
| 0.0% | 214us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/empty.js:5` |
| 0.0% | 214us | 0.0% | 0us | `async makeTarget` | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:89` |
| 0.0% | 214us | 0.0% | 214us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4765` |
| 0.0% | 214us | 0.0% | 214us | `get size` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:276` |
| 0.0% | 214us | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1076` |
| 0.0% | 214us | 0.0% | 214us | `FreeList` | `internal:freelist` |
| 0.0% | 214us | 0.0% | 214us | `exchangeKeysForValues` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 213us | 0.0% | 213us | `Buffer` | `[native code]` |
| 0.0% | 213us | 0.0% | 0us | `isResponseHandled` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:190` |
| 0.0% | 213us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/async.js:6` |
| 0.0% | 213us | 0.0% | 213us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:21` |
| 0.0% | 213us | 0.0% | 0us | `AsyncScheduler` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js:24` |
| 0.0% | 213us | 0.0% | 213us | `Scheduler` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Scheduler.js` |
| 0.0% | 213us | 0.0% | 213us | `startInterval` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:193` |
| 0.0% | 213us | 0.0% | 213us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/UnsubscriptionError.js` |
| 0.0% | 213us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:28` |
| 0.0% | 213us | 0.0% | 213us | `async resolveMiddlewareInstance` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js` |
| 0.0% | 213us | 0.0% | 213us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-id-factory.js:3` |
| 0.0% | 213us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/messages.js:4` |
| 0.0% | 213us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:7` |
| 0.0% | 213us | 0.0% | 213us | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 213us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/UnsubscriptionError.js:5` |
| 0.0% | 213us | 0.0% | 213us | `applyCallbackToRouter` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 213us | 0.0% | 0us | `node:_http_server` | `node:_http_server:702` |
| 0.0% | 213us | 0.0% | 0us | `async registerRouteMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:113` |
| 0.0% | 212us | 0.0% | 212us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/modules/injection-token.interface.js:2` |
| 0.0% | 212us | 0.0% | 212us | `node:_http_agent` | `node:_http_agent:68` |
| 0.0% | 212us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:78` |
| 0.0% | 212us | 0.0% | 212us | `forEachMimeType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:157` |
| 0.0% | 212us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:10` |
| 0.0% | 212us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/web-sockets-controller.js:4` |
| 0.0% | 212us | 0.0% | 212us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1003` |
| 0.0% | 212us | 0.0% | 212us | `internal:shared` | `internal:shared:173` |
| 0.0% | 212us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/repl.js:7` |
| 0.0% | 211us | 0.0% | 211us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 211us | 0.0% | 0us | `next` | `[native code]` |
| 0.0% | 211us | 0.0% | 211us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:3` |
| 0.0% | 211us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:82` |
| 0.0% | 211us | 0.0% | 211us | `typedArrayViewIsTypedArrayView` | `[native code]` |
| 0.0% | 211us | 0.0% | 211us | `async resolveInstances` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js` |
| 0.0% | 211us | 0.0% | 211us | `(anonymous)` | `internal:http` |
| 0.0% | 211us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/of.js:4` |
| 0.0% | 211us | 0.0% | 0us | `OrdinaryOwnMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:649` |
| 0.0% | 211us | 0.0% | 211us | `async register` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 211us | 0.0% | 211us | `slice` | `[native code]` |
| 0.0% | 211us | 0.0% | 211us | `node:_http_client` | `node:_http_client:220` |
| 0.0% | 211us | 0.0% | 0us | `internal:http` | `internal:http:13` |
| 0.0% | 210us | 0.0% | 0us | `makeSafe` | `internal:primordials:43` |
| 0.0% | 210us | 0.0% | 210us | `async loadEnhancersPerContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:457` |
| 0.0% | 210us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:125` |
| 0.0% | 210us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Notification.js:6` |
| 0.0% | 210us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:36` |
| 0.0% | 210us | 0.0% | 210us | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:65` |
| 0.0% | 210us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/reportUnhandledError.js:5` |
| 0.0% | 210us | 0.0% | 0us | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:64` |
| 0.0% | 210us | 0.0% | 0us | `createSafeIterator` | `internal:primordials:14` |
| 0.0% | 210us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:12` |
| 0.0% | 210us | 0.0% | 210us | `async loadMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 210us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/modules/index.js:10` |
| 0.0% | 210us | 0.0% | 210us | `charCodeAt` | `[native code]` |
| 0.0% | 210us | 0.0% | 0us | `decorate` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:139` |
| 0.0% | 209us | 0.0% | 209us | `async registerHandler` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 209us | 0.0% | 209us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:2` |
| 0.0% | 209us | 0.0% | 209us | `addLeadingSlash` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js` |
| 0.0% | 209us | 0.0% | 209us | `async (anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 209us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:4` |
| 0.0% | 209us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js:92` |
| 0.0% | 209us | 0.0% | 209us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js:71` |
| 0.0% | 209us | 0.0% | 209us | `BunRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1270` |
| 0.0% | 209us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/repl.js:8` |
| 0.0% | 209us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:184` |
| 0.0% | 209us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:24` |
| 0.0% | 209us | 0.0% | 0us | `RouteInfoPathExtractor` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js:12` |
| 0.0% | 209us | 0.0% | 209us | `createExceptionLayerProxy` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js` |
| 0.0% | 209us | 0.0% | 0us | `async registerRouterHooks` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:125` |
| 0.0% | 209us | 0.0% | 0us | `async register` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:32` |
| 0.0% | 209us | 0.0% | 0us | `registerExceptionHandler` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:89` |
| 0.0% | 209us | 0.0% | 209us | `getOwnPropertyNames` | `[native code]` |
| 0.0% | 209us | 0.0% | 209us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:54` |
| 0.0% | 209us | 0.0% | 209us | `flat` | `[native code]` |
| 0.0% | 208us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:164` |
| 0.0% | 208us | 0.0% | 208us | `__` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:13` |
| 0.0% | 208us | 0.0% | 0us | `RoutesResolver` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:22` |
| 0.0% | 208us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:187` |
| 0.0% | 208us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:16` |
| 0.0% | 208us | 0.0% | 208us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:14` |
| 0.0% | 208us | 0.0% | 208us | `#respond` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 208us | 0.0% | 208us | `getHttpAdapterRef` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:53` |
| 0.0% | 208us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:32` |
| 0.0% | 208us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:185` |
| 0.0% | 208us | 0.0% | 208us | `getVersion` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js` |
| 0.0% | 208us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:14` |
| 0.0% | 208us | 0.0% | 0us | `async loadProvider` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:112` |
| 0.0% | 208us | 0.0% | 208us | `async loadEnhancersPerContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 208us | 0.0% | 208us | `Param` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:238` |
| 0.0% | 207us | 0.0% | 207us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:201` |
| 0.0% | 207us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/repeat.js:4` |
| 0.0% | 207us | 0.0% | 207us | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:63` |
| 0.0% | 207us | 0.0% | 0us | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:61` |
| 0.0% | 207us | 0.0% | 0us | `#configuredQueryOpts` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1368` |
| 0.0% | 207us | 0.0% | 207us | `async lookupComponent` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 207us | 0.0% | 207us | `node:async_hooks` | `node:async_hooks:311` |
| 0.0% | 207us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/http/index.js:6` |
| 0.0% | 207us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/web-sockets-controller.js:9` |
| 0.0% | 207us | 0.0% | 207us | `FilterIterator` | `/home/user/bun-node/node_modules/iterare/lib/filter.js` |
| 0.0% | 207us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/services/reflector.service.js:4` |
| 0.0% | 206us | 0.0% | 206us | `get` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1699` |
| 0.0% | 206us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/onErrorResumeNext.js:4` |
| 0.0% | 206us | 0.0% | 0us | `internal:streams/readable` | `internal:streams/readable:2` |
| 0.0% | 206us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/BehaviorSubject.js:21` |
| 0.0% | 206us | 0.0% | 206us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:20` |
| 0.0% | 206us | 0.0% | 206us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/BehaviorSubject.js` |
| 0.0% | 206us | 0.0% | 206us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:13` |
| 0.0% | 206us | 0.0% | 0us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:233` |
| 0.0% | 206us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/pipes/parse-date.pipe.js:39` |
| 0.0% | 206us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/BehaviorSubject.js:50` |
| 0.0% | 206us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:16` |
| 0.0% | 205us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/ArgumentOutOfRangeError.js:5` |
| 0.0% | 205us | 0.0% | 205us | `BunResponse` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:696` |
| 0.0% | 205us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/provider-classifier.js:6` |
| 0.0% | 205us | 0.0% | 205us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:191` |
| 0.0% | 205us | 0.0% | 0us | `createErrorClass` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/createErrorClass.js:10` |
| 0.0% | 205us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:12` |
| 0.0% | 205us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:7` |
| 0.0% | 205us | 0.0% | 205us | `status` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1182` |
| 0.0% | 205us | 0.0% | 205us | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3389` |
| 0.0% | 205us | 0.0% | 205us | `mapIterationEntryKey` | `[native code]` |
| 0.0% | 205us | 0.0% | 205us | `createCallbackProxy` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 205us | 0.0% | 205us | `next` | `/home/user/bun-node/node_modules/iterare/lib/map.js` |
| 0.0% | 205us | 0.0% | 205us | `charAt` | `[native code]` |
| 0.0% | 205us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/defaultIfEmpty.js:4` |
| 0.0% | 205us | 0.0% | 0us | `node:zlib` | `node:zlib:456` |
| 0.0% | 204us | 0.0% | 204us | `OrdinaryGetOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1069` |
| 0.0% | 204us | 0.0% | 0us | `node:util` | `node:util:8` |
| 0.0% | 204us | 0.0% | 0us | `setup` | `/home/user/bun-node/node_modules/debug/src/common.js:287` |
| 0.0% | 204us | 0.0% | 204us | `enable` | `/home/user/bun-node/node_modules/debug/src/common.js` |
| 0.0% | 204us | 0.0% | 204us | `extractPathsFrom` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js` |
| 0.0% | 204us | 0.0% | 204us | `getGetter` | `internal:primordials` |
| 0.0% | 204us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:65` |
| 0.0% | 204us | 0.0% | 0us | `internal:primordials` | `internal:primordials:74` |
| 0.0% | 204us | 0.0% | 204us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:133` |
| 0.0% | 203us | 0.0% | 203us | `node:diagnostics_channel` | `node:diagnostics_channel:2` |
| 0.0% | 203us | 0.0% | 203us | `_preferredTypeLegacy` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:205` |
| 0.0% | 203us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:186` |
| 0.0% | 203us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:343` |
| 0.0% | 203us | 0.0% | 203us | `reflectRenderTemplate` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 203us | 0.0% | 203us | `set` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js` |
| 0.0% | 203us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:113` |
| 0.0% | 203us | 0.0% | 203us | `isDependencyTreeStatic` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.0% | 203us | 0.0% | 0us | `OrdinaryOwnMetadataKeys` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1081` |
| 0.0% | 203us | 0.0% | 0us | `node:fs/promises` | `node:fs/promises:137` |
| 0.0% | 203us | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:43` |
| 0.0% | 203us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscription.js:36` |
| 0.0% | 203us | 0.0% | 203us | `createContext` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:6` |
| 0.0% | 203us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/timer.js:6` |
| 0.0% | 203us | 0.0% | 203us | `asyncWrap` | `node:fs/promises` |
| 0.0% | 202us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/asap.js:6` |
| 0.0% | 202us | 0.0% | 0us | `AsapScheduler` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapScheduler.js:23` |
| 0.0% | 202us | 0.0% | 202us | `getNowTimestamp` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:641` |
| 0.0% | 202us | 0.0% | 0us | `node:fs` | `node:fs:706` |
| 0.0% | 202us | 0.0% | 0us | `node:util` | `node:util:2` |
| 0.0% | 202us | 0.0% | 202us | `startInterval` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:191` |
| 0.0% | 202us | 0.0% | 0us | `async callModuleBootstrapHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js:37` |
| 0.0% | 202us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-module.js:5` |
| 0.0% | 202us | 0.0% | 202us | `internal:util/inspect` | `internal:util/inspect:9` |
| 0.0% | 202us | 0.0% | 0us | `async loadInstance` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:68` |
| 0.0% | 202us | 0.0% | 0us | `internal:primordials` | `internal:primordials:83` |
| 0.0% | 202us | 0.0% | 202us | `AsyncScheduler` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js` |
| 0.0% | 202us | 0.0% | 0us | `setName` | `node:fs:696` |
| 0.0% | 202us | 0.0% | 0us | `makeSafe` | `internal:primordials:32` |
| 0.0% | 202us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js:6` |
| 0.0% | 201us | 0.0% | 201us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:129` |
| 0.0% | 201us | 0.0% | 0us | `decorate` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:135` |
| 0.0% | 201us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:12` |
| 0.0% | 201us | 0.0% | 0us | `next` | `/home/user/bun-node/node_modules/iterare/lib/flatten.js:11` |
| 0.0% | 201us | 0.0% | 201us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/publish.js:2` |
| 0.0% | 201us | 0.0% | 201us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:6` |
| 0.0% | 201us | 0.0% | 0us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:708` |
| 0.0% | 201us | 0.0% | 201us | `ToPropertyKey` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 201us | 0.0% | 201us | `get headersSent` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` |
| 0.0% | 201us | 0.0% | 0us | `internal:stream` | `internal:stream:46` |
| 0.0% | 201us | 0.0% | 201us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:82` |
| 0.0% | 200us | 0.0% | 200us | `async callInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` |
| 0.0% | 200us | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:149` |
| 0.0% | 200us | 0.0% | 200us | `NestFactoryStatic` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:28` |
| 0.0% | 200us | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1012` |
| 0.0% | 200us | 0.0% | 0us | `async createProxy` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:165` |
| 0.0% | 200us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:233` |
| 0.0% | 200us | 0.0% | 200us | `useMethod` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 200us | 0.0% | 200us | `set response` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 200us | 0.0% | 200us | `normalizeCatchAllPath` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:217` |
| 0.0% | 200us | 0.0% | 0us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:198` |
| 0.0% | 200us | 0.0% | 200us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:237` |
| 0.0% | 200us | 0.0% | 200us | `call` | `[native code]` |
| 0.0% | 200us | 0.0% | 200us | `setProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:982` |
| 0.0% | 200us | 0.0% | 0us | `addScopedEnhancersMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:341` |
| 0.0% | 200us | 0.0% | 0us | `getAllMethodNames` | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:76` |
| 0.0% | 200us | 0.0% | 200us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:40` |
| 0.0% | 200us | 0.0% | 200us | `getStaticTransientResolutionContext` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 199us | 0.0% | 0us | `async resolveConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:130` |
| 0.0% | 199us | 0.0% | 0us | `getFactoryProviderDependencies` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:213` |
| 0.0% | 199us | 0.0% | 199us | `BenchController` | `[native code]` |
| 0.0% | 199us | 0.0% | 199us | `mapFactoryProviderInjectArray` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 199us | 0.0% | 199us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-shutdown.hook.js:3` |
| 0.0% | 199us | 0.0% | 0us | `#compileMiddlewareRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:213` |
| 0.0% | 199us | 0.0% | 199us | `reflectMethodMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:22` |
| 0.0% | 199us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:9` |
| 0.0% | 198us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:17` |
| 0.0% | 198us | 0.0% | 198us | `async resolveComponentWrapper` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 198us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:44` |
| 0.0% | 198us | 0.0% | 198us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:87` |
| 0.0% | 198us | 0.0% | 0us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:431` |
| 0.0% | 198us | 0.0% | 198us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:224` |
| 0.0% | 198us | 0.0% | 0us | `node:zlib` | `node:zlib:449` |
| 0.0% | 198us | 0.0% | 0us | `applyProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:414` |
| 0.0% | 198us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 198us | 0.0% | 198us | `node:http` | `node:http:5` |
| 0.0% | 198us | 0.0% | 198us | `status` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 0.0% | 198us | 0.0% | 198us | `async instantiateClass` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:420` |
| 0.0% | 198us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:190` |
| 0.0% | 198us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js:7` |
| 0.0% | 197us | 0.0% | 0us | `internal:streams/duplex` | `internal:streams/duplex:42` |
| 0.0% | 197us | 0.0% | 197us | `loadPrototype` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:28` |
| 0.0% | 197us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module.js:8` |
| 0.0% | 197us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/timer.js:7` |
| 0.0% | 197us | 0.0% | 0us | `setup` | `/home/user/bun-node/node_modules/debug/src/common.js:17` |
| 0.0% | 197us | 0.0% | 197us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:80` |
| 0.0% | 197us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:142` |
| 0.0% | 197us | 0.0% | 197us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/unknown-dependencies.exception.js:6` |
| 0.0% | 197us | 0.0% | 197us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5037` |
| 0.0% | 196us | 0.0% | 0us | `decorator` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:193` |
| 0.0% | 196us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:286` |
| 0.0% | 196us | 0.0% | 196us | `addScopedEnhancersMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 0.0% | 196us | 0.0% | 196us | `RouterExecutionContext` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 196us | 0.0% | 196us | `getArgumentsLength` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js` |
| 0.0% | 196us | 0.0% | 196us | `IsPropertyKey` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 196us | 0.0% | 196us | `async resolveMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 196us | 0.0% | 196us | `internal:fs/streams` | `internal:fs/streams:156` |
| 0.0% | 196us | 0.0% | 0us | `RouterExplorer` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:44` |
| 0.0% | 196us | 0.0% | 196us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/max.js:9` |
| 0.0% | 196us | 0.0% | 196us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:164` |
| 0.0% | 196us | 0.0% | 196us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:19` |
| 0.0% | 195us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/combineLatest.js:5` |
| 0.0% | 195us | 0.0% | 195us | `applyApplicationProviders` | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 0.0% | 195us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/lift.js:4` |
| 0.0% | 195us | 0.0% | 195us | `Controller` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/controller.decorator.js` |
| 0.0% | 195us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:23` |
| 0.0% | 195us | 0.0% | 195us | `#routeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:427` |
| 0.0% | 195us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/index.js:7` |
| 0.0% | 195us | 0.0% | 0us | `node:events` | `node:events:10` |
| 0.0% | 195us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/services/index.js:3` |
| 0.0% | 195us | 0.0% | 0us | `extractRouterPath` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:56` |
| 0.0% | 195us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduleObservable.js:5` |
| 0.0% | 195us | 0.0% | 195us | `node:crypto` | `node:crypto:279` |
| 0.0% | 195us | 0.0% | 195us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delay.js:2` |
| 0.0% | 195us | 0.0% | 195us | `Body` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:189` |
| 0.0% | 195us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/QueueScheduler.js:17` |
| 0.0% | 195us | 0.0% | 195us | `ConsoleLogger` | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js` |
| 0.0% | 195us | 0.0% | 0us | `async (anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:114` |
| 0.0% | 195us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:42` |
| 0.0% | 194us | 0.0% | 0us | `async lookupComponent` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:292` |
| 0.0% | 194us | 0.0% | 194us | `Module` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/modules/module.decorator.js` |
| 0.0% | 194us | 0.0% | 194us | `PipesContextCreator` | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:11` |
| 0.0% | 194us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:115` |
| 0.0% | 194us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/combineLatest.js:4` |
| 0.0% | 194us | 0.0% | 0us | `extractWildcardNames` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:247` |
| 0.0% | 194us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:29` |
| 0.0% | 194us | 0.0% | 194us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1051` |
| 0.0% | 194us | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1015` |
| 0.0% | 194us | 0.0% | 0us | `getContextCreator` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:81` |
| 0.0% | 194us | 0.0% | 0us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2511` |
| 0.0% | 194us | 0.0% | 194us | `addCtorMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:102` |
| 0.0% | 194us | 0.0% | 194us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:11` |
| 0.0% | 194us | 0.0% | 0us | `register` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:27` |
| 0.0% | 194us | 0.0% | 0us | `addDependencyMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:597` |
| 0.0% | 193us | 0.0% | 193us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:107` |
| 0.0% | 193us | 0.0% | 193us | `appendToAllIfDefined` | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:64` |
| 0.0% | 193us | 0.0% | 193us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/request/index.js:3` |
| 0.0% | 193us | 0.0% | 193us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:119` |
| 0.0% | 193us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/type-is/index.js:17` |
| 0.0% | 193us | 0.0% | 193us | `OrdinaryDefineOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1075` |
| 0.0% | 193us | 0.0% | 0us | `map` | `/home/user/bun-node/node_modules/iterare/lib/iterate.js:34` |
| 0.0% | 193us | 0.0% | 193us | `MapIterator` | `/home/user/bun-node/node_modules/iterare/lib/map.js` |
| 0.0% | 193us | 0.0% | 193us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4784` |
| 0.0% | 193us | 0.0% | 0us | `getRoutesFlatList` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js:64` |
| 0.0% | 193us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:36` |
| 0.0% | 192us | 0.0% | 0us | `async initNest` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:75` |
| 0.0% | 192us | 0.0% | 0us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:3235` |
| 0.0% | 192us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/innerFrom.js:59` |
| 0.0% | 192us | 0.0% | 192us | `getMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 192us | 0.0% | 0us | `mapToClass` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/utils.js:51` |
| 0.0% | 192us | 0.0% | 192us | `OrdinaryDefineOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 192us | 0.0% | 192us | `createExceptionZone` | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js` |
| 0.0% | 192us | 0.0% | 0us | `getGlobalMetadata` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:27` |
| 0.0% | 192us | 0.0% | 192us | `isMiddlewareClass` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/utils.js:82` |
| 0.0% | 192us | 0.0% | 192us | `getRequestMethodStr` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 0.0% | 192us | 0.0% | 192us | `getGlobalFilters` | `/home/user/bun-node/node_modules/@nestjs/core/application-config.js` |
| 0.0% | 192us | 0.0% | 192us | `pathRegex` | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:38` |
| 0.0% | 191us | 0.0% | 0us | `copyProps` | `internal:primordials:23` |
| 0.0% | 191us | 0.0% | 0us | `internal:primordials` | `internal:primordials:88` |
| 0.0% | 191us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:123` |
| 0.0% | 191us | 0.0% | 0us | `makeSafe` | `internal:primordials:52` |
| 0.0% | 191us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:11` |
| 0.0% | 191us | 0.0% | 191us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:37` |
| 0.0% | 191us | 0.0% | 191us | `run` | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions-zone.js` |
| 0.0% | 190us | 0.0% | 190us | `getProvider` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:949` |
| 0.0% | 190us | 0.0% | 190us | `reply` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1178` |
| 0.0% | 190us | 0.0% | 190us | `normalizeParseBodyOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2496` |
| 0.0% | 190us | 0.0% | 190us | `use` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 190us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:37` |
| 0.0% | 190us | 0.0% | 190us | `set` | `node:diagnostics_channel` |
| 0.0% | 190us | 0.0% | 190us | `Cache` | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 190us | 0.0% | 190us | `reflectSelfParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.0% | 190us | 0.0% | 190us | `addRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1249` |
| 0.0% | 190us | 0.0% | 0us | `node:fs` | `node:fs:306` |
| 0.0% | 190us | 0.0% | 0us | `channel` | `node:diagnostics_channel:141` |
| 0.0% | 190us | 0.0% | 190us | `(anonymous)` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5182` |
| 0.0% | 190us | 0.0% | 190us | `#writableOptions` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1359` |
| 0.0% | 190us | 0.0% | 0us | `reflectConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:221` |
| 0.0% | 190us | 0.0% | 0us | `assignControllerUniqueId` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:338` |
| 0.0% | 190us | 0.0% | 0us | `Channel` | `node:diagnostics_channel:108` |
| 0.0% | 190us | 0.0% | 190us | `assignMetadata` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js` |
| 0.0% | 190us | 0.0% | 190us | `uid` | `/home/user/bun-node/node_modules/uid/dist/index.js:12` |
| 0.0% | 190us | 0.0% | 190us | `#compileMiddlewareRegExp` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 190us | 0.0% | 190us | `defineCustomPromisifyArgs` | `node:fs:304` |
| 0.0% | 190us | 0.0% | 190us | `reflectConstructorParams` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:218` |
| 0.0% | 190us | 0.0% | 0us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1016` |
| 0.0% | 189us | 0.0% | 189us | `id` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:27` |
| 0.0% | 189us | 0.0% | 189us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:45` |
| 0.0% | 189us | 0.0% | 189us | `NestApplication` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` |
| 0.0% | 189us | 0.0% | 0us | `_preferredType` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:188` |
| 0.0% | 189us | 0.0% | 189us | `addController` | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:323` |
| 0.0% | 189us | 0.0% | 189us | `forRoutes` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js` |
| 0.0% | 189us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/busboy/lib/index.js:44` |
| 0.0% | 188us | 0.0% | 188us | `copyMetadataToCallback` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.0% | 188us | 0.0% | 188us | `OrdinaryGetOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 188us | 0.0% | 188us | `set` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 188us | 0.0% | 0us | `getMatchedLayers` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4930` |
| 0.0% | 188us | 0.0% | 188us | `async registerRouteMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 188us | 0.0% | 188us | `exec` | `[native code]` |
| 0.0% | 188us | 0.0% | 0us | `node:zlib` | `node:zlib:300` |
| 0.0% | 188us | 0.0% | 0us | `connectAllGateways` | `/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:34` |
| 0.0% | 188us | 0.0% | 0us | `matchRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4634` |
| 0.0% | 188us | 0.0% | 188us | `internal:streams/utils` | `internal:streams/utils:185` |
| 0.0% | 188us | 0.0% | 188us | `create` | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js` |
| 0.0% | 188us | 0.0% | 188us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js:12` |
| 0.0% | 188us | 0.0% | 188us | `reflectProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:403` |
| 0.0% | 187us | 0.0% | 187us | `(anonymous)` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` |
| 0.0% | 187us | 0.0% | 187us | `waitForLayer` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 187us | 0.0% | 0us | `reflectCallbackParamtypes` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js` |
| 0.0% | 187us | 0.0% | 187us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 187us | 0.0% | 187us | `node:url` | `node:url:2` |
| 0.0% | 187us | 0.0% | 0us | `internal:primordials` | `internal:primordials:15` |
| 0.0% | 187us | 0.0% | 187us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:23` |
| 0.0% | 187us | 0.0% | 187us | `OrdinaryHasOwnMetadata` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.0% | 186us | 0.0% | 186us | `ie` | `bun:wrap` |
| 0.0% | 186us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:26` |
| 0.0% | 186us | 0.0% | 186us | `registerParserMiddleware` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:113` |
| 0.0% | 185us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:51` |
| 0.0% | 185us | 0.0% | 185us | `segmentKind` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:75` |
| 0.0% | 185us | 0.0% | 185us | `log` | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:54` |
| 0.0% | 185us | 0.0% | 185us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:67` |
| 0.0% | 185us | 0.0% | 185us | `node:util` | `node:util:254` |
| 0.0% | 184us | 0.0% | 184us | `serveNativeRequest` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:376` |
| 0.0% | 184us | 0.0% | 0us | `(module)` | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:36` |
| 0.0% | 184us | 0.0% | 184us | `createHandleResponseFn` | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 0.0% | 184us | 0.0% | 0us | `async callModuleBootstrapHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js:43` |
| 0.0% | 184us | 0.0% | 184us | `parseContentCodings` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:3670` |
| 0.0% | 184us | 0.0% | 184us | `isFunction` | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:38` |
| 0.0% | 184us | 0.0% | 184us | `mimeScore` | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:49` |
| 0.0% | 183us | 0.0% | 183us | `isString` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.0% | 183us | 0.0% | 0us | `Route` | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:73` |
| 0.0% | 183us | 0.0% | 0us | `registerBodyParser` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:837` |
| 0.0% | 183us | 0.0% | 183us | `getRequestPathFromRequestURL` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4479` |
| 0.0% | 183us | 0.0% | 183us | `#runPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 182us | 0.0% | 0us | `async callModuleInitHook` | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:32` |
| 0.0% | 182us | 0.0% | 182us | `#watchLateRejection` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 182us | 0.0% | 182us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/optional.decorator.js` |
| 0.0% | 182us | 0.0% | 0us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:203` |
| 0.0% | 181us | 0.0% | 181us | `setRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 0.0% | 180us | 0.0% | 180us | `GetOrCreateMetadataMap` | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1036` |
| 0.0% | 179us | 0.0% | 179us | `getInstanceByContextId` | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:53` |
| 0.0% | 179us | 0.0% | 179us | `async registerRouterHooks` | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` |
| 0.0% | 178us | 0.0% | 178us | `segmentKind` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 0.0% | 178us | 0.0% | 178us | `compileRoute` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:88` |
| 0.0% | 178us | 0.0% | 178us | `async handleBodyParsing` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3423` |
| 0.0% | 177us | 0.0% | 177us | `#finishPipeline` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5313` |
| 0.0% | 176us | 0.0% | 0us | `registerNotFoundHandler` | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:79` |
| 0.0% | 175us | 0.0% | 175us | `async resolveProperties` | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:353` |
| 0.0% | 173us | 0.0% | 0us | `segmentKind` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:71` |
| 0.0% | 171us | 0.0% | 171us | `#build` | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:191` |
| 0.0% | 168us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:31` |
| 0.0% | 161us | 0.0% | 0us | `(anonymous)` | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/raceWith.js:25` |
| 0.0% | 142us | 0.0% | 142us | `node:path` | `node:path:21` |

## Function Details

### `Response`
`[native code]` | Self: 8.1% (401.1ms) | Total: 8.1% (401.1ms) | Samples: 1020

**Called by:**
- `#respondWithText` (1020)

### `anonymous`
`[native code]` | Self: 7.3% (358.7ms) | Total: 32.7% (1.60s) | Samples: 1223

**Called by:**
- `require` (5337)
- `bound require` (116)
- `node:stream` (61)
- `internal:stream` (57)
- `node:http` (55)
- `internal:streams/compose` (45)
- `internal:streams/pipeline` (42)
- `internal:streams/duplex` (29)
- `lazyInspectModule` (28)
- `node:_http_client` (20)
- `internal:errors` (9)
- `internal:streams/destroy` (9)
- `internal:streams/operators` (8)
- `internal:streams/legacy` (8)
- `node:tty` (6)
- `node:_http_agent` (6)
- `node:_http_common` (5)
- `internal:validators` (4)
- `internal:streams/readable` (2)
- `internal:streams/end-of-stream` (2)
- `node:_http_incoming` (2)
- `setName` (1)
- `node:crypto` (1)
- `internal:stream` (1)
- `internal:stream` (1)
- `node:util` (1)
- `node:fs/promises` (1)
- `node:util` (1)
- `internal:streams/readable` (1)
- `node:events` (1)

**Calls:**
- `(anonymous)` (373)
- `(anonymous)` (366)
- `(anonymous)` (154)
- `(anonymous)` (116)
- `(anonymous)` (113)
- `(anonymous)` (105)
- `(anonymous)` (101)
- `(anonymous)` (100)
- `(anonymous)` (81)
- `(anonymous)` (78)
- `node:stream` (61)
- `(anonymous)` (61)
- `(anonymous)` (59)
- `(anonymous)` (59)
- `internal:stream` (57)
- `(anonymous)` (49)
- `(anonymous)` (46)
- `internal:streams/compose` (45)
- `(anonymous)` (44)
- `(anonymous)` (43)
- `(anonymous)` (43)
- `(anonymous)` (42)
- `internal:streams/pipeline` (42)
- `(anonymous)` (41)
- `(anonymous)` (39)
- `(anonymous)` (34)
- `(anonymous)` (32)
- `(anonymous)` (31)
- `internal:streams/duplex` (29)
- `(anonymous)` (29)
- `(anonymous)` (29)
- `(anonymous)` (27)
- `(anonymous)` (25)
- `node:_http_client` (21)
- `(anonymous)` (20)
- `(anonymous)` (20)
- `(anonymous)` (19)
- `(anonymous)` (19)
- `(anonymous)` (19)
- `(anonymous)` (18)
- `(anonymous)` (18)
- `(anonymous)` (18)
- `(anonymous)` (18)
- `(anonymous)` (17)
- `(anonymous)` (17)
- `(anonymous)` (17)
- `(anonymous)` (16)
- `(anonymous)` (16)
- `(anonymous)` (16)
- `(anonymous)` (15)
- `(anonymous)` (15)
- `(anonymous)` (15)
- `(anonymous)` (15)
- `(anonymous)` (15)
- `(anonymous)` (14)
- `(anonymous)` (14)
- `(anonymous)` (14)
- `(anonymous)` (14)
- `(anonymous)` (13)
- `(anonymous)` (13)
- `(anonymous)` (12)
- `(anonymous)` (12)
- `(anonymous)` (12)
- `(anonymous)` (12)
- `(anonymous)` (11)
- `(anonymous)` (11)
- `(anonymous)` (11)
- `(anonymous)` (11)
- `(anonymous)` (11)
- `(anonymous)` (11)
- `(anonymous)` (11)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `internal:errors` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `internal:streams/destroy` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `internal:streams/legacy` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `internal:streams/operators` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `node:tty` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `node:_http_agent` (6)
- `node:_http_common` (6)
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
- `(anonymous)` (4)
- `(anonymous)` (4)
- `internal:validators` (4)
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
- `internal:util/inspect` (3)
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
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `internal:primordials` (2)
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
- `node:crypto` (2)
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
- `internal:streams/readable` (2)
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
- `node:path` (2)
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
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `internal:streams/end-of-stream` (2)
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
- `node:_http_agent` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `node:_http_incoming` (2)
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
- `node:util` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:streams/utils` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:util/inspect` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:stream` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:fs/binding` (1)
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
- `node:diagnostics_channel` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:primordials` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:perf_hooks` (1)
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
- `(program)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:util` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:_http_client` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:http` (1)
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
- `node:crypto` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:_http_outgoing` (1)
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
- `internal:streams/readable` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:url` (1)
- `node:diagnostics_channel` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:path` (1)
- `internal:primordials` (1)
- `internal:util/inspect` (1)
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
- `internal:streams/readable` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:events` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:_http_common` (1)
- `(anonymous)` (1)
- `node:events` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:streams/destroy` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:_http_agent` (1)
- `internal:fs/streams` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:primordials` (1)
- `(anonymous)` (1)
- `internal:primordials` (1)
- `node:async_hooks` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:util` (1)
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
- `internal:shared` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:_http_server` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `internal:stream` (1)
- `internal:streams/duplex` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `node:crypto` (1)
- `(anonymous)` (1)

### `Request`
`[native code]` | Self: 5.3% (264.3ms) | Total: 5.3% (264.3ms) | Samples: 700

**Called by:**
- `static` (700)

### `async middlewareHandler`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:823` | Self: 3.1% (153.6ms) | Total: 10.4% (509.7ms) | Samples: 334

**Called by:**
- `#runPipeline` (1269)

**Calls:**
- `async (anonymous)` (926)
- `asyncFunctionDrive` (8)
- `async (anonymous)` (1)

### `get`
`[native code]` | Self: 2.6% (128.0ms) | Total: 2.6% (128.0ms) | Samples: 357

**Called by:**
- `parseCookies` (106)
- `async handleBodyParsing` (104)
- `#finishAbsentBody` (70)
- `#finishAbsentBody` (66)
- `parseContentCodings` (5)
- `require` (3)
- `define` (1)
- `#build` (1)
- `getProvider` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:696` | Self: 2.2% (108.6ms) | Total: 2.2% (108.6ms) | Samples: 320

**Called by:**
- `Promise` (319)
- `#waitLayer` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1231` | Self: 2.1% (105.3ms) | Total: 2.1% (105.3ms) | Samples: 301

**Called by:**
- `init` (301)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:428` | Self: 1.6% (82.6ms) | Total: 20.8% (1.02s) | Samples: 217

**Called by:**
- `serveNativeRequest` (2548)

**Calls:**
- `#runPipeline` (1275)
- `#runPipeline` (547)
- `dispatch` (400)
- `#waitLayer` (34)
- `#runPipeline` (23)
- `dispatch` (15)
- `#runPipeline` (12)
- `#waitLayer` (12)
- `#runPipeline` (10)
- `#runPipeline` (1)
- `#runPipeline` (1)
- `#runPipeline` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5006` | Self: 1.6% (82.0ms) | Total: 1.6% (82.0ms) | Samples: 231

**Called by:**
- `#routeRequest` (23)

### `asyncFunctionDrive`
`[native code]` | Self: 1.6% (81.7ms) | Total: 1.6% (81.7ms) | Samples: 198

**Called by:**
- `async handleBodyParsing` (99)
- `async #awaitPipeline` (43)
- `async (anonymous)` (27)
- `async (anonymous)` (11)
- `async middlewareHandler` (8)
- `async (anonymous)` (8)
- `async resolveProperties` (1)
- `async loadInstance` (1)

### `async transformToResult`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:32` | Self: 1.5% (73.6ms) | Total: 1.5% (77.5ms) | Samples: 182

**Called by:**
- `async (anonymous)` (188)

**Calls:**
- `isObservable` (3)
- `get` (3)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3541` | Self: 1.4% (70.9ms) | Total: 1.4% (70.9ms) | Samples: 150

**Called by:**
- `parseQuery` (150)

### `Promise`
`[native code]` | Self: 1.4% (69.9ms) | Total: 9.0% (445.4ms) | Samples: 165

**Called by:**
- `waitForLayer` (860)
- `awaitPipelineOrStream` (276)
- `SettlementSignal` (2)

**Calls:**
- `(anonymous)` (319)
- `(anonymous)` (211)
- `(anonymous)` (115)
- `(anonymous)` (88)
- `(anonymous)` (76)
- `(anonymous)` (75)
- `(anonymous)` (21)
- `(anonymous)` (20)
- `(anonymous)` (19)
- `(anonymous)` (17)
- `(anonymous)` (10)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 1.3% (68.4ms) | Total: 1.3% (68.4ms) | Samples: 127

**Called by:**
- `init` (127)

### `onceResponded`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2024` | Self: 1.3% (67.3ms) | Total: 1.3% (67.3ms) | Samples: 168

**Called by:**
- `(anonymous)` (164)
- `(anonymous)` (4)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js:7` | Self: 1.3% (65.4ms) | Total: 7.0% (346.2ms) | Samples: 119

**Called by:**
- `#runPipeline` (810)

**Calls:**
- `async (anonymous)` (676)
- `asyncFunctionDrive` (11)
- `async (anonymous)` (4)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1124` | Self: 1.3% (63.7ms) | Total: 1.3% (64.3ms) | Samples: 129

**Called by:**
- `init` (131)

**Calls:**
- `(anonymous)` (2)

### `createNullArray`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:27` | Self: 1.2% (61.9ms) | Total: 1.2% (61.9ms) | Samples: 153

**Called by:**
- `async (anonymous)` (153)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1213` | Self: 1.2% (59.9ms) | Total: 1.2% (59.9ms) | Samples: 137

**Called by:**
- `async apply` (132)
- `async apply` (5)

### `#watchLateRejection`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5197` | Self: 1.1% (57.7ms) | Total: 1.1% (57.7ms) | Samples: 152

**Called by:**
- `(anonymous)` (152)

### `method`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` | Self: 1.0% (53.7ms) | Total: 1.0% (53.7ms) | Samples: 110

**Called by:**
- `#routeRequest` (69)
- `#canSkipHeaders` (41)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:623` | Self: 1.0% (53.5ms) | Total: 1.0% (53.5ms) | Samples: 115

**Called by:**
- `Promise` (115)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3506` | Self: 1.0% (50.7ms) | Total: 1.0% (50.7ms) | Samples: 129

**Called by:**
- `parseQuery` (129)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:281` | Self: 1.0% (50.6ms) | Total: 1.0% (50.6ms) | Samples: 123

**Called by:**
- `getMatchedLayers` (123)

### `alloc`
`[native code]` | Self: 1.0% (49.7ms) | Total: 1.0% (49.7ms) | Samples: 136

**Called by:**
- `#finishAbsentBody` (136)

### `async handleBodyParsing`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3349` | Self: 1.0% (49.5ms) | Total: 6.5% (322.5ms) | Samples: 164

**Called by:**
- `async (anonymous)` (873)

**Calls:**
- `async handleBodyParsing` (261)
- `async handleBodyParsing` (143)
- `asyncFunctionDrive` (99)
- `async handleBodyParsing` (96)
- `async handleBodyParsing` (73)
- `async handleBodyParsing` (22)
- `async handleBodyParsing` (13)
- `async handleBodyParsing` (1)
- `async handleBodyParsing` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:410` | Self: 0.9% (48.2ms) | Total: 2.4% (117.8ms) | Samples: 130

**Called by:**
- `serveNativeRequest` (317)

**Calls:**
- `BunResponse` (98)
- `BunResponse` (87)
- `BunResponse` (1)
- `parseCookies` (1)

### `async #parseBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3118` | Self: 0.9% (46.6ms) | Total: 0.9% (46.6ms) | Samples: 106

**Called by:**
- `async #parseBody` (106)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:177` | Self: 0.9% (46.0ms) | Total: 0.9% (47.5ms) | Samples: 19

**Called by:**
- `forEach` (22)

**Calls:**
- `getMetadata` (2)
- `getMetadata` (1)

### `async #parseBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3112` | Self: 0.9% (45.7ms) | Total: 2.0% (101.0ms) | Samples: 115

**Called by:**
- `async handleBodyParsing` (254)

**Calls:**
- `async #parseBody` (106)
- `async #parseBody` (19)
- `async #parseBody` (12)
- `async #parseBody` (2)

### `(anonymous)`
`[native code]` | Self: 0.9% (44.8ms) | Total: 0.9% (46.4ms) | Samples: 123

**Called by:**
- `finish` (73)
- `(anonymous)` (42)
- `bound require` (5)
- `useColors` (5)
- `node:_http_server` (1)
- `internal:streams/duplex` (1)
- `node:zlib` (1)
- `complete` (1)

**Calls:**
- `WriteStream` (2)
- `WriteStream` (2)
- `Buffer` (1)
- `WriteStream` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` | Self: 0.8% (43.1ms) | Total: 0.8% (43.1ms) | Samples: 103

**Called by:**
- `async (anonymous)` (55)
- `async (anonymous)` (27)
- `async (anonymous)` (18)
- `async (anonymous)` (2)
- `async (anonymous)` (1)

### `getRequestPathFromRequestURL`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4470` | Self: 0.8% (42.9ms) | Total: 0.8% (43.5ms) | Samples: 104

**Called by:**
- `getMatchedLayers` (105)

**Calls:**
- `indexOf` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2029` | Self: 0.8% (42.1ms) | Total: 0.8% (42.1ms) | Samples: 131

**Called by:**
- `finish` (131)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.7% (38.3ms) | Total: 0.7% (38.3ms) | Samples: 98

**Called by:**
- `#routeRequest` (98)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:676` | Self: 0.7% (35.2ms) | Total: 0.7% (35.2ms) | Samples: 75

**Called by:**
- `Promise` (75)

### `isStreamOpen`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1624` | Self: 0.6% (33.3ms) | Total: 0.6% (33.3ms) | Samples: 87

**Called by:**
- `(anonymous)` (87)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3520` | Self: 0.6% (33.0ms) | Total: 0.6% (33.0ms) | Samples: 96

**Called by:**
- `originalUrl` (58)
- `parseQuery` (38)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4777` | Self: 0.6% (32.6ms) | Total: 0.6% (32.6ms) | Samples: 74

**Called by:**
- `dispatch` (74)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5154` | Self: 0.6% (32.2ms) | Total: 0.6% (32.2ms) | Samples: 52

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3507` | Self: 0.6% (31.2ms) | Total: 0.6% (31.2ms) | Samples: 82

**Called by:**
- `parseQuery` (82)

### `async intercept`
`/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js:10` | Self: 0.6% (30.6ms) | Total: 0.6% (30.6ms) | Samples: 65

**Called by:**
- `async (anonymous)` (65)

### `async handleBodyParsing`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3416` | Self: 0.6% (30.2ms) | Total: 0.6% (30.2ms) | Samples: 73

**Called by:**
- `async handleBodyParsing` (73)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.6% (29.5ms) | Total: 0.6% (29.5ms) | Samples: 81

**Called by:**
- `Promise` (76)
- `set response` (5)

### `async intercept`
`/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js` | Self: 0.5% (29.0ms) | Total: 0.5% (29.0ms) | Samples: 81

**Called by:**
- `async (anonymous)` (81)

### `#waitLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5151` | Self: 0.5% (28.8ms) | Total: 0.5% (28.8ms) | Samples: 74

**Called by:**
- `#runPipeline` (54)
- `#routeRequest` (12)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:181` | Self: 0.5% (28.5ms) | Total: 2.6% (130.8ms) | Samples: 88

**Called by:**
- `async (anonymous)` (333)

**Calls:**
- `async (anonymous)` (200)
- `asyncFunctionDrive` (27)
- `async (anonymous)` (18)

### `setPrototypeDirectOrThrow`
`[native code]` | Self: 0.5% (28.4ms) | Total: 0.5% (28.4ms) | Samples: 3

**Called by:**
- `(module)` (1)
- `node:perf_hooks` (1)
- `(module)` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1306` | Self: 0.5% (26.5ms) | Total: 2.1% (106.8ms) | Samples: 27

**Called by:**
- `init` (262)

**Calls:**
- `parseCookies` (152)
- `parseCookies` (50)
- `parseCookies` (20)
- `parseCookies` (6)
- `parseCookies` (6)
- `parseCookies` (1)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:685` | Self: 0.5% (26.2ms) | Total: 0.6% (30.1ms) | Samples: 76

**Called by:**
- `#routeRequest` (87)

**Calls:**
- `(anonymous)` (10)
- `(anonymous)` (1)

### `waitForLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:673` | Self: 0.5% (24.7ms) | Total: 7.1% (351.2ms) | Samples: 52

**Called by:**
- `#waitLayer` (912)

**Calls:**
- `Promise` (860)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:38` | Self: 0.4% (23.2ms) | Total: 0.4% (23.2ms) | Samples: 59

**Called by:**
- `async (anonymous)` (59)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:36` | Self: 0.4% (22.5ms) | Total: 1.1% (55.5ms) | Samples: 46

**Called by:**
- `async intercept` (138)

**Calls:**
- `async (anonymous)` (59)
- `async (anonymous)` (27)
- `async (anonymous)` (4)
- `static` (1)
- `static` (1)

### `applyCallbackToRouter`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:73` | Self: 0.4% (22.3ms) | Total: 0.4% (22.5ms) | Samples: 51

**Called by:**
- `(anonymous)` (52)

**Calls:**
- `bind` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:40` | Self: 0.4% (22.3ms) | Total: 5.4% (268.9ms) | Samples: 57

**Called by:**
- `async (anonymous)` (661)

**Calls:**
- `async (anonymous)` (378)
- `async (anonymous)` (161)
- `async (anonymous)` (55)
- `asyncFunctionDrive` (8)
- `async (anonymous)` (2)

### `cloneObject`
`[native code]` | Self: 0.4% (22.1ms) | Total: 0.4% (22.1ms) | Samples: 67

**Called by:**
- `#writableOptions` (65)
- `loadPrototype` (1)
- `(anonymous)` (1)

### `async intercept`
`/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js:11` | Self: 0.4% (21.8ms) | Total: 0.4% (21.8ms) | Samples: 27

**Called by:**
- `async (anonymous)` (27)

### `awaitPipelineOrStream`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:620` | Self: 0.4% (20.6ms) | Total: 2.8% (139.1ms) | Samples: 18

**Called by:**
- `async #awaitPipeline` (294)

**Calls:**
- `Promise` (276)

### `parseContentCodings`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:3668` | Self: 0.4% (20.4ms) | Total: 0.4% (21.6ms) | Samples: 66

**Called by:**
- `async handleBodyParsing` (71)

**Calls:**
- `get` (5)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5009` | Self: 0.4% (20.4ms) | Total: 0.4% (20.4ms) | Samples: 32

**Called by:**
- `#routeRequest` (12)

### `async #awaitPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:441` | Self: 0.4% (20.3ms) | Total: 3.9% (194.7ms) | Samples: 64

**Called by:**
- `#routeRequest` (363)
- `serveNativeRequest` (69)

**Calls:**
- `async #awaitPipeline` (308)
- `asyncFunctionDrive` (43)
- `async #awaitPipeline` (17)

### `async handleBodyParsing`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3351` | Self: 0.4% (19.6ms) | Total: 0.4% (19.6ms) | Samples: 26

**Called by:**
- `async (anonymous)` (26)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3511` | Self: 0.3% (19.3ms) | Total: 0.3% (19.3ms) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3042` | Self: 0.3% (18.2ms) | Total: 0.3% (18.2ms) | Samples: 50

**Called by:**
- `BunRequest` (50)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1335` | Self: 0.3% (17.0ms) | Total: 0.3% (17.0ms) | Samples: 39

**Called by:**
- `BunRequest` (39)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3040` | Self: 0.3% (16.7ms) | Total: 1.0% (53.3ms) | Samples: 47

**Called by:**
- `BunRequest` (152)
- `#routeRequest` (1)

**Calls:**
- `get` (106)

### `async handleBodyParsing`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3353` | Self: 0.3% (16.6ms) | Total: 0.3% (16.6ms) | Samples: 31

**Called by:**
- `async handleBodyParsing` (22)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` | Self: 0.3% (16.3ms) | Total: 0.3% (16.3ms) | Samples: 1

**Called by:**
- `addModuleRef` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3540` | Self: 0.3% (15.6ms) | Total: 0.3% (15.6ms) | Samples: 26

**Called by:**
- `parseQuery` (26)

### `reduce`
`[native code]` | Self: 0.3% (15.6ms) | Total: 0.6% (30.5ms) | Samples: 4

**Called by:**
- `reflectInjectables` (29)
- `explore` (20)

**Calls:**
- `(anonymous)` (25)
- `(anonymous)` (18)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `getRequestPathFromRequestURL`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4471` | Self: 0.3% (14.8ms) | Total: 0.3% (14.8ms) | Samples: 37

**Called by:**
- `getMatchedLayers` (37)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:713` | Self: 0.2% (12.9ms) | Total: 0.2% (12.9ms) | Samples: 23

**Called by:**
- `response` (22)
- `set response` (1)

### `async handleBodyParsing`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3392` | Self: 0.2% (12.6ms) | Total: 1.1% (57.6ms) | Samples: 39

**Called by:**
- `async handleBodyParsing` (143)

**Calls:**
- `get` (104)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5072` | Self: 0.2% (12.5ms) | Total: 0.2% (12.5ms) | Samples: 31

**Called by:**
- `#routeRequest` (10)

### `getMetadataKey`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:20` | Self: 0.2% (12.4ms) | Total: 0.2% (12.4ms) | Samples: 44

**Called by:**
- `get` (44)

### `DateTimeFormat`
`[native code]` | Self: 0.2% (12.3ms) | Total: 0.2% (12.3ms) | Samples: 40

**Called by:**
- `(anonymous)` (39)
- `(anonymous)` (1)

### `dispatch`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4988` | Self: 0.2% (12.2ms) | Total: 0.2% (12.2ms) | Samples: 15

**Called by:**
- `#routeRequest` (15)

### `dispatch`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4984` | Self: 0.2% (12.0ms) | Total: 3.3% (164.7ms) | Samples: 32

**Called by:**
- `#routeRequest` (400)

**Calls:**
- `getMatchedLayers` (144)
- `getMatchedLayers` (123)
- `getMatchedLayers` (74)
- `getMatchedLayers` (19)
- `getMatchedLayers` (3)
- `getMatchedLayers` (2)
- `getMatchedLayers` (1)
- `getMatchedLayers` (1)
- `getMatchedLayers` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:41` | Self: 0.2% (11.1ms) | Total: 1.4% (73.1ms) | Samples: 36

**Called by:**
- `async (anonymous)` (161)

**Calls:**
- `createNullArray` (153)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:46` | Self: 0.2% (11.1ms) | Total: 3.2% (159.1ms) | Samples: 36

**Called by:**
- `async (anonymous)` (378)

**Calls:**
- `async intercept` (140)
- `async intercept` (81)
- `async intercept` (65)
- `handler` (29)
- `async intercept` (27)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1261` | Self: 0.2% (11.1ms) | Total: 0.2% (11.9ms) | Samples: 37

**Called by:**
- `init` (41)

**Calls:**
- `normalizeParseBodyOptions` (2)
- `normalizeParseBodyOptions` (1)
- `normalizeParseBodyOptions` (1)

### `serveNativeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:377` | Self: 0.2% (10.5ms) | Total: 28.7% (1.40s) | Samples: 38

**Called by:**
- `(anonymous)` (3183)
- `(module)` (253)
- `bound serveNativeRequest` (50)

**Calls:**
- `#routeRequest` (2548)
- `#routeRequest` (363)
- `#routeRequest` (317)
- `#routeRequest` (70)
- `async #awaitPipeline` (69)
- `#routeRequest` (62)
- `#routeRequest` (11)
- `#routeRequest` (4)
- `#routeRequest` (1)
- `#routeRequest` (1)
- `#routeRequest` (1)
- `#routeRequest` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:182` | Self: 0.2% (10.4ms) | Total: 1.8% (89.2ms) | Samples: 25

**Called by:**
- `async (anonymous)` (200)

**Calls:**
- `async transformToResult` (188)
- `async transformToResult` (5)
- `async transformToResult` (1)

### `handler`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:36` | Self: 0.2% (10.3ms) | Total: 0.2% (10.3ms) | Samples: 29

**Called by:**
- `async (anonymous)` (29)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:621` | Self: 0.2% (10.2ms) | Total: 0.2% (10.2ms) | Samples: 21

**Called by:**
- `Promise` (21)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:712` | Self: 0.1% (9.5ms) | Total: 1.6% (82.8ms) | Samples: 28

**Called by:**
- `Promise` (211)

**Calls:**
- `onceResponded` (164)
- `onceResponded` (16)
- `onceResponded` (3)

### `RegExp`
`[native code]` | Self: 0.1% (9.5ms) | Total: 0.1% (9.5ms) | Samples: 24

**Called by:**
- `pathRegex` (23)
- `(module)` (1)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5220` | Self: 0.1% (9.5ms) | Total: 0.1% (9.5ms) | Samples: 34

**Called by:**
- `(anonymous)` (34)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:181` | Self: 0.1% (9.4ms) | Total: 0.1% (9.4ms) | Samples: 13

**Called by:**
- `forEach` (13)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js:9` | Self: 0.1% (9.1ms) | Total: 5.6% (278.3ms) | Samples: 21

**Called by:**
- `async (anonymous)` (676)

**Calls:**
- `async (anonymous)` (661)
- `async (anonymous)` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:694` | Self: 0.1% (8.8ms) | Total: 1.1% (56.2ms) | Samples: 28

**Called by:**
- `next` (158)
- `Promise` (19)

**Calls:**
- `finish` (124)
- `finish` (25)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1299` | Self: 0.1% (8.8ms) | Total: 0.2% (10.6ms) | Samples: 6

**Called by:**
- `init` (9)

**Calls:**
- `#configuredCookieSecrets` (1)
- `#configuredCookieSecrets` (1)
- `#configuredCookieSecrets` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:11` | Self: 0.1% (8.6ms) | Total: 0.1% (8.6ms) | Samples: 26

### `async (anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:824` | Self: 0.1% (8.6ms) | Total: 7.1% (352.7ms) | Samples: 22

**Called by:**
- `async middlewareHandler` (926)

**Calls:**
- `async handleBodyParsing` (873)
- `async handleBodyParsing` (26)
- `async handleBodyParsing` (7)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3521` | Self: 0.1% (8.5ms) | Total: 0.1% (8.5ms) | Samples: 32

**Called by:**
- `parseQuery` (32)

### `init`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1432` | Self: 0.1% (8.4ms) | Total: 15.8% (777.3ms) | Samples: 26

**Called by:**
- `serveNativeRequest` (1900)

**Calls:**
- `BunRequest` (544)
- `BunRequest` (376)
- `BunRequest` (301)
- `BunRequest` (262)
- `BunRequest` (131)
- `BunRequest` (127)
- `BunRequest` (80)
- `BunRequest` (41)
- `BunRequest` (9)
- `BunRequest` (1)
- `BunRequest` (1)
- `BunRequest` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:395` | Self: 0.1% (8.0ms) | Total: 0.1% (8.0ms) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3533` | Self: 0.1% (7.9ms) | Total: 0.1% (7.9ms) | Samples: 29

**Called by:**
- `parseQuery` (29)

### `#waitLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5152` | Self: 0.1% (7.9ms) | Total: 7.3% (360.0ms) | Samples: 24

**Called by:**
- `#runPipeline` (857)
- `#routeRequest` (34)

**Calls:**
- `waitForLayer` (912)
- `(anonymous)` (1)
- `waitForLayer` (1)

### `async apply`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:14` | Self: 0.1% (7.8ms) | Total: 0.1% (9.4ms) | Samples: 28

**Called by:**
- `async (anonymous)` (33)

**Calls:**
- `#respondWithText` (5)

### `parseContentCodings`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:3669` | Self: 0.1% (7.8ms) | Total: 0.1% (7.8ms) | Samples: 24

**Called by:**
- `async handleBodyParsing` (24)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1214` | Self: 0.1% (7.7ms) | Total: 9.5% (466.8ms) | Samples: 23

**Called by:**
- `async apply` (1193)

**Calls:**
- `Response` (1020)
- `response` (106)
- `#initWithoutHeaders` (17)
- `set response` (11)
- `set response` (6)
- `set response` (4)
- `set response` (3)
- `set response` (2)
- `set response` (1)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1336` | Self: 0.1% (7.6ms) | Total: 0.1% (7.6ms) | Samples: 29

**Called by:**
- `BunRequest` (29)

### `reflectInjectables`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:161` | Self: 0.1% (7.6ms) | Total: 0.1% (9.7ms) | Samples: 16

**Called by:**
- `reflectDynamicMetadata` (16)
- `reflectDynamicMetadata` (5)
- `reflectDynamicMetadata` (1)

**Calls:**
- `getAllMethodNames` (1)
- `getAllMethodNames` (1)
- `getAllMethodNames` (1)
- `getAllMethodNames` (1)
- `getAllMethodNames` (1)
- `getAllMethodNames` (1)

### `OrdinaryGetMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.1% (7.5ms) | Total: 0.1% (7.5ms) | Samples: 19

**Called by:**
- `getMetadata` (19)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:33` | Self: 0.1% (7.5ms) | Total: 0.1% (8.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (3)
- `(anonymous)` (1)

**Calls:**
- `map` (2)
- `appendToAllIfDefined` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:677` | Self: 0.1% (7.5ms) | Total: 0.1% (7.5ms) | Samples: 20

**Called by:**
- `Promise` (20)

### `onceResponded`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2019` | Self: 0.1% (7.5ms) | Total: 0.1% (7.5ms) | Samples: 21

**Called by:**
- `(anonymous)` (16)
- `(anonymous)` (5)

### `#finishPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5314` | Self: 0.1% (7.3ms) | Total: 0.1% (7.3ms) | Samples: 1

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1340` | Self: 0.1% (7.3ms) | Total: 1.1% (57.0ms) | Samples: 21

**Called by:**
- `BunRequest` (157)

**Calls:**
- `alloc` (136)

### `response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:963` | Self: 0.1% (7.1ms) | Total: 0.8% (41.7ms) | Samples: 17

**Called by:**
- `#respondWithText` (106)

**Calls:**
- `(anonymous)` (55)
- `(anonymous)` (22)
- `(anonymous)` (12)

### `next`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5079` | Self: 0.1% (6.4ms) | Total: 0.1% (6.4ms) | Samples: 23

**Called by:**
- `async (anonymous)` (23)

### `@lazy`
`[native code]` | Self: 0.1% (6.2ms) | Total: 0.1% (6.2ms) | Samples: 6

**Called by:**
- `node:vm` (3)
- `node:path` (2)
- `internal:fs/binding` (1)

### `GetMethod`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.1% (6.2ms) | Total: 0.1% (6.2ms) | Samples: 1

**Called by:**
- `GetIterator` (1)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3045` | Self: 0.1% (5.7ms) | Total: 0.1% (5.7ms) | Samples: 20

**Called by:**
- `BunRequest` (20)

### `async #parseBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3132` | Self: 0.1% (5.6ms) | Total: 0.1% (5.6ms) | Samples: 19

**Called by:**
- `async #parseBody` (19)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2997` | Self: 0.1% (5.5ms) | Total: 0.1% (5.8ms) | Samples: 6

**Called by:**
- `BunRequest` (7)

**Calls:**
- `create` (1)

### `(unknown)`
`[native code]` | Self: 0.1% (5.4ms) | Total: 0.1% (5.4ms) | Samples: 13

**Called by:**
- `reflectCallbackParamtypes` (1)
- `(anonymous)` (1)
- `next` (1)

### `async #awaitPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` | Self: 0.1% (5.4ms) | Total: 0.1% (5.4ms) | Samples: 17

**Called by:**
- `async #awaitPipeline` (17)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:99` | Self: 0.1% (5.4ms) | Total: 0.1% (5.4ms) | Samples: 2

**Called by:**
- `map` (2)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:720` | Self: 0.1% (5.3ms) | Total: 0.5% (24.9ms) | Samples: 12

**Called by:**
- `response` (55)
- `set response` (3)

**Calls:**
- `finish` (45)
- `finish` (1)

### `map`
`[native code]` | Self: 0.1% (5.2ms) | Total: 1.0% (53.0ms) | Samples: 26

**Called by:**
- `async createInstancesOfControllers` (55)
- `async createInstances` (20)
- `async createInstancesOfProviders` (18)
- `#build` (14)
- `async resolveMiddleware` (10)
- `getMetadata` (7)
- `async resolveConstructorParams` (7)
- `create` (7)
- `create` (6)
- `create` (6)
- `(anonymous)` (6)
- `async resolveInstances` (5)
- `getArgumentsLength` (4)
- `compileRoute` (3)
- `compileRoute` (2)
- `(anonymous)` (2)
- `create` (2)
- `#compileRouteRegExp` (1)
- `removeOverlappedRoutes` (1)
- `(anonymous)` (1)
- `extractWildcardNames` (1)
- `Route` (1)
- `getFactoryProviderDependencies` (1)
- `node:zlib` (1)
- `(anonymous)` (1)
- `node:zlib` (1)

**Calls:**
- `async (anonymous)` (55)
- `async (anonymous)` (20)
- `async (anonymous)` (17)
- `async loadMiddlewareConfiguration` (10)
- `(anonymous)` (5)
- `async resolveInstance` (5)
- `async resolveParam` (5)
- `(anonymous)` (4)
- `concatPaths` (3)
- `compileRoute` (3)
- `compileRoute` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `compileRoute` (2)
- `(anonymous)` (2)
- `compileRoute` (2)
- `async (anonymous)` (1)
- `compileRoute` (1)
- `(anonymous)` (1)
- `insertMiddleware` (1)
- `(anonymous)` (1)
- `segmentKind` (1)
- `segmentKind` (1)
- `segmentKind` (1)
- `compileRoute` (1)
- `(anonymous)` (1)
- `mapFactoryProviderInjectArray` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.1% (5.2ms) | Total: 0.1% (5.2ms) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `get`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:49` | Self: 0.1% (5.0ms) | Total: 0.1% (5.0ms) | Samples: 1

### `async handleBodyParsing`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (4.8ms) | Total: 0.0% (4.8ms) | Samples: 20

**Called by:**
- `async handleBodyParsing` (13)
- `async (anonymous)` (7)

### `async #awaitPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:454` | Self: 0.0% (4.8ms) | Total: 2.9% (144.0ms) | Samples: 17

**Called by:**
- `async #awaitPipeline` (308)

**Calls:**
- `awaitPipelineOrStream` (294)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:28` | Self: 0.0% (4.5ms) | Total: 0.0% (4.5ms) | Samples: 1

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1267` | Self: 0.0% (4.4ms) | Total: 4.9% (243.4ms) | Samples: 17

**Called by:**
- `init` (544)

**Calls:**
- `parseQuery` (505)
- `parseQuery` (13)
- `parseQuery` (7)
- `parseQuery` (2)

### `getProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:950` | Self: 0.0% (4.4ms) | Total: 0.0% (4.6ms) | Samples: 3

**Called by:**
- `GetMetadataProvider` (3)
- `setProvider` (1)

**Calls:**
- `get` (1)

### `node:fs`
`node:fs:8` | Self: 0.0% (4.3ms) | Total: 0.0% (4.3ms) | Samples: 1

### `set`
`[native code]` | Self: 0.0% (4.3ms) | Total: 0.0% (4.3ms) | Samples: 7

**Called by:**
- `define` (2)
- `define` (1)
- `set` (1)
- `getAllMethodNames` (1)
- `setProvider` (1)
- `getAllMethodNames` (1)

### `indexOf`
`[native code]` | Self: 0.0% (4.3ms) | Total: 0.0% (4.3ms) | Samples: 4

**Called by:**
- `require` (3)
- `getRequestPathFromRequestURL` (1)

### `create`
`[native code]` | Self: 0.0% (4.2ms) | Total: 0.0% (4.2ms) | Samples: 3

**Called by:**
- `createErrorClass` (1)
- `parseQuery` (1)
- `loadPrototype` (1)

### `require`
`[native code]` | Self: 0.0% (4.2ms) | Total: 30.3% (1.48s) | Samples: 16

**Called by:**
- `bound require` (5362)

**Calls:**
- `anonymous` (5337)
- `indexOf` (3)
- `get` (3)
- `startsWith` (2)
- `endsWith` (1)

### `#initWithoutHeaders`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:581` | Self: 0.0% (4.2ms) | Total: 0.0% (4.2ms) | Samples: 17

**Called by:**
- `#respondWithText` (17)

### `node:zlib`
`node:zlib:2` | Self: 0.0% (4.2ms) | Total: 0.0% (4.2ms) | Samples: 2

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1331` | Self: 0.0% (4.2ms) | Total: 0.5% (27.1ms) | Samples: 14

**Called by:**
- `BunRequest` (84)

**Calls:**
- `get` (70)

### `#writableOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1356` | Self: 0.0% (3.8ms) | Total: 0.5% (25.6ms) | Samples: 14

**Called by:**
- `BunRequest` (79)

**Calls:**
- `cloneObject` (65)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:645` | Self: 0.0% (3.7ms) | Total: 0.0% (3.7ms) | Samples: 13

**Called by:**
- `response` (12)
- `set response` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:625` | Self: 0.0% (3.7ms) | Total: 0.0% (3.7ms) | Samples: 12

### `isEmpty`
`/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js` | Self: 0.0% (3.7ms) | Total: 0.0% (3.7ms) | Samples: 3

**Called by:**
- `createConcreteContext` (3)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:514` | Self: 0.0% (3.6ms) | Total: 0.0% (3.6ms) | Samples: 10

**Called by:**
- `BunResponse` (10)

### `isNil`
`/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:46` | Self: 0.0% (3.6ms) | Total: 0.0% (3.6ms) | Samples: 1

**Called by:**
- `isObject` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:691` | Self: 0.0% (3.6ms) | Total: 0.0% (3.6ms) | Samples: 10

**Called by:**
- `Promise` (10)

### `assign`
`[native code]` | Self: 0.0% (3.5ms) | Total: 0.0% (3.5ms) | Samples: 10

**Called by:**
- `initialize` (10)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2992` | Self: 0.0% (3.5ms) | Total: 4.6% (226.5ms) | Samples: 2

**Called by:**
- `BunRequest` (505)

**Calls:**
- `splitRequestUrl` (150)
- `splitRequestUrl` (129)
- `splitRequestUrl` (82)
- `splitRequestUrl` (38)
- `splitRequestUrl` (32)
- `splitRequestUrl` (29)
- `splitRequestUrl` (26)
- `splitRequestUrl` (9)
- `splitRequestUrl` (7)
- `splitRequestUrl` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3530` | Self: 0.0% (3.4ms) | Total: 0.0% (3.4ms) | Samples: 9

**Called by:**
- `parseQuery` (9)

### `onceResponded`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (3.2ms) | Total: 0.0% (3.2ms) | Samples: 7

**Called by:**
- `(anonymous)` (4)
- `(anonymous)` (3)

### `isObservable`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/isObservable.js:7` | Self: 0.0% (3.2ms) | Total: 0.0% (3.2ms) | Samples: 3

**Called by:**
- `async transformToResult` (3)

### `get query`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (3.1ms) | Total: 0.0% (3.1ms) | Samples: 1

**Called by:**
- `parseQuery` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:413` | Self: 0.0% (3.0ms) | Total: 0.0% (3.0ms) | Samples: 11

**Called by:**
- `serveNativeRequest` (11)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2991` | Self: 0.0% (3.0ms) | Total: 0.0% (3.2ms) | Samples: 12

**Called by:**
- `BunRequest` (13)

**Calls:**
- `#configuredQueryOpts` (1)

### `async (anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:833` | Self: 0.0% (3.0ms) | Total: 1.3% (65.9ms) | Samples: 11

**Calls:**
- `next` (168)
- `next` (23)
- `next` (2)

### `addController`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` | Self: 0.0% (3.0ms) | Total: 0.0% (3.0ms) | Samples: 2

**Called by:**
- `addController` (2)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:697` | Self: 0.0% (2.9ms) | Total: 0.0% (2.9ms) | Samples: 9

### `InstanceWrapper`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:18` | Self: 0.0% (2.9ms) | Total: 0.0% (2.9ms) | Samples: 2

**Called by:**
- `addController` (2)

### `async #parseBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (2.8ms) | Total: 0.0% (2.8ms) | Samples: 13

**Called by:**
- `async #parseBody` (12)
- `async handleBodyParsing` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3546` | Self: 0.0% (2.7ms) | Total: 0.0% (2.7ms) | Samples: 7

**Called by:**
- `parseQuery` (7)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js` | Self: 0.0% (2.7ms) | Total: 0.0% (2.7ms) | Samples: 10

**Called by:**
- `#runPipeline` (6)
- `async (anonymous)` (4)

### `finish`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:678` | Self: 0.0% (2.6ms) | Total: 0.0% (2.6ms) | Samples: 2

### `reply`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` | Self: 0.0% (2.6ms) | Total: 0.0% (2.6ms) | Samples: 7

**Called by:**
- `async apply` (7)

### `OrdinaryGetMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:595` | Self: 0.0% (2.4ms) | Total: 0.0% (4.6ms) | Samples: 5

**Called by:**
- `OrdinaryGetMetadata` (7)
- `getMetadata` (7)

**Calls:**
- `OrdinaryGetPrototypeOf` (3)
- `OrdinaryGetPrototypeOf` (3)
- `OrdinaryGetPrototypeOf` (2)
- `OrdinaryGetPrototypeOf` (1)

### `hasProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (2.4ms) | Total: 0.0% (2.4ms) | Samples: 1

**Called by:**
- `setProvider` (1)

### `getProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (2.3ms) | Total: 0.0% (2.3ms) | Samples: 11

**Called by:**
- `GetMetadataProvider` (11)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` | Self: 0.0% (2.3ms) | Total: 0.0% (2.3ms) | Samples: 2

**Called by:**
- `async makeTarget` (2)

### `split`
`[native code]` | Self: 0.0% (2.2ms) | Total: 0.0% (2.2ms) | Samples: 11

**Called by:**
- `mimeScore` (11)

### `push`
`[native code]` | Self: 0.0% (2.2ms) | Total: 0.0% (2.2ms) | Samples: 5

**Called by:**
- `getAllMethodNames` (1)
- `pathRegex` (1)
- `pathRegex` (1)
- `#build` (1)
- `BunRequest` (1)

### `node:stream/web`
`node:stream/web:6` | Self: 0.0% (2.2ms) | Total: 0.0% (2.2ms) | Samples: 1

### `applySettlementSignal`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (2.1ms) | Total: 0.0% (2.1ms) | Samples: 1

**Called by:**
- `async loadInstance` (1)

### `fromContainer`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js` | Self: 0.0% (2.1ms) | Total: 0.0% (2.1ms) | Samples: 2

**Called by:**
- `async instantiateClass` (2)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:628` | Self: 0.0% (2.1ms) | Total: 0.3% (14.8ms) | Samples: 7

**Calls:**
- `(anonymous)` (42)

### `defineProperty`
`[native code]` | Self: 0.0% (2.1ms) | Total: 0.0% (2.1ms) | Samples: 9

**Called by:**
- `(anonymous)` (3)
- `assignControllerUniqueId` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `getStatusByMethod`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:39` | Self: 0.0% (2.0ms) | Total: 0.0% (2.0ms) | Samples: 2

**Called by:**
- `getMetadata` (2)

### `#respond`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:482` | Self: 0.0% (2.0ms) | Total: 0.0% (2.0ms) | Samples: 9

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` | Self: 0.0% (1.9ms) | Total: 0.0% (1.9ms) | Samples: 8

**Called by:**
- `forEach` (8)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3029` | Self: 0.0% (1.9ms) | Total: 0.0% (1.9ms) | Samples: 6

**Called by:**
- `BunRequest` (6)

### `forEach`
`[native code]` | Self: 0.0% (1.9ms) | Total: 17.7% (868.5ms) | Samples: 9

**Called by:**
- `resolve` (443)
- `registerRouters` (442)
- `(anonymous)` (425)
- `applyPathsToRouterProxy` (379)
- `applyCallbackToRouter` (148)
- `reflectControllers` (142)
- `(anonymous)` (118)
- `reflectParamInjectables` (44)
- `populateMaps` (41)
- `createPrototypesOfControllers` (23)
- `createPrototypes` (23)
- `populateMaps` (13)
- `(anonymous)` (8)
- `async registerHandler` (6)
- `register` (5)
- `reflectProviders` (3)
- `(anonymous)` (2)
- `reflectInjectables` (2)
- `validateModuleKeys` (2)
- `insertConfig` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (442)
- `(anonymous)` (426)
- `(anonymous)` (415)
- `(anonymous)` (379)
- `(anonymous)` (118)
- `(anonymous)` (114)
- `(anonymous)` (85)
- `(anonymous)` (28)
- `(anonymous)` (24)
- `forEachMimeType` (24)
- `(anonymous)` (23)
- `(anonymous)` (22)
- `loadPrototype` (13)
- `(anonymous)` (13)
- `(anonymous)` (13)
- `loadPrototype` (9)
- `(anonymous)` (9)
- `(anonymous)` (8)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `forEachMimeType` (6)
- `(anonymous)` (6)
- `forEachMimeType` (5)
- `(anonymous)` (5)
- `(anonymous)` (5)
- `connectAllGateways` (4)
- `(anonymous)` (4)
- `forEachMimeType` (4)
- `forEachMimeType` (3)
- `forEachMimeType` (3)
- `(anonymous)` (3)
- `(anonymous)` (2)
- `forEachMimeType` (2)
- `(anonymous)` (2)
- `forEachMimeType` (2)
- `loadPrototype` (1)
- `connectAllGateways` (1)
- `(anonymous)` (1)
- `mapIterationEntryKey` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `forEachMimeType` (1)
- `(anonymous)` (1)
- `validateKey` (1)
- `forEachMimeType` (1)
- `(anonymous)` (1)

### `RouteController`
`[native code]` | Self: 0.0% (1.8ms) | Total: 0.0% (1.8ms) | Samples: 2

**Called by:**
- `async instantiateClass` (2)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (1.8ms) | Total: 0.0% (1.8ms) | Samples: 2

**Called by:**
- `async resolveParam` (1)
- `async callback` (1)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1203` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 7

**Called by:**
- `async apply` (7)

### `importModule`
`[native code]` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 8

**Called by:**
- `async makeTarget` (7)
- `async makeTarget` (1)

### `ExternalExceptionFilterContext`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter-context.js` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 1

**Called by:**
- `fromContainer` (1)

### `async apply`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:15` | Self: 0.0% (1.6ms) | Total: 11.3% (558.4ms) | Samples: 5

**Called by:**
- `async (anonymous)` (1401)

**Calls:**
- `#respondWithText` (1193)
- `#respondWithText` (132)
- `#respondWithText` (44)
- `#respondWithText` (7)
- `reply` (7)
- `send` (6)
- `send` (2)
- `reply` (2)
- `#respondWithText` (1)
- `send` (1)
- `reply` (1)

### `OrdinaryMetadataKeys`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (1.6ms) | Total: 0.0% (1.6ms) | Samples: 1

**Called by:**
- `getMetadataKeys` (1)

### `static`
`/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:26` | Self: 0.0% (1.6ms) | Total: 0.0% (1.6ms) | Samples: 1

**Called by:**
- `async (anonymous)` (1)

### `createConcreteContext`
`/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:19` | Self: 0.0% (1.6ms) | Total: 0.0% (1.6ms) | Samples: 4

**Called by:**
- `createContext` (2)
- `createContext` (2)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3044` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 6

**Called by:**
- `BunRequest` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 6

**Called by:**
- `forEach` (6)

### `getMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 4

**Called by:**
- `(anonymous)` (2)
- `reflectProperties` (1)
- `reflectOptionalParams` (1)

### `async middlewareHandler`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 5

**Called by:**
- `#runPipeline` (5)

### `node:http`
`node:http:2` | Self: 0.0% (1.4ms) | Total: 0.2% (13.7ms) | Samples: 1

**Calls:**
- `anonymous` (55)

### `getOwnPropertyDescriptor`
`[native code]` | Self: 0.0% (1.4ms) | Total: 0.0% (1.4ms) | Samples: 7

**Called by:**
- `reflectKeyMetadata` (4)
- `getAllMethodNames` (3)

### `send`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1396` | Self: 0.0% (1.4ms) | Total: 0.0% (1.4ms) | Samples: 6

**Called by:**
- `async apply` (6)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5178` | Self: 0.0% (1.4ms) | Total: 0.2% (11.7ms) | Samples: 3

**Calls:**
- `#settleLayer` (34)
- `#settleLayer` (2)

### `async handleBodyParsing`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3420` | Self: 0.0% (1.4ms) | Total: 2.0% (102.7ms) | Samples: 6

**Called by:**
- `async handleBodyParsing` (261)

**Calls:**
- `async #parseBody` (254)
- `async #parseBody` (1)

### `createContext`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:14` | Self: 0.0% (1.4ms) | Total: 0.0% (2.6ms) | Samples: 7

**Called by:**
- `create` (4)
- `create` (3)
- `create` (3)
- `create` (2)

**Calls:**
- `createConcreteContext` (1)
- `createConcreteContext` (1)
- `createConcreteContext` (1)
- `createConcreteContext` (1)
- `createConcreteContext` (1)

### `normalizePath`
`/home/user/bun-node/node_modules/@nestjs/core/adapters/http-adapter.js` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `get`
`/home/user/bun-node/node_modules/tslib/tslib.js:210` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 4

**Called by:**
- `(anonymous)` (1)
- `get` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:71` | Self: 0.0% (1.3ms) | Total: 0.1% (6.8ms) | Samples: 6

**Called by:**
- `async callback` (28)

**Calls:**
- `async resolveProperties` (26)
- `async resolveProperties` (1)

### `getMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:369` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `getMetadata` (1)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:951` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 6

**Called by:**
- `#respondWithText` (6)

### `async loadController`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:98` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 4

**Called by:**
- `async loadController` (2)

### `getGlobalMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:52` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 6

**Called by:**
- `createContext` (6)

### `createPrototype`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:228` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 5

**Called by:**
- `loadPrototype` (5)

### `async resolveConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:121` | Self: 0.0% (1.1ms) | Total: 0.2% (13.8ms) | Samples: 3

**Called by:**
- `async loadInstance` (37)

**Calls:**
- `async resolveConstructorParams` (13)
- `async resolveConstructorParams` (8)
- `async resolveConstructorParams` (4)
- `async resolveConstructorParams` (3)
- `async resolveConstructorParams` (2)
- `async resolveConstructorParams` (1)
- `async resolveConstructorParams` (1)
- `async resolveConstructorParams` (1)
- `async resolveConstructorParams` (1)

### `async resolveConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:179` | Self: 0.0% (1.1ms) | Total: 0.0% (2.6ms) | Samples: 1

**Called by:**
- `async resolveConstructorParams` (8)

**Calls:**
- `map` (7)

### `async callback`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:70` | Self: 0.0% (1.1ms) | Total: 0.1% (8.5ms) | Samples: 6

**Called by:**
- `async resolveConstructorParams` (35)

**Calls:**
- `async (anonymous)` (28)
- `async (anonymous)` (1)

### `has`
`[native code]` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 5

**Called by:**
- `OrdinaryHasOwnMetadata` (2)
- `getAllMethodNames` (1)
- `getMiddlewareCollection` (1)
- `getAllMethodNames` (1)

### `OrdinaryOwnMetadataKeys`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 3

**Called by:**
- `OrdinaryOwnMetadataKeys` (2)
- `OrdinaryMetadataKeys` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:247` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 2

**Called by:**
- `#compileRouteRegExp` (2)

### `from`
`[native code]` | Self: 0.0% (1.1ms) | Total: 0.2% (10.3ms) | Samples: 5

**Called by:**
- `async callModuleInitHook` (13)
- `async callModuleInitHook` (8)
- `async callModuleInitHook` (5)
- `async callModuleBootstrapHook` (5)
- `forRoutes` (2)
- `(module)` (2)
- `forRoutes` (2)
- `(module)` (2)
- `async callModuleBootstrapHook` (1)
- `async callModuleBootstrapHook` (1)
- `next` (1)
- `getClassDependencies` (1)

**Calls:**
- `next` (24)
- `next` (8)
- `next` (1)
- `(anonymous)` (1)
- `next` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `next` (1)

### `async setModule`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:105` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

### `async loadInstance`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:43` | Self: 0.0% (1.0ms) | Total: 0.0% (1.4ms) | Samples: 2

**Called by:**
- `async loadInstance` (3)

**Calls:**
- `getContextInquirerId` (2)

### `async transformToResult`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:31` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 5

**Called by:**
- `async (anonymous)` (5)

### `bound require`
`[native code]` | Self: 0.0% (1.0ms) | Total: 30.9% (1.51s) | Samples: 5

**Called by:**
- `(anonymous)` (379)
- `(anonymous)` (372)
- `(anonymous)` (366)
- `(anonymous)` (156)
- `(anonymous)` (154)
- `(anonymous)` (116)
- `(anonymous)` (116)
- `(anonymous)` (116)
- `(anonymous)` (114)
- `(anonymous)` (112)
- `(anonymous)` (105)
- `(anonymous)` (101)
- `(anonymous)` (100)
- `(anonymous)` (84)
- `(anonymous)` (81)
- `(anonymous)` (78)
- `(anonymous)` (66)
- `(anonymous)` (61)
- `(anonymous)` (59)
- `(anonymous)` (59)
- `(anonymous)` (53)
- `(anonymous)` (49)
- `(anonymous)` (49)
- `optionalRequire` (48)
- `(anonymous)` (44)
- `(anonymous)` (44)
- `(anonymous)` (43)
- `(anonymous)` (43)
- `(anonymous)` (41)
- `(anonymous)` (39)
- `(anonymous)` (37)
- `(anonymous)` (34)
- `(anonymous)` (32)
- `(anonymous)` (30)
- `(anonymous)` (29)
- `(anonymous)` (29)
- `(anonymous)` (29)
- `(anonymous)` (27)
- `(anonymous)` (26)
- `(anonymous)` (26)
- `(anonymous)` (25)
- `(anonymous)` (20)
- `(anonymous)` (20)
- `(anonymous)` (19)
- `(anonymous)` (19)
- `(anonymous)` (19)
- `(anonymous)` (18)
- `(anonymous)` (18)
- `(anonymous)` (18)
- `(anonymous)` (18)
- `(anonymous)` (17)
- `(anonymous)` (17)
- `(anonymous)` (17)
- `(anonymous)` (16)
- `(anonymous)` (16)
- `(anonymous)` (16)
- `(anonymous)` (15)
- `(anonymous)` (15)
- `(anonymous)` (15)
- `(anonymous)` (15)
- `(anonymous)` (15)
- `(anonymous)` (15)
- `(anonymous)` (14)
- `(anonymous)` (14)
- `(anonymous)` (14)
- `(anonymous)` (13)
- `(anonymous)` (13)
- `(anonymous)` (12)
- `(anonymous)` (12)
- `(anonymous)` (12)
- `(anonymous)` (12)
- `(anonymous)` (12)
- `(anonymous)` (11)
- `(anonymous)` (11)
- `(anonymous)` (11)
- `(anonymous)` (11)
- `(anonymous)` (11)
- `(anonymous)` (11)
- `(anonymous)` (11)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (10)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (9)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (8)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (7)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
- `(anonymous)` (6)
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
- `setup` (3)
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
- `require` (5362)
- `anonymous` (116)
- `(anonymous)` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js:26` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 4

**Called by:**
- `next` (4)

### `isDependencyTreeStatic`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:178` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 5

**Called by:**
- `isStatic` (2)
- `(anonymous)` (2)
- `applyCallbackToRouter` (1)

### `__exportStar`
`/home/user/bun-node/node_modules/tslib/tslib.js:203` | Self: 0.0% (1.0ms) | Total: 0.0% (3.5ms) | Samples: 4

**Called by:**
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

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (2)
- `hasOwnProperty` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `getMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:370` | Self: 0.0% (1.0ms) | Total: 0.5% (27.7ms) | Samples: 1

**Called by:**
- `reflectKeyMetadata` (16)
- `reflectProperties` (11)
- `reflectMetadata` (8)
- `getMetadata` (8)
- `exploreMethodMetadata` (5)
- `(anonymous)` (4)
- `getClassScope` (4)
- `exploreMethodMetadata` (3)
- `createContext` (3)
- `createContext` (3)
- `(anonymous)` (2)
- `reflectConstructorParams` (2)
- `extractRouterPath` (1)
- `reflectResponseHeaders` (1)
- `createHandleResponseFn` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `getMetadata` (1)
- `isResponseHandled` (1)
- `reflectOptionalParams` (1)

**Calls:**
- `OrdinaryGetMetadata` (24)
- `OrdinaryGetMetadata` (23)
- `OrdinaryGetMetadata` (19)
- `OrdinaryGetMetadata` (7)
- `OrdinaryGetMetadata` (3)

### `async loadController`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:97` | Self: 0.0% (1.0ms) | Total: 0.4% (20.6ms) | Samples: 5

**Called by:**
- `async (anonymous)` (52)

**Calls:**
- `async loadController` (45)
- `async loadController` (2)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:159` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 5

**Called by:**
- `forEach` (5)

### `getClassDependencies`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:186` | Self: 0.0% (1.0ms) | Total: 0.0% (1.9ms) | Samples: 1

**Called by:**
- `async resolveConstructorParams` (5)

**Calls:**
- `reflectOptionalParams` (4)

### `async resolveComponentHost`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `async (anonymous)` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:136` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 3

**Called by:**
- `#compileRouteRegExp` (3)

### `getAllMethodNames`
`/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 3

**Called by:**
- `scanForPaths` (2)
- `reflectParamInjectables` (1)

### `#configuredCookieSecrets`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1407` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `replace`
`[native code]` | Self: 0.0% (1.0ms) | Total: 0.0% (1.3ms) | Samples: 5

**Called by:**
- `mimeScore` (2)
- `#compileMiddlewareRegExp` (1)
- `(module)` (1)
- `pathRegex` (1)
- `setRoute` (1)

**Calls:**
- `/\s*\/\/.*$/gm` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:104` | Self: 0.0% (993us) | Total: 0.0% (993us) | Samples: 1

**Called by:**
- `map` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:171` | Self: 0.0% (963us) | Total: 0.0% (963us) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:73` | Self: 0.0% (961us) | Total: 0.1% (7.0ms) | Samples: 5

**Calls:**
- `applyProperties` (4)
- `applyProperties` (3)
- `applyProperties` (3)
- `applyProperties` (1)

### `IteratorWithOperators`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js` | Self: 0.0% (955us) | Total: 0.0% (955us) | Samples: 1

**Called by:**
- `iterate` (1)

### `SettlementSignal`
`/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js` | Self: 0.0% (953us) | Total: 0.0% (953us) | Samples: 2

**Called by:**
- `applySettlementSignal` (2)

### `substring`
`[native code]` | Self: 0.0% (943us) | Total: 0.0% (943us) | Samples: 2

**Called by:**
- `addLeadingSlash` (2)

### `createResolutionContext`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (907us) | Total: 0.0% (907us) | Samples: 2

**Called by:**
- `async loadController` (2)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (906us) | Total: 0.0% (906us) | Samples: 3

**Called by:**
- `dispatch` (3)

### `getPrototypeOf`
`[native code]` | Self: 0.0% (900us) | Total: 0.0% (900us) | Samples: 1

**Called by:**
- `getAllMethodNames` (1)

### `next`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (900us) | Total: 0.0% (900us) | Samples: 2

**Called by:**
- `async (anonymous)` (2)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:644` | Self: 0.0% (899us) | Total: 0.1% (5.6ms) | Samples: 4

**Called by:**
- `Promise` (17)

**Calls:**
- `onceResponded` (5)
- `onceResponded` (4)
- `onceResponded` (4)

### `OrdinaryHasOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1058` | Self: 0.0% (890us) | Total: 0.0% (1.3ms) | Samples: 3

**Called by:**
- `OrdinaryHasOwnMetadata` (5)

**Calls:**
- `GetOrCreateMetadataMap` (2)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:962` | Self: 0.0% (888us) | Total: 0.0% (888us) | Samples: 4

**Called by:**
- `#respondWithText` (4)

### `createHandleResponseFn`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:159` | Self: 0.0% (886us) | Total: 0.0% (1.3ms) | Samples: 4

**Called by:**
- `getMetadata` (6)

**Calls:**
- `getMetadata` (1)
- `reflectRenderTemplate` (1)

### `get originalUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` | Self: 0.0% (879us) | Total: 0.0% (879us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `getDeprecationWarningEmitter`
`internal:util/deprecate:3` | Self: 0.0% (878us) | Total: 0.0% (878us) | Samples: 1

**Called by:**
- `deprecate` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5013` | Self: 0.0% (871us) | Total: 0.0% (871us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:37` | Self: 0.0% (868us) | Total: 0.0% (868us) | Samples: 4

**Called by:**
- `async (anonymous)` (4)

### `getProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:955` | Self: 0.0% (863us) | Total: 0.0% (2.5ms) | Samples: 3

**Called by:**
- `GetMetadataProvider` (9)

**Calls:**
- `getProviderNoCache` (3)
- `getProviderNoCache` (2)
- `getProviderNoCache` (1)

### `isProviderFor`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (851us) | Total: 0.0% (851us) | Samples: 2

**Called by:**
- `getProviderNoCache` (2)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs` | Self: 0.0% (845us) | Total: 0.0% (845us) | Samples: 3

**Called by:**
- `#compileMiddlewareRegExp` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js:13` | Self: 0.0% (845us) | Total: 0.0% (845us) | Samples: 2

**Called by:**
- `next` (2)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:155` | Self: 0.0% (843us) | Total: 0.0% (843us) | Samples: 4

**Called by:**
- `#compileRouteRegExp` (4)

### `hasOnModuleInitHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:13` | Self: 0.0% (835us) | Total: 0.0% (835us) | Samples: 3

**Called by:**
- `next` (3)

### `isDependencyTreeStatic`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:186` | Self: 0.0% (807us) | Total: 0.0% (807us) | Samples: 2

**Called by:**
- `isStatic` (2)

### `async loadInstance`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (803us) | Total: 0.0% (803us) | Samples: 4

**Called by:**
- `async loadInstance` (4)

### `RequestMapping`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/request-mapping.decorator.js` | Self: 0.0% (800us) | Total: 0.0% (800us) | Samples: 1

**Called by:**
- `(module)` (1)

### `arrayIteratorNextHelper`
`[native code]` | Self: 0.0% (797us) | Total: 0.0% (797us) | Samples: 4

**Called by:**
- `next` (3)
- `next` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:169` | Self: 0.0% (795us) | Total: 0.0% (4.8ms) | Samples: 4

**Called by:**
- `forEach` (24)

**Calls:**
- `_preferredType` (19)
- `_preferredType` (1)

### `init`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (794us) | Total: 0.0% (794us) | Samples: 4

**Called by:**
- `serveNativeRequest` (4)

### `async resolveProperties`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (792us) | Total: 0.0% (792us) | Samples: 3

**Called by:**
- `async resolveProperties` (2)
- `async (anonymous)` (1)

### `createConcreteContext`
`/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js:19` | Self: 0.0% (792us) | Total: 0.0% (792us) | Samples: 3

**Called by:**
- `createContext` (2)
- `createContext` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:176` | Self: 0.0% (789us) | Total: 0.0% (789us) | Samples: 4

**Called by:**
- `forEach` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js` | Self: 0.0% (788us) | Total: 0.0% (788us) | Samples: 4

**Called by:**
- `next` (2)
- `next` (2)

### `async resolveConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:122` | Self: 0.0% (788us) | Total: 0.0% (1.1ms) | Samples: 4

**Called by:**
- `async resolveConstructorParams` (4)

**Calls:**
- `getCtorMetadata` (2)

### `reflectInjectables`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:159` | Self: 0.0% (788us) | Total: 0.0% (3.8ms) | Samples: 1

**Called by:**
- `reflectDynamicMetadata` (4)
- `reflectDynamicMetadata` (3)
- `reflectDynamicMetadata` (2)
- `reflectDynamicMetadata` (1)

**Calls:**
- `reflectMetadata` (9)

### `async loadEnhancersPerContext`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:456` | Self: 0.0% (784us) | Total: 0.0% (994us) | Samples: 4

**Called by:**
- `async loadController` (5)

**Calls:**
- `async loadEnhancersPerContext` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:177` | Self: 0.0% (782us) | Total: 0.0% (782us) | Samples: 2

**Called by:**
- `#compileRouteRegExp` (2)

### `initialize`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:341` | Self: 0.0% (766us) | Total: 0.0% (4.3ms) | Samples: 4

**Called by:**
- `InstanceWrapper` (14)

**Calls:**
- `assign` (10)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (750us) | Total: 0.0% (750us) | Samples: 3

**Called by:**
- `registerVerb` (3)

### `registerNotFoundHandler`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:73` | Self: 0.0% (744us) | Total: 0.0% (744us) | Samples: 1

**Called by:**
- `async registerRouterHooks` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/tslib/tslib.js` | Self: 0.0% (743us) | Total: 0.0% (743us) | Samples: 3

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `__exportStar` (1)

### `OrdinaryGetPrototypeOf`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:847` | Self: 0.0% (735us) | Total: 0.0% (735us) | Samples: 2

**Called by:**
- `OrdinaryGetMetadata` (2)

### `Number`
`[native code]` | Self: 0.0% (732us) | Total: 0.0% (732us) | Samples: 3

**Called by:**
- `(anonymous)` (2)
- `(module)` (1)

### `get isTransient`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:43` | Self: 0.0% (731us) | Total: 0.0% (731us) | Samples: 3

**Called by:**
- `getEffectiveInquirer` (1)
- `async (anonymous)` (1)
- `async registerRouteMiddleware` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:433` | Self: 0.0% (719us) | Total: 0.0% (719us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `performIteration`
`[native code]` | Self: 0.0% (713us) | Total: 0.0% (713us) | Samples: 3

**Called by:**
- `async callModuleInitHook` (1)
- `async callModuleBootstrapHook` (1)
- `async createInstancesOfControllers` (1)

### `dirname`
`[native code]` | Self: 0.0% (711us) | Total: 0.0% (711us) | Samples: 1

**Called by:**
- `bound dirname` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5066` | Self: 0.0% (687us) | Total: 0.0% (687us) | Samples: 2

### `getInstanceByContextId`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` | Self: 0.0% (687us) | Total: 0.0% (687us) | Samples: 3

**Called by:**
- `instance` (3)

### `#settleLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (685us) | Total: 0.0% (685us) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `getStatusByMethod`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:42` | Self: 0.0% (683us) | Total: 0.0% (683us) | Samples: 3

**Called by:**
- `getMetadata` (3)

### `generateUuid`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` | Self: 0.0% (666us) | Total: 0.0% (666us) | Samples: 1

**Called by:**
- `Module` (1)

### `get`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:64` | Self: 0.0% (662us) | Total: 0.0% (662us) | Samples: 3

**Called by:**
- `async transformToResult` (3)

### `GetOrCreateMetadataMap`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (661us) | Total: 0.0% (661us) | Samples: 3

**Called by:**
- `OrdinaryHasOwnMetadata` (2)
- `OrdinaryOwnMetadataKeys` (1)

### `OrdinaryGetMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:597` | Self: 0.0% (648us) | Total: 0.3% (17.4ms) | Samples: 3

**Called by:**
- `getMetadata` (24)
- `OrdinaryGetMetadata` (13)

**Calls:**
- `OrdinaryGetMetadata` (14)
- `OrdinaryGetMetadata` (13)
- `OrdinaryGetMetadata` (7)

### `copyDataProperties`
`[native code]` | Self: 0.0% (645us) | Total: 0.0% (645us) | Samples: 3

**Called by:**
- `initialize` (3)

### `OrdinaryHasOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:584` | Self: 0.0% (642us) | Total: 0.2% (10.2ms) | Samples: 2

**Called by:**
- `OrdinaryGetMetadata` (25)

**Calls:**
- `GetMetadataProvider` (22)
- `GetMetadataProvider` (1)

### `keys`
`[native code]` | Self: 0.0% (639us) | Total: 0.0% (639us) | Samples: 3

**Called by:**
- `setup` (1)
- `populateMaps` (1)
- `populateMaps` (1)

### `OrdinaryGetPrototypeOf`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:846` | Self: 0.0% (636us) | Total: 0.0% (636us) | Samples: 3

**Called by:**
- `OrdinaryGetMetadata` (3)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:185` | Self: 0.0% (636us) | Total: 0.0% (636us) | Samples: 3

**Called by:**
- `forEach` (3)

### `getHashes`
`[native code]` | Self: 0.0% (636us) | Total: 0.0% (636us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `copyMetadataToCallback`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:229` | Self: 0.0% (632us) | Total: 0.2% (10.4ms) | Samples: 3

**Called by:**
- `(anonymous)` (12)

**Calls:**
- `getMetadataKeys` (9)

### `exchangeKeysForValues`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:101` | Self: 0.0% (631us) | Total: 0.0% (631us) | Samples: 3

**Called by:**
- `create` (2)
- `getMetadata` (1)

### `getProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:947` | Self: 0.0% (627us) | Total: 0.0% (627us) | Samples: 3

**Called by:**
- `GetMetadataProvider` (3)

### `::bunternal::`
`internal:validators` | Self: 0.0% (624us) | Total: 0.0% (624us) | Samples: 1

**Called by:**
- `deprecate` (1)

### `next`
`/home/user/bun-node/node_modules/iterare/lib/filter.js:12` | Self: 0.0% (619us) | Total: 0.0% (4.3ms) | Samples: 3

**Called by:**
- `next` (13)
- `forEach` (3)
- `from` (1)

**Calls:**
- `next` (8)
- `arrayIteratorNextHelper` (3)
- `next` (1)
- `next` (1)
- `next` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5102` | Self: 0.0% (618us) | Total: 17.5% (859.6ms) | Samples: 2

**Called by:**
- `#routeRequest` (1275)

**Calls:**
- `async middlewareHandler` (1269)
- `async (anonymous)` (810)
- `async (anonymous)` (6)
- `async middlewareHandler` (5)

### `OrdinaryGetPrototypeOf`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:858` | Self: 0.0% (616us) | Total: 0.0% (616us) | Samples: 3

**Called by:**
- `OrdinaryGetMetadata` (3)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:970` | Self: 0.0% (615us) | Total: 0.0% (615us) | Samples: 3

**Called by:**
- `#respondWithText` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js` | Self: 0.0% (613us) | Total: 0.0% (613us) | Samples: 3

**Called by:**
- `map` (2)
- `reduce` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/mime-types/index.js:167` | Self: 0.0% (612us) | Total: 0.0% (612us) | Samples: 3

**Called by:**
- `forEach` (3)

### `getProviderNoCache`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (610us) | Total: 0.0% (610us) | Samples: 3

**Called by:**
- `getProvider` (3)

### `stripEndSlash`
`/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:36` | Self: 0.0% (609us) | Total: 0.0% (609us) | Samples: 3

**Called by:**
- `concatPaths` (2)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:112` | Self: 0.0% (606us) | Total: 0.0% (1.0ms) | Samples: 2

**Called by:**
- `map` (4)

**Calls:**
- `Number` (2)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:44` | Self: 0.0% (605us) | Total: 0.0% (605us) | Samples: 3

**Called by:**
- `_preferredType` (3)

### `serveNativeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:375` | Self: 0.0% (603us) | Total: 15.8% (778.7ms) | Samples: 3

**Called by:**
- `(anonymous)` (1764)
- `(module)` (133)
- `bound serveNativeRequest` (10)

**Calls:**
- `init` (1900)
- `init` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:39` | Self: 0.0% (603us) | Total: 0.0% (1.6ms) | Samples: 1

**Called by:**
- `forEach` (6)

**Calls:**
- `extractRouterPath` (2)
- `extractRouterPath` (2)
- `extractRouterPath` (1)

### `get`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:17` | Self: 0.0% (603us) | Total: 0.0% (603us) | Samples: 3

**Called by:**
- `getMetadata` (3)

### `reflectKeyMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js` | Self: 0.0% (601us) | Total: 0.0% (601us) | Samples: 3

**Called by:**
- `(anonymous)` (3)

### `createConcreteContext`
`/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js` | Self: 0.0% (597us) | Total: 0.0% (597us) | Samples: 3

**Called by:**
- `(anonymous)` (3)

### `Barrier`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/barrier.js:9` | Self: 0.0% (596us) | Total: 0.0% (596us) | Samples: 3

**Called by:**
- `async resolveConstructorParams` (3)

### `reply`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1150` | Self: 0.0% (595us) | Total: 0.0% (595us) | Samples: 2

**Called by:**
- `async apply` (2)

### `exploreMethodMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js` | Self: 0.0% (594us) | Total: 0.0% (594us) | Samples: 3

**Called by:**
- `(anonymous)` (3)

### `internal:streams/destroy`
`internal:streams/destroy:16` | Self: 0.0% (593us) | Total: 0.0% (593us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `complete`
`/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js:22` | Self: 0.0% (592us) | Total: 0.0% (774us) | Samples: 3

**Called by:**
- `async (anonymous)` (4)

**Calls:**
- `(anonymous)` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:67` | Self: 0.0% (591us) | Total: 0.4% (21.2ms) | Samples: 3

**Called by:**
- `map` (55)

**Calls:**
- `async (anonymous)` (52)

### `bind`
`[native code]` | Self: 0.0% (589us) | Total: 0.0% (589us) | Samples: 3

**Called by:**
- `internal:primordials` (1)
- `applyCallbackToRouter` (1)
- `async createProxy` (1)

### `async resolveProperties`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:345` | Self: 0.0% (581us) | Total: 0.0% (581us) | Samples: 3

**Called by:**
- `async resolveProperties` (3)

### `addLeadingSlash`
`/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:25` | Self: 0.0% (580us) | Total: 0.0% (1.7ms) | Samples: 3

**Called by:**
- `exploreMethodMetadata` (2)
- `extractRouterPath` (2)
- `(anonymous)` (1)
- `concatPaths` (1)

**Calls:**
- `substring` (2)
- `charAt` (1)

### `async resolveProperties`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:344` | Self: 0.0% (579us) | Total: 0.1% (5.3ms) | Samples: 3

**Called by:**
- `async (anonymous)` (26)

**Calls:**
- `async resolveProperties` (14)
- `async resolveProperties` (3)
- `async resolveProperties` (2)
- `async resolveProperties` (2)
- `async resolveProperties` (1)
- `asyncFunctionDrive` (1)

### `addController`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:321` | Self: 0.0% (576us) | Total: 0.1% (7.1ms) | Samples: 1

**Called by:**
- `addController` (15)

**Calls:**
- `InstanceWrapper` (7)
- `InstanceWrapper` (4)
- `InstanceWrapper` (2)
- `InstanceWrapper` (1)

### `async instantiateClass`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:418` | Self: 0.0% (576us) | Total: 0.2% (10.2ms) | Samples: 3

**Called by:**
- `async (anonymous)` (25)

**Calls:**
- `async instantiateClass` (7)
- `async instantiateClass` (5)
- `async instantiateClass` (4)
- `async instantiateClass` (2)
- `async instantiateClass` (1)
- `async instantiateClass` (1)
- `async instantiateClass` (1)
- `async instantiateClass` (1)

### `async intercept`
`/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js:12` | Self: 0.0% (562us) | Total: 1.1% (56.1ms) | Samples: 2

**Called by:**
- `async (anonymous)` (140)

**Calls:**
- `async (anonymous)` (138)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/ReplaySubject.js` | Self: 0.0% (554us) | Total: 0.0% (554us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (551us) | Total: 0.0% (551us) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/QueueAction.js` | Self: 0.0% (549us) | Total: 0.0% (549us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:72` | Self: 0.0% (549us) | Total: 0.0% (549us) | Samples: 1

**Called by:**
- `create` (1)

### `reflectParamInjectables`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:175` | Self: 0.0% (547us) | Total: 0.0% (738us) | Samples: 2

**Called by:**
- `reflectDynamicMetadata` (3)

**Calls:**
- `getAllMethodNames` (1)

### `WriteStream`
`internal:fs/streams` | Self: 0.0% (546us) | Total: 0.0% (546us) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `get instance`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:33` | Self: 0.0% (544us) | Total: 0.0% (1.0ms) | Samples: 2

**Called by:**
- `connectGatewayToServer` (2)
- `getMetaKeyByInstanceWrapper` (1)
- `explore` (1)

**Calls:**
- `getInstanceByContextId` (2)

### `startsWith`
`[native code]` | Self: 0.0% (543us) | Total: 0.0% (543us) | Samples: 2

**Called by:**
- `require` (2)

### `static`
`/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts` | Self: 0.0% (537us) | Total: 0.0% (537us) | Samples: 1

**Called by:**
- `async (anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:8` | Self: 0.0% (531us) | Total: 0.0% (531us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `#produceResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:524` | Self: 0.0% (530us) | Total: 0.0% (530us) | Samples: 2

### `reflectDynamicMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:147` | Self: 0.0% (522us) | Total: 0.0% (2.0ms) | Samples: 2

**Called by:**
- `(anonymous)` (8)

**Calls:**
- `reflectInjectables` (4)
- `reflectInjectables` (2)

### `async resolveConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:128` | Self: 0.0% (520us) | Total: 0.0% (520us) | Samples: 2

**Called by:**
- `async resolveConstructorParams` (2)

### `hasOwnProperty`
`[native code]` | Self: 0.0% (513us) | Total: 0.0% (513us) | Samples: 2

**Called by:**
- `__exportStar` (2)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:419` | Self: 0.0% (511us) | Total: 0.4% (22.4ms) | Samples: 2

**Called by:**
- `serveNativeRequest` (62)

**Calls:**
- `originalUrl` (58)
- `get originalUrl` (1)
- `originalUrl` (1)

### `get name`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:45` | Self: 0.0% (510us) | Total: 0.0% (724us) | Samples: 2

**Called by:**
- `generateUuid` (2)
- `async (anonymous)` (1)

**Calls:**
- `get metatype` (1)

### `(module)`
`/home/user/bun-node/node_modules/token-types/lib/index.js:360` | Self: 0.0% (505us) | Total: 0.0% (505us) | Samples: 1

### `Map`
`[native code]` | Self: 0.0% (496us) | Total: 0.0% (496us) | Samples: 2

**Called by:**
- `Cache` (1)
- `getAllMethodNames` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/tslib/tslib.js:209` | Self: 0.0% (484us) | Total: 0.0% (484us) | Samples: 2

**Called by:**
- `__exportStar` (2)

### `defineMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (482us) | Total: 0.0% (482us) | Samples: 1

**Called by:**
- `copyMetadataToCallback` (1)

### `isObject`
`/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:6` | Self: 0.0% (482us) | Total: 0.0% (4.0ms) | Samples: 2

**Called by:**
- `applyProperties` (3)

**Calls:**
- `isNil` (1)

### `(module)`
`/home/user/bun-node/node_modules/mime/dist/types/other.js:718` | Self: 0.0% (480us) | Total: 0.0% (480us) | Samples: 2

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2488` | Self: 0.0% (476us) | Total: 0.0% (476us) | Samples: 2

**Called by:**
- `BunRequest` (2)

### `next`
`/home/user/bun-node/node_modules/iterare/lib/filter.js` | Self: 0.0% (474us) | Total: 0.0% (474us) | Samples: 2

**Called by:**
- `forEach` (2)

### `supportsColor`
`/home/user/bun-node/node_modules/supports-color/index.js` | Self: 0.0% (472us) | Total: 0.0% (472us) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `reflectOptionalParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:226` | Self: 0.0% (468us) | Total: 0.0% (877us) | Samples: 2

**Called by:**
- `getClassDependencies` (4)

**Calls:**
- `getMetadata` (1)
- `getMetadata` (1)

### `freeze`
`[native code]` | Self: 0.0% (465us) | Total: 0.0% (465us) | Samples: 2

**Called by:**
- `createSafeIterator` (1)
- `(module)` (1)

### `#configuredCookieSecrets`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1405` | Self: 0.0% (456us) | Total: 0.0% (456us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `parse`
`/home/user/bun-node/node_modules/picoquery/lib/parse.js` | Self: 0.0% (455us) | Total: 0.0% (455us) | Samples: 1

**Called by:**
- `(module)` (1)

### `async loadInstance`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:42` | Self: 0.0% (452us) | Total: 0.4% (21.6ms) | Samples: 2

**Called by:**
- `async loadController` (43)
- `async loadProvider` (16)
- `async loadMiddleware` (3)

**Calls:**
- `async loadInstance` (39)
- `async loadInstance` (9)
- `async loadInstance` (4)
- `async loadInstance` (3)
- `async loadInstance` (2)
- `asyncFunctionDrive` (1)
- `async loadInstance` (1)
- `async loadInstance` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js` | Self: 0.0% (452us) | Total: 0.0% (452us) | Samples: 2

**Called by:**
- `map` (1)
- `async (anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:18` | Self: 0.0% (451us) | Total: 0.0% (451us) | Samples: 2

**Called by:**
- `Route` (2)

### `applyPathsToRouterProxy`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` | Self: 0.0% (451us) | Total: 0.0% (451us) | Samples: 2

**Called by:**
- `explore` (2)

### `appendToAllIfDefined`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js` | Self: 0.0% (448us) | Total: 0.0% (448us) | Samples: 2

**Called by:**
- `create` (1)
- `create` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js` | Self: 0.0% (447us) | Total: 0.0% (447us) | Samples: 2

**Called by:**
- `map` (2)

### `getClassScope`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/get-class-scope.js` | Self: 0.0% (446us) | Total: 0.0% (446us) | Samples: 2

**Called by:**
- `addController` (2)

### `OrdinaryHasOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1061` | Self: 0.0% (444us) | Total: 0.0% (967us) | Samples: 2

**Called by:**
- `OrdinaryHasOwnMetadata` (4)

**Calls:**
- `has` (2)

### `getMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:366` | Self: 0.0% (441us) | Total: 0.0% (441us) | Samples: 2

**Called by:**
- `createHandleResponseFn` (1)
- `extractRouterPath` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js` | Self: 0.0% (433us) | Total: 0.0% (433us) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `createConcreteContext`
`/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js:20` | Self: 0.0% (431us) | Total: 0.0% (431us) | Samples: 2

**Called by:**
- `createContext` (1)
- `createContext` (1)

### `getGlobalMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js:52` | Self: 0.0% (431us) | Total: 0.0% (431us) | Samples: 2

**Called by:**
- `createContext` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:74` | Self: 0.0% (431us) | Total: 0.0% (431us) | Samples: 2

**Called by:**
- `Cache` (2)

### `applySettlementSignal`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:118` | Self: 0.0% (429us) | Total: 0.0% (429us) | Samples: 2

**Called by:**
- `async loadInstance` (2)

### `setProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:974` | Self: 0.0% (429us) | Total: 0.0% (635us) | Samples: 2

**Called by:**
- `GetOrCreateMetadataMap` (2)
- `GetMetadataProvider` (1)

**Calls:**
- `getProvider` (1)

### `reflectCallbackMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:16` | Self: 0.0% (429us) | Total: 0.0% (429us) | Samples: 1

**Called by:**
- `getMetadata` (1)

### `_preferredTypeLegacy`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:202` | Self: 0.0% (428us) | Total: 0.0% (428us) | Samples: 2

**Called by:**
- `forEachMimeType` (2)

### `createContext`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:12` | Self: 0.0% (424us) | Total: 0.1% (5.7ms) | Samples: 2

**Called by:**
- `create` (5)
- `create` (2)
- `create` (1)
- `create` (1)

**Calls:**
- `createConcreteContext` (2)
- `createConcreteContext` (1)
- `createConcreteContext` (1)
- `createConcreteContext` (1)
- `createConcreteContext` (1)
- `createConcreteContext` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapScheduler.js` | Self: 0.0% (424us) | Total: 0.0% (424us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `all`
`[native code]` | Self: 0.0% (423us) | Total: 0.0% (423us) | Samples: 2

**Called by:**
- `async createInstancesOfControllers` (1)
- `async createInstancesOfProviders` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:165` | Self: 0.0% (423us) | Total: 0.0% (423us) | Samples: 2

**Called by:**
- `#compileRouteRegExp` (2)

### `exploreMethodMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:25` | Self: 0.0% (422us) | Total: 0.0% (422us) | Samples: 2

**Called by:**
- `(anonymous)` (2)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:156` | Self: 0.0% (421us) | Total: 0.0% (421us) | Samples: 2

**Called by:**
- `forEach` (2)

### `get`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js` | Self: 0.0% (421us) | Total: 0.0% (421us) | Samples: 2

**Called by:**
- `getMetadata` (2)

### `ExceptionsHandler`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/exceptions-handler.js:10` | Self: 0.0% (421us) | Total: 0.0% (421us) | Samples: 2

**Called by:**
- `create` (2)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:49` | Self: 0.0% (420us) | Total: 0.0% (420us) | Samples: 2

**Called by:**
- `setRoute` (2)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` | Self: 0.0% (420us) | Total: 0.0% (420us) | Samples: 2

**Called by:**
- `async registerAllConfigs` (1)
- `async loadMiddlewareConfiguration` (1)

### `createPrototype`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:224` | Self: 0.0% (419us) | Total: 0.0% (419us) | Samples: 2

**Called by:**
- `loadPrototype` (2)

### `next`
`/home/user/bun-node/node_modules/iterare/lib/flatten.js:23` | Self: 0.0% (419us) | Total: 0.0% (419us) | Samples: 1

**Called by:**
- `next` (1)

### `get`
`/home/user/bun-node/node_modules/@nestjs/core/inspector/uuid-factory.js:16` | Self: 0.0% (419us) | Total: 0.0% (419us) | Samples: 2

**Called by:**
- `InstanceWrapper` (2)

### `async instantiateClass`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (418us) | Total: 0.0% (418us) | Samples: 2

**Called by:**
- `async instantiateClass` (1)
- `async (anonymous)` (1)

### `async registerMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` | Self: 0.0% (418us) | Total: 0.0% (418us) | Samples: 2

**Called by:**
- `async registerMiddleware` (1)
- `async registerMiddleware` (1)

### `applyHostFilter`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:137` | Self: 0.0% (416us) | Total: 0.0% (416us) | Samples: 2

**Called by:**
- `applyCallbackToRouter` (2)

### `async #parseBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3137` | Self: 0.0% (415us) | Total: 0.0% (415us) | Samples: 2

**Called by:**
- `async #parseBody` (2)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:27` | Self: 0.0% (414us) | Total: 0.0% (414us) | Samples: 2

**Called by:**
- `createCallbackProxy` (2)

### `originalUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3699` | Self: 0.0% (414us) | Total: 0.0% (414us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `iterate`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js` | Self: 0.0% (413us) | Total: 0.0% (413us) | Samples: 2

**Called by:**
- `addScopedEnhancersMetadata` (1)
- `applyProperties` (1)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1209` | Self: 0.0% (413us) | Total: 0.4% (24.0ms) | Samples: 2

**Called by:**
- `async apply` (44)

**Calls:**
- `#canSkipHeaders` (42)

### `OrdinaryOwnMetadataKeys`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1085` | Self: 0.0% (412us) | Total: 0.1% (6.8ms) | Samples: 2

**Called by:**
- `OrdinaryOwnMetadataKeys` (4)

**Calls:**
- `GetIterator` (2)

### `next`
`/home/user/bun-node/node_modules/iterare/lib/map.js:13` | Self: 0.0% (411us) | Total: 0.0% (3.7ms) | Samples: 2

**Called by:**
- `from` (8)
- `next` (6)

**Calls:**
- `(anonymous)` (4)
- `(anonymous)` (2)
- `(anonymous)` (2)
- `from` (1)
- `mapToClass` (1)
- `getStaticTransientInstances` (1)
- `mapToClass` (1)

### `async resolveConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (411us) | Total: 0.0% (411us) | Samples: 2

**Called by:**
- `async resolveConstructorParams` (1)
- `async loadInstance` (1)

### `async instantiateClass`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:430` | Self: 0.0% (410us) | Total: 0.0% (2.4ms) | Samples: 2

**Called by:**
- `async instantiateClass` (5)

**Calls:**
- `RouteController` (2)
- `BenchController` (1)

### `_preferredTypeLegacy`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:198` | Self: 0.0% (410us) | Total: 0.0% (410us) | Samples: 2

**Called by:**
- `forEachMimeType` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js` | Self: 0.0% (407us) | Total: 0.0% (407us) | Samples: 2

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `createConcreteContext`
`/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js:19` | Self: 0.0% (406us) | Total: 0.0% (406us) | Samples: 2

**Called by:**
- `createContext` (1)
- `createContext` (1)

### `createContext`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:13` | Self: 0.0% (405us) | Total: 0.0% (1.4ms) | Samples: 2

**Called by:**
- `create` (4)
- `create` (2)
- `create` (1)

**Calls:**
- `createConcreteContext` (2)
- `createConcreteContext` (2)
- `createConcreteContext` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:16` | Self: 0.0% (405us) | Total: 0.0% (405us) | Samples: 2

**Called by:**
- `createCallbackProxy` (2)

### `isArray`
`[native code]` | Self: 0.0% (405us) | Total: 0.0% (405us) | Samples: 2

**Called by:**
- `IsArray` (1)
- `extractRouterPath` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/tslib/tslib.js:207` | Self: 0.0% (403us) | Total: 0.0% (403us) | Samples: 1

**Called by:**
- `__exportStar` (1)

### `async createInstances`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js` | Self: 0.0% (403us) | Total: 0.0% (403us) | Samples: 2

**Called by:**
- `async createInstances` (1)
- `async createInstancesOfDependencies` (1)

### `(anonymous)`
`node:zlib` | Self: 0.0% (403us) | Total: 0.0% (403us) | Samples: 2

**Called by:**
- `map` (2)

### `SettlementSignal`
`/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js:13` | Self: 0.0% (403us) | Total: 0.0% (840us) | Samples: 2

**Called by:**
- `applySettlementSignal` (4)

**Calls:**
- `Promise` (2)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:67` | Self: 0.0% (402us) | Total: 0.0% (608us) | Samples: 2

**Called by:**
- `Route` (3)

**Calls:**
- `Map` (1)

### `send`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (401us) | Total: 0.0% (401us) | Samples: 2

**Called by:**
- `async apply` (2)

### `get method`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3572` | Self: 0.0% (401us) | Total: 0.0% (401us) | Samples: 2

**Called by:**
- `#canSkipHeaders` (1)
- `#routeRequest` (1)

### `isObject`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:179` | Self: 0.0% (401us) | Total: 0.0% (401us) | Samples: 2

**Called by:**
- `normalizeParseBodyOptions` (1)
- `#configuredQueryOpts` (1)

### `FilterIterator`
`/home/user/bun-node/node_modules/iterare/lib/filter.js:5` | Self: 0.0% (401us) | Total: 0.0% (401us) | Samples: 1

**Called by:**
- `filter` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` | Self: 0.0% (401us) | Total: 0.0% (401us) | Samples: 2

**Called by:**
- `setRoute` (2)

### `#respond`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:493` | Self: 0.0% (399us) | Total: 0.0% (399us) | Samples: 2

### `test`
`[native code]` | Self: 0.0% (398us) | Total: 0.0% (398us) | Samples: 2

**Called by:**
- `segmentKind` (1)
- `(anonymous)` (1)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:963` | Self: 0.0% (397us) | Total: 0.1% (8.4ms) | Samples: 1

**Called by:**
- `#respondWithText` (11)

**Calls:**
- `(anonymous)` (5)
- `(anonymous)` (3)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `createConcreteContext`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter-context.js:14` | Self: 0.0% (396us) | Total: 0.0% (396us) | Samples: 2

**Called by:**
- `createContext` (1)
- `createContext` (1)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:40` | Self: 0.0% (395us) | Total: 0.0% (2.6ms) | Samples: 2

**Called by:**
- `_preferredType` (13)

**Calls:**
- `split` (11)

### `initialize`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:342` | Self: 0.0% (394us) | Total: 0.0% (394us) | Samples: 2

**Called by:**
- `InstanceWrapper` (2)

### `getCtorMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` | Self: 0.0% (393us) | Total: 0.0% (393us) | Samples: 2

**Called by:**
- `async resolveConstructorParams` (2)

### `ownKeys`
`[native code]` | Self: 0.0% (393us) | Total: 0.0% (393us) | Samples: 2

**Called by:**
- `makeSafe` (1)
- `copyProps` (1)

### `startInterval`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` | Self: 0.0% (393us) | Total: 0.0% (393us) | Samples: 2

**Called by:**
- `Cache` (2)

### `async callModuleInitHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js` | Self: 0.0% (392us) | Total: 0.0% (392us) | Samples: 2

**Called by:**
- `async callInitHook` (1)
- `async callModuleInitHook` (1)

### `#compileRouteRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:198` | Self: 0.0% (387us) | Total: 0.0% (387us) | Samples: 1

**Called by:**
- `Route` (1)

### `splitRequestUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3503` | Self: 0.0% (386us) | Total: 0.0% (386us) | Samples: 2

**Called by:**
- `host` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/invalid-class.exception.js:11` | Self: 0.0% (386us) | Total: 0.0% (386us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `reflectConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (385us) | Total: 0.0% (385us) | Samples: 2

**Called by:**
- `getClassDependencies` (2)

### `OrdinaryGetMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:592` | Self: 0.0% (384us) | Total: 0.2% (13.1ms) | Samples: 2

**Called by:**
- `getMetadata` (23)
- `OrdinaryGetMetadata` (14)

**Calls:**
- `OrdinaryHasOwnMetadata` (25)
- `OrdinaryHasOwnMetadata` (9)
- `OrdinaryHasOwnMetadata` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:164` | Self: 0.0% (383us) | Total: 0.0% (383us) | Samples: 2

**Called by:**
- `forEach` (2)

### `some`
`[native code]` | Self: 0.0% (382us) | Total: 0.0% (612us) | Samples: 1

**Called by:**
- `async registerHandler` (1)
- `isResponseHandled` (1)

**Calls:**
- `(anonymous)` (1)

### `#compileRouteRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` | Self: 0.0% (381us) | Total: 0.0% (381us) | Samples: 2

**Called by:**
- `Route` (2)

### `performProxyObjectGet`
`[native code]` | Self: 0.0% (381us) | Total: 0.0% (381us) | Samples: 2

**Called by:**
- `async (anonymous)` (2)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:6` | Self: 0.0% (381us) | Total: 0.0% (381us) | Samples: 2

**Called by:**
- `#compileRouteRegExp` (2)

### `host`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3577` | Self: 0.0% (378us) | Total: 0.0% (764us) | Samples: 2

**Called by:**
- `#routeRequest` (4)

**Calls:**
- `splitRequestUrl` (2)

### `reflectConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:219` | Self: 0.0% (377us) | Total: 0.0% (4.4ms) | Samples: 1

**Called by:**
- `getClassDependencies` (3)

**Calls:**
- `getMetadata` (2)

### `/\s*\/\/.*$/gm`
`[native code]` | Self: 0.0% (377us) | Total: 0.0% (377us) | Samples: 1

**Called by:**
- `replace` (1)

### `getStaticTransientInstances`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` | Self: 0.0% (375us) | Total: 0.0% (375us) | Samples: 1

**Called by:**
- `next` (1)

### `filter`
`[native code]` | Self: 0.0% (371us) | Total: 0.0% (1.0ms) | Samples: 2

**Called by:**
- `bound call` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `async callModuleInitHook` (1)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:953` | Self: 0.0% (371us) | Total: 0.0% (371us) | Samples: 2

**Called by:**
- `#respondWithText` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js` | Self: 0.0% (369us) | Total: 0.0% (369us) | Samples: 2

**Called by:**
- `DecorateProperty` (2)

### `getPropertiesMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:121` | Self: 0.0% (366us) | Total: 0.0% (366us) | Samples: 2

**Called by:**
- `async resolveProperties` (2)

### `getContextInquirerId`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (361us) | Total: 0.0% (361us) | Samples: 2

**Called by:**
- `async loadInstance` (2)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1246` | Self: 0.0% (359us) | Total: 0.0% (359us) | Samples: 1

**Called by:**
- `init` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/unknown-export.exception.js:3` | Self: 0.0% (358us) | Total: 0.0% (358us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `endsWith`
`[native code]` | Self: 0.0% (354us) | Total: 0.0% (354us) | Samples: 1

**Called by:**
- `require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:375` | Self: 0.0% (351us) | Total: 0.0% (351us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `GetMetadataProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1166` | Self: 0.0% (342us) | Total: 0.0% (342us) | Samples: 1

**Called by:**
- `OrdinaryHasOwnMetadata` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1271` | Self: 0.0% (338us) | Total: 2.6% (130.2ms) | Samples: 1

**Called by:**
- `init` (376)

**Calls:**
- `#finishAbsentBody` (157)
- `#finishAbsentBody` (84)
- `#finishAbsentBody` (66)
- `#finishAbsentBody` (39)
- `#finishAbsentBody` (29)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:681` | Self: 0.0% (336us) | Total: 0.0% (336us) | Samples: 1

**Called by:**
- `BunResponse` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/skip.js` | Self: 0.0% (333us) | Total: 0.0% (333us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/types/urlencoded.js:48` | Self: 0.0% (329us) | Total: 0.0% (329us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `#configuredCookieSecrets`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (324us) | Total: 0.0% (324us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `InstanceWrapper`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:23` | Self: 0.0% (318us) | Total: 0.0% (318us) | Samples: 1

**Called by:**
- `addController` (1)

### `async instantiateClass`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:421` | Self: 0.0% (316us) | Total: 0.0% (495us) | Samples: 1

**Called by:**
- `async instantiateClass` (2)

**Calls:**
- `getInstanceByContextId` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:420` | Self: 0.0% (315us) | Total: 0.0% (315us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `extendStatics`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/AsyncSubject.js` | Self: 0.0% (313us) | Total: 0.0% (313us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `bound get`
`[native code]` | Self: 0.0% (306us) | Total: 0.4% (23.8ms) | Samples: 1

**Called by:**
- `(anonymous)` (84)

**Calls:**
- `get` (57)
- `registerVerb` (26)

### `OrdinaryGetOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:606` | Self: 0.0% (306us) | Total: 0.0% (698us) | Samples: 1

**Called by:**
- `OrdinaryGetMetadata` (3)

**Calls:**
- `OrdinaryGetOwnMetadata` (1)
- `OrdinaryGetOwnMetadata` (1)

### `reflectMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:324` | Self: 0.0% (303us) | Total: 0.0% (3.0ms) | Samples: 1

**Called by:**
- `reflectInjectables` (9)

**Calls:**
- `getMetadata` (8)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/undefined-dependency.exception.js:6` | Self: 0.0% (294us) | Total: 0.0% (294us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `Stream`
`internal:streams/legacy` | Self: 0.0% (294us) | Total: 0.0% (294us) | Samples: 1

**Called by:**
- `Writable` (1)

### `defineCustomPromisify`
`internal:promisify` | Self: 0.0% (293us) | Total: 0.0% (293us) | Samples: 1

**Called by:**
- `promisify2` (1)

### `async handleBodyParsing`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3398` | Self: 0.0% (292us) | Total: 0.0% (292us) | Samples: 1

**Called by:**
- `async handleBodyParsing` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/serializer/class-serializer.interceptor.js:76` | Self: 0.0% (292us) | Total: 0.0% (292us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `exploreMethodMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:31` | Self: 0.0% (291us) | Total: 0.0% (291us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `filter`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js` | Self: 0.0% (289us) | Total: 0.0% (289us) | Samples: 1

**Called by:**
- `applyProperties` (1)

### `async reflectImports`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js` | Self: 0.0% (289us) | Total: 0.0% (289us) | Samples: 1

**Called by:**
- `async reflectImports` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/enums/request-method.enum.js` | Self: 0.0% (288us) | Total: 0.0% (288us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `insertProvider`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js` | Self: 0.0% (288us) | Total: 0.0% (288us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async addDynamicModules`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js` | Self: 0.0% (287us) | Total: 0.0% (287us) | Samples: 1

**Called by:**
- `async addDynamicModules` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapAction.js` | Self: 0.0% (286us) | Total: 0.0% (286us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `resolveAdapterOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunWebSocketAdapter.ts` | Self: 0.0% (282us) | Total: 0.0% (282us) | Samples: 1

**Called by:**
- `BunWebSocketAdapter` (1)

### `layerFinished`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:598` | Self: 0.0% (282us) | Total: 0.0% (282us) | Samples: 1

**Called by:**
- `#runPipeline` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:194` | Self: 0.0% (281us) | Total: 0.0% (281us) | Samples: 1

### `Empty`
`/home/user/bun-node/node_modules/picoquery/lib/parse.js` | Self: 0.0% (281us) | Total: 0.0% (281us) | Samples: 1

**Called by:**
- `parse` (1)

### `_freeze`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:71` | Self: 0.0% (281us) | Total: 0.0% (281us) | Samples: 1

**Called by:**
- `(module)` (1)

### `static`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:126` | Self: 0.0% (279us) | Total: 5.3% (264.6ms) | Samples: 1

**Called by:**
- `(module)` (701)

**Calls:**
- `Request` (700)

### `getModules`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js` | Self: 0.0% (279us) | Total: 0.0% (279us) | Samples: 1

**Called by:**
- `async scanModulesForDependencies` (1)

### `CreateMetadataRegistry`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (277us) | Total: 0.0% (277us) | Samples: 1

**Called by:**
- `GetOrCreateMetadataRegistry` (1)

### `createForStatic`
`/home/user/bun-node/node_modules/@nestjs/core/injector/opaque-key-factory/by-reference-module-opaque-key-factory.js` | Self: 0.0% (277us) | Total: 0.0% (277us) | Samples: 1

**Called by:**
- `async compile` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncAction.js` | Self: 0.0% (276us) | Total: 0.0% (276us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/redirect.decorator.js:2` | Self: 0.0% (276us) | Total: 0.0% (276us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/SequenceError.js` | Self: 0.0% (276us) | Total: 0.0% (276us) | Samples: 1

**Called by:**
- `createErrorClass` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/uint8array-extras/index.js:178` | Self: 0.0% (275us) | Total: 0.0% (275us) | Samples: 1

**Called by:**
- `from` (1)

### `RouteCandidateIndex`
`[native code]` | Self: 0.0% (274us) | Total: 0.0% (274us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async loadInstance`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:77` | Self: 0.0% (274us) | Total: 0.2% (14.3ms) | Samples: 1

**Called by:**
- `async loadInstance` (39)

**Calls:**
- `async resolveConstructorParams` (37)
- `async resolveConstructorParams` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts` | Self: 0.0% (272us) | Total: 0.0% (272us) | Samples: 1

**Called by:**
- `BunWebSocket` (1)

### `getEffectiveResolutionContext`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (270us) | Total: 0.0% (270us) | Samples: 1

**Called by:**
- `async (anonymous)` (1)

### `getMetaKeyByInstanceWrapper`
`/home/user/bun-node/node_modules/@nestjs/core/discovery/discoverable-meta-host-collection.js` | Self: 0.0% (270us) | Total: 0.0% (270us) | Samples: 1

**Called by:**
- `inspectInstanceWrapper` (1)

### `put`
`/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/lib/index.js` | Self: 0.0% (270us) | Total: 0.0% (270us) | Samples: 1

**Called by:**
- `signatureToArray` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/sockets-container.js:5` | Self: 0.0% (268us) | Total: 0.0% (268us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `extendStatics`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/VirtualTimeScheduler.js` | Self: 0.0% (266us) | Total: 0.0% (266us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/picoquery/lib/string-util.js` | Self: 0.0% (266us) | Total: 0.0% (266us) | Samples: 1

**Called by:**
- `from` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/timeInterval.js:19` | Self: 0.0% (265us) | Total: 0.0% (265us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `useFactory`
`/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module-factory.js` | Self: 0.0% (265us) | Total: 0.0% (265us) | Samples: 1

**Called by:**
- `async instantiateClass` (1)

### `async createInstancesOfInjectables`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js` | Self: 0.0% (264us) | Total: 0.0% (264us) | Samples: 1

**Called by:**
- `async (anonymous)` (1)

### `resolveWebSocketOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` | Self: 0.0% (264us) | Total: 0.0% (264us) | Samples: 1

**Called by:**
- `BunHttpAdapter` (1)

### `mergeBunRequestOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` | Self: 0.0% (264us) | Total: 0.0% (264us) | Samples: 1

**Called by:**
- `set requestOpts` (1)

### `IsArray`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:770` | Self: 0.0% (264us) | Total: 0.0% (474us) | Samples: 1

**Called by:**
- `decorate` (1)
- `decorate` (1)

**Calls:**
- `isArray` (1)

### `writer`
`[native code]` | Self: 0.0% (262us) | Total: 0.0% (262us) | Samples: 1

**Called by:**
- `WriteStream` (1)

### `send`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1409` | Self: 0.0% (260us) | Total: 0.0% (260us) | Samples: 1

**Called by:**
- `async apply` (1)

### `getInspectOptions`
`/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js` | Self: 0.0% (260us) | Total: 0.0% (260us) | Samples: 1

**Called by:**
- `ConsoleLogger` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts:181` | Self: 0.0% (259us) | Total: 0.0% (259us) | Samples: 1

### `useColors`
`/home/user/bun-node/node_modules/debug/src/node.js:158` | Self: 0.0% (259us) | Total: 0.0% (1.6ms) | Samples: 1

**Called by:**
- `createDebug` (6)

**Calls:**
- `(anonymous)` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:79` | Self: 0.0% (258us) | Total: 0.0% (258us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async loadProvider`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:107` | Self: 0.0% (256us) | Total: 0.0% (475us) | Samples: 1

**Called by:**
- `async loadProvider` (1)

**Calls:**
- `shouldSkipProviderLoading` (1)

### `thresholdValue`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts` | Self: 0.0% (256us) | Total: 0.0% (256us) | Samples: 1

**Called by:**
- `StructuredLogger` (1)

### `getVersion`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:49` | Self: 0.0% (255us) | Total: 0.0% (255us) | Samples: 1

**Called by:**
- `create` (1)

### `useColors`
`/home/user/bun-node/node_modules/debug/src/node.js` | Self: 0.0% (254us) | Total: 0.0% (254us) | Samples: 1

**Called by:**
- `createDebug` (1)

### `WritableState`
`internal:streams/writable` | Self: 0.0% (254us) | Total: 0.0% (254us) | Samples: 1

**Called by:**
- `Writable` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:3` | Self: 0.0% (252us) | Total: 0.0% (252us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(program)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/silent-logger.js:1` | Self: 0.0% (252us) | Total: 0.0% (252us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:18` | Self: 0.0% (251us) | Total: 0.0% (251us) | Samples: 1

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js` | Self: 0.0% (251us) | Total: 0.0% (251us) | Samples: 1

**Called by:**
- `Mime` (1)

### `isBoolean`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:158` | Self: 0.0% (250us) | Total: 0.0% (250us) | Samples: 1

**Called by:**
- `parseCookies` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/last.js:2` | Self: 0.0% (250us) | Total: 0.0% (250us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `toString`
`[native code]` | Self: 0.0% (249us) | Total: 0.0% (249us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:2` | Self: 0.0% (248us) | Total: 0.0% (248us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `setPrototypeDirect`
`[native code]` | Self: 0.0% (248us) | Total: 0.0% (248us) | Samples: 1

**Called by:**
- `internal:util/inspect` (1)

### `__exportStar`
`/home/user/bun-node/node_modules/tslib/tslib.js` | Self: 0.0% (247us) | Total: 0.0% (247us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `getInstanceByContextId`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:49` | Self: 0.0% (246us) | Total: 0.0% (246us) | Samples: 1

**Called by:**
- `async loadInstance` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/NotFoundError.js` | Self: 0.0% (246us) | Total: 0.0% (246us) | Samples: 1

**Called by:**
- `createErrorClass` (1)

### `Mime`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js` | Self: 0.0% (246us) | Total: 0.0% (246us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` | Self: 0.0% (245us) | Total: 0.0% (245us) | Samples: 1

**Called by:**
- `BunHttpAdapter` (1)

### `NestApplication`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:38` | Self: 0.0% (244us) | Total: 0.0% (244us) | Samples: 1

**Called by:**
- `async create` (1)

### `pick`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` | Self: 0.0% (244us) | Total: 0.0% (244us) | Samples: 1

**Called by:**
- `BunRouter` (1)

### `MiddlewareModule`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` | Self: 0.0% (244us) | Total: 0.0% (244us) | Samples: 1

**Called by:**
- `NestApplication` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js:14` | Self: 0.0% (244us) | Total: 0.0% (244us) | Samples: 1

**Called by:**
- `Promise` (1)

### `(module)`
`/home/user/bun-node/node_modules/mime/dist/types/standard.js:365` | Self: 0.0% (243us) | Total: 0.0% (243us) | Samples: 1

### `BunRouter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (243us) | Total: 0.0% (243us) | Samples: 1

**Called by:**
- `BunHttpAdapter` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/discovery/index.js:4` | Self: 0.0% (243us) | Total: 0.5% (27.1ms) | Samples: 1

**Called by:**
- `anonymous` (113)

**Calls:**
- `bound require` (112)

### `async registerMiddlewareConfig`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` | Self: 0.0% (241us) | Total: 0.0% (241us) | Samples: 1

**Called by:**
- `async registerMiddlewareConfig` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` | Self: 0.0% (241us) | Total: 0.0% (241us) | Samples: 1

**Called by:**
- `forEach` (1)

### `addLeadingSlash`
`/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:26` | Self: 0.0% (239us) | Total: 0.0% (239us) | Samples: 1

**Called by:**
- `exploreMethodMetadata` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts:264` | Self: 0.0% (238us) | Total: 0.0% (238us) | Samples: 1

### `splitPattern`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:55` | Self: 0.0% (237us) | Total: 0.0% (237us) | Samples: 1

**Called by:**
- `compileRoute` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/opaque-key-factory/deep-hashed-module-opaque-key-factory.js:11` | Self: 0.0% (237us) | Total: 0.0% (237us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:125` | Self: 0.0% (236us) | Total: 0.0% (2.6ms) | Samples: 1

**Called by:**
- `forEach` (9)

**Calls:**
- `forEach` (8)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:21` | Self: 0.0% (236us) | Total: 0.0% (2.7ms) | Samples: 1

**Called by:**
- `Mime` (3)

**Calls:**
- `set` (2)

### `NestApplicationContext`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:36` | Self: 0.0% (235us) | Total: 0.0% (235us) | Samples: 1

**Called by:**
- `NestApplication` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1048` | Self: 0.0% (235us) | Total: 0.0% (235us) | Samples: 1

**Called by:**
- `registerVerb` (1)

### `concat`
`[native code]` | Self: 0.0% (235us) | Total: 0.0% (235us) | Samples: 1

**Called by:**
- `log` (1)

### `getGlobalMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js:57` | Self: 0.0% (235us) | Total: 0.0% (235us) | Samples: 1

**Called by:**
- `createContext` (1)

### `(program)`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter.js:1` | Self: 0.0% (235us) | Total: 0.0% (235us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:19` | Self: 0.0% (233us) | Total: 0.0% (2.6ms) | Samples: 1

**Called by:**
- `createCallbackProxy` (10)
- `async createProxy` (2)
- `registerNotFoundHandler` (1)

**Calls:**
- `createContext` (3)
- `createContext` (2)
- `createContext` (2)
- `createContext` (2)
- `createContext` (2)
- `createContext` (1)

### `async registerRouter`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` | Self: 0.0% (232us) | Total: 0.0% (232us) | Samples: 1

**Called by:**
- `async init` (1)

### `(module)`
`/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/node_modules/@borewit/text-codec/lib/index.js:12` | Self: 0.0% (232us) | Total: 0.0% (232us) | Samples: 1

### `#produceResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:550` | Self: 0.0% (232us) | Total: 0.0% (232us) | Samples: 1

### `setModuleContext`
`/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js` | Self: 0.0% (231us) | Total: 0.0% (231us) | Samples: 1

**Called by:**
- `exchangeKeysForValues` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/sse-stream.js:3` | Self: 0.0% (231us) | Total: 0.0% (231us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Notification.js` | Self: 0.0% (230us) | Total: 0.0% (230us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` | Self: 0.0% (230us) | Total: 0.0% (230us) | Samples: 1

**Called by:**
- `some` (1)

### `createPipesFn`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` | Self: 0.0% (230us) | Total: 0.0% (230us) | Samples: 1

**Called by:**
- `create` (1)

### `AsyncScheduler`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js:26` | Self: 0.0% (230us) | Total: 0.0% (230us) | Samples: 1

**Called by:**
- `QueueScheduler` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js` | Self: 0.0% (230us) | Total: 0.0% (230us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `serveNativeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` | Self: 0.0% (229us) | Total: 0.0% (229us) | Samples: 1

**Called by:**
- `(module)` (1)

### `isDisjoint`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (229us) | Total: 0.0% (229us) | Samples: 1

**Called by:**
- `candidates` (1)

### `next`
`/home/user/bun-node/node_modules/iterare/lib/map.js:12` | Self: 0.0% (228us) | Total: 0.1% (6.3ms) | Samples: 1

**Called by:**
- `from` (24)
- `next` (2)

**Calls:**
- `next` (13)
- `next` (12)

### `extractWildcardNames`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:242` | Self: 0.0% (228us) | Total: 0.0% (228us) | Samples: 1

**Called by:**
- `setRoute` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/runtime.exception.js:4` | Self: 0.0% (228us) | Total: 0.0% (228us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(program)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/compiler.js:1` | Self: 0.0% (228us) | Total: 0.0% (228us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `node:events`
`node:events:645` | Self: 0.0% (228us) | Total: 0.0% (228us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `callOperator`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js` | Self: 0.0% (227us) | Total: 0.0% (227us) | Samples: 1

**Called by:**
- `async callModuleInitHook` (1)

### `validateKey`
`/home/user/bun-node/node_modules/@nestjs/common/utils/validate-module-keys.util.js` | Self: 0.0% (227us) | Total: 0.0% (227us) | Samples: 1

**Called by:**
- `forEach` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/parse-float.pipe.js:2` | Self: 0.0% (227us) | Total: 0.0% (227us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `isIterator`
`/home/user/bun-node/node_modules/iterare/lib/utils.js:4` | Self: 0.0% (227us) | Total: 0.0% (227us) | Samples: 1

**Called by:**
- `toIterator` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:76` | Self: 0.0% (226us) | Total: 0.0% (226us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:29` | Self: 0.0% (226us) | Total: 0.0% (226us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `getProviderNoCache`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:919` | Self: 0.0% (226us) | Total: 0.0% (226us) | Samples: 1

**Called by:**
- `getProvider` (1)

### `#respondWithText`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (226us) | Total: 0.0% (226us) | Samples: 1

**Called by:**
- `async apply` (1)

### `internal:streams/readable`
`internal:streams/readable:642` | Self: 0.0% (226us) | Total: 0.0% (226us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/discovery/discoverable-meta-host-collection.js:4` | Self: 0.0% (226us) | Total: 0.0% (226us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:45` | Self: 0.0% (225us) | Total: 0.0% (225us) | Samples: 1

**Called by:**
- `Route` (1)

### `InstanceWrapper`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:24` | Self: 0.0% (225us) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `addController` (4)
- `insertMiddleware` (1)

**Calls:**
- `get` (2)
- `generateUuid` (2)

### `AnimationFrameScheduler`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AnimationFrameScheduler.js:23` | Self: 0.0% (225us) | Total: 0.0% (225us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `addListener`
`node:events` | Self: 0.0% (225us) | Total: 0.0% (225us) | Samples: 1

**Called by:**
- `Agent` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:38` | Self: 0.0% (225us) | Total: 0.0% (225us) | Samples: 1

**Called by:**
- `Route` (1)

### `extractNonWildcardPathsFrom`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js` | Self: 0.0% (224us) | Total: 0.0% (224us) | Samples: 1

**Called by:**
- `async registerHandler` (1)

### `async init`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:105` | Self: 0.0% (224us) | Total: 0.0% (2.0ms) | Samples: 1

**Calls:**
- `async callInitHook` (9)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js:25` | Self: 0.0% (224us) | Total: 0.0% (847us) | Samples: 1

**Called by:**
- `next` (4)

**Calls:**
- `isDependencyTreeStatic` (2)
- `isDependencyTreeStatic` (1)

### `createConcreteContext`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter-context.js` | Self: 0.0% (224us) | Total: 0.0% (224us) | Samples: 1

**Called by:**
- `createContext` (1)

### `async callModuleInitHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:37` | Self: 0.0% (223us) | Total: 0.0% (411us) | Samples: 1

**Called by:**
- `async callModuleInitHook` (2)

**Calls:**
- `performIteration` (1)

### `getGlobalMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js:53` | Self: 0.0% (223us) | Total: 0.0% (223us) | Samples: 1

**Called by:**
- `createContext` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js` | Self: 0.0% (223us) | Total: 0.0% (223us) | Samples: 1

**Called by:**
- `async createProxy` (1)

### `reflectDynamicMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:145` | Self: 0.0% (223us) | Total: 0.4% (22.9ms) | Samples: 1

**Called by:**
- `(anonymous)` (17)

**Calls:**
- `reflectInjectables` (9)
- `reflectInjectables` (5)
- `reflectInjectables` (1)
- `reflectInjectables` (1)

### `getGlobalMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js` | Self: 0.0% (223us) | Total: 0.0% (223us) | Samples: 1

**Called by:**
- `createContext` (1)

### `FinalizationRegistry`
`[native code]` | Self: 0.0% (223us) | Total: 0.0% (223us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `makeSafe`
`internal:primordials` | Self: 0.0% (223us) | Total: 0.0% (223us) | Samples: 1

**Called by:**
- `internal:primordials` (1)

### `Agent`
`node:_http_agent` | Self: 0.0% (222us) | Total: 0.0% (222us) | Samples: 1

**Called by:**
- `node:_http_agent` (1)

### `mapToClass`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/utils.js` | Self: 0.0% (222us) | Total: 0.0% (222us) | Samples: 1

**Called by:**
- `next` (1)

### `async callBootstrapHook`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` | Self: 0.0% (222us) | Total: 0.0% (222us) | Samples: 1

**Called by:**
- `async callBootstrapHook` (1)

### `getAllMethodNames`
`/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:67` | Self: 0.0% (221us) | Total: 0.0% (422us) | Samples: 1

**Called by:**
- `scanForPaths` (1)
- `reflectInjectables` (1)

**Calls:**
- `set` (1)

### `#finishPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (221us) | Total: 0.0% (221us) | Samples: 1

### `getGlobalMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js` | Self: 0.0% (220us) | Total: 0.0% (220us) | Samples: 1

**Called by:**
- `createContext` (1)

### `createConcreteContext`
`/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js:20` | Self: 0.0% (220us) | Total: 0.0% (220us) | Samples: 1

**Called by:**
- `createContext` (1)

### `log`
`[native code]` | Self: 0.0% (220us) | Total: 0.0% (220us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:43` | Self: 0.0% (220us) | Total: 0.0% (412us) | Samples: 1

**Called by:**
- `map` (2)

**Calls:**
- `addLeadingSlash` (1)

### `createPipesFn`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:156` | Self: 0.0% (219us) | Total: 0.0% (219us) | Samples: 1

**Called by:**
- `create` (1)

### `async instantiateClass`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:428` | Self: 0.0% (219us) | Total: 0.0% (219us) | Samples: 1

**Called by:**
- `async instantiateClass` (1)

### `createConvenienceMethod`
`node:zlib` | Self: 0.0% (219us) | Total: 0.0% (219us) | Samples: 1

**Called by:**
- `node:zlib` (1)

### `shouldSkipProviderLoading`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (219us) | Total: 0.0% (219us) | Samples: 1

**Called by:**
- `async loadProvider` (1)

### `get isStreamOpen`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:1624` | Self: 0.0% (219us) | Total: 0.0% (219us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/optional.decorator.js:22` | Self: 0.0% (219us) | Total: 0.0% (625us) | Samples: 1

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `getMetadata` (2)

### `__decorate`
`/home/user/bun-node/node_modules/tslib/tslib.js` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `GatewayMetadataExplorer`
`/home/user/bun-node/node_modules/@nestjs/websockets/gateway-metadata-explorer.js` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

**Called by:**
- `WebSocketsController` (1)

### `GetIterator`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:814` | Self: 0.0% (218us) | Total: 0.1% (6.4ms) | Samples: 1

**Called by:**
- `OrdinaryOwnMetadataKeys` (2)

**Calls:**
- `GetMethod` (1)

### `createGuardsFn`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

**Called by:**
- `create` (1)

### `OrdinaryGetPrototypeOf`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

**Called by:**
- `OrdinaryGetMetadata` (1)

### `printIntrospectedAsRequestScoped`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

**Called by:**
- `isDependencyTreeStatic` (1)

### `async transformToResult`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

**Called by:**
- `async (anonymous)` (1)

### `async bindHandler`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

**Called by:**
- `async bindHandler` (1)

### `createAdapterProxy`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:70` | Self: 0.0% (217us) | Total: 0.0% (2.9ms) | Samples: 1

**Called by:**
- `create` (6)

**Calls:**
- `getStatusByMethod` (3)
- `getStatusByMethod` (2)

### `colorIfAllowed`
`/home/user/bun-node/node_modules/@nestjs/common/utils/cli-colors.util.js` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `get id`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `set`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:12` | Self: 0.0% (217us) | Total: 0.0% (217us) | Samples: 1

**Called by:**
- `getMetadata` (1)

### `getGlobalMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

**Called by:**
- `createContext` (1)

### `async loadConfiguration`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:49` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

**Called by:**
- `async loadConfiguration` (1)

### `extractVersionPathFrom`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

**Called by:**
- `extractPathsFrom` (1)

### `async registerModules`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:81` | Self: 0.0% (216us) | Total: 0.0% (1.9ms) | Samples: 1

**Called by:**
- `async registerModules` (8)

**Calls:**
- `registerWsModule` (7)

### `getInstanceByContextId`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:46` | Self: 0.0% (216us) | Total: 0.0% (520us) | Samples: 1

**Called by:**
- `get instance` (2)

**Calls:**
- `get` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/EmptyError.js:5` | Self: 0.0% (215us) | Total: 0.0% (430us) | Samples: 1

**Called by:**
- `anonymous` (1)
- `createErrorClass` (1)

**Calls:**
- `createErrorClass` (1)

### `applyHostFilter`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `applyCallbackToRouter` (1)

### `getModulesToTriggerHooksOn`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `async callInitHook` (1)

### `async callModuleBootstrapHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `async callModuleBootstrapHook` (1)

### `async init`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `async init` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:131` | Self: 0.0% (214us) | Total: 0.0% (1.6ms) | Samples: 1

**Called by:**
- `forEach` (5)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)
- `log` (1)

### `RouterExplorer`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `RoutesResolver` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduleIterable.js:3` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4765` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `dispatch` (1)

### `exchangeKeysForValues`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `getMetadata` (1)

### `get metatype`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `get name` (1)

### `(anonymous)`
`internal:util/inspect:46` | Self: 0.0% (214us) | Total: 0.0% (414us) | Samples: 1

**Called by:**
- `filter` (2)

**Calls:**
- `bound call` (1)

### `NestApplicationContext`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `NestApplication` (1)

### `FreeList`
`internal:freelist` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `node:_http_common` (1)

### `Observable`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `get size`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:276` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `setRoute` (1)

### `Scheduler`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Scheduler.js` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `AsyncScheduler` (1)

### `Buffer`
`[native code]` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `applyCallbackToRouter`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-id-factory.js:3` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `async resolveMiddlewareInstance`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `async resolveMiddlewareInstance` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:69` | Self: 0.0% (213us) | Total: 0.0% (594us) | Samples: 1

**Calls:**
- `performProxyObjectGet` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/UnsubscriptionError.js` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `createErrorClass` (1)

### `matchRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `getMatchedLayers` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:21` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

### `startInterval`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:193` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `Cache` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1003` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `registerVerb` (1)

### `internal:shared`
`internal:shared:173` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `splitPattern`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:58` | Self: 0.0% (212us) | Total: 0.0% (423us) | Samples: 1

**Called by:**
- `compileRoute` (2)

**Calls:**
- `slice` (1)

### `node:_http_agent`
`node:_http_agent:68` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4774` | Self: 0.0% (212us) | Total: 1.1% (58.7ms) | Samples: 1

**Called by:**
- `dispatch` (144)

**Calls:**
- `getRequestPathFromRequestURL` (105)
- `getRequestPathFromRequestURL` (37)
- `getRequestPathFromRequestURL` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:157` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `forEach` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/modules/injection-token.interface.js:2` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `node:_http_client`
`node:_http_client:220` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `createCallbackProxy` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:39` | Self: 0.0% (211us) | Total: 0.0% (421us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (2)

**Calls:**
- `charCodeAt` (1)

### `reflectInjectables`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:170` | Self: 0.0% (211us) | Total: 0.0% (616us) | Samples: 1

**Called by:**
- `reflectDynamicMetadata` (1)
- `reflectDynamicMetadata` (1)
- `reflectDynamicMetadata` (1)

**Calls:**
- `forEach` (2)

### `slice`
`[native code]` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `splitPattern` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:42` | Self: 0.0% (211us) | Total: 2.8% (140.8ms) | Samples: 1

**Called by:**
- `forEach` (426)

**Calls:**
- `forEach` (425)

### `typedArrayViewIsTypedArrayView`
`[native code]` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `next` (1)

### `createConcreteContext`
`/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:20` | Self: 0.0% (211us) | Total: 0.0% (3.9ms) | Samples: 1

**Called by:**
- `(anonymous)` (2)
- `createContext` (1)
- `createContext` (1)

**Calls:**
- `isEmpty` (3)

### `(anonymous)`
`internal:http` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `internal:http` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:3` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `async resolveInstances`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `async resolveInstances` (1)

### `async register`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `async register` (1)

### `charCodeAt`
`[native code]` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `pathRegex` (1)

### `async loadEnhancersPerContext`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:457` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `async loadEnhancersPerContext` (1)

### `registerVerb`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1544` | Self: 0.0% (210us) | Total: 0.4% (23.5ms) | Samples: 1

**Called by:**
- `get` (57)
- `bound get` (26)

**Calls:**
- `setRoute` (72)
- `get` (3)
- `setRoute` (1)
- `get` (1)
- `addRoute` (1)
- `setRoute` (1)
- `setRoute` (1)
- `setRoute` (1)
- `setRoute` (1)

### `async loadInstance`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:65` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `async loadInstance` (1)

### `async loadMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `async loadMiddleware` (1)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1270` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `init` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:2` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `flat`
`[native code]` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:32` | Self: 0.0% (209us) | Total: 0.0% (2.1ms) | Samples: 1

**Called by:**
- `createCallbackProxy` (10)

**Calls:**
- `createContext` (4)
- `createContext` (3)
- `createContext` (1)
- `createContext` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:54` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `Route` (1)

### `async registerHandler`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

### `getOwnPropertyNames`
`[native code]` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `internal:util/inspect` (1)

### `createContext`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:8` | Self: 0.0% (209us) | Total: 0.0% (3.1ms) | Samples: 1

**Called by:**
- `create` (7)
- `create` (3)
- `create` (3)
- `create` (2)

**Calls:**
- `getGlobalMetadata` (6)
- `getGlobalMetadata` (2)
- `getGlobalMetadata` (1)
- `getGlobalMetadata` (1)
- `getGlobalMetadata` (1)
- `getGlobalMetadata` (1)
- `getGlobalMetadata` (1)
- `getGlobalMetadata` (1)

### `addLeadingSlash`
`/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `RouteInfoPathExtractor` (1)

### `async (anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `async middlewareHandler` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js:71` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `createExceptionLayerProxy`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `registerExceptionHandler` (1)

### `__`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:13` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:14` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `Route` (1)

### `getHttpAdapterRef`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:53` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `RoutesResolver` (1)

### `getVersion`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `create` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:184` | Self: 0.0% (208us) | Total: 11.5% (568.1ms) | Samples: 1

**Calls:**
- `async apply` (1401)
- `async apply` (33)

### `getAllMethodNames`
`/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:56` | Self: 0.0% (208us) | Total: 0.0% (403us) | Samples: 1

**Called by:**
- `scanForPaths` (1)
- `reflectInjectables` (1)

**Calls:**
- `has` (1)

### `#respond`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

### `async loadEnhancersPerContext`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `async loadProvider` (1)

### `reflectKeyMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:195` | Self: 0.0% (208us) | Total: 0.1% (8.5ms) | Samples: 1

**Called by:**
- `(anonymous)` (17)

**Calls:**
- `getMetadata` (16)

### `Param`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:238` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `(module)` (1)

### `FilterIterator`
`/home/user/bun-node/node_modules/iterare/lib/filter.js` | Self: 0.0% (207us) | Total: 0.0% (207us) | Samples: 1

**Called by:**
- `filter` (1)

### `#build`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:201` | Self: 0.0% (207us) | Total: 0.0% (207us) | Samples: 1

**Called by:**
- `candidates` (1)

### `#compileRouteRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` | Self: 0.0% (207us) | Total: 0.0% (394us) | Samples: 1

**Called by:**
- `Route` (2)

**Calls:**
- `map` (1)

### `node:async_hooks`
`node:async_hooks:311` | Self: 0.0% (207us) | Total: 0.0% (207us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:13` | Self: 0.0% (207us) | Total: 0.0% (670us) | Samples: 1

**Called by:**
- `(anonymous)` (2)
- `(anonymous)` (1)

**Calls:**
- `getVersion` (1)
- `getVersion` (1)

### `getAllMethodNames`
`/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:63` | Self: 0.0% (207us) | Total: 0.0% (207us) | Samples: 1

**Called by:**
- `reflectInjectables` (1)

### `async lookupComponent`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (207us) | Total: 0.0% (207us) | Samples: 1

**Called by:**
- `async resolveComponentWrapper` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:20` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `next` (1)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1699` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `registerVerb` (1)

### `setProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:984` | Self: 0.0% (206us) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `GetMetadataProvider` (2)

**Calls:**
- `set` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:13` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/BehaviorSubject.js` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `charAt`
`[native code]` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `addLeadingSlash` (1)

### `status`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1182` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `setStatus` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:84` | Self: 0.0% (205us) | Total: 0.0% (3.1ms) | Samples: 1

**Called by:**
- `setRoute` (15)

**Calls:**
- `Cache` (4)
- `Cache` (3)
- `Cache` (2)
- `Cache` (1)
- `Cache` (1)
- `Cache` (1)
- `Cache` (1)
- `Cache` (1)

### `async resolveProperties`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:352` | Self: 0.0% (205us) | Total: 0.0% (2.8ms) | Samples: 1

**Called by:**
- `async resolveProperties` (14)

**Calls:**
- `reflectProperties` (12)
- `reflectProperties` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:30` | Self: 0.0% (205us) | Total: 0.0% (404us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (2)

**Calls:**
- `push` (1)

### `mapIterationEntryKey`
`[native code]` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `forEach` (1)

### `async handleBodyParsing`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3389` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `async handleBodyParsing` (1)

### `createCallbackProxy`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `applyCallbackToRouter` (1)

### `node:_http_common`
`node:_http_common:2` | Self: 0.0% (205us) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `anonymous` (6)

**Calls:**
- `anonymous` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:191` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `BunResponse`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:696` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `next`
`/home/user/bun-node/node_modules/iterare/lib/map.js` | Self: 0.0% (205us) | Total: 0.0% (205us) | Samples: 1

**Called by:**
- `next` (1)

### `async resolveConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:133` | Self: 0.0% (204us) | Total: 0.0% (204us) | Samples: 1

**Called by:**
- `async resolveConstructorParams` (1)

### `OrdinaryGetOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1069` | Self: 0.0% (204us) | Total: 0.0% (204us) | Samples: 1

**Called by:**
- `OrdinaryGetOwnMetadata` (1)

### `getGetter`
`internal:primordials` | Self: 0.0% (204us) | Total: 0.0% (204us) | Samples: 1

**Called by:**
- `internal:primordials` (1)

### `enable`
`/home/user/bun-node/node_modules/debug/src/common.js` | Self: 0.0% (204us) | Total: 0.0% (204us) | Samples: 1

**Called by:**
- `setup` (1)

### `extractPathsFrom`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js` | Self: 0.0% (204us) | Total: 0.0% (204us) | Samples: 1

**Called by:**
- `async registerHandler` (1)

### `_preferredTypeLegacy`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:205` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `forEachMimeType` (1)

### `node:diagnostics_channel`
`node:diagnostics_channel:2` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `createContext`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:6` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `create` (1)

### `set`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `getMetadata` (1)

### `reflectRenderTemplate`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `createHandleResponseFn` (1)

### `isDependencyTreeStatic`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `isStatic` (1)

### `asyncWrap`
`node:fs/promises` | Self: 0.0% (203us) | Total: 0.0% (203us) | Samples: 1

**Called by:**
- `node:fs/promises` (1)

### `internal:util/inspect`
`internal:util/inspect:9` | Self: 0.0% (202us) | Total: 0.0% (202us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `getNowTimestamp`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:641` | Self: 0.0% (202us) | Total: 0.0% (202us) | Samples: 1

**Called by:**
- `async loadInstance` (1)

### `AsyncScheduler`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js` | Self: 0.0% (202us) | Total: 0.0% (202us) | Samples: 1

**Called by:**
- `AsapScheduler` (1)

### `startInterval`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:191` | Self: 0.0% (202us) | Total: 0.0% (202us) | Samples: 1

**Called by:**
- `Cache` (1)

### `reflectKeyMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:191` | Self: 0.0% (202us) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `(anonymous)` (5)

**Calls:**
- `getOwnPropertyDescriptor` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/publish.js:2` | Self: 0.0% (201us) | Total: 0.0% (201us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:82` | Self: 0.0% (201us) | Total: 0.0% (201us) | Samples: 1

**Called by:**
- `create` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:6` | Self: 0.0% (201us) | Total: 0.0% (201us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `get headersSent`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:2049` | Self: 0.0% (201us) | Total: 0.0% (201us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async resolveConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:129` | Self: 0.0% (201us) | Total: 0.0% (201us) | Samples: 1

**Called by:**
- `async resolveConstructorParams` (1)

### `ToPropertyKey`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (201us) | Total: 0.0% (201us) | Samples: 1

**Called by:**
- `decorate` (1)

### `normalizeCatchAllPath`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:217` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `setRoute` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:237` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `loadPrototype`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:33` | Self: 0.0% (200us) | Total: 0.1% (5.5ms) | Samples: 1

**Called by:**
- `forEach` (9)

**Calls:**
- `createPrototype` (5)
- `createPrototype` (2)
- `create` (1)

### `set response`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `#respondWithText` (1)

### `call`
`[native code]` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `bound call` (1)

### `NestFactoryStatic`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:28` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:40` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `forEach` (1)

### `setProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:982` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `GetMetadataProvider` (1)

### `getStaticTransientResolutionContext`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `async (anonymous)` (1)

### `useMethod`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `async callInitHook`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `async callInitHook` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-shutdown.hook.js:3` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `BenchController`
`[native code]` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

**Called by:**
- `async instantiateClass` (1)

### `reflectMethodMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:22` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

**Called by:**
- `createContext` (1)

### `mapFactoryProviderInjectArray`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

**Called by:**
- `map` (1)

### `async resolveComponentWrapper`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (198us) | Total: 0.0% (198us) | Samples: 1

**Called by:**
- `async resolveSingleParam` (1)

### `status`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` | Self: 0.0% (198us) | Total: 0.0% (198us) | Samples: 1

**Called by:**
- `setStatus` (1)

### `async instantiateClass`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:420` | Self: 0.0% (198us) | Total: 0.0% (198us) | Samples: 1

**Called by:**
- `async instantiateClass` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:224` | Self: 0.0% (198us) | Total: 0.0% (198us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:87` | Self: 0.0% (198us) | Total: 0.0% (198us) | Samples: 1

**Called by:**
- `map` (1)

### `node:http`
`node:http:5` | Self: 0.0% (198us) | Total: 0.0% (198us) | Samples: 1

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5037` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:80` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

**Called by:**
- `map` (1)

### `scanForPaths`
`/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:15` | Self: 0.0% (197us) | Total: 0.0% (2.4ms) | Samples: 1

**Called by:**
- `explore` (10)

**Calls:**
- `getAllMethodNames` (3)
- `getAllMethodNames` (2)
- `getAllMethodNames` (1)
- `getAllMethodNames` (1)
- `getAllMethodNames` (1)
- `getAllMethodNames` (1)

### `loadPrototype`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:28` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

**Called by:**
- `forEach` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/unknown-dependencies.exception.js:6` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `async resolveMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `async resolveMiddleware` (1)

### `IsPropertyKey`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `decorator` (1)

### `RouterExecutionContext`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `RouterExplorer` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:117` | Self: 0.0% (196us) | Total: 0.4% (24.0ms) | Samples: 1

**Called by:**
- `forEach` (85)

**Calls:**
- `bound get` (84)

### `addScopedEnhancersMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `async scan` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/max.js:9` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `getArgumentsLength`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:23` | Self: 0.0% (196us) | Total: 0.0% (1.0ms) | Samples: 1

**Called by:**
- `getMetadata` (5)

**Calls:**
- `map` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:164` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:19` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `reduce` (1)

### `getArgumentsLength`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `getMetadata` (1)

### `internal:fs/streams`
`internal:fs/streams:156` | Self: 0.0% (196us) | Total: 0.0% (196us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `applyApplicationProviders`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `async (anonymous)` (1)

### `Controller`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/controller.decorator.js` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `(module)` (1)

### `Body`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:189` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `(module)` (1)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:427` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `serveNativeRequest` (1)

### `node:crypto`
`node:crypto:279` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `ConsoleLogger`
`/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delay.js:2` | Self: 0.0% (195us) | Total: 0.0% (195us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1051` | Self: 0.0% (194us) | Total: 0.0% (194us) | Samples: 1

**Called by:**
- `useMethod` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:11` | Self: 0.0% (194us) | Total: 0.0% (194us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `PipesContextCreator`
`/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:11` | Self: 0.0% (194us) | Total: 0.0% (194us) | Samples: 1

**Called by:**
- `getContextCreator` (1)

### `addCtorMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:102` | Self: 0.0% (194us) | Total: 0.0% (194us) | Samples: 1

**Called by:**
- `addDependencyMetadata` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:18` | Self: 0.0% (194us) | Total: 0.0% (615us) | Samples: 1

**Called by:**
- `createCallbackProxy` (3)

**Calls:**
- `ExceptionsHandler` (2)

### `Module`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/modules/module.decorator.js` | Self: 0.0% (194us) | Total: 0.0% (194us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4784` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `dispatch` (1)

### `OrdinaryDefineOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1075` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `OrdinaryDefineOwnMetadata` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/request/index.js:3` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:107` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `map` (1)

### `MapIterator`
`/home/user/bun-node/node_modules/iterare/lib/map.js` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `map` (1)

### `forEachMimeType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:174` | Self: 0.0% (193us) | Total: 0.0% (1.2ms) | Samples: 1

**Called by:**
- `forEach` (6)

**Calls:**
- `_preferredTypeLegacy` (2)
- `_preferredTypeLegacy` (2)
- `_preferredTypeLegacy` (1)

### `appendToAllIfDefined`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:64` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `create` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:119` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `forEach` (1)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` | Self: 0.0% (192us) | Total: 0.0% (192us) | Samples: 1

**Called by:**
- `create` (1)

### `exploreMethodMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:32` | Self: 0.0% (192us) | Total: 0.0% (1.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (6)

**Calls:**
- `getMetadata` (5)

### `isMiddlewareClass`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/utils.js:82` | Self: 0.0% (192us) | Total: 0.0% (192us) | Samples: 1

**Called by:**
- `mapToClass` (1)

### `getGlobalFilters`
`/home/user/bun-node/node_modules/@nestjs/core/application-config.js` | Self: 0.0% (192us) | Total: 0.0% (192us) | Samples: 1

**Called by:**
- `getGlobalMetadata` (1)

### `node:crypto`
`node:crypto:2` | Self: 0.0% (192us) | Total: 0.0% (406us) | Samples: 1

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (1)

### `get`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:202` | Self: 0.0% (192us) | Total: 0.0% (384us) | Samples: 1

**Called by:**
- `async initNest` (1)

**Calls:**
- `createExceptionZone` (1)

### `createExceptionZone`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js` | Self: 0.0% (192us) | Total: 0.0% (192us) | Samples: 1

**Called by:**
- `get` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:38` | Self: 0.0% (192us) | Total: 0.0% (192us) | Samples: 1

**Called by:**
- `#compileRouteRegExp` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:31` | Self: 0.0% (192us) | Total: 0.1% (8.1ms) | Samples: 1

**Called by:**
- `createCallbackProxy` (21)

**Calls:**
- `createContext` (7)
- `createContext` (5)
- `createContext` (4)
- `createContext` (3)
- `createContext` (1)

### `OrdinaryDefineOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (192us) | Total: 0.0% (192us) | Samples: 1

**Called by:**
- `OrdinaryDefineOwnMetadata` (1)

### `getRequestMethodStr`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` | Self: 0.0% (192us) | Total: 0.0% (192us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `run`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions-zone.js` | Self: 0.0% (191us) | Total: 0.0% (191us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:37` | Self: 0.0% (191us) | Total: 0.0% (191us) | Samples: 1

**Called by:**
- `forEach` (1)

### `reflectConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:218` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `getClassDependencies` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5182` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2496` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `Route` (1)

### `reply`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1178` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `async apply` (1)

### `set`
`node:diagnostics_channel` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `Channel` (1)

### `assignMetadata`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `#compileMiddlewareRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `Route` (1)

### `defineCustomPromisifyArgs`
`node:fs:304` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `node:fs` (1)

### `getProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:949` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `GetMetadataProvider` (1)

### `reflectSelfParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `reflectConstructorParams` (1)

### `use`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `use` (1)

### `uid`
`/home/user/bun-node/node_modules/uid/dist/index.js:12` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `assignControllerUniqueId` (1)

### `addRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1249` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `registerVerb` (1)

### `#writableOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1359` | Self: 0.0% (190us) | Total: 0.0% (190us) | Samples: 1

**Called by:**
- `BunRequest` (1)

### `NestApplication`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `async create` (1)

### `forRoutes`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `configure` (1)

### `id`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:27` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:45` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `_preferredType` (1)

### `addController`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:323` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `addController` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js:12` | Self: 0.0% (188us) | Total: 0.0% (188us) | Samples: 1

**Called by:**
- `next` (1)

### `reflectProperties`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:403` | Self: 0.0% (188us) | Total: 0.0% (188us) | Samples: 1

**Called by:**
- `async resolveProperties` (1)

### `copyMetadataToCallback`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` | Self: 0.0% (188us) | Total: 0.0% (188us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `inspectInstanceWrapper`
`/home/user/bun-node/node_modules/@nestjs/core/discovery/discoverable-meta-host-collection.js:53` | Self: 0.0% (188us) | Total: 0.0% (674us) | Samples: 1

**Called by:**
- `addController` (2)
- `addProvider` (1)

**Calls:**
- `getMetaKeyByInstanceWrapper` (1)
- `getMetaKeyByInstanceWrapper` (1)

### `OrdinaryGetOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (188us) | Total: 0.0% (188us) | Samples: 1

**Called by:**
- `OrdinaryGetOwnMetadata` (1)

### `exec`
`[native code]` | Self: 0.0% (188us) | Total: 0.0% (188us) | Samples: 1

**Called by:**
- `matchRoute` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:68` | Self: 0.0% (188us) | Total: 0.4% (20.8ms) | Samples: 1

**Called by:**
- `async (anonymous)` (52)

**Calls:**
- `async loadController` (52)

### `iterate`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js:209` | Self: 0.0% (188us) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `addScopedEnhancersMetadata` (1)
- `filterMiddleware` (1)
- `connectAllGateways` (1)

**Calls:**
- `toIterator` (1)
- `IteratorWithOperators` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js` | Self: 0.0% (188us) | Total: 0.0% (188us) | Samples: 1

**Called by:**
- `create` (1)

### `async registerRouteMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` | Self: 0.0% (188us) | Total: 0.0% (188us) | Samples: 1

**Called by:**
- `async registerRouteMiddleware` (1)

### `set`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (188us) | Total: 0.0% (188us) | Samples: 1

**Called by:**
- `getMatchedLayers` (1)

### `internal:streams/utils`
`internal:streams/utils:185` | Self: 0.0% (188us) | Total: 0.0% (188us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `parseQuery`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2998` | Self: 0.0% (187us) | Total: 0.0% (3.2ms) | Samples: 1

**Called by:**
- `BunRequest` (2)

**Calls:**
- `get query` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:199` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `map` (1)

### `OrdinaryHasOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `OrdinaryGetMetadata` (1)

### `async createInstances`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:39` | Self: 0.0% (187us) | Total: 0.0% (4.2ms) | Samples: 1

**Called by:**
- `async createInstances` (21)

**Calls:**
- `map` (20)

### `node:url`
`node:url:2` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js:23` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `map` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:104` | Self: 0.0% (187us) | Total: 0.3% (15.3ms) | Samples: 1

**Called by:**
- `forEach` (24)

**Calls:**
- `copyMetadataToCallback` (12)
- `copyMetadataToCallback` (10)
- `copyMetadataToCallback` (1)

### `waitForLayer`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `#waitLayer` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `map` (1)

### `isInContext`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:501` | Self: 0.0% (187us) | Total: 0.0% (1.7ms) | Samples: 1

**Called by:**
- `async instantiateClass` (7)

**Calls:**
- `isStatic` (6)

### `isStatic`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:250` | Self: 0.0% (187us) | Total: 0.0% (1.6ms) | Samples: 1

**Called by:**
- `isInContext` (6)

**Calls:**
- `isDependencyTreeStatic` (2)
- `isDependencyTreeStatic` (2)
- `isDependencyTreeStatic` (1)

### `registerParserMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:113` | Self: 0.0% (186us) | Total: 0.0% (186us) | Samples: 1

**Called by:**
- `async init` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:20` | Self: 0.0% (186us) | Total: 50.0% (2.45s) | Samples: 1

**Calls:**
- `(anonymous)` (4947)
- `static` (701)
- `serveNativeRequest` (253)
- `serveNativeRequest` (133)
- `bound serveNativeRequest` (61)
- `serveNativeRequest` (1)

### `ie`
`bun:wrap` | Self: 0.0% (186us) | Total: 0.0% (186us) | Samples: 1

**Called by:**
- `(module)` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:67` | Self: 0.0% (185us) | Total: 0.0% (185us) | Samples: 1

**Called by:**
- `setRoute` (1)

### `log`
`/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:54` | Self: 0.0% (185us) | Total: 0.0% (185us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `segmentKind`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:75` | Self: 0.0% (185us) | Total: 0.0% (185us) | Samples: 1

**Called by:**
- `map` (1)

### `node:util`
`node:util:254` | Self: 0.0% (185us) | Total: 0.0% (185us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `async loadInstance`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:44` | Self: 0.0% (185us) | Total: 0.0% (431us) | Samples: 1

**Called by:**
- `async loadInstance` (2)

**Calls:**
- `getInstanceByContextId` (1)

### `parseContentCodings`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:3670` | Self: 0.0% (184us) | Total: 0.0% (184us) | Samples: 1

**Called by:**
- `async handleBodyParsing` (1)

### `isFunction`
`/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js:38` | Self: 0.0% (184us) | Total: 0.0% (184us) | Samples: 1

**Called by:**
- `next` (1)

### `createHandleResponseFn`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` | Self: 0.0% (184us) | Total: 0.0% (184us) | Samples: 1

**Called by:**
- `getMetadata` (1)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:52` | Self: 0.0% (184us) | Total: 0.2% (13.6ms) | Samples: 1

**Called by:**
- `create` (50)

**Calls:**
- `get` (44)
- `get` (3)
- `get` (2)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:49` | Self: 0.0% (184us) | Total: 0.0% (184us) | Samples: 1

**Called by:**
- `_preferredType` (1)

### `serveNativeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:376` | Self: 0.0% (184us) | Total: 0.0% (184us) | Samples: 1

**Called by:**
- `bound serveNativeRequest` (1)

### `getRequestPathFromRequestURL`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4479` | Self: 0.0% (183us) | Total: 0.0% (183us) | Samples: 1

**Called by:**
- `getMatchedLayers` (1)

### `isString`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` | Self: 0.0% (183us) | Total: 0.0% (183us) | Samples: 1

**Called by:**
- `registerBodyParser` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (183us) | Total: 0.0% (183us) | Samples: 1

**Called by:**
- `#routeRequest` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:20` | Self: 0.0% (183us) | Total: 0.0% (634us) | Samples: 1

**Called by:**
- `setRoute` (3)

**Calls:**
- `(anonymous)` (2)

### `#watchLateRejection`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (182us) | Total: 0.0% (182us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/optional.decorator.js` | Self: 0.0% (182us) | Total: 0.0% (182us) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:183` | Self: 0.0% (181us) | Total: 0.0% (1.3ms) | Samples: 1

**Called by:**
- `forEach` (7)

**Calls:**
- `map` (6)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` | Self: 0.0% (181us) | Total: 0.0% (181us) | Samples: 1

**Called by:**
- `flushPending` (1)

### `OrdinaryMetadataKeys`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:621` | Self: 0.0% (181us) | Total: 0.0% (603us) | Samples: 1

**Called by:**
- `getMetadataKeys` (2)
- `OrdinaryMetadataKeys` (1)

**Calls:**
- `OrdinaryMetadataKeys` (1)
- `OrdinaryMetadataKeys` (1)

### `reflectResponseHeaders`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:96` | Self: 0.0% (181us) | Total: 0.0% (383us) | Samples: 1

**Called by:**
- `getMetadata` (2)

**Calls:**
- `getMetadata` (1)

### `GetOrCreateMetadataMap`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1036` | Self: 0.0% (180us) | Total: 0.0% (180us) | Samples: 1

**Called by:**
- `OrdinaryDefineOwnMetadata` (1)

### `getInstanceByContextId`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:53` | Self: 0.0% (179us) | Total: 0.0% (179us) | Samples: 1

**Called by:**
- `async instantiateClass` (1)

### `async registerRouterHooks`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` | Self: 0.0% (179us) | Total: 0.0% (179us) | Samples: 1

**Called by:**
- `async init` (1)

### `finish`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:685` | Self: 0.0% (179us) | Total: 0.8% (42.2ms) | Samples: 1

**Called by:**
- `(anonymous)` (124)
- `next` (7)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (131)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:88` | Self: 0.0% (178us) | Total: 0.0% (178us) | Samples: 1

**Called by:**
- `map` (1)

### `segmentKind`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` | Self: 0.0% (178us) | Total: 0.0% (178us) | Samples: 1

**Called by:**
- `map` (1)

### `async handleBodyParsing`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3423` | Self: 0.0% (178us) | Total: 0.0% (178us) | Samples: 1

### `#finishPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5313` | Self: 0.0% (177us) | Total: 0.0% (177us) | Samples: 1

### `async resolveProperties`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:353` | Self: 0.0% (175us) | Total: 0.0% (175us) | Samples: 1

**Called by:**
- `async resolveProperties` (1)

### `#build`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:191` | Self: 0.0% (171us) | Total: 0.0% (171us) | Samples: 1

**Called by:**
- `candidates` (1)

### `node:path`
`node:path:21` | Self: 0.0% (142us) | Total: 0.0% (142us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/utils/cli-colors.util.js:8` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `colorIfAllowed` (1)

### `register`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:29` | Self: 0.0% (0us) | Total: 0.0% (218us) | Samples: 0

**Called by:**
- `registerWsModule` (1)

**Calls:**
- `WebSocketsController` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:9` | Self: 0.0% (0us) | Total: 0.0% (611us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async instantiateClass`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:431` | Self: 0.0% (0us) | Total: 0.0% (198us) | Samples: 0

**Called by:**
- `async instantiateClass` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/throwIfEmpty.js:4` | Self: 0.0% (0us) | Total: 0.0% (545us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async callModuleInitHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:31` | Self: 0.0% (0us) | Total: 0.1% (5.1ms) | Samples: 0

**Called by:**
- `async callInitHook` (23)

**Calls:**
- `async callModuleInitHook` (13)
- `async callModuleInitHook` (6)
- `async callModuleInitHook` (2)
- `async callModuleInitHook` (1)
- `async callModuleInitHook` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:55` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Called by:**
- `map` (17)

**Calls:**
- `async (anonymous)` (17)

### `addScopedEnhancersMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:339` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `async scan` (2)

**Calls:**
- `iterate` (1)
- `iterate` (1)

### `async compile`
`/home/user/bun-node/node_modules/@nestjs/core/injector/compiler.js:16` | Self: 0.0% (0us) | Total: 0.0% (277us) | Samples: 0

**Calls:**
- `createForStatic` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:343` | Self: 0.0% (0us) | Total: 0.0% (203us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `defineProperty` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncAction.js:20` | Self: 0.0% (0us) | Total: 0.0% (3.1ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/reportUnhandledError.js:5` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:189` | Self: 0.0% (0us) | Total: 0.0% (711us) | Samples: 0

**Calls:**
- `bound dirname` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (589us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `bound dirname`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (711us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `dirname` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter-context.js:9` | Self: 0.0% (0us) | Total: 0.0% (2.7ms) | Samples: 0

**Called by:**
- `anonymous` (12)

**Calls:**
- `bound require` (12)

### `node:util`
`node:util:8` | Self: 0.0% (0us) | Total: 0.0% (204us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:800` | Self: 0.0% (0us) | Total: 0.0% (274us) | Samples: 0

**Called by:**
- `BunRouter` (1)

**Calls:**
- `RouteCandidateIndex` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/repl.js:11` | Self: 0.0% (0us) | Total: 0.0% (224us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/accepts/index.js:16` | Self: 0.0% (0us) | Total: 0.1% (7.9ms) | Samples: 0

**Calls:**
- `bound require` (39)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:137` | Self: 0.0% (0us) | Total: 0.2% (12.8ms) | Samples: 0

**Called by:**
- `forEach` (28)

**Calls:**
- `insertController` (28)

### `node:zlib`
`node:zlib:485` | Self: 0.0% (0us) | Total: 0.0% (219us) | Samples: 0

**Calls:**
- `createConvenienceMethod` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (232us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:26` | Self: 0.0% (0us) | Total: 0.0% (407us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:8` | Self: 0.0% (0us) | Total: 0.0% (428us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/file-stream/index.js:4` | Self: 0.0% (0us) | Total: 0.8% (43.4ms) | Samples: 0

**Called by:**
- `anonymous` (154)

**Calls:**
- `bound require` (154)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js:7` | Self: 0.0% (0us) | Total: 0.0% (609us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/multicast.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:130` | Self: 0.0% (0us) | Total: 0.0% (402us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:126` | Self: 0.0% (0us) | Total: 0.0% (717us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:66` | Self: 0.0% (0us) | Total: 0.0% (388us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:374` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `__decorate` (7)
- `__decorate` (1)

### `generateUuid`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:369` | Self: 0.0% (0us) | Total: 0.0% (521us) | Samples: 0

**Called by:**
- `InstanceWrapper` (2)

**Calls:**
- `get name` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-id-factory.js:6` | Self: 0.0% (0us) | Total: 0.0% (226us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:160` | Self: 0.0% (0us) | Total: 0.0% (607us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:84` | Self: 0.0% (0us) | Total: 0.0% (660us) | Samples: 0

**Called by:**
- `map` (3)

**Calls:**
- `splitPattern` (2)
- `splitPattern` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapScheduler.js:21` | Self: 0.0% (0us) | Total: 0.0% (424us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:80` | Self: 0.0% (0us) | Total: 0.0% (486us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `node:_http_server`
`node:_http_server:702` | Self: 0.0% (0us) | Total: 0.0% (213us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/animationFrame.js:6` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `AnimationFrameScheduler` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/index.js:12` | Self: 0.0% (0us) | Total: 0.3% (17.4ms) | Samples: 0

**Calls:**
- `bound require` (53)
- `__exportStar` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/exceptions/base-ws-exception-filter.js:7` | Self: 0.0% (0us) | Total: 0.0% (444us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async scanModulesForDependencies`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:106` | Self: 0.0% (0us) | Total: 0.0% (289us) | Samples: 0

**Called by:**
- `async scanModulesForDependencies` (1)

**Calls:**
- `async reflectImports` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/file/file-type.validator.js:4` | Self: 0.0% (0us) | Total: 0.0% (2.9ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:185` | Self: 0.0% (0us) | Total: 0.0% (208us) | Samples: 0

**Called by:**
- `forEach` (1)

**Calls:**
- `forEach` (1)

### `get`
`/home/user/bun-node/node_modules/@nestjs/common/index.js:17` | Self: 0.0% (0us) | Total: 0.0% (304us) | Samples: 0

**Called by:**
- `getInstanceByContextId` (1)

**Calls:**
- `get` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:704` | Self: 0.0% (0us) | Total: 0.6% (33.5ms) | Samples: 0

**Called by:**
- `Promise` (88)

**Calls:**
- `isStreamOpen` (87)
- `get isStreamOpen` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1011` | Self: 0.0% (0us) | Total: 0.0% (228us) | Samples: 0

**Called by:**
- `registerVerb` (1)

**Calls:**
- `extractWildcardNames` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/hooks/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (221us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async loadConfiguration`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:55` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `async loadConfiguration` (8)

**Calls:**
- `configure` (8)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delayWhen.js:6` | Self: 0.0% (0us) | Total: 0.0% (231us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/asap.js:5` | Self: 0.0% (0us) | Total: 0.0% (649us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:14` | Self: 0.0% (0us) | Total: 0.0% (415us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/discovery/discovery-module.js:15` | Self: 0.0% (0us) | Total: 0.0% (421us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `Module` (1)
- `Module` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/routes-mapper.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `registerBodyParser`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:837` | Self: 0.0% (0us) | Total: 0.0% (183us) | Samples: 0

**Called by:**
- `registerParserMiddleware` (1)

**Calls:**
- `isString` (1)

### `async bindHandler`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:134` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `async registerRouteMiddleware` (5)

**Calls:**
- `async bindHandler` (4)
- `async bindHandler` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/iterare/lib/flatten.js:3` | Self: 0.0% (0us) | Total: 0.0% (510us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:6` | Self: 0.0% (0us) | Total: 0.1% (6.8ms) | Samples: 0

**Called by:**
- `anonymous` (15)

**Calls:**
- `bound require` (15)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-types/index.js:16` | Self: 0.0% (0us) | Total: 0.0% (747us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/refCount.js:4` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `decorate`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:135` | Self: 0.0% (0us) | Total: 0.0% (201us) | Samples: 0

**Called by:**
- `__decorate` (1)

**Calls:**
- `ToPropertyKey` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:224` | Self: 0.0% (0us) | Total: 0.0% (800us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `makeSafe`
`internal:primordials:52` | Self: 0.0% (0us) | Total: 0.0% (191us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `copyProps` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/UnsubscriptionError.js:5` | Self: 0.0% (0us) | Total: 0.0% (213us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `createErrorClass` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:200` | Self: 0.0% (0us) | Total: 0.0% (515us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/request/request-providers.js:4` | Self: 0.0% (0us) | Total: 0.0% (241us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `internal:primordials`
`internal:primordials:88` | Self: 0.0% (0us) | Total: 0.0% (191us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `makeSafe` (1)

### `GetOrCreateMetadataMap`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1045` | Self: 0.0% (0us) | Total: 0.0% (423us) | Samples: 0

**Called by:**
- `OrdinaryDefineOwnMetadata` (2)

**Calls:**
- `setProvider` (2)

### `async setModule`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:97` | Self: 0.0% (0us) | Total: 0.3% (17.2ms) | Samples: 0

**Called by:**
- `async addModule` (3)

**Calls:**
- `async setModule` (2)
- `async setModule` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:84` | Self: 0.0% (0us) | Total: 0.0% (277us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `GetOrCreateMetadataRegistry` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/utils/filter-log-levels.util.js:5` | Self: 0.0% (0us) | Total: 0.0% (231us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:216` | Self: 0.0% (0us) | Total: 0.0% (557us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:43` | Self: 0.0% (0us) | Total: 0.0% (403us) | Samples: 0

**Called by:**
- `async (anonymous)` (2)

**Calls:**
- `setStatus` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/modules/index.js:10` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/adapters/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js:4` | Self: 0.0% (0us) | Total: 0.0% (266us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `internal:streams/pipeline`
`internal:streams/pipeline:2` | Self: 0.0% (0us) | Total: 0.1% (9.1ms) | Samples: 0

**Called by:**
- `anonymous` (42)

**Calls:**
- `anonymous` (42)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:16` | Self: 0.0% (0us) | Total: 0.0% (273us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/pipes/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (767us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:12` | Self: 0.0% (0us) | Total: 0.0% (932us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter-context.js:7` | Self: 0.0% (0us) | Total: 0.0% (221us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async callModuleInitHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:44` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Calls:**
- `from` (8)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/context/ws-context-creator.js:11` | Self: 0.0% (0us) | Total: 0.0% (840us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/lazy-module-loader/lazy-module-loader.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:17` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/publishLast.js:4` | Self: 0.0% (0us) | Total: 0.0% (736us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (579us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:7` | Self: 0.0% (0us) | Total: 0.0% (543us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:100` | Self: 0.0% (0us) | Total: 0.0% (426us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/container.js:38` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `forEach` (1)

**Calls:**
- `map` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:7` | Self: 0.0% (0us) | Total: 0.0% (597us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:30` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `createCallbackProxy` (8)

**Calls:**
- `map` (6)
- `exchangeKeysForValues` (2)

### `node:_http_client`
`node:_http_client:10` | Self: 0.0% (0us) | Total: 0.1% (5.3ms) | Samples: 0

**Called by:**
- `anonymous` (21)

**Calls:**
- `anonymous` (20)
- `channel` (1)

### `async resolveConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:130` | Self: 0.0% (0us) | Total: 0.0% (199us) | Samples: 0

**Called by:**
- `async resolveConstructorParams` (1)

**Calls:**
- `getFactoryProviderDependencies` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/supports-color/index.js:133` | Self: 0.0% (0us) | Total: 0.0% (472us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `supportsColor` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/bad-gateway.exception.js:5` | Self: 0.0% (0us) | Total: 0.0% (700us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `bound call`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (614us) | Samples: 0

**Called by:**
- `internal:util/inspect` (2)
- `(anonymous)` (1)

**Calls:**
- `filter` (2)
- `call` (1)

### `async registerRouter`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:117` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Called by:**
- `async init` (10)

**Calls:**
- `async registerRouter` (10)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:29` | Self: 0.0% (0us) | Total: 0.6% (30.6ms) | Samples: 0

**Called by:**
- `createCallbackProxy` (102)

**Calls:**
- `getMetadata` (50)
- `getMetadata` (10)
- `getMetadata` (9)
- `getMetadata` (8)
- `getMetadata` (6)
- `getMetadata` (6)
- `getMetadata` (3)
- `getMetadata` (2)
- `getMetadata` (2)
- `getMetadata` (2)
- `getMetadata` (1)
- `getMetadata` (1)
- `getMetadata` (1)
- `getMetadata` (1)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:35` | Self: 0.0% (0us) | Total: 0.0% (288us) | Samples: 0

**Called by:**
- `Mime` (1)

**Calls:**
- `get` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/async.js:4` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `#configuredQueryOpts`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1368` | Self: 0.0% (0us) | Total: 0.0% (207us) | Samples: 0

**Called by:**
- `parseQuery` (1)

**Calls:**
- `isObject` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/serializer/decorators/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (299us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `#compileMiddlewareRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:213` | Self: 0.0% (0us) | Total: 0.0% (199us) | Samples: 0

**Called by:**
- `Route` (1)

**Calls:**
- `replace` (1)

### `forRoutes`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js:53` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `configure` (1)

**Calls:**
- `removeOverlappedRoutes` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:22` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js:4` | Self: 0.0% (0us) | Total: 0.0% (4.7ms) | Samples: 0

**Called by:**
- `anonymous` (20)

**Calls:**
- `bound require` (20)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/repl-logger.js:8` | Self: 0.0% (0us) | Total: 0.0% (337us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `get` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/async.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:273` | Self: 0.0% (0us) | Total: 0.0% (264us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `set requestOpts` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:42` | Self: 0.0% (0us) | Total: 0.4% (21.7ms) | Samples: 0

**Calls:**
- `async createInstancesOfControllers` (57)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:65` | Self: 0.0% (0us) | Total: 2.6% (130.1ms) | Samples: 0

**Called by:**
- `forEach` (379)

**Calls:**
- `applyCallbackToRouter` (174)
- `applyCallbackToRouter` (148)
- `applyCallbackToRouter` (52)
- `applyCallbackToRouter` (3)
- `applyCallbackToRouter` (1)
- `applyCallbackToRouter` (1)

### `get inspect`
`node:util:481` | Self: 0.0% (0us) | Total: 0.3% (15.9ms) | Samples: 0

**Calls:**
- `lazyInspectModule` (28)

### `async resolveParam`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:134` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `map` (5)

**Calls:**
- `async (anonymous)` (3)
- `async (anonymous)` (1)
- `async (anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/index.js:5` | Self: 0.0% (0us) | Total: 0.4% (22.1ms) | Samples: 0

**Called by:**
- `anonymous` (78)

**Calls:**
- `bound require` (78)

### `async resolveMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:40` | Self: 0.0% (0us) | Total: 0.0% (2.2ms) | Samples: 0

**Called by:**
- `async register` (11)

**Calls:**
- `async resolveMiddleware` (10)
- `async resolveMiddleware` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:22` | Self: 0.0% (0us) | Total: 0.0% (543us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/connect.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:16` | Self: 0.0% (0us) | Total: 0.0% (614us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:20` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:13` | Self: 0.0% (0us) | Total: 0.0% (548us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`/home/user/bun-node/node_modules/mime/dist/src/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (4.1ms) | Samples: 0

**Calls:**
- `Mime` (6)
- `Mime` (1)
- `_freeze` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:103` | Self: 0.0% (0us) | Total: 0.0% (531us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/guards/guards-consumer.js:6` | Self: 0.0% (0us) | Total: 0.0% (823us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `async callModuleBootstrapHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js:43` | Self: 0.0% (0us) | Total: 0.0% (184us) | Samples: 0

**Called by:**
- `async callModuleBootstrapHook` (1)

**Calls:**
- `from` (1)

### `NestApplication`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:45` | Self: 0.0% (0us) | Total: 0.0% (244us) | Samples: 0

**Called by:**
- `async create` (1)

**Calls:**
- `MiddlewareModule` (1)

### `lazyInspectModule`
`node:util:17` | Self: 0.0% (0us) | Total: 0.3% (15.9ms) | Samples: 0

**Called by:**
- `get inspect` (28)

**Calls:**
- `anonymous` (28)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/routes-mapper.js:8` | Self: 0.0% (0us) | Total: 0.0% (615us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:8` | Self: 0.0% (0us) | Total: 0.1% (5.7ms) | Samples: 0

**Called by:**
- `anonymous` (13)

**Calls:**
- `bound require` (13)

### `filterMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/utils.js:43` | Self: 0.0% (0us) | Total: 0.0% (227us) | Samples: 0

**Called by:**
- `forRoutes` (1)

**Calls:**
- `iterate` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (805us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `__exportStar` (2)
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/UnsubscriptionError.js:4` | Self: 0.0% (0us) | Total: 0.0% (214us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `reflectParamInjectables`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:176` | Self: 0.0% (0us) | Total: 1.1% (58.7ms) | Samples: 0

**Called by:**
- `reflectDynamicMetadata` (44)

**Calls:**
- `forEach` (44)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:146` | Self: 0.0% (0us) | Total: 0.0% (469us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:25` | Self: 0.0% (0us) | Total: 0.0% (800us) | Samples: 0

**Calls:**
- `RequestMapping` (1)

### `reflectInjectables`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:162` | Self: 0.0% (0us) | Total: 0.5% (25.8ms) | Samples: 0

**Called by:**
- `reflectDynamicMetadata` (13)
- `reflectDynamicMetadata` (9)
- `reflectDynamicMetadata` (5)
- `reflectDynamicMetadata` (2)

**Calls:**
- `reduce` (29)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/elementAt.js:4` | Self: 0.0% (0us) | Total: 0.0% (411us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/controller.decorator.js:4` | Self: 0.0% (0us) | Total: 0.0% (291us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/skipWhile.js:4` | Self: 0.0% (0us) | Total: 0.0% (321us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async callModuleInitHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:42` | Self: 0.0% (0us) | Total: 0.0% (2.9ms) | Samples: 0

**Called by:**
- `async callModuleInitHook` (13)

**Calls:**
- `from` (13)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:39` | Self: 0.0% (0us) | Total: 0.0% (4.0ms) | Samples: 0

**Called by:**
- `map` (20)

**Calls:**
- `async (anonymous)` (19)
- `async (anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/takeUntil.js:5` | Self: 0.0% (0us) | Total: 0.0% (455us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `OrdinaryDefineOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:611` | Self: 0.0% (0us) | Total: 0.0% (4.6ms) | Samples: 0

**Called by:**
- `defineMetadata` (6)
- `decorator` (3)

**Calls:**
- `GetMetadataProvider` (5)
- `GetMetadataProvider` (4)

### `async registerMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:95` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `async registerMiddleware` (8)

**Calls:**
- `async registerAllConfigs` (8)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/repl.js:7` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:30` | Self: 0.0% (0us) | Total: 0.0% (222us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async registerHandler`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:186` | Self: 0.0% (0us) | Total: 0.0% (230us) | Samples: 0

**Calls:**
- `some` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:113` | Self: 0.0% (0us) | Total: 0.2% (13.5ms) | Samples: 0

**Calls:**
- `async createInstancesOfDependencies` (46)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:13` | Self: 0.0% (0us) | Total: 0.0% (267us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:286` | Self: 0.0% (0us) | Total: 0.0% (196us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:22` | Self: 0.0% (0us) | Total: 0.2% (11.4ms) | Samples: 0

**Called by:**
- `anonymous` (44)

**Calls:**
- `bound require` (44)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/serializer/index.js:4` | Self: 0.0% (0us) | Total: 2.1% (104.3ms) | Samples: 0

**Called by:**
- `anonymous` (373)

**Calls:**
- `bound require` (372)
- `__exportStar` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/middleware/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (223us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:32` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/index.js:9` | Self: 0.0% (0us) | Total: 0.0% (404us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `OrdinaryOwnMetadataKeys`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:649` | Self: 0.0% (0us) | Total: 0.0% (211us) | Samples: 0

**Called by:**
- `OrdinaryMetadataKeys` (1)

**Calls:**
- `GetMetadataProvider` (1)

### `BunRouter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:889` | Self: 0.0% (0us) | Total: 0.0% (518us) | Samples: 0

**Called by:**
- `BunHttpAdapter` (2)

**Calls:**
- `pick` (1)
- `(anonymous)` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:26` | Self: 0.0% (0us) | Total: 0.0% (186us) | Samples: 0

**Calls:**
- `ie` (1)

### `createCallbackProxy`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:187` | Self: 0.0% (0us) | Total: 0.9% (46.3ms) | Samples: 0

**Called by:**
- `applyCallbackToRouter` (158)

**Calls:**
- `create` (102)
- `create` (21)
- `create` (11)
- `create` (10)
- `create` (8)
- `create` (2)
- `create` (2)
- `create` (1)
- `create` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduleObservable.js:6` | Self: 0.0% (0us) | Total: 0.0% (417us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `bound serveNativeRequest`
`[native code]` | Self: 0.0% (0us) | Total: 0.5% (28.4ms) | Samples: 0

**Called by:**
- `(module)` (61)

**Calls:**
- `serveNativeRequest` (50)
- `serveNativeRequest` (10)
- `serveNativeRequest` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (436us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:164` | Self: 0.0% (0us) | Total: 0.0% (612us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `internal:fs/binding`
`internal:fs/binding:3` | Self: 0.0% (0us) | Total: 0.0% (2.7ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `@lazy` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/index.js:4` | Self: 0.0% (0us) | Total: 0.2% (10.6ms) | Samples: 0

**Called by:**
- `anonymous` (31)

**Calls:**
- `bound require` (30)
- `__exportStar` (1)

### `signatureToArray`
`/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:6` | Self: 0.0% (0us) | Total: 0.0% (270us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `put` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/inspector/uuid-factory.js:4` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:121` | Self: 0.0% (0us) | Total: 0.0% (291us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:10` | Self: 0.0% (0us) | Total: 0.0% (900us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/AsyncSubject.js:12` | Self: 0.0% (0us) | Total: 0.0% (313us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `extendStatics` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/opaque-key-factory/by-reference-module-opaque-key-factory.js:5` | Self: 0.0% (0us) | Total: 0.0% (2.2ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:17` | Self: 0.0% (0us) | Total: 0.0% (438us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (3.8ms) | Samples: 0

**Called by:**
- `anonymous` (18)

**Calls:**
- `bound require` (18)

### `getAllMethodNames`
`/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:76` | Self: 0.0% (0us) | Total: 0.0% (200us) | Samples: 0

**Called by:**
- `scanForPaths` (1)

**Calls:**
- `push` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:7` | Self: 0.0% (0us) | Total: 0.0% (905us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5119` | Self: 0.0% (0us) | Total: 0.0% (282us) | Samples: 0

**Called by:**
- `#routeRequest` (1)

**Calls:**
- `layerFinished` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:160` | Self: 0.0% (0us) | Total: 0.0% (407us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `async registerHandler`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:189` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Calls:**
- `forEach` (6)

### `makeSafe`
`internal:primordials:43` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `createSafeIterator` (1)

### `getMiddlewareCollection`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/container.js:14` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `insertConfig` (1)

**Calls:**
- `has` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-module.js:5` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:242` | Self: 0.0% (0us) | Total: 0.1% (9.3ms) | Samples: 0

**Called by:**
- `#compileRouteRegExp` (23)

**Calls:**
- `RegExp` (23)

### `node:_http_agent`
`node:_http_agent:290` | Self: 0.0% (0us) | Total: 0.0% (447us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `Agent` (1)
- `Agent` (1)

### `async registerModules`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:80` | Self: 0.0% (0us) | Total: 0.0% (4.6ms) | Samples: 0

**Called by:**
- `async init` (21)

**Calls:**
- `async registerModules` (13)
- `async registerModules` (8)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (267us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:19` | Self: 0.0% (0us) | Total: 0.0% (238us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `DateTimeFormat` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/queue.js:5` | Self: 0.0% (0us) | Total: 0.0% (652us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/request-mapping.decorator.js:5` | Self: 0.0% (0us) | Total: 0.0% (561us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-types/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (3.2ms) | Samples: 0

**Called by:**
- `anonymous` (16)

**Calls:**
- `bound require` (16)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:10` | Self: 0.0% (0us) | Total: 0.0% (440us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:16` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `async registerRouteMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:131` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `async registerRouteMiddleware` (4)

**Calls:**
- `async bindHandler` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/misdirected.exception.js:4` | Self: 0.0% (0us) | Total: 0.0% (251us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`/home/user/bun-node/node_modules/ip-regex/index.js:27` | Self: 0.0% (0us) | Total: 0.0% (261us) | Samples: 0

**Calls:**
- `RegExp` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:97` | Self: 0.0% (0us) | Total: 0.0% (661us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `extractRouterPath`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:52` | Self: 0.0% (0us) | Total: 0.0% (418us) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `getMetadata` (1)
- `getMetadata` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:19` | Self: 0.0% (0us) | Total: 0.2% (11.0ms) | Samples: 0

**Called by:**
- `anonymous` (46)

**Calls:**
- `optionalRequire` (46)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:125` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `filter` (1)

**Calls:**
- `test` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module.js:7` | Self: 0.0% (0us) | Total: 0.0% (443us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `next`
`/home/user/bun-node/node_modules/iterare/lib/filter.js:13` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `next` (12)
- `next` (1)

**Calls:**
- `(anonymous)` (4)
- `hasOnModuleInitHook` (3)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(unknown)` (1)
- `isFunction` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/supports-color/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (589us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:15` | Self: 0.0% (0us) | Total: 0.0% (454us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `createCallbackProxy`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:188` | Self: 0.0% (0us) | Total: 0.0% (3.0ms) | Samples: 0

**Called by:**
- `applyCallbackToRouter` (15)

**Calls:**
- `create` (10)
- `create` (3)
- `create` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/exceptions/ws-exceptions-handler.js:7` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:8` | Self: 0.0% (0us) | Total: 0.0% (823us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `set`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:13` | Self: 0.0% (0us) | Total: 0.0% (289us) | Samples: 0

**Called by:**
- `getMetadata` (1)

**Calls:**
- `set` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:138` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:13` | Self: 0.0% (0us) | Total: 0.0% (3.7ms) | Samples: 0

**Called by:**
- `anonymous` (15)

**Calls:**
- `bound require` (15)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/create-route-param-metadata.decorator.js:6` | Self: 0.0% (0us) | Total: 0.0% (245us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/file/parse-file.pipe.js:7` | Self: 0.0% (0us) | Total: 0.0% (451us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `registerBodyParser`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:840` | Self: 0.0% (0us) | Total: 0.0% (2.5ms) | Samples: 0

**Called by:**
- `registerParserMiddleware` (12)

**Calls:**
- `use` (12)

### `#build`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:203` | Self: 0.0% (0us) | Total: 0.0% (182us) | Samples: 0

**Called by:**
- `candidates` (1)

**Calls:**
- `push` (1)

### `async loadConfiguration`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:48` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `async (anonymous)` (9)

**Calls:**
- `async loadConfiguration` (8)
- `async loadConfiguration` (1)

### `node:_http_incoming`
`node:_http_incoming:15` | Self: 0.0% (0us) | Total: 0.0% (387us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (2)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:13` | Self: 0.0% (0us) | Total: 0.0% (2.5ms) | Samples: 0

**Calls:**
- `async makeTarget` (3)

### `AsyncScheduler`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js:24` | Self: 0.0% (0us) | Total: 0.0% (213us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `Scheduler` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:11` | Self: 0.0% (0us) | Total: 0.0% (227us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `get`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js:16` | Self: 0.0% (0us) | Total: 0.2% (12.4ms) | Samples: 0

**Called by:**
- `getMetadata` (44)

**Calls:**
- `getMetadataKey` (44)

### `applyCallbackToRouter`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:74` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `isDependencyTreeStatic` (1)

### `getMetaKeyByInstanceWrapper`
`/home/user/bun-node/node_modules/@nestjs/core/discovery/discoverable-meta-host-collection.js:80` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Called by:**
- `inspectInstanceWrapper` (1)

**Calls:**
- `get instance` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:23` | Self: 0.0% (0us) | Total: 0.0% (664us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:68` | Self: 0.0% (0us) | Total: 2.8% (138.6ms) | Samples: 0

**Called by:**
- `forEach` (415)

**Calls:**
- `explore` (381)
- `explore` (30)
- `explore` (4)

### `forRoutes`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js:52` | Self: 0.0% (0us) | Total: 0.0% (599us) | Samples: 0

**Called by:**
- `configure` (3)

**Calls:**
- `from` (2)
- `getRoutesFlatList` (1)

### `segmentKind`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:71` | Self: 0.0% (0us) | Total: 0.0% (173us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `test` (1)

### `next`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5084` | Self: 0.0% (0us) | Total: 1.1% (55.5ms) | Samples: 0

**Called by:**
- `async (anonymous)` (168)

**Calls:**
- `(anonymous)` (158)
- `finish` (7)
- `finish` (3)

### `createSafeIterator`
`internal:primordials:14` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `makeSafe` (1)

**Calls:**
- `freeze` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:132` | Self: 0.0% (0us) | Total: 0.0% (963us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `async scanModulesForDependencies`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:108` | Self: 0.0% (0us) | Total: 2.3% (113.0ms) | Samples: 0

**Calls:**
- `reflectControllers` (142)

### `Writable`
`internal:streams/writable:196` | Self: 0.0% (0us) | Total: 0.0% (294us) | Samples: 0

**Called by:**
- `WriteStream` (1)

**Calls:**
- `Stream` (1)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:70` | Self: 0.0% (0us) | Total: 0.0% (808us) | Samples: 0

**Called by:**
- `Route` (4)

**Calls:**
- `startInterval` (2)
- `startInterval` (1)
- `startInterval` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/audit.js:5` | Self: 0.0% (0us) | Total: 0.1% (8.1ms) | Samples: 0

**Called by:**
- `anonymous` (34)

**Calls:**
- `bound require` (34)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:25` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/combineLatest.js:5` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-types/index.js:40` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `anonymous` (14)

**Calls:**
- `populateMaps` (14)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (451us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/validation.pipe.js:6` | Self: 0.0% (0us) | Total: 0.0% (232us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `internal:streams/compose`
`internal:streams/compose:2` | Self: 0.0% (0us) | Total: 0.1% (9.7ms) | Samples: 0

**Called by:**
- `anonymous` (45)

**Calls:**
- `anonymous` (45)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delayWhen.js:4` | Self: 0.0% (0us) | Total: 0.0% (441us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/isObservable.js:5` | Self: 0.0% (0us) | Total: 0.0% (340us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:150` | Self: 0.0% (0us) | Total: 0.0% (599us) | Samples: 0

**Called by:**
- `async resolveParam` (3)

**Calls:**
- `async resolveSingleParam` (3)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:12` | Self: 0.0% (0us) | Total: 0.0% (314us) | Samples: 0

**Calls:**
- `Number` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/index.js:7` | Self: 0.0% (0us) | Total: 0.0% (669us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:177` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:98` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `getFactoryProviderDependencies`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:213` | Self: 0.0% (0us) | Total: 0.0% (199us) | Samples: 0

**Called by:**
- `async resolveConstructorParams` (1)

**Calls:**
- `map` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/QueueAction.js:49` | Self: 0.0% (0us) | Total: 0.0% (549us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `normalizeParseBodyOptions`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:2511` | Self: 0.0% (0us) | Total: 0.0% (194us) | Samples: 0

**Called by:**
- `BunRequest` (1)

**Calls:**
- `isObject` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/elementAt.js:6` | Self: 0.0% (0us) | Total: 0.0% (736us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/enums/request-method.enum.js:21` | Self: 0.0% (0us) | Total: 0.0% (288us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `__decorate`
`/home/user/bun-node/node_modules/tslib/tslib.js:106` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (7)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `decorate` (9)
- `decorate` (2)
- `decorate` (1)
- `decorate` (1)
- `decorate` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:19` | Self: 0.0% (0us) | Total: 0.5% (27.7ms) | Samples: 0

**Calls:**
- `bound require` (116)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (4.7ms) | Samples: 0

**Called by:**
- `anonymous` (18)

**Calls:**
- `bound require` (18)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (853us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1256` | Self: 0.0% (0us) | Total: 0.5% (25.8ms) | Samples: 0

**Called by:**
- `init` (80)

**Calls:**
- `#writableOptions` (79)
- `#writableOptions` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:204` | Self: 0.0% (0us) | Total: 0.0% (406us) | Samples: 0

**Called by:**
- `async initNest` (2)

**Calls:**
- `(anonymous)` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (660us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `async registerMiddlewareConfig`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:101` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `async registerMiddlewareConfig` (6)

**Calls:**
- `async registerRouteMiddleware` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/combineLatestAll.js:4` | Self: 0.0% (0us) | Total: 0.1% (8.1ms) | Samples: 0

**Called by:**
- `anonymous` (29)

**Calls:**
- `bound require` (29)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/topology-tree/topology-tree.js:4` | Self: 0.0% (0us) | Total: 0.0% (441us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `isResponseHandled`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:190` | Self: 0.0% (0us) | Total: 0.0% (213us) | Samples: 0

**Called by:**
- `getMetadata` (1)

**Calls:**
- `getMetadata` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/inspector/serialized-graph.js:7` | Self: 0.0% (0us) | Total: 0.0% (500us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:16` | Self: 0.0% (0us) | Total: 0.0% (208us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/throttleTime.js:4` | Self: 0.0% (0us) | Total: 0.0% (254us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `setName`
`node:fs:696` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `node:fs` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:62` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:31` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Calls:**
- `bound require` (6)

### `RouteInfoPathExtractor`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js:12` | Self: 0.0% (0us) | Total: 0.0% (209us) | Samples: 0

**Called by:**
- `async register` (1)

**Calls:**
- `addLeadingSlash` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/parse-date.pipe.js:39` | Self: 0.0% (0us) | Total: 0.0% (206us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `__decorate` (1)

### `async init`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:102` | Self: 0.0% (0us) | Total: 0.0% (2.9ms) | Samples: 0

**Calls:**
- `registerParserMiddleware` (13)
- `registerParserMiddleware` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:13` | Self: 0.0% (0us) | Total: 0.0% (272us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:158` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Calls:**
- `async resolveComponentHost` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/dom/animationFrames.js:6` | Self: 0.0% (0us) | Total: 0.0% (909us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/empty.js:5` | Self: 0.0% (0us) | Total: 0.0% (214us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `Observable` (1)

### `reflectDynamicMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:149` | Self: 0.0% (0us) | Total: 1.2% (59.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (47)

**Calls:**
- `reflectParamInjectables` (44)
- `reflectParamInjectables` (3)

### `WeakRefMap`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (223us) | Samples: 0

**Called by:**
- `node:diagnostics_channel` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/guards/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:63` | Self: 0.0% (0us) | Total: 0.0% (595us) | Samples: 0

**Called by:**
- `create` (2)

**Calls:**
- `isResponseHandled` (1)
- `isResponseHandled` (1)

### `fromContainer`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:38` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `async instantiateClass` (1)

**Calls:**
- `ExternalExceptionFilterContext` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:14` | Self: 0.0% (0us) | Total: 0.0% (432us) | Samples: 0

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:64` | Self: 0.0% (0us) | Total: 0.0% (401us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:91` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Calls:**
- `BunHttpAdapter` (3)
- `BunHttpAdapter` (2)
- `BunHttpAdapter` (1)
- `BunHttpAdapter` (1)
- `BunHttpAdapter` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions-zone.js:5` | Self: 0.0% (0us) | Total: 0.0% (612us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `DecorateConstructor`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:549` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `decorate` (9)

**Calls:**
- `(anonymous)` (5)
- `decorator` (4)

### `Cache`
`/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs:24` | Self: 0.0% (0us) | Total: 0.0% (431us) | Samples: 0

**Called by:**
- `Route` (2)

**Calls:**
- `(anonymous)` (2)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/compression.ts:216` | Self: 0.0% (0us) | Total: 0.0% (255us) | Samples: 0

**Calls:**
- `freeze` (1)

### `decorate`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:127` | Self: 0.0% (0us) | Total: 0.0% (264us) | Samples: 0

**Called by:**
- `__decorate` (1)

**Calls:**
- `IsArray` (1)

### `node:path`
`node:path:2` | Self: 0.0% (0us) | Total: 0.0% (398us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `@lazy` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exceptions-handler.js:4` | Self: 0.0% (0us) | Total: 0.0% (417us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:457` | Self: 0.0% (0us) | Total: 0.0% (736us) | Samples: 0

**Calls:**
- `parse` (1)
- `parse` (1)

### `log`
`/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:55` | Self: 0.0% (0us) | Total: 0.0% (235us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `concat` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/lazy-module-loader/lazy-module-loader.js:5` | Self: 0.0% (0us) | Total: 0.2% (10.2ms) | Samples: 0

**Called by:**
- `anonymous` (43)

**Calls:**
- `bound require` (43)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:127` | Self: 0.0% (0us) | Total: 0.0% (900us) | Samples: 0

**Called by:**
- `forEach` (3)

**Calls:**
- `addProvider` (1)
- `insertProvider` (1)
- `addProvider` (1)

### `registerExceptionHandler`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:89` | Self: 0.0% (0us) | Total: 0.0% (209us) | Samples: 0

**Called by:**
- `async registerRouterHooks` (1)

**Calls:**
- `createExceptionLayerProxy` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:23` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Calls:**
- `Controller` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:208` | Self: 0.0% (0us) | Total: 0.0% (327us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `addProvider`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:167` | Self: 0.0% (0us) | Total: 0.0% (270us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `inspectInstanceWrapper` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:75` | Self: 0.0% (0us) | Total: 0.0% (774us) | Samples: 0

**Calls:**
- `complete` (4)

### `removeOverlappedRoutes`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js:73` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `forRoutes` (1)

**Calls:**
- `map` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:115` | Self: 0.0% (0us) | Total: 0.0% (194us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delay.js:5` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:92` | Self: 0.0% (0us) | Total: 0.0% (891us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:10` | Self: 0.0% (0us) | Total: 0.0% (455us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:158` | Self: 0.0% (0us) | Total: 0.0% (418us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:23` | Self: 0.0% (0us) | Total: 0.0% (274us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `registerRouters`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:36` | Self: 0.0% (0us) | Total: 2.9% (144.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (442)

**Calls:**
- `forEach` (442)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:107` | Self: 0.0% (0us) | Total: 0.0% (478us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:266` | Self: 0.0% (0us) | Total: 0.0% (761us) | Samples: 0

**Called by:**
- `async makeTarget` (3)

**Calls:**
- `BunRouter` (2)
- `BunRouter` (1)

### `applyCallbackToRouter`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:77` | Self: 0.0% (0us) | Total: 1.0% (49.6ms) | Samples: 0

**Called by:**
- `(anonymous)` (174)

**Calls:**
- `createCallbackProxy` (158)
- `createCallbackProxy` (15)
- `createCallbackProxy` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:101` | Self: 0.0% (0us) | Total: 0.0% (891us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:13` | Self: 0.0% (0us) | Total: 0.0% (223us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/index.js:9` | Self: 0.0% (0us) | Total: 0.3% (17.9ms) | Samples: 0

**Calls:**
- `bound require` (26)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:9` | Self: 0.0% (0us) | Total: 0.0% (248us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:67` | Self: 0.0% (0us) | Total: 0.0% (424us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/interceptors/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:434` | Self: 0.0% (0us) | Total: 3.5% (171.9ms) | Samples: 0

**Called by:**
- `serveNativeRequest` (363)

**Calls:**
- `async #awaitPipeline` (363)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:40` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Called by:**
- `anonymous` (11)

**Calls:**
- `bound require` (11)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:184` | Self: 0.0% (0us) | Total: 0.0% (209us) | Samples: 0

**Called by:**
- `forEach` (1)

**Calls:**
- `flat` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/tslib/tslib.js:112` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `DecorateConstructor` (5)

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `getContextCreator`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:81` | Self: 0.0% (0us) | Total: 0.0% (194us) | Samples: 0

**Called by:**
- `register` (1)

**Calls:**
- `PipesContextCreator` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module-factory.js:4` | Self: 0.0% (0us) | Total: 0.0% (290us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/http/index.js:8` | Self: 0.0% (0us) | Total: 0.0% (222us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:192` | Self: 0.0% (0us) | Total: 0.0% (840us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/modules/index.js:8` | Self: 0.0% (0us) | Total: 0.0% (311us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `__exportStar` (1)
- `bound require` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:56` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Called by:**
- `async (anonymous)` (17)

**Calls:**
- `async loadProvider` (17)

### `async loadProvider`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:106` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Called by:**
- `async (anonymous)` (17)

**Calls:**
- `async loadProvider` (16)
- `async loadProvider` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:90` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Calls:**
- `importModule` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module-ref.js:10` | Self: 0.0% (0us) | Total: 0.0% (491us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `applyCallbackToRouter`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:82` | Self: 0.0% (0us) | Total: 1.1% (56.9ms) | Samples: 0

**Called by:**
- `(anonymous)` (148)

**Calls:**
- `forEach` (148)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:7` | Self: 0.0% (0us) | Total: 0.0% (483us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/joinAllInternals.js:8` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `async loadMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:95` | Self: 0.0% (0us) | Total: 0.0% (562us) | Samples: 0

**Called by:**
- `async loadMiddleware` (3)

**Calls:**
- `async loadInstance` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/tslib/tslib.js:54` | Self: 0.0% (0us) | Total: 0.0% (256us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/repeat.js:4` | Self: 0.0% (0us) | Total: 0.0% (207us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:234` | Self: 0.0% (0us) | Total: 0.0% (844us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `__decorate` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/multicast.js:6` | Self: 0.0% (0us) | Total: 0.0% (264us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/web-sockets-controller.js:4` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:18` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:8` | Self: 0.0% (0us) | Total: 0.0% (287us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `internal:util/inspect`
`internal:util/inspect:321` | Self: 0.0% (0us) | Total: 0.0% (248us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `setPrototypeDirect` (1)

### `use`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1617` | Self: 0.0% (0us) | Total: 0.0% (2.5ms) | Samples: 0

**Called by:**
- `registerBodyParser` (12)

**Calls:**
- `use` (11)
- `use` (1)

### `async callModuleBootstrapHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js:31` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `async callBootstrapHook` (8)

**Calls:**
- `async callModuleBootstrapHook` (5)
- `async callModuleBootstrapHook` (1)
- `async callModuleBootstrapHook` (1)
- `async callModuleBootstrapHook` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:24` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/toArray.js:4` | Self: 0.0% (0us) | Total: 0.0% (852us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (456us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/modules/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (228us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/help-repl-fn.js:6` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (640us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter-context.js:7` | Self: 0.0% (0us) | Total: 0.0% (612us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/silent-logger.js:4` | Self: 0.0% (0us) | Total: 0.0% (237us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:8` | Self: 0.0% (0us) | Total: 0.0% (438us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:149` | Self: 0.0% (0us) | Total: 0.0% (406us) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `run` (1)
- `run` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:30` | Self: 0.0% (0us) | Total: 0.1% (6.0ms) | Samples: 0

**Calls:**
- `bound require` (26)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:15` | Self: 0.0% (0us) | Total: 0.0% (444us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:7` | Self: 0.0% (0us) | Total: 0.0% (666us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module-ref.js:9` | Self: 0.0% (0us) | Total: 0.1% (6.9ms) | Samples: 0

**Called by:**
- `anonymous` (32)

**Calls:**
- `bound require` (32)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:8` | Self: 0.0% (0us) | Total: 0.0% (633us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:82` | Self: 0.0% (0us) | Total: 0.0% (211us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `GetOrCreateMetadataRegistry`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:998` | Self: 0.0% (0us) | Total: 0.0% (277us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `CreateMetadataRegistry` (1)

### `OrdinaryMetadataKeys`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:617` | Self: 0.0% (0us) | Total: 0.1% (8.4ms) | Samples: 0

**Called by:**
- `getMetadataKeys` (8)
- `OrdinaryMetadataKeys` (1)

**Calls:**
- `OrdinaryOwnMetadataKeys` (7)
- `OrdinaryOwnMetadataKeys` (1)
- `OrdinaryOwnMetadataKeys` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:84` | Self: 0.0% (0us) | Total: 0.0% (447us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1012` | Self: 0.0% (0us) | Total: 0.0% (200us) | Samples: 0

**Called by:**
- `registerVerb` (1)

**Calls:**
- `normalizeCatchAllPath` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:184` | Self: 0.0% (0us) | Total: 0.0% (507us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:10` | Self: 0.0% (0us) | Total: 0.0% (476us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `BunRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1305` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `init` (1)

**Calls:**
- `push` (1)

### `Module`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:33` | Self: 0.0% (0us) | Total: 0.0% (666us) | Samples: 0

**Called by:**
- `async setModule` (1)

**Calls:**
- `generateUuid` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js:5` | Self: 0.0% (0us) | Total: 0.0% (939us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `setStatus`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:49` | Self: 0.0% (0us) | Total: 0.0% (403us) | Samples: 0

**Called by:**
- `async (anonymous)` (2)

**Calls:**
- `status` (1)
- `status` (1)

### `WebSocketsController`
`/home/user/bun-node/node_modules/@nestjs/websockets/web-sockets-controller.js:22` | Self: 0.0% (0us) | Total: 0.0% (218us) | Samples: 0

**Called by:**
- `register` (1)

**Calls:**
- `GatewayMetadataExplorer` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:42` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:8` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:210` | Self: 0.0% (0us) | Total: 0.0% (322us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:13` | Self: 0.0% (0us) | Total: 0.1% (5.5ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/combineLatest.js:8` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:65` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `create` (8)

**Calls:**
- `createHandleResponseFn` (6)
- `createHandleResponseFn` (1)
- `createHandleResponseFn` (1)

### `async resolveMiddlewareInstance`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js:14` | Self: 0.0% (0us) | Total: 0.0% (985us) | Samples: 0

**Called by:**
- `async resolveInstance` (5)

**Calls:**
- `async resolveMiddlewareInstance` (4)
- `async resolveMiddlewareInstance` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:31` | Self: 0.0% (0us) | Total: 0.0% (583us) | Samples: 0

**Calls:**
- `ie` (2)
- `Param` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/file/index.js:8` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/combineAll.js:4` | Self: 0.0% (0us) | Total: 0.2% (11.2ms) | Samples: 0

**Called by:**
- `anonymous` (43)

**Calls:**
- `bound require` (43)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (790us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/windowToggle.js:15` | Self: 0.0% (0us) | Total: 0.0% (317us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:26` | Self: 0.0% (0us) | Total: 0.0% (288us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `isDependencyTreeStatic`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:183` | Self: 0.0% (0us) | Total: 0.0% (218us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `printIntrospectedAsRequestScoped` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exceptions-handler.js:7` | Self: 0.0% (0us) | Total: 0.0% (453us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/repl-context.js:8` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Called by:**
- `anonymous` (15)

**Calls:**
- `bound require` (15)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/utils/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (879us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:48` | Self: 0.0% (0us) | Total: 2.8% (138.3ms) | Samples: 0

**Calls:**
- `async (anonymous)` (333)
- `async (anonymous)` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/innerFrom.js:61` | Self: 0.0% (0us) | Total: 0.0% (244us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `BunWebSocketAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunWebSocketAdapter.ts:529` | Self: 0.0% (0us) | Total: 0.0% (282us) | Samples: 0

**Called by:**
- `BunNestWebsocketAdapter` (1)

**Calls:**
- `resolveAdapterOptions` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:36` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/window.js:4` | Self: 0.0% (0us) | Total: 0.0% (380us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:11` | Self: 0.0% (0us) | Total: 0.0% (191us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:11` | Self: 0.0% (0us) | Total: 0.0% (246us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:18` | Self: 0.0% (0us) | Total: 0.0% (2.5ms) | Samples: 0

**Called by:**
- `anonymous` (10)

**Calls:**
- `bound require` (10)

### `async initNest`
`/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:75` | Self: 0.0% (0us) | Total: 0.0% (192us) | Samples: 0

**Calls:**
- `get` (1)

### `node:util`
`node:util:2` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/index.js:23` | Self: 0.0% (0us) | Total: 0.0% (853us) | Samples: 0

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:170` | Self: 0.0% (0us) | Total: 0.0% (913us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/index.js:4` | Self: 0.0% (0us) | Total: 0.1% (5.8ms) | Samples: 0

**Called by:**
- `anonymous` (25)

**Calls:**
- `bound require` (25)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:13` | Self: 0.0% (0us) | Total: 0.0% (2.9ms) | Samples: 0

**Called by:**
- `anonymous` (11)

**Calls:**
- `bound require` (11)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/NotFoundError.js:5` | Self: 0.0% (0us) | Total: 0.0% (246us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `createErrorClass` (1)

### `NestApplication`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:46` | Self: 0.0% (0us) | Total: 0.0% (618us) | Samples: 0

**Called by:**
- `async create` (3)

**Calls:**
- `RoutesResolver` (2)
- `RoutesResolver` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/publishReplay.js:4` | Self: 0.0% (0us) | Total: 0.0% (856us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (854us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/file/index.js:4` | Self: 0.0% (0us) | Total: 0.1% (5.9ms) | Samples: 0

**Called by:**
- `anonymous` (10)

**Calls:**
- `bound require` (10)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:142` | Self: 0.0% (0us) | Total: 0.0% (197us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts:2995` | Self: 0.0% (0us) | Total: 0.5% (27.9ms) | Samples: 0

**Calls:**
- `setPrototypeDirectOrThrow` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module.js:26` | Self: 0.0% (0us) | Total: 0.0% (295us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `Module` (1)

### `OrdinaryGetMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:594` | Self: 0.0% (0us) | Total: 0.0% (698us) | Samples: 0

**Called by:**
- `getMetadata` (3)

**Calls:**
- `OrdinaryGetOwnMetadata` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:11` | Self: 0.0% (0us) | Total: 0.0% (799us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (3)
- `__exportStar` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/invalid-exception-filter.exception.js:5` | Self: 0.0% (0us) | Total: 0.0% (639us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:33` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `anonymous` (12)

**Calls:**
- `bound require` (12)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:17` | Self: 0.0% (0us) | Total: 0.0% (410us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `internal:streams/legacy`
`internal:streams/legacy:2` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `anonymous` (8)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:17` | Self: 0.0% (0us) | Total: 0.0% (781us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `decorate`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:136` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `ie` (3)
- `__decorate` (2)

**Calls:**
- `DecorateProperty` (5)

### `reflectDynamicMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:148` | Self: 0.0% (0us) | Total: 0.2% (13.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (33)

**Calls:**
- `reflectInjectables` (16)
- `reflectInjectables` (13)
- `reflectInjectables` (3)
- `reflectInjectables` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/inspector/uuid-factory.js:5` | Self: 0.0% (0us) | Total: 0.0% (412us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/index.js:15` | Self: 0.0% (0us) | Total: 0.8% (43.9ms) | Samples: 0

**Calls:**
- `bound require` (156)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:7` | Self: 0.0% (0us) | Total: 0.0% (597us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/guards/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (232us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:9` | Self: 0.0% (0us) | Total: 0.0% (623us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `setup`
`/home/user/bun-node/node_modules/debug/src/common.js:287` | Self: 0.0% (0us) | Total: 0.0% (204us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `enable` (1)

### `addController`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:191` | Self: 0.0% (0us) | Total: 0.0% (404us) | Samples: 0

**Called by:**
- `insertController` (2)

**Calls:**
- `inspectInstanceWrapper` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/animationFrame.js:4` | Self: 0.0% (0us) | Total: 0.0% (647us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscription.js:38` | Self: 0.0% (0us) | Total: 0.0% (228us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js:9` | Self: 0.0% (0us) | Total: 0.0% (215us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async addDynamicModules`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:121` | Self: 0.0% (0us) | Total: 0.0% (287us) | Samples: 0

**Called by:**
- `async addDynamicMetadata` (1)

**Calls:**
- `async addDynamicModules` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:233` | Self: 0.0% (0us) | Total: 0.0% (200us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `NestFactoryStatic` (1)

### `async registerRouteMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:113` | Self: 0.0% (0us) | Total: 0.0% (213us) | Samples: 0

**Called by:**
- `async registerRouteMiddleware` (1)

**Calls:**
- `get isTransient` (1)

### `flushPending`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4223` | Self: 0.0% (0us) | Total: 0.0% (2.3ms) | Samples: 0

**Called by:**
- `use` (11)

**Calls:**
- `setRoute` (10)
- `setRoute` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/of.js:4` | Self: 0.0% (0us) | Total: 0.0% (211us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:21` | Self: 0.0% (0us) | Total: 0.0% (228us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/guards/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (3.8ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/timer.js:7` | Self: 0.0% (0us) | Total: 0.0% (197us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `toIterator`
`/home/user/bun-node/node_modules/iterare/lib/utils.js:12` | Self: 0.0% (0us) | Total: 0.0% (227us) | Samples: 0

**Called by:**
- `iterate` (1)

**Calls:**
- `isIterator` (1)

### `NestApplication`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:26` | Self: 0.0% (0us) | Total: 0.0% (449us) | Samples: 0

**Called by:**
- `async create` (2)

**Calls:**
- `NestApplicationContext` (1)
- `NestApplicationContext` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:32` | Self: 0.0% (0us) | Total: 2.9% (144.9ms) | Samples: 0

**Called by:**
- `forEach` (442)

**Calls:**
- `registerRouters` (442)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js:6` | Self: 0.0% (0us) | Total: 0.0% (424us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/index.js:8` | Self: 0.0% (0us) | Total: 0.0% (422us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:13` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:12` | Self: 0.0% (0us) | Total: 0.0% (632us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:174` | Self: 0.0% (0us) | Total: 0.0% (397us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `__decorate` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:14` | Self: 0.0% (0us) | Total: 0.0% (999us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:56` | Self: 0.0% (0us) | Total: 0.0% (420us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:186` | Self: 0.0% (0us) | Total: 0.0% (203us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:105` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `map` (5)

**Calls:**
- `createConcreteContext` (3)
- `createConcreteContext` (2)

### `registerParserMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:115` | Self: 0.0% (0us) | Total: 0.0% (2.7ms) | Samples: 0

**Called by:**
- `async init` (13)

**Calls:**
- `registerParserMiddleware` (13)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:29` | Self: 0.0% (0us) | Total: 0.0% (221us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `forEach`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js:157` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `connectAllGateways` (4)

**Calls:**
- `connectGatewayToServer` (2)
- `connectGatewayToServer` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/modules/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (250us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js:6` | Self: 0.0% (0us) | Total: 0.0% (606us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `internal:streams/readable`
`internal:streams/readable:2` | Self: 0.0% (0us) | Total: 0.0% (206us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `parse`
`/home/user/bun-node/node_modules/picoquery/lib/parse.js:42` | Self: 0.0% (0us) | Total: 0.0% (281us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `Empty` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:12` | Self: 0.0% (0us) | Total: 0.0% (419us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async initNest`
`/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:76` | Self: 0.0% (0us) | Total: 0.0% (406us) | Samples: 0

**Calls:**
- `(anonymous)` (2)

### `async createInstancesOfDependencies`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:22` | Self: 0.0% (0us) | Total: 0.0% (4.6ms) | Samples: 0

**Called by:**
- `async createInstancesOfDependencies` (23)

**Calls:**
- `async createInstances` (22)
- `async createInstances` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/web-sockets-controller.js:9` | Self: 0.0% (0us) | Total: 0.0% (207us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:9` | Self: 0.0% (0us) | Total: 0.0% (339us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:22` | Self: 0.0% (0us) | Total: 0.0% (224us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async callModuleBootstrapHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js:42` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `async callModuleBootstrapHook` (5)

**Calls:**
- `from` (5)

### `async resolveInstances`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `async (anonymous)` (6)

**Calls:**
- `async resolveInstances` (5)
- `async resolveInstances` (1)

### `async loadProvider`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:112` | Self: 0.0% (0us) | Total: 0.0% (208us) | Samples: 0

**Calls:**
- `async loadEnhancersPerContext` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:26` | Self: 0.0% (0us) | Total: 0.6% (31.6ms) | Samples: 0

**Calls:**
- `bound require` (114)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:6` | Self: 0.0% (0us) | Total: 0.2% (10.4ms) | Samples: 0

**Called by:**
- `anonymous` (41)

**Calls:**
- `bound require` (41)

### `addController`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:189` | Self: 0.0% (0us) | Total: 0.2% (12.4ms) | Samples: 0

**Called by:**
- `insertController` (26)

**Calls:**
- `addController` (15)
- `addController` (5)
- `addController` (3)
- `addController` (2)
- `addController` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delayWhen.js:7` | Self: 0.0% (0us) | Total: 0.0% (290us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `validateModuleKeys`
`/home/user/bun-node/node_modules/@nestjs/common/utils/validate-module-keys.util.js:21` | Self: 0.0% (0us) | Total: 0.0% (522us) | Samples: 0

**Called by:**
- `Module` (2)

**Calls:**
- `forEach` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/elementAt.js:5` | Self: 0.0% (0us) | Total: 0.0% (232us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/audit.js:4` | Self: 0.0% (0us) | Total: 0.0% (843us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `async scanModulesForDependencies`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:107` | Self: 0.0% (0us) | Total: 0.0% (900us) | Samples: 0

**Calls:**
- `reflectProviders` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:11` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async setModule`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:98` | Self: 0.0% (0us) | Total: 0.3% (16.9ms) | Samples: 0

**Called by:**
- `async setModule` (2)

**Calls:**
- `Module` (1)
- `Module` (1)

### `createDebug`
`/home/user/bun-node/node_modules/debug/src/common.js:117` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `(module)` (7)

**Calls:**
- `useColors` (6)
- `useColors` (1)

### `internal:primordials`
`internal:primordials:15` | Self: 0.0% (0us) | Total: 0.0% (187us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bind` (1)

### `OrdinaryHasOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:587` | Self: 0.0% (0us) | Total: 0.0% (2.3ms) | Samples: 0

**Called by:**
- `OrdinaryGetMetadata` (9)

**Calls:**
- `OrdinaryHasOwnMetadata` (5)
- `OrdinaryHasOwnMetadata` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/concatAll.js:4` | Self: 0.0% (0us) | Total: 0.0% (226us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:12` | Self: 0.0% (0us) | Total: 0.1% (5.1ms) | Samples: 0

**Called by:**
- `anonymous` (20)

**Calls:**
- `bound require` (20)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:64` | Self: 0.0% (0us) | Total: 0.0% (253us) | Samples: 0

**Called by:**
- `create` (1)

**Calls:**
- `getMetadata` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1414` | Self: 0.0% (0us) | Total: 0.1% (5.7ms) | Samples: 0

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/QueueAction.js:21` | Self: 0.0% (0us) | Total: 0.0% (549us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:113` | Self: 0.0% (0us) | Total: 0.0% (203us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/web-sockets-controller.js:10` | Self: 0.0% (0us) | Total: 0.0% (687us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/context/ws-context-creator.js:12` | Self: 0.0% (0us) | Total: 0.0% (241us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:12` | Self: 0.0% (0us) | Total: 0.0% (201us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module-ref.js:7` | Self: 0.0% (0us) | Total: 0.0% (834us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`/home/user/bun-node/node_modules/ip-regex/index.js:22` | Self: 0.0% (0us) | Total: 0.0% (377us) | Samples: 0

**Calls:**
- `replace` (1)

### `async resolveMiddlewareInstance`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js:15` | Self: 0.0% (0us) | Total: 0.0% (772us) | Samples: 0

**Called by:**
- `async resolveMiddlewareInstance` (4)

**Calls:**
- `async loadMiddleware` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:14` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `addProvider`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:164` | Self: 0.0% (0us) | Total: 0.0% (342us) | Samples: 0

**Called by:**
- `addProvider` (1)

**Calls:**
- `isTransientProvider` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:10` | Self: 0.0% (0us) | Total: 0.0% (276us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/repl.js:10` | Self: 0.0% (0us) | Total: 0.0% (672us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `internal:stream`
`internal:stream:2` | Self: 0.0% (0us) | Total: 0.2% (12.6ms) | Samples: 0

**Called by:**
- `anonymous` (57)

**Calls:**
- `anonymous` (57)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1015` | Self: 0.0% (0us) | Total: 0.0% (194us) | Samples: 0

**Called by:**
- `useMethod` (1)

**Calls:**
- `extractWildcardNames` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:11` | Self: 0.0% (0us) | Total: 0.0% (904us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:8` | Self: 0.0% (0us) | Total: 0.0% (4.4ms) | Samples: 0

**Called by:**
- `anonymous` (19)

**Calls:**
- `bound require` (19)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/single.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:14` | Self: 0.0% (0us) | Total: 0.0% (271us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async bindHandler`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:141` | Self: 0.0% (0us) | Total: 0.0% (870us) | Samples: 0

**Called by:**
- `async bindHandler` (4)

**Calls:**
- `async createProxy` (3)
- `async createProxy` (1)

### `BunNestWebsocketAdapter`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (554us) | Samples: 0

**Called by:**
- `BunHttpAdapter` (2)

**Calls:**
- `BunWebSocketAdapter` (1)
- `BunWebSocketAdapter` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/startWith.js:5` | Self: 0.0% (0us) | Total: 0.0% (566us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/take.js:4` | Self: 0.0% (0us) | Total: 0.0% (430us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async loadController`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:100` | Self: 0.0% (0us) | Total: 0.0% (994us) | Samples: 0

**Calls:**
- `async loadEnhancersPerContext` (5)

### `extractWildcardNames`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:247` | Self: 0.0% (0us) | Total: 0.0% (194us) | Samples: 0

**Called by:**
- `setRoute` (1)

**Calls:**
- `map` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/inspector/graph-inspector.js:6` | Self: 0.0% (0us) | Total: 0.0% (501us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:57` | Self: 0.0% (0us) | Total: 0.3% (17.3ms) | Samples: 0

**Called by:**
- `setRoute` (54)

**Calls:**
- `#compileRouteRegExp` (49)
- `#compileRouteRegExp` (2)
- `#compileRouteRegExp` (2)
- `#compileRouteRegExp` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/serializer/class-serializer.interceptor.js:5` | Self: 0.0% (0us) | Total: 2.0% (102.5ms) | Samples: 0

**Called by:**
- `anonymous` (366)

**Calls:**
- `bound require` (366)

### `internal:primordials`
`internal:primordials:83` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `makeSafe` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/modules-container.js:4` | Self: 0.0% (0us) | Total: 0.4% (24.0ms) | Samples: 0

**Called by:**
- `anonymous` (100)

**Calls:**
- `bound require` (100)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:19` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (10)

**Calls:**
- `bound require` (10)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/exception-filters.decorator.js:7` | Self: 0.0% (0us) | Total: 0.0% (520us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/file-stream/streamable-file.js:5` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `anonymous` (10)

**Calls:**
- `bound require` (10)

### `#canSkipHeaders`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts:571` | Self: 0.0% (0us) | Total: 0.4% (23.5ms) | Samples: 0

**Called by:**
- `#respondWithText` (42)

**Calls:**
- `method` (41)
- `get method` (1)

### `internal:streams/duplex`
`internal:streams/duplex:42` | Self: 0.0% (0us) | Total: 0.0% (197us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:194` | Self: 0.0% (0us) | Total: 0.0% (371us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `node:crypto`
`node:crypto:190` | Self: 0.0% (0us) | Total: 0.0% (624us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `deprecate` (1)

### `node:fs/promises`
`node:fs/promises:2` | Self: 0.0% (0us) | Total: 0.0% (2.7ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:10` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `Mime`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:13` | Self: 0.0% (0us) | Total: 0.0% (3.5ms) | Samples: 0

**Called by:**
- `(module)` (6)

**Calls:**
- `define` (3)
- `define` (1)
- `define` (1)
- `define` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:98` | Self: 0.0% (0us) | Total: 0.0% (432us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/inspector/serialized-graph.js:12` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `node:zlib`
`node:zlib:449` | Self: 0.0% (0us) | Total: 0.0% (198us) | Samples: 0

**Calls:**
- `map` (1)

### `addProvider`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:165` | Self: 0.0% (0us) | Total: 0.0% (342us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `addProvider` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/VirtualTimeScheduler.js:12` | Self: 0.0% (0us) | Total: 0.0% (266us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `extendStatics` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:15` | Self: 0.0% (0us) | Total: 0.2% (11.0ms) | Samples: 0

**Called by:**
- `anonymous` (29)

**Calls:**
- `bound require` (29)

### `populateMaps`
`/home/user/bun-node/node_modules/mime-types/index.js:158` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (14)

**Calls:**
- `forEach` (13)
- `keys` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:24` | Self: 0.0% (0us) | Total: 0.0% (627us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `assignControllerUniqueId`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:334` | Self: 0.0% (0us) | Total: 0.0% (453us) | Samples: 0

**Called by:**
- `addController` (2)

**Calls:**
- `defineProperty` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:8` | Self: 0.0% (0us) | Total: 0.0% (288us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:95` | Self: 0.0% (0us) | Total: 0.0% (406us) | Samples: 0

**Called by:**
- `forEach` (2)

**Calls:**
- `get id` (1)
- `id` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/services/reflector.service.js:4` | Self: 0.0% (0us) | Total: 0.0% (207us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:3236` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `forEach` (5)

**Calls:**
- `useMethod` (4)
- `useMethod` (1)

### `applyProperties`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:415` | Self: 0.0% (0us) | Total: 0.0% (897us) | Samples: 0

**Called by:**
- `async (anonymous)` (3)

**Calls:**
- `filter` (2)
- `filter` (1)

### `reflectProviders`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:126` | Self: 0.0% (0us) | Total: 0.0% (900us) | Samples: 0

**Called by:**
- `async scanModulesForDependencies` (3)

**Calls:**
- `forEach` (3)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:216` | Self: 0.0% (0us) | Total: 0.1% (8.4ms) | Samples: 0

**Called by:**
- `getMatchedLayers` (18)

**Calls:**
- `#build` (14)
- `#build` (1)
- `#build` (1)
- `#build` (1)
- `#build` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:214` | Self: 0.0% (0us) | Total: 0.0% (645us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:85` | Self: 0.0% (0us) | Total: 0.0% (581us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async resolveMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:46` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `async resolveMiddleware` (10)

**Calls:**
- `map` (10)

### `node:fs`
`node:fs:706` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Calls:**
- `setName` (1)

### `createPrototypes`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:32` | Self: 0.0% (0us) | Total: 0.1% (8.8ms) | Samples: 0

**Called by:**
- `async createInstancesOfDependencies` (23)

**Calls:**
- `forEach` (23)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:156` | Self: 0.0% (0us) | Total: 0.0% (620us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:114` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Calls:**
- `applyApplicationProviders` (1)

### `addCoreProviders`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:98` | Self: 0.0% (0us) | Total: 0.3% (16.3ms) | Samples: 0

**Called by:**
- `Module` (1)

**Calls:**
- `addModuleRef` (1)

### `explore`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:49` | Self: 0.0% (0us) | Total: 2.6% (130.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (381)

**Calls:**
- `applyPathsToRouterProxy` (379)
- `applyPathsToRouterProxy` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (564us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `internal:http`
`internal:http:13` | Self: 0.0% (0us) | Total: 0.0% (211us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (272us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:20` | Self: 0.0% (0us) | Total: 0.2% (12.0ms) | Samples: 0

**Called by:**
- `anonymous` (39)

**Calls:**
- `DateTimeFormat` (39)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/index.js:41` | Self: 0.0% (0us) | Total: 0.0% (2.6ms) | Samples: 0

**Calls:**
- `bound require` (12)

### `getRoutesFlatList`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js:64` | Self: 0.0% (0us) | Total: 0.0% (193us) | Samples: 0

**Called by:**
- `forRoutes` (1)

**Calls:**
- `map` (1)

### `reflectConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:221` | Self: 0.0% (0us) | Total: 0.0% (190us) | Samples: 0

**Called by:**
- `getClassDependencies` (1)

**Calls:**
- `reflectSelfParams` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/index.js:20` | Self: 0.0% (0us) | Total: 0.4% (19.6ms) | Samples: 0

**Calls:**
- `bound require` (49)
- `__exportStar` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:17` | Self: 0.0% (0us) | Total: 0.0% (266us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:16` | Self: 0.0% (0us) | Total: 0.2% (13.6ms) | Samples: 0

**Calls:**
- `bound require` (66)

### `Writable`
`internal:streams/writable:181` | Self: 0.0% (0us) | Total: 0.0% (254us) | Samples: 0

**Called by:**
- `WriteStream` (1)

**Calls:**
- `WritableState` (1)

### `next`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (211us) | Samples: 0

**Called by:**
- `next` (1)

**Calls:**
- `typedArrayViewIsTypedArrayView` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (238us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/defer.js:5` | Self: 0.0% (0us) | Total: 0.0% (234us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `getAllMethodNames`
`/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:59` | Self: 0.0% (0us) | Total: 0.0% (290us) | Samples: 0

**Called by:**
- `reflectInjectables` (1)

**Calls:**
- `Map` (1)

### `GetMetadataProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1163` | Self: 0.0% (0us) | Total: 0.0% (3.9ms) | Samples: 0

**Called by:**
- `OrdinaryDefineOwnMetadata` (5)

**Calls:**
- `setProvider` (2)
- `setProvider` (1)
- `setProvider` (1)
- `setProvider` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:154` | Self: 0.0% (0us) | Total: 0.0% (402us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/repl.js:8` | Self: 0.0% (0us) | Total: 0.0% (209us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/parse-enum.pipe.js:6` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/exhaust.js:4` | Self: 0.0% (0us) | Total: 0.0% (823us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `decorator`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:193` | Self: 0.0% (0us) | Total: 0.0% (196us) | Samples: 0

**Called by:**
- `DecorateProperty` (1)

**Calls:**
- `IsPropertyKey` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:60` | Self: 0.0% (0us) | Total: 0.0% (280us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `insertMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/container.js:29` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `InstanceWrapper` (1)

### `BunWebSocket`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts:481` | Self: 0.0% (0us) | Total: 0.0% (272us) | Samples: 0

**Called by:**
- `BunWebSocketAdapter` (1)

**Calls:**
- `(anonymous)` (1)

### `AsapScheduler`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapScheduler.js:23` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `AsyncScheduler` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:8` | Self: 0.0% (0us) | Total: 0.0% (708us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `map`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js:34` | Self: 0.0% (0us) | Total: 0.0% (193us) | Samples: 0

**Called by:**
- `getRoutesFlatList` (1)

**Calls:**
- `MapIterator` (1)

### `createPrototypesOfControllers`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:62` | Self: 0.0% (0us) | Total: 0.1% (8.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (23)

**Calls:**
- `forEach` (23)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/ReplaySubject.js:72` | Self: 0.0% (0us) | Total: 0.0% (554us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/object-hash/index.js:57` | Self: 0.0% (0us) | Total: 0.0% (636us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `getHashes` (1)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:197` | Self: 0.0% (0us) | Total: 0.0% (244us) | Samples: 0

**Called by:**
- `#compileRouteRegExp` (1)

**Calls:**
- `push` (1)

### `reflectControllers`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:136` | Self: 0.0% (0us) | Total: 2.3% (113.0ms) | Samples: 0

**Called by:**
- `async scanModulesForDependencies` (142)

**Calls:**
- `forEach` (142)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:164` | Self: 0.0% (0us) | Total: 0.0% (208us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js:6` | Self: 0.0% (0us) | Total: 0.0% (504us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `extractRouterPath`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:59` | Self: 0.0% (0us) | Total: 0.0% (388us) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `addLeadingSlash` (2)

### `addScopedEnhancersMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:341` | Self: 0.0% (0us) | Total: 0.0% (200us) | Samples: 0

**Called by:**
- `async scan` (1)

**Calls:**
- `forEach` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/pipe.js:4` | Self: 0.0% (0us) | Total: 0.0% (361us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:128` | Self: 0.0% (0us) | Total: 0.0% (411us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `explore`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:48` | Self: 0.0% (0us) | Total: 0.1% (7.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (30)

**Calls:**
- `reduce` (20)
- `scanForPaths` (10)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:65` | Self: 0.0% (0us) | Total: 0.0% (204us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `GetMetadataProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1158` | Self: 0.0% (0us) | Total: 0.2% (10.1ms) | Samples: 0

**Called by:**
- `OrdinaryHasOwnMetadata` (22)
- `OrdinaryDefineOwnMetadata` (4)
- `OrdinaryOwnMetadataKeys` (1)

**Calls:**
- `getProvider` (11)
- `getProvider` (9)
- `getProvider` (3)
- `getProvider` (3)
- `getProvider` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/controller.decorator.js:5` | Self: 0.0% (0us) | Total: 0.0% (570us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:43` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `async loadMiddlewareConfiguration` (9)

**Calls:**
- `async loadConfiguration` (9)

### `async registerMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:324` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Called by:**
- `async registerMiddleware` (10)

**Calls:**
- `async registerMiddleware` (9)
- `async registerMiddleware` (1)

### `node:_http_agent`
`node:_http_agent:2` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `anonymous` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:29` | Self: 0.0% (0us) | Total: 0.0% (194us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `defineProperty` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/asap.js:6` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `AsapScheduler` (1)

### `OrdinaryDefineOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1074` | Self: 0.0% (0us) | Total: 0.0% (603us) | Samples: 0

**Called by:**
- `OrdinaryDefineOwnMetadata` (3)

**Calls:**
- `GetOrCreateMetadataMap` (2)
- `GetOrCreateMetadataMap` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/single.js:6` | Self: 0.0% (0us) | Total: 0.0% (626us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:72` | Self: 0.0% (0us) | Total: 0.2% (10.7ms) | Samples: 0

**Calls:**
- `async instantiateClass` (25)
- `async instantiateClass` (1)
- `get isTransient` (1)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:83` | Self: 0.0% (0us) | Total: 0.0% (709us) | Samples: 0

**Called by:**
- `create` (3)

**Calls:**
- `set` (1)
- `set` (1)
- `set` (1)

### `run`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions-zone.js:10` | Self: 0.0% (0us) | Total: 0.0% (215us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `async createInstances`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:38` | Self: 0.0% (0us) | Total: 0.0% (4.4ms) | Samples: 0

**Called by:**
- `async createInstancesOfDependencies` (22)

**Calls:**
- `async createInstances` (21)
- `async createInstances` (1)

### `exploreMethodMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:27` | Self: 0.0% (0us) | Total: 0.0% (647us) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `getMetadata` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscription.js:37` | Self: 0.0% (0us) | Total: 0.0% (705us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `getEffectiveResolutionContext`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:557` | Self: 0.0% (0us) | Total: 0.0% (286us) | Samples: 0

**Called by:**
- `async (anonymous)` (1)

**Calls:**
- `getEffectiveInquirer` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:121` | Self: 0.0% (0us) | Total: 0.0% (2.6ms) | Samples: 0

**Called by:**
- `forEach` (13)

**Calls:**
- `create` (3)
- `create` (3)
- `map` (2)
- `create` (2)
- `create` (1)
- `cloneObject` (1)
- `create` (1)

### `internal:errors`
`internal:errors:2` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `anonymous` (9)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:416` | Self: 0.0% (0us) | Total: 0.6% (30.5ms) | Samples: 0

**Called by:**
- `serveNativeRequest` (70)

**Calls:**
- `method` (69)
- `get method` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:204` | Self: 0.0% (0us) | Total: 0.0% (533us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/middleware/index.js:7` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/expand.js:4` | Self: 0.0% (0us) | Total: 0.0% (231us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `internal:streams/operators`
`internal:streams/operators:2` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `anonymous` (8)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:136` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:71` | Self: 0.0% (0us) | Total: 0.0% (383us) | Samples: 0

**Called by:**
- `create` (2)

**Calls:**
- `reflectResponseHeaders` (2)

### `async register`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:26` | Self: 0.0% (0us) | Total: 0.0% (2.6ms) | Samples: 0

**Called by:**
- `async registerModules` (13)

**Calls:**
- `async register` (11)
- `async register` (1)
- `async register` (1)

### `async createInstancesOfProviders`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:55` | Self: 0.0% (0us) | Total: 0.0% (3.8ms) | Samples: 0

**Called by:**
- `async createInstancesOfProviders` (19)

**Calls:**
- `map` (18)
- `all` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:90` | Self: 0.0% (0us) | Total: 0.8% (42.5ms) | Samples: 0

**Called by:**
- `forEach` (118)

**Calls:**
- `forEach` (118)

### `addModuleRef`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:108` | Self: 0.0% (0us) | Total: 0.3% (16.3ms) | Samples: 0

**Called by:**
- `addCoreProviders` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:18` | Self: 0.0% (0us) | Total: 0.1% (5.0ms) | Samples: 0

**Called by:**
- `anonymous` (19)

**Calls:**
- `bound require` (19)

### `async registerHandler`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:170` | Self: 0.0% (0us) | Total: 0.0% (644us) | Samples: 0

**Called by:**
- `async registerHandler` (3)

**Calls:**
- `extractNonWildcardPathsFrom` (1)
- `extractPathsFrom` (1)
- `extractPathsFrom` (1)

### `async registerAllConfigs`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:73` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `async registerMiddleware` (8)

**Calls:**
- `async (anonymous)` (7)
- `async (anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (591us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (1)
- `__exportStar` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:106` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `forEach` (1)

**Calls:**
- `normalizePath` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:16` | Self: 0.0% (0us) | Total: 0.0% (310us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `assignControllerUniqueId`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:338` | Self: 0.0% (0us) | Total: 0.0% (190us) | Samples: 0

**Called by:**
- `addController` (1)

**Calls:**
- `uid` (1)

### `decorate`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:139` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `__decorate` (1)

**Calls:**
- `IsArray` (1)

### `node:zlib`
`node:zlib:300` | Self: 0.0% (0us) | Total: 0.0% (188us) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `async resolveSingleParam`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:237` | Self: 0.0% (0us) | Total: 0.0% (599us) | Samples: 0

**Called by:**
- `async (anonymous)` (3)

**Calls:**
- `async resolveComponentWrapper` (2)
- `async resolveComponentWrapper` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapAction.js:52` | Self: 0.0% (0us) | Total: 0.0% (286us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:180` | Self: 0.0% (0us) | Total: 0.0% (579us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `forEach`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js:153` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `applyProperties` (4)
- `addScopedEnhancersMetadata` (1)

**Calls:**
- `next` (3)
- `next` (2)

### `async resolveConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:131` | Self: 0.0% (0us) | Total: 0.1% (7.2ms) | Samples: 0

**Called by:**
- `async resolveConstructorParams` (13)

**Calls:**
- `getClassDependencies` (8)
- `getClassDependencies` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (243us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:174` | Self: 0.0% (0us) | Total: 0.0% (813us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `applyCallbackToRouter`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:81` | Self: 0.0% (0us) | Total: 0.0% (631us) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `applyHostFilter` (2)
- `applyHostFilter` (1)

### `internal:stream`
`internal:stream:48` | Self: 0.0% (0us) | Total: 0.0% (220us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:240` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `setup` (3)
- `bound require` (3)
- `setup` (1)
- `setup` (1)

### `async scan`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:32` | Self: 0.0% (0us) | Total: 0.0% (568us) | Samples: 0

**Calls:**
- `async scanModulesForDependencies` (2)

### `exchangeKeysForValues`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:102` | Self: 0.0% (0us) | Total: 0.0% (231us) | Samples: 0

**Called by:**
- `getMetadata` (1)

**Calls:**
- `setModuleContext` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:16` | Self: 0.0% (0us) | Total: 0.0% (224us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `internal:primordials`
`internal:primordials:74` | Self: 0.0% (0us) | Total: 0.0% (204us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `getGetter` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module.js:9` | Self: 0.0% (0us) | Total: 0.0% (231us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `node:fs`
`node:fs:306` | Self: 0.0% (0us) | Total: 0.0% (190us) | Samples: 0

**Calls:**
- `defineCustomPromisifyArgs` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/VirtualTimeScheduler.js:52` | Self: 0.0% (0us) | Total: 0.0% (266us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:196` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:708` | Self: 0.0% (0us) | Total: 0.0% (201us) | Samples: 0

**Called by:**
- `Promise` (1)

**Calls:**
- `get headersSent` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-server-provider.js:5` | Self: 0.0% (0us) | Total: 0.0% (426us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async init`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:103` | Self: 0.0% (0us) | Total: 0.0% (4.6ms) | Samples: 0

**Calls:**
- `async registerModules` (21)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/serializer/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (359us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:222` | Self: 0.0% (0us) | Total: 0.0% (260us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/combineLatest.js:10` | Self: 0.0% (0us) | Total: 0.0% (348us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:90` | Self: 0.0% (0us) | Total: 0.0% (422us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:166` | Self: 0.0% (0us) | Total: 0.0% (2.3ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:32` | Self: 0.0% (0us) | Total: 0.0% (208us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (878us) | Samples: 0

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduleObservable.js:5` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `use`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4238` | Self: 0.0% (0us) | Total: 0.0% (2.3ms) | Samples: 0

**Called by:**
- `use` (11)

**Calls:**
- `flushPending` (11)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:16` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `async init`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:95` | Self: 0.0% (0us) | Total: 0.0% (215us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `async init` (1)

### `setup`
`/home/user/bun-node/node_modules/debug/src/common.js:14` | Self: 0.0% (0us) | Total: 0.0% (652us) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `bound require` (3)

### `node:stream`
`node:stream:2` | Self: 0.0% (0us) | Total: 0.2% (13.6ms) | Samples: 0

**Called by:**
- `anonymous` (61)

**Calls:**
- `anonymous` (61)

### `internal:streams/readable`
`internal:streams/readable:14` | Self: 0.0% (0us) | Total: 0.0% (433us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:172` | Self: 0.0% (0us) | Total: 0.0% (754us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/enums/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (2)
- `__exportStar` (1)

### `insertConfig`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/container.js:37` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `async loadConfiguration` (1)

**Calls:**
- `forEach` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/invalid-exception-filter.exception.js:4` | Self: 0.0% (0us) | Total: 0.0% (632us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `copyMetadataToCallback`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:230` | Self: 0.0% (0us) | Total: 0.0% (4.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (10)

**Calls:**
- `defineMetadata` (9)
- `defineMetadata` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:44` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Calls:**
- `async resolveInstances` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/header.decorator.js:5` | Self: 0.0% (0us) | Total: 0.0% (320us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/skipUntil.js:4` | Self: 0.0% (0us) | Total: 0.0% (507us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `concatPaths`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:67` | Self: 0.0% (0us) | Total: 0.0% (616us) | Samples: 0

**Called by:**
- `map` (3)

**Calls:**
- `stripEndSlash` (2)
- `addLeadingSlash` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/http.exception.js:5` | Self: 0.0% (0us) | Total: 0.0% (470us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `OrdinaryDefineOwnMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:612` | Self: 0.0% (0us) | Total: 0.0% (988us) | Samples: 0

**Called by:**
- `defineMetadata` (3)
- `decorator` (2)

**Calls:**
- `OrdinaryDefineOwnMetadata` (3)
- `OrdinaryDefineOwnMetadata` (1)
- `OrdinaryDefineOwnMetadata` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/catch.decorator.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/tslib/tslib.js:68` | Self: 0.0% (0us) | Total: 0.0% (531us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `reflectProperties`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:402` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Called by:**
- `async resolveProperties` (12)

**Calls:**
- `getMetadata` (11)
- `getMetadata` (1)

### `Module`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:32` | Self: 0.0% (0us) | Total: 0.3% (16.3ms) | Samples: 0

**Called by:**
- `async setModule` (1)

**Calls:**
- `addCoreProviders` (1)

### `internal:util/inspect`
`internal:util/inspect:46` | Self: 0.0% (0us) | Total: 0.0% (623us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound call` (2)
- `getOwnPropertyNames` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:74` | Self: 0.0% (0us) | Total: 0.0% (440us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/hooks/index.js:7` | Self: 0.0% (0us) | Total: 0.0% (236us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async init`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:106` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Calls:**
- `async registerRouterHooks` (2)
- `async registerRouterHooks` (1)
- `async registerRouterHooks` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:124` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `filter` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:16` | Self: 0.0% (0us) | Total: 0.0% (868us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/dom/animationFrames.js:5` | Self: 0.0% (0us) | Total: 0.0% (629us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:9` | Self: 0.0% (0us) | Total: 0.0% (349us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:38` | Self: 0.0% (0us) | Total: 0.0% (856us) | Samples: 0

**Called by:**
- `forEach` (4)

**Calls:**
- `getMetadata` (4)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:59` | Self: 0.0% (0us) | Total: 0.0% (3.3ms) | Samples: 0

**Called by:**
- `create` (9)

**Calls:**
- `getMetadata` (8)
- `reflectCallbackParamtypes` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (429us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:63` | Self: 0.0% (0us) | Total: 0.0% (912us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:29` | Self: 0.0% (0us) | Total: 0.0% (793us) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:6` | Self: 0.0% (0us) | Total: 0.0% (4.4ms) | Samples: 0

**Called by:**
- `anonymous` (16)

**Calls:**
- `bound require` (16)

### `async callInitHook`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:249` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `async init` (9)

**Calls:**
- `async callInitHook` (7)
- `async callInitHook` (1)
- `async callInitHook` (1)

### `decorator`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:195` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `DecorateConstructor` (4)
- `DecorateProperty` (1)

**Calls:**
- `OrdinaryDefineOwnMetadata` (3)
- `OrdinaryDefineOwnMetadata` (2)

### `async callBootstrapHook`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:271` | Self: 0.0% (0us) | Total: 0.0% (858us) | Samples: 0

**Called by:**
- `async init` (4)

**Calls:**
- `async callBootstrapHook` (3)
- `async callBootstrapHook` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:125` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1076` | Self: 0.0% (0us) | Total: 0.0% (214us) | Samples: 0

**Called by:**
- `registerVerb` (1)

**Calls:**
- `get size` (1)

### `isResponseHandled`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:189` | Self: 0.0% (0us) | Total: 0.0% (382us) | Samples: 0

**Called by:**
- `getMetadata` (1)

**Calls:**
- `some` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/inspector/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (992us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/zip.js:25` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `async setModule`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:103` | Self: 0.0% (0us) | Total: 0.0% (287us) | Samples: 0

**Called by:**
- `async setModule` (1)

**Calls:**
- `async addDynamicMetadata` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module.js:8` | Self: 0.0% (0us) | Total: 0.0% (197us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:16` | Self: 0.0% (0us) | Total: 0.0% (709us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `reflectDynamicMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:146` | Self: 0.0% (0us) | Total: 0.0% (2.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (9)

**Calls:**
- `reflectInjectables` (5)
- `reflectInjectables` (2)
- `reflectInjectables` (1)
- `reflectInjectables` (1)

### `async registerRouterHooks`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:124` | Self: 0.0% (0us) | Total: 0.0% (920us) | Samples: 0

**Called by:**
- `async init` (2)

**Calls:**
- `registerNotFoundHandler` (1)
- `registerNotFoundHandler` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:89` | Self: 0.0% (0us) | Total: 0.1% (8.8ms) | Samples: 0

**Called by:**
- `forEach` (7)

**Calls:**
- `create` (3)
- `create` (2)
- `map` (1)
- `create` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js:6` | Self: 0.0% (0us) | Total: 0.0% (429us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:14` | Self: 0.0% (0us) | Total: 0.0% (246us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:53` | Self: 0.0% (0us) | Total: 0.0% (793us) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `(anonymous)` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (842us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:22` | Self: 0.0% (0us) | Total: 0.0% (273us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/types/multipart.js:5` | Self: 0.0% (0us) | Total: 0.0% (641us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delayWhen.js:5` | Self: 0.0% (0us) | Total: 0.0% (877us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `registerParserMiddleware`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1282` | Self: 0.0% (0us) | Total: 0.0% (2.7ms) | Samples: 0

**Called by:**
- `registerParserMiddleware` (13)

**Calls:**
- `registerBodyParser` (12)
- `registerBodyParser` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/pipes/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/index.js:21` | Self: 0.0% (0us) | Total: 2.1% (105.9ms) | Samples: 0

**Calls:**
- `bound require` (379)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/index.js:4` | Self: 0.0% (0us) | Total: 0.5% (29.2ms) | Samples: 0

**Called by:**
- `anonymous` (116)

**Calls:**
- `bound require` (116)

### `extractPathsFrom`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js:18` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Called by:**
- `async registerHandler` (1)

**Calls:**
- `extractVersionPathFrom` (1)

### `optionalRequire`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/optional-require.js:6` | Self: 0.0% (0us) | Total: 0.2% (11.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (46)
- `(anonymous)` (2)

**Calls:**
- `bound require` (48)

### `(module)`
`/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` | Self: 0.0% (0us) | Total: 0.0% (515us) | Samples: 0

**Calls:**
- `from` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:232` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `finish`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:687` | Self: 0.0% (0us) | Total: 0.6% (30.2ms) | Samples: 0

**Called by:**
- `(anonymous)` (45)
- `(anonymous)` (25)
- `next` (3)

**Calls:**
- `(anonymous)` (73)

### `getAllMethodNames`
`/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:78` | Self: 0.0% (0us) | Total: 0.0% (900us) | Samples: 0

**Called by:**
- `reflectInjectables` (1)

**Calls:**
- `getPrototypeOf` (1)

### `configure`
`/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:71` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `async loadConfiguration` (8)

**Calls:**
- `forRoutes` (3)
- `forRoutes` (3)
- `forRoutes` (1)
- `forRoutes` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:226` | Self: 0.0% (0us) | Total: 0.2% (11.3ms) | Samples: 0

**Called by:**
- `anonymous` (10)

**Calls:**
- `bound require` (10)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:7` | Self: 0.0% (0us) | Total: 0.0% (541us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:35` | Self: 0.0% (0us) | Total: 0.1% (8.8ms) | Samples: 0

**Called by:**
- `forEach` (23)

**Calls:**
- `createPrototypesOfControllers` (23)

### `async createInstancesOfControllers`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:64` | Self: 0.0% (0us) | Total: 0.4% (21.7ms) | Samples: 0

**Called by:**
- `async (anonymous)` (57)

**Calls:**
- `async createInstancesOfControllers` (56)
- `async createInstancesOfControllers` (1)

### `async loadMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:88` | Self: 0.0% (0us) | Total: 0.0% (772us) | Samples: 0

**Called by:**
- `async resolveMiddlewareInstance` (4)

**Calls:**
- `async loadMiddleware` (3)
- `async loadMiddleware` (1)

### `insertController`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:300` | Self: 0.0% (0us) | Total: 0.2% (12.8ms) | Samples: 0

**Called by:**
- `(anonymous)` (28)

**Calls:**
- `addController` (26)
- `addController` (2)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5175` | Self: 0.0% (0us) | Total: 1.1% (57.9ms) | Samples: 0

**Calls:**
- `#watchLateRejection` (152)
- `#watchLateRejection` (1)

### `async register`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:32` | Self: 0.0% (0us) | Total: 0.0% (209us) | Samples: 0

**Called by:**
- `async register` (1)

**Calls:**
- `RouteInfoPathExtractor` (1)

### `addController`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:331` | Self: 0.0% (0us) | Total: 0.0% (643us) | Samples: 0

**Called by:**
- `addController` (3)

**Calls:**
- `assignControllerUniqueId` (2)
- `assignControllerUniqueId` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Notification.js:5` | Self: 0.0% (0us) | Total: 0.0% (732us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:17` | Self: 0.0% (0us) | Total: 0.0% (4.1ms) | Samples: 0

**Called by:**
- `anonymous` (18)

**Calls:**
- `bound require` (18)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:13` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/switchMapTo.js:4` | Self: 0.0% (0us) | Total: 0.0% (310us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:31` | Self: 0.0% (0us) | Total: 0.0% (405us) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `appendToAllIfDefined` (1)
- `appendToAllIfDefined` (1)

### `ie`
`bun:wrap:1` | Self: 0.0% (0us) | Total: 0.0% (559us) | Samples: 0

**Called by:**
- `(module)` (2)
- `(module)` (1)

**Calls:**
- `decorate` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:21` | Self: 0.0% (0us) | Total: 0.0% (507us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async create`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:44` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Calls:**
- `NestApplication` (3)
- `NestApplication` (2)
- `NestApplication` (1)
- `NestApplication` (1)
- `NestApplication` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:17` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Called by:**
- `anonymous` (11)

**Calls:**
- `bound require` (11)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/bufferTime.js:21` | Self: 0.0% (0us) | Total: 0.0% (214us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async createInstancesOfControllers`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:67` | Self: 0.0% (0us) | Total: 0.4% (21.4ms) | Samples: 0

**Called by:**
- `async createInstancesOfControllers` (56)

**Calls:**
- `map` (55)
- `all` (1)

### `async loadInstance`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:57` | Self: 0.0% (0us) | Total: 0.0% (4.4ms) | Samples: 0

**Called by:**
- `async loadInstance` (9)

**Calls:**
- `applySettlementSignal` (6)
- `applySettlementSignal` (2)
- `applySettlementSignal` (1)

### `originalUrl`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3698` | Self: 0.0% (0us) | Total: 0.4% (20.6ms) | Samples: 0

**Called by:**
- `#routeRequest` (58)

**Calls:**
- `splitRequestUrl` (58)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/serializer/class-serializer.interceptor.js:10` | Self: 0.0% (0us) | Total: 0.0% (502us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:18` | Self: 0.0% (0us) | Total: 0.0% (222us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/innerFrom.js:58` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/ReplaySubject.js:22` | Self: 0.0% (0us) | Total: 0.0% (554us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `node:perf_hooks`
`node:perf_hooks:97` | Self: 0.0% (0us) | Total: 0.0% (218us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `setPrototypeDirectOrThrow` (1)

### `async instantiateClass`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:435` | Self: 0.0% (0us) | Total: 0.0% (4.1ms) | Samples: 0

**Called by:**
- `async instantiateClass` (4)

**Calls:**
- `fromContainer` (2)
- `fromContainer` (1)
- `useFactory` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/onErrorResumeNextWith.js:26` | Self: 0.0% (0us) | Total: 0.0% (648us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:20` | Self: 0.0% (0us) | Total: 0.0% (275us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `OrdinaryOwnMetadataKeys`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:653` | Self: 0.0% (0us) | Total: 0.1% (7.5ms) | Samples: 0

**Called by:**
- `OrdinaryMetadataKeys` (7)

**Calls:**
- `OrdinaryOwnMetadataKeys` (4)
- `OrdinaryOwnMetadataKeys` (2)
- `OrdinaryOwnMetadataKeys` (1)

### `mimeScore`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js:42` | Self: 0.0% (0us) | Total: 0.0% (405us) | Samples: 0

**Called by:**
- `_preferredType` (2)

**Calls:**
- `replace` (2)

### `async resolveInstances`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js:12` | Self: 0.0% (0us) | Total: 0.0% (985us) | Samples: 0

**Called by:**
- `async resolveInstances` (5)

**Calls:**
- `map` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:22` | Self: 0.0% (0us) | Total: 0.0% (4.0ms) | Samples: 0

**Called by:**
- `anonymous` (18)

**Calls:**
- `bound require` (18)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:18` | Self: 0.0% (0us) | Total: 0.0% (274us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/discovery/discovery-module.js:6` | Self: 0.0% (0us) | Total: 0.0% (690us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:49` | Self: 0.0% (0us) | Total: 0.0% (399us) | Samples: 0

**Called by:**
- `forEach` (2)

**Calls:**
- `forEach` (2)

### `instance`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:33` | Self: 0.0% (0us) | Total: 0.0% (687us) | Samples: 0

**Called by:**
- `explore` (3)

**Calls:**
- `getInstanceByContextId` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:13` | Self: 0.0% (0us) | Total: 0.0% (643us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:10` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async reflectImports`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:112` | Self: 0.0% (0us) | Total: 0.0% (289us) | Samples: 0

**Called by:**
- `async scanModulesForDependencies` (1)

**Calls:**
- `async reflectImports` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:43` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)
- `(anonymous)` (2)
- `(anonymous)` (2)

**Calls:**
- `map` (7)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4782` | Self: 0.0% (0us) | Total: 1.0% (50.6ms) | Samples: 0

**Called by:**
- `dispatch` (123)

**Calls:**
- `get` (123)

### `#finishAbsentBody`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:1332` | Self: 0.0% (0us) | Total: 0.4% (20.9ms) | Samples: 0

**Called by:**
- `BunRequest` (66)

**Calls:**
- `get` (66)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:30` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:35` | Self: 0.0% (0us) | Total: 0.0% (449us) | Samples: 0

**Called by:**
- `createCallbackProxy` (2)

**Calls:**
- `createPipesFn` (1)
- `createPipesFn` (1)

### `loadPrototype`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:35` | Self: 0.0% (0us) | Total: 0.0% (3.0ms) | Samples: 0

**Called by:**
- `forEach` (13)

**Calls:**
- `InstanceWrapper` (12)
- `cloneObject` (1)

### `internal:streams/destroy`
`internal:streams/destroy:2` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `anonymous` (9)

### `createContext`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:9` | Self: 0.0% (0us) | Total: 0.0% (613us) | Samples: 0

**Called by:**
- `create` (3)

**Calls:**
- `getMetadata` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (3.6ms) | Samples: 0

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:111` | Self: 0.0% (0us) | Total: 0.0% (423us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async callInitHook`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:252` | Self: 0.0% (0us) | Total: 0.1% (5.3ms) | Samples: 0

**Called by:**
- `async callInitHook` (7)

**Calls:**
- `async callModuleInitHook` (23)
- `async callModuleInitHook` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:6` | Self: 0.0% (0us) | Total: 0.0% (450us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/serializer/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (790us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module-ref.js:6` | Self: 0.0% (0us) | Total: 0.0% (740us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/concat.js:26` | Self: 0.0% (0us) | Total: 0.0% (664us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/factories/ws-params-factory.js:5` | Self: 0.0% (0us) | Total: 0.0% (435us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:8` | Self: 0.0% (0us) | Total: 0.2% (14.6ms) | Samples: 0

**Called by:**
- `anonymous` (59)

**Calls:**
- `bound require` (59)

### `(anonymous)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:3235` | Self: 0.0% (0us) | Total: 0.0% (192us) | Samples: 0

**Called by:**
- `forEach` (1)

**Calls:**
- `getRequestMethodStr` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:20` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `applyPathsToRouterProxy`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:62` | Self: 0.0% (0us) | Total: 2.6% (130.1ms) | Samples: 0

**Called by:**
- `explore` (379)

**Calls:**
- `forEach` (379)

### `(module)`
`/home/user/bun-node/node_modules/uint8array-extras/index.js:178` | Self: 0.0% (0us) | Total: 0.0% (525us) | Samples: 0

**Calls:**
- `from` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/asap.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/combineLatest.js:6` | Self: 0.0% (0us) | Total: 0.1% (5.8ms) | Samples: 0

**Called by:**
- `anonymous` (19)

**Calls:**
- `bound require` (19)

### `exploreMethodMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:34` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `addLeadingSlash` (2)
- `addLeadingSlash` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:20` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Calls:**
- `bound require` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:14` | Self: 0.0% (0us) | Total: 0.0% (427us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:187` | Self: 0.0% (0us) | Total: 0.0% (208us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `extractRouterPath`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:56` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `isArray` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:148` | Self: 0.0% (0us) | Total: 0.0% (419us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/context/exception-filters-context.js:7` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/timer.js:6` | Self: 0.0% (0us) | Total: 0.0% (203us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/connect.js:7` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/auditTime.js:6` | Self: 0.0% (0us) | Total: 0.0% (831us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `connectAllGateways`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:36` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `forEach` (4)

**Calls:**
- `forEach` (4)

### `(module)`
`/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:9` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Calls:**
- `createDebug` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/modules/module.decorator.js:4` | Self: 0.0% (0us) | Total: 0.0% (593us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (274us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:12` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/animationFrameProvider.js:25` | Self: 0.0% (0us) | Total: 0.0% (228us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1016` | Self: 0.0% (0us) | Total: 0.0% (190us) | Samples: 0

**Called by:**
- `useMethod` (1)

**Calls:**
- `replace` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:4` | Self: 0.0% (0us) | Total: 0.0% (209us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/utils/filter-log-levels.util.js:4` | Self: 0.0% (0us) | Total: 0.0% (221us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:116` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:114` | Self: 0.0% (0us) | Total: 0.0% (437us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js:24` | Self: 0.0% (0us) | Total: 0.0% (209us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async createInstancesOfDependencies`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:19` | Self: 0.0% (0us) | Total: 0.2% (13.5ms) | Samples: 0

**Called by:**
- `async (anonymous)` (46)

**Calls:**
- `async createInstancesOfDependencies` (23)
- `async createInstancesOfDependencies` (23)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:83` | Self: 0.0% (0us) | Total: 0.0% (826us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:50` | Self: 0.0% (0us) | Total: 0.0% (2.5ms) | Samples: 0

**Called by:**
- `anonymous` (11)

**Calls:**
- `bound require` (11)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/immediateProvider.js:25` | Self: 0.0% (0us) | Total: 0.0% (404us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/queue.js:4` | Self: 0.0% (0us) | Total: 0.0% (823us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`/home/user/bun-node/node_modules/@tokenizer/inflate/lib/ZipHandler.js:11` | Self: 0.0% (0us) | Total: 0.0% (270us) | Samples: 0

**Calls:**
- `signatureToArray` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:17` | Self: 0.0% (0us) | Total: 0.0% (198us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:86` | Self: 0.0% (0us) | Total: 0.0% (597us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:39` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:16` | Self: 0.0% (0us) | Total: 0.0% (545us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exceptions-handler.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `insertConfig`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/container.js:24` | Self: 0.0% (0us) | Total: 0.0% (217us) | Samples: 0

**Called by:**
- `async loadConfiguration` (1)

**Calls:**
- `getMiddlewareCollection` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/innerFrom.js:60` | Self: 0.0% (0us) | Total: 0.1% (6.6ms) | Samples: 0

**Called by:**
- `anonymous` (27)

**Calls:**
- `bound require` (27)

### `async registerMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:71` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `async registerMiddleware` (9)

**Calls:**
- `async registerMiddleware` (8)
- `async registerMiddleware` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/file-stream/streamable-file.js:7` | Self: 0.0% (0us) | Total: 0.5% (26.1ms) | Samples: 0

**Called by:**
- `anonymous` (81)

**Calls:**
- `bound require` (81)

### `async callBootstrapHook`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:274` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `async callBootstrapHook` (3)

**Calls:**
- `async callModuleBootstrapHook` (8)

### `getAllMethodNames`
`/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:69` | Self: 0.0% (0us) | Total: 0.0% (627us) | Samples: 0

**Called by:**
- `scanForPaths` (3)

**Calls:**
- `getOwnPropertyDescriptor` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/bufferTime.js:20` | Self: 0.0% (0us) | Total: 0.0% (462us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `getAllMethodNames`
`/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:61` | Self: 0.0% (0us) | Total: 0.0% (207us) | Samples: 0

**Called by:**
- `scanForPaths` (1)

**Calls:**
- `set` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/combineLatestAll.js:5` | Self: 0.0% (0us) | Total: 0.0% (2.6ms) | Samples: 0

**Called by:**
- `anonymous` (12)

**Calls:**
- `bound require` (12)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/serializer/class-serializer.interceptor.js:4` | Self: 0.0% (0us) | Total: 0.0% (222us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/defaultIfEmpty.js:4` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:733` | Self: 0.0% (0us) | Total: 0.0% (302us) | Samples: 0

**Calls:**
- `setPrototypeDirectOrThrow` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:60` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `setRoute` (5)

**Calls:**
- `#compileMiddlewareRegExp` (3)
- `#compileMiddlewareRegExp` (1)
- `#compileMiddlewareRegExp` (1)

### `async handleBodyParsing`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3391` | Self: 0.0% (0us) | Total: 0.6% (29.6ms) | Samples: 0

**Called by:**
- `async handleBodyParsing` (96)

**Calls:**
- `parseContentCodings` (71)
- `parseContentCodings` (24)
- `parseContentCodings` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/inject.decorator.js:44` | Self: 0.0% (0us) | Total: 0.0% (222us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `getMetadata` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4805` | Self: 0.0% (0us) | Total: 0.0% (401us) | Samples: 0

**Called by:**
- `dispatch` (2)

**Calls:**
- `matchRoute` (1)
- `matchRoute` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:15` | Self: 0.0% (0us) | Total: 0.0% (257us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscription.js:36` | Self: 0.0% (0us) | Total: 0.0% (203us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:6` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:15` | Self: 0.0% (0us) | Total: 0.0% (697us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `resolve`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:30` | Self: 0.0% (0us) | Total: 2.9% (145.1ms) | Samples: 0

**Called by:**
- `async registerRouter` (443)

**Calls:**
- `forEach` (443)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Scheduler.js:4` | Self: 0.0% (0us) | Total: 0.0% (228us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:163` | Self: 0.0% (0us) | Total: 0.2% (10.1ms) | Samples: 0

**Called by:**
- `reduce` (25)

**Calls:**
- `reflectKeyMetadata` (17)
- `reflectKeyMetadata` (5)
- `reflectKeyMetadata` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:11` | Self: 0.0% (0us) | Total: 0.0% (3.7ms) | Samples: 0

**Called by:**
- `anonymous` (14)

**Calls:**
- `bound require` (14)

### `copyProps`
`internal:primordials:23` | Self: 0.0% (0us) | Total: 0.0% (191us) | Samples: 0

**Called by:**
- `makeSafe` (1)

**Calls:**
- `ownKeys` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/ConnectableObservable.js:21` | Self: 0.0% (0us) | Total: 0.0% (661us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Notification.js:12` | Self: 0.0% (0us) | Total: 0.0% (230us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:102` | Self: 0.0% (0us) | Total: 0.0% (423us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `channel`
`node:diagnostics_channel:141` | Self: 0.0% (0us) | Total: 0.0% (190us) | Samples: 0

**Called by:**
- `node:_http_client` (1)

**Calls:**
- `Channel` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/http/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (457us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/lift.js:4` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async registerRouter`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:121` | Self: 0.0% (0us) | Total: 2.9% (145.1ms) | Samples: 0

**Calls:**
- `resolve` (443)

### `connectGatewayToServer`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:39` | Self: 0.0% (0us) | Total: 0.0% (629us) | Samples: 0

**Called by:**
- `forEach` (2)

**Calls:**
- `get instance` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:26` | Self: 0.0% (0us) | Total: 0.0% (215us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:15` | Self: 0.0% (0us) | Total: 0.0% (802us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/use-guards.decorator.js:7` | Self: 0.0% (0us) | Total: 0.0% (253us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:58` | Self: 0.0% (0us) | Total: 0.0% (385us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:150` | Self: 0.0% (0us) | Total: 0.0% (215us) | Samples: 0

**Called by:**
- `run` (1)

**Calls:**
- `async init` (1)

### `async callModuleBootstrapHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js:44` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Calls:**
- `from` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/dematerialize.js:4` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/index.js:13` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Calls:**
- `bound require` (5)

### `async resolveInstance`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js:11` | Self: 0.0% (0us) | Total: 0.0% (985us) | Samples: 0

**Called by:**
- `map` (5)

**Calls:**
- `async resolveMiddlewareInstance` (5)

### `reflectCallbackParamtypes`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js` | Self: 0.0% (0us) | Total: 0.0% (187us) | Samples: 0

**Called by:**
- `getMetadata` (1)

**Calls:**
- `(unknown)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/modules/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (422us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/AsyncSubject.js:21` | Self: 0.0% (0us) | Total: 0.0% (313us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:8` | Self: 0.0% (0us) | Total: 0.0% (233us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js:50` | Self: 0.0% (0us) | Total: 0.0% (230us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `createErrorClass`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/createErrorClass.js:10` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `create` (1)

### `internal:streams/end-of-stream`
`internal:streams/end-of-stream:17` | Self: 0.0% (0us) | Total: 0.0% (631us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapAction.js:22` | Self: 0.0% (0us) | Total: 0.0% (286us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:267` | Self: 0.0% (0us) | Total: 0.0% (245us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/combineLatest.js:4` | Self: 0.0% (0us) | Total: 0.0% (194us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async addDynamicMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:119` | Self: 0.0% (0us) | Total: 0.0% (287us) | Samples: 0

**Called by:**
- `async addDynamicMetadata` (1)

**Calls:**
- `async addDynamicModules` (1)

### `_preferredType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:189` | Self: 0.0% (0us) | Total: 0.0% (3.8ms) | Samples: 0

**Called by:**
- `forEachMimeType` (19)

**Calls:**
- `mimeScore` (13)
- `mimeScore` (3)
- `mimeScore` (2)
- `mimeScore` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `async callInitHook`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:250` | Self: 0.0% (0us) | Total: 0.0% (215us) | Samples: 0

**Called by:**
- `async callInitHook` (1)

**Calls:**
- `getModulesToTriggerHooksOn` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/VirtualTimeScheduler.js:23` | Self: 0.0% (0us) | Total: 0.0% (266us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/picoquery/lib/string-util.js:3` | Self: 0.0% (0us) | Total: 0.0% (249us) | Samples: 0

**Called by:**
- `from` (1)

**Calls:**
- `toString` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/debug/src/node.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:62` | Self: 0.0% (0us) | Total: 0.0% (3.0ms) | Samples: 0

**Called by:**
- `create` (10)

**Calls:**
- `map` (7)
- `exchangeKeysForValues` (1)
- `exchangeKeysForValues` (1)
- `exchangeKeysForValues` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/mapOneOrManyArgs.js:25` | Self: 0.0% (0us) | Total: 0.0% (411us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:16` | Self: 0.0% (0us) | Total: 0.0% (206us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `#build`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:185` | Self: 0.0% (0us) | Total: 0.1% (7.7ms) | Samples: 0

**Called by:**
- `candidates` (14)

**Calls:**
- `map` (14)

### `async resolveConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:180` | Self: 0.0% (0us) | Total: 0.1% (8.5ms) | Samples: 0

**Calls:**
- `async callback` (35)

### `(anonymous)`
`/home/user/bun-node/node_modules/mime-db/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (3.0ms) | Samples: 0

**Called by:**
- `anonymous` (15)

**Calls:**
- `bound require` (15)

### `Channel`
`node:diagnostics_channel:108` | Self: 0.0% (0us) | Total: 0.0% (190us) | Samples: 0

**Called by:**
- `channel` (1)

**Calls:**
- `set` (1)

### `BunWebSocketAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunWebSocketAdapter.ts:530` | Self: 0.0% (0us) | Total: 0.0% (272us) | Samples: 0

**Called by:**
- `BunNestWebsocketAdapter` (1)

**Calls:**
- `BunWebSocket` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (2.5ms) | Samples: 0

**Calls:**
- `bound require` (8)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncAction.js:23` | Self: 0.0% (0us) | Total: 0.0% (276us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:19` | Self: 0.0% (0us) | Total: 0.0% (877us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `async lookupComponent`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:292` | Self: 0.0% (0us) | Total: 0.0% (194us) | Samples: 0

**Called by:**
- `async resolveComponentWrapper` (1)

**Calls:**
- `addDependencyMetadata` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/opaque-key-factory/deep-hashed-module-opaque-key-factory.js:8` | Self: 0.0% (0us) | Total: 0.0% (633us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `async loadProvider`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:111` | Self: 0.0% (0us) | Total: 0.0% (3.2ms) | Samples: 0

**Called by:**
- `async loadProvider` (16)

**Calls:**
- `async loadInstance` (16)

### `pathRegex`
`/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs:233` | Self: 0.0% (0us) | Total: 0.0% (206us) | Samples: 0

**Called by:**
- `#compileRouteRegExp` (1)

**Calls:**
- `replace` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:110` | Self: 0.0% (0us) | Total: 0.0% (411us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `populateMaps`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:155` | Self: 0.0% (0us) | Total: 0.1% (8.5ms) | Samples: 0

**Called by:**
- `(anonymous)` (42)

**Calls:**
- `forEach` (41)
- `keys` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/index.js:6` | Self: 0.0% (0us) | Total: 0.1% (5.0ms) | Samples: 0

**Called by:**
- `anonymous` (17)

**Calls:**
- `bound require` (17)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:23` | Self: 0.0% (0us) | Total: 0.0% (968us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/exhaustAll.js:4` | Self: 0.0% (0us) | Total: 0.0% (420us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/publishBehavior.js:4` | Self: 0.0% (0us) | Total: 0.0% (963us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `createHandleResponseFn`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:170` | Self: 0.0% (0us) | Total: 0.0% (227us) | Samples: 0

**Called by:**
- `getMetadata` (1)

**Calls:**
- `getMetadata` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js:7` | Self: 0.0% (0us) | Total: 0.0% (569us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/provider-classifier.js:6` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:162` | Self: 0.0% (0us) | Total: 0.0% (393us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js:17` | Self: 0.0% (0us) | Total: 0.0% (4.3ms) | Samples: 0

**Called by:**
- `reduce` (18)

**Calls:**
- `exploreMethodMetadata` (6)
- `exploreMethodMetadata` (3)
- `exploreMethodMetadata` (3)
- `exploreMethodMetadata` (3)
- `exploreMethodMetadata` (2)
- `exploreMethodMetadata` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js:10` | Self: 0.0% (0us) | Total: 0.0% (870us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `async scan`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:33` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Calls:**
- `addScopedEnhancersMetadata` (2)
- `addScopedEnhancersMetadata` (1)
- `addScopedEnhancersMetadata` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/tslib/tslib.js:212` | Self: 0.0% (0us) | Total: 0.0% (847us) | Samples: 0

**Called by:**
- `__exportStar` (3)

**Calls:**
- `defineProperty` (3)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:149` | Self: 0.0% (0us) | Total: 0.0% (200us) | Samples: 0

**Called by:**
- `async resolveParam` (1)

**Calls:**
- `getStaticTransientResolutionContext` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (502us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:9` | Self: 0.0% (0us) | Total: 0.0% (199us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AnimationFrameScheduler.js:19` | Self: 0.0% (0us) | Total: 0.0% (224us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `registerNotFoundHandler`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:79` | Self: 0.0% (0us) | Total: 0.0% (176us) | Samples: 0

**Called by:**
- `async registerRouterHooks` (1)

**Calls:**
- `create` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/utils/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (246us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/index.js:9` | Self: 0.0% (0us) | Total: 0.0% (616us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:89` | Self: 0.0% (0us) | Total: 0.0% (214us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `importModule` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/index.js:3` | Self: 0.0% (0us) | Total: 0.0% (2.7ms) | Samples: 0

**Calls:**
- `bound require` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js:5` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `applySettlementSignal`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:115` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `async loadInstance` (6)

**Calls:**
- `SettlementSignal` (4)
- `SettlementSignal` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:28` | Self: 0.0% (0us) | Total: 0.0% (439us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async scanModulesForDependencies`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:104` | Self: 0.0% (0us) | Total: 0.0% (568us) | Samples: 0

**Called by:**
- `async scan` (2)

**Calls:**
- `getModules` (1)
- `async scanModulesForDependencies` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:41` | Self: 0.0% (0us) | Total: 0.0% (264us) | Samples: 0

**Calls:**
- `async createInstancesOfInjectables` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncAction.js:104` | Self: 0.0% (0us) | Total: 0.0% (276us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/reduce.js:4` | Self: 0.0% (0us) | Total: 0.0% (418us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:34` | Self: 0.0% (0us) | Total: 0.0% (424us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/animationFrame.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `explore`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:47` | Self: 0.0% (0us) | Total: 0.0% (906us) | Samples: 0

**Called by:**
- `(anonymous)` (4)

**Calls:**
- `instance` (3)
- `get instance` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:2` | Self: 0.0% (0us) | Total: 0.0% (220us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `defineProperty` (1)

### `Route`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:73` | Self: 0.0% (0us) | Total: 0.0% (183us) | Samples: 0

**Called by:**
- `setRoute` (1)

**Calls:**
- `map` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/zip.js:25` | Self: 0.0% (0us) | Total: 0.0% (227us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:42` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Calls:**
- `Body` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:123` | Self: 0.0% (0us) | Total: 0.0% (191us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async registerModules`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:86` | Self: 0.0% (0us) | Total: 0.0% (2.6ms) | Samples: 0

**Called by:**
- `async registerModules` (13)

**Calls:**
- `async register` (13)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:56` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `create` (2)

**Calls:**
- `reflectCallbackMetadata` (1)
- `getMetadata` (1)

### `async makeTarget`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:54` | Self: 0.0% (0us) | Total: 0.0% (2.5ms) | Samples: 0

**Called by:**
- `(module)` (3)

**Calls:**
- `async makeTarget` (2)
- `async makeTarget` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/general.ts:31` | Self: 0.0% (0us) | Total: 0.0% (293us) | Samples: 0

**Calls:**
- `promisify2` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/web-sockets-controller.js:11` | Self: 0.0% (0us) | Total: 0.0% (392us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `initialize`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:340` | Self: 0.0% (0us) | Total: 0.0% (645us) | Samples: 0

**Called by:**
- `InstanceWrapper` (3)

**Calls:**
- `copyDataProperties` (3)

### `getGlobalMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js:27` | Self: 0.0% (0us) | Total: 0.0% (192us) | Samples: 0

**Called by:**
- `createContext` (1)

**Calls:**
- `getGlobalFilters` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:150` | Self: 0.0% (0us) | Total: 0.0% (641us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `RoutesResolver`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:26` | Self: 0.0% (0us) | Total: 0.0% (410us) | Samples: 0

**Called by:**
- `NestApplication` (2)

**Calls:**
- `RouterExplorer` (1)
- `RouterExplorer` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/inspector/serialized-graph.js:8` | Self: 0.0% (0us) | Total: 0.2% (12.0ms) | Samples: 0

**Called by:**
- `anonymous` (49)

**Calls:**
- `bound require` (49)

### `Agent`
`node:_http_agent:22` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `node:_http_agent` (1)

**Calls:**
- `addListener` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/mergeMap.js:7` | Self: 0.0% (0us) | Total: 0.0% (690us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/last.js:6` | Self: 0.0% (0us) | Total: 0.0% (431us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:78` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:10` | Self: 0.0% (0us) | Total: 0.0% (532us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`node:diagnostics_channel:18` | Self: 0.0% (0us) | Total: 0.0% (223us) | Samples: 0

**Called by:**
- `WeakRefMap` (1)

**Calls:**
- `FinalizationRegistry` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:43` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `forEach` (6)

**Calls:**
- `create` (3)
- `create` (2)
- `create` (1)

### `useMethod`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4294` | Self: 0.0% (0us) | Total: 0.0% (812us) | Samples: 0

**Called by:**
- `(anonymous)` (4)

**Calls:**
- `setRoute` (1)
- `setRoute` (1)
- `setRoute` (1)
- `setRoute` (1)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:87` | Self: 0.0% (0us) | Total: 0.0% (374us) | Samples: 0

**Called by:**
- `map` (2)

**Calls:**
- `map` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/AsyncSubject.js:53` | Self: 0.0% (0us) | Total: 0.0% (313us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/node_modules/mime-db/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (3.3ms) | Samples: 0

**Called by:**
- `anonymous` (16)

**Calls:**
- `bound require` (16)

### `node:zlib`
`node:zlib:456` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Calls:**
- `map` (1)

### `async registerMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:323` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Called by:**
- `async registerRouter` (10)

**Calls:**
- `async registerMiddleware` (10)

### `StructuredLogger`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:183` | Self: 0.0% (0us) | Total: 0.0% (256us) | Samples: 0

**Called by:**
- `createLogger` (1)

**Calls:**
- `thresholdValue` (1)

### `async createInstancesOfDependencies`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:20` | Self: 0.0% (0us) | Total: 0.1% (8.8ms) | Samples: 0

**Called by:**
- `async createInstancesOfDependencies` (23)

**Calls:**
- `createPrototypes` (23)

### `async createInstancesOfControllers`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:66` | Self: 0.0% (0us) | Total: 0.0% (323us) | Samples: 0

**Called by:**
- `async createInstancesOfControllers` (1)

**Calls:**
- `performIteration` (1)

### `async createInstancesOfProviders`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:52` | Self: 0.0% (0us) | Total: 0.0% (3.8ms) | Samples: 0

**Called by:**
- `async (anonymous)` (19)

**Calls:**
- `async createInstancesOfProviders` (19)

### `get`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:1712` | Self: 0.0% (0us) | Total: 0.3% (15.8ms) | Samples: 0

**Called by:**
- `bound get` (57)

**Calls:**
- `registerVerb` (57)

### `ConsoleLogger`
`/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:44` | Self: 0.0% (0us) | Total: 0.0% (260us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `getInspectOptions` (1)

### `async registerMiddlewareConfig`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:98` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `async (anonymous)` (7)

**Calls:**
- `async registerMiddlewareConfig` (6)
- `async registerMiddlewareConfig` (1)

### `async loadController`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:99` | Self: 0.0% (0us) | Total: 0.3% (18.7ms) | Samples: 0

**Called by:**
- `async loadController` (45)

**Calls:**
- `async loadInstance` (43)
- `createResolutionContext` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/messages.js:4` | Self: 0.0% (0us) | Total: 0.0% (213us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `decorate`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:143` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `__decorate` (9)

**Calls:**
- `DecorateConstructor` (9)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/partition.js:4` | Self: 0.0% (0us) | Total: 0.0% (448us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `internal:stream`
`internal:stream:46` | Self: 0.0% (0us) | Total: 0.0% (201us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Notification.js:6` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/file-stream/streamable-file.js:4` | Self: 0.0% (0us) | Total: 0.2% (13.6ms) | Samples: 0

**Called by:**
- `anonymous` (61)

**Calls:**
- `bound require` (61)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:25` | Self: 0.0% (0us) | Total: 0.0% (577us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:190` | Self: 0.0% (0us) | Total: 0.0% (198us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:118` | Self: 0.0% (0us) | Total: 0.0% (1.9ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `applyProperties`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:416` | Self: 0.0% (0us) | Total: 0.0% (873us) | Samples: 0

**Called by:**
- `async (anonymous)` (4)

**Calls:**
- `forEach` (4)

### `WriteStream`
`internal:fs/streams:259` | Self: 0.0% (0us) | Total: 0.0% (548us) | Samples: 0

**Called by:**
- `(anonymous)` (2)

**Calls:**
- `Writable` (1)
- `Writable` (1)

### `compileRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:86` | Self: 0.0% (0us) | Total: 0.0% (536us) | Samples: 0

**Called by:**
- `map` (3)

**Calls:**
- `map` (3)

### `addDependencyMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:597` | Self: 0.0% (0us) | Total: 0.0% (194us) | Samples: 0

**Called by:**
- `async lookupComponent` (1)

**Calls:**
- `addCtorMetadata` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:14` | Self: 0.0% (0us) | Total: 0.0% (208us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `__` (1)

### `(module)`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:303` | Self: 0.0% (0us) | Total: 0.0% (256us) | Samples: 0

**Calls:**
- `createLogger` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:48` | Self: 0.0% (0us) | Total: 0.0% (652us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `mapToClass`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/utils.js:51` | Self: 0.0% (0us) | Total: 0.0% (192us) | Samples: 0

**Called by:**
- `next` (1)

**Calls:**
- `isMiddlewareClass` (1)

### `#build`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:198` | Self: 0.0% (0us) | Total: 0.0% (200us) | Samples: 0

**Called by:**
- `candidates` (1)

**Calls:**
- `get` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:13` | Self: 0.0% (0us) | Total: 0.0% (402us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:283` | Self: 0.0% (0us) | Total: 0.0% (264us) | Samples: 0

**Called by:**
- `async makeTarget` (1)

**Calls:**
- `resolveWebSocketOptions` (1)

### `deprecate`
`internal:util/deprecate:17` | Self: 0.0% (0us) | Total: 0.0% (878us) | Samples: 0

**Called by:**
- `node:_http_outgoing` (1)

**Calls:**
- `getDeprecationWarningEmitter` (1)

### `matchRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4634` | Self: 0.0% (0us) | Total: 0.0% (188us) | Samples: 0

**Called by:**
- `getMatchedLayers` (1)

**Calls:**
- `exec` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:31` | Self: 0.0% (0us) | Total: 0.0% (168us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async addDynamicMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:113` | Self: 0.0% (0us) | Total: 0.0% (287us) | Samples: 0

**Called by:**
- `async setModule` (1)

**Calls:**
- `async addDynamicMetadata` (1)

### `async createProxy`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:165` | Self: 0.0% (0us) | Total: 0.0% (200us) | Samples: 0

**Called by:**
- `async bindHandler` (1)

**Calls:**
- `bind` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:206` | Self: 0.0% (0us) | Total: 0.0% (569us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:46` | Self: 0.0% (0us) | Total: 0.0% (475us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:141` | Self: 0.0% (0us) | Total: 0.0% (215us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `setRoute`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:1031` | Self: 0.0% (0us) | Total: 0.4% (23.5ms) | Samples: 0

**Called by:**
- `registerVerb` (72)
- `flushPending` (10)
- `useMethod` (1)

**Calls:**
- `Route` (54)
- `Route` (15)
- `Route` (5)
- `Route` (3)
- `Route` (2)
- `Route` (2)
- `Route` (1)
- `Route` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:218` | Self: 0.0% (0us) | Total: 0.0% (533us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/from.js:4` | Self: 0.0% (0us) | Total: 0.1% (5.4ms) | Samples: 0

**Called by:**
- `anonymous` (17)

**Calls:**
- `bound require` (17)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js:10` | Self: 0.0% (0us) | Total: 0.0% (796us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:11` | Self: 0.0% (0us) | Total: 0.0% (270us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:11` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js:4` | Self: 0.0% (0us) | Total: 0.0% (4.1ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/innerFrom.js:59` | Self: 0.0% (0us) | Total: 0.0% (192us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/use-pipes.decorator.js:5` | Self: 0.0% (0us) | Total: 0.0% (355us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:34` | Self: 0.0% (0us) | Total: 0.0% (218us) | Samples: 0

**Called by:**
- `createCallbackProxy` (1)

**Calls:**
- `createGuardsFn` (1)

### `defineMetadata`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:244` | Self: 0.0% (0us) | Total: 0.0% (4.0ms) | Samples: 0

**Called by:**
- `copyMetadataToCallback` (9)

**Calls:**
- `OrdinaryDefineOwnMetadata` (6)
- `OrdinaryDefineOwnMetadata` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:44` | Self: 0.0% (0us) | Total: 0.0% (642us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/connectable.js:6` | Self: 0.0% (0us) | Total: 0.0% (463us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `#compileRouteRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:194` | Self: 0.0% (0us) | Total: 0.3% (16.2ms) | Samples: 0

**Called by:**
- `Route` (49)

**Calls:**
- `pathRegex` (23)
- `pathRegex` (4)
- `pathRegex` (3)
- `pathRegex` (2)
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

### `async register`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:38` | Self: 0.0% (0us) | Total: 0.0% (2.2ms) | Samples: 0

**Called by:**
- `async register` (11)

**Calls:**
- `async resolveMiddleware` (11)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/BehaviorSubject.js:50` | Self: 0.0% (0us) | Total: 0.0% (206us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:168` | Self: 0.0% (0us) | Total: 0.0% (999us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `getClassScope`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/get-class-scope.js:6` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `addController` (3)
- `isTransientProvider` (1)

**Calls:**
- `getMetadata` (4)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4930` | Self: 0.0% (0us) | Total: 0.0% (188us) | Samples: 0

**Called by:**
- `dispatch` (1)

**Calls:**
- `set` (1)

### `async registerRouteMiddleware`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:104` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `async registerMiddlewareConfig` (6)

**Calls:**
- `async registerRouteMiddleware` (4)
- `async registerRouteMiddleware` (1)
- `async registerRouteMiddleware` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/index.js:8` | Self: 0.0% (0us) | Total: 0.0% (758us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:138` | Self: 0.0% (0us) | Total: 2.0% (100.2ms) | Samples: 0

**Called by:**
- `forEach` (114)

**Calls:**
- `reflectDynamicMetadata` (47)
- `reflectDynamicMetadata` (33)
- `reflectDynamicMetadata` (17)
- `reflectDynamicMetadata` (9)
- `reflectDynamicMetadata` (8)

### `parseCookies`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts:3026` | Self: 0.0% (0us) | Total: 0.0% (250us) | Samples: 0

**Called by:**
- `BunRequest` (1)

**Calls:**
- `isBoolean` (1)

### `next`
`/home/user/bun-node/node_modules/iterare/lib/flatten.js:20` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Called by:**
- `next` (8)
- `from` (1)

**Calls:**
- `next` (6)
- `next` (2)
- `next` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:157` | Self: 0.0% (0us) | Total: 0.0% (556us) | Samples: 0

**Calls:**
- `getEffectiveResolutionContext` (1)
- `getEffectiveResolutionContext` (1)

### `register`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:31` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `registerWsModule` (5)

**Calls:**
- `forEach` (5)

### `async callModuleInitHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:32` | Self: 0.0% (0us) | Total: 0.0% (182us) | Samples: 0

**Called by:**
- `async callModuleInitHook` (1)

**Calls:**
- `filter` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:176` | Self: 0.0% (0us) | Total: 0.0% (797us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `candidates`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts:237` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `getMatchedLayers` (1)

**Calls:**
- `isDisjoint` (1)

### `async loadInstance`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:68` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `async loadInstance` (1)

**Calls:**
- `getNowTimestamp` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/enums/index.js:7` | Self: 0.0% (0us) | Total: 0.0% (403us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `RouterExplorer`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:44` | Self: 0.0% (0us) | Total: 0.0% (196us) | Samples: 0

**Called by:**
- `RoutesResolver` (1)

**Calls:**
- `RouterExecutionContext` (1)

### `WriteStream`
`internal:fs/streams:251` | Self: 0.0% (0us) | Total: 0.0% (262us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `writer` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js:10` | Self: 0.0% (0us) | Total: 0.0% (413us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `async callModuleBootstrapHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js:37` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `async callModuleBootstrapHook` (1)

**Calls:**
- `performIteration` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/parse-array.pipe.js:144` | Self: 0.0% (0us) | Total: 0.0% (219us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `__decorate` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:106` | Self: 0.0% (0us) | Total: 0.0% (214us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/negotiator/index.js:14` | Self: 0.0% (0us) | Total: 0.0% (648us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `async init`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:104` | Self: 0.0% (0us) | Total: 0.0% (2.3ms) | Samples: 0

**Calls:**
- `async registerRouter` (10)
- `async registerRouter` (1)

### `internal:streams/duplex`
`internal:streams/duplex:2` | Self: 0.0% (0us) | Total: 0.1% (5.8ms) | Samples: 0

**Called by:**
- `anonymous` (29)

**Calls:**
- `anonymous` (29)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/pipes/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (718us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:20` | Self: 0.0% (0us) | Total: 0.0% (456us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `optionalRequire` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js:37` | Self: 0.0% (0us) | Total: 0.0% (190us) | Samples: 0

**Called by:**
- `DecorateProperty` (1)

**Calls:**
- `assignMetadata` (1)

### `next`
`/home/user/bun-node/node_modules/iterare/lib/flatten.js:11` | Self: 0.0% (0us) | Total: 0.0% (201us) | Samples: 0

**Called by:**
- `from` (1)

**Calls:**
- `arrayIteratorNextHelper` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:51` | Self: 0.0% (0us) | Total: 0.0% (185us) | Samples: 0

**Called by:**
- `forEach` (1)

**Calls:**
- `log` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/http/index.js:6` | Self: 0.0% (0us) | Total: 0.0% (207us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async registerHandler`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:168` | Self: 0.0% (0us) | Total: 0.0% (644us) | Samples: 0

**Calls:**
- `async registerHandler` (3)

### `promisify2`
`internal:promisify:45` | Self: 0.0% (0us) | Total: 0.0% (293us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `defineCustomPromisify` (1)

### `applyProperties`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:411` | Self: 0.0% (0us) | Total: 0.0% (4.0ms) | Samples: 0

**Called by:**
- `async (anonymous)` (3)

**Calls:**
- `isObject` (3)

### `node:vm`
`node:vm:12` | Self: 0.0% (0us) | Total: 0.0% (3.1ms) | Samples: 0

**Calls:**
- `@lazy` (3)

### `RoutesResolver`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:22` | Self: 0.0% (0us) | Total: 0.0% (208us) | Samples: 0

**Called by:**
- `NestApplication` (1)

**Calls:**
- `getHttpAdapterRef` (1)

### `addController`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:327` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `addController` (5)

**Calls:**
- `getClassScope` (3)
- `getClassScope` (2)

### `node:fs/promises`
`node:fs/promises:137` | Self: 0.0% (0us) | Total: 0.0% (203us) | Samples: 0

**Calls:**
- `asyncWrap` (1)

### `InstanceWrapper`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js:22` | Self: 0.0% (0us) | Total: 0.1% (5.3ms) | Samples: 0

**Called by:**
- `loadPrototype` (12)
- `addController` (7)

**Calls:**
- `initialize` (14)
- `initialize` (3)
- `initialize` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:45` | Self: 0.0% (0us) | Total: 0.0% (714us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:124` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `#runPipeline`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:5122` | Self: 0.0% (0us) | Total: 7.0% (345.3ms) | Samples: 0

**Called by:**
- `#routeRequest` (547)

**Calls:**
- `#waitLayer` (857)
- `#waitLayer` (54)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:27` | Self: 0.0% (0us) | Total: 0.0% (214us) | Samples: 0

**Calls:**
- `__exportStar` (1)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts:36` | Self: 0.0% (0us) | Total: 0.0% (184us) | Samples: 0

**Calls:**
- `ie` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/iterare/lib/index.js:3` | Self: 0.0% (0us) | Total: 0.1% (5.9ms) | Samples: 0

**Called by:**
- `anonymous` (11)

**Calls:**
- `bound require` (11)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:32` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `(anonymous)` (3)
- `(anonymous)` (3)

**Calls:**
- `map` (6)

### `node:diagnostics_channel`
`node:diagnostics_channel:134` | Self: 0.0% (0us) | Total: 0.0% (223us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `WeakRefMap` (1)

### `createContext`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js:10` | Self: 0.0% (0us) | Total: 0.0% (816us) | Samples: 0

**Called by:**
- `create` (2)
- `create` (1)
- `create` (1)

**Calls:**
- `getMetadata` (3)
- `reflectMethodMetadata` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/serializer/index.js:3` | Self: 0.0% (0us) | Total: 0.0% (226us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:228` | Self: 0.0% (0us) | Total: 0.0% (234us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `createLogger`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts:299` | Self: 0.0% (0us) | Total: 0.0% (256us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `StructuredLogger` (1)

### `node:_http_outgoing`
`node:_http_outgoing:700` | Self: 0.0% (0us) | Total: 0.0% (878us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `deprecate` (1)

### `async addModule`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:72` | Self: 0.0% (0us) | Total: 0.3% (17.2ms) | Samples: 0

**Calls:**
- `async setModule` (3)

### `#routeRequest`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:415` | Self: 0.0% (0us) | Total: 0.0% (764us) | Samples: 0

**Called by:**
- `serveNativeRequest` (4)

**Calls:**
- `host` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/container.js:15` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `anonymous` (12)

**Calls:**
- `bound require` (12)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:5` | Self: 0.0% (0us) | Total: 0.1% (8.2ms) | Samples: 0

**Called by:**
- `anonymous` (14)

**Calls:**
- `bound require` (14)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:134` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (823us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `registerWsModule`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:92` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `async registerModules` (7)

**Calls:**
- `register` (5)
- `register` (1)
- `register` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:12` | Self: 0.0% (0us) | Total: 0.0% (732us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `internal:validators`
`internal:validators:2` | Self: 0.0% (0us) | Total: 0.0% (912us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `anonymous` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/native-functions/index.js:7` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/interceptors/index.js:4` | Self: 0.0% (0us) | Total: 0.0% (3.5ms) | Samples: 0

**Called by:**
- `anonymous` (13)

**Calls:**
- `bound require` (13)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js:92` | Self: 0.0% (0us) | Total: 0.0% (209us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `getMatchedLayers`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts:4793` | Self: 0.0% (0us) | Total: 0.1% (8.7ms) | Samples: 0

**Called by:**
- `dispatch` (19)

**Calls:**
- `candidates` (18)
- `candidates` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:5` | Self: 0.0% (0us) | Total: 0.0% (241us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `setup`
`/home/user/bun-node/node_modules/debug/src/common.js:17` | Self: 0.0% (0us) | Total: 0.0% (197us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `keys` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/index.js:10` | Self: 0.0% (0us) | Total: 0.0% (873us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js:7` | Self: 0.0% (0us) | Total: 0.0% (655us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/raceWith.js:25` | Self: 0.0% (0us) | Total: 0.0% (161us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `makeSafe`
`internal:primordials:32` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `ownKeys` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:38` | Self: 0.0% (0us) | Total: 0.0% (622us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:36` | Self: 0.0% (0us) | Total: 0.0% (193us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `node:_http_common`
`node:_http_common:62` | Self: 0.0% (0us) | Total: 0.0% (214us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `FreeList` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapScheduler.js:45` | Self: 0.0% (0us) | Total: 0.0% (424us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:91` | Self: 0.0% (0us) | Total: 0.0% (881us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `DecorateProperty`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:561` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `decorate` (5)

**Calls:**
- `(anonymous)` (2)
- `(anonymous)` (1)
- `decorator` (1)
- `decorator` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/index.js:3` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:220` | Self: 0.0% (0us) | Total: 0.0% (904us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `connectGatewayToServer`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:40` | Self: 0.0% (0us) | Total: 0.0% (493us) | Samples: 0

**Called by:**
- `forEach` (2)

**Calls:**
- `getMetadataKeys` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:42` | Self: 0.0% (0us) | Total: 0.1% (8.5ms) | Samples: 0

**Called by:**
- `anonymous` (42)

**Calls:**
- `populateMaps` (42)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:54` | Self: 0.0% (0us) | Total: 0.0% (1.8ms) | Samples: 0

**Called by:**
- `anonymous` (7)

**Calls:**
- `bound require` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/validation.pipe.js:5` | Self: 0.0% (0us) | Total: 0.1% (5.9ms) | Samples: 0

**Called by:**
- `anonymous` (11)

**Calls:**
- `bound require` (11)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:28` | Self: 0.0% (0us) | Total: 0.1% (7.0ms) | Samples: 0

**Calls:**
- `bound require` (29)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/parse-array.pipe.js:10` | Self: 0.0% (0us) | Total: 0.1% (6.6ms) | Samples: 0

**Called by:**
- `anonymous` (14)

**Calls:**
- `bound require` (14)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduled.js:5` | Self: 0.0% (0us) | Total: 0.0% (234us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `node:tty`
`node:tty:7` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `anonymous` (6)

### `register`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:27` | Self: 0.0% (0us) | Total: 0.0% (194us) | Samples: 0

**Called by:**
- `registerWsModule` (1)

**Calls:**
- `getContextCreator` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/exception-filters.decorator.js:5` | Self: 0.0% (0us) | Total: 0.0% (255us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/accepts/index.js:15` | Self: 0.0% (0us) | Total: 0.1% (9.2ms) | Samples: 0

**Calls:**
- `bound require` (15)

### `#compileMiddlewareRegExp`
`/home/user/bun-node/node_modules/@routejs/router/src/route.mjs:209` | Self: 0.0% (0us) | Total: 0.0% (845us) | Samples: 0

**Called by:**
- `Route` (3)

**Calls:**
- `pathRegex` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js:18` | Self: 0.0% (0us) | Total: 0.0% (455us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `ConsoleLogger` (1)
- `ConsoleLogger` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/async.js:6` | Self: 0.0% (0us) | Total: 0.0% (213us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `AsyncScheduler` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js:32` | Self: 0.0% (0us) | Total: 0.0% (405us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:42` | Self: 0.0% (0us) | Total: 0.0% (438us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/ArgumentOutOfRangeError.js:5` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `createErrorClass` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/joinAllInternals.js:7` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (6)

**Calls:**
- `bound require` (6)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js:19` | Self: 0.0% (0us) | Total: 0.0% (636us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:12` | Self: 0.0% (0us) | Total: 0.0% (498us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/queue.js:6` | Self: 0.0% (0us) | Total: 0.0% (230us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `QueueScheduler` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:23` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js:44` | Self: 0.0% (0us) | Total: 0.0% (198us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `stripEndSlash` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:20` | Self: 0.0% (0us) | Total: 0.0% (440us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:230` | Self: 0.0% (0us) | Total: 0.0% (790us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `internal:primordials`
`internal:primordials:76` | Self: 0.0% (0us) | Total: 0.0% (433us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `makeSafe` (1)
- `makeSafe` (1)

### `async init`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:107` | Self: 0.0% (0us) | Total: 0.0% (858us) | Samples: 0

**Calls:**
- `async callBootstrapHook` (4)

### `async loadMiddlewareConfiguration`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:42` | Self: 0.0% (0us) | Total: 0.0% (2.0ms) | Samples: 0

**Called by:**
- `map` (10)

**Calls:**
- `async (anonymous)` (9)
- `async (anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:7` | Self: 0.0% (0us) | Total: 0.0% (205us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async callModuleInitHook`
`/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js:43` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Called by:**
- `async callModuleInitHook` (6)

**Calls:**
- `from` (5)
- `callOperator` (1)

### `createErrorClass`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/createErrorClass.js:9` | Self: 0.0% (0us) | Total: 0.0% (950us) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/sampleTime.js:6` | Self: 0.0% (0us) | Total: 0.0% (214us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/QueueScheduler.js:17` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `defineProperty` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:131` | Self: 0.0% (0us) | Total: 0.0% (430us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/index.js:14` | Self: 0.0% (0us) | Total: 0.2% (10.3ms) | Samples: 0

**Calls:**
- `bound require` (37)
- `__exportStar` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:21` | Self: 0.0% (0us) | Total: 0.4% (23.4ms) | Samples: 0

**Calls:**
- `bound require` (84)

### `async registerRouterHooks`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:125` | Self: 0.0% (0us) | Total: 0.0% (209us) | Samples: 0

**Called by:**
- `async init` (1)

**Calls:**
- `registerExceptionHandler` (1)

### `create`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:33` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Called by:**
- `createCallbackProxy` (11)

**Calls:**
- `createContext` (3)
- `createContext` (3)
- `createContext` (2)
- `createContext` (1)
- `create` (1)
- `createContext` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/discovery/discovery-service.js:8` | Self: 0.0% (0us) | Total: 0.0% (452us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js:6` | Self: 0.0% (0us) | Total: 0.0% (202us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:75` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Called by:**
- `async registerAllConfigs` (7)

**Calls:**
- `async registerMiddlewareConfig` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/concat.js:4` | Self: 0.0% (0us) | Total: 0.0% (226us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/BehaviorSubject.js:21` | Self: 0.0% (0us) | Total: 0.0% (206us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:68` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js:7` | Self: 0.0% (0us) | Total: 0.0% (425us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/forbidden.exception.js:4` | Self: 0.0% (0us) | Total: 0.0% (280us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async loadConfiguration`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:69` | Self: 0.0% (0us) | Total: 0.0% (442us) | Samples: 0

**Calls:**
- `insertConfig` (1)
- `insertConfig` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js:7` | Self: 0.0% (0us) | Total: 0.0% (213us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `getEffectiveInquirer`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:526` | Self: 0.0% (0us) | Total: 0.0% (286us) | Samples: 0

**Called by:**
- `getEffectiveResolutionContext` (1)

**Calls:**
- `get isTransient` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js:10` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Called by:**
- `anonymous` (15)

**Calls:**
- `bound require` (15)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/repl/repl.js:9` | Self: 0.0% (0us) | Total: 0.0% (3.9ms) | Samples: 0

**Called by:**
- `anonymous` (17)

**Calls:**
- `bound require` (17)

### `connectAllGateways`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:34` | Self: 0.0% (0us) | Total: 0.0% (188us) | Samples: 0

**Called by:**
- `forEach` (1)

**Calls:**
- `iterate` (1)

### `async instantiateClass`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:422` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `async instantiateClass` (7)

**Calls:**
- `isInContext` (7)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` | Self: 0.0% (0us) | Total: 0.0% (198us) | Samples: 0

**Called by:**
- `async instantiateClass` (1)

**Calls:**
- `(unknown)` (1)

### `async registerRouter`
`/home/user/bun-node/node_modules/@nestjs/core/nest-application.js:118` | Self: 0.0% (0us) | Total: 0.0% (2.1ms) | Samples: 0

**Called by:**
- `async registerRouter` (10)

**Calls:**
- `async registerMiddleware` (10)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/discovery/discovery-module.js:7` | Self: 0.0% (0us) | Total: 0.5% (25.2ms) | Samples: 0

**Called by:**
- `anonymous` (105)

**Calls:**
- `bound require` (105)

### `(anonymous)`
`/home/user/bun-node/node_modules/type-is/index.js:17` | Self: 0.0% (0us) | Total: 0.0% (193us) | Samples: 0

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/sockets-container.js:4` | Self: 0.0% (0us) | Total: 0.0% (636us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/switchAll.js:4` | Self: 0.0% (0us) | Total: 0.0% (579us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/auditTime.js:4` | Self: 0.0% (0us) | Total: 0.1% (4.9ms) | Samples: 0

**Called by:**
- `anonymous` (9)

**Calls:**
- `bound require` (9)

### `node:events`
`node:events:10` | Self: 0.0% (0us) | Total: 0.0% (195us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:119` | Self: 0.0% (0us) | Total: 0.0% (216us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `async resolveComponentWrapper`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:250` | Self: 0.0% (0us) | Total: 0.0% (401us) | Samples: 0

**Called by:**
- `async resolveSingleParam` (2)

**Calls:**
- `async lookupComponent` (1)
- `async lookupComponent` (1)

### `getMetadataKeys`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:453` | Self: 0.0% (0us) | Total: 0.2% (10.2ms) | Samples: 0

**Called by:**
- `copyMetadataToCallback` (9)
- `connectGatewayToServer` (2)

**Calls:**
- `OrdinaryMetadataKeys` (8)
- `OrdinaryMetadataKeys` (2)
- `OrdinaryMetadataKeys` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:22` | Self: 0.0% (0us) | Total: 0.5% (29.2ms) | Samples: 0

**Calls:**
- `bound require` (116)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:12` | Self: 0.0% (0us) | Total: 0.0% (613us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/injectable.decorator.js:5` | Self: 0.0% (0us) | Total: 0.0% (602us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `OrdinaryOwnMetadataKeys`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:1081` | Self: 0.0% (0us) | Total: 0.0% (203us) | Samples: 0

**Called by:**
- `OrdinaryOwnMetadataKeys` (1)

**Calls:**
- `GetOrCreateMetadataMap` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:15` | Self: 0.0% (0us) | Total: 0.0% (336us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/websockets/socket-module.js:14` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `bound require` (8)

### `_preferredType`
`/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js:188` | Self: 0.0% (0us) | Total: 0.0% (189us) | Samples: 0

**Called by:**
- `forEachMimeType` (1)

**Calls:**
- `mimeScore` (1)

### `isTransientProvider`
`/home/user/bun-node/node_modules/@nestjs/core/injector/module.js:426` | Self: 0.0% (0us) | Total: 0.0% (342us) | Samples: 0

**Called by:**
- `addProvider` (1)

**Calls:**
- `getClassScope` (1)

### `filter`
`/home/user/bun-node/node_modules/iterare/lib/iterate.js:37` | Self: 0.0% (0us) | Total: 0.0% (608us) | Samples: 0

**Called by:**
- `applyProperties` (2)

**Calls:**
- `FilterIterator` (1)
- `FilterIterator` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/discovery/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (218us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapAction.js:20` | Self: 0.0% (0us) | Total: 0.0% (864us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `forRoutes`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js:55` | Self: 0.0% (0us) | Total: 0.0% (641us) | Samples: 0

**Called by:**
- `configure` (3)

**Calls:**
- `from` (2)
- `filterMiddleware` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter.js:8` | Self: 0.0% (0us) | Total: 0.0% (423us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(module)`
`/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts:25` | Self: 0.0% (0us) | Total: 0.0% (220us) | Samples: 0

**Calls:**
- `log` (1)

### `getMetadata`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js:58` | Self: 0.0% (0us) | Total: 0.0% (1.2ms) | Samples: 0

**Called by:**
- `create` (6)

**Calls:**
- `getArgumentsLength` (5)
- `getArgumentsLength` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js:9` | Self: 0.0% (0us) | Total: 0.1% (5.5ms) | Samples: 0

**Called by:**
- `anonymous` (11)

**Calls:**
- `bound require` (11)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/index.js:16` | Self: 0.0% (0us) | Total: 0.2% (10.6ms) | Samples: 0

**Calls:**
- `bound require` (44)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/pipes/validation.pipe.js:11` | Self: 0.0% (0us) | Total: 0.0% (434us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter.js:68` | Self: 0.0% (0us) | Total: 0.0% (264us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `__decorate` (1)

### `getAllMethodNames`
`/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js:64` | Self: 0.0% (0us) | Total: 0.0% (210us) | Samples: 0

**Called by:**
- `reflectInjectables` (1)

**Calls:**
- `has` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/race.js:26` | Self: 0.0% (0us) | Total: 0.0% (785us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (4)

### `deprecate`
`internal:util/deprecate:16` | Self: 0.0% (0us) | Total: 0.0% (624us) | Samples: 0

**Called by:**
- `node:crypto` (1)

**Calls:**
- `::bunternal::` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/index.js:23` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Calls:**
- `bound require` (5)
- `__exportStar` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/SequenceError.js:5` | Self: 0.0% (0us) | Total: 0.0% (276us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `createErrorClass` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/mergeInternals.js:5` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `set requestOpts`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:623` | Self: 0.0% (0us) | Total: 0.0% (264us) | Samples: 0

**Called by:**
- `BunHttpAdapter` (1)

**Calls:**
- `mergeBunRequestOptions` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:13` | Self: 0.0% (0us) | Total: 0.0% (277us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter-context.js:8` | Self: 0.0% (0us) | Total: 0.0% (862us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/busboy/lib/index.js:44` | Self: 0.0% (0us) | Total: 0.0% (189us) | Samples: 0

**Calls:**
- `filter` (1)

### `applyProperties`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:414` | Self: 0.0% (0us) | Total: 0.0% (198us) | Samples: 0

**Called by:**
- `async (anonymous)` (1)

**Calls:**
- `iterate` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/services/index.js:4` | Self: 0.0% (0us) | Total: 0.4% (20.5ms) | Samples: 0

**Called by:**
- `anonymous` (59)

**Calls:**
- `bound require` (59)

### `setProvider`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:971` | Self: 0.0% (0us) | Total: 0.0% (2.4ms) | Samples: 0

**Called by:**
- `GetMetadataProvider` (1)

**Calls:**
- `hasProvider` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/utils/load-package.util.js:4` | Self: 0.0% (0us) | Total: 0.0% (233us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:198` | Self: 0.0% (0us) | Total: 0.0% (691us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:144` | Self: 0.0% (0us) | Total: 0.0% (837us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/combineLatest.js:27` | Self: 0.0% (0us) | Total: 0.0% (501us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `(anonymous)`
`/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts:94` | Self: 0.0% (0us) | Total: 40.1% (1.96s) | Samples: 0

**Called by:**
- `(module)` (4947)

**Calls:**
- `serveNativeRequest` (3183)
- `serveNativeRequest` (1764)

### `QueueScheduler`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/QueueScheduler.js:23` | Self: 0.0% (0us) | Total: 0.0% (230us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `AsyncScheduler` (1)

### `async createProxy`
`/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js:164` | Self: 0.0% (0us) | Total: 0.0% (670us) | Samples: 0

**Called by:**
- `async bindHandler` (3)

**Calls:**
- `create` (2)
- `create` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/router/router-module.js:76` | Self: 0.0% (0us) | Total: 0.0% (222us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `__decorate` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:122` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:28` | Self: 0.0% (0us) | Total: 0.0% (213us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/onErrorResumeNext.js:4` | Self: 0.0% (0us) | Total: 0.0% (206us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `BunHttpAdapter`
`/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts:280` | Self: 0.0% (0us) | Total: 0.0% (554us) | Samples: 0

**Called by:**
- `async makeTarget` (2)

**Calls:**
- `BunNestWebsocketAdapter` (2)

### `getProviderNoCache`
`/home/user/bun-node/node_modules/reflect-metadata/Reflect.js:920` | Self: 0.0% (0us) | Total: 0.0% (851us) | Samples: 0

**Called by:**
- `getProvider` (2)

**Calls:**
- `isProviderFor` (2)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/core/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/discovery/discovery-service.js:7` | Self: 0.0% (0us) | Total: 0.4% (24.2ms) | Samples: 0

**Called by:**
- `anonymous` (101)

**Calls:**
- `bound require` (101)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/exceptions/index.js:17` | Self: 0.0% (0us) | Total: 0.0% (274us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js:105` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/modules/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (840us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js:25` | Self: 0.0% (0us) | Total: 0.0% (231us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/observable/bindCallback.js:4` | Self: 0.0% (0us) | Total: 0.0% (826us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `bound require` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:112` | Self: 0.0% (0us) | Total: 0.0% (414us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `bound require` (2)

### `getClassDependencies`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:185` | Self: 0.0% (0us) | Total: 0.1% (5.3ms) | Samples: 0

**Called by:**
- `async resolveConstructorParams` (8)

**Calls:**
- `reflectConstructorParams` (3)
- `reflectConstructorParams` (2)
- `from` (1)
- `reflectConstructorParams` (1)
- `reflectConstructorParams` (1)

### `async resolveProperties`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:348` | Self: 0.0% (0us) | Total: 0.0% (366us) | Samples: 0

**Called by:**
- `async resolveProperties` (2)

**Calls:**
- `getPropertiesMetadata` (2)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:40` | Self: 0.0% (0us) | Total: 0.0% (3.8ms) | Samples: 0

**Called by:**
- `async (anonymous)` (19)

**Calls:**
- `async createInstancesOfProviders` (19)

### `async (anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js:43` | Self: 0.0% (0us) | Total: 0.0% (203us) | Samples: 0

**Calls:**
- `get name` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/rxjs/dist/cjs/operators/index.js:26` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `bound require` (5)

### `define`
`/home/user/bun-node/node_modules/mime/dist/src/Mime.js:30` | Self: 0.0% (0us) | Total: 0.0% (288us) | Samples: 0

**Called by:**
- `Mime` (1)

**Calls:**
- `set` (1)

### `Module`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/modules/module.decorator.js:21` | Self: 0.0% (0us) | Total: 0.0% (522us) | Samples: 0

**Called by:**
- `(anonymous)` (1)
- `(anonymous)` (1)

**Calls:**
- `validateModuleKeys` (2)

### `async resolveConstructorParams`
`/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js:132` | Self: 0.0% (0us) | Total: 0.0% (596us) | Samples: 0

**Called by:**
- `async resolveConstructorParams` (3)

**Calls:**
- `Barrier` (3)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/core/scanner.js:7` | Self: 0.0% (0us) | Total: 0.0% (198us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `bound require` (1)

### `(anonymous)`
`/home/user/bun-node/node_modules/@nestjs/common/decorators/http/index.js:5` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `bound require` (3)
- `__exportStar` (1)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 31.8% | 1.55s | `[native code]` |
| 19.1% | 938.9ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRequest.ts` |
| 15.0% | 738.7ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunRouter.ts` |
| 7.3% | 361.1ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunHttpAdapter.ts` |
| 6.3% | 310.3ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunResponse.ts` |
| 3.9% | 191.7ms | `/home/user/bun-node/node_modules/@nestjs/core/router/router-execution-context.js` |
| 1.7% | 87.2ms | `/home/user/bun-node/node_modules/@nestjs/core/router/router-response-controller.js` |
| 1.6% | 82.1ms | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-consumer.js` |
| 1.5% | 77.6ms | `/home/user/bun-node/node_modules/@nestjs/core/router/router-proxy.js` |
| 1.3% | 68.5ms | `/home/user/bun-node/node_modules/@nestjs/core/scanner.js` |
| 1.3% | 63.9ms | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-utils.js` |
| 1.1% | 58.4ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/routeIndex.ts` |
| 1.0% | 52.3ms | `/home/user/bun-node/node_modules/reflect-metadata/Reflect.js` |
| 0.6% | 30.9ms | `/home/user/bun-node/node_modules/@nestjs/core/injector/injector.js` |
| 0.6% | 29.4ms | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/utils/native.ts` |
| 0.5% | 27.9ms | `/home/user/bun-node/node_modules/@nestjs/core/router/router-explorer.js` |
| 0.4% | 21.4ms | `/home/user/bun-node/node_modules/@nestjs/core/injector/module.js` |
| 0.2% | 13.8ms | `/home/user/bun-node/node_modules/@nestjs/core/helpers/handler-metadata-storage.js` |
| 0.2% | 13.0ms | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-wrapper.js` |
| 0.1% | 9.6ms | `/home/user/bun-node/node_modules/@nestjs/common/utils/shared.utils.js` |
| 0.1% | 9.2ms | `/home/user/bun-node/node_modules/@nestjs/core/router/route-path-factory.js` |
| 0.1% | 9.2ms | `/home/user/bun-node/docs/plans/evidence/elysia2/profile.ts` |
| 0.1% | 6.8ms | `/home/user/bun-node/node_modules/@routejs/router/src/path-regex.mjs` |
| 0.1% | 6.3ms | `/home/user/bun-node/node_modules/rxjs/dist/cjs/index.js` |
| 0.0% | 4.8ms | `node:zlib` |
| 0.0% | 4.7ms | `/home/user/bun-node/docs/plans/evidence/bun-native-routes/bench/servers.ts` |
| 0.0% | 4.5ms | `node:fs` |
| 0.0% | 4.4ms | `/home/user/bun-node/node_modules/tslib/tslib.js` |
| 0.0% | 4.2ms | `/home/user/bun-node/node_modules/@nestjs/core/pipes/pipes-context-creator.js` |
| 0.0% | 4.0ms | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/index.js` |
| 0.0% | 3.6ms | `/home/user/bun-node/node_modules/@routejs/router/src/route.mjs` |
| 0.0% | 3.5ms | `/home/user/bun-node/node_modules/@nestjs/core/router/routes-resolver.js` |
| 0.0% | 3.2ms | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/isObservable.js` |
| 0.0% | 3.0ms | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/transient-instances.js` |
| 0.0% | 2.8ms | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-creator.js` |
| 0.0% | 2.7ms | `/home/user/bun-node/node_modules/@nestjs/core/middleware/middleware-module.js` |
| 0.0% | 2.6ms | `/home/user/bun-node/docs/plans/evidence/elysia2/targets.ts` |
| 0.0% | 2.3ms | `/home/user/bun-node/node_modules/@nestjs/core/helpers/external-context-creator.js` |
| 0.0% | 2.2ms | `/home/user/bun-node/node_modules/@nestjs/core/injector/instance-loader.js` |
| 0.0% | 2.2ms | `/home/user/bun-node/node_modules/mime-types/index.js` |
| 0.0% | 2.2ms | `/home/user/bun-node/node_modules/@opensnip/lrujs/src/cache.mjs` |
| 0.0% | 2.2ms | `node:stream/web` |
| 0.0% | 2.1ms | `/home/user/bun-node/node_modules/@nestjs/core/injector/settlement-signal.js` |
| 0.0% | 2.1ms | `/home/user/bun-node/docs/plans/evidence/elysia2/nest-app.ts` |
| 0.0% | 2.0ms | `/home/user/bun-node/node_modules/@nestjs/core/interceptors/interceptors-context-creator.js` |
| 0.0% | 1.8ms | `/home/user/bun-node/node_modules/@nestjs/core/router/paths-explorer.js` |
| 0.0% | 1.8ms | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-module-init.hook.js` |
| 0.0% | 1.8ms | `/home/user/bun-node/node_modules/@nestjs/core/injector/container.js` |
| 0.0% | 1.8ms | `/home/user/bun-node/node_modules/iterare/lib/iterate.js` |
| 0.0% | 1.7ms | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter-context.js` |
| 0.0% | 1.7ms | `/home/user/bun-node/node_modules/iterare/lib/filter.js` |
| 0.0% | 1.6ms | `node:http` |
| 0.0% | 1.6ms | `/home/user/bun-node/node_modules/@nestjs/core/nest-application.js` |
| 0.0% | 1.6ms | `/home/user/bun-node/node_modules/@nestjs/core/metadata-scanner.js` |
| 0.0% | 1.3ms | `/home/user/bun-node/node_modules/@nestjs/core/adapters/http-adapter.js` |
| 0.0% | 1.3ms | `/home/user/bun-node/node_modules/type-is/node_modules/mime-types/mimeScore.js` |
| 0.0% | 1.3ms | `/home/user/bun-node/node_modules/@nestjs/common/services/logger.service.js` |
| 0.0% | 1.2ms | `/home/user/bun-node/node_modules/@nestjs/core/router/router-exception-filters.js` |
| 0.0% | 1.2ms | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/route-params.decorator.js` |
| 0.0% | 1.0ms | `/home/user/bun-node/node_modules/@nestjs/core/nest-application-context.js` |
| 0.0% | 1.0ms | `/home/user/bun-node/node_modules/@nestjs/core/guards/guards-context-creator.js` |
| 0.0% | 1.0ms | `/home/user/bun-node/node_modules/iterare/lib/map.js` |
| 0.0% | 1.0ms | `/home/user/bun-node/node_modules/mime/dist/src/Mime.js` |
| 0.0% | 878us | `internal:util/deprecate` |
| 0.0% | 806us | `/home/user/bun-node/node_modules/@nestjs/common/services/console-logger.service.js` |
| 0.0% | 801us | `/home/user/bun-node/node_modules/@nestjs/core/nest-factory.js` |
| 0.0% | 800us | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/request-mapping.decorator.js` |
| 0.0% | 742us | `internal:fs/streams` |
| 0.0% | 736us | `/home/user/bun-node/node_modules/picoquery/lib/parse.js` |
| 0.0% | 684us | `/home/user/bun-node/node_modules/@nestjs/core/discovery/discoverable-meta-host-collection.js` |
| 0.0% | 662us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncScheduler.js` |
| 0.0% | 644us | `/home/user/bun-node/node_modules/@nestjs/core/middleware/route-info-path-extractor.js` |
| 0.0% | 624us | `internal:validators` |
| 0.0% | 620us | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/base-exception-filter-context.js` |
| 0.0% | 615us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subject.js` |
| 0.0% | 596us | `/home/user/bun-node/node_modules/@nestjs/core/helpers/barrier.js` |
| 0.0% | 593us | `internal:streams/destroy` |
| 0.0% | 554us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/ReplaySubject.js` |
| 0.0% | 549us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/QueueAction.js` |
| 0.0% | 513us | `/home/user/bun-node/node_modules/debug/src/node.js` |
| 0.0% | 505us | `/home/user/bun-node/node_modules/token-types/lib/index.js` |
| 0.0% | 480us | `/home/user/bun-node/node_modules/mime/dist/types/other.js` |
| 0.0% | 472us | `/home/user/bun-node/node_modules/supports-color/index.js` |
| 0.0% | 453us | `node:events` |
| 0.0% | 446us | `/home/user/bun-node/node_modules/@nestjs/core/helpers/get-class-scope.js` |
| 0.0% | 434us | `node:_http_agent` |
| 0.0% | 433us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Subscriber.js` |
| 0.0% | 427us | `internal:primordials` |
| 0.0% | 424us | `/home/user/bun-node/node_modules/@nestjs/core/middleware/resolver.js` |
| 0.0% | 424us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapScheduler.js` |
| 0.0% | 423us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Observable.js` |
| 0.0% | 421us | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/exceptions-handler.js` |
| 0.0% | 419us | `/home/user/bun-node/node_modules/iterare/lib/flatten.js` |
| 0.0% | 419us | `/home/user/bun-node/node_modules/@nestjs/core/inspector/uuid-factory.js` |
| 0.0% | 416us | `internal:util/inspect` |
| 0.0% | 414us | `/home/user/bun-node/node_modules/@nestjs/core/middleware/utils.js` |
| 0.0% | 401us | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/optional.decorator.js` |
| 0.0% | 393us | `node:diagnostics_channel` |
| 0.0% | 387us | `node:crypto` |
| 0.0% | 386us | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/invalid-class.exception.js` |
| 0.0% | 358us | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/unknown-export.exception.js` |
| 0.0% | 333us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/skip.js` |
| 0.0% | 329us | `/home/user/bun-node/node_modules/busboy/lib/types/urlencoded.js` |
| 0.0% | 313us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/AsyncSubject.js` |
| 0.0% | 294us | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/undefined-dependency.exception.js` |
| 0.0% | 294us | `internal:streams/legacy` |
| 0.0% | 293us | `internal:promisify` |
| 0.0% | 292us | `/home/user/bun-node/node_modules/@nestjs/common/serializer/class-serializer.interceptor.js` |
| 0.0% | 288us | `/home/user/bun-node/node_modules/@nestjs/common/enums/request-method.enum.js` |
| 0.0% | 286us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsapAction.js` |
| 0.0% | 282us | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-nest/lib/BunWebSocketAdapter.ts` |
| 0.0% | 277us | `/home/user/bun-node/node_modules/@nestjs/core/injector/opaque-key-factory/by-reference-module-opaque-key-factory.js` |
| 0.0% | 276us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AsyncAction.js` |
| 0.0% | 276us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/SequenceError.js` |
| 0.0% | 276us | `/home/user/bun-node/node_modules/@nestjs/common/decorators/http/redirect.decorator.js` |
| 0.0% | 275us | `/home/user/bun-node/node_modules/uint8array-extras/index.js` |
| 0.0% | 272us | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunWebSocket.ts` |
| 0.0% | 270us | `/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/lib/index.js` |
| 0.0% | 268us | `/home/user/bun-node/node_modules/@nestjs/websockets/sockets-container.js` |
| 0.0% | 266us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/VirtualTimeScheduler.js` |
| 0.0% | 266us | `/home/user/bun-node/node_modules/picoquery/lib/string-util.js` |
| 0.0% | 265us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/timeInterval.js` |
| 0.0% | 265us | `/home/user/bun-node/node_modules/@nestjs/core/injector/internal-core-module/internal-core-module-factory.js` |
| 0.0% | 256us | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/logging.ts` |
| 0.0% | 254us | `internal:streams/writable` |
| 0.0% | 252us | `/home/user/bun-node/node_modules/@nestjs/core/injector/helpers/silent-logger.js` |
| 0.0% | 250us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/last.js` |
| 0.0% | 246us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/NotFoundError.js` |
| 0.0% | 243us | `/home/user/bun-node/node_modules/mime/dist/types/standard.js` |
| 0.0% | 243us | `/home/user/bun-node/node_modules/@nestjs/core/discovery/index.js` |
| 0.0% | 238us | `/tmp/claude-0/-home-user-bun-node/6c01be33-e7f8-588b-9c17-de74e928191d/scratchpad/snap/packages/bun-common/lib/BunHttpAdapter.ts` |
| 0.0% | 237us | `/home/user/bun-node/node_modules/@nestjs/core/injector/opaque-key-factory/deep-hashed-module-opaque-key-factory.js` |
| 0.0% | 235us | `/home/user/bun-node/node_modules/@nestjs/core/exceptions/external-exception-filter.js` |
| 0.0% | 232us | `/home/user/bun-node/node_modules/@tokenizer/inflate/node_modules/token-types/node_modules/@borewit/text-codec/lib/index.js` |
| 0.0% | 231us | `/home/user/bun-node/node_modules/@nestjs/core/router/sse-stream.js` |
| 0.0% | 230us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Notification.js` |
| 0.0% | 228us | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/runtime.exception.js` |
| 0.0% | 228us | `/home/user/bun-node/node_modules/@nestjs/core/injector/compiler.js` |
| 0.0% | 227us | `/home/user/bun-node/node_modules/@nestjs/common/pipes/parse-float.pipe.js` |
| 0.0% | 227us | `/home/user/bun-node/node_modules/iterare/lib/utils.js` |
| 0.0% | 227us | `/home/user/bun-node/node_modules/@nestjs/common/utils/validate-module-keys.util.js` |
| 0.0% | 226us | `internal:streams/readable` |
| 0.0% | 225us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduler/AnimationFrameScheduler.js` |
| 0.0% | 218us | `/home/user/bun-node/node_modules/@nestjs/websockets/gateway-metadata-explorer.js` |
| 0.0% | 217us | `/home/user/bun-node/node_modules/@nestjs/common/utils/cli-colors.util.js` |
| 0.0% | 215us | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-bootstrap.hook.js` |
| 0.0% | 215us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/EmptyError.js` |
| 0.0% | 214us | `internal:freelist` |
| 0.0% | 214us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/scheduled/scheduleIterable.js` |
| 0.0% | 213us | `/home/user/bun-node/node_modules/@nestjs/core/helpers/context-id-factory.js` |
| 0.0% | 213us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/Scheduler.js` |
| 0.0% | 213us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/util/UnsubscriptionError.js` |
| 0.0% | 212us | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/modules/injection-token.interface.js` |
| 0.0% | 212us | `internal:shared` |
| 0.0% | 211us | `node:_http_client` |
| 0.0% | 211us | `internal:http` |
| 0.0% | 207us | `node:async_hooks` |
| 0.0% | 206us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/BehaviorSubject.js` |
| 0.0% | 205us | `node:_http_common` |
| 0.0% | 204us | `/home/user/bun-node/node_modules/debug/src/common.js` |
| 0.0% | 203us | `node:fs/promises` |
| 0.0% | 201us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/publish.js` |
| 0.0% | 201us | `/home/user/bun-node/node_modules/@nestjs/common/interfaces/index.js` |
| 0.0% | 199us | `/home/user/bun-node/node_modules/@nestjs/core/hooks/on-app-shutdown.hook.js` |
| 0.0% | 197us | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions/unknown-dependencies.exception.js` |
| 0.0% | 196us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/max.js` |
| 0.0% | 195us | `/home/user/bun-node/node_modules/rxjs/dist/cjs/internal/operators/delay.js` |
| 0.0% | 195us | `/home/user/bun-node/node_modules/@nestjs/common/decorators/core/controller.decorator.js` |
| 0.0% | 194us | `/home/user/bun-node/node_modules/@nestjs/common/decorators/modules/module.decorator.js` |
| 0.0% | 193us | `/home/user/bun-node/node_modules/@nestjs/core/router/request/index.js` |
| 0.0% | 192us | `/home/user/bun-node/node_modules/@nestjs/core/application-config.js` |
| 0.0% | 191us | `/home/user/bun-node/node_modules/@nestjs/core/errors/exceptions-zone.js` |
| 0.0% | 190us | `/home/user/bun-node/node_modules/uid/dist/index.js` |
| 0.0% | 189us | `/home/user/bun-node/node_modules/@nestjs/core/middleware/builder.js` |
| 0.0% | 188us | `internal:streams/utils` |
| 0.0% | 187us | `node:url` |
| 0.0% | 186us | `bun:wrap` |
| 0.0% | 185us | `node:util` |
| 0.0% | 142us | `node:path` |
