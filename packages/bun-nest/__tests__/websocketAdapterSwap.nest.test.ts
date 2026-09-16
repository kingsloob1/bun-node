/**
 * Which `BunWebSocket` receives lifecycle dispatch after the router's
 * registered instance is replaced.
 *
 * `Bun.serve` reads its `websocket` object once, at `listen()`. Both HTTP
 * adapters therefore hand it a stable object whose callbacks forward to
 * whichever instance is registered on the router *at call time*
 * (`buildServerWebSocketHandler` → `resolveWebSocketAdapter`), because a
 * `BunWebSocket`'s constructor calls `setBunWebSocket(this)` on the router it
 * is given — so constructing one, as `app.useWebSocketAdapter()` does, replaces
 * the registered instance. Freezing dispatch at `listen()` left a client
 * connected and then silent.
 *
 * This pins the replaced-instance case end to end, at the adapter level rather
 * than through a gateway: NestJS binds a gateway's hooks to the adapter that
 * existed when it bound, so after a swap the *instance* is the thing that
 * changed, and the instance is what these assertions read. The control is the
 * same connection before the swap.
 *
 * `reflect-metadata` is imported last per the import-sort rule; it still
 * executes before any decorator does.
 */
import type { WebSocketClient } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WebSocketGateway } from "@nestjs/websockets";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunWebSocketAdapter } from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";
import "reflect-metadata";

/** Applications to close after each test. */
const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** Waits until `predicate` holds, rather than sleeping for a guessed span. */
async function until(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await Bun.sleep(5);
  }
}

describe("a BunWebSocket replaced after listen()", () => {
  it("dispatches to the instance registered on the router now, not the one bound at listen()", async () => {
    // A gateway only so the router carries an upgrade route for `/`; its own
    // hooks are not what this asserts.
    @WebSocketGateway()
    class PlainGateway {}

    @Module({ providers: [PlainGateway] })
    class AppModule {}

    const adapter = new BunHttpAdapter(30000);
    const app = (await NestFactory.create(AppModule, adapter as never, {
      logger: false,
    })) as INestApplication;
    app.useWebSocketAdapter(adapter.webSocketAdapter as never);
    cleanups.push(() => app.close());
    await app.listen(0);

    const base = `ws://127.0.0.1:${adapter.listeningPort}`;
    const original = adapter.webSocketAdapter;
    const seenByOriginal: string[] = [];
    const seenBySwapped: string[] = [];
    original.on("connect", (client: WebSocketClient<unknown>) => {
      seenByOriginal.push(String(client?.data?.path));
    });

    // The control: while the built-in instance is the registered one, it is
    // the one the server's callbacks reach.
    const before = await connectWs(`${base}/`);
    const originalSawOne = () => seenByOriginal.length === 1;
    await until("the built-in adapter to see it", originalSawOne);
    expect(seenByOriginal).toEqual(["/"]);
    await before.close();

    // The swap, after `listen()`: constructing it registers it on the router.
    const swapped = new BunWebSocketAdapter({ httpAdapter: adapter });
    swapped.on("connect", (client: WebSocketClient<unknown>) => {
      seenBySwapped.push(String(client?.data?.path));
    });
    expect(adapter.getInstance().getBunWebsocket()).toBe(swapped as never);

    const after = await connectWs(`${base}/`);
    await until("the new adapter to see it", () => seenBySwapped.length === 1);

    // Last one wins: the new instance dispatches, and the one the server was
    // bound with receives nothing further.
    expect(seenBySwapped).toEqual(["/"]);
    expect(seenByOriginal).toEqual(["/"]);

    await after.close();
  });
});
