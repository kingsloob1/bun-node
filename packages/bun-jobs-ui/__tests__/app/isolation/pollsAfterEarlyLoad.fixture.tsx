import { isServer } from "@tanstack/react-query";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { page, setupDom } from "../dom";
import { advance, renderRunner } from "../runners/fixtures";

/**
 * Not a `.test` file, so the package run skips it: `queryIsolation.test.ts`
 * runs it in its own process, after `loadQueryFirst.ts` has loaded TanStack
 * Query with no DOM.
 */

// Ahead of setupDom()'s hooks, which need real timers to settle.
afterEach(() => {
  jest.useRealTimers();
});

setupDom();

describe("a polling screen after TanStack Query loaded without a DOM", () => {
  it("started from the poisoned state", () => {
    expect(isServer).toBe(true);
  });

  // On real timers, so the screen's first render (and every module it loads)
  // is not raced against fake time on a loaded machine.
  it("renders the runner list", async () => {
    renderRunner({ path: "/runners" });
    await page().findByRole("table", { name: "Runners" });
  });

  it("still re-reads on its interval", async () => {
    jest.useFakeTimers();
    const { calls } = renderRunner({ path: "/runners" });
    await advance(100, 10);
    const reads = () => calls.filter((call) => call.path === "/runners").length;
    expect(reads()).toBe(1);
    await advance(10_000);
    expect(reads()).toBe(2);
  });
});
