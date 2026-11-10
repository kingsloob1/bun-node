/**
 * The SSE client reading events bun-common declared with `sseVariants()`
 * (bun-validate V11): nothing on the wire names the variant, so the client
 * checks each event's data against every variant (the declaration is a
 * Standard Schema of their union) and needs no change of its own. Over a
 * real `BunHttpAdapter` on port 0: both variants' events pass the client's
 * checks; the control is an event matching neither, which the writer let
 * through with its checks off and the client flags.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import type { RouteManifest } from "../lib/index";
import {
  BunHttpAdapter,
  sse as declareSse,
  sseVariants,
} from "@kingsleyweb/bun-common";
import { createClient } from "../lib/index";
import { sse } from "../lib/sse";

/** The declaration, shared by the server's writer and the client's checks. */
const Ticks = declareSse({
  tick: sseVariants({
    admin: {
      when: () => true,
      data: z.strictObject({ n: z.number(), secret: z.string() }),
    },
    user: { data: z.strictObject({ n: z.number() }) },
  }),
});

interface Routes {
  "GET /ticks": {
    responses: { 200: undefined };
    stream: "sse";
    events: { tick: { n: number; secret: string } | { n: number } };
  };
}

const manifest: RouteManifest<Routes> = { "GET /ticks": { statuses: [200] } };

const adapters: BunHttpAdapter[] = [];
afterEach(async () => {
  while (adapters.length) await adapters.pop()?.close();
});

/** Serves `/ticks`, sending `data` as `tick` events under the writer's `validation`; reads them back with the client's checks. */
async function readTicks(
  data: readonly unknown[],
  validation: "off" | "error",
): Promise<{ received: unknown[]; warnings: string[] }> {
  const adapter = new BunHttpAdapter(0);
  adapter.get("/ticks", (_req, res) => {
    const stream = res.sse({ contract: Ticks, validation, heartbeatMs: 0 });
    void (async () => {
      for (const value of data) {
        await stream.send({ event: "tick", data: value as { n: number } });
      }
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
    schemas: { schemas: { "GET /ticks": { responses: { 200: Ticks } } } },
    logger: {
      warn: (message: string) => void warnings.push(message),
      error: () => {},
      debug: () => {},
    },
  });
  const received: unknown[] = [];
  for await (const event of sse(api, "GET /ticks", { reconnect: false })) {
    received.push(event.data);
  }
  return { received, warnings };
}

describe("the client reading sseVariants() events", () => {
  it("passes each variant's events with the server's own declaration", async () => {
    const sent = [{ n: 1, secret: "s" }, { n: 2 }];
    const { received, warnings } = await readTicks(sent, "error");
    expect(received).toEqual(sent);
    expect(warnings).toEqual([]);
  }, 15_000);

  it("control: an event no variant matches is flagged", async () => {
    const { received, warnings } = await readTicks([{ n: "x" }], "off");
    expect(received).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  }, 15_000);
});
