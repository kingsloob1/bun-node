import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, ConfigError, MemoryDriver } from "../lib/index";
import { testNamespace } from "./helpers";

/**
 * B15: an apply cursor names the walk it belongs to, and one from another
 * walk — another queue, another override version, other states or keys — is
 * refused instead of silently skipping jobs.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

/** Two queues on one driver, each with four waiting jobs. */
async function twoQueues(): Promise<{ a: BunQueue; b: BunQueue }> {
  const driver = new MemoryDriver();
  const namespace = testNamespace("b15");
  const a = new BunQueue("a", { namespace, driver, logger: noopLogger });
  const b = new BunQueue("b", { namespace, driver, logger: noopLogger });
  closers.push(
    () => a.close(),
    () => b.close(),
  );
  for (let index = 0; index < 4; index++) {
    await a.add("x", {});
    await b.add("x", {});
  }
  return { a, b };
}

describe("applyJobDefaults: cursors belong to their walk (B15)", () => {
  it("refuses another queue's cursor, and leaves the jobs alone", async () => {
    const { a, b } = await twoQueues();
    const sa = (await a.setJobDefaults({ attempts: 3 })).seq;
    const sb = (await b.setJobDefaults({ attempts: 3 })).seq;
    const pa = await a.applyJobDefaults({ seq: sa, limit: 3 });
    expect(pa.next).not.toBeNull();

    await expect(
      b.applyJobDefaults({ seq: sb, cursor: pa.next, limit: 10 }),
    ).rejects.toBeInstanceOf(ConfigError);

    const jobs = await b.list("waiting");
    expect(jobs.map((job) => job.opts.attempts)).toEqual([1, 1, 1, 1]);
  });

  it("refuses a cursor from another override version", async () => {
    const { a } = await twoQueues();
    const first = (await a.setJobDefaults({ attempts: 3 })).seq;
    const page = await a.applyJobDefaults({ seq: first, limit: 2 });
    const second = (await a.setJobDefaults({ attempts: 4 })).seq;

    await expect(
      a.applyJobDefaults({ seq: second, cursor: page.next }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("refuses a cursor from a walk of other keys or other states", async () => {
    const { a } = await twoQueues();
    const seq = (await a.setJobDefaults({ attempts: 3, timeout: 50 })).seq;
    const page = await a.applyJobDefaults({ seq, limit: 2 });

    await expect(
      a.applyJobDefaults({ seq, keys: ["attempts"], cursor: page.next }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      a.applyJobDefaults({ seq, states: ["waiting"], cursor: page.next }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("still resumes its own walk page by page to the end", async () => {
    const { a } = await twoQueues();
    const seq = (await a.setJobDefaults({ attempts: 3 })).seq;

    let cursor: string | null = null;
    let examined = 0;
    let pages = 0;
    do {
      const page = await a.applyJobDefaults({ seq, cursor, limit: 1 });
      examined += page.examined;
      cursor = page.next;
      pages++;
    } while (cursor !== null && pages < 20);

    expect(examined).toBe(4);
    const jobs = await a.list("waiting");
    expect(jobs.map((job) => job.opts.attempts)).toEqual([3, 3, 3, 3]);
  });
});
