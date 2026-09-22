import type {
  ChildOutcome,
  JobFlow,
  JobRecord,
  QueueRef,
} from "../lib/drivers/driver";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serializeError } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { FileDriver } from "../lib/drivers/file-driver";
import { encodeName } from "../lib/drivers/file-names";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";

/**
 * The flow race on the file driver, where it is widest: a failure delivery
 * decided from an earlier view waits on the parent's hold while the first
 * delivery buries the parent and a retry requeues it, then lands. The child is
 * read under the hold, so what it sees is the child as it is *then*.
 *
 * Shipped beside the queue job defaults work (wave 3), hence the file name.
 */

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

/** A connected driver in a fresh directory, and a parents and a children queue. */
async function setup(name: string): Promise<{
  driver: FileDriver;
  root: string;
  parents: QueueRef;
  children: QueueRef;
}> {
  const tmp = await makeTmpDir(`bun-jobs-flowrace-${name}`);
  cleanups.push(tmp.cleanup);
  const driver = new FileDriver({ root: tmp.path });
  await driver.connect();
  cleanups.push(async () => await driver.close());
  const ns = testNamespace();
  return {
    driver,
    root: tmp.path,
    parents: { ns, queue: "parents" },
    children: { ns, queue: "children" },
  };
}

/** A flow value with every field, `overrides` over empty defaults. */
function flowOf(overrides: Partial<JobFlow>): JobFlow {
  return {
    parent: null,
    children: [],
    pending: 0,
    values: {},
    failures: {},
    recorded: false,
    ...overrides,
  };
}

/** A failure outcome, as the worker delivers one. */
function failed(message: string): ChildOutcome {
  return {
    completed: false,
    ignored: false,
    error: serializeError(new Error(message)),
  };
}

/** Adds parent `p` waiting on `ids` in the children queue, and those children. */
async function family(
  driver: FileDriver,
  parents: QueueRef,
  children: QueueRef,
  kids: Record<string, Partial<JobRecord> | null>,
): Promise<void> {
  const ids = Object.keys(kids);
  const ofParent = flowOf({ parent: { queue: parents.queue, id: "p" } });

  for (const [id, overrides] of Object.entries(kids)) {
    if (overrides !== null) {
      await driver.addJob(
        children,
        makeJob({ id, flow: ofParent, ...overrides }),
      );
    }
  }

  await driver.addJob(
    parents,
    makeJob({
      id: "p",
      state: "waiting-children",
      flow: flowOf({
        children: ids.map((id) => ({ queue: children.queue, id })),
        pending: ids.length,
      }),
    }),
  );
}

/** Where a job's record is on disk. */
function recordPath(root: string, q: QueueRef, id: string): string {
  return join(root, q.ns, "queues", q.queue, "jobs", `${encodeName(id)}.json`);
}

describe("file driver: a stale child failure never buries a retried parent", () => {
  it("reads the child under the parent's hold, not before waiting for it", async () => {
    const { driver, root, parents, children } = await setup("held");
    const now = Date.now();
    await family(driver, parents, children, {
      bad: {
        state: "dead",
        finishedOn: now,
        failedReason: serializeError(new Error("broke")),
      },
      good: {},
    });

    // Another change holds the parent, so the delivery waits for it...
    const dir = join(root, parents.ns, "queues", parents.queue, "index");
    const [marker] = await readdir(join(dir, "waiting-children"));
    const heldDir = join(root, parents.ns, "queues", parents.queue, "held");
    await mkdir(heldDir, { recursive: true });
    const hold = join(heldDir, `${Date.now()}.waiting-children.${marker}`);
    await rename(join(dir, "waiting-children", marker!), hold);

    const delivery = driver.recordChild(
      parents,
      "p",
      { queue: children.queue, id: "bad" },
      failed("broke"),
      now,
    );
    await Bun.sleep(40);

    // ...and meanwhile the same failure is delivered by somebody else and
    // marked, and the parent retried: the waiting delivery is now stale.
    const path = recordPath(root, children, "bad");
    const child = JSON.parse(await readFile(path, "utf8")) as JobRecord;
    await writeFile(
      path,
      JSON.stringify({ ...child, flow: { ...child.flow!, recorded: true } }),
    );
    await rename(hold, join(dir, "waiting-children", marker!));

    expect(await delivery).toBe("already");
    const parent = await driver.getJob(parents, "p");
    expect(parent?.state).toBe("waiting-children");
    expect(parent?.failedReason).toBeNull();
    expect(parent?.flow?.failures).toEqual({});
  });

  it("refuses a failure once the child has been retried itself, recorded reset or not", async () => {
    const { driver, parents, children } = await setup("child-retried");
    // Retried: waiting again, and `retryJob` reset `recorded` to false.
    await family(driver, parents, children, { bad: { state: "waiting" } });

    expect(
      await driver.recordChild(
        parents,
        "p",
        { queue: children.queue, id: "bad" },
        failed("broke"),
        Date.now(),
      ),
    ).toBe("already");
    expect((await driver.getJob(parents, "p"))?.state).toBe("waiting-children");
  });

  it("still buries for a child that failed again, and for one with no record", async () => {
    const again = await setup("again");
    const now = Date.now();
    await family(again.driver, again.parents, again.children, {
      bad: {
        state: "dead",
        finishedOn: now,
        failedReason: serializeError(new Error("broke again")),
      },
    });
    expect(
      await again.driver.recordChild(
        again.parents,
        "p",
        { queue: again.children.queue, id: "bad" },
        failed("broke again"),
        now,
      ),
    ).toBe("buried");
    expect((await again.driver.getJob(again.parents, "p"))?.state).toBe("dead");

    const gone = await setup("gone");
    await family(gone.driver, gone.parents, gone.children, { lost: null });
    expect(
      await gone.driver.recordChild(
        gone.parents,
        "p",
        { queue: gone.children.queue, id: "lost" },
        failed("broke"),
        now,
      ),
    ).toBe("buried");
  });
});
