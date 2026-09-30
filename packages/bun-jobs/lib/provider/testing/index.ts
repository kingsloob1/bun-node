/**
 * The compute provider conformance kit (`./provider/testing`): tests a
 * provider's summon facet with no cloud credentials, against a fake of its
 * platform (plugins §12, summon only).
 *
 * ```ts
 * import { assertConformance, fakePlatform, runProviderConformance } from "@kingsleyweb/bun-jobs/provider/testing";
 *
 * test("conforms", async () => {
 *   const platform = await fakePlatform({ "POST /v1/runs": async (request, state) => { … } });
 *   try {
 *     assertConformance(await runProviderConformance(acme, { config: { url: platform.url, apiToken: "…" }, platform }));
 *   } finally {
 *     await platform.close();
 *   }
 * });
 * ```
 *
 * Framework-agnostic: it imports no test runner. Passing means the provider
 * behaves correctly against its own fake; it does not mean the platform
 * behaves as the fake does, nor that bun-jobs has reviewed the provider.
 */
export { type ConformanceOptions, runProviderConformance } from "./conformance";
export {
  type FakeFault,
  type FakePlatform,
  fakePlatform,
  type FakePlatformOptions,
  type FakePlatformState,
  type FakeRoute,
  type FakeUnit,
  type FakeUnitStart,
} from "./fake";
export {
  assertConformance,
  type ConformanceCheck,
  type ConformanceReport,
} from "./report";
