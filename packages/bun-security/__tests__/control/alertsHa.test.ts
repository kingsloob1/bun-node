/**
 * Alerting across an HA pair (the user's decision, 2026-11-17): two
 * `createSecurityApi` instances on one store send an alert once, and a
 * channel's limits (one message a minute per kind, 60 an hour) hold across
 * both. The negative control: the same two instances on separate stores
 * send twice and count apart.
 */
import type { AlertChannelSpec, AlertRecord } from "../../lib/control/index";
import type { SecurityStoreDriver } from "../../lib/store/index";
import { afterEach, describe, expect, it } from "bun:test";
import {
  ALERT_RATE_LIMITS,
  memoryDeliveryQueue,
} from "../../lib/control/index";
import { memoryStore } from "../../lib/store/index";
import { fakeClock } from "../helpers";
import { testApi } from "./helpers";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const WEBHOOK: AlertChannelSpec = {
  id: "ops",
  name: "Ops",
  type: "webhook",
  url: "https://hooks.example.com/ops",
  secret: "s".repeat(43),
};

/** Two instances, on one store (`shared`) or on two; one recorder of what the channel received. */
async function pair(shared: boolean) {
  const clock = fakeClock();
  const posted: string[] = [];
  const stores: SecurityStoreDriver[] = shared
    ? [memoryStore({ now: clock.now })]
    : [memoryStore({ now: clock.now }), memoryStore({ now: clock.now })];
  const instances = [0, 1].map((n) => {
    const store = stores[shared ? 0 : n]!;
    let queue: ReturnType<typeof memoryDeliveryQueue> | undefined;
    const t = testApi({
      store,
      now: clock.now,
      alerts: {
        timers: false,
        fetch: async (_url, init) => {
          posted.push(typeof init.body === "string" ? init.body : "");
          return new Response("", { status: 200 });
        },
        queue: (deliver) =>
          (queue = memoryDeliveryQueue({
            deliver,
            now: clock.now,
            timers: false,
          })),
      },
    });
    closers.push(() => t.api.alerts!.close());
    return {
      ...t,
      alerts: t.api.alerts!,
      work: async () => await queue!.work(),
    };
  });
  for (const store of stores) {
    await store.put("alertChannel", "ops", WEBHOOK, null);
    await store.put(
      "alertRule",
      "blocks",
      {
        id: "blocks",
        title: "Blocks",
        scope: "global",
        severity: "warning",
        channels: ["ops"],
        condition: {
          type: "threshold",
          metric: "requests",
          windowMs: 300_000,
          value: 5,
        },
      },
      null,
    );
    await store.addCounters!([
      {
        service: "pay",
        at: clock.now() - 60_000,
        metric: "requests",
        value: 9,
      },
    ]);
  }
  const workAll = async () => {
    for (const i of instances) await i.work();
  };
  return { clock, posted, instances, workAll };
}

/** An alert of `kind`. */
const alert = (
  kind: string,
  at: number,
  key = `${kind}:${Math.random()}`,
): AlertRecord => ({
  kind,
  key,
  severity: "warning",
  scope: "global",
  title: kind,
  at,
  facts: {},
});

describe("an HA pair on one store", () => {
  it("evaluates the same rule on both and the channel gets one message", async () => {
    const { posted, instances, workAll, clock } = await pair(true);
    const [a, b] = instances;
    expect((await a!.alerts.evaluate()).raised).toBe(1);
    expect((await b!.alerts.evaluate()).raised).toBe(0);
    await workAll();
    expect(posted).toHaveLength(1);
    // Both hold it open; evaluating again sends nothing.
    clock.advance(60_000);
    await a!.alerts.evaluate();
    await b!.alerts.evaluate();
    await workAll();
    expect(posted).toHaveLength(1);
    // B holds it open too, without having sent it.
    expect(b!.alerts.open()).toHaveLength(1);
  });

  it("negative control: on separate stores each instance sends it", async () => {
    const { posted, instances, workAll } = await pair(false);
    expect((await instances[0]!.alerts.evaluate()).raised).toBe(1);
    expect((await instances[1]!.alerts.evaluate()).raised).toBe(1);
    await workAll();
    expect(posted).toHaveLength(2);
  });

  it("one message a minute per kind holds across both", async () => {
    for (const shared of [true, false]) {
      const { posted, instances, workAll, clock } = await pair(shared);
      await instances[0]!.alerts.raise(alert("flood", clock.now()), ["ops"]);
      await instances[1]!.alerts.raise(alert("flood", clock.now()), ["ops"]);
      await workAll();
      // Shared: the second is held for a digest; apart (the control): both go.
      expect(posted).toHaveLength(shared ? 1 : 2);
    }
  });

  it("60 messages an hour a channel holds across both; critical still goes", async () => {
    for (const shared of [true, false]) {
      const { posted, instances, workAll, clock } = await pair(shared);
      for (let i = 0; i < 40; i++) {
        await instances[0]!.alerts.raise(alert(`a${i}`, clock.now()), ["ops"]);
        await instances[1]!.alerts.raise(alert(`b${i}`, clock.now()), ["ops"]);
      }
      await instances[1]!.alerts.raise(
        { ...alert("urgent", clock.now()), severity: "critical" },
        ["ops"],
      );
      await workAll();
      expect(posted).toHaveLength(shared ? ALERT_RATE_LIMITS.perHour + 1 : 81);
    }
  });
});
