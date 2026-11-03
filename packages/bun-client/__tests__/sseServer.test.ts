/**
 * The SSE client against bun-common's writer, end to end (typed-client
 * plan `sse.md` §4, bun-native-routes PR-sse2): a real `BunHttpAdapter` on
 * port 0 whose route answers with `res.sse({ contract, ids: "auto", retry,
 * resume })`, read by `sse()` from `@kingsleyweb/bun-client/sse` over the
 * network, its events checked by the same `sse({ … })` declaration the
 * server sends with.
 *
 * Covered: typed iteration of the writer's events, their auto ids and the
 * opening's `retry:`; a dropped stream resumed with `Last-Event-ID`, the
 * server replaying from it (control: the first connection sends none); a
 * `Last-Event-ID` the server cannot replay from answered with the declared
 * `gap`, which fires `$gap`; client validation with the server's own
 * declaration passing every event the writer sent.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import type { RouteManifest } from "../lib/index";
import { BunHttpAdapter, sse as declareSse } from "@kingsleyweb/bun-common";
import { createClient } from "../lib/index";
import { sse } from "../lib/sse";

/** The declaration, shared by the server's writer and the client's checks. */
const Events = declareSse({
  progress: z.object({ percent: z.number() }),
  done: z.object({ result: z.string() }),
  gap: null,
});

interface Routes {
  "GET /jobs/:id/events": {
    params: { id: string };
    responses: { 200: undefined };
    stream: "sse";
    events: {
      progress: { percent: number };
      done: { result: string };
      gap: undefined;
    };
  };
}

const manifest: RouteManifest<Routes> = {
  "GET /jobs/:id/events": { statuses: [200] },
};

const adapters: BunHttpAdapter[] = [];
afterEach(async () => {
  while (adapters.length) await adapters.pop()?.close();
});

/**
 * A job's event log, served by a route that replays it from the client's
 * `Last-Event-ID`: the log keeps only events after `oldest`, so an id
 * before it is a gap. The first connection sends two events and drops;
 * later ones send the rest and the result.
 */
async function serveJob(oldest = 0) {
  const lastEventIds: (string | undefined)[] = [];
  const log = [10, 20, 30, 40].map((percent, i) => ({
    id: i + 1,
    percent,
  }));
  const adapter = new BunHttpAdapter(0);
  adapter.get("/jobs/:id/events", (req, res) => {
    lastEventIds.push(req.get("last-event-id") ?? undefined);
    const first = lastEventIds.length === 1;
    const stream = res.sse({
      contract: Events,
      ids: "auto",
      retry: 20,
      heartbeatMs: 0,
      resume: (lastEventId) => {
        const from = Number(lastEventId);
        if (!Number.isInteger(from) || from < oldest) return "gap";
        return log
          .filter((entry) => entry.id > from)
          .map((entry) => ({
            event: "progress" as const,
            data: { percent: entry.percent },
            id: entry.id,
          }));
      },
    });
    void (async () => {
      if (first && stream.lastEventId === undefined) {
        // The first connection: two events, then the connection drops.
        for (const entry of log.slice(0, 2)) {
          await stream.send({
            event: "progress",
            data: { percent: entry.percent },
            id: entry.id,
          });
        }
        stream.close();
        return;
      }
      await stream.send({ event: "done", data: { result: "ok" } });
      stream.close();
    })();
  });
  await adapter.listen(0);
  adapters.push(adapter);
  const warnings: string[] = [];
  const api = createClient<Routes>({
    baseUrl: `http://127.0.0.1:${adapter.listeningPort}`,
    manifest,
    mode: "development",
    // The server's own declaration: the client checks each event with it.
    schemas: {
      schemas: { "GET /jobs/:id/events": { responses: { 200: Events } } },
    },
    logger: {
      warn: (message: string) => void warnings.push(message),
      error: () => {},
      debug: () => {},
    },
  });
  return { api, lastEventIds, warnings };
}

describe("sse() against res.sse()", () => {
  it("reads the writer's typed events, and resumes a dropped stream from Last-Event-ID", async () => {
    const { api, lastEventIds, warnings } = await serveJob();
    const stream = sse(api, "GET /jobs/:id/events", {
      params: { id: "j1" },
      reconnect: { initialMs: 5_000, maxMs: 5_000 },
    });
    const seen: { event: string; data: unknown; id?: string }[] = [];
    for await (const event of stream) {
      seen.push({ event: event.event, data: event.data, id: event.id });
      if (event.event === "done") break;
    }
    stream.close();
    expect(seen).toEqual([
      { event: "progress", data: { percent: 10 }, id: "1" },
      { event: "progress", data: { percent: 20 }, id: "2" },
      // The reconnection, after the server's retry: (20 ms, not the 5 s
      // the client would otherwise wait): replayed from id 2, then live,
      // the auto id continuing after the replayed ones.
      { event: "progress", data: { percent: 30 }, id: "3" },
      { event: "progress", data: { percent: 40 }, id: "4" },
      { event: "done", data: { result: "ok" }, id: "5" },
    ]);
    // The control: the first connection sent no Last-Event-ID.
    expect(lastEventIds).toEqual([undefined, "2"]);
    expect(stream.lastEventId).toBe("5");
    expect(warnings).toEqual([]);
  }, 15_000);

  it("answers an id it cannot replay from with the declared gap, which fires $gap", async () => {
    const { api, lastEventIds, warnings } = await serveJob(3);
    const stream = sse(api, "GET /jobs/:id/events", {
      params: { id: "j1" },
      lastEventId: "1",
      reconnect: false,
    });
    const gaps: unknown[] = [];
    stream.on("$gap", (data, event) => void gaps.push([data, event.event]));
    const names: string[] = [];
    for await (const event of stream) names.push(event.event);
    expect(lastEventIds).toEqual(["1"]);
    expect(names).toEqual(["gap", "done"]);
    expect(gaps).toEqual([[undefined, "gap"]]);
    expect(warnings).toEqual([]);
  }, 15_000);

  it("control: the client's checks are live — an event the writer let through unchecked is flagged", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/jobs/:id/events", (_req, res) => {
      const stream = res.sse({
        contract: Events,
        validation: "off",
        heartbeatMs: 0,
      });
      void stream
        .send({
          event: "progress",
          data: { percent: "half" } as unknown as { percent: number },
        })
        .then(() => stream.close());
    });
    await adapter.listen(0);
    adapters.push(adapter);
    const warnings: string[] = [];
    const api = createClient<Routes>({
      baseUrl: `http://127.0.0.1:${adapter.listeningPort}`,
      manifest,
      mode: "development",
      schemas: {
        schemas: { "GET /jobs/:id/events": { responses: { 200: Events } } },
      },
      logger: {
        warn: (message: string) => void warnings.push(message),
        error: () => {},
        debug: () => {},
      },
    });
    const stream = sse(api, "GET /jobs/:id/events", {
      params: { id: "j1" },
      reconnect: false,
    });
    for await (const _event of stream) {
      // Delivered under the default "warn".
    }
    expect(warnings).toHaveLength(1);
  }, 15_000);
});
