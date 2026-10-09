import { describe, expect, it } from "bun:test";
import {
  AttemptLogWriter,
  LOG_BATCH_CHARS,
} from "../lib/queue/container/logWriter";

/**
 * The container attempt's log writer: one write in flight, lines joined into
 * entries, a bounded drain, and no line written twice — whatever a write
 * does, a batch it was given is never given again.
 */

describe("AttemptLogWriter", () => {
  it("keeps one write in flight and joins the lines that waited", async () => {
    const entries: string[] = [];
    let inFlight = 0;
    let most = 0;
    const writer = new AttemptLogWriter(async (entry) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await Bun.sleep(5);
      entries.push(entry);
      inFlight--;
    });
    for (let i = 0; i < 1000; i++) {
      writer.push(`line ${i}`);
    }
    expect(await writer.drain(5000)).toBe(true);
    expect(most).toBe(1);
    expect(entries.length).toBeLessThan(10);
    const lines = entries.flatMap((entry) => entry.split("\n"));
    expect(lines).toEqual(Array.from({ length: 1000 }, (_, i) => `line ${i}`));
  });

  it("cuts a batch at LOG_BATCH_CHARS", async () => {
    const entries: string[] = [];
    const writer = new AttemptLogWriter(async (entry) => {
      entries.push(entry);
    });
    const line = "x".repeat(1000);
    writer.push("first");
    for (let i = 0; i < 200; i++) {
      writer.push(line);
    }
    await writer.drain(5000);
    expect(entries.every((entry) => entry.length <= LOG_BATCH_CHARS)).toBe(
      true,
    );
    expect(entries.flatMap((entry) => entry.split("\n"))).toHaveLength(201);
  });

  it("never writes a line twice, when a write fails after its entry landed", async () => {
    const stored: string[] = [];
    let calls = 0;
    const writer = new AttemptLogWriter(async (entry) => {
      calls++;
      stored.push(entry);
      if (calls % 2 === 1) {
        // The store took it, and then the call failed: a reply lost.
        throw new Error("lost reply");
      }
    });
    for (let i = 0; i < 500; i++) {
      writer.push(`line ${i}`);
      if (i % 50 === 0) {
        await Bun.sleep(1);
      }
    }
    expect(await writer.drain(5000)).toBe(true);
    const lines = stored.flatMap((entry) => entry.split("\n"));
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines).toHaveLength(500);
  });

  it("drains true once written, false when a write never returns", async () => {
    const quick = new AttemptLogWriter(async () => {});
    quick.push("a");
    expect(await quick.drain(1000)).toBe(true);

    const stuck = new AttemptLogWriter(async () => await new Promise(() => {}));
    stuck.push("a");
    const started = performance.now();
    expect(await stuck.drain(200)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
