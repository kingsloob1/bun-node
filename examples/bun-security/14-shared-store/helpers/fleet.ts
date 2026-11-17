/**
 * The walk both shared-store examples take: two engines, each on its own
 * cache and store over one backend (as two processes would be), sharing a
 * limit, a counted rule's ban and a ban by hand.
 */
import type { CacheDriver } from "@kingsleyweb/bun-cache";
import { createCache } from "@kingsleyweb/bun-cache";
import { createSecurity } from "@kingsleyweb/bun-security";
import type {
  Security,
  SecurityPolicy,
  SharedStateStore,
} from "@kingsleyweb/bun-security";
import { cacheStore } from "@kingsleyweb/bun-security/stores";
import { checkEqual } from "../../shared/check";
import { facts } from "../../shared/facts";
import { show, step, waitFor } from "../../shared/console";

/** The policy every engine of the fleet runs. */
const POLICY: SecurityPolicy = {
  service: "checkout",
  // Counted in the store: exact across processes (the default with a store).
  limits: [{ id: "per-ip", limit: 5, window: "1m", key: ["ip", "route"] }],
  countedRules: [
    {
      id: "failed-password",
      event: "auth.failure",
      threshold: 3,
      window: "15m",
      duration: "1h",
    },
  ],
};

/** Runs the walk over drivers `makeDriver` builds, one per engine. */
export async function walkTheFleet(
  makeDriver: () => CacheDriver,
): Promise<void> {
  const drivers: CacheDriver[] = [];
  const stores: SharedStateStore[] = [];
  const engines: Security[] = [];

  /** One "process": its own driver, cache, store and engine. */
  const startProcess = async (): Promise<Security> => {
    const driver = makeDriver();
    drivers.push(driver);
    const store = cacheStore(createCache({ driver, logger: () => {} }), {
      namespace: "bun-security-example",
      // A driver with publish/subscribe (Redis) announces bans on it; the
      // others are read on the poll.
      ...(driver.publish !== undefined && driver.subscribe !== undefined
        ? { bus: driver }
        : {}),
      pollInterval: "200ms",
      logger: () => {},
    });
    stores.push(store);
    const security = createSecurity({
      policy: POLICY,
      store,
      // Every process sharing a store keys usernames and API keys alike.
      secret: "the-fleet-secret-of-at-least-32-bytes!!",
      logger: () => {},
    });
    engines.push(security);
    await security.ready(); // the fleet's bans loaded before the first request
    return security;
  };

  /**
   * What `engine` would decide for a request from `client`, without counting
   * it: `explain()` peeks at the limits, so waiting in a loop costs nothing.
   */
  const peek = async (engine: Security, client: string) =>
    (await engine.explain(facts(client))).decision.action;

  try {
    const a = await startProcess();
    const b = await startProcess();

    /* ---------------------------------------------------------------- */
    step("a shared limit: 5 a minute, counted across both processes");
    const actions: string[] = [];
    for (let i = 0; i < 8; i++) {
      const engine = i % 2 === 0 ? a : b;
      actions.push(
        (await engine.evaluate(facts("198.51.100.1", { path: "/cart" })))
          .action,
      );
    }
    show("eight requests, alternating", actions);
    checkEqual(
      "exactly 5 pass",
      actions.filter((x) => x === "allow").length,
      5,
    );

    /* ---------------------------------------------------------------- */
    step("a counted rule's ban, written by one, enforced by the other");
    for (let i = 0; i < 3; i++)
      await a.signal(facts("203.0.113.5"), "auth.failure");
    await a.flush();
    await waitFor(
      "the ban to reach process b",
      async () => (await peek(b, "203.0.113.5")) === "ban",
    );
    checkEqual("b refuses it", await peek(b, "203.0.113.5"), "ban");

    /* ---------------------------------------------------------------- */
    step("a ban by hand, and lifting it, from either");
    b.ban({ ip: "203.0.113.6", duration: "1h", by: "ops" });
    await b.flush();
    await waitFor(
      "a to see b's ban",
      async () => (await peek(a, "203.0.113.6")) === "ban",
    );
    a.unban("ip:203.0.113.6", { by: "ops" });
    await a.flush();
    await waitFor(
      "b to see a's lift",
      async () => (await peek(b, "203.0.113.6")) === "allow",
    );
    checkEqual("lifted everywhere", await peek(b, "203.0.113.6"), "allow");
    show("store health", a.status().state.store);
  } finally {
    for (const engine of engines) {
      engine.close();
      await engine.flush();
    }
    for (const store of stores) await store.close();
    for (const driver of drivers) await driver.close().catch(() => undefined);
  }
}
