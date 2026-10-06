import type { ConformanceOptions } from "../../lib/provider/testing/index";
import { localCompute } from "../../lib/provider/index";
import {
  CONFORMANCE_WORKER,
  fakePlatform,
  runProviderConformance,
} from "../../lib/provider/testing/index";

/**
 * `ConformanceOptions.platform` is required: a fake, or `"none"` for a
 * self-hosted provider. Forgetting it must not compile, since a run without
 * a fake would otherwise pass with the fake's checks quietly skipped.
 * Checked by the tests typecheck, not `bun test`.
 */

const config = { entry: CONFORMANCE_WORKER };

export async function compiles(): Promise<void> {
  await runProviderConformance(localCompute, { config, platform: "none" });
  const platform = await fakePlatform({});
  await runProviderConformance(localCompute, { config, platform });
}

export async function refuses(): Promise<void> {
  // @ts-expect-error platform is required: a fake, or "none"
  await runProviderConformance(localCompute, { config });
  // @ts-expect-error only "none" stands for no platform
  await runProviderConformance(localCompute, { config, platform: "local" });
}

// @ts-expect-error a ConformanceOptions without platform is incomplete
export const _missing: ConformanceOptions = { config };
