import type { JobsApiAuthorizeContext } from "../../lib/api/config";
import { BunHttpAdapter, BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { createJobsApi } from "../../lib/api/createJobsApi";
import { apiConfig, jobsContext } from "./fixtures";

/**
 * A body that fails to decode, sent to the API mounted on an adapter. An
 * adapter refuses such a body before routing, with its own HTML 400, unless
 * the router it reaches opts in (`acceptUndecodableBody`): the API does, so
 * it answers the way it does on a bare router — authorized first, then its
 * own problem JSON — wherever it is mounted.
 */

const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

/** A malformed JSON body for a route that takes one. */
const MALFORMED: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{",
};

/** The API on a `BunHttpAdapter`, recording every authorize call. */
async function mounted(allow: boolean) {
  const calls: JobsApiAuthorizeContext[] = [];
  const jobs = jobsContext("api-undecodable");
  await jobs.queue("mail").add("send", {});
  const api = createJobsApi(
    apiConfig({
      jobs,
      logger: noopLogger,
      websocket: false,
      authorize: (_req, context) => {
        calls.push(context);
        return allow;
      },
    }),
  );
  const adapter = new BunHttpAdapter(0, { logger: noopLogger });
  adapter.use(api.basePath, api.router);
  cleanups.push(async () => {
    await api.close();
    await adapter.close();
  });
  return { api, adapter, calls };
}

/** Each way into the adapter: its socket-free `fetch()`, and a real socket. */
const transports = {
  "adapter.fetch()": async (adapter: BunHttpAdapter, path: string) =>
    await adapter.fetch(path, MALFORMED),
  "a served request": async (adapter: BunHttpAdapter, path: string) => {
    const server = await adapter.listen(0);
    return await fetch(`http://127.0.0.1:${server.port}${path}`, MALFORMED);
  },
};

describe("a malformed JSON body to the API mounted on an adapter", () => {
  for (const [via, send] of Object.entries(transports)) {
    describe(via, () => {
      it("is authorized first, then answered with the API's 400 INVALID_JSON", async () => {
        const { adapter, calls } = await mounted(true);
        const response = await send(adapter, "/admin/jobs/queues/mail/pause");
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain(
          "application/problem+json",
        );
        expect(await response.json()).toMatchObject({
          code: "INVALID_JSON",
          title: "Malformed JSON body",
        });
        expect(calls).toHaveLength(1);
      });

      it("tells a denied caller 403, not that the body was bad", async () => {
        const { adapter, calls } = await mounted(false);
        const response = await send(adapter, "/admin/jobs/queues/mail/pause");
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
        expect(calls).toHaveLength(1);
      });

      it("answers an unknown path under the API with its JSON 404", async () => {
        const { adapter } = await mounted(true);
        const response = await send(adapter, "/admin/jobs/nope");
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
          code: "ROUTE_NOT_FOUND",
        });
      });
    });
  }

  it("leaves the host's own routes refusing it before routing, as before", async () => {
    // The negative control: the opt-in is the API router's, so a host route
    // beside it keeps the adapter's refusal, and its handler never runs.
    const { adapter } = await mounted(true);
    let ran = false;
    adapter.post("/host", (_req, res) => {
      ran = true;
      return res.json({ ok: true });
    });
    const response = await adapter.fetch("/host", MALFORMED);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(ran).toBe(false);
  });

  it("answers the same on a bare router as on the adapter", async () => {
    const { api } = await mounted(true);
    const root = new BunRouter();
    root.use(api.basePath, api.router);
    const response = await root.fetch(
      "/admin/jobs/queues/mail/pause",
      MALFORMED,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_JSON" });
  });
});
