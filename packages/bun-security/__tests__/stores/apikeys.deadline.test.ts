/**
 * The distinct counts' own deadline (`cacheStore`'s `distinctTimeout`): the
 * many-addresses check counts addresses in the shared store, and a call past
 * the deadline falls back to the process's own count (`onStoreError:
 * "local"`), which never sees the whole fleet's traffic. A loaded machine
 * pushed a Postgres call past the general 50 ms once, and the sixth address
 * was let through. Here three engines in one process stand in for three
 * processes (each counts locally on its own), over one shared store whose
 * `pfAdd` is slow: past the deadline the anomaly is never found, and every
 * fallback is counted in `status()` and warned of; within it, it is found.
 */
import { afterAll, describe, expect, it } from "bun:test";
import type { CacheStoreOptions } from "../../lib/stores/index";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import type { CacheDriver } from "@kingsleyweb/bun-cache";
import { createSecurity } from "../../lib/index";
import type {
  Security,
  SecurityPolicy,
  SecurityWarning,
} from "../../lib/index";
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

/** Three engines sharing one store on `driver`, with the store's `options`; the warnings they raised. */
function fleet(
  driver: CacheDriver,
  options: Pick<CacheStoreOptions, "timeout" | "distinctTimeout"> = {},
  warnings: SecurityWarning[] = [],
): Security[] {
  return [0, 1, 2].map(() => {
    const store = cacheStore(createCache({ driver, logger: () => {} }), {
      ...options,
      logger: () => {},
    });
    const security = createSecurity({
      secret: "the-deadline-test-secret-of-32-bytes!",
      policy: POLICY,
      store,
      logger: () => {},
      onWarning: (warning) => warnings.push(warning),
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

/** Each engine's distinct-count fallbacks, from `status()`. */
const fallbacksOf = (engines: readonly Security[]): (number | undefined)[] =>
  engines.map((engine) => engine.status().state.store?.distinctFallbacks);

/** The `store.distinct-fallback` warnings among `warnings`. */
const fallbackWarnings = (warnings: readonly SecurityWarning[]) =>
  warnings.filter((warning) => warning.kind === "store.distinct-fallback");

/** Seven addresses: the sixth is the first past the limit of five. */
const FOUND = ["allow", "allow", "allow", "allow", "allow", "ban"];

describe("the distinct counts' deadline and the many-addresses check", () => {
  it("under the default, a 30 ms store counts in the store: the sixth address is found", async () => {
    const warnings: SecurityWarning[] = [];
    const engines = fleet(slowDriver(30), {}, warnings);
    for (const engine of engines) await engine.ready();
    expect((await drive(engines)).slice(0, 6)).toEqual(FOUND);
    expect(fallbacksOf(engines)).toEqual([0, 0, 0]);
    expect(fallbackWarnings(warnings)).toEqual([]);
  });

  it("under the default, an 80 ms store still counts in the store: past the general 50 ms, within the distinct counts' 250 ms", async () => {
    const warnings: SecurityWarning[] = [];
    const engines = fleet(slowDriver(80), {}, warnings);
    for (const engine of engines) await engine.ready();
    expect((await drive(engines)).slice(0, 6)).toEqual(FOUND);
    expect(fallbacksOf(engines)).toEqual([0, 0, 0]);
  });

  it("a store slower than the deadline falls back: each engine counts on its own, the sixth address is let through, and it is counted and warned of once per engine", async () => {
    const warnings: SecurityWarning[] = [];
    const engines = fleet(slowDriver(30), { distinctTimeout: "5ms" }, warnings);
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
    // Seven requests round-robin over three engines: 3, 2 and 2 fallbacks.
    expect(fallbacksOf(engines)).toEqual([3, 2, 2]);
    const raised = fallbackWarnings(warnings);
    expect(raised).toHaveLength(3);
    for (const warning of raised) {
      expect(warning.message).toContain("counting in this process");
      expect(warning.share).toBe(1);
    }
  });

  it("a slow store past the default falls back too (the default is a deadline, not a wait)", async () => {
    const warnings: SecurityWarning[] = [];
    const engines = fleet(slowDriver(400), {}, warnings);
    for (const engine of engines) await engine.ready();
    const started = performance.now();
    expect((await drive(engines)).includes("ban")).toBe(false);
    // Seven requests, each waiting one 250 ms deadline on pfAdd, not 400 ms.
    expect(performance.now() - started).toBeLessThan(7 * 400);
    expect(fallbacksOf(engines)).toEqual([3, 2, 2]);
    expect(fallbackWarnings(warnings)).toHaveLength(3);
  }, 15_000);

  it("a longer general timeout lengthens the distinct counts' deadline with it", async () => {
    const engines = fleet(slowDriver(300), { timeout: "5s" });
    for (const engine of engines) await engine.ready();
    expect((await drive(engines)).slice(0, 6)).toEqual(FOUND);
    expect(fallbacksOf(engines)).toEqual([0, 0, 0]);
  }, 15_000);

  it("refuses a distinctTimeout without its unit or out of range", () => {
    const cache = createCache({ driver: memoryDriver(), logger: () => {} });
    expect(() =>
      cacheStore(cache, {
        distinctTimeout: 250 as unknown as `${number}ms`,
      }),
    ).toThrow("distinctTimeout must be a duration with its unit");
    expect(() => cacheStore(cache, { distinctTimeout: "61s" })).toThrow(
      "distinctTimeout must be from 1 ms to 60000 ms",
    );
  });
});
