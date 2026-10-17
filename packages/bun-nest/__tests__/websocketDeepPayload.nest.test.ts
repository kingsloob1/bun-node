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
 */
import type { Subprocess } from "bun";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MessageEventTypes } from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";

const EVENT = MessageEventTypes.EVENT;

let child: Subprocess<"ignore", "pipe", "pipe">;
let base = "";

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
  base = `ws://127.0.0.1:${await readPort(child.stdout)}`;
});

afterAll(async () => {
  child.kill();
  await child.exited;
});

describe("a WebSocket reply that cannot be serialised", () => {
  it("is dropped and logged, and the server keeps answering on the same connection", async () => {
    const client = await connectWs(`${base}/`);
    const depth = 200_000;
    // Written as text: the client's own JSON.stringify would overflow too.
    client.send(
      `{"type":${EVENT},"namespace":"/","data":["echo",${"[".repeat(depth)}${"]".repeat(depth)}]}`,
    );
    // Long enough for the reply to fail, and for a rethrown error to end
    // the process before the next message.
    await new Promise((resolve) => setTimeout(resolve, 300));
    client.send({ type: EVENT, namespace: "/", data: ["echo", { ok: true }] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "echo", 3000);

    expect(reply.data[1]).toEqual({ ok: true });
    expect(client.received).toHaveLength(1);
    expect(child.exitCode).toBeNull();
    await client.close();

    child.kill();
    await child.exited;
    // Logged through Nest's logger, which the app left on for errors.
    expect(await new Response(child.stderr).text()).toContain("RangeError");
  });
});
