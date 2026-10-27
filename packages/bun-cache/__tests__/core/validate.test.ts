/**
 * V10 (bun-validate): `createCache({ validate: { "user:*": UserSchema } })`
 * checks values on read; a failing value is a miss plus an `error` event
 * whose issues target `"cache"` (plan §3.13). Tested against a hand-rolled
 * Standard Schema, an async one, and a real vendor (zod).
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { CacheEventMap } from "../../lib/index";
import { createCache, memoryDriver } from "../../lib/index";
import { makeCache, testSchema, testSchemaAsync } from "../helpers";

/** The error events a cache fired. */
function collectErrors(
  cache: ReturnType<typeof createCache>,
): CacheEventMap["error"][] {
  const events: CacheEventMap["error"][] = [];
  cache.on("error", (event) => {
    events.push(event);
  });
  return events;
}

describe("validate (V10)", () => {
  test("a passing read returns the value", async () => {
    const { cache } = makeCache({
      validate: {
        "user:*": testSchema((value) =>
          typeof (value as { name?: unknown })?.name === "string"
            ? undefined
            : "name must be a string",
        ),
      },
    });
    await cache.set("user:42", { name: "Ada" });
    expect(await cache.get("user:42")).toEqual({ name: "Ada" });
    await cache.close();
  });

  test("a failing read is a miss plus an error event with value-free issues targeting cache", async () => {
    const { cache, clock } = makeCache({
      validate: {
        "user:*": testSchema(() => "the stored shape is from an older deploy"),
      },
    });
    const errors = collectErrors(cache);
    await cache.set("user:42", { secretField: "s3cr3t-value" });
    expect(await cache.get("user:42")).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].phase).toBe("validate");
    expect(errors[0].key).toBe("user:42");
    expect(errors[0].issues).toHaveLength(1);
    for (const issue of errors[0].issues ?? []) {
      expect(issue.target).toBe("cache");
    }
    // The event is value-free: the stored value appears nowhere in it.
    expect(JSON.stringify(errors[0])).not.toContain("s3cr3t-value");
    // The failing entry was deleted: it does not fail again.
    expect(errors).toHaveLength(1);
    expect(await cache.get("user:42")).toBeUndefined();
    expect(errors).toHaveLength(1);
    void clock;
    await cache.close();
  });

  test("a key matching no pattern is not checked", async () => {
    const { cache } = makeCache({
      validate: { "user:*": testSchema(() => "never valid") },
    });
    const errors = collectErrors(cache);
    await cache.set("session:9", { anything: true });
    expect(await cache.get("session:9")).toEqual({ anything: true });
    expect(errors).toHaveLength(0);
    await cache.close();
  });

  test("an async vendor is awaited", async () => {
    const { cache } = makeCache({
      validate: { "user:*": testSchemaAsync(() => "never valid") },
    });
    await cache.set("user:1", { name: "x" });
    expect(await cache.get("user:1")).toBeUndefined();
    await cache.close();
  });

  test("the schema's output is what a read returns (defaults and transforms apply)", async () => {
    const { cache } = makeCache({
      validate: {
        "user:*": z.object({
          name: z.string(),
          role: z.string().default("member"),
        }),
      },
    });
    // An older deploy wrote entries without `role`.
    await cache.set("user:7", { name: "Ada" } as unknown as Record<
      string,
      unknown
    >);
    expect(await cache.get("user:7")).toEqual({ name: "Ada", role: "member" });
    await cache.close();
  });

  test("a real vendor: zod, failing and passing", async () => {
    const { cache } = makeCache({
      validate: {
        "user:*": z.object({ name: z.string() }),
      },
    });
    const errors = collectErrors(cache);
    await cache.set("user:good", { name: "Ada" });
    await cache.set("user:bad", { name: 42 } as unknown as Record<
      string,
      unknown
    >);
    expect(await cache.get("user:good")).toEqual({ name: "Ada" });
    expect(await cache.get("user:bad")).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].issues?.[0]?.target).toBe("cache");
    expect(errors[0].issues?.[0]?.path).toBe("name");
    await cache.close();
  });

  test("an exact-key pattern matches only that key", async () => {
    const { cache } = makeCache({
      validate: { config: testSchema(() => "never valid") },
    });
    await cache.set("config", { dark: true });
    await cache.set("config:extra", { dark: true });
    expect(await cache.get("config")).toBeUndefined();
    expect(await cache.get("config:extra")).toEqual({ dark: true });
    await cache.close();
  });

  test("validate composes with getOrSet: the loaded value is checked on the next read", async () => {
    const { cache } = makeCache({
      validate: {
        "user:*": testSchema((v) => (typeof v === "string" ? undefined : "no")),
      },
    });
    expect(await cache.getOrSet("user:1", async () => "fine")).toBe("fine");
    expect(await cache.get("user:1")).toBe("fine");
    await cache.close();
  });
});

describe("validate: driver independence", () => {
  test("the check runs the same on a second cache over the same driver", async () => {
    const driver = memoryDriver();
    const writer = createCache({ driver, sweepInterval: 0 });
    await writer.set("user:1", { name: 42 });
    const reader = createCache({
      driver,
      sweepInterval: 0,
      validate: { "user:*": z.object({ name: z.string() }) },
    });
    expect(await reader.get("user:1")).toBeUndefined();
    await writer.close();
  });
});
