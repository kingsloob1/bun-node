import type { QueueRef } from "../lib/index";
import { describe, expect, it } from "bun:test";
import {
  listWorkerConfigs,
  MemoryDriver,
  readWorkerConfig,
  readWorkerControl,
  readWorkerStop,
  removeWorkerControl,
  supportsWorkerControl,
  sweepWorkerControls,
  WORKER_CONFIG_PREFIX,
  WORKER_CONTROL_PREFIX,
  workerConfigName,
  workerControlName,
  writeWorkerConfig,
  writeWorkerControl,
  writeWorkerStop,
} from "../lib/index";
import { testNamespace } from "./helpers";

/**
 * The reserved queue-state entries remote worker control is built on: what
 * they are named, how two writers are kept from losing each other, and what
 * removes the ones whose worker is gone.
 */

/** A memory-backed queue to store entries on. */
function makeQueue(): { driver: MemoryDriver; q: QueueRef } {
  return {
    driver: new MemoryDriver(),
    q: { ns: testNamespace("wctl"), queue: "mail" },
  };
}

describe("worker control storage", () => {
  it("names entries under the reserved prefix, so nothing else can write them", async () => {
    const { driver, q } = makeQueue();

    expect(workerConfigName("svc.mail")).toBe(
      `${WORKER_CONFIG_PREFIX}svc.mail`,
    );
    expect(workerControlName("svc.mail.ab12")).toBe(
      `${WORKER_CONTROL_PREFIX}svc.mail.ab12`,
    );

    await driver.connect();
    await driver.ensureQueue(q);
    await writeWorkerConfig(driver, q, "svc.mail", { concurrency: 4 });

    // The whole point of the prefix: a caller's own `setQueueState` cannot
    // reach the entry, by accident or otherwise.
    await expect(
      driver.setQueueState(
        q,
        workerConfigName("svc.mail"),
        { values: {} },
        null,
      ),
    ).rejects.toThrow(/reserved/);

    await driver.close();
  });

  it("fits a key too long for a name, and keeps the whole key inside", async () => {
    const { driver, q } = makeQueue();
    await driver.connect();
    await driver.ensureQueue(q);

    const key = `svc.${"k".repeat(400)}`;
    const name = workerConfigName(key);
    expect(name.length).toBeLessThan(key.length);

    await writeWorkerConfig(driver, q, key, { concurrency: 3 });
    const stored = await readWorkerConfig(driver, q, key);

    expect(stored?.value.key).toBe(key);
    expect(stored?.value.values).toEqual({ concurrency: 3 });
    expect((await listWorkerConfigs(driver, q))[0]?.key).toBe(key);

    await driver.close();
  });

  it("merges field by field, and clears a field set to null", async () => {
    const { driver, q } = makeQueue();
    await driver.connect();
    await driver.ensureQueue(q);

    const first = await writeWorkerConfig(driver, q, "svc.mail", {
      concurrency: 4,
    });
    const second = await writeWorkerConfig(driver, q, "svc.mail", {
      pollInterval: 250,
    });

    expect(second.override.values).toEqual({
      concurrency: 4,
      pollInterval: 250,
    });
    expect(second.override.seq).toBeGreaterThan(first.override.seq);

    const cleared = await writeWorkerConfig(driver, q, "svc.mail", {
      concurrency: null,
    });
    expect(cleared.override.values).toEqual({ pollInterval: 250 });

    await driver.close();
  });

  it("refuses a write whose expectedSeq has moved on, and changes nothing", async () => {
    const { driver, q } = makeQueue();
    await driver.connect();
    await driver.ensureQueue(q);

    const first = await writeWorkerConfig(driver, q, "svc.mail", {
      concurrency: 4,
    });
    await writeWorkerConfig(driver, q, "svc.mail", { concurrency: 8 });

    const stale = await writeWorkerConfig(
      driver,
      q,
      "svc.mail",
      { concurrency: 2 },
      { expectedSeq: first.override.seq },
    );

    expect(stale.contended).toBe(true);
    expect(
      (await readWorkerConfig(driver, q, "svc.mail"))?.value.values,
    ).toEqual({ concurrency: 8 });

    await driver.close();
  });

  it("refuses a value outside its bounds rather than storing it", async () => {
    const { driver, q } = makeQueue();
    await driver.connect();
    await driver.ensureQueue(q);

    await expect(
      writeWorkerConfig(driver, q, "svc.mail", {
        // `0` would make the worker invisible and therefore unreachable.
        reportInterval: 0,
        concurrency: 5,
      }),
    ).rejects.toThrow("reportInterval must be between 1000 and 600000");

    // Refused whole: not even the valid half is stored.
    expect(await readWorkerConfig(driver, q, "svc.mail")).toBeNull();

    await driver.close();
  });

  it("empties the entry on a reset, so its version keeps rising", async () => {
    const { driver, q } = makeQueue();
    await driver.connect();
    await driver.ensureQueue(q);

    await writeWorkerConfig(driver, q, "svc.mail", { concurrency: 4 });
    const reset = await writeWorkerConfig(
      driver,
      q,
      "svc.mail",
      {},
      {
        replace: true,
      },
    );

    expect(reset.override.values).toEqual({});
    // A delete would restart the version at 1, and a worker that had applied
    // version 2 would then believe it was up to date.
    expect(reset.override.seq).toBeGreaterThan(1);

    await driver.close();
  });

  it("stores and removes a lifecycle instruction by incarnation", async () => {
    const { driver, q } = makeQueue();
    await driver.connect();
    await driver.ensureQueue(q);

    const { seq } = await writeWorkerControl(driver, q, {
      id: "svc.mail.ab12",
      key: "svc.mail",
      incarnation: 1_700_000_000_000,
      state: "stopped",
    });

    const read = await readWorkerControl(driver, q, "svc.mail.ab12");
    expect(read?.seq).toBe(seq);
    expect(read?.value.state).toBe("stopped");
    expect(read?.value.incarnation).toBe(1_700_000_000_000);

    // Conditional on the version, so an instruction written a moment ago is
    // never swallowed by a clear of the one before it.
    expect(await removeWorkerControl(driver, q, "svc.mail.ab12", seq - 1)).toBe(
      false,
    );
    expect(await removeWorkerControl(driver, q, "svc.mail.ab12", seq)).toBe(
      true,
    );
    expect(await readWorkerControl(driver, q, "svc.mail.ab12")).toBeNull();

    await driver.close();
  });

  it("records and clears a stop against a stable key", async () => {
    const { driver, q } = makeQueue();
    await driver.connect();
    await driver.ensureQueue(q);

    await writeWorkerStop(driver, q, "svc.mail", true);
    expect((await readWorkerStop(driver, q, "svc.mail"))?.value.key).toBe(
      "svc.mail",
    );

    await writeWorkerStop(driver, q, "svc.mail", false);
    expect(await readWorkerStop(driver, q, "svc.mail")).toBeNull();

    await driver.close();
  });

  it("sweeps instructions whose worker is gone, and spares the live and the fresh", async () => {
    const { driver, q } = makeQueue();
    await driver.connect();
    await driver.ensureQueue(q);

    const now = Date.now();

    for (const [id, at] of [
      ["dead.old", now - 600_000],
      ["live.old", now - 600_000],
      ["dead.fresh", now - 1_000],
    ] as const) {
      await writeWorkerControl(driver, q, {
        id,
        key: "svc.mail",
        incarnation: 1,
        state: "stopped",
        at,
      });
    }

    const sweep = await sweepWorkerControls(driver, q, {
      now,
      liveIds: new Set(["live.old"]),
      graceMs: 100_000,
    });

    expect(sweep.removed).toBe(1);
    expect(await readWorkerControl(driver, q, "dead.old")).toBeNull();
    // A worker that is still reporting keeps its instruction, and one written
    // a second ago may be for a worker that has not registered yet.
    expect(await readWorkerControl(driver, q, "live.old")).not.toBeNull();
    expect(await readWorkerControl(driver, q, "dead.fresh")).not.toBeNull();

    await driver.close();
  });

  it("leaves configuration overrides alone: they are the operator's standing intent", async () => {
    const { driver, q } = makeQueue();
    await driver.connect();
    await driver.ensureQueue(q);

    await writeWorkerConfig(driver, q, "svc.gone", { concurrency: 4 });
    await sweepWorkerControls(driver, q, {
      now: Date.now(),
      liveIds: new Set(),
      graceMs: 0,
    });

    expect(await readWorkerConfig(driver, q, "svc.gone")).not.toBeNull();

    await driver.close();
  });

  it("says so when a driver cannot store control at all", () => {
    const driver = new MemoryDriver();
    expect(supportsWorkerControl(driver)).toBe(true);

    const stateless = Object.create(driver) as MemoryDriver;
    Object.defineProperty(stateless, "listQueueState", { value: undefined });
    expect(supportsWorkerControl(stateless)).toBe(false);
  });
});
