/**
 * `liveInvalidation()`'s route source leaves a route whose handler publishes
 * its own invalidations to it (typed-client plan `nest-typed-routes.md`
 * §4.3, PR-N4): bun-nest's `@Invalidates` marks the handler with
 * `"bun:invalidates"` reflect metadata, and its interceptor publishes when
 * the handler succeeds. Without the skip, a success would publish twice.
 * bun-common has no reflect-metadata, so this file installs a minimal
 * stand-in for the two calls (removed after), unless the polyfill is up.
 */
import type { Server } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { liveContract, liveInvalidation } from "../lib/live";
import { createTestLogger } from "../lib/logging";

/** `Reflect` with the polyfill's two calls, when present. */
const reflect = Reflect as unknown as {
  getMetadata?: (key: unknown, target: object) => unknown;
  defineMetadata?: (key: unknown, value: unknown, target: object) => void;
};
const installed = reflect.getMetadata === undefined;
if (installed) {
  const store = new WeakMap<object, Map<unknown, unknown>>();
  reflect.defineMetadata = (key, value, target) => {
    let map = store.get(target);
    if (map === undefined) store.set(target, (map = new Map()));
    map.set(key, value);
  };
  reflect.getMetadata = (key, target) => store.get(target)?.get(key);
}
afterAll(() => {
  if (!installed) return;
  delete reflect.getMetadata;
  delete reflect.defineMetadata;
});

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

describe("liveInvalidation(): a self-publishing handler", () => {
  it('skips a route whose handler carries "bun:invalidates" metadata (control: the same route without it is published)', async () => {
    const { logger } = createTestLogger();
    const adapter = new BunHttpAdapter(0, { logger });
    adapter.use(
      liveInvalidation(adapter, { authorize: (_req, _res, next) => next() }),
    );
    const marked = (
      _req: unknown,
      res: { json: (body: unknown) => void },
    ): void => {
      res.json({ ok: true });
    };
    reflect.defineMetadata?.("bun:invalidates", true, marked);
    const tag = `self-${process.pid}-${Date.now()}`;
    adapter
      .patch("/marked", marked as never)
      .describe({ cache: { invalidates: [`${tag}-marked`] } });
    adapter
      .patch("/plain", (_req, res) => {
        res.json({ ok: true });
      })
      .describe({ cache: { invalidates: [`${tag}-plain`] } });
    const server = (await adapter.listen(0)) as Server<unknown>;
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${server.port}${liveContract.meta.path}`,
      );
      const frames: {
        type: string;
        id?: string;
        data?: { tags?: string[] };
      }[] = [];
      ws.onmessage = (event) =>
        void frames.push(JSON.parse(String(event.data)) as (typeof frames)[0]);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("the live socket did not open"));
      });
      ws.send(
        JSON.stringify({
          type: "subscribe",
          id: "s",
          data: { tags: [`${tag}-marked`, `${tag}-plain`] },
        }),
      );
      await until(() => frames.some((frame) => frame.id === "s"));
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/marked`, { method: "PATCH" })).status).toBe(
        200,
      );
      expect((await fetch(`${base}/plain`, { method: "PATCH" })).status).toBe(
        200,
      );
      await until(() => frames.some((frame) => frame.type === "invalidate"));
      await Bun.sleep(50);
      const published = frames
        .filter((frame) => frame.type === "invalidate")
        .flatMap((frame) => frame.data?.tags ?? []);
      expect(published).toEqual([`${tag}-plain`]);
      ws.close();
    } finally {
      await adapter.close();
    }
  });
});
