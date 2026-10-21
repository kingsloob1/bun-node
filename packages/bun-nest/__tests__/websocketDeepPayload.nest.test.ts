/**
 * A gateway reply `JSON.stringify` cannot write must not end the process.
 *
 * `JSON.parse` accepts a client payload nested to any depth; `JSON.stringify`
 * overflows its recursion on it. An echo gateway hands it straight back, and
 * the adapter serialises the reply inside the rxjs subscriber NestJS's
 * transform returns, where a throw is rethrown asynchronously and exits Bun.
 * `@nestjs/platform-ws` 12.1.2 and 11.2.7 guard theirs (nestjs/nest
 * 7e961f8b5, 2618406e7): logged, not sent. So does this adapter.
 *
 * The server runs as a child process (`fixtures/ws-deep-payload/server.ts`),
 * so "the process exited" is observed as such rather than as a test runner's
 * unhandled error.
 *
 * **What it waits on.** Making `JSON.stringify` overflow costs about 1.5 s
 * of CPU in Bun 1.4 (oven-sh/bun#45791; measured 2026-10-17: 28,000 levels
 * stringify in 1 ms, 32,000 in 0.8 s, and 200,000 throw after 1.4–1.6 s),
 * and several suites side by side make that several seconds. So the test waits for the server's own signal that the reply
 * failed, the `RangeError` on its stderr (logged by the guard, or printed as
 * the process dies without one), not for a fixed time, and then for a short
 * grace in which a rethrown error would end the process. The deadlines are
 * only there to fail a hang with a message saying which step hung.
 */
import type { Subprocess } from "bun";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MessageEventTypes } from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";

const EVENT = MessageEventTypes.EVENT;

let child: Subprocess<"ignore", "pipe", "pipe">;
let base = "";
/** The child's stderr so far, collected from spawn on. */
let stderr = "";
/** Resolves once the child's stderr has been read to its end. */
let stderrDone: Promise<void>;

/** A deadline for a step that is only slow, never stuck: CPU-bound work under load. */
const STEP_MS = 30_000;

/** Resolves once the child's stderr contains `text`; rejects after `ms`, quoting it. */
async function stderrContains(text: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!stderr.includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(
        `no ${text} on the server's stderr within ${ms} ms; it has: ${stderr || "(nothing)"}`,
      );
    }
    if (child.exitCode !== null) {
      await stderrDone;
      if (stderr.includes(text)) return;
      throw new Error(
        `the server exited (${child.exitCode}) without logging ${text}: ${stderr || "(nothing)"}`,
      );
    }
    await Bun.sleep(10);
  }
}

/** Reads `stream` until a line `PORT <n>` arrives, and returns `n`. */
async function readPort(stream: ReadableStream<Uint8Array>): Promise<number> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    const match = /^PORT (\d+)$/m.exec(text);
    if (match) {
      return Number(match[1]);
    }
  }
  throw new Error(`the server exited before listening: ${text}`);
}

// The child boots a Nest application in a fresh Bun process: about 0.75 s on
// its own (measured at a load of 37), but in a whole suite run beside other
// jobs it passed bun:test's 5 s hook default (the 11.2.7 matrix column at a
// load of 35–39), so the hook takes the step deadline too.
beforeAll(async () => {
  child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/ws-deep-payload/server.ts"),
    ],
    {
      // The decorator options come from the working directory's tsconfig.
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, NODE_ENV: "test" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      stderr += decoder.decode(chunk, { stream: true });
    }
  })();
  base = `ws://127.0.0.1:${await readPort(child.stdout)}`;
}, STEP_MS);

afterAll(async () => {
  child.kill();
  await child.exited;
});

describe("a WebSocket reply that cannot be serialised", () => {
  it(
    "is dropped and logged, and the server keeps answering on the same connection",
    async () => {
      const client = await connectWs(`${base}/`);
      const depth = 200_000;
      // Written as text: the client's own JSON.stringify would overflow too.
      client.send(
        `{"type":${EVENT},"namespace":"/","data":["echo",${"[".repeat(depth)}${"]".repeat(depth)}]}`,
      );
      // The reply has failed once the RangeError is on stderr; then a grace in
      // which a rethrown error would end the process before the next message.
      await stderrContains("RangeError", STEP_MS);
      await Bun.sleep(300);
      expect(child.exitCode).toBeNull();
      client.send({
        type: EVENT,
        namespace: "/",
        data: ["echo", { ok: true }],
      });
      const reply = await client.waitFor(
        (m) => m?.data?.[0] === "echo",
        STEP_MS,
      );

      expect(reply.data[1]).toEqual({ ok: true });
      expect(client.received).toHaveLength(1);
      expect(child.exitCode).toBeNull();
      await client.close();

      child.kill();
      await child.exited;
      await stderrDone;
      // Logged through Nest's logger, which the app left on for errors.
      expect(stderr).toContain("RangeError");
    },
    3 * STEP_MS,
  );
});
