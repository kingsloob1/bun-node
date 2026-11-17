/**
 * The Postgres store's analytics lock (README §8.3): a counter added while
 * a rollup is moving its watermark is either rolled up or carried up, never
 * lost. A rollup is paused after its rows are written and before its
 * watermark moves, and a late row for the hour it is rolling arrives then.
 * With the lock, the row waits for the rollup and is carried up; without
 * it (the negative control), the row lands below the new watermark unseen,
 * and the hour is short of it for good.
 */
import type { SQL } from "bun";
import type { SecurityStoreDriver } from "../../lib/store/index";
import { afterEach, describe, expect, it } from "bun:test";
import { postgresInit } from "../../lib/store/postgres";
import { sqlSecurityStore } from "../../lib/store/sql";
import {
  dropStore,
  freshPrefix,
  POSTGRES_URL,
  postgresAvailable,
} from "./pgBackend";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 17);

/** A gate a test opens. */
function gate(): {
  wait: () => Promise<void>;
  open: () => void;
  reached: Promise<void>;
} {
  let open!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return {
    wait: async () => {
      reach();
      await opened;
    },
    open,
    reached,
  };
}

if (await postgresAvailable()) {
  describe("postgres analytics: the rollup and a late counter", () => {
    const opened: { store: SecurityStoreDriver; prefix: string }[] = [];
    afterEach(async () => {
      for (const { store, prefix } of opened.splice(0)) {
        await store.close();
        await dropStore(prefix);
      }
    });

    /** Runs the race; answers the hour's total once both are done. */
    const race = async (withLock: boolean): Promise<number> => {
      const prefix = freshPrefix();
      const paused = gate();
      const init = postgresInit({ url: POSTGRES_URL!, prefix, max: 4 });
      const store = sqlSecurityStore({
        ...init,
        ...(withLock ? {} : { serializeAnalytics: undefined }),
        rollupWritten: async (_tx: SQL) => {
          await paused.wait();
        },
      });
      opened.push({ store, prefix });
      await store.addCounters!([
        { service: "api", metric: "m", at: T0, value: 1 },
      ]);
      const rolling = store.rollup!("minute", "hour", T0 + HOUR);
      await paused.reached;
      // A late row for the hour being rolled, while the rollup is paused.
      const adding = store.addCounters!([
        { service: "api", metric: "m", at: T0 + 30 * MINUTE, value: 10 },
      ]);
      // Give the late write every chance to commit before the rollup does.
      await Promise.race([adding, Bun.sleep(300)]);
      paused.open();
      await Promise.all([rolling, adding]);
      const [hour] = await store.series!({
        tier: "hour",
        metric: "m",
        from: T0,
        to: T0 + 2 * HOUR,
      });
      return hour?.value ?? 0;
    };

    it("with the lock, the late row waits and is carried up", async () => {
      expect(await race(true)).toBe(11);
    });

    it("negative control: without the lock, the late row is lost from the hour", async () => {
      expect(await race(false)).toBe(1);
    });
  });
}
