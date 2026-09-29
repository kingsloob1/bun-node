/**
 * `bun test --preload` this to run the packages' own test files against the
 * prototype adapters, unmodified: it swaps `BunHttpAdapter` in both
 * packages' modules for `withNativeRoutes(BunHttpAdapter)`. `BNR_NATIVE` and
 * `BNR_SERVED` (see ../adapter.ts) choose the mode; run-tests.ts drives the
 * three modes and diffs them.
 */
import { mock } from "bun:test";
import { resolve } from "node:path";
import { withNativeRoutes } from "../adapter";

const root = resolve(import.meta.dir, "../../../../../../packages");

// BNR_INDEX=1: every BunRouter the tests construct, and every prototype
// adapter's router, gets the JS candidate index (../candidate-index.ts).
if (process.env.BNR_INDEX === "1") {
  const { installCandidateIndex, installRingCache } = await import("../candidate-index");
  const routerFile = `${root}/bun-common/lib/BunRouter.ts`;
  const routerModule = await import(routerFile);
  class IndexedRouter extends routerModule.BunRouter {
    constructor(...args: unknown[]) {
      super(...(args as []));
      installCandidateIndex(this as never);
      if (process.env.BNR_RINGCACHE === "1") installRingCache(this as never);
    }
  }
  mock.module(routerFile, () => ({ ...routerModule, BunRouter: IndexedRouter }));
}
const commonFile = `${root}/bun-common/lib/BunHttpAdapter.ts`;
const commonIndex = `${root}/bun-common/lib/index.ts`;
const common = await import(commonFile);
const commonBarrel = await import(commonIndex);
const CommonProto = withNativeRoutes(common.BunHttpAdapter);
mock.module(commonFile, () => ({ ...common, BunHttpAdapter: CommonProto }));
mock.module(commonIndex, () => ({ ...commonBarrel, BunHttpAdapter: CommonProto }));

if (process.env.BNR_NEST === "1") {
  const nestFile = `${root}/bun-nest/lib/BunHttpAdapter.ts`;
  const nestIndex = `${root}/bun-nest/lib/index.ts`;
  const nest = await import(nestFile);
  const nestBarrel = await import(nestIndex);
  const NestProto = withNativeRoutes(nest.BunHttpAdapter);
  mock.module(nestFile, () => ({ ...nest, BunHttpAdapter: NestProto, BunNestHttpAdapter: NestProto }));
  mock.module(nestIndex, () => ({ ...nestBarrel, BunHttpAdapter: NestProto, BunNestHttpAdapter: NestProto }));
}
(globalThis as { __bnrProto?: boolean }).__bnrProto = true;

// How many requests each path took — proof the native table was exercised.
if (process.env.BNR_STATS) {
  const { nativeStats } = await import("../native-routes");
  const { indexStats } = await import("../candidate-index");
  const { afterAll } = await import("bun:test");
  const { writeFileSync } = await import("node:fs");
  afterAll(() => writeFileSync(process.env.BNR_STATS!, JSON.stringify({ nativeStats, indexStats })));
}
