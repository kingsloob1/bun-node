/**
 * The testing helpers themselves (plan §13.1): `faulty`'s knobs and
 * `fakeClock`.
 */
import { describe, expect, test } from "bun:test";
import { faulty, fakeClock, InjectedFaultError } from "../../lib/testing/index";
import { memoryDriver } from "../../lib/index";

describe("faulty", () => {
  const entry = {
    key: "k",
    value: new Uint8Array([1]),
    expiresAt: null,
    tags: [] as readonly string[],
  };

  test("failOn fails the named operations only", async () => {
    const driver = faulty(memoryDriver(), { failOn: ["get"] });
    await expect(driver.get("ns", "k")).rejects.toThrow(InjectedFaultError);
    await expect(driver.set("ns", entry)).resolves.toBe("stored");
  });

  test("down fails everything; setFaults brings it back", async () => {
    const driver = faulty(memoryDriver(), { down: true });
    await expect(driver.get("ns", "k")).rejects.toThrow(InjectedFaultError);
    await expect(driver.set("ns", entry)).rejects.toThrow(InjectedFaultError);
    driver.setFaults({});
    await expect(driver.set("ns", entry)).resolves.toBe("stored");
    expect(await driver.get("ns", "k")).toBeDefined();
  });

  test("failRate: 1 fails every time, 0 never", async () => {
    const always = faulty(memoryDriver(), { failRate: 1 });
    await expect(always.get("ns", "k")).rejects.toThrow(InjectedFaultError);
    const never = faulty(memoryDriver(), { failRate: 0 });
    await expect(never.get("ns", "k")).resolves.toBeUndefined();
  });

  test("lagMs delays but completes; hangMs holds past a budget", async () => {
    const laggy = faulty(memoryDriver(), { lagMs: 30 });
    const started = Date.now();
    await laggy.set("ns", entry);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    const hanging = faulty(memoryDriver(), { hangMs: 500 });
    const outcome = await Promise.race([
      hanging.get("ns", "k").then(() => "resolved"),
      Bun.sleep(50).then(() => "still waiting"),
    ]);
    expect(outcome).toBe("still waiting");
  });

  test("the inner driver's capabilities and optional methods pass through", async () => {
    const driver = faulty(memoryDriver(), {});
    expect(driver.capabilities).toEqual(memoryDriver().capabilities);
    expect(typeof driver.increment).toBe("function");
    expect(typeof driver.acquireLock).toBe("function");
    expect(await driver.increment!("ns", "c", 2, null)).toBe(2);
  });

  test("the name says what it wraps", () => {
    expect(faulty(memoryDriver(), {}).name).toBe("faulty(memory)");
  });
});

describe("fakeClock", () => {
  test("advances and sets", () => {
    const clock = fakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.advance(250)).toBe(1_250);
    clock.set(99);
    expect(clock.now()).toBe(99);
  });
});
