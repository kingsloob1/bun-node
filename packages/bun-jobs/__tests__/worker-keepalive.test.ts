import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { makeTmpDir } from "./helpers";
import { spawnBun } from "./helpers/spawnBun";

/**
 * Whether a process running a worker stays up while its queue is idle.
 *
 * Every wait inside the worker is unref'd, so without a deliberate hold a
 * worker service would exit as soon as it had nothing to do — the moment it
 * is most needed to be listening. Tested in a real process, because in a test
 * runner the event loop is kept alive by the runner itself.
 */

const script = join(import.meta.dir, "fixtures", "processes", "idle-worker.ts");
const busy = join(import.meta.dir, "fixtures", "processes", "busy-shutdown.ts");

describe("a worker keeping its process alive", () => {
  it("stays up on an idle queue, and exits by itself once closed", async () => {
    const child = spawnBun(script, {});

    const early = await Promise.race([
      child.exited.then((code) => `exited with ${code}`),
      Bun.sleep(1_500).then(() => "alive"),
    ]);
    expect(early).toBe("alive");

    child.proc.kill("SIGTERM");

    const code = await Promise.race([
      child.exited,
      Bun.sleep(10_000).then(() => {
        child.proc.kill("SIGKILL");
        return "still running after close";
      }),
    ]);
    expect(code).toBe(0);

    const output = await child.output;
    expect(output).toContain('"event":"closed"');
    expect(output).toContain('"event":"run-returned"');
  }, 20_000);

  it("exits by itself on an idle queue with waitToExit: false", async () => {
    const child = spawnBun(script, { WAIT_TO_EXIT: "false" });

    const outcome = await Promise.race([
      child.exited.then((code) => `exited with ${code}`),
      Bun.sleep(8_000).then(() => {
        child.proc.kill("SIGKILL");
        return "alive";
      }),
    ]);

    expect(outcome).toBe("exited with 0");
  }, 20_000);

  it("finishes closing in a signal handler, even with nothing else holding the process", async () => {
    const tmp = await makeTmpDir("busy-shutdown");

    try {
      const child = spawnBun(busy, { DB: join(tmp.path, "jobs.db") });

      const code = await Promise.race([
        child.exited,
        Bun.sleep(15_000).then(() => {
          child.proc.kill("SIGKILL");
          return "did not exit";
        }),
      ]);

      const output = await child.output;
      expect(code).toBe(0);
      // The handler's line after `await jobs.close()`: printed only if the
      // process was still running when closing finished.
      expect(output).toContain('"event":"closed"');
    } finally {
      await tmp.cleanup();
    }
  }, 30_000);
});
