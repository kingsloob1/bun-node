/**
 * Shared helpers for the bun-cache tests: a cache on the memory driver with a
 * fake clock, and a hand-rolled Standard Schema for the V10 tests (a real
 * vendor — zod — is covered in `validate.test.ts`).
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { CreateCacheOptions } from "../lib/index";
import { createCache, memoryDriver } from "../lib/index";
import type { FakeClock } from "../lib/testing/index";
import { fakeClock } from "../lib/testing/index";

/** A cache on a fresh memory driver, both on one fake clock, with the sweeper off (tests drive it by hand). */
export function makeCache(options: Omit<CreateCacheOptions, "driver"> = {}): {
  /** The cache. */
  cache: ReturnType<typeof createCache>;
  /** The shared fake clock. */
  clock: FakeClock;
} {
  const clock = fakeClock();
  const cache = createCache({
    driver: memoryDriver({ now: clock.now }),
    sweepInterval: 0,
    ...options,
    now: clock.now,
  });
  return { cache, clock };
}

/** A synchronous Standard Schema that fails with `message` when `check` says so. */
export function testSchema(
  check: (value: unknown) => string | undefined,
): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "bun-cache-test",
      validate: (value: unknown) => {
        const problem = check(value);
        return problem === undefined
          ? { value }
          : { issues: [{ message: problem }] };
      },
    },
  } as StandardSchemaV1;
}

/** The same, but async — the vendor-returns-a-Promise path (yup's shape). */
export function testSchemaAsync(
  check: (value: unknown) => string | undefined,
): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "bun-cache-test-async",
      validate: async (value: unknown) => {
        const problem = check(value);
        return await (problem === undefined
          ? Promise.resolve({ value })
          : Promise.resolve({ issues: [{ message: problem }] }));
      },
    },
  } as StandardSchemaV1;
}
