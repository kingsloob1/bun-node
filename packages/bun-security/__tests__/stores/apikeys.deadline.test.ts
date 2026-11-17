/**
 * Why `apikeys.multiprocess.test.ts` gives its shared store a 5 s deadline:
 * the many-addresses check counts addresses in the shared store, and a call
 * past the store's per-call deadline falls back to the process's own count
 * (`onStoreError: "local"`), which never sees the whole fleet's traffic. A
 * loaded machine pushed a Postgres call past the default 50 ms once, and the
 * sixth address was let through. Here three engines in one process stand in
 * for three processes (each counts locally on its own), over one shared
 * store whose `pfAdd` takes 30 ms: with a 5 ms deadline the anomaly is never
 * found (the failure, reproduced), with 5 s it is (the fix).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import type { CacheDriver } from "@kingsleyweb/bun-cache";
import { createSecurity } from "../../lib/index";
import type { Security, SecurityPolicy } from "../../lib/index";
import { cacheStore } from "../../lib/stores/index";
import { facts } from "../helpers";

const POLICY: SecurityPolicy = {
  apiKeys: { manyAddresses: { limit: 5, window: "1h", action: "ban" } },
};

/** What to close after the file. */
const opened: { close: () => unknown }[] = [];
afterAll(async () => {
  for (const each of opened.splice(0).reverse()) await each.close();
});

/** A memory driver whose `pfAdd` answers `delay` ms late: a slow backend. */
function slowDriver(delay: number): CacheDriver {
  const driver = memoryDriver();
  const pfAdd = driver.pfAdd?.bind(driver);
  if (pfAdd === undefined) throw new Error("the memory driver has no pfAdd");
  return Object.assign(driver, {
    pfAdd: async (...args: Parameters<typeof pfAdd>) => {
      await Bun.sleep(delay);
      return await pfAdd(...args);
    },
  });
}

/** Three engines sharing one store on `driver`, with the store's per-call deadline. */
function fleet(
  driver: CacheDriver,
  timeout: `${number}ms` | `${number}s`,
): Security[] {
  return [0, 1, 2].map(() => {
    const store = cacheStore(createCache({ driver, logger: () => {} }), {
      timeout,
      logger: () => {},
    });
    const security = createSecurity({
      secret: "the-deadline-test-secret-of-32-bytes!",
      policy: POLICY,
      store,
      logger: () => {},
    });
    opened.push(store, { close: () => security.close() });
    return security;
  });
}

/** One key from seven addresses, round-robin over the engines; the actions. */
async function drive(engines: readonly Security[]): Promise<string[]> {
  const actions: string[] = [];
  for (let i = 0; i < 7; i++) {
    const decision = await engines[i % engines.length]!.evaluate(
      facts({
        client: `45.7.0.${i + 1}`,
        path: "/api/orders",
        rawPath: "/api/orders",
        routeKey: "GET /api/orders",
        identity: { apiKey: "key_fleet" },
      }),
    );
    actions.push(decision.action);
  }
  return actions;
}

describe("the shared store's deadline and the many-addresses check", () => {
  it("past the deadline each engine counts on its own, and the sixth address is let through (the failure)", async () => {
    const engines = fleet(slowDriver(30), "5ms");
    for (const engine of engines) await engine.ready();
    expect(await drive(engines)).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
      "allow",
      "allow",
      "allow",
    ]);
  });

  it("with room, the shared count finds it from the sixth address (the fix)", async () => {
    const engines = fleet(slowDriver(30), "5s");
    for (const engine of engines) await engine.ready();
    const actions = await drive(engines);
    expect(actions.slice(0, 5)).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
      "allow",
    ]);
    expect(actions[5]).toBe("ban");
  });
});
