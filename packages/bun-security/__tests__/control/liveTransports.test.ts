/**
 * The live hub's transports (ui.md §6, PR-CP5): SSE at `GET /live?topics=`
 * (the subscription first, then the topics' messages, resumed from
 * `Last-Event-ID`, refused past the connection limit) and the WebSocket
 * channel at the same path on a real socket (authenticated and its origin
 * checked before the upgrade, `subscribe` answered with `subscribed`). What
 * a viewer is sent holds no sample and no account subject on either.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { LIVE_LIMITS } from "../../lib/control/contract/live";
import { fullEvent, liveApi, SECRET_SUBJECTS } from "./liveFixtures";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An API mounted on an adapter, its live channel attached. */
async function mounted() {
  const test = await liveApi();
  const app = new BunHttpAdapter(0, { logger: () => {} });
  app.use(test.api.basePath, test.api.router);
  test.api.live.attach(app);
  cleanups.push(() => test.api.live.close());
  return { ...test, app };
}

/** Reads an SSE body until `until` appears (or it ends); the text so far. */
async function readUntil(
  reader: {
    read: () => Promise<{ value?: Uint8Array; done: boolean }>;
  },
  until: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5_000;
  while (!text.includes(until) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe("SSE", () => {
  /** Opens `/live` as `op`; the response. */
  const open = async (
    app: BunHttpAdapter,
    basePath: string,
    op: string,
    query = "topics=events:global",
    headers: Record<string, string> = {},
  ) => {
    const response = await app.fetch(`${basePath}/live?${query}`, {
      headers: { "x-op": op, ...headers },
    });
    if (response.body !== null) {
      const reader = response.body.getReader();
      cleanups.push(async () => {
        await reader.cancel().catch(() => undefined);
      });
      return { response, reader };
    }
    return { response, reader: undefined };
  };

  it("subscribes, then sends a viewer events stripped to its access", async () => {
    const { app, api } = await mounted();
    const { reader } = await open(app, api.basePath, "vic");
    const head = await readUntil(reader!, "event: subscribed");
    expect(head).toContain('"topics":["events:global"]');
    api.live.publishBatch("pay", {
      events: [fullEvent("e1", "pay")],
      counters: [],
    });
    const text = await readUntil(reader!, "event: event");
    expect(text).toContain('"id":"e1"');
    for (const secret of [...Object.values(SECRET_SUBJECTS), "SAMPLE-SECRET"])
      expect(text).not.toContain(secret);
  });

  it("negative control: an analyst's stream holds the account subjects (never the sample)", async () => {
    const { app, api } = await mounted();
    const { reader } = await open(app, api.basePath, "ann");
    await readUntil(reader!, "event: subscribed");
    api.live.publishBatch("pay", {
      events: [fullEvent("e1", "pay")],
      counters: [],
    });
    const text = await readUntil(reader!, "event: event");
    expect(text).toContain(SECRET_SUBJECTS.apiKey);
    expect(text).not.toContain("SAMPLE-SECRET");
  });

  it("resumes after Last-Event-ID", async () => {
    const { app, api } = await mounted();
    const hub = api.live.hub;
    api.live.publishBatch("pay", {
      events: [fullEvent("e1", "pay")],
      counters: [],
    });
    const after = `${hub.epoch}:${hub.seq}`;
    api.live.publishBatch("pay", {
      events: [fullEvent("e2", "pay")],
      counters: [],
    });
    const { reader } = await open(
      app,
      api.basePath,
      "vic",
      "topics=events:global",
      { "last-event-id": after },
    );
    const text = await readUntil(reader!, '"id":"e2"');
    expect(text).toContain('"id":"e2"');
    expect(text).not.toContain('"id":"e1"');
    expect(text).toContain(`id: ${hub.epoch}:${hub.seq}`);
  });

  it("refuses an operator past 5 connections with a 429, before any stream opens", async () => {
    const { app, api } = await mounted();
    for (let i = 0; i < LIVE_LIMITS.connectionsPerOperator; i++) {
      expect((await open(app, api.basePath, "vic")).response.status).toBe(200);
    }
    const sixth = await open(app, api.basePath, "vic");
    expect(sixth.response.status).toBe(429);
    expect(sixth.response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });
});

describe("the WebSocket channel", () => {
  /** Listens; the port. */
  const listen = async (app: BunHttpAdapter) => {
    const server = await app.listen(0);
    cleanups.push(async () => {
      await app.close();
    });
    return server.port ?? 0;
  };

  /** Opens a socket as `op`, sends `frames`, and collects frames until `count` arrive. */
  const socket = async (
    port: number,
    basePath: string,
    headers: Record<string, string>,
  ) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${basePath}/live`, {
      headers,
    } as never);
    const frames: { type: string; data: any; id?: string }[] = [];
    const waiters: (() => void)[] = [];
    ws.onmessage = (message) => {
      frames.push(
        JSON.parse(String(message.data)) as { type: string; data: any },
      );
      for (const wake of waiters.splice(0)) wake();
    };
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      ws.onclose = () => resolve(false);
    });
    cleanups.push(() => ws.close());
    const next = async (type: string) => {
      const deadline = Date.now() + 5_000;
      while (!frames.some((f) => f.type === type) && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 100);
        });
      }
      return frames.find((f) => f.type === type);
    };
    return { ws, opened, frames, next };
  };

  it("subscribes and is sent a viewer's events stripped; an analyst's whole", async () => {
    const { app, api } = await mounted();
    const port = await listen(app);
    const viewer = await socket(port, api.basePath, { "x-op": "vic" });
    expect(viewer.opened).toBe(true);
    viewer.ws.send(
      JSON.stringify({
        type: "subscribe",
        id: "1",
        data: { topics: ["events:global"] },
      }),
    );
    const subscribed = await viewer.next("subscribed");
    expect(subscribed).toMatchObject({
      id: "1",
      data: { topics: ["events:global"], refused: [] },
    });
    const analyst = await socket(port, api.basePath, { "x-op": "ann" });
    analyst.ws.send(
      JSON.stringify({
        type: "subscribe",
        id: "1",
        data: { topics: ["events:global"] },
      }),
    );
    await analyst.next("subscribed");
    api.live.publishBatch("pay", {
      events: [fullEvent("e1", "pay")],
      counters: [],
    });
    const seen = await viewer.next("event");
    expect(seen?.data.event.id).toBe("e1");
    const text = JSON.stringify(viewer.frames);
    for (const secret of [...Object.values(SECRET_SUBJECTS), "SAMPLE-SECRET"])
      expect(text).not.toContain(secret);
    await analyst.next("event");
    expect(JSON.stringify(analyst.frames)).toContain(SECRET_SUBJECTS.user);
  });

  it("refuses the upgrade without an operator, or from another origin", async () => {
    const { app, api } = await mounted();
    const port = await listen(app);
    expect((await socket(port, api.basePath, {})).opened).toBe(false);
    expect(
      (
        await socket(port, api.basePath, {
          "x-op": "vic",
          origin: "https://evil.example",
        })
      ).opened,
    ).toBe(false);
    // The control: the same operator from the API's own origin opens.
    expect(
      (
        await socket(port, api.basePath, {
          "x-op": "vic",
          origin: `http://127.0.0.1:${port}`,
        })
      ).opened,
    ).toBe(true);
    expect(api.live.hub.sessionsOf({ id: "vic" })).toBe(1);
  });

  it("the SSE route still answers a plain GET beside the socket", async () => {
    const { app, api } = await mounted();
    const port = await listen(app);
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    const response = await fetch(
      `http://127.0.0.1:${port}${api.basePath}/live?topics=policy:global`,
      {
        headers: { "x-op": "vic" },
        signal: controller.signal,
      },
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });
});
