import type { LocalAddedJob } from "../lib/queue/BunQueue";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { MemoryDriver } from "../lib/index";
import { BunQueue, LOCAL_ADD_HOOKS } from "../lib/queue/BunQueue";

/**
 * The private local-add hook the summon controller listens on. An add has
 * been written and announced before any hook runs, so a hook that throws must
 * not fail it — for a single add, or for a whole batch.
 */
describe("BunQueue local add hooks", () => {
  function queueWithHooks(...hooks: ((job: LocalAddedJob) => void)[]) {
    const logs = createTestLogger();
    const queue = new BunQueue<{ n: number }>("hooks", {
      namespace: "hooks-test",
      driver: new MemoryDriver(),
      logger: logs.logger,
    });
    queue[LOCAL_ADD_HOOKS] = hooks;
    return { queue, logs };
  }

  it("a throwing hook fails neither add() nor addBulk(), and the other hooks and listeners still run", async () => {
    const heard: LocalAddedJob[] = [];
    const { queue, logs } = queueWithHooks(
      () => {
        throw new Error("hook bug");
      },
      (job) => heard.push(job),
    );
    const added: string[] = [];
    queue.on("added", (job) => added.push(job.id));

    const one = await queue.add("a", { n: 1 });
    const many = await queue.addBulk([
      { name: "b", data: { n: 2 } },
      { name: "c", data: { n: 3 } },
    ]);

    expect(one.id).toBeString();
    expect(many).toHaveLength(2);
    // Every add reached the user's listeners and the hook after the throwing one.
    expect(added).toHaveLength(3);
    expect(heard).toHaveLength(3);
    // And the throw is surfaced, once per add, not swallowed.
    const warnings = logs.events.filter(
      (event) =>
        event.level === "warn" && event.message.includes("local add hook"),
    );
    expect(warnings).toHaveLength(3);
    expect(warnings[0]?.error?.message).toBe("hook bug");
    await queue.close();
  });

  it("with no hook set, adds run as before", async () => {
    const { queue, logs } = queueWithHooks();
    queue[LOCAL_ADD_HOOKS] = undefined;
    await queue.add("a", { n: 1 });
    await queue.addBulk([{ name: "b", data: { n: 2 } }]);
    expect(await queue.count("waiting")).toBe(2);
    expect(logs.events.filter((event) => event.level === "warn")).toEqual([]);
    await queue.close();
  });
});
