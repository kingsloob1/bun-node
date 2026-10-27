/**
 * The file driver (plan §7.2): the conformance kit against a real directory —
 * including the two-process pass and the bus-gap case this driver enables —
 * plus the driver-specific behaviors: the on-disk layout, atomic-write
 * debris, durability across instances, and the sweeper's caps.
 *
 * Test data: one temporary directory per run, made by this file and deleted
 * by this file alone.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StoredEntry } from "../../lib/index";
import { fileDriver } from "../../lib/index";
import { runCacheDriverConformance } from "../../lib/testing/index";

/** The run's own directory. */
const dir = await mkdtemp(join(tmpdir(), `bun-cache-file-${process.pid}-`));

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

await runCacheDriverConformance(
  "file",
  () => ({
    driver: fileDriver({ root: dir, busPollInterval: 25 }),
  }),
  {
    crossProcess: {
      module: new URL("../../lib/drivers/file.ts", import.meta.url).pathname,
      export: "fileDriver",
      options: { root: dir, busPollInterval: 25 },
    },
    busGap: async () => {
      // Truncating the log is exactly what a compaction does to a subscriber
      // whose offset is past the new end.
      await writeFile(join(dir, "bus.log"), "");
    },
  },
);

describe("fileDriver specifics", () => {
  const entry = (key: string, size: number): StoredEntry => ({
    key,
    value: new Uint8Array(size).fill(7),
    expiresAt: null,
    tags: [],
  });

  let root: string;

  beforeAll(async () => {
    root = join(dir, "specifics");
  });

  test("the layout: one .bce file per entry, sharded; stamps, counters and locks beside it", async () => {
    const driver = fileDriver({ root });
    await driver.set("app", entry("some:key", 10));
    await driver.setStamps!("app", ["users"], Date.now(), Date.now() + 60_000);
    await driver.increment!("app", "hits", 3, null);
    expect(await driver.acquireLock!("app", "held", "owner", 60_000)).toBe(
      true,
    );

    const nsDir = join(root, "app");
    const shards = await readdir(join(nsDir, "e"));
    expect(shards).toHaveLength(1);
    const files = await readdir(join(nsDir, "e", shards[0]));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.bce$/);
    expect(await readdir(join(nsDir, "s"))).toHaveLength(1);
    expect(await readdir(join(nsDir, "n"))).toHaveLength(1);
    expect(await readdir(join(nsDir, "l"))).toHaveLength(1);
    await driver.close();
  });

  test("two instances share the store: a restart reads what the first wrote", async () => {
    const first = fileDriver({ root });
    await first.set("durable", entry("k", 12));
    await first.increment!("durable", "c", 5, null);
    await first.close();

    const second = fileDriver({ root });
    const read = await second.get("durable", "k");
    expect(read?.value).toEqual(new Uint8Array(12).fill(7));
    expect((await second.getCounter!("durable", "c"))?.value).toBe(5);
    await second.close();
  });

  test("a torn write's .tmp file is ignored by readers and swept when old", async () => {
    const driver = fileDriver({ root });
    await driver.set("debris", entry("k", 4));
    const nsDir = join(root, "debris", "e");
    const shard = (await readdir(nsDir))[0];
    const debris = join(nsDir, shard, "deadbeef.tmp");
    await writeFile(debris, "partial");
    // A reader ignores it.
    expect((await driver.get("debris", "k"))?.value).toEqual(
      new Uint8Array(4).fill(7),
    );
    // Fresh debris is left alone (a live writer may own it); the sweep
    // removes it once it is old. Backdate it 2 hours.
    const { utimes } = await import("node:fs/promises");
    const old = new Date(Date.now() - 2 * 3_600_000);
    await utimes(debris, old, old);
    await driver.sweep!(Date.now(), 1_000);
    await expect(readFile(debris)).rejects.toThrow();
    await driver.close();
  });

  test("the sweeper evicts oldest by mtime when over maxEntries", async () => {
    const capped = join(dir, "capped");
    const driver = fileDriver({ root: capped, maxEntries: 2 });
    await driver.set("ns", entry("old", 1));
    await Bun.sleep(10);
    await driver.set("ns", entry("mid", 1));
    await Bun.sleep(10);
    await driver.set("ns", entry("new", 1));
    const removed = await driver.sweep!(Date.now(), 1_000);
    expect(removed).toBeGreaterThanOrEqual(0); // nothing expired
    expect(await driver.get("ns", "old")).toBeUndefined();
    expect((await driver.get("ns", "mid"))?.value).toHaveLength(1);
    expect((await driver.get("ns", "new"))?.value).toHaveLength(1);
    await driver.close();
  });

  test("the bus: two instances exchange invalidations over the polled log", async () => {
    const a = fileDriver({ root: join(dir, "bus"), busPollInterval: 25 });
    const b = fileDriver({ root: join(dir, "bus"), busPollInterval: 25 });
    const received: string[] = [];
    const unsubscribe = await b.subscribe!(
      (message) => {
        received.push(`${message.type}:${message.namespace}`);
      },
      () => {},
    );
    await a.publish!({ type: "clear", namespace: "app", at: Date.now() });
    const deadline = Date.now() + 5_000;
    while (received.length === 0) {
      if (Date.now() > deadline) {
        throw new Error("the bus message never arrived");
      }
      await Bun.sleep(10);
    }
    expect(received).toEqual(["clear:app"]);
    await unsubscribe();
    await a.close();
    await b.close();
  });
});
