/**
 * `cacheLiveBus` from `@kingsleyweb/bun-nest/cache`: the re-export is
 * bun-cache's own function, and the bus it makes carries a live publish
 * (`publishTags()`, which `@Invalidates` calls) onto the bun-cache bus.
 * That bun-cache stays off the package root is `packaging.test.ts`'s
 * (the `./cache` entry's `peers`).
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { BusMessage, CacheBus } from "@kingsleyweb/bun-cache";
import * as fromCache from "@kingsleyweb/bun-cache/live";
import { connectLiveBus, publishTags } from "@kingsleyweb/bun-common/live";
import { resetLiveBus } from "@kingsleyweb/bun-common/lib/live/bus";
import { cacheLiveBus, DEFAULT_LIVE_NAMESPACE } from "../lib/cache/index";

afterEach(async () => {
  await resetLiveBus();
});

describe("cacheLiveBus from ./cache", () => {
  it("is bun-cache's own", () => {
    expect(cacheLiveBus).toBe(fromCache.cacheLiveBus);
    expect(DEFAULT_LIVE_NAMESPACE).toBe(fromCache.DEFAULT_LIVE_NAMESPACE);
  });

  it("carries a live publish onto the bun-cache bus", async () => {
    const published: BusMessage[] = [];
    const bus: CacheBus = {
      name: "scripted",
      publish: async (message) => {
        published.push(message);
      },
      subscribe: async () => async () => {},
      close: async () => {},
    };
    const connection = connectLiveBus(cacheLiveBus(bus));
    await connection.ready;
    publishTags(["user:1"]);
    for (let i = 0; i < 100 && published.length === 0; i++) await Bun.sleep(5);
    expect(published).toEqual([
      expect.objectContaining({
        type: "invalidate-tags",
        namespace: DEFAULT_LIVE_NAMESPACE,
        tags: ["user:1"],
      }),
    ]);
    await connection.close();
  });
});
