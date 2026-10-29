/**
 * Run by `driverConformance.test.ts` in a child `bun test`, never by the
 * suite itself (no `.test.` in its name): the driver conformance kit against
 * the memory driver with its bus changed as the environment names, so the
 * kit's bus cases can be asserted from outside.
 *
 * - `stray-message`: every subscribe is handed, at once, a message of another
 *   namespace, as a pushed bus whose subscriber connection the suite shares
 *   delivers one an earlier case published just before (Redis: the raw-dump
 *   case's last `clear`). The bus case must pass.
 * - `deaf-bus`: publishes reach no one and a forced gap is never signalled.
 *   The bus cases must fail inside their own bound, with the kit's message.
 */
import process from "node:process";
import type { BusMessage, CacheDriver } from "../../../lib/index";
import { memoryDriver } from "../../../lib/index";
import { runCacheDriverConformance } from "../../../lib/testing/index";

const kind = process.env.BUN_CACHE_DRIVER_FIXTURE;

/** The memory driver with some members replaced (`override` is handed the real one); the rest bound to it, since its fields are private. */
function changed(
  override: (inner: CacheDriver) => Partial<CacheDriver>,
): CacheDriver {
  const inner = memoryDriver();
  const replaced = override(inner);
  return new Proxy(inner, {
    get(target, property) {
      if (Object.hasOwn(replaced, property)) {
        return replaced[property as keyof CacheDriver];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

if (kind === "stray-message") {
  const stray: BusMessage = {
    type: "clear",
    namespace: "an-earlier-case",
    at: Date.now(),
  };
  const driver = changed((inner) => ({
    subscribe: async (onMessage, onGap) => {
      const unsubscribe = await inner.subscribe!(onMessage, onGap);
      onMessage(stray);
      return unsubscribe;
    },
  }));
  await runCacheDriverConformance("stray message", () => ({ driver }));
} else if (kind === "deaf-bus") {
  const driver = changed(() => ({
    publish: async () => {},
    subscribe: async () => async () => {},
  }));
  await runCacheDriverConformance("deaf bus", () => ({ driver }), {
    busGap: () => {},
  });
} else {
  throw new Error(`unknown BUN_CACHE_DRIVER_FIXTURE ${String(kind)}`);
}
