/**
 * `cacheResponse()` over a cache with `encrypt` and `hashNames` (the
 * encryption plan's §9.4): the HTTP layer needs no change — its keys (the
 * method, host, path, query and `Vary` values) and its tags reach the store
 * only as keyed hashes, and a hit, a tag invalidation and a `Vary` split work
 * as on a plain cache.
 */
import { Buffer } from "node:buffer";
import { describe, expect, test } from "bun:test";
import { BunRouter } from "@kingsleyweb/bun-common";
import { createCache, memoryDriver } from "../../lib/index";
import { memoryDriverDump } from "../../lib/drivers/memory";
import { addCacheTags, cacheResponse } from "../../lib/http/index";
import { nextSet } from "./helpers";

/** Whether any chunk of a memory driver's dump holds `text` (UTF-8). */
function stored(dump: readonly (string | Uint8Array)[], text: string): boolean {
  const needle = Buffer.from(text);
  return dump.some((chunk) => Buffer.from(chunk).includes(needle));
}

describe("cacheResponse on a hashed, encrypted cache", () => {
  test("a hit, a Vary split and a tag invalidation, with no URL, query, header value or tag in the store", async () => {
    const driver = memoryDriver();
    const cache = createCache({
      driver,
      namespace: "pages",
      sweepInterval: 0,
      encrypt: {
        keys: [{ id: "k1", key: new Uint8Array(32).fill(1) }],
        hashNames: { key: new Uint8Array(32).fill(2) },
      },
    });
    const router = new BunRouter();
    let runs = 0;
    router.get(
      "/accounts/:id/statement",
      cacheResponse(cache, { ttl: 60_000, varyBy: ["x-tenant-secret"] }),
      (req, res) => {
        runs++;
        addCacheTags(res, `account-secret-${String(req.params.id)}`);
        res.send(`statement ${runs}`);
      },
    );
    const get = async (tenant: string): Promise<Response> =>
      await router.fetch(
        new Request(
          "http://localhost/accounts/4242/statement?month=secret-may",
          {
            headers: { "x-tenant-secret": tenant },
          },
        ),
      );

    let written = nextSet(cache);
    expect(await (await get("tenant-acme")).text()).toBe("statement 1");
    await written;
    const hit = await get("tenant-acme");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("statement 1");
    written = nextSet(cache);
    expect(await (await get("tenant-zeta")).text()).toBe("statement 2");
    await written;

    const dump = memoryDriverDump(driver);
    for (const secret of [
      "/accounts/4242/statement",
      "secret-may",
      "tenant-acme",
      "tenant-zeta",
      "account-secret-4242",
      "statement 1",
      "pages",
    ]) {
      expect(stored(dump, secret), secret).toBe(false);
    }

    await cache.invalidateTags(["account-secret-4242"]);
    expect(await (await get("tenant-acme")).text()).toBe("statement 3");
    expect(runs).toBe(3);
    await cache.close();
  });
});
